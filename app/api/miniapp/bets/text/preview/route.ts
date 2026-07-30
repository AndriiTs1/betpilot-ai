import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { verifyInitData } from "@/lib/telegram/verifyInitData";
import { parseBetSlipMessage } from "@/lib/ai/betParser";
import { buildBetSlipPreview, BetSlipValidationError, type BuildBetSlipPreviewOptions } from "@/lib/bets/buildBetSlipPreview";
import {
  buildSportmonksFootballPreview,
  isSportmonksFootballPreviewEnabled,
  signSportmonksFootballPreviewToken,
  type BuildSportmonksFootballPreviewOptions,
  type SportmonksFootballPreviewResult,
} from "@/lib/bets/buildSportmonksFootballPreview";
import { createRequestRateLimiter, safeCheckAndRecord, type RequestRateLimiter } from "@/lib/rateLimit/requestRateLimiter";
import { rateLimitedResponse } from "@/lib/rateLimit/rateLimitResponse";

// Preview-only: parses a free-text bet (SINGLE or EXPRESS, Stage 12 Phase 3)
// and checks each selection's odds against the live market, but never
// touches Bet/BetSelection/OddsSnapshot. No Prisma write anywhere in this
// route — the only DB access is a read-only Player lookup, mirroring
// GET /api/miniapp/me.

const MESSAGE_MIN_LENGTH = 3;
const MESSAGE_MAX_LENGTH = 2000;

// Step 13B — PROVISIONAL MVP CONFIGURATION VALUE (Step 13A Section 9). Not
// derived from a documented AI/odds-provider quota (none is published for
// either provider in this repository) — derived instead from the existing
// Telegram /odds cooldown precedent (lib/telegram/oddsCommand.ts) and normal
// single-player usage (one preview at a time, not bursts).
const TEXT_PREVIEW_RATE_LIMIT_MAX_REQUESTS = 5;
const TEXT_PREVIEW_RATE_LIMIT_WINDOW_MS = 60_000;

// Module-level singleton — one instance for the life of this warm serverless
// instance, exactly like defaultOddsVerificationService elsewhere in this
// codebase. In-memory, process-local, resets on cold start; never shared
// across concurrent instances or regions (see the module's own file header
// for the full best-effort-only explanation). Production code always uses
// this default; tests inject their own isolated instance via options below.
const defaultTextPreviewRateLimiter = createRequestRateLimiter({
  maxRequests: TEXT_PREVIEW_RATE_LIMIT_MAX_REQUESTS,
  windowMs: TEXT_PREVIEW_RATE_LIMIT_WINDOW_MS,
});

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

// Injectable so tests can supply a fake db/rate limiter/bet parser/odds
// verifier instead of a real database connection, a real Claude call, or a
// real Odds API call — same DI shape as handleScreenshotPreview/
// handleBetConfirm elsewhere in this codebase. POST always calls this with
// no overrides, so production behavior is unchanged.
export interface HandleTextPreviewOptions {
  db?: PrismaClient;
  botToken?: string;
  previewTokenSecret?: string;
  parseBetSlip?: typeof parseBetSlipMessage;
  verifyOddsFn?: BuildBetSlipPreviewOptions["verifyOddsFn"];
  rateLimiter?: RequestRateLimiter;
  // Stage 10 — DI seam for the Sportmonks football vertical slice, same
  // shape convention as verifyOddsFn above. Production never overrides
  // this; tests inject fakes so no real Sportmonks network call is ever
  // reachable from a test.
  sportmonksPreviewOptions?: BuildSportmonksFootballPreviewOptions;
}

// Stage 10 — maps every non-SUCCESS, non-NOT_APPLICABLE outcome of the
// Sportmonks football path to the same {error, detail} response shape this
// route already uses elsewhere. NOT_APPLICABLE is handled by the caller
// (falls through to the existing buildBetSlipPreview() pipeline) and never
// reaches this function.
function sportmonksFootballErrorResponse(result: Exclude<SportmonksFootballPreviewResult, { kind: "SUCCESS" | "NOT_APPLICABLE" }>): NextResponse {
  switch (result.kind) {
    case "TEAM_NOT_FOUND":
      return NextResponse.json({ error: "EVENT_NOT_FOUND", detail: "Команда или матч не найдены." }, { status: 422 });
    case "AMBIGUOUS":
      return NextResponse.json(
        { error: "AMBIGUOUS_EVENT", detail: "Найдено несколько подходящих событий. Уточните запрос." },
        { status: 422 },
      );
    case "INVALID_QUERY":
      return NextResponse.json({ error: "INVALID_BET_SLIP", detail: "INVALID_QUERY" }, { status: 422 });
    case "UNSUPPORTED_SELECTION":
      return NextResponse.json(
        { error: "UNSUPPORTED_SELECTION", detail: "Поддерживаются только исходы: победа хозяев, ничья, победа гостей." },
        { status: 422 },
      );
    case "ALREADY_STARTED":
      return NextResponse.json(
        { error: "EVENT_ALREADY_STARTED", detail: "Матч уже начался. Выберите другое событие." },
        { status: 422 },
      );
    case "ODDS_UNAVAILABLE":
      return NextResponse.json(
        { error: "ODDS_UNAVAILABLE", detail: "Коэффициент на выбранный исход сейчас недоступен." },
        { status: 422 },
      );
    case "FAILED":
      return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function handleTextPreview(
  request: NextRequest,
  options: HandleTextPreviewOptions = {},
): Promise<NextResponse> {
  const db = options.db ?? prisma;

  const initData = extractInitData(request);
  if (!initData) {
    return NextResponse.json({ error: "malformed" }, { status: 401 });
  }

  const botToken = options.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("POST /api/miniapp/bets/text/preview: TELEGRAM_BOT_TOKEN is not set");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  const previewTokenSecret = options.previewTokenSecret ?? process.env.BET_PREVIEW_TOKEN_SECRET;
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
    const player = await db.player.findUnique({
      where: { telegramId: String(verification.user.id) },
      select: { id: true },
    });

    if (!player) {
      return NextResponse.json({ error: "PLAYER_NOT_FOUND" }, { status: 404 });
    }

    // Step 13B — the one and only rate-limit check in this route, placed
    // immediately before the first expensive operation (the AI parse call)
    // and only after auth, body validation, and player resolution have all
    // already succeeded — a malformed/unauthenticated/unresolvable request
    // never reaches, and never consumes, this quota.
    const rateLimiter = options.rateLimiter ?? defaultTextPreviewRateLimiter;
    const rateLimitDecision = safeCheckAndRecord(rateLimiter, String(verification.user.id), "text_preview");
    if (!rateLimitDecision.allowed) {
      return rateLimitedResponse(rateLimitDecision.retryAfterSeconds);
    }

    const parseBetSlip = options.parseBetSlip ?? parseBetSlipMessage;
    const parsed = await parseBetSlip(message);

    if (!parsed.valid) {
      // parsed.error can contain provider/model/timeout/SDK detail — log it
      // server-side only, never in the response. Doesn't include the
      // player's message or any auth material.
      console.error("POST /api/miniapp/bets/text/preview: parse failed:", parsed.error);

      // Step 15J.3 — a parser-layer timeout gets its own honest response,
      // never folded into PARSE_FAILED's "we couldn't understand this bet"
      // (the message was perfectly understandable; Claude just never
      // finished in time). Mirrors the screenshot preview route's own
      // identical distinction (app/api/miniapp/bets/screenshot/preview/route.ts's
      // `if (parsed.code === "timeout")` branch) byte-for-byte — same
      // machine code, same status, same safe (raw-error-free) body shape.
      if (parsed.code === "timeout") {
        return NextResponse.json({ error: "AI_TIMEOUT" }, { status: 504 });
      }

      return NextResponse.json(
        { error: "PARSE_FAILED", detail: "Unable to understand the bet message" },
        { status: 422 },
      );
    }

    // Stage 10 — football vertical slice, gated behind
    // SPORTMONKS_FOOTBALL_PREVIEW_ENABLED (default false: this block is
    // never reached and behavior is byte-for-byte identical to before this
    // stage). Routing rule: football SINGLE bets go through Sportmonks
    // exclusively when the flag is on (never silently falling back to The
    // Odds API on a Sportmonks-side miss — see
    // buildSportmonksFootballPreview's own NOT_APPLICABLE vs. typed-failure
    // distinction); every other sport, and EXPRESS bets, are entirely
    // unaffected and keep using the existing buildBetSlipPreview() pipeline
    // below, unchanged.
    if (isSportmonksFootballPreviewEnabled()) {
      const sportmonksResult = await buildSportmonksFootballPreview(parsed, options.sportmonksPreviewOptions);
      if (sportmonksResult.kind === "SUCCESS") {
        // Stage 10.2 — a real, short-lived signed token (same mechanism,
        // same secret, same TTL as every other SINGLE preview), so Confirm
        // is no longer structurally disabled for a Sportmonks-sourced
        // preview. providerName:"SPORTMONKS" is what lets the confirm
        // route later route revalidation correctly (see
        // app/api/miniapp/bets/text/confirm/route.ts).
        const sportmonksPreviewToken = signSportmonksFootballPreviewToken(player.id, sportmonksResult, previewTokenSecret);
        return NextResponse.json({ preview: sportmonksResult.preview, previewToken: sportmonksPreviewToken });
      }
      if (sportmonksResult.kind !== "NOT_APPLICABLE") {
        return sportmonksFootballErrorResponse(sportmonksResult);
      }
      // NOT_APPLICABLE (not a SINGLE football bet) — falls through below.
    }

    let result;
    try {
      result = await buildBetSlipPreview(parsed, player.id, previewTokenSecret, {
        verifyOddsFn: options.verifyOddsFn,
      });
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleTextPreview(request);
}
