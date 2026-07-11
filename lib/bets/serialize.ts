import { Prisma } from "@/lib/generated/prisma/client";

// Prisma.Decimal.toJSON() already returns a string, so JSON.stringify would
// technically be safe without this — but making the string conversion
// explicit documents the contract and doesn't depend on that library detail.

export function serializeBet<T extends { odds: Prisma.Decimal | null; stake: Prisma.Decimal }>(
  bet: T,
) {
  return {
    ...bet,
    odds: bet.odds ? bet.odds.toString() : null,
    stake: bet.stake.toString(),
  };
}

export function serializeOddsSnapshot<
  T extends { sourceOdds: Prisma.Decimal | null; submittedOdds: Prisma.Decimal },
>(snapshot: T) {
  return {
    ...snapshot,
    sourceOdds: snapshot.sourceOdds ? snapshot.sourceOdds.toString() : null,
    submittedOdds: snapshot.submittedOdds.toString(),
  };
}
