import type { OddsCheckResult } from "@/types/oddsSnapshot";
import { normalizeTeamName, overlapScore } from "./teamNameMatcher";
import { logScreenshotPipelineEvent } from "@/lib/logging/structuredLog";

const ODDS_API_BASE_URL = "https://api.the-odds-api.com/v4";
const ODDS_API_TIMEOUT_MS = 8000;
const ODDS_CACHE_TTL_MS = 45_000;

// matched=true once event+market+selection are actually found in the
// bookmaker's data; withinTolerance is then a separate verdict on whether
// the player's submitted odds are close enough to that source price — the
// two used to be conflated into a single (and permanently-false) `matched`.
const ODDS_TOLERANCE_PERCENT = 3;

// Local, minimal input shape — no longer borrowed from the stale
// types/bet.ts (which has its own out-of-sync BetStatus and a
// selection/outcome naming mismatch against the real Prisma Bet model).
// Field names here intentionally match what betHandler.ts already builds.
//
// Step 15G — odds is nullable so this function can be called for a
// selection the player never gave a price for, to support automatic
// provider-price lookup. This is a domain-level primitive only: nothing
// upstream (buildBetSlipPreview.ts, legacyOddsBridge.ts,
// theOddsApiProvider.ts) calls verifyOdds with odds: null yet — every
// existing production call site still always passes a real number, so this
// widening has zero effect on any live code path today. See this
// function's own null-branch comment below for the exact new behavior.
export interface OddsVerificationInput {
  sport: string;
  event: string;
  selection: string;
  odds: number | null;
}

/* -------------------------------------------------------------------------- */
/* Sport → sport_key mapping                                                  */
/* -------------------------------------------------------------------------- */

// Basic mapping only. "Football"/"Soccer" defaults to the Premier League —
// The Odds API has no single sport_key covering every league, and Bet.sport
// doesn't carry enough info (e.g. which league) to disambiguate further.
//
// Tennis is different in kind, not just missing: unlike basketball_nba or
// icehockey_nhl, The Odds API has no persistent year-round ATP/WTA tour
// sport_key at all — tennis is only exposed per Grand Slam, and only while
// that tournament is actually being played. There is no single key that
// "covers tennis" the way soccer_epl approximates football. The entry below
// is a list of every currently-documented Grand Slam key (ATP + WTA); a
// match is queried against whichever of these is presently in season.
// Outside all four Grand Slam windows, every one of them legitimately
// returns zero events — that will surface as "no matching event found", not
// as an unmapped sport, which is the correct and honest distinction.
const TENNIS_SPORT_KEYS = [
  "tennis_atp_aus_open_singles",
  "tennis_wta_aus_open_singles",
  "tennis_atp_french_open",
  "tennis_wta_french_open",
  "tennis_atp_wimbledon",
  "tennis_wta_wimbledon",
  "tennis_atp_us_open",
  "tennis_wta_us_open",
];

// Step 16A — one named constant per football sport_key, referenced both
// individually (an explicit, supported league queries only its own key)
// and together in FOOTBALL_FALLBACK_SPORT_KEYS below (no explicit/
// recognized league merges across all of them) — never two separate
// literal copies of the same sport_key string.
const SOCCER_EPL_KEY = "soccer_epl";
const SOCCER_LA_LIGA_KEY = "soccer_spain_la_liga";
const SOCCER_SERIE_A_KEY = "soccer_italy_serie_a";
const SOCCER_BUNDESLIGA_KEY = "soccer_germany_bundesliga";
const SOCCER_LIGUE_1_KEY = "soccer_france_ligue_one";
const SOCCER_UEFA_CL_KEY = "soccer_uefa_champs_league";
// The Odds API models the UEFA Champions League qualifying rounds as a
// sport_key entirely separate from the main tournament (SOCCER_UEFA_CL_KEY)
// — never merged/aliased together, since they are genuinely distinct
// provider-side competitions (confirmed live: the main-tournament key can
// return zero events while this one lists real, in-progress qualifiers).
const SOCCER_UEFA_CL_QUALIFICATION_KEY = "soccer_uefa_champs_league_qualification";

// Step 16A — generic football/soccer (no explicit, supported league) now
// merges across every currently supported competition, mirroring the
// tennis multi-key pattern above, instead of defaulting exclusively to
// soccer_epl. Order carries no priority meaning — findMatchingEvent()
// below flags a cross-league score tie as ambiguous rather than silently
// preferring whichever key happens to be listed first.
const FOOTBALL_FALLBACK_SPORT_KEYS: string[] = [
  SOCCER_EPL_KEY,
  SOCCER_LA_LIGA_KEY,
  SOCCER_SERIE_A_KEY,
  SOCCER_BUNDESLIGA_KEY,
  SOCCER_LIGUE_1_KEY,
  SOCCER_UEFA_CL_KEY,
  SOCCER_UEFA_CL_QUALIFICATION_KEY,
];

const SPORT_KEY_ALIASES: Record<string, string | string[]> = {
  football: FOOTBALL_FALLBACK_SPORT_KEYS,
  soccer: FOOTBALL_FALLBACK_SPORT_KEYS,
  футбол: FOOTBALL_FALLBACK_SPORT_KEYS,
  "premier league": SOCCER_EPL_KEY,
  "la liga": SOCCER_LA_LIGA_KEY,
  "serie a": SOCCER_SERIE_A_KEY,
  bundesliga: SOCCER_BUNDESLIGA_KEY,
  "ligue 1": SOCCER_LIGUE_1_KEY,
  "champions league": SOCCER_UEFA_CL_KEY,
  "champions league qualification": SOCCER_UEFA_CL_QUALIFICATION_KEY,
  basketball: "basketball_nba",
  баскетбол: "basketball_nba",
  nba: "basketball_nba",
  "american football": "americanfootball_nfl",
  nfl: "americanfootball_nfl",
  hockey: "icehockey_nhl",
  "ice hockey": "icehockey_nhl",
  хоккей: "icehockey_nhl",
  nhl: "icehockey_nhl",
  tennis: TENNIS_SPORT_KEYS,
  теннис: TENNIS_SPORT_KEYS,
  atp: TENNIS_SPORT_KEYS,
  wta: TENNIS_SPORT_KEYS,
};

// Returns one or more sport_keys to try, in order — plural because tennis
// (see above) has no single key. Every other sport still resolves to
// exactly one key, so their existing single-request behavior is unchanged.
function getSportKeys(sport: string): string[] | null {
  const value = SPORT_KEY_ALIASES[sport.toLowerCase().trim()];
  if (!value) return null;
  return Array.isArray(value) ? value : [value];
}

/* -------------------------------------------------------------------------- */
/* Fuzzy team / selection matching                                            */
/* -------------------------------------------------------------------------- */

// Stage 3.5C-FIX — team-name normalization (Cyrillic transliteration,
// aliases, diacritics) and bounded fuzzy word-overlap matching moved to
// lib/odds/teamNameMatcher.ts (imported above), so
// lib/bets/settlement/evaluateSelectionOutcome.ts can reuse the identical
// logic for PARTICIPANT selection resolution instead of duplicating it.
// No functional change from commit 7430506 — see that module for the full
// design rationale (Cyrillic alphabet coverage, Levenshtein threshold
// calibration, etc.).

const EVENT_SEPARATOR_REGEX = /\s+(?:vs\.?|v\.?|-|–|—)\s+/i;

function splitEventTeams(event: string): [string, string] | null {
  const parts = event.split(EVENT_SEPARATOR_REGEX);
  return parts.length === 2 ? [parts[0].trim(), parts[1].trim()] : null;
}

interface OddsApiOutcome {
  name: string;
  price: number;
}

interface OddsApiMarket {
  key: string;
  outcomes: OddsApiOutcome[];
}

interface OddsApiBookmaker {
  key: string;
  title: string;
  markets: OddsApiMarket[];
}

interface OddsApiEvent {
  id: string;
  // Step 16B — The Odds API already sends this on every event; not read
  // until now. Used only for semantic dedup's tolerant time-window check
  // below (never for matching/scoring itself).
  commence_time?: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
  // Stage 3.1 — NOT part of the raw JSON response. Tagged locally by
  // verifyOdds() immediately after each fetchOddsForSport(sportKey) call,
  // before events from different keys are merged into one array (see the
  // multi-key loop below) — this is how a multi-key sport (tennis) or a
  // no-explicit-league football fallback (FOOTBALL_FALLBACK_SPORT_KEYS)
  // keeps track of which specific sport_key endpoint each event actually
  // came from, once they're merged and no longer separable by array
  // position alone. Never written into oddsCache (fetchOddsForSport's own
  // cache stores the untagged, pristine parsed response) — this field only
  // ever exists on the per-call working copy inside verifyOdds().
  providerSportKey?: string;
}

const EVENT_MATCH_THRESHOLD = 0.5;

// Step 16A — discriminated result instead of a bare nullable event: a
// no-explicit-league football lookup can now merge events from several
// competitions, so this must be able to honestly say "two genuinely
// different events both matched equally well" (AMBIGUOUS) rather than
// silently picking whichever happened to be scored first — never inventing
// a permanent league priority to break the tie.
type EventMatchResult =
  | { readonly kind: "FOUND"; readonly event: OddsApiEvent }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "AMBIGUOUS" };

// Bugfix (production incident, single-team query e.g. "Arsenal" with no
// stated opponent): the previous no-teams branch scored the query against
// the CONCATENATED "home away" string, so the opponent's own name words
// inflated the comparison's denominator and mathematically capped the score
// at 1/(number of team-name words) — always below EVENT_MATCH_THRESHOLD for
// any two-word-or-longer opponent, even for a perfect single-team match.
// Fixed by scoring the query against home and away SEPARATELY and taking
// the max — exactly how the two-teams branch already treats forward/backward
// pairing, just for one side instead of two.
interface EventCandidate {
  readonly event: OddsApiEvent;
  readonly score: number;
  // Exact, whole-string normalized equality — the strongest possible
  // signal (req. 7), checked structurally rather than inferred from score
  // alone: two different candidates can both reach score 1.0 (all words
  // fuzzy-matched) without either being a literal exact name match, and an
  // exact match must still win over such a candidate.
  readonly isExact: boolean;
  readonly isFuture: boolean;
}

function isFutureEvent(event: OddsApiEvent): boolean {
  if (!event.commence_time) return false;
  const ms = Date.parse(event.commence_time);
  if (Number.isNaN(ms)) return false;
  return ms > Date.now();
}

function findMatchingEvent(events: OddsApiEvent[], betEvent: string): EventMatchResult {
  const teams = splitEventTeams(betEvent);
  const candidates: EventCandidate[] = [];

  for (const event of events) {
    const home = normalizeTeamName(event.home_team);
    const away = normalizeTeamName(event.away_team);

    let score: number;
    let isExact: boolean;

    if (teams) {
      // Unchanged from before this fix — Bet.event order (player's
      // team1/team2) may not match the API's home/away order.
      const [t1, t2] = teams.map(normalizeTeamName);
      const forward = (overlapScore(t1, home) + overlapScore(t2, away)) / 2;
      const backward = (overlapScore(t1, away) + overlapScore(t2, home)) / 2;
      score = Math.max(forward, backward);
      isExact = (t1 === home && t2 === away) || (t1 === away && t2 === home);
    } else {
      // The fix: compare the single-team query against home and away
      // independently, never against their concatenation.
      const query = normalizeTeamName(betEvent);
      const homeScore = overlapScore(query, home);
      const awayScore = overlapScore(query, away);
      score = Math.max(homeScore, awayScore);
      isExact = query === home || query === away;
    }

    if (score < EVENT_MATCH_THRESHOLD) continue;

    candidates.push({ event, score, isExact, isFuture: isFutureEvent(event) });
  }

  if (candidates.length === 0) return { kind: "NOT_FOUND" };

  // Tier 1 (req. 7) — an exact normalized name match beats every fuzzy
  // candidate outright, regardless of raw score.
  const exactCandidates = candidates.filter((c) => c.isExact);
  let pool = exactCandidates.length > 0 ? exactCandidates : candidates;

  // Tier 2 (req. 7) — highest score within the pool; only true ties at the
  // max score continue past this point (mirrors the old exact-equality tie
  // rule, never a "close enough" fuzzy tolerance).
  const maxScore = Math.max(...pool.map((c) => c.score));
  pool = pool.filter((c) => c.score === maxScore);

  // Tier 3 (req. 7 & 8) — a future event beats a past/unknown one; a past
  // event is never allowed to win against a future alternative. If none of
  // the tied candidates is confidently future (e.g. no commence_time at
  // all, as in most existing fixtures), the pool is left as-is — there is
  // nothing to prefer one over the other for.
  const futureInPool = pool.filter((c) => c.isFuture);
  if (futureInPool.length > 0) {
    pool = futureInPool;
  }

  // Defense-in-depth: the same provider event id should never itself cause
  // a false ambiguity (callers already dedupe by id before this function
  // runs, but this function must not rely on that alone).
  const distinctIds = new Set(pool.map((c) => c.event.id));
  if (distinctIds.size > 1) return { kind: "AMBIGUOUS" };

  return { kind: "FOUND", event: pool[0].event };
}

// Step 16B — real-world provider data quality issue, confirmed live: The
// Odds API can list the exact same real-world fixture twice under two
// DIFFERENT event ids within a single competition response (observed for
// Serie A's "Torino vs AC Milan" — same two teams, ~30 hours apart in
// stated kickoff time, evidently a not-yet-finalized/inconsistently
// re-quoted schedule slot rather than two genuinely separate meetings).
// findMatchingEvent()'s id-based dedup (Array.from(new Map(...))) cannot
// catch this — the ids really are different — so this runs first and
// collapses same-team-pairing entries whose kickoff times are close enough
// to plausibly be the same match, before ambiguity detection ever sees
// them. A genuine same-season home-and-away rematch (kickoffs typically
// months apart) is far outside SAME_FIXTURE_TIME_WINDOW_MS and is
// correctly left as two separate events.
const SAME_FIXTURE_TIME_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function isSameFixture(a: OddsApiEvent, b: OddsApiEvent): boolean {
  if (normalizeTeamName(a.home_team) !== normalizeTeamName(b.home_team)) return false;
  if (normalizeTeamName(a.away_team) !== normalizeTeamName(b.away_team)) return false;

  // Neither/either side missing a kickoff time — team pairing alone is the
  // only signal available; a competition genuinely rematching the same two
  // teams within one fetch's near-term window is not a realistic case this
  // codebase's supported leagues produce.
  if (!a.commence_time || !b.commence_time) return true;

  const aTime = Date.parse(a.commence_time);
  const bTime = Date.parse(b.commence_time);
  if (Number.isNaN(aTime) || Number.isNaN(bTime)) return true;

  return Math.abs(aTime - bTime) <= SAME_FIXTURE_TIME_WINDOW_MS;
}

// Merges bookmakers from every record recognized as the same fixture —
// never silently drops a real bookmaker price (e.g. Pinnacle) just because
// it happened to be listed under whichever duplicate record processed
// second. Order of first appearance is preserved for which "event" survives
// (id, commence_time, team name casing all come from whichever record was
// encountered first) — matching semantics only, never used to invent a
// canonical id.
function dedupeEventsSemantically(events: readonly OddsApiEvent[]): OddsApiEvent[] {
  const merged: OddsApiEvent[] = [];

  for (const event of events) {
    const existingIndex = merged.findIndex((kept) => isSameFixture(kept, event));
    if (existingIndex === -1) {
      merged.push(event);
    } else {
      merged[existingIndex] = {
        ...merged[existingIndex],
        bookmakers: [...merged[existingIndex].bookmakers, ...event.bookmakers],
      };
    }
  }

  return merged;
}

function pickBookmaker(
  event: OddsApiEvent,
): { bookmaker: OddsApiBookmaker; isFallback: boolean } | null {
  if (event.bookmakers.length === 0) return null;

  const pinnacle = event.bookmakers.find((b) => b.key === "pinnacle");
  if (pinnacle) return { bookmaker: pinnacle, isFallback: false };

  return { bookmaker: event.bookmakers[0], isFallback: true };
}

const SELECTION_MATCH_THRESHOLD = 0.4;

/* -------------------------------------------------------------------------- */
/* Single 1X2 shorthand ("1"/"X"/"2" and a few common spellings)              */
/* -------------------------------------------------------------------------- */
//
// The Odds API's h2h market never uses "1"/"X"/"2" as an outcome name — its
// outcomes are always the literal home_team/away_team strings plus "Draw".
// A parser/OCR result can legitimately hand back the short European
// notation instead of a team name (that's exactly what's printed on many
// bookmaker slips), and the fuzzy word-overlap matching below this section
// scores that at 0 against any real team name — hence the previously
// unconditional NOT_FOUND for "1"/"X"/"2". This section recognizes that
// narrow, closed set of tokens *before* falling back to the existing fuzzy
// name matching, and resolves "1"/"2" against whichever provider team is
// actually first/second in the *parsed* event string — never a blind
// home_team/away_team assumption, since findMatchingEvent() already proves
// the provider's home/away order doesn't have to agree with the order the
// player's slip was read in.

type SingleSelectionClass = "FIRST_TEAM" | "DRAW" | "SECOND_TEAM" | "TEAM_NAME_OR_OTHER";

// Exact-match only (after trim + lowercase) — deliberately not a substring
// or word-boundary test, so combined-market notation like "1X"/"X2"/"12"
// (double chance) never collides with a single outcome. "Х" (Cyrillic,
// U+0425) and "X" (Latin) both lowercase to their own script's lowercase
// form; both are listed explicitly since they are different codepoints.
const FIRST_TEAM_TOKENS: ReadonlySet<string> = new Set(["1", "п1", "p1", "home"]);
const DRAW_TOKENS: ReadonlySet<string> = new Set(["x", "х", "draw", "ничья"]);
const SECOND_TEAM_TOKENS: ReadonlySet<string> = new Set(["2", "п2", "p2", "away"]);

function classifySingleSelection(selection: string): SingleSelectionClass {
  const key = selection.trim().toLowerCase();
  if (FIRST_TEAM_TOKENS.has(key)) return "FIRST_TEAM";
  if (DRAW_TOKENS.has(key)) return "DRAW";
  if (SECOND_TEAM_TOKENS.has(key)) return "SECOND_TEAM";
  return "TEAM_NAME_OR_OTHER";
}

type TeamOrderResolution =
  | { kind: "RESOLVED"; firstTeamName: string; secondTeamName: string }
  | { kind: "UNCERTAIN" };

// Reuses the exact same forward/backward pairing idea findMatchingEvent()
// already uses to tolerate a reversed home/away order — recomputed here
// against the one event that was actually matched, since findMatchingEvent()
// itself only returns the winning event, not which orientation won it.
// Never guesses: returns UNCERTAIN whenever the parsed event string can't
// be split into two teams at all, when neither orientation reaches
// EVENT_MATCH_THRESHOLD, or when both orientations are confident but tied
// (genuinely ambiguous) — the caller must then leave the selection
// unmatched rather than silently pick one team.
function resolveTeamOrder(parsedEvent: string, event: OddsApiEvent): TeamOrderResolution {
  const teams = splitEventTeams(parsedEvent);
  if (!teams) return { kind: "UNCERTAIN" };

  const [t1, t2] = teams.map(normalizeTeamName);
  const home = normalizeTeamName(event.home_team);
  const away = normalizeTeamName(event.away_team);

  const forward = (overlapScore(t1, home) + overlapScore(t2, away)) / 2;
  const backward = (overlapScore(t1, away) + overlapScore(t2, home)) / 2;

  const forwardConfident = forward >= EVENT_MATCH_THRESHOLD;
  const backwardConfident = backward >= EVENT_MATCH_THRESHOLD;

  if (forwardConfident && (!backwardConfident || forward > backward)) {
    return { kind: "RESOLVED", firstTeamName: event.home_team, secondTeamName: event.away_team };
  }
  if (backwardConfident && (!forwardConfident || backward > forward)) {
    return { kind: "RESOLVED", firstTeamName: event.away_team, secondTeamName: event.home_team };
  }

  // Neither orientation is confident, or both are confident but tied — a
  // coin flip either way, so this is left unresolved rather than guessed.
  return { kind: "UNCERTAIN" };
}

// Finds the h2h outcome whose name matches teamName — exact match after
// normalization first (The Odds API's outcome.name is always literally the
// event's own home_team/away_team string for h2h), falling back to the
// same overlapScore/threshold the general name-matching path below uses,
// for resilience against minor formatting differences.
function findOutcomePriceByTeamName(market: OddsApiMarket, teamName: string): number | null {
  const normalizedTarget = normalizeTeamName(teamName);

  let best: { outcome: OddsApiOutcome; score: number } | null = null;

  for (const outcome of market.outcomes) {
    const outcomeName = normalizeTeamName(outcome.name);
    const score = outcomeName === normalizedTarget ? 1 : overlapScore(normalizedTarget, outcomeName);

    if (!best || score > best.score) {
      best = { outcome, score };
    }
  }

  if (!best || best.score < SELECTION_MATCH_THRESHOLD) return null;

  return best.outcome.price;
}

// Same /\bdraw\b/ recognition the old single-branch matcher already used
// for a bare "Draw"/"Ничья" selection — just applied directly to find the
// Draw outcome, rather than only steering that selection's own score.
function findDrawOutcomePrice(market: OddsApiMarket): number | null {
  const drawOutcome = market.outcomes.find((outcome) => /\bdraw\b/.test(normalizeTeamName(outcome.name)));
  return drawOutcome ? drawOutcome.price : null;
}

function extractOutcomePrice(
  bookmaker: OddsApiBookmaker,
  selection: string,
  event: OddsApiEvent,
  parsedEvent: string,
): number | null {
  const market = bookmaker.markets.find((m) => m.key === "h2h");
  if (!market) return null;

  const selectionClass = classifySingleSelection(selection);

  if (selectionClass === "DRAW") {
    return findDrawOutcomePrice(market);
  }

  if (selectionClass === "FIRST_TEAM" || selectionClass === "SECOND_TEAM") {
    const order = resolveTeamOrder(parsedEvent, event);
    if (order.kind === "UNCERTAIN") return null;

    const targetTeamName = selectionClass === "FIRST_TEAM" ? order.firstTeamName : order.secondTeamName;
    return findOutcomePriceByTeamName(market, targetTeamName);
  }

  // TEAM_NAME_OR_OTHER — unchanged existing fuzzy matching (a full team
  // name, a bare "Draw"/"Ничья" not caught by the exact-token set above,
  // combined-market notation like "1X"/"X2"/"12" which scores 0 here and
  // correctly stays unmatched, or anything else).
  const normalizedSelection = normalizeTeamName(selection);
  const isDraw = /\b(draw|ничья)\b/.test(normalizedSelection);

  let best: { outcome: OddsApiOutcome; score: number } | null = null;

  for (const outcome of market.outcomes) {
    const outcomeName = normalizeTeamName(outcome.name);

    let score: number;

    if (isDraw && /\bdraw\b/.test(outcomeName)) {
      score = 1;
    } else {
      score = overlapScore(normalizedSelection, outcomeName);
      if (normalizedSelection.includes(outcomeName) || outcomeName.includes(normalizedSelection)) {
        score = Math.max(score, 0.75);
      }
    }

    if (!best || score > best.score) {
      best = { outcome, score };
    }
  }

  if (!best || best.score < SELECTION_MATCH_THRESHOLD) return null;

  return best.outcome.price;
}

/* -------------------------------------------------------------------------- */
/* The Odds API fetch (with process-level cache)                              */
/* -------------------------------------------------------------------------- */

interface CacheEntry {
  expiresAt: number;
  events: OddsApiEvent[];
}

const oddsCache = new Map<string, CacheEntry>();

// Structural failure carrier — status and the provider's own short
// error_code (never the raw body) — so both the safe note text below AND
// the safe operational log in verifyOdds() can read them directly, instead
// of each re-parsing a formatted message string independently.
class OddsApiHttpError extends Error {
  readonly status: number;
  readonly providerErrorCode: string | null;

  constructor(status: number, providerErrorCode: string | null) {
    super(`The Odds API request failed with status ${status}${providerErrorCode ? ` (${providerErrorCode})` : ""}`);
    this.name = "OddsApiHttpError";
    this.status = status;
    this.providerErrorCode = providerErrorCode;
  }
}

async function fetchOddsForSport(sportKey: string): Promise<OddsApiEvent[]> {
  const cached = oddsCache.get(sportKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.events;
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    throw new Error("ODDS_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ODDS_API_TIMEOUT_MS);

  try {
    const url = `${ODDS_API_BASE_URL}/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=eu&markets=h2h&oddsFormat=decimal`;
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      // Safe by construction: the raw response body is parsed transiently,
      // in memory, only to pull out the provider's own short, enum-like
      // `error_code` field (e.g. "OUT_OF_USAGE_CREDITS") — never kept or
      // embedded whole. A non-JSON or differently-shaped body degrades to
      // providerErrorCode: null rather than throwing or falling back to
      // including any raw text. This is what lets classifyLegacyFailureNote
      // (theOddsApiProvider.ts) distinguish quota-exhausted / auth-failed /
      // rate-limited / generic-unavailable instead of collapsing every
      // non-2xx status into one undifferentiated failure.
      const bodyText = await response.text().catch(() => "");
      let providerErrorCode: string | null = null;
      try {
        const parsedBody = JSON.parse(bodyText) as { error_code?: unknown };
        if (typeof parsedBody.error_code === "string") {
          providerErrorCode = parsedBody.error_code;
        }
      } catch {
        // Non-JSON body — providerErrorCode stays null; no raw text is ever
        // read into the thrown error below.
      }

      throw new OddsApiHttpError(response.status, providerErrorCode);
    }

    const events = (await response.json()) as unknown;

    if (!Array.isArray(events)) {
      throw new Error("Unexpected response shape from The Odds API");
    }

    oddsCache.set(sportKey, { expiresAt: Date.now() + ODDS_CACHE_TTL_MS, events: events as OddsApiEvent[] });

    return events as OddsApiEvent[];
  } finally {
    clearTimeout(timeout);
  }
}

/* -------------------------------------------------------------------------- */
/* Stage 3.1 — provider event metadata extraction                             */
/* -------------------------------------------------------------------------- */

// Human-readable competition names for every sport_key this file can ever
// tag an event with (every entry of FOOTBALL_FALLBACK_SPORT_KEYS,
// TENNIS_SPORT_KEYS, and the single-key sports below) — display purposes
// only, never used for matching/routing. A sport_key this map doesn't
// recognize (should not happen — this file is the only place
// providerSportKey is ever set) falls back to the raw key rather than
// crashing or omitting the competition name entirely.
const SPORT_KEY_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  [SOCCER_EPL_KEY]: "Premier League",
  [SOCCER_LA_LIGA_KEY]: "La Liga",
  [SOCCER_SERIE_A_KEY]: "Serie A",
  [SOCCER_BUNDESLIGA_KEY]: "Bundesliga",
  [SOCCER_LIGUE_1_KEY]: "Ligue 1",
  [SOCCER_UEFA_CL_KEY]: "UEFA Champions League",
  [SOCCER_UEFA_CL_QUALIFICATION_KEY]: "UEFA Champions League Qualification",
  basketball_nba: "NBA",
  americanfootball_nfl: "NFL",
  icehockey_nhl: "NHL",
  tennis_atp_aus_open_singles: "ATP Australian Open",
  tennis_wta_aus_open_singles: "WTA Australian Open",
  tennis_atp_french_open: "ATP French Open",
  tennis_wta_french_open: "WTA French Open",
  tennis_atp_wimbledon: "ATP Wimbledon",
  tennis_wta_wimbledon: "WTA Wimbledon",
  tennis_atp_us_open: "ATP US Open",
  tennis_wta_us_open: "WTA US Open",
};

function competitionDisplayName(sportKey: string): string {
  return SPORT_KEY_DISPLAY_NAMES[sportKey] ?? sportKey;
}

interface ProviderEventMetadata {
  readonly providerEventId: string;
  readonly providerSportKey: string;
  readonly eventStartTime: string;
  // Threaded through so Preview/Active Bets/History/Operator Dashboard can
  // show the full resolved event ("Arsenal — Coventry City", "Premier
  // League") instead of only the player's own single-team query text — see
  // lib/bets/buildBetSlipPreview.ts. Sourced directly from the matched
  // OddsApiEvent, never from the player's parsed text.
  readonly homeTeamName: string;
  readonly awayTeamName: string;
  readonly competitionName: string;
}

// All-or-nothing by design: returns either a complete, trustworthy metadata
// set or nothing at all — never an event id with a missing/invalid start
// time. `event.providerSportKey` is only absent if some future code path
// forgets to tag it (defensive only — every real call site above always
// tags it); a missing or unparsable commence_time is the realistic failure
// case this guards, per the task's explicit "invalid commence_time must not
// propagate as trustworthy metadata" requirement.
function extractProviderEventMetadata(event: OddsApiEvent): ProviderEventMetadata | null {
  if (!event.providerSportKey) return null;
  if (!event.commence_time) return null;

  const parsedMs = Date.parse(event.commence_time);
  if (Number.isNaN(parsedMs)) return null;

  return {
    providerEventId: event.id,
    providerSportKey: event.providerSportKey,
    eventStartTime: new Date(parsedMs).toISOString(),
    homeTeamName: event.home_team,
    awayTeamName: event.away_team,
    competitionName: competitionDisplayName(event.providerSportKey),
  };
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

export async function verifyOdds(bet: OddsVerificationInput): Promise<OddsCheckResult> {
  const baseResult: OddsCheckResult = {
    matched: false,
    withinTolerance: null,
    sourceOdds: null,
    submittedOdds: bet.odds,
    discrepancyPercent: null,
    bookmaker: null,
    note: null,
  };

  const sportKeys = getSportKeys(bet.sport);

  if (!sportKeys) {
    return { ...baseResult, note: `Sport/league "${bet.sport}" is not mapped to a The Odds API sport_key` };
  }

  // Single-key sports (football/basketball/etc.) make exactly the one
  // request they always did. Multi-key sports (currently only tennis) query
  // each candidate and merge — an empty result from an out-of-season Grand
  // Slam key is expected, not an error, so only report a failure if every
  // key in the list failed to fetch at all.
  let events: OddsApiEvent[] = [];
  let lastFetchError: string | null = null;
  let successCount = 0;

  for (const sportKey of sportKeys) {
    const fetchStartedAt = Date.now();
    try {
      const fetched = await fetchOddsForSport(sportKey);
      // Tag every event from this fetch with the exact sport_key that
      // produced it, before merging into the shared `events` array — once
      // merged, array position/order no longer distinguishes which key an
      // event came from (see OddsApiEvent.providerSportKey's own comment).
      events = events.concat(fetched.map((event) => ({ ...event, providerSportKey: sportKey })));
      successCount += 1;
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "AbortError";
      lastFetchError = isTimeout
        ? `The Odds API request timed out after ${ODDS_API_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : "Unknown error calling The Odds API";

      // Permanent, safe operational log — one line per failed fetch attempt.
      // failureCode is always a short, enum-like token (the provider's own
      // error_code, a synthesized HTTP_<status>, "TIMEOUT", or "UNKNOWN"),
      // never free text/raw response body/headers/API key. Lets operators
      // see failure category + HTTP status + timing + which sport_key was
      // affected without needing the (removed) verbose investigation
      // logging this replaces.
      logScreenshotPipelineEvent("odds_provider_fetch_failed", {
        sportKey,
        durationMs: Date.now() - fetchStartedAt,
        failureCode: isTimeout
          ? "TIMEOUT"
          : err instanceof OddsApiHttpError
            ? (err.providerErrorCode ?? `HTTP_${err.status}`)
            : "UNKNOWN",
        httpStatus: err instanceof OddsApiHttpError ? err.status : undefined,
      });
    }
  }

  if (successCount === 0 && lastFetchError) {
    return { ...baseResult, note: lastFetchError };
  }

  // Step 16A — dedupe by provider event id before matching: a football
  // lookup can now merge several competitions' responses, and the same
  // fixture must never be double-counted (which would otherwise make
  // findMatchingEvent's own ambiguity tie-break fire for what is actually
  // one single event seen twice, not two different ones).
  const dedupedById = Array.from(new Map(events.map((event) => [event.id, event])).values());

  // Step 16B — dedupe by SEMANTIC fixture identity next: id-based dedup
  // alone does not catch The Odds API's own confirmed real-world quirk of
  // relisting the exact same match under a genuinely different id (see
  // dedupeEventsSemantically's own comment). Runs after id-based dedup,
  // before matching/ambiguity detection, so a duplicate provider record
  // never produces a false AMBIGUOUS_EVENT.
  const dedupedEvents = dedupeEventsSemantically(dedupedById);

  const matchResult = findMatchingEvent(dedupedEvents, bet.event);

  if (matchResult.kind === "NOT_FOUND") {
    return { ...baseResult, note: `No matching event found for "${bet.event}" in ${sportKeys.join(", ")}` };
  }

  if (matchResult.kind === "AMBIGUOUS") {
    return { ...baseResult, note: `Ambiguous event match for "${bet.event}" across multiple leagues` };
  }

  const event = matchResult.event;

  // Stage 3.1 — computed once, right after the event is unambiguously
  // resolved, and spread into every return branch from this point on
  // (including the two failure branches immediately below, where the event
  // itself WAS found even though bookmaker/selection matching then failed)
  // — never into baseResult or any branch above this line, where no event
  // was ever resolved at all. `?? {}` spreads nothing when metadata is
  // null (an invalid/missing commence_time), rather than spreading
  // `providerEventId: undefined` explicitly.
  const providerMetadata = extractProviderEventMetadata(event) ?? {};

  const bookmakerPick = pickBookmaker(event);

  if (!bookmakerPick) {
    return { ...baseResult, ...providerMetadata, note: `No bookmaker odds available for "${bet.event}"` };
  }

  const price = extractOutcomePrice(bookmakerPick.bookmaker, bet.selection, event, bet.event);

  if (price === null) {
    return {
      ...baseResult,
      ...providerMetadata,
      bookmaker: bookmakerPick.bookmaker.title,
      note: `Could not match selection "${bet.selection}" to a bookmaker outcome`,
    };
  }

  // Step 15G — no odds were submitted to compare price against: every
  // branch above this point already returns before ever reaching here, so
  // a price is only ever promoted once a real event+bookmaker+outcome
  // match has genuinely succeeded — never fabricated on a failed lookup.
  // The provider's own found price is adopted as both sourceOdds and
  // submittedOdds, trivially "within tolerance" of itself (0% discrepancy,
  // nothing to disagree with). This promoted submittedOdds is an internal
  // compatibility value only — "the provider price proposed for player
  // confirmation" — never a price the player actually typed, and this
  // function has no caller yet that surfaces it as one (see this file's
  // own OddsVerificationInput comment: nothing wires this into the live
  // Mini App flow as of this step).
  if (bet.odds === null) {
    return {
      matched: true,
      withinTolerance: true,
      sourceOdds: price,
      submittedOdds: price,
      discrepancyPercent: 0,
      bookmaker: bookmakerPick.bookmaker.title,
      note: bookmakerPick.isFallback
        ? `Pinnacle odds unavailable — using ${bookmakerPick.bookmaker.title} instead`
        : null,
      ...providerMetadata,
    };
  }

  const discrepancyPercent = Number((((bet.odds - price) / price) * 100).toFixed(2));

  return {
    matched: true,
    withinTolerance: Math.abs(discrepancyPercent) <= ODDS_TOLERANCE_PERCENT,
    sourceOdds: price,
    submittedOdds: bet.odds,
    discrepancyPercent,
    bookmaker: bookmakerPick.bookmaker.title,
    note: bookmakerPick.isFallback
      ? `Pinnacle odds unavailable — using ${bookmakerPick.bookmaker.title} instead`
      : null,
    ...providerMetadata,
  };
}
