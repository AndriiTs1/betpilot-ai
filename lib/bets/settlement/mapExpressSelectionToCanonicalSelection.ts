// Stage 3.4B — pure BetSelection -> CanonicalSelection mapper for a single
// EXPRESS leg, used only to feed evaluateSelectionOutcome() for automatic
// settlement. Source of truth is exactly the Stage 3.1 canonical columns
// (canonicalMarketType/canonicalSelectionType/canonicalParticipant/
// canonicalPeriod) — never BetSelection.event/BetSelection.outcome (free
// text), never mapBetForDisplay.ts's legacy-fallback logic, never AI, never
// fuzzy matching. Returns null (never throws) whenever a required field is
// missing or fails lib/odds/domain.ts's own guards.
//
// Deliberately a separate, near-identical twin of
// mapSingleBetToCanonicalSelection.ts rather than a shared generic helper —
// per the Stage 3.4 audit's own recommendation: the two bet shapes
// (Bet for SINGLE, BetSelection for EXPRESS) are coincidentally identical
// in their 4 canonical field names today, but keeping them as separate,
// independently-testable modules means a future change to one can never
// silently affect the other. The duplication is 4 lines of validation, not
// a real cost.
//
// CanonicalSelection.sport/.event are required by the type but are NEVER
// read by evaluateSelectionOutcome() — filled with an inert, honestly-empty
// placeholder (sport "UNKNOWN", name "", participants []), never parsed
// from BetSelection.event/.outcome (which aren't even accepted as inputs
// here, so there is no way for them to leak into a decision).
//
// X2 — BetSelection.line threaded through, same pattern as
// mapSingleBetToCanonicalSelection.ts's own `line` field: converted with
// Prisma.Decimal's own .toString() (decimal.js, no rounding, no reformatting
// beyond what's already stored — never Number()/parseFloat()/toFixed()), so
// -1.25 stays "-1.25" and 2.5 stays "2.5". This alone does not enable SPREAD/
// TOTALS EXPRESS settlement — aggregateExpressOutcome.ts's own
// SPREAD_AUTO_SETTLEMENT_DEFERRED/TOTALS_AUTO_SETTLEMENT_DEFERRED guards are
// unchanged and still turn those legs away before this value is ever read
// for a settlement decision. This is purely making the already-persisted
// value available to a future evaluator, not a behavior change.

import { Prisma } from "@/lib/generated/prisma/client";
import { isMarketType, isPeriod, isSelectionType, type CanonicalSelection } from "@/lib/odds/domain";

export interface ExpressSelectionCanonicalFields {
  readonly canonicalMarketType: string | null;
  readonly canonicalSelectionType: string | null;
  readonly canonicalParticipant: string | null;
  readonly canonicalPeriod: string | null;
  // X2 — BetSelection.line (Decimal(5,2), see prisma/schema.prisma).
  readonly line: Prisma.Decimal | null;
}

export function mapExpressSelectionToCanonicalSelection(
  selection: ExpressSelectionCanonicalFields,
): CanonicalSelection | null {
  const { canonicalMarketType, canonicalSelectionType, canonicalPeriod, canonicalParticipant, line } = selection;

  if (canonicalMarketType === null || !isMarketType(canonicalMarketType)) return null;
  if (canonicalSelectionType === null || !isSelectionType(canonicalSelectionType)) return null;
  if (canonicalPeriod === null || !isPeriod(canonicalPeriod)) return null;

  return {
    sport: "UNKNOWN",
    event: {
      sport: "UNKNOWN",
      name: "",
      participants: [],
      period: canonicalPeriod,
    },
    marketType: canonicalMarketType,
    period: canonicalPeriod,
    selectionType: canonicalSelectionType,
    participant: canonicalParticipant !== null ? { name: canonicalParticipant } : undefined,
    line: line !== null ? line.toString() : undefined,
  };
}
