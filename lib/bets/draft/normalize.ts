// Step 8A — pure, deterministic normalization functions for
// UniversalBetDraft fields. No LLM calls, no HTTP, no environment
// variables, no logging, no provider IDs or sport_key values anywhere.
// Every alias table here is closed and exact (trim + lowercase + collapse
// whitespace) — never fuzzy or substring matching.
//
// This file mirrors (never imports) the same small, stable vocabularies
// already proven in lib/odds/legacyOddsBridge.ts (Step 7A) — the same
// convention that file itself uses for oddsVerifier.ts's private token
// sets. The two tables are intentionally independent: this one governs
// how a UniversalBetDraft's own fields normalize; legacyOddsBridge.ts's
// governs how a legacy ParsedBetSlip selection maps to a provider request.
// A future Step 8B integration is expected to keep them in sync by hand,
// not by importing across module boundaries that were never asked for.

import type { MarketType, Period, SelectionType, Sport } from "@/lib/odds/domain";
import {
  extractedField,
  missingField,
  unknownField,
  unsupportedField,
  type BetDraftField,
  type BetDraftLeague,
  type BetDraftLine,
  type BetDraftParticipant,
  type BetDraftParticipantRef,
} from "./domain";

function normalizeLookupKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function isBlank(text: string | null | undefined): text is null | undefined | "" {
  return text === null || text === undefined || text.trim().length === 0;
}

/* -------------------------------------------------------------------------- */
/* Sport                                                                       */
/* -------------------------------------------------------------------------- */

// Only genuine sport-NAME aliases — never league names. "la liga"/"serie
// a"/etc. deliberately do NOT appear here: resolving a league string that
// happens to occupy a sport slot into FOOTBALL-plus-a-separately-resolved-
// league is an orchestration-level concern (a future Step 8B caller's
// job), not this single-field function's.
const SPORT_ALIASES: Readonly<Record<string, Sport>> = {
  football: "FOOTBALL",
  soccer: "FOOTBALL",
  футбол: "FOOTBALL",
  basketball: "BASKETBALL",
  баскетбол: "BASKETBALL",
  nba: "BASKETBALL",
  tennis: "TENNIS",
  теннис: "TENNIS",
  atp: "TENNIS",
  wta: "TENNIS",
  hockey: "ICE_HOCKEY",
  "ice hockey": "ICE_HOCKEY",
  хоккей: "ICE_HOCKEY",
  nhl: "ICE_HOCKEY",
  "american football": "AMERICAN_FOOTBALL",
  nfl: "AMERICAN_FOOTBALL",
};

// Mirrors docs/ODDS_SUPPORT_MATRIX.md Section 3's explicitly-deferred
// sport list — recognizable as a real sport, just not one this product
// supports today. Kept small and closed; not an attempt at an exhaustive
// sports taxonomy.
const DEFERRED_SPORTS: ReadonlySet<string> = new Set([
  "cricket",
  "rugby",
  "esports",
  "mma",
  "boxing",
  "volleyball",
  "baseball",
  "golf",
]);

export function normalizeDraftSport(rawText: string | null | undefined): BetDraftField<Sport> {
  if (isBlank(rawText)) return missingField();

  const trimmed = rawText.trim();
  const key = normalizeLookupKey(trimmed);

  const sport = SPORT_ALIASES[key];
  if (sport) return extractedField(sport, trimmed);

  if (DEFERRED_SPORTS.has(key)) return unsupportedField(trimmed);

  return unknownField(trimmed);
}

/* -------------------------------------------------------------------------- */
/* League                                                                      */
/* -------------------------------------------------------------------------- */

// Exactly the 7 keys approved and shipped in Step 7A's
// legacyOddsBridge.ts FOOTBALL_LEAGUE_NAMES table — deliberately not
// extended with "epl"/"england premier league" here: the Step 8 audit
// explicitly identified those as unresolved under current rules, and nothing
// in this step's approval reopens that decision.
const FOOTBALL_LEAGUE_ALIASES: Readonly<Record<string, string>> = {
  "premier league": "Premier League",
  "la liga": "La Liga",
  "serie a": "Serie A",
  bundesliga: "Bundesliga",
  "ligue 1": "Ligue 1",
  "champions league": "UEFA Champions League",
  "uefa champions league": "UEFA Champions League",
};

// A tiny, explicit, illustrative recognition set for tennis tournament
// names the system has NO representation for at all (TENNIS_SPORT_KEYS is
// a fixed 8-key Grand-Slam list, queried in full regardless of which
// tournament was named — oddsVerifier.ts). "ATP Rome" is the exact
// documented example; this is not, and is not intended to become, a
// comprehensive tournament database.
const UNSUPPORTED_TENNIS_TOURNAMENTS: ReadonlySet<string> = new Set(["atp rome"]);

// sport must be the ALREADY-normalized canonical Sport — league resolution
// rules differ per sport (only football has a real alias table today), so
// this function never re-derives sport from rawText itself.
export function normalizeDraftLeague(rawText: string | null | undefined, sport: Sport): BetDraftField<BetDraftLeague> {
  if (isBlank(rawText)) return missingField();

  const trimmed = rawText.trim();
  const key = normalizeLookupKey(trimmed);

  if (sport === "FOOTBALL") {
    const resolvedName = FOOTBALL_LEAGUE_ALIASES[key];
    if (resolvedName) {
      return extractedField<BetDraftLeague>({ rawText: trimmed, resolvedName }, trimmed);
    }
    // Recognizable as a league-shaped string but not in the closed alias
    // table (e.g. "EPL", "England Premier League") — preserved, never
    // guessed, never mapped to a provider identifier.
    return unknownField(trimmed);
  }

  if (sport === "TENNIS" && UNSUPPORTED_TENNIS_TOURNAMENTS.has(key)) {
    return unsupportedField(trimmed);
  }

  // NBA/NHL and any other non-football league text: preserved as raw text
  // only. Basketball/hockey each have exactly one supported league today,
  // so there is nothing to resolve against, and no deterministic rule for
  // doing so is documented or tested — per the task's explicit "do not
  // claim deterministic resolved league semantics unless the rule is
  // explicitly documented and tested."
  return unknownField(trimmed);
}

/* -------------------------------------------------------------------------- */
/* Event participants                                                         */
/* -------------------------------------------------------------------------- */

// Mirrors legacyOddsBridge.ts's own EVENT_SEPARATOR_REGEX exactly —
// whitespace-bounded only, so "Saint-Étienne" (internal hyphen, no
// surrounding whitespace) is never mistaken for a separator. Deliberately
// does NOT include "/" — the Step 8 audit's documented, still-open
// limitation for slash-delimited individual-sport notation ("Player A /
// Player B") is preserved as-is, not silently fixed here.
const EVENT_SEPARATOR_REGEX = /\s+(?:vs\.?|v\.?|-|–|—)\s+/i;

export function splitDraftEventParticipants(rawEventText: string): readonly BetDraftParticipant[] {
  const parts = rawEventText
    .split(EVENT_SEPARATOR_REGEX)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  // Exactly two non-empty sides -> two ordered participants. Anything else
  // (zero separators found, or more than one) -> empty: never fabricate a
  // single participant containing the whole event string, and never guess
  // which of 3+ candidate splits is correct.
  if (parts.length !== 2) return [];

  return [
    { index: 0, rawName: parts[0] },
    { index: 1, rawName: parts[1] },
  ];
}

/* -------------------------------------------------------------------------- */
/* Scheduled start time                                                       */
/* -------------------------------------------------------------------------- */

// Two accepted complete forms only — everything else (missing date,
// missing time, missing zone/offset, informal phrases like "Saturday
// 3pm") is UNKNOWN, never defaulted:
//
//  1. Local wall-clock date/time + a named IANA zone:
//     "2026-08-14 15:00 Europe/Zurich" (seconds optional)
//  2. Local wall-clock date/time + an explicit numeric UTC offset:
//     "2026-08-14T15:00:00+02:00" (seconds optional)
//
// Group indices are shared: 1=year 2=month 3=day 4=hour 5=minute
// 6=seconds(optional) 7=zone-name-or-offset.
const NAMED_ZONE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s+([A-Za-z_]+(?:\/[A-Za-z_]+)+)$/;
const NUMERIC_OFFSET_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{2}:\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Deterministic calendar-shape validation — rejects an impossible
// date/time (month 13, Feb 30, Feb 29 on a non-leap year, hour 25, minute
// 99, second 60...) rather than letting it silently become a JS Date's
// own auto-rolling-over interpretation. Never touches "today"/"now" or
// any environment-supplied clock.
function isValidCalendarDateTime(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  if (month < 1 || month > 12) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;
  if (day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

// Absent seconds default to "00" — unlike year/date/timezone (which this
// function never defaults, per its own header comment), omitting seconds
// from a time like "15:00" is a normal, unambiguous, universally-understood
// convention, not a genuine source of interpretive risk. Explicit non-zero
// seconds are always preserved exactly, never dropped.
function resolveSeconds(secondsGroup: string | undefined): string {
  return secondsGroup ?? "00";
}

// Syntax-only shape (Area/Location, one or more segments) is checked by
// the regex itself; this additionally verifies the identifier is a REAL
// recognized IANA zone, not merely shaped like one ("Foo/Bar" matches the
// regex but is not a real zone). Uses Intl.DateTimeFormat's own timeZone
// option — a deterministic, dependency-free mechanism this codebase
// already relies on elsewhere for the exact same purpose
// (app/api/dashboard/players/route.ts, components/players/PlayerCard.tsx)
// — rather than introducing any new timezone-database dependency. This is
// genuine zone-IDENTITY verification, not just syntax validation — see
// this function's own tests for both a syntactically-plausible-but-fake
// zone (rejected) and a real one (accepted).
function isRecognizedIanaZone(candidate: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

export function normalizeScheduledStartTime(rawText: string | null | undefined): BetDraftField<string> {
  if (isBlank(rawText)) return missingField();

  const trimmed = rawText.trim();

  const namedZoneMatch = NAMED_ZONE_PATTERN.exec(trimmed);
  if (namedZoneMatch) {
    const [, year, month, day, hour, minute, secondsGroup, zone] = namedZoneMatch;
    const seconds = resolveSeconds(secondsGroup);

    if (!isValidCalendarDateTime(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(seconds))) {
      return unknownField(trimmed);
    }
    if (!isRecognizedIanaZone(zone)) {
      return unknownField(trimmed);
    }

    // Bracketed IANA-zone notation — the same convention java.time's
    // ZonedDateTime.toString() and the TC39 Temporal proposal use.
    // Preserves the wall-clock time AND the zone exactly as given,
    // without fabricating a UTC offset: correctly resolving what offset
    // "Europe/Zurich" means on this specific date (DST rules) requires
    // real timezone-database arithmetic, which this step does not
    // introduce — so this value is honest about being a local time in a
    // named zone, never claiming to be a resolved UTC instant (no "Z", no
    // fabricated "+00:00").
    return extractedField(`${year}-${month}-${day}T${hour}:${minute}:${seconds}[${zone}]`, trimmed);
  }

  const numericOffsetMatch = NUMERIC_OFFSET_PATTERN.exec(trimmed);
  if (numericOffsetMatch) {
    const [, year, month, day, hour, minute, secondsGroup, offset] = numericOffsetMatch;
    const seconds = resolveSeconds(secondsGroup);

    if (!isValidCalendarDateTime(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(seconds))) {
      return unknownField(trimmed);
    }

    // A numeric offset needs no timezone database to interpret — it is
    // already a complete, unambiguous ISO-8601 instant, safe to return
    // as-is.
    return extractedField(`${year}-${month}-${day}T${hour}:${minute}:${seconds}${offset}`, trimmed);
  }

  // Missing date, missing time, missing zone/offset, or an informal
  // phrase ("Saturday 3pm", "14 August 3pm") — never guessed, never
  // defaulted. rawText is still preserved on the field wrapper.
  return unknownField(trimmed);
}

/* -------------------------------------------------------------------------- */
/* Market                                                                      */
/* -------------------------------------------------------------------------- */

const MVP_MARKET_ALIASES: Readonly<Record<string, MarketType>> = {
  "1x2": "MONEYLINE_3WAY",
  "match winner": "MONEYLINE_2WAY",
  moneyline: "MONEYLINE_2WAY",
  winner: "MONEYLINE_2WAY",
  "to win": "MONEYLINE_2WAY",
  "double chance": "DOUBLE_CHANCE",
  totals: "TOTALS",
  total: "TOTALS",
  "over/under": "TOTALS",
  handicap: "SPREAD",
  spread: "SPREAD",
  "both teams to score": "BOTH_TEAMS_TO_SCORE",
  btts: "BOTH_TEAMS_TO_SCORE",
};

// Named/recognizable, but explicitly deferred by docs/ODDS_SUPPORT_MATRIX.md
// — resolves to its real canonical MarketType enum value, but with state
// UNSUPPORTED, never EXTRACTED, so nothing downstream can mistake it for
// something actionable.
const DEFERRED_MARKET_ALIASES: Readonly<Record<string, MarketType>> = {
  "player prop": "PLAYER_PROP",
  "team total": "TEAM_TOTAL",
  "correct score": "EXACT_SCORE",
  "exact score": "EXACT_SCORE",
  "draw no bet": "DRAW_NO_BET",
  outright: "OUTRIGHT",
  futures: "OUTRIGHT",
};

export function normalizeDraftMarket(rawText: string | null | undefined): BetDraftField<MarketType> {
  if (isBlank(rawText)) return missingField();

  const trimmed = rawText.trim();
  const key = normalizeLookupKey(trimmed);

  const mvpMarket = MVP_MARKET_ALIASES[key];
  if (mvpMarket) return extractedField(mvpMarket, trimmed);

  const deferredMarket = DEFERRED_MARKET_ALIASES[key];
  if (deferredMarket) return unsupportedField(trimmed);

  return unknownField(trimmed);
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

// Same closed token sets already proven in legacyOddsBridge.ts (mirrored,
// not imported — see this file's header comment), plus the additional
// YES/NO/OVER/UNDER/double-chance tokens this step's richer market model
// now needs.
const HOME_TOKENS: ReadonlySet<string> = new Set(["1", "п1", "p1", "home"]);
const DRAW_TOKENS: ReadonlySet<string> = new Set(["x", "х", "draw", "ничья"]);
const AWAY_TOKENS: ReadonlySet<string> = new Set(["2", "п2", "p2", "away"]);
const YES_TOKENS: ReadonlySet<string> = new Set(["yes", "да"]);
const NO_TOKENS: ReadonlySet<string> = new Set(["no", "нет"]);
const OVER_TOKENS: ReadonlySet<string> = new Set(["over"]);
const UNDER_TOKENS: ReadonlySet<string> = new Set(["under"]);
const HOME_OR_DRAW_TOKENS: ReadonlySet<string> = new Set(["1x", "1х"]);
const DRAW_OR_AWAY_TOKENS: ReadonlySet<string> = new Set(["x2", "х2"]);
const HOME_OR_AWAY_TOKENS: ReadonlySet<string> = new Set(["12"]);

// Only these two markets structurally permit a PARTICIPANT-style
// team-name/free-text selection (mirrors lib/odds/domain.ts's own
// validateCanonicalSelection rules for MONEYLINE_2WAY/3WAY). Any other
// market (or no market at all) never gets the PARTICIPANT fallback — see
// this function's own "does not appear actionable" reasoning below.
const PARTICIPANT_ELIGIBLE_MARKETS: ReadonlySet<MarketType> = new Set(["MONEYLINE_2WAY", "MONEYLINE_3WAY"]);

export interface DraftSelectionClassification {
  readonly selectionType: BetDraftField<SelectionType>;
  readonly participant: BetDraftParticipantRef | null;
}

export function normalizeDraftSelection(
  rawText: string,
  marketType: MarketType | undefined,
  participants: readonly BetDraftParticipant[],
): DraftSelectionClassification {
  const trimmed = rawText.trim();
  const key = normalizeLookupKey(trimmed);

  if (HOME_TOKENS.has(key)) return { selectionType: extractedField("HOME", trimmed), participant: null };
  if (DRAW_TOKENS.has(key)) return { selectionType: extractedField("DRAW", trimmed), participant: null };
  if (AWAY_TOKENS.has(key)) return { selectionType: extractedField("AWAY", trimmed), participant: null };
  if (YES_TOKENS.has(key)) return { selectionType: extractedField("YES", trimmed), participant: null };
  if (NO_TOKENS.has(key)) return { selectionType: extractedField("NO", trimmed), participant: null };
  if (OVER_TOKENS.has(key)) return { selectionType: extractedField("OVER", trimmed), participant: null };
  if (UNDER_TOKENS.has(key)) return { selectionType: extractedField("UNDER", trimmed), participant: null };
  if (HOME_OR_DRAW_TOKENS.has(key)) return { selectionType: extractedField("HOME_OR_DRAW", trimmed), participant: null };
  if (DRAW_OR_AWAY_TOKENS.has(key)) return { selectionType: extractedField("DRAW_OR_AWAY", trimmed), participant: null };
  if (HOME_OR_AWAY_TOKENS.has(key)) return { selectionType: extractedField("HOME_OR_AWAY", trimmed), participant: null };

  // Not an exact closed token. Only attempt PARTICIPANT classification
  // when the market is one this system can actually act on — an
  // unsupported or unrecognized market's free-text selection ("Ronaldo to
  // score anytime" under PLAYER_PROP) must never be force-fit into
  // PARTICIPANT semantics, which would misleadingly imply "Ronaldo" is a
  // competing event participant.
  if (marketType && PARTICIPANT_ELIGIBLE_MARKETS.has(marketType)) {
    const exactIndex = participants.findIndex((participant) => normalizeLookupKey(participant.rawName) === key);
    const participantRef: BetDraftParticipantRef =
      exactIndex !== -1 ? { kind: "INDEX", participantIndex: exactIndex } : { kind: "RAW_TEXT", rawName: trimmed };
    return { selectionType: extractedField("PARTICIPANT", trimmed), participant: participantRef };
  }

  return { selectionType: unknownField(trimmed), participant: null };
}

/* -------------------------------------------------------------------------- */
/* Period                                                                      */
/* -------------------------------------------------------------------------- */

const PERIOD_ALIASES: Readonly<Record<string, Period>> = {
  "full game": "FULL_GAME",
  "full match": "FULL_GAME",
  "full time": "FULL_GAME",
  regulation: "REGULATION",
  "first half": "FIRST_HALF",
  "1st half": "FIRST_HALF",
  "second half": "SECOND_HALF",
  "2nd half": "SECOND_HALF",
  "first quarter": "FIRST_QUARTER",
  "1st quarter": "FIRST_QUARTER",
  match: "MATCH",
  set: "SET",
};

// Absence is MISSING, never defaulted to FULL_GAME — a future legacy
// adapter may choose to omit the field entirely (ParsedBetSlip has no
// period slot), but the draft itself must never silently assert a period
// that was never actually present in the source.
export function normalizeDraftPeriod(rawText: string | null | undefined): BetDraftField<Period> {
  if (isBlank(rawText)) return missingField();

  const trimmed = rawText.trim();
  const key = normalizeLookupKey(trimmed);

  const period = PERIOD_ALIASES[key];
  if (period) return extractedField(period, trimmed);

  return unknownField(trimmed);
}

/* -------------------------------------------------------------------------- */
/* Decimal values                                                             */
/* -------------------------------------------------------------------------- */

// Returns a signed-or-unsigned canonical decimal string, or null when the
// input cannot be safely represented as one. Never rounds, never touches
// digit content beyond sign/separator normalization, never returns
// "NaN"/"Infinity" as a string.
export function normalizeDecimalString(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return null;

  // Reject more than one decimal separator BEFORE attempting comma->dot
  // substitution — "1.234.5" or "1,234,5" must never silently become a
  // plausible-looking number.
  const separatorCount = (trimmed.match(/[.,]/g) ?? []).length;
  if (separatorCount > 1) return null;

  // Comma is treated as a decimal separator, never a thousands separator
  // — betting lines/odds/stakes in this codebase are never in the
  // thousands (lib/ai/betParser.ts's own MAX_DECIMAL_ODDS=1000 ceiling
  // reflects the same assumption), so no ambiguity exists in practice.
  const dotted = trimmed.replace(",", ".");

  // Strict decimal shape only: optional leading sign, digits, optional
  // .digits — no exponents, no internal whitespace, no thousands
  // separators of any kind.
  if (!/^[+-]?\d+(\.\d+)?$/.test(dotted)) return null;

  const parsed = Number(dotted);
  if (!Number.isFinite(parsed)) return null; // guards NaN and +/-Infinity

  // Canonical form: a redundant leading "+" is stripped (a plain unsigned
  // string already means positive); "-" is preserved.
  return dotted.startsWith("+") ? dotted.slice(1) : dotted;
}

/* -------------------------------------------------------------------------- */
/* Line                                                                        */
/* -------------------------------------------------------------------------- */

const OVER_PREFIX = /^over\b\s*/i;
const UNDER_PREFIX = /^under\b\s*/i;

export function normalizeDraftLine(rawText: string | null | undefined): BetDraftField<BetDraftLine> {
  if (isBlank(rawText)) return missingField();

  const trimmed = rawText.trim();
  const isOver = OVER_PREFIX.test(trimmed);
  const isUnder = UNDER_PREFIX.test(trimmed);
  const numericPart = trimmed.replace(OVER_PREFIX, "").replace(UNDER_PREFIX, "").trim();

  if (numericPart.length === 0) return unknownField(trimmed);

  const hasExplicitPlus = numericPart.startsWith("+");
  const decimal = normalizeDecimalString(numericPart);
  if (decimal === null) return unknownField(trimmed);

  const isNegative = decimal.startsWith("-");
  const magnitude = isNegative ? decimal.slice(1) : decimal;

  let direction: BetDraftLine["direction"];
  if (isOver) direction = "OVER";
  else if (isUnder) direction = "UNDER";
  else if (isNegative) direction = "MINUS";
  else if (hasExplicitPlus) direction = "PLUS";
  else direction = "NONE";

  const line: BetDraftLine = { rawText: numericPart, magnitude, direction };
  return extractedField(line, trimmed);
}
