import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import type { Bet } from "@/lib/generated/prisma/client";
import { verifyInitData } from "@/lib/telegram/verifyInitData";
import { verifyPreviewToken } from "@/lib/betPreview/previewToken";
import { createBetFromPreview } from "@/lib/bets/createBetFromPreview";

// Requires node:crypto (verifyInitData/verifyPreviewToken) and Prisma —
// neither runs on the Edge runtime.
export const runtime = "nodejs";

// A real token is ~500-600 chars (measured in production); this is a
// generous upper bound against an oversized body, not a tight budget.
const PREVIEW_TOKEN_MAX_LENGTH = 2048;

// Same header-parsing shape as the preview route and GET /api/miniapp/me.
// Duplicated rather than shared for the same reason as there — it's a 6-line
// parse, not the actual verification logic.
function extractInitData(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "tma" || !value) return null;

  return value;
}

// Whitelisted, client-facing shape only — deliberately excludes previewId,
// playerId, rawMessage, and every other internal Prisma column.
function serializeBet(bet: Bet) {
  return {
    id: bet.id,
    status: bet.status,
    type: bet.type,
    sport: bet.sport,
    event: bet.event,
    outcome: bet.outcome,
    stake: bet.stake.toNumber(),
    odds: bet.odds !== null ? bet.odds.toNumber() : null,
    totalOdds: bet.totalOdds !== null ? bet.totalOdds.toNumber() : null,
    createdAt: bet.createdAt.toISOString(),
  };
}

export async function POST(request: NextRequest) {
  const initData = extractInitData(request);
  if (!initData) {
    return NextResponse.json({ error: "malformed" }, { status: 401 });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("POST /api/miniapp/bets/text/confirm: TELEGRAM_BOT_TOKEN is not set");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  const previewTokenSecret = process.env.BET_PREVIEW_TOKEN_SECRET;
  if (!previewTokenSecret) {
    console.error("POST /api/miniapp/bets/text/confirm: BET_PREVIEW_TOKEN_SECRET is not set");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  const verification = verifyInitData(initData, botToken);
  if (!verification.ok) {
    return NextResponse.json({ error: verification.reason }, { status: 401 });
  }

  try {
    const player = await prisma.player.findUnique({
      where: { telegramId: String(verification.user.id) },
      select: { id: true },
    });

    if (!player) {
      return NextResponse.json({ error: "PLAYER_NOT_FOUND" }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }

    if (
      typeof body !== "object" ||
      body === null ||
      !("previewToken" in body) ||
      typeof (body as { previewToken: unknown }).previewToken !== "string"
    ) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }

    const previewToken = (body as { previewToken: string }).previewToken;

    if (previewToken.length === 0 || previewToken.length > PREVIEW_TOKEN_MAX_LENGTH) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }

    const verified = verifyPreviewToken(previewToken, previewTokenSecret);

    if (!verified.ok) {
      if (verified.reason === "expired") {
        return NextResponse.json({ error: "PREVIEW_EXPIRED" }, { status: 410 });
      }

      // malformed / invalid_signature / invalid_version / invalid_payload
      // all collapse to the same public code — the specific reason is
      // logged server-side only, never in the response.
      console.error("POST /api/miniapp/bets/text/confirm: token rejected:", verified.reason);
      return NextResponse.json({ error: "PREVIEW_INVALID" }, { status: 422 });
    }

    const payload = verified.payload;

    // Player mismatch reported identically to any other invalid token —
    // never confirms or denies that a *different* player's token was used.
    if (payload.playerId !== player.id || payload.type !== "SINGLE") {
      return NextResponse.json({ error: "PREVIEW_INVALID" }, { status: 422 });
    }

    const { bet, idempotent } = await createBetFromPreview(payload);

    return NextResponse.json({
      bet: serializeBet(bet),
      idempotent,
    });
  } catch (err) {
    console.error("POST /api/miniapp/bets/text/confirm failed:", err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
