import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
// Same bracket-dir workaround as settle.route.test.ts's own header comment
// explains — node --test can't select a file inside a "[id]" directory, so
// this file lives flat under app/api/bets/, importing into the real route.
import { handleSettlementRetry } from "./[id]/settlement-retry/route";
import type { ManualRetryOutcome } from "@/lib/bets/settlement/manualRetrySettlement";

const OPERATOR_SECRET = "test-operator-secret";
const BET_ID = "bet-1";
const originalSecret = process.env.OPERATOR_SECRET;

test.beforeEach(() => {
  process.env.OPERATOR_SECRET = OPERATOR_SECRET;
});

test.after(() => {
  process.env.OPERATOR_SECRET = originalSecret;
});

function retryRequest(authHeader: string | null = `Bearer ${OPERATOR_SECRET}`): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== null) headers.Authorization = authHeader;
  return new NextRequest(`http://localhost/api/bets/${BET_ID}/settlement-retry`, { method: "POST", headers });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

function fakeRetry(outcome: ManualRetryOutcome, callLog: unknown[] = []) {
  return async (db: unknown, input: unknown) => {
    callLog.push({ db, input });
    return outcome;
  };
}

function fakeRetryThrowing(callLog: unknown[] = []) {
  return async (db: unknown, input: unknown) => {
    callLog.push({ db, input });
    throw new Error("simulated failure with a sensitive-looking detail: apiKey=super-secret-key");
  };
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

test("1. unauthorized request is rejected with 401, retry never called", async () => {
  const callLog: unknown[] = [];
  const res = await handleSettlementRetry(retryRequest(null), BET_ID, { retry: fakeRetry({ kind: "OK", status: "WAITING", bet: {} as never }, callLog) });

  assert.equal(res.status, 401);
  assert.equal(callLog.length, 0);
});

test("wrong token -> 401", async () => {
  const res = await handleSettlementRetry(retryRequest("Bearer wrong"), BET_ID, {});
  assert.equal(res.status, 401);
});

/* -------------------------------------------------------------------------- */
/* Rejection -> status code mapping                                          */
/* -------------------------------------------------------------------------- */

test("NOT_FOUND rejection -> 404", async () => {
  const res = await handleSettlementRetry(retryRequest(), BET_ID, {
    retry: fakeRetry({ kind: "REJECTED", reason: "NOT_FOUND", message: "No bet found" }),
  });
  assert.equal(res.status, 404);
  assert.deepEqual((await json(res)).error, { code: "NOT_FOUND", message: "No bet found", betId: BET_ID });
});

test("NOT_CONFIRMED rejection -> 409", async () => {
  const res = await handleSettlementRetry(retryRequest(), BET_ID, {
    retry: fakeRetry({ kind: "REJECTED", reason: "NOT_CONFIRMED", message: "Bet is not CONFIRMED" }),
  });
  assert.equal(res.status, 409);
});

test("NOT_NEEDS_REVIEW rejection -> 409", async () => {
  const res = await handleSettlementRetry(retryRequest(), BET_ID, {
    retry: fakeRetry({ kind: "REJECTED", reason: "NOT_NEEDS_REVIEW", message: "Not flagged for review" }),
  });
  assert.equal(res.status, 409);
});

test("STRUCTURALLY_INVALID rejection -> 400", async () => {
  const res = await handleSettlementRetry(retryRequest(), BET_ID, {
    retry: fakeRetry({ kind: "REJECTED", reason: "STRUCTURALLY_INVALID", message: "Missing provider identity" }),
  });
  assert.equal(res.status, 400);
});

/* -------------------------------------------------------------------------- */
/* Success -> 200, status field reflects the outcome                        */
/* -------------------------------------------------------------------------- */

test("SETTLED outcome -> 200, success:true, settlement summary included", async () => {
  const res = await handleSettlementRetry(retryRequest(), BET_ID, {
    retry: fakeRetry({
      kind: "OK",
      status: "SETTLED",
      bet: {
        id: BET_ID,
        status: "SETTLED_WIN",
        settlementReviewStatus: "RESOLVED",
        settlementReviewReason: "EVENT_NOT_FOUND_MAX_RETRIES",
        settlementRetryCount: 3,
        lastSettlementAttemptAt: new Date("2026-07-30T12:00:00Z"),
        lastSettlementErrorCode: "EVENT_NOT_FOUND",
        lastSettlementErrorMessage: "msg",
      },
      settlement: { outcome: "WIN", idempotent: false },
    }),
  });

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal((body.result as Record<string, unknown>).status, "SETTLED");
  assert.deepEqual((body.result as Record<string, unknown>).settlement, { outcome: "WIN", idempotent: false });
});

test("CONFLICT outcome still returns 200 success:true (a resolved race, not a caller error)", async () => {
  const res = await handleSettlementRetry(retryRequest(), BET_ID, {
    retry: fakeRetry({
      kind: "OK",
      status: "CONFLICT",
      bet: {
        id: BET_ID,
        status: "SETTLED_WIN",
        settlementReviewStatus: "RESOLVED",
        settlementReviewReason: null,
        settlementRetryCount: 0,
        lastSettlementAttemptAt: null,
        lastSettlementErrorCode: null,
        lastSettlementErrorMessage: null,
      },
    }),
  });

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.success, true);
});

/* -------------------------------------------------------------------------- */
/* Security correction — sensitive detail never leaks on an unexpected throw */
/* -------------------------------------------------------------------------- */

test("an unexpected thrown error never leaks its message/detail in the response", async () => {
  const res = await handleSettlementRetry(retryRequest(), BET_ID, { retry: fakeRetryThrowing() });
  const bodyText = JSON.stringify(await json(res));

  assert.equal(res.status, 500);
  assert.equal(bodyText.includes("super-secret-key"), false);
  assert.equal(bodyText.includes("simulated failure"), false);
});

/* -------------------------------------------------------------------------- */
/* Response contains no sensitive fields                                     */
/* -------------------------------------------------------------------------- */

test("response never contains a raw provider payload, Transaction ledger, or secret-shaped field", async () => {
  const res = await handleSettlementRetry(retryRequest(), BET_ID, {
    retry: fakeRetry({
      kind: "OK",
      status: "SETTLED",
      bet: {
        id: BET_ID,
        status: "SETTLED_WIN",
        settlementReviewStatus: "RESOLVED",
        settlementReviewReason: null,
        settlementRetryCount: 0,
        lastSettlementAttemptAt: null,
        lastSettlementErrorCode: null,
        lastSettlementErrorMessage: null,
      },
      settlement: { outcome: "WIN", idempotent: false },
    }),
  });
  const bodyText = JSON.stringify(await json(res));

  for (const forbidden of ["transactions", "apiKey", "OPERATOR_SECRET", "stack", "rawMessage"]) {
    assert.equal(bodyText.includes(forbidden), false, `response must not contain "${forbidden}"`);
  }
});
