// Stage 3.5A — one stateless polling cycle: finds CONFIRMED bets whose
// events are plausibly resolvable right now, fetches their results from
// the provider, and settles them through the existing, unmodified Stage
// 3.3/3.4 services. This file does not schedule itself, does not retry
// across cycles, does not persist any audit trail, and does not know how
// to trigger a second cycle — all of that is explicitly out of scope
// (Stage 3.5B / 3.6 / 3.7).
//
// This module never computes a payout, never writes a Transaction, never
// updates Player.currentCredit, and never calls settleBet() directly —
// every financial decision is delegated entirely to autoSettleSingleBet()/
// autoSettleExpressBet(), unmodified.

import type { PrismaClient } from "@/lib/generated/prisma/client";
import { autoSettleSingleBet } from "./autoSettleSingleBet";
import { autoSettleExpressBet, type EventResultEntryInput } from "./autoSettleExpressBet";
import type { CanonicalEventResult } from "./eventResultDomain";
import {
  extractProviderEventKey,
  extractProviderEventKeys,
  groupAndDeduplicateEventKeys,
  countUniqueEvents,
  type ProviderEventKey,
} from "./pollingEventKey";
import { fetchProviderScores, type ScoresFetchResult } from "@/lib/odds/providers/theOddsApi/scoresAdapter";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

// Our OWN polling-eligibility window — a bet's event must have started
// within the last 3 days to be worth attempting. This happens to match The
// Odds API's own daysFrom=3 scores-endpoint parameter
// (lib/odds/providers/theOddsApi/scoresAdapter.ts's SCORES_DAYS_FROM), but
// the two constants are intentionally NOT shared: one describes what the
// provider is willing to answer, this one describes our own decision about
// how long to keep trying before leaving a bet for Stage 3.7/manual
// review. Coincidence, not a wiring dependency.
const POLLING_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

// Implementation safety limit, NOT a confirmed provider limit — no
// official maximum eventIds-per-request count is documented anywhere in
// this repository or the task's own confirmed provider contract. Chosen
// conservatively to keep each request URL small and each batch's blast
// radius (one failed request affects at most this many events) bounded.
const MAX_EVENT_IDS_PER_SCORES_REQUEST = 10;

// How many CONFIRMED bets of EACH type (SINGLE, EXPRESS) one cycle will
// load at most — a safety bound against scanning an unbounded table on a
// serverless invocation, not a claim about real production scale (this is
// a demo-scale MVP; see the Stage 3.5 audit).
const DEFAULT_ELIGIBLE_BET_LIMIT = 200;

// How many bet-level settlement calls run concurrently at once. Small and
// bounded, per the Stage 3.5A brief's explicit "no p-limit, no unbounded
// Promise.all" instruction — a hand-rolled chunked Promise.allSettled loop
// is simple enough not to need a dependency for this.
const DEFAULT_SETTLEMENT_CONCURRENCY = 5;

/* -------------------------------------------------------------------------- */
/* Report contract                                                            */
/* -------------------------------------------------------------------------- */

export interface PollingReport {
  readonly scannedBets: number;
  readonly eligibleBets: number;
  readonly uniqueEvents: number;
  readonly providerRequests: number;
  readonly providerFailures: number;
  readonly settled: number;
  readonly noAction: number;
  readonly rejected: number;
  readonly conflicts: number;
  readonly failed: number;
}

export interface PollConfirmedBetResultsInput {
  readonly now?: Date;
  readonly limit?: number;
  readonly concurrency?: number;
  // Injectable so tests never make a real network call — matches this
  // codebase's existing DI convention (TheOddsApiProvider's own
  // verifyOddsFn constructor parameter), applied here at the polling
  // service's own layer rather than re-mocking global.fetch a second time
  // (that's scoresAdapter.test.ts's job, at its own layer).
  readonly fetchScoresFn?: typeof fetchProviderScores;
}

/* -------------------------------------------------------------------------- */
/* Eligible-bet loading                                                       */
/* -------------------------------------------------------------------------- */

interface LoadedSingleBet {
  readonly id: string;
  readonly providerName: string | null;
  readonly providerSportKey: string | null;
  readonly providerEventId: string | null;
  readonly eventStartTime: Date | null;
}

interface LoadedExpressLeg {
  readonly providerName: string | null;
  readonly providerSportKey: string | null;
  readonly providerEventId: string | null;
  readonly eventStartTime: Date | null;
}

interface LoadedExpressBet {
  readonly id: string;
  readonly selections: readonly LoadedExpressLeg[];
}

// Two separate queries, deliberately not one combined query — Bet.eventStartTime
// is always null for EXPRESS (that identity lives entirely on BetSelection,
// Stage 3.1's Variant B), so a single WHERE clause cannot express both
// SINGLE's and EXPRESS's eligibility windows honestly. Both queries filter
// the polling window AT THE DATABASE LEVEL (not as an in-memory post-filter
// over an arbitrary "first N confirmed" page) — this is what actually
// prevents starvation: every row either query returns is already
// guaranteed to be in-window, so `take: limit` never wastes a slot on a
// bet that can't be acted on this cycle, and a cursor/repeated call always
// makes forward progress through genuinely eligible rows rather than
// getting stuck re-scanning the same unpollable prefix.
//
// The implicit reliance on Stage 3.1's all-or-nothing provider-metadata
// invariant (providerName/providerSportKey/providerEventId/eventStartTime
// are populated together or not at all) is what lets the eventStartTime
// range filter alone correctly exclude metadata-less bets too, without a
// separate explicit null check.
async function loadEligibleSingleBets(db: PrismaClient, now: Date, limit: number): Promise<LoadedSingleBet[]> {
  const windowStart = new Date(now.getTime() - POLLING_LOOKBACK_MS);
  return db.bet.findMany({
    where: {
      type: "SINGLE",
      status: "CONFIRMED",
      eventStartTime: { lte: now, gte: windowStart },
    },
    select: { id: true, providerName: true, providerSportKey: true, providerEventId: true, eventStartTime: true },
    orderBy: { eventStartTime: "asc" },
    take: limit,
  });
}

async function loadEligibleExpressBets(db: PrismaClient, now: Date, limit: number): Promise<LoadedExpressBet[]> {
  const windowStart = new Date(now.getTime() - POLLING_LOOKBACK_MS);
  return db.bet.findMany({
    where: {
      type: "EXPRESS",
      status: "CONFIRMED",
      // "some" — at least one leg must currently be in-window for this bet
      // to be worth attempting at all. Legs individually outside the
      // window are still included in the loaded row (selections: true
      // below is unfiltered) so autoSettleExpressBet() sees every leg, not
      // a partial view — only the *event-key collection* step (below)
      // decides which specific legs get a provider request attempted.
      selections: { some: { eventStartTime: { lte: now, gte: windowStart } } },
    },
    select: {
      id: true,
      selections: {
        select: { providerName: true, providerSportKey: true, providerEventId: true, eventStartTime: true },
      },
    },
    // No Bet-level eventStartTime exists for EXPRESS to order by — id is
    // the best available stable, deterministic tie-breaker without a
    // schema change. Known, accepted limitation: EXPRESS bets aren't
    // prioritized by "how overdue" the way SINGLE bets are (see the
    // Stage 3.5A report).
    orderBy: { id: "asc" },
    take: limit,
  });
}

/* -------------------------------------------------------------------------- */
/* Chunked, bounded-concurrency settlement pass                              */
/* -------------------------------------------------------------------------- */

type SettlementTask =
  | { readonly kind: "SINGLE"; readonly betId: string; readonly key: ProviderEventKey }
  | { readonly kind: "EXPRESS"; readonly betId: string };

type TaskOutcome = "settled" | "noAction" | "rejected" | "conflict" | "failed";

function chunk<T>(items: readonly T[], size: number): readonly T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function runTask(
  db: PrismaClient,
  task: SettlementTask,
  resultsByEventId: ReadonlyMap<string, CanonicalEventResult>,
  eventResultsArray: readonly EventResultEntryInput[],
): Promise<TaskOutcome> {
  if (task.kind === "SINGLE") {
    const eventResult = resultsByEventId.get(task.key.providerEventId);
    // No result available for this SINGLE bet's one required event this
    // cycle (batch failed, event missing from the response, etc.) —
    // autoSettleSingleBet() has no "optional eventResult" shape to call it
    // with honestly, so it is simply not called at all. Never synthesized
    // as NOT_STARTED — the task's own explicit prohibition.
    if (!eventResult) return "noAction";

    const result = await autoSettleSingleBet(db, {
      betId: task.betId,
      eventResult,
      expectedProviderEventId: task.key.providerEventId,
    });
    return mapSingleOutcome(result.kind);
  }

  // EXPRESS — always attempted, even with zero/partial results available;
  // autoSettleExpressBet() (Stage 3.4B) already honestly handles a missing
  // leg as WAITING and structurally-broken metadata as REJECTED — nothing
  // about that logic is duplicated or second-guessed here. The full,
  // shared eventResultsArray is passed as-is (not filtered down to "this
  // bet's own legs") — extra, irrelevant entries are already proven safe
  // to pass (Stage 3.4B's own "extra unmatched providerEventId is ignored"
  // behavior).
  const result = await autoSettleExpressBet(db, { betId: task.betId, eventResults: eventResultsArray });
  return mapExpressOutcome(result.kind);
}

function mapSingleOutcome(kind: string): TaskOutcome {
  if (kind === "SETTLED") return "settled";
  if (kind === "NO_ACTION") return "noAction";
  if (kind === "REJECTED") return "rejected";
  if (kind === "CONFLICT") return "conflict";
  // NOT_FOUND folds into "failed" — see this file's own report: it only
  // happens via a genuine race (bet deleted between the eligible-query
  // read and the settlement call), an unexpected condition, not a normal
  // business outcome the report should have its own bucket for.
  return "failed"; // FAILED | NOT_FOUND
}

function mapExpressOutcome(kind: string): TaskOutcome {
  if (kind === "SETTLED") return "settled";
  if (kind === "NO_ACTION") return "noAction";
  if (kind === "REJECTED") return "rejected";
  if (kind === "CONFLICT") return "conflict";
  return "failed"; // FAILED | NOT_FOUND
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

export async function pollConfirmedBetResults(
  db: PrismaClient,
  input: PollConfirmedBetResultsInput = {},
): Promise<PollingReport> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? DEFAULT_ELIGIBLE_BET_LIMIT;
  const concurrency = input.concurrency ?? DEFAULT_SETTLEMENT_CONCURRENCY;
  const fetchScores = input.fetchScoresFn ?? fetchProviderScores;
  const window = { now, lookbackMs: POLLING_LOOKBACK_MS };

  const [singleBets, expressBets] = await Promise.all([
    loadEligibleSingleBets(db, now, limit),
    loadEligibleExpressBets(db, now, limit),
  ]);

  const scannedBets = singleBets.length + expressBets.length;

  if (scannedBets === 0) {
    return {
      scannedBets: 0,
      eligibleBets: 0,
      uniqueEvents: 0,
      providerRequests: 0,
      providerFailures: 0,
      settled: 0,
      noAction: 0,
      rejected: 0,
      conflicts: 0,
      failed: 0,
    };
  }

  // Build the settlement task list and collect every key we'll need to ask
  // the provider about, in one pass.
  const tasks: SettlementTask[] = [];
  const allKeys: ProviderEventKey[] = [];

  for (const bet of singleBets) {
    const key = extractProviderEventKey(bet, window);
    if (key) {
      tasks.push({ kind: "SINGLE", betId: bet.id, key });
      allKeys.push(key);
    }
    // A SINGLE bet the query returned but that yields no key (only
    // reachable if Stage 3.1's all-or-nothing invariant were somehow
    // violated) is scanned but not eligible — no task is queued for it.
  }

  for (const bet of expressBets) {
    tasks.push({ kind: "EXPRESS", betId: bet.id });
    allKeys.push(...extractProviderEventKeys(bet.selections, window));
  }

  const eligibleBets = tasks.length;

  const groups = groupAndDeduplicateEventKeys(allKeys);
  const uniqueEvents = countUniqueEvents(groups);

  // Sequential across sport groups — the Stage 3.5A brief's own explicit
  // "sequential processing of sport batches is sufficient and safer" call,
  // avoiding any risk of a provider request storm without needing a
  // concurrency-limiting dependency.
  const resultsByEventId = new Map<string, CanonicalEventResult>();
  let providerRequests = 0;
  let providerFailures = 0;

  for (const group of groups) {
    const idChunks = chunk(group.providerEventIds, MAX_EVENT_IDS_PER_SCORES_REQUEST);
    for (const idChunk of idChunks) {
      providerRequests += 1;
      const fetchResult: ScoresFetchResult = await fetchScores({
        providerSportKey: group.providerSportKey,
        providerEventIds: idChunk,
      });

      if (fetchResult.status === "FAILED") {
        providerFailures += 1;
        // This batch's events simply stay absent from resultsByEventId —
        // every dependent bet naturally resolves to WAITING/NO_ACTION
        // downstream, exactly as a missing individual event would.
        continue;
      }

      for (const mapped of fetchResult.results) {
        resultsByEventId.set(mapped.providerEventId, mapped.eventResult);
      }
    }
  }

  const eventResultsArray: EventResultEntryInput[] = Array.from(resultsByEventId.entries()).map(
    ([providerEventId, eventResult]) => ({ providerEventId, eventResult }),
  );

  // Bounded-concurrency settlement pass — chunked Promise.allSettled, never
  // one unbounded Promise.all. One bet throwing/failing/conflicting never
  // stops any other bet in the same or a later chunk.
  const outcomes: TaskOutcome[] = [];
  for (const taskChunk of chunk(tasks, concurrency)) {
    const settled = await Promise.allSettled(
      taskChunk.map((task) => runTask(db, task, resultsByEventId, eventResultsArray)),
    );
    for (const outcome of settled) {
      outcomes.push(outcome.status === "fulfilled" ? outcome.value : "failed");
    }
  }

  const counts = { settled: 0, noAction: 0, rejected: 0, conflicts: 0, failed: 0 };
  for (const outcome of outcomes) {
    if (outcome === "settled") counts.settled += 1;
    else if (outcome === "noAction") counts.noAction += 1;
    else if (outcome === "rejected") counts.rejected += 1;
    else if (outcome === "conflict") counts.conflicts += 1;
    else counts.failed += 1;
  }

  return {
    scannedBets,
    eligibleBets,
    uniqueEvents,
    providerRequests,
    providerFailures,
    ...counts,
  };
}
