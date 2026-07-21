import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import type { Bet, BetSelection, PrismaClient } from "@/lib/generated/prisma/client";
import { verifyInitData } from "@/lib/telegram/verifyInitData";
import {
  verifyPreviewToken,
  verifyExpressPreviewToken,
  type VerifyPreviewTokenFailureReason,
} from "@/lib/betPreview/previewToken";
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

// Stage 12, Phase 4, Step 4 — reads *only* the token's own `type` field,
// from its base64url JSON payload segment, with no signature check. This
// exists solely to pick which of the two already-existing, independently
// full verify functions to call below — verifyPreviewToken/
// verifyExpressPreviewToken each still re-parse the same raw token string
// from scratch and do their own complete signature + shape + expiry
// verification. Nothing decoded here is trusted for anything else: it is
// never written to the database, never used to build a response, and never
// substituted for what the chosen verify function itself decodes after
// checking the signature. If this peek fails to recognize a type (garbage,
// truncated, wrong encoding), it falls through to the SINGLE verifier —
// the same one that handled every previewToken before EXPRESS existed —
// which will correctly reject a genuinely malformed token on its own.
function peekPreviewTokenType(token: string): "SINGLE" | "EXPRESS" | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [encodedPayload] = parts;
  if (!encodedPayload) return null;

  try {
    const decoded: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return null;

    const type = (decoded as Record<string, unknown>).type;
    if (type === "SINGLE" || type === "EXPRESS") return type;
    return null;
  } catch {
    return null;
  }
}

// Shared by both branches below: malformed / invalid_signature /
// invalid_version / invalid_payload all collapse to the same public
// PREVIEW_INVALID code (the specific reason is logged server-side only,
// never in the response) — unchanged from the SINGLE-only behavior this
// route already had; EXPRESS reuses the identical mapping rather than
// inventing a parallel one.
function verifyFailureResponse(reason: VerifyPreviewTokenFailureReason, tokenKind: "SINGLE" | "EXPRESS") {
  if (reason === "expired") {
    return NextResponse.json({ error: "PREVIEW_EXPIRED" }, { status: 410 });
  }

  console.error(`POST /api/miniapp/bets/text/confirm: ${tokenKind} token rejected:`, reason);
  return NextResponse.json({ error: "PREVIEW_INVALID" }, { status: 422 });
}

// Whitelisted, client-facing shape only — deliberately excludes previewId,
// playerId, rawMessage, and every other internal Prisma column. Unchanged
// from Phase 3: same fields, same .toNumber() (not .toString()) — SINGLE's
// response shape stays exactly backward compatible.
function serializeSingleBet(bet: Bet) {
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

// New for Step 4. Decimal fields are always .toString() here, never
// .toNumber() — a deliberate difference from serializeSingleBet above (that
// one is frozen for backward compatibility; this one is new and follows
// this step's explicit "Decimal values as strings" requirement). "id" is
// this bet's existing public identifier — no separate ticketId field is
// introduced; nothing in the codebase has one today, and inventing one
// isn't this step's job.
function serializeExpressSelection(selection: BetSelection) {
  return {
    id: selection.id,
    sport: selection.sport,
    event: selection.event,
    outcome: selection.outcome,
    market: selection.market,
    odds: selection.odds !== null ? selection.odds.toString() : null,
    currentOdds: selection.currentOdds !== null ? selection.currentOdds.toString() : null,
    oddsStatus: selection.oddsStatus,
  };
}

function serializeExpressBet(bet: Bet & { selections: BetSelection[] }) {
  return {
    id: bet.id,
    status: bet.status,
    type: bet.type,
    sport: bet.sport,
    event: bet.event,
    outcome: bet.outcome,
    odds: bet.odds !== null ? bet.odds.toString() : null,
    stake: bet.stake.toString(),
    totalOdds: bet.totalOdds !== null ? bet.totalOdds.toString() : null,
    createdAt: bet.createdAt.toISOString(),
    selections: bet.selections.map(serializeExpressSelection),
  };
}

// Injectable so tests can supply an in-memory fake db and self-chosen
// crypto material instead of a real database connection / real Telegram
// bot token / real preview-token secret — same DI shape as
// createBetFromPreview.ts's CreateBetFromPreviewOptions. POST (the actual
// Next.js route export, whose signature is fixed by the framework) always
// calls this with no overrides, so production behavior is byte-for-byte
// what it was before this option existed.
export interface HandleBetConfirmOptions {
  db?: PrismaClient;
  botToken?: string;
  previewTokenSecret?: string;
}

export async function handleBetConfirm(
  request: NextRequest,
  options: HandleBetConfirmOptions = {},
): Promise<NextResponse> {
  const db = options.db ?? prisma;

  const initData = extractInitData(request);
  if (!initData) {
    return NextResponse.json({ error: "malformed" }, { status: 401 });
  }

  const botToken = options.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("POST /api/miniapp/bets/text/confirm: TELEGRAM_BOT_TOKEN is not set");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  const previewTokenSecret = options.previewTokenSecret ?? process.env.BET_PREVIEW_TOKEN_SECRET;
  if (!previewTokenSecret) {
    console.error("POST /api/miniapp/bets/text/confirm: BET_PREVIEW_TOKEN_SECRET is not set");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  const verification = verifyInitData(initData, botToken);
  if (!verification.ok) {
    return NextResponse.json({ error: verification.reason }, { status: 401 });
  }

  try {
    const player = await db.player.findUnique({
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

    // Only previewToken is ever read from the request body — no other
    // field (type, selections, stake, odds, ...) is consulted anywhere in
    // this route. Everything about the bet being confirmed comes from
    // inside the signed token itself, verified below.
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

    // Unsigned peek, dispatch-only — see peekPreviewTokenType's own comment.
    // A peek that can't recognize a type falls through to the SINGLE path,
    // matching this route's exact pre-Step-4 behavior for anything that
    // isn't a valid EXPRESS token.
    const peekedType = peekPreviewTokenType(previewToken);

    if (peekedType === "EXPRESS") {
      const verified = verifyExpressPreviewToken(previewToken, previewTokenSecret);

      if (!verified.ok) {
        return verifyFailureResponse(verified.reason, "EXPRESS");
      }

      const payload = verified.payload;

      // Same anti-enumeration behavior as SINGLE below: a different
      // player's token is reported identically to any other invalid token.
      if (payload.playerId !== player.id) {
        return NextResponse.json({ error: "PREVIEW_INVALID" }, { status: 422 });
      }

      const { bet, idempotent } = await createBetFromPreview(payload, { db });

      return NextResponse.json({
        bet: serializeExpressBet(bet),
        idempotent,
      });
    }

    const verified = verifyPreviewToken(previewToken, previewTokenSecret);

    if (!verified.ok) {
      return verifyFailureResponse(verified.reason, "SINGLE");
    }

    const payload = verified.payload;

    // Player mismatch reported identically to any other invalid token —
    // never confirms or denies that a *different* player's token was used.
    if (payload.playerId !== player.id || payload.type !== "SINGLE") {
      return NextResponse.json({ error: "PREVIEW_INVALID" }, { status: 422 });
    }

    const { bet, idempotent } = await createBetFromPreview(payload, { db });

    return NextResponse.json({
      bet: serializeSingleBet(bet),
      idempotent,
    });
  } catch (err) {
    console.error("POST /api/miniapp/bets/text/confirm failed:", err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleBetConfirm(request);
}
