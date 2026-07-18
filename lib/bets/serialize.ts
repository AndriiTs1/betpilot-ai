import { Prisma } from "@/lib/generated/prisma/client";

// Prisma.Decimal.toJSON() already returns a string, so JSON.stringify would
// technically be safe without this — but making the string conversion
// explicit documents the contract and doesn't depend on that library detail.
// Same reasoning applies to totalOdds and each selection's own odds below —
// those were previously relying on that same implicit toJSON() behavior.

export function serializeBetSelection<T extends { odds: Prisma.Decimal | null }>(selection: T) {
  return {
    ...selection,
    odds: selection.odds ? selection.odds.toString() : null,
  };
}

export function serializeBet<
  T extends {
    odds: Prisma.Decimal | null;
    stake: Prisma.Decimal;
    totalOdds: Prisma.Decimal | null;
    selections?: { odds: Prisma.Decimal | null }[];
  },
>(bet: T) {
  return {
    ...bet,
    odds: bet.odds ? bet.odds.toString() : null,
    stake: bet.stake.toString(),
    totalOdds: bet.totalOdds ? bet.totalOdds.toString() : null,
    ...(bet.selections ? { selections: bet.selections.map(serializeBetSelection) } : {}),
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
