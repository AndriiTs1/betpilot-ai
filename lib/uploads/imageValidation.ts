// Stage 14.4A — extracted, unchanged, from
// app/api/miniapp/bets/screenshot/preview/route.ts (Stage 4.5B) so the new
// operator debug route (Stage 14.4A, Part E) can reuse the exact same
// upload validation instead of duplicating it. Pure extraction: no
// behavior change, no new validation rule.

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export type AllowedMimeType = "image/jpeg" | "image/png" | "image/webp";

export const ALLOWED_MIME_TYPES: ReadonlySet<AllowedMimeType> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Real byte-signature check, run after the MIME allow-list check — a
// client can freely lie about a multipart part's declared Content-Type,
// this can't be. Only checks the handful of leading bytes each format
// requires; no image-processing package, no attempt to decode the image.
export function detectImageSignature(bytes: Uint8Array): AllowedMimeType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50 // "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}
