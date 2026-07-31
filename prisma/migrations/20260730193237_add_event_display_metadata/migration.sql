-- AlterTable
ALTER TABLE "Bet" ADD COLUMN     "awayTeamName" TEXT,
ADD COLUMN     "competitionName" TEXT,
ADD COLUMN     "homeTeamName" TEXT;

-- AlterTable
ALTER TABLE "BetSelection" ADD COLUMN     "awayTeamName" TEXT,
ADD COLUMN     "competitionName" TEXT,
ADD COLUMN     "homeTeamName" TEXT;
