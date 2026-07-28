// Stage 3.2 — SELECTION OUTCOME EVALUATOR
//
// Pure domain evaluator: given a (possibly still-in-progress/cancelled/
// abandoned) event result and a previously-verified canonical selection,
// decides WIN / LOSS / VOID / WAITING / UNSUPPORTED / INVALID_DATA. This
// function does NOT: touch a database, call a provider, call AI, call
// settleBet(), mutate Player.currentCredit, create a Transaction, write
// logs, read Date.now(), or mutate either argument. Same input always
// produces the same output.
//
// Scope (Stage 3.2 only — see this stage's own conversation record for the
// full audit this was derived from):
//   - marketType: MONEYLINE_2WAY, MONEYLINE_3WAY only.
//   - period: FULL_GAME only (the only period the current provider pipeline
//     ever actually produces — see legacyOddsBridge.ts).
//   - selectionType: HOME/AWAY/DRAW only. PARTICIPANT (today's tennis
//     selections, matched by bare name with no home/away structure) is
//     UNSUPPORTED_SELECTION — section 5's moneyline rules are defined
//     purely in terms of HOME/AWAY/DRAW structural identity; matching a
//     bare participant name against a result would need a different
//     CanonicalEventResult shape (an ordered participant list, not fixed
//     home/away fields) this stage does not introduce.
// Anything outside this scope returns a typed UNSUPPORTED/INVALID_DATA
// result — this function never guesses.

import type { CanonicalSelection, MarketType, Period, SelectionType } from "@/lib/odds/domain";
import type { CanonicalEventResult, EventResultStatus } from "./eventResultDomain";

export type WinReasonCode = "WIN_HOME_PARTICIPANT" | "WIN_AWAY_PARTICIPANT" | "WIN_DRAW";
export type LossReasonCode = "LOSS_HOME_PARTICIPANT" | "LOSS_AWAY_PARTICIPANT" | "LOSS_DRAW";

// VOID here is a pure domain classification only — this function never
// calls settleBet()/settlementRules.ts, moves Bet.status, or touches money.
// A future stage decides whether/how a VOID evaluation becomes an actual
// financial VOID settlement.
export type VoidReasonCode =
  // Event never started and will not be played — the standard, essentially
  // unambiguous industry rule: void every bet on it. Safe to decide here
  // (not deferred to WAITING/manual review) because there is no competing
  // interpretation the way there is for ABANDONED below.
  | "VOID_CANCELLED"
  // MONEYLINE_2WAY has no DRAW selection option by construction
  // (lib/odds/domain.ts's validateCanonicalSelection forbids it) — if the
  // event nonetheless ends level, neither HOME nor AWAY can honestly be
  // called a winner or loser. Void/push is the standard, safe outcome.
  | "VOID_DRAW_TWO_WAY_MARKET";

// NOT_STARTED/IN_PROGRESS/POSTPONED all mean "no result yet, ask again
// later" — but POSTPONED keeps its own reason code (distinct from the
// generic EVENT_NOT_COMPLETED bucket) since "was scheduled, then explicitly
// delayed" is a useful distinct signal for a caller/operator. ABANDONED is
// WAITING, not VOID: unlike CANCELLED it has no single industry-standard
// rule (competition-specific rules on partial-completion thresholds,
// scoring at the moment of abandonment, etc. genuinely vary) — this stage
// refuses to pick one silently and defers to manual review instead.
export type WaitingReasonCode = "EVENT_NOT_COMPLETED" | "EVENT_POSTPONED" | "EVENT_ABANDONED";

export type UnsupportedReasonCode = "UNSUPPORTED_MARKET" | "UNSUPPORTED_SELECTION" | "UNSUPPORTED_PERIOD";

export type InvalidDataReasonCode =
  | "MISSING_SCORE"
  | "INVALID_SCORE"
  | "PARTICIPANT_MISMATCH"
  | "INVALID_EVENT_RESULT";

export type SelectionOutcomeEvaluation =
  | { readonly kind: "WIN"; readonly reasonCode: WinReasonCode }
  | { readonly kind: "LOSS"; readonly reasonCode: LossReasonCode }
  | { readonly kind: "VOID"; readonly reasonCode: VoidReasonCode }
  | { readonly kind: "WAITING"; readonly reasonCode: WaitingReasonCode }
  | { readonly kind: "UNSUPPORTED"; readonly reasonCode: UnsupportedReasonCode }
  | { readonly kind: "INVALID_DATA"; readonly reasonCode: InvalidDataReasonCode };

type SupportedMoneylineMarket = "MONEYLINE_2WAY" | "MONEYLINE_3WAY";

const SUPPORTED_PERIOD: Period = "FULL_GAME";

function win(reasonCode: WinReasonCode): SelectionOutcomeEvaluation {
  return { kind: "WIN", reasonCode };
}
function loss(reasonCode: LossReasonCode): SelectionOutcomeEvaluation {
  return { kind: "LOSS", reasonCode };
}
function voidOutcome(reasonCode: VoidReasonCode): SelectionOutcomeEvaluation {
  return { kind: "VOID", reasonCode };
}
function waiting(reasonCode: WaitingReasonCode): SelectionOutcomeEvaluation {
  return { kind: "WAITING", reasonCode };
}
function unsupported(reasonCode: UnsupportedReasonCode): SelectionOutcomeEvaluation {
  return { kind: "UNSUPPORTED", reasonCode };
}
function invalidData(reasonCode: InvalidDataReasonCode): SelectionOutcomeEvaluation {
  return { kind: "INVALID_DATA", reasonCode };
}

function isSupportedMoneylineMarket(marketType: MarketType): marketType is SupportedMoneylineMarket {
  return marketType === "MONEYLINE_2WAY" || marketType === "MONEYLINE_3WAY";
}

// PARTICIPANT is structurally valid for MONEYLINE_2WAY per
// lib/odds/domain.ts's validateCanonicalSelection, but deliberately not
// supported here — see this file's header comment.
function isSupportedSelectionType(marketType: SupportedMoneylineMarket, selectionType: SelectionType): boolean {
  if (marketType === "MONEYLINE_3WAY") {
    return selectionType === "HOME" || selectionType === "DRAW" || selectionType === "AWAY";
  }
  return selectionType === "HOME" || selectionType === "AWAY";
}

// Minimal safe normalization only — trim, collapse internal whitespace,
// lowercase. No fuzzy matching, no Levenshtein, no AI. selectionType
// remains the source of truth; this is only an additional structural
// safety check (see this stage's own "Participant matching" design note).
function normalizeParticipantName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function evaluateNonCompletedStatus(status: Exclude<EventResultStatus, "COMPLETED">): SelectionOutcomeEvaluation {
  switch (status) {
    case "NOT_STARTED":
    case "IN_PROGRESS":
      return waiting("EVENT_NOT_COMPLETED");
    case "POSTPONED":
      return waiting("EVENT_POSTPONED");
    case "CANCELLED":
      return voidOutcome("VOID_CANCELLED");
    case "ABANDONED":
      return waiting("EVENT_ABANDONED");
    case "UNKNOWN":
      return invalidData("INVALID_EVENT_RESULT");
  }

  // Exhaustiveness guard, not a real runtime path — EventResultStatus has
  // exactly 7 members; COMPLETED is excluded by this function's own
  // parameter type, and the switch above covers the other 6 (TS narrows
  // `status` to `never` here, proving every case was handled). Same
  // defense-in-depth reasoning as lib/bets/settlementRules.ts's own final
  // branch (caller data isn't bound by TS at runtime).
  throw new Error(`evaluateNonCompletedStatus: unhandled EventResultStatus ${String(status)}`);
}

export function evaluateSelectionOutcome(
  eventResult: CanonicalEventResult,
  selection: CanonicalSelection,
): SelectionOutcomeEvaluation {
  if (!isSupportedMoneylineMarket(selection.marketType)) {
    return unsupported("UNSUPPORTED_MARKET");
  }
  if (selection.period !== SUPPORTED_PERIOD) {
    return unsupported("UNSUPPORTED_PERIOD");
  }
  if (!isSupportedSelectionType(selection.marketType, selection.selectionType)) {
    return unsupported("UNSUPPORTED_SELECTION");
  }

  const homeName = eventResult.homeParticipant?.name;
  const awayName = eventResult.awayParticipant?.name;
  if (!homeName || homeName.trim().length === 0 || !awayName || awayName.trim().length === 0) {
    return invalidData("INVALID_EVENT_RESULT");
  }
  if (normalizeParticipantName(homeName) === normalizeParticipantName(awayName)) {
    return invalidData("INVALID_EVENT_RESULT");
  }

  if (selection.participant) {
    const expectedName =
      selection.selectionType === "HOME" ? homeName : selection.selectionType === "AWAY" ? awayName : null;
    if (expectedName === null || normalizeParticipantName(selection.participant.name) !== normalizeParticipantName(expectedName)) {
      return invalidData("PARTICIPANT_MISMATCH");
    }
  }

  if (eventResult.status !== "COMPLETED") {
    return evaluateNonCompletedStatus(eventResult.status);
  }

  const { homeScore, awayScore } = eventResult;
  if (homeScore === null || awayScore === null) {
    return invalidData("MISSING_SCORE");
  }
  if (
    !Number.isFinite(homeScore) ||
    !Number.isFinite(awayScore) ||
    homeScore < 0 ||
    awayScore < 0 ||
    !Number.isInteger(homeScore) ||
    !Number.isInteger(awayScore)
  ) {
    return invalidData("INVALID_SCORE");
  }

  const isDraw = homeScore === awayScore;

  if (selection.marketType === "MONEYLINE_3WAY") {
    if (selection.selectionType === "HOME") {
      return !isDraw && homeScore > awayScore ? win("WIN_HOME_PARTICIPANT") : loss("LOSS_HOME_PARTICIPANT");
    }
    if (selection.selectionType === "AWAY") {
      return !isDraw && awayScore > homeScore ? win("WIN_AWAY_PARTICIPANT") : loss("LOSS_AWAY_PARTICIPANT");
    }
    // DRAW — the only remaining possibility per isSupportedSelectionType's
    // MONEYLINE_3WAY gate above.
    return isDraw ? win("WIN_DRAW") : loss("LOSS_DRAW");
  }

  // MONEYLINE_2WAY — selectionType is HOME or AWAY only, per this
  // function's own isSupportedSelectionType gate above.
  if (isDraw) {
    return voidOutcome("VOID_DRAW_TWO_WAY_MARKET");
  }
  if (selection.selectionType === "HOME") {
    return homeScore > awayScore ? win("WIN_HOME_PARTICIPANT") : loss("LOSS_HOME_PARTICIPANT");
  }
  return awayScore > homeScore ? win("WIN_AWAY_PARTICIPANT") : loss("LOSS_AWAY_PARTICIPANT");
}
