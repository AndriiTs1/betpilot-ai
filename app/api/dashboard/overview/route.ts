import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

export async function GET() {
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

    return NextResponse.json({ activePlayers: distinctPlayers.length });
  } catch (err) {
    console.error("GET /api/dashboard/overview failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
