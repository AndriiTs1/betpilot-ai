import { Prisma } from "@/lib/generated/prisma/client";
import type { BetSelectionOddsStatus } from "@/lib/generated/prisma/client";
import type { ParsedBetSlip } from "@/lib/bets/betSlip";
import { validateBetSlipType, BetSlipValidationError } from "@/lib/bets/betSlipRules";
import { computeTotalOdds, computePotentialWin } from "@/lib/bets/expressMath";
import { mapOddsCheckToSelectionStatus } from "@/lib/odds/mapOddsStatus";
import { verifyOdds, type OddsVerificationInput } from "@/lib/odds/oddsVerifier";
import { signPreviewToken } from "@/lib/betPreview/previewToken";
import type { OddsCheckResult } from "@/types/oddsSnapshot";

// Stage 12, Phase 3 — the one shared pipeline both the text and screenshot
// preview routes run a parsed slip through: validate shape -> verify odds
// per selection in parallel -> compute totals -> sign a previewToken (SINGLE
// only, for now). Exists so this logic isn't duplicated between the two
// routes (they only differ in how they got a ParsedBetSlip in the first
// place). Does NOT write to the database and does NOT touch
// createBetFromPreview.ts — this only ever produces the response Preview
// shows the player, plus (for SINGLE) the exact same kind of signed token
// confirm already accepts.

export interface BetSlipPreviewSelection {
  sport: string;
  event: string;
  market: string | null;
  selection: string;
  submittedOdds: number | null;
  currentOdds: number | null;
  oddsStatus: BetSelectionOddsStatus;
  bookmaker: string | null;
  discrepancyPercent: number | null;
}

export interface BetSlipPreview {
  type: "SINGLE" | "EXPRESS";
  stake: number;
  totalOdds: number | null;
  potentialWin: number | null;
  selections: BetSlipPreviewSelection[];
}

export interface BuildBetSlipPreviewResult {
  preview: BetSlipPreview;
  // Only ever set for SINGLE — EXPRESS confirm isn't implemented yet
  // (createBetFromPreview.ts only models one selection), so no token is
  // signed for it. The Mini App blocks Confirm for EXPRESS client-side;
  // this is the server-side backstop — there is nothing to submit even if
  // that UI guard were bypassed.
  previewToken: string | null;
}

// Injectable so tests can supply a fake without hitting the real Odds API —
// defaults to the real verifyOdds for actual routes. Not a general
// dependency-injection framework, just one parameter with a default.
export interface BuildBetSlipPreviewOptions {
  verifyOddsFn?: (input: OddsVerificationInput) => Promise<OddsCheckResult>;
}

export async function buildBetSlipPreview(
  slip: ParsedBetSlip,
  playerId: string,
  previewTokenSecret: string,
  options: BuildBetSlipPreviewOptions = {},
): Promise<BuildBetSlipPreviewResult> {
  // Throws BetSlipValidationError on an invalid (type, selections.length)
  // combination — callers (the preview routes) catch this and return a 422
  // before this function is ever reached again. Nothing below runs for an
  // invalid slip.
  validateBetSlipType(slip.type, slip.selections);

  const verifyOddsFn = options.verifyOddsFn ?? verifyOdds;

  // One request per selection, in parallel. allSettled (not Promise.all) so
  // a single rejected/thrown check never aborts the others — each outcome
  // is mapped independently right below.
  const settled = await Promise.allSettled(
    slip.selections.map((selection) =>
      selection.submittedOdds !== null
        ? verifyOddsFn({
            sport: selection.sport,
            event: selection.event,
            selection: selection.selection,
            odds: selection.submittedOdds,
          })
        : Promise.resolve(null),
    ),
  );

  const previewSelections: BetSlipPreviewSelection[] = slip.selections.map((selection, index) => {
    const settledResult = settled[index];
    const oddsCheck: OddsCheckResult | null = settledResult.status === "fulfilled" ? settledResult.value : null;

    // Stage 9's rule carried forward: oddsCheck.note can contain sport_key
    // values, internal tournament identifiers, or raw upstream API error
    // text (see lib/odds/oddsVerifier.ts) — useful for debugging, never for
    // a player. It's never copied into BetSlipPreviewSelection below (so
    // there's nothing to strip before the response goes out) — only logged
    // here, server-side.
    if (oddsCheck && !oddsCheck.matched) {
      console.log(`buildBetSlipPreview: odds not matched for "${selection.event}":`, oddsCheck.note);
    }
    if (settledResult.status === "rejected") {
      console.error(`buildBetSlipPreview: odds check rejected for "${selection.event}":`, settledResult.reason);
    }

    return {
      sport: selection.sport,
      event: selection.event,
      market: selection.market,
      selection: selection.selection,
      submittedOdds: selection.submittedOdds,
      currentOdds: oddsCheck?.sourceOdds ?? null,
      oddsStatus: mapOddsCheckToSelectionStatus(oddsCheck),
      bookmaker: oddsCheck?.bookmaker ?? null,
      discrepancyPercent: oddsCheck?.discrepancyPercent ?? null,
    };
  });

  // totalOdds/potentialWin become null (not thrown) whenever any leg's
  // submitted odds is unknown — mirrors the pre-Phase-3 SINGLE behavior,
  // where potentialWin was already nullable when odds was null. This
  // function's job is to decide *when* it's safe to call the strict
  // computeTotalOdds/computePotentialWin, not to duplicate their math.
  const allOddsKnown = slip.selections.every((selection) => selection.submittedOdds !== null);

  let totalOdds: Prisma.Decimal | null = null;
  let potentialWin: Prisma.Decimal | null = null;

  if (allOddsKnown) {
    totalOdds = computeTotalOdds(slip.selections.map((selection) => new Prisma.Decimal(selection.submittedOdds!)));
    potentialWin = computePotentialWin(new Prisma.Decimal(slip.stake), totalOdds);
  }

  let previewToken: string | null = null;

  if (slip.type === "SINGLE") {
    const single = previewSelections[0];
    const rawOddsCheck: OddsCheckResult | null = settled[0].status === "fulfilled" ? settled[0].value : null;

    previewToken = signPreviewToken(
      {
        playerId,
        sport: single.sport,
        event: single.event,
        outcome: single.selection,
        stake: slip.stake,
        odds: single.submittedOdds,
        totalOdds: totalOdds !== null ? totalOdds.toNumber() : single.submittedOdds,
        oddsCheck: rawOddsCheck
          ? {
              matched: rawOddsCheck.matched,
              withinTolerance: rawOddsCheck.withinTolerance,
              sourceOdds: rawOddsCheck.sourceOdds,
              bookmaker: rawOddsCheck.bookmaker,
            }
          : null,
      },
      previewTokenSecret,
    );
  }

  return {
    preview: {
      type: slip.type,
      stake: slip.stake,
      totalOdds: totalOdds !== null ? totalOdds.toNumber() : null,
      potentialWin: potentialWin !== null ? potentialWin.toNumber() : null,
      selections: previewSelections,
    },
    previewToken,
  };
}

export { BetSlipValidationError };
