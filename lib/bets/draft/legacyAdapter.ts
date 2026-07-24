// Step 8A — deterministic adapter: UniversalBetDraft -> ParsedBetSlip.
//
// Produces the EXACT existing ParsedBetSlip shape (lib/bets/betSlip.ts,
// untouched by this step) so every current consumer — buildBetSlipPreview,
// both previewToken shapes, Prisma writes — keeps working completely
// unchanged. league/period/line/warnings/confidence/participants are
// deliberately NOT threaded through here: ParsedBetSlip has no slot for
// them, and adding one is explicitly out of this step's scope.
//
// This file makes no business decisions: it never touches confirmation
// eligibility, provider support, acceptedOdds, currentOdds, combined odds,
// potential payout, or settlement — those all live downstream of
// buildBetSlipPreview, which this adapter's output feeds into completely
// unchanged.

import type { ParsedBetSlip, BetSlipSelectionInput } from "@/lib/bets/betSlip";
import type { BetDraftField, UniversalBetDraft } from "./domain";

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

export function universalBetDraftToParsedBetSlip(draft: UniversalBetDraft): ParsedBetSlip {
  const stake = toRequiredNumber(draft.stake, "INVALID_STAKE", "stake");

  const selections: BetSlipSelectionInput[] = draft.selections.map((selection, index) => ({
    sport: requiredLegacyText(selection.sport, "INVALID_SPORT", `selections[${index}].sport`),
    event: selection.event.rawText,
    market: optionalLegacyDisplayText(selection.marketType),
    selection: selection.selectionRawText,
    submittedOdds: toOptionalNumber(selection.submittedOdds, "INVALID_SUBMITTED_ODDS", `selections[${index}].submittedOdds`),
  }));

  return { type: draft.slipType, stake, selections };
}
