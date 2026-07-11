export type TransactionType = "DEPOSIT" | "BET" | "WIN" | "LOSS" | "WITHDRAWAL";

export interface Transaction {
  id: string;

  playerId: string;

  type: TransactionType;

  amount: number;

  currency: "USDC";

  description?: string;

  createdAt: Date;
}
