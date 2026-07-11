import { Message } from "@/types/message";
import { handleIncomingBet } from "@/lib/whatsapp/betHandler";
import { checkBalance } from "@/lib/wallet/balance";
import { createTransaction } from "@/lib/wallet/transaction";

export function processBet(message: Message) {
  // 1. Получаем и анализируем ставку
  const result = handleIncomingBet(message);

  const { bet, oddsCheck } = result;

  // 2. Проверяем коэффициент

  if (!oddsCheck.isValid) {
    return {
      status: "ODDS_CHANGED",

      bet,

      oddsCheck,
    };
  }

  // 3. Проверяем баланс

  const wallet = {
    playerId: message.playerId,

    balance: 1000,

    currency: "USDC" as const,
  };

  const hasBalance = checkBalance(wallet, bet.stake);

  if (!hasBalance) {
    return {
      status: "INSUFFICIENT_BALANCE",
    };
  }

  // 4. Создаем транзакцию

  const transaction = createTransaction(
    message.playerId,
    "BET_PLACED",
    -bet.stake,
  );

  return {
    status: "WAITING_CONFIRMATION",

    bet,

    transaction,
  };
}
