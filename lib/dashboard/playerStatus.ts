// Computes the single, highest-priority status a PlayerCard should show in
// its header. Every input here is a fact already available from
// GET /api/dashboard/players (available, activeBetsCount, telegramId) plus
// pendingBetsCount (new field, see that route) and the settlement countdown
// tone (already computed client-side by getSettlementCountdown() for the
// card's own "Settlement" ministat — passed in here rather than
// recalculated, so both consumers agree by construction).
//
// Priority order (highest first) — a player showing "Credit Exhausted" is
// more actionable to an operator than one merely "Pending Bets", so only one
// status is ever shown, picked by this fixed precedence:
//   1. Credit Exhausted   — available <= 0
//   2. Settlement Due     — settlement date reached or passed
//   3. Pending Bets       — has bets awaiting operator decision
//   4. Exposure Active    — has confirmed, not-yet-settled bets
//   5. Telegram Not Linked
//   6. Active              — none of the above

export type PlayerStatusKey =
  | "CREDIT_EXHAUSTED"
  | "SETTLEMENT_DUE"
  | "PENDING_BETS"
  | "EXPOSURE_ACTIVE"
  | "TELEGRAM_NOT_LINKED"
  | "ACTIVE";

export type PlayerStatusTone = "red" | "amber" | "yellow" | "blue" | "slate" | "green";

export interface PlayerStatus {
  key: PlayerStatusKey;
  label: string;
  /** Full sentence for a title/aria-label — never emoji, matches the dot+text badge convention used elsewhere (StatusBadge, the old Telegram pill). */
  description: string;
  tone: PlayerStatusTone;
}

export interface PlayerStatusInput {
  /** Decimal string, as returned by the API (already clamped to >= 0 for display there). */
  available: string;
  isSettlementDueOrOverdue: boolean;
  pendingBetsCount: number;
  /** Count of CONFIRMED, not-yet-settled bets — doubles as "has exposure". */
  activeBetsCount: number;
  hasTelegramLinked: boolean;
}

export function computePlayerStatus(input: PlayerStatusInput): PlayerStatus {
  const availableNum = Number(input.available);

  if (Number.isFinite(availableNum) && availableNum <= 0) {
    return {
      key: "CREDIT_EXHAUSTED",
      label: "Credit Exhausted",
      description: "This player has no available credit remaining.",
      tone: "red",
    };
  }

  if (input.isSettlementDueOrOverdue) {
    return {
      key: "SETTLEMENT_DUE",
      label: "Settlement Due",
      description: "This player's settlement date has arrived or passed.",
      tone: "amber",
    };
  }

  if (input.pendingBetsCount > 0) {
    return {
      key: "PENDING_BETS",
      label: "Pending Bets",
      description: `${input.pendingBetsCount} bet${input.pendingBetsCount === 1 ? "" : "s"} awaiting confirmation.`,
      tone: "yellow",
    };
  }

  if (input.activeBetsCount > 0) {
    return {
      key: "EXPOSURE_ACTIVE",
      label: "Exposure Active",
      description: `${input.activeBetsCount} confirmed bet${input.activeBetsCount === 1 ? "" : "s"} not yet settled.`,
      tone: "blue",
    };
  }

  if (!input.hasTelegramLinked) {
    return {
      key: "TELEGRAM_NOT_LINKED",
      label: "Telegram Not Linked",
      description: "This player has not linked a Telegram account yet.",
      tone: "slate",
    };
  }

  return {
    key: "ACTIVE",
    label: "Active",
    description: "No pending actions for this player.",
    tone: "green",
  };
}
