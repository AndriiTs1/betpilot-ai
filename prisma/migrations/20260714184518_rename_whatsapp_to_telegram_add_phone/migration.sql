/*
  Warnings:

  - You are about to drop the column `whatsappId` on the `Player` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[telegramId]` on the table `Player` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Player_whatsappId_key";

-- AlterTable
ALTER TABLE "Player" DROP COLUMN "whatsappId",
ADD COLUMN     "phoneNumber" TEXT,
ADD COLUMN     "telegramId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Player_telegramId_key" ON "Player"("telegramId");
