// Stage 10 — wires a SECOND INSTANCE of the existing Discovery Engine
// (Team Index, Team Alias Index, Candidate Resolver — all created via
// their own existing factories, zero new resolution logic) to Sportmonks
// as its data source, instead of The Odds API's Event Catalog. This is not
// a second Discovery Engine: every layer's code is 100% reused; only the
// data source plugged into Team Index's own existing DI seam
// (Pick<EventCatalog, "getCatalog">) is new. The original
// lib/odds/discovery/{teamIndex,teamAliasIndex,candidateResolver}.ts
// default singletons (The Odds API-backed) are completely untouched and
// keep serving everything else (e.g. Telegram /find).

import { createTeamIndex } from "./teamIndex";
import { createTeamAliasIndex } from "./teamAliasIndex";
import { createCandidateResolver, type CandidateResolver } from "./candidateResolver";
import type { EventCatalogResult, GetEventCatalogOptions } from "./eventCatalog";
import {
  fetchSportmonksFixtures,
  toProviderEventCandidate,
  type FetchSportmonksFixturesOptions,
} from "@/lib/odds/providers/sportmonks/sportmonksFixturesAdapter";

// Same TTL as Event Catalog's own DEFAULT_TTL_MS (lib/odds/discovery/eventCatalog.ts)
// — no evidence Sportmonks fixture data needs a different cache lifetime.
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface SportmonksEventSource {
  getCatalog(options?: GetEventCatalogOptions): Promise<EventCatalogResult>;
  clearCache(): void;
}

export interface CreateSportmonksEventSourceOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly fetchFixtures?: (options: FetchSportmonksFixturesOptions) => ReturnType<typeof fetchSportmonksFixtures>;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly entries: ReturnType<typeof toProviderEventCandidate>[];
}

// Satisfies Team Index's existing Pick<EventCatalog, "getCatalog"> DI seam
// — same "no silent stale-serving, no silent empty rebuild" TTL-cache
// discipline as the real Event Catalog. The FAILED reason is reused as
// "ALL_LEAGUES_UNAVAILABLE" (the only literal EventCatalogFailureReason
// permits) even though nothing here is about sport_keys — deliberately not
// widening that shared type for one caller; the real failure detail is
// still available via the underlying fetchSportmonksFixtures() call this
// wraps, for anything that needs it directly.
export function createSportmonksEventSource(options: CreateSportmonksEventSourceOptions = {}): SportmonksEventSource {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const fetchFixtures = options.fetchFixtures ?? fetchSportmonksFixtures;

  let cache: CacheEntry | null = null;

  async function getCatalog(getOptions: GetEventCatalogOptions = {}): Promise<EventCatalogResult> {
    const currentTime = now();

    if (!getOptions.forceRefresh && cache && cache.expiresAt > currentTime) {
      return { status: "SUCCESS", entries: cache.entries, failedSportKeys: [], skippedSportKeys: [], fromCache: true };
    }

    const result = await fetchFixtures({ now });
    if (result.status === "FAILED") {
      return { status: "FAILED", reason: "ALL_LEAGUES_UNAVAILABLE" };
    }

    const entries = result.results.map(toProviderEventCandidate);
    cache = { expiresAt: currentTime + ttlMs, entries };
    return { status: "SUCCESS", entries, failedSportKeys: [], skippedSportKeys: [], fromCache: false };
  }

  function clearCache(): void {
    cache = null;
  }

  return { getCatalog, clearCache };
}

export interface CreateSportmonksFootballResolverOptions {
  readonly eventSource?: Pick<SportmonksEventSource, "getCatalog">;
}

// Not a new resolver implementation — createCandidateResolver/createTeamIndex/
// createTeamAliasIndex are the exact same Stage 6-8 factories every other
// resolver instance in this codebase uses, just given a fresh, isolated
// Sportmonks-backed data source instead of The Odds API's.
export function createSportmonksFootballCandidateResolver(
  options: CreateSportmonksFootballResolverOptions = {},
): CandidateResolver {
  const eventSource = options.eventSource ?? createSportmonksEventSource();
  const footballTeamIndex = createTeamIndex({ eventCatalog: eventSource });
  const footballTeamAliasIndex = createTeamAliasIndex({ teamIndex: footballTeamIndex });
  return createCandidateResolver({ teamIndex: footballTeamIndex, teamAliasIndex: footballTeamAliasIndex });
}

// Shared default instance — the one the Stage 10 preview builder actually
// uses. Independent of, and never shared with, the default
// The-Odds-API-backed candidateResolver singleton.
export const sportmonksFootballCandidateResolver: CandidateResolver = createSportmonksFootballCandidateResolver();
