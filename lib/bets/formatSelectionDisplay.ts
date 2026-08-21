import type { Locale } from "@/lib/i18n/locale";

// Presentation-only RU localization for the betting terminology
// (selection/market labels) rendered on an already-confirmed/submitted
// ticket. This is deliberately downstream of, and never modifies,
// lib/bets/normalizeSelectionToEnglish.ts's own "temporary product rule"
// (every selection/outcome string is normalized to a small closed set of
// English phrasings before it ever becomes user-facing — see that file's
// header for the full rationale and its own list of call sites). Every
// `selection` string this formatter receives is one of THAT function's
// known English output shapes (Home Win / Away Win / Draw / Home or Draw /
// Draw or Away / Home or Away / Both Teams to Score — Yes|No /
// Over N[ Goals] / Under N[ Goals] / "<Name> Win" / a SPREAD's
// "<Name> <signed line>"), or an unrecognized value passed straight
// through unchanged — this formatter recognizes that same closed
// vocabulary and is the RU-only display-layer inverse of it. It never
// touches canonical data, provider values, the preview token, the parser,
// odds verification, or normalizeSelectionToEnglish itself — only what
// text a RU-locale player sees for an already-finalized English display
// string.
//
// Team/event/participant names are never translated — a captured name
// (e.g. "Марсель" from "Марсель Win") is carried through byte-for-byte,
// exactly per product rule.
//
// Called from components/miniapp/BetTicket.tsx (SINGLE and EXPRESS legs
// share this one call site — see that file's own selections.map()).
// Deliberately NOT wired into components/bets/SelectionRow.tsx, the shared
// dashboard leaf renderer, which must never gain Mini-App locale awareness
// (see that file's own header comment on the localization boundary).
//
// Fallback safety: an unrecognized selection or market string is always
// returned unchanged (never blank, never thrown) — the exact same
// "preserve original rather than guess" discipline
// normalizeSelectionToEnglish.ts itself already follows.

export interface SelectionDisplayResult {
  selection: string;
  market: string | null;
}

const HOME_WIN = "home win";
const AWAY_WIN = "away win";
const DRAW = "draw";
const HOME_OR_DRAW = "home or draw";
const DRAW_OR_AWAY = "draw or away";
const HOME_OR_AWAY = "home or away";
const BTTS_YES = "both teams to score — yes";
const BTTS_NO = "both teams to score — no";

const OVER_PATTERN = /^over\s+(\d+(?:\.\d+)?)(?:\s+goals)?$/i;
const UNDER_PATTERN = /^under\s+(\d+(?:\.\d+)?)(?:\s+goals)?$/i;
// Same shape as normalizeSelectionToEnglish.ts's own ALREADY_ENGLISH_WIN —
// checked last, only after every exact known phrasing above has already
// failed to match, so "Home Win"/"Away Win" (no real participant name) are
// never mistaken for a named winner.
const NAMED_WIN_PATTERN = /^(.+)\sWin$/;

type SelectionKind =
  | { kind: "namedWin"; name: string }
  | { kind: "homeWin" }
  | { kind: "awayWin" }
  | { kind: "draw" }
  | { kind: "homeOrDraw" }
  | { kind: "drawOrAway" }
  | { kind: "homeOrAway" }
  | { kind: "bttsYes" }
  | { kind: "bttsNo" }
  | { kind: "over"; line: string }
  | { kind: "under"; line: string }
  | { kind: "unknown" };

function classifySelection(selection: string): SelectionKind {
  const trimmed = selection.trim();
  const key = trimmed.toLowerCase();

  if (key === HOME_WIN) return { kind: "homeWin" };
  if (key === AWAY_WIN) return { kind: "awayWin" };
  if (key === DRAW) return { kind: "draw" };
  if (key === HOME_OR_DRAW) return { kind: "homeOrDraw" };
  if (key === DRAW_OR_AWAY) return { kind: "drawOrAway" };
  if (key === HOME_OR_AWAY) return { kind: "homeOrAway" };
  if (key === BTTS_YES) return { kind: "bttsYes" };
  if (key === BTTS_NO) return { kind: "bttsNo" };

  const overMatch = trimmed.match(OVER_PATTERN);
  if (overMatch) return { kind: "over", line: overMatch[1] };

  const underMatch = trimmed.match(UNDER_PATTERN);
  if (underMatch) return { kind: "under", line: underMatch[1] };

  const namedWinMatch = trimmed.match(NAMED_WIN_PATTERN);
  if (namedWinMatch && namedWinMatch[1].trim().length > 0) {
    return { kind: "namedWin", name: namedWinMatch[1].trim() };
  }

  return { kind: "unknown" };
}

// A selection that already states WHO wins the match makes a "Match
// Winner"/"Победитель матча" market label purely redundant right next to
// it — see this module's own header and the two production examples this
// was built from ("Марсель · Победа" vs "Ничья · Победитель матча").
function isWinOutcome(kind: SelectionKind["kind"]): boolean {
  return kind === "namedWin" || kind === "homeWin" || kind === "awayWin";
}

function ruSelectionText(classified: SelectionKind, original: string): string {
  switch (classified.kind) {
    case "namedWin":
      // The participant name is carried through untranslated — only the
      // outcome word is localized. Deliberately one combined string (not a
      // separate field): with the market suppressed as redundant right
      // below, this is the entire localized label BetTicket.tsx renders.
      return `${classified.name} · Победа`;
    case "homeWin":
      return "Победа хозяев";
    case "awayWin":
      return "Победа гостей";
    case "draw":
      return "Ничья";
    case "homeOrDraw":
      return "Победа хозяев или ничья";
    case "drawOrAway":
      return "Ничья или победа гостей";
    case "homeOrAway":
      return "Победа хозяев или гостей";
    case "bttsYes":
      return "Обе забьют — Да";
    case "bttsNo":
      return "Обе забьют — Нет";
    case "over":
      return `Больше ${classified.line}`;
    case "under":
      return `Меньше ${classified.line}`;
    case "unknown":
      // Fallback safety — an unrecognized selection (a SPREAD's
      // "<Name> <signed line>", or any future/unknown phrasing) is never
      // guessed at; the existing, safe English/canonical value is kept.
      return original;
  }
}

const MARKET_RU_LOOKUP = new Map<string, string>([
  ["match winner", "Победитель матча"],
  ["moneyline", "Победитель матча"],
  ["money line", "Победитель матча"],
  ["1x2", "Победитель матча"],
  ["total goals", "Тотал голов"],
  ["totals", "Тотал"],
  ["total", "Тотал"],
  ["both teams to score", "Обе забьют"],
]);

function isMatchWinnerMarket(market: string): boolean {
  const key = market.trim().toLowerCase();
  return key === "match winner" || key === "moneyline" || key === "money line" || key === "1x2";
}

function ruMarketText(market: string): string {
  const key = market.trim().toLowerCase();
  // Fallback safety — an unrecognized market label is returned unchanged,
  // never blank.
  return MARKET_RU_LOOKUP.get(key) ?? market;
}

// The one entry point BetTicket.tsx calls per selection, for both SINGLE
// and EXPRESS legs, across every ticket status (submitted/confirmed/
// rejected/settled) — the canonical selection/market values themselves
// never change with status, so this formatter has no status-dependent
// behavior at all.
export function formatSelectionDisplay(
  selection: string,
  market: string | null | undefined,
  locale: Locale,
): SelectionDisplayResult {
  const normalizedMarket = market ?? null;

  // EN is the identity function: these strings ARE already the correct
  // English display text (normalizeSelectionToEnglish's whole purpose) —
  // nothing is reconstructed, so EN output can never regress.
  if (locale !== "ru") {
    return { selection, market: normalizedMarket };
  }

  const classified = classifySelection(selection);
  const ruSelection = ruSelectionText(classified, selection);

  if (normalizedMarket === null) {
    return { selection: ruSelection, market: null };
  }

  if (isWinOutcome(classified.kind) && isMatchWinnerMarket(normalizedMarket)) {
    // Redundant: the selection text already states who wins the match.
    return { selection: ruSelection, market: null };
  }

  return { selection: ruSelection, market: ruMarketText(normalizedMarket) };
}
