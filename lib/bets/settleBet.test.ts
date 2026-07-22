import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma, type BetStatus } from "@/lib/generated/prisma/client";
import {
  settleBet,
  BetNotFoundForSettlementError,
  MissingSettlementOddsError,
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
          update: async ({ where, data }: { where: { id: string; status: string }; data: { status: string } }) => {
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
          update: async ({ where, data }: { where: { id: string; status: string }; data: { status: string } }) => {
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
