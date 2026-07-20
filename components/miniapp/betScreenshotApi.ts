import { isBetPreviewSuccess, type BetPreviewSuccess } from "./betPreviewApi";

const REQUEST_TIMEOUT_MS = 15000;

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
  | "AI_NOT_CONFIGURED"
  | "AI_TIMEOUT"
  | "AI_UNAVAILABLE"
  | "IMAGE_NOT_RECOGNIZED"
  | "INCOMPLETE_BET_DATA"
  | "INTERNAL_ERROR";

export interface ParlaySelectionPreview {
  sport: string;
  event: string;
  selection: string;
  odds: number | null;
}

export type BetScreenshotFailure =
  | { kind: "http"; code: BetScreenshotErrorCode | "UNKNOWN" }
  | { kind: "parlay_not_supported"; stake: number; selections: ParlaySelectionPreview[] }
  | { kind: "network" }
  | { kind: "timeout" }
  | { kind: "invalid_response" };

export type BetScreenshotResult =
  | { ok: true; data: BetPreviewSuccess }
  | { ok: false; failure: BetScreenshotFailure };

function isParlaySelectionPreview(value: unknown): value is ParlaySelectionPreview {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.sport === "string" &&
    typeof s.event === "string" &&
    typeof s.selection === "string" &&
    (s.odds === null || typeof s.odds === "number")
  );
}

function parseParlayFailure(body: unknown): BetScreenshotFailure | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.error !== "PARLAY_CONFIRM_NOT_SUPPORTED") return null;

  const parsed = b.parsed;
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  if (typeof p.stake !== "number" || !Array.isArray(p.selections) || !p.selections.every(isParlaySelectionPreview)) {
    return null;
  }

  return { kind: "parlay_not_supported", stake: p.stake, selections: p.selections };
}

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

    const parlayFailure = parseParlayFailure(body);
    if (parlayFailure) return { ok: false, failure: parlayFailure };

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
  if (failure.kind === "parlay_not_supported") {
    return "This looks like a multi-selection (parlay) bet. Parlay confirmation isn't supported yet — please describe it as text instead.";
  }

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
    case "AI_TIMEOUT":
      return "Recognition took too long. Please try again.";
    case "AI_UNAVAILABLE":
    case "AI_NOT_CONFIGURED":
      return "Bet recognition is temporarily unavailable. Please try again later.";
    case "IMAGE_NOT_RECOGNIZED":
      return "We couldn't recognize a bet slip in this image. Please try a clearer screenshot.";
    case "INCOMPLETE_BET_DATA":
      return "We could only partially read this bet slip. Please try a clearer screenshot.";
    case "INTERNAL_ERROR":
    default:
      return "Something went wrong. Please try again.";
  }
}
