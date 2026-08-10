// Step 8A — deterministic adapter: UniversalBetDraft -> ParsedBetSlip.
//
// Produces the EXACT existing ParsedBetSlip shape (lib/bets/betSlip.ts) so
// every current consumer — buildBetSlipPreview, both previewToken shapes,
// Prisma writes — keeps working completely unchanged. period/warnings/
// confidence/participants are still deliberately NOT threaded through
// here: ParsedBetSlip has no slot for them, and adding one remains out of
// scope. league IS threaded through as of Step 16A (see
// optionalLegacyLeagueText below) — BetSlipSelectionInput.league now exists
// specifically to carry it. line IS threaded through as of Betting Markets
// V1 Phase 2 (see optionalLegacyLineText below) — purely additive data,
// no market classification changes here.
//
// This file makes no business decisions: it never touches confirmation
// eligibility, provider support, acceptedOdds, currentOdds, combined odds,
// potential payout, or settlement — those all live downstream of
// buildBetSlipPreview, which this adapter's output feeds into completely
// unchanged.

import type { ParsedBetSlip, BetSlipSelectionInput } from "@/lib/bets/betSlip";
import type { BetDraftField, BetDraftLeague, BetDraftLine, UniversalBetDraft } from "./domain";

export type LegacyAdapterErrorCode = "INVALID_STAKE" | "INVALID_SUBMITTED_ODDS" | "INVALID_SPORT";

// Same narrow-purpose "Error subclass with an explicit code" convention
// used throughout this codebase.
export class LegacyAdapterError extends Error {
  readonly code: LegacyAdapterErrorCode;

  constructor(code: LegacyAdapterErrorCode, message: string) {
    super(message);
    this.name = "LegacyAdapterError";
    this.code = code;
  }
}

function toRequiredNumber(value: string, code: LegacyAdapterErrorCode, fieldLabel: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new LegacyAdapterError(code, `${fieldLabel} "${value}" does not convert to a finite decimal number`);
  }
  return parsed;
}

function toOptionalNumber(value: string | null, code: LegacyAdapterErrorCode, fieldLabel: string): number | null {
  if (value === null) return null;
  return toRequiredNumber(value, code, fieldLabel);
}

// Prefers rawText over the canonical enum value — this is not just
// literal-instruction-following ("sport remains a raw legacy-compatible
// string"), it is functionally required: collapsing a football-league-
// specific string like "La Liga" down to the canonical value "FOOTBALL"
// would lose exactly the string Step 7A's legacyOddsBridge.ts alias table
// depends on to route to a different sport_key than generic football.
// Falls back to the canonical value's own string form only when rawText is
// genuinely absent; throws only when NEITHER is available at all (a
// draft with no captured sport text whatsoever is programmer-invalid,
// since the parser's own required-field gate should never let one exist).
function requiredLegacyText<T>(field: BetDraftField<T>, code: LegacyAdapterErrorCode, fieldLabel: string): string {
  if (field.rawText && field.rawText.trim().length > 0) return field.rawText;
  if (field.state === "EXTRACTED") return String(field.value);
  throw new LegacyAdapterError(code, `${fieldLabel} has neither raw text nor an extracted value to adapt`);
}

// market is optional in legacy — only ever populated when EXTRACTED, using
// the field's own raw display text (never the bare canonical enum name,
// which would be a meaningless string like "MONEYLINE_3WAY" to show a
// player). Any other state (MISSING/UNKNOWN/UNSUPPORTED/AMBIGUOUS) adapts
// to null, exactly matching today's existing hardcoded-null behavior.
function optionalLegacyDisplayText<T>(field: BetDraftField<T>): string | null {
  if (field.state !== "EXTRACTED") return null;
  return field.rawText ?? String(field.value);
}

// Step 16A — league is optional in legacy, same "prefer whatever text is
// actually available" reasoning as optionalLegacyDisplayText above, but
// reads BetDraftLeague's own resolvedName first when EXTRACTED (already
// alias-normalized by lib/bets/draft/normalize.ts, e.g. "serie a" ->
// "Serie A") since that is a more useful signal downstream
// (lib/odds/footballLeagues.ts) than raw text alone. Falls back to the
// field's own rawText for every other state (UNKNOWN/UNSUPPORTED/MISSING
// with rawText) so a league that lib/bets/draft/normalize.ts's own,
// separately-maintained alias table didn't recognize (e.g. "EPL") still
// survives to reach lib/odds/footballLeagues.ts's alias table instead of
// being silently dropped — exactly the data loss this step fixes.
function optionalLegacyLeagueText(field: BetDraftField<BetDraftLeague>): string | null {
  if (field.state === "EXTRACTED") return field.value.resolvedName ?? field.value.rawText;
  return field.rawText ?? null;
}

// Betting Markets V1, Phase 2 — line is optional in legacy, only ever
// populated when EXTRACTED (a genuinely-parsed numeric line — UNKNOWN/
// MISSING/AMBIGUOUS all adapt to null, same discipline as
// optionalLegacyDisplayText above). Reconstructs the domain-layer decimal-
// string convention (lib/odds/domain.ts's isDecimalString: optional
// leading "-", never "+") from BetDraftLine's magnitude/direction split —
// magnitude is always unsigned by construction (normalizeDraftLine's own
// invariant), so only MINUS needs the sign restored; OVER/UNDER/PLUS/NONE
// all represent a non-negative line and pass the magnitude through as-is,
// exactly matching this task's required examples ("2.5", "-1.5", "0.0").
function optionalLegacyLineText(field: BetDraftField<BetDraftLine>): string | null {
  if (field.state !== "EXTRACTED") return null;
  return field.value.direction === "MINUS" ? `-${field.value.magnitude}` : field.value.magnitude;
}

export function universalBetDraftToParsedBetSlip(draft: UniversalBetDraft): ParsedBetSlip {
  const stake = toRequiredNumber(draft.stake, "INVALID_STAKE", "stake");

  const selections: BetSlipSelectionInput[] = draft.selections.map((selection, index) => ({
    sport: requiredLegacyText(selection.sport, "INVALID_SPORT", `selections[${index}].sport`),
    league: optionalLegacyLeagueText(selection.league),
    event: selection.event.rawText,
    market: optionalLegacyDisplayText(selection.marketType),
    // H3 Production Fix — threaded through verbatim, additive alongside the
    // normalized `market` field above (see UniversalBetDraftSelection's own
    // comment on marketRawText for why this survives separately).
    marketRawText: selection.marketRawText,
    selection: selection.selectionRawText,
    submittedOdds: toOptionalNumber(selection.submittedOdds, "INVALID_SUBMITTED_ODDS", `selections[${index}].submittedOdds`),
    line: optionalLegacyLineText(selection.line),
  }));

  return { type: draft.slipType, stake, selections };
}
