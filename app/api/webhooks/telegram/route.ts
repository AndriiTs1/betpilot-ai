import { NextRequest, NextResponse } from "next/server";

import { processBet } from "@/lib/bets/betService";
import { sendTelegramMessage } from "@/lib/telegram/sendMessage";
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
    const fromId = String(tgMessage.from.id);

    const player = await prisma.player.findUnique({ where: { telegramId: fromId } });

    if (!player) {
      await sendTelegramMessage(chatId, "Вы ещё не зарегистрированы. Обратитесь к оператору.");
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
      case "WAITING_CONFIRMATION":
        await sendTelegramMessage(chatId, "Заявка получена, ожидает подтверждения оператора");
        break;

      case "PARSE_FAILED":
        await sendTelegramMessage(chatId, "Не удалось распознать заявку, попробуйте переформулировать");
        break;

      case "PLAYER_NOT_FOUND":
      case "DB_ERROR":
        console.error(`POST /api/webhooks/telegram: processBet returned ${result.status}`, result);
        await sendTelegramMessage(chatId, "Произошла ошибка, попробуйте позже");
        break;

      default:
        console.error(`POST /api/webhooks/telegram: unexpected processBet status`, result);
        await sendTelegramMessage(chatId, "Произошла ошибка, попробуйте позже");
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("POST /api/webhooks/telegram failed:", err);
    return NextResponse.json({ ok: true });
  }
}
