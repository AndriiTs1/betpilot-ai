import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapExpressSelectionToCanonicalSelection,
  type ExpressSelectionCanonicalFields,
} from "./mapExpressSelectionToCanonicalSelection";

function fields(overrides: Partial<ExpressSelectionCanonicalFields> = {}): ExpressSelectionCanonicalFields {
  return {
    canonicalMarketType: "MONEYLINE_3WAY",
    canonicalSelectionType: "HOME",
    canonicalParticipant: null,
    canonicalPeriod: "FULL_GAME",
    ...overrides,
  };
}

test("mapper: valid MONEYLINE_3WAY HOME maps correctly", () => {
  const selection = mapExpressSelectionToCanonicalSelection(fields());
  assert.ok(selection);
  assert.equal(selection?.marketType, "MONEYLINE_3WAY");
  assert.equal(selection?.selectionType, "HOME");
  assert.equal(selection?.period, "FULL_GAME");
  assert.equal(selection?.participant, undefined);
});

test("mapper: valid MONEYLINE_2WAY AWAY maps correctly", () => {
  const selection = mapExpressSelectionToCanonicalSelection(
    fields({ canonicalMarketType: "MONEYLINE_2WAY", canonicalSelectionType: "AWAY" }),
  );
  assert.ok(selection);
  assert.equal(selection?.marketType, "MONEYLINE_2WAY");
  assert.equal(selection?.selectionType, "AWAY");
});

test("mapper: DRAW selectionType maps correctly", () => {
  const selection = mapExpressSelectionToCanonicalSelection(fields({ canonicalSelectionType: "DRAW" }));
  assert.ok(selection);
  assert.equal(selection?.selectionType, "DRAW");
});

test("mapper: canonicalParticipant is carried through as CanonicalParticipant.name", () => {
  const selection = mapExpressSelectionToCanonicalSelection(fields({ canonicalParticipant: "Arsenal" }));
  assert.deepEqual(selection?.participant, { name: "Arsenal" });
});

test("mapper: no canonicalLine column exists on BetSelection — mapper never sets .line", () => {
  const selection = mapExpressSelectionToCanonicalSelection(fields());
  assert.equal(selection?.line, undefined);
});

test("mapper: free-text fields (BetSelection.event/.outcome) are not even part of the input type", () => {
  const selection = mapExpressSelectionToCanonicalSelection(fields());
  assert.equal(selection?.event.name, "");
  assert.deepEqual(selection?.event.participants, []);
});

test("mapper: missing canonicalMarketType -> null", () => {
  assert.equal(mapExpressSelectionToCanonicalSelection(fields({ canonicalMarketType: null })), null);
});

test("mapper: invalid (unrecognized) canonicalMarketType -> null", () => {
  assert.equal(mapExpressSelectionToCanonicalSelection(fields({ canonicalMarketType: "NOT_A_REAL_MARKET" })), null);
});

test("mapper: missing canonicalSelectionType -> null", () => {
  assert.equal(mapExpressSelectionToCanonicalSelection(fields({ canonicalSelectionType: null })), null);
});

test("mapper: invalid canonicalSelectionType -> null", () => {
  assert.equal(mapExpressSelectionToCanonicalSelection(fields({ canonicalSelectionType: "NOT_A_REAL_SELECTION" })), null);
});

test("mapper: missing canonicalPeriod -> null", () => {
  assert.equal(mapExpressSelectionToCanonicalSelection(fields({ canonicalPeriod: null })), null);
});

test("mapper: invalid canonicalPeriod -> null", () => {
  assert.equal(mapExpressSelectionToCanonicalSelection(fields({ canonicalPeriod: "NOT_A_REAL_PERIOD" })), null);
});

test("mapper: does not mutate its input", () => {
  const input = fields();
  const copy = { ...input };
  mapExpressSelectionToCanonicalSelection(input);
  assert.deepEqual(input, copy);
});

test("mapper: identical input always returns a deep-equal result", () => {
  const input = fields();
  const r1 = mapExpressSelectionToCanonicalSelection(input);
  const r2 = mapExpressSelectionToCanonicalSelection(input);
  assert.deepEqual(r1, r2);
});
