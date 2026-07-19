-- AlterTable
ALTER TABLE "Bet" ADD COLUMN     "previewId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Bet_previewId_key" ON "Bet"("previewId");
