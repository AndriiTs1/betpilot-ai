// Stage 10 — typed adapter over the Sportmonks Football API v3 fixtures
// endpoints, scoped to BetPilot's supported league_id allowlist
// (supportedSportmonksLeagues.ts). Same split as
// lib/odds/providers/theOddsApi/eventsAdapter.ts: this file only does I/O
// + shape validation + translation; no team-name matching, no caching, no
// odds. Confirmed live field names (Stage 9.4.1-9.4.5): id, name,
// league_id, starting_at ("YYYY-MM-DD HH:mm:ss" UTC, no "Z"), state_id,
// participants[].{id,name,meta.location}, league.{id,name}, stage.{name}.
//
// Only ever produces FUTURE, not-yet-started fixtures — state_id === 1
// (empirically confirmed live as the "scheduled, not started" state; 2 was
// observed for fixtures that had already kicked off) AND
// starting_at > now, both enforced together, never one alone. Never logs
// or returns SPORTMONKS_API_TOKEN.

import { z } from "zod";
import type { ProviderEventCandidate } from "@/lib/odds/oddsProvider";
import { getSupportedSportmonksLeagueIds, isSupportedSportmonksLeagueId } from "@/lib/odds/discovery/supportedSportmonksLeagues";

const SPORTMONKS_BASE_URL = "https://api.sportmonks.com/v3";
const DEFAULT_TIMEOUT_MS = 8000;
// Empirically the qualification-round window Stage 9.4 needed; kept modest
// (not the API's 100-day max) so a normal fetch stays a single reasonably
// small response.
const DEFAULT_WINDOW_DAYS = 45;
// Sportmonks documents starting_at as UTC but returns it without "Z" and
// with a space instead of "T" (e.g. "2026-08-14 19:00:00") — every reader
// of this field in this codebase must go through this one function so a
// second, differently-behaving parser can never silently drift from it.
const NOT_STARTED_STATE_ID = 1;

export function parseSportmonksUtcTimestamp(raw: string): number {
  const iso = raw.replace(" ", "T") + (raw.endsWith("Z") ? "" : "Z");
  return Date.parse(iso);
}

export interface SportmonksFixture {
  readonly provider: "SPORTMONKS";
  readonly providerEventId: string;
  readonly sport: "FOOTBALL";
  readonly leagueId: number;
  readonly leagueName: string | null;
  readonly stageName: string | null;
  readonly homeTeamId: string | null;
  readonly homeTeamName: string;
  readonly awayTeamId: string | null;
  readonly awayTeamName: string;
  // ISO 8601 UTC — matches every other DateTime-as-string boundary in this
  // codebase (CanonicalEvent.startTime), converted here from Sportmonks'
  // own space-separated raw format.
  readonly commenceTime: string;
  readonly stateId: number;
}

export type SportmonksFixturesFetchFailureReason =
  | "MISSING_API_TOKEN"
  | "TIMEOUT"
  | "HTTP_UNAUTHORIZED"
  | "HTTP_FORBIDDEN"
  | "HTTP_RATE_LIMITED"
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "INVALID_RESPONSE";

export type SportmonksFixturesFetchResult =
  | { readonly status: "SUCCESS"; readonly results: readonly SportmonksFixture[]; readonly rejectedEntries: number }
  | { readonly status: "FAILED"; readonly reason: SportmonksFixturesFetchFailureReason };

export type SportmonksFixtureByIdResult =
  | { readonly status: "SUCCESS"; readonly fixture: SportmonksFixture }
  | { readonly status: "NOT_FOUND" }
  | { readonly status: "FAILED"; readonly reason: SportmonksFixturesFetchFailureReason };

const participantSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  meta: z.object({ location: z.string().optional() }).optional(),
});

const rawFixtureSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().optional(),
  league_id: z.union([z.number(), z.string()]),
  starting_at: z.string(),
  state_id: z.union([z.number(), z.string()]),
  participants: z.array(participantSchema).optional(),
  league: z.object({ id: z.union([z.number(), z.string()]).optional(), name: z.string().optional() }).optional(),
  stage: z.object({ name: z.string().optional() }).optional(),
});

type RawFixture = z.infer<typeof rawFixtureSchema>;

function classifyHttpStatus(status: number): SportmonksFixturesFetchFailureReason {
  if (status === 401) return "HTTP_UNAUTHORIZED";
  if (status === 403) return "HTTP_FORBIDDEN";
  if (status === 429) return "HTTP_RATE_LIMITED";
  return "HTTP_ERROR";
}

function mapRawFixture(raw: RawFixture): SportmonksFixture | null {
  const participants = raw.participants ?? [];
  const home = participants.find((p) => p.meta?.location === "home");
  const away = participants.find((p) => p.meta?.location === "away");
  if (!home || !away) return null;

  return {
    provider: "SPORTMONKS",
    providerEventId: String(raw.id),
    sport: "FOOTBALL",
    leagueId: Number(raw.league_id),
    leagueName: raw.league?.name ?? null,
    stageName: raw.stage?.name ?? null,
    homeTeamId: home.id !== undefined ? String(home.id) : null,
    homeTeamName: home.name,
    awayTeamId: away.id !== undefined ? String(away.id) : null,
    awayTeamName: away.name,
    commenceTime: new Date(parseSportmonksUtcTimestamp(raw.starting_at)).toISOString(),
    stateId: Number(raw.state_id),
  };
}

function isFutureAndNotStarted(fixture: SportmonksFixture, now: number): boolean {
  if (fixture.stateId !== NOT_STARTED_STATE_ID) return false;
  const startMs = Date.parse(fixture.commenceTime);
  return !Number.isNaN(startMs) && startMs > now;
}

interface CallOptions {
  readonly timeoutMs?: number;
  readonly now?: () => number;
  // Injectable for tests — defaults to the real global fetch. Never
  // exercised against the real network in any *.test.ts file.
  readonly fetchImpl?: typeof fetch;
}

async function callSportmonks(
  path: string,
  options: CallOptions,
): Promise<{ status: number; body: unknown } | { failed: SportmonksFixturesFetchFailureReason }> {
  const token = process.env.SPORTMONKS_API_TOKEN;
  if (!token) {
    return { failed: "MISSING_API_TOKEN" };
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(`${SPORTMONKS_BASE_URL}${path}`, {
      headers: { Authorization: token },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { failed: "TIMEOUT" };
    }
    return { failed: "HTTP_ERROR" };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return { failed: classifyHttpStatus(response.status) };
  }

  try {
    const body: unknown = await response.json();
    return { status: response.status, body };
  } catch {
    return { failed: "INVALID_JSON" };
  }
}

export interface FetchSportmonksFixturesOptions extends CallOptions {
  readonly leagueIds?: readonly number[];
  readonly windowDays?: number;
}

// Only future, not-started fixtures across the supported league_id
// allowlist. Never fetches an unsupported league_id — same
// "no network call for an unsupported key" discipline as
// eventsAdapter.ts's isSupportedSportKey guard.
const responseShapeSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
  pagination: z.object({ has_more: z.boolean().optional(), current_page: z.union([z.number(), z.string()]).optional() }).optional(),
});

// A single page (per_page=50) silently truncated real results in practice —
// live-confirmed, Stage 10: a 5-league window regularly holds 25+ upcoming
// qualifying-round fixtures, sorted by kickoff time, so a later (but still
// well within window) fixture like a Club Friendlies match could sit past
// page 1 and never be seen without pagination. Capped at 10 pages (up to
// 500 fixtures) as a safety bound against a runaway loop, not a real
// expected ceiling at this allowlist's current scale.
const MAX_PAGES = 10;

export async function fetchSportmonksFixtures(
  options: FetchSportmonksFixturesOptions = {},
): Promise<SportmonksFixturesFetchResult> {
  const leagueIds = (options.leagueIds ?? getSupportedSportmonksLeagueIds()).filter(isSupportedSportmonksLeagueId);
  if (leagueIds.length === 0) {
    return { status: "SUCCESS", results: [], rejectedEntries: 0 };
  }

  const now = options.now ?? (() => Date.now());
  const nowMs = now();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const from = new Date(nowMs).toISOString().slice(0, 10);
  const to = new Date(nowMs + windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const results: SportmonksFixture[] = [];
  let rejectedEntries = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = `/football/fixtures/between/${from}/${to}?include=participants;league;stage&per_page=50&page=${page}&filters=fixtureLeagues:${leagueIds.join(",")}`;
    const result = await callSportmonks(path, options);

    if ("failed" in result) {
      return { status: "FAILED", reason: result.failed };
    }

    const shapeResult = responseShapeSchema.safeParse(result.body);
    if (!shapeResult.success) {
      return { status: "FAILED", reason: "INVALID_RESPONSE" };
    }

    for (const rawEntry of shapeResult.data.data) {
      const parsed = rawFixtureSchema.safeParse(rawEntry);
      if (!parsed.success) {
        rejectedEntries += 1;
        continue;
      }
      const fixture = mapRawFixture(parsed.data);
      if (!fixture) {
        rejectedEntries += 1;
        continue;
      }
      if (isFutureAndNotStarted(fixture, nowMs)) {
        results.push(fixture);
      }
    }

    if (!shapeResult.data.pagination?.has_more) {
      break;
    }
  }

  return { status: "SUCCESS", results, rejectedEntries };
}

// Single-fixture lookup — used by the Stage 10 preview builder's own
// pre-Preview safety re-check (section 8), independent of whatever the
// list fetch above returned moments earlier.
export async function fetchSportmonksFixtureById(
  fixtureId: string,
  options: CallOptions = {},
): Promise<SportmonksFixtureByIdResult> {
  const path = `/football/fixtures/${encodeURIComponent(fixtureId)}?include=participants;league;stage`;
  const result = await callSportmonks(path, options);

  if ("failed" in result) {
    return { status: "FAILED", reason: result.failed };
  }

  const shapeResult = z.object({ data: z.record(z.string(), z.unknown()).optional() }).safeParse(result.body);
  if (!shapeResult.success || !shapeResult.data.data) {
    return { status: "NOT_FOUND" };
  }

  const parsed = rawFixtureSchema.safeParse(shapeResult.data.data);
  if (!parsed.success) {
    return { status: "FAILED", reason: "INVALID_RESPONSE" };
  }

  const fixture = mapRawFixture(parsed.data);
  if (!fixture) {
    return { status: "NOT_FOUND" };
  }

  return { status: "SUCCESS", fixture };
}

// Team Index's own DI seam only understands ProviderEventCandidate
// (lib/odds/oddsProvider.ts) — this is the one, deliberately narrow,
// translation point between SportmonksFixture (this file's own rich shape,
// carrying stageName/stateId/team IDs the shared canonical types have no
// slot for) and what Team Index/Candidate Resolver actually consume.
export function toProviderEventCandidate(fixture: SportmonksFixture): ProviderEventCandidate {
  return {
    event: {
      sport: "FOOTBALL",
      league: fixture.leagueName ? { id: String(fixture.leagueId), name: fixture.leagueName } : undefined,
      name: `${fixture.homeTeamName} vs ${fixture.awayTeamName}`,
      participants: [{ id: fixture.homeTeamId ?? undefined, name: fixture.homeTeamName }, { id: fixture.awayTeamId ?? undefined, name: fixture.awayTeamName }],
      startTime: fixture.commenceTime,
      period: "FULL_GAME",
      homeParticipantIndex: 0,
      awayParticipantIndex: 1,
    },
    reference: {
      provider: "SPORTMONKS",
      eventId: fixture.providerEventId,
      // Namespaced so a Sportmonks league_id can never collide with a real
      // The Odds API sport_key string, even at the sportKey-string level.
      sportKey: `sportmonks:${fixture.leagueId}`,
    },
  };
}
