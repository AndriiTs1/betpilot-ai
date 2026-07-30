import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLeagueCatalog } from "./leagueCatalog";
import { SUPPORTED_COMPETITIONS } from "./supportedCompetitions";
import type { ProviderSportEntry, SportsCatalogFetchResult } from "@/lib/odds/providers/theOddsApi/sportsCatalogAdapter";

// DI-only — no global.fetch replacement, no real network call anywhere in
// this file. createLeagueCatalog()'s own `fetchCatalog` option is the one
// and only seam a test needs (same convention as buildBetSlipPreview.ts's
// verifyOddsFn injection elsewhere in this codebase).

function providerEntry(overrides: Partial<ProviderSportEntry> = {}): ProviderSportEntry {
  return {
    sportKey: "soccer_epl",
    group: "Soccer",
    title: "EPL",
    description: "English Premier League",
    active: true,
    hasOutrights: false,
    ...overrides,
  };
}

// Every sportKey in SUPPORTED_COMPETITIONS, wrapped as a full provider
// catalog response — the "everything lines up" fixture.
function fullMatchingCatalog(): ProviderSportEntry[] {
  return SUPPORTED_COMPETITIONS.map((c) => providerEntry({ sportKey: c.sportKey, title: c.displayName }));
}

function fakeFetchCatalog(result: SportsCatalogFetchResult, callLog: number[] = []) {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    callLog.push(calls);
    return result;
  };
  return { fn, getCalls: () => calls };
}

/* -------------------------------------------------------------------------- */
/* getCatalog — success, cache, TTL, forceRefresh, failure passthrough       */
/* -------------------------------------------------------------------------- */

test("getCatalog(): first call fetches fresh, fromCache is false", async () => {
  const { fn } = fakeFetchCatalog({ status: "SUCCESS", results: [providerEntry()], rejectedEntries: 0 });
  const catalog = createLeagueCatalog({ fetchCatalog: fn });

  const result = await catalog.getCatalog();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.fromCache, false);
  assert.equal(result.entries.length, 1);
});

test("getCatalog(): a second call within the TTL window is served from cache, fetchCatalog is not called again", async () => {
  const { fn, getCalls } = fakeFetchCatalog({ status: "SUCCESS", results: [providerEntry()], rejectedEntries: 0 });
  let clock = 1_000_000;
  const catalog = createLeagueCatalog({ fetchCatalog: fn, now: () => clock, ttlMs: 60_000 });

  await catalog.getCatalog();
  clock += 30_000; // still well within the 60s TTL
  const second = await catalog.getCatalog();

  assert.equal(getCalls(), 1, "fetchCatalog must only have been called once");
  assert.equal(second.status, "SUCCESS");
  if (second.status !== "SUCCESS") return;
  assert.equal(second.fromCache, true);
});

test("getCatalog(): once the TTL has elapsed, the next call fetches fresh again", async () => {
  const { fn, getCalls } = fakeFetchCatalog({ status: "SUCCESS", results: [providerEntry()], rejectedEntries: 0 });
  let clock = 1_000_000;
  const catalog = createLeagueCatalog({ fetchCatalog: fn, now: () => clock, ttlMs: 60_000 });

  await catalog.getCatalog();
  clock += 60_001; // just past the TTL
  const second = await catalog.getCatalog();

  assert.equal(getCalls(), 2, "fetchCatalog must have been called again after TTL expiry");
  assert.equal(second.status, "SUCCESS");
  if (second.status !== "SUCCESS") return;
  assert.equal(second.fromCache, false);
});

test("getCatalog({forceRefresh: true}): bypasses a still-fresh cache", async () => {
  const { fn, getCalls } = fakeFetchCatalog({ status: "SUCCESS", results: [providerEntry()], rejectedEntries: 0 });
  const catalog = createLeagueCatalog({ fetchCatalog: fn, ttlMs: 60_000 });

  await catalog.getCatalog();
  await catalog.getCatalog({ forceRefresh: true });

  assert.equal(getCalls(), 2);
});

test("getCatalog(): a FAILED fetch is returned as-is and never cached as if it were success", async () => {
  const { fn, getCalls } = fakeFetchCatalog({ status: "FAILED", reason: "TIMEOUT" });
  const catalog = createLeagueCatalog({ fetchCatalog: fn });

  const result = await catalog.getCatalog();
  assert.deepEqual(result, { status: "FAILED", reason: "TIMEOUT" });

  // A second call must retry (not silently reuse a "cached failure").
  await catalog.getCatalog();
  assert.equal(getCalls(), 2);
});

/* -------------------------------------------------------------------------- */
/* validateAllowlist                                                         */
/* -------------------------------------------------------------------------- */

test("validateAllowlist(): no missing sport_keys when the provider catalog fully covers the allowlist", async () => {
  const { fn } = fakeFetchCatalog({ status: "SUCCESS", results: fullMatchingCatalog(), rejectedEntries: 0 });
  const catalog = createLeagueCatalog({ fetchCatalog: fn });

  const result = await catalog.validateAllowlist();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.deepEqual(result.missingSportKeys, []);
  assert.ok(!Number.isNaN(Date.parse(result.checkedAt)));
});

test("validateAllowlist(): the provider catalog may contain unrelated extra competitions with no effect", async () => {
  const extras = [providerEntry({ sportKey: "soccer_netherlands_eredivisie", title: "Dutch Eredivisie" })];
  const { fn } = fakeFetchCatalog({
    status: "SUCCESS",
    results: [...fullMatchingCatalog(), ...extras],
    rejectedEntries: 0,
  });
  const catalog = createLeagueCatalog({ fetchCatalog: fn });

  const result = await catalog.validateAllowlist();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.deepEqual(result.missingSportKeys, []);
});

test("validateAllowlist(): detects exactly one missing allowlisted sport_key when the provider no longer lists it", async () => {
  const missingKey = SUPPORTED_COMPETITIONS[0].sportKey;
  const catalogWithoutOne = fullMatchingCatalog().filter((entry) => entry.sportKey !== missingKey);
  const { fn } = fakeFetchCatalog({ status: "SUCCESS", results: catalogWithoutOne, rejectedEntries: 0 });
  const catalog = createLeagueCatalog({ fetchCatalog: fn });

  const originalConsoleError = console.error;
  let loggedArgs: unknown[] | null = null;
  console.error = (...args: unknown[]) => {
    loggedArgs = args;
  };

  try {
    const result = await catalog.validateAllowlist();
    assert.equal(result.status, "SUCCESS");
    if (result.status !== "SUCCESS") return;
    assert.deepEqual(result.missingSportKeys, [missingKey]);
    assert.ok(loggedArgs, "a missing sport_key must be explicitly logged");
    assert.ok(JSON.stringify(loggedArgs).includes(missingKey));
  } finally {
    console.error = originalConsoleError;
  }
});

test("validateAllowlist(): detects every missing sport_key when several are absent at once", async () => {
  const catalogMissingTwo = fullMatchingCatalog().slice(2);
  const expectedMissing = SUPPORTED_COMPETITIONS.slice(0, 2).map((c) => c.sportKey);
  const { fn } = fakeFetchCatalog({ status: "SUCCESS", results: catalogMissingTwo, rejectedEntries: 0 });
  const catalog = createLeagueCatalog({ fetchCatalog: fn });

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await catalog.validateAllowlist();
    assert.equal(result.status, "SUCCESS");
    if (result.status !== "SUCCESS") return;
    assert.deepEqual([...result.missingSportKeys].sort(), [...expectedMissing].sort());
  } finally {
    console.error = originalConsoleError;
  }
});

test("validateAllowlist(): propagates a FAILED catalog fetch unchanged", async () => {
  const { fn } = fakeFetchCatalog({ status: "FAILED", reason: "HTTP_401" });
  const catalog = createLeagueCatalog({ fetchCatalog: fn });

  const result = await catalog.validateAllowlist();
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_401" });
});

/* -------------------------------------------------------------------------- */
/* Isolation — Stage 3 explicitly must not touch the live pipeline           */
/* -------------------------------------------------------------------------- */
// Same two-tier check Stage 2's supportedCompetitions.test.ts already
// established: a precise list of the exact files this stage's own spec
// names as "must not change," plus a broader repo-wide scan. Both are
// expected to need revisiting once a later stage legitimately wires
// League Catalog into the live pipeline — not a permanent invariant.

const MUST_NOT_IMPORT_YET = [
  "lib/odds/oddsVerifier.ts",
  "lib/odds/footballLeagues.ts",
  "lib/odds/legacyOddsBridge.ts",
  "lib/odds/oddsVerificationService.ts",
  "lib/odds/theOddsApiProvider.ts",
  "lib/odds/providerRegistry.ts",
  "lib/bets/buildBetSlipPreview.ts",
  "app/api/miniapp/bets/text/preview/route.ts",
  "app/api/miniapp/bets/text/confirm/route.ts",
  "app/api/miniapp/bets/screenshot/preview/route.ts",
  "components/miniapp/BetTextForm.tsx",
  "components/miniapp/BetScreenshotForm.tsx",
  "components/miniapp/BetPreviewCard.tsx",
  "components/miniapp/canConfirmBetSlip.ts",
];

test("none of the explicitly-named live-pipeline files import leagueCatalog or sportsCatalogAdapter", () => {
  for (const relativePath of MUST_NOT_IMPORT_YET) {
    const contents = readFileSync(join(process.cwd(), relativePath), "utf8");
    assert.ok(!contents.includes("leagueCatalog"), `${relativePath} must not import leagueCatalog.ts at this stage`);
    assert.ok(
      !contents.includes("sportsCatalogAdapter"),
      `${relativePath} must not import sportsCatalogAdapter.ts at this stage`,
    );
  }
});

test("no import of leagueCatalog exists anywhere in app/, components/, or lib/ (excluding discovery/ itself)", () => {
  const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".next", ".git", "generated"]);
  const roots = ["app", "components", "lib"].map((dir) => join(process.cwd(), dir));
  const offenders: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (EXCLUDED_DIR_NAMES.has(entry)) continue;
      const fullPath = join(dir, entry);
      const stats = statSync(fullPath);

      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (fullPath.includes(join("lib", "odds", "discovery"))) continue;
      if (fullPath.includes(join("lib", "odds", "providers", "theOddsApi"))) continue;

      const contents = readFileSync(fullPath, "utf8");
      if (contents.includes("discovery/leagueCatalog") || contents.includes("theOddsApi/sportsCatalogAdapter")) {
        offenders.push(fullPath);
      }
    }
  }

  for (const root of roots) walk(root);

  assert.deepEqual(offenders, [], `unexpected imports found: ${offenders.join(", ")}`);
});
