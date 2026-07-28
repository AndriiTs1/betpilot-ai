// Stage 3.4B — pure EXPRESS outcome aggregator. Given every leg of an
// EXPRESS bet (already mapped to a CanonicalSelection) and a lookup of
// event results keyed by providerEventId, decides the bet-level outcome:
// WIN / LOSS / VOID / WAITING / UNSUPPORTED / INVALID_DATA. No DB, no
// provider/network calls, no settleBet(), no balance/Transaction writes,
// no Date.now(), no side effects — a deterministic function of its two
// arguments, same purity contract as evaluateSelectionOutcome() itself
// (Stage 3.2), which this function calls once per leg and never
// duplicates.
//
// Structural/config problems (missing provider metadata, unmappable
// canonical fields, duplicate event-result keys) are NOT this function's
// concern — those are eligibility failures the caller (autoSettleExpressBet)
// rejects before a leg ever reaches here, mirroring Stage 3.3's own split
// between REJECTED (structural) and NO_ACTION (business/evaluator-driven).
// Every leg this function receives is assumed to already have a valid
// CanonicalSelection and a non-null providerEventId.

import { Prisma } from "@/lib/generated/prisma/client";
import type { CanonicalSelection } from "@/lib/odds/domain";
import { computeTotalOdds, ExpressMathError } from "@/lib/bets/expressMath";
import { evaluateSelectionOutcome, type SelectionOutcomeEvaluation } from "./evaluateSelectionOutcome";
import type { CanonicalEventResult } from "./eventResultDomain";

export interface ExpressLeg {
  readonly id: string;
  readonly providerEventId: string;
  readonly selection: CanonicalSelection;
  // BetSelection.odds — the price fixed at bet-acceptance time. Never a
  // "current"/provider price; this function has no concept of live odds at
  // all (matches lib/bets/settleBet.ts's own established rule that
  // settlement math is always computed from odds captured at confirm time).
  readonly odds: Prisma.Decimal | null;
}

export type AggregateExpressOutcome =
  | {
      readonly kind: "WIN";
      readonly effectiveOdds: Prisma.Decimal;
      readonly winningSelectionIds: readonly string[];
      readonly voidedSelectionIds: readonly string[];
    }
  | { readonly kind: "LOSS"; readonly losingSelectionIds: readonly string[] }
  | { readonly kind: "VOID" }
  | {
      readonly kind: "WAITING";
      readonly waitingSelectionIds: readonly string[];
      readonly missingProviderEventIds: readonly string[];
    }
  | {
      readonly kind: "UNSUPPORTED";
      readonly affectedSelectionIds: readonly string[];
      readonly reasonCodes: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "INVALID_DATA";
      readonly affectedSelectionIds: readonly string[];
      readonly reasonCodes: Readonly<Record<string, string>>;
    };

// A leg whose providerEventId has no matching entry in the lookup is
// treated exactly like an event that hasn't concluded yet — there is
// nothing dishonest about this: the caller simply doesn't have a result for
// it yet, which is indistinguishable in effect from "not completed." Reuses
// evaluateSelectionOutcome()'s own WAITING/EVENT_NOT_COMPLETED shape rather
// than inventing a parallel per-leg outcome type, so every downstream
// consumer of SelectionOutcomeEvaluation.kind works uniformly regardless of
// which of the two WAITING sources produced it.
const MISSING_RESULT_EVALUATION: SelectionOutcomeEvaluation = { kind: "WAITING", reasonCode: "EVENT_NOT_COMPLETED" };

// Aggregation priority when no single leg's state alone determines the
// whole bet (i.e. not every leg is WIN/VOID): LOSS is unconditional and
// authoritative — a parlay/express requires every leg to win, so one real
// LOSS dooms the whole bet regardless of any other leg's state, including a
// co-occurring INVALID_DATA/UNSUPPORTED/WAITING leg (Stage 3.4 audit
// section 7.G's conclusion). Among the remaining non-LOSS problem states,
// INVALID_DATA is surfaced before UNSUPPORTED before WAITING — a real data
// problem and a coverage gap are both more actionable than "still waiting,"
// so neither should be silently masked by a sibling leg that's merely
// pending.
export function aggregateExpressOutcome(
  legs: readonly ExpressLeg[],
  eventResultsByProviderEventId: ReadonlyMap<string, CanonicalEventResult>,
): AggregateExpressOutcome {
  const losingIds: string[] = [];
  const invalidIds: string[] = [];
  const invalidReasons: Record<string, string> = {};
  const unsupportedIds: string[] = [];
  const unsupportedReasons: Record<string, string> = {};
  const waitingIds: string[] = [];
  const missingProviderEventIds: string[] = [];
  const winningLegs: ExpressLeg[] = [];
  const voidedIds: string[] = [];

  for (const leg of legs) {
    const eventResult = eventResultsByProviderEventId.get(leg.providerEventId);
    const evaluation = eventResult ? evaluateSelectionOutcome(eventResult, leg.selection) : MISSING_RESULT_EVALUATION;

    switch (evaluation.kind) {
      case "LOSS":
        losingIds.push(leg.id);
        break;
      case "INVALID_DATA":
        invalidIds.push(leg.id);
        invalidReasons[leg.id] = evaluation.reasonCode;
        break;
      case "UNSUPPORTED":
        unsupportedIds.push(leg.id);
        unsupportedReasons[leg.id] = evaluation.reasonCode;
        break;
      case "WAITING":
        waitingIds.push(leg.id);
        if (!eventResult) missingProviderEventIds.push(leg.providerEventId);
        break;
      case "VOID":
        voidedIds.push(leg.id);
        break;
      case "WIN":
        winningLegs.push(leg);
        break;
    }
  }

  if (losingIds.length > 0) {
    return { kind: "LOSS", losingSelectionIds: losingIds };
  }
  if (invalidIds.length > 0) {
    return { kind: "INVALID_DATA", affectedSelectionIds: invalidIds, reasonCodes: invalidReasons };
  }
  if (unsupportedIds.length > 0) {
    return { kind: "UNSUPPORTED", affectedSelectionIds: unsupportedIds, reasonCodes: unsupportedReasons };
  }
  if (waitingIds.length > 0) {
    return { kind: "WAITING", waitingSelectionIds: waitingIds, missingProviderEventIds };
  }

  // Every leg is now WIN or VOID.
  if (winningLegs.length === 0) {
    return { kind: "VOID" };
  }

  // VOID legs contribute nothing to the product (equivalent to a x1.00
  // factor) — simply excluded from the list, not multiplied in as 1.00,
  // same net effect, no fabricated Decimal(1) entries. computeTotalOdds()
  // (lib/bets/expressMath.ts) is reused unmodified: same Decimal-safe
  // product, same HALF_UP/2dp rounding this codebase already established —
  // never a new math rule invented here.
  try {
    const effectiveOdds = computeTotalOdds(winningLegs.map((leg) => leg.odds));
    return {
      kind: "WIN",
      effectiveOdds,
      winningSelectionIds: winningLegs.map((leg) => leg.id),
      voidedSelectionIds: voidedIds,
    };
  } catch (err) {
    // computeTotalOdds() only throws for MISSING_ODDS (a WIN leg with a
    // null BetSelection.odds) or ZERO_OR_NEGATIVE_ODDS — both are genuine
    // stored-data problems, not evaluator/business outcomes, so they
    // surface as INVALID_DATA rather than propagating a raw
    // ExpressMathError out of this otherwise-pure function.
    if (err instanceof ExpressMathError) {
      const affectedSelectionIds = winningLegs
        .filter((leg) => leg.odds === null || leg.odds.lte(0))
        .map((leg) => leg.id);
      const reasonCodes = Object.fromEntries(affectedSelectionIds.map((id) => [id, "INVALID_SELECTION_ODDS"]));
      return { kind: "INVALID_DATA", affectedSelectionIds, reasonCodes };
    }
    throw err;
  }
}
