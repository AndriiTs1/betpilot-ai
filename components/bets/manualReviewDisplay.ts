// Stage 4.3.5 — pure, DOM-free display logic for the Manual Review section.
// Kept separate from ManualReviewQueue.tsx/ManualReviewItem.tsx (which do
// the actual rendering) for the same reason ActiveBetsScreen.tsx exports
// ACTIVE_STATUSES and getSportIconComponent() as standalone, directly
// testable functions: this project has no DOM-rendering test infrastructure
// (jsdom/@testing-library were deliberately not added — see
// components/miniapp/ActiveBetsScreen.test.ts's own header comment), so
// every piece of real logic a component depends on must be extractable and
// testable on its own, in plain node:test, without ever rendering JSX.

import { getSettlementReviewReasonLabel } from "@/lib/dashboard/settlementReviewReasonLabels";
import { formatBetDate } from "@/components/miniapp/formatBetDate";

export interface NeedsReviewSelectionApi {
  readonly id: string;
  readonly sport: string;
  readonly market: string | null;
  readonly selection: string;
  readonly participant: string | null;
  readonly odds: string | null;
  readonly providerName: string | null;
  readonly providerEventId: string | null;
  readonly eventStartTime: string | null;
  readonly oddsStatus: string;
}

// The exact wire shape GET /api/dashboard/bets/needs-review returns (see
// app/api/bets/needs-review/route.ts's own serialization) — never
// re-declared with different field names, so a real API response shape
// change surfaces as a type error here rather than a silent mismatch.
export interface NeedsReviewBetApi {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly player: { readonly id: string; readonly name: string };
  readonly stake: string;
  readonly odds: string | null;
  readonly totalOdds: string | null;
  readonly potentialPayout: string | null;
  readonly providerName: string | null;
  readonly providerEventId: string | null;
  readonly providerSportKey: string | null;
  readonly eventStartTime: string | null;
  readonly settlementRetryCount: number;
  readonly lastSettlementAttemptAt: string | null;
  readonly lastSettlementErrorCode: string | null;
  readonly lastSettlementErrorMessage: string | null;
  readonly settlementReviewReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly selections: readonly NeedsReviewSelectionApi[];
}

export interface NeedsReviewPagination {
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
  readonly hasMore: boolean;
}

// The curated shape ManualReviewItem.tsx actually renders — every field is
// already display-ready (reason humanized, dates formatted, odds resolved)
// so the component itself contains no business logic to test separately.
export interface ManualReviewDisplayBet {
  readonly id: string;
  readonly isExpress: boolean;
  readonly playerName: string;
  readonly stake: string;
  readonly effectiveOdds: string | null;
  readonly potentialPayout: string | null;
  readonly reviewReasonLabel: string;
  readonly retryCount: number;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly lastAttemptDisplay: string;
  readonly eventStartDisplay: string;
  readonly createdAtDisplay: string;
  readonly providerEventId: string | null;
  readonly selections: readonly NeedsReviewSelectionApi[];
}

export function mapNeedsReviewBetForDisplay(bet: NeedsReviewBetApi): ManualReviewDisplayBet {
  return {
    id: bet.id,
    isExpress: bet.type === "EXPRESS",
    playerName: bet.player.name,
    stake: bet.stake,
    effectiveOdds: bet.totalOdds ?? bet.odds,
    potentialPayout: bet.potentialPayout,
    reviewReasonLabel: getSettlementReviewReasonLabel(bet.settlementReviewReason),
    retryCount: bet.settlementRetryCount,
    lastErrorCode: bet.lastSettlementErrorCode,
    lastErrorMessage: bet.lastSettlementErrorMessage,
    lastAttemptDisplay: bet.lastSettlementAttemptAt ? formatBetDate(bet.lastSettlementAttemptAt) : "—",
    eventStartDisplay: bet.eventStartTime ? formatBetDate(bet.eventStartTime) : "—",
    createdAtDisplay: formatBetDate(bet.createdAt),
    providerEventId: bet.providerEventId,
    selections: bet.selections,
  };
}

export type ManualReviewViewState = "loading" | "error" | "empty" | "list";

// Mirrors BetQueue.tsx's own conditional-render order exactly
// (isInitialLoad -> error -> empty -> list) — extracted here so that exact
// branching is independently testable for every input combination, without
// rendering.
export function determineManualReviewViewState(input: {
  readonly bets: readonly unknown[] | null;
  readonly error: string | null;
  readonly isInitialLoad: boolean;
}): ManualReviewViewState {
  if (input.isInitialLoad && !input.error) return "loading";
  if (input.error) return "error";
  if (input.bets !== null && input.bets.length === 0) return "empty";
  return "list";
}

/* -------------------------------------------------------------------------- */
/* Retry Automatically — result feedback                                     */
/* -------------------------------------------------------------------------- */

// Stage 4.3.6 — every status POST /api/bets/:id/settlement-retry's
// `result.status` can hold, mapped to the same tone vocabulary
// EmptyState/StatusBadge already use elsewhere in this Dashboard, plus a
// short, operator-safe sentence (never a raw provider payload or internal
// error string). Pure and directly testable — ManualReviewItem.tsx only
// renders whatever this function returns, no branching logic of its own.
export type ManualRetryFeedbackTone = "success" | "info" | "warning" | "error";

export interface ManualRetryFeedback {
  readonly tone: ManualRetryFeedbackTone;
  readonly text: string;
}

const RETRY_STATUS_FEEDBACK: Record<string, ManualRetryFeedback> = {
  SETTLED: { tone: "success", text: "Settled automatically." },
  WAITING: { tone: "info", text: "Event is not finished yet — still waiting for a result." },
  TRANSIENT_FAILURE: { tone: "warning", text: "Still no result from the provider. It will need another look." },
  PERMANENT_REVIEW: { tone: "warning", text: "Automatic settlement is not possible for this bet." },
  CONFLICT: { tone: "info", text: "This bet was already resolved elsewhere." },
  PROVIDER_UNAVAILABLE: { tone: "error", text: "The result provider is temporarily unavailable. Try again later." },
};

const UNKNOWN_RETRY_FEEDBACK: ManualRetryFeedback = { tone: "error", text: "Unexpected result. Try refreshing the page." };

export function describeManualRetryOutcome(status: string): ManualRetryFeedback {
  return RETRY_STATUS_FEEDBACK[status] ?? UNKNOWN_RETRY_FEEDBACK;
}

// A retry is only ever "resolved" (should leave the Manual Review queue)
// when it actually settled — every other outcome leaves the bet exactly
// where it was (still NEEDS_REVIEW), just with fresher diagnostic fields
// the caller should re-fetch from the server rather than guess at
// client-side.
export function manualRetryResolvesTheReview(status: string): boolean {
  return status === "SETTLED";
}
