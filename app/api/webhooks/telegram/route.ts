import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/client";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { sendTelegramMessage } from "@/lib/telegram/sendMessage";
import { isTelegramWebhookAuthorized } from "@/lib/auth/telegramWebhookAuth";
import { bindInvitedPlayerByTelegramUsername } from "@/lib/telegram/bindInvitedPlayer";
import { handleScreenshotMessage } from "@/lib/telegram/handleScreenshotMessage";
import type { TelegramUpdate } from "@/lib/telegram/telegramTypes";

// Stage 14.1 — this route previously declared its own inline, text-only
// TelegramUpdate interface; it now imports the shared shape from
// lib/telegram/telegramTypes.ts (extended with photo/document/caption/
// update_id) so the screenshot-intake modules and this route can't drift
// out of sync with two independently-maintained copies of the same API
// shape.

// Duplicate-delivery guard (Part 8) — Telegram retries a webhook delivery
// whenever it doesn't get a prompt 200 back (slow cold start, transient
// error, etc.), and this route previously had *no* deduplication at all: a
// retried /start would just re-run bindInvitedPlayerByTelegramUsername
// (already idempotent) and resend the welcome text; a retried screenshot
// would re-download the file from Telegram and resend the "received"
// acknowledgement. Neither case can create a duplicate Bet/Transaction —
// nothing in this route or lib/telegram/handleScreenshotMessage.ts writes
// one — so the only real-world impact is a duplicate outbound message and
// wasted download bandwidth.
//
// No update_id-based deduplication exists anywhere else in the codebase
// (confirmed by full-repo search) and Part 8 explicitly forbids adding a
// schema change solely for this. This is the smallest safe mitigation that
// fits the existing architecture: an in-memory, size-capped set of recently
// seen update_ids, module-scoped to this route. It only protects against
// redeliveries that land on the same warm serverless instance — a cold
// start (or Fluid Compute routing the retry to a different instance) resets
// it, so this is a best-effort reduction of duplicate replies, not a
// guarantee. A guaranteed fix would need a persisted dedup key (e.g. a
// unique index on update_id), which is exactly the kind of schema change
// Part 8 says to stop and review separately rather than add here.
const MAX_TRACKED_UPDATE_IDS = 500;
const seenUpdateIds = new Set<number>();
const updateIdOrder: number[] = [];

function isDuplicateUpdate(updateId: number): boolean {
  if (seenUpdateIds.has(updateId)) return true;

  seenUpdateIds.add(updateId);
  updateIdOrder.push(updateId);

  if (updateIdOrder.length > MAX_TRACKED_UPDATE_IDS) {
    const oldest = updateIdOrder.shift();
    if (oldest !== undefined) seenUpdateIds.delete(oldest);
  }

  return false;
}

const WELCOME_TEXT =
  `👋 Добро пожаловать в BetPilot AI.\n\n` +
  `Ваш AI-ассистент для спортивных ставок.\n\n` +
  `Чтобы начать, нажмите кнопку ниже\n` +
  `и откройте Mini App.`;

// The bot is Mini-App-only: any chat input other than /start (plain text or
// another command) gets this same short nudge — the webhook never analyzes
// message content or replies with anything longer.
const REDIRECT_TEXT = "Для работы откройте приложение BetPilot AI.";

// Same "stable production origin" reasoning as lib/dashboard/operatorApiProxy.ts:
// request.url can resolve to a raw per-deployment URL, and Telegram's own
// servers (opening the web_app link) need a real public HTTPS URL, not that.
function resolveOrigin(request: NextRequest): string {
  const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return productionUrl ? `https://${productionUrl}` : new URL(request.url).origin;
}

function openAppKeyboard(origin: string) {
  return {
    inline_keyboard: [
      [{ text: "🚀 Открыть приложение", web_app: { url: `${origin}/miniapp` } }],
    ],
  };
}

// Commands always start with "/", optionally "@BotUsername"-suffixed and/or
// followed by a space-separated argument (e.g. "/start@BetPilotAI_bot ref_1")
// — strip both before matching so bet text starting with "/" (unlikely, but
// not impossible) doesn't get misrouted, and so real commands aren't missed.
function extractCommand(text: string): string | null {
  if (!text.startsWith("/")) return null;

  const firstToken = text.split(/\s/, 1)[0];
  const command = firstToken.slice(1).split("@", 1)[0].toLowerCase();

  return command || null;
}

// Injectable so tests can supply an in-memory fake db instead of the real
// shared production database — same DI shape as
// app/api/miniapp/bets/text/confirm/route.ts's handleBetConfirm and
// app/api/bets/[id]/settle/route.ts's handleSettleBet. POST (the actual
// Next.js route export) always calls this with no overrides.
export interface HandleTelegramWebhookOptions {
  db?: PrismaClient;
}

export async function handleTelegramWebhook(
  request: NextRequest,
  options: HandleTelegramWebhookOptions = {},
): Promise<NextResponse> {
  if (!isTelegramWebhookAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = options.db ?? prisma;

  try {
    const rawBody: unknown = await request.json();

    // Malformed/unexpected payload shapes (null, an array, a bare string,
    // an object missing the fields below) must never crash this route —
    // guarded explicitly here rather than relying only on the outer
    // catch's TypeError safety net, so the intent is visible at the call
    // site.
    if (typeof rawBody !== "object" || rawBody === null) {
      return NextResponse.json({ ok: true });
    }

    const body = rawBody as TelegramUpdate;

    if (typeof body.update_id === "number" && isDuplicateUpdate(body.update_id)) {
      return NextResponse.json({ ok: true });
    }

    // Non-message updates (edited_message, callback_query, channel_post,
    // etc.) have no `message` field — nothing for us to process.
    if (!body.message) {
      return NextResponse.json({ ok: true });
    }

    const tgMessage = body.message;

    // Stage 14.1 — image handling takes priority over text handling: a
    // photo/document message is fully handled (including whichever reply
    // fits its outcome) and never falls through to the text branch below.
    // This is also naturally exclusive already — Telegram puts a
    // photo/document message's caption in `caption`, never in `text` — but
    // checking image-first regardless makes that priority explicit rather
    // than incidental.
    const screenshotOutcome = await handleScreenshotMessage(tgMessage, { db });
    if (screenshotOutcome.kind !== "NO_IMAGE") {
      return NextResponse.json({ ok: true });
    }

    // Non-text messages (stickers, photos without a caption, etc.) — ignore.
    if (!tgMessage.text) {
      return NextResponse.json({ ok: true });
    }

    const chatId = String(tgMessage.chat.id);
    const origin = resolveOrigin(request);
    const command = extractCommand(tgMessage.text);

    if (command === "start") {
      // Closed-demo onboarding: silent bind attempt — the welcome message
      // below is identical regardless of outcome (bound just now, already
      // bound, or no invited match at all), so this never leaks to the
      // sender whether a given username exists in the system. An
      // unexpected error here (e.g. a transient DB error) propagates to
      // this route's existing outer catch, same as any other failure —
      // Telegram still gets an ok:true ack either way, just without the
      // welcome text on that one delivery.
      await bindInvitedPlayerByTelegramUsername(db, String(tgMessage.from.id), tgMessage.from.username);

      await sendTelegramMessage(chatId, WELCOME_TEXT, openAppKeyboard(origin));
      return NextResponse.json({ ok: true });
    }

    // Everything else — plain text or any other command — gets the same
    // redirect. The bot never parses message content into a bet.
    await sendTelegramMessage(chatId, REDIRECT_TEXT, openAppKeyboard(origin));

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("POST /api/webhooks/telegram failed:", err);
    return NextResponse.json({ ok: true });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleTelegramWebhook(request);
}
