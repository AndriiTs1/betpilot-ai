import type { ScreenshotIntake } from "@/lib/telegram/screenshotIntake";
import { recognizeScreenshot } from "./recognizeScreenshot";
import { detectBettingRegion, type RegionDetectionOutcome } from "./regionDetection";
import {
  readImageDimensions,
  exceedsMaxDimension,
  looksLikeFullScreenScreenshot,
  createDetectionCopy,
  cropToRegion,
  type ImageDimensions,
} from "./screenshotPreprocessing";
import type { OcrProvider, OcrResult } from "./ocrTypes";

// New module — the adaptive entry point in front of the existing,
// unmodified recognizeScreenshot()/claudeOcrProvider.ts pipeline. This file
// decides *what buffer* gets OCR'd (the original upload, or a region
// detected and cropped from it); it never changes how OCR itself works.
// A cropped bet-slip screenshot's existing successful path is unaffected:
// small (or undecodable-by-sharp) images skip region detection entirely
// and reach recognizeScreenshot() with the exact same buffer/mimeType as
// before this module existed.

export type RegionDetectionSummary =
  | { outcome: "skipped_small_image" }
  | { outcome: "region_found"; confidence: number }
  | { outcome: "region_not_found" }
  | { outcome: "region_invalid" }
  | { outcome: "region_timeout" }
  | { outcome: "region_error" };

export interface ScreenshotPipelineDiagnostics {
  imageWidth: number | null;
  imageHeight: number | null;
  // true when sharp could not read basic metadata from the buffer at all
  // (corrupt/truncated file, or — in tests — a synthetic fixture that only
  // has a valid magic-number prefix). This is a *log-only* signal, never a
  // request failure: without dimensions, the size-based region-detection
  // heuristic simply can't be applied, so the pipeline falls back to
  // exactly the pre-existing behavior (plain OCR on the original buffer).
  // Whether the image is actually usable is still decided the same way it
  // always was — by the OCR call itself.
  metadataDecodeFailed: boolean;
  metadataMs: number;
  regionDetection: RegionDetectionSummary;
  regionDetectionMs: number | null;
  cropMs: number | null;
}

export type RecognizeBetSlipScreenshotOutcome =
  // A hard stop before any Claude call is made, mirroring the existing
  // upload-validation rejections (FILE_TOO_LARGE, INVALID_IMAGE_SIGNATURE)
  // in spirit — but only fires when dimensions were actually, successfully
  // read and are genuinely oversized; a failure to read dimensions at all
  // never reaches this branch (see metadataDecodeFailed above).
  | { kind: "IMAGE_TOO_LARGE"; diagnostics: ScreenshotPipelineDiagnostics }
  | { kind: "OCR_RESULT"; ocrResult: OcrResult; diagnostics: ScreenshotPipelineDiagnostics };

export interface RecognizeBetSlipScreenshotParams {
  buffer: Buffer;
  intake: Pick<ScreenshotIntake, "mimeType" | "originalFilename">;
  provider: OcrProvider;
  ocrTimeoutMs?: number;
  // Injectable so tests can control region-detection behavior (found,
  // not-found, invalid, timeout, error) without a real Claude call — same
  // DI shape as the `provider`/`ocrProvider` parameters used throughout
  // lib/ocr/ and the routes that call it.
  detectRegion?: typeof detectBettingRegion;
  regionDetectionTimeoutMs?: number;
}

const SKIPPED_REGION_DETECTION: RegionDetectionSummary = { outcome: "skipped_small_image" };

function summarizeRegionOutcome(outcome: RegionDetectionOutcome): RegionDetectionSummary {
  switch (outcome.kind) {
    case "FOUND":
      return { outcome: "region_found", confidence: outcome.confidence };
    case "NOT_FOUND":
      return { outcome: "region_not_found" };
    case "INVALID":
      return { outcome: "region_invalid" };
    case "TIMEOUT":
      return { outcome: "region_timeout" };
    case "ERROR":
      return { outcome: "region_error" };
  }
}

export async function recognizeBetSlipScreenshot(
  params: RecognizeBetSlipScreenshotParams,
): Promise<RecognizeBetSlipScreenshotOutcome> {
  const metadataStartedAt = Date.now();
  const dimensions: ImageDimensions | null = await readImageDimensions(params.buffer);
  const metadataMs = Date.now() - metadataStartedAt;

  const baseDiagnostics = {
    imageWidth: dimensions?.width ?? null,
    imageHeight: dimensions?.height ?? null,
    metadataDecodeFailed: dimensions === null,
    metadataMs,
  };

  if (dimensions && exceedsMaxDimension(dimensions)) {
    return {
      kind: "IMAGE_TOO_LARGE",
      diagnostics: { ...baseDiagnostics, regionDetection: SKIPPED_REGION_DETECTION, regionDetectionMs: null, cropMs: null },
    };
  }

  if (!dimensions || !looksLikeFullScreenScreenshot(dimensions)) {
    // The existing, unchanged cropped-slip path: no region-detection call,
    // no extra buffer — recognizeScreenshot() gets exactly what it always
    // got before this module existed. Also the fallback for a buffer sharp
    // couldn't read dimensions from at all (see metadataDecodeFailed doc).
    const ocrResult = await recognizeScreenshot({
      intake: params.intake,
      buffer: params.buffer,
      provider: params.provider,
      timeoutMs: params.ocrTimeoutMs,
    });
    return {
      kind: "OCR_RESULT",
      ocrResult,
      diagnostics: { ...baseDiagnostics, regionDetection: SKIPPED_REGION_DETECTION, regionDetectionMs: null, cropMs: null },
    };
  }

  // Large-image path — attempt region detection, but every failure mode
  // (bad crop, timeout, model error, no region found) falls through to
  // plain full-image OCR rather than failing the request (Step 2C).
  const detectRegion = params.detectRegion ?? detectBettingRegion;

  let regionDetectionMs: number | null = null;
  let cropMs: number | null = null;
  let regionSummary: RegionDetectionSummary = SKIPPED_REGION_DETECTION;
  let bufferForOcr = params.buffer;
  let intakeForOcr = params.intake;

  try {
    const detectionCopy = await createDetectionCopy(params.buffer);

    const outcome = await detectRegion({
      buffer: detectionCopy,
      mimeType: "image/jpeg",
      timeoutMs: params.regionDetectionTimeoutMs,
    });
    regionDetectionMs = outcome.durationMs;
    regionSummary = summarizeRegionOutcome(outcome);

    if (outcome.kind === "FOUND") {
      const cropStartedAt = Date.now();
      const cropped = await cropToRegion(params.buffer, outcome.region, dimensions);
      cropMs = Date.now() - cropStartedAt;
      bufferForOcr = cropped;
      intakeForOcr = { ...params.intake, mimeType: "image/jpeg" };
    }
  } catch (err) {
    // Only reachable if createDetectionCopy/cropToRegion themselves throw
    // (an unexpected sharp failure on an image whose metadata we already
    // read successfully) — logged server-side only, never surfaced as a
    // request failure. The original buffer is still used for OCR below.
    console.error(
      "recognizeBetSlipScreenshot: region detection/crop failed:",
      err instanceof Error ? err.name : "unknown error",
    );
    regionSummary = { outcome: "region_error" };
  }

  const ocrResult = await recognizeScreenshot({
    intake: intakeForOcr,
    buffer: bufferForOcr,
    provider: params.provider,
    timeoutMs: params.ocrTimeoutMs,
  });

  return {
    kind: "OCR_RESULT",
    ocrResult,
    diagnostics: { ...baseDiagnostics, regionDetection: regionSummary, regionDetectionMs, cropMs },
  };
}
