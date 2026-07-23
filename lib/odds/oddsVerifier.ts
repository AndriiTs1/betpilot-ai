import type { OddsCheckResult } from "@/types/oddsSnapshot";

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
export interface OddsVerificationInput {
  sport: string;
  event: string;
  selection: string;
  odds: number;
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

const SPORT_KEY_ALIASES: Record<string, string | string[]> = {
  football: "soccer_epl",
  soccer: "soccer_epl",
  футбол: "soccer_epl",
  "premier league": "soccer_epl",
  "la liga": "soccer_spain_la_liga",
  "serie a": "soccer_italy_serie_a",
  bundesliga: "soccer_germany_bundesliga",
  "ligue 1": "soccer_france_ligue_one",
  "champions league": "soccer_uefa_champs_league",
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

// Small set of common clubs written in Russian, so "Реал Мадрид" resolves
// against The Odds API's "Real Madrid". Not exhaustive by design.
const TEAM_ALIASES: Record<string, string> = {
  "реал мадрид": "real madrid",
  барселона: "barcelona",
  "манчестер юнайтед": "manchester united",
  "манчестер сити": "manchester city",
  ливерпуль: "liverpool",
  челси: "chelsea",
  арсенал: "arsenal",
  тоттенхэм: "tottenham",
  бавария: "bayern munich",
  "боруссия дортмунд": "borussia dortmund",
  ювентус: "juventus",
  милан: "ac milan",
  интер: "inter milan",
  псж: "paris saint germain",
};

const DIACRITIC_REGEX = /[̀-ͯ]/g;

function normalizeTeamName(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const aliased = TEAM_ALIASES[lower] ?? lower;

  return aliased
    .normalize("NFD")
    .replace(DIACRITIC_REGEX, "") // strip accents (e.g. "México" -> "mexico")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EVENT_SEPARATOR_REGEX = /\s+(?:vs\.?|v\.?|-|–|—)\s+/i;

function splitEventTeams(event: string): [string, string] | null {
  const parts = event.split(EVENT_SEPARATOR_REGEX);
  return parts.length === 2 ? [parts[0].trim(), parts[1].trim()] : null;
}

function wordSet(s: string): Set<string> {
  return new Set(s.split(" ").filter(Boolean));
}

function overlapScore(a: string, b: string): number {
  const setA = wordSet(a);
  const setB = wordSet(b);

  if (setA.size === 0 || setB.size === 0) return 0;

  let common = 0;
  for (const word of setA) {
    if (setB.has(word)) common += 1;
  }

  return common / Math.max(setA.size, setB.size);
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
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

const EVENT_MATCH_THRESHOLD = 0.5;

function findMatchingEvent(events: OddsApiEvent[], betEvent: string): OddsApiEvent | null {
  const teams = splitEventTeams(betEvent);

  let best: { event: OddsApiEvent; score: number } | null = null;

  for (const event of events) {
    const home = normalizeTeamName(event.home_team);
    const away = normalizeTeamName(event.away_team);

    let score: number;

    if (teams) {
      const [t1, t2] = teams.map(normalizeTeamName);
      // Bet.event order (player's team1/team2) may not match the API's home/away order.
      const forward = (overlapScore(t1, home) + overlapScore(t2, away)) / 2;
      const backward = (overlapScore(t1, away) + overlapScore(t2, home)) / 2;
      score = Math.max(forward, backward);
    } else {
      score = overlapScore(normalizeTeamName(betEvent), `${home} ${away}`);
    }

    if (score >= EVENT_MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { event, score };
    }
  }

  return best?.event ?? null;
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
      const body = await response.text().catch(() => "");
      throw new Error(
        `The Odds API request failed with status ${response.status}${body ? `: ${body}` : ""}`,
      );
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
    try {
      events = events.concat(await fetchOddsForSport(sportKey));
      successCount += 1;
    } catch (err) {
      lastFetchError =
        err instanceof Error && err.name === "AbortError"
          ? `The Odds API request timed out after ${ODDS_API_TIMEOUT_MS}ms`
          : err instanceof Error
            ? err.message
            : "Unknown error calling The Odds API";
    }
  }

  if (successCount === 0 && lastFetchError) {
    return { ...baseResult, note: lastFetchError };
  }

  const event = findMatchingEvent(events, bet.event);

  if (!event) {
    return { ...baseResult, note: `No matching event found for "${bet.event}" in ${sportKeys.join(", ")}` };
  }

  const bookmakerPick = pickBookmaker(event);

  if (!bookmakerPick) {
    return { ...baseResult, note: `No bookmaker odds available for "${bet.event}"` };
  }

  const price = extractOutcomePrice(bookmakerPick.bookmaker, bet.selection, event, bet.event);

  if (price === null) {
    return {
      ...baseResult,
      bookmaker: bookmakerPick.bookmaker.title,
      note: `Could not match selection "${bet.selection}" to a bookmaker outcome`,
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
  };
}
