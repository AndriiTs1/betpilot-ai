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
  | "UNKNOWN_BET_SLIP_TYPE";

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

// Current business rule (explicit, deliberate — confirmed during the
// Stage 12 audit): no odds-verification outcome blocks a player from
// submitting a bet slip for operator review. VERIFIED, ODDS_CHANGED,
// NOT_FOUND, UNAVAILABLE, and the reserved-but-practically-unreachable
// PENDING default all currently allow submission — the operator's own
// Confirm/Reject is the only real gate. Implemented as a membership check
// against every known status (not a hardcoded `return true`) so the
// function is a genuine, testable seam: changing this policy later (e.g.
// blocking NOT_FOUND) means removing one entry here, not hunting down
// scattered call sites.
const SUBMITTABLE_ODDS_STATUSES: ReadonlySet<BetSelectionOddsStatus> = new Set([
  "PENDING",
  "VERIFIED",
  "ODDS_CHANGED",
  "NOT_FOUND",
  "UNAVAILABLE",
] satisfies BetSelectionOddsStatus[]);

export function canSubmitBetSlip(
  selections: readonly { oddsStatus: BetSelectionOddsStatus }[],
): boolean {
  return selections.every((selection) => SUBMITTABLE_ODDS_STATUSES.has(selection.oddsStatus));
}
