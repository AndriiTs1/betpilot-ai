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
