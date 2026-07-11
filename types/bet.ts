export type BetStatus =
  | "RECEIVED"
  | "AI_ANALYZED"
  | "WAITING_CONFIRMATION"
  | "CONFIRMED"
  | "SETTLED"
  | "PAID"
  | "REJECTED";

export type Currency = "USDC";

export interface Bet {
  id: string;

  playerId: string;

  sport: string;

  event: string;

  selection: string;

  stake: number;

  currency: Currency;

  odds: number;

  status: BetStatus;

  createdAt: Date;
}
