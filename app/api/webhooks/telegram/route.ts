import { NextRequest, NextResponse } from "next/server";

import { sendTelegramMessage } from "@/lib/telegram/sendMessage";
import { isTelegramWebhookAuthorized } from "@/lib/auth/telegramWebhookAuth";

interface TelegramUpdate {
  message?: {
    date: number;
    text?: string;
    chat: { id: number };
    from: { id: number };
  };
}

const WELCOME_TEXT =
  `👋 Добро пожаловать в BetPilot AI.\n\n` +
  `Ваш AI-ассистент для спортивных ставок.\n\n` +
  `Чтобы начать, откройте Mini App\n` +
  `кнопкой 🚀 ниже.`;

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
