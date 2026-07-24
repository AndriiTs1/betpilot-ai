import { Prisma } from "@/lib/generated/prisma/client";
import type { BetSelectionOddsStatus } from "@/lib/generated/prisma/client";
import type { ParsedBetSlip } from "@/lib/bets/betSlip";
import { validateBetSlipType, BetSlipValidationError } from "@/lib/bets/betSlipRules";
import { computeTotalOdds, computePotentialWin } from "@/lib/bets/expressMath";
import { mapOddsCheckToSelectionStatus } from "@/lib/odds/mapOddsStatus";
import type { verifyOdds } from "@/lib/odds/oddsVerifier";
import { TheOddsApiProvider } from "@/lib/odds/theOddsApiProvider";
import { OddsVerificationService } from "@/lib/odds/oddsVerificationService";
import type { VerifySelectionRequest } from "@/lib/odds/oddsProvider";
import {
  legacySelectionToCanonicalRequest,
  verificationResultToLegacyOddsCheck,
  type ReconstructedOddsCheck,
} from "@/lib/odds/legacyOddsBridge";
import { signPreviewToken, signExpressPreviewToken } from "@/lib/betPreview/previewToken";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import { logScreenshotPipelineEvent } from "@/lib/logging/structuredLog";

// Stage 12, Phase 3 — the one shared pipeline both the text and screenshot
// preview routes run a parsed slip through: validate shape -> verify odds
// per selection in parallel -> compute totals -> sign a previewToken. Exists
// so this logic isn't duplicated between the two routes (they only differ
// in how they got a ParsedBetSlip in the first place). Does NOT write to
// the database and does NOT touch createBetFromPreview.ts — this only ever
// produces the response Preview shows the player, plus the same kind of
// signed token confirm already accepts for SINGLE (Phase 3) and now signs
// for EXPRESS too (Phase 4, Step 2) — Confirm itself still only knows how
// to redeem a SINGLE token; that's Phase 4, Step 3's job, not this file's.
//
// Step 7 — odds verification now runs through the provider-neutral
// OddsVerificationService + TheOddsApiProvider (lib/odds/) instead of
// calling verifyOdds() directly. See docs/ODDS_PROVIDER_DESIGN.md Section
// 18 Phase E. This is a compatibility migration only: every public
// input/output shape below, and every odds-related field in the preview
// and both previewToken payloads, is unchanged — only the mechanism that
// fetches odds moved. lib/odds/legacyOddsBridge.ts owns the (pure,
// separately tested) translation in both directions; oddsVerifier.ts
// itself is untouched and remains the sole place that actually talks to
// The Odds API.

// One shared, stateless singleton — TheOddsApiProvider/OddsVerificationService
// hold no per-request mutable state, so there is no reason to reconstruct
// either per preview call (docs/ODDS_PROVIDER_DESIGN.md Section 10's
// "provider registry/resolver... trivial for MVP" — a full registry isn't
// warranted for exactly one always-used provider).
const defaultOddsProvider = new TheOddsApiProvider();
const defaultOddsVerificationService = new OddsVerificationService(defaultOddsProvider);

export type BuildBetSlipPreviewConfigErrorCode = "AMBIGUOUS_ODDS_DEPENDENCY";

// Same narrow-purpose "Error subclass with an explicit code" convention as
// BetSlipValidationError below — this is a programmer/configuration error
// (an impossible-by-contract caller mistake), not an expected verification
// outcome, so it throws rather than returning a typed result.
export class BuildBetSlipPreviewConfigError extends Error {
  readonly code: BuildBetSlipPreviewConfigErrorCode;

  constructor(code: BuildBetSlipPreviewConfigErrorCode, message: string) {
    super(message);
    this.name = "BuildBetSlipPreviewConfigError";
    this.code = code;
  }
}

// Precedence: oddsVerificationService (new primary seam) > verifyOddsFn
// (existing legacy seam, wrapped with TheOddsApiProvider so it flows
// through the exact same OddsVerificationService path production uses) >
// the shared default. Supplying both is rejected rather than silently
// prioritized — docs/ODDS_PROVIDER_DESIGN.md gives no reason two
// simultaneous odds dependencies would ever be intentional, and an
// ambiguous test/caller configuration is a bug worth surfacing loudly.
function resolveOddsVerificationService(
  options: BuildBetSlipPreviewOptions,
): Pick<OddsVerificationService, "verifyMany"> {
  if (options.oddsVerificationService && options.verifyOddsFn) {
    throw new BuildBetSlipPreviewConfigError(
      "AMBIGUOUS_ODDS_DEPENDENCY",
      "buildBetSlipPreview: supply either options.oddsVerificationService or options.verifyOddsFn, not both",
    );
  }
  if (options.oddsVerificationService) return options.oddsVerificationService;
  if (options.verifyOddsFn) return new OddsVerificationService(new TheOddsApiProvider(options.verifyOddsFn));
  return defaultOddsVerificationService;
}

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
  // SINGLE: always set (unchanged since Phase 3). EXPRESS (Phase 4, Step 2):
  // set whenever totalOdds/potentialWin could be computed, i.e. every
  // selection had a known submittedOdds — same condition that already
  // decides whether the preview itself shows real totals instead of null.
  // If any selection's odds are unknown, there's nothing valid to put in
  // an EXPRESS token's required (non-nullable) totalOdds/potentialWin
  // fields, so previewToken stays null exactly as it already would have.
  // createBetFromPreview.ts still only knows how to redeem a SINGLE token
  // (Phase 4, Step 3), and the Mini App still blocks EXPRESS Confirm
  // client-side regardless of this token's presence — signing it here is
  // just this step's scope, not a green light to submit yet.
  previewToken: string | null;
}

// Injectable so tests can supply a fake without hitting the real Odds API —
// defaults to the shared TheOddsApiProvider + OddsVerificationService for
// actual routes. Not a general dependency-injection framework, just two
// alternative seams with a shared default; see resolveOddsVerificationService.
export interface BuildBetSlipPreviewOptions {
  // Existing seam (unchanged type) — still the most direct way for a test
  // to control odds-check outcomes without knowing about the canonical
  // layer at all. Wrapped internally with TheOddsApiProvider so it reaches
  // the real production code path, not a bypass of it.
  verifyOddsFn?: typeof verifyOdds;
  // New seam — lets a test or future caller inject a full
  // OddsVerificationService-shaped dependency (a real instance, or
  // anything providing a compatible verifyMany) directly.
  oddsVerificationService?: Pick<OddsVerificationService, "verifyMany">;
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

  const oddsVerificationService = resolveOddsVerificationService(options);

  // Selections with no submitted odds are never sent to the provider —
  // there is nothing to verify against, mirroring the exact call-gating
  // this function has always had (previously: Promise.resolve(null)
  // instead of calling verifyOddsFn). `verifiableIndices[batchIndex]` maps
  // each verifyMany() result back to its original position in
  // slip.selections, since the two arrays are no longer the same length.
  const verifiableIndices: number[] = [];
  const requests: VerifySelectionRequest[] = [];

  slip.selections.forEach((selection, index) => {
    if (selection.submittedOdds === null) return;
    verifiableIndices.push(index);
    requests.push(
      legacySelectionToCanonicalRequest({
        sport: selection.sport,
        event: selection.event,
        selection: selection.selection,
        submittedOdds: selection.submittedOdds,
      }),
    );
  });

  // One call for the whole batch — OddsVerificationService owns
  // concurrency (bounded, order-preserving, failure-isolated) internally;
  // this file never loops verifyOne() itself. See
  // lib/odds/oddsVerificationService.ts.
  const results = await oddsVerificationService.verifyMany(requests);

  const reconstructedByIndex = new Map<number, ReconstructedOddsCheck>();
  verifiableIndices.forEach((selectionIndex, batchIndex) => {
    const submittedOdds = slip.selections[selectionIndex].submittedOdds!;
    reconstructedByIndex.set(selectionIndex, verificationResultToLegacyOddsCheck(results[batchIndex], submittedOdds));
  });

  const previewSelections: BetSlipPreviewSelection[] = slip.selections.map((selection, index) => {
    const reconstructed = reconstructedByIndex.get(index);
    const oddsCheck: OddsCheckResult | null = reconstructed?.oddsCheck ?? null;

    // Stage 14.4A security cleanup: this used to log selection.event
    // directly (plus, on the rejected-check path, oddsCheck.note /
    // settledResult.reason — per Stage 9's own comment, either of those
    // can contain sport_key values, internal tournament identifiers, or
    // raw upstream API error text). None of that is safe to log —
    // selection.event/selection/market/odds/stake are never copied into
    // BetSlipPreviewSelection either (so there was never anything to
    // strip before the response goes out), and now there's nothing to
    // strip from the logs either: only a status enum and a purely
    // positional index are logged, never the selection's own content.
    if (oddsCheck && !oddsCheck.matched) {
      logScreenshotPipelineEvent("odds_check_not_matched", {
        selectionIndex: index,
        oddsVerificationStatus: mapOddsCheckToSelectionStatus(oddsCheck),
      });
    }
    // Equivalent to the old settledResult.status === "rejected" check —
    // see ReconstructedOddsCheck's own doc comment in legacyOddsBridge.ts
    // for exactly why this is the correct signal now that
    // OddsVerificationService always converts a thrown verifyOddsFn error
    // into a normal (never-rejected) FAILED result.
    if (reconstructed?.wasExceptionMapped) {
      logScreenshotPipelineEvent("odds_check_rejected", { selectionIndex: index });
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

  // Kept as a Decimal (not re-derived from the number a second time below)
  // so the EXPRESS branch's stake string comes from the exact same
  // instance already used for potentialWin's math, not a fresh conversion.
  const stakeDecimal = new Prisma.Decimal(slip.stake);

  let totalOdds: Prisma.Decimal | null = null;
  let potentialWin: Prisma.Decimal | null = null;

  if (allOddsKnown) {
    totalOdds = computeTotalOdds(slip.selections.map((selection) => new Prisma.Decimal(selection.submittedOdds!)));
    potentialWin = computePotentialWin(stakeDecimal, totalOdds);
  }

  let previewToken: string | null = null;

  if (slip.type === "SINGLE") {
    const single = previewSelections[0];
    const rawOddsCheck: OddsCheckResult | null = reconstructedByIndex.get(0)?.oddsCheck ?? null;

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
  } else if (slip.type === "EXPRESS" && totalOdds !== null && potentialWin !== null) {
    // Not caught here: signExpressPreviewToken's own selections-count guard
    // (lib/betPreview/previewToken.ts) can only ever throw for a count
    // outside 2-10, and validateBetSlipType already enforced that same
    // range at the top of this function — this call is not expected to
    // throw in practice, but if it somehow did, the existing model this
    // function already follows for BetSlipValidationError applies equally
    // here: let it propagate uncaught rather than silently degrading to a
    // null token.
    previewToken = signExpressPreviewToken(
      {
        playerId,
        stake: stakeDecimal.toString(),
        totalOdds: totalOdds.toString(),
        potentialWin: potentialWin.toString(),
        selections: previewSelections.map((selection) => ({
          sport: selection.sport,
          event: selection.event,
          outcome: selection.selection,
          market: selection.market,
          submittedOdds:
            selection.submittedOdds !== null ? new Prisma.Decimal(selection.submittedOdds).toString() : null,
          currentOdds: selection.currentOdds !== null ? new Prisma.Decimal(selection.currentOdds).toString() : null,
          oddsStatus: selection.oddsStatus,
        })),
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
