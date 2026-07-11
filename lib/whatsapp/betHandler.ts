import { Message } from "@/types/message";
import { processWhatsAppMessage } from "./messageProcessor";
import { parseBetMessage } from "@/lib/ai/betParser";
import { verifyOdds } from "@/lib/odds/oddsVerifier";

export async function handleIncomingBet(message: Message) {
  const received = processWhatsAppMessage(message);

  const bet = await parseBetMessage(message.text, message.playerId);

  if (!bet.valid) {
    return {
      received,
      bet,
      oddsCheck: null,
    };
  }

  // Player didn't mention odds — nothing to compare yet, verification
  // happens once odds are confirmed elsewhere.
  const oddsCheck = bet.odds !== null ? verifyOdds(bet.odds) : null;

  return {
    received,
    bet,
    oddsCheck,
  };
}
