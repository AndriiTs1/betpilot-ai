-- AlterTable
ALTER TABLE "Bet" ADD COLUMN     "canonicalMarketType" TEXT,
ADD COLUMN     "canonicalParticipant" TEXT,
ADD COLUMN     "canonicalPeriod" TEXT,
ADD COLUMN     "canonicalSelectionType" TEXT,
ADD COLUMN     "eventStartTime" TIMESTAMP(3),
ADD COLUMN     "providerEventId" TEXT,
ADD COLUMN     "providerName" TEXT,
ADD COLUMN     "providerSportKey" TEXT;

-- AlterTable
ALTER TABLE "BetSelection" ADD COLUMN     "canonicalMarketType" TEXT,
ADD COLUMN     "canonicalParticipant" TEXT,
ADD COLUMN     "canonicalPeriod" TEXT,
ADD COLUMN     "canonicalSelectionType" TEXT,
ADD COLUMN     "eventStartTime" TIMESTAMP(3),
ADD COLUMN     "providerEventId" TEXT,
ADD COLUMN     "providerName" TEXT,
ADD COLUMN     "providerSportKey" TEXT;
