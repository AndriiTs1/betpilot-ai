import { NextRequest, NextResponse } from "next/server";

import { processBet } from "@/lib/bets/betService";
import { sendTelegramMessage, sendTelegramPhoto } from "@/lib/telegram/sendMessage";
import { escapeHtml } from "@/lib/telegram/escapeHtml";
import { prisma } from "@/lib/db/client";
import { Message } from "@/types/message";

interface TelegramUpdate {
  message?: {
    date: number;
    text?: string;
    chat: { id: number };
    from: { id: number };
  };
}

const WELCOME_CAPTION =
  `🤖 <b>BetPilot AI</b> — ваш AI-помощник для ставок\n\n` +
  `Что я умею:\n` +
  `✅ Распознаю ставки из текста и скриншотов\n` +
  `✅ Проверяю актуальные коэффициенты\n` +
  `✅ Готовлю заявку для подтверждения оператором\n\n` +
  `📸 Просто отправьте текст ставки или скриншот купона`;

// Same "stable production origin" reasoning as lib/dashboard/operatorApiProxy.ts:
// request.url can resolve to a raw per-deployment URL, and Telegram's own
// servers (fetching the photo, opening the web_app link) need a real public
// HTTPS URL, not that.
function resolveOrigin(request: NextRequest): string {
  const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return productionUrl ? `https://${productionUrl}` : new URL(request.url).origin;
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

    // Commands are handled before any registration check or AI parsing —
    // /start must greet even a not-yet-registered player, and no command
    // (known or not) should ever be routed into the bet parser as text.
    const command = extractCommand(tgMessage.text);

    if (command !== null) {
      if (command === "start") {
        const origin = resolveOrigin(request);

        await sendTelegramPhoto(
          chatId,
          `${origin}/miniapp/welcome-640x360.jpg`,
          WELCOME_CAPTION,
          {
            inline_keyboard: [
              [{ text: "📊 Открыть панель", web_app: { url: `${origin}/miniapp` } }],
            ],
          },
        );
      }

      // Any other command (e.g. a future /help) is intentionally ignored
      // for now — silently ok:true, no reply, no fallthrough to the parser.
      return NextResponse.json({ ok: true });
    }

    const fromId = String(tgMessage.from.id);

    const player = await prisma.player.findUnique({ where: { telegramId: fromId } });

    if (!player) {
      await sendTelegramMessage(chatId, "🚫 Вы ещё не зарегистрированы.\nОбратитесь к оператору.");
      return NextResponse.json({ ok: true });
    }

    const message: Message = {
      id: crypto.randomUUID(),
      playerId: player.id,
      text: tgMessage.text,
      createdAt: new Date(tgMessage.date * 1000),
    };

    const result = await processBet(message);

    switch (result.status) {
      case "WAITING_CONFIRMATION": {
        const oddsLine = result.bet.odds !== null ? `, коэф. ${result.bet.odds.toString()}` : "";
        const text =
          `✅ <b>Заявка принята</b>\n` +
          `⚽ ${escapeHtml(result.bet.event)}\n` +
          `🎯 ${escapeHtml(result.bet.outcome)}\n` +
          `💰 Ставка: ${result.bet.stake.toString()}${oddsLine}\n\n` +
          `Ожидайте подтверждения оператора.`;
        await sendTelegramMessage(chatId, text);
        break;
      }

      case "PARSE_FAILED":
        await sendTelegramMessage(
          chatId,
          "⚠️ Не удалось распознать заявку.\n\nПопробуйте переформулировать, например:\n<i>Реал Мадрид победа коэф 2.1 ставлю 50</i>",
        );
        break;

      case "PLAYER_NOT_FOUND":
      case "DB_ERROR":
        console.error(`POST /api/webhooks/telegram: processBet returned ${result.status}`, result);
        await sendTelegramMessage(chatId, "⚠️ Произошла ошибка, попробуйте позже.");
        break;

      default:
        console.error(`POST /api/webhooks/telegram: unexpected processBet status`, result);
        await sendTelegramMessage(chatId, "⚠️ Произошла ошибка, попробуйте позже.");
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("POST /api/webhooks/telegram failed:", err);
    return NextResponse.json({ ok: true });
  }
}
