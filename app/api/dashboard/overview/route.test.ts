import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { handleDashboardOverview, type HandleDashboardOverviewOptions } from "./route";
import { OPERATOR_SESSION_COOKIE_NAME, type OperatorSessionStore } from "@/lib/auth/operatorSession";
import { Prisma, type PrismaClient, type BetStatus } from "@/lib/generated/prisma/client";

// Sector 0 (ADR-0002) — cross-operator IDOR fix for this route: GET
// /api/dashboard/overview previously aggregated every operator's
// players/bets/transactions unconditionally. Same faking conventions as
// app/api/dashboard/players/route.test.ts.

const OPERATOR_ID_A = "operator-a";
const OPERATOR_ID_B = "operator-b";

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
function makeToken(): string {
  return randomBytes(32).toString("base64url");
}

interface FakeSessionRow {
  id: string;
  operatorId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

function createFakeStore(rows: FakeSessionRow[]): OperatorSessionStore {
  return {
    async create() {
      throw new Error("not used in these tests");
    },
    async findUnique({ where }) {
      return rows.find((r) => r.tokenHash === where.tokenHash) ?? null;
    },
    async update({ where, data }) {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    },
    async updateMany() {
      return { count: 0 };
    },
    async deleteMany() {
      return { count: 0 };
    },
  };
}

function sessionRow(token: string, operatorId: string): FakeSessionRow {
  return {
    id: `session-${operatorId}`,
    operatorId,
    tokenHash: hashToken(token),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: null,
    lastUsedAt: null,
  };
}

interface FakePlayerRow {
  id: string;
  operatorId: string;
  creditLimit: Prisma.Decimal;
  currentCredit: Prisma.Decimal;
}

interface FakeBetRow {
  id: string;
  operatorId: string;
  playerId: string;
  status: BetStatus;
  stake: Prisma.Decimal;
}

function fakePlayer(overrides: Partial<FakePlayerRow> = {}): FakePlayerRow {
  return {
    id: "player-1",
    operatorId: OPERATOR_ID_A,
    creditLimit: new Prisma.Decimal(1000),
    currentCredit: new Prisma.Decimal(0),
    ...overrides,
  };
}

function fakeBet(overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return {
    id: "bet-1",
    operatorId: OPERATOR_ID_A,
    playerId: "player-1",
    status: "PENDING",
    stake: new Prisma.Decimal(100),
    ...overrides,
  };
}

// Minimal fake — implements only the where-filtering this route relies on:
// Player.operatorId directly, Bet/Transaction scoped via player.operatorId.
function createFakeDb(players: FakePlayerRow[], bets: FakeBetRow[] = []) {
  return {
    player: {
      findMany: async ({ where }: { where: { operatorId: string } }) => {
        return players.filter((p) => p.operatorId === where.operatorId).map((p) => ({ ...p }));
      },
    },
    bet: {
      count: async ({ where }: { where: { status: BetStatus; player: { operatorId: string } } }) => {
        return bets.filter((b) => b.status === where.status && b.operatorId === where.player.operatorId).length;
      },
      findMany: async ({ where }: { where: { status: BetStatus; player: { operatorId: string } } }) => {
        return bets
          .filter((b) => b.status === where.status && b.operatorId === where.player.operatorId)
          .map((b) => ({ playerId: b.playerId, stake: b.stake }));
      },
    },
    transaction: {
      findMany: async () => [],
    },
  };
}

function fakeOptions(
  db: ReturnType<typeof createFakeDb>,
  store: OperatorSessionStore,
): HandleDashboardOverviewOptions {
  return { db: db as unknown as PrismaClient, operatorSessionStore: store };
}

function requestWithSession(rawToken: string | null): NextRequest {
  return new NextRequest("http://localhost/api/dashboard/overview", {
    method: "GET",
    headers: rawToken ? { cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${rawToken}` } : {},
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

test("dashboard overview route: no session is rejected with 401", async () => {
  const store = createFakeStore([]);
  const db = createFakeDb([]);
  const res = await handleDashboardOverview(requestWithSession(null), fakeOptions(db, store));
  assert.equal(res.status, 401);
});

test("dashboard overview route: own-data visibility — totals reflect only the caller's own operator", async () => {
  const token = makeToken();
  const store = createFakeStore([sessionRow(token, OPERATOR_ID_A)]);
  const db = createFakeDb(
    [fakePlayer({ id: "player-a", operatorId: OPERATOR_ID_A })],
    [fakeBet({ id: "bet-a", operatorId: OPERATOR_ID_A, playerId: "player-a", status: "PENDING" })],
  );

  const res = await handleDashboardOverview(requestWithSession(token), fakeOptions(db, store));

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.activePlayers, 1);
  assert.equal(body.pendingBetsCount, 1);
});

test("dashboard overview route: cross-operator invisibility — another operator's players/bets never contribute to the caller's totals", async () => {
  const token = makeToken();
  const store = createFakeStore([sessionRow(token, OPERATOR_ID_A)]);
  const db = createFakeDb(
    [
      fakePlayer({ id: "player-a", operatorId: OPERATOR_ID_A }),
      fakePlayer({ id: "player-b", operatorId: OPERATOR_ID_B }),
    ],
    [
      fakeBet({ id: "bet-a", operatorId: OPERATOR_ID_A, playerId: "player-a", status: "PENDING" }),
      fakeBet({ id: "bet-b", operatorId: OPERATOR_ID_B, playerId: "player-b", status: "PENDING" }),
    ],
  );

  const res = await handleDashboardOverview(requestWithSession(token), fakeOptions(db, store));

  assert.equal(res.status, 200);
  const body = await json(res);
  // Only operator A's one player/one pending bet — operator B's are
  // invisible, not merely deduplicated or double-counted.
  assert.equal(body.activePlayers, 1);
  assert.equal(body.pendingBetsCount, 1);
});
