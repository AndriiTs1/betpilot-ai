// Temporary product rule (explicitly NOT full i18n): every bet
// selection/outcome label must display in English, regardless of what
// language it was submitted or parsed in. AI text parsing and OCR
// transcribe whatever language the source bookmaker slip used (see
// lib/ai/betParser.ts's prompts, which have no instruction to translate),
// so the same logical selection currently reaches the UI as "П1",
// "Победа 1", "Home team win", or "Home Win" depending on where it came
// from — all of those must render identically.
//
// Deterministic, not AI-based: this is a display-layer lookup over a small
// set of well-known market phrasings (1X2, totals, both teams to score,
// double chance, named winner), not a translator. Anything that doesn't
// confidently match one of these known shapes is returned completely
// unchanged — inventing an English label for an ambiguous or unrecognized
// selection would silently misrepresent what the player actually bet on.
//
// This is called only on the *display* value, each data flow exactly once
// at the point that flow's selection text first becomes user-facing:
// lib/bets/mapBetForDisplay.ts (the canonical post-persistence mapper —
// covers Dashboard BetQueueItem/PlayerCard and both Mini App screens'
// headline row), components/miniapp/BetPreviewCard.tsx (pre-persistence
// preview, both SINGLE and EXPRESS branches), components/miniapp/
// BetSelectionsList.tsx (the Mini App's raw per-leg list, which reads
// straight off GET /api/miniapp/me and never passes through
// mapBetForDisplay), the Mini App confirm-response serializers in
// app/api/miniapp/bets/text/confirm/route.ts, and the three Telegram
// notification builders. Deliberately NOT called in components/bets/
// SelectionRow.tsx — the shared leaf renderer trusts every DisplaySelection
// it's given to already be normalized by whichever of the above produced
// it, so normalization happens once per flow, not once per render. Never
// inserted into lib/odds/oddsVerifier.ts or lib/bets/buildBetSlipPreview.ts,
// which must keep matching against the player's originally submitted text.
// Calling this on an already-normalized value is still safe (every
// canonical output is also a recognized input) — a couple of call sites
// unavoidably do this across separate requests (see mapBetForDisplay.ts's
// and BetSelectionsList.tsx's own comments), which is harmless by design.

export interface NormalizeSelectionInput {
  selection: string;
  sport?: string | null;
  event?: string | null;
  market?: string | null;
}

function clean(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

// Case/whitespace-insensitive exact-string lookup — deliberately not a
// substring/regex replace against arbitrary surrounding text, so a longer,
// unrelated selection that merely contains "draw" or "x" somewhere never
// gets rewritten.
function buildExactLookup(pairs: [string[], string][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const [keys, value] of pairs) {
    for (const key of keys) {
      map.set(key.toLowerCase(), value);
    }
  }
  return map;
}

const HOME_WIN = "Home Win";
const AWAY_WIN = "Away Win";
const DRAW = "Draw";

// Cyrillic "х"/"Х" (U+0445/U+0425) are included alongside Latin "x"/"X"
// since Russian bookmaker slips write the draw/double-chance symbol with
// the Cyrillic letter, which is visually near-identical but a different
// codepoint.
const MATCH_RESULT_LOOKUP = buildExactLookup([
  [["п1", "победа 1", "победа хозяев", "home team win", "home win"], HOME_WIN],
  [["п2", "победа 2", "победа гостей", "away team win", "away win"], AWAY_WIN],
  [["x", "х", "ничья", "draw"], DRAW],
]);

const DOUBLE_CHANCE_LOOKUP = buildExactLookup([
  [["1x", "1х"], "Home or Draw"],
  [["x2", "х2"], "Draw or Away"],
  [["12"], "Home or Away"],
]);

const BTTS_NO_PATTERN = /^(?:both teams to score|обе забьют|btts)\s*[-–—:]\s*(?:no|нет)$/i;
const BTTS_YES_PATTERN = /^(?:both teams to score|обе забьют|btts)(?:\s*[-–—:]\s*(?:yes|да))?$/i;

const TOTAL_NUMBER = "(\\d+(?:[.,]\\d+)?)";
const OVER_PATTERN = new RegExp(`^(?:тб|тотал\\s+больше|over|more than)\\s*${TOTAL_NUMBER}(?:\\s*(?:голов|goals))?$`, "i");
const UNDER_PATTERN = new RegExp(`^(?:тм|тотал\\s+меньше|under|less than)\\s*${TOTAL_NUMBER}(?:\\s*(?:голов|goals))?$`, "i");

// Already-canonical English named-winner form — returned unchanged rather
// than re-wrapped (e.g. "Carlos Alcaraz Win" must not become
// "Carlos Alcaraz Win Win").
const ALREADY_ENGLISH_WIN = /^.+\sWin$/;

// "Победа <Name>" / "<Name> победит" — only reached once every fixed 1X2
// literal above (Победа 1 / Победа хозяев / …) has already failed to match,
// so this can never mistake "1"/"2"/"хозяев"/"гостей" for a team or player
// name. The guard set below is a second, independent safety net in case a
// spelling variant of those same words reaches this branch.
const NAMED_WIN_RU_PREFIX = /^Победа\s+(.+)$/i;
const NAMED_WIN_RU_SUFFIX = /^(.+?)\s+победит$/i;
const NON_NAME_GUARD = new Set(["1", "2", "хозяев", "гостей", "дома", "в гостях", "home", "away"]);

function normalizeTotalNumber(raw: string): string {
  return raw.replace(",", ".");
}

// Totals are only labeled "Goals" for football/soccer, where every example
// in the product brief is drawn from — an unspecified sport defaults to
// that same football-context wording. For a sport known to use a different
// unit (basketball, hockey, tennis, ...), the number is normalized without
// guessing a possibly-wrong unit.
function isFootball(sport?: string | null): boolean {
  if (!sport) return true;
  const s = sport.toLowerCase().trim();
  return s === "football" || s === "soccer" || s === "футбол";
}

export function normalizeSelectionToEnglish(input: NormalizeSelectionInput): string {
  const original = input.selection;
  if (typeof original !== "string") return original;

  const text = clean(original);
  if (text.length === 0) return original;

  const key = text.toLowerCase();

  const matchResult = MATCH_RESULT_LOOKUP.get(key);
  if (matchResult) return matchResult;

  const doubleChance = DOUBLE_CHANCE_LOOKUP.get(key);
  if (doubleChance) return doubleChance;

  if (BTTS_NO_PATTERN.test(text)) return "Both Teams to Score — No";
  if (BTTS_YES_PATTERN.test(text)) return "Both Teams to Score — Yes";

  const overMatch = text.match(OVER_PATTERN);
  if (overMatch) {
    const suffix = isFootball(input.sport) ? " Goals" : "";
    return `Over ${normalizeTotalNumber(overMatch[1])}${suffix}`;
  }

  const underMatch = text.match(UNDER_PATTERN);
  if (underMatch) {
    const suffix = isFootball(input.sport) ? " Goals" : "";
    return `Under ${normalizeTotalNumber(underMatch[1])}${suffix}`;
  }

  if (ALREADY_ENGLISH_WIN.test(text)) return original;

  const prefixMatch = text.match(NAMED_WIN_RU_PREFIX);
  if (prefixMatch) {
    const name = clean(prefixMatch[1]);
    if (!NON_NAME_GUARD.has(name.toLowerCase())) return `${name} Win`;
  }

  const suffixMatch = text.match(NAMED_WIN_RU_SUFFIX);
  if (suffixMatch) {
    const name = clean(suffixMatch[1]);
    if (!NON_NAME_GUARD.has(name.toLowerCase())) return `${name} Win`;
  }

  // Nothing matched confidently — preserve the original value untouched
  // rather than guessing.
  return original;
}
