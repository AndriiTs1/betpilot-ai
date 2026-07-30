// Stage 10 — Sportmonks football vertical slice. A single, typed,
// isolated allowlist of Sportmonks league_ids BetPilot's Sportmonks path
// supports today — the same role lib/odds/discovery/supportedCompetitions.ts
// plays for The Odds API's sport_key, kept as a SEPARATE file rather than
// extended into that one: the two providers key competitions completely
// differently (sport_key strings vs numeric league_id), and
// supportedCompetitions.ts is explicitly out of scope for this stage.
//
// Every league_id below was confirmed against a real, authorized
// GET /v3/my/leagues call (Stage 9.4.1/9.4.3) plus GET /v3/football/leagues
// for Club Friendlies 1 (Stage 9.4.5) — none are guessed. Qualification
// rounds are NOT separate league_ids for Europa League/Conference League
// (confirmed live, Stage 9.4.1): they are a `stage` within the same
// league_id, so this allowlist is deliberately league-level only —
// stage/round filtering, if ever needed, happens downstream of this file.

export interface SupportedSportmonksLeague {
  readonly leagueId: number;
  readonly displayName: string;
}

const RAW_SUPPORTED_SPORTMONKS_LEAGUES: readonly SupportedSportmonksLeague[] = [
  { leagueId: 1101, displayName: "Club Friendlies 1" },
  { leagueId: 2, displayName: "UEFA Champions League" },
  { leagueId: 5, displayName: "UEFA Europa League" },
  { leagueId: 2286, displayName: "UEFA Europa Conference League" },
  { leagueId: 1328, displayName: "UEFA Super Cup" },
];

export const SUPPORTED_SPORTMONKS_LEAGUES: readonly SupportedSportmonksLeague[] = Object.freeze(
  RAW_SUPPORTED_SPORTMONKS_LEAGUES.map((league) => Object.freeze({ ...league })),
);

export function getSupportedSportmonksLeagueIds(): number[] {
  return SUPPORTED_SPORTMONKS_LEAGUES.map((l) => l.leagueId);
}

export function isSupportedSportmonksLeagueId(leagueId: number): boolean {
  return SUPPORTED_SPORTMONKS_LEAGUES.some((l) => l.leagueId === leagueId);
}

export function sportmonksLeagueDisplayName(leagueId: number): string | null {
  return SUPPORTED_SPORTMONKS_LEAGUES.find((l) => l.leagueId === leagueId)?.displayName ?? null;
}
