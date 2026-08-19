import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { handleDashboardPlayers, type HandleDashboardPlayersOptions } from "./route";
import { OPERATOR_SESSION_COOKIE_NAME, type OperatorSessionStore } from "@/lib/auth/operatorSession";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";

// Sector 0 (ADR-0002) — cross-operator IDOR fix for this route: GET
// /api/dashboard/players previously returned every operator's players
// unconditionally. Session-store faking follows the exact same convention
// as app/api/dashboard/debug/screenshot-preview/route.test.ts; db faking
// follows the same "real filtering, not just call-recording" convention as
// app/api/bets/confirm.route.test.ts.

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
  name: string;
  telegramId: string | null;
  phoneNumber: string | null;
  creditLimit: Prisma.Decimal;
  currentCredit: Prisma.Decimal;
}

function fakePlayer(overrides: Partial<FakePlayerRow> = {}): FakePlayerRow {
  return {
    id: "player-1",
    operatorId: OPERATOR_ID_A,
    name: "Test Player",
    telegramId: "555000111",
    phoneNumber: null,
    creditLimit: new Prisma.Decimal(1000),
    currentCredit: new Prisma.Decimal(0),
    ...overrides,
  };
}

// A minimal fake — only implements the where-filtering this route actually
// relies on (operatorId directly on Player, player.operatorId via relation
// on Bet/Transaction); no bets/transactions are seeded in these tests since
// the fix under test is the operator-scoping of the `players` list itself.
function createFakeDb(players: FakePlayerRow[]) {
  return {
    player: {
      findMany: async ({ where }: { where: { operatorId: string } }) => {
        return players
          .filter((p) => p.operatorId === where.operatorId)
          .map((p) => ({ ...p, bets: [] }));
      },
    },
    bet: {
      findMany: async () => [],
    },
    transaction: {
      findMany: async () => [],
    },
  };
}

function fakeOptions(
  db: ReturnType<typeof createFakeDb>,
  store: OperatorSessionStore,
): HandleDashboardPlayersOptions {
  return { db: db as unknown as PrismaClient, operatorSessionStore: store };
}

function requestWithSession(rawToken: string | null): NextRequest {
  return new NextRequest("http://localhost/api/dashboard/players", {
    method: "GET",
    headers: rawToken ? { cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${rawToken}` } : {},
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

test("dashboard players route: no session is rejected with 401", async () => {
  const store = createFakeStore([]);
  const db = createFakeDb([]);
  const res = await handleDashboardPlayers(requestWithSession(null), fakeOptions(db, store));
  assert.equal(res.status, 401);
});

test("dashboard players route: own-data visibility — an operator sees their own players", async () => {
  const token = makeToken();
  const store = createFakeStore([sessionRow(token, OPERATOR_ID_A)]);
  const db = createFakeDb([fakePlayer({ id: "player-a", operatorId: OPERATOR_ID_A })]);

  const res = await handleDashboardPlayers(requestWithSession(token), fakeOptions(db, store));

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal((body.players as Array<{ id: string }>).length, 1);
  assert.equal((body.players as Array<{ id: string }>)[0].id, "player-a");
});

test("dashboard players route: cross-operator list invisibility — an operator never sees another operator's players", async () => {
  const token = makeToken();
  const store = createFakeStore([sessionRow(token, OPERATOR_ID_A)]);
  const db = createFakeDb([
    fakePlayer({ id: "player-a", operatorId: OPERATOR_ID_A }),
    fakePlayer({ id: "player-b", operatorId: OPERATOR_ID_B }),
  ]);

  const res = await handleDashboardPlayers(requestWithSession(token), fakeOptions(db, store));

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(
    (body.players as Array<{ id: string }>).map((p) => p.id),
    ["player-a"],
  );
});
