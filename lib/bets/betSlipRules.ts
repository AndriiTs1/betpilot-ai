import type { BetSelectionOddsStatus } from "@/lib/generated/prisma/client";

// Stage 12, Phase 2 — pure domain rules for the SINGLE/EXPRESS bet slip
// shape. Deliberately not wired into any route/UI/Prisma write yet; see
// this file's companions lib/bets/expressMath.ts and
// lib/odds/mapOddsStatus.ts.

export const MIN_EXPRESS_SELECTIONS = 2;
export const MAX_EXPRESS_SELECTIONS = 10;

export type BetSlipValidationErrorCode =
  | "SINGLE_INVALID_SELECTION_COUNT"
  | "EXPRESS_TOO_FEW_SELECTIONS"
  | "EXPRESS_TOO_MANY_SELECTIONS"
  | "UNKNOWN_BET_SLIP_TYPE"
  // SCREENSHOT QA-1.6 — a selection carried a pendingMarketReconciliation
  // (lib/bets/betSlip.ts) that buildBetSlipPreview.ts could not confirm
  // against the real, provider-resolved event: the event never matched, the
  // claimed participant name matched neither/both real team names, or it
  // matched the WRONG side of the required HOME/AWAY evidence. Never thrown
  // for any other kind of market/selection contradiction — those are
  // rejected earlier, in betParser.ts, before a ParsedBetSlip is ever built.
  | "MARKET_INTENT_UNRECONCILED";

// A named error class + a machine-checkable `code`, not a bare Error with
// only prose — callers (and tests) branch on `code`, never on parsing
// `message`. Follows this codebase's existing narrow-purpose-Error-subclass
// convention (see InvalidPasswordError, InsufficientCreditError) but adds
// the explicit code these didn't need until now.
export class BetSlipValidationError extends Error {
  readonly code: BetSlipValidationErrorCode;

  constructor(code: BetSlipValidationErrorCode, message: string) {
    super(message);
    this.name = "BetSlipValidationError";
    this.code = code;
  }
}

// Throws on an invalid (type, selections.length) combination; returns
// nothing (void) when valid — the absence of a thrown error *is* the
// predictable "ok" result. Chosen over a { ok, error } return object
// because every other structural gate already in this codebase (the
// confirm route's InsufficientCreditError/BetNoLongerPendingError) uses the
// same throw-to-reject shape, and this function is a gate of the same
// kind: "is this shape allowed to proceed at all", not a computation with
// a value to hand back.
export function validateBetSlipType(
  type: "SINGLE" | "EXPRESS",
  selections: readonly unknown[],
): void {
  if (type === "SINGLE") {
    if (selections.length !== 1) {
      throw new BetSlipValidationError(
        "SINGLE_INVALID_SELECTION_COUNT",
        `SINGLE requires exactly 1 selection, got ${selections.length}`,
      );
    }
    return;
  }

  if (type === "EXPRESS") {
    if (selections.length < MIN_EXPRESS_SELECTIONS) {
      throw new BetSlipValidationError(
        "EXPRESS_TOO_FEW_SELECTIONS",
        `EXPRESS requires at least ${MIN_EXPRESS_SELECTIONS} selections, got ${selections.length}`,
      );
    }
    if (selections.length > MAX_EXPRESS_SELECTIONS) {
      throw new BetSlipValidationError(
        "EXPRESS_TOO_MANY_SELECTIONS",
        `EXPRESS supports at most ${MAX_EXPRESS_SELECTIONS} selections, got ${selections.length}`,
      );
    }
    return;
  }

  // Defensive — `type`'s TS signature already excludes this, but a caller
  // handing in unvalidated JSON (e.g. off a request body) isn't bound by
  // that at runtime. Same "boundary" reasoning as the rest of this file.
  throw new BetSlipValidationError(
    "UNKNOWN_BET_SLIP_TYPE",
    `Unknown bet slip type: ${JSON.stringify(type)}`,
  );
}

// Current business rule (final product decision — the odds provider must
// positively confirm a selection before it may ever become a Bet; see
// lib/bets/verifyPreviewFreshness.ts's decideFreshnessOutcome, the actual
// server-side enforcement point this mirrors, and
// components/miniapp/canConfirmBetSlip.ts's hasUnverifiedOddsStatus, the
// client-side one). Only VERIFIED (the provider confirmed this exact
// event/market and price) and ODDS_CHANGED (the provider confirmed the
// selection but the price moved — resolved via a mandatory reconfirmation,
// never silently accepted) are submittable. NOT_FOUND (the provider could
// not match this exact event/market at all), UNAVAILABLE (the provider
// couldn't verify anything right now), and the
// reserved-but-practically-unreachable PENDING default are never
// submittable — a bet the provider never confirmed must never reach the
// operator queue. Implemented as a membership check against every known
// status (not a hardcoded `return true`) so the function is a genuine,
// testable seam: changing this policy later means editing one set here,
// not hunting down scattered call sites.
const SUBMITTABLE_ODDS_STATUSES: ReadonlySet<BetSelectionOddsStatus> = new Set([
  "VERIFIED",
  "ODDS_CHANGED",
] satisfies BetSelectionOddsStatus[]);

export function canSubmitBetSlip(
  selections: readonly { oddsStatus: BetSelectionOddsStatus }[],
): boolean {
  return selections.every((selection) => SUBMITTABLE_ODDS_STATUSES.has(selection.oddsStatus));
}
