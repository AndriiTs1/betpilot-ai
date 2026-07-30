import { isTelegramAuthErrorReason, getTelegramAuthErrorMessage } from "./telegramAuthError";

const REQUEST_TIMEOUT_MS = 15000;

// Stage 12, Phase 3 — unified SINGLE/EXPRESS shape. For a SINGLE bet,
// `selections` always has exactly 1 entry — the UI (BetPreviewCard.tsx)
// renders that case visually identically to how the old single-selection
// shape used to render, just reading from selections[0] now.
export type BetSelectionOddsStatus = "PENDING" | "VERIFIED" | "ODDS_CHANGED" | "NOT_FOUND" | "UNAVAILABLE";

export interface BetPreviewSelection {
  sport: string;
  event: string;
  market: string | null;
  selection: string;
  submittedOdds: number | null;
  currentOdds: number | null;
  oddsStatus: BetSelectionOddsStatus;
  bookmaker: string | null;
  discrepancyPercent: number | null;
}

export interface BetPreview {
  type: "SINGLE" | "EXPRESS";
  stake: number;
  totalOdds: number | null;
  potentialWin: number | null;
  selections: BetPreviewSelection[];
}

export interface BetPreviewSuccess {
  preview: BetPreview;
  // null for EXPRESS — confirm doesn't support it yet (see
  // lib/bets/buildBetSlipPreview.ts). Always a real token for SINGLE.
  previewToken: string | null;
}

export type BetPreviewErrorCode =
  | "malformed"
  | "invalid_signature"
  | "expired"
  | "PLAYER_NOT_FOUND"
  | "INVALID_JSON"
  | "INVALID_MESSAGE"
  | "PARSE_FAILED"
  // Step 15J.3 — a parser-layer timeout, distinguished from PARSE_FAILED:
  // the message was understandable, Claude just didn't respond in time.
  // Mirrors betScreenshotApi.ts's own identical code for the exact same
  // condition (app/api/miniapp/bets/text/preview/route.ts's
  // `parsed.code === "timeout"` branch), though the two error-code unions
  // remain separate types, never merged into one shared union.
  | "AI_TIMEOUT"
  | "INVALID_BET_SLIP"
  | "INTERNAL_ERROR"
  // Stage 10.2 bugfix — the 5 error codes
  // app/api/miniapp/bets/text/preview/route.ts's sportmonksFootballErrorResponse
  // already sent from the server since Stage 10, but this client type/the
  // getBetPreviewErrorMessage switch below were never updated to recognize
  // them. Every one of these previously fell through to the generic
  // "Something went wrong" default — even though the server had already
  // computed an honest, specific reason — because TypeScript scope forces a
  // literal `as` cast at fetchBetPreview's parse site (there is no runtime
  // check against this union), so an unrecognized string was silently
  // accepted as valid but never matched any switch case.
  | "EVENT_NOT_FOUND"
  | "AMBIGUOUS_EVENT"
  | "UNSUPPORTED_SELECTION"
  | "EVENT_ALREADY_STARTED"
  | "ODDS_UNAVAILABLE";

export type BetPreviewFailure =
  | { kind: "http"; code: BetPreviewErrorCode | "UNKNOWN" }
  | { kind: "network" }
  | { kind: "timeout" }
  | { kind: "invalid_response" };

export type BetPreviewResult = { ok: true; data: BetPreviewSuccess } | { ok: false; failure: BetPreviewFailure };

const ODDS_STATUSES: ReadonlySet<string> = new Set([
  "PENDING",
  "VERIFIED",
  "ODDS_CHANGED",
  "NOT_FOUND",
  "UNAVAILABLE",
]);

function isBetPreviewSelection(value: unknown): value is BetPreviewSelection {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.sport === "string" &&
    typeof s.event === "string" &&
    (s.market === null || typeof s.market === "string") &&
    typeof s.selection === "string" &&
    (s.submittedOdds === null || typeof s.submittedOdds === "number") &&
    (s.currentOdds === null || typeof s.currentOdds === "number") &&
    typeof s.oddsStatus === "string" &&
    ODDS_STATUSES.has(s.oddsStatus) &&
    (s.bookmaker === null || typeof s.bookmaker === "string") &&
    (s.discrepancyPercent === null || typeof s.discrepancyPercent === "number")
  );
}

// Minimal structural check before trusting a bare preview object (no
// previewToken wrapper) — the shape POST .../text/confirm's own
// `refreshedPreview` field (409 ODDS_CHANGED_RECONFIRM_REQUIRED, Step 15B)
// uses. Exported so betConfirmApi.ts can validate that field against the
// exact same runtime shape as every other preview in this app, rather than
// a second parallel implementation.
export function isBetPreview(value: unknown): value is BetPreview {
  if (typeof value !== "object" || value === null) return false;

  const p = value as Record<string, unknown>;
  return (
    (p.type === "SINGLE" || p.type === "EXPRESS") &&
    typeof p.stake === "number" &&
    (p.totalOdds === null || typeof p.totalOdds === "number") &&
    (p.potentialWin === null || typeof p.potentialWin === "number") &&
    Array.isArray(p.selections) &&
    p.selections.length > 0 &&
    p.selections.every(isBetPreviewSelection)
  );
}

// Minimal structural check before trusting the response shape — no blind
// `as BetPreviewSuccess` cast. Doesn't validate every nested field
// exhaustively, just enough to catch a genuinely malformed/unexpected body.
// Exported so betScreenshotApi.ts can validate its own response against the
// exact same runtime shape — the screenshot preview endpoint's success
// contract is deliberately identical to this one, so this is the only
// success-shape validator, not a second parallel implementation.
export function isBetPreviewSuccess(value: unknown): value is BetPreviewSuccess {
  if (
    typeof value !== "object" ||
    value === null ||
    !("preview" in value) ||
    !("previewToken" in value)
  ) {
    return false;
  }

  const previewToken = (value as { previewToken: unknown }).previewToken;
  if (previewToken !== null && typeof previewToken !== "string") return false;

  return isBetPreview((value as { preview: unknown }).preview);
}

export async function fetchBetPreview(initData: string, message: string): Promise<BetPreviewResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;

  try {
    response = await fetch("/api/miniapp/bets/text/preview", {
      method: "POST",
      headers: {
        Authorization: `tma ${initData}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
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
        ? ((body as { error: string }).error as BetPreviewErrorCode | "UNKNOWN")
        : "UNKNOWN";

    return { ok: false, failure: { kind: "http", code } };
  }

  const body: unknown = await response.json().catch(() => null);

  if (!isBetPreviewSuccess(body)) {
    return { ok: false, failure: { kind: "invalid_response" } };
  }

  return { ok: true, data: body };
}

// Step 15J.3 — the one place BetTextForm derives whether a preview failure
// was specifically an AI timeout, so its dedicated "AI service timed out /
// Try again" UI is never driven by string-matching getBetPreviewErrorMessage's
// output. Structured field only (failure.kind/code), never message text.
export function isAiTimeoutFailure(failure: BetPreviewFailure): boolean {
  return failure.kind === "http" && failure.code === "AI_TIMEOUT";
}

export function getBetPreviewErrorMessage(failure: BetPreviewFailure): string {
  if (failure.kind === "network") return "Unable to connect. Check your internet connection.";
  if (failure.kind === "timeout") return "The request took too long. Please try again.";
  if (failure.kind === "invalid_response") return "Something went wrong. Please try again.";

  if (isTelegramAuthErrorReason(failure.code)) {
    return getTelegramAuthErrorMessage(failure.code);
  }

  switch (failure.code) {
    case "PLAYER_NOT_FOUND":
      return "Your player account was not found.";
    case "INVALID_MESSAGE":
      return "Enter a valid bet message.";
    case "PARSE_FAILED":
      // Odds deliberately not listed as something to add — they're never
      // required from the player, only event/selection/stake are. See
      // lib/ai/betParserPrompt.ts's chatPrompt for the matching parser-side
      // policy this message must stay consistent with.
      return "We could not understand this bet. Try including the event, selection, and stake.";
    // Step 15J.3 — fallback text only (used if this failure ever reaches a
    // caller with just a single message slot, no dedicated UI). BetTextForm
    // itself never calls this for an AI_TIMEOUT failure — it renders its own
    // Title/Body/CTA block instead, gated on isAiTimeoutFailure above — but
    // this case still exists so the switch stays exhaustive-in-spirit and
    // this code never silently falls through to the generic default.
    case "AI_TIMEOUT":
      return "Your bet was not rejected. The analysis took too long. Please try again.";
    case "INVALID_BET_SLIP":
      return "This bet doesn't have a valid number of selections. Please try again.";
    // Stage 10.2 bugfix — see this union's own comment: these 5 codes were
    // already being sent by the server (Stage 10) but had no case here,
    // so they always fell through to the generic default below instead of
    // the specific, already-computed reason.
    case "EVENT_NOT_FOUND":
      return "We couldn't find that team or match. Please check the spelling and try again.";
    case "AMBIGUOUS_EVENT":
      return "We found more than one matching event. Please be more specific, e.g. include both team names.";
    case "UNSUPPORTED_SELECTION":
      return "Only Home win, Draw, or Away win are supported for this event right now.";
    case "EVENT_ALREADY_STARTED":
      return "This match has already started. Please choose a different event.";
    case "ODDS_UNAVAILABLE":
      return "Odds for this selection aren't available right now. Please try again shortly.";
    case "INVALID_JSON":
    case "INTERNAL_ERROR":
    default:
      return "Something went wrong. Please try again.";
  }
}
