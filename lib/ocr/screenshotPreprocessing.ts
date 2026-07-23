import sharp from "sharp";

// New module — image-dimension inspection, region cropping, and the small
// "detection copy" resize used before asking a vision model where the
// betting content is. Nothing here knows about Claude, Telegram, or bet
// parsing; it only operates on buffers and pixel geometry, same "narrow
// primitive" convention as the rest of lib/ocr/ (see ocrTypes.ts's header
// comment). sharp is already an optional dependency of Next.js itself
// (used for its built-in image optimization, confirmed present in this
// project's node_modules and pinned by next's own package.json) and has
// prebuilt binaries for Vercel's Linux runtime — added here as a direct
// dependency rather than relying on that transitive install.

// A real cropped bet-slip screenshot (phone photo, cropped browser region,
// a bookmaker app screenshot) is essentially never this large on either
// side. A full desktop screenshot including OS chrome/other windows
// virtually always is — this matches the task's own stated example
// ("resolution around 1500x1000 or larger"). A full-height, uncropped
// mobile screenshot (e.g. 1080x2400) also legitimately exceeds this on one
// side, which is intentional: region detection still helps there (it crops
// out the status bar/nav chrome around the actual app content).
export const LARGE_SCREENSHOT_MIN_DIMENSION_PX = 1400;

// Defense against a decompression-bomb-style upload (a small, heavily
// compressed file that decodes to an enormous pixel grid) — sharp has its
// own built-in ~268-megapixel default ceiling that would eventually throw,
// but this is a much tighter, deliberate limit sized for "any real
// screenshot", checked immediately after reading metadata and before any
// resize/crop is attempted.
export const MAX_IMAGE_DIMENSION_PX = 6000;

// The image handed to the region-detection model — small on purpose (faster
// upload, fewer tokens, faster model turnaround) since only approximate
// normalized coordinates are needed from it, never pixel-perfect detail.
// The actual crop is always taken from the original, full-resolution
// buffer (see cropToRegion below), so this downscaling never affects the
// text quality the OCR stage ultimately sees.
const DETECTION_COPY_MAX_DIMENSION_PX = 1024;
const DETECTION_COPY_JPEG_QUALITY = 70;

// Padding added around a detected region before cropping, as a fraction of
// the *detected region's own* width/height — proportional rather than a
// fixed pixel margin, so a small tight box and a large loose box both keep
// a sensible amount of surrounding context (odds columns, team names,
// match time) without the padding becoming negligible or excessive at
// either extreme.
export const REGION_PADDING_FRACTION = 0.08;

// A detected region smaller than this fraction of the image, on either
// axis, is treated as unusable rather than cropped — indistinguishable in
// practice from a model mistake (e.g. a stray UI icon), and cropping to it
// would very likely cut off the actual bet content it was supposed to
// isolate.
export const MIN_REGION_FRACTION = 0.05;

// Cap on the crop's own longest side before it's sent to the OCR stage.
// 1568px matches Anthropic's own documented long-side sweet spot for
// Claude's vision input — larger images are downscaled server-side by the
// API anyway before the model ever sees them, so pre-shrinking here avoids
// paying to upload/encode pixels that would just be thrown away, without
// ever *upscaling* a smaller crop (upscaling would blur text, not help
// read it).
const CROP_MAX_DIMENSION_PX = 1568;
const CROP_JPEG_QUALITY = 92;

export interface ImageDimensions {
  width: number;
  height: number;
}

// null return (not a throw) — a caller with a corrupt/unreadable file
// still needs to decide what to do next (screenshot-preview's orchestrator
// maps this to IMAGE_DECODE_FAILED); the raw sharp error itself is never
// propagated (it can include internal library detail that has no business
// reaching a client-facing error).
export async function readImageDimensions(buffer: Buffer): Promise<ImageDimensions | null> {
  try {
    const metadata = await sharp(buffer).metadata();
    if (!metadata.width || !metadata.height || metadata.width <= 0 || metadata.height <= 0) {
      return null;
    }
    return { width: metadata.width, height: metadata.height };
  } catch {
    return null;
  }
}

export function exceedsMaxDimension(dimensions: ImageDimensions): boolean {
  return dimensions.width > MAX_IMAGE_DIMENSION_PX || dimensions.height > MAX_IMAGE_DIMENSION_PX;
}

// The one heuristic deciding whether the extra region-detection round trip
// is even attempted. Deliberately simple (a single threshold on either
// side) and named so the reasoning is visible at the call site, not a bare
// inline comparison.
export function looksLikeFullScreenScreenshot(dimensions: ImageDimensions): boolean {
  return (
    dimensions.width >= LARGE_SCREENSHOT_MIN_DIMENSION_PX || dimensions.height >= LARGE_SCREENSHOT_MIN_DIMENSION_PX
  );
}

// Resizes down (never up — `withoutEnlargement`) for the detection-only
// call. Re-encoded as JPEG regardless of the original format: the
// detection model only ever needs to *locate* the betting content, not
// transcribe it, so JPEG's smaller payload is a clear win and there is no
// text-fidelity requirement to protect here (unlike the actual OCR crop).
export async function createDetectionCopy(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(DETECTION_COPY_MAX_DIMENSION_PX, DETECTION_COPY_MAX_DIMENSION_PX, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: DETECTION_COPY_JPEG_QUALITY })
    .toBuffer();
}

export interface NormalizedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Pure geometry — no I/O, no model call, fully unit-testable on its own.
// Takes a raw (untrusted) region straight from the model's tool call and
// either returns a safe, padded, in-bounds region, or null when the input
// is too degenerate to safely use (in which case the caller falls back to
// the original, uncropped image — Step 2C's explicit "do not fail solely
// because region detection failed").
//
// Two different kinds of "wrong" are handled differently, deliberately:
//
// - Negative x/y, non-positive width/height, and non-finite values are
//   rejected outright (return null) — these describe a response that is
//   fundamentally nonsensical (a region starting before the image even
//   begins, or with no area at all), not a plausible detection that merely
//   needs adjusting.
// - A box that extends past the image's own *far* edge (x+width > 1 or
//   y+height > 1) is clamped (shrunk), not rejected — this is the common,
//   benign case of a model's approximate percentage slightly overshooting
//   one edge, and throwing away an otherwise-good detection over it would
//   defeat the point of region detection more often than it protects
//   anything.
//
// After clamping, padding is added, and the padded box is clamped *again*
// (padding can itself push it back out of bounds) before the minimum-size
// floor is applied as the final accept/reject gate.
export function clampAndPadRegion(raw: NormalizedRegion): NormalizedRegion | null {
  if (
    !Number.isFinite(raw.x) ||
    !Number.isFinite(raw.y) ||
    !Number.isFinite(raw.width) ||
    !Number.isFinite(raw.height)
  ) {
    return null;
  }

  if (raw.x < 0 || raw.y < 0) return null;
  if (raw.width <= 0 || raw.height <= 0) return null;
  if (raw.x >= 1 || raw.y >= 1) return null;

  const x0 = raw.x;
  const y0 = raw.y;
  // Shrink (never grow) width/height so the box never extends past the
  // image's own right/bottom edge — a safe clamp, not a rejection (see the
  // header comment above).
  const width0 = clamp01(Math.min(raw.width, 1 - x0));
  const height0 = clamp01(Math.min(raw.height, 1 - y0));

  if (width0 <= 0 || height0 <= 0) return null;

  const padX = width0 * REGION_PADDING_FRACTION;
  const padY = height0 * REGION_PADDING_FRACTION;

  const paddedX = clamp01(x0 - padX);
  const paddedY = clamp01(y0 - padY);
  const paddedRight = clamp01(x0 + width0 + padX);
  const paddedBottom = clamp01(y0 + height0 + padY);

  const finalWidth = paddedRight - paddedX;
  const finalHeight = paddedBottom - paddedY;

  if (finalWidth < MIN_REGION_FRACTION || finalHeight < MIN_REGION_FRACTION) {
    return null;
  }

  return { x: paddedX, y: paddedY, width: finalWidth, height: finalHeight };
}

// Crops the *original*, full-resolution buffer (never the small detection
// copy) so OCR always sees the sharpest available pixels for the region.
// Only downscales afterward, and only if the crop itself is still larger
// than a vision-friendly ceiling (see CROP_MAX_DIMENSION_PX above) — a
// small crop is left exactly as-is, per Step 2B's "resize the cropped
// region only when necessary".
export async function cropToRegion(
  buffer: Buffer,
  region: NormalizedRegion,
  original: ImageDimensions,
): Promise<Buffer> {
  const left = Math.round(region.x * original.width);
  const top = Math.round(region.y * original.height);
  // Recompute from the image's own bounds rather than trusting
  // round(width*original.width) not to push left+width past the edge —
  // clampAndPadRegion already guarantees region fits within [0,1], but
  // rounding each corner independently can still overshoot by a pixel.
  const right = Math.min(original.width, Math.round((region.x + region.width) * original.width));
  const bottom = Math.min(original.height, Math.round((region.y + region.height) * original.height));

  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);

  return sharp(buffer)
    .extract({ left, top, width, height })
    .resize(CROP_MAX_DIMENSION_PX, CROP_MAX_DIMENSION_PX, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: CROP_JPEG_QUALITY })
    .toBuffer();
}
