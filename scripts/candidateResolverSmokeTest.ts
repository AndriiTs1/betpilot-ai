import "dotenv/config";
import { createLeagueCatalog } from "../lib/odds/discovery/leagueCatalog";
import { createEventCatalog } from "../lib/odds/discovery/eventCatalog";
import { createTeamIndex } from "../lib/odds/discovery/teamIndex";
import { createTeamAliasIndex } from "../lib/odds/discovery/teamAliasIndex";
import { createCandidateResolver, type ResolveQueryResult } from "../lib/odds/discovery/candidateResolver";
import { CURATED_TEAM_ALIASES } from "../lib/odds/discovery/teamAliases";
import { fetchProviderSportsCatalog, type SportsCatalogFetchResult } from "../lib/odds/providers/theOddsApi/sportsCatalogAdapter";
import { fetchProviderEvents, type FetchProviderEventsInput, type EventsFetchResult } from "../lib/odds/providers/theOddsApi/eventsAdapter";
import type { TeamIndexEntry } from "../lib/odds/discovery/teamIndex";

// Stage 8.1 — manual, one-off LIVE smoke test of the full Discovery Engine
// (Stage 2-8), against the real The Odds API. Deliberately NOT a *.test.ts
// file — never picked up by `npm test`, never runs in CI, never spends
// live quota by accident.
//
// Uses ONLY the real, existing factories (createLeagueCatalog,
// createEventCatalog, createTeamIndex, createTeamAliasIndex,
// createCandidateResolver) composed with counting wrappers around the two
// real adapter functions (fetchProviderSportsCatalog, fetchProviderEvents)
// — the exact same instrumentation technique scripts/eventCatalogSmokeTest.ts
// already established. No Discovery Engine logic is reimplemented here, and
// no second/alternative Candidate Resolver is created.
//
// Endpoints this script can possibly reach: GET /v4/sports (via
// fetchProviderSportsCatalog, called only from within League Catalog) and
// GET /v4/sports/{sportKey}/events (via fetchProviderEvents, called only
// from within Event Catalog). Nothing in this file imports
// lib/odds/oddsVerifier.ts, lib/odds/theOddsApiProvider.ts, or any other
// module that could construct a request to /v4/sports/{sportKey}/odds or
// /v4/sports/{sportKey}/scores — there is no code path to either paid
// endpoint anywhere in this script's dependency graph. No Prisma, no
// database client, no Telegram client, no Redis client is imported either.

/* -------------------------------------------------------------------------- */
/* HTTP counting instrumentation (same technique as eventCatalogSmokeTest.ts) */
/* -------------------------------------------------------------------------- */

let sportsRequestCount = 0;
let eventsRequestCount = 0;
const eventsRequestLog: string[] = [];

async function countingFetchCatalog(): Promise<SportsCatalogFetchResult> {
  sportsRequestCount += 1;
  return fetchProviderSportsCatalog();
}

async function countingFetchEvents(input: FetchProviderEventsInput): Promise<EventsFetchResult> {
  eventsRequestCount += 1;
  eventsRequestLog.push(input.sportKey);
  return fetchProviderEvents(input);
}

/* -------------------------------------------------------------------------- */
/* Small report helpers                                                      */
/* -------------------------------------------------------------------------- */

type Verdict = "PASS" | "FAIL" | "SKIPPED";

interface QueryReportRow {
  readonly query: string;
  readonly category: string;
  readonly kind: string;
  readonly eventIds: string;
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly league: string;
  readonly matchMethod: string;
  readonly score: string;
  readonly note: string;
  readonly verdict: Verdict;
}

const reportRows: QueryReportRow[] = [];

function summarizeResult(result: ResolveQueryResult): Pick<QueryReportRow, "kind" | "eventIds" | "homeTeam" | "awayTeam" | "league" | "matchMethod" | "score" | "note"> {
  if (result.kind === "TEAM_RESOLVED" || result.kind === "MATCH_RESOLVED") {
    const c = result.candidate;
    return {
      kind: result.kind,
      eventIds: c.providerEventId,
      homeTeam: c.homeTeam ?? "(none)",
      awayTeam: c.awayTeam ?? "(none)",
      league: c.league ?? "(none)",
      matchMethod: c.matchMethod,
      score: c.score.toFixed(2),
      note: c.diagnostics.join(" | "),
    };
  }
  if (result.kind === "AMBIGUOUS") {
    return {
      kind: result.kind,
      eventIds: result.candidates.map((c) => c.providerEventId).join(", "),
      homeTeam: "-",
      awayTeam: "-",
      league: "-",
      matchMethod: "-",
      score: "-",
      note: result.reason,
    };
  }
  if (result.kind === "NOT_FOUND" || result.kind === "INVALID_QUERY") {
    return { kind: result.kind, eventIds: "-", homeTeam: "-", awayTeam: "-", league: "-", matchMethod: "-", score: "-", note: result.reason };
  }
  // FAILED
  return { kind: result.kind, eventIds: "-", homeTeam: "-", awayTeam: "-", league: "-", matchMethod: "-", score: "-", note: `${result.source}: ${result.reason}` };
}

function record(query: string, category: string, result: ResolveQueryResult, expectedVerdict: (r: ResolveQueryResult) => boolean): void {
  const summary = summarizeResult(result);
  const verdict: Verdict = expectedVerdict(result) ? "PASS" : "FAIL";
  reportRows.push({ query, category, verdict, ...summary });
}

function recordSkipped(query: string, category: string, note: string): void {
  reportRows.push({ query, category, kind: "-", eventIds: "-", homeTeam: "-", awayTeam: "-", league: "-", matchMethod: "-", score: "-", note, verdict: "SKIPPED" });
}

function printReportTable(): void {
  console.log("");
  console.log("=== Query report ===");
  for (const row of reportRows) {
    console.log(`[${row.verdict}] (${row.category}) query="${row.query}"`);
    console.log(`    kind=${row.kind} events=[${row.eventIds}] home="${row.homeTeam}" away="${row.awayTeam}" league="${row.league}"`);
    console.log(`    matchMethod=${row.matchMethod} score=${row.score} note="${row.note}"`);
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log("========================================================");
  console.log("Candidate Resolver — full Discovery Engine live smoke test");
  console.log("========================================================");

  // Step 1 — env var presence check, value never logged.
  const hasApiKey = Boolean(process.env.ODDS_API_KEY && process.env.ODDS_API_KEY.trim().length > 0);
  console.log(`ODDS_API_KEY present: ${hasApiKey}`);
  if (!hasApiKey) {
    console.error("BLOCKED: ODDS_API_KEY is not set. Cannot proceed.");
    process.exitCode = 1;
    return;
  }

  // Real factories only, composed with counting wrappers around the two
  // real adapter functions — no Discovery Engine logic reimplemented here.
  const leagueCatalog = createLeagueCatalog({ fetchCatalog: countingFetchCatalog });
  const eventCatalog = createEventCatalog({ leagueCatalog, fetchEvents: countingFetchEvents });
  const teamIndex = createTeamIndex({ eventCatalog });
  const teamAliasIndex = createTeamAliasIndex({ teamIndex });
  const resolver = createCandidateResolver({ teamIndex, teamAliasIndex });

  console.log("");
  console.log("--- Building dependencies (League Catalog -> Event Catalog -> Team Index -> Team Alias Index -> Resolver) ---");
  const sportsBefore = sportsRequestCount;
  const eventsBefore = eventsRequestCount;

  const buildResult = await resolver.buildDependencies();

  console.log(`buildDependencies(): ${buildResult.status}`);
  if (buildResult.status === "FAILED") {
    console.error(`BLOCKED: dependency build failed — source=${buildResult.source} reason=${buildResult.reason}`);
    process.exitCode = 1;
    return;
  }

  const sportsAfterBuild = sportsRequestCount;
  const eventsAfterBuild = eventsRequestCount;
  console.log(`HTTP during first build: /sports=${sportsAfterBuild - sportsBefore}, /events=${eventsAfterBuild - eventsBefore}`);

  /* ------------------------------------------------------------------ */
  /* Layer statistics                                                    */
  /* ------------------------------------------------------------------ */

  const leagueCatalogResult = await leagueCatalog.getCatalog();
  const allowlistValidation = await leagueCatalog.validateAllowlist();
  const eventCatalogResult = await eventCatalog.getCatalog();
  const teamIndexStats = teamIndex.getStats();
  const aliasStats = teamAliasIndex.getStats();

  console.log("");
  console.log("--- League Catalog ---");
  console.log(`status=${leagueCatalogResult.status}`);
  if (leagueCatalogResult.status === "SUCCESS" && allowlistValidation.status === "SUCCESS") {
    console.log(`total provider competitions=${leagueCatalogResult.entries.length}`);
    console.log(`missing allowlisted competitions: ${allowlistValidation.missingSportKeys.length > 0 ? allowlistValidation.missingSportKeys.join(", ") : "none"}`);
  }

  console.log("");
  console.log("--- Event Catalog ---");
  console.log(`status=${eventCatalogResult.status}`);
  if (eventCatalogResult.status === "SUCCESS") {
    console.log(`requested competitions=9`);
    console.log(`failed competitions: ${eventCatalogResult.failedSportKeys.length > 0 ? eventCatalogResult.failedSportKeys.join(", ") : "none"}`);
    console.log(`skipped competitions: ${eventCatalogResult.skippedSportKeys.length > 0 ? eventCatalogResult.skippedSportKeys.join(", ") : "none"}`);
    console.log(`total events=${eventCatalogResult.entries.length}`);
    console.log(`fromCache=${eventCatalogResult.fromCache}`);
  }

  const allTeamEntries = teamIndex.getAllTeams();
  const uniqueEventIds = new Set(allTeamEntries.map((e) => e.providerEventId));
  console.log("");
  console.log("--- Team Index ---");
  console.log(`entryCount=${teamIndexStats.entryCount} uniqueTeamCount=${teamIndexStats.uniqueTeamCount} uniqueEventCount=${uniqueEventIds.size} buildDurationMs=${teamIndexStats.buildDurationMs}`);

  console.log("");
  console.log("--- Team Alias Index ---");
  console.log(
    `canonicalGeneratedAliasCount=${aliasStats.canonicalGeneratedAliasCount} curatedAliasCount=${aliasStats.curatedAliasCount} totalAliasCount=${aliasStats.totalAliasCount} aliasCollisionCount=${aliasStats.aliasCollisionCount} teamEntryReferenceCount=${aliasStats.teamEntryReferenceCount}`,
  );

  if (allTeamEntries.length === 0) {
    console.error("");
    console.error("BLOCKED: Event Catalog/Team Index built successfully but contain zero real events across every supported competition.");
    console.error("Not faking data. Stopping here.");
    process.exitCode = 1;
    return;
  }

  /* ------------------------------------------------------------------ */
  /* Dynamically pick real teams/events to query                        */
  /* ------------------------------------------------------------------ */

  const byEventId = new Map<string, TeamIndexEntry[]>();
  for (const e of allTeamEntries) {
    const bucket = byEventId.get(e.providerEventId);
    if (bucket) bucket.push(e);
    else byEventId.set(e.providerEventId, [e]);
  }
  // Pick the first event that genuinely has both a HOME and an AWAY side.
  let sampleHome: TeamIndexEntry | undefined;
  let sampleAway: TeamIndexEntry | undefined;
  for (const entries of byEventId.values()) {
    const home = entries.find((e) => e.role === "HOME");
    const away = entries.find((e) => e.role === "AWAY");
    if (home && away) {
      sampleHome = home;
      sampleAway = away;
      break;
    }
  }

  if (!sampleHome || !sampleAway) {
    console.error("BLOCKED: no event with both a HOME and an AWAY side was found — cannot run match-query tests.");
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log(`Sample real event for dynamic queries: "${sampleHome.canonicalName}" vs "${sampleAway.canonicalName}" (${sampleHome.providerEventId})`);

  /* ------------------------------------------------------------------ */
  /* A. Dynamic canonical-name queries                                  */
  /* ------------------------------------------------------------------ */

  console.log("");
  console.log("--- A. Dynamic canonical queries ---");

  record(sampleHome.canonicalName, "A.exact", resolver.resolveTeam(sampleHome.canonicalName), (r) => r.kind === "TEAM_RESOLVED" || r.kind === "AMBIGUOUS");
  record(sampleHome.canonicalName.toLowerCase(), "A.lowercase", resolver.resolveTeam(sampleHome.canonicalName.toLowerCase()), (r) => r.kind === "TEAM_RESOLVED" || r.kind === "AMBIGUOUS");
  record(`  ${sampleHome.canonicalName}  `, "A.extra-whitespace", resolver.resolveTeam(`  ${sampleHome.canonicalName}  `), (r) => r.kind === "TEAM_RESOLVED" || r.kind === "AMBIGUOUS");

  const vsQuery = `${sampleHome.canonicalName} vs ${sampleAway.canonicalName}`;
  record(vsQuery, "A.match-vs", resolver.resolve(vsQuery), (r) => r.kind === "MATCH_RESOLVED" || r.kind === "AMBIGUOUS");

  const reversedQuery = `${sampleAway.canonicalName} vs ${sampleHome.canonicalName}`;
  record(reversedQuery, "A.match-reversed", resolver.resolve(reversedQuery), (r) => r.kind === "MATCH_RESOLVED" || r.kind === "AMBIGUOUS");

  const dashQuery = `${sampleHome.canonicalName} - ${sampleAway.canonicalName}`;
  record(dashQuery, "A.match-dash", resolver.resolve(dashQuery), (r) => r.kind === "MATCH_RESOLVED" || r.kind === "AMBIGUOUS");

  /* ------------------------------------------------------------------ */
  /* B. Curated aliases — only for teams actually present               */
  /* ------------------------------------------------------------------ */

  console.log("");
  console.log("--- B. Curated aliases (only for currently-present teams) ---");

  const presentCanonicalNames = new Set(allTeamEntries.map((e) => e.canonicalName));

  for (const curated of CURATED_TEAM_ALIASES) {
    if (!presentCanonicalNames.has(curated.canonicalTeamName)) {
      recordSkipped(curated.canonicalTeamName, "B.curated-alias", `team not present in current Team Index — skipped, not failed`);
      continue;
    }
    for (const alias of curated.aliases) {
      record(alias, `B.curated-alias(${curated.canonicalTeamName})`, resolver.resolveTeam(alias), (r) => r.kind === "TEAM_RESOLVED" || r.kind === "AMBIGUOUS");
    }
  }

  /* ------------------------------------------------------------------ */
  /* C. Fuzzy — one safe typo on a real, currently-present team         */
  /* ------------------------------------------------------------------ */

  console.log("");
  console.log("--- C. Fuzzy typo ---");

  const fuzzyCandidateTeam = [...presentCanonicalNames].find((name) => name.length >= 6);
  if (fuzzyCandidateTeam) {
    // Delete the middle character — a safe, deterministic single-character typo.
    const midIndex = Math.floor(fuzzyCandidateTeam.length / 2);
    const typo = fuzzyCandidateTeam.slice(0, midIndex) + fuzzyCandidateTeam.slice(midIndex + 1);
    record(typo, `C.fuzzy(${fuzzyCandidateTeam})`, resolver.resolveTeam(typo), (r) => r.kind !== "NOT_FOUND");
  } else {
    recordSkipped("(none)", "C.fuzzy", "no currently-present team name is at least 6 characters long — skipped");
  }

  /* ------------------------------------------------------------------ */
  /* D. Negative cases                                                  */
  /* ------------------------------------------------------------------ */

  console.log("");
  console.log("--- D. Negative cases ---");

  record("Definitely Nonexistent FC 12345", "D.nonexistent", resolver.resolveTeam("Definitely Nonexistent FC 12345"), (r) => r.kind === "NOT_FOUND");
  record("", "D.empty-string", resolver.resolve(""), (r) => r.kind === "INVALID_QUERY");
  record(`${sampleHome.canonicalName} vs `, "D.malformed-empty-side", resolver.resolve(`${sampleHome.canonicalName} vs `), (r) => r.kind === "INVALID_QUERY");
  record(`${sampleHome.canonicalName} vs ${sampleAway.canonicalName} vs Extra`, "D.three-parts", resolver.resolve(`${sampleHome.canonicalName} vs ${sampleAway.canonicalName} vs Extra`), (r) => r.kind === "INVALID_QUERY");

  printReportTable();

  /* ------------------------------------------------------------------ */
  /* Cache verification                                                  */
  /* ------------------------------------------------------------------ */

  console.log("");
  console.log("--- Cache verification (second pass, no forceRefresh) ---");
  const sportsBeforeSecond = sportsRequestCount;
  const eventsBeforeSecond = eventsRequestCount;

  await eventCatalog.getCatalog();
  const secondBuild = await resolver.buildDependencies();

  const sportsAfterSecond = sportsRequestCount;
  const eventsAfterSecond = eventsRequestCount;
  console.log(`Second buildDependencies(): ${secondBuild.status}`);
  console.log(`HTTP during second pass: /sports=${sportsAfterSecond - sportsBeforeSecond}, /events=${eventsAfterSecond - eventsBeforeSecond} (expected 0 for both, given Event Catalog's own TTL is still fresh)`);

  /* ------------------------------------------------------------------ */
  /* Final summary                                                       */
  /* ------------------------------------------------------------------ */

  const passCount = reportRows.filter((r) => r.verdict === "PASS").length;
  const failCount = reportRows.filter((r) => r.verdict === "FAIL").length;
  const skippedCount = reportRows.filter((r) => r.verdict === "SKIPPED").length;

  const kindDistribution = new Map<string, number>();
  const methodDistribution = new Map<string, number>();
  for (const row of reportRows) {
    if (row.verdict === "SKIPPED") continue;
    kindDistribution.set(row.kind, (kindDistribution.get(row.kind) ?? 0) + 1);
    if (row.matchMethod !== "-") methodDistribution.set(row.matchMethod, (methodDistribution.get(row.matchMethod) ?? 0) + 1);
  }

  console.log("");
  console.log("=== Final summary ===");
  console.log(`Queries executed: ${reportRows.length} — PASS=${passCount} FAIL=${failCount} SKIPPED=${skippedCount}`);
  console.log(`result.kind distribution: ${JSON.stringify(Object.fromEntries(kindDistribution))}`);
  console.log(`matchMethod distribution: ${JSON.stringify(Object.fromEntries(methodDistribution))}`);
  console.log("");
  console.log(`Total HTTP this run: /sports=${sportsRequestCount}, /events=${eventsRequestCount}, /odds=0 (no code path to it exists in this script)`);

  if (failCount > 0) {
    console.error("");
    console.error(`BLOCKED: ${failCount} quer${failCount === 1 ? "y" : "ies"} did not match the expected outcome.`);
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log("Smoke test complete — all checks passed.");
}

main().catch((err) => {
  console.error("Smoke test crashed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
