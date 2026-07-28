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

import { isMarketType, isPeriod, isSelectionType, type CanonicalSelection } from "@/lib/odds/domain";

export interface SingleBetCanonicalFields {
  readonly canonicalMarketType: string | null;
  readonly canonicalSelectionType: string | null;
  readonly canonicalParticipant: string | null;
  readonly canonicalPeriod: string | null;
}

export function mapSingleBetToCanonicalSelection(bet: SingleBetCanonicalFields): CanonicalSelection | null {
  const { canonicalMarketType, canonicalSelectionType, canonicalPeriod, canonicalParticipant } = bet;

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
  };
}
