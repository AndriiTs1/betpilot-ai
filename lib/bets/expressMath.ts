import { Prisma } from "@/lib/generated/prisma/client";

// Stage 12, Phase 2 — pure Decimal-based money/odds math for SINGLE and
// EXPRESS bet slips. Not wired into any route/UI/Prisma write yet.
//
// Every intermediate value here is a Prisma.Decimal — never a plain JS
// `number` — because floating-point multiplication of up to
// MAX_EXPRESS_SELECTIONS (10) odds values can accumulate visible rounding
// error (e.g. 0.1 * 3 !== 0.3 in IEEE 754 binary floating point). Decimal
// does exact base-10 arithmetic throughout the whole product, so the only
// rounding that ever happens is the single, explicit step at the end of
// each function below — never once per multiplication.
//
// Rounding strategy (explicit, used identically by both functions):
// round HALF_UP to 2 decimal places. HALF_UP (not banker's/HALF_EVEN)
// because it's the conventional rounding a bettor expects for money/odds
// display, and matches every other money figure already shown in this app
// (BetPreviewCard.tsx's formatAmount(), Bet.stake's real-world usage).
// 2 decimal places because that's Bet.totalOdds's actual column precision
// (`@db.Decimal(10, 2)`, see prisma/schema.prisma) — the value these
// functions compute is only ever persisted/displayed at that precision, so
// rounding once at the end matches the column exactly rather than losing
// precision earlier and then rounding again.
const ROUNDING_DECIMAL_PLACES = 2;
const ROUNDING_MODE = Prisma.Decimal.ROUND_HALF_UP;

export type ExpressMathErrorCode =
  | "NO_SELECTIONS"
  | "MISSING_ODDS"
  | "ZERO_OR_NEGATIVE_ODDS"
  | "ZERO_OR_NEGATIVE_STAKE";

export class ExpressMathError extends Error {
  readonly code: ExpressMathErrorCode;

  constructor(code: ExpressMathErrorCode, message: string) {
    super(message);
    this.name = "ExpressMathError";
    this.code = code;
  }
}

// Accepts `Decimal | null` per selection (BetSelection.odds's real,
// nullable column type) and rejects null/zero/negative explicitly — a
// selection with no confirmed submitted odds, or a non-positive one,
// can't contribute to a product that's meant to represent real payout
// odds. Rejects up front (before any multiplication) so a bad input never
// silently produces a wrong total.
export function computeTotalOdds(oddsList: readonly (Prisma.Decimal | null)[]): Prisma.Decimal {
  if (oddsList.length === 0) {
    throw new ExpressMathError("NO_SELECTIONS", "computeTotalOdds requires at least one selection");
  }

  let total = new Prisma.Decimal(1);

  for (const odds of oddsList) {
    if (odds === null) {
      throw new ExpressMathError(
        "MISSING_ODDS",
        "Every selection must have submitted odds before totalOdds can be computed",
      );
    }
    if (odds.lte(0)) {
      throw new ExpressMathError("ZERO_OR_NEGATIVE_ODDS", `Odds must be positive, got ${odds.toString()}`);
    }

    total = total.times(odds);
  }

  return total.toDecimalPlaces(ROUNDING_DECIMAL_PLACES, ROUNDING_MODE);
}

// stake is Bet.stake's real column type (Decimal, NOT NULL — never
// nullable in the schema), so no null-stake case exists to guard against;
// only positivity is validated.
export function computePotentialWin(stake: Prisma.Decimal, totalOdds: Prisma.Decimal): Prisma.Decimal {
  if (stake.lte(0)) {
    throw new ExpressMathError("ZERO_OR_NEGATIVE_STAKE", `Stake must be positive, got ${stake.toString()}`);
  }
  if (totalOdds.lte(0)) {
    throw new ExpressMathError("ZERO_OR_NEGATIVE_ODDS", `totalOdds must be positive, got ${totalOdds.toString()}`);
  }

  return stake.times(totalOdds).toDecimalPlaces(ROUNDING_DECIMAL_PLACES, ROUNDING_MODE);
}
