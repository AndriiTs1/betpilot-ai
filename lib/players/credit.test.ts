import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@/lib/generated/prisma/client";
import { computeRemainingCredit, clampAvailableForDisplay } from "./credit";

test("computeRemainingCredit: positive currentCredit does not increase the limit", () => {
  const result = computeRemainingCredit({
    creditLimit: new Prisma.Decimal(10000),
    currentCredit: new Prisma.Decimal(500),
  });
  assert.equal(result.toString(), "10000");
});

test("computeRemainingCredit: zero currentCredit leaves the full limit available", () => {
  const result = computeRemainingCredit({
    creditLimit: new Prisma.Decimal(10000),
    currentCredit: new Prisma.Decimal(0),
  });
  assert.equal(result.toString(), "10000");
});

test("computeRemainingCredit: negative currentCredit shrinks the limit by the debt", () => {
  const result = computeRemainingCredit({
    creditLimit: new Prisma.Decimal(10000),
    currentCredit: new Prisma.Decimal(-2500),
  });
  assert.equal(result.toString(), "7500");
});

test("computeRemainingCredit: debt larger than the limit can produce a negative remaining credit", () => {
  const result = computeRemainingCredit({
    creditLimit: new Prisma.Decimal(1000),
    currentCredit: new Prisma.Decimal(-2500),
  });
  assert.equal(result.toString(), "-1500");
});

test("clampAvailableForDisplay: positive value passes through unchanged", () => {
  const result = clampAvailableForDisplay(new Prisma.Decimal(250), "player:test");
  assert.equal(result.toString(), "250");
});

test("clampAvailableForDisplay: zero passes through unchanged", () => {
  const result = clampAvailableForDisplay(new Prisma.Decimal(0), "player:test");
  assert.equal(result.toString(), "0");
});

test("clampAvailableForDisplay: negative value is clamped to 0", () => {
  const result = clampAvailableForDisplay(new Prisma.Decimal(-150), "player:test");
  assert.equal(result.toString(), "0");
});

test("clampAvailableForDisplay: logs a diagnostic warning when clamping, without throwing", () => {
  const originalWarn = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };

  try {
    clampAvailableForDisplay(new Prisma.Decimal(-1), "player:abc123");
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), /player:abc123/);
});
