import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { handleBetsHistory, type HandleBetsHistoryOptions } from "./route";
import { Prisma, type PrismaClient, type BetStatus } from "@/lib/generated/prisma/client";
import { INTERNAL_OPERATOR_SCOPE_HEADER } from "@/lib/auth/operatorAuth";

// Sector 0 (ADR-0002) — same fix/coverage shape as
// app/api/bets/pending/route.test.ts, for GET /api/bets/history.

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
    status: "CONFIRMED",
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
      findMany: async ({
        where,
      }: {
        where: { status: { not: BetStatus }; player?: { operatorId: string } };
      }) => {
        return bets
          .filter((b) => b.status !== where.status.not)
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

function fakeOptions(fake: ReturnType<typeof createFakeDb>): HandleBetsHistoryOptions {
  return { db: fake as unknown as PrismaClient };
}

function historyRequest(authHeader: string | null, scopedOperatorId?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== null) headers.Authorization = authHeader;
  if (scopedOperatorId !== undefined) headers[INTERNAL_OPERATOR_SCOPE_HEADER] = scopedOperatorId;
  return new NextRequest("http://localhost/api/bets/history", { method: "GET", headers });
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

test("history route: unauthorized request is rejected with 401", async () => {
  const fake = createFakeDb([]);
  const res = await handleBetsHistory(historyRequest(null), fakeOptions(fake));
  assert.equal(res.status, 401);
});

test("history route: own-data visibility — an operator sees their own resolved bets", async () => {
  const fake = createFakeDb([fakeBet({ id: "bet-a", operatorId: OPERATOR_ID_A })]);
  const res = await handleBetsHistory(
    historyRequest(`Bearer ${OPERATOR_SECRET}`, OPERATOR_ID_A),
    fakeOptions(fake),
  );

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal((body.bets as Array<{ id: string }>).length, 1);
});

test("history route: cross-operator list invisibility — an operator never sees another operator's resolved bets", async () => {
  const fake = createFakeDb([
    fakeBet({ id: "bet-a", operatorId: OPERATOR_ID_A }),
    fakeBet({ id: "bet-b", operatorId: OPERATOR_ID_B }),
  ]);
  const res = await handleBetsHistory(
    historyRequest(`Bearer ${OPERATOR_SECRET}`, OPERATOR_ID_A),
    fakeOptions(fake),
  );

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(
    (body.bets as Array<{ id: string }>).map((b) => b.id),
    ["bet-a"],
  );
});

test("history route: with no operator-scope header, all resolved bets are returned — single-operator regression (unchanged prior behavior)", async () => {
  const fake = createFakeDb([
    fakeBet({ id: "bet-a", operatorId: OPERATOR_ID_A }),
    fakeBet({ id: "bet-b", operatorId: OPERATOR_ID_B }),
  ]);
  const res = await handleBetsHistory(historyRequest(`Bearer ${OPERATOR_SECRET}`), fakeOptions(fake));

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal((body.bets as Array<{ id: string }>).length, 2);
});
