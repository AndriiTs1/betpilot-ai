import { isTelegramAuthErrorReason, getTelegramAuthErrorMessage } from "./telegramAuthError";
import { translate } from "@/lib/i18n/translations";
import type { Locale } from "@/lib/i18n/locale";

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
  // Handicap Stage H2 — canonical SPREAD display data, sourced identically
  // to `market`/`selection` above (mirrors lib/bets/buildBetSlipPreview.ts's
  // BetSlipPreviewSelection). null for any market with no participant, or
  // when verification never resolved one — never fabricated client-side.
  marketType: string | null;
  participant: string | null;
  // Individual Team Totals, Stage 5B — the canonical OVER/UNDER direction
  // (mirrors BetSlipPreviewSelection.selectionType), sourced identically to
  // marketType/participant/line. Needed alongside them so BetPreviewCard.tsx
  // can render a TEAM_TOTAL selection from canonical fields (see
  // lib/bets/normalizeSelectionToEnglish.ts's own TEAM_TOTAL branch).
  selectionType: string | null;
  // Already present on every real API response (mirrors
  // BetSlipPreviewSelection.line) — declared here, alongside marketType/
  // participant above, so BetPreviewCard.tsx can read it type-safely.
  line: string | null;
  submittedOdds: number | null;
  currentOdds: number | null;
  oddsStatus: BetSelectionOddsStatus;
  bookmaker: string | null;
  discrepancyPercent: number | null;
  // Full event display metadata — present only when the odds provider
  // unambiguously resolved the event; null otherwise, never fabricated.
  // Mirrors lib/bets/buildBetSlipPreview.ts's BetSlipPreviewSelection.
  homeTeamName: string | null;
  awayTeamName: string | null;
  competitionName: string | null;
  eventStartTime: string | null;
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
  | "ODDS_UNAVAILABLE"
  // UI-E1 — the server has always been able to send this (429, see
  // lib/rateLimit/rateLimitResponse.ts), but this client had no case for
  // it, so it silently fell through to getBetPreviewErrorMessage's generic
  // "Something went wrong" default, discarding the server's already-
  // computed retryAfterSeconds. See BetPreviewFailure's own comment for
  // how that value is threaded through.
  | "RATE_LIMITED"
  // Sector 1 (ADR-0002) — POST /api/miniapp/bets/express/exclude-legs's own
  // error codes (lib/bets/buildExpressLegExclusionPreview.ts's
  // ExpressLegExclusionErrorCode, plus the route's own INVALID_REQUEST/
  // NOT_EXPRESS_TOKEN shape checks). None of these are expected to be
  // player-caused in normal use (the UI only ever offers Remove on a
  // genuinely recoverable leg) — they exist as the server-side defense-in-
  // depth backstop, same "client mirrors server, server is the real gate"
  // pattern as every other business rule in this codebase.
  | "NOT_EXPRESS_TOKEN"
  | "NO_LEGS_EXCLUDED"
  | "DUPLICATE_LEG_INDEX"
  | "INVALID_LEG_INDEX"
  | "LEG_NOT_RECOVERABLE"
  | "ALL_LEGS_EXCLUDED"
  // Sector 1 (ADR-0002) — the exclude-legs endpoint verifies the incoming
  // previewToken the same way POST .../text/confirm does (it's a real,
  // signed EXPRESS token, not a fresh message/image), so it can return
  // these same two token-verification failures. Mirrors
  // BetConfirmErrorCode's identical two codes in betConfirmApi.ts — kept as
  // a separate, duplicated pair here rather than importing that file's
  // union, since betPreviewApi.ts has no existing dependency on
  // betConfirmApi.ts and this step's scope doesn't warrant introducing one
  // just to share two string literals.
  | "PREVIEW_EXPIRED"
  | "PREVIEW_INVALID";

export type BetPreviewFailure =
  | {
      kind: "http";
      code: BetPreviewErrorCode | "UNKNOWN";
      // UI-E1 — present only for a RATE_LIMITED (429) response, whose body
      // is the only one that ever carries this field
      // (lib/rateLimit/rateLimitResponse.ts). Optional, not required, so
      // every other existing `http` failure's shape/behavior is untouched.
      retryAfterSeconds?: number;
    }
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
    (s.marketType === null || typeof s.marketType === "string") &&
    (s.participant === null || typeof s.participant === "string") &&
    (s.selectionType === null || typeof s.selectionType === "string") &&
    (s.line === null || typeof s.line === "string") &&
    (s.submittedOdds === null || typeof s.submittedOdds === "number") &&
    (s.currentOdds === null || typeof s.currentOdds === "number") &&
    typeof s.oddsStatus === "string" &&
    ODDS_STATUSES.has(s.oddsStatus) &&
    (s.bookmaker === null || typeof s.bookmaker === "string") &&
    (s.discrepancyPercent === null || typeof s.discrepancyPercent === "number") &&
    (s.homeTeamName === null || typeof s.homeTeamName === "string") &&
    (s.awayTeamName === null || typeof s.awayTeamName === "string") &&
    (s.competitionName === null || typeof s.competitionName === "string") &&
    (s.eventStartTime === null || typeof s.eventStartTime === "string")
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

    // UI-E1 — only ever present on the RATE_LIMITED body
    // (lib/rateLimit/rateLimitResponse.ts's own { error, retryAfterSeconds }
    // shape); every other error body simply doesn't have this field, so
    // this stays undefined for them, same as before this change.
    const retryAfterSeconds =
      typeof body === "object" && body !== null && typeof (body as { retryAfterSeconds?: unknown }).retryAfterSeconds === "number"
        ? (body as { retryAfterSeconds: number }).retryAfterSeconds
        : undefined;

    return { ok: false, failure: { kind: "http", code, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) } };
  }

  const body: unknown = await response.json().catch(() => null);

  if (!isBetPreviewSuccess(body)) {
    return { ok: false, failure: { kind: "invalid_response" } };
  }

  return { ok: true, data: body };
}

// Sector 1 (ADR-0002) — same request/response/error-handling shape as
// fetchBetPreview above, for POST /api/miniapp/bets/express/exclude-legs.
// The request body carries only the already-signed previewToken and a list
// of leg indices — never odds/market/event data (the approved Variant B
// trust boundary). The success response is byte-for-byte the same
// BetPreviewSuccess shape fetchBetPreview returns, validated with the exact
// same isBetPreviewSuccess — no second, parallel response type.
export async function fetchExpressLegExclusionPreview(
  initData: string,
  previewToken: string,
  excludeIndices: readonly number[],
): Promise<BetPreviewResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;

  try {
    response = await fetch("/api/miniapp/bets/express/exclude-legs", {
      method: "POST",
      headers: {
        Authorization: `tma ${initData}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ previewToken, excludeIndices }),
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

    const retryAfterSeconds =
      typeof body === "object" && body !== null && typeof (body as { retryAfterSeconds?: unknown }).retryAfterSeconds === "number"
        ? (body as { retryAfterSeconds: number }).retryAfterSeconds
        : undefined;

    return { ok: false, failure: { kind: "http", code, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) } };
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

// Localization completion pass — `locale` defaults to "en" so every
// pre-existing call site/test that doesn't pass one keeps getting the exact
// same English text as before this pass; every UI call site now explicitly
// passes the player's real current locale (from useLocale()). The failure
// codes, their classification, and every business rule that produces them
// are completely untouched — only the returned string is localized.
export function getBetPreviewErrorMessage(failure: BetPreviewFailure, locale: Locale = "en"): string {
  if (failure.kind === "network") return translate(locale, "error.network");
  if (failure.kind === "timeout") return translate(locale, "error.timeout");
  if (failure.kind === "invalid_response") return translate(locale, "error.generic");

  if (isTelegramAuthErrorReason(failure.code)) {
    return getTelegramAuthErrorMessage(failure.code, locale);
  }

  switch (failure.code) {
    case "PLAYER_NOT_FOUND":
      return translate(locale, "error.playerNotFound");
    case "INVALID_MESSAGE":
      return translate(locale, "error.invalidMessage");
    case "PARSE_FAILED":
      // Odds deliberately not listed as something to add — they're never
      // required from the player, only event/selection/stake are. See
      // lib/ai/betParserPrompt.ts's chatPrompt for the matching parser-side
      // policy this message must stay consistent with.
      return translate(locale, "error.parseFailed");
    // Step 15J.3 — fallback text only (used if this failure ever reaches a
    // caller with just a single message slot, no dedicated UI). BetTextForm
    // itself never calls this for an AI_TIMEOUT failure — it renders its own
    // Title/Body/CTA block instead, gated on isAiTimeoutFailure above — but
    // this case still exists so the switch stays exhaustive-in-spirit and
    // this code never silently falls through to the generic default.
    case "AI_TIMEOUT":
      return translate(locale, "error.aiTimeoutPreview");
    case "INVALID_BET_SLIP":
      return translate(locale, "error.invalidBetSlip");
    // Stage 10.2 bugfix — see this union's own comment: these 5 codes were
    // already being sent by the server (Stage 10) but had no case here,
    // so they always fell through to the generic default below instead of
    // the specific, already-computed reason.
    case "EVENT_NOT_FOUND":
      return translate(locale, "error.eventNotFound");
    case "AMBIGUOUS_EVENT":
      return translate(locale, "error.ambiguousEvent");
    case "UNSUPPORTED_SELECTION":
      return translate(locale, "error.unsupportedSelection");
    case "EVENT_ALREADY_STARTED":
      return translate(locale, "error.eventAlreadyStarted");
    case "ODDS_UNAVAILABLE":
      return translate(locale, "error.oddsUnavailable");
    // UI-E1 — see BetPreviewErrorCode's own comment: this was previously
    // unhandled and fell through to the generic default below, discarding
    // the server's already-computed retryAfterSeconds.
    case "RATE_LIMITED":
      return failure.retryAfterSeconds !== undefined
        ? translate(locale, "error.rateLimitedWithSeconds", { seconds: String(failure.retryAfterSeconds) })
        : translate(locale, "error.rateLimited");
    // Sector 1 (ADR-0002) — ALL_LEGS_EXCLUDED is the one exclusion-error
    // code that's genuinely reachable in normal use (removing the last
    // recoverable leg alongside every other selection already gone) and
    // needs its own actionable message; the rest
    // (NOT_EXPRESS_TOKEN/NO_LEGS_EXCLUDED/DUPLICATE_LEG_INDEX/
    // INVALID_LEG_INDEX/LEG_NOT_RECOVERABLE) are server-side defense-in-
    // depth that the UI's own gating should never actually trigger, so they
    // fall through to the generic message like any other unexpected case.
    case "ALL_LEGS_EXCLUDED":
      return translate(locale, "error.allLegsExcluded");
    // Sector 1 (ADR-0002) — same friendly message/wording as
    // betConfirmApi.ts's identical PREVIEW_EXPIRED/PREVIEW_INVALID case for
    // the exact same underlying condition (a no-longer-valid signed token).
    case "PREVIEW_EXPIRED":
    case "PREVIEW_INVALID":
      return translate(locale, "error.previewExpired");
    case "NOT_EXPRESS_TOKEN":
    case "NO_LEGS_EXCLUDED":
    case "DUPLICATE_LEG_INDEX":
    case "INVALID_LEG_INDEX":
    case "LEG_NOT_RECOVERABLE":
    case "INVALID_JSON":
    case "INTERNAL_ERROR":
    default:
      return translate(locale, "error.generic");
  }
}
