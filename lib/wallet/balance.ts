export interface WalletBalance {
  playerId: string;

  balance: number;

  currency: "USDC";
}

export function checkBalance(wallet: WalletBalance, stake: number) {
  return wallet.balance >= stake;
}
