import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { handleScreenshotPreview } from "./route";
import type { ParseBetSlipResult } from "@/lib/ai/betParser";
import type { OcrProvider, OcrResult } from "@/lib/ocr/ocrTypes";
import type { OddsCheckResult } from "@/types/oddsSnapshot";

// Stage 14.3 — this route now runs upload validation -> OCR
// (recognizeScreenshot, injectable) -> bet parsing (parseBetSlipMessage in
// "OCR" mode, injectable) -> buildBetSlipPreview (its own verifyOddsFn is
// also injectable). Every external dependency is faked here: no real
// database, no real Claude call (neither for OCR nor for parsing), no real
// Odds API call, no real Telegram initData from a live Mini App session —
// initData is constructed locally using the exact same HMAC algorithm
// lib/telegram/verifyInitData.ts implements, so signature verification runs
// for real against a known test bot token.

const BOT_TOKEN = "test-bot-token-screenshot-preview";
const PREVIEW_TOKEN_SECRET = "test-preview-token-secret";
const PLAYER_TELEGRAM_ID = 800000001; // synthetic — not Andrii or Denis
const PLAYER_ID = "player-synthetic-screenshot-1";

function buildInitData(botToken: string, userId: number, authDateOverride?: number): string {
  const authDate = authDateOverride ?? Math.floor(Date.now() / 1000);
  const params = new URLSearchParams();
  params.set("auth_date", String(authDate));
  params.set("user", JSON.stringify({ id: userId, first_name: "Test" }));

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  params.set("hash", hash);
  return params.toString();
}

interface FakePlayerRow {
  id: string;
  telegramId: string | null;
}

function fakeDb(players: FakePlayerRow[]): PrismaClient {
  return {
    player: {
      findUnique: async ({ where }: { where: { telegramId: string } }) => {
        const found = players.find((p) => p.telegramId === where.telegramId);
        return found ? { id: found.id } : null;
      },
    },
  } as unknown as PrismaClient;
}

function registeredDb(): PrismaClient {
  return fakeDb([{ id: PLAYER_ID, telegramId: String(PLAYER_TELEGRAM_ID) }]);
}

// Deterministic fake OCR provider — no real Claude call.
function fakeOcrProvider(recognize: () => Promise<OcrResult> | OcrResult): OcrProvider {
  return { name: "fake-ocr-provider", recognize: async () => recognize() };
}

function ocrSuccess(rawText: string): OcrResult {
  return { kind: "SUCCESS", provider: "fake-ocr-provider", rawText, normalizedText: rawText, durationMs: 1 };
}

// Deterministic fake bet parser — no real Claude call.
function fakeParseBetSlip(result: ParseBetSlipResult): typeof import("@/lib/ai/betParser").parseBetSlipMessage {
  return (async () => result) as typeof import("@/lib/ai/betParser").parseBetSlipMessage;
}

function singleSlip(overrides: Partial<Extract<ParseBetSlipResult, { valid: true }>> = {}): ParseBetSlipResult {
  return {
    valid: true,
    type: "SINGLE",
    stake: 50,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win", submittedOdds: 1.9 },
    ],
    ...overrides,
  };
}

// Never hits the real Odds API — matches lib/bets/buildBetSlipPreview.test.ts's
// own fakeVerifyOddsFn convention.
async function fakeVerifyOddsFn(): Promise<OddsCheckResult> {
  return {
    matched: true,
    withinTolerance: true,
    sourceOdds: 1.9,
    submittedOdds: 1.9,
    discrepancyPercent: 0,
    bookmaker: "test-bookmaker",
    note: null,
  };
}

// Minimal-but-valid signature bytes for each allowed format — long enough
// to pass detectImageSignature() in route.ts; pixel content is irrelevant
// since nothing in this pipeline ever decodes the image (OCR is fully
// faked).
function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
}

function buildRequest(initData: string, fileBytes: Uint8Array, mimeType: string, filename = "slip.jpg"): NextRequest {
  const file = new File([fileBytes], filename, { type: mimeType });
  const formData = new FormData();
  formData.set("image", file, filename);

  return new NextRequest("https://example.com/api/miniapp/bets/screenshot/preview", {
    method: "POST",
    headers: { authorization: `tma ${initData}` },
    body: formData,
  });
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    previewTokenSecret: PREVIEW_TOKEN_SECRET,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("Real Madrid vs Barcelona\nReal Madrid Win\nOdds 1.9\nStake 50")),
    parseBetSlip: fakeParseBetSlip(singleSlip()),
    verifyOddsFn: fakeVerifyOddsFn,
    ...overrides,
  };
}

// Stage 14.4A — captures every console.log call (the structured pipeline
// events logScreenshotPipelineEvent emits) so tests can assert on exactly
// what was logged, and — just as importantly — what was never logged.
const originalConsoleLog = console.log;
let loggedLines: unknown[][] = [];

test.beforeEach(() => {
  loggedLines = [];
  console.log = (...args: unknown[]) => {
    loggedLines.push(args);
  };
});

test.afterEach(() => {
  console.log = originalConsoleLog;
});

// Filters out any console.log line that isn't one of our own structured
// events — lib/bets/buildBetSlipPreview.ts (unrelated, unchanged, and
// explicitly out of scope for this stage) has its own pre-existing
// diagnostic console.log for an odds mismatch, which this route's tests
// also happen to capture. Only lines that are valid JSON with an `event`
// field are ours.
function parsedLogEvents(): Array<{ event: string; [key: string]: unknown }> {
  const events: Array<{ event: string; [key: string]: unknown }> = [];
  for (const args of loggedLines) {
    try {
      const parsed = JSON.parse(String(args[0]));
      if (parsed && typeof parsed === "object" && typeof parsed.event === "string") {
        events.push(parsed);
      }
    } catch {
      // Not one of ours — ignore.
    }
  }
  return events;
}

// ---------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------

test("screenshot preview: a valid upload flows through OCR -> parser -> preview and returns previewToken", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const response = await handleScreenshotPreview(request, baseOptions());

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.preview.type, "SINGLE");
  assert.equal(body.preview.selections[0].event, "Real Madrid vs Barcelona");
  assert.equal(typeof body.previewToken, "string");
  assert.ok(body.previewToken.length > 0);

  // Never the raw OCR text anywhere in the response.
  const raw = JSON.stringify(body);
  assert.equal(raw.includes("Stake 50\\n"), false);
  assert.equal(Object.keys(body).sort().join(","), "preview,previewToken");
});

test("screenshot preview: PNG and WEBP uploads are also accepted", async () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

  for (const [bytes, mimeType] of [
    [pngBytes, "image/png"],
    [webpBytes, "image/webp"],
  ] as const) {
    const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
    const request = buildRequest(initData, bytes, mimeType);
    const response = await handleScreenshotPreview(request, baseOptions());
    assert.equal(response.status, 200, `expected 200 for ${mimeType}`);
  }
});

// ---------------------------------------------------------------------
// Auth / upload validation (unchanged from before this migration)
// ---------------------------------------------------------------------

test("screenshot preview: missing initData is rejected", async () => {
  const request = new NextRequest("https://example.com/api/miniapp/bets/screenshot/preview", {
    method: "POST",
    body: new FormData(),
  });
  const response = await handleScreenshotPreview(request, baseOptions());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "malformed" });
});

test("screenshot preview: an invalid initData signature is rejected", async () => {
  const initData = buildInitData("a-different-bot-token", PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");
  const response = await handleScreenshotPreview(request, baseOptions());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "invalid_signature" });
});

test("screenshot preview: an unregistered telegramId is rejected", async () => {
  const initData = buildInitData(BOT_TOKEN, 999999999);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");
  const response = await handleScreenshotPreview(request, baseOptions());
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "PLAYER_NOT_FOUND" });
});

test("screenshot preview: a missing file is rejected", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = new NextRequest("https://example.com/api/miniapp/bets/screenshot/preview", {
    method: "POST",
    headers: { authorization: `tma ${initData}` },
    body: new FormData(),
  });
  const response = await handleScreenshotPreview(request, baseOptions());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "MISSING_FILE" });
});

test("screenshot preview: an unsupported declared MIME type is rejected before OCR", async () => {
  let ocrCalled = false;
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "application/pdf", "slip.pdf");

  const response = await handleScreenshotPreview(
    request,
    baseOptions({ ocrProvider: fakeOcrProvider(() => { ocrCalled = true; return ocrSuccess("x"); }) }),
  );

  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "UNSUPPORTED_FILE_TYPE" });
  assert.equal(ocrCalled, false);
});

test("screenshot preview: a MIME/signature mismatch is rejected before OCR", async () => {
  let ocrCalled = false;
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  // Declares image/png but the bytes are a JPEG signature.
  const request = buildRequest(initData, jpegBytes(), "image/png", "slip.png");

  const response = await handleScreenshotPreview(
    request,
    baseOptions({ ocrProvider: fakeOcrProvider(() => { ocrCalled = true; return ocrSuccess("x"); }) }),
  );

  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "INVALID_IMAGE_SIGNATURE" });
  assert.equal(ocrCalled, false);
});

// ---------------------------------------------------------------------
// OCR failure mapping
// ---------------------------------------------------------------------

test("screenshot preview: OCR NO_TEXT_FOUND maps to IMAGE_NOT_RECOGNIZED", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const ocrProvider = fakeOcrProvider(() => ({
    kind: "FAILURE",
    code: "NO_TEXT_FOUND",
    provider: "fake-ocr-provider",
    durationMs: 1,
    safeMessage: "no text",
  }));

  const response = await handleScreenshotPreview(request, baseOptions({ ocrProvider }));
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "IMAGE_NOT_RECOGNIZED" });
});

test("screenshot preview: OCR PROVIDER_TIMEOUT maps to AI_TIMEOUT", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const ocrProvider = fakeOcrProvider(() => ({
    kind: "FAILURE",
    code: "PROVIDER_TIMEOUT",
    provider: "fake-ocr-provider",
    durationMs: 1,
    safeMessage: "timed out",
  }));

  const response = await handleScreenshotPreview(request, baseOptions({ ocrProvider }));
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "AI_TIMEOUT" });
});

test("screenshot preview: OCR PROVIDER_UNAVAILABLE maps to AI_NOT_CONFIGURED", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const ocrProvider = fakeOcrProvider(() => ({
    kind: "FAILURE",
    code: "PROVIDER_UNAVAILABLE",
    provider: "fake-ocr-provider",
    durationMs: 1,
    safeMessage: "not configured",
  }));

  const response = await handleScreenshotPreview(request, baseOptions({ ocrProvider }));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "AI_NOT_CONFIGURED" });
});

test("screenshot preview: OCR PROVIDER_ERROR maps to AI_UNAVAILABLE and never leaks the safeMessage", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const ocrProvider = fakeOcrProvider(() => ({
    kind: "FAILURE",
    code: "PROVIDER_ERROR",
    provider: "fake-ocr-provider",
    durationMs: 1,
    safeMessage: "internal detail that must never reach the client",
  }));

  const response = await handleScreenshotPreview(request, baseOptions({ ocrProvider }));
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.deepEqual(body, { error: "AI_UNAVAILABLE" });
  assert.equal(JSON.stringify(body).includes("internal detail"), false);
});

// ---------------------------------------------------------------------
// Bet parser failure / rejection
// ---------------------------------------------------------------------

test("screenshot preview: a bet parser rejection maps to IMAGE_NOT_RECOGNIZED, never a fabricated bet", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const response = await handleScreenshotPreview(
    request,
    baseOptions({ parseBetSlip: fakeParseBetSlip({ valid: false, error: "Message does not appear to be a bet request" }) }),
  );

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "IMAGE_NOT_RECOGNIZED" });
});

// ---------------------------------------------------------------------
// Response contract — no raw OCR text ever returned, same shape as before
// ---------------------------------------------------------------------

test("screenshot preview: the response never contains OCR raw/normalized text fields", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const secretMarker = "SECRET_OCR_MARKER_TEXT_9182";
  const response = await handleScreenshotPreview(
    request,
    baseOptions({ ocrProvider: fakeOcrProvider(() => ocrSuccess(secretMarker)) }),
  );

  const body = await response.json();
  assert.equal(JSON.stringify(body).includes(secretMarker), false);
  assert.equal("rawText" in body, false);
  assert.equal("normalizedText" in body, false);
  assert.equal("ocr" in body, false);
});

test("screenshot preview: EXPRESS (multi-selection) slips are also returned correctly", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const expressSlip: ParseBetSlipResult = {
    valid: true,
    type: "EXPRESS",
    stake: 30,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win", submittedOdds: 1.9 },
      { sport: "Football", event: "Inter vs Juventus", market: null, selection: "Over 2.5", submittedOdds: 1.7 },
    ],
  };

  const response = await handleScreenshotPreview(request, baseOptions({ parseBetSlip: fakeParseBetSlip(expressSlip) }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.preview.type, "EXPRESS");
  assert.equal(body.preview.selections.length, 2);
});

// ---------------------------------------------------------------------
// Pre-commit review additions
// ---------------------------------------------------------------------

test("screenshot preview: an oversized image is rejected before OCR", async () => {
  let ocrCalled = false;
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);

  // A real 11 MB buffer (still a valid JPEG signature) — image.size is
  // what the route checks, not the declared MIME/signature, so this must
  // actually exceed MAX_FILE_SIZE_BYTES (10 MB) in bytes.
  const oversized = new Uint8Array(11 * 1024 * 1024);
  oversized.set([0xff, 0xd8, 0xff, 0xe0], 0);

  const request = buildRequest(initData, oversized, "image/jpeg");
  const response = await handleScreenshotPreview(
    request,
    baseOptions({ ocrProvider: fakeOcrProvider(() => { ocrCalled = true; return ocrSuccess("x"); }) }),
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "FILE_TOO_LARGE" });
  assert.equal(ocrCalled, false);
});

test("screenshot preview: an OCR INVALID_RESPONSE failure maps to AI_UNAVAILABLE", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const ocrProvider = fakeOcrProvider(() => ({
    kind: "FAILURE",
    code: "INVALID_RESPONSE",
    provider: "fake-ocr-provider",
    durationMs: 1,
    safeMessage: "malformed provider response",
  }));

  const response = await handleScreenshotPreview(request, baseOptions({ ocrProvider }));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "AI_UNAVAILABLE" });
});

test("screenshot preview: a bet-parser timeout maps to AI_TIMEOUT, not IMAGE_NOT_RECOGNIZED", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const response = await handleScreenshotPreview(
    request,
    baseOptions({
      parseBetSlip: fakeParseBetSlip({ valid: false, error: "Claude request timed out after 8000ms", code: "timeout" }),
    }),
  );

  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "AI_TIMEOUT" });
});

test("screenshot preview: a bet-parser API error (non-timeout) maps to IMAGE_NOT_RECOGNIZED, not AI_TIMEOUT", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const response = await handleScreenshotPreview(
    request,
    baseOptions({ parseBetSlip: fakeParseBetSlip({ valid: false, error: "Claude API responded 500" }) }),
  );

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "IMAGE_NOT_RECOGNIZED" });
});

test("screenshot preview: the bet parser throwing (not rejecting) is still handled safely", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const throwingParser = (async () => {
    throw new Error("unexpected parser crash");
  }) as typeof import("@/lib/ai/betParser").parseBetSlipMessage;

  const response = await handleScreenshotPreview(request, baseOptions({ parseBetSlip: throwingParser }));

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "AI_UNAVAILABLE" });
});

test("screenshot preview: odds-verification failure (rejected verifyOddsFn) still returns a usable preview, not a 500", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const failingVerifyOddsFn = async (): Promise<OddsCheckResult> => {
    throw new Error("odds provider unavailable");
  };

  const response = await handleScreenshotPreview(request, baseOptions({ verifyOddsFn: failingVerifyOddsFn }));

  assert.equal(response.status, 200);
  const body = await response.json();
  // buildBetSlipPreview uses Promise.allSettled internally — a rejected
  // odds check degrades this one selection's status, it never fails the
  // whole request.
  assert.equal(body.preview.selections[0].oddsStatus, "UNAVAILABLE");
  assert.equal(body.preview.selections[0].currentOdds, null);
});

test("screenshot preview: never creates a Bet, BetSelection, or Transaction (fake db has no such methods)", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  // registeredDb() only implements player.findUnique. If the handler, OCR
  // stage, parser stage, or buildBetSlipPreview() ever reached for
  // db.bet.create / db.transaction.create / any write, this would throw a
  // TypeError instead of resolving 200 — this route never touches the
  // database beyond the one read-only player lookup.
  const response = await handleScreenshotPreview(request, baseOptions());

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.previewToken, "string");
});

// ---------------------------------------------------------------------
// Stage 14.4A — timing + structured logging
// ---------------------------------------------------------------------

test("screenshot preview: a successful request logs the full expected event sequence with numeric timings", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const response = await handleScreenshotPreview(request, baseOptions());
  assert.equal(response.status, 200);

  const events = parsedLogEvents();
  const eventNames = events.map((e) => e.event);

  assert.deepEqual(eventNames, [
    "screenshot_preview_started",
    "ocr_succeeded",
    "parser_succeeded",
    "odds_verification_succeeded",
    "screenshot_preview_completed",
  ]);

  const ocrEvent = events.find((e) => e.event === "ocr_succeeded")!;
  assert.equal(typeof ocrEvent.durationMs, "number");

  const parserEvent = events.find((e) => e.event === "parser_succeeded")!;
  assert.equal(typeof parserEvent.durationMs, "number");
  assert.equal(parserEvent.parserMode, "OCR");
  assert.equal(parserEvent.selectionCount, 1);

  const oddsEvent = events.find((e) => e.event === "odds_verification_succeeded")!;
  assert.equal(typeof oddsEvent.durationMs, "number");
  assert.equal(oddsEvent.selectionCount, 1);

  const completedEvent = events.find((e) => e.event === "screenshot_preview_completed")!;
  assert.equal(typeof completedEvent.totalDurationMs, "number");
  assert.ok(completedEvent.totalDurationMs as number >= 0);
});

test("screenshot preview: OCR failure logs ocr_failed with the failure code and duration, nothing further", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const ocrProvider = fakeOcrProvider(() => ({
    kind: "FAILURE",
    code: "NO_TEXT_FOUND",
    provider: "fake-ocr-provider",
    durationMs: 42, // recognizeScreenshot() re-measures/re-stamps this itself (Stage 14.2 behavior) — not asserted verbatim below.
    safeMessage: "no text",
  }));

  await handleScreenshotPreview(request, baseOptions({ ocrProvider }));

  const events = parsedLogEvents();
  assert.deepEqual(
    events.map((e) => e.event),
    ["screenshot_preview_started", "ocr_failed"],
  );
  const ocrFailed = events[1];
  assert.equal(ocrFailed.failureCode, "NO_TEXT_FOUND");
  assert.equal(typeof ocrFailed.durationMs, "number");
});

test("screenshot preview: a parser rejection logs parser_rejected; a parser timeout logs parser_timed_out", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);

  const rejectedRequest = buildRequest(initData, jpegBytes(), "image/jpeg");
  await handleScreenshotPreview(
    rejectedRequest,
    baseOptions({ parseBetSlip: fakeParseBetSlip({ valid: false, error: "not a bet" }) }),
  );
  assert.deepEqual(
    parsedLogEvents().map((e) => e.event),
    ["screenshot_preview_started", "ocr_succeeded", "parser_rejected"],
  );

  loggedLines = [];

  const timeoutRequest = buildRequest(initData, jpegBytes(), "image/jpeg");
  await handleScreenshotPreview(
    timeoutRequest,
    baseOptions({ parseBetSlip: fakeParseBetSlip({ valid: false, error: "timed out", code: "timeout" }) }),
  );
  assert.deepEqual(
    parsedLogEvents().map((e) => e.event),
    ["screenshot_preview_started", "ocr_succeeded", "parser_timed_out"],
  );
});

test("screenshot preview: the bet parser throwing logs parser_failed", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const throwingParser = (async () => {
    throw new Error("unexpected parser crash");
  }) as typeof import("@/lib/ai/betParser").parseBetSlipMessage;

  await handleScreenshotPreview(request, baseOptions({ parseBetSlip: throwingParser }));

  assert.deepEqual(
    parsedLogEvents().map((e) => e.event),
    ["screenshot_preview_started", "ocr_succeeded", "parser_failed"],
  );
});

test("screenshot preview: odds NOT_FOUND logs odds_verification_not_found with the status summary, never selection content", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const notFoundOdds = async (): Promise<OddsCheckResult> => ({
    matched: false,
    withinTolerance: null,
    sourceOdds: null,
    submittedOdds: 1.9,
    discrepancyPercent: null,
    bookmaker: null,
    note: "no matching event",
  });

  await handleScreenshotPreview(request, baseOptions({ verifyOddsFn: notFoundOdds }));

  const events = parsedLogEvents();
  const oddsEvent = events.find((e) => e.event === "odds_verification_not_found");
  assert.ok(oddsEvent, "expected an odds_verification_not_found event");
  assert.equal(oddsEvent!.oddsVerificationStatus, "NOT_FOUND");
});

test("screenshot preview: a rejected verifyOddsFn logs odds_verification_failed (UNAVAILABLE), not a success", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const failingVerifyOddsFn = async (): Promise<OddsCheckResult> => {
    throw new Error("odds provider unavailable");
  };

  await handleScreenshotPreview(request, baseOptions({ verifyOddsFn: failingVerifyOddsFn }));

  const events = parsedLogEvents();
  const oddsEvent = events.find((e) => e.event === "odds_verification_failed");
  assert.ok(oddsEvent, "expected an odds_verification_failed event");
  assert.equal(oddsEvent!.oddsVerificationStatus, "UNAVAILABLE");
});

test("screenshot preview: no logged event ever contains OCR text, event/selection/stake/odds content, initData, tokens, or headers", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, jpegBytes(), "image/jpeg");

  const secretOcrMarker = "SUPER_SECRET_OCR_MARKER_5561";
  const secretSlip = singleSlip({
    selections: [
      {
        sport: "Football",
        event: "SECRET_EVENT_NAME_Barcelona_vs_RealMadrid",
        market: null,
        selection: "SECRET_SELECTION_Over_2_5",
        submittedOdds: 1.9,
      },
    ],
  });

  await handleScreenshotPreview(
    request,
    baseOptions({
      ocrProvider: fakeOcrProvider(() => ocrSuccess(secretOcrMarker)),
      parseBetSlip: fakeParseBetSlip(secretSlip),
    }),
  );

  const forbidden = [
    secretOcrMarker,
    "SECRET_EVENT_NAME",
    "SECRET_SELECTION",
    initData,
    BOT_TOKEN,
    PREVIEW_TOKEN_SECRET,
    "authorization",
    "Bearer",
  ];

  const rawLoggedText = JSON.stringify(loggedLines);
  for (const value of forbidden) {
    assert.equal(rawLoggedText.includes(value), false, `logged output must never contain: ${value}`);
  }

  // Every logged line must be valid, flat JSON metadata — never a raw
  // Error object, stack trace, or arbitrary nested content.
  for (const event of parsedLogEvents()) {
    for (const [key, value] of Object.entries(event)) {
      assert.ok(
        typeof value === "string" || typeof value === "number",
        `log field "${key}" must be a string or number, got ${typeof value}`,
      );
    }
  }
});
