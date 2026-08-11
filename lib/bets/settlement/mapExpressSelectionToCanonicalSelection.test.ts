import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@/lib/generated/prisma/client";
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
    line: null,
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

/* -------------------------------------------------------------------------- */
/* X2 — BetSelection.line read-wiring. Same conversion pattern as            */
/* mapSingleBetToCanonicalSelection.ts's own `line` field: Prisma.Decimal's  */
/* own .toString() only, never Number()/parseFloat()/toFixed(). This alone   */
/* does not enable SPREAD/TOTALS EXPRESS settlement — the deferral guards in */
/* aggregateExpressOutcome.ts are untouched and still turn those legs away.  */
/* -------------------------------------------------------------------------- */

test("X2 (A): EXPRESS SPREAD persisted line -1.5 -> canonical selection line \"-1.5\"", () => {
  const selection = mapExpressSelectionToCanonicalSelection(
    fields({ canonicalMarketType: "SPREAD", canonicalSelectionType: "PARTICIPANT", canonicalParticipant: "Arsenal", line: new Prisma.Decimal("-1.5") }),
  );
  assert.equal(selection?.line, "-1.5");
});

test("X2 (B): EXPRESS SPREAD quarter line -1.25 -> canonical selection line \"-1.25\"", () => {
  const selection = mapExpressSelectionToCanonicalSelection(
    fields({ canonicalMarketType: "SPREAD", canonicalSelectionType: "PARTICIPANT", canonicalParticipant: "Arsenal", line: new Prisma.Decimal("-1.25") }),
  );
  assert.equal(selection?.line, "-1.25");
});

test("X2 (C): EXPRESS TOTALS line 2.5 -> canonical selection line \"2.5\"", () => {
  const selection = mapExpressSelectionToCanonicalSelection(
    fields({ canonicalMarketType: "TOTALS", canonicalSelectionType: "OVER", line: new Prisma.Decimal("2.5") }),
  );
  assert.equal(selection?.line, "2.5");
});

test("X2 (D): EXPRESS TOTALS quarter line 2.25 -> canonical selection line \"2.25\"", () => {
  const selection = mapExpressSelectionToCanonicalSelection(
    fields({ canonicalMarketType: "TOTALS", canonicalSelectionType: "OVER", line: new Prisma.Decimal("2.25") }),
  );
  assert.equal(selection?.line, "2.25");
});

test("X2 (E): null persisted line -> canonical selection line undefined", () => {
  const selection = mapExpressSelectionToCanonicalSelection(
    fields({ canonicalMarketType: "TOTALS", canonicalSelectionType: "OVER", line: null }),
  );
  assert.equal(selection?.line, undefined);
});

test("X2 (F): a persisted Decimal equivalent to 3.00 maps to a valid canonical line via Decimal.toString(), never native floating point", () => {
  const selection = mapExpressSelectionToCanonicalSelection(
    fields({ canonicalMarketType: "TOTALS", canonicalSelectionType: "OVER", line: new Prisma.Decimal("3.00") }),
  );
  // Prisma.Decimal("3.00").toString() is "3" (decimal.js normalizes trailing
  // zeros on construction) — this is the exact same representation
  // mapSingleBetToCanonicalSelection.ts already produces for the identical
  // input, proven in that module's own test suite. Asserting the numeric
  // value (not a specific string) is what actually matters here: whatever
  // string comes out must still represent exactly 3, with no floating-point
  // drift introduced by this mapper.
  assert.ok(selection?.line !== undefined);
  assert.equal(new Prisma.Decimal(selection!.line!).toNumber(), 3);
});

test("mapper: MONEYLINE leg with no persisted line -> canonical selection line stays undefined (unaffected by X2)", () => {
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
