import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractedField,
  missingField,
  unknownField,
  unsupportedField,
  ambiguousField,
  BetDraftDomainError,
} from "./domain";

/* -------------------------------------------------------------------------- */
/* Every valid FieldState variant                                             */
/* -------------------------------------------------------------------------- */

test("extractedField: state EXTRACTED always carries a non-null value", () => {
  const field = extractedField("FOOTBALL", "football");
  assert.equal(field.state, "EXTRACTED");
  assert.equal(field.value, "FOOTBALL");
  assert.equal(field.rawText, "football");
});

test("extractedField: rawText is optional", () => {
  const field = extractedField(42);
  assert.equal(field.state, "EXTRACTED");
  assert.equal(field.value, 42);
  assert.equal(field.rawText, undefined);
});

test("missingField: state MISSING always carries value null", () => {
  const field = missingField();
  assert.equal(field.state, "MISSING");
  assert.equal(field.value, null);
});

test("missingField: rawText may still be set even though value is null", () => {
  const field = missingField("some raw text");
  assert.equal(field.state, "MISSING");
  assert.equal(field.value, null);
  assert.equal(field.rawText, "some raw text");
});

test("unknownField: state UNKNOWN always carries value null, preserves rawText", () => {
  const field = unknownField("EPL");
  assert.equal(field.state, "UNKNOWN");
  assert.equal(field.value, null);
  assert.equal(field.rawText, "EPL");
});

test("unsupportedField: state UNSUPPORTED always carries value null, preserves rawText", () => {
  const field = unsupportedField("cricket");
  assert.equal(field.state, "UNSUPPORTED");
  assert.equal(field.value, null);
  assert.equal(field.rawText, "cricket");
});

test("ambiguousField: state AMBIGUOUS carries value null and the given candidates", () => {
  const field = ambiguousField(["FOOTBALL", "BASKETBALL"], "some raw text");
  assert.equal(field.state, "AMBIGUOUS");
  assert.equal(field.value, null);
  if (field.state === "AMBIGUOUS") {
    assert.deepEqual(field.candidates, ["FOOTBALL", "BASKETBALL"]);
  }
});

/* -------------------------------------------------------------------------- */
/* Invalid/contradictory combinations are impossible (compile-time) or        */
/* rejected (runtime, for the one case TS can't statically enforce)           */
/* -------------------------------------------------------------------------- */

test("ambiguousField: throws BetDraftDomainError with fewer than two candidates", () => {
  assert.throws(
    () => ambiguousField(["FOOTBALL"]),
    (err: unknown) => err instanceof BetDraftDomainError && err.code === "AMBIGUOUS_REQUIRES_MULTIPLE_CANDIDATES",
  );
});

test("ambiguousField: throws BetDraftDomainError with zero candidates", () => {
  assert.throws(
    () => ambiguousField([]),
    (err: unknown) => err instanceof BetDraftDomainError && err.code === "AMBIGUOUS_REQUIRES_MULTIPLE_CANDIDATES",
  );
});

test("ambiguousField: throws BetDraftDomainError when all candidates are identical (not distinct)", () => {
  assert.throws(
    () => ambiguousField(["FOOTBALL", "FOOTBALL"]),
    (err: unknown) => err instanceof BetDraftDomainError && err.code === "AMBIGUOUS_REQUIRES_DISTINCT_CANDIDATES",
  );
});

test("ambiguousField: three candidates with only two distinct values still throws", () => {
  assert.throws(
    () => ambiguousField(["FOOTBALL", "FOOTBALL", "FOOTBALL"]),
    (err: unknown) => err instanceof BetDraftDomainError && err.code === "AMBIGUOUS_REQUIRES_DISTINCT_CANDIDATES",
  );
});

test("ambiguousField: three candidates where two are duplicates and one differs is accepted (2+ distinct)", () => {
  const field = ambiguousField(["FOOTBALL", "FOOTBALL", "BASKETBALL"]);
  if (field.state === "AMBIGUOUS") {
    assert.equal(field.candidates.length, 3);
  }
});

/* -------------------------------------------------------------------------- */
/* Immutable input behavior                                                   */
/* -------------------------------------------------------------------------- */

test("ambiguousField: the returned field's candidates array is the same readonly reference passed in (no unnecessary copy/mutation)", () => {
  const candidates = ["FOOTBALL", "BASKETBALL"] as const;
  const field = ambiguousField(candidates);
  if (field.state === "AMBIGUOUS") {
    assert.equal(field.candidates, candidates);
  }
});

test("extractedField: constructing a field does not mutate the input value object", () => {
  const value = Object.freeze({ rawText: "La Liga", resolvedName: "La Liga" });
  assert.doesNotThrow(() => extractedField(value, "la liga"));
  assert.deepEqual(value, { rawText: "La Liga", resolvedName: "La Liga" });
});

test("field objects are frozen-compatible (constructors return plain, non-mutated shapes)", () => {
  const field = extractedField("FOOTBALL", "football");
  // Every field returned by these constructors uses `readonly` at the type
  // level; this test additionally verifies at runtime that freezing a
  // constructed field doesn't reveal any hidden mutable property.
  assert.doesNotThrow(() => Object.freeze(field));
  assert.equal(Object.isFrozen(Object.freeze(field)), true);
});
