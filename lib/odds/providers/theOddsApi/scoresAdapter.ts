// Stage 3.5A — typed adapter over The Odds API v4 scores endpoint:
//
//   GET /v4/sports/{sportKey}/scores/?apiKey=...&daysFrom=3&dateFormat=iso&eventIds=id1,id2,...
//
// This file's only job is: perform the HTTP request, validate the raw
// response, and translate it into { providerEventId, eventResult } pairs
// (eventResult being an honest lib/bets/settlement/eventResultDomain.ts
// CanonicalEventResult). It does NOT know about Bet/BetSelection, does not
// touch the database, does not call any settlement service, does not
// decide WIN/LOSS, and does not implement retry (Stage 3.6's job) — same
// separation of concerns lib/odds/oddsVerifier.ts already establishes for
// the /odds endpoint, extended here for /scores.
//
// Test convention: same global-fetch-replacement technique
// lib/odds/oddsVerifier.test.ts already uses (module-level indirection via
// a mutable handler) — no fetchFn parameter is added here, matching that
// existing pattern rather than inventing a second DI style for the same
// kind of HTTP call.

import { z } from "zod";
import type { CanonicalEventResult, EventResultStatus } from "@/lib/bets/settlement/eventResultDomain";

const SCORES_API_BASE_URL = "https://api.the-odds-api.com/v4";

// Same timeout value and AbortController+finally pattern as
// lib/odds/oddsVerifier.ts's ODDS_API_TIMEOUT_MS — no evidence either
// endpoint needs a different ceiling, so no new number is invented.
const SCORES_API_TIMEOUT_MS = 8000;

// The Odds API's own documented scores-endpoint parameter (confirmed by
// the task's provider-contract brief, not re-derived here) — how many days
// back a completed event can still be queried. This is a PROVIDER fact
// baked into the URL; lib/bets/settlement/pollConfirmedBetResults.ts has
// its own, separately-named lookback constant for a different
// concern (our own polling-eligibility window) that happens to share this
// value today — the two are not the same constant and are not wired
// together, so one changing independently of the other can't silently
// break anything.
const SCORES_DAYS_FROM = 3;

/* -------------------------------------------------------------------------- */
/* Raw provider response validation                                          */
/* -------------------------------------------------------------------------- */

// Zod validates shape/type only, matching this repo's existing convention
// (lib/ai/betParser.ts's betFieldsSchema, lib/ocr/regionDetection.ts's
// regionDetectionResultSchema) — business rules (score parsing, home/away
// resolution) are a separate, dedicated step below, not folded into the
// schema.
const providerScoreEntrySchema = z.object({
  name: z.string(),
  score: z.string(),
});

const providerScoresEventSchema = z.object({
  id: z.string().min(1),
  sport_key: z.string().min(1),
  sport_title: z.string(),
  // Validated for shape-trustworthiness only — CanonicalEventResult has no
  // startTime field at all (Stage 3.2's deliberately minimal domain), so
  // this value is never read past validation. An event whose commence_time
  // doesn't even parse as a date is treated as a malformed event overall
  // (rejected, not partially trusted) rather than silently ignoring just
  // this one field.
  commence_time: z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: "invalid commence_time" }),
  completed: z.boolean(),
  home_team: z.string().min(1),
  away_team: z.string().min(1),
  scores: z.array(providerScoreEntrySchema).nullable(),
  last_update: z.string().optional(),
});

// The top-level shape check is deliberately loose (any array of objects) —
// each element is validated individually below so one malformed event can
// be isolated and skipped without invalidating an otherwise-valid batch.
// z.array(providerScoresEventSchema).safeParse() on the whole array would
// fail the ENTIRE parse the moment any single element is malformed, which
// is exactly the all-or-nothing behavior this stage must avoid.
const rawResponseShapeSchema = z.array(z.record(z.string(), z.unknown()));

/* -------------------------------------------------------------------------- */
/* Score resolution (provider array -> home/away integers)                    */
/* -------------------------------------------------------------------------- */

// Only a bare, non-negative integer string is accepted — no leading "+",
// no decimal point, no whitespace, no sign, no leading zeros beyond a bare
// "0". Deliberately not parseInt() (which tolerates "12abc" -> 12,
// leading/trailing whitespace, and other silently-lossy coercions) — a
// provider score is trusted only if the ENTIRE string matches this shape.
const NON_NEGATIVE_INTEGER_STRING = /^(0|[1-9]\d*)$/;

function parseIntegerScore(raw: string): number | null {
  if (!NON_NEGATIVE_INTEGER_STRING.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  return value;
}

interface ScoreEntry {
  readonly name: string;
  readonly score: string;
}

// Resolves exactly one side's score by EXACT team-name match — never by
// array position/order (the task's own explicit "нельзя полагаться на
// порядок массива"). A team name matched zero times (missing) or more than
// once (duplicate entry) is treated identically to an unparseable score:
// this side cannot be honestly resolved, so the whole event is rejected
// rather than guessed. Entries matching neither home_team nor away_team
// are simply never looked at here — they cannot create ambiguity for THIS
// side's resolution, since matching is by exact name, not position.
function resolveSideScore(scores: readonly ScoreEntry[], teamName: string): number | null {
  const matches = scores.filter((entry) => entry.name === teamName);
  if (matches.length !== 1) return null; // 0 = missing, >1 = duplicate entry
  return parseIntegerScore(matches[0].score);
}

/* -------------------------------------------------------------------------- */
/* Provider event -> CanonicalEventResult                                     */
/* -------------------------------------------------------------------------- */

interface MappedEvent {
  readonly providerEventId: string;
  readonly eventResult: CanonicalEventResult;
}

// Returns null for any event this adapter cannot honestly map — the caller
// (fetchProviderScores below) treats a null as "reject this one event,
// keep the rest," never as a reason to fail the whole batch.
//
// Status mapping (Stage 3.5A's confirmed, non-speculative rule set — see
// this file's own header and the Stage 3.5 audit): the /scores endpoint
// only ever tells us completed (boolean) and scores (present or not).
// CANCELLED/POSTPONED/ABANDONED are never inferred from this response —
// eventResultDomain.ts's UNKNOWN is deliberately NOT used for "event
// hasn't happened yet" either (UNKNOWN means "we don't even know if this
// will ever resolve," which is dishonest for a simple not-yet-started
// event that this endpoint describes just fine as NOT_STARTED/IN_PROGRESS).
//
//   completed=true  + both scores resolve       -> COMPLETED, real scores
//   completed=true  + scores missing/malformed  -> COMPLETED, null scores
//                                                   (matches
//                                                   evaluateSelectionOutcome()'s
//                                                   own existing, already-tested
//                                                   MISSING_SCORE/INVALID_DATA
//                                                   rule for exactly this case —
//                                                   no new adapter-level
//                                                   "invalid" branch needed)
//   completed=false + both scores resolve       -> IN_PROGRESS, but
//                                                   homeScore/awayScore are
//                                                   still set to null: per
//                                                   eventResultDomain.ts's own
//                                                   documented invariant,
//                                                   scores are "only
//                                                   meaningful when status
//                                                   === COMPLETED" and
//                                                   evaluateSelectionOutcome()
//                                                   never reads them for any
//                                                   other status — populating
//                                                   them here would imply a
//                                                   meaning nothing downstream
//                                                   honors
//   completed=false + scores absent/null        -> NOT_STARTED, null scores
function mapProviderEvent(raw: z.infer<typeof providerScoresEventSchema>): MappedEvent | null {
  let status: EventResultStatus;
  let homeScore: number | null = null;
  let awayScore: number | null = null;

  if (raw.completed) {
    status = "COMPLETED";
    if (raw.scores !== null) {
      const home = resolveSideScore(raw.scores, raw.home_team);
      const away = resolveSideScore(raw.scores, raw.away_team);
      // Only trust the pair if BOTH sides resolved — a half-resolved
      // pair (e.g. home found, away duplicated) is not partially honest,
      // it's just as untrustworthy as neither resolving.
      if (home !== null && away !== null) {
        homeScore = home;
        awayScore = away;
      }
    }
    // scores === null or unresolved -> homeScore/awayScore stay null;
    // COMPLETED + null scores is a legitimate, honestly-representable
    // CanonicalEventResult (see this function's own header comment).
  } else {
    status = raw.scores !== null && raw.scores.length > 0 ? "IN_PROGRESS" : "NOT_STARTED";
    // homeScore/awayScore intentionally left null regardless — see header.
  }

  return {
    providerEventId: raw.id,
    eventResult: {
      status,
      homeParticipant: { name: raw.home_team },
      awayParticipant: { name: raw.away_team },
      homeScore,
      awayScore,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Result contract                                                            */
/* -------------------------------------------------------------------------- */

export type ScoresFetchFailureReason =
  | "MISSING_API_KEY"
  | "TIMEOUT"
  | "HTTP_401"
  | "HTTP_429"
  | "HTTP_5XX"
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "INVALID_RESPONSE";

export type ScoresFetchResult =
  | { readonly status: "SUCCESS"; readonly results: readonly MappedEvent[]; readonly rejectedEvents: number }
  | { readonly status: "FAILED"; readonly reason: ScoresFetchFailureReason };

export interface FetchProviderScoresInput {
  readonly providerSportKey: string;
  // Caller's responsibility to have already deduplicated/bounded this list
  // (lib/bets/settlement/pollingEventKey.ts's own job) — this function
  // does not re-chunk or re-deduplicate; it sends exactly what it's given
  // as one request.
  readonly providerEventIds: readonly string[];
}

function classifyHttpStatus(status: number): ScoresFetchFailureReason {
  if (status === 401) return "HTTP_401";
  if (status === 429) return "HTTP_429";
  if (status >= 500) return "HTTP_5XX";
  return "HTTP_ERROR";
}

// Never throws — every expected failure (missing key, timeout, non-2xx,
// malformed JSON, malformed top-level shape) resolves to a typed FAILED
// result, matching lib/odds/theOddsApiProvider.ts's own "never throw for
// an expected outcome" convention. An unexpected exception (a genuine bug,
// not a provider/network condition) is allowed to propagate — swallowing
// it here would hide a real defect from the caller.
export async function fetchProviderScores(input: FetchProviderScoresInput): Promise<ScoresFetchResult> {
  const { providerSportKey, providerEventIds } = input;

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return { status: "FAILED", reason: "MISSING_API_KEY" };
  }

  const url = new URL(`${SCORES_API_BASE_URL}/sports/${providerSportKey}/scores/`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("daysFrom", String(SCORES_DAYS_FROM));
  url.searchParams.set("dateFormat", "iso");
  url.searchParams.set("eventIds", providerEventIds.join(","));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCORES_API_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    // AbortError from our own timeout vs. any other network failure —
    // distinguished so a future retry layer (Stage 3.6) can treat them
    // differently; both are expected, typed outcomes here, never thrown.
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "FAILED", reason: "TIMEOUT" };
    }
    return { status: "FAILED", reason: "HTTP_ERROR" };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return { status: "FAILED", reason: classifyHttpStatus(response.status) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "FAILED", reason: "INVALID_JSON" };
  }

  const shapeResult = rawResponseShapeSchema.safeParse(body);
  if (!shapeResult.success) {
    return { status: "FAILED", reason: "INVALID_RESPONSE" };
  }

  const results: MappedEvent[] = [];
  let rejectedEvents = 0;

  for (const rawEvent of shapeResult.data) {
    const eventResult = providerScoresEventSchema.safeParse(rawEvent);
    if (!eventResult.success) {
      rejectedEvents += 1;
      continue;
    }
    // Defensive integrity check: an event whose own sport_key doesn't
    // match what we asked for is not honestly usable, even if every other
    // field is well-formed — never silently accepted under the requested
    // key.
    if (eventResult.data.sport_key !== providerSportKey) {
      rejectedEvents += 1;
      continue;
    }

    const mapped = mapProviderEvent(eventResult.data);
    if (!mapped) {
      rejectedEvents += 1;
      continue;
    }
    results.push(mapped);
  }

  return { status: "SUCCESS", results, rejectedEvents };
}
