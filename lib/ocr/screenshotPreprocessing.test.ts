import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  readImageDimensions,
  exceedsMaxDimension,
  looksLikeFullScreenScreenshot,
  createDetectionCopy,
  cropToRegion,
  clampAndPadRegion,
  MAX_IMAGE_DIMENSION_PX,
  LARGE_SCREENSHOT_MIN_DIMENSION_PX,
  MIN_REGION_FRACTION,
} from "./screenshotPreprocessing";

function solidImage(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .jpeg()
    .toBuffer();
}

// ---------------------------------------------------------------------
// readImageDimensions
// ---------------------------------------------------------------------

test("readImageDimensions: returns the real width/height of a decodable image", async () => {
  const buffer = await solidImage(320, 240);
  const dims = await readImageDimensions(buffer);
  assert.deepEqual(dims, { width: 320, height: 240 });
});

test("readImageDimensions: returns null for a buffer sharp cannot decode, never throws", async () => {
  const dims = await readImageDimensions(Buffer.from("not an image"));
  assert.equal(dims, null);
});

test("readImageDimensions: returns null for an empty buffer", async () => {
  const dims = await readImageDimensions(Buffer.alloc(0));
  assert.equal(dims, null);
});

// ---------------------------------------------------------------------
// exceedsMaxDimension / looksLikeFullScreenScreenshot
// ---------------------------------------------------------------------

test("exceedsMaxDimension: false for a normal screenshot", () => {
  assert.equal(exceedsMaxDimension({ width: 1920, height: 1080 }), false);
});

test("exceedsMaxDimension: true when either axis exceeds the ceiling", () => {
  assert.equal(exceedsMaxDimension({ width: MAX_IMAGE_DIMENSION_PX + 1, height: 100 }), true);
  assert.equal(exceedsMaxDimension({ width: 100, height: MAX_IMAGE_DIMENSION_PX + 1 }), true);
});

test("exceedsMaxDimension: exactly at the ceiling is not exceeding it", () => {
  assert.equal(exceedsMaxDimension({ width: MAX_IMAGE_DIMENSION_PX, height: MAX_IMAGE_DIMENSION_PX }), false);
});

test("looksLikeFullScreenScreenshot: false for a typical cropped bet-slip screenshot", () => {
  assert.equal(looksLikeFullScreenScreenshot({ width: 480, height: 800 }), false);
});

test("looksLikeFullScreenScreenshot: true at/above the threshold on either axis", () => {
  assert.equal(looksLikeFullScreenScreenshot({ width: LARGE_SCREENSHOT_MIN_DIMENSION_PX, height: 200 }), true);
  assert.equal(looksLikeFullScreenScreenshot({ width: 200, height: LARGE_SCREENSHOT_MIN_DIMENSION_PX }), true);
});

test("looksLikeFullScreenScreenshot: true for the task's own example resolution (1500x1000)", () => {
  assert.equal(looksLikeFullScreenScreenshot({ width: 1500, height: 1000 }), true);
});

// ---------------------------------------------------------------------
// clampAndPadRegion — pure geometry, the core safety net
// ---------------------------------------------------------------------

test("clampAndPadRegion: a well-formed region is padded and stays in bounds", () => {
  const region = clampAndPadRegion({ x: 0.3, y: 0.3, width: 0.2, height: 0.2 });
  assert.ok(region);
  assert.ok(region!.x < 0.3, "left edge should move outward (padding)");
  assert.ok(region!.y < 0.3, "top edge should move outward (padding)");
  assert.ok(region!.width > 0.2, "padding should widen the box");
  assert.ok(region!.height > 0.2, "padding should heighten the box");
  assert.ok(region!.x >= 0 && region!.y >= 0);
  assert.ok(region!.x + region!.width <= 1 + 1e-9);
  assert.ok(region!.y + region!.height <= 1 + 1e-9);
});

test("clampAndPadRegion: negative coordinates are rejected", () => {
  assert.equal(clampAndPadRegion({ x: -0.1, y: 0.1, width: 0.2, height: 0.2 }), null);
});

test("clampAndPadRegion: negative width/height is rejected", () => {
  assert.equal(clampAndPadRegion({ x: 0.1, y: 0.1, width: -0.2, height: 0.2 }), null);
  assert.equal(clampAndPadRegion({ x: 0.1, y: 0.1, width: 0.2, height: -0.2 }), null);
});

test("clampAndPadRegion: zero width or height is rejected", () => {
  assert.equal(clampAndPadRegion({ x: 0.1, y: 0.1, width: 0, height: 0.2 }), null);
  assert.equal(clampAndPadRegion({ x: 0.1, y: 0.1, width: 0.2, height: 0 }), null);
});

test("clampAndPadRegion: non-finite values (NaN, Infinity) are rejected", () => {
  assert.equal(clampAndPadRegion({ x: NaN, y: 0.1, width: 0.2, height: 0.2 }), null);
  assert.equal(clampAndPadRegion({ x: 0.1, y: 0.1, width: Infinity, height: 0.2 }), null);
  assert.equal(clampAndPadRegion({ x: 0.1, y: -Infinity, width: 0.2, height: 0.2 }), null);
});

test("clampAndPadRegion: a region extending past the image's right/bottom edge is safely clamped, not rejected", () => {
  const region = clampAndPadRegion({ x: 0.8, y: 0.8, width: 0.5, height: 0.5 });
  assert.ok(region, "an out-of-bounds-but-otherwise-sane box should be clamped, not rejected");
  assert.ok(region!.x + region!.width <= 1 + 1e-9);
  assert.ok(region!.y + region!.height <= 1 + 1e-9);
});

test("clampAndPadRegion: a region entirely outside [0,1] (x/y >= 1) is rejected as degenerate", () => {
  assert.equal(clampAndPadRegion({ x: 1, y: 1, width: 0.5, height: 0.5 }), null);
});

test("clampAndPadRegion: an extremely small region is rejected even after padding", () => {
  assert.equal(clampAndPadRegion({ x: 0.5, y: 0.5, width: 0.001, height: 0.001 }), null);
});

test("clampAndPadRegion: a region right at the minimum fraction survives", () => {
  const region = clampAndPadRegion({ x: 0.5, y: 0.5, width: MIN_REGION_FRACTION * 2, height: MIN_REGION_FRACTION * 2 });
  assert.ok(region);
});

test("clampAndPadRegion: a full-image region (0,0,1,1) is accepted and stays within bounds", () => {
  const region = clampAndPadRegion({ x: 0, y: 0, width: 1, height: 1 });
  assert.ok(region);
  assert.ok(region!.x >= 0);
  assert.ok(region!.y >= 0);
  assert.ok(region!.x + region!.width <= 1 + 1e-9);
  assert.ok(region!.y + region!.height <= 1 + 1e-9);
});

// ---------------------------------------------------------------------
// createDetectionCopy / cropToRegion — real sharp integration
// ---------------------------------------------------------------------

test("createDetectionCopy: downscales a large image and never upscales a small one", async () => {
  const large = await solidImage(3000, 2000);
  const copy = await createDetectionCopy(large);
  const meta = await sharp(copy).metadata();
  assert.ok((meta.width ?? 0) <= 1024 && (meta.height ?? 0) <= 1024);

  const small = await solidImage(200, 100);
  const smallCopy = await createDetectionCopy(small);
  const smallMeta = await sharp(smallCopy).metadata();
  assert.equal(smallMeta.width, 200);
  assert.equal(smallMeta.height, 100);
});

test("cropToRegion: crops the original at full resolution, matching the region's fraction of the real dimensions", async () => {
  const original = await solidImage(2000, 1000);
  const region = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };

  const cropped = await cropToRegion(original, region, { width: 2000, height: 1000 });
  const meta = await sharp(cropped).metadata();

  // 0.5 * 2000 = 1000, 0.5 * 1000 = 500 — well under CROP_MAX_DIMENSION_PX,
  // so no further downscaling should occur.
  assert.equal(meta.width, 1000);
  assert.equal(meta.height, 500);
});

test("cropToRegion: downscales the crop when it exceeds the vision-friendly ceiling, preserving aspect ratio", async () => {
  const original = await solidImage(4000, 3000);
  // A crop of 3600x2700 — larger than the 1568px ceiling on both axes.
  const region = { x: 0, y: 0, width: 0.9, height: 0.9 };

  const cropped = await cropToRegion(original, region, { width: 4000, height: 3000 });
  const meta = await sharp(cropped).metadata();

  assert.ok((meta.width ?? 0) <= 1568);
  assert.ok((meta.height ?? 0) <= 1568);
  // Aspect ratio preserved (4:3 source region -> 4:3 output, within rounding).
  const ratio = (meta.width ?? 0) / (meta.height ?? 1);
  assert.ok(Math.abs(ratio - 4 / 3) < 0.02);
});

test("cropToRegion: never crops past the original image's own bounds even from a region touching the edge", async () => {
  const original = await solidImage(1000, 1000);
  const region = { x: 0.9, y: 0.9, width: 0.1, height: 0.1 };

  const cropped = await cropToRegion(original, region, { width: 1000, height: 1000 });
  // Must not throw (sharp's extract() throws if the requested rect exceeds
  // the source image bounds) — resolving at all is the assertion.
  const meta = await sharp(cropped).metadata();
  assert.ok((meta.width ?? 0) > 0);
  assert.ok((meta.height ?? 0) > 0);
});
