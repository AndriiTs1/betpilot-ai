import { Prisma } from "@/lib/generated/prisma/client";
import type { BetSelectionOddsStatus } from "@/lib/generated/prisma/client";
import type { ParsedBetSlip, PendingMarketReconciliation } from "@/lib/bets/betSlip";
import { validateBetSlipType, BetSlipValidationError } from "@/lib/bets/betSlipRules";
import { computeTotalOdds, computePotentialWin } from "@/lib/bets/expressMath";
import { mapOddsCheckToSelectionStatus } from "@/lib/odds/mapOddsStatus";
import type { verifyOdds } from "@/lib/odds/oddsVerifier";
import { TheOddsApiProvider } from "@/lib/odds/theOddsApiProvider";
import { OddsVerificationService } from "@/lib/odds/oddsVerificationService";
import type { VerifySelectionRequest } from "@/lib/odds/oddsProvider";
import type { CanonicalSelection, MarketType } from "@/lib/odds/domain";
import {
  legacySelectionToCanonicalRequest,
  verificationResultToLegacyOddsCheck,
  type ReconstructedOddsCheck,
} from "@/lib/odds/legacyOddsBridge";
import { resolveParticipantSide } from "@/lib/odds/teamNameMatcher";
import { normalizeSelectionTextForCanonicalization } from "@/lib/ai/ocrParticipantClaimNormalizer";
import { signPreviewToken, signExpressPreviewToken } from "@/lib/betPreview/previewToken";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import { logScreenshotPipelineEvent } from "@/lib/logging/structuredLog";
import { logScreenshotQa1Diagnostic } from "@/lib/logging/screenshotQa1Diagnostic";
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
  // Betting Markets V1, Phase 3.3 — the numeric line for a TOTALS selection
  // (e.g. "2.5"), when one was stated. Sourced from the same canonical
  // request the odds check itself was verified against (requests[index]'s
  // CanonicalSelection.line), not from the odds-check response — a
  // player's requested line is part of what they asked for, shown
  // regardless of whether verification succeeded. null for MONEYLINE/DRAW
  // and for a Totals selection that stated no line at all.
  line: string | null;
  // Handicap Stage H2 — the same canonical request's marketType/participant
  // (requests[index].selection.marketType / .participant.name), sourced
  // identically to `line` above. Display-only: lets a formatter render a
  // SPREAD selection from its canonical participant+line (e.g. "Arsenal
  // -1.5") instead of the raw AI text in `selection` (e.g. "Arsenal F1").
  // null for any market that has no participant (e.g. MONEYLINE/TOTALS) or
  // when verification never resolved one.
  marketType: MarketType | null;
  participant: string | null;
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
  // Betting Markets V1, Phase 2 — sourced from canonicalSelection.line (the
  // pre-verification REQUEST), exactly like canonicalMarketType/
  // canonicalSelectionType/canonicalParticipant/canonicalPeriod above —
  // never from oddsCheck (the response): a line is part of what the player
  // asked for, not something the provider resolves, so it belongs with the
  // other canonical-request fields, not the provider-event-metadata ones
  // (homeTeamName/awayTeamName/competitionName below, which genuinely only
  // become known once the provider matches an event).
  canonicalLine: string | null;
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
  canonicalLine: null,
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
    canonicalLine: canonicalSelection.line ?? null,
    homeTeamName: oddsCheck.homeTeamName ?? null,
    awayTeamName: oddsCheck.awayTeamName ?? null,
    competitionName: oddsCheck.competitionName ?? null,
  };
}

// SCREENSHOT QA-1.6 — the ONE place a pendingMarketReconciliation
// (lib/bets/betSlip.ts) is ever turned into an accept/reject decision. This
// is the nearest point in the pipeline that has real, provider-resolved
// event identity (oddsCheck.homeTeamName/awayTeamName — never the raw OCR/
// player event string, never guessed from word order). Reuses
// resolveParticipantSide (lib/odds/teamNameMatcher.ts) completely
// unmodified — the exact same deterministic fuzzy-name-matching primitive
// lib/bets/settlement/evaluateSelectionOutcome.ts already relies on in
// production for the identical "does this participant name mean home or
// away" question, just asked here at preview time instead of settlement
// time.
//
// Returns the CORRECTED CanonicalSelection (marketType MONEYLINE_3WAY,
// selectionType HOME/AWAY, no participant — the real 1X2 shape, never an
// accidental generic MONEYLINE_2WAY/PARTICIPANT reading left in place) on
// success, or null on any failure to reconcile — never partially applies a
// correction. Null causes the caller to reject the whole preview; this
// function itself never rejects/throws, staying a pure decision function
// like every other verifier in this codebase.
//
// Never reached for DRAW evidence — betParser.ts's own
// classifyReconcilable1X2Mismatch only ever produces a pendingMarketReconciliation
// for HOME/AWAY evidence, exactly because a claimed participant name has no
// DRAW equivalent (SCREENSHOT QA-1.5's own semantic analysis).
function reconcile1X2ParticipantClaim(
  original: CanonicalSelection,
  pending: PendingMarketReconciliation,
  oddsCheck: OddsCheckResult | null,
): CanonicalSelection | null {
  if (!oddsCheck || !oddsCheck.homeTeamName || !oddsCheck.awayTeamName) return null;

  const resolution = resolveParticipantSide(pending.claimedParticipant, oddsCheck.homeTeamName, oddsCheck.awayTeamName);
  // HOME evidence + resolves AWAY -> reject, UNLESS the M3.2 override below
  // applies. AWAY evidence + resolves HOME -> same. NO_MATCH -> always
  // reject (never HOME/AWAY, so the override below can never apply either).
  // AMBIGUOUS (matches both/neither decisively) -> always reject, same
  // reason. An exact match to the side the original text evidence actually
  // asserted always reconciles, same as before this stage.
  if (resolution.kind === pending.requiredSide) {
    return { ...original, marketType: "MONEYLINE_3WAY", selectionType: pending.requiredSide, participant: undefined };
  }

  // MASTER STAGE M3.2 — a decisive, provider-confirmed participant match
  // outranks a conflicting UNATTRIBUTED bare 1X2 shorthand marker. Proven
  // real production case: claim "Alavés" resolves decisively to HOME
  // against the real provider event (exact string match), but a bare OCR
  // marker with no participant name of its own (MONEYLINE_3WAY/AWAY,
  // participantName: null — plausibly an unselected sibling outcome
  // button's own UI text, not a deliberate statement) disagreed, and the
  // claim was wrongly rejected. This override applies ONLY when:
  //   1. resolution.kind is a clean HOME or AWAY (never AMBIGUOUS/NO_MATCH
  //      — those can never reach this branch at all, since neither value
  //      is ever === pending.requiredSide, so they fall through to `return
  //      null` below exactly as before this stage);
  //   2. pending.conflictingParticipantName is explicitly null — i.e. the
  //      conflicting evidence that produced requiredSide genuinely named no
  //      participant of its own (see betSlip.ts's own header for why
  //      `undefined`, from any caller built before this field existed,
  //      deliberately does NOT satisfy this check — the conservative,
  //      pre-M3.2 reject-on-mismatch behavior is what those callers get).
  // A conflicting entry that DID name a different participant (a real,
  // named disagreement) still rejects unconditionally, regardless of how
  // decisively the claim itself resolves — this override only ever
  // discounts UI noise, never a genuine competing statement.
  if ((resolution.kind === "HOME" || resolution.kind === "AWAY") && pending.conflictingParticipantName === null) {
    return { ...original, marketType: "MONEYLINE_3WAY", selectionType: resolution.kind, participant: undefined };
  }

  return null;
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
  // SCREENSHOT QA-2.1 — off by default, so every existing caller (text
  // preview/confirm, dashboard debug preview) gets byte-for-byte the same
  // behavior and logging as before this option existed. Only the screenshot
  // preview route opts in, keeping [SCREENSHOT_QA1_DIAGNOSTIC] output
  // scoped to screenshot requests, matching its own name/existing
  // convention (every other stage is likewise only ever logged from
  // app/api/miniapp/bets/screenshot/preview/route.ts). Side-effect-only
  // when true — see the call site below; never changes which branch
  // executes or what reconcile1X2ParticipantClaim itself decides.
  logQa1ReconciliationDiagnostic?: boolean;
}

// MASTER STAGE M3, Phase 3 — `slip` is the project's canonical BetIntent
// (see lib/bets/betSlip.ts's BetIntent alias): everything below this point
// consumes already-extracted, already-validated intent fields
// (event/market/selection/line/stake), never raw OCR/bookmaker wording or
// button text directly. Any future UI-noise/wording concern belongs
// upstream of this boundary (betParser.ts + lib/ai/screenshotUiNoise.ts),
// not here.
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
        // SCREENSHOT ODDS QA-2 — this is the ACTUAL provider-facing search
        // text (legacySelectionToCanonicalRequest classifies it and, for a
        // bare participant fallback, sends it straight to the odds
        // provider's own team-name matching) — a completely different
        // consumer than the human-readable `selection.selection` shown
        // elsewhere in this file's own preview/token output, which stays
        // untouched. A screenshot's raw display text can carry the same
        // shorthand-plus-participant pollution SCREENSHOT QA-CORE S1 already
        // fixed for reconciliation (e.g. "Bayern Win (П1)") — proven, via
        // this exact production event, to ALSO defeat provider matching:
        // legacySelectionToCanonicalRequest's own knownParticipantNames
        // prefix-stripping only fires on an EXACT prefix match, which
        // "Bayern Win (П1)" fails the same way it fails reconciliation.
        // Deliberately the NARROWER normalizeSelectionTextForCanonicalization
        // (not the full normalizeOcrParticipantClaim S1 uses for
        // reconciliation) — see that function's own header for the real
        // regression reusing the full one caused here (stripping a trailing
        // "Win" suffix before classification, which weakens
        // classifyBettingSelectionTextWithMarketHint's own market-hint-
        // override-resistance). Safe to apply unconditionally (not
        // mode-gated, unlike S1's own call site in betParser.ts): idempotent
        // on already-clean text, so a typed-chat selection — essentially
        // never polluted with 1X2 shorthand — passes through unchanged.
        selection: normalizeSelectionTextForCanonicalization(selection.selection),
        submittedOdds: selection.submittedOdds,
        // Betting Markets V1, Phase 2 — threaded through to
        // CanonicalSelection.line so it survives into the signed preview
        // token (canonicalLine) and, eventually, persistence. Not read by
        // any matching/verification logic yet.
        line: selection.line ?? null,
        // H3 Production Fix — threaded through so legacySelectionToCanonicalRequest
        // can recover market intent a bare `selection` alone can't express
        // (e.g. "Фора"/"Handicap"/"Spread") — see that function's own
        // comment for the exact, narrow rule this only ever applies under.
        marketRawText: selection.marketRawText ?? null,
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

    // SCREENSHOT QA-1.6 — the request already went to the odds provider
    // with the original (uncorrected) MONEYLINE_2WAY/PARTICIPANT shape
    // above (a bare participant name always resolves against the
    // provider's own real outcome names via fuzzy team-name matching —
    // lib/odds/theOddsApiProvider.ts's selectionToLegacyText — so pricing
    // itself was never blocked by this). Now that oddsCheck may carry the
    // provider's real homeTeamName/awayTeamName, this is the first point
    // able to finish the ONE deferred decision betParser.ts staged. Mutates
    // requests[index] in place so every existing downstream read of it
    // (below, and buildProviderTokenFields further down) automatically
    // picks up the correction with no other code changes.
    if (selection.pendingMarketReconciliation) {
      const original = requests[index]?.selection;
      const reconciled = original
        ? reconcile1X2ParticipantClaim(original, selection.pendingMarketReconciliation, oddsCheck)
        : null;

      // SCREENSHOT QA-2.1 — diagnostic-only, gated behind
      // options.logQa1ReconciliationDiagnostic (screenshot preview only —
      // see BuildBetSlipPreviewOptions above). resolutionKind is computed by
      // an independent, second call to the exact same pure
      // resolveParticipantSide() reconcile1X2ParticipantClaim already called
      // above with the exact same inputs, so it can only ever report the
      // same outcome that already happened — it never feeds back into
      // `reconciled` or any other decision. Mirrors
      // recognizeBetSlipScreenshot.ts's own summarizeRegionOutcome()
      // convention (SCREENSHOT QA-1.1): read-only, side-effect-only, purely
      // for observability.
      if (options.logQa1ReconciliationDiagnostic) {
        const resolutionKind =
          oddsCheck?.homeTeamName && oddsCheck?.awayTeamName
            ? resolveParticipantSide(
                selection.pendingMarketReconciliation.claimedParticipant,
                oddsCheck.homeTeamName,
                oddsCheck.awayTeamName,
              ).kind
            : null;

        logScreenshotQa1Diagnostic({
          stage: "reconciliation",
          claimedParticipant: selection.pendingMarketReconciliation.claimedParticipant,
          requiredSide: selection.pendingMarketReconciliation.requiredSide,
          marketTypeBefore: original?.marketType ?? null,
          selectionTypeBefore: original?.selectionType ?? null,
          oddsCheckMatched: oddsCheck?.matched ?? false,
          providerEventIdPresent: oddsCheck?.providerEventId !== undefined,
          homeTeamName: oddsCheck?.homeTeamName ?? null,
          awayTeamName: oddsCheck?.awayTeamName ?? null,
          resolutionKind,
          reconciled: reconciled !== null,
        });
      }

      if (!reconciled) {
        throw new BetSlipValidationError(
          "MARKET_INTENT_UNRECONCILED",
          `Could not reconcile a MONEYLINE_2WAY/PARTICIPANT claim against real event participants for selection ${index}`,
        );
      }

      requests[index] = { ...requests[index], selection: reconciled };
    }

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
    // never free text), a purely positional index, and (Stage M4.4) the
    // internal diagnosticCode (another fixed, enum-like token, e.g.
    // "LEGACY_SPREAD_LINE_NOT_AVAILABLE" — see OddsCheckResult's own doc
    // comment) are logged, never the selection's own content.
    if (oddsCheck && !oddsCheck.matched) {
      logScreenshotPipelineEvent("odds_check_not_matched", {
        selectionIndex: index,
        oddsVerificationStatus: mapOddsCheckToSelectionStatus(oddsCheck),
        failureCode: oddsCheck.reasonCode,
        diagnosticCode: oddsCheck.diagnosticCode,
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
      line: requests[index]?.selection.line ?? null,
      marketType: requests[index]?.selection.marketType ?? null,
      participant: requests[index]?.selection.participant?.name ?? null,
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

  // SCREENSHOT ODDS QA-2 — totalOdds/potentialWin are the ACTIONABLE numbers
  // a player commits to; they must be computed from the provider's own
  // CURRENT, VERIFIED price for every leg, never from whatever a player (or
  // a screenshot's OCR'd number) merely submitted. Before this stage, this
  // computation read previewSelections[i].submittedOdds — the EFFECTIVE
  // submitted value (Step 15I), which for a screenshot bet is almost always
  // non-null (OCR usually reads a visible odds figure) and therefore always
  // won regardless of whether the provider ever actually verified it. A
  // player/screenshot's stated odds is reference-only; only a leg whose
  // odds check actually matched contributes an effective price here — an
  // unmatched leg (NOT_FOUND/UNAVAILABLE) contributes none at all, making
  // the whole bet's totalOdds/potentialWin null (not silently computed from
  // an unverified number), exactly the same "any missing leg -> null total"
  // shape this already had for a genuinely-unknown submittedOdds, just keyed
  // on verification instead of submission. VERIFIED and ODDS_CHANGED both
  // count (both have oddsCheck.matched === true and a real sourceOdds — a
  // moved price is still today's real, actionable price; ODDS_CHANGED only
  // ever gates CONFIRM-time reconfirmation, never PREVIEW-time display).
  const effectiveVerifiedOdds: Array<number | null> = slip.selections.map((_selection, index) => {
    const oddsCheck = reconstructedByIndex.get(index)?.oddsCheck ?? null;
    return oddsCheck?.matched === true && oddsCheck.sourceOdds !== null ? oddsCheck.sourceOdds : null;
  });
  const allOddsKnown = effectiveVerifiedOdds.every((odds) => odds !== null);

  // Kept as a Decimal (not re-derived from the number a second time below)
  // so the EXPRESS branch's stake string comes from the exact same
  // instance already used for potentialWin's math, not a fresh conversion.
  const stakeDecimal = new Prisma.Decimal(slip.stake);

  let totalOdds: Prisma.Decimal | null = null;
  let potentialWin: Prisma.Decimal | null = null;

  if (allOddsKnown) {
    totalOdds = computeTotalOdds(effectiveVerifiedOdds.map((odds) => new Prisma.Decimal(odds!)));
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
        // Stage M4.8 — the confirmation acceptance baseline: BetPilot's own
        // current price, exactly what the "Odds" row shows the player (see
        // components/miniapp/BetPreviewCard.tsx's formatSingleOdds, which
        // reads this same field). Never `single.submittedOdds` above (the
        // player's own screenshot/typed reference number) — see
        // PreviewTokenPayload.acceptedOdds's own comment for why conflating
        // the two broke reconfirmation.
        acceptedOdds: single.currentOdds,
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
  } else if (slip.type === "EXPRESS") {
    // Sector 1 correction (ADR-0002) — a signed EXPRESS token is now
    // produced whenever the slip itself is structurally valid (2-10
    // selections, already enforced by validateBetSlipType above),
    // regardless of whether totalOdds/potentialWin could be computed.
    // `previewToken exists` (a safe, signed reference to this exact set of
    // legs — what lib/bets/buildExpressLegExclusionPreview.ts needs) and
    // `bet can be confirmed` (decided independently by each selection's own
    // oddsStatus — canConfirmBetSlip.ts/verifyPreviewFreshness.ts/
    // createBetFromPreview.ts's own EXPRESS_INVALID_DECIMAL guard) are
    // deliberately different questions; this branch only ever answers the
    // first one. Before this correction, one NOT_FOUND/UNAVAILABLE leg made
    // allOddsKnown false, which kept previewToken null for the WHOLE slip —
    // the exact condition that made Sector 1's exclusion endpoint
    // structurally unreachable in its own target scenario (see ADR-0002's
    // Sector 1 practical-QA finding).
    //
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
        totalOdds: totalOdds !== null ? totalOdds.toString() : null,
        potentialWin: potentialWin !== null ? potentialWin.toString() : null,
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
