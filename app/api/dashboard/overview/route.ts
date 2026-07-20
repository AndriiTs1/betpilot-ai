import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { computeRemainingCredit } from "@/lib/players/credit";
import { requireOperatorApi } from "@/lib/auth/requireOperator";

export async function GET(request: NextRequest) {
  const auth = await requireOperatorApi(request);
  if (!auth.ok) return auth.response;

  try {
    // findMany({distinct}) is Prisma's purpose-built API for "give me the
    // distinct values of a field" (translates to SELECT DISTINCT ON in
    // Postgres). groupBy is designed for per-group aggregation (sum/avg/etc
    // per playerId) — it would also work here, but that's the wrong tool
    // for a plain dedup. Neither can return a single COUNT(DISTINCT ...)
    // scalar through Prisma's query builder, so both pull one row per
    // distinct player into the app and count .length; at this app's scale
    // that's fine. A raw $queryRaw`SELECT COUNT(DISTINCT "playerId") ...`
    // would be the next step if the player base grows large enough for the
    // row-transfer cost to matter.
    const distinctPlayers = await prisma.bet.findMany({
      distinct: ["playerId"],
      select: { playerId: true },
    });

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

    return NextResponse.json({
      activePlayers: distinctPlayers.length,
      totalRemainingCredit: totalRemainingCredit.toString(),
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
