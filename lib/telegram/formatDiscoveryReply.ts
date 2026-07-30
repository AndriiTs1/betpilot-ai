// Stage 9.1 — pure Telegram HTML-free text formatter for a /find
// (Candidate Resolver) result. Reads only ResolveQueryResult
// (lib/odds/discovery/candidateResolver.ts, unmodified) and never exposes
// providerEventId, matchMethod, score, diagnostics, or any internal
// FAILED source/reason to the player — those are logging-only fields.
// commenceTime is never rendered (always null today, see candidateResolver.ts).

import { escapeHtml } from "./escapeHtml";
import type { ResolveQueryResult, ResolvedEventCandidate } from "@/lib/odds/discovery/candidateResolver";

const MAX_AMBIGUOUS_CANDIDATES = 5;

export const DISCOVERY_USAGE_TEXT = "Использование:\n/find <команда>\nили\n/find <команда1> vs <команда2>";
export const DISCOVERY_NOT_FOUND_TEXT = "Команда или матч не найдены.";
export const DISCOVERY_FAILED_TEXT = "Поиск временно недоступен. Попробуйте позже.";

function formatTeams(candidate: ResolvedEventCandidate): string {
  const home = escapeHtml(candidate.homeTeam ?? "?");
  const away = escapeHtml(candidate.awayTeam ?? "?");
  return `${home} — ${away}`;
}

function formatResolvedCandidate(candidate: ResolvedEventCandidate): string {
  const lines = [formatTeams(candidate)];
  if (candidate.league) lines.push(escapeHtml(candidate.league));
  return lines.join("\n");
}

function formatAmbiguousLine(candidate: ResolvedEventCandidate, index: number): string {
  const league = candidate.league ? ` (${escapeHtml(candidate.league)})` : "";
  return `${index + 1}. ${formatTeams(candidate)}${league}`;
}

function formatAmbiguousHint(first: ResolvedEventCandidate | undefined): string {
  if (first?.homeTeam && first?.awayTeam) {
    return `Уточните запрос, например:\n/find ${first.homeTeam} vs ${first.awayTeam}`;
  }
  return "Уточните запрос.";
}

export function formatDiscoveryReply(result: ResolveQueryResult): string {
  switch (result.kind) {
    case "TEAM_RESOLVED":
    case "MATCH_RESOLVED":
      return `Найден матч:\n\n${formatResolvedCandidate(result.candidate)}`;

    case "AMBIGUOUS": {
      // Never auto-picks the first candidate — always shows the (capped)
      // list and asks the player to refine the query themselves.
      const shown = result.candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES);
      const lines = shown.map((candidate, index) => formatAmbiguousLine(candidate, index));
      return `Найдено несколько матчей:\n\n${lines.join("\n")}\n\n${formatAmbiguousHint(shown[0])}`;
    }

    case "NOT_FOUND":
      return DISCOVERY_NOT_FOUND_TEXT;

    case "INVALID_QUERY":
      return DISCOVERY_USAGE_TEXT;

    case "FAILED":
      // result.source / result.reason are deliberately never read here.
      return DISCOVERY_FAILED_TEXT;
  }
}
