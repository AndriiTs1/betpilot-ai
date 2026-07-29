// Stage 3.5C-FIX — shared team-name normalization/matching primitives,
// extracted verbatim (no functional change) from lib/odds/oddsVerifier.ts's
// original Cyrillic-transliteration fix (commit 7430506), so both
// oddsVerifier.ts (odds/event matching) and
// lib/bets/settlement/evaluateSelectionOutcome.ts (PARTICIPANT selection
// resolution) call the exact same logic instead of two independently
// drifting copies. Every constant, table, and threshold below is
// byte-for-byte the same as before this extraction — see oddsVerifier.ts's
// own git history for the original design rationale (Cyrillic alphabet
// coverage decisions, the empirical Levenshtein-threshold calibration
// against real club-name pairs, etc.), not repeated here.

/* -------------------------------------------------------------------------- */
/* Team name normalization                                                    */
/* -------------------------------------------------------------------------- */

// Small set of common clubs written in Russian, so "Реал Мадрид" resolves
// against The Odds API's "Real Madrid". Not exhaustive by design.
const TEAM_ALIASES: Record<string, string> = {
  "реал мадрид": "real madrid",
  барселона: "barcelona",
  "манчестер юнайтед": "manchester united",
  "манчестер сити": "manchester city",
  ливерпуль: "liverpool",
  челси: "chelsea",
  арсенал: "arsenal",
  тоттенхэм: "tottenham",
  бавария: "bayern munich",
  "боруссия дортмунд": "borussia dortmund",
  ювентус: "juventus",
  милан: "ac milan",
  интер: "inter milan",
  псж: "paris saint germain",
};

const DIACRITIC_REGEX = /[̀-ͯ]/g;

// General Cyrillic -> Latin transliteration, covering Russian, Ukrainian,
// and the handful of additional Serbian-specific letters (ђ, џ, ћ, љ, њ,
// ј — the rest of the Serbian/Bulgarian Cyrillic alphabet is already a
// subset of Russian's, same underlying letters). Deliberately NOT a
// scientific/official transliteration standard, and deliberately NOT
// tuned per-language (e.g. Serbian's own official Latin alphabet maps ц
// to "c", not "ts" — using that here would be exactly the kind of
// point-specific special-casing this fix must avoid) — one single,
// consistent table applied to every Cyrillic character regardless of
// which Slavic language it happens to belong to. Its job is narrow: turn
// meaningful Cyrillic text into SOME stable, non-empty Latin
// approximation so the word-overlap matching below has something to work
// with — it is not expected to reproduce a foreign provider's own native
// spelling exactly (see wordsMatch()'s bounded fuzzy tolerance, which is
// what actually bridges that remaining gap).
const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", ґ: "g", д: "d", е: "e", ё: "e", є: "e",
  ж: "zh", з: "z", и: "i", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h",
  ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e",
  ю: "yu", я: "ya",
  // Serbian-only letters (not present in Russian/Ukrainian Cyrillic).
  ђ: "dj", џ: "dz", ћ: "c", љ: "lj", њ: "nj", ј: "j",
};

// Any character not in the table above (already-Latin letters, digits,
// punctuation, whitespace) passes through unchanged — this function never
// throws and never produces an empty result for non-empty Cyrillic input,
// which is the specific bug commit 7430506 fixed (Cyrillic previously
// survived to the final `[^a-z0-9\s]` filter below completely unrecognized,
// and was stripped down to nothing).
function transliterateCyrillic(raw: string): string {
  let out = "";
  for (const ch of raw) {
    out += CYRILLIC_TO_LATIN[ch] ?? ch;
  }
  return out;
}

// Pipeline: trim+lowercase -> TEAM_ALIASES lookup (Cyrillic-keyed, so it
// must run BEFORE transliteration or its keys would never match) ->
// Cyrillic transliteration -> Unicode NFD -> strip combining marks (accents)
// -> normalize punctuation/keep [a-z0-9\s] (one combined regex — replacing
// every disallowed character with a space already achieves both "normalize
// separators" and "keep only [a-z0-9\s]" in a single pass) -> collapse
// whitespace.
//
// No second TEAM_ALIASES lookup after transliteration: every alias key is
// itself a lowercase Cyrillic string, checked against the raw (still
// Cyrillic) input above — by definition it can never match Latin
// transliterated output, so re-checking after transliteration would only
// ever be dead code, not an additional safety net.
export function normalizeTeamName(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const aliased = TEAM_ALIASES[lower] ?? lower;
  const transliterated = transliterateCyrillic(aliased);

  return transliterated
    .normalize("NFD")
    .replace(DIACRITIC_REGEX, "") // strip accents (e.g. "México" -> "mexico")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Bounded fuzzy word matching                                                */
/* -------------------------------------------------------------------------- */

// Iterative (not recursive) Levenshtein distance — no external dependency,
// deterministic, O(a.length * b.length), only ever run on short
// already-normalized single words (team names), never on full sentences.
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const current = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min(current[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost));
    }
    prev = current;
  }
  return prev[n];
}

// Bounded near-match tolerance for a single word pair — this is what
// actually bridges the gap pure transliteration cannot: a Cyrillic
// rendering of a foreign name (e.g. Russian "Забже" for Polish "Zabrze")
// and the provider's own native/English spelling are both honest
// representations of the same name, but rarely identical letter-for-letter
// after transliteration. Calibrated empirically (commit 7430506) against a
// real diagnosed case AND a battery of ~17 real, genuinely DIFFERENT
// club-name pairs of similar length (chelsea/everton, barcelona/valencia,
// celtic/rangers, genk/gent, etc.) — every one of those stays safely
// unmatched with wide margin at these exact constants; tightening either
// constant would risk losing real positive cases, loosening either would
// start risking false positives on short, genuinely-different club names
// (the closest real negative found, "genk"/"gent", is exactly why
// FUZZY_WORD_MIN_LENGTH excludes anything under 6 characters rather than
// being set lower).
const FUZZY_WORD_MIN_LENGTH = 6;
const FUZZY_WORD_MAX_DISTANCE_RATIO = 0.34;
const FUZZY_WORD_MAX_ABSOLUTE_DISTANCE = 3;

function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < FUZZY_WORD_MIN_LENGTH) return false;

  const maxLen = Math.max(a.length, b.length);
  const allowed = Math.min(Math.floor(maxLen * FUZZY_WORD_MAX_DISTANCE_RATIO), FUZZY_WORD_MAX_ABSOLUTE_DISTANCE);
  return levenshteinDistance(a, b) <= allowed;
}

function wordSet(s: string): Set<string> {
  return new Set(s.split(" ").filter(Boolean));
}

// A word in `a` counts as "common" if it exactly matches a word in `b`, OR
// (see wordsMatch() above) is a bounded near-match — never a fuzzy MATCH
// COUNT beyond 1 per word, and never substring/prefix matching (which
// could match "art" inside "cartagena"), only whole-word comparison.
function wordSetHasMatch(word: string, set: ReadonlySet<string>): boolean {
  if (set.has(word)) return true;
  for (const candidate of set) {
    if (wordsMatch(word, candidate)) return true;
  }
  return false;
}

// Operates on two ALREADY-NORMALIZED strings (see normalizeTeamName above)
// — kept as its own export, distinct from compareTeamNames() below, because
// oddsVerifier.ts's existing call sites normalize once per event/selection
// upfront and reuse that normalized value across several comparisons (e.g.
// findMatchingEvent()'s forward/backward pairing); re-normalizing on every
// call there would be wasteful, not incorrect, but this preserves the
// original, already-proven call structure byte-for-byte during extraction
// rather than introducing an unrelated refactor alongside this stage's own
// change.
export function overlapScore(normalizedA: string, normalizedB: string): number {
  const setA = wordSet(normalizedA);
  const setB = wordSet(normalizedB);

  if (setA.size === 0 || setB.size === 0) return 0;

  let common = 0;
  for (const word of setA) {
    if (wordSetHasMatch(word, setB)) common += 1;
  }

  return common / Math.max(setA.size, setB.size);
}

/* -------------------------------------------------------------------------- */
/* Convenience API for a single raw-string-pair comparison                    */
/* -------------------------------------------------------------------------- */

// One-shot convenience wrapper for callers with a single raw (not yet
// normalized) pair to compare, e.g. resolveParticipantSide() below —
// normalizes both sides then delegates to the identical overlapScore()
// used everywhere else, never a second scoring algorithm.
export function compareTeamNames(left: string, right: string): number {
  return overlapScore(normalizeTeamName(left), normalizeTeamName(right));
}

// Same operation as oddsVerifier.ts's own SELECTION_MATCH_THRESHOLD (a
// free-text team name vs a single canonical team name — not a whole-event,
// two-team comparison, which is oddsVerifier.ts's separately-tuned
// EVENT_MATCH_THRESHOLD instead) — reused at the identical value rather
// than independently re-derived, since it is, structurally, the same
// comparison. Kept as this module's own constant (not imported from
// oddsVerifier.ts) so settlement's tolerance can diverge later without
// having to touch odds verification, should real evidence ever justify
// that — not a hint that it should, today.
const PARTICIPANT_MATCH_THRESHOLD = 0.4;

export type ParticipantSideResolution =
  | { readonly kind: "HOME" }
  | { readonly kind: "AWAY" }
  | { readonly kind: "NO_MATCH" }
  | { readonly kind: "AMBIGUOUS" };

// Never guesses: a participant name matching neither side, or both sides
// at once, is reported honestly rather than silently picking one — see
// this stage's own audit for why (a wrong guess here is a wrong WIN/LOSS,
// a real money outcome). Never uses selection order, odds, or any other
// heuristic — name-vs-name comparison only, via the exact same
// normalization/fuzzy-matching pipeline oddsVerifier.ts already relies on
// in production.
export function resolveParticipantSide(
  participantName: string,
  homeName: string,
  awayName: string,
): ParticipantSideResolution {
  const homeScore = compareTeamNames(participantName, homeName);
  const awayScore = compareTeamNames(participantName, awayName);
  const matchesHome = homeScore >= PARTICIPANT_MATCH_THRESHOLD;
  const matchesAway = awayScore >= PARTICIPANT_MATCH_THRESHOLD;

  if (matchesHome && matchesAway) return { kind: "AMBIGUOUS" };
  if (matchesHome) return { kind: "HOME" };
  if (matchesAway) return { kind: "AWAY" };
  return { kind: "NO_MATCH" };
}
