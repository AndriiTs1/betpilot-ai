// Step 7 — pure, directly-testable translation functions between the
// legacy free-text bet-slip shape (lib/bets/betSlip.ts's
// BetSlipSelectionInput, and legacy verifyOdds()'s OddsCheckResult) and the
// canonical, provider-neutral domain (lib/odds/domain.ts,
// lib/odds/oddsProvider.ts, lib/odds/verification.ts).
//
// This file has no side effects and calls no provider — it exists purely
// so lib/bets/buildBetSlipPreview.ts's orchestration logic can stay a thin,
// reviewable diff (see docs/ODDS_PROVIDER_DESIGN.md Section 18 Phase E).
//
// Only MONEYLINE_2WAY/MONEYLINE_3WAY are ever produced here — the current
// legacy pipeline only ever verifies match-winner/moneyline selections
// (lib/odds/oddsVerifier.ts requests `markets=h2h` exclusively); this
// bridge does not, and must not, extend into Totals, Spread, BTTS, Double
// Chance, Team Totals, or player props (docs/ODDS_SUPPORT_MATRIX.md
// Section 5 — those remain deferred until a later step).

import type { CanonicalEvent, CanonicalLeague, CanonicalParticipant, Sport } from "./domain";
import type { VerifySelectionRequest } from "./oddsProvider";
import type { VerificationResult } from "./verification";
import type { OddsCheckResult } from "@/types/oddsSnapshot";

/* -------------------------------------------------------------------------- */
/* Legacy sport string -> canonical Sport                                     */
/* -------------------------------------------------------------------------- */

// Mirrors the KEYS of oddsVerifier.ts's private SPORT_KEY_ALIASES table
// (not its VALUES or matching behavior — that stays entirely inside
// TheOddsApiProvider/oddsVerifier.ts, never duplicated here). Canonical
// Sport itself has no slot for "which specific football league" — every
// football-league-specific key below (la liga, serie a, bundesliga,
// ligue 1, champions league, premier league) still collapses to the
// single FOOTBALL bucket here. That distinction is NOT lost, though: it
// is captured separately by legacyFootballLeagueFromSportString() below
// and carried on CanonicalSelection.league/CanonicalEvent.league, which
// TheOddsApiProvider's resolveLegacyFootballSport() (Step 7A) reads to
// restore the exact pre-migration legacy sport string for these six
// names — see legacyOddsBridge.test.ts's request-mapping tests for the
// full round-trip proof.
const LEGACY_SPORT_TO_CANONICAL: Readonly<Record<string, Sport>> = {
  football: "FOOTBALL",
  soccer: "FOOTBALL",
  футбол: "FOOTBALL",
  "premier league": "FOOTBALL",
  "la liga": "FOOTBALL",
  "serie a": "FOOTBALL",
  bundesliga: "FOOTBALL",
  "ligue 1": "FOOTBALL",
  "champions league": "FOOTBALL",
  basketball: "BASKETBALL",
  баскетбол: "BASKETBALL",
  nba: "BASKETBALL",
  "american football": "AMERICAN_FOOTBALL",
  nfl: "AMERICAN_FOOTBALL",
  hockey: "ICE_HOCKEY",
  "ice hockey": "ICE_HOCKEY",
  хоккей: "ICE_HOCKEY",
  nhl: "ICE_HOCKEY",
  tennis: "TENNIS",
  теннис: "TENNIS",
  atp: "TENNIS",
  wta: "TENNIS",
};

export function legacySportToCanonical(sport: string): Sport {
  return LEGACY_SPORT_TO_CANONICAL[sport.toLowerCase().trim()] ?? "UNKNOWN";
}

// Honest CanonicalLeague population for the six football-league-specific
// legacy sport strings — closed, exact lookup only (no fuzzy/substring
// matching), and never extended beyond what oddsVerifier.ts's own
// SPORT_KEY_ALIASES already recognizes as a distinct sport_key (or, for
// "premier league", the same sport_key the generic default already
// resolves to, represented honestly rather than silently substituted).
// Generic football aliases (football/soccer/футбол) are deliberately
// absent from this table — they fabricate no league. No sport_key or
// other provider-specific value ever appears here; this is purely a
// human-readable league NAME, matching what CanonicalLeague already
// exists to hold (lib/odds/domain.ts).
const FOOTBALL_LEAGUE_NAMES: Readonly<Record<string, CanonicalLeague>> = {
  "la liga": { name: "La Liga" },
  "serie a": { name: "Serie A" },
  bundesliga: { name: "Bundesliga" },
  "ligue 1": { name: "Ligue 1" },
  "champions league": { name: "UEFA Champions League" },
  "uefa champions league": { name: "UEFA Champions League" },
  "premier league": { name: "Premier League" },
};

export function legacyFootballLeagueFromSportString(sport: string): CanonicalLeague | undefined {
  return FOOTBALL_LEAGUE_NAMES[sport.toLowerCase().trim().replace(/\s+/g, " ")];
}

/* -------------------------------------------------------------------------- */
/* Legacy selection text -> canonical market/selection classification         */
/* -------------------------------------------------------------------------- */

interface ClassifiedSelection {
  readonly marketType: "MONEYLINE_2WAY" | "MONEYLINE_3WAY";
  readonly selectionType: "HOME" | "DRAW" | "AWAY" | "PARTICIPANT";
  readonly participant?: CanonicalParticipant;
}

// Same closed token set oddsVerifier.ts's private classifySingleSelection
// recognizes (FIRST_TEAM_TOKENS/DRAW_TOKENS/SECOND_TEAM_TOKENS) — chosen
// so a "1"/"X"/"2"/"П1"/etc. selection is classified structurally honestly
// as HOME/DRAW/AWAY rather than opaque PARTICIPANT text. This choice does
// not change legacy behavior even if it were skipped entirely:
// TheOddsApiProvider's selectionToLegacyText() re-expands HOME/DRAW/AWAY
// into the literal strings "home"/"draw"/"away", which are THEMSELVES
// members of oddsVerifier.ts's own recognized token sets — so either path
// reaches the identical legacy classification. Anything not in these three
// sets (full team names, "Over 2.5", OCR garbage, anything) falls back to
// PARTICIPANT with the ORIGINAL, UNMODIFIED text preserved as the
// participant name — TheOddsApiProvider passes that name straight through
// as the legacy `selection` string, so this fallback is a lossless,
// byte-for-byte-equivalent pass-through of exactly what legacy receives
// today, not an interpretation of what the text means.
const HOME_TOKENS: ReadonlySet<string> = new Set(["1", "п1", "p1", "home"]);
const DRAW_TOKENS: ReadonlySet<string> = new Set(["x", "х", "draw", "ничья"]);
const AWAY_TOKENS: ReadonlySet<string> = new Set(["2", "п2", "p2", "away"]);

export function legacySelectionTextToCanonical(raw: string): ClassifiedSelection {
  const key = raw.trim().toLowerCase();
  if (HOME_TOKENS.has(key)) return { marketType: "MONEYLINE_3WAY", selectionType: "HOME" };
  if (DRAW_TOKENS.has(key)) return { marketType: "MONEYLINE_3WAY", selectionType: "DRAW" };
  if (AWAY_TOKENS.has(key)) return { marketType: "MONEYLINE_3WAY", selectionType: "AWAY" };
  return { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT", participant: { name: raw } };
}

/* -------------------------------------------------------------------------- */
/* Legacy event string -> CanonicalEvent                                      */
/* -------------------------------------------------------------------------- */

// Mirrors (does not import) the same small, stable separator vocabulary
// oddsVerifier.ts's own private, unexported EVENT_SEPARATOR_REGEX
// recognizes ("vs"/"v"/"-"/"–"/"—"). This is a plain string split — no
// scoring, no team-name normalization, no comparison against provider
// data — so reproducing the separator convention does not duplicate any
// part of oddsVerifier.ts's actual event-matching algorithm, which stays
// exclusively inside that file.
const EVENT_SEPARATOR_REGEX = /\s+(?:vs\.?|v\.?|-|–|—)\s+/i;

function legacyEventToCanonical(sport: Sport, eventName: string, league: CanonicalLeague | undefined): CanonicalEvent {
  const parts = eventName
    .split(EVENT_SEPARATOR_REGEX)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 2) {
    // Ordered exactly as parsed — NOT asserting which participant is the
    // provider's "home" team. Legacy's own event matching tolerates BOTH
    // orientations precisely because a parsed event string never reliably
    // says which team is home; asserting homeParticipantIndex here would
    // itself be a fabrication, not an honest representation (see
    // docs/ODDS_PROVIDER_DESIGN.md Section 4's "unsafe to guess").
    return {
      sport,
      league,
      name: eventName,
      participants: [{ name: parts[0] }, { name: parts[1] }],
      period: "FULL_GAME",
    };
  }

  // Cannot be split into exactly two participants — reported here as a
  // genuine limitation (empty participants) rather than fabricating a
  // single participant whose "name" would actually be the whole,
  // multi-team event string. TheOddsApiProvider.verifySelection() does not
  // read CanonicalEvent.participants at all today (confirmed by a full
  // read of that file) — this has zero effect on verification — but this
  // bridge's canonical output must stay honest independent of what the
  // current adapter happens to ignore, not merely valid because it does.
  return {
    sport,
    league,
    name: eventName,
    participants: [],
    period: "FULL_GAME",
  };
}

/* -------------------------------------------------------------------------- */
/* Legacy request -> VerifySelectionRequest                                   */
/* -------------------------------------------------------------------------- */

// The narrower shape buildBetSlipPreview.ts actually has in hand once it
// has already filtered out selections with no submitted odds — deliberately
// not the full (nullable-odds) BetSlipSelectionInput, so this function's
// contract never has to decide what "no odds" means; that decision stays
// with the caller, exactly like today.
export interface LegacyVerifiableSelection {
  readonly sport: string;
  readonly event: string;
  readonly selection: string;
  readonly submittedOdds: number;
}

// league/provider IDs/acceptedOdds/currentOdds are never set here — league
// is not fabricated (legacy has no league concept at all); provider
// references don't exist yet at request time; acceptedOdds/currentOdds are
// verification OUTPUTS, never request inputs.
export function legacySelectionToCanonicalRequest(selection: LegacyVerifiableSelection): VerifySelectionRequest {
  const sport = legacySportToCanonical(selection.sport);
  // Only ever non-undefined when selection.sport is one of the six
  // recognized football-league names — legacyFootballLeagueFromSportString
  // returns undefined for every generic/non-football/unrecognized string,
  // so this never fabricates a league (see that function's own comment).
  const league = legacyFootballLeagueFromSportString(selection.sport);
  const event = legacyEventToCanonical(sport, selection.event, league);
  const classified = legacySelectionTextToCanonical(selection.selection);

  return {
    context: "PREVIEW",
    selection: {
      sport,
      league,
      event,
      marketType: classified.marketType,
      period: "FULL_GAME",
      selectionType: classified.selectionType,
      participant: classified.participant,
      submittedOdds: String(selection.submittedOdds),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* VerificationResult -> legacy OddsCheckResult                               */
/* -------------------------------------------------------------------------- */

export interface ReconstructedOddsCheck {
  readonly oddsCheck: OddsCheckResult | null;
  // True only when this VerificationResult came from
  // OddsVerificationService's own unexpected-exception catch (its fixed,
  // stable diagnosticCode "ODDS_PROVIDER_UNEXPECTED_ERROR" —
  // lib/odds/oddsVerificationService.ts — is the only reliable signal for
  // this, since the service is a protected file this step must not
  // modify). Distinguishes "the injected verifyOddsFn threw" (today: a
  // rejected Promise.allSettled entry -> oddsCheck stays null -> UNAVAILABLE,
  // plus an "odds_check_rejected" log) from a normal, RETURNED legacy
  // failure (today: a matched:false OddsCheckResult -> NOT_FOUND, plus an
  // "odds_check_not_matched" log) — oddsVerifier.ts's real verifyOdds()
  // never throws (confirmed by a full read of that file), so this
  // distinction only ever matters for test fakes that simulate a
  // provider crash by throwing, exactly as several existing
  // buildBetSlipPreview.test.ts fixtures already do.
  readonly wasExceptionMapped: boolean;
}

const UNEXPECTED_ERROR_DIAGNOSTIC_CODE = "ODDS_PROVIDER_UNEXPECTED_ERROR";

export function verificationResultToLegacyOddsCheck(
  result: VerificationResult,
  submittedOdds: number,
): ReconstructedOddsCheck {
  if (result.status === "FAILED" && result.diagnosticCode === UNEXPECTED_ERROR_DIAGNOSTIC_CODE) {
    return { oddsCheck: null, wasExceptionMapped: true };
  }

  switch (result.status) {
    case "VERIFIED":
    case "ODDS_CHANGED":
      return {
        oddsCheck: {
          matched: true,
          withinTolerance: result.status === "VERIFIED",
          sourceOdds: result.currentOdds !== null ? Number(result.currentOdds) : null,
          submittedOdds,
          discrepancyPercent: result.differencePercentage !== null ? Number(result.differencePercentage) : null,
          bookmaker: result.bookmaker ?? null,
          // legacy's `note` is fetched-but-never-read by any downstream
          // consumer (buildBetSlipPreview.ts, mapOddsStatus.ts, and every
          // previewToken shape all read only matched/withinTolerance/
          // sourceOdds/bookmaker/discrepancyPercent/submittedOdds —
          // confirmed by a full audit of every `.note` access site during
          // this step) — safe to always reconstruct as null.
          note: null,
        },
        wasExceptionMapped: false,
      };
    case "FAILED":
    case "NOT_CHECKED":
      return {
        oddsCheck: {
          matched: false,
          withinTolerance: null,
          sourceOdds: null,
          submittedOdds,
          discrepancyPercent: null,
          bookmaker: result.bookmaker ?? null,
          note: null,
        },
        wasExceptionMapped: false,
      };
  }
}
