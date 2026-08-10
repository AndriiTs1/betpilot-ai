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
//
// Handicap Stage H3 — natural-language RU/UA/EN aliases for the SAME SPREAD
// market Ф1/Ф2 already represents (фора/с формой/з формою/handicap/spread,
// optionally prefixed by азиатская/азійська/asian) — vocabulary only, see
// matchSpread's own comment below. Still produces the exact same
// {marketType: "SPREAD", selectionType: "PARTICIPANT"} shape, still no
// rounding/normalization of the line, and a quarter line (e.g. "-1.25")
// still classifies as SPREAD here — TheOddsApiProvider's own H1
// isStandardHandicapLine gate (unchanged by this stage) is what keeps a
// quarter line non-confirmable, exactly as it already does for Ф1(-1.25).

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
//
// BA-2C, Step 1C (production fix) — the token character class now accepts
// Latin "f" as a canonical alias of Cyrillic "ф" ([фf]), case-insensitive.
// Root cause: a real production message typed in Cyrillic ("Арсенал
// Ф1(-1.5)") was extracted by the AI with the selection text romanized to
// Latin ("Arsenal F1") — nothing in this codebase performs that
// transliteration (confirmed by reading lib/ai/betParser.ts's raw-output
// mapping, which copies the AI's selection string verbatim); it is the
// LLM's own behavior, which this deterministic classifier cannot control
// but must be robust to regardless. Before this fix, Latin "F1"/"F2" never
// matched here at all and fell to the same fabricated MONEYLINE_2WAY/
// PARTICIPANT fallback Step 1B fixed for the lineless-Cyrillic case — this
// widening closes the Latin half of that same hole.
//
// A letter-boundary guard ((?<![a-zа-яё]), case-insensitive) is required on
// the participant-prefixed form specifically because of this widening:
// without it, the previously Cyrillic-only "ф[12]" already had a latent
// substring-match risk inside an ordinary Cyrillic word (e.g. "шкаф1" —
// "cabinet" + "1" — lazily matches participant="шка", token="ф1"); adding
// Latin "f" would newly expose the identical risk for ordinary English
// words (e.g. "off1", "Sheff2"). The guard requires the character
// immediately before the token to NOT be a letter (Latin or Cyrillic) —
// still permits zero literal whitespace when nothing but non-letter
// characters precede the token, exactly preserving every already-tested
// "team name, then optional space, then token" shape. The bare form
// (SPREAD_TOKEN_BARE_PATTERN) needs no such guard — it is anchored at the
// very start of the string (^), so nothing can ever precede the token.
const SPREAD_TOKEN_PARTICIPANT_PATTERN = /^(.+?)\s*(?<![a-zа-яё])[фf][12](.*)$/i;
// Bare form — no participant name before the token (e.g. "Ф1(-1.5)"/
// "F1(-1.5)" alone). Discovered during BA-2C Step 1's empirical audit: this
// form did NOT classify as SPREAD before that change (it fell through to
// the generic PARTICIPANT fallback, since SPREAD_TOKEN_PARTICIPANT_PATTERN
// requires at least one character before the token). Added to satisfy Step
// 1's rule 9 ("Ф1(-1.5) -> SPREAD, must NEVER fall back to a fabricated
// PARTICIPANT selection") and its REQUIRED TESTS list, which both name this
// exact bare form.
const SPREAD_TOKEN_BARE_PATTERN = /^[фf][12](.*)$/i;
const SIGNED_LINE_NUMBER = "([+-]\\d+(?:\\.\\d+)?)";
const SIGNED_LINE_SUFFIX_PATTERN = new RegExp(
  `^(?:\\s*\\(\\s*${SIGNED_LINE_NUMBER}\\s*\\)|\\s+${SIGNED_LINE_NUMBER}|\\s*:\\s*${SIGNED_LINE_NUMBER})$`,
);

interface SignedLineSuffixResult {
  readonly ok: boolean;
  readonly value: string | null;
}

// BA-2C Step 1B (production fix) — an empty remainder is valid (no embedded
// line at all — e.g. bare "Ф1", or "Арсенал Ф1" with no number in the
// selection text itself), exactly mirroring parseLineSuffix's existing
// TEAM_TOTAL precedent. This matters in production because the AI's own
// tool schema carries the numeric line in its OWN dedicated `line` field
// (BetSlipSelectionInput.line) as well as, redundantly, sometimes inside
// the free-text selection — when it chooses the former and leaves the
// selection text as a bare token, this file must still recognize the
// market honestly as SPREAD (embeddedLine: null) rather than silently
// falling through to the lossless PARTICIPANT fallback, which is what
// let "Арсенал Ф1" (line stated separately) reach the odds provider as a
// MONEYLINE_2WAY selection and get fuzzy-matched to a real "Arsenal to
// win" price — the exact production regression this fixes. A non-empty
// remainder must still fully match one of SIGNED_LINE_SUFFIX_PATTERN's
// forms, or the whole match is rejected (ok: false) — "Ф1abc-1.5" must
// never become SPREAD with a garbled/absent line.
function parseSignedLineSuffix(remainder: string): SignedLineSuffixResult {
  if (remainder.length === 0) return { ok: true, value: null };
  const match = SIGNED_LINE_SUFFIX_PATTERN.exec(remainder);
  if (!match) return { ok: false, value: null };
  return { ok: true, value: match[1] ?? match[2] ?? match[3] ?? null };
}

// "Арсенал -1.5" — a bare signed number is only ever attributed to a
// participant when one is actually named immediately before it in the SAME
// string; an unattributed bare "-1.5" alone is deliberately never matched
// here (falls through to the generic PARTICIPANT fallback instead, exactly
// as before this stage) — attributing a line to no one would be a
// fabrication this file must never make.
const SPREAD_BARE_SIGNED_PATTERN = /^(.+?)\s+([+-]\d+(?:\.\d+)?)$/;

/* -------------------------------------------------------------------------- */
/* Handicap Stage H3 — natural-language RU/UA/EN handicap vocabulary, new.   */
/* Same canonical result as Ф1/Ф2 (marketType SPREAD, selectionType         */
/* PARTICIPANT) — this only widens which WORDS a player can use to say it.  */
/*                                                                            */
/* Unlike Ф1/Ф2 (which encode "side 1" vs "side 2" even without a named     */
/* participant), none of фора/handicap/spread encode a side on their own —  */
/* so, mirroring TEAM_TOTAL's ИТБ/ИТМ precedent exactly, three shapes are   */
/* supported: participant-suffix ("Арсенал фора -1.5"), marker-prefix       */
/* ("фора Арсенал -1.5"), and bare/unattributed ("фора -1.5",               */
/* participantName: null, resolved from context by the caller if at all —  */
/* same contract as TEAM_TOTAL_BARE_PATTERN).                               */
/*                                                                            */
/* The азиатская/азійська/asian modifier is folded into the SAME regex      */
/* group as the base marker (never a separate alternative) specifically so  */
/* it can never be mistakenly captured as part of the participant name by   */
/* the non-greedy prefix group in SUFFIX_PATTERN below — "Арсенал азиатская */
/* фора -1.25" must never split as participant "Арсенал азиатская".        */
/*                                                                            */
/* All natural-language markers require REAL whitespace (\s+, never \s*)    */
/* between participant and marker — unlike Ф1/Ф2's glued-shorthand-tolerant */
/* \s*, there is no legitimate zero-space form of "Арсенал фора" a player   */
/* would ever type, so \s+ alone (with no letter-boundary lookbehind needed)*/
/* already rules out a token boundary falling inside an unrelated single    */
/* word (e.g. "семафора" can never split into "сема" + "фора": there is no  */
/* space to match against inside one word).                                 */
/*                                                                            */
/* No new lookahead/word-boundary guard is added after the marker either —  */
/* parseSignedLineSuffix (reused unmodified from the Ф1/Ф2 code above)      */
/* already rejects any remainder that isn't empty or a well-formed signed-  */
/* line suffix, which is exactly what keeps "handicapper"/"spreadsheet"     */
/* safe: matching "handicap"/"spread" as a literal prefix of those words    */
/* leaves a remainder ("per"/"sheet") that parseSignedLineSuffix rejects     */
/* outright (starts with a letter, not paren/colon/whitespace+digit) — the  */
/* whole match attempt is then abandoned, exactly the same safety net       */
/* already proven for "Ф1abc-1.5"/"F1abc" above.                            */
const HANDICAP_MARKER_SOURCE =
  "(?:(?:азиатская|азійська|asian)\\s+)?(?:с\\s+форой|з\\s+форою|фора|форой|форою|handicap|spread)";
const HANDICAP_SUFFIX_PATTERN = new RegExp(`^(.+?)\\s+${HANDICAP_MARKER_SOURCE}(.*)$`, "i");
const HANDICAP_PREFIX_PATTERN = new RegExp(`^${HANDICAP_MARKER_SOURCE}\\s+(.+?)\\s+${SIGNED_LINE_NUMBER}$`, "i");
const HANDICAP_BARE_PATTERN = new RegExp(`^${HANDICAP_MARKER_SOURCE}(.*)$`, "i");

interface SpreadMatch {
  readonly participantName: string | null;
  readonly embeddedLine: string | null;
}

function matchSpread(text: string): SpreadMatch | null {
  const prefixed = SPREAD_TOKEN_PARTICIPANT_PATTERN.exec(text);
  if (prefixed) {
    const suffix = parseSignedLineSuffix(prefixed[2]);
    if (suffix.ok) return { participantName: prefixed[1].trim(), embeddedLine: suffix.value };
  }

  const bareToken = SPREAD_TOKEN_BARE_PATTERN.exec(text);
  if (bareToken) {
    const suffix = parseSignedLineSuffix(bareToken[1]);
    if (suffix.ok) return { participantName: null, embeddedLine: suffix.value };
  }

  // BARE is tried FIRST among the three handicap shapes, before SUFFIX/
  // PREFIX — both of which have an outer, generic non-greedy capture group
  // (participant) immediately adjacent to the marker. BARE is anchored at
  // the very start of the string (^), so it can only ever match when the
  // marker (optionally modifier-prefixed) is the very FIRST thing in the
  // text — exactly the situation where there is no real participant text at
  // all to confuse it with. Concretely: for a standalone "азійська фора
  // -1.25" (no participant present), trying SUFFIX first would let its
  // non-greedy `(.+?)` capture "азійська" as if it were a team name (since
  // "фора" alone, without the modifier, is ALSO a valid bare marker later
  // in that same string) — checking BARE first resolves this correctly to
  // participantName: null instead. This never steals a legitimate SUFFIX
  // match: whenever real participant text actually precedes the marker
  // (e.g. "Арсенал азійська фора -1.25"), BARE's ^-anchor fails outright
  // (the string does not START with a marker), so it always falls through
  // to SUFFIX untouched.
  const handicapBare = HANDICAP_BARE_PATTERN.exec(text);
  if (handicapBare) {
    const suffix = parseSignedLineSuffix(handicapBare[1]);
    if (suffix.ok) return { participantName: null, embeddedLine: suffix.value };
  }

  const handicapPrefix = HANDICAP_PREFIX_PATTERN.exec(text);
  if (handicapPrefix) return { participantName: handicapPrefix[1].trim(), embeddedLine: handicapPrefix[2] };

  // Tried BEFORE SPREAD_BARE_SIGNED_PATTERN below: that pattern's own
  // participant capture is a bare `(.+?)\s+SIGNED_NUMBER` with no marker
  // requirement at all, so for "Арсенал фора -1.5" it would otherwise match
  // FIRST and greedily swallow "фора" itself into the participant name
  // ("Арсенал фора" instead of "Арсенал") — checking the marker-aware
  // pattern first ensures the natural-language marker is always stripped
  // out, never absorbed as if it were part of a team name.
  const handicapSuffix = HANDICAP_SUFFIX_PATTERN.exec(text);
  if (handicapSuffix) {
    const suffix = parseSignedLineSuffix(handicapSuffix[2]);
    if (suffix.ok) return { participantName: handicapSuffix[1].trim(), embeddedLine: suffix.value };
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

/* -------------------------------------------------------------------------- */
/* H3 Production Fix — market-hint-aware classification, one shared          */
/* implementation for every caller that has a separate market-field hint     */
/* alongside the selection text (lib/ai/betDraftMapper.ts's BA-2D claim      */
/* construction, lib/odds/legacyOddsBridge.ts's canonical request            */
/* construction — previously two independently-maintained copies of the      */
/* same reconstruction rule; this is the one place it now lives).            */
/* -------------------------------------------------------------------------- */

// The classifier's own final, lossless fallback (see classifyBettingSelectionText's
// own last branch above) is recognizable exactly this way: marketType
// MONEYLINE_2WAY, selectionType PARTICIPANT, and participantName equal to
// the EXACT text that was classified, verbatim. This is what distinguishes
// a genuine "nothing matched" fallback from a real, confident MONEYLINE_2WAY
// classification that merely happens to share the same marketType/
// selectionType (e.g. "Arsenal Win"'s winner-suffix-derived participantName
// "Arsenal" — shorter than the full input "Arsenal Win" — is never mistaken
// for a fallback here).
function isGenericParticipantFallback(classified: ShorthandClassification, classifiedText: string): boolean {
  return classified.marketType === "MONEYLINE_2WAY" && classified.selectionType === "PARTICIPANT" && classified.participantName === classifiedText;
}

// Root cause this exists to fix: an AI/parser output sometimes legitimately
// splits a natural-language handicap phrase across two separate fields —
// e.g. market: "Фора", selection: "Арсенал" — because the schema's own
// field semantics actively invite this (market: the bet TYPE; selection:
// the specific OUTCOME). classifyBettingSelectionText(selectionText) alone
// then sees nothing but a bare participant name and falls back to a
// fabricated MONEYLINE_2WAY reading — even though the real market intent
// ("фора"/"handicap"/"spread", or any of H3's other recognized aliases) was
// right there in the market field the whole time.
//
// Fix: ONLY when selectionText alone resolves to the classifier's own
// generic PARTICIPANT fallback (never for any other, already-confident
// classification — see isGenericParticipantFallback above), and ONLY when
// marketHint is present and non-empty, try ONE additional reconstructed
// candidate: `${selectionText} ${marketHint}` (participant-then-marker —
// the SUFFIX shape this file's own SPREAD/TEAM_TOTAL grammar is built
// around, e.g. "Арсенал Фора", "Arsenal Handicap"; the reverse order does
// not match that grammar without a trailing line, which this reconstruction
// never has). If — and only if — that reconstructed candidate is ALSO not a
// generic fallback, it becomes the result instead. No other permutation is
// tried, no fuzzy matching, no vocabulary changes — this only ever recovers
// intent the caller itself already explicitly supplied in marketHint,
// exactly as stated, through the exact same closed-vocabulary deterministic
// classifier every other call already goes through.
//
// A genuinely confident selection-derived classification (e.g. "Arsenal
// Win", or "Over 2.5") is NEVER reached by this fallback at all — the
// generic-fallback guard short-circuits before any reconstruction is even
// attempted, so marketHint can never silently override a real reading; it
// can only fill in for a reading that was never real to begin with (a
// fabricated PARTICIPANT reading of a bare name).
export function classifyBettingSelectionTextWithMarketHint(
  selectionText: string,
  marketHint: string | null | undefined,
  knownParticipantNames: readonly string[] = [],
): ShorthandClassification {
  const classified = classifyBettingSelectionText(selectionText, knownParticipantNames);

  const trimmedHint = marketHint?.trim() ?? "";
  if (trimmedHint.length === 0) return classified;
  if (!isGenericParticipantFallback(classified, selectionText.trim())) return classified;

  const reconstructedText = `${selectionText.trim()} ${trimmedHint}`;
  const reconstructed = classifyBettingSelectionText(reconstructedText, knownParticipantNames);

  if (isGenericParticipantFallback(reconstructed, reconstructedText)) {
    // marketHint didn't contain anything the classifier recognizes either
    // (e.g. a league name, or genuinely unrelated text) — never fabricate a
    // market from it; the original fallback classification stands.
    return classified;
  }

  return reconstructed;
}
