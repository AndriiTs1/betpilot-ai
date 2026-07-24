// Step 8B — deterministic mapping: validated raw Claude tool output ->
// UniversalBetDraft (lib/bets/draft/domain.ts) -> ParsedBetSlip
// (lib/bets/betSlip.ts), via the unmodified Step 8A normalization layer
// and legacy adapter.
//
// Kept separate from lib/ai/betParser.ts because this file owns three
// distinct concerns (deterministic normalization orchestration, warning
// derivation, decimal conversion) that would make betParser.ts — already
// focused on Anthropic API interaction and raw-schema validation —
// materially harder to reason about if inlined.
//
// Raw extraction boundary: the shapes below (RawBetSelectionFields,
// RawBetSlipFields) are the LLM's raw textual output, already validated by
// betParser.ts's Zod schemas, but not yet normalized into any canonical
// enum. Nothing in this file calls an LLM, performs HTTP, reads an
// environment variable, or logs original bet content.

import {
  missingField,
  type BetDraftEvent,
  type BetDraftLeague,
  type BetDraftLine,
  type ExtractionWarning,
  type UniversalBetDraft,
  type UniversalBetDraftSelection,
} from "@/lib/bets/draft/domain";
import {
  normalizeDraftLeague,
  normalizeDraftLine,
  normalizeDraftMarket,
  normalizeDraftPeriod,
  normalizeDraftSelection,
  normalizeDraftSport,
  splitDraftEventParticipants,
} from "@/lib/bets/draft/normalize";
import { universalBetDraftToParsedBetSlip } from "@/lib/bets/draft/legacyAdapter";
import type { ParsedBetSlip } from "@/lib/bets/betSlip";
import type { MarketType, Period, Sport } from "@/lib/odds/domain";

/* -------------------------------------------------------------------------- */
/* Raw extraction shapes                                                      */
/* -------------------------------------------------------------------------- */

// Structurally satisfied by betParser.ts's betFieldsSchema / parlaySelection-
// FieldsSchema parse results (minus stake, which lives at the slip level for
// EXPRESS) — never re-exported outside lib/ai/.
export interface RawBetSelectionFields {
  readonly sport: string;
  readonly league: string | null;
  readonly event: string;
  readonly market: string | null;
  readonly selection: string;
  readonly period: string | null;
  readonly line: string | null;
  readonly odds: number | null;
}

export interface RawBetSlipFields {
  readonly type: "SINGLE" | "EXPRESS";
  readonly stake: number;
  readonly selections: readonly RawBetSelectionFields[];
}

export interface BetDraftMappingContext {
  readonly originalText: string;
  readonly sourceType: "CHAT" | "OCR";
}

export type BetDraftMapperErrorCode = "INVALID_NUMERIC_VALUE";

// Same narrow-purpose "Error subclass with an explicit code" convention used
// throughout this codebase. Only ever thrown for a programmer error (a
// non-finite number reaching here would mean Zod's own .finite()/.positive()
// guards were bypassed) — never expected in real traffic.
export class BetDraftMapperError extends Error {
  readonly code: BetDraftMapperErrorCode;

  constructor(code: BetDraftMapperErrorCode, message: string) {
    super(message);
    this.name = "BetDraftMapperError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Decimal conversion                                                         */
/* -------------------------------------------------------------------------- */

// No locale formatting, no rounding, no currency formatting. Number.prototype
// .toString() only switches to exponential notation outside this codebase's
// realistic range (magnitude >= 1e21 or < 1e-6) — far beyond stake/odds
// values (odds capped at MAX_DECIMAL_ODDS = 1000, stakes positive and
// realistically bounded similarly) — so it is a safe, deterministic,
// dependency-free decimal-string conversion for this domain.
export function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new BetDraftMapperError("INVALID_NUMERIC_VALUE", `value is not a finite number`);
  }
  return value.toString();
}

/* -------------------------------------------------------------------------- */
/* Per-selection mapping                                                      */
/* -------------------------------------------------------------------------- */

interface MappedSelection {
  readonly selection: UniversalBetDraftSelection;
  readonly warnings: readonly ExtractionWarning[];
}

// Warnings are only ever derived for the four NEW optional concepts this
// step introduces (league/market/period/line) — never for sport/event/
// selection (core required fields) and never merely because an optional
// field is MISSING (absent raw text is not noteworthy; raw text that
// deterministic normalization could not use IS).
export function mapRawSelectionToDraftSelection(raw: RawBetSelectionFields): MappedSelection {
  const warnings: ExtractionWarning[] = [];

  const sportField = normalizeDraftSport(raw.sport);
  const canonicalSport: Sport | "UNKNOWN" = sportField.state === "EXTRACTED" ? sportField.value : "UNKNOWN";

  const leagueField = raw.league === null ? missingField<BetDraftLeague>() : normalizeDraftLeague(raw.league, canonicalSport as Sport);
  if (raw.league !== null && (leagueField.state === "UNKNOWN" || leagueField.state === "UNSUPPORTED")) {
    warnings.push({ field: "league", reason: leagueField.state, rawText: leagueField.rawText });
  }

  const participants = splitDraftEventParticipants(raw.event);
  const event: BetDraftEvent = { rawText: raw.event, participants, scheduledStartTime: missingField() };

  const marketField = raw.market === null ? missingField<MarketType>() : normalizeDraftMarket(raw.market);
  if (raw.market !== null && (marketField.state === "UNKNOWN" || marketField.state === "UNSUPPORTED")) {
    warnings.push({ field: "market", reason: marketField.state, rawText: marketField.rawText });
  }

  const canonicalMarket = marketField.state === "EXTRACTED" ? marketField.value : undefined;
  const { selectionType, participant } = normalizeDraftSelection(raw.selection, canonicalMarket, participants);

  const periodField = raw.period === null ? missingField<Period>() : normalizeDraftPeriod(raw.period);
  if (raw.period !== null && periodField.state === "UNKNOWN") {
    warnings.push({ field: "period", reason: "UNKNOWN", rawText: periodField.rawText });
  }

  const lineField = raw.line === null ? missingField<BetDraftLine>() : normalizeDraftLine(raw.line);
  if (raw.line !== null && lineField.state === "UNKNOWN") {
    warnings.push({ field: "line", reason: "UNKNOWN", rawText: lineField.rawText });
  }

  const submittedOdds = raw.odds === null ? null : numberToDecimalString(raw.odds);

  return {
    selection: {
      sport: sportField,
      league: leagueField,
      event,
      marketType: marketField,
      selectionType,
      selectionRawText: raw.selection,
      participant,
      period: periodField,
      line: lineField,
      submittedOdds,
    },
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Top-level slip mapping                                                     */
/* -------------------------------------------------------------------------- */

// The single conversion boundary from validated raw Claude tool output all
// the way to the legacy ParsedBetSlip shape. Confidence is always "HIGH"
// here: this function only ever runs on input that has already passed
// betParser.ts's Zod validation of every currently-required legacy field
// (sport/event/selection/stake, and odds when non-null) — MEDIUM/LOW are
// not reachable states in this design, and are never generated by the LLM.
export function mapRawBetSlipToParsedBetSlip(raw: RawBetSlipFields, context: BetDraftMappingContext): ParsedBetSlip {
  const mapped = raw.selections.map((selection) => mapRawSelectionToDraftSelection(selection));
  const warnings = mapped.flatMap((entry) => entry.warnings);

  const draft: UniversalBetDraft = {
    raw: {
      originalText: context.originalText,
      sourceType: context.sourceType,
      language: missingField(),
      confidence: "HIGH",
      warnings,
    },
    slipType: raw.type,
    stake: numberToDecimalString(raw.stake),
    selections: mapped.map((entry) => entry.selection),
  };

  return universalBetDraftToParsedBetSlip(draft);
}
