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
import type { CanonicalSelection } from "@/lib/odds/domain";
import {
  legacySelectionToCanonicalRequest,
  verificationResultToLegacyOddsCheck,
  type ReconstructedOddsCheck,
} from "@/lib/odds/legacyOddsBridge";
import { signPreviewToken, signExpressPreviewToken } from "@/lib/betPreview/previewToken";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import { logScreenshotPipelineEvent } from "@/lib/logging/structuredLog";
import { formatFullEventName } from "@/lib/bets/formatFullEventName";

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
  // The full resolved event name ("Arsenal — Coventry City") whenever the
  // odds provider unambiguously matched one, falling back to exactly what
  // it always was (the player's own parsed text, e.g. "Arsenal") when it
  // didn't — see formatFullEventName. Never breaks an existing consumer:
  // this field's type and "always present" contract are unchanged, only
  // its value gets richer.
  event: string;
  market: string | null;
  selection: string;
  submittedOdds: number | null;
  currentOdds: number | null;
  oddsStatus: BetSelectionOddsStatus;
  bookmaker: string | null;
  discrepancyPercent: number | null;
  // Present only when the odds provider unambiguously resolved the event
  // (mirrors OddsCheckResult's own all-or-nothing rule) — null otherwise,
  // never fabricated. homeTeamName/awayTeamName are the provider's own team
  // names (not the player's typed text); competitionName is a
  // human-readable league name; eventStartTime is the provider's own
  // commence_time (ISO 8601).
  homeTeamName: string | null;
  awayTeamName: string | null;
  competitionName: string | null;
  eventStartTime: string | null;
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
// Stage 3.1 — the seven provider/canonical fields threaded into the signed
// preview token (lib/betPreview/previewToken.ts's PreviewTokenProviderMetadata).
// Gated as one atomic unit on a single signal: did the odds check actually
// resolve a trustworthy provider event? (oddsCheck.matched === true AND
// oddsVerifier.ts's own all-or-nothing metadata was present — see
// lib/odds/oddsVerifier.ts's extractProviderEventMetadata). Provider event
// identity (providerEventId/providerSportKey/eventStartTime) comes from
// oddsCheck, the post-verification RESULT; canonical market/selection
// identity comes from `canonicalSelection`, the pre-verification REQUEST
// already built by legacySelectionToCanonicalRequest() above — deterministic
// from the player's own text, independent of whether the provider call
// succeeded, but only surfaced here alongside the provider fields, never
// independently, so a consumer sees "all seven present" as one fact.
interface ProviderTokenFields {
  providerEventId: string | null;
  providerSportKey: string | null;
  eventStartTime: string | null;
  canonicalMarketType: string | null;
  canonicalSelectionType: string | null;
  canonicalParticipant: string | null;
  canonicalPeriod: string | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  competitionName: string | null;
}

const NULL_PROVIDER_TOKEN_FIELDS: ProviderTokenFields = {
  providerEventId: null,
  providerSportKey: null,
  eventStartTime: null,
  canonicalMarketType: null,
  canonicalSelectionType: null,
  canonicalParticipant: null,
  canonicalPeriod: null,
  homeTeamName: null,
  awayTeamName: null,
  competitionName: null,
};

function buildProviderTokenFields(
  oddsCheck: OddsCheckResult | null,
  canonicalSelection: CanonicalSelection | undefined,
): ProviderTokenFields {
  if (!oddsCheck || oddsCheck.matched !== true || oddsCheck.providerEventId === undefined || !canonicalSelection) {
    return NULL_PROVIDER_TOKEN_FIELDS;
  }

  return {
    providerEventId: oddsCheck.providerEventId,
    providerSportKey: oddsCheck.providerSportKey ?? null,
    eventStartTime: oddsCheck.eventStartTime ?? null,
    canonicalMarketType: canonicalSelection.marketType,
    canonicalSelectionType: canonicalSelection.selectionType,
    canonicalParticipant: canonicalSelection.participant?.name ?? null,
    canonicalPeriod: canonicalSelection.period,
    homeTeamName: oddsCheck.homeTeamName ?? null,
    awayTeamName: oddsCheck.awayTeamName ?? null,
    competitionName: oddsCheck.competitionName ?? null,
  };
}

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

  // Step 17 — every selection is sent for provider verification, SINGLE and
  // EXPRESS alike, regardless of whether the player submitted a price. A
  // null submittedOdds is not "nothing to verify": Step 15G/15H's
  // nullable-aware pipeline asks the provider to find and price the
  // selection itself, and a successful match's price is promoted into
  // submittedOdds below (see effectiveSubmittedOdds). There is no separate
  // EXPRESS pipeline — this is the exact same request-building/verifyMany()
  // path SINGLE has always used.
  //
  // Previously (Step 15I) this auto-lookup was gated to SINGLE only — an
  // EXPRESS leg with no submitted price was never sent to the provider at
  // all and fell straight to UNAVAILABLE, even when the underlying event
  // was genuinely verifiable (confirmed live: an EXPRESS built from two
  // real, individually-VERIFIED-as-SINGLE events reported the whole slip as
  // unconfirmable). That restriction is now removed for both bet types.
  //
  // `verifiableIndices[batchIndex]` maps each verifyMany() result back to
  // its original position in slip.selections — always the identity mapping
  // now that nothing is filtered out, kept so the by-index reconstruction
  // below needs no separate code path for "some selections were skipped".
  const verifiableIndices: number[] = [];
  const requests: VerifySelectionRequest[] = [];

  slip.selections.forEach((selection, index) => {
    verifiableIndices.push(index);
    requests.push(
      legacySelectionToCanonicalRequest({
        sport: selection.sport,
        // Step 16A — an explicit, player-stated league (e.g. "Serie A"),
        // when present, now reaches provider verification instead of being
        // silently dropped — see lib/odds/footballLeagues.ts for where it's
        // actually resolved/validated.
        league: selection.league ?? null,
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

  // Step 15I — no longer passes a submittedOdds argument: Step 15H made
  // verificationResultToLegacyOddsCheck derive submittedOdds entirely from
  // the verification result itself (correctly promoted for a successful
  // SINGLE null-input lookup, unchanged for a real numeric submission).
  // Passing the original slip.selections[...].submittedOdds here would
  // require a non-null assertion for exactly the new SINGLE-null-input
  // case this step introduces — removed rather than forced.
  const reconstructedByIndex = new Map<number, ReconstructedOddsCheck>();
  verifiableIndices.forEach((selectionIndex, batchIndex) => {
    reconstructedByIndex.set(selectionIndex, verificationResultToLegacyOddsCheck(results[batchIndex]));
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
    // strip from the logs either: only a status enum, the internal
    // reasonCode (a fixed enum value, e.g. "PROVIDER_QUOTA_EXCEEDED" —
    // never free text), and a purely positional index are logged, never
    // the selection's own content.
    if (oddsCheck && !oddsCheck.matched) {
      logScreenshotPipelineEvent("odds_check_not_matched", {
        selectionIndex: index,
        oddsVerificationStatus: mapOddsCheckToSelectionStatus(oddsCheck),
        failureCode: oddsCheck.reasonCode,
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

    // Step 15I / Step 17 — when the player submitted no odds but auto-lookup
    // (see the request-construction block above, now identical for SINGLE
    // and EXPRESS) found and verified a real provider price,
    // oddsCheck.submittedOdds already holds that promoted price (Step 15G's
    // own promotion, carried through by Step 15H's bridge). For every other
    // case — a real player submission, or a lookup that failed to find
    // anything to promote — this is exactly the original value, unchanged.
    const effectiveSubmittedOdds = selection.submittedOdds ?? oddsCheck?.submittedOdds ?? null;

    return {
      sport: selection.sport,
      event: formatFullEventName(selection.event, oddsCheck?.homeTeamName ?? null, oddsCheck?.awayTeamName ?? null),
      market: selection.market,
      selection: selection.selection,
      submittedOdds: effectiveSubmittedOdds,
      currentOdds: oddsCheck?.sourceOdds ?? null,
      oddsStatus: mapOddsCheckToSelectionStatus(oddsCheck),
      bookmaker: oddsCheck?.bookmaker ?? null,
      discrepancyPercent: oddsCheck?.discrepancyPercent ?? null,
      homeTeamName: oddsCheck?.homeTeamName ?? null,
      awayTeamName: oddsCheck?.awayTeamName ?? null,
      competitionName: oddsCheck?.competitionName ?? null,
      eventStartTime: oddsCheck?.eventStartTime ?? null,
    };
  });

  // totalOdds/potentialWin become null (not thrown) whenever any leg's
  // submitted odds is unknown — mirrors the pre-Phase-3 SINGLE behavior,
  // where potentialWin was already nullable when odds was null. This
  // function's job is to decide *when* it's safe to call the strict
  // computeTotalOdds/computePotentialWin, not to duplicate their math.
  //
  // Step 15I — reads previewSelections (the EFFECTIVE, possibly
  // auto-lookup-promoted odds), not the original slip.selections: a SINGLE
  // selection that started with submittedOdds:null but was successfully
  // auto-looked-up now has a real effective value here, and must count as
  // "known" for totalOdds/potentialWin to be computed from it.
  const allOddsKnown = previewSelections.every((selection) => selection.submittedOdds !== null);

  // Kept as a Decimal (not re-derived from the number a second time below)
  // so the EXPRESS branch's stake string comes from the exact same
  // instance already used for potentialWin's math, not a fresh conversion.
  const stakeDecimal = new Prisma.Decimal(slip.stake);

  let totalOdds: Prisma.Decimal | null = null;
  let potentialWin: Prisma.Decimal | null = null;

  if (allOddsKnown) {
    // Step 15I — reads previewSelections (effective odds), matching
    // allOddsKnown above; same non-null-assertion shape this line already
    // had before this step (now proven correct against the array
    // allOddsKnown itself was just computed from, not a different one).
    totalOdds = computeTotalOdds(previewSelections.map((selection) => new Prisma.Decimal(selection.submittedOdds!)));
    potentialWin = computePotentialWin(stakeDecimal, totalOdds);
  }

  let previewToken: string | null = null;

  if (slip.type === "SINGLE") {
    const single = previewSelections[0];
    const rawOddsCheck: OddsCheckResult | null = reconstructedByIndex.get(0)?.oddsCheck ?? null;
    const providerTokenFields = buildProviderTokenFields(rawOddsCheck, requests[0]?.selection);

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
        ...providerTokenFields,
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
        selections: previewSelections.map((selection, index) => {
          const legOddsCheck = reconstructedByIndex.get(index)?.oddsCheck ?? null;
          const providerTokenFields = buildProviderTokenFields(legOddsCheck, requests[index]?.selection);

          return {
            sport: selection.sport,
            event: selection.event,
            outcome: selection.selection,
            market: selection.market,
            submittedOdds:
              selection.submittedOdds !== null ? new Prisma.Decimal(selection.submittedOdds).toString() : null,
            currentOdds: selection.currentOdds !== null ? new Prisma.Decimal(selection.currentOdds).toString() : null,
            oddsStatus: selection.oddsStatus,
            ...providerTokenFields,
          };
        }),
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
