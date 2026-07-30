// Stage 3 (Event Discovery Engine) — typed adapter over The Odds API v4
// sports-catalog endpoint:
//
//   GET /v4/sports/?apiKey=...&all=true
//
// Same separation of concerns as lib/odds/providers/theOddsApi/scoresAdapter.ts
// (this file's direct precedent): perform the HTTP request, validate the raw
// response, translate it into a plain, camelCase ProviderSportEntry — no
// caching, no TTL, no allowlist awareness, no knowledge of Bet/BetSelection.
// The caching/allowlist-comparison layer is lib/odds/discovery/leagueCatalog.ts,
// a separate file, same "adapter does I/O and shape only, a discovery-layer
// file owns policy" split scoresAdapter.ts already establishes.
//
// `all=true` is deliberate, not the default: League Catalog's own purpose
// (Stage 3 spec) includes telling a player "this competition exists at the
// provider, we just don't support it yet" — that requires seeing
// out-of-season competitions too (the provider's default omits them), not
// only whichever happen to be active right now.
//
// Confirmed live (2026-07-30, one authorized call, x-requests-last: 0):
// this endpoint does not consume the account's usage quota — see this
// repo's odds-architecture discussion for the full citation. Nothing below
// re-verifies that at runtime; it is a documented, not enforced, provider
// fact.

import { z } from "zod";

const SPORTS_API_BASE_URL = "https://api.the-odds-api.com/v4";

// Same timeout value and AbortController+finally pattern as
// lib/odds/oddsVerifier.ts's ODDS_API_TIMEOUT_MS and scoresAdapter.ts's own
// SCORES_API_TIMEOUT_MS — no evidence this endpoint needs a different
// ceiling, so no new number is invented.
const SPORTS_CATALOG_TIMEOUT_MS = 8000;

/* -------------------------------------------------------------------------- */
/* Raw provider response validation                                          */
/* -------------------------------------------------------------------------- */

// Zod validates shape/type only, matching this repo's existing convention
// (scoresAdapter.ts's providerScoresEventSchema, lib/ai/betParser.ts's
// betFieldsSchema) — no business rule (e.g. "group must be Soccer") is
// folded into this schema; that's leagueCatalog.ts's job.
const providerSportEntrySchema = z.object({
  key: z.string().min(1),
  group: z.string(),
  title: z.string(),
  description: z.string(),
  active: z.boolean(),
  has_outrights: z.boolean(),
});

// Loose top-level shape check, same reasoning as scoresAdapter.ts's
// rawResponseShapeSchema: each element is validated individually below so
// one malformed entry can be isolated and skipped without invalidating an
// otherwise-valid catalog — z.array(providerSportEntrySchema).safeParse()
// on the whole array would fail the ENTIRE parse on a single bad element,
// which is exactly the all-or-nothing behavior this stage must avoid (a
// single malformed entry must never take down the whole catalog sync).
const rawResponseShapeSchema = z.array(z.record(z.string(), z.unknown()));

/* -------------------------------------------------------------------------- */
/* Provider entry -> camelCase domain shape                                   */
/* -------------------------------------------------------------------------- */

export interface ProviderSportEntry {
  readonly sportKey: string;
  readonly group: string;
  readonly title: string;
  readonly description: string;
  readonly active: boolean;
  readonly hasOutrights: boolean;
}

function mapProviderSportEntry(raw: z.infer<typeof providerSportEntrySchema>): ProviderSportEntry {
  return {
    sportKey: raw.key,
    group: raw.group,
    title: raw.title,
    description: raw.description,
    active: raw.active,
    hasOutrights: raw.has_outrights,
  };
}

/* -------------------------------------------------------------------------- */
/* Result contract                                                            */
/* -------------------------------------------------------------------------- */

export type SportsCatalogFetchFailureReason =
  | "MISSING_API_KEY"
  | "TIMEOUT"
  | "HTTP_401"
  | "HTTP_429"
  | "HTTP_5XX"
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "INVALID_RESPONSE";

export type SportsCatalogFetchResult =
  | { readonly status: "SUCCESS"; readonly results: readonly ProviderSportEntry[]; readonly rejectedEntries: number }
  | { readonly status: "FAILED"; readonly reason: SportsCatalogFetchFailureReason };

function classifyHttpStatus(status: number): SportsCatalogFetchFailureReason {
  if (status === 401) return "HTTP_401";
  if (status === 429) return "HTTP_429";
  if (status >= 500) return "HTTP_5XX";
  return "HTTP_ERROR";
}

// Never throws — every expected failure (missing key, timeout, non-2xx,
// malformed JSON, malformed top-level shape) resolves to a typed FAILED
// result, matching scoresAdapter.ts's/theOddsApiProvider.ts's own "never
// throw for an expected outcome" convention. An unexpected exception (a
// genuine bug, not a provider/network condition) is allowed to propagate.
export async function fetchProviderSportsCatalog(): Promise<SportsCatalogFetchResult> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return { status: "FAILED", reason: "MISSING_API_KEY" };
  }

  const url = new URL(`${SPORTS_API_BASE_URL}/sports/`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("all", "true");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SPORTS_CATALOG_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    // AbortError from our own timeout vs. any other network failure —
    // distinguished the same way scoresAdapter.ts already does, so a
    // future retry layer can treat them differently.
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

  const results: ProviderSportEntry[] = [];
  let rejectedEntries = 0;

  for (const rawEntry of shapeResult.data) {
    const parsed = providerSportEntrySchema.safeParse(rawEntry);
    if (!parsed.success) {
      rejectedEntries += 1;
      continue;
    }
    results.push(mapProviderSportEntry(parsed.data));
  }

  return { status: "SUCCESS", results, rejectedEntries };
}
