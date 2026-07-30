// Stage 4.3.5 — the one centralized SettlementReviewReason -> operator-
// facing text mapping, same Record<Enum, string> + safe-fallback shape
// already established by lib/bets/oddsStatusBadge.ts's
// ODDS_STATUS_BADGES / getOddsStatusBadge() for the analogous "enum stored
// as a stable machine code, humanized only at the presentation edge"
// problem. No i18n system introduced — English only, matching every other
// operator-facing label already in this Dashboard (StatusBadge.tsx,
// EmptyState copy, StatCard titles); no localized text is ever stored in
// the database — this file is the only translation layer, and it lives
// entirely in application code.

import { SettlementReviewReason } from "@/lib/generated/prisma/client";

export const SETTLEMENT_REVIEW_REASON_LABELS: Record<SettlementReviewReason, string> = {
  POLLING_WINDOW_EXPIRED: "Polling window expired",
  EVENT_NOT_FOUND_MAX_RETRIES: "Event was not found after automatic retries",
  MISSING_SCORE_MAX_RETRIES: "Score was unavailable after automatic retries",
  DB_ERROR_MAX_RETRIES: "A database error persisted after automatic retries",
  MISSING_PROVIDER_REFERENCE: "Provider reference is incomplete",
  PROVIDER_EVENT_MISMATCH: "Provider event does not match the expected event",
  MISSING_CANONICAL_METADATA: "Market or selection metadata is missing",
  INVALID_BET_TYPE: "Bet type is not eligible for automatic settlement",
  EMPTY_SELECTIONS: "Express bet has no selections",
  DUPLICATE_PROVIDER_EVENT_RESULT: "Duplicate provider event result detected",
  UNSUPPORTED_MARKET: "Market is not supported for automatic settlement",
  UNSUPPORTED_SELECTION: "Selection type is not supported for automatic settlement",
  UNSUPPORTED_PERIOD: "Period is not supported for automatic settlement",
  INVALID_SCORE: "Provider returned an invalid score",
  PARTICIPANT_MISMATCH: "Participant could not be matched",
  INVALID_EVENT_RESULT: "Provider event result is invalid",
  MISSING_PARTICIPANT_NAME: "Selection is missing a participant name",
  AMBIGUOUS_PARTICIPANT_MATCH: "Participant name matched more than one side",
  MISSING_SETTLEMENT_ODDS: "No odds available to compute a payout",
  INVALID_SETTLEMENT_ODDS: "Computed settlement odds are invalid",
  INVALID_EXPRESS_DATA: "Express bet has invalid selection data",
};

const NO_REASON_FALLBACK = "—";

// null (a review-flagged bet with somehow no reason recorded — not
// reachable through any Stage 4.3 code path today, but this function must
// still degrade honestly rather than throw) -> the same "—" fallback used
// throughout this Dashboard for "nothing to show". An unrecognized string
// (defensive only — every real value comes from the real enum) falls back
// to echoing the raw value rather than a blank or crash, same convention
// getOddsStatusBadge() already uses.
export function getSettlementReviewReasonLabel(reason: string | null): string {
  if (!reason) return NO_REASON_FALLBACK;
  return SETTLEMENT_REVIEW_REASON_LABELS[reason as SettlementReviewReason] ?? reason;
}
