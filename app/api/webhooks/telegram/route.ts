import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/client";
import { sendTelegramMessage } from "@/lib/telegram/sendMessage";
import { isTelegramWebhookAuthorized } from "@/lib/auth/telegramWebhookAuth";
import { bindInvitedPlayerByTelegramUsername } from "@/lib/telegram/bindInvitedPlayer";

interface TelegramUpdate {
  message?: {
    date: number;
    text?: string;
    chat: { id: number };
    // username is genuinely optional in the Bot API (not every Telegram
    // account has one set) — closed-demo onboarding (see
    // lib/telegram/bindInvitedPlayer.ts) is the only thing that reads it;
    // everything else in this route is unaffected by its presence/absence.
    from: { id: number; username?: string };
  };
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

export async function POST(request: NextRequest) {
  if (!isTelegramWebhookAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as TelegramUpdate;

    // Non-message updates (edited_message, callback_query, channel_post,
    // etc.) have no `message` field — nothing for us to process.
    if (!body.message) {
      return NextResponse.json({ ok: true });
    }

    const tgMessage = body.message;

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
      await bindInvitedPlayerByTelegramUsername(prisma, String(tgMessage.from.id), tgMessage.from.username);

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
