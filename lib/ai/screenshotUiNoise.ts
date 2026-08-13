// MASTER STAGE M3, Phase 2 — the one shared boundary numericRoleEvidence.ts
// (M1.1/M1.3) and marketIntentEvidence.ts each independently needed and,
// until this stage, each independently lacked: a way to recognize bare
// sportsbook UI-control clusters (quick-add/quick-stake preset rows,
// info-icon glyphs) BEFORE any marker/window classification runs, so a
// button row can never masquerade as betting evidence in either evidence
// system. marketIntentEvidence.ts's own file header explicitly flagged this
// exact duplication as a known, deferred concern ("a later, separate,
// reviewed refactor is recommended rather than done here") — this is that
// refactor, scoped to the smallest boundary that actually needs to be
// shared. It does not touch shorthandClassifier.ts (still used
// independently by both files, and by lib/odds/legacyOddsBridge.ts, for the
// classification itself) — only the pre-classification "is this token part
// of a UI control cluster" decision.
//
// Structural, not lexical, and not bookmaker-specific: a control row is
// recognized purely by TOKEN SHAPE and ADJACENCY (two or more consecutive
// signed-bare-number/icon tokens on the same source line), never by
// matching a specific bookmaker's button wording, icon character, or
// language. See findControlRowTokenIndices's own header for the full
// calibration rationale (proven against real production incidents in two
// independent evidence systems, not invented in the abstract).

export interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

// A token is "word-like" only if it contains a genuine run of 2+ letters —
// deliberately stronger than "contains any single Unicode Letter codepoint":
// a lone stray icon glyph can still be Unicode-categorized as a Letter (a
// real, proven production gap — U+2139 "ℹ" INFORMATION SOURCE is category
// Lo, unlike the visually similar U+24D8 "ⓘ" circled-i, category So/Symbol),
// but can never satisfy a 2-letter run. Every genuine participant/market
// word, in any language, always can — even a short shorthand token like
// "ТБ"/"PS". Used both to decide control-row membership below and (by
// numericRoleEvidence.ts) to judge whether a classified "participant name"
// is plausible.
const WORD_LIKE_PATTERN = /\p{L}{2,}/u;

export function isWordLikeToken(text: string): boolean {
  return WORD_LIKE_PATTERN.test(text);
}

// A bare number, signed or unsigned, with nothing else glued to it.
const BARE_NUMBER_TOKEN_PATTERN = /^[+-]?\d+(?:[.,]\d+)?$/;

function isBareNumberToken(text: string): boolean {
  return BARE_NUMBER_TOKEN_PATTERN.test(text);
}

// SIGNED specifically — control-row *membership* deliberately requires the
// sign, matching the actual bug mechanism exactly: shorthandClassifier.ts's
// SPREAD_BARE_SIGNED_PATTERN (the pattern this whole mechanism exists to
// guard against, in both consumers) only ever matches a SIGNED number in
// the first place. A bare UNSIGNED number ("2.5", "10") is completely
// ordinary betting shorthand elsewhere ("Арсенал ТБ 2.5 10" — a line value
// immediately followed by a stake, both unsigned, both legitimately
// adjacent) and must never be treated as a control row. Every real
// production control-row example (quick-ADD buttons) is signed by its very
// nature (a "+10"/"+25" button, never a bare unsigned preset in practice).
const SIGNED_BARE_NUMBER_TOKEN_PATTERN = /^[+-]\d+(?:[.,]\d+)?$/;

function isSignedBareNumberToken(text: string): boolean {
  return SIGNED_BARE_NUMBER_TOKEN_PATTERN.test(text);
}

// An icon/symbol token: no real word AND no digit at all — never a number
// written in any form, so this can never overlap with — and accidentally
// sweep in — an ordinary bare numeric token.
function isIconLikeToken(text: string): boolean {
  return !isWordLikeToken(text) && !/\d/.test(text);
}

// A token can anchor or extend a control-row run if it is either a signed
// bare number itself, or a genuine icon/symbol with no digit and no real
// word at all. Never a bare unsigned number, and never a genuine
// participant/market word.
function isControlRowToken(text: string): boolean {
  return isSignedBareNumberToken(text) || isIconLikeToken(text);
}

// Two or more is the whole signal: a single bare signed number next to a
// real word ("Arsenal +1.5") is completely ordinary market-line shorthand,
// not a control. Two or more bare/iconic tokens in an unbroken run
// ("+10 +25 +100", "ℹ +10 +25 +100") has no other plausible reading on a
// real sportsbook screen.
const MIN_CONTROL_ROW_LENGTH = 2;

// Structural, not lexical: a quick-add/quick-stake preset row (or similar
// bare control cluster) is two or more consecutive tokens on the SAME
// source line — never bridging a newline. This is what keeps a genuinely
// separate field directly below a preset row (e.g. the real stake input,
// almost always its own OCR line) from ever being swept into the row purely
// because it happens to be numeric too.
//
// Returns every token index that is part of a qualifying run — BOTH the
// bare-number tokens and any anchoring icon token, so a caller that
// pre-seeds a "consumed" token-index set (marketIntentEvidence.ts) blocks
// the whole row uniformly, while a caller that only ever produces evidence
// from numeric spans (numericRoleEvidence.ts) can filter down to the
// numbers it actually cares about.
export function findControlRowTokenIndices(text: string, tokens: readonly Token[]): ReadonlySet<number> {
  const excluded = new Set<number>();
  let i = 0;

  while (i < tokens.length) {
    let j = i;
    while (
      j < tokens.length &&
      isControlRowToken(tokens[j].text) &&
      (j === i || !text.slice(tokens[j - 1].end, tokens[j].start).includes("\n"))
    ) {
      j += 1;
    }

    if (j - i >= MIN_CONTROL_ROW_LENGTH) {
      for (let k = i; k < j; k += 1) excluded.add(k);
    }

    i = j > i ? j : i + 1;
  }

  return excluded;
}

// Convenience wrapper for callers (numericRoleEvidence.ts) that want
// character-span exclusions for the bare-number tokens specifically, rather
// than raw token indices — every entry here is guaranteed to correspond to
// a token findAllNumberOccurrences could also have found, since both use
// the identical number shape.
export function findControlRowCharSpanExclusions(text: string, tokens: readonly Token[]): ReadonlyArray<{ start: number; end: number }> {
  const indices = findControlRowTokenIndices(text, tokens);
  const spans: Array<{ start: number; end: number }> = [];
  for (const idx of indices) {
    if (isBareNumberToken(tokens[idx].text)) spans.push({ start: tokens[idx].start, end: tokens[idx].end });
  }
  return spans;
}
