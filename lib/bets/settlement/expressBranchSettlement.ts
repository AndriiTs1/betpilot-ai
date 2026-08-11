// X3E — exact EXPRESS branch settlement, per the reviewed X3D design.
//
// Root cause this replaces: X3B collapsed every HALF_WIN/HALF_LOSS leg into
// a single scalar "settlement factor" ((odds+1)/2 or 0.5), multiplied them
// all into one combined effectiveOdds, rounded THAT once, then applied it
// against the FULL stake via settleBet()'s ordinary grossPayout = round(
// stake * effectiveOdds) formula. X3C proved this is NOT cent-exact —
// rounding a combined ratio and then multiplying by the whole stake is not
// interchangeable with settling each real half-stake sub-bet independently
// (the exact same reason settleBet.ts's own SETTLED_HALF_WIN/HALF_LOSS
// comment already gives for SINGLE bets: "a single unrounded formula...
// can occasionally differ by a cent... once ROUND_HALF_UP is involved").
//
// This module computes the TRUE branch-decomposition delta instead: an
// EXPRESS with k split (HALF_WIN/HALF_LOSS) legs is exactly k+1 real
// sub-accumulators sharing the stake in 2^k equal shares, each settled
// independently via the EXACT SAME two-step rounding contract settleBet.ts
// already established (round the gross payout once, derive the net delta
// from that already-rounded figure) — then the branch deltas are summed.
// Every HALF_LOSS leg landing on its LOSS sub-outcome kills that branch
// unconditionally (accumulator rule), and every such branch shares the
// identical branchStake, so their combined contribution is a closed-form
// multiplication (no enumeration) — HALF_WIN legs are what actually need
// enumeration, one branch per subset assumed to land WIN, bounded at
// 2^MAX_EXPRESS_SELECTIONS in the worst case (see the test file for the
// concrete max-leg proof).
//
// Pure: no DB, no I/O, no Date.now(), no side effects. Prisma.Decimal only
// — never Number()/parseFloat()/Math.*/toFixed() anywhere in this file.
// Assumes every input odds value is already known-positive and non-null —
// the caller (aggregateExpressOutcome.ts) is responsible for that
// validation before ever constructing a BranchSettlementLeg, exactly as it
// already validates before calling computeTotalOdds() for the non-split
// case. This module never throws.
//
// Deliberately does NOT handle a real (non-split) full LOSS leg — that
// case is not a branch-decomposition question at all (see the module
// header this mirrors in aggregateExpressOutcome.ts's own comment): a
// genuine LOSS leg makes the WHOLE bet an unconditional full loss of the
// UNDIVIDED original stake, already handled by the pre-existing
// losingIds.length > 0 short-circuit before this module is ever reached.

import { Prisma } from "@/lib/generated/prisma/client";

const ROUNDING_DECIMAL_PLACES = 2;
const ROUNDING_MODE = Prisma.Decimal.ROUND_HALF_UP;

// Same rounding boundary as settleBet.ts's own roundMoney() — deliberately
// not imported from there (that file has no exported rounding helper, and
// this module must stay DB-free/importable without pulling in settleBet's
// own Prisma-writing machinery) — but byte-identical in mode and precision.
function roundMoney(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(ROUNDING_DECIMAL_PLACES, ROUNDING_MODE);
}

export type BranchSettlementLeg =
  | { readonly kind: "WIN"; readonly odds: Prisma.Decimal }
  | { readonly kind: "VOID" }
  | { readonly kind: "HALF_WIN"; readonly odds: Prisma.Decimal }
  | { readonly kind: "HALF_LOSS" };

// Computes the exact, cent-correct total EXPRESS delta for a set of legs
// that are ALL WIN, VOID, HALF_WIN, or HALF_LOSS (never a real LOSS — see
// header). Safe to call even when zero legs are HALF_WIN/HALF_LOSS (a=b=0
// collapses to a single "branch" = the whole bet, i.e. the ordinary
// SETTLED_WIN grossPayout/netProfit shape) — callers are not required to
// special-case that, though aggregateExpressOutcome.ts's own wiring only
// invokes this module when at least one split leg is present, reserving
// the pre-existing computeTotalOdds() scalar path for the pure a=b=0 case
// (provably identical, so no behavior changes there either way).
export function computeExpressBranchExactDelta(stake: Prisma.Decimal, legs: readonly BranchSettlementLeg[]): Prisma.Decimal {
  const plainWinOdds = legs.filter((l): l is { kind: "WIN"; odds: Prisma.Decimal } => l.kind === "WIN").map((l) => l.odds);
  const halfWinLegs = legs.filter((l): l is { kind: "HALF_WIN"; odds: Prisma.Decimal } => l.kind === "HALF_WIN");
  const halfLossCount = legs.filter((l) => l.kind === "HALF_LOSS").length;

  // P = product of every plain-WIN leg's odds (1 if none) — constant across
  // every branch, since plain WIN/VOID legs never split.
  const p = plainWinOdds.reduce((acc, odds) => acc.times(odds), new Prisma.Decimal(1));

  const a = halfWinLegs.length;
  const b = halfLossCount;
  const totalBranches = new Prisma.Decimal(2).pow(a + b);
  // Exact Decimal division — deliberately NEVER rounded on its own. A
  // branch's stake-share is not itself real money changing hands; only a
  // branch's final gross payout (or its negated stake, for a LOSS branch)
  // is ever rounded, exactly mirroring settleBet.ts's own halfStake
  // (SETTLED_HALF_WIN/HALF_LOSS) convention.
  const branchStake = stake.dividedBy(totalBranches);

  // LOSS branches: any branch where >= 1 HALF_LOSS leg lands on its LOSS
  // sub-outcome is a total loss for that branch, regardless of what any
  // HALF_WIN leg did in the same branch (accumulator rule — one LOSS
  // component kills the whole branch). Count = 2^a * (2^b - 1) (every
  // combination of HALF_WIN outcomes, times every HALF_LOSS combination
  // EXCEPT "all voided"). Every such branch shares the identical
  // branchStake, so its rounded delta is computed ONCE and multiplied —
  // no enumeration needed for this part.
  const lossBranchCount = new Prisma.Decimal(2).pow(a).times(new Prisma.Decimal(2).pow(b).minus(1));
  const perLossBranchDelta = roundMoney(branchStake.negated());
  let total = lossBranchCount.times(perLossBranchDelta);

  // Surviving branches (every HALF_LOSS leg voided): exactly 2^a, one per
  // subset of HALF_WIN legs assumed to land WIN (the rest VOID in that
  // branch). Bounded at 2^MAX_EXPRESS_SELECTIONS in the worst case (every
  // leg HALF_WIN) — see expressBranchSettlement.test.ts's max-leg proof.
  const subsetCount = 1 << a;
  for (let mask = 0; mask < subsetCount; mask++) {
    let combinedOdds = p;
    for (let i = 0; i < a; i++) {
      if (mask & (1 << i)) combinedOdds = combinedOdds.times(halfWinLegs[i].odds);
    }

    if (combinedOdds.equals(1)) {
      // This SPECIFIC branch has zero active WIN components (every split
      // leg landed VOID in this branch, and there are no plain-WIN legs
      // either). Since every real odds value is strictly > 1, combinedOdds
      // can only equal exactly 1 via this empty-product case — a true
      // breakeven for this one branch. Delta is exactly 0 by definition,
      // same axiom the top-level VOID case already uses (no arithmetic at
      // all) — branchStake must NEVER be rounded in isolation here; doing
      // so would manufacture a fake profit/loss out of a branch that
      // genuinely moved zero money, purely from stake/2^k not landing on a
      // clean 2-decimal value.
      continue;
    }

    const grossPayout = roundMoney(branchStake.times(combinedOdds));
    const branchDelta = roundMoney(grossPayout.minus(branchStake));
    total = total.plus(branchDelta);
  }

  return total;
}
