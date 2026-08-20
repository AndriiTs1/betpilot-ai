import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { verifyInitData } from "@/lib/telegram/verifyInitData";
import { verifyExpressPreviewToken, type VerifyPreviewTokenFailureReason } from "@/lib/betPreview/previewToken";
import {
  buildExpressLegExclusionPreview,
  ExpressLegExclusionError,
  type BuildExpressLegExclusionPreviewOptions,
} from "@/lib/bets/buildExpressLegExclusionPreview";
import { BetSlipValidationError } from "@/lib/bets/buildBetSlipPreview";
import { createRequestRateLimiter, safeCheckAndRecord, type RequestRateLimiter } from "@/lib/rateLimit/requestRateLimiter";
import { rateLimitedResponse } from "@/lib/rateLimit/rateLimitResponse";

// Sector 1 (ADR-0002) — EXPRESS per-leg unavailable recovery. Preview-only,
// same discipline as text/preview and screenshot/preview: no Prisma write
// anywhere in this route, the only DB access is the same read-only Player
// lookup those routes already do. The request body carries only a
// previewToken (already signed by an earlier preview call) and a list of
// leg indices to exclude — never odds/market/event data. All the real
// verification (signature, expiry, ownership, leg-recoverability,
// live-odds re-check) happens in verifyExpressPreviewToken and
// lib/bets/buildExpressLegExclusionPreview.ts; this route is a thin HTTP
// adapter over both, mirroring text/preview/route.ts's and
// text/confirm/route.ts's existing shape.

export const runtime = "nodejs";

const PREVIEW_TOKEN_MAX_LENGTH = 2048;
// Cheap upper bound checked before any real work — MAX_EXPRESS_SELECTIONS
// (10) already makes anything above this meaningless, but this route
// doesn't import that constant just to duplicate a redundant check;
// buildExpressLegExclusionPreview's own INVALID_LEG_INDEX check is the real
// gate against an out-of-range index.
const MAX_EXCLUDE_INDICES = 10;

// Step 13B-style provisional MVP rate limit — mirrors text/preview's own
// budget and reasoning (lib/telegram/oddsCommand.ts cooldown precedent,
// single-player usage, not bursts). A separate bucket from text_preview/
// text_confirm: leg exclusion is its own distinct action, not a retry of
// either.
const EXCLUDE_LEGS_RATE_LIMIT_MAX_REQUESTS = 5;
const EXCLUDE_LEGS_RATE_LIMIT_WINDOW_MS = 60_000;

const defaultExcludeLegsRateLimiter = createRequestRateLimiter({
  maxRequests: EXCLUDE_LEGS_RATE_LIMIT_MAX_REQUESTS,
  windowMs: EXCLUDE_LEGS_RATE_LIMIT_WINDOW_MS,
});

// Same header-parsing shape as every other /api/miniapp/* route.
function extractInitData(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "tma" || !value) return null;

  return value;
}

// Mirrors text/confirm/route.ts's verifyFailureResponse — expired/invalid
// collapse to the same two public codes, real reason logged server-only.
function verifyFailureResponse(reason: VerifyPreviewTokenFailureReason): NextResponse {
  if (reason === "expired") {
    return NextResponse.json({ error: "PREVIEW_EXPIRED" }, { status: 410 });
  }

  console.error("POST /api/miniapp/bets/express/exclude-legs: token rejected:", reason);
  return NextResponse.json({ error: "PREVIEW_INVALID" }, { status: 422 });
}

export interface HandleExpressLegExclusionOptions {
  db?: PrismaClient;
  botToken?: string;
  previewTokenSecret?: string;
  verifyOddsFn?: BuildExpressLegExclusionPreviewOptions["verifyOddsFn"];
  oddsVerificationService?: BuildExpressLegExclusionPreviewOptions["oddsVerificationService"];
  rateLimiter?: RequestRateLimiter;
}

export async function handleExpressLegExclusion(
  request: NextRequest,
  options: HandleExpressLegExclusionOptions = {},
): Promise<NextResponse> {
  const db = options.db ?? prisma;

  const initData = extractInitData(request);
  if (!initData) {
    return NextResponse.json({ error: "malformed" }, { status: 401 });
  }

  const botToken = options.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("POST /api/miniapp/bets/express/exclude-legs: TELEGRAM_BOT_TOKEN is not set");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  const previewTokenSecret = options.previewTokenSecret ?? process.env.BET_PREVIEW_TOKEN_SECRET;
  if (!previewTokenSecret) {
    console.error("POST /api/miniapp/bets/express/exclude-legs: BET_PREVIEW_TOKEN_SECRET is not set");
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

    // Only previewToken and excludeIndices are ever read from the request
    // body — no odds/market/event field is consulted anywhere in this
    // route. Everything about the bet's legs comes from inside the signed
    // token, verified below.
    if (
      typeof body !== "object" ||
      body === null ||
      !("previewToken" in body) ||
      typeof (body as { previewToken: unknown }).previewToken !== "string" ||
      !("excludeIndices" in body) ||
      !Array.isArray((body as { excludeIndices: unknown }).excludeIndices)
    ) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }

    const previewToken = (body as { previewToken: string }).previewToken;
    const rawExcludeIndices = (body as { excludeIndices: unknown[] }).excludeIndices;

    if (previewToken.length === 0 || previewToken.length > PREVIEW_TOKEN_MAX_LENGTH) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }

    if (
      rawExcludeIndices.length === 0 ||
      rawExcludeIndices.length > MAX_EXCLUDE_INDICES ||
      !rawExcludeIndices.every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0)
    ) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }

    const excludeIndices = rawExcludeIndices as number[];

    const verified = verifyExpressPreviewToken(previewToken, previewTokenSecret);
    if (!verified.ok) {
      return verifyFailureResponse(verified.reason);
    }

    const payload = verified.payload;

    // Same anti-enumeration behavior as confirm: a different player's token
    // is reported identically to any other invalid token.
    if (payload.playerId !== player.id) {
      return NextResponse.json({ error: "PREVIEW_INVALID" }, { status: 422 });
    }

    const rateLimiter = options.rateLimiter ?? defaultExcludeLegsRateLimiter;
    const rateLimitDecision = safeCheckAndRecord(rateLimiter, String(verification.user.id), "express_exclude_legs");
    if (!rateLimitDecision.allowed) {
      return rateLimitedResponse(rateLimitDecision.retryAfterSeconds);
    }

    let result;
    try {
      result = await buildExpressLegExclusionPreview(payload, excludeIndices, previewTokenSecret, {
        verifyOddsFn: options.verifyOddsFn,
        oddsVerificationService: options.oddsVerificationService,
      });
    } catch (err) {
      if (err instanceof ExpressLegExclusionError) {
        return NextResponse.json({ error: err.code }, { status: 422 });
      }
      if (err instanceof BetSlipValidationError) {
        console.error("POST /api/miniapp/bets/express/exclude-legs: invalid bet slip:", err.code, err.message);
        return NextResponse.json({ error: "INVALID_BET_SLIP", detail: err.code }, { status: 422 });
      }
      throw err;
    }

    // Same response shape as text/preview's own success body — the client
    // reuses BetPreviewSuccess/isBetPreviewSuccess unchanged, no new
    // client-side response type needed for this endpoint.
    return NextResponse.json(result);
  } catch (err) {
    console.error("POST /api/miniapp/bets/express/exclude-legs failed:", err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleExpressLegExclusion(request);
}
