// H4-B2 — pure Asian handicap (quarter-line) split helper. Given a
// canonical SPREAD line (already a Prisma.Decimal — this file never parses
// a raw string itself, that's evaluateSelectionOutcome.ts's job), decides
// whether the line is a genuine quarter line requiring a 50/50 split into
// two half-stake components, an ordinary whole/half line requiring no
// split at all, or a fraction outside the supported grid.
//
// Pure and DB-free: no Prisma client, no randomness, no Date.now(), no
// side effects — same purity contract as evaluateSelectionOutcome.ts
// itself, which is this function's only intended caller. All arithmetic
// uses Prisma.Decimal (decimal.js) exclusively — never native floating
// point, so e.g. -1.25 can never be silently coerced to -1.2500000001 or
// rounded to -1/-1.5 before being split.

import { Prisma } from "@/lib/generated/prisma/client";

const ZERO = new Prisma.Decimal(0);
const QUARTER = new Prisma.Decimal("0.25");
const HALF = new Prisma.Decimal("0.5");

export type AsianLineSplit =
  // Ordinary whole/half line (0, ±0.5, ±1, ±1.5, ±2, ...) — used as-is by
  // the evaluator, no 50/50 split.
  | { readonly kind: "NO_SPLIT" }
  // Genuine quarter line (fraction .25 or .75) — split into its two
  // half-stake components, always in ascending numeric order (documented
  // and tested below): e.g. -0.75 -> [-1, -0.5], +1.25 -> [+1, +1.5].
  | { readonly kind: "SPLIT"; readonly components: readonly [Prisma.Decimal, Prisma.Decimal] }
  // Fraction outside the supported .00/.25/.50/.75 grid (e.g. -1.33,
  // +0.10) — the caller must treat this as a safe evaluation failure
  // (INVALID_DATA), never silently round to the nearest supported grid
  // point. This stage does not widen what the parser/provider can submit
  // — it only refuses to guess when it receives something outside the
  // grid it can arithmetically decide.
  | { readonly kind: "INVALID_GRID" };

// Exact fractional part, independent of sign — Prisma.Decimal/decimal.js's
// own .mod() follows the sign of the dividend (like JS `%`), so -0.75 mod 1
// would be -0.75, not 0.25, if computed directly on a negative line. Taking
// .abs() first is what makes -0.75 and +0.75 both report a 0.75 fraction.
function fractionOf(line: Prisma.Decimal): Prisma.Decimal {
  return line.abs().modulo(1);
}

export function splitAsianHandicapLine(line: Prisma.Decimal): AsianLineSplit {
  const fraction = fractionOf(line);

  if (fraction.equals(ZERO) || fraction.equals(HALF)) {
    return { kind: "NO_SPLIT" };
  }

  if (!fraction.equals(QUARTER) && !fraction.equals(HALF.plus(QUARTER))) {
    return { kind: "INVALID_GRID" };
  }

  // Quarter line (fraction .25 or .75, either sign). The two half-stake
  // components straddle `line` by exactly a quarter point each — verified
  // against every example in this stage's own task spec:
  //   -0.25 -> [-0.5, 0]   -0.75 -> [-1, -0.5]
  //   -1.25 -> [-1.5, -1]  -1.75 -> [-2, -1.5]
  //   +0.25 -> [0, +0.5]   +0.75 -> [+0.5, +1]
  //   +1.25 -> [+1, +1.5]  +1.75 -> [+1.5, +2]
  // `line.minus(QUARTER)` is always numerically less than `line.plus(QUARTER)`,
  // so this is already ascending order without any extra sort/compare step.
  const lower = line.minus(QUARTER);
  const upper = line.plus(QUARTER);
  return { kind: "SPLIT", components: [lower, upper] };
}
