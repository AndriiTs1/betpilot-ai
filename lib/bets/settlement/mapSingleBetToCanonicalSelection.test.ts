import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@/lib/generated/prisma/client";
import { mapSingleBetToCanonicalSelection, type SingleBetCanonicalFields } from "./mapSingleBetToCanonicalSelection";

function fields(overrides: Partial<SingleBetCanonicalFields> = {}): SingleBetCanonicalFields {
  return {
    canonicalMarketType: "MONEYLINE_3WAY",
    canonicalSelectionType: "HOME",
    canonicalParticipant: null,
    canonicalPeriod: "FULL_GAME",
    line: null,
    ...overrides,
  };
}

test("mapper: valid MONEYLINE_3WAY HOME maps correctly", () => {
  const selection = mapSingleBetToCanonicalSelection(fields());
  assert.ok(selection);
  assert.equal(selection?.marketType, "MONEYLINE_3WAY");
  assert.equal(selection?.selectionType, "HOME");
  assert.equal(selection?.period, "FULL_GAME");
  assert.equal(selection?.participant, undefined);
});

test("mapper: valid MONEYLINE_2WAY AWAY maps correctly", () => {
  const selection = mapSingleBetToCanonicalSelection(fields({ canonicalMarketType: "MONEYLINE_2WAY", canonicalSelectionType: "AWAY" }));
  assert.ok(selection);
  assert.equal(selection?.marketType, "MONEYLINE_2WAY");
  assert.equal(selection?.selectionType, "AWAY");
});

test("mapper: DRAW selectionType maps correctly", () => {
  const selection = mapSingleBetToCanonicalSelection(fields({ canonicalSelectionType: "DRAW" }));
  assert.ok(selection);
  assert.equal(selection?.selectionType, "DRAW");
});

test("mapper: canonicalParticipant is carried through as CanonicalParticipant.name", () => {
  const selection = mapSingleBetToCanonicalSelection(fields({ canonicalParticipant: "Arsenal" }));
  assert.deepEqual(selection?.participant, { name: "Arsenal" });
});

test("mapper: Bet.line = null maps to CanonicalSelection.line = undefined (MONEYLINE has no line concept)", () => {
  const selection = mapSingleBetToCanonicalSelection(fields());
  assert.equal(selection?.line, undefined);
});

// H4-B2 — Bet.line is now threaded through (Section 13). Exact preservation,
// no rounding: -1.25 stays "-1.25", 0.75 stays "0.75", never coerced
// through a native floating-point number anywhere in this path.
for (const value of ["-1.25", "0.75", "-1.75", "1.25", "-1.5", "2.5", "0"]) {
  test(`mapper: Bet.line = ${value} is threaded through to CanonicalSelection.line exactly, no rounding`, () => {
    const selection = mapSingleBetToCanonicalSelection(
      fields({
        canonicalMarketType: "SPREAD",
        canonicalSelectionType: "PARTICIPANT",
        canonicalParticipant: "Arsenal",
        line: new Prisma.Decimal(value),
      }),
    );
    assert.equal(selection?.line, value);
  });
}

test("mapper: free-text fields (Bet.event/Bet.outcome) are not even part of the input type — nothing to ignore, structurally impossible to leak in", () => {
  // SingleBetCanonicalFields has no event/outcome/sport field at all.
  const selection = mapSingleBetToCanonicalSelection(fields());
  assert.equal(selection?.event.name, "");
  assert.deepEqual(selection?.event.participants, []);
});

test("mapper: missing canonicalMarketType -> null", () => {
  assert.equal(mapSingleBetToCanonicalSelection(fields({ canonicalMarketType: null })), null);
});

// Individual Team Totals, Stage 4 — no changes were needed to this mapper
// for TEAM_TOTAL: isMarketType/isSelectionType already accept it (Phase 0),
// and canonicalParticipant/line are already fully generic fields.
test("mapper: TEAM_TOTAL maps correctly — marketType, participant, and line all carried through", () => {
  const selection = mapSingleBetToCanonicalSelection(
    fields({
      canonicalMarketType: "TEAM_TOTAL",
      canonicalSelectionType: "OVER",
      canonicalParticipant: "Marseille",
      line: new Prisma.Decimal("1.5"),
    }),
  );
  assert.ok(selection);
  assert.equal(selection?.marketType, "TEAM_TOTAL");
  assert.equal(selection?.selectionType, "OVER");
  assert.deepEqual(selection?.participant, { name: "Marseille" });
  assert.equal(selection?.line, "1.5");
});

test("mapper: invalid (unrecognized) canonicalMarketType -> null", () => {
  assert.equal(mapSingleBetToCanonicalSelection(fields({ canonicalMarketType: "NOT_A_REAL_MARKET" })), null);
});

test("mapper: missing canonicalSelectionType -> null", () => {
  assert.equal(mapSingleBetToCanonicalSelection(fields({ canonicalSelectionType: null })), null);
});

test("mapper: invalid canonicalSelectionType -> null", () => {
  assert.equal(mapSingleBetToCanonicalSelection(fields({ canonicalSelectionType: "NOT_A_REAL_SELECTION" })), null);
});

test("mapper: missing canonicalPeriod -> null", () => {
  assert.equal(mapSingleBetToCanonicalSelection(fields({ canonicalPeriod: null })), null);
});

test("mapper: invalid canonicalPeriod -> null", () => {
  assert.equal(mapSingleBetToCanonicalSelection(fields({ canonicalPeriod: "NOT_A_REAL_PERIOD" })), null);
});

test("mapper: PARTICIPANT selectionType maps structurally (support/unsupport decided later by the evaluator, not the mapper)", () => {
  const selection = mapSingleBetToCanonicalSelection(
    fields({ canonicalMarketType: "MONEYLINE_2WAY", canonicalSelectionType: "PARTICIPANT", canonicalParticipant: "Novak Djokovic" }),
  );
  assert.ok(selection);
  assert.equal(selection?.selectionType, "PARTICIPANT");
});

test("mapper: does not mutate its input", () => {
  const input = fields();
  const copy = { ...input };
  mapSingleBetToCanonicalSelection(input);
  assert.deepEqual(input, copy);
});

test("mapper: identical input always returns a deep-equal result", () => {
  const input = fields();
  const r1 = mapSingleBetToCanonicalSelection(input);
  const r2 = mapSingleBetToCanonicalSelection(input);
  assert.deepEqual(r1, r2);
});
