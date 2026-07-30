// Event Discovery Engine — Stage 7 (+ Stage 7.1). Team Alias Index: a
// deterministic, rule-based alias lookup built ENTIRELY on top of Stage
// 6's Team Index — never a second team database, never a second source of
// truth.
//
// Every entry this index returns is a direct reference to a TeamIndexEntry
// Team Index already owns — this file never constructs its own team
// record, never copies event data, never talks to Event Catalog directly
// (build() reaches it only by asking Team Index to build itself, exactly
// once, and reading whatever Team Index then holds).
//
// Two sources of alias strings, both keyed off the same canonical
// TeamIndexEntry references:
//   1. Canonical-generated — every TeamIndexEntry.canonicalName run through
//      generateAlias() (Stage 7). Always present for every team Team Index
//      currently has.
//   2. Curated (Stage 7.1) — lib/odds/discovery/teamAliases.ts's small,
//      hand-reviewed CURATED_TEAM_ALIASES list. A curated entry is only
//      ever activated when its canonicalTeamName, after the exact same
//      generateAlias() pipeline, matches a team ACTUALLY present in the
//      current Team Index build — a curated alias for a team that isn't
//      currently indexed contributes nothing, silently, every time.
//
// No fuzzy matching, no Levenshtein distance, no AI/embeddings, no
// guessing, and — same discipline as Stage 6 — no stripping of club-name
// tokens (FC/CF/AC/SSC/AFC/SC/Sporting/Club). The query passed to find()
// is normalized through the exact same pipeline as both alias sources
// above, so index-time and query-time aliasing can never drift apart.

import { teamIndex as defaultTeamIndex, type TeamIndexEntry, type TeamIndex, type BuildTeamIndexResult } from "./teamIndex";
import { CURATED_TEAM_ALIASES } from "./teamAliases";

// Structurally identical to Event Catalog's own GetEventCatalogOptions
// (Team Index's build() ultimately forwards this to it) — defined locally,
// not imported from ./eventCatalog, so this file never references Event
// Catalog even at the type level. TypeScript's structural typing makes
// this interchangeable with GetEventCatalogOptions at every call site
// below without an explicit dependency on that module.
export interface BuildTeamAliasIndexOptions {
  readonly forceRefresh?: boolean;
}

export interface TeamAliasIndexStats {
  // Distinct alias keys produced purely by normalizing every
  // TeamIndexEntry's own canonicalName — always present, one per distinct
  // normalized team name.
  readonly canonicalGeneratedAliasCount: number;
  // Distinct alias keys that came from CURATED_TEAM_ALIASES and were
  // actually activated (their canonical team was present) this build —
  // never counts an entry from the static registry file that was silently
  // skipped because its team wasn't in the current Team Index.
  readonly curatedAliasCount: number;
  // Distinct alias keys in the final map (canonical ∪ curated, a curated
  // string that happens to equal a canonical one is not double-counted).
  readonly totalAliasCount: number;
  // Number of alias keys whose bucket contains entries from more than one
  // DISTINCT canonicalName — a genuine, honestly-surfaced collision, never
  // silently resolved or ranked away.
  readonly aliasCollisionCount: number;
  // Total (alias -> entry) reference pairs across the whole map — can
  // exceed entryCount, since one TeamIndexEntry becomes reachable from
  // every alias that resolves to it (its own canonical alias plus however
  // many curated aliases point to it).
  readonly teamEntryReferenceCount: number;
  readonly builtAt: string | null;
  // Unchanged from Stage 7 — Team Index's own raw entry count, unaffected
  // by curated fan-out.
  readonly entryCount: number;
  readonly buildDurationMs: number;
  readonly dataSource: "TEAM_INDEX";
}

export type BuildTeamAliasIndexResult =
  | { readonly status: "SUCCESS"; readonly stats: TeamAliasIndexStats }
  | Extract<BuildTeamIndexResult, { status: "FAILED" }>;

export interface CreateTeamAliasIndexOptions {
  // Injected Team Index instance — defaults to Stage 6's shared singleton.
  // Only `build`/`getAllTeams` are used; tests supply a fake satisfying
  // this narrow shape, never a real TeamIndex wired to a real EventCatalog.
  readonly teamIndex?: Pick<TeamIndex, "build" | "getAllTeams">;
}

export interface TeamAliasIndex {
  build(options?: BuildTeamAliasIndexOptions): Promise<BuildTeamAliasIndexResult>;
  find(query: string): readonly TeamIndexEntry[];
  getAliases(): readonly string[];
  getStats(): TeamAliasIndexStats;
  clear(): void;
}

const EMPTY_STATS: TeamAliasIndexStats = {
  canonicalGeneratedAliasCount: 0,
  curatedAliasCount: 0,
  totalAliasCount: 0,
  aliasCollisionCount: 0,
  teamEntryReferenceCount: 0,
  builtAt: null,
  entryCount: 0,
  buildDurationMs: 0,
  dataSource: "TEAM_INDEX",
};

// The one, fixed, deterministic transformation pipeline this stage
// permits — applied identically to canonical-generated aliases, every
// curated alias string, EVERY curated entry's own canonicalTeamName (to
// decide whether it matches a currently-present team), and find()'s query,
// so none of the four can ever disagree. Order matters: character-level
// substitutions (periods/hyphens/"&") run first, on the NFKC-normalized
// string, before case-folding and whitespace collapsing.
function generateAlias(rawName: string): string {
  return rawName
    .normalize("NFKC")
    .replace(/\./g, "")
    .replace(/-/g, " ")
    .replace(/&/g, "and")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function addReference(map: Map<string, TeamIndexEntry[]>, alias: string, entry: TeamIndexEntry): void {
  const bucket = map.get(alias);
  if (bucket) {
    // Defensive: never let the exact same entry object appear twice in one
    // bucket (possible only if a curated alias string, once normalized,
    // happens to collide with the team's own canonical-generated alias).
    if (!bucket.includes(entry)) bucket.push(entry);
  } else {
    map.set(alias, [entry]);
  }
}

export function createTeamAliasIndex(options: CreateTeamAliasIndexOptions = {}): TeamAliasIndex {
  const teamIndexInstance = options.teamIndex ?? defaultTeamIndex;

  let aliasMap = new Map<string, TeamIndexEntry[]>();
  let stats: TeamAliasIndexStats = EMPTY_STATS;

  async function build(buildOptions: BuildTeamAliasIndexOptions = {}): Promise<BuildTeamAliasIndexResult> {
    const startedAt = Date.now();

    // Cascades exactly one level down — Team Index owns deciding whether
    // (and how) to reach Event Catalog; this file never touches Event
    // Catalog, an adapter, or the provider itself, directly or indirectly
    // beyond this one call.
    const teamIndexResult = await teamIndexInstance.build(buildOptions);

    if (teamIndexResult.status === "FAILED") {
      // Same "no silent empty rebuild" discipline as every prior stage —
      // the previous alias map (if any) is left completely untouched.
      return teamIndexResult;
    }

    const entries = teamIndexInstance.getAllTeams();

    // Step 1 — canonical-generated aliases, exactly as Stage 7 always did.
    const newAliasMap = new Map<string, TeamIndexEntry[]>();
    for (const entry of entries) {
      addReference(newAliasMap, generateAlias(entry.canonicalName), entry);
    }
    const canonicalGeneratedAliasCount = newAliasMap.size;

    // Step 2 — curated aliases (Stage 7.1). A curated entry activates only
    // when its own canonicalTeamName, normalized, matches a team the
    // canonical step above already found present — never adds a team,
    // never fabricates a TeamIndexEntry, and a curated entry for an absent
    // team contributes exactly zero alias keys.
    let curatedAliasCount = 0;
    for (const curated of CURATED_TEAM_ALIASES) {
      const canonicalAlias = generateAlias(curated.canonicalTeamName);
      const matchingEntries = newAliasMap.get(canonicalAlias);
      if (!matchingEntries || matchingEntries.length === 0) continue; // team not currently in Team Index — silently skipped

      for (const rawAlias of curated.aliases) {
        const normalizedAlias = generateAlias(rawAlias);
        const isNewAliasKey = !newAliasMap.has(normalizedAlias);
        for (const entry of matchingEntries) {
          addReference(newAliasMap, normalizedAlias, entry);
        }
        if (isNewAliasKey) curatedAliasCount += 1;
      }
    }

    // Collisions — an alias key whose final bucket spans more than one
    // DISTINCT canonicalName. Computed after both steps, over the final
    // map, so a curated alias that happens to bridge two different teams
    // is counted exactly like a canonical-only collision would be.
    let aliasCollisionCount = 0;
    let teamEntryReferenceCount = 0;
    for (const bucket of newAliasMap.values()) {
      teamEntryReferenceCount += bucket.length;
      const distinctCanonicalNames = new Set(bucket.map((e) => e.canonicalName));
      if (distinctCanonicalNames.size > 1) aliasCollisionCount += 1;
    }

    aliasMap = newAliasMap;
    const builtAt = new Date(startedAt).toISOString();
    stats = {
      canonicalGeneratedAliasCount,
      curatedAliasCount,
      totalAliasCount: aliasMap.size,
      aliasCollisionCount,
      teamEntryReferenceCount,
      builtAt,
      entryCount: entries.length,
      buildDurationMs: Date.now() - startedAt,
      dataSource: "TEAM_INDEX",
    };

    return { status: "SUCCESS", stats };
  }

  function find(query: string): readonly TeamIndexEntry[] {
    return aliasMap.get(generateAlias(query)) ?? [];
  }

  function getAliases(): readonly string[] {
    return Array.from(aliasMap.keys());
  }

  function getStats(): TeamAliasIndexStats {
    return stats;
  }

  function clear(): void {
    aliasMap = new Map();
    stats = EMPTY_STATS;
  }

  return { build, find, getAliases, getStats, clear };
}

// Shared default instance, for future stages (Candidate Resolver) to
// import — not consumed by any live route/component today.
export const teamAliasIndex: TeamAliasIndex = createTeamAliasIndex();
