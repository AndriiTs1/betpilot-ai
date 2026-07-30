import { test } from "node:test";
import assert from "node:assert/strict";
import { SettlementReviewReason, SettlementReviewStatus, type BetStatus, type PrismaClient } from "@/lib/generated/prisma/client";
import {
  classifyExpressBetForSweep,
  classifySingleBetForSweep,
  escalateExpiredPolling,
  type EscalateExpiredPollingInput,
} from "./escalateExpiredPolling";
import { POLLING_LOOKBACK_MS } from "./pollConfirmedBetResults";

/* -------------------------------------------------------------------------- */
/* Fake DB — only what escalateExpiredPolling.ts actually calls               */
/* -------------------------------------------------------------------------- */

interface FakeSelectionRow {
  id: string;
  providerName: string | null;
  providerSportKey: string | null;
  providerEventId: string | null;
  eventStartTime: Date | null;
  canonicalMarketType: string | null;
  canonicalSelectionType: string | null;
  canonicalParticipant: string | null;
  canonicalPeriod: string | null;
}

interface FakeBetRow {
  id: string;
  type: string;
  status: BetStatus;
  providerName: string | null;
  providerSportKey: string | null;
  providerEventId: string | null;
  eventStartTime: Date | null;
  canonicalMarketType: string | null;
  canonicalSelectionType: string | null;
  canonicalParticipant: string | null;
  canonicalPeriod: string | null;
  selections: FakeSelectionRow[];
  settlementReviewStatus: SettlementReviewStatus | null;
  settlementReviewReason: SettlementReviewReason | null;
  lastSettlementErrorCode: string | null;
  lastSettlementErrorMessage: string | null;
  lastSettlementAttemptAt: Date | null;
  settlementRetryCount: number;
}

const NOW = new Date("2026-07-30T12:00:00Z");
const WINDOW_START = new Date(NOW.getTime() - POLLING_LOOKBACK_MS);

function beforeWindow(hoursBeforeCutoff = 1): Date {
  return new Date(WINDOW_START.getTime() - hoursBeforeCutoff * 60 * 60 * 1000);
}
function insideWindow(hoursAgo = 2): Date {
  return new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000);
}

function fakeSingleBet(overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return {
    id: "single-1",
    type: "SINGLE",
    status: "CONFIRMED",
    providerName: "THE_ODDS_API",
    providerSportKey: "soccer_epl",
    providerEventId: "evt-1",
    eventStartTime: beforeWindow(),
    canonicalMarketType: "MONEYLINE_3WAY",
    canonicalSelectionType: "HOME",
    canonicalParticipant: null,
    canonicalPeriod: "FULL_GAME",
    selections: [],
    settlementReviewStatus: null,
    settlementReviewReason: null,
    lastSettlementErrorCode: null,
    lastSettlementErrorMessage: null,
    lastSettlementAttemptAt: null,
    settlementRetryCount: 0,
    ...overrides,
  };
}

function fakeLeg(overrides: Partial<FakeSelectionRow> = {}): FakeSelectionRow {
  return {
    id: "sel-1",
    providerName: "THE_ODDS_API",
    providerSportKey: "soccer_epl",
    providerEventId: "evt-1",
    eventStartTime: beforeWindow(),
    canonicalMarketType: "MONEYLINE_3WAY",
    canonicalSelectionType: "HOME",
    canonicalParticipant: null,
    canonicalPeriod: "FULL_GAME",
    ...overrides,
  };
}

function legacyLeg(overrides: Partial<FakeSelectionRow> = {}): FakeSelectionRow {
  return fakeLeg({
    providerName: null,
    providerSportKey: null,
    providerEventId: null,
    eventStartTime: null,
    canonicalMarketType: null,
    canonicalSelectionType: null,
    canonicalPeriod: null,
    ...overrides,
  });
}

function fakeExpressBet(selections: FakeSelectionRow[], overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return {
    id: "express-1",
    type: "EXPRESS",
    status: "CONFIRMED",
    providerName: null,
    providerSportKey: null,
    providerEventId: null,
    eventStartTime: null,
    canonicalMarketType: null,
    canonicalSelectionType: null,
    canonicalParticipant: null,
    canonicalPeriod: null,
    selections,
    settlementReviewStatus: null,
    settlementReviewReason: null,
    lastSettlementErrorCode: null,
    lastSettlementErrorMessage: null,
    lastSettlementAttemptAt: null,
    settlementRetryCount: 0,
    ...overrides,
  };
}

function createFakeDb(bets: FakeBetRow[]) {
  const store = new Map<string, FakeBetRow>();
  for (const bet of bets) store.set(bet.id, { ...bet, selections: bet.selections.map((s) => ({ ...s })) });

  const findMany = async (args: { where: { type: string; status: string; settlementReviewStatus?: null } }) => {
    return Array.from(store.values())
      .filter((b) => b.type === args.where.type && b.status === args.where.status)
      .filter((b) => !("settlementReviewStatus" in args.where) || b.settlementReviewStatus === null)
      .map((b) => ({ ...b, selections: b.selections.map((s) => ({ ...s })) }));
  };

  const updateMany = async ({
    where,
    data,
  }: {
    where: { id: string; status: string; settlementReviewStatus: null };
    data: Partial<FakeBetRow>;
  }) => {
    const bet = store.get(where.id);
    if (!bet || bet.status !== where.status || bet.settlementReviewStatus !== where.settlementReviewStatus) {
      return { count: 0 };
    }
    Object.assign(bet, data);
    return { count: 1 };
  };

  return {
    bet: { findMany, updateMany },
    _debug: { getBet: (id: string) => store.get(id) },
  };
}

function db(fake: ReturnType<typeof createFakeDb>): PrismaClient {
  return fake as unknown as PrismaClient;
}

function input(overrides: Partial<EscalateExpiredPollingInput> = {}): EscalateExpiredPollingInput {
  return { now: NOW, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* SINGLE                                                                     */
/* -------------------------------------------------------------------------- */

test("1. correct provider-backed SINGLE outside the window -> NEEDS_REVIEW/POLLING_WINDOW_EXPIRED, retryCount stays 0", async () => {
  const fake = createFakeDb([fakeSingleBet({ id: "s1" })]);
  const report = await escalateExpiredPolling(db(fake), input());

  assert.equal(report.escalatedSingles, 1);
  const row = fake._debug.getBet("s1");
  assert.equal(row?.settlementReviewStatus, SettlementReviewStatus.NEEDS_REVIEW);
  assert.equal(row?.settlementReviewReason, SettlementReviewReason.POLLING_WINDOW_EXPIRED);
  assert.equal(row?.lastSettlementErrorCode, "POLLING_WINDOW_EXPIRED");
  assert.equal(row?.settlementRetryCount, 0);
  assert.equal(row?.lastSettlementAttemptAt, null); // no provider attempt was made
});

test("2. SINGLE inside the window is left untouched by the sweep", async () => {
  const fake = createFakeDb([fakeSingleBet({ id: "s1", eventStartTime: insideWindow() })]);
  const report = await escalateExpiredPolling(db(fake), input());

  assert.equal(report.escalatedSingles, 0);
  assert.equal(fake._debug.getBet("s1")?.settlementReviewStatus, null);
});

test("3. legacy SINGLE without provider metadata is left untouched by the sweep", async () => {
  const fake = createFakeDb([
    fakeSingleBet({
      id: "s1",
      providerName: null,
      providerSportKey: null,
      providerEventId: null,
      eventStartTime: null,
      canonicalMarketType: null,
      canonicalSelectionType: null,
      canonicalPeriod: null,
    }),
  ]);
  const report = await escalateExpiredPolling(db(fake), input());

  assert.equal(report.skippedLegacy, 1);
  assert.equal(report.escalatedSingles, 0);
  assert.equal(report.structurallyInvalid, 0);
  assert.equal(fake._debug.getBet("s1")?.settlementReviewStatus, null);
});

test("4. SINGLE with partially-filled provider metadata gets structural review, not POLLING_WINDOW_EXPIRED", async () => {
  const fake = createFakeDb([fakeSingleBet({ id: "s1", providerEventId: null })]);
  const report = await escalateExpiredPolling(db(fake), input());

  assert.equal(report.structurallyInvalid, 1);
  assert.equal(report.escalatedSingles, 0);
  const row = fake._debug.getBet("s1");
  assert.equal(row?.settlementReviewStatus, SettlementReviewStatus.NEEDS_REVIEW);
  assert.equal(row?.settlementReviewReason, SettlementReviewReason.MISSING_PROVIDER_REFERENCE);
});

/* -------------------------------------------------------------------------- */
/* EXPRESS                                                                    */
/* -------------------------------------------------------------------------- */

test("5. every provider-backed leg outside the window -> POLLING_WINDOW_EXPIRED", async () => {
  const legs = [fakeLeg({ id: "l1" }), fakeLeg({ id: "l2", providerEventId: "evt-2" })];
  const fake = createFakeDb([fakeExpressBet(legs, { id: "e1" })]);
  const report = await escalateExpiredPolling(db(fake), input());

  assert.equal(report.escalatedExpresses, 1);
  assert.equal(fake._debug.getBet("e1")?.settlementReviewReason, SettlementReviewReason.POLLING_WINDOW_EXPIRED);
});

test("6. one leg inside the window, the rest outside -> sweep does not escalate the bet", async () => {
  const legs = [fakeLeg({ id: "l1", eventStartTime: insideWindow() }), fakeLeg({ id: "l2", providerEventId: "evt-2" })];
  const fake = createFakeDb([fakeExpressBet(legs, { id: "e1" })]);
  const report = await escalateExpiredPolling(db(fake), input());

  assert.equal(report.escalatedExpresses, 0);
  assert.equal(report.structurallyInvalid, 0);
  assert.equal(fake._debug.getBet("e1")?.settlementReviewStatus, null);
});

test("7. one provider-backed leg missing eventStartTime -> structural review, not POLLING_WINDOW_EXPIRED", async () => {
  const legs = [fakeLeg({ id: "l1" }), fakeLeg({ id: "l2", providerEventId: "evt-2", eventStartTime: null })];
  const fake = createFakeDb([fakeExpressBet(legs, { id: "e1" })]);
  const report = await escalateExpiredPolling(db(fake), input());

  assert.equal(report.structurallyInvalid, 1);
  assert.equal(report.escalatedExpresses, 0);
  const row = fake._debug.getBet("e1");
  assert.equal(row?.settlementReviewReason, SettlementReviewReason.MISSING_PROVIDER_REFERENCE);
});

test("8. one leg missing providerEventId -> structural review", async () => {
  const legs = [fakeLeg({ id: "l1" }), fakeLeg({ id: "l2", providerEventId: null })];
  const fake = createFakeDb([fakeExpressBet(legs, { id: "e1" })]);
  const report = await escalateExpiredPolling(db(fake), input());

  assert.equal(report.structurallyInvalid, 1);
  assert.equal(fake._debug.getBet("e1")?.settlementReviewReason, SettlementReviewReason.MISSING_PROVIDER_REFERENCE);
});

test("9. every leg legacy -> fully skipped", async () => {
  const legs = [legacyLeg({ id: "l1" }), legacyLeg({ id: "l2" })];
  const fake = createFakeDb([fakeExpressBet(legs, { id: "e1" })]);
  const report = await escalateExpiredPolling(db(fake), input());

  assert.equal(report.skippedLegacy, 1);
  assert.equal(report.escalatedExpresses, 0);
  assert.equal(report.structurallyInvalid, 0);
  assert.equal(fake._debug.getBet("e1")?.settlementReviewStatus, null);
});

test("10. mixed EXPRESS (some legacy legs, some provider-backed) -> structural review, neither legacy-skip nor expiry", async () => {
  const legs = [legacyLeg({ id: "l1" }), fakeLeg({ id: "l2", providerEventId: "evt-2" })];
  const fake = createFakeDb([fakeExpressBet(legs, { id: "e1" })]);
  const report = await escalateExpiredPolling(db(fake), input());

  assert.equal(report.structurallyInvalid, 1);
  assert.equal(report.skippedLegacy, 0);
  assert.equal(report.escalatedExpresses, 0);
  assert.equal(fake._debug.getBet("e1")?.settlementReviewReason, SettlementReviewReason.MISSING_PROVIDER_REFERENCE);
});

/* -------------------------------------------------------------------------- */
/* Idempotency / concurrency                                                  */
/* -------------------------------------------------------------------------- */

test("11. repeated sweep does not re-escalate an already-escalated bet or double-count it", async () => {
  const fake = createFakeDb([fakeSingleBet({ id: "s1" })]);

  const first = await escalateExpiredPolling(db(fake), input());
  assert.equal(first.escalatedSingles, 1);
  const reasonAfterFirst = fake._debug.getBet("s1")?.settlementReviewReason;

  const second = await escalateExpiredPolling(db(fake), input());
  assert.equal(second.escalatedSingles, 0); // query itself excludes it now (settlementReviewStatus no longer null)
  assert.equal(second.scanned, 0);
  assert.equal(fake._debug.getBet("s1")?.settlementReviewReason, reasonAfterFirst); // unchanged
});

test("12. two concurrent sweeps against the same bet: exactly one real escalation, correct final status", async () => {
  const fake = createFakeDb([fakeSingleBet({ id: "s1" })]);

  // Both cycles read the bet via findMany before either writes (fake DB has
  // no real async interleaving to race on) — this proves the updateMany()
  // guard makes a second write against an already-escalated row a safe
  // no-op, the same idempotent-replay proof convention every earlier
  // settlement stage's own concurrency tests already use.
  const [r1, r2] = await Promise.all([escalateExpiredPolling(db(fake), input()), escalateExpiredPolling(db(fake), input())]);

  assert.equal(r1.escalatedSingles + r2.escalatedSingles, 1);
  assert.equal(fake._debug.getBet("s1")?.settlementReviewStatus, SettlementReviewStatus.NEEDS_REVIEW);
  assert.equal(fake._debug.getBet("s1")?.settlementReviewReason, SettlementReviewReason.POLLING_WINDOW_EXPIRED);
});

test("13. a bet already NEEDS_REVIEW is fully skipped by the query itself", async () => {
  const fake = createFakeDb([
    fakeSingleBet({ id: "s1", settlementReviewStatus: SettlementReviewStatus.NEEDS_REVIEW, settlementReviewReason: SettlementReviewReason.PARTICIPANT_MISMATCH }),
  ]);
  const report = await escalateExpiredPolling(db(fake), input());

  assert.equal(report.scanned, 0);
  assert.equal(fake._debug.getBet("s1")?.settlementReviewReason, SettlementReviewReason.PARTICIPANT_MISMATCH); // unchanged
});

test("14. a bet already SETTLED_WIN/VOID is fully skipped by the query itself", async () => {
  const fake = createFakeDb([fakeSingleBet({ id: "s1", status: "SETTLED_WIN" }), fakeSingleBet({ id: "s2", status: "VOID" })]);
  const report = await escalateExpiredPolling(db(fake), input());

  assert.equal(report.scanned, 0);
});

/* -------------------------------------------------------------------------- */
/* Boundary                                                                    */
/* -------------------------------------------------------------------------- */

test("15. eventStartTime exactly equal to windowStart matches active-polling semantics, never both queries at once", async () => {
  // pollConfirmedBetResults.ts's own active-polling query uses `gte:
  // windowStart` (inclusive) — the exact boundary instant belongs to
  // active polling only. This sweep's classifier must use a strict `<` so
  // the two are non-overlapping complements for the same shared windowStart.
  const disposition = classifySingleBetForSweep(fakeSingleBet({ eventStartTime: WINDOW_START }), WINDOW_START);
  assert.equal(disposition.kind, "SKIP_ACTIVE");

  const oneMsBefore = new Date(WINDOW_START.getTime() - 1);
  const expiredDisposition = classifySingleBetForSweep(fakeSingleBet({ eventStartTime: oneMsBefore }), WINDOW_START);
  assert.equal(expiredDisposition.kind, "EXPIRED");
});

test("15b. same boundary semantics hold for EXPRESS legs", () => {
  const atBoundary = classifyExpressBetForSweep(fakeExpressBet([fakeLeg({ eventStartTime: WINDOW_START })]), WINDOW_START);
  assert.equal(atBoundary.kind, "SKIP_ACTIVE");

  const justBefore = classifyExpressBetForSweep(fakeExpressBet([fakeLeg({ eventStartTime: new Date(WINDOW_START.getTime() - 1) })]), WINDOW_START);
  assert.equal(justBefore.kind, "EXPIRED");
});
