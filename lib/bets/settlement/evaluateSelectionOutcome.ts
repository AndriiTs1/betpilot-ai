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

import { Prisma } from "@/lib/generated/prisma/client";
import type { CanonicalSelection, MarketType, Period, SelectionType } from "@/lib/odds/domain";
import { resolveParticipantSide } from "@/lib/odds/teamNameMatcher";
import type { CanonicalEventResult, EventResultStatus } from "./eventResultDomain";
import { splitAsianHandicapLine } from "./asianHandicapLine";

export type WinReasonCode =
  | "WIN_HOME_PARTICIPANT"
  | "WIN_AWAY_PARTICIPANT"
  | "WIN_DRAW"
  // H4-B2 — SPREAD full win (whole/half line, or both quarter-line
  // components win). Deliberately distinct from WIN_HOME_PARTICIPANT/
  // WIN_AWAY_PARTICIPANT above: those mean "this side won the match
  // outright" (MONEYLINE); these mean "this side covered the handicap
  // line", a different question with a different answer in general.
  | "WIN_SPREAD_HOME_PARTICIPANT"
  | "WIN_SPREAD_AWAY_PARTICIPANT"
  // H5-A2 — TOTALS full win (whole/half line, or both quarter-line
  // components win). Distinct from the SPREAD codes above: this is "the
  // combined match total covered OVER/UNDER the line", not a per-team
  // outcome — there is no home/away side at all for TOTALS.
  | "WIN_TOTALS_OVER"
  | "WIN_TOTALS_UNDER";
export type LossReasonCode =
  | "LOSS_HOME_PARTICIPANT"
  | "LOSS_AWAY_PARTICIPANT"
  | "LOSS_DRAW"
  | "LOSS_SPREAD_HOME_PARTICIPANT"
  | "LOSS_SPREAD_AWAY_PARTICIPANT"
  | "LOSS_TOTALS_OVER"
  | "LOSS_TOTALS_UNDER";

// H4-B2 — quarter-line Asian handicap "won half the stake, pushed the
// other half" outcome (one component WIN, the other PUSH). This is a
// SEMANTIC evaluation result only — it names no financial amount, mutates
// no balance, and creates no Transaction. Whether/how it can actually be
// settled is entirely lib/bets/settleBet.ts's concern (still fail-closed,
// unchanged by this stage — see UnsupportedSettlementTargetError).
// H5-A2 — TOTALS_OVER/TOTALS_UNDER added alongside the existing SPREAD
// codes: the exact same "one component WIN, the other PUSH" semantic,
// applied to a combined match-total quarter line instead of a per-team
// handicap line.
export type HalfWinReasonCode =
  | "HALF_WIN_HOME_PARTICIPANT"
  | "HALF_WIN_AWAY_PARTICIPANT"
  | "HALF_WIN_TOTALS_OVER"
  | "HALF_WIN_TOTALS_UNDER";
// H4-B2 — the mirror image of HalfWinReasonCode: one component LOSS, the
// other PUSH.
export type HalfLossReasonCode =
  | "HALF_LOSS_HOME_PARTICIPANT"
  | "HALF_LOSS_AWAY_PARTICIPANT"
  | "HALF_LOSS_TOTALS_OVER"
  | "HALF_LOSS_TOTALS_UNDER";

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
  | "VOID_DRAW_TWO_WAY_MARKET"
  // H4-B2 — a SPREAD push: either a whole/half line's adjusted margin is
  // exactly zero, or (defensively, mathematically unreachable for a
  // genuine quarter split — see asianHandicapLine.ts) both components of a
  // quarter line push. This stage deliberately reuses VOID rather than
  // introducing a separate PUSH status, per the approved H4-B plan.
  | "VOID_PUSH_SPREAD"
  // H5-A2 — the TOTALS equivalent of VOID_PUSH_SPREAD: the combined match
  // total lands exactly on a whole/half line, or (defensively,
  // mathematically unreachable for a genuine quarter split) both
  // components of a quarter total push.
  | "VOID_PUSH_TOTALS";

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
  | "AMBIGUOUS_PARTICIPANT_MATCH"
  // H4-B2 — SPREAD selection has no line at all. Structurally shouldn't
  // happen (lib/odds/domain.ts's validateCanonicalSelection requires
  // SPREAD to carry a line), but this function never assumes a caller
  // already ran that validator.
  | "MISSING_LINE"
  // H4-B2 — selection.line isn't a valid decimal, or its fraction isn't on
  // the supported .00/.25/.50/.75 grid (e.g. -1.33, +0.10). Never silently
  // rounded to the nearest supported line — see asianHandicapLine.ts.
  | "INVALID_LINE"
  // H4-B2 — defensive only: a quarter line whose two components evaluated
  // to one WIN and one LOSS. Mathematically unreachable for a genuine
  // quarter split (proven in asianHandicapLine.ts's own header comment —
  // components differ by exactly 0.5 against an integer margin, so a
  // WIN/LOSS pair can never occur), kept as an explicit fail-closed
  // branch rather than silently picking a side.
  | "INVALID_SPREAD_COMBINATION"
  // H5-A2 — the TOTALS equivalent of INVALID_SPREAD_COMBINATION: same
  // defensive, mathematically-unreachable WIN/LOSS pair, for a quarter
  // total instead of a per-team handicap line.
  | "INVALID_TOTALS_COMBINATION";

export type SelectionOutcomeEvaluation =
  | { readonly kind: "WIN"; readonly reasonCode: WinReasonCode }
  | { readonly kind: "LOSS"; readonly reasonCode: LossReasonCode }
  // H4-B2 — semantic-only quarter-line half outcomes. See HalfWinReasonCode/
  // HalfLossReasonCode above: these name no financial amount and cannot
  // (yet) reach settleBet() — lib/bets/settlement/autoSettleSingleBet.ts's
  // existing `kind !== "WIN" && kind !== "LOSS" && kind !== "VOID"` gate
  // already treats any other kind (including these two) as NO_ACTION,
  // unchanged by this stage.
  | { readonly kind: "HALF_WIN"; readonly reasonCode: HalfWinReasonCode }
  | { readonly kind: "HALF_LOSS"; readonly reasonCode: HalfLossReasonCode }
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
function halfWin(reasonCode: HalfWinReasonCode): SelectionOutcomeEvaluation {
  return { kind: "HALF_WIN", reasonCode };
}
function halfLoss(reasonCode: HalfLossReasonCode): SelectionOutcomeEvaluation {
  return { kind: "HALF_LOSS", reasonCode };
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

/* -------------------------------------------------------------------------- */
/* H4-B2 — SPREAD / Asian handicap component evaluation                       */
/* -------------------------------------------------------------------------- */

type SpreadComponentResult = "WIN" | "LOSS" | "PUSH";

// adjustedMargin = participantScore - opponentScore + componentLine, exact
// Decimal comparison against zero — never native floating point. Same rule
// for a whole/half line (NO_SPLIT, called once) and for each half-stake
// component of a quarter line (SPLIT, called twice).
function evaluateSpreadComponent(
  participantScore: number,
  opponentScore: number,
  componentLine: Prisma.Decimal,
): SpreadComponentResult {
  const adjustedMargin = componentLine.plus(participantScore - opponentScore);
  if (adjustedMargin.greaterThan(0)) return "WIN";
  if (adjustedMargin.isZero()) return "PUSH";
  return "LOSS";
}

// side is the effective HOME/AWAY side the (already-resolved) participant
// is on — never assumed, always the output of resolveParticipantSide()
// (see evaluateSelectionOutcome() below), matching this file's existing
// PARTICIPANT-resolution convention for MONEYLINE.
function evaluateSpreadOutcome(
  side: "HOME" | "AWAY",
  participantScore: number,
  opponentScore: number,
  line: Prisma.Decimal,
): SelectionOutcomeEvaluation {
  const split = splitAsianHandicapLine(line);

  if (split.kind === "INVALID_GRID") {
    return invalidData("INVALID_LINE");
  }

  const winCode: WinReasonCode = side === "HOME" ? "WIN_SPREAD_HOME_PARTICIPANT" : "WIN_SPREAD_AWAY_PARTICIPANT";
  const lossCode: LossReasonCode = side === "HOME" ? "LOSS_SPREAD_HOME_PARTICIPANT" : "LOSS_SPREAD_AWAY_PARTICIPANT";
  const halfWinCode: HalfWinReasonCode = side === "HOME" ? "HALF_WIN_HOME_PARTICIPANT" : "HALF_WIN_AWAY_PARTICIPANT";
  const halfLossCode: HalfLossReasonCode = side === "HOME" ? "HALF_LOSS_HOME_PARTICIPANT" : "HALF_LOSS_AWAY_PARTICIPANT";

  if (split.kind === "NO_SPLIT") {
    const result = evaluateSpreadComponent(participantScore, opponentScore, line);
    if (result === "WIN") return win(winCode);
    if (result === "LOSS") return loss(lossCode);
    return voidOutcome("VOID_PUSH_SPREAD");
  }

  // Quarter line — evaluate each half-stake component independently, then
  // combine per the approved H4-B plan:
  //   WIN + WIN     -> full WIN
  //   LOSS + LOSS   -> full LOSS
  //   WIN + PUSH    -> HALF_WIN   (order-independent — checked both ways)
  //   LOSS + PUSH   -> HALF_LOSS  (order-independent — checked both ways)
  //   PUSH + PUSH   -> VOID       (defensive; unreachable for a genuine
  //                                 quarter split — see asianHandicapLine.ts)
  //   WIN + LOSS    -> INVALID_DATA (defensive; equally unreachable — never
  //                                   silently resolved toward either side)
  const [componentA, componentB] = split.components;
  const resultA = evaluateSpreadComponent(participantScore, opponentScore, componentA);
  const resultB = evaluateSpreadComponent(participantScore, opponentScore, componentB);

  if (resultA === "WIN" && resultB === "WIN") return win(winCode);
  if (resultA === "LOSS" && resultB === "LOSS") return loss(lossCode);
  if ((resultA === "WIN" && resultB === "PUSH") || (resultA === "PUSH" && resultB === "WIN")) {
    return halfWin(halfWinCode);
  }
  if ((resultA === "LOSS" && resultB === "PUSH") || (resultA === "PUSH" && resultB === "LOSS")) {
    return halfLoss(halfLossCode);
  }
  if (resultA === "PUSH" && resultB === "PUSH") {
    return voidOutcome("VOID_PUSH_SPREAD");
  }
  // resultA/resultB are WIN+LOSS or LOSS+WIN — mathematically unreachable
  // for a genuine quarter split, never silently resolved either way.
  return invalidData("INVALID_SPREAD_COMBINATION");
}

/* -------------------------------------------------------------------------- */
/* H5-A2 — TOTALS / Asian totals component evaluation                        */
/* -------------------------------------------------------------------------- */

type TotalsComponentResult = "WIN" | "LOSS" | "PUSH";

// diff = totalGoals - componentLine, exact Decimal comparison against zero —
// never native floating point, same convention as evaluateSpreadComponent
// above. OVER wins when the total is strictly greater than the line, UNDER
// wins when strictly less; either direction PUSHes when the total lands
// exactly on the line. Same rule for a whole/half line (NO_SPLIT, called
// once) and for each half-stake component of a quarter line (SPLIT, called
// twice) — splitAsianHandicapLine() itself has no concept of SPREAD vs
// TOTALS at all, so it is reused completely unmodified for both.
function evaluateTotalsComponent(
  direction: "OVER" | "UNDER",
  totalGoals: number,
  componentLine: Prisma.Decimal,
): TotalsComponentResult {
  const diff = new Prisma.Decimal(totalGoals).minus(componentLine);
  if (diff.isZero()) return "PUSH";
  const isOverLine = diff.greaterThan(0);
  if (direction === "OVER") return isOverLine ? "WIN" : "LOSS";
  return isOverLine ? "LOSS" : "WIN";
}

// Mirrors evaluateSpreadOutcome() above exactly — same NO_SPLIT/SPLIT
// dispatch via the identical, unmodified splitAsianHandicapLine(), same
// WIN+WIN/LOSS+LOSS/WIN+PUSH/LOSS+PUSH/PUSH+PUSH/WIN+LOSS combination
// table — only the per-component comparison (evaluateTotalsComponent,
// combined-match-total-vs-line) and the reason codes differ. TOTALS has no
// participant/side concept at all, so there is no `side`/`participantScore`/
// `opponentScore` parameter here — only the OVER/UNDER direction and the
// combined total.
function evaluateTotalsOutcome(
  direction: "OVER" | "UNDER",
  totalGoals: number,
  line: Prisma.Decimal,
): SelectionOutcomeEvaluation {
  const split = splitAsianHandicapLine(line);

  if (split.kind === "INVALID_GRID") {
    return invalidData("INVALID_LINE");
  }

  const winCode: WinReasonCode = direction === "OVER" ? "WIN_TOTALS_OVER" : "WIN_TOTALS_UNDER";
  const lossCode: LossReasonCode = direction === "OVER" ? "LOSS_TOTALS_OVER" : "LOSS_TOTALS_UNDER";
  const halfWinCode: HalfWinReasonCode = direction === "OVER" ? "HALF_WIN_TOTALS_OVER" : "HALF_WIN_TOTALS_UNDER";
  const halfLossCode: HalfLossReasonCode = direction === "OVER" ? "HALF_LOSS_TOTALS_OVER" : "HALF_LOSS_TOTALS_UNDER";

  if (split.kind === "NO_SPLIT") {
    const result = evaluateTotalsComponent(direction, totalGoals, line);
    if (result === "WIN") return win(winCode);
    if (result === "LOSS") return loss(lossCode);
    return voidOutcome("VOID_PUSH_TOTALS");
  }

  // Quarter line — same combination table as SPREAD's own (see
  // evaluateSpreadOutcome above for the full rationale):
  //   WIN + WIN     -> full WIN
  //   LOSS + LOSS   -> full LOSS
  //   WIN + PUSH    -> HALF_WIN   (order-independent — checked both ways)
  //   LOSS + PUSH   -> HALF_LOSS  (order-independent — checked both ways)
  //   PUSH + PUSH   -> VOID       (defensive; unreachable for a genuine
  //                                 quarter split — see asianHandicapLine.ts)
  //   WIN + LOSS    -> INVALID_DATA (defensive; equally unreachable — never
  //                                   silently resolved toward either side)
  const [componentA, componentB] = split.components;
  const resultA = evaluateTotalsComponent(direction, totalGoals, componentA);
  const resultB = evaluateTotalsComponent(direction, totalGoals, componentB);

  if (resultA === "WIN" && resultB === "WIN") return win(winCode);
  if (resultA === "LOSS" && resultB === "LOSS") return loss(lossCode);
  if ((resultA === "WIN" && resultB === "PUSH") || (resultA === "PUSH" && resultB === "WIN")) {
    return halfWin(halfWinCode);
  }
  if ((resultA === "LOSS" && resultB === "PUSH") || (resultA === "PUSH" && resultB === "LOSS")) {
    return halfLoss(halfLossCode);
  }
  if (resultA === "PUSH" && resultB === "PUSH") {
    return voidOutcome("VOID_PUSH_TOTALS");
  }
  // resultA/resultB are WIN+LOSS or LOSS+WIN — mathematically unreachable
  // for a genuine quarter split, never silently resolved either way.
  return invalidData("INVALID_TOTALS_COMBINATION");
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
  // H4-B2 — SPREAD joins MONEYLINE_2WAY/MONEYLINE_3WAY as a supported
  // market. H5-A2 — TOTALS joins them too. Every other market type is
  // still UNSUPPORTED_MARKET, unchanged.
  const isSpread = selection.marketType === "SPREAD";
  const isTotals = selection.marketType === "TOTALS";
  if (!isSpread && !isTotals && !isSupportedMoneylineMarket(selection.marketType)) {
    return unsupported("UNSUPPORTED_MARKET");
  }
  if (selection.period !== SUPPORTED_PERIOD) {
    return unsupported("UNSUPPORTED_PERIOD");
  }
  // SPREAD is only supported as selectionType PARTICIPANT — the only shape
  // production actually constructs (lib/odds/shorthandClassifier.ts) and
  // the only shape lib/odds/domain.ts's validateCanonicalSelection allows
  // to carry the participant a line applies to. TOTALS is only supported
  // as OVER/UNDER — the only two selectionTypes validateCanonicalSelection
  // permits for it. Anything else is UNSUPPORTED_SELECTION, same
  // fail-closed pattern as MONEYLINE below.
  if (isSpread) {
    if (selection.selectionType !== "PARTICIPANT") {
      return unsupported("UNSUPPORTED_SELECTION");
    }
  } else if (isTotals) {
    if (selection.selectionType !== "OVER" && selection.selectionType !== "UNDER") {
      return unsupported("UNSUPPORTED_SELECTION");
    }
  } else if (!isSupportedSelectionType(selection.marketType, selection.selectionType)) {
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
  //
  // H5-A2 — TOTALS has no participant/side concept at all (it's a combined
  // match-total question, never "which team"), so none of this
  // resolution applies to it. The placeholder "HOME" assigned below is
  // NEVER actually read for TOTALS: the isTotals dispatch further down
  // returns before either the SPREAD or MONEYLINE branches — the only two
  // readers of this variable — are ever reached.
  let effectiveSelectionType: "HOME" | "AWAY" | "DRAW";

  if (isTotals) {
    effectiveSelectionType = "HOME";
  } else if (selection.selectionType === "PARTICIPANT") {
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

  // H5-A2 — TOTALS dispatch. No participant/side involved at all — the
  // combined match total (never homeScore/awayScore individually) is
  // compared against the requested line. Same MISSING_LINE/INVALID_LINE
  // guards as SPREAD below, same Prisma.Decimal-only arithmetic.
  if (isTotals) {
    if (selection.line === undefined) {
      return invalidData("MISSING_LINE");
    }
    let line: Prisma.Decimal;
    try {
      line = new Prisma.Decimal(selection.line);
    } catch {
      return invalidData("INVALID_LINE");
    }
    if (!line.isFinite()) {
      return invalidData("INVALID_LINE");
    }

    const direction = selection.selectionType as "OVER" | "UNDER";
    const totalGoals = homeScore + awayScore;
    return evaluateTotalsOutcome(direction, totalGoals, line);
  }

  // H4-B2 — SPREAD dispatch. effectiveSelectionType is guaranteed HOME or
  // AWAY here (never DRAW — SPREAD only accepts selectionType PARTICIPANT
  // above, and resolveParticipantSide() never resolves to DRAW), so `side`
  // is never assumed and never guessed — it is exactly what the same
  // participant-resolution mechanism MONEYLINE already uses decided.
  if (isSpread) {
    if (selection.line === undefined) {
      return invalidData("MISSING_LINE");
    }
    let line: Prisma.Decimal;
    try {
      line = new Prisma.Decimal(selection.line);
    } catch {
      return invalidData("INVALID_LINE");
    }
    if (!line.isFinite()) {
      return invalidData("INVALID_LINE");
    }

    const side = effectiveSelectionType as "HOME" | "AWAY";
    const participantScore = side === "HOME" ? homeScore : awayScore;
    const opponentScore = side === "HOME" ? awayScore : homeScore;
    return evaluateSpreadOutcome(side, participantScore, opponentScore, line);
  }

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
