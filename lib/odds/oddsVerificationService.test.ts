import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OddsVerificationService,
  OddsVerificationServiceError,
  summarizeVerificationResults,
} from "./oddsVerificationService";
import { createVerifiedResult, createOddsChangedResult, createFailedResult, createNotCheckedResult } from "./verification";
import type { VerificationResult } from "./verification";
import type { CanonicalEvent, CanonicalSelection } from "./domain";
import type { OddsProvider, ProviderHealthResult, VerifySelectionRequest } from "./oddsProvider";

const CHECKED_AT = "2026-07-24T00:00:00.000Z";

const FOOTBALL_EVENT: CanonicalEvent = {
  sport: "FOOTBALL",
  name: "Manchester United vs Chelsea",
  participants: [{ name: "Manchester United" }, { name: "Chelsea" }],
  period: "FULL_GAME",
  homeParticipantIndex: 0,
  awayParticipantIndex: 1,
};

function moneylineSelection(overrides: Partial<CanonicalSelection> = {}): CanonicalSelection {
  return {
    sport: "FOOTBALL",
    event: FOOTBALL_EVENT,
    marketType: "MONEYLINE_3WAY",
    period: "FULL_GAME",
    selectionType: "HOME",
    submittedOdds: "2.15",
    ...overrides,
  };
}

function request(overrides: Partial<VerifySelectionRequest> = {}): VerifySelectionRequest {
  return { selection: moneylineSelection(), ...overrides };
}

/* -------------------------------------------------------------------------- */
/* Fake OddsProvider                                                          */
/* -------------------------------------------------------------------------- */

type VerifySelectionImpl = (request: VerifySelectionRequest) => Promise<VerificationResult>;

function fakeProvider(verifySelection: VerifySelectionImpl): OddsProvider {
  return {
    name: "THE_ODDS_API",
    getCapabilities: () => ({
      provider: "THE_ODDS_API",
      supportedSports: [],
      supportedMarketTypes: [],
      leagueSelectionSupported: false,
      livePrematchSupport: "PREMATCH_ONLY",
      eventSearchSupported: false,
      eventByIdLookupSupported: false,
      regions: [],
      notes: [],
    }),
    findEvents: async () => ({ ok: true, value: [] }),
    getEventMarkets: async () => ({ ok: true, value: [] }),
    verifySelection,
    healthCheck: async (): Promise<ProviderHealthResult> => ({
      healthy: true,
      provider: "THE_ODDS_API",
      checkedAt: CHECKED_AT,
    }),
  };
}

function callCountingProvider(impl: VerifySelectionImpl) {
  const calls: VerifySelectionRequest[] = [];
  const provider = fakeProvider(async (req) => {
    calls.push(req);
    return impl(req);
  });
  return { provider, calls };
}

// Deterministic in-flight tracker — relies only on JS's guaranteed
// synchronous run-to-first-await semantics (every worker started by
// runWithConcurrency's Promise.all(Array.from(...)) runs synchronously up
// to its first await), never on wall-clock timing. `maxInFlight` records
// the true historical peak once all calls have settled.
function trackingProvider(resultFor: (callIndex: number) => VerificationResult) {
  let inFlight = 0;
  let maxInFlight = 0;
  let callIndex = 0;
  const calls: VerifySelectionRequest[] = [];

  const provider = fakeProvider(async (req) => {
    const index = callIndex++;
    calls.push(req);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    await Promise.resolve();
    inFlight -= 1;
    return resultFor(index);
  });

  return {
    provider,
    calls,
    getMaxInFlight: () => maxInFlight,
    resetMaxInFlight: () => {
      maxInFlight = 0;
    },
  };
}

function verified(submittedOdds = "2.15", currentOdds = "2.10"): VerificationResult {
  return createVerifiedResult({ submittedOdds, currentOdds, provider: "THE_ODDS_API", checkedAt: CHECKED_AT });
}

/* -------------------------------------------------------------------------- */
/* Group A — constructor and configuration                                    */
/* -------------------------------------------------------------------------- */

test("constructor: default concurrency is applied (service behaves correctly with no options)", () => {
  const provider = fakeProvider(async () => verified());
  assert.doesNotThrow(() => new OddsVerificationService(provider));
});

test("constructor: concurrency 1 is accepted", () => {
  const provider = fakeProvider(async () => verified());
  assert.doesNotThrow(() => new OddsVerificationService(provider, { concurrency: 1 }));
});

test("constructor: concurrency above 1 is accepted", () => {
  const provider = fakeProvider(async () => verified());
  assert.doesNotThrow(() => new OddsVerificationService(provider, { concurrency: 10 }));
});

test("constructor: concurrency 0 is rejected", () => {
  const provider = fakeProvider(async () => verified());
  assert.throws(
    () => new OddsVerificationService(provider, { concurrency: 0 }),
    (err: unknown) => err instanceof OddsVerificationServiceError && err.code === "INVALID_CONCURRENCY",
  );
});

test("constructor: negative concurrency is rejected", () => {
  const provider = fakeProvider(async () => verified());
  assert.throws(
    () => new OddsVerificationService(provider, { concurrency: -1 }),
    (err: unknown) => err instanceof OddsVerificationServiceError && err.code === "INVALID_CONCURRENCY",
  );
});

test("constructor: non-integer concurrency is rejected", () => {
  const provider = fakeProvider(async () => verified());
  assert.throws(
    () => new OddsVerificationService(provider, { concurrency: 2.5 }),
    (err: unknown) => err instanceof OddsVerificationServiceError && err.code === "INVALID_CONCURRENCY",
  );
});

test("constructor: unsafe integer concurrency is rejected", () => {
  const provider = fakeProvider(async () => verified());
  assert.throws(
    () => new OddsVerificationService(provider, { concurrency: Number.MAX_SAFE_INTEGER + 10 }),
    (err: unknown) => err instanceof OddsVerificationServiceError && err.code === "INVALID_CONCURRENCY",
  );
});

test("verifyMany: per-call concurrency override is validated identically to the constructor", async () => {
  const provider = fakeProvider(async () => verified());
  const service = new OddsVerificationService(provider);

  await assert.rejects(
    () => service.verifyMany([request()], { concurrency: 0 }),
    (err: unknown) => err instanceof OddsVerificationServiceError && err.code === "INVALID_CONCURRENCY",
  );
  await assert.rejects(
    () => service.verifyMany([request()], { concurrency: -3 }),
    (err: unknown) => err instanceof OddsVerificationServiceError && err.code === "INVALID_CONCURRENCY",
  );
  await assert.rejects(
    () => service.verifyMany([request()], { concurrency: 1.2 }),
    (err: unknown) => err instanceof OddsVerificationServiceError && err.code === "INVALID_CONCURRENCY",
  );
});

/* -------------------------------------------------------------------------- */
/* Group B — verifyOne pass-through                                           */
/* -------------------------------------------------------------------------- */

test("verifyOne: VERIFIED is returned unchanged", async () => {
  const result = verified();
  const { provider, calls } = callCountingProvider(async () => result);
  const service = new OddsVerificationService(provider);
  const req = request();

  const actual = await service.verifyOne(req);

  assert.equal(actual, result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], req);
});

test("verifyOne: ODDS_CHANGED is returned unchanged", async () => {
  const result = createOddsChangedResult({ submittedOdds: "2.15", currentOdds: "1.50", provider: "THE_ODDS_API", checkedAt: CHECKED_AT });
  const { provider } = callCountingProvider(async () => result);
  const service = new OddsVerificationService(provider);

  const actual = await service.verifyOne(request());

  assert.equal(actual, result);
});

test("verifyOne: FAILED is returned unchanged", async () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "EVENT_NOT_FOUND" });
  const { provider } = callCountingProvider(async () => result);
  const service = new OddsVerificationService(provider);

  const actual = await service.verifyOne(request());

  assert.equal(actual, result);
});

test("verifyOne: NOT_CHECKED is returned unchanged", async () => {
  const result = createNotCheckedResult({ submittedOdds: null, provider: "THE_ODDS_API", checkedAt: CHECKED_AT });
  const { provider } = callCountingProvider(async () => result);
  const service = new OddsVerificationService(provider);

  const actual = await service.verifyOne(request());

  assert.equal(actual, result);
});

test("verifyOne: the provider is called exactly once with the same request object", async () => {
  const { provider, calls } = callCountingProvider(async () => verified());
  const service = new OddsVerificationService(provider);
  const req = request();

  await service.verifyOne(req);

  assert.equal(calls.length, 1);
  assert.equal(calls[0], req);
});

/* -------------------------------------------------------------------------- */
/* Group C — verifyOne unexpected exception mapping                           */
/* -------------------------------------------------------------------------- */

test("verifyOne: a thrown Error becomes FAILED/PROVIDER_UNAVAILABLE", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("some internal provider bug with a secret detail 12345");
  });
  const service = new OddsVerificationService(provider);

  const result = await service.verifyOne(request());

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "PROVIDER_UNAVAILABLE");
});

test("verifyOne: a thrown non-Error value (string) is handled the same way", async () => {
  const provider = fakeProvider(async () => {
    throw "raw string thrown by a misbehaving provider";
  });
  const service = new OddsVerificationService(provider);

  const result = await service.verifyOne(request());

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "PROVIDER_UNAVAILABLE");
});

test("verifyOne: exception mapping sets acceptedOdds null and preserves submittedOdds from the request", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("boom");
  });
  const service = new OddsVerificationService(provider);

  const result = await service.verifyOne(request({ selection: moneylineSelection({ submittedOdds: "3.40" }) }));

  assert.equal(result.acceptedOdds, null);
  assert.equal(result.submittedOdds, "3.40");
});

test("verifyOne: exception mapping falls back to null submittedOdds when neither request nor selection has one", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("boom");
  });
  const service = new OddsVerificationService(provider);

  const result = await service.verifyOne(request({ selection: moneylineSelection({ submittedOdds: undefined }) }));

  assert.equal(result.submittedOdds, null);
});

test("verifyOne: exception mapping is retryable, preserves provider name, and uses a stable diagnosticCode", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("boom");
  });
  const service = new OddsVerificationService(provider);

  const result = await service.verifyOne(request());

  assert.equal(result.retryable, true);
  assert.equal(result.provider, "THE_ODDS_API");
  assert.equal(result.diagnosticCode, "ODDS_PROVIDER_UNEXPECTED_ERROR");
  assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("verifyOne: exception message and stack are never exposed anywhere in the result", async () => {
  const secret = "SECRET_TOKEN_abc123_never_leak_this";
  const provider = fakeProvider(async () => {
    throw new Error(secret);
  });
  const service = new OddsVerificationService(provider);

  const result = await service.verifyOne(request());
  const serialized = JSON.stringify(result);

  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.toLowerCase().includes("stack"));
});

/* -------------------------------------------------------------------------- */
/* Group D — verifyMany basics                                                */
/* -------------------------------------------------------------------------- */

test("verifyMany: empty input returns [] and the provider is never called", async () => {
  const { provider, calls } = callCountingProvider(async () => verified());
  const service = new OddsVerificationService(provider);

  const results = await service.verifyMany([]);

  assert.deepEqual(results, []);
  assert.equal(calls.length, 0);
});

test("verifyMany: a single request behaves like verifyOne", async () => {
  const result = verified();
  const { provider } = callCountingProvider(async () => result);
  const service = new OddsVerificationService(provider);

  const results = await service.verifyMany([request()]);

  assert.equal(results.length, 1);
  assert.equal(results[0], result);
});

test("verifyMany: multiple results preserve input order despite out-of-order completion", async () => {
  // Each call resolves after a number of microtask ticks inversely
  // proportional to its index, so index 0 finishes LAST and index 4
  // finishes FIRST — a direct test that completion order never determines
  // result order.
  const provider = fakeProvider(async (req) => {
    const oddsToken = (req.selection.submittedOdds ?? "0").replace(".", "");
    const index = Number(oddsToken) - 200; // requests are built with submittedOdds "2.00".."2.04"
    for (let i = 0; i < 5 - index; i++) await Promise.resolve();
    return createVerifiedResult({
      submittedOdds: req.selection.submittedOdds ?? null,
      currentOdds: req.selection.submittedOdds ?? "0",
      provider: "THE_ODDS_API",
      checkedAt: CHECKED_AT,
    });
  });
  const service = new OddsVerificationService(provider, { concurrency: 5 });

  const requests = [0, 1, 2, 3, 4].map((i) => request({ selection: moneylineSelection({ submittedOdds: `2.0${i}` }) }));
  const results = await service.verifyMany(requests);

  assert.deepEqual(
    results.map((r) => r.submittedOdds),
    ["2.00", "2.01", "2.02", "2.03", "2.04"],
  );
});

test("verifyMany: duplicate requests are each processed independently", async () => {
  const { provider, calls } = callCountingProvider(async () => verified());
  const service = new OddsVerificationService(provider);
  const req = request();

  const results = await service.verifyMany([req, req, req]);

  assert.equal(calls.length, 3);
  assert.equal(results.length, 3);
});

test("verifyMany: the input array and its request objects are never mutated", async () => {
  const { provider } = callCountingProvider(async () => verified());
  const service = new OddsVerificationService(provider);
  const requests = [request(), request()] as const;
  const snapshot = JSON.parse(JSON.stringify(requests));

  await service.verifyMany(requests);

  assert.deepEqual(JSON.parse(JSON.stringify(requests)), snapshot);
  assert.equal(requests.length, 2);
});

test("verifyMany: result count always equals request count", async () => {
  const { provider } = callCountingProvider(async () => verified());
  const service = new OddsVerificationService(provider);

  const results = await service.verifyMany([request(), request(), request(), request()]);

  assert.equal(results.length, 4);
});

test("verifyMany: mixed VERIFIED/ODDS_CHANGED/FAILED/NOT_CHECKED results pass through correctly", async () => {
  const outcomes: VerificationResult[] = [
    verified(),
    createOddsChangedResult({ submittedOdds: "2.0", currentOdds: "1.5", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
    createFailedResult({ submittedOdds: "2.0", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "EVENT_NOT_FOUND" }),
    createNotCheckedResult({ submittedOdds: null, provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
  ];
  let callIndex = 0;
  const provider = fakeProvider(async () => outcomes[callIndex++]);
  const service = new OddsVerificationService(provider);

  const results = await service.verifyMany([request(), request(), request(), request()]);

  assert.deepEqual(
    results.map((r) => r.status),
    ["VERIFIED", "ODDS_CHANGED", "FAILED", "NOT_CHECKED"],
  );
});

/* -------------------------------------------------------------------------- */
/* Group E — bounded concurrency                                              */
/* -------------------------------------------------------------------------- */

test("bounded concurrency: maximum in-flight calls never exceeds the configured concurrency", async () => {
  const tracker = trackingProvider(() => verified());
  const service = new OddsVerificationService(tracker.provider, { concurrency: 2 });

  await service.verifyMany(Array.from({ length: 6 }, () => request()));

  assert.equal(tracker.getMaxInFlight(), 2);
});

test("bounded concurrency: concurrency > 1 actually overlaps calls", async () => {
  const tracker = trackingProvider(() => verified());
  const service = new OddsVerificationService(tracker.provider, { concurrency: 3 });

  await service.verifyMany(Array.from({ length: 6 }, () => request()));

  assert.equal(tracker.getMaxInFlight(), 3);
  assert.ok(tracker.getMaxInFlight() > 1);
});

test("bounded concurrency: concurrency = 1 remains strictly sequential", async () => {
  const tracker = trackingProvider(() => verified());
  const service = new OddsVerificationService(tracker.provider, { concurrency: 1 });

  await service.verifyMany(Array.from({ length: 5 }, () => request()));

  assert.equal(tracker.getMaxInFlight(), 1);
});

test("bounded concurrency: concurrency greater than the request count is safe and caps at request count", async () => {
  const tracker = trackingProvider(() => verified());
  const service = new OddsVerificationService(tracker.provider, { concurrency: 100 });

  const results = await service.verifyMany(Array.from({ length: 3 }, () => request()));

  assert.equal(tracker.getMaxInFlight(), 3);
  assert.equal(results.length, 3);
});

test("bounded concurrency: a per-call override changes only that call, not the service's stored default", async () => {
  const tracker = trackingProvider(() => verified());
  const service = new OddsVerificationService(tracker.provider, { concurrency: 4 });
  const sixRequests = Array.from({ length: 6 }, () => request());

  await service.verifyMany(sixRequests);
  assert.equal(tracker.getMaxInFlight(), 4, "uses the service default when no override is given");
  tracker.resetMaxInFlight();

  await service.verifyMany(sixRequests, { concurrency: 2 });
  assert.equal(tracker.getMaxInFlight(), 2, "the override applies for this call only");
  tracker.resetMaxInFlight();

  await service.verifyMany(sixRequests);
  assert.equal(tracker.getMaxInFlight(), 4, "the service default is unchanged after the earlier override");
});

/* -------------------------------------------------------------------------- */
/* Group F — failure isolation                                                */
/* -------------------------------------------------------------------------- */

test("failure isolation: one thrown provider call does not reject verifyMany, and siblings still complete", async () => {
  const provider = fakeProvider(async (req) => {
    if (req.selection.submittedOdds === "2.01") {
      throw new Error("this one blows up");
    }
    return verified(req.selection.submittedOdds ?? undefined);
  });
  const service = new OddsVerificationService(provider, { concurrency: 3 });

  const requests = ["2.00", "2.01", "2.02"].map((odds) => request({ selection: moneylineSelection({ submittedOdds: odds }) }));

  const results = await service.verifyMany(requests);

  assert.equal(results.length, 3);
  assert.equal(results[0].status, "VERIFIED");
  assert.equal(results[1].status, "FAILED");
  assert.equal(results[1].reasonCode, "PROVIDER_UNAVAILABLE");
  assert.equal(results[2].status, "VERIFIED");
});

test("failure isolation: mixed provider-returned FAILED and thrown-exception FAILED are both correctly typed at their original index", async () => {
  const provider = fakeProvider(async (req) => {
    const odds = req.selection.submittedOdds;
    if (odds === "2.00") return createFailedResult({ submittedOdds: odds, provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "EVENT_NOT_FOUND" });
    if (odds === "2.01") throw new Error("unexpected");
    return verified(odds ?? undefined);
  });
  const service = new OddsVerificationService(provider);

  const requests = ["2.00", "2.01", "2.02"].map((odds) => request({ selection: moneylineSelection({ submittedOdds: odds }) }));
  const results = await service.verifyMany(requests);

  assert.equal(results[0].status, "FAILED");
  assert.equal(results[0].reasonCode, "EVENT_NOT_FOUND");
  assert.equal(results[1].status, "FAILED");
  assert.equal(results[1].reasonCode, "PROVIDER_UNAVAILABLE");
  assert.equal(results[1].diagnosticCode, "ODDS_PROVIDER_UNEXPECTED_ERROR");
  assert.equal(results[2].status, "VERIFIED");
});

/* -------------------------------------------------------------------------- */
/* Optional result-summary helper                                             */
/* -------------------------------------------------------------------------- */

test("summarizeVerificationResults: pure counts, blocking = acceptedOdds null, no confirmability decision", () => {
  const results: VerificationResult[] = [
    verified(),
    createOddsChangedResult({ submittedOdds: "2.0", currentOdds: "1.5", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
    createFailedResult({ submittedOdds: "2.0", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "PROVIDER_TIMEOUT" }),
    createNotCheckedResult({ submittedOdds: null, provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
  ];

  const summary = summarizeVerificationResults(results);

  assert.deepEqual(summary, {
    total: 4,
    verified: 1,
    oddsChanged: 1,
    failed: 1,
    notChecked: 1,
    blocking: 3, // everything except the VERIFIED result
    retryable: 1, // only PROVIDER_TIMEOUT
  });
});

test("summarizeVerificationResults: empty input yields all-zero counts", () => {
  assert.deepEqual(summarizeVerificationResults([]), {
    total: 0,
    verified: 0,
    oddsChanged: 0,
    failed: 0,
    notChecked: 0,
    blocking: 0,
    retryable: 0,
  });
});
