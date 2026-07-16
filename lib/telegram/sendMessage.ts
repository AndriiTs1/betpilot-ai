export async function sendTelegramMessage(chatId: string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.error("sendTelegramMessage: TELEGRAM_BOT_TOKEN is not set");
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });

    if (!response.ok) {
      console.error(`sendTelegramMessage: Telegram API responded ${response.status}`, await response.text());
      return false;
    }

    return true;
  } catch (err) {
    console.error("sendTelegramMessage: request failed", err);
    return false;
  }
}

interface TelegramInlineKeyboardButton {
  text: string;
  web_app?: { url: string };
}

interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export async function sendTelegramPhoto(
  chatId: string,
  photoUrl: string,
  caption: string,
  replyMarkup?: TelegramInlineKeyboardMarkup,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.error("sendTelegramPhoto: TELEGRAM_BOT_TOKEN is not set");
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      }),
    });

    if (!response.ok) {
      console.error(`sendTelegramPhoto: Telegram API responded ${response.status}`, await response.text());
      return false;
    }

    return true;
  } catch (err) {
    console.error("sendTelegramPhoto: request failed", err);
    return false;
  }
}
