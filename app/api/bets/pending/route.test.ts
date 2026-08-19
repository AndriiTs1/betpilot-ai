import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { handleBetsPending, type HandleBetsPendingOptions } from "./route";
import { Prisma, type PrismaClient, type BetStatus } from "@/lib/generated/prisma/client";
import { INTERNAL_OPERATOR_SCOPE_HEADER } from "@/lib/auth/operatorAuth";

// Sector 0 (ADR-0002) — cross-operator IDOR fix for this route: GET
// /api/bets/pending previously returned every operator's PENDING bets
// unconditionally. Same hand-written in-memory fake Prisma client
// convention as app/api/bets/confirm.route.test.ts — the fake applies the
// where-filter for real rather than just recording the call.

const OPERATOR_SECRET = "test-operator-secret";
const OPERATOR_ID_A = "operator-a";
const OPERATOR_ID_B = "operator-b";

interface FakeBetRow {
  id: string;
  status: BetStatus;
  playerId: string;
  operatorId: string;
  stake: Prisma.Decimal;
  odds: Prisma.Decimal | null;
  totalOdds: Prisma.Decimal | null;
  createdAt: Date;
  updatedAt: Date;
}

function fakeBet(overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return {
    id: "bet-1",
    status: "PENDING",
    playerId: "player-1",
    operatorId: OPERATOR_ID_A,
    stake: new Prisma.Decimal(100),
    odds: new Prisma.Decimal("2.10"),
    totalOdds: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createFakeDb(bets: FakeBetRow[]) {
  return {
    bet: {
      findMany: async ({ where }: { where: { status: BetStatus; player?: { operatorId: string } } }) => {
        return bets
          .filter((b) => b.status === where.status)
          .filter((b) => !where.player || b.operatorId === where.player.operatorId)
          .map((b) => ({
            ...b,
            player: { id: b.playerId, name: `Player ${b.playerId}` },
            oddsSnapshot: null,
            selections: [],
          }));
      },
    },
  };
}

function fakeOptions(fake: ReturnType<typeof createFakeDb>): HandleBetsPendingOptions {
  return { db: fake as unknown as PrismaClient };
}

function pendingRequest(authHeader: string | null, scopedOperatorId?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== null) headers.Authorization = authHeader;
  if (scopedOperatorId !== undefined) headers[INTERNAL_OPERATOR_SCOPE_HEADER] = scopedOperatorId;
  return new NextRequest("http://localhost/api/bets/pending", { method: "GET", headers });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

const originalSecret = process.env.OPERATOR_SECRET;
test.beforeEach(() => {
  process.env.OPERATOR_SECRET = OPERATOR_SECRET;
});
test.after(() => {
  process.env.OPERATOR_SECRET = originalSecret;
});

test("pending route: unauthorized request is rejected with 401", async () => {
  const fake = createFakeDb([]);
  const res = await handleBetsPending(pendingRequest(null), fakeOptions(fake));
  assert.equal(res.status, 401);
});

test("pending route: own-data visibility — an operator sees their own PENDING bets", async () => {
  const fake = createFakeDb([fakeBet({ id: "bet-a", operatorId: OPERATOR_ID_A })]);
  const res = await handleBetsPending(
    pendingRequest(`Bearer ${OPERATOR_SECRET}`, OPERATOR_ID_A),
    fakeOptions(fake),
  );

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal((body.bets as Array<{ id: string }>).length, 1);
});

test("pending route: cross-operator list invisibility — an operator never sees another operator's PENDING bets", async () => {
  const fake = createFakeDb([
    fakeBet({ id: "bet-a", operatorId: OPERATOR_ID_A }),
    fakeBet({ id: "bet-b", operatorId: OPERATOR_ID_B }),
  ]);
  const res = await handleBetsPending(
    pendingRequest(`Bearer ${OPERATOR_SECRET}`, OPERATOR_ID_A),
    fakeOptions(fake),
  );

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(
    (body.bets as Array<{ id: string }>).map((b) => b.id),
    ["bet-a"],
  );
});

test("pending route: with no operator-scope header, all PENDING bets are returned — single-operator regression (unchanged prior behavior)", async () => {
  const fake = createFakeDb([
    fakeBet({ id: "bet-a", operatorId: OPERATOR_ID_A }),
    fakeBet({ id: "bet-b", operatorId: OPERATOR_ID_B }),
  ]);
  const res = await handleBetsPending(pendingRequest(`Bearer ${OPERATOR_SECRET}`), fakeOptions(fake));

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal((body.bets as Array<{ id: string }>).length, 2);
});
