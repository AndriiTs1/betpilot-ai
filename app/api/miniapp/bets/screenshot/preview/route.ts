import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { verifyInitData } from "@/lib/telegram/verifyInitData";
import { parseBetSlipMessage, type ParseBetSlipResult } from "@/lib/ai/betParser";
import type { ParsedBetSlip } from "@/lib/bets/betSlip";
import { buildBetSlipPreview, BetSlipValidationError, type BuildBetSlipPreviewOptions } from "@/lib/bets/buildBetSlipPreview";
import { recognizeScreenshot } from "@/lib/ocr/recognizeScreenshot";
import { createClaudeOcrProvider } from "@/lib/ocr/claudeOcrProvider";
import type { OcrFailure, OcrProvider } from "@/lib/ocr/ocrTypes";
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES, detectImageSignature, type AllowedMimeType } from "@/lib/uploads/imageValidation";
import { logScreenshotPipelineEvent } from "@/lib/logging/structuredLog";

// Stage 4.5B built server-side upload validation only. Stage 4.5C added a
// pipeline that read the image and extracted structured bet fields in one
// Claude call. Stage 14.3 replaced that single combined call with two
// independent stages, reusing Stage 14.2's OCR work wholesale:
//
//   upload -> recognizeScreenshot() [lib/ocr/] -> OCR text
//          -> parseBetSlipMessage(text, "OCR") [lib/ai/betParser.ts] -> ParsedBetSlip
//          -> buildBetSlipPreview() [unchanged] -> { preview, previewToken }
//
// OCR and bet parsing are deliberately two separate Claude calls, never
// combined into one — recognizeScreenshot() has no concept of "a bet" (it
// only transcribes text), and parseBetSlipMessage() never sees the image,
// only already-transcribed text. This is the exact same parseBetSlipMessage()
// the text-bet flow (app/api/miniapp/bets/text/preview/route.ts) already
// uses — just called in "OCR" mode instead of "CHAT" mode (see
// lib/ai/betParserPrompt.ts) — so there is only one bet parser in the
// codebase, not two, and its output already matches ParsedBetSlip directly:
// no normalization step is needed for screenshots anymore (unlike the old
// normalizeParsedImageBet(), now removed).
//
// The client-facing contract is unchanged: same endpoint, same multipart
// request shape, same { preview, previewToken } response shape, same error
// code vocabulary components/miniapp/betScreenshotApi.ts already knows —
// no Mini App UI change required.

// Requires node:crypto (verifyInitData/previewToken signing), Buffer
// (base64 conversion), and the Anthropic SDK — none of these run on the
// Edge runtime.
export const runtime = "nodejs";

// Same header-parsing shape as the text preview/confirm routes and
// GET /api/miniapp/me. Duplicated rather than shared for the same reason as
// there — it's a 6-line Authorization-header parse, not the actual
// signature verification (that part *is* reused as-is via verifyInitData()).
function extractInitData(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "tma" || !value) return null;

  return value;
}

// Maps an OCR-layer failure onto the same client-facing error vocabulary
// betScreenshotApi.ts already understands from before this migration — no
// new codes introduced, so the Mini App needs no changes. EMPTY_IMAGE/
// UNSUPPORTED_FORMAT are not expected to actually trigger here (the upload
// validation above already rejects those before recognizeScreenshot() is
// ever called) but are mapped defensively rather than left unhandled.
function mapOcrFailureToResponse(failure: OcrFailure): NextResponse {
  switch (failure.code) {
    case "EMPTY_IMAGE":
      return NextResponse.json({ error: "EMPTY_FILE" }, { status: 400 });
    case "UNSUPPORTED_FORMAT":
      return NextResponse.json({ error: "UNSUPPORTED_FILE_TYPE" }, { status: 415 });
    case "NO_TEXT_FOUND":
      return NextResponse.json({ error: "IMAGE_NOT_RECOGNIZED" }, { status: 422 });
    case "PROVIDER_UNAVAILABLE":
      return NextResponse.json({ error: "AI_NOT_CONFIGURED" }, { status: 500 });
    case "PROVIDER_TIMEOUT":
      return NextResponse.json({ error: "AI_TIMEOUT" }, { status: 504 });
    case "PROVIDER_ERROR":
    case "INVALID_RESPONSE":
      return NextResponse.json({ error: "AI_UNAVAILABLE" }, { status: 502 });
  }
}

export interface HandleScreenshotPreviewOptions {
  db?: PrismaClient;
  botToken?: string;
  previewTokenSecret?: string;
  ocrProvider?: OcrProvider;
  verifyOddsFn?: BuildBetSlipPreviewOptions["verifyOddsFn"];
  // Injectable separately from ocrProvider — keeps OCR and bet parsing
  // testable as the two independent stages they actually are at runtime.
  // Defaults to the real parseBetSlipMessage; tests inject a fake so the
  // bet-parsing Claude call never needs the same singleton-fetch-mocking
  // technique lib/ocr/claudeOcrProvider.test.ts/lib/ai/betParser.test.ts
  // already had to use for the module-level Anthropic client.
  parseBetSlip?: typeof parseBetSlipMessage;
}

// Injectable so tests can supply a fake db/OCR provider/bet parser/odds
// verifier instead of a real database connection, a real Claude call, or a
// real Odds API call — same DI shape as handleBetConfirm/handleSettleBet/
// handleTelegramWebhook elsewhere in this codebase. POST always calls this
// with no overrides.
// Aggregates per-selection odds status into one of the three
// odds-verification log events — reports the most concerning outcome
// across all selections (UNAVAILABLE > NOT_FOUND > everything else) so a
// partially-failed EXPRESS bet is never silently reported as a clean
// success. Selection content (event/selection/odds) never enters this —
// only the already-enum-typed oddsStatus values.
function aggregateOddsVerificationEvent(
  selections: Array<{ oddsStatus: string }>,
): "odds_verification_succeeded" | "odds_verification_not_found" | "odds_verification_failed" {
  if (selections.some((s) => s.oddsStatus === "UNAVAILABLE")) return "odds_verification_failed";
  if (selections.some((s) => s.oddsStatus === "NOT_FOUND")) return "odds_verification_not_found";
  return "odds_verification_succeeded";
}

export async function handleScreenshotPreview(
  request: NextRequest,
  options: HandleScreenshotPreviewOptions = {},
): Promise<NextResponse> {
  const totalStartedAt = Date.now();
  const db = options.db ?? prisma;

  const initData = extractInitData(request);
  if (!initData) {
    return NextResponse.json({ error: "malformed" }, { status: 401 });
  }

  const botToken = options.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("POST /api/miniapp/bets/screenshot/preview: TELEGRAM_BOT_TOKEN is not set");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  const previewTokenSecret = options.previewTokenSecret ?? process.env.BET_PREVIEW_TOKEN_SECRET;
  if (!previewTokenSecret) {
    console.error("POST /api/miniapp/bets/screenshot/preview: BET_PREVIEW_TOKEN_SECRET is not set");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  const verification = verifyInitData(initData, botToken);
  if (!verification.ok) {
    return NextResponse.json({ error: verification.reason }, { status: 401 });
  }

  try {
    const player = await db.player.findUnique({
      where: { telegramId: String(verification.user.id) },
      select: { id: true },
    });

    if (!player) {
      return NextResponse.json({ error: "PLAYER_NOT_FOUND" }, { status: 404 });
    }

    logScreenshotPipelineEvent("screenshot_preview_started");

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: "MISSING_FILE" }, { status: 400 });
    }

    const image = formData.get("image");

    if (!(image instanceof File)) {
      return NextResponse.json({ error: "MISSING_FILE" }, { status: 400 });
    }

    if (image.size === 0) {
      return NextResponse.json({ error: "EMPTY_FILE" }, { status: 400 });
    }

    if (image.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json({ error: "FILE_TOO_LARGE" }, { status: 413 });
    }

    // Allow-list, not a deny-list — SVG, PDF, HEIC, or anything else with an
    // unexpected MIME type is rejected by omission, not by name. The
    // filename/extension is never inspected; only the multipart part's own
    // declared Content-Type (File.type) is checked here — detectImageSignature
    // below is the real, byte-level check.
    if (!ALLOWED_MIME_TYPES.has(image.type as AllowedMimeType)) {
      return NextResponse.json({ error: "UNSUPPORTED_FILE_TYPE" }, { status: 415 });
    }

    const mimeType = image.type as AllowedMimeType;

    // Single read of the file body — everything downstream (signature
    // check, OCR) reuses this same buffer. Nothing is ever written to disk
    // or a storage bucket; it only exists in memory for the rest of this
    // request.
    const bytes = new Uint8Array(await image.arrayBuffer());

    const detectedType = detectImageSignature(bytes);
    if (detectedType === null || detectedType !== mimeType) {
      return NextResponse.json({ error: "INVALID_IMAGE_SIGNATURE" }, { status: 415 });
    }

    const ocrProvider = options.ocrProvider ?? createClaudeOcrProvider();

    const ocrResult = await recognizeScreenshot({
      intake: { mimeType, originalFilename: image.name || undefined },
      buffer: Buffer.from(bytes),
      provider: ocrProvider,
    });

    if (ocrResult.kind === "FAILURE") {
      // Structured code only — never the provider's own safeMessage, and
      // never the image bytes or any OCR text (there is none to log here).
      console.error("POST /api/miniapp/bets/screenshot/preview: OCR failed:", ocrResult.code);
      logScreenshotPipelineEvent("ocr_failed", { durationMs: ocrResult.durationMs, failureCode: ocrResult.code });
      return mapOcrFailureToResponse(ocrResult);
    }

    logScreenshotPipelineEvent("ocr_succeeded", { durationMs: ocrResult.durationMs });

    const parseBetSlip = options.parseBetSlip ?? parseBetSlipMessage;

    const parserStartedAt = Date.now();
    let parsed: ParseBetSlipResult;
    try {
      parsed = await parseBetSlip(ocrResult.normalizedText, "OCR");
    } catch (err) {
      console.error("POST /api/miniapp/bets/screenshot/preview: bet parser threw:", err);
      logScreenshotPipelineEvent("parser_failed", { durationMs: Date.now() - parserStartedAt, parserMode: "OCR" });
      return NextResponse.json({ error: "AI_UNAVAILABLE" }, { status: 502 });
    }
    const parserDurationMs = Date.now() - parserStartedAt;

    if (!parsed.valid) {
      // parsed.error can contain provider/model/timeout/SDK detail — log it
      // server-side only, never in the response, and never the OCR text
      // that produced it.
      console.error("POST /api/miniapp/bets/screenshot/preview: parse failed:", parsed.error);

      // A parser-layer timeout gets its own honest response — never
      // reported as an image-quality problem — same distinction the old
      // image-specific parser made. Every other parse failure (rejected,
      // no tool call, malformed fields, non-timeout API error) is folded
      // into the single IMAGE_NOT_RECOGNIZED code and the single
      // parser_rejected log event, because ParseBetSlipResult — shared
      // with the text-bet flow, which already treats every other parse
      // failure identically as PARSE_FAILED — carries no finer-grained
      // discriminated reason beyond the timeout code for those cases.
      if (parsed.code === "timeout") {
        logScreenshotPipelineEvent("parser_timed_out", { durationMs: parserDurationMs, parserMode: "OCR" });
        return NextResponse.json({ error: "AI_TIMEOUT" }, { status: 504 });
      }
      logScreenshotPipelineEvent("parser_rejected", { durationMs: parserDurationMs, parserMode: "OCR" });
      return NextResponse.json({ error: "IMAGE_NOT_RECOGNIZED" }, { status: 422 });
    }

    // parseBetSlipMessage()'s success shape already *is* ParsedBetSlip — no
    // normalization step, unlike the old normalizeParsedImageBet().
    const slip: ParsedBetSlip = { type: parsed.type, stake: parsed.stake, selections: parsed.selections };

    logScreenshotPipelineEvent("parser_succeeded", {
      durationMs: parserDurationMs,
      parserMode: "OCR",
      selectionCount: slip.selections.length,
    });

    const oddsStartedAt = Date.now();
    let result;
    try {
      result = await buildBetSlipPreview(slip, player.id, previewTokenSecret, {
        verifyOddsFn: options.verifyOddsFn,
      });
    } catch (err) {
      if (err instanceof BetSlipValidationError) {
        console.error("POST /api/miniapp/bets/screenshot/preview: invalid bet slip:", err.code, err.message);
        return NextResponse.json({ error: "INVALID_BET_SLIP", detail: err.code }, { status: 422 });
      }
      throw err;
    }
    const oddsDurationMs = Date.now() - oddsStartedAt;

    const oddsStatuses = result.preview.selections.map((s) => s.oddsStatus);
    logScreenshotPipelineEvent(aggregateOddsVerificationEvent(result.preview.selections), {
      durationMs: oddsDurationMs,
      selectionCount: result.preview.selections.length,
      // A deduplicated summary of the enum statuses observed — never the
      // selections themselves (no event/selection/odds/stake content).
      oddsVerificationStatus: [...new Set(oddsStatuses)].join(","),
    });

    logScreenshotPipelineEvent("screenshot_preview_completed", {
      totalDurationMs: Date.now() - totalStartedAt,
      selectionCount: result.preview.selections.length,
    });

    // Never the OCR text, never the raw parser output — only the same
    // { preview, previewToken } shape the text-bet flow already returns.
    return NextResponse.json(result);
  } catch (err) {
    console.error("POST /api/miniapp/bets/screenshot/preview failed:", err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleScreenshotPreview(request);
}
