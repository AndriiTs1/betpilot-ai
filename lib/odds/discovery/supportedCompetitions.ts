// Event Discovery Engine — Stage 2. A single, typed, isolated source of
// truth for which football competitions BetPilot supports today, keyed by
// the provider's own sport_key rather than a human-typed league name.
//
// This file is deliberately NOT wired into anything yet — no route,
// component, or live odds-verification file imports it (verified by
// supportedCompetitions.test.ts's own repo-scan test). It exists so later
// stages (League/Event Catalog, Candidate Resolver) have one place to read
// "which sport_keys are we allowed to index," instead of each layer
// re-deciding it independently.
//
// Every sportKey below was confirmed against a real, authorized
// GET /v4/sports call (2026-07-30) — none are guessed by naming pattern.
// The full raw response (174 entries across every sport The Odds API
// offers) was filtered to Soccer and cross-checked field-by-field; the
// values here are the provider's own `key`/`title` strings verbatim, not
// derived from footballLeagues.ts's existing (also-correct, independently
// verified in earlier stages) table. displayName follows the same
// human-readable convention lib/odds/footballLeagues.ts's FOOTBALL_LEAGUES
// table already uses, extended with the two newly-approved competitions.
//
// active (whether the provider currently lists live fixtures for a key) is
// deliberately NOT modeled here — allowlist membership is a product
// decision ("do we support this competition at all"), independent of
// whether it happens to be in season right now. Confirmed at fetch time:
// soccer_uefa_champs_league_qualification was active:true, soccer_epl/
// soccer_spain_la_liga/soccer_italy_serie_a/soccer_germany_bundesliga/
// soccer_france_ligue_one active:true, soccer_uefa_champs_league/
// soccer_uefa_europa_league/soccer_uefa_europa_conference_league
// active:false at the moment of the check (out of season) — all nine are
// still real, valid, queryable sport_keys either way.

import type { Sport } from "@/lib/odds/domain";

export interface SupportedCompetition {
  readonly sportKey: string;
  readonly sport: Sport;
  readonly displayName: string;
}

const RAW_SUPPORTED_COMPETITIONS: readonly SupportedCompetition[] = [
  { sportKey: "soccer_epl", sport: "FOOTBALL", displayName: "Premier League" },
  { sportKey: "soccer_spain_la_liga", sport: "FOOTBALL", displayName: "La Liga" },
  { sportKey: "soccer_italy_serie_a", sport: "FOOTBALL", displayName: "Serie A" },
  { sportKey: "soccer_germany_bundesliga", sport: "FOOTBALL", displayName: "Bundesliga" },
  { sportKey: "soccer_france_ligue_one", sport: "FOOTBALL", displayName: "Ligue 1" },
  { sportKey: "soccer_uefa_champs_league", sport: "FOOTBALL", displayName: "UEFA Champions League" },
  {
    sportKey: "soccer_uefa_champs_league_qualification",
    sport: "FOOTBALL",
    displayName: "UEFA Champions League Qualification",
  },
  { sportKey: "soccer_uefa_europa_league", sport: "FOOTBALL", displayName: "UEFA Europa League" },
  {
    sportKey: "soccer_uefa_europa_conference_league",
    sport: "FOOTBALL",
    displayName: "UEFA Europa Conference League",
  },
];

// Frozen at both the array and the per-entry level — `readonly` in the type
// only prevents mistakes at compile time; a caller with a type-unsafe
// reference (or a test deliberately checking this) could otherwise still
// mutate the array/objects at runtime. Object.freeze() makes that
// impossible in both strict and non-strict mode (a mutation attempt throws
// under "use strict", which ES modules always are, or silently no-ops
// otherwise — either way, the list itself can never actually change).
export const SUPPORTED_COMPETITIONS: readonly SupportedCompetition[] = Object.freeze(
  RAW_SUPPORTED_COMPETITIONS.map((competition) => Object.freeze({ ...competition })),
);

// sport omitted -> every supported competition's sportKey, regardless of
// sport. Provided (even though every entry today is FOOTBALL) because this
// allowlist's own shape must not assume football is the only sport it will
// ever hold — adding a basketball/tennis/hockey competition later must
// never require changing this function's signature.
export function getSupportedSportKeys(sport?: Sport): string[] {
  const entries = sport === undefined ? SUPPORTED_COMPETITIONS : SUPPORTED_COMPETITIONS.filter((c) => c.sport === sport);
  return entries.map((c) => c.sportKey);
}

export function isSupportedSportKey(key: string): boolean {
  return SUPPORTED_COMPETITIONS.some((c) => c.sportKey === key);
}
