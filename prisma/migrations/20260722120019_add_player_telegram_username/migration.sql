-- Closed-demo player onboarding — additive only, no data impact for any
-- existing row (every current Player gets NULL, which is valid: a unique
-- index on a nullable Postgres column allows any number of NULLs, only
-- non-NULL values are compared for uniqueness).

-- AlterTable
ALTER TABLE "Player" ADD COLUMN "telegramUsername" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Player_telegramUsername_key" ON "Player"("telegramUsername");
