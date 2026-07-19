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
const SPORT_KEY_ALIASES: Record<string, string> = {
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
};

function getSportKey(sport: string): string | null {
  return SPORT_KEY_ALIASES[sport.toLowerCase().trim()] ?? null;
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

function extractOutcomePrice(bookmaker: OddsApiBookmaker, selection: string): number | null {
  const market = bookmaker.markets.find((m) => m.key === "h2h");
  if (!market) return null;

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

  const sportKey = getSportKey(bet.sport);

  if (!sportKey) {
    return { ...baseResult, note: `Sport/league "${bet.sport}" is not mapped to a The Odds API sport_key` };
  }

  let events: OddsApiEvent[];

  try {
    events = await fetchOddsForSport(sportKey);
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `The Odds API request timed out after ${ODDS_API_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : "Unknown error calling The Odds API";

    return { ...baseResult, note: message };
  }

  const event = findMatchingEvent(events, bet.event);

  if (!event) {
    return { ...baseResult, note: `No matching event found for "${bet.event}" in ${sportKey}` };
  }

  const bookmakerPick = pickBookmaker(event);

  if (!bookmakerPick) {
    return { ...baseResult, note: `No bookmaker odds available for "${bet.event}"` };
  }

  const price = extractOutcomePrice(bookmakerPick.bookmaker, bet.selection);

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
