import type { PrismaClient } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import type { TelegramMessage } from "./telegramTypes";
import { selectScreenshotSource } from "./selectScreenshotSource";
import { downloadTelegramFile } from "./downloadTelegramFile";
import { sendTelegramMessage } from "./sendMessage";
import type { ScreenshotIntake } from "./screenshotIntake";

// Stage 14.1 — Screenshot Intake orchestration. This is the *only* place
// that wires together message inspection (selectScreenshotSource, pure),
// Player lookup (Prisma), file download (downloadTelegramFile), and the
// player-facing Telegram replies. It deliberately does not touch Bet,
// BetSelection, Transaction, or any settlement/financial logic — every
// outcome below ends either in a rejection reply or a plain "received"
// acknowledgement, never a Bet.
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

const RECEIVED_TEXT =
  "✅ Скриншот получен\n\n" +
  "Мы успешно загрузили изображение.\n" +
  "На следующем этапе BetPilot распознает данные ставки.";

export interface HandleScreenshotMessageOptions {
  db?: PrismaClient;
  botToken?: string;
}

export type ScreenshotMessageOutcome =
  // Not a screenshot at all — no photo, no document. The webhook route
  // falls through to its existing text-handling flow for this.
  | { kind: "NO_IMAGE" }
  | { kind: "UNSUPPORTED_FORMAT" }
  | { kind: "FILE_TOO_LARGE" }
  | { kind: "PLAYER_NOT_FOUND" }
  | { kind: "DOWNLOAD_FAILED" }
  | { kind: "ACCEPTED"; intake: ScreenshotIntake };

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

  // Best-effort acknowledgement — mirrors confirm/reject/settle's own
  // notification discipline (sendTelegramMessage already swallows its own
  // failures and returns a boolean, never throws), so a Telegram outage
  // here can't turn a successfully accepted screenshot into a 500.
  await sendTelegramMessage(chatId, RECEIVED_TEXT);

  return { kind: "ACCEPTED", intake };
}
