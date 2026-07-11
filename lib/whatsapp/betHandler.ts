import { Message } from "@/types/message";
import { processWhatsAppMessage } from "./messageProcessor";
import { parseBetMessage } from "@/lib/ai/betParser";
import { verifyOdds } from "@/lib/odds/oddsVerifier";

export function handleIncomingBet(message: Message) {
  const received = processWhatsAppMessage(message);

  const bet = parseBetMessage(message.text, message.playerId);

  const oddsCheck = verifyOdds(bet.odds);

  return {
    received,

    bet,

    oddsCheck,
  };
}
