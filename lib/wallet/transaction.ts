export type TransactionType = "BET_PLACED" | "BET_WIN" | "BET_LOSS" | "DEPOSIT";

export interface Transaction {
  id: string;

  playerId: string;

  type: TransactionType;

  amount: number;

  currency: "USDC";

  createdAt: Date;
}

export function createTransaction(
  playerId: string,
  type: TransactionType,
  amount: number,
): Transaction {
  return {
    id: crypto.randomUUID(),

    playerId,

    type,

    amount,

    currency: "USDC",

    createdAt: new Date(),
  };
}
