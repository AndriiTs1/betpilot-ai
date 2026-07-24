// Step 10B — a pure, synchronous, deterministic pre-parser gate deciding
// whether ordinary Telegram text is worth routing into the paid
// parseBetSlipMessage/buildBetSlipPreview pipeline at all. No I/O, no
// database, no AI, no provider, no Telegram API, no logging, no external
// package — every decision here is a closed-vocabulary regex match over the
// text itself.
//
// Reuses MIN_ODDS_PAYLOAD_LENGTH/MAX_ODDS_PAYLOAD_LENGTH from
// extractCommandPayload.ts (the same bounds /odds already enforces) rather
// than duplicating them.
//
// Design: four independent closed categories (event structure, market
// language, odds marker, slip marker). A match requires signals from at
// least TWO different categories — a single strong-looking word is never
// enough (see this file's own tests for "I want to win" / "This is over" /
// "Draw me a picture" / "My stake in the company", each of which matches
// exactly one category and is correctly rejected). This deliberately
// favors precision over recall: some genuine bets phrased outside this
// closed vocabulary will be missed and fall back to the existing REDIRECT
// text, which is a safe, unchanged, already-live outcome — a false
// positive here means an unwanted paid Claude+odds-provider call, which is
// the more expensive mistake to make.

import { MIN_ODDS_PAYLOAD_LENGTH, MAX_ODDS_PAYLOAD_LENGTH } from "./extractCommandPayload";

const URL_ONLY_PATTERN = /^(?:https?:\/\/|www\.)\S+$/i;

// Whitespace-bounded only (mirrors lib/bets/draft/normalize.ts's own
// EVENT_SEPARATOR_REGEX convention) — "TeamA-TeamB" (no surrounding
// whitespace) must never be mistaken for event structure.
const EVENT_SEPARATOR_PATTERN = /\s(?:vs\.?|v\.?|against|-|–|—)\s/i;

// Longest-first is not required for correctness here (each phrase is
// checked independently as its own boolean signal, not via a single
// alternation), but is kept for readability — "to win" reads naturally
// above the bare "win" it overlaps with.
const MARKET_LANGUAGE_WORDS = [
  "both teams to score",
  "to win",
  "win",
  "draw",
  "over",
  "under",
  "total",
  "handicap",
  "btts",
  "moneyline",
  "1x2",
  // Italian
  "vincente",
  "vittoria",
  "pareggio",
  "totale",
  "sopra",
  "sotto",
  // Russian
  "победа",
  "победит",
  "ничья",
  "тотал",
  "больше",
  "меньше",
  "обе забьют",
];

const SLIP_MARKER_WORDS = [
  "single",
  "express",
  "accumulator",
  "parlay",
  "stake",
  "bet",
  "ставка",
  "экспресс",
  "ординар",
  "puntata",
  "multipla",
  "scommessa",
];

// Word-form odds markers only — "@" is handled separately below since it's
// a symbol, not a word, and needs no letter/number boundary check of its
// own (an "@" adjacent to a digit is unambiguous on its own).
const ODDS_WORD_MARKERS = ["odds", "coefficient", "quota", "кф", "коэффициент"];

function escapeForRegExp(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// True Unicode-aware word/phrase boundary check — NOT `\b`, which is
// defined in terms of `\w` (ASCII letters/digits/underscore only). For a
// pure-Cyrillic run like "победа", every character (and the surrounding
// spaces) is equally non-\w, so `\b` never fires anywhere in that string at
// all. `(?<![\p{L}\p{N}])...(?![\p{L}\p{N}])` (with the `u` flag) instead
// checks against the real Unicode Letter/Number categories, so it works
// identically for Latin, Cyrillic, or any other script.
function hasWordOrPhrase(normalized: string, token: string): boolean {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeForRegExp(token)}(?![\\p{L}\\p{N}])`, "u");
  return pattern.test(normalized);
}

// "odds followed by a number" only needs a real Letter/Number boundary
// BEFORE the word (so "podds 2.05" doesn't count) — the trailing digit
// itself is what satisfies "followed by a number", so no closing boundary
// check is applied on that side (an immediately-adjacent digit, e.g.
// "odds2.05", must still count).
function hasOddsWordMarker(normalized: string): boolean {
  return ODDS_WORD_MARKERS.some((word) => {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeForRegExp(word)}\\s*\\d`, "u");
    return pattern.test(normalized);
  });
}

function isNonTrivialSide(side: string): boolean {
  const trimmed = side.trim();
  if (!/\p{L}/u.test(trimmed)) return false;
  return trimmed.replace(/\s/g, "").length >= 2;
}

function hasEventStructure(normalized: string): boolean {
  const match = EVENT_SEPARATOR_PATTERN.exec(normalized);
  if (!match) return false;

  const before = normalized.slice(0, match.index);
  const after = normalized.slice(match.index + match[0].length);
  return isNonTrivialSide(before) && isNonTrivialSide(after);
}

function hasMarketLanguage(normalized: string): boolean {
  return MARKET_LANGUAGE_WORDS.some((word) => hasWordOrPhrase(normalized, word));
}

function hasSlipMarker(normalized: string): boolean {
  return SLIP_MARKER_WORDS.some((word) => hasWordOrPhrase(normalized, word));
}

function hasOddsMarker(normalized: string): boolean {
  if (/@\d/.test(normalized)) return true;
  return hasOddsWordMarker(normalized);
}

// Normalization exists ONLY for this function's own matching decision —
// the caller must always forward the original, untrimmed-of-internal-
// content text to parseBetSlipMessage, never anything derived from this
// normalized copy.
function normalizeForMatching(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function looksLikeBettingText(text: string): boolean {
  if (typeof text !== "string") return false;

  const trimmed = text.trim();

  if (trimmed.length < MIN_ODDS_PAYLOAD_LENGTH) return false;
  if (trimmed.length > MAX_ODDS_PAYLOAD_LENGTH) return false;

  // Defensive — app/api/webhooks/telegram/route.ts already only calls this
  // function when extractCommand(text) === null (no leading "/" at all),
  // so this should never actually fire in production, but a pure function
  // should never assume its caller's own gating is the only thing standing
  // between it and a slash command.
  if (trimmed.startsWith("/")) return false;

  if (URL_ONLY_PATTERN.test(trimmed)) return false;

  const normalized = normalizeForMatching(trimmed);

  const categoryMatches = [
    hasEventStructure(normalized),
    hasMarketLanguage(normalized),
    hasOddsMarker(normalized),
    hasSlipMarker(normalized),
  ].filter(Boolean).length;

  return categoryMatches >= 2;
}
