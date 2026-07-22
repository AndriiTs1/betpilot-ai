import { test } from "node:test";
import assert from "node:assert/strict";
import { getOddsStatusBadge, ODDS_STATUS_BADGES } from "./oddsStatusBadge";

test("getOddsStatusBadge: every known status resolves to its fixed label/color", () => {
  for (const [status, info] of Object.entries(ODDS_STATUS_BADGES)) {
    assert.deepEqual(getOddsStatusBadge(status), info);
  }
});

test("getOddsStatusBadge: null/undefined returns an empty label, never a fabricated one", () => {
  assert.equal(getOddsStatusBadge(null).label, "");
  assert.equal(getOddsStatusBadge(undefined).label, "");
});

test("getOddsStatusBadge: an unrecognized status echoes the raw string instead of dropping it silently", () => {
  const badge = getOddsStatusBadge("SOME_FUTURE_STATUS");
  assert.equal(badge.label, "SOME_FUTURE_STATUS");
  assert.equal(badge.color, "#94a3b8");
});
