-- CreateEnum
CREATE TYPE "BetStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'SETTLED_WIN', 'SETTLED_LOSS', 'VOID');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'BET_STAKE', 'BET_PAYOUT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "whatsappId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "balance" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bet" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "odds" DECIMAL(6,2) NOT NULL,
    "stake" DECIMAL(18,6) NOT NULL,
    "status" "BetStatus" NOT NULL DEFAULT 'PENDING',
    "rawMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OddsSnapshot" (
    "id" TEXT NOT NULL,
    "betId" TEXT NOT NULL,
    "sourceOdds" DECIMAL(6,2) NOT NULL,
    "submittedOdds" DECIMAL(6,2) NOT NULL,
    "matched" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OddsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "betId" TEXT,
    "type" "TransactionType" NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "balanceAfter" DECIMAL(18,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "content" TEXT NOT NULL,
    "betId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Operator_phone_key" ON "Operator"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Player_whatsappId_key" ON "Player"("whatsappId");

-- CreateIndex
CREATE INDEX "Player_operatorId_idx" ON "Player"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_playerId_key" ON "Wallet"("playerId");

-- CreateIndex
CREATE INDEX "Bet_playerId_idx" ON "Bet"("playerId");

-- CreateIndex
CREATE INDEX "Bet_status_idx" ON "Bet"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OddsSnapshot_betId_key" ON "OddsSnapshot"("betId");

-- CreateIndex
CREATE INDEX "Transaction_playerId_idx" ON "Transaction"("playerId");

-- CreateIndex
CREATE INDEX "Message_playerId_idx" ON "Message"("playerId");

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OddsSnapshot" ADD CONSTRAINT "OddsSnapshot_betId_fkey" FOREIGN KEY ("betId") REFERENCES "Bet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_betId_fkey" FOREIGN KEY ("betId") REFERENCES "Bet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
