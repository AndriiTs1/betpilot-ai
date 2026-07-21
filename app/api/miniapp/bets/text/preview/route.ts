import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { verifyInitData } from "@/lib/telegram/verifyInitData";
import { parseBetSlipMessage } from "@/lib/ai/betParser";
import { buildBetSlipPreview, BetSlipValidationError } from "@/lib/bets/buildBetSlipPreview";

// Preview-only: parses a free-text bet (SINGLE or EXPRESS, Stage 12 Phase 3)
// and checks each selection's odds against the live market, but never
// touches Bet/BetSelection/OddsSnapshot. No Prisma write anywhere in this
// route — the only DB access is a read-only Player lookup, mirroring
// GET /api/miniapp/me.

const MESSAGE_MIN_LENGTH = 3;
const MESSAGE_MAX_LENGTH = 2000;

// Same header-parsing shape as GET /api/miniapp/me. Duplicated rather than
// extracted into a shared helper — it's a 6-line Authorization-header parse,
// not the actual signature verification (that part *is* reused as-is via
// verifyInitData()) — keeps this stage from touching an already-shipped,
// production-verified file for a non-functional refactor.
function extractInitData(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "tma" || !value) return null;

  return value;
}

export async function POST(request: NextRequest) {
  const initData = extractInitData(request);
  if (!initData) {
    return NextResponse.json({ error: "malformed" }, { status: 401 });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("POST /api/miniapp/bets/text/preview: TELEGRAM_BOT_TOKEN is not set");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  const previewTokenSecret = process.env.BET_PREVIEW_TOKEN_SECRET;
  if (!previewTokenSecret) {
    console.error("POST /api/miniapp/bets/text/preview: BET_PREVIEW_TOKEN_SECRET is not set");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  const verification = verifyInitData(initData, botToken);

  if (!verification.ok) {
    return NextResponse.json({ error: verification.reason }, { status: 401 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("message" in body) ||
    typeof (body as { message: unknown }).message !== "string"
  ) {
    return NextResponse.json({ error: "INVALID_MESSAGE" }, { status: 422 });
  }

  const message = (body as { message: string }).message.trim();

  if (message.length < MESSAGE_MIN_LENGTH || message.length > MESSAGE_MAX_LENGTH) {
    return NextResponse.json({ error: "INVALID_MESSAGE" }, { status: 422 });
  }

  try {
    const player = await prisma.player.findUnique({
      where: { telegramId: String(verification.user.id) },
      select: { id: true },
    });

    if (!player) {
      return NextResponse.json({ error: "PLAYER_NOT_FOUND" }, { status: 404 });
    }

    const parsed = await parseBetSlipMessage(message);

    if (!parsed.valid) {
      // parsed.error can contain provider/model/timeout/SDK detail — log it
      // server-side only, never in the response. Doesn't include the
      // player's message or any auth material.
      console.error("POST /api/miniapp/bets/text/preview: parse failed:", parsed.error);
      return NextResponse.json(
        { error: "PARSE_FAILED", detail: "Unable to understand the bet message" },
        { status: 422 },
      );
    }

    let result;
    try {
      result = await buildBetSlipPreview(parsed, player.id, previewTokenSecret);
    } catch (err) {
      if (err instanceof BetSlipValidationError) {
        console.error("POST /api/miniapp/bets/text/preview: invalid bet slip:", err.code, err.message);
        return NextResponse.json({ error: "INVALID_BET_SLIP", detail: err.code }, { status: 422 });
      }
      throw err;
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("POST /api/miniapp/bets/text/preview failed:", err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
