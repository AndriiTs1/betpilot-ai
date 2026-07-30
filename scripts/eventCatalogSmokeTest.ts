import "dotenv/config";
import { createEventCatalog } from "../lib/odds/discovery/eventCatalog";
import { createLeagueCatalog } from "../lib/odds/discovery/leagueCatalog";
import { fetchProviderSportsCatalog, type ProviderSportEntry } from "../lib/odds/providers/theOddsApi/sportsCatalogAdapter";
import { fetchProviderEvents, type FetchProviderEventsInput, type EventsFetchResult } from "../lib/odds/providers/theOddsApi/eventsAdapter";
import { getSupportedSportKeys, SUPPORTED_COMPETITIONS } from "../lib/odds/discovery/supportedCompetitions";
import type { ProviderEventCandidate } from "../lib/odds/oddsProvider";

// Manual, one-off smoke test against the REAL The Odds API — deliberately
// NOT a *.test.ts file, so `npm test` never picks it up and no CI run ever
// spends live quota by accident.
//
// Usage:
//   npx tsx scripts/eventCatalogSmokeTest.ts
//
// Every endpoint touched (/v4/sports, /v4/sports/{sportKey}/events) is
// documented as free. Never calls /odds. Never writes to the database,
// never starts a server, never prints ODDS_API_KEY (only the already
// key-free typed results/errors these modules already guarantee never
// carry it — proven by Stage 2-4's own tests).
//
// This script wraps the REAL fetchProviderSportsCatalog/fetchProviderEvents
// functions in counting instrumentation (own local closures, not a change
// to either adapter) purely so the report below can state exact real HTTP
// request counts rather than inferring them.

let sportsRequestCount = 0;
let eventsRequestCount = 0;
// Running total of raw (pre-dedup) events returned across every successful
// /events call made through the wrapper — used to compute how many
// duplicates Event Catalog's own dedup step removed, without a second
// independent fetch pass.
let totalRawSuccessfulEvents = 0;
const eventsRequestLog: string[] = [];

async function countingFetchCatalog() {
  sportsRequestCount += 1;
  return fetchProviderSportsCatalog();
}

async function countingFetchEvents(input: FetchProviderEventsInput): Promise<EventsFetchResult> {
  eventsRequestCount += 1;
  eventsRequestLog.push(input.sportKey);
  const result = await fetchProviderEvents(input);
  if (result.status === "SUCCESS") totalRawSuccessfulEvents += result.results.length;
  return result;
}

function isValidCommenceTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function eventsForSportKey(entries: readonly ProviderEventCandidate[], sportKey: string): ProviderEventCandidate[] {
  return entries.filter((e) => e.reference.sportKey === sportKey);
}

const SPECIAL_ATTENTION_KEYS = [
  "soccer_uefa_champs_league",
  "soccer_uefa_champs_league_qualification",
  "soccer_uefa_europa_league",
  "soccer_uefa_europa_conference_league",
];

async function main(): Promise<void> {
  const supportedSportKeys = getSupportedSportKeys();

  console.log("========================================================");
  console.log("Event Catalog smoke test — live The Odds API");
  console.log("========================================================");
  console.log(`Supported competitions (Stage 2 allowlist): ${supportedSportKeys.length}`);
  for (const c of SUPPORTED_COMPETITIONS) console.log(`  - ${c.sportKey}  (${c.displayName})`);
  console.log("");

  // Own, isolated League Catalog instance (not the module-level default),
  // wired to the real adapter through the counting wrapper — same
  // createLeagueCatalog() factory Stage 3 already exports, used exactly as
  // any other caller would use it.
  const leagueCatalog = createLeagueCatalog({ fetchCatalog: countingFetchCatalog });
  const catalog = createEventCatalog({ leagueCatalog, fetchEvents: countingFetchEvents });

  /* ------------------------------------------------------------------ */
  /* PHASE 1 — League Catalog raw check (direct, for active-status)      */
  /* ------------------------------------------------------------------ */
  console.log("--- Phase 1: League Catalog (GET /v4/sports) ---");
  const rawCatalog = await leagueCatalog.getCatalog({ forceRefresh: true });

  const providerEntryByKey = new Map<string, ProviderSportEntry>();
  if (rawCatalog.status === "SUCCESS") {
    console.log(`League Catalog: SUCCESS — ${rawCatalog.entries.length} total sports/competitions from the provider.`);
    for (const entry of rawCatalog.entries) providerEntryByKey.set(entry.sportKey, entry);

    const missingFromProvider = supportedSportKeys.filter((k) => !providerEntryByKey.has(k));
    console.log(
      missingFromProvider.length === 0
        ? "All 9 allowlisted sport_keys are present in the live provider catalog."
        : `MISSING from live provider catalog: ${missingFromProvider.join(", ")}`,
    );
  } else {
    console.log(`League Catalog: FAILED (${rawCatalog.reason}) — active-status table below will show "unknown".`);
  }
  console.log("");

  /* ------------------------------------------------------------------ */
  /* PHASE 2 — Event Catalog first load (forceRefresh: true)             */
  /* ------------------------------------------------------------------ */
  console.log("--- Phase 2: Event Catalog first load — getCatalog({ forceRefresh: true }) ---");
  const sportsCountBeforeFirst = sportsRequestCount;
  const eventsCountBeforeFirst = eventsRequestCount;
  const rawEventsBeforeFirst = totalRawSuccessfulEvents;

  const first = await catalog.getCatalog({ forceRefresh: true });

  const sportsCallsDuringFirst = sportsRequestCount - sportsCountBeforeFirst;
  const eventsCallsDuringFirst = eventsRequestCount - eventsCountBeforeFirst;
  // Captured immediately after this call, before Phase 4's own extra
  // diagnostic calls (for any failed keys) can add to the running total.
  const rawEventsAtFirstLoad = totalRawSuccessfulEvents - rawEventsBeforeFirst;

  console.log(`Real /sports requests during this call: ${sportsCallsDuringFirst}`);
  console.log(`Real /events requests during this call: ${eventsCallsDuringFirst} (${eventsRequestLog.slice(-eventsCallsDuringFirst).join(", ")})`);

  if (first.status === "FAILED") {
    console.error(`CRITICAL: Event Catalog FAILED to load: ${first.reason}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Raw (pre-dedup) events collected across all leagues: ${rawEventsAtFirstLoad}`);
  console.log("");

  /* ------------------------------------------------------------------ */
  /* PHASE 3 — cache check: second call must not touch the network       */
  /* ------------------------------------------------------------------ */
  console.log("--- Phase 3: cache check — plain getCatalog() (no forceRefresh) ---");
  const statsBeforeSecond = catalog.getStats();
  const sportsCountBeforeSecond = sportsRequestCount;
  const eventsCountBeforeSecond = eventsRequestCount;

  const second = await catalog.getCatalog();

  const sportsCallsDuringSecond = sportsRequestCount - sportsCountBeforeSecond;
  const eventsCallsDuringSecond = eventsRequestCount - eventsCountBeforeSecond;
  const statsAfterSecond = catalog.getStats();

  console.log(`Real /sports requests during this call: ${sportsCallsDuringSecond} (expected 0)`);
  console.log(`Real /events requests during this call: ${eventsCallsDuringSecond} (expected 0)`);
  console.log(`second.fromCache: ${second.status === "SUCCESS" ? second.fromCache : "N/A (FAILED)"}`);
  console.log(`lastUpdatedAt unchanged: ${statsBeforeSecond.lastUpdatedAt === statsAfterSecond.lastUpdatedAt}`);

  const resultsIdentical =
    second.status === "SUCCESS" &&
    first.entries.length === second.entries.length &&
    first.entries.every((e, i) => e.reference.eventId === second.entries[i]?.reference.eventId);
  console.log(`First and second call results identical: ${resultsIdentical}`);
  console.log("");

  /* ------------------------------------------------------------------ */
  /* PHASE 4 — per-competition table (all 9, including zero-event ones)  */
  /* ------------------------------------------------------------------ */
  console.log("--- Phase 4: per-competition table ---");
  const failedReasonByKey = new Map<string, string>();

  for (const key of first.failedSportKeys) {
    // Extra, explicitly-permitted direct call to determine the precise
    // reason a specific league failed — not available from
    // EventCatalogResult itself (Stage 5's own public shape only exposes
    // the list of failed sport_keys, not why).
    const diagnostic = await countingFetchEvents({ sportKey: key });
    failedReasonByKey.set(key, diagnostic.status === "FAILED" ? diagnostic.reason : "(succeeded on retry)");
  }

  interface Row {
    sportKey: string;
    displayName: string;
    status: "loaded" | "failed" | "skipped";
    eventCount: number;
    active: string;
    reason: string;
  }

  const rows: Row[] = SUPPORTED_COMPETITIONS.map((c) => {
    const active = providerEntryByKey.has(c.sportKey) ? String(providerEntryByKey.get(c.sportKey)!.active) : "unknown";
    if (first.skippedSportKeys.includes(c.sportKey)) {
      return { sportKey: c.sportKey, displayName: c.displayName, status: "skipped", eventCount: 0, active, reason: "missing from live League Catalog" };
    }
    if (first.failedSportKeys.includes(c.sportKey)) {
      return {
        sportKey: c.sportKey,
        displayName: c.displayName,
        status: "failed",
        eventCount: 0,
        active,
        reason: failedReasonByKey.get(c.sportKey) ?? "unknown",
      };
    }
    return {
      sportKey: c.sportKey,
      displayName: c.displayName,
      status: "loaded",
      eventCount: eventsForSportKey(first.entries, c.sportKey).length,
      active,
      reason: "-",
    };
  });

  for (const row of rows) {
    console.log(
      `${row.displayName.padEnd(36)} ${row.sportKey.padEnd(42)} status=${row.status.padEnd(7)} events=${String(row.eventCount).padEnd(4)} active=${row.active.padEnd(9)} reason=${row.reason}`,
    );
  }
  console.log("");

  /* ------------------------------------------------------------------ */
  /* PHASE 5 — duplicate providerEventId check                          */
  /* ------------------------------------------------------------------ */
  console.log("--- Phase 5: duplicate providerEventId check ---");
  const ids = first.entries.map((e) => e.reference.eventId);
  const uniqueIds = new Set(ids);
  console.log(`Total events: ${ids.length}. Unique providerEventId: ${uniqueIds.size}.`);
  console.log(`Duplicates found: ${ids.length - uniqueIds.size}`);
  console.log("");

  /* ------------------------------------------------------------------ */
  /* PHASE 6 — per-event structural validation                          */
  /* ------------------------------------------------------------------ */
  console.log("--- Phase 6: per-event structural validation ---");
  const supportedSet = new Set(supportedSportKeys);
  let validCount = 0;
  const problems: string[] = [];

  for (const candidate of first.entries) {
    const home = candidate.event.participants[0]?.name ?? "";
    const away = candidate.event.participants[1]?.name ?? "";
    const checks = [
      candidate.reference.eventId.trim().length > 0,
      candidate.reference.sportKey !== undefined && supportedSet.has(candidate.reference.sportKey),
      typeof candidate.event.startTime === "string" && isValidCommenceTime(candidate.event.startTime),
      home.trim().length > 0,
      away.trim().length > 0,
      home.trim().toLowerCase() !== away.trim().toLowerCase(),
      candidate.reference.provider === "THE_ODDS_API",
    ];
    if (checks.every(Boolean)) {
      validCount += 1;
    } else {
      problems.push(candidate.reference.eventId);
    }
  }
  console.log(`Structurally valid events: ${validCount} / ${first.entries.length}`);
  if (problems.length > 0) console.log(`Problem event ids: ${problems.join(", ")}`);
  console.log("");

  /* ------------------------------------------------------------------ */
  /* PHASE 7 — CL / CL Qualification / Europa League / Conference League */
  /* ------------------------------------------------------------------ */
  console.log("--- Phase 7: special attention — CL / CLQ / EL / Conference League ---");
  for (const key of SPECIAL_ATTENTION_KEYS) {
    const row = rows.find((r) => r.sportKey === key)!;
    const providerActive = providerEntryByKey.get(key)?.active;
    const note =
      row.status === "loaded" && row.eventCount === 0
        ? "provider returned a valid EMPTY array (HTTP 200, no events) — not an error"
        : row.status === "loaded"
          ? `provider returned ${row.eventCount} real event(s)`
          : `did NOT return an empty array — status=${row.status}, reason=${row.reason}`;
    console.log(`${row.displayName} (${key}): active=${providerActive ?? "unknown"} — ${note}`);
  }
  console.log("");

  /* ------------------------------------------------------------------ */
  /* PHASE 8 — summary                                                   */
  /* ------------------------------------------------------------------ */
  console.log("--- Phase 8: summary ---");
  const loadedCount = rows.filter((r) => r.status === "loaded").length;
  const failedCount = rows.filter((r) => r.status === "failed").length;
  const skippedCount = rows.filter((r) => r.status === "skipped").length;
  const stats = catalog.getStats();

  console.log(`Supported competitions: ${supportedSportKeys.length}`);
  console.log(`Loaded successfully: ${loadedCount}`);
  console.log(`Failed: ${failedCount}`);
  console.log(`Skipped (missing from provider): ${skippedCount}`);
  console.log(`Total events returned (post-dedup): ${first.entries.length}`);
  console.log(`Raw events collected before dedup: ${rawEventsAtFirstLoad}`);
  console.log(`Duplicates removed by Event Catalog's own dedup: ${rawEventsAtFirstLoad - first.entries.length}`);
  console.log(`Unique providerEventId: ${uniqueIds.size}`);
  console.log(`getStats(): ${JSON.stringify(stats)}`);
  console.log("");
  console.log(`Total real HTTP requests this run: /sports=${sportsRequestCount}, /events=${eventsRequestCount}`);
  console.log("");
  console.log("Smoke test complete.");
}

main().catch((err) => {
  console.error("Smoke test crashed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
