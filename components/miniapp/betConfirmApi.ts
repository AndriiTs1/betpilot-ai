import { isTelegramAuthErrorReason, getTelegramAuthErrorMessage } from "./telegramAuthError";
import { isBetPreview, type BetPreview, type BetPreviewSuccess } from "./betPreviewApi";

const REQUEST_TIMEOUT_MS = 15000;

// ConfirmedBet — unchanged since Phase 3, byte-for-byte. Kept exactly as
// this shape (not widened, not renamed): Phase 4 Step 4 found that turning
// this into a union directly broke BetScreen.tsx's then out-of-scope
// toBetTicketData (`Type 'string | null' is not assignable to type
// 'string'`), so the EXPRESS shape lives under new names instead — see
// AnyConfirmedBet below, which is what BetScreen.tsx/BetTicket.tsx/
// BetTextForm.tsx/BetScreenshotForm.tsx actually consume as of Step 5.
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

// The shape app/api/miniapp/bets/text/confirm/route.ts returns for a
// confirmed EXPRESS bet (Phase 4, Step 4) — now actually rendered by
// BetTicket.tsx (Step 5).
export interface ConfirmedExpressSelection {
  id: string;
  sport: string;
  event: string;
  outcome: string;
  market: string | null;
  odds: string | null;
  currentOdds: string | null;
  oddsStatus: string;
}

export interface ConfirmedExpressBet {
  id: string;
  status: "PENDING";
  type: "EXPRESS";
  sport: string;
  event: null;
  outcome: null;
  odds: null;
  stake: string;
  totalOdds: string | null;
  createdAt: string;
  selections: ConfirmedExpressSelection[];
}

// Stage 12, Phase 4, Step 5 — the discriminated union the UI now consumes:
// BetTextForm.tsx/BetScreenshotForm.tsx/BetScreen.tsx/BetTicket.tsx all
// branch on `.type` to render either shape. ConfirmedBet itself is left
// completely alone (still exactly its Phase 3 shape) — only this union and
// BetConfirmSuccess.bet's type change.
export type AnyConfirmedBet = ConfirmedBet | ConfirmedExpressBet;

export interface BetConfirmSuccess {
  bet: AnyConfirmedBet;
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
  // Step 15B — listed here for completeness/documentation of every code the
  // server can send, but this one is never surfaced through the generic
  // `{kind:"http", code}` path: fetchBetConfirm below intercepts it and
  // returns the dedicated `{kind:"odds_changed", ...}` failure instead,
  // since (unlike every other code) it carries data the caller must act on,
  // not just a message to display.
  | "ODDS_CHANGED_RECONFIRM_REQUIRED"
  | "INTERNAL_ERROR";

// Step 15B — a distinct failure kind, not a `{kind:"http", code}` variant,
// specifically because this one carries a payload the caller needs
// (refreshedPreview/refreshedPreviewToken), not just a display message.
// Only ever constructed after both fields have been runtime-validated
// (isBetPreview + non-empty string) — see fetchBetConfirm below. A 409 body
// that fails that validation falls back to the safe, dataless
// `invalid_response` failure instead, never a partially-trusted payload.
export interface BetConfirmOddsChangedFailure {
  kind: "odds_changed";
  refreshedPreview: BetPreview;
  refreshedPreviewToken: string;
}

export type BetConfirmFailure =
  | { kind: "http"; code: BetConfirmErrorCode | "UNKNOWN" }
  | { kind: "network" }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "invalid_response" }
  | BetConfirmOddsChangedFailure;

export type BetConfirmResult =
  | { ok: true; data: BetConfirmSuccess }
  | { ok: false; failure: BetConfirmFailure };

// Plain boolean helpers, not `value is X` predicates — same reasoning as
// this file's earlier attempt: a type predicate's return type must be
// assignable to its parameter type, and `Record<string, unknown>` (no
// index signature) isn't assignable to/from a concrete interface.
// isBetConfirmSuccess below narrows via the already-boolean result and its
// own local `b.type` check instead.
function isConfirmedSingleBetShape(b: Record<string, unknown>): boolean {
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

function isConfirmedExpressSelectionShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.sport === "string" &&
    typeof s.event === "string" &&
    typeof s.outcome === "string" &&
    (s.market === null || typeof s.market === "string") &&
    (s.odds === null || typeof s.odds === "string") &&
    (s.currentOdds === null || typeof s.currentOdds === "string") &&
    typeof s.oddsStatus === "string"
  );
}

function isConfirmedExpressBetShape(b: Record<string, unknown>): boolean {
  return (
    typeof b.id === "string" &&
    b.status === "PENDING" &&
    b.type === "EXPRESS" &&
    typeof b.sport === "string" &&
    b.event === null &&
    b.outcome === null &&
    b.odds === null &&
    typeof b.stake === "string" &&
    (b.totalOdds === null || typeof b.totalOdds === "string") &&
    typeof b.createdAt === "string" &&
    Array.isArray(b.selections) &&
    b.selections.every(isConfirmedExpressSelectionShape)
  );
}

// Minimal structural check before trusting the response shape — same
// discipline as betPreviewApi.ts's isBetPreviewSuccess. No blind cast.
// Stage 12, Phase 4, Step 5 — now accepts either a SINGLE or an EXPRESS
// confirmed bet, dispatched by the already-validated `type` field.
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
  return isConfirmedSingleBetShape(b) || isConfirmedExpressBetShape(b);
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

    // Step 15B — the one response code that carries data the caller must
    // act on (a fresh preview + token to reconfirm against), not just a
    // message. Both fields are runtime-validated before being trusted at
    // all: a malformed/incomplete 409 body (wrong shape, empty token, odds
    // API response was tampered with in transit, etc.) falls back to the
    // safe, dataless `invalid_response` failure instead of ever handing the
    // caller a half-valid payload it might act on unsafely.
    if (code === "ODDS_CHANGED_RECONFIRM_REQUIRED" && typeof body === "object" && body !== null) {
      const refreshedPreview = (body as { refreshedPreview?: unknown }).refreshedPreview;
      const refreshedPreviewToken = (body as { refreshedPreviewToken?: unknown }).refreshedPreviewToken;

      if (
        isBetPreview(refreshedPreview) &&
        typeof refreshedPreviewToken === "string" &&
        refreshedPreviewToken.length > 0
      ) {
        return { ok: false, failure: { kind: "odds_changed", refreshedPreview, refreshedPreviewToken } };
      }

      return { ok: false, failure: { kind: "invalid_response" } };
    }

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
  // Step 15B — defensive only: BetTextForm/BetScreenshotForm intercept
  // `kind: "odds_changed"` before ever calling this function (it needs the
  // refreshedPreview/refreshedPreviewToken payload, which a plain message
  // string can't carry) — see buildOddsChangedReconfirm below. This exists
  // so the function stays total or a future caller that forgets to
  // intercept it still gets a sane message instead of a crash.
  if (failure.kind === "odds_changed") return "Odds have changed. Please review and confirm again.";

  if (isTelegramAuthErrorReason(failure.code)) {
    return getTelegramAuthErrorMessage(failure.code);
  }

  switch (failure.code) {
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

function formatOdds(value: number | null): string {
  return value !== null ? value.toFixed(2) : "—";
}

export interface OddsChangedReconfirmUpdate {
  // Always a real, non-null previewToken (validated by fetchBetConfirm
  // before this is ever called) — a form can hand this straight to
  // canConfirmBetSlip/fetchBetConfirm exactly like any other preview.
  preview: BetPreviewSuccess;
  message: string;
}

// Step 15B — the one piece of logic both BetTextForm and BetScreenshotForm
// need identically when a confirm attempt comes back as
// ODDS_CHANGED_RECONFIRM_REQUIRED: build the new preview/token pair to
// stage (never auto-submitted — the caller still requires an explicit
// Confirm tap) and a message showing old vs. new odds per selection.
// `stalePreview` is the preview the player was just looking at (still in
// the form's own state at the moment the confirm response comes back) —
// used only to read the odds they last saw, never resubmitted anywhere;
// the returned `preview` is built entirely from the server's fresh
// refreshedPreview/refreshedPreviewToken, never mixed with anything stale.
export function buildOddsChangedReconfirm(
  stalePreview: BetPreviewSuccess | null,
  failure: BetConfirmOddsChangedFailure,
): OddsChangedReconfirmUpdate {
  const staleSelections = stalePreview?.preview.selections ?? [];

  const lines = failure.refreshedPreview.selections.map((selection, index) => {
    const staleOdds = staleSelections[index]?.submittedOdds ?? null;
    return `${selection.event}: ${formatOdds(staleOdds)} → ${formatOdds(selection.currentOdds)}`;
  });

  const message =
    `⚠️ Odds have changed since you last checked.\n\n${lines.join("\n")}` +
    `\n\nPlease review and confirm again.`;

  return {
    preview: { preview: failure.refreshedPreview, previewToken: failure.refreshedPreviewToken },
    message,
  };
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
