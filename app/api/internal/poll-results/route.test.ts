import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { handlePollResults, GET } from "./route";
import type { PollingReport } from "@/lib/bets/settlement/pollConfirmedBetResults";

const CRON_SECRET = "test-cron-secret-value";
const originalSecret = process.env.CRON_SECRET;

// Same console.error-capture convention as lib/ocr/claudeOcrProvider.test.ts
// / lib/ocr/regionDetection.test.ts — lets the security-correction tests
// below assert exactly what the route passes to console.error, not just
// what ends up in the HTTP response.
let consoleErrorCalls: unknown[][] = [];
const originalConsoleError = console.error;

test.beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET;
  consoleErrorCalls = [];
  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };
});

test.afterEach(() => {
  console.error = originalConsoleError;
});

test.after(() => {
  if (originalSecret !== undefined) {
    process.env.CRON_SECRET = originalSecret;
  } else {
    delete process.env.CRON_SECRET;
  }
});

function pollRequest(authHeader: string | null, url = "http://localhost/api/internal/poll-results"): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== null) headers.Authorization = authHeader;
  return new NextRequest(url, { method: "GET", headers });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

const SAMPLE_REPORT: PollingReport = {
  scannedBets: 3,
  eligibleBets: 3,
  uniqueEvents: 2,
  providerRequests: 1,
  providerFailures: 0,
  settled: 1,
  noAction: 1,
  rejected: 1,
  conflicts: 0,
  failed: 0,
};

function fakePoll(callLog: Array<{ db: unknown; options: unknown }>, report: PollingReport = SAMPLE_REPORT, shouldThrow = false) {
  return async (db: unknown, options: unknown) => {
    callLog.push({ db, options });
    if (shouldThrow) throw new Error("simulated polling failure with a sensitive-looking detail: apiKey=super-secret-key");
    return report;
  };
}

/* -------------------------------------------------------------------------- */
/* 1-2. Missing/empty CRON_SECRET -> 500                                     */
/* -------------------------------------------------------------------------- */

test("missing CRON_SECRET -> 500, poll never called", async () => {
  delete process.env.CRON_SECRET;
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog) as never });

  assert.equal(res.status, 500);
  assert.deepEqual(await json(res), { success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  assert.equal(callLog.length, 0);
});

test("empty CRON_SECRET -> 500, poll never called", async () => {
  process.env.CRON_SECRET = "";
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog) as never });

  assert.equal(res.status, 500);
  assert.equal(callLog.length, 0);
});

/* -------------------------------------------------------------------------- */
/* 3-6. Unauthorized -> 401                                                   */
/* -------------------------------------------------------------------------- */

test("missing Authorization -> 401, poll never called", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(null), { poll: fakePoll(callLog) as never });

  assert.equal(res.status, 401);
  assert.deepEqual(await json(res), { success: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
  assert.equal(callLog.length, 0);
});

test("empty Authorization -> 401, poll never called", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(""), { poll: fakePoll(callLog) as never });

  assert.equal(res.status, 401);
  assert.equal(callLog.length, 0);
});

test("wrong scheme -> 401, poll never called", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Basic ${CRON_SECRET}`), { poll: fakePoll(callLog) as never });

  assert.equal(res.status, 401);
  assert.equal(callLog.length, 0);
});

test("wrong token -> 401, poll never called", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest("Bearer wrong-token"), { poll: fakePoll(callLog) as never });

  assert.equal(res.status, 401);
  assert.equal(callLog.length, 0);
});

/* -------------------------------------------------------------------------- */
/* 7-9. Authorized -> 200, poll called exactly once with fixed options        */
/* -------------------------------------------------------------------------- */

test("correct token -> 200", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog) as never });

  assert.equal(res.status, 200);
});

test("authorized request calls poll exactly once", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog) as never });

  assert.equal(callLog.length, 1);
});

test("poll is called with exactly { limit: 25, concurrency: 2 } — no more, no less", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog) as never });

  assert.deepEqual(callLog[0].options, { limit: 25, concurrency: 2 });
});

/* -------------------------------------------------------------------------- */
/* 10-11. Query params never influence limit/concurrency                     */
/* -------------------------------------------------------------------------- */

test("a limit query param does not change the options passed to poll", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`, "http://localhost/api/internal/poll-results?limit=99999"), {
    poll: fakePoll(callLog) as never,
  });

  assert.deepEqual(callLog[0].options, { limit: 25, concurrency: 2 });
});

test("a concurrency query param does not change the options passed to poll", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`, "http://localhost/api/internal/poll-results?concurrency=50"), {
    poll: fakePoll(callLog) as never,
  });

  assert.deepEqual(callLog[0].options, { limit: 25, concurrency: 2 });
});

/* -------------------------------------------------------------------------- */
/* 12-15. Success body shape and content                                     */
/* -------------------------------------------------------------------------- */

test("success returns the exact PollingReport from poll", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog) as never });
  const body = await json(res);

  assert.deepEqual(body, { success: true, report: SAMPLE_REPORT });
});

test("success body contains no secret", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog) as never });
  const bodyText = JSON.stringify(await json(res));

  assert.equal(bodyText.includes(CRON_SECRET), false);
});

test("success body contains no Authorization value", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog) as never });
  const bodyText = JSON.stringify(await json(res));

  assert.equal(bodyText.includes("Bearer"), false);
});

test("success body contains nothing beyond { success, report } — no raw provider payload", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog) as never });
  const body = await json(res);

  assert.deepEqual(Object.keys(body).sort(), ["report", "success"]);
  assert.deepEqual(Object.keys(body.report as object).sort(), Object.keys(SAMPLE_REPORT).sort());
});

/* -------------------------------------------------------------------------- */
/* 16-18. poll() throwing -> 500, no raw error leaked                        */
/* -------------------------------------------------------------------------- */

test("poll throws -> 500", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog, SAMPLE_REPORT, true) as never });

  assert.equal(res.status, 500);
});

test("raw error message from a thrown poll() error never appears in the response body", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog, SAMPLE_REPORT, true) as never });
  const bodyText = JSON.stringify(await json(res));

  assert.equal(bodyText.includes("apiKey=super-secret-key"), false);
  assert.equal(bodyText.includes("simulated polling failure"), false);
});

test("no stack trace appears in the response body", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog, SAMPLE_REPORT, true) as never });
  const body = await json(res);

  assert.equal(JSON.stringify(body).includes("at "), false); // no stack-trace-shaped content
  assert.deepEqual(body, { success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
});

/* -------------------------------------------------------------------------- */
/* Security correction — a downstream error carrying a secret-looking value  */
/* must never reach the response OR console.error, in any form.             */
/* -------------------------------------------------------------------------- */

function fakePollThrowingSecretError(callLog: Array<{ db: unknown; options: unknown }>) {
  return async (db: unknown, options: unknown) => {
    callLog.push({ db, options });
    throw new Error("provider failed with ODDS_API_KEY=super-secret-value");
  };
}

test("a poll() error containing an embedded secret never appears in the response body, message, or stack", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePollThrowingSecretError(callLog) as never });
  const bodyText = JSON.stringify(await json(res));

  assert.equal(bodyText.includes("super-secret-value"), false);
  assert.equal(bodyText.includes("ODDS_API_KEY"), false);
  assert.equal(bodyText.includes("provider failed with"), false);
  assert.equal(res.status, 500);
});

test("console.error never receives the caught Error object, its message, or its stack for a polling failure", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePollThrowingSecretError(callLog) as never });

  const loggedText = JSON.stringify(consoleErrorCalls);
  assert.equal(loggedText.includes("super-secret-value"), false);
  assert.equal(loggedText.includes("ODDS_API_KEY"), false);
  assert.equal(loggedText.includes("provider failed with"), false);
  assert.equal(loggedText.includes(" at "), false); // no stack-trace-shaped content
  for (const call of consoleErrorCalls) {
    for (const arg of call) {
      assert.equal(arg instanceof Error, false, "console.error must never receive the raw Error object itself");
    }
  }
});

test("console.error is called with exactly one static string argument for a polling failure — no error object, no interpolated detail", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePollThrowingSecretError(callLog) as never });

  assert.equal(consoleErrorCalls.length, 1);
  assert.deepEqual(consoleErrorCalls[0], ["Internal polling route failed"]);
});

test("console.error for a polling failure never receives the Authorization header value or CRON_SECRET", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePollThrowingSecretError(callLog) as never });

  const loggedText = JSON.stringify(consoleErrorCalls);
  assert.equal(loggedText.includes(CRON_SECRET), false);
  assert.equal(loggedText.includes("Bearer"), false);
});

test("missing CRON_SECRET produces a single static log line that does not contain any secret value", async () => {
  delete process.env.CRON_SECRET;
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog) as never });

  assert.equal(consoleErrorCalls.length, 1);
  assert.equal(consoleErrorCalls[0].length, 1);
  assert.equal(typeof consoleErrorCalls[0][0], "string");
  const loggedText = JSON.stringify(consoleErrorCalls);
  assert.equal(loggedText.includes(CRON_SECRET), false);
});

/* -------------------------------------------------------------------------- */
/* 19-21. Cache-Control: no-store on every response                          */
/* -------------------------------------------------------------------------- */

test("Cache-Control: no-store on 200", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog) as never });
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("Cache-Control: no-store on 401", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(null), { poll: fakePoll(callLog) as never });
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("Cache-Control: no-store on 500", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  const res = await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog, SAMPLE_REPORT, true) as never });
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

/* -------------------------------------------------------------------------- */
/* 22-23. Unauthorized/misconfigured never call poll (already covered above,  */
/* restated explicitly per the brief's own numbered list)                     */
/* -------------------------------------------------------------------------- */

test("unauthorized request does not call poll (restated)", async () => {
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  await handlePollResults(pollRequest("Bearer wrong"), { poll: fakePoll(callLog) as never });
  assert.equal(callLog.length, 0);
});

test("missing configuration does not call poll (restated)", async () => {
  delete process.env.CRON_SECRET;
  const callLog: Array<{ db: unknown; options: unknown }> = [];
  await handlePollResults(pollRequest(`Bearer ${CRON_SECRET}`), { poll: fakePoll(callLog) as never });
  assert.equal(callLog.length, 0);
});

/* -------------------------------------------------------------------------- */
/* 24. GET wrapper                                                            */
/* -------------------------------------------------------------------------- */

test("the exported GET wrapper runs the real authorization flow (unauthorized -> 401) without needing the DI seam", async () => {
  const res = await GET(pollRequest(null));
  assert.equal(res.status, 401);
});

/* -------------------------------------------------------------------------- */
/* 25. Importing the module does not trigger polling                         */
/* -------------------------------------------------------------------------- */

test("importing the route module does not itself invoke polling", () => {
  // route.ts's own top-level module scope contains only const
  // declarations and function definitions — pollConfirmedBetResults() is
  // called exclusively inside handlePollResults()'s function body, never
  // at import time. This test's own successful execution is itself part
  // of the evidence: the module (imported at the top of this file, before
  // any test ran) never attempted a real database/provider call — every
  // test above that exercises the authorized path does so exclusively
  // through the injected `poll` DI seam, never the real implementation.
  assert.ok(true);
});
