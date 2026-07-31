import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  findScreenshotRecognition,
  createScreenshotRecognition,
  findFreshScreenshotVerification,
  createScreenshotVerification,
  VERIFICATION_TTL_MS,
} from "./screenshotRecognitionService";
import type { ParsedBetSlip } from "./betSlip";
import type { BetSlipPreview } from "./buildBetSlipPreview";

// ---------------------------------------------------------------------
// In-memory fake Prisma client — same hand-written, no-mocking-library
// convention as every other Prisma fake in this codebase.
// ---------------------------------------------------------------------

interface FakeRecognitionRow {
  id: string;
  playerId: string;
  imageHash: string;
  parsedBet: unknown;
  ocrText: string | null;
  createdAt: Date;
}

interface FakeVerificationRow {
  id: string;
  recognitionId: string;
  preview: unknown;
  previewToken: string | null;
  createdAt: Date;
  expiresAt: Date;
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { modelName: "ScreenshotRecognition" },
  });
}

function otherKnownError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Some other error", {
    code: "P2003",
    clientVersion: "test",
  });
}

function fakeDb(seed: { recognitions?: FakeRecognitionRow[]; verifications?: FakeVerificationRow[] } = {}) {
  const recognitions: FakeRecognitionRow[] = seed.recognitions ? [...seed.recognitions] : [];
  const verifications: FakeVerificationRow[] = seed.verifications ? [...seed.verifications] : [];
  let nextId = 1;
  let recognitionCreateAttempts = 0;
  // When true, the NEXT recognition create() call throws a unique
  // violation regardless of whether a real conflict exists — simulates
  // "a concurrent request committed between our own findUnique and our own
  // create", which a purely sequential seed can't otherwise reproduce.
  let injectConflictOnce = false;

  return {
    db: {
      screenshotRecognition: {
        findUnique: async ({
          where,
        }: {
          where: { playerId_imageHash: { playerId: string; imageHash: string } };
        }) => {
          const { playerId, imageHash } = where.playerId_imageHash;
          return recognitions.find((r) => r.playerId === playerId && r.imageHash === imageHash) ?? null;
        },
        create: async ({
          data,
        }: {
          data: { playerId: string; imageHash: string; parsedBet: unknown; ocrText: string | null };
        }) => {
          recognitionCreateAttempts += 1;
          if (injectConflictOnce) {
            injectConflictOnce = false;
            throw uniqueViolation();
          }
          const conflict = recognitions.find((r) => r.playerId === data.playerId && r.imageHash === data.imageHash);
          if (conflict) throw uniqueViolation();

          const row: FakeRecognitionRow = {
            id: `sr-${nextId++}`,
            playerId: data.playerId,
            imageHash: data.imageHash,
            parsedBet: data.parsedBet,
            ocrText: data.ocrText ?? null,
            createdAt: new Date(),
          };
          recognitions.push(row);
          return row;
        },
      },
      screenshotVerification: {
        findFirst: async ({
          where,
        }: {
          where: { recognitionId: string; expiresAt: { gt: Date } };
        }) => {
          const matches = verifications
            .filter((v) => v.recognitionId === where.recognitionId && v.expiresAt.getTime() > where.expiresAt.gt.getTime())
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return matches[0] ?? null;
        },
        create: async ({
          data,
        }: {
          data: { recognitionId: string; preview: unknown; previewToken: string | null; createdAt: Date; expiresAt: Date };
        }) => {
          const row: FakeVerificationRow = {
            id: `sv-${nextId++}`,
            recognitionId: data.recognitionId,
            preview: data.preview,
            previewToken: data.previewToken ?? null,
            createdAt: data.createdAt,
            expiresAt: data.expiresAt,
          };
          verifications.push(row);
          return row;
        },
      },
    } as unknown as PrismaClient,
    _debug: {
      recognitions,
      verifications,
      recognitionCreateAttempts: () => recognitionCreateAttempts,
      seedExistingRecognition: (row: FakeRecognitionRow) => recognitions.push(row),
      injectConflictOnRecognitionCreate: () => {
        injectConflictOnce = true;
      },
    },
  };
}

function sampleParsedBet(): ParsedBetSlip {
  return {
    type: "SINGLE",
    stake: 10,
    selections: [{ sport: "Football", event: "Team A vs Team B", market: null, selection: "Team A Win", submittedOdds: 1.9 }],
  };
}

function samplePreview(oddsStatus: "VERIFIED" | "ODDS_CHANGED" | "NOT_FOUND" | "UNAVAILABLE" = "VERIFIED"): BetSlipPreview {
  return {
    type: "SINGLE",
    stake: 10,
    totalOdds: 1.9,
    potentialWin: 19,
    selections: [
      {
        sport: "Football",
        event: "Team A vs Team B",
        market: null,
        selection: "Team A Win",
        submittedOdds: 1.9,
        currentOdds: 1.9,
        oddsStatus,
        bookmaker: "Pinnacle",
        discrepancyPercent: 0,
        homeTeamName: null,
        awayTeamName: null,
        competitionName: null,
        eventStartTime: null,
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* findScreenshotRecognition / createScreenshotRecognition                    */
/* -------------------------------------------------------------------------- */

test("findScreenshotRecognition: returns null when no row exists for this (playerId, imageHash)", async () => {
  const { db } = fakeDb();
  const result = await findScreenshotRecognition(db, "player-1", "hash-a");
  assert.equal(result, null);
});

test("createScreenshotRecognition: creates a new row and returns it with the exact parsedBet passed in", async () => {
  const { db, _debug } = fakeDb();
  const parsedBet = sampleParsedBet();

  const created = await createScreenshotRecognition(db, {
    playerId: "player-1",
    imageHash: "hash-a",
    parsedBet,
    ocrText: "some ocr text",
  });

  assert.equal(created.playerId, "player-1");
  assert.equal(created.imageHash, "hash-a");
  assert.deepEqual(created.parsedBet, parsedBet);
  assert.equal(created.ocrText, "some ocr text");
  assert.equal(_debug.recognitionCreateAttempts(), 1);
});

test("findScreenshotRecognition: finds a previously created row by the exact (playerId, imageHash) pair", async () => {
  const { db } = fakeDb();
  const parsedBet = sampleParsedBet();
  await createScreenshotRecognition(db, { playerId: "player-1", imageHash: "hash-a", parsedBet, ocrText: null });

  const found = await findScreenshotRecognition(db, "player-1", "hash-a");
  assert.ok(found);
  assert.deepEqual(found!.parsedBet, parsedBet);
});

test("findScreenshotRecognition: never cross-matches a different player with the same imageHash", async () => {
  const { db } = fakeDb();
  await createScreenshotRecognition(db, { playerId: "player-1", imageHash: "hash-a", parsedBet: sampleParsedBet(), ocrText: null });

  const foundForOtherPlayer = await findScreenshotRecognition(db, "player-2", "hash-a");
  assert.equal(foundForOtherPlayer, null);
});

test("findScreenshotRecognition: never cross-matches a different imageHash for the same player", async () => {
  const { db } = fakeDb();
  await createScreenshotRecognition(db, { playerId: "player-1", imageHash: "hash-a", parsedBet: sampleParsedBet(), ocrText: null });

  const foundForOtherHash = await findScreenshotRecognition(db, "player-1", "hash-b");
  assert.equal(foundForOtherHash, null);
});

test("createScreenshotRecognition: concurrency — a unique-constraint conflict recovers by re-reading the winning row instead of throwing", async () => {
  const { db, _debug } = fakeDb();

  const winningRow: FakeRecognitionRow = {
    id: "sr-winner",
    playerId: "player-1",
    imageHash: "hash-a",
    parsedBet: { type: "SINGLE", stake: 99, selections: [] },
    ocrText: "winner's own text",
    createdAt: new Date(),
  };
  _debug.seedExistingRecognition(winningRow);
  // Simulate: our own findUnique (done by the caller, not this function)
  // returned null a moment ago, but another request has since committed —
  // our create() must now hit the real conflict already seeded above.

  const result = await createScreenshotRecognition(db, {
    playerId: "player-1",
    imageHash: "hash-a",
    parsedBet: sampleParsedBet(), // our own (losing) OCR/parse output — must be discarded
    ocrText: "our own losing text",
  });

  assert.equal(result.id, "sr-winner");
  assert.deepEqual(result.parsedBet, winningRow.parsedBet);
  assert.equal(result.ocrText, "winner's own text");
  // No duplicate row was created.
  assert.equal(_debug.recognitions.length, 1);
});

test("createScreenshotRecognition: a conflict reported by the database but with no corresponding row is a genuine, unexpected error (rethrown)", async () => {
  const { db, _debug } = fakeDb();
  _debug.injectConflictOnRecognitionCreate();

  await assert.rejects(
    () => createScreenshotRecognition(db, { playerId: "player-1", imageHash: "hash-a", parsedBet: sampleParsedBet(), ocrText: null }),
    Prisma.PrismaClientKnownRequestError,
  );
});

test("createScreenshotRecognition: a non-unique-constraint database error propagates unchanged, never silently swallowed", async () => {
  const db = {
    screenshotRecognition: {
      create: async () => {
        throw otherKnownError();
      },
    },
  } as unknown as PrismaClient;

  await assert.rejects(
    () => createScreenshotRecognition(db, { playerId: "player-1", imageHash: "hash-a", parsedBet: sampleParsedBet(), ocrText: null }),
    (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003",
  );
});

/* -------------------------------------------------------------------------- */
/* findFreshScreenshotVerification / createScreenshotVerification             */
/* -------------------------------------------------------------------------- */

test("findFreshScreenshotVerification: returns null when no verification exists yet", async () => {
  const { db } = fakeDb();
  const result = await findFreshScreenshotVerification(db, "sr-1", new Date());
  assert.equal(result, null);
});

test("createScreenshotVerification + findFreshScreenshotVerification: a just-created verification is found while still within its TTL", async () => {
  const { db } = fakeDb();
  const now = new Date("2030-01-01T00:00:00.000Z");
  const preview = samplePreview();

  const created = await createScreenshotVerification(db, {
    recognitionId: "sr-1",
    preview,
    previewToken: "token-abc",
    now,
  });

  assert.equal(created.expiresAt.getTime(), now.getTime() + VERIFICATION_TTL_MS);

  const stillFresh = new Date(now.getTime() + VERIFICATION_TTL_MS - 1);
  const found = await findFreshScreenshotVerification(db, "sr-1", stillFresh);
  assert.ok(found);
  assert.deepEqual(found!.preview, preview);
  assert.equal(found!.previewToken, "token-abc");
});

test("findFreshScreenshotVerification: a verification is NOT returned once its TTL has passed", async () => {
  const { db } = fakeDb();
  const now = new Date("2030-01-01T00:00:00.000Z");
  await createScreenshotVerification(db, { recognitionId: "sr-1", preview: samplePreview(), previewToken: "token-abc", now });

  const exactlyAtExpiry = new Date(now.getTime() + VERIFICATION_TTL_MS);
  const afterExpiry = new Date(now.getTime() + VERIFICATION_TTL_MS + 1);

  assert.equal(await findFreshScreenshotVerification(db, "sr-1", exactlyAtExpiry), null);
  assert.equal(await findFreshScreenshotVerification(db, "sr-1", afterExpiry), null);
});

test("findFreshScreenshotVerification: with a custom (shorter) ttlMs, expiry is honored exactly", async () => {
  const { db } = fakeDb();
  const now = new Date("2030-01-01T00:00:00.000Z");
  await createScreenshotVerification(db, { recognitionId: "sr-1", preview: samplePreview(), previewToken: null, now, ttlMs: 5_000 });

  assert.ok(await findFreshScreenshotVerification(db, "sr-1", new Date(now.getTime() + 4_999)));
  assert.equal(await findFreshScreenshotVerification(db, "sr-1", new Date(now.getTime() + 5_000)), null);
});

test("findFreshScreenshotVerification: always returns the NEWEST non-expired verification, not the oldest", async () => {
  const { db } = fakeDb();
  const t0 = new Date("2030-01-01T00:00:00.000Z");
  const t1 = new Date(t0.getTime() + 1_000);

  await createScreenshotVerification(db, { recognitionId: "sr-1", preview: samplePreview("ODDS_CHANGED"), previewToken: "old-token", now: t0, ttlMs: 100_000 });
  await createScreenshotVerification(db, { recognitionId: "sr-1", preview: samplePreview("VERIFIED"), previewToken: "new-token", now: t1, ttlMs: 100_000 });

  const found = await findFreshScreenshotVerification(db, "sr-1", new Date(t1.getTime() + 1));
  assert.equal(found!.previewToken, "new-token");
  assert.equal(found!.preview.selections[0].oddsStatus, "VERIFIED");
});

test("findFreshScreenshotVerification: never cross-matches a different recognitionId", async () => {
  const { db } = fakeDb();
  const now = new Date("2030-01-01T00:00:00.000Z");
  await createScreenshotVerification(db, { recognitionId: "sr-1", preview: samplePreview(), previewToken: "token-abc", now });

  const found = await findFreshScreenshotVerification(db, "sr-2", now);
  assert.equal(found, null);
});

test("createScreenshotVerification: never mutates an existing verification row — each call is a genuinely new, independent row", async () => {
  const { db, _debug } = fakeDb();
  const now = new Date("2030-01-01T00:00:00.000Z");

  await createScreenshotVerification(db, { recognitionId: "sr-1", preview: samplePreview(), previewToken: "token-1", now });
  await createScreenshotVerification(db, { recognitionId: "sr-1", preview: samplePreview(), previewToken: "token-2", now });

  assert.equal(_debug.verifications.length, 2);
  assert.notEqual(_debug.verifications[0].id, _debug.verifications[1].id);
});

test("createScreenshotVerification: previewToken null is preserved as null (an unconfirmable EXPRESS with unknown odds)", async () => {
  const { db } = fakeDb();
  const now = new Date();
  const created = await createScreenshotVerification(db, { recognitionId: "sr-1", preview: samplePreview("NOT_FOUND"), previewToken: null, now });
  assert.equal(created.previewToken, null);
});

test("VERIFICATION_TTL_MS: is a sane, positive value, comfortably shorter than the previewToken's own 180s expiry", () => {
  assert.ok(VERIFICATION_TTL_MS > 0);
  assert.ok(VERIFICATION_TTL_MS < 180_000, "must stay under previewToken.ts's TTL_SECONDS so a reused token is never already expired");
});
