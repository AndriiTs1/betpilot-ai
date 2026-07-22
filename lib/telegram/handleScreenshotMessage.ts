import type { PrismaClient } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import type { TelegramMessage } from "./telegramTypes";
import { selectScreenshotSource } from "./selectScreenshotSource";
import { downloadTelegramFile } from "./downloadTelegramFile";
import { sendTelegramMessage } from "./sendMessage";
import { escapeHtml } from "./escapeHtml";
import type { ScreenshotIntake } from "./screenshotIntake";
import { recognizeScreenshot } from "@/lib/ocr/recognizeScreenshot";
import { createClaudeOcrProvider } from "@/lib/ocr/claudeOcrProvider";
import type { OcrFailureCode, OcrProvider, OcrSuccess } from "@/lib/ocr/ocrTypes";

// Stage 14.1 — Screenshot Intake orchestration. Stage 14.2 added OCR
// (lib/ocr/recognizeScreenshot.ts) as the last step before replying. This is
// the *only* place that wires together message inspection
// (selectScreenshotSource, pure), Player lookup (Prisma), file download
// (downloadTelegramFile), OCR (recognizeScreenshot), and the player-facing
// Telegram replies. It deliberately does not touch Bet, BetSelection,
// Transaction, or any settlement/financial logic — every outcome below ends
// in a rejection reply or an OCR-result-dependent reply, never a Bet.
//
// DI-friendly (db/botToken overridable), same shape as
// app/api/miniapp/bets/text/confirm/route.ts's handleBetConfirm and
// app/api/bets/[id]/settle/route.ts's handleSettleBet — so tests can inject
// a fake db instead of a real database connection. The real webhook route
// always calls this with no overrides.

export const MAX_SCREENSHOT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const TOO_LARGE_TEXT = "⚠️ Файл слишком большой.\nМаксимальный размер изображения — 10 МБ.";

const UNSUPPORTED_FORMAT_TEXT =
  "⚠️ Неподдерживаемый формат.\nОтправьте изображение в формате JPG, PNG или WEBP.";

const NOT_REGISTERED_TEXT = "⚠️ Ваш Telegram-аккаунт не зарегистрирован в BetPilot.";

// No canonical wording exists elsewhere in the codebase for a Telegram-side
// download failure (getFile/network/timeout) — every other player-facing
// error string in this stage comes directly from Part 3 of the brief. This
// one is new, kept in the same ⚠️ tone, and only ever describes an
// operational failure to the player, never a stack trace or internal detail.
const DOWNLOAD_FAILED_TEXT = "⚠️ Не удалось загрузить изображение. Попробуйте отправить его ещё раз.";

// Stage 14.2 — replaces Stage 14.1's unconditional "✅ Скриншот получен"
// acknowledgement: the player now gets exactly one reply that reflects the
// actual OCR outcome, never a generic "received" message followed by a
// second one. Telegram's own message length cap is 4096 UTF-16 code units.
//
// Verification pass (post-14.2): the original implementation truncated the
// *raw* OCR text to a fixed character count and only escaped afterward.
// escapeHtml() can expand a single character into up to 5 (each & -> &amp;,
// each < -> &lt;, each > -> &gt;) — OCR text that happens to be mostly
// those characters (e.g. a screenshot misread as a wall of "&") could
// therefore still overflow 4096 after escaping, even though the raw
// truncation looked safely under budget. Fixed by escaping first, then
// truncating the *escaped* string against a budget computed from the
// actual static template parts below, never a guessed constant.
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

const OCR_SUCCESS_HEADER = "✅ Текст со скриншота распознан\n\nРаспознанный текст:\n\n";
const OCR_SUCCESS_FOOTER = "\n\nНа следующем этапе BetPilot преобразует этот текст в ставку.";
const TRUNCATION_SUFFIX = "\n\n…текст сокращён";

const NO_TEXT_FOUND_TEXT =
  "⚠️ Не удалось распознать текст на изображении.\nПопробуйте отправить более чёткий скриншот.";

const OCR_FAILED_TEXT = "⚠️ Не удалось распознать изображение.\nПопробуйте отправить скриншот ещё раз позже.";

// escapeHtml() only ever produces these three entities — "&amp;" (5 chars)
// is the longest — so a truncation cut point is only ever at risk of
// landing inside one of them within the last 4 characters before the cut.
const LONGEST_HTML_ENTITY_LENGTH = "&amp;".length;

// Truncates an *already-escaped* string to at most maxLength characters
// without ever cutting in the middle of an HTML entity (which would leak a
// raw, unescaped-looking fragment like "&am" into the sent message). Walks
// back from the naive cut point only far enough to detect a partial entity
// (at most LONGEST_HTML_ENTITY_LENGTH - 1 characters) and, if one is found,
// shortens the cut to end right before its "&" instead.
function truncateEscapedText(escaped: string, maxLength: number): string {
  if (escaped.length <= maxLength) return escaped;

  const cut = maxLength;
  const lookbackStart = Math.max(0, cut - (LONGEST_HTML_ENTITY_LENGTH - 1));
  const tail = escaped.slice(lookbackStart, cut);
  const ampIndex = tail.lastIndexOf("&");

  if (ampIndex !== -1 && !tail.slice(ampIndex).includes(";")) {
    return escaped.slice(0, lookbackStart + ampIndex);
  }

  return escaped.slice(0, cut);
}

function buildOcrSuccessMessage(normalizedText: string): string {
  const escapedFull = escapeHtml(normalizedText);

  // The exact remaining room for the OCR text once every *other* fixed part
  // of the message is accounted for — never a guessed/approximate figure.
  const maxBodyLength = Math.max(
    0,
    TELEGRAM_MAX_MESSAGE_LENGTH - OCR_SUCCESS_HEADER.length - OCR_SUCCESS_FOOTER.length,
  );

  if (escapedFull.length <= maxBodyLength) {
    return OCR_SUCCESS_HEADER + escapedFull + OCR_SUCCESS_FOOTER;
  }

  // Truncation is needed — reserve room for TRUNCATION_SUFFIX too, then
  // truncate the *escaped* text (never the raw text) so entity expansion
  // can never push the final message over budget.
  const maxBodyLengthWithSuffix = Math.max(0, maxBodyLength - TRUNCATION_SUFFIX.length);
  const truncatedBody = truncateEscapedText(escapedFull, maxBodyLengthWithSuffix);

  return OCR_SUCCESS_HEADER + truncatedBody + TRUNCATION_SUFFIX + OCR_SUCCESS_FOOTER;
}

export interface HandleScreenshotMessageOptions {
  db?: PrismaClient;
  botToken?: string;
  // DI-friendly, same reasoning as db/botToken — tests inject a
  // deterministic fake provider, production always gets the real
  // Claude-backed one via createClaudeOcrProvider().
  ocrProvider?: OcrProvider;
}

export type ScreenshotMessageOutcome =
  // Not a screenshot at all — no photo, no document. The webhook route
  // falls through to its existing text-handling flow for this.
  | { kind: "NO_IMAGE" }
  | { kind: "UNSUPPORTED_FORMAT" }
  | { kind: "FILE_TOO_LARGE" }
  | { kind: "PLAYER_NOT_FOUND" }
  | { kind: "DOWNLOAD_FAILED" }
  | { kind: "OCR_SUCCESS"; intake: ScreenshotIntake; ocr: OcrSuccess }
  | { kind: "OCR_NO_TEXT"; intake: ScreenshotIntake }
  | { kind: "OCR_FAILED"; intake: ScreenshotIntake; code: OcrFailureCode };

export async function handleScreenshotMessage(
  tgMessage: TelegramMessage,
  options: HandleScreenshotMessageOptions = {},
): Promise<ScreenshotMessageOutcome> {
  const db = options.db ?? prisma;
  const chatId = String(tgMessage.chat.id);
  const telegramId = String(tgMessage.from.id);

  const selection = selectScreenshotSource(tgMessage);

  if (selection.kind === "NONE") {
    return { kind: "NO_IMAGE" };
  }

  if (selection.kind === "UNSUPPORTED_DOCUMENT_TYPE") {
    await sendTelegramMessage(chatId, UNSUPPORTED_FORMAT_TEXT);
    return { kind: "UNSUPPORTED_FORMAT" };
  }

  const { source } = selection;

  // Reject on Telegram's own metadata before ever touching the database or
  // the network — cheapest possible check, and matches Part 8's explicit
  // "reject oversized files before download when Telegram metadata
  // contains file_size".
  if (typeof source.sizeBytes === "number" && source.sizeBytes > MAX_SCREENSHOT_SIZE_BYTES) {
    await sendTelegramMessage(chatId, TOO_LARGE_TEXT);
    return { kind: "FILE_TOO_LARGE" };
  }

  // Player isolation: every screenshot must belong to a registered Player
  // via the same telegramId lookup GET /api/miniapp/me and
  // bindInvitedPlayerByTelegramUsername already use — no new auth path.
  const player = await db.player.findUnique({ where: { telegramId }, select: { id: true } });
  if (!player) {
    await sendTelegramMessage(chatId, NOT_REGISTERED_TEXT);
    return { kind: "PLAYER_NOT_FOUND" };
  }

  const botToken = options.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("handleScreenshotMessage: TELEGRAM_BOT_TOKEN is not set");
    return { kind: "DOWNLOAD_FAILED" };
  }

  const downloadResult = await downloadTelegramFile({
    fileId: source.fileId,
    botToken,
    maxBytes: MAX_SCREENSHOT_SIZE_BYTES,
  });

  if (!downloadResult.ok) {
    if (downloadResult.error.kind === "FILE_TOO_LARGE") {
      await sendTelegramMessage(chatId, TOO_LARGE_TEXT);
      return { kind: "FILE_TOO_LARGE" };
    }

    // Structured error kind only — never the download error's own detail,
    // and downloadTelegramFile never surfaces the request URL/token in its
    // error variants in the first place.
    console.error("handleScreenshotMessage: Telegram file download failed:", downloadResult.error.kind);
    await sendTelegramMessage(chatId, DOWNLOAD_FAILED_TEXT);
    return { kind: "DOWNLOAD_FAILED" };
  }

  const intake: ScreenshotIntake = {
    source: source.source,
    playerId: player.id,
    telegramId,
    telegramMessageId: tgMessage.message_id,
    fileId: source.fileId,
    fileUniqueId: source.fileUniqueId,
    mimeType: source.mimeType,
    sizeBytes: downloadResult.download.sizeBytes,
    originalFilename: source.originalFilename,
    receivedAt: new Date(),
  };

  // Stage 14.2 — OCR runs immediately after a successful download, still
  // entirely in memory (the buffer is never written to disk or the
  // database). recognizeScreenshot() is provider-agnostic; the only
  // Claude-specific code anywhere in this stage lives in
  // lib/ocr/claudeOcrProvider.ts, never here.
  const ocrProvider = options.ocrProvider ?? createClaudeOcrProvider();
  const ocrResult = await recognizeScreenshot({
    intake,
    buffer: downloadResult.download.buffer,
    provider: ocrProvider,
  });

  if (ocrResult.kind === "SUCCESS") {
    // Best-effort — sendTelegramMessage already swallows its own failures
    // and returns a boolean, never throws.
    await sendTelegramMessage(chatId, buildOcrSuccessMessage(ocrResult.normalizedText));
    return { kind: "OCR_SUCCESS", intake, ocr: ocrResult };
  }

  if (ocrResult.code === "NO_TEXT_FOUND") {
    await sendTelegramMessage(chatId, NO_TEXT_FOUND_TEXT);
    return { kind: "OCR_NO_TEXT", intake };
  }

  // Every other failure code (EMPTY_IMAGE, UNSUPPORTED_FORMAT,
  // PROVIDER_UNAVAILABLE, PROVIDER_TIMEOUT, PROVIDER_ERROR,
  // INVALID_RESPONSE) — never the provider's own safeMessage/detail sent to
  // the player, just the one generic Russian retry message. The code alone
  // is logged server-side for diagnosis.
  console.error("handleScreenshotMessage: OCR failed:", ocrResult.code);
  await sendTelegramMessage(chatId, OCR_FAILED_TEXT);
  return { kind: "OCR_FAILED", intake, code: ocrResult.code };
}
