// Stage 10 — typed adapter over Sportmonks' pre-match odds endpoint,
// scoped to market_id=1 ("Fulltime Result" / 1X2 — confirmed live,
// Stage 9.4.4, via GET /odds/markets/search/Fulltime Result). Only ever
// returns a complete Home+Draw+Away set from exactly ONE bookmaker, chosen
// deterministically — never mixes outcomes from different bookmakers.

import { z } from "zod";

const SPORTMONKS_BASE_URL = "https://api.sportmonks.com/v3";
const DEFAULT_TIMEOUT_MS = 8000;
const FULLTIME_RESULT_MARKET_ID = 1;

export interface SportmonksOddsSnapshot {
  readonly provider: "SPORTMONKS";
  readonly providerEventId: string;
  readonly bookmakerId: string;
  readonly bookmakerName: string | null;
  readonly marketId: number;
  readonly marketName: string;
  // Decimal strings, matching this codebase's decimal-safety convention
  // (docs/ODDS_PROVIDER_DESIGN.md Section 8) — never a JS number.
  readonly homeOdds: string;
  readonly drawOdds: string;
  readonly awayOdds: string;
  readonly updatedAt: string | null;
}

export type SportmonksOddsFetchFailureReason =
  | "MISSING_API_TOKEN"
  | "TIMEOUT"
  | "HTTP_UNAUTHORIZED"
  | "HTTP_FORBIDDEN"
  | "HTTP_RATE_LIMITED"
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "INVALID_RESPONSE";

export type SportmonksOddsFetchResult =
  | { readonly status: "SUCCESS"; readonly snapshot: SportmonksOddsSnapshot }
  // Either the provider returned zero odds rows, or none of the returned
  // rows form a complete Home+Draw+Away set from a single bookmaker —
  // both are an honest "nothing usable right now", never guessed further.
  | { readonly status: "EMPTY" }
  | { readonly status: "FAILED"; readonly reason: SportmonksOddsFetchFailureReason };

const oddsEntrySchema = z.object({
  market_id: z.union([z.number(), z.string()]),
  market_description: z.string().optional(),
  bookmaker_id: z.union([z.number(), z.string()]),
  bookmaker: z.object({ name: z.string().optional() }).optional(),
  label: z.string().optional(),
  value: z.string().optional(),
  latest_bookmaker_update: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});

function classifyHttpStatus(status: number): SportmonksOddsFetchFailureReason {
  if (status === 401) return "HTTP_UNAUTHORIZED";
  if (status === 403) return "HTTP_FORBIDDEN";
  if (status === 429) return "HTTP_RATE_LIMITED";
  return "HTTP_ERROR";
}

function isPositiveDecimalString(v: string | undefined): v is string {
  if (typeof v !== "string") return false;
  if (!/^\d+(\.\d+)?$/.test(v)) return false;
  return Number(v) > 0;
}

interface FetchSportmonksOddsOptions {
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

// Deterministic choice, per Stage 10's own spec: (1) bookmaker has all
// three of Home/Draw/Away with valid positive decimal odds, (2) freshest
// latest_bookmaker_update (falling back to updated_at), (3) tie-break on
// the lowest numeric bookmaker_id. Never mixes outcomes across bookmakers.
function chooseBookmakerEntries(entries: z.infer<typeof oddsEntrySchema>[]): z.infer<typeof oddsEntrySchema>[] | null {
  const byBookmaker = new Map<string, z.infer<typeof oddsEntrySchema>[]>();
  for (const e of entries) {
    const key = String(e.bookmaker_id);
    const bucket = byBookmaker.get(key);
    if (bucket) bucket.push(e);
    else byBookmaker.set(key, [e]);
  }

  const complete: Array<{ bookmakerId: string; entries: z.infer<typeof oddsEntrySchema>[]; ts: number }> = [];
  for (const [bookmakerId, bucket] of byBookmaker) {
    const home = bucket.find((e) => e.label?.toLowerCase() === "home");
    const draw = bucket.find((e) => e.label?.toLowerCase() === "draw");
    const away = bucket.find((e) => e.label?.toLowerCase() === "away");
    if (!home || !draw || !away) continue;
    if (![home, draw, away].every((e) => isPositiveDecimalString(e.value))) continue;

    const timestamps = [home, draw, away]
      .map((e) => Date.parse(e.latest_bookmaker_update ?? e.updated_at ?? ""))
      .filter((t) => !Number.isNaN(t));
    const ts = timestamps.length > 0 ? Math.max(...timestamps) : 0;

    complete.push({ bookmakerId, entries: [home, draw, away], ts });
  }

  if (complete.length === 0) return null;

  complete.sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : Number(a.bookmakerId) - Number(b.bookmakerId)));
  return complete[0].entries;
}

export async function fetchSportmonksPreMatchOdds(
  providerEventId: string,
  options: FetchSportmonksOddsOptions = {},
): Promise<SportmonksOddsFetchResult> {
  const token = process.env.SPORTMONKS_API_TOKEN;
  if (!token) {
    return { status: "FAILED", reason: "MISSING_API_TOKEN" };
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(
      `${SPORTMONKS_BASE_URL}/football/odds/pre-match/fixtures/${encodeURIComponent(providerEventId)}?include=bookmaker;market`,
      { headers: { Authorization: token }, signal: controller.signal },
    );
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "FAILED", reason: "TIMEOUT" };
    }
    return { status: "FAILED", reason: "HTTP_ERROR" };
  }
  clearTimeout(timeout);

  if (!response.ok) {
    return { status: "FAILED", reason: classifyHttpStatus(response.status) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "FAILED", reason: "INVALID_JSON" };
  }

  const shapeResult = z.object({ data: z.array(z.record(z.string(), z.unknown())) }).safeParse(body);
  if (!shapeResult.success) {
    return { status: "FAILED", reason: "INVALID_RESPONSE" };
  }

  const entries = shapeResult.data.data
    .map((raw) => oddsEntrySchema.safeParse(raw))
    .filter((r): r is { success: true; data: z.infer<typeof oddsEntrySchema> } => r.success)
    .map((r) => r.data)
    .filter((e) => Number(e.market_id) === FULLTIME_RESULT_MARKET_ID);

  if (entries.length === 0) {
    return { status: "EMPTY" };
  }

  const chosen = chooseBookmakerEntries(entries);
  if (!chosen) {
    return { status: "EMPTY" };
  }

  const [home, draw, away] = chosen;
  const updatedAt = home.latest_bookmaker_update ?? home.updated_at ?? null;

  return {
    status: "SUCCESS",
    snapshot: {
      provider: "SPORTMONKS",
      providerEventId,
      bookmakerId: String(home.bookmaker_id),
      bookmakerName: home.bookmaker?.name ?? null,
      marketId: FULLTIME_RESULT_MARKET_ID,
      marketName: home.market_description ?? "Fulltime Result",
      homeOdds: home.value!,
      drawOdds: draw.value!,
      awayOdds: away.value!,
      updatedAt,
    },
  };
}
