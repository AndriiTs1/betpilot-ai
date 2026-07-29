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
//   - selectionType: HOME/AWAY/DRAW/PARTICIPANT. Anything else (the
//     HOME_OR_DRAW/DRAW_OR_AWAY/HOME_OR_AWAY double-chance family) remains
//     UNSUPPORTED_SELECTION.
// Anything outside this scope returns a typed UNSUPPORTED/INVALID_DATA
// result — this function never guesses.
//
// Stage 3.5C-FIX — PARTICIPANT support: production's real betting flow
// (lib/odds/legacyOddsBridge.ts's legacySelectionTextToCanonical) encodes
// essentially every real team-name selection (e.g. "Fenerbahce Win") as
// PARTICIPANT, not HOME/AWAY — confirmed by a live production audit where
// 100% of real bets with canonical fields at all were PARTICIPANT, zero
// were HOME/AWAY/DRAW. Rejecting PARTICIPANT outright (this file's
// original Stage 3.2 scope) meant automatic settlement could never
// succeed for any real bet. PARTICIPANT is now resolved structurally to an
// effective HOME or AWAY side by comparing canonicalParticipant's name
// against the event result's own homeParticipant/awayParticipant names
// (see resolveParticipantSide() usage below) — via the SAME
// normalization/bounded-fuzzy-match pipeline lib/odds/oddsVerifier.ts
// already uses in production (lib/odds/teamNameMatcher.ts, shared, not
// duplicated) — and then falls through to the existing, unmodified
// HOME/AWAY win/loss/void rules below. A name matching neither side, or
// both, is never guessed — see PARTICIPANT_MISMATCH/
// AMBIGUOUS_PARTICIPANT_MATCH below.

import type { CanonicalSelection, MarketType, Period, SelectionType } from "@/lib/odds/domain";
import { resolveParticipantSide } from "@/lib/odds/teamNameMatcher";
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
  | "INVALID_EVENT_RESULT"
  // PARTICIPANT selection has no usable participant name at all (missing or
  // empty) — distinct from PARTICIPANT_MISMATCH (a real name that matched
  // neither side): there is nothing here to even attempt a comparison with.
  | "MISSING_PARTICIPANT_NAME"
  // PARTICIPANT's name matched BOTH homeParticipant and awayParticipant —
  // genuinely ambiguous (e.g. a club and its reserve/B-team sharing most of
  // the same words); never resolved by guessing, order, or odds.
  | "AMBIGUOUS_PARTICIPANT_MATCH";

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

// PARTICIPANT is accepted for BOTH market shapes (Stage 3.5C-FIX) — once
// resolved to an effective HOME/AWAY side (see resolveParticipantSide()
// usage in evaluateSelectionOutcome() below), a 3-way event ending in a
// draw is a LOSS for that side exactly like a real HOME/AWAY selection
// would be; nothing about "which side won" changes based on how the
// player originally phrased their selection. A market type outside
// isSupportedMoneylineMarket() above is rejected before this function is
// ever reached, so PARTICIPANT on a genuinely unsupported market (totals,
// handicaps, etc.) still correctly surfaces as UNSUPPORTED_MARKET, never
// reaching this selectionType check at all.
function isSupportedSelectionType(marketType: SupportedMoneylineMarket, selectionType: SelectionType): boolean {
  if (marketType === "MONEYLINE_3WAY") {
    return selectionType === "HOME" || selectionType === "DRAW" || selectionType === "AWAY" || selectionType === "PARTICIPANT";
  }
  return selectionType === "HOME" || selectionType === "AWAY" || selectionType === "PARTICIPANT";
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

  // effectiveSelectionType is what the rest of this function actually
  // decides WIN/LOSS/VOID against — for HOME/AWAY/DRAW it is simply
  // selection.selectionType itself (unchanged); for PARTICIPANT it is the
  // side resolveParticipantSide() structurally resolved the participant
  // name to. Every rule below this point is IDENTICAL regardless of which
  // path produced it — a resolved PARTICIPANT never gets different
  // treatment than a real HOME/AWAY selection once its side is known.
  let effectiveSelectionType: "HOME" | "AWAY" | "DRAW";

  if (selection.selectionType === "PARTICIPANT") {
    // Fuzzy, Cyrillic-aware resolution — this is the actual fix: a
    // player's free-text team name (possibly Cyrillic, possibly a
    // near-spelling of the provider's own name) is resolved against the
    // real event's home/away names via the same shared matcher
    // oddsVerifier.ts already relies on in production. Deliberately NOT
    // the same mechanism as the exact-match cross-check below — that one
    // guards a DIFFERENT, narrower case (a HOME/AWAY selection that
    // happens to also carry a supplied participant name) and must stay
    // exact, not fuzzy (see its own comment and
    // evaluateSelectionOutcome.test.ts's "does not use fuzzy/free-text
    // market data as a source of truth" test).
    if (!selection.participant || selection.participant.name.trim().length === 0) {
      return invalidData("MISSING_PARTICIPANT_NAME");
    }

    const resolution = resolveParticipantSide(selection.participant.name, homeName, awayName);
    if (resolution.kind === "NO_MATCH") return invalidData("PARTICIPANT_MISMATCH");
    if (resolution.kind === "AMBIGUOUS") return invalidData("AMBIGUOUS_PARTICIPANT_MATCH");
    effectiveSelectionType = resolution.kind;
  } else {
    // HOME/AWAY/DRAW — unchanged Stage 3.2 behavior. An optionally-supplied
    // participant name is only an extra structural safety cross-check here
    // (exact-normalized match only, never fuzzy) — it is not how the side
    // itself is determined; selection.selectionType already says that.
    if (selection.participant) {
      const expectedName =
        selection.selectionType === "HOME" ? homeName : selection.selectionType === "AWAY" ? awayName : null;
      if (expectedName === null || normalizeParticipantName(selection.participant.name) !== normalizeParticipantName(expectedName)) {
        return invalidData("PARTICIPANT_MISMATCH");
      }
    }
    effectiveSelectionType = selection.selectionType as "HOME" | "AWAY" | "DRAW";
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
    if (effectiveSelectionType === "HOME") {
      return !isDraw && homeScore > awayScore ? win("WIN_HOME_PARTICIPANT") : loss("LOSS_HOME_PARTICIPANT");
    }
    if (effectiveSelectionType === "AWAY") {
      return !isDraw && awayScore > homeScore ? win("WIN_AWAY_PARTICIPANT") : loss("LOSS_AWAY_PARTICIPANT");
    }
    // DRAW — the only remaining possibility (PARTICIPANT never resolves to
    // DRAW; resolveParticipantSide() only ever produces HOME or AWAY).
    return isDraw ? win("WIN_DRAW") : loss("LOSS_DRAW");
  }

  // MONEYLINE_2WAY — effectiveSelectionType is HOME or AWAY only, per this
  // function's own isSupportedSelectionType gate above (DRAW is never
  // valid on a 2-way market, and PARTICIPANT never resolves to DRAW).
  if (isDraw) {
    return voidOutcome("VOID_DRAW_TWO_WAY_MARKET");
  }
  if (effectiveSelectionType === "HOME") {
    return homeScore > awayScore ? win("WIN_HOME_PARTICIPANT") : loss("LOSS_HOME_PARTICIPANT");
  }
  return awayScore > homeScore ? win("WIN_AWAY_PARTICIPANT") : loss("LOSS_AWAY_PARTICIPANT");
}
