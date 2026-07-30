-- Stage 4.3.1 — Retry & Manual Review: additive-only schema groundwork.
-- No existing column is altered/dropped, no data is rewritten — every
-- existing Bet row (including the legacy, provider-metadata-less CONFIRMED
-- ones) gets settlementRetryCount = 0 and every other new field NULL by
-- construction. settleBet.ts/settlementRules.ts do not read or write any
-- of this. Generated via `prisma migrate diff --from-schema <pre-4.3
-- schema.prisma> --to-schema <post-4.3 schema.prisma> --script`, not
-- applied to any database by that generation step — this file is created,
-- not run, pending an explicit `prisma migrate deploy` decision.

-- CreateEnum
CREATE TYPE "SettlementReviewStatus" AS ENUM ('NEEDS_REVIEW', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SettlementReviewReason" AS ENUM ('POLLING_WINDOW_EXPIRED', 'EVENT_NOT_FOUND_MAX_RETRIES', 'MISSING_SCORE_MAX_RETRIES', 'DB_ERROR_MAX_RETRIES', 'MISSING_PROVIDER_REFERENCE', 'PROVIDER_EVENT_MISMATCH', 'MISSING_CANONICAL_METADATA', 'INVALID_BET_TYPE', 'EMPTY_SELECTIONS', 'DUPLICATE_PROVIDER_EVENT_RESULT', 'UNSUPPORTED_MARKET', 'UNSUPPORTED_SELECTION', 'UNSUPPORTED_PERIOD', 'INVALID_SCORE', 'PARTICIPANT_MISMATCH', 'INVALID_EVENT_RESULT', 'MISSING_PARTICIPANT_NAME', 'AMBIGUOUS_PARTICIPANT_MATCH', 'MISSING_SETTLEMENT_ODDS', 'INVALID_SETTLEMENT_ODDS', 'INVALID_EXPRESS_DATA');

-- AlterTable
ALTER TABLE "Bet" ADD COLUMN     "lastSettlementAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastSettlementErrorCode" TEXT,
ADD COLUMN     "lastSettlementErrorMessage" TEXT,
ADD COLUMN     "settlementRetryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "settlementReviewReason" "SettlementReviewReason",
ADD COLUMN     "settlementReviewStatus" "SettlementReviewStatus";
