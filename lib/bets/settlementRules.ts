import type { BetStatus } from "@/lib/generated/prisma/client";

// Stage 13.2 — the single canonical source of truth for settlement
// eligibility and idempotency, before any database implementation exists.
// Pure and dependency-free: no Prisma client, no database access, no
// Next.js/Telegram imports, no environment variables, no side effects, and
// no money/payout calculations (that's explicitly a later stage's job —
// see lib/bets/expressMath.ts for where Decimal arithmetic already lives).
//
// Settlement is final and irreversible for the demo MVP: once a Bet moves
// from CONFIRMED to SETTLED_WIN/SETTLED_LOSS/VOID, it can never move to a
// *different* settled result — only the exact same repeated request is
// ever allowed, and that repeat is idempotent (kind: "IDEMPOTENT"). A
// database layer consuming this module's decision must only perform a
// financial/status write for an APPLY decision — never for IDEMPOTENT,
// which by definition means the mutation already happened on some earlier
// request and must not run again.

// H4-B1 — widened from the original 3-value union to also *structurally*
// recognize SETTLED_HALF_WIN/SETTLED_HALF_LOSS (needed so this type can
// describe a bet's currentStatus once it's terminally half-settled, and so
// SettlementConflictError/SettlementDecision can name them). This is a type-
// level widening only. SETTLEMENT_TARGET_STATUSES/isSettlementTarget below —
// the *runtime* gate on what a caller may currently REQUEST — deliberately
// stay at the original 3 values. See the comment above isSettlementTarget
// for why that split is intentional, not an oversight.
export type SettlementTarget = "SETTLED_WIN" | "SETTLED_LOSS" | "VOID" | "SETTLED_HALF_WIN" | "SETTLED_HALF_LOSS";

// Frozen array (not a mutable Set) exported directly — a plain frozen
// array reliably rejects consumer mutation (Object.freeze blocks .push()/
// .splice()/index-assignment on a real array; a frozen Set/Map does not
// reliably block .add()/.set() in modern JS engines, since their mutating
// state lives in an internal slot rather than an own property). The
// `readonly` type additionally blocks any mutating call at compile time.
//
// H4-B1 — intentionally NOT widened to include SETTLED_HALF_WIN/
// SETTLED_HALF_LOSS, even though the SettlementTarget type above now
// includes them. This is the one runtime gate decideSettlementTransition
// uses to validate requestedStatus, and it's also the exact gate
// app/api/bets/[id]/settle/route.ts uses for its public pre-check — so
// keeping it at 3 values is what keeps HALF_WIN/HALF_LOSS unrequestable
// through both the public settle API and decideSettlementTransition itself
// until H4-B3 adds real payout math for them. The schema/type layer knows
// the status; no settlement action can request it yet.
export const SETTLEMENT_TARGET_STATUSES: readonly SettlementTarget[] = Object.freeze([
  "SETTLED_WIN",
  "SETTLED_LOSS",
  "VOID",
]);

// Built once from the frozen array above — used only internally by
// isSettlementTarget for O(1) membership checks; never exported itself, so
// there's nothing mutable for a consumer to reach.
const SETTLEMENT_TARGET_SET: ReadonlySet<SettlementTarget> = new Set(SETTLEMENT_TARGET_STATUSES);

// Returns true only for the 3 currently-requestable targets — see the
// comment on SETTLEMENT_TARGET_STATUSES above. Correctly returns false for
// "SETTLED_HALF_WIN"/"SETTLED_HALF_LOSS", even though both are valid
// SettlementTarget *type* members now.
export function isSettlementTarget(value: unknown): value is SettlementTarget {
  return typeof value === "string" && SETTLEMENT_TARGET_SET.has(value as SettlementTarget);
}

// H4-B3 — the internal-primitive counterpart to SETTLEMENT_TARGET_STATUSES
// above. This is the wider, 5-value set: what settleBet.ts/
// decideSettlementTransition may structurally ACCEPT as a requestedStatus
// shape now that HALF_WIN/HALF_LOSS have real financial execution support
// (computeSettlementFinancials in settleBet.ts). Deliberately a SEPARATE
// export from isSettlementTarget/SETTLEMENT_TARGET_STATUSES, not a widening
// of them — those stay at exactly 3 values because
// app/api/bets/[id]/settle/route.ts imports isSettlementTarget directly for
// its own public pre-check, and that route's acceptance is UNCHANGED by
// H4-B3 (a distinct, later, explicitly-reviewed decision — see this
// module's own header comment on the A/B/C distinction: this is "A",
// internal capability, never "B", public API surface). Never imported by
// the settle route.
export const INTERNAL_SETTLEMENT_TARGET_STATUSES: readonly SettlementTarget[] = Object.freeze([
  "SETTLED_WIN",
  "SETTLED_LOSS",
  "VOID",
  "SETTLED_HALF_WIN",
  "SETTLED_HALF_LOSS",
]);

const INTERNAL_SETTLEMENT_TARGET_SET: ReadonlySet<SettlementTarget> = new Set(INTERNAL_SETTLEMENT_TARGET_STATUSES);

// Used only by decideSettlementTransition's own requestedStatus shape-check
// below — never by any route. Returns true for HALF_WIN/HALF_LOSS, unlike
// isSettlementTarget above.
export function isInternalSettlementTarget(value: unknown): value is SettlementTarget {
  return typeof value === "string" && INTERNAL_SETTLEMENT_TARGET_SET.has(value as SettlementTarget);
}

// APPLY: the database layer (a later stage) may perform the guarded
// CONFIRMED -> targetStatus transition and its associated financial write.
// IDEMPOTENT: this exact settlement already happened on some earlier
// request — the database layer must treat this as a successful no-op and
// must NOT run any financial/status mutation again.
export type SettlementDecision =
  | { kind: "APPLY"; fromStatus: "CONFIRMED"; targetStatus: SettlementTarget }
  | { kind: "IDEMPOTENT"; currentStatus: SettlementTarget; targetStatus: SettlementTarget };

export type SettlementRuleErrorCode =
  | "INVALID_SETTLEMENT_TARGET"
  | "BET_NOT_CONFIRMED_FOR_SETTLEMENT"
  | "BET_ALREADY_REJECTED"
  | "SETTLEMENT_CONFLICT";

// requestedStatus was not one of SETTLED_WIN/SETTLED_LOSS/VOID — this
// includes PENDING, CONFIRMED, and REJECTED as requested *targets* (a Bet
// can never be "settled to REJECTED" — rejection is a separate, unrelated
// lifecycle path handled entirely outside this module), plus any
// non-BetStatus garbage (null/undefined/empty string/arbitrary
// string/object/number). Distinguishable from every other error below by
// its code alone — this is about the *shape of the request*, never about
// the bet's current lifecycle position.
export class InvalidSettlementTargetError extends Error {
  readonly code = "INVALID_SETTLEMENT_TARGET" as const;
  readonly currentStatus: BetStatus;
  readonly requestedStatus: unknown;

  constructor(currentStatus: BetStatus, requestedStatus: unknown) {
    super(
      `Invalid settlement target ${JSON.stringify(requestedStatus)} — must be one of ${INTERNAL_SETTLEMENT_TARGET_STATUSES.join(", ")}`,
    );
    this.name = "InvalidSettlementTargetError";
    this.currentStatus = currentStatus;
    this.requestedStatus = requestedStatus;
  }
}

// currentStatus is PENDING — a bet must pass through CONFIRMED (the
// existing, unchanged confirm route) before it is eligible for settlement.
export class BetNotConfirmedForSettlementError extends Error {
  readonly code = "BET_NOT_CONFIRMED_FOR_SETTLEMENT" as const;
  readonly currentStatus: BetStatus;
  readonly requestedStatus: SettlementTarget;

  constructor(currentStatus: BetStatus, requestedStatus: SettlementTarget) {
    super(`Bet must be CONFIRMED before it can be settled (current status: ${currentStatus})`);
    this.name = "BetNotConfirmedForSettlementError";
    this.currentStatus = currentStatus;
    this.requestedStatus = requestedStatus;
  }
}

// currentStatus is REJECTED — a separate, already-terminal error from
// BetNotConfirmedForSettlementError above: PENDING means "not eligible
// yet", REJECTED means "was eligible, was explicitly declined, and can
// never become eligible again." Kept as its own class (not folded into
// BetNotConfirmedForSettlementError) because the two have genuinely
// different meanings for a future caller deciding what to tell an
// operator.
export class BetAlreadyRejectedError extends Error {
  readonly code = "BET_ALREADY_REJECTED" as const;
  readonly currentStatus = "REJECTED" as const;
  readonly requestedStatus: SettlementTarget;

  constructor(requestedStatus: SettlementTarget) {
    super("Bet was already rejected and can never be settled — REJECTED is terminal");
    this.name = "BetAlreadyRejectedError";
    this.requestedStatus = requestedStatus;
  }
}

// currentStatus is already a *different* final settlement result than what
// was just requested (e.g. already SETTLED_WIN, now requesting
// SETTLED_LOSS). Distinct from the IDEMPOTENT success path: requesting the
// *same* result again is not an error at all (see decideSettlementTransition
// below) — this only fires when the two disagree.
export class SettlementConflictError extends Error {
  readonly code = "SETTLEMENT_CONFLICT" as const;
  readonly currentStatus: SettlementTarget;
  readonly requestedStatus: SettlementTarget;

  constructor(currentStatus: SettlementTarget, requestedStatus: SettlementTarget) {
    super(`Bet is already settled as ${currentStatus} and cannot be changed to ${requestedStatus}`);
    this.name = "SettlementConflictError";
    this.currentStatus = currentStatus;
    this.requestedStatus = requestedStatus;
  }
}

// Convenience union for a future caller's catch block — a TS-level alias
// only, not a shared runtime base class, so this doesn't reintroduce the
// hierarchy the task asks to avoid.
export type SettlementRuleError =
  | InvalidSettlementTargetError
  | BetNotConfirmedForSettlementError
  | BetAlreadyRejectedError
  | SettlementConflictError;

// The one place that decides APPLY vs IDEMPOTENT vs which error to throw —
// every other exported helper in this module exists only to support this
// function; none of them duplicate its transition logic.
export function decideSettlementTransition(currentStatus: BetStatus, requestedStatus: unknown): SettlementDecision {
  // H4-B3 — widened from isSettlementTarget (3 values) to
  // isInternalSettlementTarget (5 values): decideSettlementTransition is the
  // internal settlement PRIMITIVE (settleBet.ts's own shape-check before it
  // ever computes financials), not the public API surface — that's
  // app/api/bets/[id]/settle/route.ts's own separate, unchanged
  // isSettlementTarget pre-check. This is what makes CONFIRMED ->
  // SETTLED_HALF_WIN/SETTLED_HALF_LOSS a real, callable APPLY decision now
  // that computeSettlementFinancials (settleBet.ts) has real math for them,
  // without widening what an operator/route request may ask for.
  if (!isInternalSettlementTarget(requestedStatus)) {
    throw new InvalidSettlementTargetError(currentStatus, requestedStatus);
  }

  // Terminal currentStatus recognition — includes SETTLED_HALF_WIN/
  // SETTLED_HALF_LOSS since H4-B1 (both for the BetStatus exhaustiveCheck
  // guard below and for correct conflict detection). As of H4-B3, with
  // requestedStatus now also able to be a HALF_* value, this branch is
  // fully reachable for HALF_* same-target idempotency too — not just
  // different-target conflict as it was before H4-B3's widening above.
  if (
    currentStatus === "SETTLED_WIN" ||
    currentStatus === "SETTLED_LOSS" ||
    currentStatus === "VOID" ||
    currentStatus === "SETTLED_HALF_WIN" ||
    currentStatus === "SETTLED_HALF_LOSS"
  ) {
    if (currentStatus === requestedStatus) {
      return { kind: "IDEMPOTENT", currentStatus, targetStatus: requestedStatus };
    }
    throw new SettlementConflictError(currentStatus, requestedStatus);
  }

  if (currentStatus === "CONFIRMED") {
    return { kind: "APPLY", fromStatus: "CONFIRMED", targetStatus: requestedStatus };
  }

  if (currentStatus === "PENDING") {
    throw new BetNotConfirmedForSettlementError(currentStatus, requestedStatus);
  }

  if (currentStatus === "REJECTED") {
    throw new BetAlreadyRejectedError(requestedStatus);
  }

  // Exhaustiveness guard — BetStatus has exactly 6 members, all handled
  // above (this line is unreachable through the real Prisma enum; TS
  // narrows currentStatus to `never` here as proof every case was
  // covered). Same "caller unvalidated data isn't bound by TS at runtime"
  // defense-in-depth reasoning lib/bets/betSlipRules.ts's own final branch
  // already uses.
  const exhaustiveCheck: never = currentStatus;
  throw new Error(`decideSettlementTransition: unhandled Bet status ${String(exhaustiveCheck)}`);
}
