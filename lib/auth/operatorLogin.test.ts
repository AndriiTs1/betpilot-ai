import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attemptOperatorLogin,
  normalizeOperatorPhone,
  parseOperatorLoginRequestBody,
  type OperatorLookup,
} from "./operatorLogin";
import { hashPassword } from "./password";
import type { OperatorSessionStore } from "./operatorSession";

const REAL_PASSWORD = "a-long-enough-test-password";

interface FakeOperator {
  id: string;
  phone: string;
  passwordHash: string | null;
}

function createFakeLookup(operators: FakeOperator[]): OperatorLookup {
  return {
    async findUnique({ where }) {
      return operators.find((op) => op.phone === where.phone) ?? null;
    },
  };
}

// Only .create() is exercised by attemptOperatorLogin's success path — the
// rest are stubbed to satisfy the OperatorSessionStore interface without
// pulling in operatorSession.test.ts's fuller fake for a file that only
// needs "was a session created, and for which operator."
function createFakeSessionStore() {
  const created: Array<{ operatorId: string; tokenHash: string; expiresAt: Date }> = [];

  const store: OperatorSessionStore = {
    async create({ data }) {
      created.push(data);
      return { id: `fake-${created.length}`, ...data, createdAt: new Date(), revokedAt: null, lastUsedAt: null };
    },
    async findUnique() {
      return null;
    },
    async update({ where, data }) {
      return { id: where.id, operatorId: "", tokenHash: "", createdAt: new Date(), expiresAt: new Date(), revokedAt: null, lastUsedAt: null, ...data };
    },
    async updateMany() {
      return { count: 0 };
    },
    async deleteMany() {
      return { count: 0 };
    },
  };

  return { store, created };
}

test("login: successful login with the correct password creates a session", async () => {
  const hash = await hashPassword(REAL_PASSWORD);
  const lookup = createFakeLookup([{ id: "op_1", phone: "+41000000000", passwordHash: hash }]);
  const { store, created } = createFakeSessionStore();

  const result = await attemptOperatorLogin("+41000000000", REAL_PASSWORD, lookup, store);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.operatorId, "op_1");
    assert.ok(result.token.length > 0);
    assert.ok(result.expiresAt instanceof Date);
  }
  assert.equal(created.length, 1);
  assert.equal(created[0].operatorId, "op_1");
});

test("login: unknown phone fails generically, no session created", async () => {
  const lookup = createFakeLookup([]);
  const { store, created } = createFakeSessionStore();

  const result = await attemptOperatorLogin("+41000000000", REAL_PASSWORD, lookup, store);

  assert.deepEqual(result, { ok: false });
  assert.equal(created.length, 0);
});

test("login: wrong password fails generically, no session created", async () => {
  const hash = await hashPassword(REAL_PASSWORD);
  const lookup = createFakeLookup([{ id: "op_1", phone: "+41000000000", passwordHash: hash }]);
  const { store, created } = createFakeSessionStore();

  const result = await attemptOperatorLogin("+41000000000", "wrong-password-entirely", lookup, store);

  assert.deepEqual(result, { ok: false });
  assert.equal(created.length, 0);
});

test("login: operator without a passwordHash fails generically, no session created", async () => {
  const lookup = createFakeLookup([{ id: "op_1", phone: "+41000000000", passwordHash: null }]);
  const { store, created } = createFakeSessionStore();

  const result = await attemptOperatorLogin("+41000000000", REAL_PASSWORD, lookup, store);

  assert.deepEqual(result, { ok: false });
  assert.equal(created.length, 0);
});

test("login: unknown phone and wrong password take approximately the same time (constant-time defense)", async () => {
  const hash = await hashPassword(REAL_PASSWORD);
  const lookupKnown = createFakeLookup([{ id: "op_1", phone: "+41000000000", passwordHash: hash }]);
  const lookupUnknown = createFakeLookup([]);

  const start1 = process.hrtime.bigint();
  await attemptOperatorLogin("+41000000000", "wrong-password-entirely", lookupKnown, createFakeSessionStore().store);
  const wrongPasswordMs = Number(process.hrtime.bigint() - start1) / 1e6;

  const start2 = process.hrtime.bigint();
  await attemptOperatorLogin("+41999999999", "wrong-password-entirely", lookupUnknown, createFakeSessionStore().store);
  const unknownPhoneMs = Number(process.hrtime.bigint() - start2) / 1e6;

  // Both paths run one real scrypt computation — allow generous slack for
  // machine/CI noise, this is checking "same order of magnitude," not a
  // precise timing guarantee.
  const ratio = Math.max(wrongPasswordMs, unknownPhoneMs) / Math.max(1, Math.min(wrongPasswordMs, unknownPhoneMs));
  assert.ok(ratio < 3, `expected comparable timings, got wrongPassword=${wrongPasswordMs}ms unknownPhone=${unknownPhoneMs}ms`);
});

test("normalizeOperatorPhone: trims whitespace only, no reformatting", () => {
  assert.equal(normalizeOperatorPhone("  +41000000000  "), "+41000000000");
  assert.equal(normalizeOperatorPhone("+41 00 000 00 00"), "+41 00 000 00 00");
});

test("parseOperatorLoginRequestBody: accepts a well-formed body and normalizes phone", () => {
  const result = parseOperatorLoginRequestBody({ phone: "  +41000000000  ", password: "secret" });
  assert.deepEqual(result, { phone: "+41000000000", password: "secret" });
});

test("parseOperatorLoginRequestBody: rejects malformed bodies without throwing", () => {
  const malformedBodies: unknown[] = [
    null,
    undefined,
    "a string, not an object",
    42,
    [],
    {},
    { phone: "+41000000000" }, // missing password
    { password: "secret" }, // missing phone
    { phone: 12345, password: "secret" }, // wrong type
    { phone: "+41000000000", password: 12345 }, // wrong type
    { phone: "   ", password: "secret" }, // blank after trim
    { phone: "+41000000000", password: "" }, // empty password
  ];

  for (const body of malformedBodies) {
    assert.equal(parseOperatorLoginRequestBody(body), null);
  }
});
