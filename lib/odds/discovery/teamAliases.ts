// Event Discovery Engine — Stage 7.1. Curated Team Aliases: a small, hand-
// reviewed, purely CONFIGURATION list of extra alias strings for a handful
// of well-known clubs across the five supported domestic leagues — the
// real user-typed abbreviations/nicknames (PSG, Man Utd, MU, Bayern, a few
// Russian short names for Telegram) that no deterministic normalization
// rule (Stage 6/7) can ever produce on its own, because they are not
// mechanical transformations of the canonical name, they are genuinely
// different words.
//
// This file is NOT a team database. It has no opinion on whether a team
// currently exists anywhere — that is teamAliasIndex.ts's job at build()
// time (it looks up canonicalTeamName against the CURRENT Team Index and
// silently ignores any curated entry that isn't actually present). This
// file only ever supplies candidate strings; nothing here ever creates a
// TeamIndexEntry, stores an event, or asserts a team is real.
//
// Every canonicalTeamName below was verified against a real, live
// GET /v4/sports/{sportKey}/events call (2026-07-30) for the exact
// sport_keys these teams' leagues use — not guessed, not carried over
// unmodified from lib/odds/teamNameMatcher.ts's own (older, differently-
// cased) target strings, though that file's existing alias set was
// consulted as background context for WHICH clubs commonly need a
// Russian-language short name, per this stage's own instruction to treat
// it as information only, never as an import. One concrete correction that
// came out of checking live data instead of assuming: Paris Saint-Germain
// (with a hyphen) is the common written form, but The Odds API's actual
// event data returns "Paris Saint Germain" — no hyphen. Verified names:
//   soccer_epl:               Manchester United, Manchester City,
//                              Tottenham Hotspur, Chelsea, Arsenal, Liverpool
//   soccer_spain_la_liga:      Real Madrid, Barcelona, Atlético Madrid
//   soccer_italy_serie_a:      AC Milan, Inter Milan, Juventus
//   soccer_germany_bundesliga: Bayern Munich, Borussia Dortmund
//   soccer_france_ligue_one:   Paris Saint Germain
//
// Deliberately small (15 clubs, 27 alias strings) — only the clubs where a
// genuinely common, practically unambiguous short form/nickname/Russian
// name exists that current normalization cannot already produce. No bare,
// generic single words that collide across clubs (see the explicit
// exclusion list below) — "inter" is included ONLY as the full Russian
// word "интер", never the bare English word, and only because within this
// product's actual supported-competition scope (the five leagues + UEFA
// CL/CLQ/EL/ECL) there is exactly one "Inter"-named club reachable at all
// (Inter Miami plays in MLS, which this product does not index) — a real,
// scope-bounded fact, not an assumption.
//
// Explicitly NOT included, on purpose, because each is genuinely ambiguous
// across more than one real club in this product's own supported scope:
// "united" (Manchester United / Newcastle United / Leeds United all appear
// live), "city" (Manchester City alone today, but a bare single-word
// alias for a name this generic is refused on principle, not on today's
// snapshot), "sporting", "real" (Real Madrid / Atlético Madrid share the
// word "Real" in Spanish football branding), "athletic".

export interface CuratedAliasEntry {
  // Must match the provider's own raw team name exactly — this is looked
  // up against Team Index's canonicalName (via the same normalization
  // pipeline every other alias goes through), never assumed to exist.
  readonly canonicalTeamName: string;
  readonly aliases: readonly string[];
}

const RAW_CURATED_TEAM_ALIASES: readonly CuratedAliasEntry[] = [
  { canonicalTeamName: "Manchester United", aliases: ["man utd", "man united", "mu", "манчестер юнайтед"] },
  { canonicalTeamName: "Manchester City", aliases: ["man city", "манчестер сити"] },
  { canonicalTeamName: "Tottenham Hotspur", aliases: ["tottenham", "spurs", "тоттенхэм"] },
  { canonicalTeamName: "Chelsea", aliases: ["челси"] },
  { canonicalTeamName: "Arsenal", aliases: ["арсенал"] },
  { canonicalTeamName: "Liverpool", aliases: ["ливерпуль"] },
  { canonicalTeamName: "Real Madrid", aliases: ["реал мадрид"] },
  { canonicalTeamName: "Barcelona", aliases: ["barca", "барселона"] },
  { canonicalTeamName: "Atlético Madrid", aliases: ["atletico madrid", "атлетико мадрид"] },
  { canonicalTeamName: "AC Milan", aliases: ["милан"] },
  { canonicalTeamName: "Inter Milan", aliases: ["интер"] },
  { canonicalTeamName: "Juventus", aliases: ["juve", "ювентус"] },
  { canonicalTeamName: "Bayern Munich", aliases: ["bayern", "бавария"] },
  { canonicalTeamName: "Borussia Dortmund", aliases: ["dortmund", "боруссия дортмунд"] },
  { canonicalTeamName: "Paris Saint Germain", aliases: ["psg", "псж"] },
];

// Frozen at both the array and the per-entry (and per-entry-aliases-array)
// level — same discipline as Stage 2's SUPPORTED_COMPETITIONS — so this
// configuration can never be mutated at runtime by an importer.
export const CURATED_TEAM_ALIASES: readonly CuratedAliasEntry[] = Object.freeze(
  RAW_CURATED_TEAM_ALIASES.map((entry) => Object.freeze({ canonicalTeamName: entry.canonicalTeamName, aliases: Object.freeze([...entry.aliases]) })),
);
