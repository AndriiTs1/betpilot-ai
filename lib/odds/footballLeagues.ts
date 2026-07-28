// Step 16A — the single centralized football-league lookup table. Every
// file that needs "which of our supported football leagues does this name
// refer to" reads from here — never a second, independently-maintained
// alias list (legacyOddsBridge.ts's legacyFootballLeagueFromSportString and
// theOddsApiProvider.ts's league-support check both consume this same
// table). Provider-specific sport_key VALUES (e.g. "soccer_epl") are
// deliberately not modeled here — those stay entirely inside
// oddsVerifier.ts, matching the existing "provider-specific identifiers
// never leave the legacy/provider layer" discipline. This file only ever
// deals in legacySportString — the same human-readable legacy alias string
// oddsVerifier.ts's own SPORT_KEY_ALIASES table has always accepted (e.g.
// "la liga"), never a raw sport_key.

export interface FootballLeagueDefinition {
  // Canonical, human-readable display name — what CanonicalLeague.name
  // (lib/odds/domain.ts) and legacyOddsBridge.ts's reconstructed league
  // both use.
  readonly displayName: string;
  // The exact legacy sport string oddsVerifier.ts's SPORT_KEY_ALIASES
  // table recognizes for this league.
  readonly legacySportString: string;
}

// Every football competition this product currently supports. This list IS
// the closed set an explicit league name is validated against, and (via
// FOOTBALL_FALLBACK_LEGACY_SPORT_STRINGS below) the fallback set queried
// when no league is stated at all. Order carries no priority meaning —
// oddsVerifier.ts's own event matching flags a cross-league score tie as
// AMBIGUOUS_EVENT rather than silently preferring whichever league happens
// to be listed first here.
export const FOOTBALL_LEAGUES: readonly FootballLeagueDefinition[] = [
  { displayName: "Premier League", legacySportString: "premier league" },
  { displayName: "La Liga", legacySportString: "la liga" },
  { displayName: "Serie A", legacySportString: "serie a" },
  { displayName: "Bundesliga", legacySportString: "bundesliga" },
  { displayName: "Ligue 1", legacySportString: "ligue 1" },
  { displayName: "UEFA Champions League", legacySportString: "champions league" },
  // Provider-side, this is a distinct competition from the main tournament
  // above (The Odds API: soccer_uefa_champs_league_qualification vs.
  // soccer_uefa_champs_league) — a separate legacySportString so
  // oddsVerifier.ts's SPORT_KEY_ALIASES routes it to its own sport_key
  // rather than merging it into the main tournament's.
  {
    displayName: "UEFA Champions League Qualification",
    legacySportString: "champions league qualification",
  },
];

// Case-insensitive, whitespace-tolerant aliases -> this table's own
// displayName. Closed, exact lookup only (never fuzzy/substring matching)
// — same discipline as every other alias table in this codebase. Generic
// football/soccer aliases are deliberately absent — recognizing "football"
// itself as a "league" would fabricate specificity nobody stated; that
// case is the no-explicit-league fallback path instead (see
// FOOTBALL_FALLBACK_LEGACY_SPORT_STRINGS).
const FOOTBALL_LEAGUE_ALIASES: Readonly<Record<string, string>> = {
  "premier league": "Premier League",
  "english premier league": "Premier League",
  epl: "Premier League",
  "la liga": "La Liga",
  laliga: "La Liga",
  "serie a": "Serie A",
  seriea: "Serie A",
  bundesliga: "Bundesliga",
  "ligue 1": "Ligue 1",
  "ligue1": "Ligue 1",
  "champions league": "UEFA Champions League",
  "uefa champions league": "UEFA Champions League",
  ucl: "UEFA Champions League",
  "uefa champions league qualification": "UEFA Champions League Qualification",
  "champions league qualification": "UEFA Champions League Qualification",
  "ucl qualification": "UEFA Champions League Qualification",
  "champions league qualifiers": "UEFA Champions League Qualification",
  "лига чемпионов квалификация": "UEFA Champions League Qualification",
  "квалификация лиги чемпионов": "UEFA Champions League Qualification",
};

function normalizeLeagueAliasKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Looks up any recognized alias/display name against the closed table
// above. Returns null for anything not recognized — a real league this
// product simply doesn't support yet (e.g. "Eredivisie") and plain
// gibberish are treated identically here; callers own the
// supported-vs-unsupported distinction this makes possible (see
// theOddsApiProvider.ts's LEAGUE_NOT_SUPPORTED handling) — this function
// itself never fabricates a match.
export function resolveFootballLeague(name: string): FootballLeagueDefinition | null {
  const canonicalName = FOOTBALL_LEAGUE_ALIASES[normalizeLeagueAliasKey(name)];
  if (!canonicalName) return null;
  return FOOTBALL_LEAGUES.find((league) => league.displayName === canonicalName) ?? null;
}

// The exact legacy sport strings oddsVerifier.ts's SPORT_KEY_ALIASES table
// must merge-query when a football bet has no explicit, supported league —
// every currently supported competition, mirroring the existing tennis
// multi-key pattern (TENNIS_SPORT_KEYS) rather than defaulting to only
// Premier League.
export const FOOTBALL_FALLBACK_LEGACY_SPORT_STRINGS: readonly string[] = FOOTBALL_LEAGUES.map(
  (league) => league.legacySportString,
);
