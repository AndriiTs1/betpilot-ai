import type { ParsedBet, ParseImageBetResult } from "@/lib/ai/betParser";

// Stage 12, Phase 3 — the unified SINGLE/EXPRESS shape every parser output
// converges on before Preview. Doesn't touch betParser.ts's own public
// types (ParsedBet, ParseImageBetResult stay exactly as they are) — this
// file only adds a normalization layer on top of them, so every existing
// caller of those types is completely unaffected.

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

// Normalizes parseImageWithClaude()'s existing result (SINGLE or PARLAY —
// that discriminant name is untouched in betParser.ts itself) into the
// unified shape. PARLAY maps to "EXPRESS" here only — the rename from
// Phase 1's Prisma enum never had to propagate back into the AI parser's
// own vocabulary for this to work.
export function normalizeParsedImageBet(
  result: Extract<ParseImageBetResult, { valid: true }>,
): ParsedBetSlip {
  if (result.type === "SINGLE") {
    return normalizeParsedBet(result.bet);
  }

  return {
    type: "EXPRESS",
    stake: result.stake,
    selections: result.selections.map((selection) => ({
      sport: selection.sport,
      event: selection.event,
      market: null,
      selection: selection.selection,
      submittedOdds: selection.odds,
    })),
  };
}
