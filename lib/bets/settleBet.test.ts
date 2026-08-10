import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma, type BetStatus } from "@/lib/generated/prisma/client";
import {
  settleBet,
  BetNotFoundForSettlementError,
  MissingSettlementOddsError,
  InvalidEffectiveSettlementOddsError,
  type SettlementDatabase,
} from "./settleBet";
import {
  BetNotConfirmedForSettlementError,
  BetAlreadyRejectedError,
  InvalidSettlementTargetError,
  SettlementConflictError,
} from "./settlementRules";

// ---------------------------------------------------------------------
// In-memory fake Prisma client — same hand-written, no-mocking-library
// convention as lib/bets/createBetFromPreview.test.ts. Implements exactly
// the surface settleBet.ts actually calls: bet.findUnique, tx.bet.update
// (with the guarded WHERE that can P2025), tx.player.update (atomic
// increment), tx.transaction.create, $transaction.
// ---------------------------------------------------------------------

interface FakeBetRow {
  id: string;
  status: BetStatus;
  playerId: string;
  stake: Prisma.Decimal;
  totalOdds: Prisma.Decimal | null;
  odds: Prisma.Decimal | null;
}

interface FakePlayerRow {
  id: string;
  currentCredit: Prisma.Decimal;
}

interface FakeTransactionRow {
  id: string;
  playerId: string;
  betId: string;
  type: string;
  amount: Prisma.Decimal;
  balanceAfter: Prisma.Decimal;
  createdAt: Date;
}

function p2025(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("An operation failed because it depends on one or more records that were required but not found.", {
    code: "P2025",
    clientVersion: "test",
    meta: { modelName: "Bet" },
  });
}

const PLAYER_ID = "player-1";
const BET_ID = "bet-1";

function fakeBet(overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return {
    id: BET_ID,
    status: "CONFIRMED",
    playerId: PLAYER_ID,
    stake: new Prisma.Decimal(100),
    totalOdds: new Prisma.Decimal("2.10"),
    odds: new Prisma.Decimal("2.10"),
    ...overrides,
  };
}

function createFakeDb(seed: { bet?: FakeBetRow; playerCurrentCredit?: Prisma.Decimal } = {}) {
  const bets = new Map<string, FakeBetRow>();
  const players = new Map<string, FakePlayerRow>();
  const transactions: FakeTransactionRow[] = [];
  let nextTxId = 1;
  let playerUpdateCallCount = 0;
  let transactionCreateCallCount = 0;
  let betUpdateAttemptCount = 0;

  const initialBet = seed.bet ?? fakeBet();
  bets.set(initialBet.id, { ...initialBet });
  players.set(initialBet.playerId, {
    id: initialBet.playerId,
    currentCredit: seed.playerCurrentCredit ?? new Prisma.Decimal(0),
  });

  const tx = {
    bet: {
      update: async ({
        where,
        data,
      }: {
        where: { id: string; status: BetStatus };
        data: { status: BetStatus };
      }) => {
        betUpdateAttemptCount += 1;
        const bet = bets.get(where.id);
        if (!bet) throw p2025();
        if (bet.status !== where.status) throw p2025();
        bet.status = data.status;
        return { ...bet };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const bet = bets.get(where.id);
        return bet ? { ...bet } : null;
      },
    },
    player: {
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { currentCredit: { increment: Prisma.Decimal } };
      }) => {
        playerUpdateCallCount += 1;
        const player = players.get(where.id);
        if (!player) throw p2025();
        player.currentCredit = player.currentCredit.plus(data.currentCredit.increment);
        return { ...player };
      },
    },
    transaction: {
      create: async ({ data }: { data: Omit<FakeTransactionRow, "id" | "createdAt"> }) => {
        transactionCreateCallCount += 1;
        const row: FakeTransactionRow = { id: `tx-${nextTxId++}`, createdAt: new Date(), ...data };
        transactions.push(row);
        return row;
      },
    },
  };

  return {
    bet: {
      findUnique: tx.bet.findUnique,
    },
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    _debug: {
      getBet: (id: string) => bets.get(id),
      getPlayer: (id: string) => players.get(id),
      transactions: () => transactions,
      playerUpdateCallCount: () => playerUpdateCallCount,
      transactionCreateCallCount: () => transactionCreateCallCount,
      betUpdateAttemptCount: () => betUpdateAttemptCount,
    },
  };
}

function db(fake: ReturnType<typeof createFakeDb>): SettlementDatabase {
  return fake as unknown as SettlementDatabase;
}

// ---------------------------------------------------------------------
// WIN
// ---------------------------------------------------------------------

test("settleBet: CONFIRMED bet settles to SETTLED_WIN", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.10") }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(result.kind, "APPLIED");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN");
});

test("settleBet: WIN net profit is stake x odds - stake", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.10") }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "210"); // 100 * 2.10
  assert.equal(result.netProfit?.toString(), "110"); // 210 - 100
  assert.equal(result.amount.toString(), "110"); // delta === netProfit
});

test("settleBet: WIN uses totalOdds in preference to legacy odds", async () => {
  const fake = createFakeDb({
    bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.00"), odds: new Prisma.Decimal("9.99") }),
  });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "200"); // uses totalOdds=2.00, not legacy odds=9.99
});

test("settleBet: WIN falls back to legacy odds when totalOdds is null", async () => {
  const fake = createFakeDb({
    bet: fakeBet({ stake: new Prisma.Decimal(50), totalOdds: null, odds: new Prisma.Decimal("1.80") }),
  });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "90"); // 50 * 1.80
});

test("settleBet: WIN with both totalOdds and odds null throws MissingSettlementOddsError and performs no writes", async () => {
  const fake = createFakeDb({ bet: fakeBet({ totalOdds: null, odds: null }) });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" }),
    (err: unknown) => {
      assert.ok(err instanceof MissingSettlementOddsError);
      assert.equal(err.code, "MISSING_SETTLEMENT_ODDS");
      assert.equal(err.betId, BET_ID);
      return true;
    },
  );

  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED"); // unchanged
  assert.equal(fake._debug.playerUpdateCallCount(), 0);
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
  assert.equal(fake._debug.betUpdateAttemptCount(), 0); // never even attempted
});

test("settleBet: WIN creates a Transaction of type BET_PAYOUT with a positive amount", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(40), totalOdds: new Prisma.Decimal("1.85") }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  const [txRow] = fake._debug.transactions();
  assert.equal(txRow.type, "BET_PAYOUT");
  assert.ok(txRow.amount.gt(0));
  assert.equal(txRow.amount.toString(), result.amount.toString());
});

test("settleBet: WIN balanceAfter matches the persisted currentCredit", async () => {
  const fake = createFakeDb({
    bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.10") }),
    playerCurrentCredit: new Prisma.Decimal(50),
  });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.balanceAfter.toString(), "160"); // 50 + 110 net profit
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "160");
  assert.equal(fake._debug.transactions()[0].balanceAfter.toString(), "160");
});

// ---------------------------------------------------------------------
// LOSS
// ---------------------------------------------------------------------

test("settleBet: CONFIRMED bet settles to SETTLED_LOSS", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" });

  assert.equal(result.kind, "APPLIED");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_LOSS");
});

test("settleBet: LOSS delta is negative stake", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(75) }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.amount.toString(), "-75");
  assert.equal(result.grossPayout, undefined);
  assert.equal(result.netProfit, undefined);
});

test("settleBet: LOSS requires no odds — both totalOdds and odds null is fine", async () => {
  const fake = createFakeDb({ bet: fakeBet({ totalOdds: null, odds: null, stake: new Prisma.Decimal(30) }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.amount.toString(), "-30");
});

test("settleBet: LOSS creates a Transaction of type BET_STAKE", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(60) }) });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" });

  const [txRow] = fake._debug.transactions();
  assert.equal(txRow.type, "BET_STAKE");
  assert.equal(txRow.amount.toString(), "-60");
});

test("settleBet: LOSS balanceAfter is correct", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(20) }), playerCurrentCredit: new Prisma.Decimal(5) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.balanceAfter.toString(), "-15"); // 5 - 20
});

// ---------------------------------------------------------------------
// VOID
// ---------------------------------------------------------------------

test("settleBet: CONFIRMED bet settles to VOID", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "VOID" });

  assert.equal(result.kind, "APPLIED");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "VOID");
});

test("settleBet: VOID delta is zero and requires no odds", async () => {
  const fake = createFakeDb({ bet: fakeBet({ totalOdds: null, odds: null }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "VOID" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.amount.toString(), "0");
});

test("settleBet: VOID still creates exactly one zero-amount Transaction of type ADJUSTMENT", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "VOID" });

  assert.equal(fake._debug.transactions().length, 1);
  const [txRow] = fake._debug.transactions();
  assert.equal(txRow.type, "ADJUSTMENT");
  assert.equal(txRow.amount.toString(), "0");
});

test("settleBet: VOID leaves currentCredit unchanged, and balanceAfter equals it", async () => {
  const fake = createFakeDb({ bet: fakeBet(), playerCurrentCredit: new Prisma.Decimal(42) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "VOID" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.balanceAfter.toString(), "42");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "42");
});

// ---------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------

test("settleBet: repeating the same settlement returns IDEMPOTENT with no writes", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  const first = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });
  const second = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(first.kind, "APPLIED");
  assert.deepEqual(second, { kind: "IDEMPOTENT", betId: BET_ID, status: "SETTLED_WIN" });
  assert.equal(fake._debug.playerUpdateCallCount(), 1); // only the first call wrote
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
  assert.equal(fake._debug.transactions().length, 1); // repeated request never produces a second payout
});

test("settleBet: idempotent VOID repeat also performs no writes", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "VOID" });
  const second = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "VOID" });

  assert.deepEqual(second, { kind: "IDEMPOTENT", betId: BET_ID, status: "VOID" });
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
});

// ---------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------

test("settleBet: settled WIN followed by a LOSS request throws SettlementConflictError and performs no writes", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" }),
    (err: unknown) => {
      assert.ok(err instanceof SettlementConflictError);
      assert.equal(err.currentStatus, "SETTLED_WIN");
      assert.equal(err.requestedStatus, "SETTLED_LOSS");
      return true;
    },
  );

  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN"); // unchanged
  assert.equal(fake._debug.transactionCreateCallCount(), 1); // only the original WIN
});

test("settleBet: settled LOSS followed by a VOID request throws SettlementConflictError", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "VOID" }),
    (err: unknown) => err instanceof SettlementConflictError,
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
});

test("settleBet: PENDING cannot settle", async () => {
  const fake = createFakeDb({ bet: fakeBet({ status: "PENDING" }) });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" }),
    (err: unknown) => err instanceof BetNotConfirmedForSettlementError,
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("settleBet: REJECTED cannot settle", async () => {
  const fake = createFakeDb({ bet: fakeBet({ status: "REJECTED" }) });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" }),
    (err: unknown) => err instanceof BetAlreadyRejectedError,
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("settleBet: an invalid requested status is rejected by settlementRules with no writes", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "REJECTED" as never }),
    (err: unknown) => err instanceof InvalidSettlementTargetError,
  );
  assert.equal(fake._debug.betUpdateAttemptCount(), 0);
});

test("settleBet: an unknown betId throws BetNotFoundForSettlementError", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  await assert.rejects(
    () => settleBet(db(fake), { betId: "does-not-exist", requestedStatus: "SETTLED_WIN" }),
    (err: unknown) => {
      assert.ok(err instanceof BetNotFoundForSettlementError);
      assert.equal(err.betId, "does-not-exist");
      return true;
    },
  );
});

// ---------------------------------------------------------------------
// Atomicity / race safety
// ---------------------------------------------------------------------

test("settleBet: failure during the Player update rolls back — Bet status is not left dangling as settled with no credit change", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  const failingDb = {
    bet: { findUnique: fake.bet.findUnique },
    $transaction: async <T>(fn: (t: unknown) => Promise<T>) => {
      // Simulates Postgres rolling back the whole transaction when a later
      // statement inside it throws — the real $transaction guarantee this
      // fake is standing in for.
      return fn({
        bet: {
          update: async (args: Parameters<typeof fake.$transaction>[0]) => {
            void args;
            return fake._debug.getBet(BET_ID);
          },
          findUnique: fake.bet.findUnique,
        },
        player: {
          update: async () => {
            throw new Error("simulated Player update failure");
          },
        },
        transaction: { create: async () => ({}) },
      }).catch((err: unknown) => {
        // Real Prisma $transaction re-throws after rollback; nothing this
        // fake wrote (it wrote nothing — the failure happened before any
        // real store mutation) needs undoing, which is exactly the point:
        // the underlying fake store was never touched by this attempt.
        throw err;
      });
    },
  } as unknown as SettlementDatabase;

  await assert.rejects(() => settleBet(failingDb, { betId: BET_ID, requestedStatus: "SETTLED_WIN" }));
  // The original fake db (untouched by the failing attempt) still shows
  // the bet as CONFIRMED — proving no partial state (settled status with
  // no matching credit change) was ever visible.
  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED");
});

test("settleBet: guarded Bet update losing a race to a different final result throws SettlementConflictError and never touches credit", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  const raceDb = {
    bet: { findUnique: fake.bet.findUnique },
    $transaction: async <T>(fn: (t: unknown) => Promise<T>) => {
      let firstAttempt = true;
      const tx = {
        bet: {
          update: async ({ where, data }: { where: { id: string; status: BetStatus }; data: { status: BetStatus } }) => {
            if (firstAttempt) {
              firstAttempt = false;
              // Simulate a concurrent request winning the race and
              // settling this bet to LOSS right before our own guarded
              // update runs.
              const b = fake._debug.getBet(BET_ID)!;
              b.status = "SETTLED_LOSS";
            }
            const b = fake._debug.getBet(BET_ID)!;
            if (b.status !== where.status) throw p2025();
            b.status = data.status;
            return { ...b };
          },
          findUnique: fake.bet.findUnique,
        },
        player: {
          update: async ({ data }: { data: { currentCredit: { increment: Prisma.Decimal } } }) => {
            const p = fake._debug.getPlayer(PLAYER_ID)!;
            p.currentCredit = p.currentCredit.plus(data.currentCredit.increment);
            return { ...p };
          },
        },
        transaction: {
          create: async (args: { data: Record<string, unknown> }) => ({ id: "should-not-be-created", ...args.data }),
        },
      };
      return fn(tx);
    },
  } as unknown as SettlementDatabase;

  await assert.rejects(
    () => settleBet(raceDb, { betId: BET_ID, requestedStatus: "SETTLED_WIN" }),
    (err: unknown) => err instanceof SettlementConflictError,
  );

  // Credit was never touched by the losing request.
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "0");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_LOSS"); // the winner's result stands
});

test("settleBet: guarded Bet update losing a race to the SAME final result resolves IDEMPOTENT, no double write", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  const raceDb = {
    bet: { findUnique: fake.bet.findUnique },
    $transaction: async <T>(fn: (t: unknown) => Promise<T>) => {
      let firstAttempt = true;
      const tx = {
        bet: {
          update: async ({ where, data }: { where: { id: string; status: BetStatus }; data: { status: BetStatus } }) => {
            if (firstAttempt) {
              firstAttempt = false;
              const b = fake._debug.getBet(BET_ID)!;
              // Concurrent request already applied the exact same result.
              b.status = "SETTLED_WIN";
            }
            const b = fake._debug.getBet(BET_ID)!;
            if (b.status !== where.status) throw p2025();
            b.status = data.status;
            return { ...b };
          },
          findUnique: fake.bet.findUnique,
        },
        player: {
          update: async ({ data }: { data: { currentCredit: { increment: Prisma.Decimal } } }) => {
            const p = fake._debug.getPlayer(PLAYER_ID)!;
            p.currentCredit = p.currentCredit.plus(data.currentCredit.increment);
            return { ...p };
          },
        },
        transaction: {
          create: async (args: { data: Record<string, unknown> }) => ({ id: "should-not-be-created", ...args.data }),
        },
      };
      return fn(tx);
    },
  } as unknown as SettlementDatabase;

  const result = await settleBet(raceDb, { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.deepEqual(result, { kind: "IDEMPOTENT", betId: BET_ID, status: "SETTLED_WIN" });
  // No credit change from the losing request — only whatever the
  // (simulated) concurrent winner already did, which this fake never
  // routes through player.update either.
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "0");
});

test("settleBet: genuinely concurrent identical settlement requests produce one APPLIED and one IDEMPOTENT, exactly one Transaction row", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  const [a, b] = await Promise.all([
    settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" }),
    settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" }),
  ]);

  const kinds = [a.kind, b.kind].sort();
  assert.deepEqual(kinds, ["APPLIED", "IDEMPOTENT"]);
  assert.equal(fake._debug.transactions().length, 1);
  assert.equal(fake._debug.playerUpdateCallCount(), 1);
});

test("settleBet: genuinely concurrent conflicting settlement requests produce one APPLIED and one thrown conflict, exactly one Transaction row", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  const results = await Promise.allSettled([
    settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" }),
    settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0] as PromiseRejectedResult).reason instanceof SettlementConflictError, true);
  assert.equal(fake._debug.transactions().length, 1);
  assert.equal(fake._debug.playerUpdateCallCount(), 1);
});

// ---------------------------------------------------------------------
// Decimal precision
// ---------------------------------------------------------------------

test("settleBet: stake 0.29 x odds 3 exposes a real native-float artifact that Decimal must avoid", () => {
  // Sanity check on the underlying arithmetic the next test then exercises
  // through settleBet: native JS floats produce 0.29 * 3 ===
  // 0.8699999999999999, not the exact 0.87 Prisma.Decimal must produce.
  assert.notEqual(0.29 * 3, 0.87);
});

test("settleBet: WIN with stake 0.10 and odds 1.30 produces an exact Decimal result, never a floating-point artifact", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal("0.10"), totalOdds: new Prisma.Decimal("1.30"), odds: null }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "0.13");
  assert.equal(result.netProfit?.toString(), "0.03");
  assert.ok(result.amount instanceof Prisma.Decimal);
});

test("settleBet: WIN with stake 0.29 and odds 3 produces the exact 0.87 gross payout, not the native-float 0.8699999999999999", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal("0.29"), totalOdds: new Prisma.Decimal("3"), odds: null }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "0.87");
  assert.equal(result.netProfit?.toString(), "0.58");
});

test("settleBet: ROUND_HALF_UP applies at 2 decimal places for a result that lands exactly on the boundary", async () => {
  // 33.335 * 1 = 33.335 -> rounds to 33.34 under HALF_UP (not 33.33, which
  // banker's/HALF_EVEN rounding could produce instead).
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal("33.335"), totalOdds: new Prisma.Decimal("2"), odds: null }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  // grossPayout = 33.335 * 2 = 66.67 exactly (no half-way rounding needed
  // here) — netProfit = 66.67 - 33.335 = 33.335, which itself lands
  // exactly on the HALF_UP boundary at 2dp and must round up to 33.34.
  assert.equal(result.netProfit?.toString(), "33.34");
});

test("settleBet: a large Decimal stake never converts to a native number", async () => {
  const bigStake = new Prisma.Decimal("123456789012.123456");
  const fake = createFakeDb({ bet: fakeBet({ stake: bigStake, totalOdds: new Prisma.Decimal("1.50"), odds: null }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  // Exact Decimal negation — a native-number round-trip would have lost
  // precision on a value this size.
  assert.equal(result.amount.toString(), "-123456789012.12"); // rounded to 2dp per the settlement convention
});

test("settleBet: does not mutate the source Decimal inputs", async () => {
  const stake = new Prisma.Decimal(100);
  const totalOdds = new Prisma.Decimal("2.10");
  const stakeSnapshot = stake.toString();
  const oddsSnapshot = totalOdds.toString();

  const fake = createFakeDb({ bet: fakeBet({ stake, totalOdds }) });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  // Prisma.Decimal is itself immutable (every operation returns a new
  // instance), so this is really confirming settleBet never does anything
  // unusual like reassigning into the original object's fields.
  assert.equal(stake.toString(), stakeSnapshot);
  assert.equal(totalOdds.toString(), oddsSnapshot);
});

// ---------------------------------------------------------------------
// Database relation correctness
// ---------------------------------------------------------------------

test("settleBet: Transaction.playerId and betId are correct", async () => {
  const fake = createFakeDb({ bet: fakeBet({ playerId: "player-xyz" }) });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" });

  const [txRow] = fake._debug.transactions();
  assert.equal(txRow.playerId, "player-xyz");
  assert.equal(txRow.betId, BET_ID);
});

test("settleBet: Transaction.balanceAfter equals the final persisted currentCredit for all three outcomes", async () => {
  for (const target of ["SETTLED_WIN", "SETTLED_LOSS", "VOID"] as const) {
    const fake = createFakeDb({ bet: fakeBet({ id: "bet-x", stake: new Prisma.Decimal(20), totalOdds: new Prisma.Decimal("3.00") }), playerCurrentCredit: new Prisma.Decimal(7) });
    const result = await settleBet(db(fake), { betId: "bet-x", requestedStatus: target });

    assert.equal(result.kind, "APPLIED");
    if (result.kind !== "APPLIED") continue;
    const [txRow] = fake._debug.transactions();
    assert.equal(txRow.balanceAfter.toString(), result.balanceAfter.toString());
    assert.equal(fake._debug.getPlayer("player-1")?.currentCredit.toString(), result.balanceAfter.toString());
  }
});

// ---------------------------------------------------------------------
// EXPRESS settlement — whole-Bet granularity only.
//
// Architectural context (see the Settlement audit): prisma/schema.prisma's
// BetSelection model has no settlement-status column at all, and
// settleBet.ts's own bet.findUnique select (line ~162) never reads `type`
// or `selections` — only id/status/playerId/stake/totalOdds/odds. Settlement
// math is therefore IDENTICAL for SINGLE and EXPRESS by construction; there
// is no EXPRESS-specific branch inside settleBet.ts to exercise separately.
// What the tests below actually prove:
//   1. A real EXPRESS-shaped Bet (canonical Bet.totalOdds, legacy Bet.odds
//      null, 2+ BetSelection rows) settles correctly using Bet.totalOdds —
//      never re-deriving a price from the individual selections' own odds
//      or falling back to legacy odds while totalOdds is present.
//   2. BetSelection rows are provably untouched. settleBet.ts's only
//      database calls are bet.findUnique / tx.bet.update / tx.player.update
//      / tx.transaction.create — never tx.betSelection.* — and
//      SettleBetInput (settleBet.ts:21-24) doesn't even accept selection
//      data as input. No shared fake-db change is needed for this: the
//      existing createFakeDb() tx object already has no `betSelection`
//      property, so an accidental future tx.betSelection.* call inside
//      settleBet.ts would throw immediately and fail every test in this
//      file, not just these. The fixture below lives entirely outside the
//      fake db (never passed into settleBet()) and is asserted unchanged
//      purely to lock in and document that contract.
// ---------------------------------------------------------------------

// Mirrors prisma/schema.prisma's BetSelection shape (sport/event/outcome/
// odds) closely enough to be recognizable as "the real thing" — not a
// Prisma model, just a plain fixture settleBet() never receives a
// reference to.
interface FakeBetSelectionRow {
  id: string;
  betId: string;
  sport: string;
  event: string;
  outcome: string;
  odds: Prisma.Decimal;
}

// Deliberately does NOT multiply to totalOdds (1.50 * 1.80 = 2.70, while
// expressBet()'s default totalOdds is 2.50) — Step "EXPRESS WIN uses
// canonical Bet.totalOdds" below depends on this mismatch to prove
// settleBet() never re-derives a price from these.
function fakeExpressSelections(betId: string): readonly FakeBetSelectionRow[] {
  return [
    { id: "sel-1", betId, sport: "Football", event: "Real Madrid vs Barcelona", outcome: "Real Madrid Win", odds: new Prisma.Decimal("1.50") },
    { id: "sel-2", betId, sport: "Football", event: "Inter vs Juventus", outcome: "Inter Win", odds: new Prisma.Decimal("1.80") },
  ];
}

function selectionsFingerprint(selections: readonly FakeBetSelectionRow[]): string {
  return JSON.stringify(selections.map((s) => ({ ...s, odds: s.odds.toString() })));
}

// A real EXPRESS Bet row per prisma/schema.prisma: no single event/outcome
// of its own (both live on BetSelection, Stage 12), totalOdds is the
// canonical combined price, legacy odds is null (no EXPRESS bet was ever
// created through the pre-Stage-1 single-event path). `type: "EXPRESS"`
// itself is deliberately not part of this fixture — settleBet.ts's own
// select never reads it (confirmed above), so FakeBetRow correctly has no
// such field either; what makes a fixture "EXPRESS" here is the paired
// fakeExpressSelections() below, exactly as a real multi-selection Bet row
// would be paired with 2+ BetSelection rows.
function expressBet(overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return fakeBet({ stake: new Prisma.Decimal(50), totalOdds: new Prisma.Decimal("2.50"), odds: null, ...overrides });
}

test("settleBet: EXPRESS WIN — CONFIRMED with 2 selections settles using Bet.totalOdds, BetSelection rows untouched", async () => {
  const fake = createFakeDb({ bet: expressBet() });
  const selections = fakeExpressSelections(BET_ID);
  const before = selectionsFingerprint(selections);

  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN");
  assert.equal(result.grossPayout?.toString(), "125"); // 50 * 2.50 (Bet.totalOdds)
  assert.equal(result.netProfit?.toString(), "75"); // 125 - 50
  assert.equal(result.amount.toString(), "75");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "75");
  assert.equal(fake._debug.transactions().length, 1);
  const [txRow] = fake._debug.transactions();
  assert.equal(txRow.type, "BET_PAYOUT");
  assert.equal(txRow.amount.toString(), "75");

  assert.equal(selectionsFingerprint(selections), before, "BetSelection rows must be unchanged after settlement");
});

test("settleBet: EXPRESS LOSS — CONFIRMED with 3 selections, credit decreases by exactly stake, no odds required, BetSelection untouched", async () => {
  const bet = expressBet({ stake: new Prisma.Decimal(40) });
  const fake = createFakeDb({ bet });
  const selections = [
    ...fakeExpressSelections(BET_ID),
    { id: "sel-3", betId: BET_ID, sport: "Football", event: "Bayern vs Dortmund", outcome: "Bayern Win", odds: new Prisma.Decimal("1.40") },
  ];
  const before = selectionsFingerprint(selections);

  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_LOSS");
  assert.equal(result.amount.toString(), "-40");
  assert.equal(result.grossPayout, undefined);
  assert.equal(result.netProfit, undefined);
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "-40");
  assert.equal(fake._debug.transactions().length, 1);
  const [txRow] = fake._debug.transactions();
  assert.equal(txRow.type, "BET_STAKE");
  assert.equal(txRow.amount.toString(), "-40");

  assert.equal(selectionsFingerprint(selections), before, "BetSelection rows must be unchanged after settlement");
});

test("settleBet: EXPRESS VOID — CONFIRMED with 2 selections, credit unchanged, single zero-amount ADJUSTMENT Transaction, BetSelection untouched", async () => {
  const fake = createFakeDb({ bet: expressBet(), playerCurrentCredit: new Prisma.Decimal(15) });
  const selections = fakeExpressSelections(BET_ID);
  const before = selectionsFingerprint(selections);

  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "VOID" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(fake._debug.getBet(BET_ID)?.status, "VOID");
  assert.equal(result.amount.toString(), "0");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "15"); // unchanged
  assert.equal(fake._debug.transactions().length, 1);
  const [txRow] = fake._debug.transactions();
  assert.equal(txRow.type, "ADJUSTMENT");
  assert.equal(txRow.amount.toString(), "0");

  assert.equal(selectionsFingerprint(selections), before, "BetSelection rows must be unchanged after settlement");
});

test("settleBet: EXPRESS WIN uses canonical Bet.totalOdds — never the legacy Bet.odds value, never the selections' own odds multiplied together", async () => {
  // Three deliberately different numbers: totalOdds=2.50 (canonical, must
  // win), selection odds 1.50*1.80=2.70 (must be ignored — and can't be
  // read anyway, per this file's own header comment), legacy odds=9.99
  // (must be ignored while totalOdds is present, same precedence already
  // proven for SINGLE by "settleBet: WIN uses totalOdds in preference to
  // legacy odds" above).
  const fake = createFakeDb({
    bet: expressBet({ stake: new Prisma.Decimal(50), totalOdds: new Prisma.Decimal("2.50"), odds: new Prisma.Decimal("9.99") }),
  });
  const selections = fakeExpressSelections(BET_ID); // product = 1.50 * 1.80 = 2.70, unused

  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "125", "must use totalOdds=2.50, not the legacy odds=9.99 or the selections' 1.50*1.80=2.70 product");
  assert.equal(result.netProfit?.toString(), "75");
  void selections; // documents the mismatch above; never read by settleBet()
});

test("settleBet: EXPRESS idempotency — repeating the same settlement returns IDEMPOTENT, no second write, BetSelection still untouched", async () => {
  const fake = createFakeDb({ bet: expressBet() });
  const selections = fakeExpressSelections(BET_ID);
  const before = selectionsFingerprint(selections);

  const first = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });
  const second = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(first.kind, "APPLIED");
  assert.deepEqual(second, { kind: "IDEMPOTENT", betId: BET_ID, status: "SETTLED_WIN" });
  assert.equal(fake._debug.playerUpdateCallCount(), 1);
  assert.equal(fake._debug.transactions().length, 1);
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "75"); // only the first call's net profit

  assert.equal(selectionsFingerprint(selections), before, "BetSelection rows must be unchanged after either call");
});

test("settleBet: EXPRESS conflict — SETTLED_WIN followed by a SETTLED_LOSS request throws SettlementConflictError, no further writes, BetSelection untouched", async () => {
  const fake = createFakeDb({ bet: expressBet() });
  const selections = fakeExpressSelections(BET_ID);
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });
  const before = selectionsFingerprint(selections);

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" }),
    (err: unknown) => {
      assert.ok(err instanceof SettlementConflictError);
      assert.equal(err.currentStatus, "SETTLED_WIN");
      assert.equal(err.requestedStatus, "SETTLED_LOSS");
      return true;
    },
  );

  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN"); // unchanged
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "75"); // unchanged by the rejected LOSS
  assert.equal(fake._debug.transactions().length, 1); // only the original WIN
  assert.equal(selectionsFingerprint(selections), before, "BetSelection rows must be unchanged after the rejected conflicting request");
});

test("settleBet: EXPRESS WIN with both totalOdds and legacy odds null throws MissingSettlementOddsError and performs no writes at all", async () => {
  const fake = createFakeDb({ bet: expressBet({ totalOdds: null, odds: null }) });
  const selections = fakeExpressSelections(BET_ID);
  const before = selectionsFingerprint(selections);

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" }),
    (err: unknown) => {
      assert.ok(err instanceof MissingSettlementOddsError);
      assert.equal(err.code, "MISSING_SETTLEMENT_ODDS");
      assert.equal(err.betId, BET_ID);
      return true;
    },
  );

  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED"); // unchanged
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "0"); // unchanged
  assert.equal(fake._debug.playerUpdateCallCount(), 0);
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
  assert.equal(fake._debug.betUpdateAttemptCount(), 0); // never even attempted — aborted before the transaction opened
  assert.equal(selectionsFingerprint(selections), before, "BetSelection rows must be unchanged after a rejected settlement attempt");
});

// ---------------------------------------------------------------------
// Stage 3.4A — optional caller-computed effectiveOdds, WIN only.
//
// Architectural context (see the Stage 3.4A audit): BetSelection.odds and
// Bet.totalOdds/Bet.odds are provably immutable after creation — no
// bet.update()/betSelection.update() call anywhere in the codebase ever
// writes to them (every bet.update() call site writes only `status`). A
// caller-computed effectiveOdds therefore has no staleness/TOCTOU risk to
// guard against here; it's just an ordinary immutable input value.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// B. Override behavior
// ---------------------------------------------------------------------

test("effectiveOdds: WIN uses the override instead of Bet.totalOdds", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("6.00") }) });
  const result = await settleBet(db(fake), {
    betId: BET_ID,
    requestedStatus: "SETTLED_WIN",
    effectiveOdds: new Prisma.Decimal("2.00"),
  });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "200"); // 100 * 2.00, not 100 * 6.00
  assert.equal(result.netProfit?.toString(), "100");
  assert.equal(result.amount.toString(), "100");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "100");
  assert.equal(fake._debug.transactions().length, 1);
});

test("effectiveOdds: WIN uses the override instead of legacy Bet.odds", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(50), totalOdds: null, odds: new Prisma.Decimal("9.99") }) });
  const result = await settleBet(db(fake), {
    betId: BET_ID,
    requestedStatus: "SETTLED_WIN",
    effectiveOdds: new Prisma.Decimal("3.00"),
  });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "150"); // 50 * 3.00, not 50 * 9.99
});

test("effectiveOdds: stake 100, stored totalOdds 6.00, effectiveOdds 2.00 — exact worked example from the task", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("6.00") }) });
  const result = await settleBet(db(fake), {
    betId: BET_ID,
    requestedStatus: "SETTLED_WIN",
    effectiveOdds: new Prisma.Decimal("2.00"),
  });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "200");
  assert.equal(result.netProfit?.toString(), "100");
  const [txRow] = fake._debug.transactions();
  assert.equal(txRow.type, "BET_PAYOUT");
  assert.equal(txRow.amount.toString(), "100");
  assert.equal(fake._debug.playerUpdateCallCount(), 1); // balance changed exactly once
});

test("effectiveOdds = 1.00 -> gross return equals stake, delta 0, status SETTLED_WIN, a real zero-amount BET_PAYOUT Transaction is still created", async () => {
  // Existing rule (unchanged, verified against the real code): settleBet()
  // creates tx.transaction.create() unconditionally after a WIN decision —
  // there is no "skip if delta is zero" branch. VOID's zero-amount
  // Transaction uses type ADJUSTMENT; a WIN that happens to compute a
  // zero delta (effectiveOdds=1.00) still uses type BET_PAYOUT — this test
  // locks in that existing distinction rather than assuming VOID's behavior
  // silently applies here too.
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("6.00") }) });
  const result = await settleBet(db(fake), {
    betId: BET_ID,
    requestedStatus: "SETTLED_WIN",
    effectiveOdds: new Prisma.Decimal("1.00"),
  });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "100");
  assert.equal(result.netProfit?.toString(), "0");
  assert.equal(result.amount.toString(), "0");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN");
  assert.equal(fake._debug.transactions().length, 1);
  const [txRow] = fake._debug.transactions();
  assert.equal(txRow.type, "BET_PAYOUT");
  assert.equal(txRow.amount.toString(), "0");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "0"); // unchanged: delta is exactly 0
});

// ---------------------------------------------------------------------
// C. Validation
// ---------------------------------------------------------------------

test("effectiveOdds: zero is rejected, no writes", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN", effectiveOdds: new Prisma.Decimal(0) }),
    (err: unknown) => {
      assert.ok(err instanceof InvalidEffectiveSettlementOddsError);
      assert.equal(err.code, "INVALID_EFFECTIVE_SETTLEMENT_ODDS");
      assert.equal(err.betId, BET_ID);
      return true;
    },
  );
  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
  assert.equal(fake._debug.betUpdateAttemptCount(), 0);
});

test("effectiveOdds: negative is rejected, no writes", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN", effectiveOdds: new Prisma.Decimal("-2.00") }),
    (err: unknown) => err instanceof InvalidEffectiveSettlementOddsError,
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("effectiveOdds: NaN is rejected, no writes", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  const nanOdds = new Prisma.Decimal(NaN);
  assert.ok(nanOdds.isNaN(), "test setup: Prisma.Decimal must actually be able to represent NaN");

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN", effectiveOdds: nanOdds }),
    (err: unknown) => err instanceof InvalidEffectiveSettlementOddsError,
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("effectiveOdds: Infinity is rejected, no writes", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  const infOdds = new Prisma.Decimal(Infinity);
  assert.ok(!infOdds.isFinite(), "test setup: Prisma.Decimal must actually be able to represent Infinity");

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN", effectiveOdds: infOdds }),
    (err: unknown) => err instanceof InvalidEffectiveSettlementOddsError,
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("effectiveOdds: a non-Decimal value at the runtime boundary is rejected, not silently coerced", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  await assert.rejects(
    () =>
      settleBet(db(fake), {
        betId: BET_ID,
        requestedStatus: "SETTLED_WIN",
        effectiveOdds: "2.00" as unknown as Prisma.Decimal,
      }),
    (err: unknown) => err instanceof InvalidEffectiveSettlementOddsError,
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("effectiveOdds: provided for SETTLED_LOSS is rejected (misuse), no writes", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  await assert.rejects(
    () =>
      settleBet(db(fake), {
        betId: BET_ID,
        requestedStatus: "SETTLED_LOSS",
        effectiveOdds: new Prisma.Decimal("2.00"),
      }),
    (err: unknown) => {
      assert.ok(err instanceof InvalidEffectiveSettlementOddsError);
      return true;
    },
  );
  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("effectiveOdds: provided for VOID is rejected (misuse), no writes", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  await assert.rejects(
    () =>
      settleBet(db(fake), {
        betId: BET_ID,
        requestedStatus: "VOID",
        effectiveOdds: new Prisma.Decimal("2.00"),
      }),
    (err: unknown) => err instanceof InvalidEffectiveSettlementOddsError,
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("effectiveOdds: validation runs before any database read (fails fast even for a bet that doesn't exist)", async () => {
  const fake = createFakeDb();

  await assert.rejects(
    () =>
      settleBet(db(fake), {
        betId: "nonexistent-bet",
        requestedStatus: "SETTLED_LOSS",
        effectiveOdds: new Prisma.Decimal("2.00"),
      }),
    (err: unknown) => err instanceof InvalidEffectiveSettlementOddsError,
  );
});

// ---------------------------------------------------------------------
// D. Fallback
// ---------------------------------------------------------------------

test("effectiveOdds absent -> falls back to Bet.totalOdds exactly as before (regression guard)", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.10") }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "210");
});

test("effectiveOdds absent + totalOdds null -> falls back to legacy Bet.odds exactly as before (regression guard)", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(50), totalOdds: null, odds: new Prisma.Decimal("1.80") }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "90");
});

test("effectiveOdds absent + totalOdds null + odds null -> MissingSettlementOddsError exactly as before (regression guard)", async () => {
  const fake = createFakeDb({ bet: fakeBet({ totalOdds: null, odds: null }) });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" }),
    (err: unknown) => err instanceof MissingSettlementOddsError,
  );
});

test("effectiveOdds present + totalOdds null + odds null -> settlement still succeeds using the override alone", async () => {
  // Confirmed safe by the Stage 3.4A audit: the only real eligibility gate
  // (decideSettlementTransition — CONFIRMED-or-already-settled) is
  // orthogonal to odds presence and already ran before this point; nothing
  // is bypassed by letting effectiveOdds be the sole financial source.
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(40), totalOdds: null, odds: null }) });
  const result = await settleBet(db(fake), {
    betId: BET_ID,
    requestedStatus: "SETTLED_WIN",
    effectiveOdds: new Prisma.Decimal("2.50"),
  });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "100"); // 40 * 2.50
  assert.equal(result.netProfit?.toString(), "60");
});

// ---------------------------------------------------------------------
// E. Idempotency
// ---------------------------------------------------------------------

test("effectiveOdds: first WIN with an override applies; a second identical call is idempotent", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("6.00") }) });

  const first = await settleBet(db(fake), {
    betId: BET_ID,
    requestedStatus: "SETTLED_WIN",
    effectiveOdds: new Prisma.Decimal("2.00"),
  });
  const second = await settleBet(db(fake), {
    betId: BET_ID,
    requestedStatus: "SETTLED_WIN",
    effectiveOdds: new Prisma.Decimal("2.00"),
  });

  assert.equal(first.kind, "APPLIED");
  assert.deepEqual(second, { kind: "IDEMPOTENT", betId: BET_ID, status: "SETTLED_WIN" });
  assert.equal(fake._debug.transactions().length, 1);
  assert.equal(fake._debug.playerUpdateCallCount(), 1);
});

test("effectiveOdds: a second call with a DIFFERENT effectiveOdds after settlement is still idempotent and does not recompute/rewrite anything", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("6.00") }) });

  const first = await settleBet(db(fake), {
    betId: BET_ID,
    requestedStatus: "SETTLED_WIN",
    effectiveOdds: new Prisma.Decimal("2.00"),
  });
  assert.equal(first.kind, "APPLIED");
  const balanceAfterFirst = fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString();

  // A materially different override — decideSettlementTransition() resolves
  // IDEMPOTENT purely from status (SETTLED_WIN === SETTLED_WIN), before
  // computeSettlementFinancials() is ever reached, so this value is
  // validated but never used to recompute anything.
  const second = await settleBet(db(fake), {
    betId: BET_ID,
    requestedStatus: "SETTLED_WIN",
    effectiveOdds: new Prisma.Decimal("6.00"),
  });

  assert.deepEqual(second, { kind: "IDEMPOTENT", betId: BET_ID, status: "SETTLED_WIN" });
  assert.equal(fake._debug.transactions().length, 1); // no second Transaction
  assert.equal(fake._debug.playerUpdateCallCount(), 1); // balance not touched again
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), balanceAfterFirst); // still the FIRST call's result (100 net profit, not 500)
});

// ---------------------------------------------------------------------
// F. Conflict — effectiveOdds must never influence status transition rules
// ---------------------------------------------------------------------

test("effectiveOdds: after SETTLED_WIN via override, a LOSS request is still a conflict", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN", effectiveOdds: new Prisma.Decimal("2.00") });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" }),
    (err: unknown) => err instanceof SettlementConflictError,
  );
  assert.equal(fake._debug.transactions().length, 1);
});

test("effectiveOdds: after a LOSS, a WIN request with an override is still a conflict, not a silent overwrite", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN", effectiveOdds: new Prisma.Decimal("2.00") }),
    (err: unknown) => err instanceof SettlementConflictError,
  );
  assert.equal(fake._debug.transactions().length, 1);
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_LOSS");
});

// ---------------------------------------------------------------------
// H4-B3 — SETTLED_HALF_WIN / SETTLED_HALF_LOSS financial settlement.
//
// Defined as exactly half the stake settling as a full WIN (or LOSS) and
// the other half settling as a VOID — the SAME computation shape
// SETTLED_WIN/SETTLED_LOSS already use above, just at halfStake =
// stake/2. VOID's own delta is always exactly zero (stake is never
// deducted at confirmation — see the VOID section above), so it never
// needs to appear as a separate term in any assertion below.
// ---------------------------------------------------------------------

test("settleBet: CONFIRMED bet settles to SETTLED_HALF_WIN", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.00") }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" });

  assert.equal(result.kind, "APPLIED");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_HALF_WIN");
});

test("settleBet: CONFIRMED bet settles to SETTLED_HALF_LOSS", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100) }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_LOSS" });

  assert.equal(result.kind, "APPLIED");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_HALF_LOSS");
});

// HALF_WIN delta must equal exactly what "50 stake WIN @ O" + "50 stake
// VOID" would produce: netProfit of a halfStake WIN, i.e.
// roundMoney(halfStake * O) - halfStake.
const HALF_WIN_CASES: Array<{ stake: string; odds: string; grossPayout: string; netProfit: string }> = [
  { stake: "100", odds: "2.00", grossPayout: "100", netProfit: "50" }, // halfStake 50 * 2.00 = 100, -50 = 50
  { stake: "100", odds: "1.50", grossPayout: "75", netProfit: "25" }, // 50 * 1.50 = 75, -50 = 25
  { stake: "100", odds: "1.63", grossPayout: "81.5", netProfit: "31.5" }, // 50 * 1.63 = 81.5, -50 = 31.5
  { stake: "10", odds: "2.49", grossPayout: "12.45", netProfit: "7.45" }, // 5 * 2.49 = 12.45, -5 = 7.45
];

for (const { stake, odds, grossPayout, netProfit } of HALF_WIN_CASES) {
  test(`settleBet: HALF_WIN stake ${stake} @ ${odds} -> halfStake WIN grossPayout ${grossPayout}, netProfit/delta ${netProfit}`, async () => {
    const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(stake), totalOdds: new Prisma.Decimal(odds) }) });
    const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" });

    assert.equal(result.kind, "APPLIED");
    if (result.kind !== "APPLIED") return;
    assert.equal(result.grossPayout?.toString(), grossPayout);
    assert.equal(result.netProfit?.toString(), netProfit);
    assert.equal(result.amount.toString(), netProfit);
  });
}

// HALF_LOSS delta is always exactly -halfStake, independent of odds —
// same "no odds required" rule as full SETTLED_LOSS, at half scale.
const HALF_LOSS_CASES: Array<{ stake: string; delta: string }> = [
  { stake: "100", delta: "-50" },
  { stake: "10", delta: "-5" },
];

for (const { stake, delta } of HALF_LOSS_CASES) {
  test(`settleBet: HALF_LOSS stake ${stake} -> delta ${delta}, independent of odds`, async () => {
    const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(stake), totalOdds: null, odds: null }) });
    const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_LOSS" });

    assert.equal(result.kind, "APPLIED");
    if (result.kind !== "APPLIED") return;
    assert.equal(result.amount.toString(), delta);
    assert.equal(result.grossPayout, undefined);
    assert.equal(result.netProfit, undefined);
  });
}

test("settleBet: HALF_WIN creates a Transaction of type BET_PAYOUT with a positive amount", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.00") }) });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" });

  const [tx] = fake._debug.transactions();
  assert.equal(tx.type, "BET_PAYOUT");
  assert.equal(tx.amount.toString(), "50");
  assert.ok(tx.amount.greaterThan(0));
});

test("settleBet: HALF_LOSS creates a Transaction of type BET_STAKE with a negative amount", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100) }) });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_LOSS" });

  const [tx] = fake._debug.transactions();
  assert.equal(tx.type, "BET_STAKE");
  assert.equal(tx.amount.toString(), "-50");
  assert.ok(tx.amount.lessThan(0));
});

test("settleBet: HALF_WIN balanceAfter matches the persisted currentCredit", async () => {
  const fake = createFakeDb({
    bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.00") }),
    playerCurrentCredit: new Prisma.Decimal(1000),
  });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.balanceAfter.toString(), "1050"); // 1000 + 50
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "1050");
});

test("settleBet: HALF_LOSS balanceAfter matches the persisted currentCredit", async () => {
  const fake = createFakeDb({
    bet: fakeBet({ stake: new Prisma.Decimal(100) }),
    playerCurrentCredit: new Prisma.Decimal(1000),
  });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_LOSS" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.balanceAfter.toString(), "950"); // 1000 - 50
});

test("settleBet: HALF_WIN with neither totalOdds nor legacy odds throws MissingSettlementOddsError and performs no writes", async () => {
  const fake = createFakeDb({ bet: fakeBet({ totalOdds: null, odds: null }) });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" }),
    (err: unknown) => err instanceof MissingSettlementOddsError,
  );
  assert.equal(fake._debug.playerUpdateCallCount(), 0);
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

// ---------------------------------------------------------------------
// H4-B3 — HALF_WIN/HALF_LOSS rounding: fractional-cent intermediate,
// exact existing Decimal/ROUND_HALF_UP policy, never native float.
// ---------------------------------------------------------------------

test("settleBet: HALF_WIN stake 10 @ odds 1.63 exercises a fractional-cent-free intermediate via Decimal (5 * 1.63 = 8.15 exactly)", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal("10"), totalOdds: new Prisma.Decimal("1.63") }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.grossPayout?.toString(), "8.15"); // 5 * 1.63
  assert.equal(result.netProfit?.toString(), "3.15"); // 8.15 - 5
});

test("settleBet: HALF_WIN rounding uses ROUND_HALF_UP at 2 decimal places, matching SETTLED_WIN's own policy — odd stake forcing a genuine half-cent boundary", async () => {
  // halfStake = 33.335 (odd stake not evenly halvable to whole cents).
  // grossPayout = roundMoney(33.335 * 1.50) = roundMoney(50.0025) = 50.00
  // netProfit = roundMoney(50.00 - 33.335) = roundMoney(16.665) = 16.67 (HALF_UP)
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal("66.67"), totalOdds: new Prisma.Decimal("1.50") }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  // halfStake = 33.335, grossPayout = roundMoney(50.0025) = 50, netProfit = roundMoney(16.665) = 16.67
  assert.equal(result.grossPayout?.toString(), "50");
  assert.equal(result.netProfit?.toString(), "16.67");
});

test("settleBet: HALF_LOSS rounding uses ROUND_HALF_UP at 2 decimal places for an odd stake", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal("66.67") }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_LOSS" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  // halfStake = 33.335 -> negated -33.335 -> roundMoney HALF_UP -> -33.34
  assert.equal(result.amount.toString(), "-33.34");
});

test("settleBet: HALF_WIN never produces a native-float artifact (stake 0.29-style precision check at half scale)", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal("0.29"), totalOdds: new Prisma.Decimal("3") }) });
  const result = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" });

  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  // halfStake = 0.145, grossPayout = roundMoney(0.435) = 0.44 (HALF_UP), netProfit = roundMoney(0.44 - 0.145) = roundMoney(0.295) = 0.30
  assert.equal(result.grossPayout?.toString(), "0.44");
  assert.equal(result.netProfit?.toString(), "0.3");
  // Never the raw native-float artifact 0.29 * 3 / 2 would produce via Number arithmetic.
  assert.notEqual(result.grossPayout?.toString(), String((0.29 * 3) / 2));
});

// ---------------------------------------------------------------------
// H4-B3 — idempotency
// ---------------------------------------------------------------------

test("settleBet: HALF_WIN repeated settlement returns IDEMPOTENT, no second credit mutation, no second Transaction", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.00") }) });

  const first = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" });
  const second = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" });

  assert.equal(first.kind, "APPLIED");
  assert.deepEqual(second, { kind: "IDEMPOTENT", betId: BET_ID, status: "SETTLED_HALF_WIN" });
  assert.equal(fake._debug.playerUpdateCallCount(), 1);
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
  assert.equal(fake._debug.transactions().length, 1);
});

test("settleBet: HALF_LOSS repeated settlement returns IDEMPOTENT, no second credit mutation, no second Transaction", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100) }) });

  const first = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_LOSS" });
  const second = await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_LOSS" });

  assert.equal(first.kind, "APPLIED");
  assert.deepEqual(second, { kind: "IDEMPOTENT", betId: BET_ID, status: "SETTLED_HALF_LOSS" });
  assert.equal(fake._debug.playerUpdateCallCount(), 1);
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
  assert.equal(fake._debug.transactions().length, 1);
});

// ---------------------------------------------------------------------
// H4-B3 — terminal conflicts. No terminal bet can be financially settled
// twice, regardless of which terminal status came first.
// ---------------------------------------------------------------------

test("settleBet: HALF_WIN followed by a LOSS request throws SettlementConflictError and performs no further writes", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.00") }) });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_LOSS" }),
    (err: unknown) => {
      assert.ok(err instanceof SettlementConflictError);
      assert.equal(err.currentStatus, "SETTLED_HALF_WIN");
      assert.equal(err.requestedStatus, "SETTLED_LOSS");
      return true;
    },
  );
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_HALF_WIN");
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
});

test("settleBet: HALF_LOSS followed by a WIN request throws SettlementConflictError and performs no further writes", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.00") }) });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_LOSS" });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" }),
    (err: unknown) => {
      assert.ok(err instanceof SettlementConflictError);
      assert.equal(err.currentStatus, "SETTLED_HALF_LOSS");
      assert.equal(err.requestedStatus, "SETTLED_WIN");
      return true;
    },
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
});

test("settleBet: WIN followed by a HALF_WIN request throws SettlementConflictError and performs no further writes", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.00") }) });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_WIN" });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" }),
    (err: unknown) => {
      assert.ok(err instanceof SettlementConflictError);
      assert.equal(err.currentStatus, "SETTLED_WIN");
      assert.equal(err.requestedStatus, "SETTLED_HALF_WIN");
      return true;
    },
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
});

test("settleBet: VOID followed by a HALF_LOSS request throws SettlementConflictError and performs no further writes", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100) }) });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "VOID" });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_LOSS" }),
    (err: unknown) => {
      assert.ok(err instanceof SettlementConflictError);
      assert.equal(err.currentStatus, "VOID");
      assert.equal(err.requestedStatus, "SETTLED_HALF_LOSS");
      return true;
    },
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
});

test("settleBet: HALF_WIN followed by a HALF_LOSS request throws SettlementConflictError (the two HALF_* statuses conflict with each other too)", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.00") }) });
  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_LOSS" }),
    (err: unknown) => err instanceof SettlementConflictError,
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
});

test("settleBet: PENDING cannot settle to HALF_WIN", async () => {
  const fake = createFakeDb({ bet: fakeBet({ status: "PENDING" }) });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" }),
    (err: unknown) => err instanceof BetNotConfirmedForSettlementError,
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("settleBet: REJECTED cannot settle to HALF_LOSS", async () => {
  const fake = createFakeDb({ bet: fakeBet({ status: "REJECTED" }) });

  await assert.rejects(
    () => settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_LOSS" }),
    (err: unknown) => err instanceof BetAlreadyRejectedError,
  );
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("settleBet: does not mutate the source Decimal stake input for HALF_WIN/HALF_LOSS", async () => {
  const stake = new Prisma.Decimal("100");
  const stakeSnapshot = stake.toString();
  const fake = createFakeDb({ bet: fakeBet({ stake, totalOdds: new Prisma.Decimal("2.00") }) });

  await settleBet(db(fake), { betId: BET_ID, requestedStatus: "SETTLED_HALF_WIN" });

  assert.equal(stake.toString(), stakeSnapshot);
});
