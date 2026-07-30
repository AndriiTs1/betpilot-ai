// Event Discovery Engine — Stage 4. Typed adapter over The Odds API v4
// events endpoint, scoped to ONE already-supported competition:
//
//   GET /v4/sports/{sportKey}/events/?apiKey=...
//
// Same separation of concerns as scoresAdapter.ts/sportsCatalogAdapter.ts:
// perform the HTTP request, validate the raw response, translate it into
// this project's existing provider-neutral shapes — no caching, no
// cross-competition orchestration, no team-name matching. That is
// deliberately out of scope for this file (Event Catalog / Team Index /
// Candidate Resolver are separate, later stages).
//
// Contract-fit note (checked before writing this file, per this stage's
// own instruction to report friction rather than silently work around
// it): ProviderEventCandidate (lib/odds/oddsProvider.ts) is a reasonable,
// not-perfect fit. Its `confidence`/`matchMetadata` fields exist for a
// SCORED search result (Section 7/9 of docs/ODDS_PROVIDER_DESIGN.md) —
// this adapter produces unscored catalog entries (every event a
// competition currently has, not a match against a query), so both fields
// are simply left undefined here. This is a semantic stretch, not a
// blocker: the type still represents the data honestly (a CanonicalEvent +
// a ProviderEventReference), and a future Candidate Resolver is the natural
// place to actually populate `confidence` once it scores these against a
// player's free-text input. No new type was introduced for this — the
// existing one already covers it.
//
// This endpoint never returns odds/markets/selections (confirmed by The
// Odds API's own documentation) — nothing below has a slot for them, and
// this file never calls /odds.
//
// Never imports lib/odds/footballLeagues.ts — sport_key -> Sport/league
// display name resolution here uses lib/odds/discovery/supportedCompetitions.ts's
// own SUPPORTED_COMPETITIONS table exclusively (the same table this
// adapter's allowlist gate already reads), per this stage's explicit
// instruction not to introduce a second, parallel sport_key/league lookup.

import { z } from "zod";
import type { CanonicalEvent, CanonicalParticipant } from "@/lib/odds/domain";
import type { ProviderEventCandidate, ProviderEventReference } from "@/lib/odds/oddsProvider";
import { SUPPORTED_COMPETITIONS, isSupportedSportKey, type SupportedCompetition } from "@/lib/odds/discovery/supportedCompetitions";

const EVENTS_API_BASE_URL = "https://api.the-odds-api.com/v4";

// Same timeout value as every other adapter in this codebase
// (oddsVerifier.ts's ODDS_API_TIMEOUT_MS, scoresAdapter.ts,
// sportsCatalogAdapter.ts) — no evidence this endpoint needs a different
// ceiling. Configurable per this stage's explicit requirement (tests need
// to exercise a short timeout deterministically; production never
// overrides it).
const DEFAULT_EVENTS_TIMEOUT_MS = 8000;

/* -------------------------------------------------------------------------- */
/* Raw provider response validation                                          */
/* -------------------------------------------------------------------------- */

// Zod validates shape/type only (this repo's existing convention — see
// scoresAdapter.ts's providerScoresEventSchema) — the two business rules
// this stage also requires (sport_key matches what we asked for; home_team
// and away_team are not the same team after basic normalization) are NOT
// shape concerns and are checked separately, in mapProviderEvent below.
const providerEventEntrySchema = z.object({
  id: z.string().min(1),
  sport_key: z.string().min(1),
  sport_title: z.string().min(1),
  commence_time: z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: "invalid commence_time" }),
  home_team: z.string().min(1),
  away_team: z.string().min(1),
});

// Loose top-level shape check, same reasoning as every other adapter in
// this codebase: each element is validated individually below so one
// malformed entry can be isolated and skipped without invalidating an
// otherwise-valid batch.
const rawResponseShapeSchema = z.array(z.record(z.string(), z.unknown()));

/* -------------------------------------------------------------------------- */
/* Provider event -> existing provider-neutral shape                         */
/* -------------------------------------------------------------------------- */

// Deliberately NOT a fuzzy/normalized comparison (lib/odds/teamNameMatcher.ts
// is explicitly out of scope for this stage — "не придумывай сложную
// бизнес-логику матчинга команд"). Only trim + lowercase, enough to catch
// an exact-duplicate-after-whitespace/case data-quality problem, nothing
// more.
function isSameTeamAfterBasicNormalization(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Returns null for any event this adapter cannot honestly map — the caller
// (fetchProviderEvents below) treats a null as "reject this one event,
// keep the rest," never as a reason to fail the whole batch (mirrors
// scoresAdapter.ts's own mapProviderEvent contract exactly).
function mapProviderEvent(
  raw: z.infer<typeof providerEventEntrySchema>,
  requestedSportKey: string,
  competition: SupportedCompetition,
): ProviderEventCandidate | null {
  // Defensive integrity check, same convention as scoresAdapter.ts:233-235
  // — an event whose own sport_key doesn't match what we asked for is not
  // honestly usable, even if every other field is well-formed.
  if (raw.sport_key !== requestedSportKey) return null;

  if (isSameTeamAfterBasicNormalization(raw.home_team, raw.away_team)) return null;

  const participants: readonly CanonicalParticipant[] = [{ name: raw.home_team }, { name: raw.away_team }];

  const event: CanonicalEvent = {
    sport: competition.sport,
    league: { name: competition.displayName },
    name: `${raw.home_team} vs ${raw.away_team}`,
    participants,
    startTime: raw.commence_time,
    // No market/selection context exists at this stage (this endpoint
    // never returns one) — FULL_GAME is the same default
    // legacyOddsBridge.ts's own legacyEventToCanonical already uses for
    // exactly this "no period stated yet" case, not a new convention.
    period: "FULL_GAME",
    homeParticipantIndex: 0,
    awayParticipantIndex: 1,
  };

  const reference: ProviderEventReference = {
    provider: "THE_ODDS_API",
    eventId: raw.id,
    sportKey: raw.sport_key,
  };

  return { event, reference };
}

/* -------------------------------------------------------------------------- */
/* Result contract                                                            */
/* -------------------------------------------------------------------------- */

export type EventsFetchFailureReason =
  | "MISSING_API_KEY"
  | "UNSUPPORTED_SPORT_KEY"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "HTTP_UNAUTHORIZED"
  | "HTTP_RATE_LIMITED"
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "INVALID_RESPONSE"
  | "NO_VALID_EVENTS";

export type EventsFetchResult =
  | { readonly status: "SUCCESS"; readonly results: readonly ProviderEventCandidate[]; readonly rejectedEntries: number }
  | { readonly status: "FAILED"; readonly reason: EventsFetchFailureReason };

export interface FetchProviderEventsInput {
  readonly sportKey: string;
  readonly timeoutMs?: number;
}

function classifyHttpStatus(status: number): EventsFetchFailureReason {
  if (status === 401) return "HTTP_UNAUTHORIZED";
  if (status === 429) return "HTTP_RATE_LIMITED";
  return "HTTP_ERROR";
}

// Never throws — every expected failure resolves to a typed FAILED result,
// matching this codebase's established adapter convention. Never calls
// /odds (paid) — this function's only network target is /events (free).
export async function fetchProviderEvents(input: FetchProviderEventsInput): Promise<EventsFetchResult> {
  const { sportKey } = input;

  // Cheapest possible check first, and independent of configuration state
  // — a request for a competition we don't support can never succeed
  // regardless of API key validity, so it's rejected before that check
  // even runs, per this stage's explicit "no network call for an
  // unsupported sportKey" requirement.
  const competition = SUPPORTED_COMPETITIONS.find((c) => c.sportKey === sportKey);
  if (!isSupportedSportKey(sportKey) || !competition) {
    return { status: "FAILED", reason: "UNSUPPORTED_SPORT_KEY" };
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return { status: "FAILED", reason: "MISSING_API_KEY" };
  }

  // encodeURIComponent guards against a sportKey containing characters
  // that would otherwise corrupt the path segment — defense-in-depth only
  // in practice (every real sportKey is already a plain lowercase
  // snake_case token, and isSupportedSportKey above already rejects
  // anything not in our own closed allowlist), never trust-by-convention.
  const url = new URL(`${EVENTS_API_BASE_URL}/sports/${encodeURIComponent(sportKey)}/events/`);
  url.searchParams.set("apiKey", apiKey);

  const timeoutMs = input.timeoutMs ?? DEFAULT_EVENTS_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "FAILED", reason: "TIMEOUT" };
    }
    // Never the caught error's own message (could embed a URL/host/detail)
    // — only the typed reason crosses this boundary.
    return { status: "FAILED", reason: "NETWORK_ERROR" };
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

  const results: ProviderEventCandidate[] = [];
  let rejectedEntries = 0;

  for (const rawEntry of shapeResult.data) {
    const parsed = providerEventEntrySchema.safeParse(rawEntry);
    if (!parsed.success) {
      rejectedEntries += 1;
      continue;
    }

    const mapped = mapProviderEvent(parsed.data, sportKey, competition);
    if (!mapped) {
      rejectedEntries += 1;
      continue;
    }

    results.push(mapped);
  }

  // Distinguishes "the provider genuinely has nothing scheduled right now"
  // (an empty raw array — a normal, valid state, e.g. off-season) from
  // "the provider sent us entries but none of them were usable" (a real
  // data-quality signal worth surfacing distinctly, not silently folded
  // into an empty-looking success).
  if (shapeResult.data.length > 0 && results.length === 0) {
    return { status: "FAILED", reason: "NO_VALID_EVENTS" };
  }

  return { status: "SUCCESS", results, rejectedEntries };
}
