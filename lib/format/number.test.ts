import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDisplayNumber, formatSignedDisplayNumber } from "./number";

test("formatDisplayNumber: inserts thousand-space separators", () => {
  assert.equal(formatDisplayNumber("10000"), "10 000");
  assert.equal(formatDisplayNumber("1250000"), "1 250 000");
});

test("formatDisplayNumber: leaves small numbers unchanged", () => {
  assert.equal(formatDisplayNumber("500"), "500");
  assert.equal(formatDisplayNumber("0"), "0");
});

test("formatDisplayNumber: preserves a decimal part without altering it", () => {
  assert.equal(formatDisplayNumber("1250.5"), "1 250.5");
});

test("formatDisplayNumber: preserves a leading sign", () => {
  assert.equal(formatDisplayNumber("-1250"), "-1 250");
  assert.equal(formatDisplayNumber("+1250"), "+1 250");
});

test("formatDisplayNumber: passes through a non-numeric string unchanged", () => {
  assert.equal(formatDisplayNumber("—"), "—");
});

test("formatSignedDisplayNumber: positive value gets a '+' prefix", () => {
  assert.equal(formatSignedDisplayNumber("110"), "+110");
  assert.equal(formatSignedDisplayNumber("1250.5"), "+1 250.5");
});

test("formatSignedDisplayNumber: negative value keeps its '-' prefix, no double sign", () => {
  assert.equal(formatSignedDisplayNumber("-75"), "-75");
  assert.equal(formatSignedDisplayNumber("-1250"), "-1 250");
});

test("formatSignedDisplayNumber: zero renders as a bare '0', no sign", () => {
  assert.equal(formatSignedDisplayNumber("0"), "0");
  assert.equal(formatSignedDisplayNumber("0.00"), "0");
});

test("formatSignedDisplayNumber: large positive value groups thousands correctly", () => {
  assert.equal(formatSignedDisplayNumber("12500"), "+12 500");
});
