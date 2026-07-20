import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createOperatorSession,
  validateOperatorSession,
  revokeOperatorSession,
  revokeAllOperatorSessions,
  cleanupExpiredOperatorSessions,
  type OperatorSessionStore,
} from "./operatorSession";

// Plain in-memory fake — no real database connection, matching this
// project's single-shared-Neon-DB constraint (no separate dev/staging copy
// to safely run tests against). Implements exactly the OperatorSessionStore
// surface operatorSession.ts actually calls.
function createFakeStore() {
  interface Row {
    id: string;
    operatorId: string;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
    lastUsedAt: Date | null;
  }

  const rows: Row[] = [];
  let nextId = 1;

  const store: OperatorSessionStore = {
    async create({ data }) {
      const row: Row = {
        id: `fake-session-${nextId++}`,
        operatorId: data.operatorId,
        tokenHash: data.tokenHash,
        createdAt: new Date(),
        expiresAt: data.expiresAt,
        revokedAt: null,
        lastUsedAt: null,
      };
      rows.push(row);
      return row;
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
    async updateMany({ where, data }) {
      let count = 0;
      for (const row of rows) {
        if (where.operatorId !== undefined && row.operatorId !== where.operatorId) continue;
        if (where.tokenHash !== undefined && row.tokenHash !== where.tokenHash) continue;
        if (where.revokedAt === null && row.revokedAt !== null) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    },
    async deleteMany({ where }) {
      const before = rows.length;
      const remaining = rows.filter((r) => !(r.expiresAt.getTime() < where.expiresAt.lt.getTime()));
      const count = before - remaining.length;
      rows.length = 0;
      rows.push(...remaining);
      return { count };
    },
  };

  return { store, rows };
}

test("session: raw token is not stored in the DB", async () => {
  const { store, rows } = createFakeStore();
  const { token } = await createOperatorSession("op_1", store);

  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].tokenHash, token);
  // tokenHash must be exactly the SHA-256 hex digest of the raw token.
  assert.equal(rows[0].tokenHash, createHash("sha256").update(token).digest("hex"));
});

test("session: valid session resolves the operator", async () => {
  const { store } = createFakeStore();
  const { token } = await createOperatorSession("op_1", store);

  const result = await validateOperatorSession(token, store);
  assert.deepEqual(result, { valid: true, operatorId: "op_1" });
});

test("session: expired session is rejected", async () => {
  const { store, rows } = createFakeStore();
  const { token } = await createOperatorSession("op_1", store);
  rows[0].expiresAt = new Date(Date.now() - 1000); // force into the past

  const result = await validateOperatorSession(token, store);
  assert.deepEqual(result, { valid: false, reason: "expired" });
});

test("session: revoked session is rejected", async () => {
  const { store } = createFakeStore();
  const { token } = await createOperatorSession("op_1", store);
  await revokeOperatorSession(token, store);

  const result = await validateOperatorSession(token, store);
  assert.deepEqual(result, { valid: false, reason: "revoked" });
});

test("session: unknown token is rejected", async () => {
  const { store } = createFakeStore();
  // Shape-valid but never issued.
  const result = await validateOperatorSession("a".repeat(43), store);
  assert.deepEqual(result, { valid: false, reason: "not_found" });
});

test("session: malformed token is rejected without a store lookup", async () => {
  const { store } = createFakeStore();
  const malformedValues = [null, undefined, "", "short", "has spaces in it!!", "a".repeat(200)];

  for (const malformed of malformedValues) {
    const result = await validateOperatorSession(malformed, store);
    assert.deepEqual(result, { valid: false, reason: "malformed" });
  }
});

test("session: revokeAllOperatorSessions revokes every active session for that operator only", async () => {
  const { store } = createFakeStore();
  const a1 = await createOperatorSession("op_1", store);
  const a2 = await createOperatorSession("op_1", store);
  const b1 = await createOperatorSession("op_2", store);

  const revokedCount = await revokeAllOperatorSessions("op_1", store);
  assert.equal(revokedCount, 2);

  assert.deepEqual(await validateOperatorSession(a1.token, store), { valid: false, reason: "revoked" });
  assert.deepEqual(await validateOperatorSession(a2.token, store), { valid: false, reason: "revoked" });
  // A different operator's session must be untouched.
  assert.deepEqual(await validateOperatorSession(b1.token, store), { valid: true, operatorId: "op_2" });
});

test("session: cleanupExpiredOperatorSessions removes only past-expiry rows", async () => {
  const { store, rows } = createFakeStore();
  const expired = await createOperatorSession("op_1", store);
  const active = await createOperatorSession("op_1", store);
  rows.find((r) => r.tokenHash === createHash("sha256").update(expired.token).digest("hex"))!.expiresAt =
    new Date(Date.now() - 1000);

  const deletedCount = await cleanupExpiredOperatorSessions(store);
  assert.equal(deletedCount, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenHash, createHash("sha256").update(active.token).digest("hex"));
});
