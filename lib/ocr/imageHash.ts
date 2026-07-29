import { createHash } from "node:crypto";

// Stage 4.2B2 — pure SHA-256 over the raw, unmodified image bytes exactly
// as received, before any OCR/region-detection/crop/normalization ever
// touches them. Same algorithm, same function, called at the same point
// (immediately after the raw bytes are obtained) regardless of source —
// Mini App multipart upload, Telegram file download, the operator debug
// route, or any future source — so "was this the same image" becomes a
// provable, diagnosable fact instead of a guess (see Stage 4.2A's own
// "IDENTICAL_INPUT_NOT_PROVABLE" finding).
//
// Deliberately does nothing else: no persistence, no Prisma model, no
// database write, no change to the bytes it hashes, no decision-making.
// Purely additive observability — this stage's own scope boundary.
export function computeImageHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
