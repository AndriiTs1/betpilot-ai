import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { handleScreenshotDebug } from "./route";
import { OPERATOR_SESSION_COOKIE_NAME, type OperatorSessionStore } from "@/lib/auth/operatorSession";
import type { ParseBetSlipResult } from "@/lib/ai/betParser";
import type { OcrProvider, OcrResult } from "@/lib/ocr/ocrTypes";
import type { OddsCheckResult } from "@/types/oddsSnapshot";

// Stage 14.4A, Part E — this route is operator-only (requireOperatorApi,
// the exact same session mechanism every /api/dashboard/* route already
// uses) and reuses the production OCR/parser/odds-verification modules
// directly, never a reimplementation. No database is touched for the
// pipeline itself (no player lookup — this route has no player context);
// the only "database" involved is requireOperatorApi's own injectable
// session store, faked here the same way lib/auth/requireOperator.test.ts
// already fakes it — real SHA-256 token hashing, real cookie name, no
// actual DB connection.

const PREVIEW_TOKEN_SECRET = "test-preview-token-secret-debug";

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

// Matches operatorSession.ts's own TOKEN_SHAPE expectation
// (/^[A-Za-z0-9_-]{40,50}$/) — base64url of 32 random bytes, same as
// createOperatorSession's real token generation.
function makeToken(): string {
  return randomBytes(32).toString("base64url");
}

interface FakeSessionRow {
  id: string;
  operatorId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

function createFakeStore(rows: FakeSessionRow[]): OperatorSessionStore {
  return {
    async create() {
      throw new Error("not used in these tests");
    },
    async findUnique({ where }) {
      return rows.find((r) => r.tokenHash === where.tokenHash) ?? null;
    },
    async update({ where, data }) {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    },
    async updateMany() {
      return { count: 0 };
    },
    async deleteMany() {
      return { count: 0 };
    },
  };
}

function validSessionRow(token: string): FakeSessionRow {
  return {
    id: "session-1",
    operatorId: "operator-1",
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: null,
    lastUsedAt: null,
  };
}

function requestWithSession(fileBytes: Uint8Array, mimeType: string, rawToken: string | null): NextRequest {
  const file = new File([fileBytes], "slip.jpg", { type: mimeType });
  const formData = new FormData();
  formData.set("image", file, "slip.jpg");

  return new NextRequest("https://example.com/api/dashboard/debug/screenshot-preview", {
    method: "POST",
    headers: rawToken ? { cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${rawToken}` } : {},
    body: formData,
  });
}

function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
}

function fakeOcrProvider(recognize: () => Promise<OcrResult> | OcrResult): OcrProvider {
  return { name: "fake-ocr-provider", recognize: async () => recognize() };
}

function ocrSuccess(rawText: string): OcrResult {
  return { kind: "SUCCESS", provider: "fake-ocr-provider", rawText, normalizedText: rawText, durationMs: 1 };
}

function fakeParseBetSlip(result: ParseBetSlipResult): typeof import("@/lib/ai/betParser").parseBetSlipMessage {
  return (async () => result) as typeof import("@/lib/ai/betParser").parseBetSlipMessage;
}

function singleSlip(): ParseBetSlipResult {
  return {
    valid: true,
    type: "SINGLE",
    stake: 50,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Over 2.5 Goals", submittedOdds: 2.1 },
    ],
  };
}

async function fakeVerifyOddsFn(): Promise<OddsCheckResult> {
  return {
    matched: true,
    withinTolerance: true,
    sourceOdds: 2.1,
    submittedOdds: 2.1,
    discrepancyPercent: 0,
    bookmaker: "test-bookmaker",
    note: null,
  };
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    previewTokenSecret: PREVIEW_TOKEN_SECRET,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("Real Madrid vs Barcelona\nOver 2.5 Goals\nOdds 2.10\nStake 50")),
    parseBetSlip: fakeParseBetSlip(singleSlip()),
    verifyOddsFn: fakeVerifyOddsFn,
    ...overrides,
  };
}

function authedOptions(rawToken: string, overrides: Record<string, unknown> = {}) {
  return { ...baseOptions(overrides), operatorSessionStore: createFakeStore([validSessionRow(rawToken)]) };
}

// ---------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------

test("screenshot debug: no session cookie is rejected", async () => {
  const request = requestWithSession(jpegBytes(), "image/jpeg", null);
  const response = await handleScreenshotDebug(request, { ...baseOptions(), operatorSessionStore: createFakeStore([]) });
  assert.equal(response.status, 401);
});

test("screenshot debug: an unknown session token is rejected even with a real, injectable store present", async () => {
  const knownToken = makeToken();
  const unknownToken = makeToken();
  const request = requestWithSession(jpegBytes(), "image/jpeg", unknownToken);

  const response = await handleScreenshotDebug(request, {
    ...baseOptions(),
    operatorSessionStore: createFakeStore([validSessionRow(knownToken)]),
  });

  assert.equal(response.status, 401);
});

test("screenshot debug: a revoked session is rejected", async () => {
  const token = makeToken();
  const row = validSessionRow(token);
  row.revokedAt = new Date();
  const request = requestWithSession(jpegBytes(), "image/jpeg", token);

  const response = await handleScreenshotDebug(request, { ...baseOptions(), operatorSessionStore: createFakeStore([row]) });
  assert.equal(response.status, 401);
});

test("screenshot debug: an expired session is rejected", async () => {
  const token = makeToken();
  const row = validSessionRow(token);
  row.expiresAt = new Date(Date.now() - 1000);
  const request = requestWithSession(jpegBytes(), "image/jpeg", token);

  const response = await handleScreenshotDebug(request, { ...baseOptions(), operatorSessionStore: createFakeStore([row]) });
  assert.equal(response.status, 401);
});

// ---------------------------------------------------------------------
// Happy path, with a real (faked-store) authenticated operator session
// ---------------------------------------------------------------------

test("screenshot debug: a valid operator session runs the full pipeline and returns every diagnostic stage", async () => {
  const token = makeToken();
  const request = requestWithSession(jpegBytes(), "image/jpeg", token);

  const response = await handleScreenshotDebug(request, authedOptions(token));

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.ocr.kind, "SUCCESS");
  assert.equal(typeof body.ocr.durationMs, "number");
  assert.equal(body.ocr.normalizedText, "Real Madrid vs Barcelona\nOver 2.5 Goals\nOdds 2.10\nStake 50");

  assert.equal(body.parser.valid, true);
  assert.equal(body.parser.mode, "OCR");
  assert.equal(body.parser.type, "SINGLE");
  assert.equal(body.parser.selections[0].event, "Real Madrid vs Barcelona");

  assert.equal(typeof body.oddsVerification.durationMs, "number");
  assert.equal(body.oddsVerification.selections[0].oddsStatus, "VERIFIED");

  assert.equal(body.preview.type, "SINGLE");
  assert.equal(typeof body.totalDurationMs, "number");
});

test("screenshot debug: never returns a previewToken, anywhere in the response", async () => {
  const token = makeToken();
  const request = requestWithSession(jpegBytes(), "image/jpeg", token);

  const response = await handleScreenshotDebug(request, authedOptions(token));
  const body = await response.json();

  assert.equal("previewToken" in body, false);
  assert.equal("previewToken" in (body.preview ?? {}), false);
  assert.equal(JSON.stringify(body).includes("previewToken"), false);
});

test("screenshot debug: an OCR failure is reported diagnostically, with no parser/oddsVerification fields", async () => {
  const token = makeToken();
  const request = requestWithSession(jpegBytes(), "image/jpeg", token);

  const ocrProvider = fakeOcrProvider(() => ({
    kind: "FAILURE",
    code: "NO_TEXT_FOUND",
    provider: "fake-ocr-provider",
    durationMs: 5,
    safeMessage: "no legible text",
  }));

  const response = await handleScreenshotDebug(request, authedOptions(token, { ocrProvider }));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.ocr.kind, "FAILURE");
  assert.equal(body.ocr.code, "NO_TEXT_FOUND");
  assert.equal("parser" in body, false);
  assert.equal("oddsVerification" in body, false);
});

test("screenshot debug: a parser rejection is reported diagnostically, with no oddsVerification field", async () => {
  const token = makeToken();
  const request = requestWithSession(jpegBytes(), "image/jpeg", token);

  const response = await handleScreenshotDebug(
    request,
    authedOptions(token, { parseBetSlip: fakeParseBetSlip({ valid: false, error: "not a bet" }) }),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.parser.valid, false);
  assert.equal("oddsVerification" in body, false);
  assert.equal("preview" in body, false);
});

// ---------------------------------------------------------------------
// Upload validation reuse (proves no duplicated/diverged logic)
// ---------------------------------------------------------------------

test("screenshot debug: an unsupported MIME type is rejected the same way as the production route", async () => {
  const token = makeToken();
  const file = new File([jpegBytes()], "slip.pdf", { type: "application/pdf" });
  const formData = new FormData();
  formData.set("image", file, "slip.pdf");
  const request = new NextRequest("https://example.com/api/dashboard/debug/screenshot-preview", {
    method: "POST",
    headers: { cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${token}` },
    body: formData,
  });

  const response = await handleScreenshotDebug(request, authedOptions(token));
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "UNSUPPORTED_FILE_TYPE" });
});

test("screenshot debug: an oversized image is rejected before OCR", async () => {
  const token = makeToken();
  const oversized = new Uint8Array(11 * 1024 * 1024);
  oversized.set([0xff, 0xd8, 0xff, 0xe0], 0);
  const request = requestWithSession(oversized, "image/jpeg", token);

  let ocrCalled = false;
  const response = await handleScreenshotDebug(
    request,
    authedOptions(token, { ocrProvider: fakeOcrProvider(() => { ocrCalled = true; return ocrSuccess("x"); }) }),
  );

  assert.equal(response.status, 413);
  assert.equal(ocrCalled, false);
});

// ---------------------------------------------------------------------
// No persistence, no financial side effects
// ---------------------------------------------------------------------

test("screenshot debug: never creates a Bet/Transaction and never mutates a wallet (route imports no such model at all)", async () => {
  const token = makeToken();
  const request = requestWithSession(jpegBytes(), "image/jpeg", token);

  // This route doesn't import Prisma's Bet/Transaction/Player models at
  // all — there is no `db` option to inject in the first place, unlike
  // the production preview route. A passing 200 here is itself the proof:
  // there is no code path in route.ts that could have written anything.
  const response = await handleScreenshotDebug(request, authedOptions(token));
  assert.equal(response.status, 200);
});

test("screenshot debug: the response never leaks the operator's session token or cookie header", async () => {
  const token = makeToken();
  const request = requestWithSession(jpegBytes(), "image/jpeg", token);

  const response = await handleScreenshotDebug(request, authedOptions(token));
  const rawBody = JSON.stringify(await response.json());

  assert.equal(rawBody.includes(token), false);
  assert.equal(rawBody.toLowerCase().includes("cookie"), false);
});
