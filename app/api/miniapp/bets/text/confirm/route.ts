import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import type { Bet, BetSelection, PrismaClient } from "@/lib/generated/prisma/client";
import { verifyInitData } from "@/lib/telegram/verifyInitData";
import {
  verifyPreviewToken,
  verifyExpressPreviewToken,
  PREVIEW_TOKEN_MAX_LENGTH,
  type VerifyPreviewTokenFailureReason,
} from "@/lib/betPreview/previewToken";
import { createBetFromPreview } from "@/lib/bets/createBetFromPreview";
import { normalizeSelectionToEnglish } from "@/lib/bets/normalizeSelectionToEnglish";
import { verifyPreviewFreshness, type VerifyPreviewFreshnessOptions } from "@/lib/bets/verifyPreviewFreshness";
import {
  verifySportmonksPreviewFreshness,
  type VerifySportmonksPreviewFreshnessOptions,
} from "@/lib/bets/verifySportmonksPreviewFreshness";
import { createRequestRateLimiter, safeCheckAndRecord, type RequestRateLimiter } from "@/lib/rateLimit/requestRateLimiter";
import { rateLimitedResponse } from "@/lib/rateLimit/rateLimitResponse";

// Requires node:crypto (verifyInitData/verifyPreviewToken) and Prisma —
// neither runs on the Edge runtime.
export const runtime = "nodejs";

// Step 13B — PROVISIONAL MVP CONFIGURATION VALUE (Step 13A Section 9).
// Higher than either preview route's: a cheap-to-reject invalid/expired
// token never reaches this limiter at all (see Step 13A-R's approved
// ordering below), so this budget only needs to bound genuinely fresh
// confirm attempts (each triggering one verifyPreviewFreshness/odds-provider
// call), not cheap-reject traffic. Not derived from a documented
// AI/odds-provider quota (none is published in this repository).
const TEXT_CONFIRM_RATE_LIMIT_MAX_REQUESTS = 10;
const TEXT_CONFIRM_RATE_LIMIT_WINDOW_MS = 60_000;

// One shared module-level instance for BOTH the SINGLE and EXPRESS branches
// below — Step 13A Section 9 / Step 13A-R Section 8 both require SINGLE and
// EXPRESS confirmation to share one per-user quota bucket, not two separate
// ones; a player confirming an EXPRESS bet must count against the same
// budget as one confirming a SINGLE bet. In-memory, process-local, resets
// on cold start — see lib/rateLimit/requestRateLimiter.ts's file header.
// Production always uses this default; tests inject their own isolated
// instance via options below.
const defaultTextConfirmRateLimiter = createRequestRateLimiter({
  maxRequests: TEXT_CONFIRM_RATE_LIMIT_MAX_REQUESTS,
  windowMs: TEXT_CONFIRM_RATE_LIMIT_WINDOW_MS,
});

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
    outcome:
      bet.outcome !== null
        ? normalizeSelectionToEnglish({
            selection: bet.outcome,
            sport: bet.sport,
            event: bet.event,
            // Individual Team Totals, Stage 5B — the same canonical fields
            // already persisted at confirm time (Stage 5A) and already read
            // for settlement, now also read here so the final ticket can
            // render a TEAM_TOTAL selection from them instead of losing its
            // line (see lib/bets/normalizeSelectionToEnglish.ts's own
            // TEAM_TOTAL branch).
            marketType: bet.canonicalMarketType,
            selectionType: bet.canonicalSelectionType,
            participant: bet.canonicalParticipant,
            line: bet.line !== null ? bet.line.toString() : null,
          })
        : bet.outcome,
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
    outcome: normalizeSelectionToEnglish({
      selection: selection.outcome,
      sport: selection.sport,
      event: selection.event,
      market: selection.market,
      // Individual Team Totals, Stage 5B — same reasoning as
      // serializeSingleBet's identical addition above.
      marketType: selection.canonicalMarketType,
      selectionType: selection.canonicalSelectionType,
      participant: selection.canonicalParticipant,
      line: selection.line !== null ? selection.line.toString() : null,
    }),
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
    outcome:
      bet.outcome !== null
        ? normalizeSelectionToEnglish({ selection: bet.outcome, sport: bet.sport, event: bet.event })
        : bet.outcome,
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
  // Step 11B — forwarded as-is to verifyPreviewFreshness's own
  // buildBetSlipPreview call. Production supplies neither, so freshness
  // verification falls through to the real default provider, exactly like
  // preview creation already does.
  verifyOddsFn?: VerifyPreviewFreshnessOptions["verifyOddsFn"];
  oddsVerificationService?: VerifyPreviewFreshnessOptions["oddsVerificationService"];
  rateLimiter?: RequestRateLimiter;
  // Stage 10.2 — DI seam for revalidating a Sportmonks-sourced SINGLE
  // token, same shape convention as verifyOddsFn/oddsVerificationService
  // above. Production never overrides this.
  sportmonksFreshnessOptions?: VerifySportmonksPreviewFreshnessOptions["buildOptions"];
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

      // Step 11B idempotency fast-path — an already-confirmed preview must
      // never trigger a second (paid) provider call. Mirrors the exact same
      // previewId lookup createBetFromPreview.ts's own transaction performs,
      // run here first and read-only, purely to short-circuit before any
      // re-verification.
      const existingExpress = await db.bet.findUnique({
        where: { previewId: payload.previewId },
        include: { selections: true },
      });
      if (existingExpress) {
        return NextResponse.json({ bet: serializeExpressBet(existingExpress), idempotent: true });
      }

      // Step 13B / Step 13A-R — the rate limiter is consulted only here,
      // strictly after the idempotency lookup above has already proven no
      // Bet exists yet for this previewId. An idempotent retry therefore
      // never reaches this check and never consumes quota (Step 13A-R
      // Section 9's core guarantee); only a genuinely fresh confirm
      // attempt — the one about to trigger verifyPreviewFreshness's
      // odds-provider call — is gated here. Shared with the SINGLE branch's
      // identical check below via one module-level limiter instance, so
      // SINGLE and EXPRESS confirmations draw from the same per-user budget.
      const expressRateLimiter = options.rateLimiter ?? defaultTextConfirmRateLimiter;
      const expressRateLimitDecision = safeCheckAndRecord(expressRateLimiter, String(verification.user.id), "text_confirm");
      if (!expressRateLimitDecision.allowed) {
        return rateLimitedResponse(expressRateLimitDecision.retryAfterSeconds);
      }

      const expressFreshness = await verifyPreviewFreshness(payload, previewTokenSecret, {
        verifyOddsFn: options.verifyOddsFn,
        oddsVerificationService: options.oddsVerificationService,
      });

      if (expressFreshness.kind === "ODDS_CHANGED") {
        return NextResponse.json(
          {
            error: "ODDS_CHANGED_RECONFIRM_REQUIRED",
            refreshedPreview: expressFreshness.refreshedPreview,
            refreshedPreviewToken: expressFreshness.refreshedPreviewToken,
          },
          { status: 409 },
        );
      }

      if (expressFreshness.kind === "SELECTION_UNAVAILABLE") {
        return NextResponse.json({ error: "SELECTION_UNAVAILABLE" }, { status: 422 });
      }

      if (expressFreshness.kind === "VERIFICATION_UNAVAILABLE") {
        return NextResponse.json({ error: "VERIFICATION_UNAVAILABLE" }, { status: 503 });
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

    // Step 11B idempotency fast-path — an already-confirmed preview must
    // never trigger a second (paid) provider call. Mirrors the exact same
    // previewId lookup createBetFromPreview.ts's own transaction performs,
    // run here first and read-only, purely to short-circuit before any
    // re-verification.
    const existingSingle = await db.bet.findUnique({ where: { previewId: payload.previewId } });
    if (existingSingle) {
      return NextResponse.json({ bet: serializeSingleBet(existingSingle), idempotent: true });
    }

    // Step 15J — a SINGLE token with no confirmable current price means
    // either the player never had a price at all, or (Step 15I's new SINGLE
    // auto-lookup path) the provider lookup for a no-odds text bet never
    // resolved to a real price (event not found, market unsupported,
    // provider unavailable). Either way there is no verified number to bet
    // at. Blocked here, before any provider call or rate-limit consumption,
    // rather than silently creating a Bet with odds:null and no
    // OddsSnapshot. Deliberately not narrowed to "text-originated" tokens:
    // buildBetSlipPreview.ts (and therefore this exact PreviewTokenPayload
    // shape and this exact confirm route) is shared byte-for-byte by the
    // screenshot/OCR preview route too, with no field anywhere in the token
    // recording which route produced it — there is no way to distinguish
    // them here, and nothing in the app today (client-side
    // canConfirmBetSlip only checks previewToken !== null;
    // canSubmitBetSlip's operator-review odds-status allowance is defined
    // but has zero live call sites) actually depends on a null-price SINGLE
    // confirm succeeding for either origin.
    // Stage M4.8 — checks acceptedOdds (the confirmation baseline, BetPilot's
    // own current price), not `odds` (the player's own screenshot/typed
    // reference, which can be non-null even when there is genuinely no
    // confirmable current price — e.g. NOT_FOUND with a real submitted
    // number). This is also what keeps verifyPreviewFreshness's own
    // exemption-from-gating check safe for SINGLE: by the time freshness
    // runs, acceptedOdds is guaranteed non-null, so the lone selection can
    // never be skipped and silently ACCEPTed (see that file's own
    // hadAnyKnownPriceAtPreviewTime comment).
    if (payload.acceptedOdds === null) {
      return NextResponse.json(
        {
          error: "ODDS_REQUIRED_BEFORE_CONFIRMATION",
          message: "Odds could not be verified for this bet. Request a new preview or provide odds manually before confirming.",
        },
        { status: 422 },
      );
    }

    // Step 13B / Step 13A-R — see the identical comment in the EXPRESS
    // branch above: consulted only after the idempotency lookup has already
    // proven no Bet exists yet, so an idempotent retry never consumes
    // quota. Shares defaultTextConfirmRateLimiter (or the injected test
    // override) with the EXPRESS branch — one per-user budget for both.
    const singleRateLimiter = options.rateLimiter ?? defaultTextConfirmRateLimiter;
    const singleRateLimitDecision = safeCheckAndRecord(singleRateLimiter, String(verification.user.id), "text_confirm");
    if (!singleRateLimitDecision.allowed) {
      return rateLimitedResponse(singleRateLimitDecision.retryAfterSeconds);
    }

    // Step 11B — confirmation-time odds freshness verification. The one and
    // only new provider call this route makes: verifyPreviewFreshness is a
    // pure domain service (lib/bets/verifyPreviewFreshness.ts) that reuses
    // buildBetSlipPreview() exactly once, never a direct provider call, and
    // never a second comparison implementation.
    //
    // Stage 10.2 — a token whose payload.providerName is "SPORTMONKS"
    // (normalizeProviderMetadata guarantees this field is always a concrete
    // string on any verified token, old or new) is routed to the Sportmonks
    // equivalent instead: same contract (VerifyPreviewFreshnessDecision),
    // same reused decideFreshnessOutcome policy, but re-resolves via
    // Sportmonks (fixture-still-upcoming check + live 1X2 re-fetch) rather
    // than calling buildBetSlipPreview()/The Odds API. Every branch below
    // this point (ODDS_CHANGED / SELECTION_UNAVAILABLE /
    // VERIFICATION_UNAVAILABLE / createBetFromPreview) is completely
    // unaffected — it already operates generically on whichever
    // VerifyPreviewFreshnessDecision it receives.
    const freshness =
      payload.providerName === "SPORTMONKS"
        ? await verifySportmonksPreviewFreshness(payload, previewTokenSecret, {
            buildOptions: options.sportmonksFreshnessOptions,
          })
        : await verifyPreviewFreshness(payload, previewTokenSecret, {
            verifyOddsFn: options.verifyOddsFn,
            oddsVerificationService: options.oddsVerificationService,
          });

    if (freshness.kind === "ODDS_CHANGED") {
      return NextResponse.json(
        {
          error: "ODDS_CHANGED_RECONFIRM_REQUIRED",
          refreshedPreview: freshness.refreshedPreview,
          refreshedPreviewToken: freshness.refreshedPreviewToken,
        },
        { status: 409 },
      );
    }

    if (freshness.kind === "SELECTION_UNAVAILABLE") {
      return NextResponse.json({ error: "SELECTION_UNAVAILABLE" }, { status: 422 });
    }

    if (freshness.kind === "VERIFICATION_UNAVAILABLE") {
      return NextResponse.json({ error: "VERIFICATION_UNAVAILABLE" }, { status: 503 });
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
