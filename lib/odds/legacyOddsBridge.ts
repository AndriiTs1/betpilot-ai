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
// Stage BA-2A — selection-text classification (which market/selection a
// free-text string like "ТБ 2.5"/"Арсенал ИТБ 1.5"/"1" means) now lives
// entirely in lib/odds/shorthandClassifier.ts, the one deterministic
// classifier this file and lib/bets/draft/normalize.ts both call, instead
// of this file maintaining its own independent token tables. This file's
// own job stays: legacy free-text shape -> canonical VerifySelectionRequest,
// and VerificationResult -> legacy OddsCheckResult, in both directions.
//
// MONEYLINE_2WAY/MONEYLINE_3WAY/TOTALS/TEAM_TOTAL/SPREAD can all be
// produced here (via the shared classifier) — but only MONEYLINE_2WAY/
// MONEYLINE_3WAY/TOTALS are actually verifiable by any provider adapter
// today (TheOddsApiProvider's own supportedMarketTypes allowlist rejects
// TEAM_TOTAL/SPREAD as MARKET_NOT_SUPPORTED before any provider call —
// classifying a market correctly and a provider being able to verify it
// are two different questions; docs/ODDS_SUPPORT_MATRIX.md Section 5).

import { normalizeLineString, type CanonicalEvent, type CanonicalLeague, type MarketType, type SelectionType, type Sport } from "./domain";
import type { VerifySelectionRequest } from "./oddsProvider";
import type { VerificationResult } from "./verification";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import { resolveFootballLeague } from "./footballLeagues";
import { classifyBettingSelectionTextWithMarketHint } from "./shorthandClassifier";

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

// H4-B5.4 — the two proven-unusable AI event values: blank/whitespace-only
// (a value betParser.ts's `event: z.string().min(1)` schema does NOT
// reject, since it validates the raw string's length, not whether it
// survives a later .trim()), and the literal sentinel "<UNKNOWN>" the real
// production Claude tool call was directly observed to emit (H4-B5.3's
// production diagnostic) — a syntactically valid, non-empty string that
// trivially satisfies minLength 1 with nothing left to catch it. This is
// deliberately NOT an open-ended blocklist of every string a model might
// ever hallucinate — only what has actually been observed in production, or
// is trivially indistinguishable from "nothing was extracted."
const UNUSABLE_EVENT_TEXTS = new Set(["<unknown>", "unknown"]);

function isUsableEventText(rawEvent: string): boolean {
  const trimmed = rawEvent.trim();
  if (trimmed.length === 0) return false;
  return !UNUSABLE_EVENT_TEXTS.has(trimmed.toLowerCase());
}

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
  // Betting Markets V1, Phase 2 — the numeric line for a TOTALS/SPREAD
  // selection, when stated (e.g. "2.5", "-1.5", "+1.5"). Absent/null both
  // mean "no line stated".
  readonly line?: string | null;
  // H3 Production Fix — the AI's own raw, unnormalized market text (e.g.
  // "Фора", "Азійська фора", "Handicap", "Spread"), when stated. Absent/
  // null both mean "no market hint stated". Consulted ONLY as a fallback,
  // and ONLY when `selection` alone resolves to the classifier's own
  // generic PARTICIPANT fallback — see classifyBettingSelectionTextWithMarketHint
  // (lib/odds/shorthandClassifier.ts) for the exact rule. Never overrides a
  // real, already-confident classification derived from `selection` alone.
  readonly marketRawText?: string | null;
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
  let event = legacyEventToCanonical(sport, selection.event, league);

  // Stage BA-2A — the one deterministic shorthand classifier
  // (lib/odds/shorthandClassifier.ts), replacing this function's own
  // former separate classifyTotalsDirection()/legacySelectionTextToCanonical()
  // composition. Behavior for every previously-recognized token is
  // preserved byte-for-byte (see shorthandClassifier.test.ts's parity
  // tests); new in this stage: TEAM_TOTAL (ИТБ/ИТМ) and SPREAD (Ф1/Ф2, a
  // participant-attributed signed line) are now classified honestly
  // instead of silently falling back to MONEYLINE_2WAY/PARTICIPANT.
  //
  // event.participants (already split above) is passed through as
  // knownParticipantNames so a shorthand token concatenated with a team
  // name in a single selection string (e.g. "Арсенал ТБ 2.5" arriving as
  // one field rather than a separately-stated event/selection split) can
  // still be recognized — closing the exact gap the BA-1 acceptance audit
  // traced this production bug to.
  const knownParticipantNames = event.participants.map((participant) => participant.name);
  // H3 Production Fix — this is the ACTUAL canonical-request-building call
  // (the one whose output real odds verification uses), previously blind to
  // any market hint the AI supplied separately from `selection` — the exact
  // production root cause (a natural-language handicap phrase split across
  // market="Фора"/selection="Арсенал" silently reclassified as MONEYLINE
  // here, even after BA-2D's own claim was correctly SPREAD). Now uses the
  // one shared reconstruction rule (lib/odds/shorthandClassifier.ts) BA-2D
  // itself uses, so this function and BA-2D's claim can never diverge on
  // the same input again.
  const classified = classifyBettingSelectionTextWithMarketHint(selection.selection, selection.marketRawText, knownParticipantNames);

  // H4-B5.4 — event search-hint recovery. Root cause (proven live via the
  // H4-B5.3 production diagnostic, not assumed): for at least one real
  // production message, Claude's own extract_bet tool call returned
  // event: "<UNKNOWN>" — a syntactically valid, non-empty string, so
  // betParser.ts's `event: z.string().min(1)` schema has nothing to reject
  // (there is no schema bypass; "<UNKNOWN>" trivially satisfies
  // minLength 1). That placeholder text was then sent to the provider as
  // the event query verbatim and — correctly — never matched anything,
  // producing EVENT_NOT_FOUND even though the player's own selection text
  // named a real, resolvable participant ("Arsenal") the whole time.
  //
  // Recovery: when the raw AI event text is unusable (blank, whitespace-
  // only, or that proven literal placeholder) AND the classifier already
  // resolved a real participant name from `selection.selection` — which by
  // construction (see shorthandClassifier.ts's matchSpread/matchTeamTotal/
  // classifyOnce) is ONLY ever non-null for a participant-attributed market
  // (SPREAD, TEAM_TOTAL, or MONEYLINE's team-name fallback), never for
  // HOME/DRAW/AWAY/OVER/UNDER — that participant name becomes the event
  // SEARCH HINT instead of the unusable text. This never fabricates an
  // opponent: it substitutes one real, single-team search string for
  // another, exactly the same shape H3.1 already treats as a legitimate
  // query ("Arsenal" alone, same as a player typing just one team name).
  // resolveMatchedEvent/findMatchingEvent (lib/odds/oddsVerifier.ts,
  // untouched by this stage) remain the sole authority on whether that
  // search resolves uniquely, is ambiguous, or is not found — no second
  // event matcher, no rounding, no guessed opponent. If no participant name
  // was resolved either, `event` is left exactly as built above (from the
  // original unusable text), which correctly fails as EVENT_NOT_FOUND
  // downstream rather than being silently rescued.
  if (!isUsableEventText(selection.event) && classified.participantName !== null) {
    event = legacyEventToCanonical(sport, classified.participantName, league);
  }

  // Line precedence: BetSlipSelectionInput.line (Phase 2's already-threaded
  // field — the AI's own dedicated "line" tool-schema value) is always
  // authoritative when present. The classifier's embeddedLine (a number
  // scraped out of the free-text selection, e.g. "2.5" from "ТБ 2.5") is
  // used ONLY as a backward-compatible fallback when no separate line was
  // ever stated at all — it never overwrites a real, separately-submitted
  // line, per this phase's explicit instruction (unchanged from before this
  // stage).
  const rawLine = selection.line ?? classified.embeddedLine ?? null;

  return {
    context: "PREVIEW",
    selection: {
      sport,
      league,
      event,
      marketType: classified.marketType,
      period: "FULL_GAME",
      selectionType: classified.selectionType,
      participant: classified.participantName !== null ? { name: classified.participantName } : undefined,
      // Step 15H — omitted (undefined) rather than serialized as the
      // literal string "null" when nothing was submitted. No unsafe
      // assertion: a plain, real null check, matching
      // CanonicalSelection.submittedOdds's own already-optional shape.
      submittedOdds: selection.submittedOdds !== null ? String(selection.submittedOdds) : undefined,
      // Betting Markets V1, Phase 2 review fix — canonicalized through the
      // one shared rule (normalizeLineString), so a "+1.5"-style input is
      // recognized as a valid positive line and stored/signed in canonical
      // unsigned form ("1.5"), not silently dropped. A genuinely malformed
      // string (normalizeLineString -> null) is passed through UNCHANGED
      // rather than coerced to undefined, so it still reaches
      // validateCanonicalSelection's own "not a valid decimal string" check
      // (called first thing inside TheOddsApiProvider.verifySelection) and
      // is rejected there — one validation point, not two (Phase 3.2: a
      // TOTALS selection with no line anywhere — neither stated nor
      // embedded — reaches that same check as "line: undefined", which
      // validateCanonicalSelection's existing "TOTALS requires line" rule
      // already rejects; no new validation code needed here).
      line: rawLine !== null ? (normalizeLineString(rawLine) ?? rawLine) : undefined,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Individual Team Totals, Stage 5A — known-canonical request construction,  */
/* skipping free-text (re-)classification entirely.                          */
/* -------------------------------------------------------------------------- */

// The confirm-time counterpart to LegacyVerifiableSelection above: instead of
// a raw `selection` string (and optional `marketRawText` hint) that still
// needs classifying, the caller already KNOWS the exact marketType/
// selectionType/participant this selection resolved to — because it already
// went through classification once, successfully, at preview time, and that
// result was signed onto the preview token (canonicalMarketType/
// canonicalSelectionType/canonicalParticipant — lib/betPreview/
// previewToken.ts). The caller (lib/bets/buildBetSlipPreview.ts, via
// BetSlipSelectionInput's own canonicalMarketType/canonicalSelectionType/
// canonicalParticipant fields) is responsible for validating these against
// lib/odds/domain.ts's own isMarketType/isSelectionType before constructing
// this shape — this function trusts its input completely, the same way
// mapSingleBetToCanonicalSelection.ts/mapExpressSelectionToCanonicalSelection.ts
// already do for the identical already-canonical data at persistence time.
export interface KnownCanonicalVerifiableSelection {
  readonly sport: string;
  readonly league?: string | null;
  readonly event: string;
  readonly marketType: MarketType;
  readonly selectionType: SelectionType;
  readonly participant?: string | null;
  readonly line?: string | null;
  readonly submittedOdds: number | null;
}

// Mirrors legacySelectionToCanonicalRequest's own event/league resolution
// exactly (same legacySportToCanonical/legacyFootballLeagueFromSportString/
// legacyEventToCanonical calls, same normalizeLineString line
// canonicalization) — the ONLY thing this function does NOT do is call
// classifyBettingSelectionTextWithMarketHint or isUsableEventText's <UNKNOWN>
// recovery: marketType/selectionType/participant are already known, never
// re-derived from text, and event text reaching this function has already
// been successfully resolved once before (at the original preview that
// produced the token this data came from), so the "<UNKNOWN>" placeholder
// recovery has nothing left to do here.
export function canonicalRequestFromKnownSelection(selection: KnownCanonicalVerifiableSelection): VerifySelectionRequest {
  const sport = legacySportToCanonical(selection.sport);
  const league = selection.league
    ? { name: selection.league.trim() }
    : legacyFootballLeagueFromSportString(selection.sport);
  const event = legacyEventToCanonical(sport, selection.event, league);

  const rawLine = selection.line ?? null;

  return {
    context: "PREVIEW",
    selection: {
      sport,
      league,
      event,
      marketType: selection.marketType,
      period: "FULL_GAME",
      selectionType: selection.selectionType,
      participant:
        selection.participant !== null && selection.participant !== undefined && selection.participant.trim().length > 0
          ? { name: selection.participant }
          : undefined,
      submittedOdds: selection.submittedOdds !== null ? String(selection.submittedOdds) : undefined,
      // Same canonicalization/pass-through-on-malformed discipline as
      // legacySelectionToCanonicalRequest's own line field — never a second,
      // different rule.
      line: rawLine !== null ? (normalizeLineString(rawLine) ?? rawLine) : undefined,
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

  // Same round-trip as the three fields above — the provider's own team
  // names/competition (threaded onto CanonicalEvent by
  // theOddsApiProvider.ts's buildMatchedEvent), read back out here so
  // buildBetSlipPreview.ts only ever has to read one place. `participants`
  // is ordered (never assumed [0]=home) — homeParticipantIndex/
  // awayParticipantIndex are the only honest pointers into it.
  const matchedParticipants = result.matchedEvent?.event.participants;
  const homeIndex = result.matchedEvent?.event.homeParticipantIndex;
  const awayIndex = result.matchedEvent?.event.awayParticipantIndex;
  const homeTeamName =
    matchedParticipants && homeIndex !== undefined ? matchedParticipants[homeIndex]?.name : undefined;
  const awayTeamName =
    matchedParticipants && awayIndex !== undefined ? matchedParticipants[awayIndex]?.name : undefined;
  const competitionName = result.matchedEvent?.event.league?.name;

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
          homeTeamName,
          awayTeamName,
          competitionName,
          // Stage 4.2B1 — carried through unconditionally, same as every
          // other field derived straight from `result` here: VerificationResult
          // always has a reasonCode (NONE for VERIFIED, ODDS_OUTSIDE_TOLERANCE
          // for ODDS_CHANGED), so there's no reason to selectively omit it on
          // the matched:true branches.
          reasonCode: result.reasonCode,
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
          homeTeamName,
          awayTeamName,
          competitionName,
          // Stage 4.2B1 — root cause fix: this used to be the one place that
          // silently dropped the classification lib/odds/theOddsApiProvider.ts's
          // classifyLegacyFailureNote() already computed (PROVIDER_UNAVAILABLE/
          // PROVIDER_TIMEOUT/PROVIDER_INVALID_RESPONSE/PROVIDER_RATE_LIMITED vs.
          // EVENT_NOT_FOUND/SELECTION_NOT_FOUND/SPORT_NOT_SUPPORTED/etc.),
          // making a technical provider failure indistinguishable from a real
          // "not found" by the time mapOddsStatus.ts saw only matched:false.
          // Now threaded through so that distinction survives to the UI.
          reasonCode: result.reasonCode,
          // Stage M4.4 — same fix, one layer more granular: this used to be
          // the point where the specific findSpreadOutcome() kind (already
          // classified by classifyLegacyFailureNote() into
          // result.diagnosticCode, e.g. "LEGACY_SPREAD_LINE_NOT_AVAILABLE")
          // was silently dropped, leaving every spread SELECTION_NOT_FOUND
          // indistinguishable from every other one downstream.
          diagnosticCode: result.diagnosticCode,
        },
        wasExceptionMapped: false,
      };
  }
}
