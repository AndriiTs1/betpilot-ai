import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { isOperatorAuthorized } from "@/lib/auth/operatorAuth";
import { settleBet, BetNotFoundForSettlementError, MissingSettlementOddsError, type SettleBetResult } from "@/lib/bets/settleBet";
import {
  isSettlementTarget,
  InvalidSettlementTargetError,
  BetNotConfirmedForSettlementError,
  BetAlreadyRejectedError,
  SettlementConflictError,
} from "@/lib/bets/settlementRules";
import { sendTelegramMessage } from "@/lib/telegram/sendMessage";
import { escapeHtml } from "@/lib/telegram/escapeHtml";
import { normalizeSelectionToEnglish } from "@/lib/bets/normalizeSelectionToEnglish";

// Stage 13.4 — the operator-only HTTP layer over settleBet() (Stage 13.3).
// This route does exactly three things: authorize, validate the request's
// shape, and translate settleBet()'s result/errors into an HTTP response.
// It never calculates a payout, never touches Bet/Player/Transaction
// directly, and never re-decides settlement eligibility itself — every one
// of those already lives in lib/bets/settleBet.ts and
// lib/bets/settlementRules.ts, the single source of truth for both.
//
// Same shared-secret operator authorization as confirm/reject
// (isOperatorAuthorized -> OPERATOR_SECRET Bearer token) — this is a known,
// pre-existing limitation (not scoped to an individual operator) that this
// stage preserves unchanged rather than redesigning as an unrelated change.

export interface HandleSettleBetOptions {
  db?: PrismaClient;
}

interface SettleErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    betId?: string;
    currentStatus?: string;
    requestedStatus?: unknown;
  };
}

function errorResponse(status: number, body: SettleErrorBody["error"]): NextResponse<SettleErrorBody> {
  return NextResponse.json({ success: false, error: body }, { status });
}

// Decimal -> string only, mirroring lib/bets/serialize.ts's existing
// convention elsewhere in this codebase — never a raw Prisma.Decimal object
// in a JSON response. IDEMPOTENT carries no financial fields at all (Stage
// 13.3's own contract: no fake transaction information for a no-op).
function serializeSettleResult(result: SettleBetResult) {
  if (result.kind === "IDEMPOTENT") {
    return { kind: "IDEMPOTENT" as const, betId: result.betId, status: result.status };
  }

  return {
    kind: "APPLIED" as const,
    betId: result.betId,
    status: result.status,
    playerId: result.playerId,
    transactionId: result.transactionId,
    amount: result.amount.toString(),
    balanceAfter: result.balanceAfter.toString(),
    ...(result.grossPayout !== undefined ? { grossPayout: result.grossPayout.toString() } : {}),
    ...(result.netProfit !== undefined ? { netProfit: result.netProfit.toString() } : {}),
  };
}

// Maps each domain error to its HTTP response without ever parsing
// err.message — every field used here is a structured property the error
// class itself already exposes (Stage 13.2/13.3's explicit design goal).
function mapSettlementError(err: unknown, betId: string): NextResponse<SettleErrorBody> {
  if (err instanceof BetNotFoundForSettlementError) {
    return errorResponse(404, { code: err.code, message: err.message, betId: err.betId });
  }

  if (err instanceof BetNotConfirmedForSettlementError || err instanceof BetAlreadyRejectedError || err instanceof SettlementConflictError) {
    return errorResponse(409, {
      code: err.code,
      message: err.message,
      currentStatus: err.currentStatus,
      requestedStatus: err.requestedStatus,
    });
  }

  if (err instanceof InvalidSettlementTargetError) {
    return errorResponse(422, {
      code: err.code,
      message: err.message,
      currentStatus: err.currentStatus,
      requestedStatus: err.requestedStatus,
    });
  }

  if (err instanceof MissingSettlementOddsError) {
    return errorResponse(422, { code: err.code, message: err.message, betId: err.betId });
  }

  console.error(`POST /api/bets/${betId}/settle failed:`, err);
  return errorResponse(500, { code: "INTERNAL_ERROR", message: "Internal server error" });
}

type AppliedSettleResult = Extract<SettleBetResult, { kind: "APPLIED" }>;

interface SettledBetDisplayFields {
  sport: string;
  event: string | null;
  outcome: string | null;
  odds: Prisma.Decimal | null;
  totalOdds: Prisma.Decimal | null;
  stake: Prisma.Decimal;
}

// Stage 13.6 — same message shape/tone/emoji convention as confirm/reject's
// existing notifications (app/api/bets/[id]/confirm/route.ts,
// app/api/bets/[id]/reject/route.ts): 🟢/🔴/⚪ heading, ⚽ event, 🎯
// selection, escapeHtml() on every dynamic field, Decimal.toString() (never
// a raw Decimal object, never a plain-number reformat). Only player-facing
// figures appear here — no bet id, transaction id, error code, or any other
// internal/technical field.
function buildSettlementMessage(result: AppliedSettleResult, bet: SettledBetDisplayFields): string {
  const event = escapeHtml(bet.event ?? "—");
  const normalizedOutcome =
    bet.outcome !== null ? normalizeSelectionToEnglish({ selection: bet.outcome, sport: bet.sport, event: bet.event }) : bet.outcome;
  const outcome = escapeHtml(normalizedOutcome ?? "—");
  const stake = bet.stake.toString();
  const effectiveOdds = bet.totalOdds ?? bet.odds;
  const oddsLine = effectiveOdds !== null ? `📈 Коэффициент: ${effectiveOdds.toString()}\n` : "";

  if (result.status === "SETTLED_WIN") {
    return (
      `🟢 <b>Ставка выиграла!</b>\n` +
      `⚽ ${event}\n` +
      `🎯 ${outcome}\n` +
      `💰 Ставка: ${stake}\n` +
      oddsLine +
      `💵 Выплата: ${result.grossPayout?.toString() ?? "—"}\n` +
      `📊 Чистая прибыль: ${result.netProfit?.toString() ?? "—"}\n` +
      `💳 Баланс: ${result.balanceAfter.toString()}`
    );
  }

  if (result.status === "SETTLED_LOSS") {
    return (
      `🔴 <b>Ставка не зашла</b>\n` +
      `⚽ ${event}\n` +
      `🎯 ${outcome}\n` +
      `💰 Ставка: ${stake}\n` +
      oddsLine +
      `📉 Проигрыш: ${stake}\n` +
      `💳 Баланс: ${result.balanceAfter.toString()}`
    );
  }

  // VOID
  return (
    `⚪ <b>Ставка аннулирована</b>\n` +
    `⚽ ${event}\n` +
    `🎯 ${outcome}\n` +
    `💰 Ставка: ${stake}\n` +
    `↩️ Возврат: ${stake}\n` +
    `💳 Баланс: ${result.balanceAfter.toString()}`
  );
}

// Best-effort, non-blocking — mirrors confirm/reject's exact
// try/catch-and-log-only shape. Only ever called after settleBet() has
// already returned APPLIED (i.e., after the transaction committed), so a
// failure here can never roll back or affect the settlement itself, and
// this function itself never throws — the caller doesn't need its own
// try/catch around it. A missing telegramId is skipped silently (no log),
// matching confirm/reject's existing `if (player.telegramId) { ... }`
// behavior exactly — there is no else/log branch there either.
async function notifySettlementResult(db: PrismaClient, result: AppliedSettleResult): Promise<void> {
  try {
    const bet = await db.bet.findUnique({
      where: { id: result.betId },
      select: {
        sport: true,
        event: true,
        outcome: true,
        odds: true,
        totalOdds: true,
        stake: true,
        player: { select: { telegramId: true } },
      },
    });

    if (!bet?.player.telegramId) return;

    await sendTelegramMessage(bet.player.telegramId, buildSettlementMessage(result, bet));
  } catch (err) {
    console.error(`POST /api/bets/${result.betId}/settle: failed to notify player via Telegram`, err);
  }
}

// Exported and DI-friendly (same shape as
// app/api/miniapp/bets/text/confirm/route.ts's handleBetConfirm) so route
// tests can inject a fake db instead of hitting a real database — POST
// itself always calls this with no overrides.
export async function handleSettleBet(
  request: NextRequest,
  betId: string,
  options: HandleSettleBetOptions = {},
): Promise<NextResponse> {
  if (!isOperatorAuthorized(request)) {
    return errorResponse(401, { code: "UNAUTHORIZED", message: "Unauthorized" });
  }

  if (!betId) {
    return errorResponse(400, { code: "INVALID_REQUEST", message: "Missing bet id" });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, { code: "INVALID_JSON", message: "Malformed JSON body" });
  }

  const status = typeof body === "object" && body !== null ? (body as { status?: unknown }).status : undefined;

  // A cheap, request-shape-only pre-check (reusing settlementRules.ts's own
  // isSettlementTarget guard, not a hand-rolled duplicate) so an obviously
  // malformed request never even reaches the database layer. This is NOT
  // the transition matrix — whether the bet's *current* status can actually
  // move to this target is decided exclusively inside settleBet(), below.
  if (!isSettlementTarget(status)) {
    return errorResponse(422, {
      code: "INVALID_SETTLEMENT_TARGET",
      message: "status must be one of SETTLED_WIN, SETTLED_LOSS, VOID",
      betId,
      requestedStatus: status,
    });
  }

  const db = options.db ?? prisma;

  try {
    const result = await settleBet(db, { betId, requestedStatus: status });

    // Only ever fires for a real APPLY (never IDEMPOTENT, never on a
    // thrown error — this line is unreached in both those cases) — exactly
    // one notification per successfully applied settlement.
    if (result.kind === "APPLIED") {
      await notifySettlementResult(db, result);
    }

    return NextResponse.json({ success: true, result: serializeSettleResult(result) }, { status: 200 });
  } catch (err) {
    return mapSettlementError(err, betId);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  return handleSettleBet(request, id);
}
