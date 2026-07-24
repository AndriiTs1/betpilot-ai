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

import { verifyOdds, type OddsVerificationInput } from "./oddsVerifier";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import { validateCanonicalSelection, type CanonicalSelection, type Sport } from "./domain";
import {
  createFailedResult,
  createNotCheckedResult,
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
  // h2h/moneyline only — oddsVerifier.ts:406 hardcodes `markets=h2h`;
  // oddsVerifier.ts:330 only ever reads the "h2h" market key.
  supportedMarketTypes: ["MONEYLINE_2WAY", "MONEYLINE_3WAY"],
  leagueSelectionSupported: false,
  livePrematchSupport: "PREMATCH_ONLY",
  eventSearchSupported: false,
  eventByIdLookupSupported: false,
  regions: ["eu"], // oddsVerifier.ts:406 hardcodes `regions=eu`
  notes: [
    "Generic football/soccer with no recognized league resolves to the English Premier League only (oddsVerifier.ts SPORT_KEY_ALIASES). A football selection whose league is exactly one of La Liga/Serie A/Bundesliga/Ligue 1/UEFA Champions League/Premier League (see resolveLegacyFootballSport below) resolves to that league's own sport_key instead — any other or absent league still falls back to the generic EPL default.",
    "Tennis coverage is limited to the four Grand Slam tournaments, in-tournament only (oddsVerifier.ts TENNIS_SPORT_KEYS) — no year-round ATP/WTA tour coverage.",
    "Only bare 1X2/moneyline selections are verifiable — no totals, spreads, both-teams-to-score, or double-chance markets.",
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

// Step 7A compatibility fix — restores the five pre-existing football-
// league-specific legacy sport strings oddsVerifier.ts's own
// SPORT_KEY_ALIASES already resolves to distinct sport_keys ("la liga" ->
// soccer_spain_la_liga, "serie a" -> soccer_italy_serie_a, "bundesliga" ->
// soccer_germany_bundesliga, "ligue 1" -> soccer_france_ligue_one,
// "champions league" -> soccer_uefa_champs_league), plus "premier league"
// (which already resolves to the same soccer_epl the generic default
// does, but is represented honestly rather than silently substituted).
// These were reachable directly through legacy verifyOdds() before the
// Step 7 migration collapsed every football league into the generic
// "football" default. Closed, exact lookup only (trim + lowercase +
// whitespace-normalize) — never fuzzy or substring matching, and never
// extended beyond these six names (no Europa League, no international
// competitions, no other domestic leagues — see
// docs/ODDS_SUPPORT_MATRIX.md). No sport_key value is ever stored or
// returned here — only the same human-readable legacy alias string
// oddsVerifier.ts's own SPORT_KEY_ALIASES table already accepts; that
// file remains the sole owner of sport_key resolution. Kept private to
// this adapter — the canonical domain (CanonicalLeague) stays
// provider-neutral and knows nothing about legacy alias strings.
const FOOTBALL_LEAGUE_TO_LEGACY_STRING: Readonly<Record<string, string>> = {
  "la liga": "la liga",
  "serie a": "serie a",
  bundesliga: "bundesliga",
  "ligue 1": "ligue 1",
  "champions league": "champions league",
  "uefa champions league": "champions league",
  "premier league": "premier league",
};

function normalizeLeagueName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Only ever consulted when selection.sport === "FOOTBALL" — every other
// sport preserves today's exact SPORT_TO_LEGACY_STRING behavior,
// completely untouched by this function. An absent or unrecognized league
// falls back to the same generic "football" default that has always
// applied — this function only ever narrows behavior for the six
// explicitly recognized names, never broadens it.
function resolveLegacyFootballSport(leagueName: string | undefined): string {
  if (!leagueName) return SPORT_TO_LEGACY_STRING.FOOTBALL;
  return FOOTBALL_LEAGUE_TO_LEGACY_STRING[normalizeLeagueName(leagueName)] ?? SPORT_TO_LEGACY_STRING.FOOTBALL;
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
// below). It intentionally does NOT try to parse embedded HTTP status
// codes out of the "request failed with status N" template to distinguish
// PROVIDER_RATE_LIMITED from a generic failure — that message was written
// for human logs, not as a structured contract, and parsing it further
// would be exactly the kind of fabricated reliability
// docs/ODDS_PROVIDER_DESIGN.md Section 9's "narrowest honest generic
// reason" instruction warns against. PROVIDER_RATE_LIMITED is therefore
// unreachable from this adapter today — reserved for a future stage where
// oddsVerifier.ts (or its eventual replacement) exposes the HTTP status
// structurally instead of as embedded text.
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
  if (/^The Odds API request failed with status \d+/.test(note)) {
    return { reasonCode: "PROVIDER_UNAVAILABLE", diagnosticCode: "LEGACY_FETCH_FAILED" };
  }
  if (note === "Unknown error calling The Odds API") {
    return { reasonCode: "PROVIDER_UNAVAILABLE", diagnosticCode: "LEGACY_FETCH_UNKNOWN_ERROR" };
  }
  if (/^No matching event found for /.test(note)) {
    return { reasonCode: "EVENT_NOT_FOUND", diagnosticCode: "LEGACY_EVENT_NOT_FOUND" };
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
  constructor(private readonly verifyOddsFn: typeof verifyOdds = verifyOdds) {}

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

    if (submittedOdds === null) {
      return createNotCheckedResult({ submittedOdds: null, provider: PROVIDER_NAME, checkedAt: checkedAtFor() });
    }

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

    if (selection.marketType !== "MONEYLINE_2WAY" && selection.marketType !== "MONEYLINE_3WAY") {
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

    // FOOTBALL alone consults selection.league (Step 7A) — every other
    // sport takes the exact, unchanged path it always has.
    const legacySport =
      selection.sport === "FOOTBALL"
        ? resolveLegacyFootballSport(selection.league?.name)
        : SPORT_TO_LEGACY_STRING[selection.sport];

    const submittedOddsNumber = Number(submittedOdds);
    if (!Number.isFinite(submittedOddsNumber) || submittedOddsNumber <= 0) {
      return createFailedResult({
        submittedOdds,
        provider: PROVIDER_NAME,
        checkedAt: checkedAtFor(),
        reasonCode: "INVALID_INPUT",
        diagnosticCode: "SUBMITTED_ODDS_NOT_A_POSITIVE_DECIMAL",
      });
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

    const legacyResult: OddsCheckResult = await this.verifyOddsFn(legacyInput);
    const checkedAt = checkedAtFor();

    // Bookmaker is passed through whenever the legacy result actually
    // provided one — including the "could not match selection" failure
    // case, where oddsVerifier.ts still returns the bookmaker it found the
    // event under (oddsVerifier.ts:494-497). This is honest pass-through
    // of data the legacy verifier already returned, not fabrication.
    const bookmaker = legacyResult.bookmaker ?? undefined;

    if (legacyResult.matched) {
      const currentOdds = String(legacyResult.sourceOdds);
      const differencePercentage =
        legacyResult.discrepancyPercent !== null ? String(legacyResult.discrepancyPercent) : null;

      if (legacyResult.withinTolerance === true) {
        return createVerifiedResult({
          submittedOdds,
          currentOdds,
          differencePercentage,
          provider: PROVIDER_NAME,
          bookmaker,
          checkedAt,
        });
      }

      return createOddsChangedResult({
        submittedOdds,
        currentOdds,
        differencePercentage,
        provider: PROVIDER_NAME,
        bookmaker,
        checkedAt,
      });
    }

    // matched === false — legacy has no structured reason, only `note`.
    // legacyResult.note is guaranteed non-null on every matched:false
    // return path in oddsVerifier.ts (confirmed by reading the full file);
    // the `?? ""` is defensive only, in case that guarantee is ever
    // violated by a future change to that file.
    const { reasonCode, diagnosticCode } = classifyLegacyFailureNote(legacyResult.note ?? "");

    return createFailedResult({
      submittedOdds,
      provider: PROVIDER_NAME,
      checkedAt,
      reasonCode,
      diagnosticCode,
      bookmaker,
    });
  }
}
