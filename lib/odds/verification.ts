// Step 5 — verification statuses, reason codes, and the provider-neutral
// VerificationResult shape. See docs/ODDS_PROVIDER_DESIGN.md Sections 3
// and 6-7 for the full design.

export type VerificationStatus = "VERIFIED" | "ODDS_CHANGED" | "FAILED" | "NOT_CHECKED";

export const VERIFICATION_STATUSES: readonly VerificationStatus[] = [
  "VERIFIED",
  "ODDS_CHANGED",
  "FAILED",
  "NOT_CHECKED",
];

// Kept deliberately small (4 values) — every UI/policy consumer only needs
// "confirmable / confirmable-with-acceptance / blocked" (docs/ODDS_PROVIDER_DESIGN.md
// Section 3). Detailed causes live in VerificationReasonCode below, which is
// allowed to be larger and more volatile since its audience is
// logging/operator tooling, not every UI branch.
export type VerificationReasonCode =
  | "NONE"
  | "EVENT_NOT_FOUND"
  | "MARKET_NOT_SUPPORTED"
  | "SELECTION_NOT_FOUND"
  | "SPORT_NOT_SUPPORTED"
  | "LEAGUE_NOT_SUPPORTED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_INVALID_RESPONSE"
  | "AMBIGUOUS_EVENT"
  | "INVALID_INPUT"
  | "ODDS_OUTSIDE_TOLERANCE"
  | "NOT_CHECKED";

export const VERIFICATION_REASON_CODES: readonly VerificationReasonCode[] = [
  "NONE",
  "EVENT_NOT_FOUND",
  "MARKET_NOT_SUPPORTED",
  "SELECTION_NOT_FOUND",
  "SPORT_NOT_SUPPORTED",
  "LEAGUE_NOT_SUPPORTED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_INVALID_RESPONSE",
  "AMBIGUOUS_EVENT",
  "INVALID_INPUT",
  "ODDS_OUTSIDE_TOLERANCE",
  "NOT_CHECKED",
];

// Classification from docs/ODDS_PROVIDER_DESIGN.md Section 3's table.
// "retryable" governs whether a caller may reattempt the same request
// (used by lib/odds/theOddsApiProvider.ts's VerificationResult.retryable
// field, and intended for a future retry/backoff layer — not implemented
// in Step 5, see docs/ODDS_PROVIDER_DESIGN.md Section 17).
export type ReasonCodeCategory =
  | "SUCCESS"
  | "COMPARISON"
  | "MATCHING_FAILURE"
  | "COVERAGE_FAILURE"
  | "PROVIDER_FAILURE"
  | "INPUT_FAILURE"
  | "NOT_ATTEMPTED";

interface ReasonCodeClassification {
  readonly category: ReasonCodeCategory;
  readonly retryable: boolean;
}

const REASON_CODE_CLASSIFICATION: Readonly<Record<VerificationReasonCode, ReasonCodeClassification>> = {
  NONE: { category: "SUCCESS", retryable: false },
  EVENT_NOT_FOUND: { category: "MATCHING_FAILURE", retryable: false },
  MARKET_NOT_SUPPORTED: { category: "COVERAGE_FAILURE", retryable: false },
  SELECTION_NOT_FOUND: { category: "MATCHING_FAILURE", retryable: false },
  SPORT_NOT_SUPPORTED: { category: "COVERAGE_FAILURE", retryable: false },
  LEAGUE_NOT_SUPPORTED: { category: "COVERAGE_FAILURE", retryable: false },
  PROVIDER_UNAVAILABLE: { category: "PROVIDER_FAILURE", retryable: true },
  PROVIDER_TIMEOUT: { category: "PROVIDER_FAILURE", retryable: true },
  PROVIDER_RATE_LIMITED: { category: "PROVIDER_FAILURE", retryable: true },
  PROVIDER_INVALID_RESPONSE: { category: "PROVIDER_FAILURE", retryable: true },
  AMBIGUOUS_EVENT: { category: "MATCHING_FAILURE", retryable: false },
  INVALID_INPUT: { category: "INPUT_FAILURE", retryable: false },
  ODDS_OUTSIDE_TOLERANCE: { category: "COMPARISON", retryable: false },
  NOT_CHECKED: { category: "NOT_ATTEMPTED", retryable: false },
};

export function classifyReasonCode(reason: VerificationReasonCode): ReasonCodeClassification {
  return REASON_CODE_CLASSIFICATION[reason];
}

export function isRetryableReason(reason: VerificationReasonCode): boolean {
  return REASON_CODE_CLASSIFICATION[reason].retryable;
}

/* -------------------------------------------------------------------------- */
/* VerificationResult                                                         */
/* -------------------------------------------------------------------------- */

// Provider identity lives here (not in domain.ts) since it's inherently a
// provider-interaction concept — see lib/odds/oddsProvider.ts for the full
// ProviderName union and provider-reference types this result may embed.
import type { ProviderEventCandidate, ProviderName, ProviderOutcome } from "./oddsProvider";

// Step 5 does not implement explicit player acceptance (that's a later
// application-service concern per docs/ODDS_PROVIDER_DESIGN.md Section 6) —
// a provider/adapter never mutates acceptedOdds after construction; only
// the VERIFIED-path factory below is allowed to set it automatically.
export interface VerificationResult {
  readonly status: VerificationStatus;
  readonly reasonCode: VerificationReasonCode;
  readonly submittedOdds: string | null;
  readonly currentOdds: string | null;
  readonly acceptedOdds: string | null;
  readonly differencePercentage: string | null;
  readonly matchedEvent?: ProviderEventCandidate;
  readonly matchedOutcome?: ProviderOutcome;
  readonly provider: ProviderName;
  readonly bookmaker?: string;
  readonly checkedAt: string; // ISO 8601
  readonly providerTimestamp?: string;
  readonly retryable: boolean;
  readonly publicMessageKey: string;
  readonly diagnosticCode?: string;
}

export interface VerificationResultInput {
  readonly submittedOdds: string | null;
  readonly provider: ProviderName;
  readonly checkedAt: string;
  readonly currentOdds?: string | null;
  readonly differencePercentage?: string | null;
  readonly matchedEvent?: ProviderEventCandidate;
  readonly matchedOutcome?: ProviderOutcome;
  readonly bookmaker?: string;
  readonly providerTimestamp?: string;
  readonly diagnosticCode?: string;
}

const PUBLIC_MESSAGE_KEYS: Readonly<Record<VerificationStatus | VerificationReasonCode, string>> = {
  VERIFIED: "odds.verified",
  ODDS_CHANGED: "odds.changed",
  FAILED: "odds.failed",
  NOT_CHECKED: "odds.not_checked",
  NONE: "odds.verified",
  EVENT_NOT_FOUND: "odds.event_not_found",
  MARKET_NOT_SUPPORTED: "odds.market_not_supported",
  SELECTION_NOT_FOUND: "odds.selection_not_found",
  SPORT_NOT_SUPPORTED: "odds.sport_not_supported",
  LEAGUE_NOT_SUPPORTED: "odds.league_not_supported",
  PROVIDER_UNAVAILABLE: "odds.provider_unavailable",
  PROVIDER_TIMEOUT: "odds.provider_timeout",
  PROVIDER_RATE_LIMITED: "odds.provider_rate_limited",
  PROVIDER_INVALID_RESPONSE: "odds.provider_invalid_response",
  AMBIGUOUS_EVENT: "odds.ambiguous_event",
  INVALID_INPUT: "odds.invalid_input",
  ODDS_OUTSIDE_TOLERANCE: "odds.changed",
};

function publicMessageKeyFor(status: VerificationStatus, reasonCode: VerificationReasonCode): string {
  if (status === "FAILED") return PUBLIC_MESSAGE_KEYS[reasonCode];
  return PUBLIC_MESSAGE_KEYS[status];
}

// --- Factories -------------------------------------------------------------
// Each factory is the only way to construct a VerificationResult for its
// status, so the invariants from docs/ODDS_PROVIDER_DESIGN.md Section 6
// hold structurally rather than by caller discipline:
//   VERIFIED       -> reasonCode NONE, acceptedOdds = currentOdds
//   ODDS_CHANGED   -> reasonCode ODDS_OUTSIDE_TOLERANCE, acceptedOdds null
//   FAILED         -> acceptedOdds null, reasonCode must not be NONE
//   NOT_CHECKED    -> acceptedOdds null, reasonCode NOT_CHECKED

export function createVerifiedResult(
  input: VerificationResultInput & { readonly currentOdds: string },
): VerificationResult {
  return {
    status: "VERIFIED",
    reasonCode: "NONE",
    submittedOdds: input.submittedOdds,
    currentOdds: input.currentOdds,
    acceptedOdds: input.currentOdds,
    differencePercentage: input.differencePercentage ?? null,
    matchedEvent: input.matchedEvent,
    matchedOutcome: input.matchedOutcome,
    provider: input.provider,
    bookmaker: input.bookmaker,
    checkedAt: input.checkedAt,
    providerTimestamp: input.providerTimestamp,
    retryable: false,
    publicMessageKey: publicMessageKeyFor("VERIFIED", "NONE"),
    diagnosticCode: input.diagnosticCode,
  };
}

export function createOddsChangedResult(
  input: VerificationResultInput & { readonly currentOdds: string },
): VerificationResult {
  return {
    status: "ODDS_CHANGED",
    reasonCode: "ODDS_OUTSIDE_TOLERANCE",
    submittedOdds: input.submittedOdds,
    currentOdds: input.currentOdds,
    acceptedOdds: null,
    differencePercentage: input.differencePercentage ?? null,
    matchedEvent: input.matchedEvent,
    matchedOutcome: input.matchedOutcome,
    provider: input.provider,
    bookmaker: input.bookmaker,
    checkedAt: input.checkedAt,
    providerTimestamp: input.providerTimestamp,
    retryable: false,
    publicMessageKey: publicMessageKeyFor("ODDS_CHANGED", "ODDS_OUTSIDE_TOLERANCE"),
    diagnosticCode: input.diagnosticCode,
  };
}

export function createFailedResult(
  input: VerificationResultInput & { readonly reasonCode: Exclude<VerificationReasonCode, "NONE"> },
): VerificationResult {
  return {
    status: "FAILED",
    reasonCode: input.reasonCode,
    submittedOdds: input.submittedOdds,
    currentOdds: input.currentOdds ?? null,
    acceptedOdds: null,
    differencePercentage: input.differencePercentage ?? null,
    matchedEvent: input.matchedEvent,
    matchedOutcome: input.matchedOutcome,
    provider: input.provider,
    bookmaker: input.bookmaker,
    checkedAt: input.checkedAt,
    providerTimestamp: input.providerTimestamp,
    retryable: isRetryableReason(input.reasonCode),
    publicMessageKey: publicMessageKeyFor("FAILED", input.reasonCode),
    diagnosticCode: input.diagnosticCode,
  };
}

export function createNotCheckedResult(
  input: Omit<VerificationResultInput, "currentOdds" | "differencePercentage" | "matchedEvent" | "matchedOutcome" | "bookmaker">,
): VerificationResult {
  return {
    status: "NOT_CHECKED",
    reasonCode: "NOT_CHECKED",
    submittedOdds: input.submittedOdds,
    currentOdds: null,
    acceptedOdds: null,
    differencePercentage: null,
    provider: input.provider,
    checkedAt: input.checkedAt,
    providerTimestamp: input.providerTimestamp,
    retryable: false,
    publicMessageKey: publicMessageKeyFor("NOT_CHECKED", "NOT_CHECKED"),
    diagnosticCode: input.diagnosticCode,
  };
}
