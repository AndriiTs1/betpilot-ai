import { test } from "node:test";
import assert from "node:assert/strict";
import { SettlementReviewReason } from "@/lib/generated/prisma/client";
import type { ScoresFetchFailureReason } from "@/lib/odds/providers/theOddsApi/scoresAdapter";
import type { SelectionOutcomeEvaluation } from "./evaluateSelectionOutcome";
import type { AutoSettlementRejectionReasonCode } from "./autoSettleSingleBet";
import type { AutoSettlementExpressRejectionReasonCode } from "./autoSettleExpressBet";
import type { AggregateExpressOutcome } from "./aggregateExpressOutcome";
import {
  classifyConflict,
  classifyEventNotFound,
  classifyEvaluatorOutcome,
  classifyExpressNoActionAggregate,
  classifyInvalidDataReasonCode,
  classifyNoActionReasonCode,
  classifyProviderFetchFailure,
  classifyRejectionReasonCode,
  classifySettleFailureCode,
  classifyUnsupportedReasonCode,
} from "./classifySettlementFailure";

/* -------------------------------------------------------------------------- */
/* Cycle-level: every provider fetch failure -> CYCLE_PROVIDER_FAILURE only   */
/* -------------------------------------------------------------------------- */

const ALL_PROVIDER_FETCH_FAILURE_REASONS: readonly ScoresFetchFailureReason[] = [
  "MISSING_API_KEY",
  "TIMEOUT",
  "HTTP_401",
  "HTTP_429",
  "HTTP_5XX",
  "HTTP_ERROR",
  "INVALID_JSON",
  "INVALID_RESPONSE",
];

test("every ScoresFetchFailureReason classifies as CYCLE_PROVIDER_FAILURE — never a bet-level category", () => {
  for (const reason of ALL_PROVIDER_FETCH_FAILURE_REASONS) {
    const result = classifyProviderFetchFailure(reason);
    assert.equal(result.category, "CYCLE_PROVIDER_FAILURE", `reason ${reason} must classify as CYCLE_PROVIDER_FAILURE`);
  }
});

test("HTTP_5XX never becomes a bet-level retry", () => {
  assert.equal(classifyProviderFetchFailure("HTTP_5XX").category, "CYCLE_PROVIDER_FAILURE");
});

test("HTTP_429 never becomes a bet-level retry", () => {
  assert.equal(classifyProviderFetchFailure("HTTP_429").category, "CYCLE_PROVIDER_FAILURE");
});

test("TIMEOUT never becomes a bet-level retry", () => {
  assert.equal(classifyProviderFetchFailure("TIMEOUT").category, "CYCLE_PROVIDER_FAILURE");
});

test("HTTP_401 never becomes a bet-level retry", () => {
  assert.equal(classifyProviderFetchFailure("HTTP_401").category, "CYCLE_PROVIDER_FAILURE");
});

/* -------------------------------------------------------------------------- */
/* Bet-level: EVENT_NOT_FOUND (synthetic, post-successful-fetch absence)      */
/* -------------------------------------------------------------------------- */

test("EVENT_NOT_FOUND after a successful provider response is a bet-level transient retry", () => {
  const result = classifyEventNotFound();
  assert.equal(result.category, "BET_TRANSIENT");
  assert.equal(result.retryCode, "EVENT_NOT_FOUND");
  assert.equal(result.maxRetriesReason, SettlementReviewReason.EVENT_NOT_FOUND_MAX_RETRIES);
});

/* -------------------------------------------------------------------------- */
/* Bet-level: evaluator outcomes (SINGLE)                                    */
/* -------------------------------------------------------------------------- */

function evaluation(overrides: Partial<SelectionOutcomeEvaluation> = {}): SelectionOutcomeEvaluation {
  return { kind: "WIN", reasonCode: "WIN_HOME_PARTICIPANT", ...overrides } as SelectionOutcomeEvaluation;
}

test("WIN/LOSS/VOID classify as TERMINAL_OUTCOME", () => {
  assert.equal(classifyEvaluatorOutcome(evaluation({ kind: "WIN", reasonCode: "WIN_HOME_PARTICIPANT" })).category, "TERMINAL_OUTCOME");
  assert.equal(classifyEvaluatorOutcome(evaluation({ kind: "LOSS", reasonCode: "LOSS_AWAY_PARTICIPANT" })).category, "TERMINAL_OUTCOME");
  assert.equal(classifyEvaluatorOutcome(evaluation({ kind: "VOID", reasonCode: "VOID_CANCELLED" })).category, "TERMINAL_OUTCOME");
});

test("WAITING reasons (EVENT_NOT_COMPLETED/EVENT_POSTPONED/EVENT_ABANDONED) classify as WAITING and never increment a retry counter", () => {
  for (const reasonCode of ["EVENT_NOT_COMPLETED", "EVENT_POSTPONED", "EVENT_ABANDONED"] as const) {
    const result = classifyEvaluatorOutcome(evaluation({ kind: "WAITING", reasonCode }));
    assert.equal(result.category, "WAITING", `reasonCode ${reasonCode} must classify as WAITING`);
    assert.notEqual(result.category, "BET_TRANSIENT");
  }
});

test("every UnsupportedReasonCode classifies as BET_PERMANENT_REVIEW with the matching SettlementReviewReason", () => {
  const cases: Array<[string, SettlementReviewReason]> = [
    ["UNSUPPORTED_MARKET", SettlementReviewReason.UNSUPPORTED_MARKET],
    ["UNSUPPORTED_SELECTION", SettlementReviewReason.UNSUPPORTED_SELECTION],
    ["UNSUPPORTED_PERIOD", SettlementReviewReason.UNSUPPORTED_PERIOD],
  ];
  for (const [reasonCode, expected] of cases) {
    const result = classifyEvaluatorOutcome(evaluation({ kind: "UNSUPPORTED", reasonCode: reasonCode as never }));
    assert.equal(result.category, "BET_PERMANENT_REVIEW");
    assert.equal((result as { reason: SettlementReviewReason }).reason, expected);
  }
});

test("MISSING_SCORE is bet-level transient, not permanent review", () => {
  const result = classifyEvaluatorOutcome(evaluation({ kind: "INVALID_DATA", reasonCode: "MISSING_SCORE" }));
  assert.equal(result.category, "BET_TRANSIENT");
  assert.equal((result as { retryCode: string }).retryCode, "MISSING_SCORE");
  assert.equal((result as { maxRetriesReason: SettlementReviewReason }).maxRetriesReason, SettlementReviewReason.MISSING_SCORE_MAX_RETRIES);
});

test("PARTICIPANT_MISMATCH is immediate BET_PERMANENT_REVIEW, zero retries spent", () => {
  const result = classifyEvaluatorOutcome(evaluation({ kind: "INVALID_DATA", reasonCode: "PARTICIPANT_MISMATCH" }));
  assert.deepEqual(result, { category: "BET_PERMANENT_REVIEW", reason: SettlementReviewReason.PARTICIPANT_MISMATCH });
});

test("every other InvalidDataReasonCode (besides MISSING_SCORE) classifies as immediate BET_PERMANENT_REVIEW", () => {
  const cases: Array<[string, SettlementReviewReason]> = [
    ["INVALID_SCORE", SettlementReviewReason.INVALID_SCORE],
    ["PARTICIPANT_MISMATCH", SettlementReviewReason.PARTICIPANT_MISMATCH],
    ["INVALID_EVENT_RESULT", SettlementReviewReason.INVALID_EVENT_RESULT],
    ["MISSING_PARTICIPANT_NAME", SettlementReviewReason.MISSING_PARTICIPANT_NAME],
    ["AMBIGUOUS_PARTICIPANT_MATCH", SettlementReviewReason.AMBIGUOUS_PARTICIPANT_MATCH],
  ];
  for (const [reasonCode, expected] of cases) {
    const result = classifyEvaluatorOutcome(evaluation({ kind: "INVALID_DATA", reasonCode: reasonCode as never }));
    assert.deepEqual(result, { category: "BET_PERMANENT_REVIEW", reason: expected });
  }
});

test("classifyInvalidDataReasonCode: aggregateExpressOutcome's synthetic INVALID_SELECTION_ODDS falls back to INVALID_EXPRESS_DATA", () => {
  const result = classifyInvalidDataReasonCode("INVALID_SELECTION_ODDS");
  assert.deepEqual(result, { category: "BET_PERMANENT_REVIEW", reason: SettlementReviewReason.INVALID_EXPRESS_DATA });
});

test("classifyInvalidDataReasonCode: a genuinely unrecognized code still degrades to BET_PERMANENT_REVIEW, never thrown/dropped", () => {
  const result = classifyInvalidDataReasonCode("SOME_FUTURE_UNKNOWN_CODE");
  assert.equal(result.category, "BET_PERMANENT_REVIEW");
});

test("classifyUnsupportedReasonCode: a genuinely unrecognized code still degrades to BET_PERMANENT_REVIEW, never thrown/dropped", () => {
  const result = classifyUnsupportedReasonCode("SOME_FUTURE_UNKNOWN_CODE");
  assert.equal(result.category, "BET_PERMANENT_REVIEW");
});

/* -------------------------------------------------------------------------- */
/* classifyNoActionReasonCode — SINGLE's flattened NO_ACTION.reasonCode       */
/* -------------------------------------------------------------------------- */

test("classifyNoActionReasonCode re-derives WAITING from a flattened reasonCode", () => {
  for (const reasonCode of ["EVENT_NOT_COMPLETED", "EVENT_POSTPONED", "EVENT_ABANDONED"]) {
    assert.deepEqual(classifyNoActionReasonCode(reasonCode), { category: "WAITING" });
  }
});

test("classifyNoActionReasonCode re-derives UNSUPPORTED from a flattened reasonCode", () => {
  assert.deepEqual(classifyNoActionReasonCode("UNSUPPORTED_SELECTION"), {
    category: "BET_PERMANENT_REVIEW",
    reason: SettlementReviewReason.UNSUPPORTED_SELECTION,
  });
});

test("classifyNoActionReasonCode re-derives MISSING_SCORE as transient", () => {
  assert.deepEqual(classifyNoActionReasonCode("MISSING_SCORE"), {
    category: "BET_TRANSIENT",
    retryCode: "MISSING_SCORE",
    maxRetriesReason: SettlementReviewReason.MISSING_SCORE_MAX_RETRIES,
  });
});

test("classifyNoActionReasonCode re-derives PARTICIPANT_MISMATCH as immediate review", () => {
  assert.deepEqual(classifyNoActionReasonCode("PARTICIPANT_MISMATCH"), {
    category: "BET_PERMANENT_REVIEW",
    reason: SettlementReviewReason.PARTICIPANT_MISMATCH,
  });
});

/* -------------------------------------------------------------------------- */
/* classifyExpressNoActionAggregate — EXPRESS multi-leg fold                  */
/* -------------------------------------------------------------------------- */

function waitingAggregate(): Extract<AggregateExpressOutcome, { kind: "WAITING" }> {
  return { kind: "WAITING", waitingSelectionIds: ["s1"], missingProviderEventIds: ["e1"] };
}

function unsupportedAggregate(reasonCodes: Record<string, string>): Extract<AggregateExpressOutcome, { kind: "UNSUPPORTED" }> {
  return { kind: "UNSUPPORTED", affectedSelectionIds: Object.keys(reasonCodes), reasonCodes };
}

function invalidDataAggregate(reasonCodes: Record<string, string>): Extract<AggregateExpressOutcome, { kind: "INVALID_DATA" }> {
  return { kind: "INVALID_DATA", affectedSelectionIds: Object.keys(reasonCodes), reasonCodes };
}

test("EXPRESS WAITING aggregate always classifies as WAITING, never BET_TRANSIENT", () => {
  const result = classifyExpressNoActionAggregate(waitingAggregate());
  assert.deepEqual(result, { category: "WAITING" });
});

test("EXPRESS INVALID_DATA aggregate: every affected leg is MISSING_SCORE -> BET_TRANSIENT", () => {
  const result = classifyExpressNoActionAggregate(invalidDataAggregate({ s1: "MISSING_SCORE", s2: "MISSING_SCORE" }));
  assert.deepEqual(result, { category: "BET_TRANSIENT", retryCode: "MISSING_SCORE", maxRetriesReason: SettlementReviewReason.MISSING_SCORE_MAX_RETRIES });
});

test("EXPRESS INVALID_DATA aggregate: one permanent leg among a MISSING_SCORE leg -> immediate BET_PERMANENT_REVIEW", () => {
  const result = classifyExpressNoActionAggregate(invalidDataAggregate({ s1: "MISSING_SCORE", s2: "PARTICIPANT_MISMATCH" }));
  assert.deepEqual(result, { category: "BET_PERMANENT_REVIEW", reason: SettlementReviewReason.PARTICIPANT_MISMATCH });
});

test("EXPRESS UNSUPPORTED aggregate always classifies as immediate BET_PERMANENT_REVIEW", () => {
  const result = classifyExpressNoActionAggregate(unsupportedAggregate({ s1: "UNSUPPORTED_MARKET" }));
  assert.deepEqual(result, { category: "BET_PERMANENT_REVIEW", reason: SettlementReviewReason.UNSUPPORTED_MARKET });
});

/* -------------------------------------------------------------------------- */
/* Bet-level: structural REJECTED reasonCode (SINGLE + EXPRESS)               */
/* -------------------------------------------------------------------------- */

test("UNSUPPORTED_BET_STATUS classifies as CONFLICT_NO_ACTION — not a retry, not a review", () => {
  const result = classifyRejectionReasonCode("UNSUPPORTED_BET_STATUS");
  assert.deepEqual(result, { category: "CONFLICT_NO_ACTION" });
});

test("NOT_SINGLE and NOT_EXPRESS both map to the single INVALID_BET_TYPE reason (no duplicate enum values)", () => {
  const single = classifyRejectionReasonCode("NOT_SINGLE" satisfies AutoSettlementRejectionReasonCode);
  const express = classifyRejectionReasonCode("NOT_EXPRESS" satisfies AutoSettlementExpressRejectionReasonCode);
  assert.deepEqual(single, { category: "BET_PERMANENT_REVIEW", reason: SettlementReviewReason.INVALID_BET_TYPE });
  assert.deepEqual(express, { category: "BET_PERMANENT_REVIEW", reason: SettlementReviewReason.INVALID_BET_TYPE });
});

test("every SINGLE REJECTED reasonCode classifies correctly", () => {
  const cases: Array<[AutoSettlementRejectionReasonCode, ReturnType<typeof classifyRejectionReasonCode>]> = [
    ["NOT_SINGLE", { category: "BET_PERMANENT_REVIEW", reason: SettlementReviewReason.INVALID_BET_TYPE }],
    ["UNSUPPORTED_BET_STATUS", { category: "CONFLICT_NO_ACTION" }],
    ["MISSING_PROVIDER_REFERENCE", { category: "BET_PERMANENT_REVIEW", reason: SettlementReviewReason.MISSING_PROVIDER_REFERENCE }],
    ["PROVIDER_EVENT_MISMATCH", { category: "BET_PERMANENT_REVIEW", reason: SettlementReviewReason.PROVIDER_EVENT_MISMATCH }],
    ["MISSING_CANONICAL_METADATA", { category: "BET_PERMANENT_REVIEW", reason: SettlementReviewReason.MISSING_CANONICAL_METADATA }],
  ];
  for (const [reasonCode, expected] of cases) {
    assert.deepEqual(classifyRejectionReasonCode(reasonCode), expected, `reasonCode ${reasonCode}`);
  }
});

test("every EXPRESS-only REJECTED reasonCode classifies correctly", () => {
  const cases: Array<[AutoSettlementExpressRejectionReasonCode, ReturnType<typeof classifyRejectionReasonCode>]> = [
    ["NOT_EXPRESS", { category: "BET_PERMANENT_REVIEW", reason: SettlementReviewReason.INVALID_BET_TYPE }],
    ["EMPTY_SELECTIONS", { category: "BET_PERMANENT_REVIEW", reason: SettlementReviewReason.EMPTY_SELECTIONS }],
    ["DUPLICATE_PROVIDER_EVENT_RESULT", { category: "BET_PERMANENT_REVIEW", reason: SettlementReviewReason.DUPLICATE_PROVIDER_EVENT_RESULT }],
  ];
  for (const [reasonCode, expected] of cases) {
    assert.deepEqual(classifyRejectionReasonCode(reasonCode), expected, `reasonCode ${reasonCode}`);
  }
});

/* -------------------------------------------------------------------------- */
/* Bet-level: settleBet() FAILED reasonCode                                   */
/* -------------------------------------------------------------------------- */

test("MISSING_SETTLEMENT_ODDS is immediate BET_PERMANENT_REVIEW", () => {
  assert.deepEqual(classifySettleFailureCode("MISSING_SETTLEMENT_ODDS"), {
    category: "BET_PERMANENT_REVIEW",
    reason: SettlementReviewReason.MISSING_SETTLEMENT_ODDS,
  });
});

test("INVALID_EFFECTIVE_SETTLEMENT_ODDS is immediate BET_PERMANENT_REVIEW", () => {
  assert.deepEqual(classifySettleFailureCode("INVALID_EFFECTIVE_SETTLEMENT_ODDS"), {
    category: "BET_PERMANENT_REVIEW",
    reason: SettlementReviewReason.INVALID_SETTLEMENT_ODDS,
  });
});

test("UNEXPECTED_ERROR (non-P2025 DB error) is bet-level transient, not cycle-level", () => {
  const result = classifySettleFailureCode("UNEXPECTED_ERROR");
  assert.deepEqual(result, { category: "BET_TRANSIENT", retryCode: "DB_ERROR", maxRetriesReason: SettlementReviewReason.DB_ERROR_MAX_RETRIES });
});

test("an unrecognized settle failure code still degrades to BET_TRANSIENT/DB_ERROR, never thrown", () => {
  const result = classifySettleFailureCode("SOME_FUTURE_UNKNOWN_CODE");
  assert.equal(result.category, "BET_TRANSIENT");
});

/* -------------------------------------------------------------------------- */
/* CONFLICT / P2025 — not retry, not review                                   */
/* -------------------------------------------------------------------------- */

test("CONFLICT (settleBet()'s own resolved P2025 race) is not a retry and not a review", () => {
  const result = classifyConflict();
  assert.deepEqual(result, { category: "CONFLICT_NO_ACTION" });
  assert.notEqual(result.category, "BET_TRANSIENT");
  assert.notEqual(result.category, "BET_PERMANENT_REVIEW");
});
