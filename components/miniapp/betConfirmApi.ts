const REQUEST_TIMEOUT_MS = 15000;

export interface ConfirmedBet {
  id: string;
  status: "PENDING";
  type: "SINGLE";
  sport: string;
  event: string;
  outcome: string;
  stake: number;
  odds: number | null;
  totalOdds: number | null;
  createdAt: string;
}

export interface BetConfirmSuccess {
  bet: ConfirmedBet;
  idempotent: boolean;
}

export type BetConfirmErrorCode =
  | "malformed"
  | "invalid_signature"
  | "expired"
  | "PLAYER_NOT_FOUND"
  | "INVALID_REQUEST"
  | "PREVIEW_INVALID"
  | "PREVIEW_EXPIRED"
  | "INTERNAL_ERROR";

export type BetConfirmFailure =
  | { kind: "http"; code: BetConfirmErrorCode | "UNKNOWN" }
  | { kind: "network" }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "invalid_response" };

export type BetConfirmResult =
  | { ok: true; data: BetConfirmSuccess }
  | { ok: false; failure: BetConfirmFailure };

// Minimal structural check before trusting the response shape — same
// discipline as betPreviewApi.ts's isBetPreviewSuccess. No blind cast.
function isBetConfirmSuccess(value: unknown): value is BetConfirmSuccess {
  if (
    typeof value !== "object" ||
    value === null ||
    !("bet" in value) ||
    !("idempotent" in value) ||
    typeof (value as { idempotent: unknown }).idempotent !== "boolean"
  ) {
    return false;
  }

  const bet = (value as { bet: unknown }).bet;
  if (typeof bet !== "object" || bet === null) return false;

  const b = bet as Record<string, unknown>;
  return (
    typeof b.id === "string" &&
    b.status === "PENDING" &&
    b.type === "SINGLE" &&
    typeof b.sport === "string" &&
    typeof b.event === "string" &&
    typeof b.outcome === "string" &&
    typeof b.stake === "number" &&
    (b.odds === null || typeof b.odds === "number") &&
    (b.totalOdds === null || typeof b.totalOdds === "number") &&
    typeof b.createdAt === "string"
  );
}

// externalSignal lets the caller cancel on unmount/replacement; it's
// combined with this function's own timeout controller so a single fetch
// call reacts to either trigger.
export async function fetchBetConfirm(
  initData: string,
  previewToken: string,
  externalSignal?: AbortSignal,
): Promise<BetConfirmResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort);

  let response: Response;

  try {
    response = await fetch("/api/miniapp/bets/text/confirm", {
      method: "POST",
      headers: {
        Authorization: `tma ${initData}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ previewToken }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      if (timedOut) return { ok: false, failure: { kind: "timeout" } };
      return { ok: false, failure: { kind: "aborted" } };
    }
    return { ok: false, failure: { kind: "network" } };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const code =
      typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
        ? ((body as { error: string }).error as BetConfirmErrorCode | "UNKNOWN")
        : "UNKNOWN";

    return { ok: false, failure: { kind: "http", code } };
  }

  const body: unknown = await response.json().catch(() => null);

  if (!isBetConfirmSuccess(body)) {
    return { ok: false, failure: { kind: "invalid_response" } };
  }

  return { ok: true, data: body };
}

export function getBetConfirmErrorMessage(failure: BetConfirmFailure): string {
  if (failure.kind === "network") return "Unable to connect. Check your internet connection.";
  if (failure.kind === "timeout") return "The request took too long. Please try again.";
  if (failure.kind === "invalid_response") return "Something went wrong. Please try again.";
  if (failure.kind === "aborted") return "";

  switch (failure.code) {
    case "malformed":
    case "invalid_signature":
    case "expired":
      return "Your Telegram session needs to be refreshed. Reopen the Mini App.";
    case "PLAYER_NOT_FOUND":
      return "Your player account could not be found.";
    // Stage 10 — same friendly message for every reason a previewToken can
    // no longer be confirmed (expired, signature/shape invalid, or the
    // token simply doesn't match what confirm expects). The player never
    // needs to tell these apart; server-side logs still capture the real
    // reason. Rendered with whitespace-pre-line so the blank lines below
    // actually show up (see BetTextForm.tsx / BetScreenshotForm.tsx).
    case "PREVIEW_EXPIRED":
    case "PREVIEW_INVALID":
      return "⏳ This preview has expired.\n\nOdds may have changed.\n\nPlease generate a new preview.";
    case "INVALID_REQUEST":
    case "INTERNAL_ERROR":
    default:
      return "Something went wrong. Please try again.";
  }
}

// Whether previewToken/preview data should be discarded after this failure.
// Kept as a single source of truth so the UI never has to re-derive it.
export function shouldResetPreviewAfterConfirmFailure(failure: BetConfirmFailure): boolean {
  if (failure.kind !== "http") return false; // network/timeout/invalid_response/aborted: keep, retry is safe

  switch (failure.code) {
    case "malformed":
    case "invalid_signature":
    case "expired":
    case "PLAYER_NOT_FOUND":
    case "INVALID_REQUEST":
    case "PREVIEW_EXPIRED":
    case "PREVIEW_INVALID":
      return true;
    case "INTERNAL_ERROR":
    default:
      return false;
  }
}
