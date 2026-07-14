import { Message } from "@/types/message";

export function processTelegramMessage(message: Message) {
  console.log("Incoming Telegram message");

  console.log({
    playerId: message.playerId,
    text: message.text,
    receivedAt: message.createdAt,
  });

  return {
    status: "RECEIVED",
    messageId: message.id,
  };
}
