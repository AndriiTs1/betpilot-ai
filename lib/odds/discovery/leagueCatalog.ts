// Event Discovery Engine — Stage 3. League Catalog: fetches and caches the
// FULL provider sports catalog (via sportsCatalogAdapter.ts, unfiltered —
// every competition the provider offers, not only the ones in our
// allowlist), and cross-checks it against Stage 2's
// lib/odds/discovery/supportedCompetitions.ts allowlist.
//
// Deliberately caches the whole catalog, not a filtered subset: League
// Catalog's own purpose (per this stage's spec) includes being able to
// honestly tell a player "this competition exists at the provider, we just
// don't support it yet" later — that requires having actually seen it, not
// just the ones we already chose to support.
//
// No matching/search logic, no Event Catalog, no Team Index, no Candidate
// Resolver, no new API route — this file only answers two questions: "what
// does the provider currently offer" and "does our allowlist still line up
// with that." Nothing in this file is imported by any live route/component
// yet.
//
// Factory pattern (createLeagueCatalog), not a bare module-level singleton
// — mirrors lib/rateLimit/requestRateLimiter.ts's createRequestRateLimiter:
// every caller (including every test) gets its own fully independent
// cache/clock/fetch-override, with zero risk of state leaking between
// tests or callers. A shared default instance is exported below for future
// stages to import, matching the same "module-level default, DI override
// for tests" convention already used throughout lib/odds/ and lib/bets/
// (e.g. buildBetSlipPreview.ts's defaultOddsVerificationService).

import {
  fetchProviderSportsCatalog,
  type ProviderSportEntry,
  type SportsCatalogFetchFailureReason,
} from "@/lib/odds/providers/theOddsApi/sportsCatalogAdapter";
import { getSupportedSportKeys } from "./supportedCompetitions";

// Stage 3 spec: 12-24h. 24h chosen as the default — the sports catalog
// (which competitions exist at all) changes on the order of days/weeks,
// never minute-to-minute; a shorter TTL would only add unnecessary refetch
// traffic to a free endpoint without any real freshness benefit. An
// initial operational value, not a measured one — revisit if evidence
// (e.g. a competition added mid-cycle that we needed to see sooner) ever
// suggests otherwise.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type LeagueCatalogResult =
  | { readonly status: "SUCCESS"; readonly entries: readonly ProviderSportEntry[]; readonly fromCache: boolean }
  | { readonly status: "FAILED"; readonly reason: SportsCatalogFetchFailureReason };

export type ValidateAllowlistResult =
  | { readonly status: "SUCCESS"; readonly missingSportKeys: readonly string[]; readonly checkedAt: string }
  | { readonly status: "FAILED"; readonly reason: SportsCatalogFetchFailureReason };

export interface GetLeagueCatalogOptions {
  readonly forceRefresh?: boolean;
}

export interface CreateLeagueCatalogOptions {
  readonly ttlMs?: number;
  // Injected clock, same convention as lib/telegram/oddsCommand.ts's own
  // `now` option — lets tests control TTL expiry deterministically instead
  // of waiting out real wall-clock time.
  readonly now?: () => number;
  // Injected fetch function, same DI shape used throughout this codebase
  // (e.g. buildBetSlipPreview.ts's verifyOddsFn) — defaults to the real
  // adapter; tests supply a fake so no real network call is ever made.
  readonly fetchCatalog?: typeof fetchProviderSportsCatalog;
}

export interface LeagueCatalog {
  getCatalog(options?: GetLeagueCatalogOptions): Promise<LeagueCatalogResult>;
  validateAllowlist(options?: GetLeagueCatalogOptions): Promise<ValidateAllowlistResult>;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly entries: readonly ProviderSportEntry[];
}

export function createLeagueCatalog(options: CreateLeagueCatalogOptions = {}): LeagueCatalog {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const fetchCatalog = options.fetchCatalog ?? fetchProviderSportsCatalog;

  let cache: CacheEntry | null = null;

  async function getCatalog(getOptions: GetLeagueCatalogOptions = {}): Promise<LeagueCatalogResult> {
    const currentTime = now();

    if (!getOptions.forceRefresh && cache && cache.expiresAt > currentTime) {
      return { status: "SUCCESS", entries: cache.entries, fromCache: true };
    }

    const result = await fetchCatalog();
    if (result.status === "FAILED") {
      // No stale-cache fallback on a fetch failure — an honest FAILED
      // result is returned rather than silently serving a possibly very
      // old cached catalog. A stale-if-error policy is a real, separate
      // product decision this stage does not make.
      return result;
    }

    cache = { expiresAt: currentTime + ttlMs, entries: result.results };
    return { status: "SUCCESS", entries: result.results, fromCache: false };
  }

  async function validateAllowlist(validateOptions: GetLeagueCatalogOptions = {}): Promise<ValidateAllowlistResult> {
    const catalogResult = await getCatalog(validateOptions);
    if (catalogResult.status === "FAILED") {
      return catalogResult;
    }

    const catalogKeys = new Set(catalogResult.entries.map((entry) => entry.sportKey));
    const missingSportKeys = getSupportedSportKeys().filter((sportKey) => !catalogKeys.has(sportKey));

    // Explicit, safe log — sport_key strings only, never a raw provider
    // payload, URL, or API key. Matches this codebase's established
    // "structured, content-bounded logging" discipline
    // (lib/logging/structuredLog.ts's own odds_* events).
    if (missingSportKeys.length > 0) {
      console.error("leagueCatalog: allowlisted sport_key(s) missing from the live provider catalog:", missingSportKeys);
    }

    return { status: "SUCCESS", missingSportKeys, checkedAt: new Date(now()).toISOString() };
  }

  return { getCatalog, validateAllowlist };
}

// Shared default instance, for future stages to import — not consumed by
// any live route/component today (verified by leagueCatalog.test.ts's own
// isolation test, mirroring supportedCompetitions.test.ts's Stage 2
// precedent).
export const leagueCatalog: LeagueCatalog = createLeagueCatalog();
