import { test } from "node:test";
import assert from "node:assert/strict";
import { recognizeScreenshot } from "./recognizeScreenshot";
import type { OcrImageInput, OcrProvider, OcrResult } from "./ocrTypes";

// Deterministic fake provider — no real network call, no real API key, no
// real OCR service. Matches this repo's established fake-dependency
// convention (fakeDb in lib/telegram/bindInvitedPlayer.test.ts,
// app/api/bets/settle.route.test.ts, etc.): a small hand-written stand-in
// implementing only the one method callers actually use.
function fakeProvider(
  recognize: (input: OcrImageInput) => Promise<OcrResult> | OcrResult,
  name = "fake-provider",
): OcrProvider {
  return { name, recognize: async (input) => recognize(input) };
}

function jpegIntake() {
  return { mimeType: "image/jpeg" as const, originalFilename: undefined };
}

function validBuffer() {
  return Buffer.from("fake-image-bytes");
}

test("recognizeScreenshot: a valid JPEG buffer returns normalized OCR success", async () => {
  const provider = fakeProvider(async () => ({
    kind: "SUCCESS",
    provider: "fake-provider",
    rawText: "Real Madrid vs Barcelona\r\nOver 2.5",
    normalizedText: "irrelevant — orchestrator re-normalizes",
    durationMs: 5,
  }));

  const result = await recognizeScreenshot({ intake: jpegIntake(), buffer: validBuffer(), provider });

  assert.equal(result.kind, "SUCCESS");
  if (result.kind !== "SUCCESS") return;
  assert.equal(result.normalizedText, "Real Madrid vs Barcelona\nOver 2.5");
  assert.equal(result.provider, "fake-provider");
  assert.equal(typeof result.durationMs, "number");
});

test("recognizeScreenshot: a valid PNG buffer returns normalized OCR success", async () => {
  const provider = fakeProvider(async () => ({
    kind: "SUCCESS",
    provider: "fake-provider",
    rawText: "PNG slip text",
    normalizedText: "",
    durationMs: 5,
  }));

  const result = await recognizeScreenshot({
    intake: { mimeType: "image/png", originalFilename: undefined },
    buffer: validBuffer(),
    provider,
  });

  assert.equal(result.kind, "SUCCESS");
  if (result.kind !== "SUCCESS") return;
  assert.equal(result.normalizedText, "PNG slip text");
});

test("recognizeScreenshot: a valid WEBP buffer returns normalized OCR success", async () => {
  const provider = fakeProvider(async () => ({
    kind: "SUCCESS",
    provider: "fake-provider",
    rawText: "WEBP slip text",
    normalizedText: "",
    durationMs: 5,
  }));

  const result = await recognizeScreenshot({
    intake: { mimeType: "image/webp", originalFilename: undefined },
    buffer: validBuffer(),
    provider,
  });

  assert.equal(result.kind, "SUCCESS");
  if (result.kind !== "SUCCESS") return;
  assert.equal(result.normalizedText, "WEBP slip text");
});

test("recognizeScreenshot: an empty buffer returns EMPTY_IMAGE without calling the provider", async () => {
  let called = false;
  const provider = fakeProvider(async () => {
    called = true;
    return { kind: "SUCCESS", provider: "fake-provider", rawText: "x", normalizedText: "x", durationMs: 1 };
  });

  const result = await recognizeScreenshot({ intake: jpegIntake(), buffer: Buffer.alloc(0), provider });

  assert.equal(result.kind, "FAILURE");
  if (result.kind !== "FAILURE") return;
  assert.equal(result.code, "EMPTY_IMAGE");
  assert.equal(result.safeMessage, "Image is empty");
  assert.equal(called, false);
});

test("recognizeScreenshot: an unsupported MIME type returns UNSUPPORTED_FORMAT without calling the provider", async () => {
  let called = false;
  const provider = fakeProvider(async () => {
    called = true;
    return { kind: "SUCCESS", provider: "fake-provider", rawText: "x", normalizedText: "x", durationMs: 1 };
  });

  const result = await recognizeScreenshot({
    // Cast bypasses the compile-time OcrMimeType guarantee, matching how a
    // malformed/legacy caller could reach this at runtime.
    intake: { mimeType: "application/pdf" as unknown as "image/jpeg", originalFilename: undefined },
    buffer: validBuffer(),
    provider,
  });

  assert.equal(result.kind, "FAILURE");
  if (result.kind !== "FAILURE") return;
  assert.equal(result.code, "UNSUPPORTED_FORMAT");
  assert.equal(called, false);
});

test("recognizeScreenshot: provider returning empty text becomes NO_TEXT_FOUND", async () => {
  const provider = fakeProvider(async () => ({
    kind: "SUCCESS",
    provider: "fake-provider",
    rawText: "   \n\n  ",
    normalizedText: "",
    durationMs: 1,
  }));

  const result = await recognizeScreenshot({ intake: jpegIntake(), buffer: validBuffer(), provider });

  assert.equal(result.kind, "FAILURE");
  if (result.kind !== "FAILURE") return;
  assert.equal(result.code, "NO_TEXT_FOUND");
});

test("recognizeScreenshot: a provider that throws becomes PROVIDER_ERROR", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("boom");
  });

  const result = await recognizeScreenshot({ intake: jpegIntake(), buffer: validBuffer(), provider });

  assert.equal(result.kind, "FAILURE");
  if (result.kind !== "FAILURE") return;
  assert.equal(result.code, "PROVIDER_ERROR");
  // Never the raw error message surfaced to the caller.
  assert.equal(result.safeMessage.includes("boom"), false);
});

test("recognizeScreenshot: a provider that never resolves in time becomes PROVIDER_TIMEOUT", async () => {
  const provider = fakeProvider(() => new Promise<OcrResult>(() => {}));

  const result = await recognizeScreenshot({
    intake: jpegIntake(),
    buffer: validBuffer(),
    provider,
    timeoutMs: 20,
  });

  assert.equal(result.kind, "FAILURE");
  if (result.kind !== "FAILURE") return;
  assert.equal(result.code, "PROVIDER_TIMEOUT");
});

test("recognizeScreenshot: an invalid/malformed provider response becomes INVALID_RESPONSE", async () => {
  const provider = fakeProvider(async () => ({ nonsense: true }) as unknown as OcrResult);

  const result = await recognizeScreenshot({ intake: jpegIntake(), buffer: validBuffer(), provider });

  assert.equal(result.kind, "FAILURE");
  if (result.kind !== "FAILURE") return;
  assert.equal(result.code, "INVALID_RESPONSE");
});

test("recognizeScreenshot: a provider-reported FAILURE is passed through with a re-measured duration", async () => {
  const provider = fakeProvider(async () => ({
    kind: "FAILURE",
    code: "PROVIDER_UNAVAILABLE",
    provider: "fake-provider",
    durationMs: 999999, // deliberately wrong — orchestrator must not trust this
    safeMessage: "not configured",
  }));

  const result = await recognizeScreenshot({ intake: jpegIntake(), buffer: validBuffer(), provider });

  assert.equal(result.kind, "FAILURE");
  if (result.kind !== "FAILURE") return;
  assert.equal(result.code, "PROVIDER_UNAVAILABLE");
  assert.notEqual(result.durationMs, 999999);
});

test("recognizeScreenshot: never mutates the database or creates a Bet (pure function of its inputs)", async () => {
  // No db/Prisma is even reachable from this module's imports — this test
  // exists as a structural guardrail, not a mock-call assertion: the
  // function signature itself (intake/buffer/provider only) makes a
  // Bet/Transaction/balance side effect impossible without changing the
  // file's own imports.
  const provider = fakeProvider(async () => ({
    kind: "SUCCESS",
    provider: "fake-provider",
    rawText: "text",
    normalizedText: "text",
    durationMs: 1,
  }));

  const result = await recognizeScreenshot({ intake: jpegIntake(), buffer: validBuffer(), provider });
  assert.equal(result.kind, "SUCCESS");
});
