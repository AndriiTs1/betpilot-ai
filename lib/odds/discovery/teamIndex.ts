// Event Discovery Engine — Stage 6. Team Index: a local, in-memory index of
// every team name that currently appears in Stage 5's Event Catalog — home
// and away participants only, nothing else.
//
// Single source of truth: Event Catalog. No static roster, no historical
// club list, no lib/odds/footballLeagues.ts, no external lookup of any
// kind — a team that isn't currently home or away in some Event Catalog
// entry simply does not exist in this index. This is deliberate: the whole
// point of Stage 2-5's move away from hand-maintained tables was to stop
// needing one; reintroducing a static team list here would be exactly that
// mistake one layer down.
//
// No fuzzy matching, no aliasing, no name normalization beyond the four
// deterministic rules Stage 6 specifies (lowercase, trim, collapse
// whitespace, NFKC). In particular, club-name tokens like "FC"/"CF"/"AC"/
// "SSC" are never stripped — that kind of heavier, judgment-call
// normalization is explicitly Stage 7 (Team Alias Index)'s job, not this
// one's. lib/odds/teamNameMatcher.ts is deliberately NOT reused here even
// though it also "normalizes team names" — its normalizeTeamName() does
// Cyrillic transliteration and a small hand-curated alias lookup, both of
// which this stage explicitly forbids reintroducing. Reusing it would
// silently violate that boundary, so this file defines its own, narrower
// normalizeTeamNameForIndex() instead.
//
// Factory pattern (createTeamIndex), same convention as every prior
// Discovery Engine stage — independent state per instance, DI for the
// injected EventCatalog dependency so tests never touch the real network.

import type { ProviderEventCandidate, ProviderName } from "@/lib/odds/oddsProvider";
import { eventCatalog as defaultEventCatalog, type EventCatalog, type EventCatalogFailureReason, type GetEventCatalogOptions } from "./eventCatalog";

export type TeamRole = "HOME" | "AWAY";

export interface TeamIndexEntry {
  // The team name exactly as the provider returned it (event.home/away) —
  // never modified, never re-cased. "Canonical" here means "the one real
  // name Event Catalog actually carries for this occurrence," not a
  // resolved/deduplicated identity across spelling variants — that
  // resolution is explicitly Stage 7's job, not this one's.
  readonly canonicalName: string;
  readonly normalizedName: string;
  // Stage 10 — which provider this occurrence came from. Combined with
  // providerEventId this forms the real, composite event identity
  // (provider, providerEventId): providerEventId alone is only unique
  // within one provider's own ID namespace, never guaranteed unique across
  // providers (see lib/odds/discovery/candidateResolver.ts's own
  // composite-key joins, which this field exists to support).
  readonly provider: ProviderName;
  readonly providerEventId: string;
  readonly sportKey: string;
  readonly league: string | null;
  readonly role: TeamRole;
}

export interface TeamIndexStats {
  readonly uniqueTeamCount: number;
  readonly entryCount: number;
  readonly homeCount: number;
  readonly awayCount: number;
  readonly buildDurationMs: number;
  readonly dataSource: "EVENT_CATALOG";
}

export type BuildTeamIndexResult =
  | { readonly status: "SUCCESS"; readonly stats: TeamIndexStats }
  | { readonly status: "FAILED"; readonly reason: EventCatalogFailureReason };

export interface CreateTeamIndexOptions {
  // Injected EventCatalog instance — defaults to Stage 5's shared
  // singleton. Tests supply their own fake (an object satisfying this
  // narrow shape, not a real EventCatalog instance) so no real network
  // call is ever reachable from this file.
  readonly eventCatalog?: Pick<EventCatalog, "getCatalog">;
}

export interface TeamIndex {
  build(options?: GetEventCatalogOptions): Promise<BuildTeamIndexResult>;
  findExact(canonicalName: string): readonly TeamIndexEntry[];
  findNormalized(name: string): readonly TeamIndexEntry[];
  getAllTeams(): readonly TeamIndexEntry[];
  getStats(): TeamIndexStats;
  clear(): void;
}

const EMPTY_STATS: TeamIndexStats = {
  uniqueTeamCount: 0,
  entryCount: 0,
  homeCount: 0,
  awayCount: 0,
  buildDurationMs: 0,
  dataSource: "EVENT_CATALOG",
};

// The four deterministic rules Stage 6 specifies, in this exact order:
// Unicode NFKC first (canonicalizes compatibility variants — full-width
// characters, certain ligatures — into their standard form before any
// case/whitespace handling touches them), then trim, then lowercase, then
// collapse internal whitespace runs to a single space. No transliteration,
// no diacritic stripping, no token removal — deliberately narrower than
// lib/odds/teamNameMatcher.ts's normalizeTeamName() (see file header).
function normalizeTeamNameForIndex(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function extractEntriesFromCandidate(candidate: ProviderEventCandidate): TeamIndexEntry[] {
  const { event, reference } = candidate;
  const homeIndex = event.homeParticipantIndex ?? 0;
  const awayIndex = event.awayParticipantIndex ?? 1;
  const home = event.participants[homeIndex];
  const away = event.participants[awayIndex];

  // Defensive — every real ProviderEventCandidate produced by Stage 4's
  // eventsAdapter.ts always has exactly two participants at indices 0/1,
  // but this function must not assume a producer it doesn't control always
  // will. An entry missing either side contributes nothing rather than a
  // half-built, misleading record.
  if (!home || !away) return [];

  const sportKey = reference.sportKey ?? "";
  const league = event.league?.name ?? null;

  return [
    {
      canonicalName: home.name,
      normalizedName: normalizeTeamNameForIndex(home.name),
      provider: reference.provider,
      providerEventId: reference.eventId,
      sportKey,
      league,
      role: "HOME",
    },
    {
      canonicalName: away.name,
      normalizedName: normalizeTeamNameForIndex(away.name),
      provider: reference.provider,
      providerEventId: reference.eventId,
      sportKey,
      league,
      role: "AWAY",
    },
  ];
}

export function createTeamIndex(options: CreateTeamIndexOptions = {}): TeamIndex {
  const eventCatalogInstance = options.eventCatalog ?? defaultEventCatalog;

  let entries: TeamIndexEntry[] = [];
  let byCanonicalName = new Map<string, TeamIndexEntry[]>();
  let byNormalizedName = new Map<string, TeamIndexEntry[]>();
  let stats: TeamIndexStats = EMPTY_STATS;

  function indexBy<K>(list: readonly TeamIndexEntry[], keyOf: (entry: TeamIndexEntry) => K): Map<K, TeamIndexEntry[]> {
    const map = new Map<K, TeamIndexEntry[]>();
    for (const entry of list) {
      const key = keyOf(entry);
      const bucket = map.get(key);
      if (bucket) bucket.push(entry);
      else map.set(key, [entry]);
    }
    return map;
  }

  async function build(buildOptions: GetEventCatalogOptions = {}): Promise<BuildTeamIndexResult> {
    const startedAt = Date.now();
    const catalogResult = await eventCatalogInstance.getCatalog(buildOptions);

    if (catalogResult.status === "FAILED") {
      // Explicit, typed failure — the previous index (if any) is left
      // completely untouched. Never silently replaced with an empty
      // index just because the source couldn't be reached this time.
      return { status: "FAILED", reason: catalogResult.reason };
    }

    const newEntries = catalogResult.entries.flatMap(extractEntriesFromCandidate);

    entries = newEntries;
    byCanonicalName = indexBy(entries, (e) => e.canonicalName);
    byNormalizedName = indexBy(entries, (e) => e.normalizedName);

    const uniqueTeamCount = new Set(entries.map((e) => e.normalizedName)).size;
    const homeCount = entries.filter((e) => e.role === "HOME").length;
    const awayCount = entries.filter((e) => e.role === "AWAY").length;

    stats = {
      uniqueTeamCount,
      entryCount: entries.length,
      homeCount,
      awayCount,
      buildDurationMs: Date.now() - startedAt,
      dataSource: "EVENT_CATALOG",
    };

    return { status: "SUCCESS", stats };
  }

  function findExact(canonicalName: string): readonly TeamIndexEntry[] {
    return byCanonicalName.get(canonicalName) ?? [];
  }

  function findNormalized(name: string): readonly TeamIndexEntry[] {
    return byNormalizedName.get(normalizeTeamNameForIndex(name)) ?? [];
  }

  function getAllTeams(): readonly TeamIndexEntry[] {
    return entries;
  }

  function getStats(): TeamIndexStats {
    return stats;
  }

  function clear(): void {
    entries = [];
    byCanonicalName = new Map();
    byNormalizedName = new Map();
    stats = EMPTY_STATS;
  }

  return { build, findExact, findNormalized, getAllTeams, getStats, clear };
}

// Shared default instance, for future stages (Team Alias Index, Candidate
// Resolver) to import — not consumed by any live route/component today.
export const teamIndex: TeamIndex = createTeamIndex();
