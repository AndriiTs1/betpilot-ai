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

// Available = remainingCredit - exposure should never be negative in
// practice — the operator confirm route (app/api/bets/[id]/confirm)
// rejects any confirm that would push a player's exposure past their
// remaining credit. A negative value here means either stale/pre-existing
// data or a bug in that guard, not a value the UI should ever display
// as-is (a negative "Available" reads as nonsensical to an operator).
//
// Clamped to 0 for display only — never mutates the underlying figures —
// and logs a diagnostic warning so a real occurrence is discoverable in
// server logs rather than silently hidden. `context` should identify what
// was being computed (e.g. a player id) to make that log actionable.
export function clampAvailableForDisplay(available: Prisma.Decimal, context: string): Prisma.Decimal {
  if (available.isNegative()) {
    console.warn(
      `[credit] available < 0 for ${context}: ${available.toString()} — clamping to 0 for display. ` +
        "This should be unreachable if the confirm-time credit check is working; investigate.",
    );
    return new Prisma.Decimal(0);
  }

  return available;
}
