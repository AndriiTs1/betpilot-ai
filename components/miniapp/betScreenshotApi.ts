import { isBetPreviewSuccess, type BetPreviewSuccess } from "./betPreviewApi";

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
  | { kind: "http"; code: BetScreenshotErrorCode | "UNKNOWN" }
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

    return { ok: false, failure: { kind: "http", code } };
  }

  const body: unknown = await response.json().catch(() => null);

  if (!isBetPreviewSuccess(body)) {
    return { ok: false, failure: { kind: "invalid_response" } };
  }

  return { ok: true, data: body };
}

export function getBetScreenshotErrorMessage(failure: BetScreenshotFailure): string {
  if (failure.kind === "network") return "Unable to connect. Check your internet connection.";
  if (failure.kind === "timeout") return "The request took too long. Please try again.";
  if (failure.kind === "invalid_response") return "Something went wrong. Please try again.";

  switch (failure.code) {
    case "malformed":
    case "invalid_signature":
    case "expired":
      return "Unable to verify Telegram session. Reopen the Mini App.";
    case "PLAYER_NOT_FOUND":
      return "Your player account was not found.";
    case "MISSING_FILE":
      return "Please choose an image first.";
    case "EMPTY_FILE":
      return "That file is empty. Please choose a different image.";
    case "FILE_TOO_LARGE":
      return "That image is too large (max 10 MB). Please choose a smaller file.";
    case "UNSUPPORTED_FILE_TYPE":
      return "Unsupported file type. Please use a JPEG, PNG, or WEBP image.";
    case "INVALID_IMAGE_SIGNATURE":
      return "That file doesn't look like a valid image. Please choose a different file.";
    case "IMAGE_TOO_LARGE":
      return "That image's resolution is too large. Please crop it to the bet slip and try again.";
    case "AI_TIMEOUT":
      return "Recognition took too long. Please try again.";
    case "AI_UNAVAILABLE":
    case "AI_NOT_CONFIGURED":
      return "Bet recognition is temporarily unavailable. Please try again later.";
    case "IMAGE_NOT_RECOGNIZED":
      return "We couldn't recognize a bet slip in this image. Please try a clearer screenshot.";
    case "INCOMPLETE_BET_DATA":
      return "We could only partially read this bet slip. Please try a clearer screenshot.";
    case "INVALID_BET_SLIP":
      return "This bet doesn't have a valid number of selections. Please try again.";
    case "INTERNAL_ERROR":
    default:
      return "Something went wrong. Please try again.";
  }
}
