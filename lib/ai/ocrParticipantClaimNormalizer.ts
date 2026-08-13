// SCREENSHOT QA-CORE, Stage S1 — a pure, deterministic text-cleanup step for
// exactly one narrow input: the `claimedParticipant` text
// classifyReconcilable1X2Mismatch() (lib/ai/betParser.ts) is about to hand to
// lib/odds/teamNameMatcher.ts's resolveParticipantSide() for fuzzy matching
// against a real, provider-resolved home/away team name.
//
// PROVEN PRODUCTION DEFECT (QA-3 fresh reconciliation diagnostic, rrrr.png):
// claimedParticipant was the literal, unmodified `selection` field Claude's
// own extract_bet tool call produced — "Bayern Win (П1)" — not a clean team
// name. The tool schema's own field description ("The outcome the player is
// betting on, e.g. Real Madrid Win.") explicitly asks for a display-style
// phrase, and that phrase, verbatim, was reused as machine-matching input.
// Word-overlap scoring against "Bayern Munich" then dilutes to 1/3 = 0.333,
// below PARTICIPANT_MATCH_THRESHOLD (0.4), producing a false NO_MATCH the
// real event data should have resolved correctly.
//
// This module fixes the INPUT, not the matcher: resolveParticipantSide()
// and its calibrated overlapScore()/wordsMatch() thresholds (proven against
// a real 17-pair name battery — see teamNameMatcher.ts's own comments) are
// completely untouched. Every token/regex used below is reused verbatim from
// lib/odds/shorthandClassifier.ts's own existing, already-trusted vocabulary
// (HOME/DRAW/AWAY tokens, WINNER_SUFFIX_REGEX) — no new vocabulary is
// invented here, and nothing here is specific to any one bookmaker.
//
// Deliberately invoked ONLY from the OCR-mode branch of
// lib/ai/betParser.ts's buildParsedBetSlipResult() — the CHAT/typed-message
// path passes its claim through completely unchanged, so this module cannot
// alter typed-chat behavior even in principle, not just in practice.

import { isBareMoneylineShorthandToken, stripTrailingWinnerSuffix } from "@/lib/odds/shorthandClassifier";

const SEPARATOR_CHARS_PATTERN = /[\s\-–—:]/;
const LEADING_SEPARATOR_PATTERN = /^[\s\-–—:]+/;
const TRAILING_PAREN_PATTERN = /\s*\(([^()]+)\)\s*$/;
const SHORTHAND_TOKEN_PUNCTUATION_PATTERN = /[().,;]/g;

// "П1 - Бавария" -> "Бавария". Only strips a single leading token when that
// exact token (punctuation-free, case-insensitive) is a closed HOME/DRAW/AWAY
// shorthand token — a real participant name's own first word (e.g. "Real"
// in "Real Madrid") is never a member of that set, so it can never be
// mistaken for one.
function stripLeadingShorthand(text: string): string {
  const firstSeparatorIndex = text.search(SEPARATOR_CHARS_PATTERN);
  if (firstSeparatorIndex === -1) return text;

  const candidate = text.slice(0, firstSeparatorIndex);
  if (!isBareMoneylineShorthandToken(candidate)) return text;

  const rest = text.slice(firstSeparatorIndex).replace(LEADING_SEPARATOR_PATTERN, "");
  return rest;
}

// "Bayern Win (П1)" -> "Bayern Win" (the trailing "Win" is then handled by
// stripTrailingWinnerSuffix separately). Only strips a trailing parenthetical
// whose entire content is a single closed shorthand token — a genuinely
// descriptive parenthetical (e.g. a city/country qualifier) never matches
// that closed vocabulary and is left untouched.
function stripTrailingParenShorthand(text: string): string {
  const match = TRAILING_PAREN_PATTERN.exec(text);
  if (!match) return text;

  const inner = match[1].trim();
  if (!isBareMoneylineShorthandToken(inner)) return text;

  return text.slice(0, match.index).trim();
}

// "Bayern Munich W1" -> "Bayern Munich". Same closed-token discipline as
// stripLeadingShorthand, applied to the trailing word instead.
function stripTrailingBareShorthand(text: string): string {
  const lastSeparatorIndex = text.lastIndexOf(" ");
  if (lastSeparatorIndex === -1) return text;

  const candidate = text.slice(lastSeparatorIndex + 1).replace(SHORTHAND_TOKEN_PUNCTUATION_PATTERN, "");
  if (!isBareMoneylineShorthandToken(candidate)) return text;

  return text.slice(0, lastSeparatorIndex).trim();
}

// Cleans OCR-mode display-style selection text into something closer to a
// bare participant name before it is used as a claimedParticipant for
// resolveParticipantSide() matching. Never called for the raw `selection`
// field that is actually shown to the player (that stays exactly what
// Claude produced) — this only affects the separate, internal matching
// input. Never throws; a fully-stripped-to-empty result falls back to the
// original raw text rather than handing the caller an empty string.
export function normalizeOcrParticipantClaim(rawSelectionText: string): string {
  const trimmed = rawSelectionText.trim();
  if (trimmed.length === 0) return trimmed;

  let text = trimmed;
  text = stripLeadingShorthand(text);
  text = stripTrailingParenShorthand(text);
  text = stripTrailingWinnerSuffix(text);
  text = stripTrailingBareShorthand(text);

  const cleaned = text.trim();
  return cleaned.length > 0 ? cleaned : trimmed;
}

// SCREENSHOT ODDS QA-2 — a DELIBERATELY NARROWER sibling of
// normalizeOcrParticipantClaim(), for a different consumer:
// legacySelectionToCanonicalRequest() (lib/odds/legacyOddsBridge.ts), the
// function that turns raw selection text into the odds-provider search
// input. That function already has TWO of its own working mechanisms for
// exactly this kind of noise — classifyOnce() (lib/odds/shorthandClassifier.ts)
// already strips a trailing winner-suffix ("Arsenal Win" -> "Arsenal")
// directly, and its own knownParticipantNames prefix loop already strips a
// trailing bare shorthand token when it follows an EXACT participant-name
// prefix ("RB Leipzig W1" -> "RB Leipzig" + "W1"). Reusing the FULL
// normalizeOcrParticipantClaim() here — confirmed by a real regression
// while building this fix — actively HURTS: pre-stripping "Arsenal Win" to
// "Arsenal" before classification removes the exact word ("Win") classifyOnce
// needs to derive a confident MONEYLINE claim on its own, which then lets an
// unrelated market hint (e.g. marketRawText "Handicap") incorrectly win
// instead — precisely the failure mode the "market hint never overrides a
// real selection-derived claim" contract exists to prevent.
//
// This function strips ONLY the two noise shapes neither existing mechanism
// already covers: a leading shorthand token ("П1 - Бавария" -> "Бавария")
// and a TRAILING PARENTHETICAL shorthand annotation ("Bayern Win (П1)" ->
// "Bayern Win", which classifyOnce's own winner-suffix stripping then
// completes on its own, since "Bayern Win" — unlike "Bayern Win (П1)" —
// genuinely ends in "Win"). Deliberately does NOT strip a trailing winner
// suffix or a trailing bare shorthand token — those are left to the two
// existing mechanisms above, so this function can never weaken either one.
export function normalizeSelectionTextForCanonicalization(rawSelectionText: string): string {
  const trimmed = rawSelectionText.trim();
  if (trimmed.length === 0) return trimmed;

  let text = trimmed;
  text = stripLeadingShorthand(text);
  text = stripTrailingParenShorthand(text);

  const cleaned = text.trim();
  return cleaned.length > 0 ? cleaned : trimmed;
}
