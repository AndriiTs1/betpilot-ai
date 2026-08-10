// Stage 3.3 — pure Bet -> CanonicalSelection mapper for a SINGLE bet, used
// only to feed evaluateSelectionOutcome() for automatic settlement. Source
// of truth is exactly the Stage 3.1 canonical columns
// (canonicalMarketType/canonicalSelectionType/canonicalParticipant/
// canonicalPeriod) — never Bet.event/Bet.outcome (free text), never
// mapBetForDisplay.ts's legacy-fallback logic, never AI, never fuzzy
// matching. Returns null (never throws) whenever a required field is
// missing or fails lib/odds/domain.ts's own guards — this function never
// guesses a value it can't verify.
//
// CanonicalSelection.sport/.event are required by the type but are NEVER
// read by evaluateSelectionOutcome() (confirmed by reading that file in
// full during this stage's audit — it only reads .marketType/.period/
// .selectionType/.participant). Rather than parse Bet.event's free text
// into a CanonicalEvent.name/participants (explicitly forbidden — that
// would be "taking display labels as canonical data"), this mapper fills
// them with an inert, honestly-empty placeholder: sport "UNKNOWN",
// name "", participants []. Bet.event/Bet.sport are not even accepted as
// inputs to this function, so there is no way to accidentally let them
// leak into a decision.

import { Prisma } from "@/lib/generated/prisma/client";
import { isMarketType, isPeriod, isSelectionType, type CanonicalSelection } from "@/lib/odds/domain";

export interface SingleBetCanonicalFields {
  readonly canonicalMarketType: string | null;
  readonly canonicalSelectionType: string | null;
  readonly canonicalParticipant: string | null;
  readonly canonicalPeriod: string | null;
  // H4-B2 — Bet.line (Decimal(5,2), see H4-B1), threaded through so
  // evaluateSelectionOutcome() can evaluate SPREAD selections. Converted
  // with Prisma.Decimal's own .toString() — decimal.js never loses
  // precision or reformats the value (no rounding, no added/dropped
  // trailing zeros beyond what was already stored), so -1.25 stays
  // "-1.25" and 0.75 stays "0.75", never coerced through a native
  // floating-point number at any point in this function.
  readonly line: Prisma.Decimal | null;
}

export function mapSingleBetToCanonicalSelection(bet: SingleBetCanonicalFields): CanonicalSelection | null {
  const { canonicalMarketType, canonicalSelectionType, canonicalPeriod, canonicalParticipant, line } = bet;

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
