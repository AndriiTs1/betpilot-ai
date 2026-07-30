import { test } from "node:test";
import assert from "node:assert/strict";
import { SettlementReviewReason } from "@/lib/generated/prisma/client";
import { SETTLEMENT_REVIEW_REASON_LABELS, getSettlementReviewReasonLabel } from "./settlementReviewReasonLabels";

test("every SettlementReviewReason enum value has a human-readable label, never the raw enum key itself", () => {
  for (const reason of Object.values(SettlementReviewReason)) {
    const label = SETTLEMENT_REVIEW_REASON_LABELS[reason];
    assert.ok(label, `missing label for ${reason}`);
    assert.notEqual(label, reason, `label for ${reason} must not be the raw enum key`);
    assert.equal(label.includes("_"), false, `label for ${reason} looks like a raw enum, not human text: "${label}"`);
  }
});

test("getSettlementReviewReasonLabel resolves a known reason", () => {
  assert.equal(getSettlementReviewReasonLabel("PARTICIPANT_MISMATCH"), "Participant could not be matched");
});

test("getSettlementReviewReasonLabel falls back to an em dash for null", () => {
  assert.equal(getSettlementReviewReasonLabel(null), "—");
});

test("getSettlementReviewReasonLabel degrades to the raw string for an unrecognized value, never throws", () => {
  assert.equal(getSettlementReviewReasonLabel("SOME_FUTURE_UNKNOWN_REASON"), "SOME_FUTURE_UNKNOWN_REASON");
});
