import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import {
  decideSettlementTransition,
  type SettlementTarget,
  type SettlementDecision,
} from "@/lib/bets/settlementRules";

// Stage 13.3 — the settlement application service. Unlike
// lib/bets/settlementRules.ts (pure, no DB), this file performs real
// database writes, but stays independent from Next.js Request/Response,
// operator authentication, HTTP status codes, Telegram, and React/UI —
// none of those are imported here. No API route or UI exists yet; this is
// only the reusable service a future route (Stage 13.4) will call.
//
// Whole-slip manual settlement is the MVP behavior for both SINGLE and
// EXPRESS (Stage 13.1's Approach A) — this file never reads BetSelection
// rows and never requires a per-selection result.

export type SettlementDatabase = PrismaClient;

export interface SettleBetInput {
  betId: string;
  requestedStatus: SettlementTarget;
  // Stage 3.4A — optional override for the odds used to compute the
  // financial delta, instead of the stored Bet.totalOdds/Bet.odds. Exists
  // so an application-layer caller (e.g. a future EXPRESS aggregator) can
  // supply a freshly-computed effective price — e.g. a combined price
  // adjusted for a VOID leg — without this file duplicating that
  // computation. Absent for every existing caller today; a no-op when
  // omitted. Safe because BetSelection.odds/Bet.totalOdds/Bet.odds are all
  // immutable after creation (no update() call anywhere in the codebase
  // ever writes to them — confirmed by a full-codebase audit, not assumed),
  // so there is no staleness window between when a caller computes this
  // value and when it's used here.
  //
  // X3A — widened from SETTLED_WIN-only to also accept SETTLED_LOSS, for a
  // genuine partial-loss EXPRESS outcome (0 < effectiveOdds < 1) — see
  // validateEffectiveOddsInput's own comment for the exact accepted range.
  // Still rejected for VOID/SETTLED_HALF_WIN/SETTLED_HALF_LOSS.
  effectiveOdds?: Prisma.Decimal;
}

export type SettleBetResult =
  | {
      kind: "APPLIED";
      betId: string;
      status: SettlementTarget;
      playerId: string;
      transactionId: string;
      amount: Prisma.Decimal;
      balanceAfter: Prisma.Decimal;
      // Only meaningful for SETTLED_WIN — omitted (not null) for
      // SETTLED_LOSS/VOID, since neither has a payout to report. Never
      // persisted (no Bet.grossPayout/potentialPayout column exists).
      grossPayout?: Prisma.Decimal;
      netProfit?: Prisma.Decimal;
    }
  | {
      kind: "IDEMPOTENT";
      betId: string;
      status: SettlementTarget;
    };

export class BetNotFoundForSettlementError extends Error {
  readonly code = "BET_NOT_FOUND_FOR_SETTLEMENT" as const;
  readonly betId: string;

  constructor(betId: string) {
    super(`No Bet found with id ${betId}`);
    this.name = "BetNotFoundForSettlementError";
    this.betId = betId;
  }
}

// SETTLED_WIN with neither Bet.totalOdds nor the legacy Bet.odds set —
// there is genuinely no odds figure to compute a payout from. Never
// reachable for SETTLED_LOSS/VOID, which require no odds at all.
export class MissingSettlementOddsError extends Error {
  readonly code = "MISSING_SETTLEMENT_ODDS" as const;
  readonly betId: string;

  constructor(betId: string) {
    super(`Bet ${betId} has neither totalOdds nor a legacy odds value — cannot compute a WIN payout`);
    this.name = "MissingSettlementOddsError";
    this.betId = betId;
  }
}

// Covers every way an optional effectiveOdds input can be invalid: wrong
// runtime type (defense-in-depth beyond the TS boundary), non-finite
// (NaN/±Infinity — Prisma.Decimal/decimal.js can represent both), zero, or
// negative. Also covers misuse — effectiveOdds provided for a
// SETTLED_LOSS/VOID request, where it has no meaning and silently ignoring
// it would risk masking a caller bug instead of surfacing it.
export class InvalidEffectiveSettlementOddsError extends Error {
  readonly code = "INVALID_EFFECTIVE_SETTLEMENT_ODDS" as const;
  readonly betId: string;

  constructor(betId: string, message: string) {
    super(message);
    this.name = "InvalidEffectiveSettlementOddsError";
    this.betId = betId;
  }
}

// H4-B1 introduced this as a fail-closed guard for SETTLED_HALF_WIN/
// SETTLED_HALF_LOSS, before their financial math existed. H4-B3 gave both
// real math (see computeSettlementFinancials below), so neither can reach
// this error today. Kept as a permanent defensive branch for any FUTURE
// SettlementTarget value added to the type before its own financial math
// is implemented — the exact same fail-closed pattern H4-B1 established
// for HALF_* itself, now generalized rather than removed.
export class UnsupportedSettlementTargetError extends Error {
  readonly code = "UNSUPPORTED_SETTLEMENT_TARGET" as const;
  readonly betId: string;
  readonly targetStatus: SettlementTarget;

  constructor(betId: string, targetStatus: SettlementTarget) {
    super(`Bet ${betId}: settlement target ${targetStatus} has no financial execution support yet (H4-B3)`);
    this.name = "UnsupportedSettlementTargetError";
    this.betId = betId;
    this.targetStatus = targetStatus;
  }
}

// Deliberately NOT added (see Stage 13.3 report):
// - PlayerNotFoundForSettlementError — Bet.playerId is a required FK with
//   real referential integrity; a Bet can't reference a Player that
//   doesn't exist in a correctly functioning database, so this is
//   unreachable in practice, not just untested.
// - SettlementPersistenceConflictError — the race-recovery path below
//   re-runs decideSettlementTransition() against a freshly-read status,
//   which already throws the real, accurately-typed SettlementConflictError
//   (or resolves to IDEMPOTENT) — a separate error class would just
//   duplicate that decision, not add real distinction.

// Same P2025 ("record to update not found") detection as
// app/api/bets/[id]/confirm/route.ts's isRecordNotFoundError — a guarded
// `update({ where: { id, status: "CONFIRMED" } })` throws exactly this when
// a concurrent request already moved the Bet off CONFIRMED first.
function isRecordNotFoundError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

// Runs before any database read — a malformed effectiveOdds input fails
// fast with zero DB access, same "abort before any write is attempted"
// principle the pre-existing MissingSettlementOddsError check already
// follows below. Deliberately does NOT re-round or otherwise reshape a
// valid value — it flows through the exact same stake.times(x) ->
// roundMoney() pipeline totalOdds/legacyOdds already use in
// computeSettlementFinancials, unrounded on the way in; the caller is
// responsible for passing an already-appropriately-scaled Decimal, the same
// implicit contract totalOdds/odds already have (their scale comes from
// Prisma column precision, never from a rounding step in this file).
//
// X3A — widened from SETTLED_WIN-only to also accept SETTLED_LOSS, per
// X2.5's proven design: a future EXPRESS aggregator whose exact combined
// effectiveOdds factor lands strictly between 0 and 1 (a genuine partial
// loss — e.g. one leg HALF_LOSS, another WIN) settles as SETTLED_LOSS with
// this override, so computeSettlementFinancials can compute the exact
// partial delta instead of always assuming the full stake was lost.
// SETTLED_HALF_WIN/SETTLED_HALF_LOSS/VOID remain rejected — their math is
// still the fixed SINGLE-shaped stake/2 or stake-never-deducted rule X2.5
// found unsafe to generalize, untouched by this stage.
function validateEffectiveOddsInput(
  betId: string,
  requestedStatus: SettlementTarget,
  effectiveOdds: Prisma.Decimal | undefined,
): void {
  if (effectiveOdds === undefined) return;

  if (requestedStatus !== "SETTLED_WIN" && requestedStatus !== "SETTLED_LOSS") {
    throw new InvalidEffectiveSettlementOddsError(
      betId,
      `effectiveOdds may only be provided when requestedStatus is SETTLED_WIN or SETTLED_LOSS, got ${requestedStatus}`,
    );
  }

  // Defense-in-depth beyond the TS boundary — this file is internal-only
  // today (no HTTP route passes effectiveOdds through), but a caller could
  // still construct a malformed value via an `as` cast or an untyped test
  // double.
  if (!(effectiveOdds instanceof Prisma.Decimal)) {
    throw new InvalidEffectiveSettlementOddsError(betId, "effectiveOdds must be a Prisma.Decimal instance");
  }
  if (!effectiveOdds.isFinite()) {
    throw new InvalidEffectiveSettlementOddsError(betId, `effectiveOdds must be finite, got ${effectiveOdds.toString()}`);
  }
  if (effectiveOdds.lte(0)) {
    throw new InvalidEffectiveSettlementOddsError(betId, `effectiveOdds must be positive, got ${effectiveOdds.toString()}`);
  }

  // X3A — SETTLED_LOSS-only fail-closed boundary: an override is only ever
  // meaningful here as a PARTIAL loss (0 < E < 1). E == 1 is a breakeven
  // (X2.5: that's VOID's job, not SETTLED_LOSS's), and E > 1 is a genuine
  // gain (that's SETTLED_WIN's job) — either would silently produce a
  // SETTLED_LOSS row with a zero or positive balance delta, a self-
  // contradictory financial record. E == 0 (a full loss) is deliberately
  // NOT required to pass through this override at all: ordinary
  // SETTLED_LOSS without an override already means exactly that, so a
  // caller with a full loss should simply omit effectiveOdds, not supply 0
  // (0 would also fail the lte(0) check above, which is intentionally not
  // special-cased for this boundary — no caller needs it).
  if (requestedStatus === "SETTLED_LOSS" && effectiveOdds.gte(1)) {
    throw new InvalidEffectiveSettlementOddsError(
      betId,
      `effectiveOdds for SETTLED_LOSS must represent a partial loss (0 < effectiveOdds < 1), got ${effectiveOdds.toString()}`,
    );
  }
}

const ROUNDING_DECIMAL_PLACES = 2;
const ROUNDING_MODE = Prisma.Decimal.ROUND_HALF_UP;

// Single rounding boundary for every settlement delta, applied once, right
// before the value is used for the Player.currentCredit increment and the
// Transaction.amount it must exactly match — same "round once, at the end,
// never mid-calculation" convention lib/bets/expressMath.ts already
// established, same ROUND_HALF_UP mode, same 2-decimal-place precision.
function roundMoney(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(ROUNDING_DECIMAL_PLACES, ROUNDING_MODE);
}

interface SettlementFinancials {
  delta: Prisma.Decimal;
  transactionType: "BET_PAYOUT" | "BET_STAKE" | "ADJUSTMENT";
  grossPayout: Prisma.Decimal | null;
  netProfit: Prisma.Decimal | null;
}

// Pure arithmetic, no DB access — computed once per settleBet() call,
// before any write is attempted, so a MissingSettlementOddsError aborts
// before the transaction ever opens.
function computeSettlementFinancials(
  betId: string,
  targetStatus: SettlementTarget,
  stake: Prisma.Decimal,
  totalOdds: Prisma.Decimal | null,
  legacyOdds: Prisma.Decimal | null,
  overrideOdds: Prisma.Decimal | null,
): SettlementFinancials {
  // H4-B3 — a quarter-line Asian handicap half-outcome is financially
  // defined as exactly half the stake settling as a full WIN (or LOSS) and
  // the other half settling as a VOID (this stage's own required
  // semantics, Section 2) — so this reuses the *exact same* two
  // computations below (SETTLED_WIN's grossPayout/netProfit shape,
  // SETTLED_LOSS's negated-stake shape), just substituting `halfStake` for
  // `stake`. This is deliberately NOT a new single-shot "(S/2)*(O-1)"
  // formula: running it through SETTLED_WIN's own rounding shape (round
  // grossPayout to the cent first, THEN derive netProfit from that already-
  // rounded figure) is what guarantees a HALF_WIN produces the exact same
  // cent-for-cent result a real "half-stake WIN + half-stake VOID" pair of
  // settlements would — which can occasionally differ by a cent from a
  // single unrounded "(S/2)*(O-1)" computation once ROUND_HALF_UP is
  // involved on an odd stake. VOID's own delta is always exactly zero
  // (stake is never deducted at confirmation — see SETTLED_LOSS's comment
  // below), so the "other half settles VOID" side of the decomposition
  // contributes nothing and never needs its own line here.
  if (targetStatus === "SETTLED_HALF_WIN") {
    const settlementOdds = overrideOdds ?? totalOdds ?? legacyOdds;
    if (settlementOdds === null) {
      throw new MissingSettlementOddsError(betId);
    }

    const halfStake = stake.dividedBy(2);
    const grossPayout = roundMoney(halfStake.times(settlementOdds));
    const netProfit = roundMoney(grossPayout.minus(halfStake));
    return { delta: netProfit, transactionType: "BET_PAYOUT", grossPayout, netProfit };
  }

  if (targetStatus === "SETTLED_HALF_LOSS") {
    // No odds required, same rule as full SETTLED_LOSS below — only the
    // half-stake itself is ever at risk.
    const halfStake = stake.dividedBy(2);
    return { delta: roundMoney(halfStake.negated()), transactionType: "BET_STAKE", grossPayout: null, netProfit: null };
  }

  if (targetStatus === "SETTLED_WIN") {
    // Precedence: Stage 3.4A's caller-supplied overrideOdds first (already
    // validated by validateEffectiveOddsInput before this function is ever
    // called), then Bet.totalOdds (canonical, populated for both SINGLE and
    // EXPRESS today), then legacy Bet.odds as a backward-compatible
    // fallback for an older row. Never re-derived from BetSelection rows —
    // Stage 13.1's explicit instruction, still true for the two DB-sourced
    // fallbacks; overrideOdds is the one deliberate, explicit exception,
    // and only when a caller actually asks for it.
    const settlementOdds = overrideOdds ?? totalOdds ?? legacyOdds;
    if (settlementOdds === null) {
      throw new MissingSettlementOddsError(betId);
    }

    const grossPayout = roundMoney(stake.times(settlementOdds));
    const netProfit = roundMoney(grossPayout.minus(stake));
    return { delta: netProfit, transactionType: "BET_PAYOUT", grossPayout, netProfit };
  }

  if (targetStatus === "SETTLED_LOSS") {
    // X3A — overrideOdds is the ONLY source consulted here (never
    // totalOdds/legacyOdds — a full LOSS has always been, and remains,
    // odds-independent). When absent (every caller before this stage, and
    // every caller that hasn't computed a genuine partial-loss factor),
    // behavior is byte-for-byte unchanged: no odds required, full stake
    // lost. When present, validateEffectiveOddsInput has already proven
    // 0 < overrideOdds < 1, so this is always a genuine partial loss:
    // grossReturn = stake * overrideOdds (some money still comes back),
    // delta = grossReturn - stake (negative, exactly the partial-loss
    // amount) — the same grossReturn-minus-stake shape SETTLED_WIN already
    // uses above, just with a sub-1 odds figure instead of a supra-1 one.
    if (overrideOdds !== null) {
      const grossReturn = roundMoney(stake.times(overrideOdds));
      return { delta: roundMoney(grossReturn.minus(stake)), transactionType: "BET_STAKE", grossPayout: null, netProfit: null };
    }
    return { delta: roundMoney(stake.negated()), transactionType: "BET_STAKE", grossPayout: null, netProfit: null };
  }

  // VOID — stake was never deducted at confirmation (Stage 13.1 finding),
  // so there is nothing to return; the delta is exactly zero. A
  // zero-amount Transaction row is still created for the audit trail.
  return { delta: new Prisma.Decimal(0), transactionType: "ADJUSTMENT", grossPayout: null, netProfit: null };
}

// Internal control-flow signal only — never exported, never part of the
// public API. Thrown from inside the $transaction callback when a lost
// race resolves to IDEMPOTENT, so the transaction aborts (a correct no-op:
// nothing was written yet) and settleBet's own try/catch below converts it
// into a clean IDEMPOTENT return instead of a thrown error.
class RaceResolvedIdempotently extends Error {
  constructor(readonly betId: string, readonly status: SettlementTarget) {
    super("internal: settlement race resolved idempotently");
  }
}

export async function settleBet(db: SettlementDatabase, input: SettleBetInput): Promise<SettleBetResult> {
  const { betId, requestedStatus, effectiveOdds } = input;

  // Fails fast, before any database access — a malformed/misused
  // effectiveOdds is a caller bug, not something to silently ignore or
  // discover mid-transaction.
  validateEffectiveOddsInput(betId, requestedStatus, effectiveOdds);

  const bet = await db.bet.findUnique({
    where: { id: betId },
    select: { id: true, status: true, playerId: true, stake: true, totalOdds: true, odds: true },
  });

  if (!bet) {
    throw new BetNotFoundForSettlementError(betId);
  }

  // Optimistic fast path: decide against what was just read. Throws for
  // every invalid-target/invalid-source/conflict case (propagates straight
  // out of settleBet, no transaction ever opened), or resolves IDEMPOTENT
  // immediately (also zero writes) — only an APPLY decision proceeds to
  // open a transaction at all.
  const decision: SettlementDecision = decideSettlementTransition(bet.status, requestedStatus);

  if (decision.kind === "IDEMPOTENT") {
    return { kind: "IDEMPOTENT", betId, status: decision.targetStatus };
  }

  // Computed before opening the transaction — a MissingSettlementOddsError
  // must abort before any write is attempted, not mid-transaction.
  const financials = computeSettlementFinancials(
    betId,
    decision.targetStatus,
    bet.stake,
    bet.totalOdds,
    bet.odds,
    effectiveOdds ?? null,
  );

  try {
    const applied = await db.$transaction(async (tx) => {
      let updatedBet;
      try {
        // The one authoritative guard: an atomic conditional update whose
        // WHERE clause only matches a row still exactly CONFIRMED. Same
        // proven idiom as confirm route's `update({ where: { id, status:
        // "PENDING" } })` — if a concurrent request already moved this Bet
        // off CONFIRMED, zero rows match and Prisma throws P2025.
        updatedBet = await tx.bet.update({
          where: { id: betId, status: decision.fromStatus },
          data: { status: decision.targetStatus },
        });
      } catch (err) {
        if (!isRecordNotFoundError(err)) throw err;

        // Lost the race — re-read the *current* status inside this same
        // transaction (never trust the outer, now-stale read) and re-decide
        // from scratch. This either resolves IDEMPOTENT (another request
        // already applied the exact same settlement) or throws the real,
        // accurately-typed settlementRules.ts error (SettlementConflictError
        // for a different final result, or the analogous
        // not-confirmed/already-rejected errors in the unreachable-in-
        // practice case the status somehow reverted further).
        const current = await tx.bet.findUnique({ where: { id: betId }, select: { status: true } });
        if (!current) throw new BetNotFoundForSettlementError(betId);

        const raceDecision = decideSettlementTransition(current.status, requestedStatus);
        if (raceDecision.kind === "IDEMPOTENT") {
          throw new RaceResolvedIdempotently(betId, raceDecision.targetStatus);
        }

        // raceDecision.kind is "APPLY" here only if current.status is once
        // again exactly CONFIRMED, which cannot happen after this Bet was
        // already confirmed once (nothing in the existing lifecycle moves a
        // bet backward into CONFIRMED) — defensive, not expected to be
        // reachable, but there is nothing safe to do except surface it as
        // its own error rather than silently retrying forever.
        throw new Error(
          `settleBet: race recovery produced an unexpected APPLY decision for bet ${betId} (current status: ${current.status})`,
        );
      }

      // Atomic increment — never a stale read-modify-write. Prisma's
      // update() always returns the full post-update row, so
      // updatedPlayer.currentCredit is already the real, persisted
      // resulting balance; no separate read is needed to obtain it.
      const updatedPlayer = await tx.player.update({
        where: { id: bet.playerId },
        data: { currentCredit: { increment: financials.delta } },
      });

      const transaction = await tx.transaction.create({
        data: {
          playerId: bet.playerId,
          betId,
          type: financials.transactionType,
          amount: financials.delta,
          balanceAfter: updatedPlayer.currentCredit,
        },
      });

      return { updatedBet, updatedPlayer, transaction };
    });

    return {
      kind: "APPLIED",
      betId,
      status: decision.targetStatus,
      playerId: bet.playerId,
      transactionId: applied.transaction.id,
      amount: financials.delta,
      balanceAfter: applied.updatedPlayer.currentCredit,
      ...(financials.grossPayout !== null ? { grossPayout: financials.grossPayout } : {}),
      ...(financials.netProfit !== null ? { netProfit: financials.netProfit } : {}),
    };
  } catch (err) {
    if (err instanceof RaceResolvedIdempotently) {
      return { kind: "IDEMPOTENT", betId: err.betId, status: err.status };
    }
    throw err;
  }
}
