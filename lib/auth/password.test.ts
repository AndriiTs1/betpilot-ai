import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, MIN_OPERATOR_PASSWORD_LENGTH, InvalidPasswordError } from "./password";

const VALID_PASSWORD = "a-long-enough-test-password";

test("password: correct password verifies", async () => {
  const hash = await hashPassword(VALID_PASSWORD);
  assert.equal(await verifyPassword(VALID_PASSWORD, hash), true);
});

test("password: incorrect password fails", async () => {
  const hash = await hashPassword(VALID_PASSWORD);
  assert.equal(await verifyPassword("definitely-the-wrong-password", hash), false);
});

test("password: malformed stored hash fails safely (no throw)", async () => {
  const malformedValues = [
    "",
    "not-a-hash-at-all",
    "scrypt$v1$16384$8$1$onlysixparts",
    "scrypt$v2$16384$8$1$abcd$abcd", // wrong version
    "bcrypt$v1$16384$8$1$abcd$abcd", // wrong prefix
    "scrypt$v1$notanumber$8$1$abcd$abcd", // non-numeric N
    "scrypt$v1$16384$8$1$zzzz$abcd", // non-hex salt
  ];

  for (const malformed of malformedValues) {
    await assert.doesNotReject(async () => {
      const result = await verifyPassword(VALID_PASSWORD, malformed);
      assert.equal(result, false);
    });
  }
});

test("password: two hashes of the same password differ because of salt", async () => {
  const hashA = await hashPassword(VALID_PASSWORD);
  const hashB = await hashPassword(VALID_PASSWORD);
  assert.notEqual(hashA, hashB);

  // Both must still independently verify the same password.
  assert.equal(await verifyPassword(VALID_PASSWORD, hashA), true);
  assert.equal(await verifyPassword(VALID_PASSWORD, hashB), true);
});

test("password: hash format has the documented 7 '$'-separated fields", async () => {
  const hash = await hashPassword(VALID_PASSWORD);
  const parts = hash.split("$");
  assert.equal(parts.length, 7);
  assert.equal(parts[0], "scrypt");
  assert.equal(parts[1], "v1");
});

test("password: hashPassword rejects a too-short password", async () => {
  const tooShort = "short";
  assert.ok(tooShort.length < MIN_OPERATOR_PASSWORD_LENGTH);
  await assert.rejects(() => hashPassword(tooShort), InvalidPasswordError);
});
