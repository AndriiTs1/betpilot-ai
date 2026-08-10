import { test } from "node:test";
import assert from "node:assert/strict";
import { STATUS_BADGES } from "./StatusBadge";

// No DOM-rendering test infra exists in this repo (see
// components/miniapp/ActiveBetsScreen.test.ts's own header comment) — this
// proves the exact lookup StatusBadge's JSX reads from
// (STATUS_BADGES[status] ?? fallback), not a rendered DOM tree.
//
// NOTE: this file lives in components/bets/, which is not currently
// included in package.json's `test` script glob (only lib/**, app/api/**,
// and components/miniapp/** are) — the same pre-existing gap
// components/bets/SelectionRow.test.ts already has. Not fixed here: a
// package.json change is outside H4-B4's lifecycle/display-readiness
// scope. Run explicitly via `npx tsx --test components/bets/StatusBadge.test.ts`.

test("StatusBadge: SETTLED_HALF_WIN uses the win-family color (same as SETTLED_WIN) with an explicit 'Half win' label", () => {
  assert.deepEqual(STATUS_BADGES.SETTLED_HALF_WIN, { dot: "bg-green-400", label: "Half win", text: "text-green-300" });
  assert.equal(STATUS_BADGES.SETTLED_HALF_WIN.dot, STATUS_BADGES.SETTLED_WIN.dot);
  assert.equal(STATUS_BADGES.SETTLED_HALF_WIN.text, STATUS_BADGES.SETTLED_WIN.text);
  assert.notEqual(STATUS_BADGES.SETTLED_HALF_WIN.label, STATUS_BADGES.SETTLED_WIN.label);
});

test("StatusBadge: SETTLED_HALF_LOSS uses the loss-family color (same as SETTLED_LOSS) with an explicit 'Half loss' label", () => {
  assert.deepEqual(STATUS_BADGES.SETTLED_HALF_LOSS, { dot: "bg-red-400", label: "Half loss", text: "text-red-300" });
  assert.equal(STATUS_BADGES.SETTLED_HALF_LOSS.dot, STATUS_BADGES.SETTLED_LOSS.dot);
  assert.equal(STATUS_BADGES.SETTLED_HALF_LOSS.text, STATUS_BADGES.SETTLED_LOSS.text);
  assert.notEqual(STATUS_BADGES.SETTLED_HALF_LOSS.label, STATUS_BADGES.SETTLED_LOSS.label);
});

test("StatusBadge: HALF_WIN is never visually collapsed into full WIN, HALF_LOSS never into full LOSS", () => {
  assert.notDeepEqual(STATUS_BADGES.SETTLED_HALF_WIN, STATUS_BADGES.SETTLED_WIN);
  assert.notDeepEqual(STATUS_BADGES.SETTLED_HALF_LOSS, STATUS_BADGES.SETTLED_LOSS);
});

// Regression — existing labels/colors must be byte-for-byte unchanged.
test("StatusBadge: WIN/LOSS/VOID/PENDING/CONFIRMED/REJECTED labels are unchanged", () => {
  assert.deepEqual(STATUS_BADGES.SETTLED_WIN, { dot: "bg-green-400", label: "Won", text: "text-green-300" });
  assert.deepEqual(STATUS_BADGES.SETTLED_LOSS, { dot: "bg-red-400", label: "Lost", text: "text-red-300" });
  assert.deepEqual(STATUS_BADGES.VOID, { dot: "bg-slate-500", label: "Void", text: "text-slate-400" });
  assert.deepEqual(STATUS_BADGES.PENDING, { dot: "bg-yellow-400", label: "Pending", text: "text-yellow-300" });
  assert.deepEqual(STATUS_BADGES.CONFIRMED, { dot: "bg-blue-400", label: "Confirmed", text: "text-blue-300" });
  assert.deepEqual(STATUS_BADGES.REJECTED, { dot: "bg-slate-500", label: "Rejected", text: "text-slate-400" });
});

test("StatusBadge: an unrecognized status still falls back safely (never throws, never undefined)", () => {
  assert.equal(STATUS_BADGES["NOT_A_REAL_STATUS" as keyof typeof STATUS_BADGES], undefined);
});
