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
import { computeTotalOdds } from "@/lib/bets/expressMath";
import { evaluateSelectionOutcome, type SelectionOutcomeEvaluation } from "./evaluateSelectionOutcome";
import { computeExpressBranchExactDelta, type BranchSettlementLeg } from "./expressBranchSettlement";
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
      // X3E — exactly one of these two is present, never both:
      // effectiveOdds for an ORDINARY WIN (no HALF_WIN/HALF_LOSS leg
      // present at all — the pure computeTotalOdds() scalar path, byte-
      // identical to before X3B/X3E for this case); exactDelta for a
      // BRANCH-DERIVED WIN (>=1 HALF_WIN/HALF_LOSS leg present — X3C proved
      // effectiveOdds cannot represent this case cent-exactly, so the
      // caller-computed branch-summed delta is carried instead, per
      // settleBet.ts's own X3E exactDelta primitive).
      readonly effectiveOdds?: Prisma.Decimal;
      readonly exactDelta?: Prisma.Decimal;
      // Every leg that contributed a non-trivial factor to the product: a
      // full WIN, or a HALF_WIN/HALF_LOSS quarter-line component. For an
      // EXPRESS with only full-WIN legs, this is byte-identical to before
      // X3B — the set of full-WIN leg ids.
      readonly winningSelectionIds: readonly string[];
      readonly voidedSelectionIds: readonly string[];
    }
  | {
      readonly kind: "LOSS";
      readonly losingSelectionIds: readonly string[];
      // X3E — present ONLY for a genuine PARTIAL loss (a HALF_WIN/
      // HALF_LOSS combination whose exact branch-summed delta is strictly
      // negative), never when losingSelectionIds is non-empty (a real full
      // LOSS leg — still needs no override at all, per settleBet.ts's own
      // X3A rule and X2.5's design: full-stake loss is not a branch-
      // decomposition question, see this file's own full-LOSS short-
      // circuit below). Always the exact branch-summed delta now, never a
      // scalar effectiveOdds — a partial LOSS can only ever arise from a
      // HALF_WIN/HALF_LOSS combination (a pure WIN/VOID-only EXPRESS can
      // never classify as LOSS except via the full-LOSS short-circuit),
      // so effectiveOdds was never actually meaningful for LOSS and is
      // dropped from this variant entirely.
      readonly exactDelta?: Prisma.Decimal;
    }
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
  // X3E — Bet.stake, needed only for the branch-exact path (splitting the
  // ORIGINAL stake into 2^k branches — see expressBranchSettlement.ts).
  // Never read for LOSS/VOID/WAITING/UNSUPPORTED/INVALID_DATA, and never
  // read for the ordinary no-split-leg WIN path either (that continues to
  // use the pre-existing computeTotalOdds() scalar product, unaffected).
  stake: Prisma.Decimal,
): AggregateExpressOutcome {
  const losingIds: string[] = [];
  const invalidIds: string[] = [];
  const invalidReasons: Record<string, string> = {};
  const unsupportedIds: string[] = [];
  const unsupportedReasons: Record<string, string> = {};
  const waitingIds: string[] = [];
  const missingProviderEventIds: string[] = [];
  // X3B/X3E — every leg whose evaluation contributes a non-trivial value
  // to the product: full WIN, or a HALF_WIN/HALF_LOSS quarter-line
  // component. VOID legs still contribute nothing and are still simply
  // excluded (never a fabricated entry).
  const contributingLegs: Array<{
    readonly id: string;
    readonly kind: "WIN" | "HALF_WIN" | "HALF_LOSS";
    readonly odds: Prisma.Decimal | null;
  }> = [];
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
        contributingLegs.push({ id: leg.id, kind: "WIN", odds: leg.odds });
        break;
      // X3B — HALF_WIN/HALF_LOSS are real, reachable evaluation kinds for
      // a SPREAD or TOTALS quarter-line leg (the SPREAD_AUTO_SETTLEMENT_
      // DEFERRED/TOTALS_AUTO_SETTLEMENT_DEFERRED guards that used to
      // intercept both markets before evaluateSelectionOutcome() was ever
      // called were removed in X3B). Both cases are explicit — neither
      // silently falls through a missing switch case.
      case "HALF_WIN":
        contributingLegs.push({ id: leg.id, kind: "HALF_WIN", odds: leg.odds });
        break;
      case "HALF_LOSS":
        contributingLegs.push({ id: leg.id, kind: "HALF_LOSS", odds: null });
        break;
    }
  }

  if (losingIds.length > 0) {
    // X3D/X3E — a real (non-split) full LOSS leg is not a branch-
    // decomposition question at all: it makes the WHOLE ORIGINAL,
    // UNDIVIDED stake an unconditional loss regardless of any HALF_WIN/
    // HALF_LOSS leg's own state (accumulator rule — one genuine LOSS
    // component kills the entire bet). No exactDelta, no effectiveOdds —
    // settleBet.ts's plain SETTLED_LOSS (no override) already computes
    // exactly this (round(-stake)), unchanged since before X3B.
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

  // Every leg is now WIN, HALF_WIN, HALF_LOSS, or VOID.
  if (contributingLegs.length === 0) {
    return { kind: "VOID" };
  }

  const hasSplitLeg = contributingLegs.some((leg) => leg.kind === "HALF_WIN" || leg.kind === "HALF_LOSS");

  // WIN/HALF_WIN legs both require a real, positive stored odds value —
  // checked once, uniformly, before either path below runs. A HALF_LOSS
  // leg needs no odds at all (same rule as SINGLE's own HALF_LOSS math).
  const invalidOddsIds = contributingLegs
    .filter((leg) => leg.kind !== "HALF_LOSS" && (leg.odds === null || leg.odds.lte(0)))
    .map((leg) => leg.id);
  if (invalidOddsIds.length > 0) {
    const reasonCodes = Object.fromEntries(invalidOddsIds.map((id) => [id, "INVALID_SELECTION_ODDS"]));
    return { kind: "INVALID_DATA", affectedSelectionIds: invalidOddsIds, reasonCodes };
  }

  if (!hasSplitLeg) {
    // X3E — no HALF_WIN/HALF_LOSS leg present at all: the pure, unmodified
    // computeTotalOdds() scalar product (lib/bets/expressMath.ts), exactly
    // as before X3B. Every real leg odds is > 1, so a product of >=1 such
    // WIN legs is always > 1 — this path can only ever be a genuine WIN
    // (VOID/LOSS were already resolved above), matching the pre-X3B
    // MONEYLINE-only EXPRESS contract byte-for-byte.
    const effectiveOdds = computeTotalOdds(contributingLegs.map((leg) => leg.odds));
    return {
      kind: "WIN",
      effectiveOdds,
      winningSelectionIds: contributingLegs.map((leg) => leg.id),
      voidedSelectionIds: voidedIds,
    };
  }

  // X3E — at least one HALF_WIN/HALF_LOSS leg: X3C proved the X3B scalar-
  // factor shortcut is not cent-exact here. Delegate to the reviewed X3D
  // branch algorithm instead, which sums every real 2^k sub-accumulator's
  // own independently-rounded delta — the exact same rounding contract
  // settleBet.ts's SETTLED_HALF_WIN/HALF_LOSS already use for SINGLE bets.
  const branchLegs: BranchSettlementLeg[] = contributingLegs.map((leg) => {
    if (leg.kind === "HALF_LOSS") return { kind: "HALF_LOSS" };
    // leg.odds is guaranteed non-null and positive here (checked above).
    return { kind: leg.kind, odds: leg.odds as Prisma.Decimal };
  });
  const exactDelta = computeExpressBranchExactDelta(stake, branchLegs);

  // X3D's proven final-status boundary, applied to the exact branch-summed
  // delta:
  //   delta == 0 -> VOID (a genuine coincidental breakeven — e.g. a
  //                 HALF_WIN branch's gain exactly cancels a HALF_LOSS
  //                 branch's loss; financially identical to, but distinct
  //                 from, the "every leg voided" case above)
  //   delta <  0 -> LOSS with this exactDelta as a SETTLED_LOSS override
  //                 (settleBet.ts's X3E primitive; a real LOSS leg — the
  //                 only OTHER way to reach a full loss — was already
  //                 intercepted above, long before any branch was summed)
  //   delta >  0 -> WIN with this exactDelta
  if (exactDelta.equals(0)) {
    return { kind: "VOID" };
  }
  if (exactDelta.lessThan(0)) {
    return { kind: "LOSS", losingSelectionIds: [], exactDelta };
  }
  return {
    kind: "WIN",
    exactDelta,
    winningSelectionIds: contributingLegs.map((leg) => leg.id),
    voidedSelectionIds: voidedIds,
  };
}
