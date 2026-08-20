import { isBetPreviewSuccess, type BetPreviewSuccess } from "./betPreviewApi";

import { isTelegramAuthErrorReason, getTelegramAuthErrorMessage } from "./telegramAuthError";
import { translate } from "@/lib/i18n/translations";
import type { Locale } from "@/lib/i18n/locale";

// Full-screen-screenshot support — the server-side pipeline this timeout
// bounds can now involve up to four sequential Claude-backed stages for a
// large image: region detection (lib/ocr/regionDetection.ts,
// REGION_DETECTION_TIMEOUT_MS = 12000ms) -> OCR
// (lib/ocr/recognizeScreenshot.ts, DEFAULT_OCR_TIMEOUT_MS = 20000ms) ->
// bet-slip parsing (lib/ai/betParser.ts, CLAUDE_OCR_PARSER_TIMEOUT_MS =
// 15000ms) -> odds verification (lib/odds/oddsVerifier.ts,
// ODDS_API_TIMEOUT_MS = 8000ms, run in parallel across selections, not
// sequentially per leg). Worst case that's 12+20+15+8 = 55s of legitimate
// server-side work before the server itself would ever time out — the
// previous 15000ms value here was already shorter than the OCR stage's own
// 20000ms budget *alone*, even before region detection existed, so the
// client could abort a request the server would otherwise have completed
// successfully. 65000ms leaves roughly 10s of margin over that 55s
// worst-case total for network/serialization overhead. An already-cropped
// slip (the majority case) skips region detection entirely and finishes
// well under this — this raises the ceiling for the slow path, it doesn't
// change the typical-case latency.
const REQUEST_TIMEOUT_MS = 65000;

export type BetScreenshotErrorCode =
  | "malformed"
  | "invalid_signature"
  | "expired"
  | "PLAYER_NOT_FOUND"
  | "MISSING_FILE"
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FILE_TYPE"
  | "INVALID_IMAGE_SIGNATURE"
  | "IMAGE_TOO_LARGE"
  | "AI_NOT_CONFIGURED"
  | "AI_TIMEOUT"
  | "AI_UNAVAILABLE"
  // SCREENSHOT QA-CORE S3 — its own code, split off from IMAGE_NOT_RECOGNIZED
  // below (OCR found no legible text at all vs. OCR succeeded but the parser
  // couldn't build a valid bet from it — two different causes, previously
  // sharing one message).
  | "OCR_NO_TEXT"
  | "IMAGE_NOT_RECOGNIZED"
  | "INCOMPLETE_BET_DATA"
  | "INVALID_BET_SLIP"
  | "INTERNAL_ERROR";

// Stage 12, Phase 3 — a detected multi-selection slip used to be rejected
// server-side with a dedicated 422 PARLAY_CONFIRM_NOT_SUPPORTED (parsed
// here as a "parlay_not_supported" failure kind, shown as its own message).
// The server now returns a normal 200 preview for it instead (via
// buildBetSlipPreview()), so that error code — and the client-side parsing
// for it (ParlaySelectionPreview/isParlaySelectionPreview/
// parseParlayFailure) — no longer exists. Removed rather than left dormant:
// leaving an error branch for a response the server can never send again
// would be misleading, not just unused.
export type BetScreenshotFailure =
  // SCREENSHOT QA-CORE S3 — `detail` mirrors the server's own existing
  // {error, detail} response shape (INVALID_BET_SLIP already carried a
  // detail; IMAGE_NOT_RECOGNIZED now does too — see route.ts). Always a
  // closed, already-safe enum string when present (a BetSlipValidationErrorCode
  // or a ParseBetSlipResult code) — never raw exception text, never provider
  // detail. Optional/null whenever the server response carried no detail
  // field at all — every pre-existing client-side-only failure construction
  // (upload validation, rejected before any request is even sent) simply
  // omits it, unaffected by this addition.
  | { kind: "http"; code: BetScreenshotErrorCode | "UNKNOWN"; detail?: string | null }
  | { kind: "network" }
  | { kind: "timeout" }
  | { kind: "invalid_response" };

export type BetScreenshotResult =
  | { ok: true; data: BetPreviewSuccess }
  | { ok: false; failure: BetScreenshotFailure };

// Multipart upload — mirrors fetchBetPreview's/fetchBetConfirm's shape
// (AbortController + timeout, Authorization: tma <initData>, same
// ok/failure discriminated result), but this is the only place in the app
// that sends a file instead of JSON: no Content-Type header is set here on
// purpose — the browser must generate the multipart boundary itself.
export async function fetchBetScreenshotPreview(
  initData: string,
  file: File,
): Promise<BetScreenshotResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const formData = new FormData();
  formData.set("image", file, file.name);

  let response: Response;

  try {
    response = await fetch("/api/miniapp/bets/screenshot/preview", {
      method: "POST",
      headers: { Authorization: `tma ${initData}` },
      body: formData,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, failure: { kind: "timeout" } };
    }
    return { ok: false, failure: { kind: "network" } };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);

    const code =
      typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
        ? ((body as { error: string }).error as BetScreenshotErrorCode | "UNKNOWN")
        : "UNKNOWN";

    // SCREENSHOT QA-CORE S3 — same optional-field extraction discipline as
    // `code` above; a missing/non-string detail is simply null, never
    // fabricated.
    const detail =
      typeof body === "object" && body !== null && typeof (body as { detail?: unknown }).detail === "string"
        ? (body as { detail: string }).detail
        : null;

    return { ok: false, failure: { kind: "http", code, detail } };
  }

  const body: unknown = await response.json().catch(() => null);

  if (!isBetPreviewSuccess(body)) {
    return { ok: false, failure: { kind: "invalid_response" } };
  }

  return { ok: true, data: body };
}

// Localization completion pass — same "locale defaults to en" convention as
// getBetPreviewErrorMessage (betPreviewApi.ts) — zero behavior change for
// any pre-existing call site/test that doesn't pass a locale; every UI call
// site now explicitly passes the player's real current locale. Every
// failure code, and the OCR/parser pipeline that produces it, is completely
// untouched — this is presentation text for an already-computed code only.
export function getBetScreenshotErrorMessage(failure: BetScreenshotFailure, locale: Locale = "en"): string {
  if (failure.kind === "network") return translate(locale, "error.network");
  if (failure.kind === "timeout") return translate(locale, "error.timeout");
  if (failure.kind === "invalid_response") return translate(locale, "error.generic");

  if (isTelegramAuthErrorReason(failure.code)) {
    return getTelegramAuthErrorMessage(failure.code, locale);
  }

  switch (failure.code) {
    case "PLAYER_NOT_FOUND":
      return translate(locale, "error.playerNotFound");
    case "MISSING_FILE":
      return translate(locale, "error.missingFile");
    case "EMPTY_FILE":
      return translate(locale, "error.emptyFile");
    case "FILE_TOO_LARGE":
      return translate(locale, "error.fileTooLarge");
    case "UNSUPPORTED_FILE_TYPE":
      return translate(locale, "error.unsupportedFileType");
    case "INVALID_IMAGE_SIGNATURE":
      return translate(locale, "error.invalidImageSignature");
    case "IMAGE_TOO_LARGE":
      return translate(locale, "error.imageTooLarge");
    case "AI_TIMEOUT":
      return translate(locale, "error.aiTimeoutScreenshot");
    case "AI_UNAVAILABLE":
    case "AI_NOT_CONFIGURED":
      return translate(locale, "error.aiUnavailable");
    // SCREENSHOT QA-CORE S3 — OCR genuinely found no legible text at all
    // (distinct from IMAGE_NOT_RECOGNIZED below, where OCR succeeded but the
    // bet itself couldn't be confidently extracted).
    case "OCR_NO_TEXT":
      return translate(locale, "error.ocrNoText");
    case "IMAGE_NOT_RECOGNIZED":
      // SCREENSHOT QA-CORE S3 — `detail` (when present) is the parser's own
      // already-safe rejection code (numeric_mismatch/market_mismatch),
      // never raw text — see route.ts's own comment on this field. Every
      // other cause (OCR succeeded but the parser genuinely rejected the
      // slip, or a schema/tool-call failure with no finer-grained code)
      // keeps today's existing, still-accurate message.
      if (failure.detail === "numeric_mismatch") {
        return translate(locale, "error.numericMismatch");
      }
      if (failure.detail === "market_mismatch") {
        return translate(locale, "error.marketMismatch");
      }
      return translate(locale, "error.imageNotRecognized");
    case "INCOMPLETE_BET_DATA":
      return translate(locale, "error.incompleteBetData");
    case "INVALID_BET_SLIP":
      // SCREENSHOT QA-CORE S3 — confirmed production defect (QA-2): every
      // BetSlipValidationErrorCode used to share this one message, even
      // MARKET_INTENT_UNRECONCILED, which has nothing to do with selection
      // count. `detail` already carried the real code — see route.ts — it
      // was simply never read here until now.
      if (failure.detail === "MARKET_INTENT_UNRECONCILED") {
        return translate(locale, "error.marketIntentUnreconciled");
      }
      return translate(locale, "error.invalidBetSlip");
    case "INTERNAL_ERROR":
    default:
      return translate(locale, "error.generic");
  }
}
