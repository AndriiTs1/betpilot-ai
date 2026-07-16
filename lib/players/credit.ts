import { Prisma } from "@/lib/generated/prisma/client";

// currentCredit negative = player owes (limit shrinks by the debt);
// positive/zero = player is up (full limit still available).
export function computeRemainingCredit(player: {
  creditLimit: Prisma.Decimal;
  currentCredit: Prisma.Decimal;
}): Prisma.Decimal {
  return player.currentCredit.lt(0)
    ? player.creditLimit.plus(player.currentCredit)
    : player.creditLimit;
}
