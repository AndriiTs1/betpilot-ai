import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { requireOperatorApi, resolveOperatorPageAuth } from "./requireOperator";
import { OPERATOR_SESSION_COOKIE_NAME, type OperatorSessionStore } from "./operatorSession";

interface FakeRow {
  id: string;
  operatorId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function makeToken(): string {
  return randomBytes(32).toString("base64url");
}

function makeValidRow(token: string, operatorId = "op_1"): FakeRow {
  return {
    id: "session_1",
    operatorId,
    tokenHash: hashToken(token),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: null,
    lastUsedAt: null,
  };
}

// Only findUnique/update are exercised by requireOperatorApi/
// resolveOperatorPageAuth's call graph (via getOperatorSessionFromRequest/
// validateOperatorSession) — the rest are stubbed to satisfy the interface.
function createFakeStore(rows: FakeRow[]): OperatorSessionStore {
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

function requestWithCookie(token: string | null): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `${OPERATOR_SESSION_COOKIE_NAME}=${token}`;
  return new NextRequest("http://localhost/api/dashboard/overview", { headers });
}

function assertGenericUnauthorized(response: Response): Promise<void> {
  assert.equal(response.status, 401);
  return response.json().then((body) => {
    assert.deepEqual(body, { ok: false, error: "UNAUTHORIZED" });
  });
}

// --- requireOperatorApi (Route Handlers) ---

test("requireOperatorApi: valid session returns the operator", async () => {
  const token = makeToken();
  const store = createFakeStore([makeValidRow(token, "op_42")]);

  const result = await requireOperatorApi(requestWithCookie(token), store);

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.operator.operatorId, "op_42");
});

test("requireOperatorApi: missing cookie is rejected generically", async () => {
  const store = createFakeStore([]);
  const result = await requireOperatorApi(requestWithCookie(null), store);

  assert.equal(result.ok, false);
  if (!result.ok) await assertGenericUnauthorized(result.response);
});

test("requireOperatorApi: expired session is rejected generically", async () => {
  const token = makeToken();
  const row = makeValidRow(token);
  row.expiresAt = new Date(Date.now() - 1000);
  const store = createFakeStore([row]);

  const result = await requireOperatorApi(requestWithCookie(token), store);

  assert.equal(result.ok, false);
  if (!result.ok) await assertGenericUnauthorized(result.response);
});

test("requireOperatorApi: revoked session is rejected generically", async () => {
  const token = makeToken();
  const row = makeValidRow(token);
  row.revokedAt = new Date();
  const store = createFakeStore([row]);

  const result = await requireOperatorApi(requestWithCookie(token), store);

  assert.equal(result.ok, false);
  if (!result.ok) await assertGenericUnauthorized(result.response);
});

test("requireOperatorApi: malformed cookie is rejected generically without a store lookup", async () => {
  const store = createFakeStore([]);
  const result = await requireOperatorApi(requestWithCookie("not-a-valid-token-shape"), store);

  assert.equal(result.ok, false);
  if (!result.ok) await assertGenericUnauthorized(result.response);
});

// --- resolveOperatorPageAuth (Server Component pages) ---
//
// next/navigation's redirect() throws a synchronous Error carrying a
// digest that encodes the redirect target (NEXT_REDIRECT;<type>;<url>;...)
// regardless of whether it's called inside a real Next.js request — see
// node_modules/next/dist/client/components/redirect.js. That makes the
// redirect-vs-authenticated decision safely testable without mocking
// next/headers or spinning up a real request context.

function assertRedirectsToLogin(err: unknown): true {
  assert.ok(err instanceof Error);
  const digest = (err as Error & { digest?: string }).digest;
  assert.ok(typeof digest === "string", `expected a digest string, got: ${digest}`);
  assert.ok(digest.startsWith("NEXT_REDIRECT"), `expected a NEXT_REDIRECT digest, got: ${digest}`);
  assert.ok(digest.includes("/operator/login"), `expected redirect target /operator/login, got: ${digest}`);
  return true;
}

test("resolveOperatorPageAuth: valid session returns the operator", async () => {
  const token = makeToken();
  const store = createFakeStore([makeValidRow(token, "op_7")]);

  const result = await resolveOperatorPageAuth(token, store);
  assert.equal(result.operatorId, "op_7");
});

test("resolveOperatorPageAuth: no session redirects to /operator/login", async () => {
  const store = createFakeStore([]);
  await assert.rejects(() => resolveOperatorPageAuth(null, store), assertRedirectsToLogin);
});

test("resolveOperatorPageAuth: expired session redirects to /operator/login", async () => {
  const token = makeToken();
  const row = makeValidRow(token);
  row.expiresAt = new Date(Date.now() - 1000);
  const store = createFakeStore([row]);

  await assert.rejects(() => resolveOperatorPageAuth(token, store), assertRedirectsToLogin);
});

test("resolveOperatorPageAuth: revoked session redirects to /operator/login", async () => {
  const token = makeToken();
  const row = makeValidRow(token);
  row.revokedAt = new Date();
  const store = createFakeStore([row]);

  await assert.rejects(() => resolveOperatorPageAuth(token, store), assertRedirectsToLogin);
});
