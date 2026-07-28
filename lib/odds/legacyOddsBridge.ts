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
import { resolveFootballLeague } from "./footballLeagues";

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
// matching), backed by lib/odds/footballLeagues.ts's single centralized
// alias table (Step 16A) rather than a second, independently-maintained
// one. Generic football aliases (football/soccer/футбол) are deliberately
// absent from that table — they fabricate no league. No sport_key or other
// provider-specific value ever appears here; this is purely a
// human-readable league NAME, matching what CanonicalLeague already exists
// to hold (lib/odds/domain.ts).
export function legacyFootballLeagueFromSportString(sport: string): CanonicalLeague | undefined {
  const resolved = resolveFootballLeague(sport);
  return resolved ? { name: resolved.displayName } : undefined;
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

// Step 16A — natural winner phrases ("Inter Win", "Inter to win", "Inter
// wins", "Home win", "away team wins", ...). Only a recognized TRAILING
// winner-intent suffix is ever stripped, anchored to the end of the string
// via `$` and requiring a preceding word boundary/whitespace — so a real
// participant name that merely contains a similar-looking substring with
// no actual separating space before it (there is no realistic team name
// this could misfire on; the anchor makes that structurally true, not just
// empirically) is never damaged, and the strip never fires more than once
// per selection. This never hardcodes any team/club name — it recognizes
// only the phrasing pattern, exactly like HOME/DRAW/AWAY_TOKENS above.
const WINNER_SUFFIX_REGEX = /\s+(?:to\s+win|wins|win)$/i;

// "home"/"home team" and "away"/"away team" — recognized only AFTER a
// winner suffix was actually stripped (a bare "home"/"away" is already
// handled by HOME_TOKENS/AWAY_TOKENS above); this only extends recognition
// to the "<side> team wins" phrasing, never a different token set.
const HOME_TEAM_PHRASES: ReadonlySet<string> = new Set(["home", "home team"]);
const AWAY_TEAM_PHRASES: ReadonlySet<string> = new Set(["away", "away team"]);

export function legacySelectionTextToCanonical(raw: string): ClassifiedSelection {
  const trimmed = raw.trim();
  const key = trimmed.toLowerCase();
  if (HOME_TOKENS.has(key)) return { marketType: "MONEYLINE_3WAY", selectionType: "HOME" };
  if (DRAW_TOKENS.has(key)) return { marketType: "MONEYLINE_3WAY", selectionType: "DRAW" };
  if (AWAY_TOKENS.has(key)) return { marketType: "MONEYLINE_3WAY", selectionType: "AWAY" };

  const withoutWinnerSuffix = trimmed.replace(WINNER_SUFFIX_REGEX, "").trim();

  if (withoutWinnerSuffix.length > 0 && withoutWinnerSuffix.length !== trimmed.length) {
    const strippedKey = withoutWinnerSuffix.toLowerCase();
    if (HOME_TEAM_PHRASES.has(strippedKey)) return { marketType: "MONEYLINE_3WAY", selectionType: "HOME" };
    if (AWAY_TEAM_PHRASES.has(strippedKey)) return { marketType: "MONEYLINE_3WAY", selectionType: "AWAY" };
    // A genuine participant candidate — the winner-intent suffix stripped,
    // the remainder (e.g. "Inter") is what's actually searchable against
    // provider outcome names. The ORIGINAL raw text is never lost: it stays
    // available to the caller via BetSlipSelectionInput.selection, which
    // this function does not read from or write back to.
    return { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT", participant: { name: withoutWinnerSuffix } };
  }

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

// Step 15H — submittedOdds is nullable: this is now also the shape a
// selection with no player-submitted odds takes, to support provider-price
// lookup (Step 15G's nullable-aware verifyOdds). Still deliberately not the
// full BetSlipSelectionInput — this function's contract still never has to
// decide what "no odds" MEANS (permissive submission vs. lookup vs.
// something else), only how to pass it through honestly; that decision
// stays with the caller.
export interface LegacyVerifiableSelection {
  readonly sport: string;
  // Step 16A — an explicit, player-stated league name (e.g. "Serie A"),
  // when known. Passed through HONESTLY, exactly as given — this function
  // never validates, normalizes, or aliases it (that decision belongs to
  // the provider adapter, lib/odds/theOddsApiProvider.ts, which is the only
  // place that knows which leagues are actually supported). Absent/null
  // both mean "no league stated" and fall back to the existing
  // sport-string-based reconstruction below, unchanged.
  readonly league?: string | null;
  readonly event: string;
  readonly selection: string;
  readonly submittedOdds: number | null;
}

// league/provider IDs/acceptedOdds/currentOdds are never set here — league
// is not fabricated (legacy has no league concept at all); provider
// references don't exist yet at request time; acceptedOdds/currentOdds are
// verification OUTPUTS, never request inputs.
export function legacySelectionToCanonicalRequest(selection: LegacyVerifiableSelection): VerifySelectionRequest {
  const sport = legacySportToCanonical(selection.sport);
  // Step 16A — an explicit league (selection.league) takes priority over
  // the older, narrower fallback (selection.sport itself happening to BE
  // one of the six recognized league name strings — legacyFootballLeagueFromSportString,
  // kept for backward compatibility). Neither ever fabricates a league:
  // the explicit path passes through selection.league's own text verbatim
  // (trimmed only), whatever it is — including a real but unsupported
  // league name, which the provider adapter alone is responsible for
  // recognizing as unsupported rather than silently substituting.
  const league = selection.league
    ? { name: selection.league.trim() }
    : legacyFootballLeagueFromSportString(selection.sport);
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
      // Step 15H — omitted (undefined) rather than serialized as the
      // literal string "null" when nothing was submitted. No unsafe
      // assertion: a plain, real null check, matching
      // CanonicalSelection.submittedOdds's own already-optional shape.
      submittedOdds: selection.submittedOdds !== null ? String(selection.submittedOdds) : undefined,
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
  // Step 15H — no longer read: the authoritative submittedOdds now always
  // comes from result.submittedOdds itself (derived just below), which
  // Step 15G's verifyOdds already computes correctly for every case —
  // unchanged for a real player-submitted number, promoted to the
  // provider's found price for a successful null-input lookup, or still
  // null when nothing could be promoted. Kept as an accepted-but-unused
  // optional parameter purely so lib/bets/buildBetSlipPreview.ts (out of
  // scope for this step, still calling this with two positional arguments)
  // keeps compiling unchanged until that file is wired up in a later step.
  _legacySubmittedOdds?: number,
): ReconstructedOddsCheck {
  if (result.status === "FAILED" && result.diagnosticCode === UNEXPECTED_ERROR_DIAGNOSTIC_CODE) {
    return { oddsCheck: null, wasExceptionMapped: true };
  }

  // Failed lookup with null input stays null here (result.submittedOdds is
  // null in that case, per verifyOdds — nothing was ever promoted).
  // Successful auto-lookup carries the provider-promoted price. Numeric
  // player-submitted odds pass straight through unchanged — no non-null
  // assertion anywhere in this derivation.
  const submittedOdds = result.submittedOdds !== null ? Number(result.submittedOdds) : null;

  // Stage 3.1 — round-trips result.matchedEvent back into OddsCheckResult's
  // own providerEventId/providerSportKey/eventStartTime fields, so
  // buildBetSlipPreview.ts only ever has to read one place (the
  // reconstructed oddsCheck) for both the original odds-check figures and
  // the provider event metadata — the same "legacy shape is the one
  // canonical read surface" convention this bridge already established for
  // matched/sourceOdds/bookmaker/etc. Present on FAILED too (the
  // event-found-but-selection-not-matched case) for honesty, even though
  // buildBetSlipPreview.ts only ever reads it from a matched:true result in
  // practice (Stage 3.1 gates preview-token population on that).
  const providerEventId = result.matchedEvent?.reference.eventId;
  const providerSportKey = result.matchedEvent?.reference.sportKey;
  const eventStartTime = result.matchedEvent?.event.startTime;

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
          providerEventId,
          providerSportKey,
          eventStartTime,
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
          providerEventId,
          providerSportKey,
          eventStartTime,
        },
        wasExceptionMapped: false,
      };
  }
}
