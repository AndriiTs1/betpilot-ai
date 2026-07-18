-- CreateEnum
CREATE TYPE "BetType" AS ENUM ('SINGLE', 'PARLAY');

-- AlterTable
ALTER TABLE "Bet" ADD COLUMN     "totalOdds" DECIMAL(10,2),
ADD COLUMN     "type" "BetType" NOT NULL DEFAULT 'SINGLE';

-- CreateTable
CREATE TABLE "BetSelection" (
    "id" TEXT NOT NULL,
    "betId" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "odds" DECIMAL(6,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BetSelection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BetSelection_betId_idx" ON "BetSelection"("betId");

-- AddForeignKey
ALTER TABLE "BetSelection" ADD CONSTRAINT "BetSelection_betId_fkey" FOREIGN KEY ("betId") REFERENCES "Bet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
