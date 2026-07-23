import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VERIFICATION_STATUSES,
  VERIFICATION_REASON_CODES,
  classifyReasonCode,
  isRetryableReason,
  createVerifiedResult,
  createOddsChangedResult,
  createFailedResult,
  createNotCheckedResult,
} from "./verification";

const CHECKED_AT = "2026-07-24T00:00:00.000Z";

/* -------------------------------------------------------------------------- */
/* Group A (continued) — reason codes are stable                              */
/* -------------------------------------------------------------------------- */

test("VerificationStatus: exact serialized values", () => {
  assert.deepEqual(VERIFICATION_STATUSES, ["VERIFIED", "ODDS_CHANGED", "FAILED", "NOT_CHECKED"]);
});

test("VerificationReasonCode: exact serialized values, stable order", () => {
  assert.deepEqual(VERIFICATION_REASON_CODES, [
    "NONE",
    "EVENT_NOT_FOUND",
    "MARKET_NOT_SUPPORTED",
    "SELECTION_NOT_FOUND",
    "SPORT_NOT_SUPPORTED",
    "LEAGUE_NOT_SUPPORTED",
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_TIMEOUT",
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_INVALID_RESPONSE",
    "AMBIGUOUS_EVENT",
    "INVALID_INPUT",
    "ODDS_OUTSIDE_TOLERANCE",
    "NOT_CHECKED",
  ]);
});

test("every reason code has a classification with no gaps", () => {
  for (const reason of VERIFICATION_REASON_CODES) {
    const classification = classifyReasonCode(reason);
    assert.ok(classification.category);
    assert.equal(typeof classification.retryable, "boolean");
  }
});

test("retryable reason codes are exactly the provider-failure family", () => {
  const retryable = VERIFICATION_REASON_CODES.filter(isRetryableReason);
  assert.deepEqual(
    retryable.slice().sort(),
    ["PROVIDER_INVALID_RESPONSE", "PROVIDER_RATE_LIMITED", "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE"].sort(),
  );
});

test("coverage-failure and matching-failure reason codes are never retryable", () => {
  for (const reason of [
    "EVENT_NOT_FOUND",
    "MARKET_NOT_SUPPORTED",
    "SELECTION_NOT_FOUND",
    "SPORT_NOT_SUPPORTED",
    "LEAGUE_NOT_SUPPORTED",
    "AMBIGUOUS_EVENT",
    "INVALID_INPUT",
  ] as const) {
    assert.equal(isRetryableReason(reason), false, `${reason} must not be retryable`);
  }
});

/* -------------------------------------------------------------------------- */
/* Group B — VerificationResult invariants                                    */
/* -------------------------------------------------------------------------- */

test("VERIFIED: acceptedOdds equals currentOdds, reasonCode is NONE", () => {
  const result = createVerifiedResult({
    submittedOdds: "2.10",
    currentOdds: "2.05",
    provider: "THE_ODDS_API",
    checkedAt: CHECKED_AT,
  });

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.reasonCode, "NONE");
  assert.equal(result.acceptedOdds, result.currentOdds);
  assert.equal(result.acceptedOdds, "2.05");
  assert.equal(result.retryable, false);
});

test("ODDS_CHANGED: acceptedOdds is null, reasonCode is ODDS_OUTSIDE_TOLERANCE", () => {
  const result = createOddsChangedResult({
    submittedOdds: "2.10",
    currentOdds: "1.50",
    provider: "THE_ODDS_API",
    checkedAt: CHECKED_AT,
  });

  assert.equal(result.status, "ODDS_CHANGED");
  assert.equal(result.reasonCode, "ODDS_OUTSIDE_TOLERANCE");
  assert.equal(result.acceptedOdds, null);
  assert.equal(result.currentOdds, "1.50");
});

test("FAILED: acceptedOdds is null, reasonCode is never NONE, and matches the given reason", () => {
  const result = createFailedResult({
    submittedOdds: "2.10",
    provider: "THE_ODDS_API",
    checkedAt: CHECKED_AT,
    reasonCode: "EVENT_NOT_FOUND",
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.acceptedOdds, null);
  assert.notEqual(result.reasonCode, "NONE");
  assert.equal(result.reasonCode, "EVENT_NOT_FOUND");
});

test("FAILED: retryable flag matches the reason code's classification", () => {
  const unavailable = createFailedResult({
    submittedOdds: "2.10",
    provider: "THE_ODDS_API",
    checkedAt: CHECKED_AT,
    reasonCode: "PROVIDER_UNAVAILABLE",
  });
  assert.equal(unavailable.retryable, true);

  const notSupported = createFailedResult({
    submittedOdds: "2.10",
    provider: "THE_ODDS_API",
    checkedAt: CHECKED_AT,
    reasonCode: "MARKET_NOT_SUPPORTED",
  });
  assert.equal(notSupported.retryable, false);
});

test("FAILED: the type system rejects NONE as a reason (compile-time; runtime shape check here)", () => {
  // createFailedResult's TS signature excludes "NONE" from its reasonCode
  // parameter (Exclude<VerificationReasonCode, "NONE">) — this test
  // documents that invariant at the value level for every other reason.
  for (const reason of VERIFICATION_REASON_CODES) {
    if (reason === "NONE") continue;
    const result = createFailedResult({
      submittedOdds: null,
      provider: "THE_ODDS_API",
      checkedAt: CHECKED_AT,
      reasonCode: reason,
    });
    assert.notEqual(result.reasonCode, "NONE");
  }
});

test("NOT_CHECKED: acceptedOdds null, reasonCode NOT_CHECKED, currentOdds null", () => {
  const result = createNotCheckedResult({
    submittedOdds: null,
    provider: "THE_ODDS_API",
    checkedAt: CHECKED_AT,
  });

  assert.equal(result.status, "NOT_CHECKED");
  assert.equal(result.reasonCode, "NOT_CHECKED");
  assert.equal(result.acceptedOdds, null);
  assert.equal(result.currentOdds, null);
});

test("publicMessageKey is populated for every constructed result and never contains raw diagnostic text", () => {
  const results = [
    createVerifiedResult({ submittedOdds: "2.0", currentOdds: "2.0", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
    createOddsChangedResult({ submittedOdds: "2.0", currentOdds: "1.5", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
    createFailedResult({ submittedOdds: "2.0", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "PROVIDER_TIMEOUT" }),
    createNotCheckedResult({ submittedOdds: null, provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
  ];

  for (const result of results) {
    assert.match(result.publicMessageKey, /^odds\.[a-z_]+$/);
  }
});
