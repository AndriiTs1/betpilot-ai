// Stage BA-2B, Step 1 — a standalone, deterministic extractor that finds
// textual evidence in a player's ORIGINAL message for which numeric role
// (stake / line / odds) each number in it plausibly plays. Pure function,
// no LLM call, no HTTP, no environment variable, no logging, and — this is
// the whole point of this stage — no caller anywhere yet. It does not
// change, correct, or reject anything; it only observes.
//
// LINE evidence deliberately does NOT define its own ТБ/ТМ/ИТБ/ИТМ/Ф1/Ф2
// vocabulary. lib/odds/shorthandClassifier.ts (Stage BA-2A) already IS that
// vocabulary's one source of truth — this file calls its public
// classifyBettingSelectionText() on small, bounded windows of the raw text
// and trusts whatever it reports, rather than re-listing the same tokens a
// second time. STAKE and ODDS evidence use genuinely new closed marker
// vocabularies (ставка/ставлю/экспресс/коэффициент/@/...) that exist
// nowhere else in this codebase, so there is nothing to duplicate there.

import { classifyBettingSelectionText } from "@/lib/odds/shorthandClassifier";

export type NumericRole = "STAKE" | "LINE" | "ODDS";

// SCREENSHOT QA-CORE S2 — MARKER_HIGH split into two tiers. LABEL_STRONG is
// every case that used to be MARKER_HIGH via an explicit FIELD-NAME label
// sitting directly next to the number (ставка/ставлю/сумма ставки/размер
// ставки/сумма пари/экспресс/stake/bet/коэффициент/кф/коэф/odds/@, or a line
// token recognized by the shared shorthand classifier) — unchanged in
// meaning, just renamed. LABEL_WEAK is new: a bare currency-suffixed number
// with NO field label at all ("100 USD", "$100") — real evidence in
// isolation (nothing else to go on), but a sportsbook screenshot commonly
// repeats that exact shape for a quick-stake preset button, a "possible
// win" figure, or other UI chrome that is not the stake. See
// numericRoleVerifier.ts's own header for how the two tiers interact: an
// explicit LABEL_STRONG entry always wins outright over LABEL_WEAK noise
// for the same role, rather than the two competing as equals the way two
// MARKER_HIGH entries used to.
export type NumericRoleEvidenceConfidence =
  | "LABEL_STRONG"
  | "LABEL_WEAK"
  // A marker exists, but it is a common word with other meanings in
  // ordinary speech ("на") — real evidence, weighted lower.
  | "MARKER_LOW"
  // No marker at all. This number is the ONLY numeric occurrence in the
  // whole message left unclaimed after every marker-based (STAKE/LINE/
  // ODDS) pass has run — never "the last number" or "the biggest number";
  // strictly "the one number nothing else already explains."
  | "SOLE_CANDIDATE";

export interface NumericRoleEvidence {
  readonly role: NumericRole;
  // The exact numeric substring as it appears at [start, end) in the
  // source — never normalized, never reformatted, so a caller can always
  // re-slice the original text and get back exactly this.
  readonly value: string;
  // The marker text that established this evidence (lowercased, e.g.
  // "ставка", "тб", "коэффициент", "@"), or null for SOLE_CANDIDATE, which
  // has no marker by definition.
  readonly marker: string | null;
  readonly confidence: NumericRoleEvidenceConfidence;
  // Character offsets into the ORIGINAL text this evidence was extracted
  // from — of the NUMBER itself, not the marker or any surrounding text.
  // Preserved specifically so two occurrences of the identical numeric
  // VALUE (e.g. two "2.5" lines in an EXPRESS message) remain distinguishable
  // by position, never collapsed into "the value 2.5 exists somewhere."
  readonly start: number;
  readonly end: number;
}

/* -------------------------------------------------------------------------- */
/* Number occurrences — the ground truth every marker pass claims against    */
/* -------------------------------------------------------------------------- */

interface NumberOccurrence {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

// Deliberately permissive about the SHAPE of a number (optional sign,
// optional single decimal separator) — this is not where any semantic
// decision happens; it only locates candidate spans. A comma decimal
// separator is recognized as a shape (matching this codebase's existing
// normalizeDecimalString convention elsewhere) but never converted here —
// this file never mutates or reinterprets a value, only reports it verbatim.
const NUMBER_PATTERN = /[+-]?\d+(?:[.,]\d+)?/g;

function findAllNumberOccurrences(text: string): NumberOccurrence[] {
  const occurrences: NumberOccurrence[] = [];
  const pattern = new RegExp(NUMBER_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    occurrences.push({ value: match[0], start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) pattern.lastIndex += 1; // defensive: NUMBER_PATTERN can never actually match empty, but never loop forever if it somehow did
  }
  return occurrences;
}

function spansOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/* -------------------------------------------------------------------------- */
/* Word tokens — only used to build small windows for the LINE reuse below   */
/* -------------------------------------------------------------------------- */

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* STAKE / ODDS marker vocabulary — genuinely new, nothing to reuse          */
/* -------------------------------------------------------------------------- */

// Marker-BEFORE-number forms: the captured number sits at the very end of
// the match, immediately after the marker (with optional ":"/"="/whitespace
// between them) — its position is therefore
// [match.index + match[0].length - captured.length, match.index + match[0].length).
interface MarkerBeforeNumberSpec {
  readonly role: NumericRole;
  readonly confidence: NumericRoleEvidenceConfidence;
  readonly markerLabel: string;
  readonly pattern: RegExp;
}

// JavaScript's `\b` (word boundary) is defined against ASCII `\w`
// ([A-Za-z0-9_]) ONLY — Cyrillic letters are never `\w`, so `\bна`/`\bкоэф`
// never actually anchors the way it would for a Latin word (confirmed: a
// space followed by a Cyrillic letter is NOT a `\b` transition in plain JS
// regex, since neither side is `\w`). Every Cyrillic marker below uses an
// explicit lookbehind/lookahead against a small Latin+Cyrillic letter/digit
// class instead of `\b`, which is the only reliable equivalent here. Latin
// markers (stake/bet) keep `\b`, which works correctly for them.
const NOT_WORD_BEFORE = "(?<![a-zа-яё0-9])";
const NOT_WORD_AFTER = "(?![a-zа-яё0-9])";

// "ставка"/"ставлю" are shared, colloquially identical in Russian and
// Ukrainian betting usage — no distinct Ukrainian-only stake word is added
// here; inventing one without a concrete example to verify against would be
// exactly the kind of guess this stage's brief explicitly warns against.
//
// SCREENSHOT QA-1.3 — "сумма ставки"/"размер ставки"/"сумма пари" added
// alongside "ставка" for a proven, real reason: a bookmaker UI's own field
// label is a DIFFERENT grammatical form ("ставки", genitive) than the
// player's own spoken/typed "ставка" (nominative) — the literal substring
// "ставка" never appears inside "Сумма ставки" at all, so a real screenshot
// like "Сумма ставки\n100\nUSD" produced ZERO STAKE marker evidence before
// this change (confirmed via SCREENSHOT QA-1.2's production diagnostic:
// containsStake100=true at the OCR stage, yet the numeric-role verifier
// still returned STAKE=AMBIGUOUS). `\s*` between the label and the number
// already matches a newline exactly like every other whitespace character
// (JS's `\s` includes `\n`/`\r`), so these patterns work identically
// whether the label and number are on the same OCR line or separate ones —
// no special-casing needed for that.
const MARKER_BEFORE_NUMBER_SPECS: readonly MarkerBeforeNumberSpec[] = [
  { role: "STAKE", confidence: "LABEL_STRONG", markerLabel: "ставка", pattern: new RegExp(`${NOT_WORD_BEFORE}ставка\\s*[:=]?\\s*([+-]?\\d+(?:[.,]\\d+)?)`, "gi") },
  { role: "STAKE", confidence: "LABEL_STRONG", markerLabel: "ставлю", pattern: new RegExp(`${NOT_WORD_BEFORE}ставлю\\s*[:=]?\\s*([+-]?\\d+(?:[.,]\\d+)?)`, "gi") },
  { role: "STAKE", confidence: "LABEL_STRONG", markerLabel: "сумма ставки", pattern: new RegExp(`${NOT_WORD_BEFORE}сумма\\s+ставки\\s*[:=]?\\s*([+-]?\\d+(?:[.,]\\d+)?)`, "gi") },
  { role: "STAKE", confidence: "LABEL_STRONG", markerLabel: "размер ставки", pattern: new RegExp(`${NOT_WORD_BEFORE}размер\\s+ставки\\s*[:=]?\\s*([+-]?\\d+(?:[.,]\\d+)?)`, "gi") },
  { role: "STAKE", confidence: "LABEL_STRONG", markerLabel: "сумма пари", pattern: new RegExp(`${NOT_WORD_BEFORE}сумма\\s+пари\\s*[:=]?\\s*([+-]?\\d+(?:[.,]\\d+)?)`, "gi") },
  { role: "STAKE", confidence: "LABEL_STRONG", markerLabel: "экспресс", pattern: new RegExp(`${NOT_WORD_BEFORE}(?:экспресс|express)\\s*[:=]?\\s*([+-]?\\d+(?:[.,]\\d+)?)`, "gi") },
  { role: "STAKE", confidence: "LABEL_STRONG", markerLabel: "stake", pattern: /\bstake\s*[:=]?\s*([+-]?\d+(?:[.,]\d+)?)/gi },
  { role: "STAKE", confidence: "LABEL_STRONG", markerLabel: "bet", pattern: /\bbet\s*[:=]?\s*([+-]?\d+(?:[.,]\d+)?)/gi },
  // "на" is a common preposition ("bet ON Arsenal", "total ON the match")
  // with no betting-specific meaning of its own — only ever treated as weak
  // STAKE evidence, never on par with an unambiguous marker like "ставка".
  { role: "STAKE", confidence: "MARKER_LOW", markerLabel: "на", pattern: new RegExp(`${NOT_WORD_BEFORE}на\\s+([+-]?\\d+(?:[.,]\\d+)?)${NOT_WORD_AFTER}`, "gi") },
  { role: "ODDS", confidence: "LABEL_STRONG", markerLabel: "коэффициент", pattern: /коэффициент\s*[:=]?\s*(\d+(?:[.,]\d+)?)/gi },
  { role: "ODDS", confidence: "LABEL_STRONG", markerLabel: "коэф", pattern: new RegExp(`${NOT_WORD_BEFORE}коэф\\.?\\s*[:=]?\\s*(\\d+(?:[.,]\\d+)?)`, "gi") },
  { role: "ODDS", confidence: "LABEL_STRONG", markerLabel: "кф", pattern: new RegExp(`${NOT_WORD_BEFORE}кф\\.?\\s*[:=]?\\s*(\\d+(?:[.,]\\d+)?)`, "gi") },
  { role: "ODDS", confidence: "LABEL_STRONG", markerLabel: "odds", pattern: /\bodds\s*[:=]?\s*(\d+(?:[.,]\d+)?)/gi },
  { role: "ODDS", confidence: "LABEL_STRONG", markerLabel: "@", pattern: /@\s*(\d+(?:[.,]\d+)?)/g },
];

// Number-BEFORE-marker forms: the captured number is the very first thing
// in the match — its position is [match.index, match.index + captured.length).
interface NumberBeforeMarkerSpec {
  readonly role: NumericRole;
  readonly confidence: NumericRoleEvidenceConfidence;
  readonly markerLabel: string;
  readonly pattern: RegExp;
}

const NUMBER_BEFORE_MARKER_SPECS: readonly NumberBeforeMarkerSpec[] = [
  { role: "STAKE", confidence: "LABEL_WEAK", markerLabel: "usdc", pattern: /([+-]?\d+(?:[.,]\d+)?)\s*(?:usdc|usd|\$)\b/gi },
];

// SCREENSHOT QA-1.3 — the ROOT CAUSE the production diagnostic (QA-1.2)
// actually proved: "<number> USD"/"<number>$" is a genuinely useful STAKE
// signal in isolation (a player message like "100 USD on Arsenal" has
// nothing else to go on), but a real bookmaker slip commonly repeats the
// SAME currency-suffix shape for figures that are emphatically NOT the
// stake — "Возможный выигрыш\n142.00 USD" (potential win) is the exact
// figure that turned the real screenshot's stake claim from a clean
// CORROBORATED match into a false AMBIGUOUS one (a second, DIFFERENT
// currency-suffixed STAKE value competing with the real 100). This bounded,
// PRECEDING-text check remains in place even after SCREENSHOT QA-CORE S2
// introduced the LABEL_STRONG/LABEL_WEAK tier split above (this spec is now
// LABEL_WEAK) — the two are complementary, not redundant: this check
// excludes a currency-suffixed number outright when a known non-stake label
// precedes it (even with no competing evidence at all), while the
// LABEL_WEAK tier separately keeps any *other*, unexcluded currency-suffixed
// number from ever outranking or competing with an explicit LABEL_STRONG
// field label elsewhere in the same text (e.g. a quick-stake preset button
// with no explanatory label of its own). It excludes a currency-suffixed number
// only when an explicit non-stake monetary label sits immediately before
// it, exactly mirroring findLineEvidence's own "small bounded window,
// explicit vocabulary only" discipline elsewhere in this file. 60 chars
// comfortably covers a label and its value sitting on adjacent OCR lines
// (e.g. "Возможный выигрыш\n142.00" is ~19 chars) without reaching back far
// enough to swallow unrelated earlier content. Deliberately NOT "сумма"/
// "amount" alone (too broad, would suppress the real stake's own "Сумма
// ставки" label) — every word here unambiguously means "this number is a
// different figure than the stake," never a guess.
//
// SCREENSHOT QA-CORE M1 — "выигрыш" already covers the Russian noun for
// "winnings"; English mobile bookmaker UIs commonly label the identical
// figure "Potential winnings"/"Possible win" instead of "Payout", which this
// vocabulary didn't previously recognize (confirmed via a deterministic
// reconstruction of the real RB Leipzig/Borussia Mönchengladbach layout: a
// bare, unlabeled stake input carries no STAKE evidence of its own, so an
// unexcluded "Potential winnings 185.00 USD" became the ONLY evidence for
// the role and falsely CONTRADICTED the true stake). Deliberately the
// qualified phrase "(potential|possible) win(nings?)?", never bare "win" —
// bare "win" is a common substring of a market/selection descriptor
// ("Team to win"), and this file's lookbehind window is a plain substring
// search over up to 60 preceding characters, so an unqualified "win" could
// wrongly exclude a genuine currency-suffixed stake sitting near an
// unrelated "to win" selection phrase. Same reasoning as "сумма" being
// rejected above: specific enough to unambiguously mean "this is the payout
// figure," never a guess.
const STAKE_CURRENCY_EXCLUSION_LOOKBEHIND_CHARS = 60;
const STAKE_CURRENCY_EXCLUSION_PATTERN = new RegExp(
  `${NOT_WORD_BEFORE}(?:выигрыш|выплата|баланс)${NOT_WORD_AFTER}|\\b(?:payout|balance|(?:potential|possible)\\s+win(?:nings?)?)\\b`,
  "i",
);

function isPrecededByStakeExclusionLabel(text: string, numberStart: number): boolean {
  const windowStart = Math.max(0, numberStart - STAKE_CURRENCY_EXCLUSION_LOOKBEHIND_CHARS);
  return STAKE_CURRENCY_EXCLUSION_PATTERN.test(text.slice(windowStart, numberStart));
}

function findMarkerBeforeNumberEvidence(text: string): NumericRoleEvidence[] {
  const evidence: NumericRoleEvidence[] = [];
  for (const spec of MARKER_BEFORE_NUMBER_SPECS) {
    const pattern = new RegExp(spec.pattern);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const captured = match[1];
      const end = match.index + match[0].length;
      const start = end - captured.length;
      evidence.push({ role: spec.role, value: captured, marker: spec.markerLabel, confidence: spec.confidence, start, end });
    }
  }
  return evidence;
}

interface NumberBeforeMarkerResult {
  readonly evidence: NumericRoleEvidence[];
  // SCREENSHOT QA-1.3 — spans excluded by isPrecededByStakeExclusionLabel
  // (a currency-suffixed number that's actually a potential win/payout/
  // balance, not the stake). Reported separately from `evidence` — NOT
  // silently dropped — so the caller can fold them into
  // findSoleCandidateEvidence's own consumedSpans below: an excluded number
  // must never fall through to the SOLE_CANDIDATE fallback and become weak
  // STAKE evidence anyway, which would defeat the whole point of excluding
  // it in the first place.
  readonly excludedSpans: ReadonlyArray<{ start: number; end: number }>;
}

function findNumberBeforeMarkerEvidence(text: string): NumberBeforeMarkerResult {
  const evidence: NumericRoleEvidence[] = [];
  const excludedSpans: Array<{ start: number; end: number }> = [];
  for (const spec of NUMBER_BEFORE_MARKER_SPECS) {
    const pattern = new RegExp(spec.pattern);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const captured = match[1];
      const start = match.index;
      const end = start + captured.length;
      // Only ever applies to STAKE — a future non-STAKE NUMBER_BEFORE_MARKER_SPEC
      // (none exist today) would be unaffected, since this exclusion exists
      // specifically for "this currency figure isn't the stake," a
      // STAKE-only concern.
      if (spec.role === "STAKE" && isPrecededByStakeExclusionLabel(text, start)) {
        excludedSpans.push({ start, end });
        continue;
      }
      evidence.push({ role: spec.role, value: captured, marker: spec.markerLabel, confidence: spec.confidence, start, end });
    }
  }
  return { evidence, excludedSpans };
}

/* -------------------------------------------------------------------------- */
/* LINE evidence — reuses lib/odds/shorthandClassifier.ts, never redefines   */
/* its vocabulary. For each number occurrence not already claimed by a       */
/* STAKE/ODDS marker, try classifying small windows of the surrounding text  */
/* (the token containing the number, plus up to two preceding tokens) and    */
/* trust the shared classifier's own verdict — this file never decides on   */
/* its own what counts as a line-shaped token.                              */
/* -------------------------------------------------------------------------- */

const LINE_MARKET_TYPES: ReadonlySet<string> = new Set(["TOTALS", "TEAM_TOTAL", "SPREAD"]);

// Any classification other than the classifier's own lossless PARTICIPANT
// fallback (marketType MONEYLINE_2WAY, participantName equal to the whole
// window verbatim) means classifyBettingSelectionText recognized something
// real — not necessarily a LINE (a bare "П1"/"Ф1" window can resolve to
// MONEYLINE_3WAY/HOME with no line at all). Recognizing this matters even
// when it produces no LINE evidence: shorthand tokens like "Ф1"/"П1"/"П2"
// have a digit GLUED INTO the marker's own spelling (the "1" in "Ф1" is
// part of the token name, not a player-supplied value) — that digit must
// never be left floating as an unclaimed "number" a later SOLE_CANDIDATE
// pass could mistake for the stake.
const GENERIC_FALLBACK_MARKET_TYPE = "MONEYLINE_2WAY";
const GENERIC_FALLBACK_SELECTION_TYPE = "PARTICIPANT";

// Bounded at 3 tokens (the digit-bearing token plus up to 2 preceding ones)
// — enough to cover every documented shorthand shape (bare "ТБ2.5", "ТБ
// 2.5", "тотал больше 2.5", "Арсенал Ф1(-1.5)", "ИТБ Арсенал 1.5"), never
// unbounded backtracking over the whole message.
const MAX_LINE_WINDOW_TOKENS = 3;

function findEnclosingTokenIndex(tokens: readonly Token[], occurrence: NumberOccurrence): number {
  return tokens.findIndex((token) => token.start <= occurrence.start && occurrence.end <= token.end);
}

// A best-effort check that the classifier's embeddedLine actually
// corresponds to THIS occurrence (not some other number that happened to
// also be in the tried window) — sign-and-comma-insensitive since
// classifyBettingSelectionText's TOTALS/TEAM_TOTAL patterns never capture a
// sign, while SPREAD's does; this file must not reject a real match merely
// over "+"/"-"/","/"." formatting differences it doesn't itself own.
//
// Exported (Stage BA-2B, Step 2) so lib/ai/numericRoleVerifier.ts reuses
// this exact comparison instead of maintaining a second one — the same
// "one implementation" discipline established in Stage BA-2A.
export function sameNumericValue(a: string, b: string): boolean {
  const na = Number(a.replace(",", "."));
  const nb = Number(b.replace(",", "."));
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

interface WindowClassification {
  readonly marketType: string;
  readonly selectionType: string;
  readonly participantName: string | null;
  readonly embeddedLine: string | null;
  readonly windowText: string;
  readonly windowStart: number;
  readonly windowEnd: number;
}

// Trailing sentence punctuation (","/";") glued to a token by the raw
// tokenizer (e.g. "2.5," right before ", ставка 10") carries no betting-
// shorthand meaning and is never part of any pattern
// classifyBettingSelectionText itself recognizes — its own anchored (^...$)
// patterns would otherwise fail on a token that is, semantically, still
// "2.5" plus incidental punctuation. Only ever strips from the very end of
// a token; a meaningful trailing ")" (e.g. "Ф1(-1.5)") is untouched.
function stripTrailingSentencePunctuation(tokenText: string): string {
  return tokenText.replace(/[,;]+$/, "");
}

// classifyBettingSelectionText's own patterns (Stage BA-2A) only recognize
// a dot decimal separator ("2.5"), not the European/RU-UA comma form
// ("2,5") — confirmed by reading its LINE_NUMBER pattern. That file is not
// touched here (out of this stage's scope); instead, ONLY the ephemeral
// window text handed to the classifier gets comma->dot normalization —
// never originalText, never a returned evidence.value, which always stays
// the exact raw source substring (comma included) regardless of this
// internal step. Only a comma directly BETWEEN two digits is touched
// (decimal-separator shape) — never a broader "any comma is a decimal"
// rule, so a genuine sentence-separating comma elsewhere is unaffected.
function normalizeDecimalCommaForClassification(tokenText: string): string {
  return tokenText.replace(/(\d),(\d)/g, "$1.$2");
}

function classifyWindow(tokens: readonly Token[], endIndex: number, windowSize: number): WindowClassification | null {
  const startIndex = endIndex - windowSize + 1;
  if (startIndex < 0) return null;
  const windowTokens = tokens.slice(startIndex, endIndex + 1);
  const windowText = windowTokens
    .map((token) => normalizeDecimalCommaForClassification(stripTrailingSentencePunctuation(token.text)))
    .join(" ");
  const classified = classifyBettingSelectionText(windowText);
  return {
    ...classified,
    windowText,
    windowStart: windowTokens[0].start,
    windowEnd: windowTokens[windowTokens.length - 1].end,
  };
}

function isGenericFallback(classified: WindowClassification): boolean {
  return (
    classified.marketType === GENERIC_FALLBACK_MARKET_TYPE &&
    classified.selectionType === GENERIC_FALLBACK_SELECTION_TYPE &&
    classified.participantName === classified.windowText
  );
}

// Diagnostic-only, best-effort: the marker label is the window text with
// the number's own matched substring removed — e.g. "Over 2.5" -> "Over",
// "ТБ2.5" -> "ТБ", "тотал больше 2.5" -> "тотал больше". Never re-derives
// or re-validates the token vocabulary itself (that stays exclusively
// classifyBettingSelectionText's job) — this is purely a human-readable
// label for the evidence entry, not something any logic branches on.
function deriveLineMarkerLabel(windowText: string, occurrenceValue: string): string {
  return windowText
    .replace(occurrenceValue, "")
    .replace(/[(),]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

interface LineEvidenceResult {
  readonly lineEvidence: NumericRoleEvidence[];
  // Character spans of every window that classifyBettingSelectionText
  // recognized as SOMETHING (line-bearing or not) — a bare "П1"/"1"
  // resolving to MONEYLINE_3WAY/HOME consumes its span here even though it
  // produces no LINE evidence, so the digit glued inside "П1"/"Ф1" is never
  // left over for the SOLE_CANDIDATE pass to mistake for a free number.
  readonly consumedSpans: ReadonlyArray<{ start: number; end: number }>;
}

// SCREENSHOT QA-CORE M1.1 — a genuine SPREAD/TEAM_TOTAL line is always
// attributed to a real participant name; a "name" composed entirely of
// digits/symbols (an icon glyph, or a neighboring quick-add stake button's
// own "+10" text) is never a real participant in any language. This is
// exactly what a real production screenshot proved: a row of quick-add
// stake buttons ("+10  +25  +100") was misread by shorthandClassifier.ts's
// deliberately permissive SPREAD_BARE_SIGNED_PATTERN (any
// "<text> <signed number>" shape, designed to accept real team names of any
// form) as a sequence of SPREAD lines, each "attributed" to the PRECEDING
// button's own text as if it were a team name — producing false LABEL_STRONG
// LINE evidence that conflicted with the genuine, correctly-labeled line
// ("больше 2.5") and turned a clean CORROBORATED claim into AMBIGUOUS.
// Fixed here, at this module's own trust boundary, not inside the shared
// classifier: shorthandClassifier.ts is also relied on by canonical
// selection-text classification and other callers never proven to share
// this problem, so narrowing its own regex would risk an unreviewed,
// out-of-scope behavior change there. This guard only decides whether THIS
// module trusts a classification as real LINE evidence — it changes nothing
// about what shorthandClassifier.ts itself returns to any caller.
const PARTICIPANT_NAME_LETTER_PATTERN = /\p{L}/u;

function hasPlausibleParticipantName(name: string | null): boolean {
  return name === null || PARTICIPANT_NAME_LETTER_PATTERN.test(name);
}

function findLineEvidence(text: string, occurrences: readonly NumberOccurrence[], alreadyClaimed: readonly NumericRoleEvidence[]): LineEvidenceResult {
  const tokens = tokenize(text);
  const lineEvidence: NumericRoleEvidence[] = [];
  const consumedSpans: Array<{ start: number; end: number }> = [];

  for (const occurrence of occurrences) {
    if (alreadyClaimed.some((claimed) => spansOverlap(claimed, occurrence))) continue;

    const tokenIndex = findEnclosingTokenIndex(tokens, occurrence);
    if (tokenIndex === -1) continue;

    for (let windowSize = 1; windowSize <= MAX_LINE_WINDOW_TOKENS; windowSize += 1) {
      const classified = classifyWindow(tokens, tokenIndex, windowSize);
      if (classified === null || isGenericFallback(classified)) continue;

      consumedSpans.push({ start: classified.windowStart, end: classified.windowEnd });

      if (
        LINE_MARKET_TYPES.has(classified.marketType) &&
        classified.embeddedLine !== null &&
        sameNumericValue(classified.embeddedLine, occurrence.value) &&
        hasPlausibleParticipantName(classified.participantName)
      ) {
        lineEvidence.push({
          role: "LINE",
          value: occurrence.value,
          // Stripped using classified.embeddedLine (already dot-normalized,
          // guaranteed to appear literally in classified.windowText) rather
          // than occurrence.value (the raw, possibly comma-containing
          // source substring, e.g. "2,5") — the latter would never be
          // found inside the normalized window text, leaving the label
          // uncleanly stripped for comma inputs.
          marker: deriveLineMarkerLabel(classified.windowText, classified.embeddedLine),
          confidence: "LABEL_STRONG",
          start: occurrence.start,
          end: occurrence.end,
        });
      }
      break;
    }
  }

  return { lineEvidence, consumedSpans };
}

/* -------------------------------------------------------------------------- */
/* SOLE_CANDIDATE — the one, deliberately narrow, non-marker fallback        */
/* -------------------------------------------------------------------------- */

// Never "the last number" or "the biggest number" — strictly: once every
// number explicitly claimed by a STAKE/LINE/ODDS marker, OR consumed as
// part of a recognized shorthand token's own spelling (e.g. the "1" glued
// inside "П1"/"Ф1"), is excluded, if EXACTLY one occurrence remains, it
// becomes weak STAKE evidence. Two or more remaining occurrences produce
// nothing — genuine ambiguity is left unresolved here, not guessed at.
function findSoleCandidateEvidence(
  occurrences: readonly NumberOccurrence[],
  claimed: readonly NumericRoleEvidence[],
  consumedSpans: ReadonlyArray<{ start: number; end: number }>,
): NumericRoleEvidence[] {
  const unclaimed = occurrences.filter(
    (occurrence) =>
      !claimed.some((evidence) => spansOverlap(evidence, occurrence)) &&
      !consumedSpans.some((span) => spansOverlap(span, occurrence)),
  );
  if (unclaimed.length !== 1) return [];

  const sole = unclaimed[0];
  return [{ role: "STAKE", value: sole.value, marker: null, confidence: "SOLE_CANDIDATE", start: sole.start, end: sole.end }];
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

// Never mutates originalText. Returns evidence sorted by source position —
// purely for readable output/diffing, callers must not infer meaning from
// order.
export function extractNumericRoleEvidence(originalText: string): readonly NumericRoleEvidence[] {
  const occurrences = findAllNumberOccurrences(originalText);

  const numberBeforeMarkerResult = findNumberBeforeMarkerEvidence(originalText);
  const markerEvidence = [...findMarkerBeforeNumberEvidence(originalText), ...numberBeforeMarkerResult.evidence];
  const { lineEvidence, consumedSpans } = findLineEvidence(originalText, occurrences, markerEvidence);
  const claimedSoFar = [...markerEvidence, ...lineEvidence];
  // SCREENSHOT QA-1.3 — excludedSpans (a currency-suffixed potential-win/
  // payout/balance figure) are folded in here alongside consumedSpans, so
  // an excluded number is treated exactly like a shorthand-consumed one:
  // never left over for SOLE_CANDIDATE to mistake for the stake.
  const soleCandidateEvidence = findSoleCandidateEvidence(occurrences, claimedSoFar, [
    ...consumedSpans,
    ...numberBeforeMarkerResult.excludedSpans,
  ]);

  return [...markerEvidence, ...lineEvidence, ...soleCandidateEvidence].sort((a, b) => a.start - b.start);
}
