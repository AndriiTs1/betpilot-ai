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
  | "INVALID_BET_SLIP"
  | "INTERNAL_ERROR";

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

  const preview = (value as { preview: unknown }).preview;
  if (typeof preview !== "object" || preview === null) return false;

  const p = preview as Record<string, unknown>;
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

export function getBetPreviewErrorMessage(failure: BetPreviewFailure): string {
  if (failure.kind === "network") return "Unable to connect. Check your internet connection.";
  if (failure.kind === "timeout") return "The request took too long. Please try again.";
  if (failure.kind === "invalid_response") return "Something went wrong. Please try again.";

  switch (failure.code) {
    case "malformed":
    case "invalid_signature":
      return "Unable to verify Telegram session. Reopen the Mini App.";
    case "expired":
      return "Your Telegram session expired. Reopen the Mini App.";
    case "PLAYER_NOT_FOUND":
      return "Your player account was not found.";
    case "INVALID_MESSAGE":
      return "Enter a valid bet message.";
    case "PARSE_FAILED":
      return "We could not understand this bet. Try adding event, selection, stake and odds.";
    case "INVALID_BET_SLIP":
      return "This bet doesn't have a valid number of selections. Please try again.";
    case "INVALID_JSON":
    case "INTERNAL_ERROR":
    default:
      return "Something went wrong. Please try again.";
  }
}
