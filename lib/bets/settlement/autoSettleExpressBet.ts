// Stage 3.4B — AUTOMATIC EXPRESS SETTLEMENT
//
// Application-layer orchestration, the EXPRESS counterpart of Stage 3.3's
// autoSettleSingleBet(). Given an EXPRESS bet id and a caller-supplied set
// of event results (one per distinct providerEventId this bet's legs
// reference), decides whether the bet can be automatically settled and, if
// so, applies that settlement through the existing, unmodified settleBet()
// (Stage 13.3 + Stage 3.4A's effectiveOdds override).
//
// This module does NOT: call a provider/HTTP endpoint, run polling/cron/
// worker/queue logic, compute payouts itself, write a Transaction directly,
// touch Player.currentCredit directly, or duplicate settleBet()'s own
// idempotency/concurrency guarantees. It does exactly one non-transactional
// read (Bet + its BetSelection rows) to decide eligibility and the intended
// outcome, then delegates the actual state transition entirely to
// settleBet().

import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import {
  settleBet,
  BetNotFoundForSettlementError,
  MissingSettlementOddsError,
  InvalidEffectiveSettlementOddsError,
  type SettlementDatabase,
  type SettleBetResult,
} from "@/lib/bets/settleBet";
import {
  BetNotConfirmedForSettlementError,
  BetAlreadyRejectedError,
  SettlementConflictError,
  type SettlementTarget,
} from "@/lib/bets/settlementRules";
import { aggregateExpressOutcome, type AggregateExpressOutcome, type ExpressLeg } from "./aggregateExpressOutcome";
import type { CanonicalEventResult } from "./eventResultDomain";
import {
  mapExpressSelectionToCanonicalSelection,
  type ExpressSelectionCanonicalFields,
} from "./mapExpressSelectionToCanonicalSelection";

/* -------------------------------------------------------------------------- */
/* Result contract                                                            */
/* -------------------------------------------------------------------------- */

export type AutoSettlementExpressRejectionReasonCode =
  | "NOT_EXPRESS"
  | "UNSUPPORTED_BET_STATUS"
  | "EMPTY_SELECTIONS"
  | "MISSING_PROVIDER_REFERENCE"
  | "MISSING_CANONICAL_METADATA"
  | "DUPLICATE_PROVIDER_EVENT_RESULT";

// The NO_ACTION branch carries the aggregator's own WAITING/UNSUPPORTED/
// INVALID_DATA result verbatim rather than flattening it to a single
// string — unlike Stage 3.3 (exactly one selection, one reasonCode is
// enough), an EXPRESS bet has multiple legs, and per-leg detail
// (waitingSelectionIds, reasonCodes per id, etc.) would be lost by
// flattening. Never re-derived — always the exact value
// aggregateExpressOutcome() returned.
type NoActionAggregate = Extract<AggregateExpressOutcome, { kind: "WAITING" | "UNSUPPORTED" | "INVALID_DATA" }>;

export type AutoSettleExpressBetResult =
  | {
      readonly kind: "SETTLED";
      readonly betId: string;
      readonly outcome: "WIN" | "LOSS" | "VOID";
      // Only present for outcome WIN — mirrors SettleBetResult's own
      // grossPayout/netProfit convention (optional, not null, for a field
      // that's only meaningful for one outcome).
      readonly effectiveOdds?: Prisma.Decimal;
      readonly previousStatus: string;
      readonly finalStatus: SettlementTarget;
      readonly idempotent: boolean;
    }
  | { readonly kind: "NO_ACTION"; readonly betId: string; readonly aggregate: NoActionAggregate }
  | { readonly kind: "REJECTED"; readonly betId: string; readonly reasonCode: AutoSettlementExpressRejectionReasonCode }
  | { readonly kind: "NOT_FOUND"; readonly betId: string }
  | { readonly kind: "CONFLICT"; readonly betId: string; readonly reasonCode: "ALREADY_SETTLED" | "STATUS_CHANGED_DURING_TRANSACTION" }
  | { readonly kind: "FAILED"; readonly betId: string; readonly reasonCode: string; readonly message: string };

export interface EventResultEntryInput {
  readonly providerEventId: string;
  readonly eventResult: CanonicalEventResult;
}

export interface AutoSettleExpressBetInput {
  readonly betId: string;
  readonly eventResults: readonly EventResultEntryInput[];
}

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                */
/* -------------------------------------------------------------------------- */

// Same rationale as Stage 3.3's identically-named constant: PENDING/
// REJECTED are excluded because settleBet()/decideSettlementTransition()
// always throws for both — a cheap short-circuit, not new business logic.
const ELIGIBLE_BET_STATUSES: ReadonlySet<string> = new Set(["CONFIRMED", "SETTLED_WIN", "SETTLED_LOSS", "VOID"]);

interface LoadedExpressSelection extends ExpressSelectionCanonicalFields {
  readonly id: string;
  readonly providerName: string | null;
  readonly providerEventId: string | null;
  readonly odds: Prisma.Decimal | null;
}

interface LoadedExpressBet {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly selections: readonly LoadedExpressSelection[];
}

function settlementTargetFor(outcome: "WIN" | "LOSS" | "VOID"): SettlementTarget {
  if (outcome === "WIN") return "SETTLED_WIN";
  if (outcome === "LOSS") return "SETTLED_LOSS";
  return "VOID";
}

// Builds the leg list the pure aggregator needs, or returns a single
// REJECTED reason the moment any leg fails a structural check. Every leg
// must pass before any leg is evaluated — a partially-mapped EXPRESS is
// never partially settled.
function buildLegsOrReject(
  selections: readonly LoadedExpressSelection[],
): { ok: true; legs: ExpressLeg[] } | { ok: false; reasonCode: AutoSettlementExpressRejectionReasonCode } {
  const legs: ExpressLeg[] = [];

  for (const sel of selections) {
    if (sel.providerName === null || sel.providerEventId === null) {
      return { ok: false, reasonCode: "MISSING_PROVIDER_REFERENCE" };
    }

    const selection = mapExpressSelectionToCanonicalSelection(sel);
    if (!selection) {
      return { ok: false, reasonCode: "MISSING_CANONICAL_METADATA" };
    }

    legs.push({ id: sel.id, providerEventId: sel.providerEventId, selection, odds: sel.odds });
  }

  return { ok: true, legs };
}

// Detects a duplicate providerEventId as the lookup is built — the only
// place this can actually be caught (a pre-built Map/Record handed in from
// outside would have already silently collapsed the duplicate before this
// function ever saw it). An entry whose providerEventId matches none of
// this bet's legs is not an error — it's simply never looked up by
// aggregateExpressOutcome() (which only ever queries by each leg's own
// providerEventId), so it's implicitly, harmlessly ignored without any
// special-casing needed here.
function buildEventResultLookupOrReject(
  entries: readonly EventResultEntryInput[],
): { ok: true; lookup: ReadonlyMap<string, CanonicalEventResult> } | { ok: false } {
  const lookup = new Map<string, CanonicalEventResult>();
  for (const entry of entries) {
    if (lookup.has(entry.providerEventId)) {
      return { ok: false };
    }
    lookup.set(entry.providerEventId, entry.eventResult);
  }
  return { ok: true, lookup };
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

export async function autoSettleExpressBet(
  db: PrismaClient,
  input: AutoSettleExpressBetInput,
): Promise<AutoSettleExpressBetResult> {
  const { betId, eventResults } = input;

  const bet: LoadedExpressBet | null = await db.bet.findUnique({
    where: { id: betId },
    select: {
      id: true,
      type: true,
      status: true,
      selections: {
        select: {
          id: true,
          providerName: true,
          providerEventId: true,
          canonicalMarketType: true,
          canonicalSelectionType: true,
          canonicalParticipant: true,
          canonicalPeriod: true,
          odds: true,
        },
      },
    },
  });

  if (!bet) {
    return { kind: "NOT_FOUND", betId };
  }
  if (bet.type !== "EXPRESS") {
    return { kind: "REJECTED", betId, reasonCode: "NOT_EXPRESS" };
  }
  if (!ELIGIBLE_BET_STATUSES.has(bet.status)) {
    return { kind: "REJECTED", betId, reasonCode: "UNSUPPORTED_BET_STATUS" };
  }
  if (bet.selections.length === 0) {
    return { kind: "REJECTED", betId, reasonCode: "EMPTY_SELECTIONS" };
  }

  const legsResult = buildLegsOrReject(bet.selections);
  if (!legsResult.ok) {
    return { kind: "REJECTED", betId, reasonCode: legsResult.reasonCode };
  }

  const lookupResult = buildEventResultLookupOrReject(eventResults);
  if (!lookupResult.ok) {
    return { kind: "REJECTED", betId, reasonCode: "DUPLICATE_PROVIDER_EVENT_RESULT" };
  }

  const aggregate = aggregateExpressOutcome(legsResult.legs, lookupResult.lookup);

  if (aggregate.kind === "WAITING" || aggregate.kind === "UNSUPPORTED" || aggregate.kind === "INVALID_DATA") {
    return { kind: "NO_ACTION", betId, aggregate };
  }

  const requestedStatus = settlementTargetFor(aggregate.kind);

  let settleResult: SettleBetResult;
  try {
    settleResult = await settleBet(db as unknown as SettlementDatabase, {
      betId,
      requestedStatus,
      ...(aggregate.kind === "WIN" ? { effectiveOdds: aggregate.effectiveOdds } : {}),
    });
  } catch (err) {
    if (err instanceof SettlementConflictError) {
      return { kind: "CONFLICT", betId, reasonCode: "ALREADY_SETTLED" };
    }
    if (err instanceof BetNotConfirmedForSettlementError || err instanceof BetAlreadyRejectedError) {
      return { kind: "CONFLICT", betId, reasonCode: "STATUS_CHANGED_DURING_TRANSACTION" };
    }
    if (err instanceof BetNotFoundForSettlementError) {
      return { kind: "NOT_FOUND", betId };
    }
    if (err instanceof MissingSettlementOddsError || err instanceof InvalidEffectiveSettlementOddsError) {
      return { kind: "FAILED", betId, reasonCode: err.code, message: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "FAILED", betId, reasonCode: "UNEXPECTED_ERROR", message };
  }

  const effectiveOddsField = aggregate.kind === "WIN" ? { effectiveOdds: aggregate.effectiveOdds } : {};

  if (settleResult.kind === "IDEMPOTENT") {
    return {
      kind: "SETTLED",
      betId,
      outcome: aggregate.kind,
      ...effectiveOddsField,
      previousStatus: settleResult.status,
      finalStatus: settleResult.status,
      idempotent: true,
    };
  }

  return {
    kind: "SETTLED",
    betId,
    outcome: aggregate.kind,
    ...effectiveOddsField,
    previousStatus: bet.status,
    finalStatus: settleResult.status,
    idempotent: false,
  };
}
