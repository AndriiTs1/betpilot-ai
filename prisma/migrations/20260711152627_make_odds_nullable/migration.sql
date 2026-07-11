-- AlterTable
ALTER TABLE "Bet" ALTER COLUMN "odds" DROP NOT NULL;

-- AlterTable
ALTER TABLE "OddsSnapshot" ALTER COLUMN "sourceOdds" DROP NOT NULL;
