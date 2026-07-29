-- CreateTable
CREATE TABLE "ScreenshotRecognition" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "imageHash" TEXT NOT NULL,
    "parsedBet" JSONB NOT NULL,
    "ocrText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScreenshotRecognition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreenshotVerification" (
    "id" TEXT NOT NULL,
    "recognitionId" TEXT NOT NULL,
    "preview" JSONB NOT NULL,
    "previewToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreenshotVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScreenshotRecognition_playerId_idx" ON "ScreenshotRecognition"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "ScreenshotRecognition_playerId_imageHash_key" ON "ScreenshotRecognition"("playerId", "imageHash");

-- CreateIndex
CREATE INDEX "ScreenshotVerification_recognitionId_createdAt_idx" ON "ScreenshotVerification"("recognitionId", "createdAt");

-- AddForeignKey
ALTER TABLE "ScreenshotRecognition" ADD CONSTRAINT "ScreenshotRecognition_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreenshotVerification" ADD CONSTRAINT "ScreenshotVerification_recognitionId_fkey" FOREIGN KEY ("recognitionId") REFERENCES "ScreenshotRecognition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
