import { test } from "node:test";
import assert from "node:assert/strict";
import { wouldLocalizedPathDiffer, type DecisionComparisonInput } from "./selectedRegionLocalization";

function input(overrides: Partial<DecisionComparisonInput>): DecisionComparisonInput {
  return {
    currentNumericVerdict: "CORROBORATED",
    localizedNumericVerdict: "CORROBORATED",
    currentMarketVerdict: "CORROBORATED",
    localizedMarketVerdict: "CORROBORATED",
    currentFinalDecision: "ACCEPTED",
    ...overrides,
  };
}

test("both paths accept -> no difference", () => {
  assert.equal(wouldLocalizedPathDiffer(input({})), false);
});

test("current rejected (numeric), localized also would reject -> no difference", () => {
  assert.equal(
    wouldLocalizedPathDiffer(
      input({ currentFinalDecision: "REJECTED_NUMERIC", localizedNumericVerdict: "CONTRADICTED" }),
    ),
    false,
  );
});

test("current rejected due to whole-screen sibling noise, localized evidence corroborates -> DIFFERS (the exact false-rejection class this stage exists to detect)", () => {
  assert.equal(
    wouldLocalizedPathDiffer(
      input({
        currentFinalDecision: "REJECTED_MARKET",
        currentMarketVerdict: "AMBIGUOUS",
        localizedMarketVerdict: "CORROBORATED",
      }),
    ),
    true,
  );
});

test("current accepted, localized would reject -> DIFFERS (the other direction: localized evidence finds a real problem whole-screen missed)", () => {
  assert.equal(
    wouldLocalizedPathDiffer(input({ localizedNumericVerdict: "CONTRADICTED" })),
    true,
  );
});

test("localized verdict NOT_AVAILABLE never itself causes a difference", () => {
  assert.equal(
    wouldLocalizedPathDiffer(
      input({ localizedNumericVerdict: "NOT_AVAILABLE", localizedMarketVerdict: "NOT_AVAILABLE" }),
    ),
    false,
  );
});

test("AMBIGUOUS localized verdict counts as a would-be rejection, same as CONTRADICTED", () => {
  assert.equal(
    wouldLocalizedPathDiffer(input({ localizedMarketVerdict: "AMBIGUOUS" })),
    true,
  );
});

test("UNVERIFIED localized verdict never itself causes a difference (absence of evidence is not evidence of a problem)", () => {
  assert.equal(
    wouldLocalizedPathDiffer(
      input({ localizedNumericVerdict: "UNVERIFIED", localizedMarketVerdict: "UNVERIFIED" }),
    ),
    false,
  );
});

test("both current gates rejected and both localized verdicts still reject -> no difference", () => {
  assert.equal(
    wouldLocalizedPathDiffer(
      input({
        currentFinalDecision: "REJECTED_NUMERIC",
        localizedNumericVerdict: "AMBIGUOUS",
        localizedMarketVerdict: "CONTRADICTED",
      }),
    ),
    false,
  );
});
