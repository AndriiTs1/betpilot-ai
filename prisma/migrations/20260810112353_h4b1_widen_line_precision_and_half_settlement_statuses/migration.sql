-- H4-B1: schema/type foundation for Asian handicap (quarter-line) support.
-- Purely additive — no data transformation, no backfill, no unrelated
-- columns touched. See lib/bets/settlementRules.ts and lib/bets/settleBet.ts
-- for why SETTLED_HALF_WIN/SETTLED_HALF_LOSS are not yet reachable through
-- any settlement path even though the enum now has them.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BetStatus" ADD VALUE 'SETTLED_HALF_WIN';
ALTER TYPE "BetStatus" ADD VALUE 'SETTLED_HALF_LOSS';

-- AlterTable
ALTER TABLE "Bet" ALTER COLUMN "line" SET DATA TYPE DECIMAL(5,2);

-- AlterTable
ALTER TABLE "BetSelection" ALTER COLUMN "line" SET DATA TYPE DECIMAL(5,2);
