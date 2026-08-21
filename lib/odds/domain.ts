// Step 5 — canonical, provider-neutral odds domain vocabulary.
// See docs/ODDS_PROVIDER_DESIGN.md Sections 3-5 for the full design this
// implements. This file knows nothing about any specific odds provider —
// no sport_key, no bookmaker key, no provider event/market/outcome ID.
// Those live only in lib/odds/oddsProvider.ts's Provider*Reference types.

// String union "enums" rather than TS `enum` — the repo's existing Prisma
// enums (BetSelectionOddsStatus, BetType, ...) already serialize as plain
// strings end-to-end (JSON responses, previewToken payloads), so a plain
// string-literal union matches that convention, needs no runtime object,
// and serializes predictably (JSON.stringify(x) === the value itself).

export type Sport = "FOOTBALL" | "BASKETBALL" | "TENNIS" | "ICE_HOCKEY" | "AMERICAN_FOOTBALL" | "UNKNOWN";

export const SPORTS: readonly Sport[] = [
  "FOOTBALL",
  "BASKETBALL",
  "TENNIS",
  "ICE_HOCKEY",
  "AMERICAN_FOOTBALL",
  "UNKNOWN",
];

export type MarketType =
  | "MONEYLINE_2WAY"
  | "MONEYLINE_3WAY"
  | "DOUBLE_CHANCE"
  | "TOTALS"
  | "SPREAD"
  | "BOTH_TEAMS_TO_SCORE"
  | "DRAW_NO_BET"
  | "TEAM_TOTAL"
  | "EXACT_SCORE"
  | "PLAYER_PROP"
  | "OUTRIGHT"
  | "UNKNOWN";

export const MARKET_TYPES: readonly MarketType[] = [
  "MONEYLINE_2WAY",
  "MONEYLINE_3WAY",
  "DOUBLE_CHANCE",
  "TOTALS",
  "SPREAD",
  "BOTH_TEAMS_TO_SCORE",
  "DRAW_NO_BET",
  "TEAM_TOTAL",
  "EXACT_SCORE",
  "PLAYER_PROP",
  "OUTRIGHT",
  "UNKNOWN",
];

// REGULATION exists specifically so ice hockey's regulation-time 3-way
// market and full-game 2-way market (which includes OT/shootout) are never
// conflated — see docs/ODDS_SUPPORT_MATRIX.md Section 6. Deliberately no
// THIRD_QUARTER/OVERTIME/SECOND_SET — those only matter for deferred,
// period-scoped markets not in Step 5's scope (over-modeling ahead of
// evidence is exactly what docs/ODDS_PROVIDER_DESIGN.md Section 3 warns
// against for Period).
export type Period =
  | "FULL_GAME"
  | "REGULATION"
  | "FIRST_HALF"
  | "SECOND_HALF"
  | "FIRST_QUARTER"
  | "MATCH"
  | "SET"
  | "UNKNOWN";

export const PERIODS: readonly Period[] = [
  "FULL_GAME",
  "REGULATION",
  "FIRST_HALF",
  "SECOND_HALF",
  "FIRST_QUARTER",
  "MATCH",
  "SET",
  "UNKNOWN",
];

export type SelectionType =
  | "HOME"
  | "DRAW"
  | "AWAY"
  | "PARTICIPANT"
  | "HOME_OR_DRAW"
  | "DRAW_OR_AWAY"
  | "HOME_OR_AWAY"
  | "OVER"
  | "UNDER"
  | "YES"
  | "NO";

export const SELECTION_TYPES: readonly SelectionType[] = [
  "HOME",
  "DRAW",
  "AWAY",
  "PARTICIPANT",
  "HOME_OR_DRAW",
  "DRAW_OR_AWAY",
  "HOME_OR_AWAY",
  "OVER",
  "UNDER",
  "YES",
  "NO",
];

/* -------------------------------------------------------------------------- */
/* Canonical value types                                                      */
/* -------------------------------------------------------------------------- */

export interface CanonicalParticipant {
  readonly id?: string;
  readonly name: string;
}

export interface CanonicalLeague {
  readonly id?: string;
  readonly name: string;
  readonly countryCode?: string;
}

// Ordered `participants` is the general-purpose representation — tennis
// (2 named individuals, no home/away concept) is expressed the same way as
// football (2 teams, home/away meaningful) without forcing either shape
// onto the other. `homeParticipantIndex`/`awayParticipantIndex` are
// optional pointers into `participants`, present only for sports whose
// provider convention has a real home/away structure — never populated by
// guessing participants[0]/[1] order for a sport that has no such concept
// (see docs/ODDS_PROVIDER_DESIGN.md Section 4).
//
// No provider event ID or provider name here by design — those exist only
// on ProviderEventCandidate/Provider*Reference (lib/odds/oddsProvider.ts).
export interface CanonicalEvent {
  readonly sport: Sport;
  readonly league?: CanonicalLeague;
  readonly name: string;
  readonly participants: readonly CanonicalParticipant[];
  readonly startTime?: string; // ISO 8601, matches every other DateTime-as-string boundary in this codebase
  readonly period: Period;
  readonly homeParticipantIndex?: number;
  readonly awayParticipantIndex?: number;
}

// Decimal-safe boundary: `line`/`submittedOdds` are decimal strings, never
// JS `number` — matches docs/ODDS_PROVIDER_DESIGN.md Section 2's
// "Decimal-safe odds" principle and lib/betPreview/previewToken.ts's
// existing EXPRESS-payload convention. No new decimal package is
// introduced (Step 5 constraint) — these are validated as decimal-shaped
// strings by isDecimalString() below, not parsed into a Decimal type here.
export interface CanonicalSelection {
  readonly sport: Sport;
  readonly league?: CanonicalLeague;
  readonly event: CanonicalEvent;
  readonly marketType: MarketType;
  readonly period: Period;
  readonly selectionType: SelectionType;
  readonly participant?: CanonicalParticipant;
  readonly line?: string;
  readonly submittedOdds?: string;
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

export function isSport(value: string): value is Sport {
  return (SPORTS as readonly string[]).includes(value);
}

export function isMarketType(value: string): value is MarketType {
  return (MARKET_TYPES as readonly string[]).includes(value);
}

export function isPeriod(value: string): value is Period {
  return (PERIODS as readonly string[]).includes(value);
}

export function isSelectionType(value: string): value is SelectionType {
  return (SELECTION_TYPES as readonly string[]).includes(value);
}

const DECIMAL_STRING_PATTERN = /^-?\d+(\.\d+)?$/;

// Shape-only check (matches lib/betPreview/previewToken.ts's own
// DECIMAL_STRING_PATTERN convention) — never parses to a number here, so
// no floating-point arithmetic happens in the domain layer.
export function isDecimalString(value: string): boolean {
  return DECIMAL_STRING_PATTERN.test(value);
}

// Betting Markets V1, Phase 2 review fix — the one canonical rule for
// turning a betting-LINE input into its canonical decimal string. A leading
// "+" is a valid, common way a positive spread is typed/extracted (e.g.
// "Coventry +1.5"), so it must be ACCEPTED here — but it is never retained
// in the canonical form: an unsigned decimal string already means positive
// (matching isDecimalString's own convention, and the draft layer's own
// magnitude+direction split), so "+1.5" canonicalizes to "1.5", identical
// to a bare "1.5" input. "-1.5" and "2.5" pass through unchanged. Anything
// not decimal-shaped at all (garbage, multiple dots, letters) returns null
// — a real "malformed", never silently coerced. Distinct from
// isDecimalString: that function asks "is this ALREADY canonical"; this one
// produces the canonical string from any validly-shaped input, "+" included.
//
// Individual Team Totals, Stage 2 — the fraction separator now also accepts
// a comma ("1,5"), the standard RU/UA decimal spelling, as an alternate
// INPUT spelling of the exact same dot form — never a second, differently-
// canonicalized value. Exactly one separator character (dot OR comma, never
// both, never more than one) is still required for a match; "1.5,3"/"1,5.3"
// remain rejected exactly as any other malformed multi-separator string
// already was. isDecimalString's own CANONICAL shape is unchanged by this —
// a comma is never canonical output, only ever accepted input.
const LINE_INPUT_PATTERN = /^[+-]?\d+(?:[.,]\d+)?$/;

// H4-B5.6 — proven live production bug: a requested line of "-2.0" and a
// provider point of -2 (canonicalized via oddsVerifier.ts's
// canonicalizeProviderPoint, which round-trips through String(point) and so
// NEVER produces a redundant trailing ".0") failed to string-match even
// though they are the identical handicap line — "-2.0" !== "-2". This
// function is the one shared canonical boundary every line comparison in
// the codebase is built on (request construction in legacyOddsBridge.ts,
// provider-point canonicalization and exact-match comparison in
// oddsVerifier.ts's findSpreadOutcome/findTotalsOutcome, and re-persisted
// again in createBetFromPreview.ts) — fixing it here, once, is what makes
// every equivalent decimal spelling ("-2.0"/"-2.00"/"-2") converge on
// exactly the same canonical string everywhere, rather than patching one
// caller with a special case.
//
// Pure string manipulation only — no Number()/parseFloat()/Math.*/
// toFixed(), which would risk floating-point representation error for
// values this codebase must treat as exact (Prisma's own Bet.line/
// BetSelection.line are Decimal(5,2), never float). Trailing fractional
// zeros are stripped one digit at a time from the END of the fraction
// string only — "2.05" keeps its "05" (does not end in "0"), so it is
// never conflated with "2.5"; "-1.25" has no trailing zero at all, so it
// is untouched. This is length/character trimming, never rounding: a
// genuinely different quarter-line value is never merged into a
// different one (see this file's own required-safety examples: -1.25
// must never become -1.5, 0.75 must never become 0.5, 2.25 must never
// become 2.5).
function stripTrailingFractionZeros(magnitude: string): string {
  const dotIndex = magnitude.indexOf(".");
  if (dotIndex === -1) return magnitude;

  const integerPart = magnitude.slice(0, dotIndex);
  const fractionPart = magnitude.slice(dotIndex + 1).replace(/0+$/, "");

  return fractionPart.length > 0 ? `${integerPart}.${fractionPart}` : integerPart;
}

export function normalizeLineString(value: string): string | null {
  const trimmed = value.trim();
  if (!LINE_INPUT_PATTERN.test(trimmed)) return null;

  // Individual Team Totals, Stage 2 — a single, separator-only swap, applied
  // AFTER shape validation above already confirmed at most one comma-or-dot
  // is present. Every subsequent step (sign stripping,
  // stripTrailingFractionZeros, the isDecimalString-shaped output) then
  // operates on the exact same dot-separated string it always has —
  // "1,5" and "1.5" are therefore guaranteed to canonicalize byte-for-byte
  // identically, never two different representations of the same line.
  const dotForm = trimmed.replace(",", ".");

  const isNegative = dotForm.startsWith("-");
  const magnitude = isNegative || dotForm.startsWith("+") ? dotForm.slice(1) : dotForm;
  const canonicalMagnitude = stripTrailingFractionZeros(magnitude);

  // "-0"/"-0.0"/etc. and "0"/"0.0"/etc. are the same line (no handicap at
  // all) — a signed zero would otherwise silently produce two different
  // canonical strings for the identical value.
  if (canonicalMagnitude === "0") return "0";

  return isNegative ? `-${canonicalMagnitude}` : canonicalMagnitude;
}

/* -------------------------------------------------------------------------- */
/* Structural selection validation                                            */
/* -------------------------------------------------------------------------- */

export interface CanonicalSelectionValidationResult {
  readonly ok: boolean;
  readonly message?: string;
}

const OK: CanonicalSelectionValidationResult = { ok: true };

function invalid(message: string): CanonicalSelectionValidationResult {
  return { ok: false, message };
}

// Enforces docs/ODDS_SUPPORT_MATRIX.md Section 5 / docs/ODDS_PROVIDER_DESIGN.md
// Section 5's per-market rules structurally, so an invalid combination
// (e.g. MONEYLINE_2WAY + DRAW) is caught before anything tries to verify
// it against a provider. Pure validation only — assigning a
// VerificationReasonCode for an invalid selection is the adapter's job
// (lib/odds/theOddsApiProvider.ts), not this function's.
export function validateCanonicalSelection(selection: CanonicalSelection): CanonicalSelectionValidationResult {
  if (selection.line !== undefined && !isDecimalString(selection.line)) {
    return invalid(`line "${selection.line}" is not a valid decimal string`);
  }
  if (selection.submittedOdds !== undefined && !isDecimalString(selection.submittedOdds)) {
    return invalid(`submittedOdds "${selection.submittedOdds}" is not a valid decimal string`);
  }

  switch (selection.marketType) {
    case "MONEYLINE_2WAY":
      if (selection.selectionType === "DRAW") {
        return invalid("MONEYLINE_2WAY must not permit DRAW");
      }
      if (!["HOME", "AWAY", "PARTICIPANT"].includes(selection.selectionType)) {
        return invalid(`MONEYLINE_2WAY does not permit selectionType "${selection.selectionType}"`);
      }
      if (selection.selectionType === "PARTICIPANT" && !selection.participant) {
        return invalid("MONEYLINE_2WAY with selectionType PARTICIPANT requires participant");
      }
      return OK;

    case "MONEYLINE_3WAY":
      if (!["HOME", "DRAW", "AWAY"].includes(selection.selectionType)) {
        return invalid("MONEYLINE_3WAY permits only HOME/DRAW/AWAY");
      }
      return OK;

    case "DOUBLE_CHANCE":
      if (!["HOME_OR_DRAW", "DRAW_OR_AWAY", "HOME_OR_AWAY"].includes(selection.selectionType)) {
        return invalid("DOUBLE_CHANCE permits only its three canonical combinations");
      }
      return OK;

    case "TOTALS":
      if (!["OVER", "UNDER"].includes(selection.selectionType)) {
        return invalid("TOTALS requires selectionType OVER or UNDER");
      }
      if (selection.line === undefined) {
        return invalid("TOTALS requires line");
      }
      return OK;

    case "SPREAD":
      if (!selection.participant) {
        return invalid("SPREAD requires participant");
      }
      if (selection.line === undefined) {
        return invalid("SPREAD requires line");
      }
      return OK;

    case "BOTH_TEAMS_TO_SCORE":
      if (!["YES", "NO"].includes(selection.selectionType)) {
        return invalid("BOTH_TEAMS_TO_SCORE requires selectionType YES or NO");
      }
      return OK;

    case "TEAM_TOTAL":
      if (!["OVER", "UNDER"].includes(selection.selectionType)) {
        return invalid("TEAM_TOTAL requires selectionType OVER or UNDER");
      }
      if (!selection.participant) {
        return invalid("TEAM_TOTAL requires participant");
      }
      if (selection.line === undefined) {
        return invalid("TEAM_TOTAL requires line");
      }
      return OK;

    // DRAW_NO_BET, EXACT_SCORE, PLAYER_PROP, OUTRIGHT are named in the
    // canonical taxonomy (docs/ODDS_SUPPORT_MATRIX.md Section 5) but not
    // modeled to selection-type granularity yet — deferred scope, per that
    // document's own Section 5 note. Structurally valid as a bare
    // classification; the adapter is responsible for rejecting them as
    // MARKET_NOT_SUPPORTED, not this validator.
    case "DRAW_NO_BET":
    case "EXACT_SCORE":
    case "PLAYER_PROP":
    case "OUTRIGHT":
      return OK;

    case "UNKNOWN":
      // UNKNOWN must never mean VERIFIED — structurally valid to
      // construct (a selection the parser/UI captured but couldn't
      // classify), but the adapter must never attempt provider
      // verification for it (see lib/odds/theOddsApiProvider.ts).
      return OK;

    default: {
      const exhaustive: never = selection.marketType;
      return invalid(`unhandled marketType "${String(exhaustive)}"`);
    }
  }
}
