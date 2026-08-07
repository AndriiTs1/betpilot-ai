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

export type NumericRoleEvidenceConfidence =
  // A closed, unambiguous marker word/symbol sits directly next to the
  // number (ставка/ставлю/экспресс/коэффициент/кф/коэф/odds/stake/bet/@,
  // or a line token recognized by the shared shorthand classifier).
  | "MARKER_HIGH"
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
const MARKER_BEFORE_NUMBER_SPECS: readonly MarkerBeforeNumberSpec[] = [
  { role: "STAKE", confidence: "MARKER_HIGH", markerLabel: "ставка", pattern: new RegExp(`${NOT_WORD_BEFORE}ставка\\s*[:=]?\\s*([+-]?\\d+(?:[.,]\\d+)?)`, "gi") },
  { role: "STAKE", confidence: "MARKER_HIGH", markerLabel: "ставлю", pattern: new RegExp(`${NOT_WORD_BEFORE}ставлю\\s*[:=]?\\s*([+-]?\\d+(?:[.,]\\d+)?)`, "gi") },
  { role: "STAKE", confidence: "MARKER_HIGH", markerLabel: "экспресс", pattern: new RegExp(`${NOT_WORD_BEFORE}(?:экспресс|express)\\s*[:=]?\\s*([+-]?\\d+(?:[.,]\\d+)?)`, "gi") },
  { role: "STAKE", confidence: "MARKER_HIGH", markerLabel: "stake", pattern: /\bstake\s*[:=]?\s*([+-]?\d+(?:[.,]\d+)?)/gi },
  { role: "STAKE", confidence: "MARKER_HIGH", markerLabel: "bet", pattern: /\bbet\s*[:=]?\s*([+-]?\d+(?:[.,]\d+)?)/gi },
  // "на" is a common preposition ("bet ON Arsenal", "total ON the match")
  // with no betting-specific meaning of its own — only ever treated as weak
  // STAKE evidence, never on par with an unambiguous marker like "ставка".
  { role: "STAKE", confidence: "MARKER_LOW", markerLabel: "на", pattern: new RegExp(`${NOT_WORD_BEFORE}на\\s+([+-]?\\d+(?:[.,]\\d+)?)${NOT_WORD_AFTER}`, "gi") },
  { role: "ODDS", confidence: "MARKER_HIGH", markerLabel: "коэффициент", pattern: /коэффициент\s*[:=]?\s*(\d+(?:[.,]\d+)?)/gi },
  { role: "ODDS", confidence: "MARKER_HIGH", markerLabel: "коэф", pattern: new RegExp(`${NOT_WORD_BEFORE}коэф\\.?\\s*[:=]?\\s*(\\d+(?:[.,]\\d+)?)`, "gi") },
  { role: "ODDS", confidence: "MARKER_HIGH", markerLabel: "кф", pattern: new RegExp(`${NOT_WORD_BEFORE}кф\\.?\\s*[:=]?\\s*(\\d+(?:[.,]\\d+)?)`, "gi") },
  { role: "ODDS", confidence: "MARKER_HIGH", markerLabel: "odds", pattern: /\bodds\s*[:=]?\s*(\d+(?:[.,]\d+)?)/gi },
  { role: "ODDS", confidence: "MARKER_HIGH", markerLabel: "@", pattern: /@\s*(\d+(?:[.,]\d+)?)/g },
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
  { role: "STAKE", confidence: "MARKER_HIGH", markerLabel: "usdc", pattern: /([+-]?\d+(?:[.,]\d+)?)\s*(?:usdc|usd|\$)\b/gi },
];

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

function findNumberBeforeMarkerEvidence(text: string): NumericRoleEvidence[] {
  const evidence: NumericRoleEvidence[] = [];
  for (const spec of NUMBER_BEFORE_MARKER_SPECS) {
    const pattern = new RegExp(spec.pattern);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const captured = match[1];
      const start = match.index;
      const end = start + captured.length;
      evidence.push({ role: spec.role, value: captured, marker: spec.markerLabel, confidence: spec.confidence, start, end });
    }
  }
  return evidence;
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
function sameNumericValue(a: string, b: string): boolean {
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

function classifyWindow(tokens: readonly Token[], endIndex: number, windowSize: number): WindowClassification | null {
  const startIndex = endIndex - windowSize + 1;
  if (startIndex < 0) return null;
  const windowTokens = tokens.slice(startIndex, endIndex + 1);
  const windowText = windowTokens.map((token) => stripTrailingSentencePunctuation(token.text)).join(" ");
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

      if (LINE_MARKET_TYPES.has(classified.marketType) && classified.embeddedLine !== null && sameNumericValue(classified.embeddedLine, occurrence.value)) {
        lineEvidence.push({
          role: "LINE",
          value: occurrence.value,
          marker: deriveLineMarkerLabel(classified.windowText, occurrence.value),
          confidence: "MARKER_HIGH",
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

  const markerEvidence = [...findMarkerBeforeNumberEvidence(originalText), ...findNumberBeforeMarkerEvidence(originalText)];
  const { lineEvidence, consumedSpans } = findLineEvidence(originalText, occurrences, markerEvidence);
  const claimedSoFar = [...markerEvidence, ...lineEvidence];
  const soleCandidateEvidence = findSoleCandidateEvidence(occurrences, claimedSoFar, consumedSpans);

  return [...markerEvidence, ...lineEvidence, ...soleCandidateEvidence].sort((a, b) => a.start - b.start);
}
