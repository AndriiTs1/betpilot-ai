import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import type { ParsedBetSlip } from "./betSlip";
import type { BetSlipPreview } from "./buildBetSlipPreview";

// Stage 4.2B3 — the service layer for prisma/schema.prisma's own
// ScreenshotRecognition/ScreenshotVerification models; see those models'
// comments for the full architecture rationale. This file owns exactly
// four operations (find/create for each model) and nothing else — it never
// calls OCR, the AI parser, or buildBetSlipPreview() itself; the caller
// (app/api/miniapp/bets/screenshot/preview/route.ts) decides WHEN to call
// those existing, unmodified functions and only hands this service their
// already-produced results to persist.

// Deliberately independent of, and larger than, oddsVerifier.ts's own 45s
// process-level provider cache (Stage 3) — that cache is about not
// hammering The Odds API within a single request/short window; this TTL is
// a product-level "how stale may a shown price be" decision. Comfortably
// shorter than lib/betPreview/previewToken.ts's own 180s (TTL_SECONDS)
// token expiry, so a verification reused at the very edge of this TTL still
// carries a token with time left on it — never silently serves an
// already-expired token.
export const VERIFICATION_TTL_MS = 60_000;

export interface ScreenshotRecognitionRecord {
  readonly id: string;
  readonly playerId: string;
  readonly imageHash: string;
  readonly parsedBet: ParsedBetSlip;
  readonly ocrText: string | null;
  readonly createdAt: Date;
}

export interface ScreenshotVerificationRecord {
  readonly id: string;
  readonly recognitionId: string;
  readonly preview: BetSlipPreview;
  readonly previewToken: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

// P2002 = unique constraint violation. This service's only create() call
// with a unique constraint that can collide is ScreenshotRecognition's own
// @@unique([playerId, imageHash]) (`id` is a server-generated cuid, never
// client-supplied, so it can't collide) — same "code + meta.modelName"
// detection convention as lib/bets/createBetFromPreview.ts's
// isPreviewIdUniqueViolation, confirmed against this codebase's actual
// Prisma 7.8 + Neon adapter error shape.
function isRecognitionUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002" &&
    err.meta?.modelName === "ScreenshotRecognition"
  );
}

/* -------------------------------------------------------------------------- */
/* Recognition — immutable                                                    */
/* -------------------------------------------------------------------------- */

// Read-only lookup. Never creates, never mutates.
export async function findScreenshotRecognition(
  db: PrismaClient,
  playerId: string,
  imageHash: string,
): Promise<ScreenshotRecognitionRecord | null> {
  const row = await db.screenshotRecognition.findUnique({
    where: { playerId_imageHash: { playerId, imageHash } },
  });
  if (!row) return null;
  return {
    id: row.id,
    playerId: row.playerId,
    imageHash: row.imageHash,
    parsedBet: row.parsedBet as unknown as ParsedBetSlip,
    ocrText: row.ocrText,
    createdAt: row.createdAt,
  };
}

// Creates a new immutable recognition row — OR, if a concurrent request for
// the exact same (playerId, imageHash) pair already won the race, returns
// THAT row instead of throwing or creating a duplicate. The database's own
// unique constraint is the actual concurrency guard; this function only
// reacts to the conflict it produces (same "guarded create + re-read"
// idiom as lib/bets/createBetFromPreview.ts's previewId handling). Never
// called for a failed OCR/parse — only the caller decides a recognition is
// worth persisting, by not calling this until it has a real ParsedBetSlip.
export async function createScreenshotRecognition(
  db: PrismaClient,
  input: { playerId: string; imageHash: string; parsedBet: ParsedBetSlip; ocrText: string | null },
): Promise<ScreenshotRecognitionRecord> {
  try {
    const row = await db.screenshotRecognition.create({
      data: {
        playerId: input.playerId,
        imageHash: input.imageHash,
        parsedBet: input.parsedBet as unknown as Prisma.InputJsonValue,
        ocrText: input.ocrText,
      },
    });
    return {
      id: row.id,
      playerId: row.playerId,
      imageHash: row.imageHash,
      parsedBet: input.parsedBet,
      ocrText: row.ocrText,
      createdAt: row.createdAt,
    };
  } catch (err) {
    if (!isRecognitionUniqueViolation(err)) throw err;

    // Lost the race — the winning request's row must exist; re-read it
    // rather than fabricating a result from our own (discarded) OCR output.
    const existing = await findScreenshotRecognition(db, input.playerId, input.imageHash);
    if (!existing) throw err;
    return existing;
  }
}

/* -------------------------------------------------------------------------- */
/* Verification — versioned, TTL-bound                                        */
/* -------------------------------------------------------------------------- */

// The most recent verification for this recognition that has NOT yet
// expired, or null if none exists yet or the latest one has expired.
// Ordering by createdAt desc + take-first (rather than a single indexed
// lookup) is deliberate: verifications are intentionally multi-valued per
// recognition (a new row every TTL expiry / Refresh Odds), never updated in
// place — "the current one" is always "the newest one still valid", not a
// distinguished row.
export async function findFreshScreenshotVerification(
  db: PrismaClient,
  recognitionId: string,
  now: Date,
): Promise<ScreenshotVerificationRecord | null> {
  const row = await db.screenshotVerification.findFirst({
    where: { recognitionId, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  return {
    id: row.id,
    recognitionId: row.recognitionId,
    preview: row.preview as unknown as BetSlipPreview,
    previewToken: row.previewToken,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

// Always creates a new row — never updates an existing one (see this
// model's own schema comment on why "new row" is the only mutation this
// service ever performs for Verification). No conflict handling is needed
// here: nothing about this insert can violate a unique constraint (there
// isn't one), so two concurrent refreshes simply produce two valid,
// harmless rows — the next read picks whichever is newest.
export async function createScreenshotVerification(
  db: PrismaClient,
  input: {
    recognitionId: string;
    preview: BetSlipPreview;
    previewToken: string | null;
    now: Date;
    ttlMs?: number;
  },
): Promise<ScreenshotVerificationRecord> {
  const ttlMs = input.ttlMs ?? VERIFICATION_TTL_MS;
  const expiresAt = new Date(input.now.getTime() + ttlMs);

  const row = await db.screenshotVerification.create({
    data: {
      recognitionId: input.recognitionId,
      preview: input.preview as unknown as Prisma.InputJsonValue,
      previewToken: input.previewToken,
      // Explicit, not left to the schema's @default(now()) — createdAt must
      // be derived from the SAME `now` expiresAt is computed from, so
      // ordering ("the newest verification") is governed by the caller's
      // clock, not an independent DB-side timestamp that could tie or
      // disagree with it under fast/concurrent calls.
      createdAt: input.now,
      expiresAt,
    },
  });

  return {
    id: row.id,
    recognitionId: row.recognitionId,
    preview: input.preview,
    previewToken: row.previewToken,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
