// Stage BA-2A — the one deterministic betting-shorthand classifier both
// lib/bets/draft/normalize.ts and lib/odds/legacyOddsBridge.ts call, closing
// the "two independently-maintained token tables" gap identified in the
// BA-1 acceptance-contract audit.
//
// Pure and deterministic — no LLM call, no HTTP, no environment variable,
// no logging. Behavior for every token already recognized by
// legacyOddsBridge.ts's (now-removed) legacySelectionTextToCanonical /
// classifyTotalsDirection — HOME/DRAW/AWAY bare tokens, English
// winner-suffix stripping ("Inter Win" -> PARTICIPANT "Inter"), ТБ/ТМ/over/
// under totals with an optional embedded line, and the final lossless
// PARTICIPANT fallback for anything unrecognized — is preserved
// byte-for-byte; see this file's own tests for the parity proof against the
// exact fixtures legacyOddsBridge.test.ts used before this stage.
//
// New in this stage: Ukrainian нічия/перемога and Russian победа/выиграет as
// additional draw/winner tokens, and TEAM_TOTAL (ИТБ/ИТМ) / SPREAD (Ф1/Ф2,
// a participant-attributed signed line) recognition — classified honestly
// as their real MarketType, never silently folded into MONEYLINE_2WAY/
// PARTICIPANT the way an unrecognized string always has been. No provider
// adapter anywhere supports TEAM_TOTAL/SPREAD verification yet (see
// docs/ODDS_SUPPORT_MATRIX.md) — that is unchanged by this file. Classifying
// a market correctly and a provider being able to verify it are two
// different questions; TheOddsApiProvider's own existing supportedMarketTypes
// allowlist (lib/odds/theOddsApiProvider.ts) is what turns a correctly
// classified TEAM_TOTAL/SPREAD into a safe MARKET_NOT_SUPPORTED rejection.

import type { MarketType, SelectionType } from "./domain";

export interface ShorthandClassification {
  readonly marketType: MarketType;
  readonly selectionType: SelectionType;
  // Set only for PARTICIPANT (moneyline team-name fallback), TEAM_TOTAL, and
  // SPREAD — the participant a TEAM_TOTAL/SPREAD line applies to, or the
  // free-text name a moneyline selection couldn't classify to any closed
  // token. null for HOME/DRAW/AWAY/OVER/UNDER, which need no participant.
  readonly participantName: string | null;
  // A numeric line found INSIDE the selection token itself (e.g. "2.5" in
  // "ТБ 2.5", "-1.5" in "Арсенал -1.5"), when present. Callers that also
  // have a separately-stated line (e.g. the AI's own dedicated `line`
  // field) must treat that separate value as authoritative and use this
  // only as a backward-compatible fallback — this file makes no precedence
  // decision itself, matching the existing, already-tested convention in
  // legacyOddsBridge.ts's legacySelectionToCanonicalRequest.
  readonly embeddedLine: string | null;
}

function normalizeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/* -------------------------------------------------------------------------- */
/* Moneyline — bare 1X2 tokens                                                */
/* -------------------------------------------------------------------------- */

const HOME_TOKENS: ReadonlySet<string> = new Set(["1", "п1", "p1", "home"]);
// Ukrainian "нічия" added alongside the existing Russian/English tokens —
// already proven safe and live: lib/bets/buildSportmonksFootballPreview.ts's
// own independent DRAW_KEYWORDS list already includes it in production.
const DRAW_TOKENS: ReadonlySet<string> = new Set(["x", "х", "draw", "ничья", "нічия"]);
const AWAY_TOKENS: ReadonlySet<string> = new Set(["2", "п2", "p2", "away"]);

/* -------------------------------------------------------------------------- */
/* Moneyline — winner-suffix phrases ("Inter Win", "Арсенал победа")          */
/* -------------------------------------------------------------------------- */

// Extends the original English-only "to win"/"wins"/"win" suffix with
// Russian "победа"/"выиграет" and Ukrainian "перемога" — same anchoring
// discipline as the original: only a TRAILING, whitespace-separated
// occurrence is ever stripped, so a real participant name is never damaged.
const WINNER_SUFFIX_REGEX = /\s+(?:to\s+win|wins|win|победа|выиграет|перемога)$/i;
const HOME_TEAM_PHRASES: ReadonlySet<string> = new Set(["home", "home team"]);
const AWAY_TEAM_PHRASES: ReadonlySet<string> = new Set(["away", "away team"]);

/* -------------------------------------------------------------------------- */
/* Totals (match)                                                              */
/* -------------------------------------------------------------------------- */

const LINE_NUMBER = "(\\d+(?:\\.\\d+)?)";

// BA-2C, Step 1 — narrow, explicit separator grammar accepted between a
// numeric-line-bearing shorthand token (ТБ/ТМ/ИТБ/ИТМ) and its embedded
// line: nothing/whitespace ("ТБ2.5"/"ТБ 2.5"), a colon ("ТБ:2.5"/
// "ТБ: 2.5"), or a fully parenthesized number ("ТБ(2.5)"/"ТБ (2.5)").
// Deliberately NOT a generic separator class (no \W*, no [^\d]*): a bare
// comma is never accepted here (comma is contextually either punctuation
// or a decimal separator — that ambiguity is already resolved upstream,
// ephemerally, by numericRoleEvidence.ts's own
// normalizeDecimalCommaForClassification, never duplicated here), a bare
// hyphen is never accepted as a generic separator (would collide with
// SPREAD's sign), and unbalanced/doubled punctuation (ТБ::2.5,
// ТБ((2.5))) is rejected outright rather than silently tolerated.
const LINE_SUFFIX_PATTERN = new RegExp(`^(?:\\s*${LINE_NUMBER}|\\s*:\\s*${LINE_NUMBER}|\\s*\\(\\s*${LINE_NUMBER}\\s*\\))$`);

interface LineSuffixResult {
  readonly ok: boolean;
  readonly value: string | null;
}

// `remainder` is everything captured after a market token matched. An empty
// remainder is always valid (no embedded line at all — e.g. bare "ТБ").
// A non-empty remainder must fully match one of LINE_SUFFIX_PATTERN's three
// separator forms; anything else (unbalanced parens, stray letters, a
// doubled colon) is rejected outright (ok: false) so the caller falls
// through to the generic PARTICIPANT fallback instead of silently
// discarding the garbage and reporting a line-less match.
function parseLineSuffix(remainder: string): LineSuffixResult {
  if (remainder.length === 0) return { ok: true, value: null };
  const match = LINE_SUFFIX_PATTERN.exec(remainder);
  if (!match) return { ok: false, value: null };
  return { ok: true, value: match[1] ?? match[2] ?? match[3] ?? null };
}

const OVER_WORD_PATTERN = new RegExp(`^(?:тб|тотал\\s+больше|больше|over)(.*)$`, "i");
const UNDER_WORD_PATTERN = new RegExp(`^(?:тм|тотал\\s+меньше|меньше|under)(.*)$`, "i");
const OVER_LETTER_PATTERN = new RegExp(`^o${LINE_NUMBER}$`, "i");
const UNDER_LETTER_PATTERN = new RegExp(`^u${LINE_NUMBER}$`, "i");

interface TotalsMatch {
  readonly direction: "OVER" | "UNDER";
  readonly embeddedLine: string | null;
}

function matchTotals(text: string): TotalsMatch | null {
  const overWord = OVER_WORD_PATTERN.exec(text);
  if (overWord) {
    const suffix = parseLineSuffix(overWord[1]);
    return suffix.ok ? { direction: "OVER", embeddedLine: suffix.value } : null;
  }
  const overLetter = OVER_LETTER_PATTERN.exec(text);
  if (overLetter) return { direction: "OVER", embeddedLine: overLetter[1] ?? null };

  const underWord = UNDER_WORD_PATTERN.exec(text);
  if (underWord) {
    const suffix = parseLineSuffix(underWord[1]);
    return suffix.ok ? { direction: "UNDER", embeddedLine: suffix.value } : null;
  }
  const underLetter = UNDER_LETTER_PATTERN.exec(text);
  if (underLetter) return { direction: "UNDER", embeddedLine: underLetter[1] ?? null };

  return null;
}

/* -------------------------------------------------------------------------- */
/* Team totals — ИТБ/ИТМ, new in this stage                                   */
/* -------------------------------------------------------------------------- */

// Three shapes, mirroring the BA-1 acceptance matrix examples exactly:
//   "Арсенал ИТБ 1.5"  -> team name, then token, then line
//   "ИТБ Арсенал 1.5"  -> token, then team name, then line
//   "ИТБ 1.5" / "ИТБ"  -> bare token, no participant embedded in this string
//                          at all (resolved from context by the caller, if
//                          at all — this function never guesses one)
const TEAM_TOTAL_SUFFIX_PATTERN = new RegExp(`^(.+?)\\s+(итб|итм)(.*)$`, "i");
// Prefix form ("ИТБ Арсенал 1.5") is unchanged by BA-2C Step 1 — none of the
// requested punctuation variants involve a participant name embedded
// between the token and its number, so widening this one would be scope
// creep beyond what was asked and tested.
const TEAM_TOTAL_PREFIX_PATTERN = new RegExp(`^(итб|итм)\\s+(.+?)\\s+${LINE_NUMBER}$`, "i");
const TEAM_TOTAL_BARE_PATTERN = new RegExp(`^(итб|итм)(.*)$`, "i");

interface TeamTotalMatch {
  readonly direction: "OVER" | "UNDER";
  readonly participantName: string | null;
  readonly embeddedLine: string | null;
}

function directionFromToken(token: string): "OVER" | "UNDER" {
  return token.toLowerCase() === "итб" ? "OVER" : "UNDER";
}

function matchTeamTotal(text: string): TeamTotalMatch | null {
  const suffix = TEAM_TOTAL_SUFFIX_PATTERN.exec(text);
  if (suffix) {
    const parsed = parseLineSuffix(suffix[3]);
    if (parsed.ok) {
      return { direction: directionFromToken(suffix[2]), participantName: suffix[1].trim(), embeddedLine: parsed.value };
    }
  }

  const prefix = TEAM_TOTAL_PREFIX_PATTERN.exec(text);
  if (prefix) {
    return { direction: directionFromToken(prefix[1]), participantName: prefix[2].trim(), embeddedLine: prefix[3] };
  }

  const bare = TEAM_TOTAL_BARE_PATTERN.exec(text);
  if (bare) {
    const parsed = parseLineSuffix(bare[2]);
    if (parsed.ok) {
      return { direction: directionFromToken(bare[1]), participantName: null, embeddedLine: parsed.value };
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Spread / handicap — Ф1/Ф2 and a participant-attributed signed line, new   */
/* -------------------------------------------------------------------------- */

// "Арсенал Ф1(-1.5)" / "Челси Ф2(+1)" — the Ф1/Ф2 token itself does not
// distinguish which side of the match it names beyond "this named
// participant" (both forms are written directly against a single named
// team in every example this stage's contract requires) — the parenthesized
// (or bare) signed number is always the actual line.
//
// BA-2C, Step 1 — the token/number separator now also accepts a colon
// ("Ф1:-1.5", "Ф1: -1.5"), on top of the pre-existing whitespace and
// parenthesized forms. The sign ("+"/"-") is always captured as part of the
// number itself, never treated as a separator, so it can never be dropped
// or flipped by this widening.
const SPREAD_TOKEN_PARTICIPANT_PATTERN = /^(.+?)\s*ф[12](.*)$/i;
// Bare form — no participant name before the token (e.g. "Ф1(-1.5)" alone).
// Discovered during BA-2C Step 1's empirical audit: this form did NOT
// classify as SPREAD before this change (it fell through to the generic
// PARTICIPANT fallback, since SPREAD_TOKEN_PARTICIPANT_PATTERN requires at
// least one character before the token). Added specifically to satisfy this
// stage's own rule 9 ("Ф1(-1.5) -> SPREAD, must NEVER fall back to a
// fabricated PARTICIPANT selection") and its REQUIRED TESTS list, which
// both name this exact bare form. The number is mandatory here (unlike
// TEAM_TOTAL's bare form) — a spread with no line at all identifies nothing
// concrete, so it is never fabricated.
const SPREAD_TOKEN_BARE_PATTERN = /^ф[12](.*)$/i;
const SIGNED_LINE_NUMBER = "([+-]\\d+(?:\\.\\d+)?)";
const SIGNED_LINE_SUFFIX_PATTERN = new RegExp(
  `^(?:\\s*\\(\\s*${SIGNED_LINE_NUMBER}\\s*\\)|\\s+${SIGNED_LINE_NUMBER}|\\s*:\\s*${SIGNED_LINE_NUMBER})$`,
);

function parseSignedLineSuffix(remainder: string): string | null {
  const match = SIGNED_LINE_SUFFIX_PATTERN.exec(remainder);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

// "Арсенал -1.5" — a bare signed number is only ever attributed to a
// participant when one is actually named immediately before it in the SAME
// string; an unattributed bare "-1.5" alone is deliberately never matched
// here (falls through to the generic PARTICIPANT fallback instead, exactly
// as before this stage) — attributing a line to no one would be a
// fabrication this file must never make.
const SPREAD_BARE_SIGNED_PATTERN = /^(.+?)\s+([+-]\d+(?:\.\d+)?)$/;

interface SpreadMatch {
  readonly participantName: string | null;
  readonly embeddedLine: string;
}

function matchSpread(text: string): SpreadMatch | null {
  const prefixed = SPREAD_TOKEN_PARTICIPANT_PATTERN.exec(text);
  if (prefixed) {
    const value = parseSignedLineSuffix(prefixed[2]);
    if (value !== null) return { participantName: prefixed[1].trim(), embeddedLine: value };
  }

  const bareToken = SPREAD_TOKEN_BARE_PATTERN.exec(text);
  if (bareToken) {
    const value = parseSignedLineSuffix(bareToken[1]);
    if (value !== null) return { participantName: null, embeddedLine: value };
  }

  const bareSigned = SPREAD_BARE_SIGNED_PATTERN.exec(text);
  if (bareSigned) return { participantName: bareSigned[1].trim(), embeddedLine: bareSigned[2] };

  return null;
}

/* -------------------------------------------------------------------------- */
/* Single-pass classification (no participant-prefix stripping)               */
/* -------------------------------------------------------------------------- */

// Priority order mirrors the original composition exactly: Totals-family
// checks (TOTALS, then the new TEAM_TOTAL/SPREAD) are tried before any
// moneyline classification, then bare HOME/DRAW/AWAY, then winner-suffix
// stripping, in that order — matching legacySelectionToCanonicalRequest's
// original "Totals is tried FIRST" composition byte-for-byte for every
// token this function already recognized before this stage.
function classifyOnce(trimmed: string): ShorthandClassification | null {
  const totals = matchTotals(trimmed);
  if (totals) {
    return { marketType: "TOTALS", selectionType: totals.direction, participantName: null, embeddedLine: totals.embeddedLine };
  }

  const teamTotal = matchTeamTotal(trimmed);
  if (teamTotal) {
    return {
      marketType: "TEAM_TOTAL",
      selectionType: teamTotal.direction,
      participantName: teamTotal.participantName,
      embeddedLine: teamTotal.embeddedLine,
    };
  }

  const spread = matchSpread(trimmed);
  if (spread) {
    return { marketType: "SPREAD", selectionType: "PARTICIPANT", participantName: spread.participantName, embeddedLine: spread.embeddedLine };
  }

  const key = normalizeKey(trimmed);
  if (HOME_TOKENS.has(key)) return { marketType: "MONEYLINE_3WAY", selectionType: "HOME", participantName: null, embeddedLine: null };
  if (DRAW_TOKENS.has(key)) return { marketType: "MONEYLINE_3WAY", selectionType: "DRAW", participantName: null, embeddedLine: null };
  if (AWAY_TOKENS.has(key)) return { marketType: "MONEYLINE_3WAY", selectionType: "AWAY", participantName: null, embeddedLine: null };

  const withoutSuffix = trimmed.replace(WINNER_SUFFIX_REGEX, "").trim();
  if (withoutSuffix.length > 0 && withoutSuffix.length !== trimmed.length) {
    const strippedKey = normalizeKey(withoutSuffix);
    if (HOME_TEAM_PHRASES.has(strippedKey)) return { marketType: "MONEYLINE_3WAY", selectionType: "HOME", participantName: null, embeddedLine: null };
    if (AWAY_TEAM_PHRASES.has(strippedKey)) return { marketType: "MONEYLINE_3WAY", selectionType: "AWAY", participantName: null, embeddedLine: null };
    return { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT", participantName: withoutSuffix, embeddedLine: null };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

export function classifyBettingSelectionText(
  rawSelectionText: string,
  // Optional — lets a caller that already knows the event's participant
  // names (e.g. legacyOddsBridge.ts, which has already split the event
  // string into teams) recover a shorthand token that arrived concatenated
  // with a team name in a single string (e.g. "Арсенал ТБ 2.5" as one
  // field, rather than a separately-stated event/selection split). Empty by
  // default, in which case this function's behavior is identical to having
  // no knowledge of participants at all — every existing caller that never
  // passes this stays byte-for-byte unaffected.
  knownParticipantNames: readonly string[] = [],
): ShorthandClassification {
  const trimmed = rawSelectionText.trim();

  const direct = classifyOnce(trimmed);
  if (direct) return direct;

  for (const name of knownParticipantNames) {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) continue;

    const lowerTrimmed = trimmed.toLowerCase();
    const lowerName = trimmedName.toLowerCase();
    const nextChar = trimmed[trimmedName.length];

    if (lowerTrimmed.startsWith(lowerName) && nextChar !== undefined && /\s/.test(nextChar)) {
      const remainder = trimmed.slice(trimmedName.length).trim();
      const remainderResult = classifyOnce(remainder);
      if (remainderResult) return remainderResult;
    }
  }

  // Final, lossless fallback — identical in spirit to the original
  // legacySelectionTextToCanonical's own last branch: never fabricate a
  // market/selection this function couldn't actually determine; preserve
  // the original text as a PARTICIPANT name so nothing is silently dropped.
  return { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT", participantName: trimmed, embeddedLine: null };
}
