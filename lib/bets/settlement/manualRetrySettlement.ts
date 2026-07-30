// Stage 4.3.6 — Manual Automatic Retry. Re-runs the exact same automatic
// settlement pipeline Stage 3.3/3.4/4.3 already established, for exactly
// one bet, on operator demand. This module never invents a second
// financial path: it calls fetchProviderScores() (Stage 3.5A, unmodified),
// then autoSettleSingleBet()/autoSettleExpressBet() (Stage 3.3/3.4B,
// unmodified), which internally calls settleBet() (Stage 13.3, unmodified,
// not touched by any part of Stage 4.3). It reuses
// classifySettlementFailure.ts's classifiers verbatim — the "second
// parallel classifier" Stage 4.3.6's own brief explicitly forbids does not
// exist here.
//
// What IS new here (and could not simply reuse pollConfirmedBetResults.ts's
// applyBetLevelClassification()): the guarded-write precondition differs.
// The cron pipeline only ever writes tracking fields for a bet it just
// loaded via settlementReviewStatus: null; this module's precondition is
// the opposite — settlementReviewStatus: "NEEDS_REVIEW" — and its
// BET_TRANSIENT/BET_PERMANENT_REVIEW writes must never re-escalate an
// already-escalated bet (no threshold check here at all, on purpose — see
// applyManualRetryClassification() below). Reusing the cron function as-is
// would have applied the wrong guard and the wrong escalation behavior;
// duplicating classifySettlementFailure.ts's own categorization logic was
// never necessary and is not done.

import { SettlementReviewReason, SettlementReviewStatus, type PrismaClient } from "@/lib/generated/prisma/client";
import {
  autoSettleSingleBet,
  type AutoSettleSingleBetResult,
} from "./autoSettleSingleBet";
import {
  autoSettleExpressBet,
  type AutoSettleExpressBetResult,
  type EventResultEntryInput,
} from "./autoSettleExpressBet";
import type { CanonicalEventResult } from "./eventResultDomain";
import {
  classifyEventNotFound,
  classifyExpressNoActionAggregate,
  classifyNoActionReasonCode,
  classifyRejectionReasonCode,
  classifySettleFailureCode,
  type BetClassification,
} from "./classifySettlementFailure";
import { fetchProviderScores, type ScoresFetchResult } from "@/lib/odds/providers/theOddsApi/scoresAdapter";
import type { ProviderName } from "@/lib/odds/oddsProvider";

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                */
/* -------------------------------------------------------------------------- */

export type ManualRetryRejectionReason =
  | "NOT_FOUND"
  | "NOT_CONFIRMED"
  | "NOT_NEEDS_REVIEW"
  | "UNSUPPORTED_BET_TYPE"
  | "STRUCTURALLY_INVALID";

export interface ManualRetryRejection {
  readonly kind: "REJECTED";
  readonly reason: ManualRetryRejectionReason;
  readonly message: string;
}

interface LoadedBetForRetry {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly settlementReviewStatus: SettlementReviewStatus | null;
  readonly providerName: string | null;
  readonly providerSportKey: string | null;
  readonly providerEventId: string | null;
  readonly selections: readonly {
    readonly providerName: string | null;
    readonly providerSportKey: string | null;
    readonly providerEventId: string | null;
  }[];
}

// Pure, directly testable. Never calls the provider or writes anything —
// the fast, cheap checks that decide whether a retry attempt is even worth
// starting. `status`/`settlementReviewStatus` mismatches map to 409 at the
// route layer (state already changed); structural/type problems map to
// 400 (the request itself can never succeed, regardless of timing).
export function checkManualRetryEligibility(bet: LoadedBetForRetry): ManualRetryRejection | null {
  if (bet.status !== "CONFIRMED") {
    return { kind: "REJECTED", reason: "NOT_CONFIRMED", message: `Bet is not CONFIRMED (current status: ${bet.status})` };
  }
  if (bet.settlementReviewStatus !== SettlementReviewStatus.NEEDS_REVIEW) {
    return {
      kind: "REJECTED",
      reason: "NOT_NEEDS_REVIEW",
      message: `Bet is not flagged for manual review (settlementReviewStatus: ${bet.settlementReviewStatus ?? "null"})`,
    };
  }
  if (bet.type !== "SINGLE" && bet.type !== "EXPRESS") {
    return { kind: "REJECTED", reason: "UNSUPPORTED_BET_TYPE", message: `Unsupported bet type: ${bet.type}` };
  }

  if (bet.type === "SINGLE") {
    if (bet.providerName === null || bet.providerSportKey === null || bet.providerEventId === null) {
      return {
        kind: "REJECTED",
        reason: "STRUCTURALLY_INVALID",
        message: "Bet is missing provider identity fields required to fetch a result",
      };
    }
    return null;
  }

  // EXPRESS — at least one leg must carry enough provider identity to
  // attempt a fetch at all. A bet with zero such legs could only have
  // reached NEEDS_REVIEW via a genuine data anomaly (escalateExpiredPolling.ts's
  // own legacy-skip rule means a fully-legacy EXPRESS is never escalated in
  // the first place) — defensive, not expected to be reachable in practice.
  const hasAnyFetchableLeg = bet.selections.some(
    (leg) => leg.providerName !== null && leg.providerSportKey !== null && leg.providerEventId !== null,
  );
  if (!hasAnyFetchableLeg) {
    return {
      kind: "REJECTED",
      reason: "STRUCTURALLY_INVALID",
      message: "Express bet has no leg with enough provider identity to fetch a result",
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Result contract                                                            */
/* -------------------------------------------------------------------------- */

export type ManualRetryOutcomeStatus =
  | "SETTLED"
  | "WAITING"
  | "TRANSIENT_FAILURE"
  | "PERMANENT_REVIEW"
  | "CONFLICT"
  | "PROVIDER_UNAVAILABLE";

// Deliberately minimal — autoSettleSingleBet()/autoSettleExpressBet()'s own
// SETTLED result never exposes settleBet()'s raw
// transactionId/amount/balanceAfter/grossPayout/netProfit (only
// outcome/previousStatus/finalStatus/idempotent), and this file does not
// widen that contract just to surface more detail here — that would mean
// changing an already-approved Stage 3.3/3.4B return type for a Stage
// 4.3.6-only convenience. `idempotent` is the one genuinely useful signal
// this file can honestly add: whether this call was the one that actually
// applied the financial change, or found it already applied.
export interface ManualRetrySettlementSummary {
  readonly outcome: "WIN" | "LOSS" | "VOID";
  readonly idempotent: boolean;
}

export interface ManualRetryBetSnapshot {
  readonly id: string;
  readonly status: string;
  readonly settlementReviewStatus: SettlementReviewStatus | null;
  readonly settlementReviewReason: SettlementReviewReason | null;
  readonly settlementRetryCount: number;
  readonly lastSettlementAttemptAt: Date | null;
  readonly lastSettlementErrorCode: string | null;
  readonly lastSettlementErrorMessage: string | null;
}

export type ManualRetryOutcome =
  | { readonly kind: "OK"; readonly status: ManualRetryOutcomeStatus; readonly bet: ManualRetryBetSnapshot; readonly settlement?: ManualRetrySettlementSummary }
  | ManualRetryRejection;

export interface RetryBetSettlementInput {
  readonly betId: string;
  readonly now: Date;
  readonly fetchScoresFn?: typeof fetchProviderScores;
}

// Self-review fix — always re-reads the bet's tracking fields fresh from
// the database immediately before they're returned to the caller. The
// original implementation captured a `bet` snapshot once, at the very
// start of retryBetSettlement(), and reused that same (by then stale)
// object for every returned response — including the paths that had just
// written new values (RESOLVED, an incremented settlementRetryCount, an
// updated settlementReviewReason) via resolveAfterTerminalSettlement()/
// applyManualRetryClassification() moments earlier. The database itself
// was always correct; only the HTTP response body lied about it. Called
// only after the id is already known to exist (either the initial
// findUnique succeeded, or a write against this exact id just committed),
// so a null result here would indicate a genuinely unreachable state (this
// codebase never deletes a Bet row) — the non-null assertion below matches
// that same "unreachable, not silently guessed" reasoning already used
// elsewhere in this file (see settleBet.ts's own analogous comments).
async function loadSnapshot(db: PrismaClient, betId: string): Promise<ManualRetryBetSnapshot> {
  const bet = await db.bet.findUnique({
    where: { id: betId },
    select: {
      id: true,
      status: true,
      settlementReviewStatus: true,
      settlementReviewReason: true,
      settlementRetryCount: true,
      lastSettlementAttemptAt: true,
      lastSettlementErrorCode: true,
      lastSettlementErrorMessage: true,
    },
  });
  return bet as ManualRetryBetSnapshot;
}

/* -------------------------------------------------------------------------- */
/* Guarded, one-time-per-attempt tracking write                              */
/* -------------------------------------------------------------------------- */

// The manual-retry counterpart of pollConfirmedBetResults.ts's
// applyBetLevelClassification() — same six-field vocabulary, same
// classifySettlementFailure.ts categories, deliberately different write
// rules (see this file's own header for why a shared function was not
// used). Every write here is guarded by `status: "CONFIRMED",
// settlementReviewStatus: "NEEDS_REVIEW"` via updateMany() — a concurrent
// second attempt (double click, two operators, or a settlement that
// completed in between) simply matches zero rows and is reported back as
// `applied: false`, never a second financial or tracking write.
async function applyManualRetryClassification(
  db: PrismaClient,
  betId: string,
  classification: BetClassification,
  technicalCode: string,
  technicalMessage: string,
  now: Date,
): Promise<{ readonly applied: boolean }> {
  const guardedWhere = { id: betId, status: "CONFIRMED", settlementReviewStatus: SettlementReviewStatus.NEEDS_REVIEW } as const;

  switch (classification.category) {
    case "WAITING": {
      const result = await db.bet.updateMany({
        where: guardedWhere,
        data: { lastSettlementAttemptAt: now, lastSettlementErrorCode: technicalCode },
      });
      return { applied: result.count === 1 };
    }

    case "BET_TRANSIENT": {
      // Atomic increment — but, unlike the cron path, NEVER re-escalates:
      // this bet is already NEEDS_REVIEW, so "reaching MAX_AUTO_RETRY_ATTEMPTS"
      // has no further action to take (Stage 4.3.6's own explicit
      // instruction). settlementReviewReason is deliberately left
      // untouched here — it still reflects why the bet was ORIGINALLY
      // escalated; a transient outcome on manual retry doesn't change that
      // diagnosis.
      const result = await db.bet.updateMany({
        where: guardedWhere,
        data: {
          settlementRetryCount: { increment: 1 },
          lastSettlementAttemptAt: now,
          lastSettlementErrorCode: technicalCode,
          lastSettlementErrorMessage: technicalMessage,
        },
      });
      return { applied: result.count === 1 };
    }

    case "BET_PERMANENT_REVIEW": {
      // settlementReviewReason IS updated here — a manual retry that
      // reveals a different (more precise) permanent cause than the
      // original escalation is new, real diagnostic information, exactly
      // as Stage 4.3.6's own instruction distinguishes from the
      // BET_TRANSIENT/WAITING cases above (which never overwrite it).
      const result = await db.bet.updateMany({
        where: guardedWhere,
        data: {
          lastSettlementAttemptAt: now,
          lastSettlementErrorCode: technicalCode,
          lastSettlementErrorMessage: technicalMessage,
          settlementReviewReason: classification.reason,
        },
      });
      return { applied: result.count === 1 };
    }

    case "CONFLICT_NO_ACTION": {
      console.warn(`manualRetrySettlement: bet ${betId} — ${technicalCode} (resolved race, no action taken)`);
      return { applied: false };
    }

    case "TERMINAL_OUTCOME":
    case "CYCLE_PROVIDER_FAILURE":
      // Never reached — TERMINAL_OUTCOME is resolved via the dedicated
      // resolveAfterTerminalSettlement() below (different guard: by this
      // point the bet is no longer CONFIRMED), and this service never
      // produces CYCLE_PROVIDER_FAILURE (provider failures are handled
      // before any classification is ever computed — see
      // retryBetSettlement() below).
      return { applied: false };
  }
}

// Called only after autoSettleSingleBet()/autoSettleExpressBet() ->
// settleBet() has already moved the bet to a terminal status (APPLIED or
// IDEMPOTENT — both mean "financially settled, by this call or an earlier
// one"). Guarded on settlementReviewStatus alone (status is already
// terminal by this point, not CONFIRMED) — a second concurrent caller that
// already flipped this to RESOLVED makes this a safe no-op, never
// overwriting a newer state (Stage 4.3.6's own explicit requirement).
async function resolveAfterTerminalSettlement(db: PrismaClient, betId: string, now: Date): Promise<void> {
  await db.bet.updateMany({
    where: { id: betId, settlementReviewStatus: SettlementReviewStatus.NEEDS_REVIEW },
    data: { settlementReviewStatus: SettlementReviewStatus.RESOLVED, lastSettlementAttemptAt: now },
  });
}

/* -------------------------------------------------------------------------- */
/* Provider fetch — single-bet, on-demand, no polling-window filter          */
/* -------------------------------------------------------------------------- */
//
// Deliberately NOT lib/bets/settlement/pollingEventKey.ts's
// extractProviderEventKey()/extractProviderEventKeys() — those enforce the
// cron's OWN 3-day POLLING_LOOKBACK_MS window, which is exactly wrong here:
// a bet reaching this service is very often NEEDS_REVIEW precisely BECAUSE
// it fell outside that window (POLLING_WINDOW_EXPIRED). An operator-
// initiated, single-bet, on-demand fetch has no such window of its own —
// the only real bound left is The Odds API's own SCORES_DAYS_FROM=3
// constant baked into fetchProviderScores() itself, which this function
// does not (and should not) re-implement or second-guess.

interface FetchableLeg {
  readonly providerSportKey: string;
  readonly providerEventId: string;
}

async function fetchResultsForLegs(
  legs: readonly FetchableLeg[],
  fetchScores: typeof fetchProviderScores,
): Promise<{ readonly ok: true; readonly resultsByEventId: Map<string, CanonicalEventResult> } | { readonly ok: false }> {
  const idsBySportKey = new Map<string, string[]>();
  for (const leg of legs) {
    const ids = idsBySportKey.get(leg.providerSportKey) ?? [];
    if (!ids.includes(leg.providerEventId)) ids.push(leg.providerEventId);
    idsBySportKey.set(leg.providerSportKey, ids);
  }

  const resultsByEventId = new Map<string, CanonicalEventResult>();

  for (const [providerSportKey, providerEventIds] of idsBySportKey) {
    const fetchResult: ScoresFetchResult = await fetchScores({ providerSportKey, providerEventIds });
    // Stage 4.3.6's own central rule, identical to cron's: a provider
    // fetch failure for ANY of this bet's legs makes the WHOLE manual
    // retry PROVIDER_UNAVAILABLE — never partially applied, never folded
    // into a bet-level retry. Simpler than cron's per-id CYCLE_FAILURE
    // tracking (unnecessary here: only one bet's own legs are ever in
    // play, never a shared cross-bet batch), and consistent with Stage
    // 4.3.3's own already-accepted "EXPRESS WAITING/failure is not
    // tracked per leg" scope boundary.
    if (fetchResult.status === "FAILED") {
      return { ok: false };
    }
    for (const mapped of fetchResult.results) {
      resultsByEventId.set(mapped.providerEventId, mapped.eventResult);
    }
  }

  return { ok: true, resultsByEventId };
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

function isRealProviderName(value: string | null): value is ProviderName {
  return value === "THE_ODDS_API";
}

export async function retryBetSettlement(db: PrismaClient, input: RetryBetSettlementInput): Promise<ManualRetryOutcome> {
  const { betId, now } = input;
  const fetchScores = input.fetchScoresFn ?? fetchProviderScores;

  const bet = await db.bet.findUnique({
    where: { id: betId },
    select: {
      id: true,
      type: true,
      status: true,
      settlementReviewStatus: true,
      settlementReviewReason: true,
      settlementRetryCount: true,
      lastSettlementAttemptAt: true,
      lastSettlementErrorCode: true,
      lastSettlementErrorMessage: true,
      providerName: true,
      providerSportKey: true,
      providerEventId: true,
      selections: { select: { id: true, providerName: true, providerSportKey: true, providerEventId: true } },
    },
  });

  if (!bet) {
    return { kind: "REJECTED", reason: "NOT_FOUND", message: `No bet found with id ${betId}` };
  }

  const eligibilityRejection = checkManualRetryEligibility(bet);
  if (eligibilityRejection) {
    return eligibilityRejection;
  }

  if (bet.type === "SINGLE") {
    // Eligibility already guaranteed providerName/providerSportKey/
    // providerEventId are all non-null.
    const providerSportKey = bet.providerSportKey as string;
    const providerEventId = bet.providerEventId as string;

    if (!isRealProviderName(bet.providerName)) {
      return { kind: "REJECTED", reason: "STRUCTURALLY_INVALID", message: "Unrecognized provider name" };
    }

    const fetched = await fetchResultsForLegs([{ providerSportKey, providerEventId }], fetchScores);
    if (!fetched.ok) {
      return { kind: "OK", status: "PROVIDER_UNAVAILABLE", bet: await loadSnapshot(db, betId) };
    }

    const eventResult = fetched.resultsByEventId.get(providerEventId);
    if (!eventResult) {
      const applied = await applyManualRetryClassification(
        db,
        betId,
        classifyEventNotFound(),
        "EVENT_NOT_FOUND",
        "Provider response did not include this event on manual retry.",
        now,
      );
      return { kind: "OK", status: applied.applied ? "TRANSIENT_FAILURE" : "CONFLICT", bet: await loadSnapshot(db, betId) };
    }

    const result: AutoSettleSingleBetResult = await autoSettleSingleBet(db, { betId, eventResult, expectedProviderEventId: providerEventId });
    return handleAutoSettleResult(db, betId, now, result);
  }

  // EXPRESS
  const fetchableLegs: FetchableLeg[] = bet.selections
    .filter((leg) => leg.providerSportKey !== null && leg.providerEventId !== null)
    .map((leg) => ({ providerSportKey: leg.providerSportKey as string, providerEventId: leg.providerEventId as string }));

  const fetched = await fetchResultsForLegs(fetchableLegs, fetchScores);
  if (!fetched.ok) {
    return { kind: "OK", status: "PROVIDER_UNAVAILABLE", bet: await loadSnapshot(db, betId) };
  }

  const eventResultsArray: EventResultEntryInput[] = Array.from(fetched.resultsByEventId.entries()).map(
    ([providerEventId, eventResult]) => ({ providerEventId, eventResult }),
  );

  const result: AutoSettleExpressBetResult = await autoSettleExpressBet(db, { betId, eventResults: eventResultsArray });
  return handleAutoSettleResult(db, betId, now, result);
}

/* -------------------------------------------------------------------------- */
/* Shared result -> classification -> write dispatch (SINGLE + EXPRESS)      */
/* -------------------------------------------------------------------------- */

async function handleAutoSettleResult(
  db: PrismaClient,
  betId: string,
  now: Date,
  result: AutoSettleSingleBetResult | AutoSettleExpressBetResult,
): Promise<ManualRetryOutcome> {
  if (result.kind === "SETTLED") {
    // Financial settlement already happened (or was already idempotently
    // in place) inside autoSettleSingleBet()/autoSettleExpressBet() ->
    // settleBet() — this call never touches Transaction/Player.currentCredit
    // itself. Only now, AFTER that success, is settlementReviewStatus
    // moved to RESOLVED — never before, so a settleBet() failure can never
    // leave a bet stripped of NEEDS_REVIEW (Stage 4.3.6's own explicit
    // requirement).
    await resolveAfterTerminalSettlement(db, betId, now);
    const settlement: ManualRetrySettlementSummary = { outcome: result.outcome, idempotent: result.idempotent };
    return { kind: "OK", status: "SETTLED", bet: await loadSnapshot(db, betId), settlement };
  }

  if (result.kind === "NOT_FOUND") {
    return { kind: "REJECTED", reason: "NOT_FOUND", message: `No bet found with id ${betId}` };
  }

  if (result.kind === "CONFLICT") {
    if (result.reasonCode === "ALREADY_SETTLED") {
      // The bet is already financially terminal via some other call
      // (another manual retry, or — structurally impossible per Stage
      // 4.3.3/4.3.4's own query exclusions of NEEDS_REVIEW bets, but
      // defended anyway) — the underlying review problem no longer
      // exists, so this resolves the review the same way a fresh SETTLED
      // does, guarded exactly the same way.
      await resolveAfterTerminalSettlement(db, betId, now);
      return { kind: "OK", status: "CONFLICT", bet: await loadSnapshot(db, betId) };
    }
    // STATUS_CHANGED_DURING_TRANSACTION — genuinely unreachable in
    // practice (see settleBet.ts's own comment), no write, safe no-op.
    return { kind: "OK", status: "CONFLICT", bet: await loadSnapshot(db, betId) };
  }

  // NO_ACTION / REJECTED / FAILED — classify via the exact same,
  // unmodified classifySettlementFailure.ts functions the cron pipeline
  // uses, then apply via this file's own guarded write rules.
  let classification: BetClassification;
  let technicalCode: string;
  let technicalMessage: string;

  if (result.kind === "NO_ACTION") {
    if ("aggregate" in result) {
      classification = classifyExpressNoActionAggregate(result.aggregate);
      technicalCode = result.aggregate.kind;
      technicalMessage = `Express aggregate outcome: ${result.aggregate.kind}.`;
    } else {
      classification = classifyNoActionReasonCode(result.reasonCode);
      technicalCode = result.reasonCode;
      technicalMessage = `Selection outcome evaluator returned ${result.reasonCode}.`;
    }
  } else if (result.kind === "REJECTED") {
    classification = classifyRejectionReasonCode(result.reasonCode);
    technicalCode = result.reasonCode;
    technicalMessage = `Settlement rejected: ${result.reasonCode}.`;
  } else {
    // FAILED
    classification = classifySettleFailureCode(result.reasonCode);
    technicalCode = result.reasonCode;
    technicalMessage = `Settlement failed: ${result.reasonCode}.`;
  }

  const applied = await applyManualRetryClassification(db, betId, classification, technicalCode, technicalMessage, now);

  const statusByCategory: Record<BetClassification["category"], ManualRetryOutcomeStatus> = {
    WAITING: "WAITING",
    BET_TRANSIENT: "TRANSIENT_FAILURE",
    BET_PERMANENT_REVIEW: "PERMANENT_REVIEW",
    CONFLICT_NO_ACTION: "CONFLICT",
    TERMINAL_OUTCOME: "SETTLED",
    CYCLE_PROVIDER_FAILURE: "PROVIDER_UNAVAILABLE",
  };

  const status = applied.applied ? statusByCategory[classification.category] : "CONFLICT";
  return { kind: "OK", status, bet: await loadSnapshot(db, betId) };
}
