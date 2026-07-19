const REQUEST_TIMEOUT_MS = 15000;

export interface BetPreview {
  type: "SINGLE";
  sport: string;
  event: string;
  outcome: string;
  stake: number;
  odds: number | null;
  totalOdds: number | null;
  potentialWin: number | null;
}

export interface BetOddsCheck {
  matched: boolean;
  withinTolerance: boolean | null;
  sourceOdds: number | null;
  submittedOdds: number;
  discrepancyPercent: number | null;
  bookmaker: string | null;
  note: string | null;
}

export interface BetPreviewSuccess {
  preview: BetPreview;
  oddsCheck: BetOddsCheck | null;
}

export type BetPreviewErrorCode =
  | "malformed"
  | "invalid_signature"
  | "expired"
  | "PLAYER_NOT_FOUND"
  | "INVALID_JSON"
  | "INVALID_MESSAGE"
  | "PARSE_FAILED"
  | "INTERNAL_ERROR";

export type BetPreviewFailure =
  | { kind: "http"; code: BetPreviewErrorCode | "UNKNOWN" }
  | { kind: "network" }
  | { kind: "timeout" }
  | { kind: "invalid_response" };

export type BetPreviewResult = { ok: true; data: BetPreviewSuccess } | { ok: false; failure: BetPreviewFailure };

// Minimal structural check before trusting the response shape — no blind
// `as BetPreviewSuccess` cast. Doesn't validate every nested field
// exhaustively, just enough to catch a genuinely malformed/unexpected body.
function isBetPreviewSuccess(value: unknown): value is BetPreviewSuccess {
  if (typeof value !== "object" || value === null || !("preview" in value) || !("oddsCheck" in value)) {
    return false;
  }

  const preview = (value as { preview: unknown }).preview;
  if (typeof preview !== "object" || preview === null) return false;

  const p = preview as Record<string, unknown>;
  return (
    typeof p.sport === "string" &&
    typeof p.event === "string" &&
    typeof p.outcome === "string" &&
    typeof p.stake === "number" &&
    (p.odds === null || typeof p.odds === "number") &&
    (p.totalOdds === null || typeof p.totalOdds === "number") &&
    (p.potentialWin === null || typeof p.potentialWin === "number")
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
    case "INVALID_JSON":
    case "INTERNAL_ERROR":
    default:
      return "Something went wrong. Please try again.";
  }
}
