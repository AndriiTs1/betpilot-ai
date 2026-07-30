// Event Discovery Engine — Stage 5. Event Catalog: the aggregation layer
// that combines Stage 2 (supportedCompetitions.ts), Stage 3
// (leagueCatalog.ts), and Stage 4 (eventsAdapter.ts) into one in-memory
// cache of every currently-listed event across every supported football
// competition.
//
// No new domain model — every returned event is the exact, unmodified
// ProviderEventCandidate shape eventsAdapter.ts already produces
// (lib/odds/oddsProvider.ts). This file's own job is purely orchestration
// and caching: which sport_keys to ask for, how to combine what comes
// back, how long to trust the result before asking again. It has no
// concept of a player, a search query, or a team name — that is Team
// Index/Candidate Resolver's job, explicitly out of scope for this stage.
//
// Factory pattern (createEventCatalog), same convention as
// leagueCatalog.ts's createLeagueCatalog — every caller (including every
// test) gets a fully independent cache/clock/fetch-override, no
// module-level singleton state to leak between tests. A shared default
// instance is exported for future stages to import, not consumed by any
// live route/component yet.

import { fetchProviderEvents, type FetchProviderEventsInput, type EventsFetchResult } from "@/lib/odds/providers/theOddsApi/eventsAdapter";
import type { ProviderEventCandidate } from "@/lib/odds/oddsProvider";
import { getSupportedSportKeys } from "./supportedCompetitions";
import { leagueCatalog as defaultLeagueCatalog, type LeagueCatalog } from "./leagueCatalog";

// Stage 5 spec: 5-10 minutes. 5 minutes chosen as the default — events data
// (which fixtures exist, when they kick off) changes more often than the
// League Catalog's own "which competitions exist at all" (Stage 3's 24h),
// but still far slower than odds prices; this is the same class of
// initial operational value as every other TTL constant in this codebase,
// not a measured one.
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface EventCatalogStats {
  readonly competitionCount: number;
  readonly eventCount: number;
  readonly lastUpdatedAt: string | null;
  readonly failedLoadCount: number;
}

export type EventCatalogFailureReason = "ALL_LEAGUES_UNAVAILABLE";

export type EventCatalogResult =
  | {
      readonly status: "SUCCESS";
      readonly entries: readonly ProviderEventCandidate[];
      // sport_keys we attempted via eventsAdapter and that came back FAILED
      // — distinct from skippedSportKeys below (never even attempted).
      readonly failedSportKeys: readonly string[];
      // Allowlisted sport_keys League Catalog reported as missing from the
      // live provider catalog — never sent to eventsAdapter at all, since
      // there is nothing there to fetch (Stage 3's validateAllowlist()).
      readonly skippedSportKeys: readonly string[];
      readonly fromCache: boolean;
    }
  | { readonly status: "FAILED"; readonly reason: EventCatalogFailureReason };

export interface GetEventCatalogOptions {
  readonly forceRefresh?: boolean;
}

export interface CreateEventCatalogOptions {
  readonly ttlMs?: number;
  // Same DI convention as leagueCatalog.ts's own `now` option.
  readonly now?: () => number;
  // Injected so tests never make a real network call — defaults to the
  // real adapter.
  readonly fetchEvents?: (input: FetchProviderEventsInput) => Promise<EventsFetchResult>;
  // Injected League Catalog instance — defaults to Stage 3's shared
  // singleton. Tests supply their own isolated instance (via
  // createLeagueCatalog()) so League Catalog state never leaks between
  // Event Catalog tests either.
  readonly leagueCatalog?: LeagueCatalog;
}

export interface EventCatalog {
  getCatalog(options?: GetEventCatalogOptions): Promise<EventCatalogResult>;
  clearCache(): void;
  getStats(): EventCatalogStats;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly entries: readonly ProviderEventCandidate[];
  readonly failedSportKeys: readonly string[];
  readonly skippedSportKeys: readonly string[];
}

const EMPTY_STATS: EventCatalogStats = {
  competitionCount: 0,
  eventCount: 0,
  lastUpdatedAt: null,
  failedLoadCount: 0,
};

// Defensive de-duplication by providerEventId — the same real-world event
// should never appear twice, but this is enforced here rather than assumed
// from "each sport_key's events are naturally distinct," the same
// "don't trust structure you haven't verified" discipline
// oddsVerifier.ts's own dedupeEventsSemantically already applies to a
// related, real provider data-quality quirk. First occurrence wins; later
// duplicates are silently dropped, never merged.
function dedupeByProviderEventId(candidates: readonly ProviderEventCandidate[]): ProviderEventCandidate[] {
  const seen = new Set<string>();
  const deduped: ProviderEventCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.reference.eventId)) continue;
    seen.add(candidate.reference.eventId);
    deduped.push(candidate);
  }

  return deduped;
}

export function createEventCatalog(options: CreateEventCatalogOptions = {}): EventCatalog {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const fetchEvents = options.fetchEvents ?? fetchProviderEvents;
  const leagueCatalogInstance = options.leagueCatalog ?? defaultLeagueCatalog;

  let cache: CacheEntry | null = null;
  // Deliberately separate from `cache` — stats describe the last
  // SUCCESSFUL load specifically (never updated on a cache-hit read, never
  // updated on a FAILED attempt), so a caller can always answer "what do
  // we currently know" even while a fresh (possibly failing) reload is in
  // flight or just failed.
  let stats: EventCatalogStats = EMPTY_STATS;

  async function getCatalog(getOptions: GetEventCatalogOptions = {}): Promise<EventCatalogResult> {
    const currentTime = now();

    if (!getOptions.forceRefresh && cache && cache.expiresAt > currentTime) {
      return {
        status: "SUCCESS",
        entries: cache.entries,
        failedSportKeys: cache.failedSportKeys,
        skippedSportKeys: cache.skippedSportKeys,
        fromCache: true,
      };
    }

    const supportedSportKeys = getSupportedSportKeys();

    // League Catalog is a pre-filter, not a hard gate: if it can't be
    // reached at all, Event Catalog fails OPEN — every supported sport_key
    // is still attempted directly via eventsAdapter, which has its own
    // independent success/failure per key. A League Catalog outage must
    // never, by itself, take down event discovery for competitions whose
    // /events endpoint is working fine.
    const validation = await leagueCatalogInstance.validateAllowlist(
      getOptions.forceRefresh ? { forceRefresh: true } : {},
    );

    let sportKeysToFetch: readonly string[];
    let skippedSportKeys: readonly string[];

    if (validation.status === "SUCCESS") {
      const missing = new Set(validation.missingSportKeys);
      sportKeysToFetch = supportedSportKeys.filter((key) => !missing.has(key));
      skippedSportKeys = validation.missingSportKeys;
    } else {
      sportKeysToFetch = supportedSportKeys;
      skippedSportKeys = [];
    }

    // Unbounded parallel fetch — nine supported competitions today (Stage
    // 2), all free (/events) calls; no concurrency limiter is warranted at
    // this scale (mirrors this codebase's own "don't build ahead of
    // evidence" convention — OddsVerificationService's bounded pool exists
    // specifically because EXPRESS legs can reach 10 PAID calls, a
    // different cost profile entirely).
    const perLeagueResults = await Promise.all(
      sportKeysToFetch.map(async (sportKey) => ({ sportKey, result: await fetchEvents({ sportKey }) })),
    );

    const collected: ProviderEventCandidate[] = [];
    const failedSportKeys: string[] = [];

    for (const { sportKey, result } of perLeagueResults) {
      if (result.status === "SUCCESS") {
        collected.push(...result.results);
      } else {
        failedSportKeys.push(sportKey);
      }
    }

    const successfulLeagueCount = sportKeysToFetch.length - failedSportKeys.length;

    // Covers both "we attempted N leagues and every single one failed" and
    // "League Catalog said every supported key is missing, so nothing was
    // even attempted" — either way, zero leagues actually succeeded, so
    // there is nothing honest to cache or report as a catalog snapshot.
    // The previous cache/stats (if any) are left completely untouched —
    // same "no silent stale-serving" policy leagueCatalog.ts's own
    // getCatalog() already established, applied consistently here.
    if (successfulLeagueCount === 0) {
      return { status: "FAILED", reason: "ALL_LEAGUES_UNAVAILABLE" };
    }

    const entries = dedupeByProviderEventId(collected);

    cache = { expiresAt: currentTime + ttlMs, entries, failedSportKeys, skippedSportKeys };
    stats = {
      competitionCount: successfulLeagueCount,
      eventCount: entries.length,
      lastUpdatedAt: new Date(currentTime).toISOString(),
      failedLoadCount: failedSportKeys.length,
    };

    return { status: "SUCCESS", entries, failedSportKeys, skippedSportKeys, fromCache: false };
  }

  function clearCache(): void {
    cache = null;
    stats = EMPTY_STATS;
  }

  function getStats(): EventCatalogStats {
    return stats;
  }

  return { getCatalog, clearCache, getStats };
}

// Shared default instance, for future stages (Team Index, Candidate
// Resolver) to import — not consumed by any live route/component today.
export const eventCatalog: EventCatalog = createEventCatalog();
