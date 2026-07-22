import type { ParsedBet } from "@/lib/ai/betParser";

// Stage 12, Phase 3 — the unified SINGLE/EXPRESS shape every parser output
// converges on before Preview. Doesn't touch betParser.ts's own public
// types (ParsedBet stays exactly as it is) — this file only adds a
// normalization layer on top of it, so every existing caller of that type
// is completely unaffected.
//
// Stage 14.3 — normalizeParsedImageBet() (the equivalent normalizer for the
// old image-parser's ParseImageBetResult) was removed here: the new OCR ->
// parseBetSlipMessage() pipeline already returns this exact ParsedBetSlip
// shape directly (see lib/ai/betParser.ts's ParseBetSlipResult), so no
// normalization step is needed for screenshots anymore.

export interface BetSlipSelectionInput {
  sport: string;
  event: string;
  market: string | null;
  selection: string;
  // Decimal-compatible: a plain number here (what every parser produces
  // today) — callers construct a Prisma.Decimal from it at the point they
  // actually need Decimal math (see lib/bets/buildBetSlipPreview.ts).
  // Nullable because a player can omit odds for a leg — the same case
  // that's always been representable for a SINGLE bet.
  submittedOdds: number | null;
}

export interface ParsedBetSlip {
  type: "SINGLE" | "EXPRESS";
  stake: number;
  selections: BetSlipSelectionInput[];
}

// Normalizes the existing, unchanged single-selection parser shape
// (ParsedBet — what parseBetMessage()/the image parser's SINGLE branch
// already return) into the new unified ParsedBetSlip. This *is* the
// backward-compatibility layer requirement: old SINGLE output still flows
// through unchanged, just wrapped.
export function normalizeParsedBet(bet: ParsedBet): ParsedBetSlip {
  return {
    type: "SINGLE",
    stake: bet.stake,
    selections: [
      {
        sport: bet.sport,
        event: bet.event,
        market: null,
        selection: bet.selection,
        submittedOdds: bet.odds,
      },
    ],
  };
}
