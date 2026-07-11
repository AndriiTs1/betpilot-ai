import { Message } from "@/types/message";

export function processWhatsAppMessage(message: Message) {
  console.log("Incoming WhatsApp message");

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
