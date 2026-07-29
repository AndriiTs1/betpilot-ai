import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { computeImageHash } from "./imageHash";

test("computeImageHash: identical bytes produce identical hashes", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 0, 128]);
  const copy = new Uint8Array(bytes);

  assert.equal(computeImageHash(bytes), computeImageHash(copy));
});

test("computeImageHash: calling it twice on the same bytes is stable (deterministic, no hidden state)", () => {
  const bytes = new Uint8Array([9, 8, 7, 6, 5]);
  assert.equal(computeImageHash(bytes), computeImageHash(bytes));
});

test("computeImageHash: different bytes produce different hashes", () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2, 4]);
  assert.notEqual(computeImageHash(a), computeImageHash(b));
});

test("computeImageHash: a single differing byte anywhere changes the hash (avalanche, not just length)", () => {
  const base = new Uint8Array(1000).fill(7);
  const changed = new Uint8Array(base);
  changed[500] = 8;

  assert.notEqual(computeImageHash(base), computeImageHash(changed));
});

test("computeImageHash: different-length inputs sharing a common prefix produce different hashes", () => {
  const shorter = new Uint8Array([1, 2, 3]);
  const longer = new Uint8Array([1, 2, 3, 4]);
  assert.notEqual(computeImageHash(shorter), computeImageHash(longer));
});

test("computeImageHash: matches a plain node:crypto sha256 hex digest of the same bytes", () => {
  const bytes = new Uint8Array([100, 101, 102, 103]);
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(computeImageHash(bytes), expected);
});

test("computeImageHash: returns a 64-character lowercase hex string", () => {
  const hash = computeImageHash(new Uint8Array([1, 2, 3]));
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test("computeImageHash: empty input still produces a valid, stable hash (never throws, never empty)", () => {
  const hash = computeImageHash(new Uint8Array(0));
  assert.equal(hash.length, 64);
  assert.equal(hash, computeImageHash(new Uint8Array(0)));
});

test("computeImageHash: accepts a Buffer (Node's Uint8Array subclass) the same way as a plain Uint8Array", () => {
  const plain = new Uint8Array([5, 10, 15, 20]);
  const asBuffer = Buffer.from(plain);
  assert.equal(computeImageHash(plain), computeImageHash(asBuffer));
});
