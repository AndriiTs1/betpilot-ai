import { test } from "node:test";
import assert from "node:assert/strict";
import { CircleDot, Disc, Goal, Target, Trophy } from "lucide-react";
import { getSportIcon } from "./sportIcons";

test("getSportIcon: maps each supported sport to its icon", () => {
  assert.equal(getSportIcon("Football"), Goal);
  assert.equal(getSportIcon("Soccer"), Goal);
  assert.equal(getSportIcon("Basketball"), CircleDot);
  assert.equal(getSportIcon("Tennis"), Target);
  assert.equal(getSportIcon("Hockey"), Disc);
});

test("getSportIcon: is case-insensitive", () => {
  assert.equal(getSportIcon("football"), Goal);
  assert.equal(getSportIcon("FOOTBALL"), Goal);
  assert.equal(getSportIcon("FootBall"), Goal);
  assert.equal(getSportIcon("  Tennis  "), Target);
});

test("getSportIcon: mixed-sport lookups stay independent per call", () => {
  // Simulates what BetTicket.tsx does per-leg in a mixed-sport EXPRESS
  // ticket — each selection's own sport resolves independently, one call
  // never affects another.
  const legs = ["Football", "Tennis", "Basketball", "Hockey"];
  const icons = legs.map(getSportIcon);
  assert.deepEqual(icons, [Goal, Target, CircleDot, Disc]);
});

test("getSportIcon: falls back to Trophy for unknown, empty, null, or undefined sport", () => {
  assert.equal(getSportIcon("Darts"), Trophy);
  assert.equal(getSportIcon(""), Trophy);
  assert.equal(getSportIcon(null), Trophy);
  assert.equal(getSportIcon(undefined), Trophy);
});
