// Step 5 — TheOddsApiProvider: an OddsProvider-shaped compatibility wrapper
// around the existing, UNCHANGED lib/odds/oddsVerifier.ts. See
// docs/ODDS_PROVIDER_DESIGN.md Section 18 Phase C for the migration
// rationale: this file translates the legacy OddsCheckResult into the new
// VerificationResult without duplicating or rewriting oddsVerifier.ts's
// matching algorithm — every actual verification decision (event matching,
// team-name fuzzy scoring, 1X2 classification) still happens inside
// verifyOdds() itself, exactly as it does today.
//
// No production caller imports this file yet (Step 5 scope) — see
// docs/ODDS_PROVIDER_DESIGN.md Section 18 Phase E for when
// buildBetSlipPreview.ts is expected to start depending on this instead of
// calling verifyOdds() directly.

import {
  verifyOdds,
  verifyTotalsOdds,
  verifySpreadOdds,
  type OddsVerificationInput,
  type TotalsVerificationInput,
  type SpreadVerificationInput,
} from "./oddsVerifier";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import { validateCanonicalSelection, type CanonicalParticipant, type CanonicalSelection, type Sport } from "./domain";
import { resolveFootballLeague } from "./footballLeagues";
import {
  createFailedResult,
  createOddsChangedResult,
  createVerifiedResult,
  type VerificationReasonCode,
  type VerificationResult,
} from "./verification";
import type {
  FindEventsRequest,
  GetEventMarketsRequest,
  OddsProvider,
  OddsProviderCapabilities,
  ProviderEventCandidate,
  ProviderHealthResult,
  ProviderName,
  ProviderOutcome,
  ProviderResult,
  VerifySelectionRequest,
} from "./oddsProvider";

const PROVIDER_NAME: ProviderName = "THE_ODDS_API";

/* -------------------------------------------------------------------------- */
/* Stage 3.1 — matchedEvent/matchedOutcome construction                       */
/* -------------------------------------------------------------------------- */
//
// Both helpers below read exclusively from data this adapter already has
// honestly: legacyResult's new Stage 3.1 fields (oddsVerifier.ts's own
// all-or-nothing provider event metadata — see that file's
// extractProviderEventMetadata) for matchedEvent, and the already-validated
// CanonicalSelection the caller constructed BEFORE this request was ever
// sent to the provider (never provider response data) for matchedOutcome's
// market/selection classification. Neither helper invents an outcome ID —
// The Odds API's h2h outcomes carry no stable id/key of their own (only a
// display `name` and a `price`), so ProviderOutcome.outcomeReference is
// deliberately left unset here, never synthesized from outcome.name, a team
// name, the market key, an array index, or a hash of any of those.

function buildMatchedEvent(legacyResult: OddsCheckResult, selection: CanonicalSelection): ProviderEventCandidate | undefined {
  if (!legacyResult.providerEventId || !legacyResult.providerSportKey) return undefined;

  // Prefer the provider's OWN team names/competition (oddsVerifier.ts's
  // extractProviderEventMetadata) over the player's pre-verification typed
  // text (selection.event.name/participants) — this is what lets a
  // single-team query like "Arsenal" surface the full resolved event
  // ("Arsenal — Coventry City", "Premier League") downstream, instead of
  // only ever repeating back whatever the player happened to type. Falls
  // back to the pre-verification text when the provider names are somehow
  // absent (should not happen — extractProviderEventMetadata is
  // all-or-nothing alongside providerEventId/providerSportKey — but this
  // keeps the pre-existing behavior as a safe default rather than crashing).
  const hasProviderTeamNames = Boolean(legacyResult.homeTeamName && legacyResult.awayTeamName);

  return {
    event: {
      sport: selection.sport,
      league: legacyResult.competitionName ? { name: legacyResult.competitionName } : selection.league,
      name: hasProviderTeamNames
        ? `${legacyResult.homeTeamName} — ${legacyResult.awayTeamName}`
        : selection.event.name,
      participants: hasProviderTeamNames
        ? [{ name: legacyResult.homeTeamName! }, { name: legacyResult.awayTeamName! }]
        : selection.event.participants,
      homeParticipantIndex: hasProviderTeamNames ? 0 : selection.event.homeParticipantIndex,
      awayParticipantIndex: hasProviderTeamNames ? 1 : selection.event.awayParticipantIndex,
      startTime: legacyResult.eventStartTime,
      period: selection.period,
    },
    reference: {
      provider: PROVIDER_NAME,
      eventId: legacyResult.providerEventId,
      sportKey: legacyResult.providerSportKey,
    },
  };
}

// Only constructed once a real bookmaker price was actually found
// (legacyResult.sourceOdds !== null) — the "event found but selection/
// bookmaker not matched" failure paths have no price to report an outcome
// for, and naturally produce undefined here (sourceOdds stays null on
// those paths too).
function buildMatchedOutcome(legacyResult: OddsCheckResult, selection: CanonicalSelection): ProviderOutcome | undefined {
  if (legacyResult.sourceOdds === null || legacyResult.sourceOdds === undefined) return undefined;

  // Betting Markets V1, Phase 3.3 — the only market keys this adapter ever
  // actually requests (oddsVerifier.ts's verifyOdds()/verifyTotalsOdds()
  // hardcode "h2h"/"totals" respectively) — not synthesized, not guessed.
  // Handicap Stage H1 — verifySpreadOdds() hardcodes "spreads" the same way.
  const marketKey = selection.marketType === "TOTALS" ? "totals" : selection.marketType === "SPREAD" ? "spreads" : "h2h";

  return {
    marketType: selection.marketType,
    period: selection.period,
    selectionType: selection.selectionType,
    participant: selection.participant,
    // line is only ever meaningful for TOTALS/SPREAD — the request-side
    // canonicalLine (already exact-match-verified against the provider's
    // own point by findTotalsOutcome/findSpreadOutcome), never re-derived
    // from the response.
    line: selection.marketType === "TOTALS" || selection.marketType === "SPREAD" ? selection.line : undefined,
    currentOdds: String(legacyResult.sourceOdds),
    bookmaker: legacyResult.bookmaker ?? undefined,
    marketReference: { provider: PROVIDER_NAME, marketKey },
    // outcomeReference deliberately omitted — see this section's header
    // comment.
  };
}

/* -------------------------------------------------------------------------- */
/* Capabilities — CURRENT adapter reality only, never the future MVP target   */
/* -------------------------------------------------------------------------- */

// Every field here is backed by a specific, cited line in oddsVerifier.ts —
// re-verified fresh against the current file while writing this adapter,
// not carried over from the Support Matrix's target-state tables. Do not
// add totals/spreads/BTTS/double-chance or additional leagues here without
// oddsVerifier.ts itself actually supporting them.
const CAPABILITIES: OddsProviderCapabilities = {
  provider: PROVIDER_NAME,
  supportedSports: ["FOOTBALL", "BASKETBALL", "TENNIS", "ICE_HOCKEY", "AMERICAN_FOOTBALL"],
  // Betting Markets V1, Phase 3.3 — TOTALS joins MONEYLINE_2WAY/3WAY, but
  // ONLY for football (see the sport gate in verifySelection() below) —
  // oddsVerifier.ts's verifyTotalsOdds() has only ever been built/tested
  // against football fixtures this phase; Team Totals remain fully out of
  // scope.
  // Handicap Stage H1 — SPREAD joins the set, for every currently supported
  // sport (unlike TOTALS, nothing in findSpreadOutcome()/verifySpreadOdds()
  // is football-specific — event resolution and outcome lookup are both
  // fully sport-generic, so no analogous sport gate was needed or added).
  // H4-B5 — the H1-era "standard whole/half lines only" restriction is
  // removed: any exact decimal line (standard or Asian quarter,
  // ±0.25/±0.75/±1.25/±1.75) is now routed to real verification.
  // findSpreadOutcome() only ever matches an EXACT canonical line — never
  // rounds, substitutes, or picks a nearest neighbor — so an unavailable
  // exact quarter line still fails safely (SELECTION_NOT_FOUND), it is
  // simply no longer rejected up front purely for being a quarter line.
  supportedMarketTypes: ["MONEYLINE_2WAY", "MONEYLINE_3WAY", "TOTALS", "SPREAD"],
  // Step 16A — true as of this step: a stated, supported football league
  // (lib/odds/footballLeagues.ts) now actually routes the request to that
  // league's own sport_key, and an unsupported one is honestly reported as
  // LEAGUE_NOT_SUPPORTED rather than silently substituted (see
  // resolveFootballSportResolution below).
  leagueSelectionSupported: true,
  livePrematchSupport: "PREMATCH_ONLY",
  eventSearchSupported: false,
  eventByIdLookupSupported: false,
  regions: ["eu"], // oddsVerifier.ts:406 hardcodes `regions=eu`
  notes: [
    "Generic football/soccer with no stated league now merges across every currently supported competition (lib/odds/footballLeagues.ts / oddsVerifier.ts SPORT_KEY_ALIASES), not only the English Premier League. A football selection whose league is one of the supported names (or a recognized alias, e.g. EPL/UCL) resolves to that league's own sport_key alone; an unrecognized league returns LEAGUE_NOT_SUPPORTED rather than querying an unrelated competition.",
    "Tennis coverage is limited to the four Grand Slam tournaments, in-tournament only (oddsVerifier.ts TENNIS_SPORT_KEYS) — no year-round ATP/WTA tour coverage.",
    "1X2/moneyline selections are verifiable for every supported sport; TOTALS (Over/Under) is verifiable for football only (Betting Markets V1, Phase 3.3); SPREAD (handicap) is verifiable for every supported sport, including exact Asian quarter lines (±0.25/±0.75/±1.25/±1.75) as of Handicap Stage H4-B5 — both-teams-to-score, double-chance, and team-totals markets remain out of scope. Quarter-line SPREAD bets can become confirmable, but automatic settlement remains deferred for every SPREAD bet regardless (see lib/bets/settlement/autoSettleSingleBet.ts).",
    "findEvents() and getEventMarkets() are not implemented by this adapter in Step 5 — verifySelection() is the only operational method (see its own code comment below).",
  ],
};

/* -------------------------------------------------------------------------- */
/* Canonical -> legacy request translation                                    */
/* -------------------------------------------------------------------------- */

// oddsVerifier.ts's SPORT_KEY_ALIASES recognizes these exact free-text
// strings (case-insensitive) — chosen to be the shortest alias for each
// sport that already exists in that table today. Deliberately excludes
// UNKNOWN: a selection with sport UNKNOWN never reaches verifyOdds() (see
// verifySelection() below) — "UNKNOWN must never mean VERIFIED"
// (docs/ODDS_PROVIDER_DESIGN.md Section 3).
const SPORT_TO_LEGACY_STRING: Readonly<Record<Exclude<Sport, "UNKNOWN">, string>> = {
  FOOTBALL: "football",
  BASKETBALL: "basketball",
  TENNIS: "tennis",
  ICE_HOCKEY: "hockey",
  AMERICAN_FOOTBALL: "american football",
};

// Step 16A — replaces the old Step 7A FOOTBALL_LEAGUE_TO_LEGACY_STRING
// table (now lib/odds/footballLeagues.ts's single centralized alias
// table, shared with legacyOddsBridge.ts's legacyFootballLeagueFromSportString
// — never a second, independently-maintained list) with an explicit
// three-way result: a supported league resolves to exactly its own legacy
// sport string (queried alone); no league at all falls back to the
// generic "football" default, which oddsVerifier.ts's own SPORT_KEY_ALIASES
// now merges across every supported competition (Step 16A) instead of only
// Premier League; an explicitly stated but UNRECOGNIZED league is reported
// honestly rather than silently substituted with an unrelated competition
// — the exact behavior change Step 16A requires (previously this silently
// fell back to generic "football"/EPL).
type FootballSportResolution =
  | { readonly kind: "NO_LEAGUE" }
  | { readonly kind: "SUPPORTED"; readonly legacySport: string }
  | { readonly kind: "UNSUPPORTED_LEAGUE" };

// Only ever consulted when selection.sport === "FOOTBALL" — every other
// sport preserves today's exact SPORT_TO_LEGACY_STRING behavior,
// completely untouched by this function.
function resolveFootballSportResolution(leagueName: string | undefined): FootballSportResolution {
  if (!leagueName) return { kind: "NO_LEAGUE" };
  const resolved = resolveFootballLeague(leagueName);
  if (!resolved) return { kind: "UNSUPPORTED_LEAGUE" };
  return { kind: "SUPPORTED", legacySport: resolved.legacySportString };
}

// Only the tokens oddsVerifier.ts's classifySingleSelection/fuzzy matching
// actually recognizes. HOME/AWAY/DRAW map to the exact literal tokens in
// oddsVerifier.ts's FIRST_TEAM_TOKENS/DRAW_TOKENS/SECOND_TEAM_TOKENS sets
// ("home", "draw", "away" are each members of those sets). PARTICIPANT
// falls through to oddsVerifier.ts's fuzzy team-name matching, exactly as
// a real team name typed by a player would. Every other SelectionType
// (OVER/UNDER/YES/NO/HOME_OR_DRAW/DRAW_OR_AWAY/HOME_OR_AWAY) has no legacy
// equivalent — never reached here because verifySelection() rejects those
// market/selection combinations before this function is called.
function selectionToLegacyText(selection: CanonicalSelection): string | null {
  switch (selection.selectionType) {
    case "HOME":
      return "home";
    case "AWAY":
      return "away";
    case "DRAW":
      return "draw";
    case "PARTICIPANT":
      return selection.participant?.name?.trim() || null;
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Legacy failure note -> VerificationReasonCode classification               */
/* -------------------------------------------------------------------------- */
//
// oddsVerifier.ts's OddsCheckResult has no structured reason field — only a
// free-text `note` (Step 2 audit's confirmed limitation, formalized in
// docs/ODDS_PROVIDER_DESIGN.md Section 3's VerificationReasonCode design).
// This function is a best-effort, DOCUMENTED, TESTED classification of the
// small, fully-enumerated set of note templates the current file actually
// produces (verified by reading oddsVerifier.ts in full while writing this
// adapter — every `return { ...baseResult, note: ... }` site is listed
// below).
//
// The "request failed with status N" template now safely embeds the HTTP
// status and (when present) the provider's own short `error_code` string —
// e.g. "...status 401 (OUT_OF_USAGE_CREDITS)" — parsed here to distinguish
// quota exhaustion / auth failure / rate limiting from a generic failure.
// oddsVerifier.ts's fetchOddsForSport is the only place this template is
// constructed; it never embeds the raw provider response body, only that
// one short field, so parsing it here is not the "fabricated reliability
// from unstructured text" docs/ODDS_PROVIDER_DESIGN.md Section 9 warns
// against — the status and error_code are the provider's own structured
// signal, just relayed through a string boundary. PROVIDER_RATE_LIMITED is
// reachable via this path (HTTP 429).
function classifyLegacyFailureNote(
  note: string,
): { reasonCode: Exclude<VerificationReasonCode, "NONE">; diagnosticCode: string } {
  if (/^Sport\/league ".*" is not mapped to a The Odds API sport_key$/.test(note)) {
    return { reasonCode: "SPORT_NOT_SUPPORTED", diagnosticCode: "LEGACY_SPORT_UNMAPPED" };
  }
  if (/^The Odds API request timed out after \d+ms$/.test(note)) {
    return { reasonCode: "PROVIDER_TIMEOUT", diagnosticCode: "LEGACY_FETCH_TIMEOUT" };
  }
  if (note === "ODDS_API_KEY is not configured") {
    return { reasonCode: "PROVIDER_UNAVAILABLE", diagnosticCode: "LEGACY_FETCH_API_KEY_MISSING" };
  }
  if (note === "Unexpected response shape from The Odds API") {
    return { reasonCode: "PROVIDER_INVALID_RESPONSE", diagnosticCode: "LEGACY_FETCH_INVALID_RESPONSE" };
  }
  const statusMatch = note.match(/^The Odds API request failed with status (\d+)(?: \(([A-Z0-9_]+)\))?$/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    const providerErrorCode = statusMatch[2] ?? null;

    if (status === 401 && providerErrorCode === "OUT_OF_USAGE_CREDITS") {
      return { reasonCode: "PROVIDER_QUOTA_EXCEEDED", diagnosticCode: "LEGACY_QUOTA_EXCEEDED" };
    }
    // Any other 401 (missing key, invalid key, revoked key, ...) — the
    // provider's exact error_code for these varies and isn't guaranteed
    // stable across cases, so every non-quota 401 is classified as an auth
    // failure rather than pattern-matching individual key-error codes.
    if (status === 401) {
      return { reasonCode: "PROVIDER_AUTH_FAILED", diagnosticCode: "LEGACY_AUTH_FAILED" };
    }
    if (status === 429) {
      return { reasonCode: "PROVIDER_RATE_LIMITED", diagnosticCode: "LEGACY_RATE_LIMITED" };
    }
    return { reasonCode: "PROVIDER_UNAVAILABLE", diagnosticCode: "LEGACY_FETCH_FAILED" };
  }
  if (note === "Unknown error calling The Odds API") {
    return { reasonCode: "PROVIDER_UNAVAILABLE", diagnosticCode: "LEGACY_FETCH_UNKNOWN_ERROR" };
  }
  if (/^No matching event found for /.test(note)) {
    return { reasonCode: "EVENT_NOT_FOUND", diagnosticCode: "LEGACY_EVENT_NOT_FOUND" };
  }
  // Step 16A — two or more genuinely DIFFERENT events (distinct provider
  // IDs, e.g. from different merged competitions) scored an equally
  // confident match — oddsVerifier.ts's findMatchingEvent() never silently
  // picks one by array/league order in this case (see that function's own
  // comment).
  if (/^Ambiguous event match for /.test(note)) {
    return { reasonCode: "AMBIGUOUS_EVENT", diagnosticCode: "LEGACY_AMBIGUOUS_EVENT" };
  }
  // Event was found but has no bookmaker/odds data at all — SELECTION_NOT_FOUND
  // is an imperfect fit (the event itself WAS found), but it is the
  // narrowest honest code in the approved enum: there is nothing to select
  // from, which is a degenerate case of "the outcome wasn't found."
  if (/^No bookmaker odds available for /.test(note)) {
    return { reasonCode: "SELECTION_NOT_FOUND", diagnosticCode: "LEGACY_NO_BOOKMAKER_ODDS" };
  }
  if (/^Could not match selection /.test(note)) {
    return { reasonCode: "SELECTION_NOT_FOUND", diagnosticCode: "LEGACY_SELECTION_NOT_FOUND" };
  }
  // Betting Markets V1, Phase 3.3 — verifyTotalsOdds()'s own note template,
  // covering every findTotalsOutcome() non-match kind (MARKET_ABSENT/
  // OUTCOME_ABSENT/LINE_NOT_AVAILABLE/MISSING_POINT/MALFORMED_POINT/
  // NO_BOOKMAKER/INVALID_REQUESTED_LINE — see that function's own doc
  // comments). All classify to the same SELECTION_NOT_FOUND family as
  // h2h's own "market/event were found, the specific outcome wasn't" cases
  // above — the captured kind is preserved only in diagnosticCode, for
  // operator-visible precision, never in the public reasonCode surface.
  const totalsMatch = note.match(/^Could not match totals selection ".*" for ".*" \(([A-Z_]+)\)$/);
  if (totalsMatch) {
    return { reasonCode: "SELECTION_NOT_FOUND", diagnosticCode: `LEGACY_TOTALS_${totalsMatch[1]}` };
  }
  // Handicap Stage H1 — verifySpreadOdds()'s own note template, covering
  // every findSpreadOutcome() non-match kind (INVALID_REQUESTED_LINE/
  // NO_BOOKMAKER/MARKET_ABSENT/PARTICIPANT_NOT_FOUND/MISSING_POINT/
  // MALFORMED_POINT/LINE_NOT_AVAILABLE). Same SELECTION_NOT_FOUND family as
  // h2h/totals' own "market/event were found, the specific outcome wasn't"
  // cases — the captured kind is preserved only in diagnosticCode.
  const spreadMatch = note.match(/^Could not match spread selection ".*" for ".*" \(([A-Z_]+)\)$/);
  if (spreadMatch) {
    return { reasonCode: "SELECTION_NOT_FOUND", diagnosticCode: `LEGACY_SPREAD_${spreadMatch[1]}` };
  }

  // Defensive fallback only — every note template oddsVerifier.ts can
  // currently produce is enumerated above (confirmed by a full read of the
  // file while writing this adapter). This branch exists so a future,
  // unexpected change to oddsVerifier.ts's note text degrades to a
  // conservative, blocking, non-coverage-claiming reason rather than
  // silently mismapping to something more permissive.
  return { reasonCode: "PROVIDER_UNAVAILABLE", diagnosticCode: "LEGACY_UNCLASSIFIED_FAILURE" };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class TheOddsApiProvider implements OddsProvider {
  readonly name: ProviderName = PROVIDER_NAME;

  // Dependency-injected so adapter tests are deterministic without mocking
  // module internals or making real network calls — defaults to the real,
  // unmodified verifyOdds() in production (no caller in this step passes
  // an override; see the constructor's own default parameter).
  // Betting Markets V1, Phase 3.3 — verifyTotalsOddsFn added as a second,
  // independently-injectable seam (purely additive: every existing
  // single-argument `new TheOddsApiProvider(fn)` call site keeps compiling
  // and behaving unchanged, since this is a new parameter with its own
  // default, not a change to the first one).
  // Handicap Stage H1 — verifySpreadOddsFn added the same way, as a third
  // independently-injectable seam.
  //
  // H4-B5 — the H3.1-era 4th DI seam (resolveSpreadEventMetadataFn) is
  // removed here: it existed only to give the old H1 quarter-line capability
  // gate a way to resolve a real event without ever reaching price lookup.
  // Now that the gate itself is gone (see verifySelection() below), every
  // SPREAD line — standard or quarter — resolves its event the same way,
  // inside verifySpreadOddsFn itself, exactly like it always has for
  // standard lines. No replacement seam is needed.
  constructor(
    private readonly verifyOddsFn: typeof verifyOdds = verifyOdds,
    private readonly verifyTotalsOddsFn: typeof verifyTotalsOdds = verifyTotalsOdds,
    private readonly verifySpreadOddsFn: typeof verifySpreadOdds = verifySpreadOdds,
  ) {}

  getCapabilities(): OddsProviderCapabilities {
    return CAPABILITIES;
  }

  // Not implemented in Step 5 — oddsVerifier.ts has no exported primitive
  // for "just find candidate events" (fetchOddsForSport/findMatchingEvent
  // are private, unexported functions). Duplicating that private matching
  // logic here to fake this method, or modifying oddsVerifier.ts to export
  // it, are both out of scope for Step 5 (see this file's own header
  // comment and docs/ODDS_PROVIDER_DESIGN.md Section 6's note that "The
  // Odds API has no dedicated event-search endpoint" even conceptually).
  // verifySelection() remains the only operational method this adapter
  // offers today.
  async findEvents(_request: FindEventsRequest): Promise<ProviderResult<readonly ProviderEventCandidate[]>> {
    return {
      ok: false,
      reasonCode: "PROVIDER_UNAVAILABLE",
      retryable: false,
      message:
        "TheOddsApiProvider.findEvents() is not implemented in Step 5 — oddsVerifier.ts exposes no standalone event-discovery primitive without duplicating its private matching logic. Use verifySelection() instead.",
    };
  }

  // Same rationale as findEvents() above.
  async getEventMarkets(_request: GetEventMarketsRequest): Promise<ProviderResult<readonly ProviderOutcome[]>> {
    return {
      ok: false,
      reasonCode: "PROVIDER_UNAVAILABLE",
      retryable: false,
      message:
        "TheOddsApiProvider.getEventMarkets() is not implemented in Step 5 — oddsVerifier.ts exposes no standalone market-retrieval primitive without duplicating its private fetch/parse logic. Use verifySelection() instead.",
    };
  }

  // Configuration-readiness check only, NOT a live provider connectivity
  // check — named accurately per docs/ODDS_PROVIDER_DESIGN.md Section 10's
  // "name the behavior accurately." Makes no network request, so it is
  // safe to call from any test without stubbing fetch.
  async healthCheck(): Promise<ProviderHealthResult> {
    const checkedAt = new Date().toISOString();
    const configured = Boolean(process.env.ODDS_API_KEY);

    if (!configured) {
      return {
        healthy: false,
        provider: PROVIDER_NAME,
        checkedAt,
        latencyMs: 0,
        reasonCode: "PROVIDER_UNAVAILABLE",
        diagnosticCode: "MISSING_API_KEY",
      };
    }

    return { healthy: true, provider: PROVIDER_NAME, checkedAt, latencyMs: 0 };
  }

  async verifySelection(request: VerifySelectionRequest): Promise<VerificationResult> {
    const { selection } = request;
    const submittedOdds = request.submittedOdds ?? selection.submittedOdds ?? null;
    const checkedAtFor = () => new Date().toISOString();

    // Step 15H — a null submittedOdds no longer stops event/market/
    // selection/bookmaker/price lookup here. It used to return
    // NOT_CHECKED immediately (see this file's git history); that early
    // return is removed so a selection with no submitted price still
    // reaches the nullable-aware verifyOddsFn below, which is the sole
    // place (Step 15G) a provider price may ever be promoted into
    // submittedOdds. This adapter itself never invents a price.

    const structural = validateCanonicalSelection(selection);
    if (!structural.ok) {
      return createFailedResult({
        submittedOdds,
        provider: PROVIDER_NAME,
        checkedAt: checkedAtFor(),
        reasonCode: "INVALID_INPUT",
        diagnosticCode: "STRUCTURAL_VALIDATION_FAILED",
      });
    }

    // Betting Markets V1, Phase 3.3 — TOTALS joins the two MONEYLINE
    // variants. Handicap Stage H1 — SPREAD joins them too.
    if (
      selection.marketType !== "MONEYLINE_2WAY" &&
      selection.marketType !== "MONEYLINE_3WAY" &&
      selection.marketType !== "TOTALS" &&
      selection.marketType !== "SPREAD"
    ) {
      return createFailedResult({
        submittedOdds,
        provider: PROVIDER_NAME,
        checkedAt: checkedAtFor(),
        reasonCode: "MARKET_NOT_SUPPORTED",
        diagnosticCode: "ADAPTER_MARKET_NOT_SUPPORTED",
      });
    }

    if (selection.sport === "UNKNOWN") {
      return createFailedResult({
        submittedOdds,
        provider: PROVIDER_NAME,
        checkedAt: checkedAtFor(),
        reasonCode: "SPORT_NOT_SUPPORTED",
        diagnosticCode: "ADAPTER_SPORT_UNKNOWN",
      });
    }

    // Betting Markets V1, Phase 3.3 — TOTALS is football-only this phase
    // (CAPABILITIES.supportedMarketTypes above documents this same
    // restriction). Checked before the football-specific league resolution
    // below so a non-football TOTALS selection never has to wait on that
    // logic to be honestly rejected.
    if (selection.marketType === "TOTALS" && selection.sport !== "FOOTBALL") {
      return createFailedResult({
        submittedOdds,
        provider: PROVIDER_NAME,
        checkedAt: checkedAtFor(),
        reasonCode: "MARKET_NOT_SUPPORTED",
        diagnosticCode: "ADAPTER_TOTALS_FOOTBALL_ONLY",
      });
    }

    // FOOTBALL alone consults selection.league — every other sport takes
    // the exact, unchanged path it always has.
    const footballResolution =
      selection.sport === "FOOTBALL" ? resolveFootballSportResolution(selection.league?.name) : null;

    // Step 16A — an explicitly stated but unrecognized league is reported
    // honestly and immediately, before any provider call — never silently
    // substituted with an unrelated competition (the previous, deliberately
    // changed behavior).
    if (footballResolution?.kind === "UNSUPPORTED_LEAGUE") {
      return createFailedResult({
        submittedOdds,
        provider: PROVIDER_NAME,
        checkedAt: checkedAtFor(),
        reasonCode: "LEAGUE_NOT_SUPPORTED",
        diagnosticCode: "ADAPTER_LEAGUE_NOT_SUPPORTED",
      });
    }

    const legacySport =
      footballResolution === null
        ? SPORT_TO_LEGACY_STRING[selection.sport]
        : footballResolution.kind === "SUPPORTED"
          ? footballResolution.legacySport
          : SPORT_TO_LEGACY_STRING.FOOTBALL;

    // Step 15H — this format/positivity check only applies when a value was
    // actually submitted; there is nothing to validate the shape of when
    // nothing was given. submittedOddsNumber stays null in that case and is
    // passed straight through to the nullable-aware verifyOddsFn below.
    let submittedOddsNumber: number | null = null;
    if (submittedOdds !== null) {
      submittedOddsNumber = Number(submittedOdds);
      if (!Number.isFinite(submittedOddsNumber) || submittedOddsNumber <= 0) {
        return createFailedResult({
          submittedOdds,
          provider: PROVIDER_NAME,
          checkedAt: checkedAtFor(),
          reasonCode: "INVALID_INPUT",
          diagnosticCode: "SUBMITTED_ODDS_NOT_A_POSITIVE_DECIMAL",
        });
      }
    }

    const legacyEvent = selection.event.name.trim();
    if (legacyEvent.length === 0) {
      return createFailedResult({
        submittedOdds,
        provider: PROVIDER_NAME,
        checkedAt: checkedAtFor(),
        reasonCode: "INVALID_INPUT",
        diagnosticCode: "EVENT_NAME_EMPTY",
      });
    }

    // H4-B5 — the old Handicap Stage H1 quarter-line capability gate lived
    // here (rejecting ±0.25/±0.75/±1.25/±1.75 as MARKET_NOT_SUPPORTED,
    // diagnosticCode ADAPTER_SPREAD_QUARTER_LINE_UNSUPPORTED_H1, with only
    // event-only resolution via resolveSpreadEventMetadataFn). Removed now
    // that persistence (H4-B1), the settlement evaluator (H4-B2), and the
    // internal settlement primitive (H4-B3) all have real support for a
    // quarter-line outcome — findSpreadOutcome()/verifySpreadOdds() (below)
    // already handled arbitrary exact decimal lines with zero restriction;
    // this gate was the ONLY thing preventing a quarter-line SPREAD
    // selection from reaching them. Every SPREAD line, standard or quarter,
    // now takes the exact same path below — no separate quarter-line
    // routing, no second verifier, no rounding/nearest-line substitution
    // (findSpreadOutcome's own exact canonical-string equality already
    // guarantees that). Auto-settlement remains independently blocked for
    // SPREAD regardless (lib/bets/settlement/autoSettleSingleBet.ts's own
    // SPREAD_AUTO_SETTLEMENT_DEFERRED guard, untouched by this stage) — a
    // quarter-line bet becoming VERIFIED/confirmable here does not make it
    // auto-settleable.

    let legacyResult: OddsCheckResult;

    if (selection.marketType === "TOTALS") {
      // selectionType is guaranteed "OVER"/"UNDER" and line is guaranteed a
      // present, decimal-shaped string here — validateCanonicalSelection's
      // own TOTALS rule (selectionType must be OVER/UNDER, line required)
      // already ran above and would have returned INVALID_INPUT otherwise.
      const totalsInput: TotalsVerificationInput = {
        sport: legacySport,
        event: legacyEvent,
        direction: selection.selectionType as "OVER" | "UNDER",
        line: selection.line as string,
        odds: submittedOddsNumber,
      };
      legacyResult = await this.verifyTotalsOddsFn(totalsInput);
    } else if (selection.marketType === "SPREAD") {
      // participant and line are both guaranteed present here —
      // validateCanonicalSelection's own SPREAD rule already ran above and
      // would have returned INVALID_INPUT otherwise. H4-B5 — any exact
      // decimal line, standard or quarter, reaches verifySpreadOddsFn the
      // same way; findSpreadOutcome() itself decides match/no-match via
      // exact canonical-string equality, never a grid restriction here.
      const spreadInput: SpreadVerificationInput = {
        sport: legacySport,
        event: legacyEvent,
        participant: (selection.participant as CanonicalParticipant).name,
        line: selection.line as string,
        odds: submittedOddsNumber,
      };
      legacyResult = await this.verifySpreadOddsFn(spreadInput);
    } else {
      const legacySelection = selectionToLegacyText(selection);
      if (!legacySelection) {
        return createFailedResult({
          submittedOdds,
          provider: PROVIDER_NAME,
          checkedAt: checkedAtFor(),
          reasonCode: "MARKET_NOT_SUPPORTED",
          diagnosticCode: "ADAPTER_SELECTION_TYPE_NOT_SUPPORTED",
        });
      }

      const legacyInput: OddsVerificationInput = {
        sport: legacySport,
        event: legacyEvent,
        selection: legacySelection,
        odds: submittedOddsNumber,
      };

      legacyResult = await this.verifyOddsFn(legacyInput);
    }
    const checkedAt = checkedAtFor();

    // Bookmaker is passed through whenever the legacy result actually
    // provided one — including the "could not match selection" failure
    // case, where oddsVerifier.ts still returns the bookmaker it found the
    // event under (oddsVerifier.ts:494-497). This is honest pass-through
    // of data the legacy verifier already returned, not fabrication.
    const bookmaker = legacyResult.bookmaker ?? undefined;

    // Step 15H — the submittedOdds reported from this point on. For a real
    // player-submitted value, this is the exact original request string,
    // completely unchanged (never round-tripped through Number/String,
    // which could otherwise reformat e.g. "2.10" -> "2.1" and change this
    // adapter's existing output). For a null-input lookup, this is
    // whichever value verifyOddsFn (Step 15G) actually returned: the
    // provider's found price when promotion succeeded, or still null when
    // nothing could be promoted (failed lookup) — never fabricated here.
    const effectiveSubmittedOdds: string | null =
      submittedOdds !== null
        ? submittedOdds
        : legacyResult.submittedOdds !== null
          ? String(legacyResult.submittedOdds)
          : null;

    // Stage 3.1 — undefined whenever oddsVerifier.ts never resolved a
    // trustworthy provider event (EVENT_NOT_FOUND/AMBIGUOUS_EVENT/coverage
    // failures never set legacyResult.providerEventId at all) — see
    // buildMatchedEvent's own null-check. Computed once, reused across
    // every branch below (VERIFIED/ODDS_CHANGED/FAILED-with-event-found
    // alike), since it depends only on legacyResult/selection, not on which
    // branch is taken.
    const matchedEvent = buildMatchedEvent(legacyResult, selection);

    if (legacyResult.matched) {
      const currentOdds = String(legacyResult.sourceOdds);
      const differencePercentage =
        legacyResult.discrepancyPercent !== null ? String(legacyResult.discrepancyPercent) : null;
      const matchedOutcome = buildMatchedOutcome(legacyResult, selection);

      if (legacyResult.withinTolerance === true) {
        return createVerifiedResult({
          submittedOdds: effectiveSubmittedOdds,
          currentOdds,
          differencePercentage,
          provider: PROVIDER_NAME,
          bookmaker,
          checkedAt,
          matchedEvent,
          matchedOutcome,
        });
      }

      return createOddsChangedResult({
        submittedOdds: effectiveSubmittedOdds,
        currentOdds,
        differencePercentage,
        provider: PROVIDER_NAME,
        bookmaker,
        checkedAt,
        matchedEvent,
        matchedOutcome,
      });
    }

    // matched === false — legacy has no structured reason, only `note`.
    // legacyResult.note is guaranteed non-null on every matched:false
    // return path in oddsVerifier.ts (confirmed by reading the full file);
    // the `?? ""` is defensive only, in case that guarantee is ever
    // violated by a future change to that file.
    const { reasonCode, diagnosticCode } = classifyLegacyFailureNote(legacyResult.note ?? "");

    return createFailedResult({
      submittedOdds: effectiveSubmittedOdds,
      provider: PROVIDER_NAME,
      checkedAt,
      reasonCode,
      diagnosticCode,
      bookmaker,
      // Present exactly for the two failure reasons where oddsVerifier.ts
      // found the event before matching then failed (SELECTION_NOT_FOUND —
      // "no bookmaker odds"/"could not match selection"); undefined for
      // every coverage/matching failure where no event was ever resolved
      // (EVENT_NOT_FOUND, AMBIGUOUS_EVENT, SPORT_NOT_SUPPORTED, etc.) —
      // buildMatchedEvent's own check already encodes this distinction, no
      // separate branch on reasonCode needed here.
      matchedEvent,
    });
  }
}
