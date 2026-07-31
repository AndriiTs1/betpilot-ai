// Event Discovery Engine — Stage 8. Candidate Resolver: the deterministic
// layer that turns a player's free-text team/match query into a concrete
// event candidate (or an honest AMBIGUOUS/NOT_FOUND/INVALID_QUERY/FAILED
// outcome) — built entirely on Stage 6 (Team Index) and Stage 7/7.1 (Team
// Alias Index). Nothing here talks to Event Catalog, an Events Adapter,
// League Catalog, The Odds API, a database, or any AI/LLM/embeddings
// service — every decision is table lookups and one small, local,
// deterministic Levenshtein fallback over CURRENT canonical team names.
//
// This file is not wired to Telegram, an API route, or the live betting
// pipeline. It is a standalone, fully testable resolution engine — the
// integration decision (where/how a player's text reaches this) is
// explicitly out of scope for this stage.
//
// Resolution order per query "part" (Team Index findExact -> Team Index
// findNormalized -> Team Alias Index find -> fuzzy fallback) is fixed and
// never merged across levels: the first level that returns at least one
// match wins outright, and lower-priority levels are never consulted for
// that part. This is what "не объединять одинаковые TeamIndexEntry
// несколько раз" means in practice — a part is resolved through exactly
// one level, once.

import type { TeamIndex, TeamIndexEntry, BuildTeamIndexResult } from "./teamIndex";
import type { TeamAliasIndex } from "./teamAliasIndex";
import { teamIndex as defaultTeamIndex } from "./teamIndex";
import { teamAliasIndex as defaultTeamAliasIndex } from "./teamAliasIndex";
import type { ProviderName } from "@/lib/odds/oddsProvider";

// Stage 10 — the real, composite event identity. providerEventId alone is
// only unique within one provider's own ID namespace; a Team Index that
// ever held entries from more than one provider could otherwise conflate
// two different real-world events that happen to share a raw ID. Every
// join/dedup below keys on this composite string, never on providerEventId
// alone.
function eventKey(provider: ProviderName, providerEventId: string): string {
  return `${provider}:${providerEventId}`;
}

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type CandidateMatchMethod = "EXACT" | "NORMALIZED" | "CURATED_ALIAS" | "FUZZY";

// commenceTime is always null today — TeamIndexEntry (Stage 6) has no such
// field; Stage 8's own spec explicitly qualifies this as conditional ("если
// доступно через TeamIndexEntry"), so this is the documented, permitted
// absence, not a silently-dropped requirement or a guess. homeTeam/awayTeam
// ARE reconstructable without any contract change: Team Index's own
// getAllTeams() exposes every HOME/AWAY occurrence, so this file finds both
// sides of a given providerEventId by filtering that list itself — no
// change to Team Index was needed or made.
export interface ResolvedEventCandidate {
  // Stage 10 — see eventKey() above: providerEventId alone is not a
  // globally unique identity, only (provider, providerEventId) together is.
  readonly provider: ProviderName;
  readonly providerEventId: string;
  readonly sportKey: string;
  readonly league: string | null;
  readonly commenceTime: string | null;
  readonly homeTeam: string | null;
  readonly awayTeam: string | null;
  readonly matchedTeamNames: readonly string[];
  readonly matchMethod: CandidateMatchMethod;
  readonly score: number;
  readonly diagnostics: readonly string[];
}

type UpstreamFailureReason = Extract<BuildTeamIndexResult, { status: "FAILED" }>["reason"];

export type CandidateResolverFailureSource = "TEAM_INDEX" | "TEAM_ALIAS_INDEX" | "RESOLVER";

export type BuildDependenciesResult =
  | { readonly status: "SUCCESS" }
  | { readonly status: "FAILED"; readonly source: "TEAM_INDEX" | "TEAM_ALIAS_INDEX"; readonly reason: UpstreamFailureReason };

export type ResolveQueryResult =
  | { readonly kind: "TEAM_RESOLVED"; readonly candidate: ResolvedEventCandidate }
  | { readonly kind: "MATCH_RESOLVED"; readonly candidate: ResolvedEventCandidate }
  | { readonly kind: "AMBIGUOUS"; readonly candidates: readonly ResolvedEventCandidate[]; readonly reason: string }
  | { readonly kind: "NOT_FOUND"; readonly reason: string }
  | { readonly kind: "INVALID_QUERY"; readonly reason: string }
  | { readonly kind: "FAILED"; readonly source: CandidateResolverFailureSource; readonly reason: string };

export interface CreateCandidateResolverOptions {
  readonly teamIndex?: Pick<TeamIndex, "build" | "getAllTeams" | "findExact" | "findNormalized">;
  readonly teamAliasIndex?: Pick<TeamAliasIndex, "find" | "build">;
}

export interface CandidateResolver {
  resolve(query: string): ResolveQueryResult;
  resolveTeam(query: string): ResolveQueryResult;
  resolveMatch(homeOrFirst: string, awayOrSecond: string): ResolveQueryResult;
  buildDependencies(): Promise<BuildDependenciesResult>;
  clear(): void;
}

/* -------------------------------------------------------------------------- */
/* Match-query splitting — deterministic, fixed separator set                */
/* -------------------------------------------------------------------------- */

// Exactly the separators Stage 8 lists, nothing inferred: " vs ", " v ",
// " - ", " — " (em dash), " – " (en dash), " против " (Cyrillic). Matched
// with mandatory surrounding whitespace so a hyphenated club name with no
// spaces around its own hyphen (e.g. "Sheffield-United") is never
// mistaken for a separator.
const SEPARATOR_PATTERN = /\s(vs|v|против|-|–|—)\s/giu;

type QuerySplit = { readonly kind: "TEAM" } | { readonly kind: "MATCH"; readonly first: string; readonly second: string } | { readonly kind: "INVALID" };

function splitMatchQuery(trimmedQuery: string): QuerySplit {
  const matches = [...trimmedQuery.matchAll(SEPARATOR_PATTERN)];

  if (matches.length === 0) return { kind: "TEAM" };
  // More than one separator instance means more than two team parts — never
  // guess which split was intended.
  if (matches.length > 1) return { kind: "INVALID" };

  const [match] = matches;
  const splitIndex = match.index;
  const first = trimmedQuery.slice(0, splitIndex).trim();
  const second = trimmedQuery.slice(splitIndex + match[0].length).trim();

  if (first.length === 0 || second.length === 0) return { kind: "INVALID" };
  return { kind: "MATCH", first, second };
}

/* -------------------------------------------------------------------------- */
/* Fuzzy fallback — local, deterministic, canonical-name-only                */
/* -------------------------------------------------------------------------- */
//
// Deliberately NOT imported from lib/odds/teamNameMatcher.ts — this stage
// (and Stage 6/7 before it) explicitly keeps the Discovery Engine
// independent of the legacy matcher. This is a small (~15 line), local,
// standard iterative Levenshtein implementation, not an external library.

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

// Below this length, fuzzy matching is refused entirely — a 1-character
// edit on a 2-3 character string is too large a relative change to trust
// (this is "короткие строки обрабатываются строже" as an outright gate,
// not just a stricter ratio).
const FUZZY_MIN_QUERY_LENGTH = 4;
// Allowed edit distance scales with the longer string's length (stricter
// for shorter names, same spirit as lib/odds/teamNameMatcher.ts's own
// length-aware calibration, independently re-derived here — not imported),
// capped at an absolute ceiling regardless of how long the names get.
const FUZZY_MAX_DISTANCE_RATIO = 0.25;
const FUZZY_MAX_ABSOLUTE_DISTANCE = 2;

function isFuzzyCandidate(distance: number, maxLen: number): boolean {
  const allowed = Math.min(Math.floor(maxLen * FUZZY_MAX_DISTANCE_RATIO), FUZZY_MAX_ABSOLUTE_DISTANCE);
  return distance <= allowed;
}

interface FuzzyCandidateName {
  readonly canonicalName: string;
  readonly score: number;
}

// Scans the CURRENT set of distinct canonical team names from Team Index —
// never a static dictionary. Returns every name tied for the single best
// score (length 0 = no candidate cleared the threshold at all; length 1 =
// a unique best match; length > 1 = a genuine tie, surfaced honestly for
// the caller to treat as ambiguous rather than picked arbitrarily).
function fuzzyFindBestTeams(rawQuery: string, allEntries: readonly TeamIndexEntry[]): readonly FuzzyCandidateName[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < FUZZY_MIN_QUERY_LENGTH) return [];

  const distinctNames = new Set(allEntries.map((e) => e.canonicalName));
  const scored: FuzzyCandidateName[] = [];

  for (const name of distinctNames) {
    const normalizedName = name.trim().toLowerCase();
    const distance = levenshteinDistance(query, normalizedName);
    const maxLen = Math.max(query.length, normalizedName.length);
    if (!isFuzzyCandidate(distance, maxLen)) continue;
    const score = maxLen === 0 ? 1 : 1 - distance / maxLen;
    scored.push({ canonicalName: name, score });
  }

  if (scored.length === 0) return [];

  const bestScore = Math.max(...scored.map((s) => s.score));
  return scored.filter((s) => s.score === bestScore);
}

/* -------------------------------------------------------------------------- */
/* Per-part resolution                                                       */
/* -------------------------------------------------------------------------- */

interface PartResolution {
  readonly entries: readonly TeamIndexEntry[];
  readonly matchMethod: CandidateMatchMethod;
  readonly score: number;
  readonly matchedTeamNames: readonly string[];
  readonly diagnostics: readonly string[];
}

function distinctCanonicalNames(entries: readonly TeamIndexEntry[]): string[] {
  return [...new Set(entries.map((e) => e.canonicalName))];
}

// Priority order fixed by Stage 8: EXACT -> NORMALIZED -> CURATED_ALIAS ->
// FUZZY. The first level with any match wins outright; nothing below it is
// ever consulted for this part.
function resolvePart(
  part: string,
  teamIndexInstance: Pick<TeamIndex, "findExact" | "findNormalized" | "getAllTeams">,
  teamAliasIndexInstance: Pick<TeamAliasIndex, "find">,
): PartResolution | null {
  const exactMatches = teamIndexInstance.findExact(part);
  if (exactMatches.length > 0) {
    return {
      entries: exactMatches,
      matchMethod: "EXACT",
      score: 1,
      matchedTeamNames: distinctCanonicalNames(exactMatches),
      diagnostics: [`"${part}" matched via Team Index.findExact()`],
    };
  }

  const normalizedMatches = teamIndexInstance.findNormalized(part);
  if (normalizedMatches.length > 0) {
    return {
      entries: normalizedMatches,
      matchMethod: "NORMALIZED",
      score: 1,
      matchedTeamNames: distinctCanonicalNames(normalizedMatches),
      diagnostics: [`"${part}" matched via Team Index.findNormalized()`],
    };
  }

  const aliasMatches = teamAliasIndexInstance.find(part);
  if (aliasMatches.length > 0) {
    return {
      entries: aliasMatches,
      matchMethod: "CURATED_ALIAS",
      score: 1,
      matchedTeamNames: distinctCanonicalNames(aliasMatches),
      diagnostics: [`"${part}" matched via Team Alias Index.find()`],
    };
  }

  const allEntries = teamIndexInstance.getAllTeams();
  const bestFuzzy = fuzzyFindBestTeams(part, allEntries);
  if (bestFuzzy.length > 0) {
    const bestNames = bestFuzzy.map((f) => f.canonicalName);
    const matchingEntries = allEntries.filter((e) => bestNames.includes(e.canonicalName));
    return {
      entries: matchingEntries,
      matchMethod: "FUZZY",
      score: bestFuzzy[0].score,
      matchedTeamNames: bestNames,
      diagnostics: [
        `"${part}" matched via fuzzy (score ${bestFuzzy[0].score.toFixed(2)}, ${bestFuzzy.length} tied candidate(s): ${bestNames.join(", ")})`,
      ],
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Candidate construction                                                    */
/* -------------------------------------------------------------------------- */

// EXACT/NORMALIZED/CURATED_ALIAS are treated as equally "exact-like" for
// combining two sides of a match query — only FUZZY is weaker. When the two
// sides used different methods, the combined candidate reports the WEAKER
// one and the lower of the two scores: a match candidate's confidence is
// only as strong as its least-certain side.
const METHOD_STRENGTH: Record<CandidateMatchMethod, number> = { EXACT: 0, NORMALIZED: 0, CURATED_ALIAS: 0, FUZZY: 1 };

function weakerMethod(a: CandidateMatchMethod, b: CandidateMatchMethod): CandidateMatchMethod {
  return METHOD_STRENGTH[a] >= METHOD_STRENGTH[b] ? a : b;
}

function buildCandidate(
  provider: ProviderName,
  providerEventId: string,
  method: CandidateMatchMethod,
  score: number,
  matchedTeamNames: readonly string[],
  diagnostics: readonly string[],
  teamIndexInstance: Pick<TeamIndex, "getAllTeams">,
): ResolvedEventCandidate {
  const key = eventKey(provider, providerEventId);
  const related = teamIndexInstance.getAllTeams().filter((e) => eventKey(e.provider, e.providerEventId) === key);
  const home = related.find((e) => e.role === "HOME")?.canonicalName ?? null;
  const away = related.find((e) => e.role === "AWAY")?.canonicalName ?? null;

  return {
    provider,
    providerEventId,
    sportKey: related[0]?.sportKey ?? "",
    league: related[0]?.league ?? null,
    // Always null — see this file's header comment and ResolvedEventCandidate's
    // own doc comment: TeamIndexEntry has no commenceTime field, and Stage 8's
    // own spec explicitly permits this ("если доступно").
    commenceTime: null,
    homeTeam: home,
    awayTeam: away,
    matchedTeamNames,
    matchMethod: method,
    score,
    diagnostics,
  };
}

function buildCandidatesFromResolution(
  resolution: PartResolution,
  teamIndexInstance: Pick<TeamIndex, "getAllTeams">,
): ResolvedEventCandidate[] {
  const seen = new Map<string, { provider: ProviderName; providerEventId: string }>();
  for (const e of resolution.entries) {
    seen.set(eventKey(e.provider, e.providerEventId), { provider: e.provider, providerEventId: e.providerEventId });
  }
  return [...seen.values()].map(({ provider, providerEventId }) =>
    buildCandidate(provider, providerEventId, resolution.matchMethod, resolution.score, resolution.matchedTeamNames, resolution.diagnostics, teamIndexInstance),
  );
}

function dedupeCandidatesByEventId(candidates: readonly ResolvedEventCandidate[]): ResolvedEventCandidate[] {
  const seen = new Set<string>();
  const result: ResolvedEventCandidate[] = [];
  for (const candidate of candidates) {
    const key = eventKey(candidate.provider, candidate.providerEventId);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export function createCandidateResolver(options: CreateCandidateResolverOptions = {}): CandidateResolver {
  const teamIndexInstance = options.teamIndex ?? defaultTeamIndex;
  const teamAliasIndexInstance = options.teamAliasIndex ?? defaultTeamAliasIndex;

  // The ONLY state this file keeps — dependency readiness. No team data,
  // no event cache, no third index: every resolve() call reads live from
  // teamIndexInstance/teamAliasIndexInstance at call time.
  let lastBuildResult: BuildDependenciesResult | null = null;

  async function buildDependencies(): Promise<BuildDependenciesResult> {
    // Step 1 — Team Index. Step 2 — Team Alias Index (which itself cascades
    // to Team Index again internally, per Stage 7's own design; calling
    // Team Index directly first is Stage 8's own explicit two-step
    // instruction, not an attempt to avoid that cascade).
    const teamIndexResult = await teamIndexInstance.build();
    if (teamIndexResult.status === "FAILED") {
      lastBuildResult = { status: "FAILED", source: "TEAM_INDEX", reason: teamIndexResult.reason };
      return lastBuildResult;
    }

    const aliasResult = await teamAliasIndexInstance.build();
    if (aliasResult.status === "FAILED") {
      lastBuildResult = { status: "FAILED", source: "TEAM_ALIAS_INDEX", reason: aliasResult.reason };
      return lastBuildResult;
    }

    lastBuildResult = { status: "SUCCESS" };
    return lastBuildResult;
  }

  function clear(): void {
    lastBuildResult = null;
  }

  function checkReady(): ResolveQueryResult | null {
    if (lastBuildResult === null) {
      return { kind: "FAILED", source: "RESOLVER", reason: "buildDependencies() was never called" };
    }
    if (lastBuildResult.status === "FAILED") {
      return { kind: "FAILED", source: lastBuildResult.source, reason: lastBuildResult.reason };
    }
    return null;
  }

  function resolveTeamInternal(query: string): ResolveQueryResult {
    const resolution = resolvePart(query, teamIndexInstance, teamAliasIndexInstance);
    if (!resolution) {
      return { kind: "NOT_FOUND", reason: `no team matched "${query}" at any resolution level` };
    }

    const candidates = buildCandidatesFromResolution(resolution, teamIndexInstance);
    if (candidates.length === 1) {
      return { kind: "TEAM_RESOLVED", candidate: candidates[0] };
    }

    const distinctNames = distinctCanonicalNames(resolution.entries);
    const reason =
      distinctNames.length > 1
        ? `"${query}" matched ${distinctNames.length} different teams: ${distinctNames.join(", ")}`
        : `"${distinctNames[0]}" is involved in ${candidates.length} current events`;
    return { kind: "AMBIGUOUS", candidates, reason };
  }

  function resolveMatchInternal(rawFirst: string, rawSecond: string): ResolveQueryResult {
    const firstResolution = resolvePart(rawFirst, teamIndexInstance, teamAliasIndexInstance);
    const secondResolution = resolvePart(rawSecond, teamIndexInstance, teamAliasIndexInstance);

    if (!firstResolution || !secondResolution) {
      const missing = !firstResolution ? rawFirst : rawSecond;
      return { kind: "NOT_FOUND", reason: `no team matched "${missing}"` };
    }

    const firstNames = distinctCanonicalNames(firstResolution.entries);
    const secondNames = distinctCanonicalNames(secondResolution.entries);

    if (firstNames.length > 1 || secondNames.length > 1) {
      const candidates = dedupeCandidatesByEventId([
        ...buildCandidatesFromResolution(firstResolution, teamIndexInstance),
        ...buildCandidatesFromResolution(secondResolution, teamIndexInstance),
      ]);
      return {
        kind: "AMBIGUOUS",
        candidates,
        reason: `one or both sides matched multiple distinct teams ("${rawFirst}" -> ${firstNames.join("/")}; "${rawSecond}" -> ${secondNames.join("/")})`,
      };
    }

    const firstByKey = new Map(firstResolution.entries.map((e) => [eventKey(e.provider, e.providerEventId), e] as const));
    const secondKeys = new Set(secondResolution.entries.map((e) => eventKey(e.provider, e.providerEventId)));
    const commonEntries = [...firstByKey.values()].filter((e) => secondKeys.has(eventKey(e.provider, e.providerEventId)));

    if (commonEntries.length === 0) {
      return { kind: "NOT_FOUND", reason: `no common event found for "${rawFirst}" and "${rawSecond}"` };
    }

    const combinedMethod = weakerMethod(firstResolution.matchMethod, secondResolution.matchMethod);
    const combinedScore = Math.min(firstResolution.score, secondResolution.score);
    const combinedNames = [...new Set([...firstResolution.matchedTeamNames, ...secondResolution.matchedTeamNames])];
    const combinedDiagnostics = [...firstResolution.diagnostics, ...secondResolution.diagnostics];

    const candidates = commonEntries.map((e) =>
      buildCandidate(e.provider, e.providerEventId, combinedMethod, combinedScore, combinedNames, combinedDiagnostics, teamIndexInstance),
    );

    if (candidates.length === 1) {
      return { kind: "MATCH_RESOLVED", candidate: candidates[0] };
    }

    return {
      kind: "AMBIGUOUS",
      candidates,
      reason: `${candidates.length} common events found for "${rawFirst}" and "${rawSecond}"`,
    };
  }

  function resolve(query: string): ResolveQueryResult {
    const notReady = checkReady();
    if (notReady) return notReady;

    if (query.trim().length === 0) return { kind: "INVALID_QUERY", reason: "empty query" };

    // Deliberately splits on the ORIGINAL, not the outer-trimmed, string —
    // trimming first can silently eat the trailing space a separator like
    // " vs " needs to be recognized when it sits at the very end of the
    // query (e.g. "Real Madrid vs " — the trailing space IS the
    // separator's own closing boundary, not incidental whitespace to
    // discard before parsing). splitMatchQuery trims each resulting part
    // itself, so nothing downstream ever sees untrimmed team names.
    const split = splitMatchQuery(query);
    if (split.kind === "INVALID") {
      return { kind: "INVALID_QUERY", reason: "could not deterministically split into at most two team parts" };
    }
    if (split.kind === "TEAM") {
      return resolveTeamInternal(query.trim());
    }
    return resolveMatchInternal(split.first, split.second);
  }

  function resolveTeam(query: string): ResolveQueryResult {
    const notReady = checkReady();
    if (notReady) return notReady;

    const trimmed = query.trim();
    if (trimmed.length === 0) return { kind: "INVALID_QUERY", reason: "empty query" };

    return resolveTeamInternal(trimmed);
  }

  function resolveMatch(homeOrFirst: string, awayOrSecond: string): ResolveQueryResult {
    const notReady = checkReady();
    if (notReady) return notReady;

    const first = homeOrFirst.trim();
    const second = awayOrSecond.trim();
    if (first.length === 0 || second.length === 0) {
      return { kind: "INVALID_QUERY", reason: "one or both match-query sides are empty" };
    }

    return resolveMatchInternal(first, second);
  }

  return { resolve, resolveTeam, resolveMatch, buildDependencies, clear };
}

// Shared default instance — not consumed by any live route/component,
// Telegram integration, or the betting pipeline today.
export const candidateResolver: CandidateResolver = createCandidateResolver();
