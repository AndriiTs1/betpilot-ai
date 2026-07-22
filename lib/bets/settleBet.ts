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
): SettlementFinancials {
  if (targetStatus === "SETTLED_WIN") {
    // Precedence: Bet.totalOdds (canonical, populated for both SINGLE and
    // EXPRESS today) first, legacy Bet.odds only as a backward-compatible
    // fallback for an older row. Never re-derived from BetSelection rows —
    // Stage 13.1's explicit instruction.
    const effectiveOdds = totalOdds ?? legacyOdds;
    if (effectiveOdds === null) {
      throw new MissingSettlementOddsError(betId);
    }

    const grossPayout = roundMoney(stake.times(effectiveOdds));
    const netProfit = roundMoney(grossPayout.minus(stake));
    return { delta: netProfit, transactionType: "BET_PAYOUT", grossPayout, netProfit };
  }

  if (targetStatus === "SETTLED_LOSS") {
    // No odds required — a missing totalOdds must never block a LOSS.
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
  const { betId, requestedStatus } = input;

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
