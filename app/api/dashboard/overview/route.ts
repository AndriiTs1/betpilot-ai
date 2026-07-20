import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { computeRemainingCredit } from "@/lib/players/credit";
import { requireOperatorApi } from "@/lib/auth/requireOperator";

export async function GET(request: NextRequest) {
  const auth = await requireOperatorApi(request);
  if (!auth.ok) return auth.response;

  try {
    // Deliberately computed in JS, not as a single SQL aggregate: the
    // per-player "remaining credit" branches on the sign of currentCredit,
    // and this figure is correctness-critical (it's a credit exposure
    // total). An explicit loop is easier to verify than a conditional-sum
    // Prisma/SQL expression, and player counts here are small.
    const players = await prisma.player.findMany({
      select: { creditLimit: true, currentCredit: true },
    });

    const totalRemainingCredit = players.reduce(
      (total, player) => total.plus(computeRemainingCredit(player)),
      new Prisma.Decimal(0),
    );

    const pendingBetsCount = await prisma.bet.count({ where: { status: "PENDING" } });

    // Same explicit-reduce approach as totalRemainingCredit above, for
    // consistency: this particular sum has no per-row branching, so
    // aggregate({_sum}) would also be correct and simpler, but keeping one
    // pattern for "sum of a correctness-sensitive money figure" across this
    // file is easier to audit than mixing SQL-aggregate and JS-reduce sums.
    const pendingBets = await prisma.bet.findMany({
      where: { status: "PENDING" },
      select: { stake: true },
    });

    const pendingBetsSum = pendingBets.reduce(
      (total, bet) => total.plus(bet.stake),
      new Prisma.Decimal(0),
    );

    // "Played"/"Not Played" here is a temporary simplification:
    // CONFIRMED = "played", PENDING = "not played". That's not actually
    // whether the underlying match has finished — it will be revisited once
    // settlement (determining win/loss from the real match result) exists.
    // One query covers both count and sum here (unlike pendingBets above,
    // which follows the existing count()-then-findMany two-query shape) —
    // no established pattern to stay consistent with yet for this figure.
    const confirmedBets = await prisma.bet.findMany({
      where: { status: "CONFIRMED" },
      select: { stake: true },
    });

    const confirmedCount = confirmedBets.length;
    const confirmedSum = confirmedBets.reduce(
      (total, bet) => total.plus(bet.stake),
      new Prisma.Decimal(0),
    );

    // Stage 6.1 — Available = remaining credit limit minus currently-
    // confirmed exposure, summed across all players. Algebraically this is
    // Σ(remaining_i) − Σ(exposure_i) regardless of how exposure is grouped,
    // so it reuses the two sums already computed above rather than a new
    // per-player query. Same formula the Mini App and the Players list
    // already use per-player (app/api/miniapp/me/route.ts) — previously
    // this KPI only showed totalRemainingCredit, which didn't subtract
    // exposure and could visibly disagree with the per-player figure for
    // the same underlying state; added here as a new field (not a rename)
    // so totalRemainingCredit's own meaning is unchanged for any other
    // consumer.
    const totalAvailable = totalRemainingCredit.minus(confirmedSum);

    return NextResponse.json({
      activePlayers: players.length,
      totalRemainingCredit: totalRemainingCredit.toString(),
      totalAvailable: totalAvailable.toString(),
      pendingBetsCount,
      pendingBetsSum: pendingBetsSum.toString(),
      confirmedCount,
      confirmedSum: confirmedSum.toString(),
    });
  } catch (err) {
    console.error("GET /api/dashboard/overview failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
