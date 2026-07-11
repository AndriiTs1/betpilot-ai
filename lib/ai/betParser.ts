import { Bet } from "@/types/bet";

export function parseBetMessage(text: string, playerId: string): Bet {
  return {
    id: crypto.randomUUID(),

    playerId,

    sport: "Football",

    event: "Real Madrid vs Barcelona",

    selection: "Real Madrid Win",

    stake: 100,

    currency: "USDC",

    odds: 2.1,

    status: "AI_ANALYZED",

    createdAt: new Date(),
  };
}
