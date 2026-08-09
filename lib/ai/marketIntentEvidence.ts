// Stage BA-2D, Step 2 — a standalone, deterministic extractor that finds
// strong market/selection evidence in a player's ORIGINAL message, using
// nothing but lib/odds/shorthandClassifier.ts's existing public
// classifyBettingSelectionText(). Pure function, no LLM call, no HTTP, no
// environment variable, no logging, and — same discipline as Step 1
// (lib/ai/numericRoleEvidence.ts) — no caller anywhere yet. It does not
// change, correct, or reject anything; it only observes.
//
// Deliberately independent of lib/ai/numericRoleEvidence.ts's own window-
// scanning machinery: that file is already stable/reviewed (BA-2B), and
// this step's brief explicitly asks to avoid refactoring it "merely for
// code reuse." The window-scanning ALGORITHM below is conceptually similar
// (small bounded windows of tokenized originalText, classified via the one
// shared classifier) but is a fresh, independent implementation — see this
// file's own header comment in the final report for the duplication this
// produced and why a later, separate, reviewed refactor is recommended
// rather than done here.

import { classifyBettingSelectionText, type ShorthandClassification } from "@/lib/odds/shorthandClassifier";

export type MarketIntentConfidence = "TOKEN_MATCH";

export interface MarketIntentEvidence {
  // The classifier's own, unmodified result for the matched window — reused
  // as-is rather than re-declaring a parallel "market/selection/participant/
  // line" shape (BA-2D Step 1 audit's explicit recommendation).
  readonly classification: ShorthandClassification;
  // A single tier for this step: classifyBettingSelectionText is already a
  // closed, no-fuzzy-matching vocabulary by design (every existing header
  // comment in that file says so) — anything it recognizes as something
  // other than its own lossless PARTICIPANT fallback is already
  // deterministic. There is no equivalent, today, to numericRoleEvidence.ts's
  // weaker "на" marker tier for market tokens. If a genuinely weaker signal
  // is ever discovered, add a second tier then — not speculatively here.
  readonly confidence: MarketIntentConfidence;
  // Character offsets into the ORIGINAL text this evidence was extracted
  // from — of the matched window (the market-shape token, plus whatever
  // adjacent tokens were needed to resolve it), never a normalized or
  // transliterated form. originalText itself is never touched anywhere in
  // this file.
  readonly start: number;
  readonly end: number;
}

/* -------------------------------------------------------------------------- */
/* Word tokens — reimplemented locally (not imported); see this file's own   */
/* header re: why numericRoleEvidence.ts's private tokenize() isn't reused.  */
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
/* Generic-fallback exclusion                                                 */
/* -------------------------------------------------------------------------- */

// Any classification other than the classifier's own lossless PARTICIPANT
// fallback (marketType MONEYLINE_2WAY, participantName equal to the whole
// window verbatim) means classifyBettingSelectionText recognized something
// real — a closed HOME/DRAW/AWAY token, a winner-suffix phrase, or a
// TOTALS/TEAM_TOTAL/SPREAD shape. Only that counts as market evidence; the
// generic fallback (the classifier's own "I couldn't determine anything,
// here is your text back as a participant name" branch) never does — this
// is what keeps "Арсенал 10" / "Arsenal 10" / "ставка 10 на Арсенал" from
// ever producing evidence. Same check numericRoleEvidence.ts's own
// (private, unexported) isGenericFallback already performs — reimplemented
// here rather than imported, per this step's explicit constraint.
const GENERIC_FALLBACK_MARKET_TYPE = "MONEYLINE_2WAY";
const GENERIC_FALLBACK_SELECTION_TYPE = "PARTICIPANT";

function isGenericFallback(classified: ShorthandClassification, windowText: string): boolean {
  return (
    classified.marketType === GENERIC_FALLBACK_MARKET_TYPE &&
    classified.selectionType === GENERIC_FALLBACK_SELECTION_TYPE &&
    classified.participantName === windowText
  );
}

/* -------------------------------------------------------------------------- */
/* Number-shaped tokens — anchors for the "token precedes its own line as a  */
/* separate word" pass (ТБ 2.5, Арсенал -1.5, Ф1 -1.5).                      */
/* -------------------------------------------------------------------------- */

// Deliberately permissive about SHAPE only (optional sign, optional single
// dot-or-comma decimal separator) — recognizing "this token IS a number,
// for anchoring purposes" is not the same as normalizing or comparing its
// VALUE, and this file never does the latter. A comma-decimal token (e.g.
// "2,5") is still recognized as an anchor here even though the window
// classification built from it will not itself resolve a comma-decimal
// embedded line (see this file's own DECIMAL COMMA finding in the final
// report) — that limitation lives entirely inside shorthandClassifier.ts's
// own LINE_NUMBER grammar, not here.
const PURE_NUMBER_TOKEN_PATTERN = /^[+-]?\d+(?:[.,]\d+)?$/;

function isPureNumberToken(text: string): boolean {
  return PURE_NUMBER_TOKEN_PATTERN.test(text);
}

/* -------------------------------------------------------------------------- */
/* Bounded backward-expanding window match                                    */
/* -------------------------------------------------------------------------- */

// Bounded at 3 tokens — enough to cover every documented shorthand shape
// this step is asked to support (bare "ничья", "Арсенал победа", "Arsenal
// to win", "ТБ 2.5", "Арсенал ИТБ 1.5", glued "Ф1(-1.5)"), never unbounded
// backtracking over the whole message. Same bound numericRoleEvidence.ts's
// own MAX_LINE_WINDOW_TOKENS already uses, for the same reason.
const MAX_WINDOW_TOKENS = 3;

interface WindowMatch {
  readonly classification: ShorthandClassification;
  readonly start: number;
  readonly end: number;
  readonly consumedIndices: readonly number[];
}

// Tries window sizes MAX_WINDOW_TOKENS..1 ENDING at `endIndex` — i.e.
// expanding backward to include preceding tokens — taking the LARGEST
// window that produces non-generic evidence. Never lets a window span a
// token index already claimed by an earlier match (`consumed`).
//
// Largest-first (not smallest-first) is required by an empirically-found
// case: WINNER_SUFFIX_REGEX (shorthandClassifier.ts) includes a bare "win"
// alternative alongside "to\s+win" — for the 2-token window "to win" tried
// in isolation, "to" has nothing before it, so the "to\s+win" alternative
// can never fire (its own required leading \s+ has nothing to attach to),
// but the plain "win" alternative still matches the space between "to" and
// "win", incorrectly stripping to a bogus participant "to". Trying the
// 3-token window "Arsenal to win" FIRST finds the correct match instead.
//
// This does not reopen the danger largest-first would otherwise pose for a
// case like "ничья Арсенал победа": the CONSUMED check (not window-size
// ordering) is what keeps two independent signals from merging there —
// once "ничья" (an earlier token) is recognized and consumed on its own,
// a later window ending at "победа" can never expand back far enough to
// reach it, because the consumed check blocks any window whose range
// would include an already-claimed index, regardless of size-ordering
// preference. See this file's own extractMarketIntentEvidence() comment
// for that full walk-through.
function findBackwardMatch(tokens: readonly Token[], endIndex: number, consumed: ReadonlySet<number>): WindowMatch | null {
  if (consumed.has(endIndex)) return null;

  for (let windowSize = MAX_WINDOW_TOKENS; windowSize >= 1; windowSize -= 1) {
    const startIndex = endIndex - windowSize + 1;
    // windowSize decreases each iteration, so startIndex INCREASES — unlike
    // a smallest-first loop, a negative startIndex here only rules out THIS
    // windowSize, not every smaller one still to come, so this must skip
    // (continue) rather than abandon the whole search (break).
    if (startIndex < 0) continue;

    let blocked = false;
    for (let i = startIndex; i <= endIndex; i += 1) {
      if (consumed.has(i)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    const windowTokens = tokens.slice(startIndex, endIndex + 1);
    const windowText = windowTokens.map((token) => token.text).join(" ");
    const classified = classifyBettingSelectionText(windowText);
    if (isGenericFallback(classified, windowText)) continue;

    const consumedIndices: number[] = [];
    for (let i = startIndex; i <= endIndex; i += 1) consumedIndices.push(i);

    return {
      classification: classified,
      start: windowTokens[0].start,
      end: windowTokens[windowTokens.length - 1].end,
      consumedIndices,
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

// Never mutates originalText. Returns evidence sorted by source position —
// purely for readable output/diffing, callers must not infer meaning from
// order. Multiple independent occurrences are always preserved separately
// (e.g. "ТБ 2.5 ТМ 3.5" -> two entries) — this function makes no
// contradiction/ambiguity decision of its own; that is Step 3's job.
export function extractMarketIntentEvidence(originalText: string): readonly MarketIntentEvidence[] {
  const tokens = tokenize(originalText);
  const consumed = new Set<number>();
  const evidence: MarketIntentEvidence[] = [];

  // Pass 1 — number-anchored. A market token that precedes its own line as
  // a SEPARATE word (e.g. "ТБ 2.5", "Арсенал -1.5", "Ф1 -1.5") can only be
  // found by anchoring the backward-expanding window at the NUMBER's own
  // token position: a window ending AT "ТБ" can never look forward to
  // "2.5". Running this pass first — and consuming both tokens the instant
  // "ТБ 2.5" matches — is what stops a bare "ТБ" from ever being
  // independently recognized (with no line at all) before "ТБ 2.5"
  // together gets a chance. Concrete trace: for "Арсенал ТБ 2.5", if
  // "ТБ" alone were tried before "2.5"'s position was ever considered, it
  // would match TOTALS/OVER with embeddedLine:null — silently losing the
  // "2.5". Anchoring on the number instead means the window ending at
  // "2.5" is what gets tried, expanding backward to "ТБ 2.5" (embeddedLine
  // correctly "2.5") before ever separately considering "ТБ" alone.
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isPureNumberToken(tokens[i].text)) continue;
    const match = findBackwardMatch(tokens, i, consumed);
    if (!match) continue;
    evidence.push({ classification: match.classification, confidence: "TOKEN_MATCH", start: match.start, end: match.end });
    for (const idx of match.consumedIndices) consumed.add(idx);
  }

  // Pass 2 — every remaining (unconsumed) token. Covers bare HOME/DRAW/AWAY
  // tokens ("ничья", "draw"), winner-suffix phrases ("Арсенал победа",
  // "Arsenal to win"), and any single token that already carries its own
  // embedded line via punctuation with no separate number token at all
  // ("Ф1(-1.5)", "ТБ:2.5") — none of these need Pass 1's number anchor.
  //
  // Left-to-right processing order matters here for exactly the same
  // reason as Pass 1: for "ничья Арсенал победа" (tokens 0/1/2), index 0
  // ("ничья") is resolved and consumed FIRST (window size 1, DRAW). By the
  // time index 2 ("победа") is reached, a window trying to expand back to
  // size 3 (which would otherwise falsely match "ничья Арсенал" as a
  // winner-suffix-stripped PARTICIPANT, since winner-suffix stripping does
  // not itself validate that its own captured prefix is free of other
  // market tokens) is blocked by the consumed check on index 0 — so only
  // window size 2 ("Арсенал победа") is ever tried, correctly isolating
  // the two independent signals instead of merging them into one
  // fabricated result.
  for (let i = 0; i < tokens.length; i += 1) {
    if (consumed.has(i)) continue;
    const match = findBackwardMatch(tokens, i, consumed);
    if (!match) continue;
    evidence.push({ classification: match.classification, confidence: "TOKEN_MATCH", start: match.start, end: match.end });
    for (const idx of match.consumedIndices) consumed.add(idx);
  }

  return [...evidence].sort((a, b) => a.start - b.start);
}
