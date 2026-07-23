import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { recognizeBetSlipScreenshot } from "./recognizeBetSlipScreenshot";
import type { RegionDetectionOutcome } from "./regionDetection";
import { clampAndPadRegion } from "./screenshotPreprocessing";
import type { OcrImageInput, OcrProvider, OcrResult } from "./ocrTypes";

function solidImage(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 50, g: 90, b: 160 } } })
    .jpeg()
    .toBuffer();
}

function fakeProvider(recognize: (input: OcrImageInput) => Promise<OcrResult> | OcrResult): OcrProvider {
  return { name: "fake", recognize: async (input) => recognize(input) };
}

function ocrSuccess(): OcrResult {
  return { kind: "SUCCESS", provider: "fake", rawText: "text", normalizedText: "text", durationMs: 1 };
}

function fakeDetectRegion(outcome: RegionDetectionOutcome) {
  return async () => outcome;
}

// ---------------------------------------------------------------------
// 1. Cropped/small screenshot — existing behavior unchanged
// ---------------------------------------------------------------------

test("recognizeBetSlipScreenshot: a small, already-cropped image skips region detection and reaches OCR unchanged", async () => {
  const buffer = await solidImage(400, 700);
  let detectRegionCalled = false;
  let receivedBuffer: Buffer | null = null;

  const outcome = await recognizeBetSlipScreenshot({
    buffer,
    intake: { mimeType: "image/jpeg" },
    provider: fakeProvider((input) => {
      receivedBuffer = input.buffer;
      return ocrSuccess();
    }),
    detectRegion: async () => {
      detectRegionCalled = true;
      throw new Error("must not be called for a small image");
    },
  });

  assert.equal(outcome.kind, "OCR_RESULT");
  assert.equal(detectRegionCalled, false);
  assert.equal(outcome.kind === "OCR_RESULT" && outcome.diagnostics.regionDetection.outcome, "skipped_small_image");
  assert.deepEqual(receivedBuffer, buffer, "OCR must receive the exact original buffer, byte for byte");
});

test("recognizeBetSlipScreenshot: an undecodable buffer (sharp can't read metadata) still succeeds via the original-image OCR path", async () => {
  const buffer = Buffer.from("not a real image, just enough to pass upstream signature checks");

  const outcome = await recognizeBetSlipScreenshot({
    buffer,
    intake: { mimeType: "image/jpeg" },
    provider: fakeProvider(() => ocrSuccess()),
    detectRegion: async () => {
      throw new Error("must not be called");
    },
  });

  assert.equal(outcome.kind, "OCR_RESULT");
  assert.equal(outcome.kind === "OCR_RESULT" && outcome.diagnostics.metadataDecodeFailed, true);
  assert.equal(outcome.kind === "OCR_RESULT" && outcome.ocrResult.kind, "SUCCESS");
});

// ---------------------------------------------------------------------
// 2. Full desktop screenshot — region found, cropped, padded
// ---------------------------------------------------------------------

test("recognizeBetSlipScreenshot: a large image with a found region sends OCR a cropped buffer smaller than the original", async () => {
  const buffer = await solidImage(1800, 1100);
  // An object wrapper, not a bare `let` — TS's control-flow narrowing of a
  // bare closured `let` across an `await` boundary is unreliable (observed
  // narrowing to `never` here); a property read is always just the
  // declared type, with no narrowing ambiguity to trip over.
  const received: { buffer: Buffer | null } = { buffer: null };

  const outcome = await recognizeBetSlipScreenshot({
    buffer,
    intake: { mimeType: "image/jpeg" },
    provider: fakeProvider((input) => {
      received.buffer = input.buffer;
      return ocrSuccess();
    }),
    detectRegion: fakeDetectRegion({
      kind: "FOUND",
      region: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
      confidence: 0.9,
      reason: "test",
      durationMs: 3,
    }),
  });

  assert.equal(outcome.kind, "OCR_RESULT");
  assert.equal(typeof received.buffer?.byteLength, "number");
  assert.ok((received.buffer?.byteLength ?? 0) < buffer.byteLength, "cropped buffer must be smaller than the full screenshot");
  assert.equal(outcome.kind === "OCR_RESULT" && outcome.diagnostics.regionDetection.outcome, "region_found");
  assert.equal(outcome.kind === "OCR_RESULT" && outcome.diagnostics.cropMs !== null, true);
});

test("recognizeBetSlipScreenshot: the cropped buffer's mimeType is reported as image/jpeg (the crop's own re-encoding)", async () => {
  const buffer = await solidImage(1800, 1100);
  let receivedMimeType: string | null = null;

  await recognizeBetSlipScreenshot({
    buffer,
    intake: { mimeType: "image/png" },
    provider: fakeProvider((input) => {
      receivedMimeType = input.mimeType;
      return ocrSuccess();
    }),
    detectRegion: fakeDetectRegion({
      kind: "FOUND",
      region: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
      confidence: 0.9,
      reason: "test",
      durationMs: 3,
    }),
  });

  assert.equal(receivedMimeType, "image/jpeg");
});

// ---------------------------------------------------------------------
// 3. Express screenshot — legs stay inside the crop (padding coverage;
//    exact geometry already covered in screenshotPreprocessing.test.ts,
//    this asserts the orchestrator actually applies that padding end to
//    end rather than a raw, unpadded box).
// ---------------------------------------------------------------------

test("recognizeBetSlipScreenshot: a padded region (as detectBettingRegion would actually produce) survives end to end into the cropped buffer OCR receives", async () => {
  const width = 2000;
  const height = 1200;
  const buffer = await solidImage(width, height);

  // The orchestrator crops exactly whatever region it's given — padding
  // itself is lib/ocr/regionDetection.ts's own responsibility (already
  // covered directly in regionDetection.test.ts), not something the
  // orchestrator redundantly re-applies. So this test computes the region
  // the same way detectBettingRegion() actually would (raw box ->
  // clampAndPadRegion), to prove that padding — once applied — is not lost
  // or re-clipped anywhere between region detection and the buffer OCR
  // finally receives.
  const rawBox = { x: 0.35, y: 0.35, width: 0.3, height: 0.3 };
  const paddedRegion = clampAndPadRegion(rawBox);
  assert.ok(paddedRegion, "test setup: the raw box must itself be valid");

  // Captured outside the provider callback and asserted on after
  // recognizeBetSlipScreenshot() resolves — an assertion thrown *inside*
  // the callback would be caught by recognizeScreenshot.ts's own
  // provider try/catch and reported as a generic PROVIDER_ERROR result
  // instead of a real test failure with a useful message.
  let receivedBuffer: Buffer | null = null;

  const outcome = await recognizeBetSlipScreenshot({
    buffer,
    intake: { mimeType: "image/jpeg" },
    provider: fakeProvider((input) => {
      receivedBuffer = input.buffer;
      return ocrSuccess();
    }),
    detectRegion: fakeDetectRegion({
      kind: "FOUND",
      region: paddedRegion!,
      confidence: 0.9,
      reason: "express legs region",
      durationMs: 3,
    }),
  });

  assert.equal(outcome.kind, "OCR_RESULT");
  assert.equal(outcome.kind === "OCR_RESULT" && outcome.ocrResult.kind, "SUCCESS");

  assert.ok(receivedBuffer !== null);
  const meta = await sharp(receivedBuffer!).metadata();
  const rawWidthPx = rawBox.width * width;
  const rawHeightPx = rawBox.height * height;
  assert.ok((meta.width ?? 0) > rawWidthPx, "the padded crop should be wider than the raw, unpadded region");
  assert.ok((meta.height ?? 0) > rawHeightPx, "the padded crop should be taller than the raw, unpadded region");
});

// ---------------------------------------------------------------------
// 4. Invalid bounding box — rejected/clamped, original-image fallback
// ---------------------------------------------------------------------

test("recognizeBetSlipScreenshot: an INVALID region outcome falls back to the original, uncropped buffer", async () => {
  const buffer = await solidImage(1800, 1100);
  let receivedBuffer: Buffer | null = null;

  const outcome = await recognizeBetSlipScreenshot({
    buffer,
    intake: { mimeType: "image/jpeg" },
    provider: fakeProvider((input) => {
      receivedBuffer = input.buffer;
      return ocrSuccess();
    }),
    detectRegion: fakeDetectRegion({ kind: "INVALID", reason: "degenerate box", durationMs: 3 }),
  });

  assert.equal(outcome.kind, "OCR_RESULT");
  assert.deepEqual(receivedBuffer, buffer);
  assert.equal(outcome.kind === "OCR_RESULT" && outcome.diagnostics.regionDetection.outcome, "region_invalid");
});

// ---------------------------------------------------------------------
// 5. Region not found — original-image fallback
// ---------------------------------------------------------------------

test("recognizeBetSlipScreenshot: a NOT_FOUND region outcome falls back to the original, uncropped buffer", async () => {
  const buffer = await solidImage(1800, 1100);
  let receivedBuffer: Buffer | null = null;

  const outcome = await recognizeBetSlipScreenshot({
    buffer,
    intake: { mimeType: "image/jpeg" },
    provider: fakeProvider((input) => {
      receivedBuffer = input.buffer;
      return ocrSuccess();
    }),
    detectRegion: fakeDetectRegion({ kind: "NOT_FOUND", reason: "nothing here", durationMs: 3 }),
  });

  assert.equal(outcome.kind, "OCR_RESULT");
  assert.deepEqual(receivedBuffer, buffer);
  assert.equal(outcome.kind === "OCR_RESULT" && outcome.diagnostics.regionDetection.outcome, "region_not_found");
});

// ---------------------------------------------------------------------
// 6. Region detection timeout — request does not hang, falls back
// ---------------------------------------------------------------------

test("recognizeBetSlipScreenshot: a TIMEOUT region outcome does not hang the request and falls back to full-image OCR", async () => {
  const buffer = await solidImage(1800, 1100);

  const startedAt = Date.now();
  const outcome = await recognizeBetSlipScreenshot({
    buffer,
    intake: { mimeType: "image/jpeg" },
    provider: fakeProvider(() => ocrSuccess()),
    detectRegion: fakeDetectRegion({ kind: "TIMEOUT", durationMs: 12000 }),
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(outcome.kind, "OCR_RESULT");
  assert.equal(outcome.kind === "OCR_RESULT" && outcome.diagnostics.regionDetection.outcome, "region_timeout");
  // The fake detectRegion resolves immediately (it's not a real 12s wait) —
  // this proves the orchestrator itself adds no additional blocking wait
  // on top of whatever detectRegion took.
  assert.ok(elapsedMs < 2000);
});

test("recognizeBetSlipScreenshot: an ERROR region outcome (and a throwing detectRegion) both fall back safely", async () => {
  const buffer = await solidImage(1800, 1100);

  const errorOutcome = await recognizeBetSlipScreenshot({
    buffer,
    intake: { mimeType: "image/jpeg" },
    provider: fakeProvider(() => ocrSuccess()),
    detectRegion: fakeDetectRegion({ kind: "ERROR", durationMs: 3 }),
  });
  assert.equal(errorOutcome.kind, "OCR_RESULT");

  const throwingOutcome = await recognizeBetSlipScreenshot({
    buffer,
    intake: { mimeType: "image/jpeg" },
    provider: fakeProvider(() => ocrSuccess()),
    detectRegion: async () => {
      throw new Error("unexpected crash");
    },
  });
  assert.equal(throwingOutcome.kind, "OCR_RESULT");
  assert.equal(throwingOutcome.kind === "OCR_RESULT" && throwingOutcome.ocrResult.kind, "SUCCESS");
});

// ---------------------------------------------------------------------
// 8. Oversized image — rejected before any Claude call
// ---------------------------------------------------------------------

test("recognizeBetSlipScreenshot: an image exceeding MAX_IMAGE_DIMENSION_PX is rejected with IMAGE_TOO_LARGE before OCR or region detection run", async () => {
  const buffer = await sharp({ create: { width: 6500, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .jpeg({ quality: 1 })
    .toBuffer();

  let ocrCalled = false;
  let detectRegionCalled = false;

  const outcome = await recognizeBetSlipScreenshot({
    buffer,
    intake: { mimeType: "image/jpeg" },
    provider: fakeProvider(() => {
      ocrCalled = true;
      return ocrSuccess();
    }),
    detectRegion: async () => {
      detectRegionCalled = true;
      return { kind: "NOT_FOUND", reason: "n/a", durationMs: 1 };
    },
  });

  assert.equal(outcome.kind, "IMAGE_TOO_LARGE");
  assert.equal(ocrCalled, false);
  assert.equal(detectRegionCalled, false);
  assert.equal(outcome.kind === "IMAGE_TOO_LARGE" && outcome.diagnostics.imageWidth, 6500);
});

test("recognizeBetSlipScreenshot: a normal, non-oversized image is never rejected as too large", async () => {
  const buffer = await solidImage(1920, 1080);
  const outcome = await recognizeBetSlipScreenshot({
    buffer,
    intake: { mimeType: "image/jpeg" },
    provider: fakeProvider(() => ocrSuccess()),
    detectRegion: fakeDetectRegion({ kind: "NOT_FOUND", reason: "n/a", durationMs: 1 }),
  });
  assert.equal(outcome.kind, "OCR_RESULT");
});
