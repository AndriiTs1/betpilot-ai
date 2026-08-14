// Stage 10 — Sportmonks football vertical slice. Reuses the EXISTING
// pipeline shape end to end: ParsedBetSlip (same AI Parser output every
// other bet uses) -> Discovery resolution (the same Candidate Resolver
// code, Sportmonks-backed instance) -> odds (Sportmonks pre-match 1X2) ->
// the EXISTING BetSlipPreview/BetSlipPreviewSelection shape
// (lib/bets/buildBetSlipPreview.ts, unmodified) -> the EXISTING Mini App
// preview UI. This function itself never creates a Bet and never touches
// balance — it only builds a preview and (Stage 10.2) exposes the raw
// fields needed to sign a real previewToken via
// signSportmonksFootballPreviewToken below, using the EXISTING signing
// mechanism (lib/betPreview/previewToken.ts). Actual Bet creation still
// only ever happens through the existing, unmodified confirm pipeline
// (app/api/miniapp/bets/text/confirm/route.ts -> createBetFromPreview.ts),
// after that route's own fresh revalidation.

import { Prisma } from "@/lib/generated/prisma/client";
import type { ParsedBetSlip } from "@/lib/bets/betSlip";
import type { BetSlipPreview, BetSlipPreviewSelection } from "@/lib/bets/buildBetSlipPreview";
import { computeTotalOdds, computePotentialWin } from "@/lib/bets/expressMath";
import { signPreviewToken } from "@/lib/betPreview/previewToken";
import type { CandidateResolver, ResolvedEventCandidate } from "@/lib/odds/discovery/candidateResolver";
import { sportmonksFootballCandidateResolver } from "@/lib/odds/discovery/sportmonksFootballDiscovery";
import {
  fetchSportmonksFixtureById,
  type SportmonksFixtureByIdResult,
} from "@/lib/odds/providers/sportmonks/sportmonksFixturesAdapter";
import { fetchSportmonksPreMatchOdds, type SportmonksOddsFetchResult } from "@/lib/odds/providers/sportmonks/sportmonksOddsAdapter";

// Default false even when the env var is unset — mirrors
// lib/telegram/betStatusNotifications.ts's isBetStatusNotificationsEnabled()
// and lib/telegram/discoveryCommand.ts's isTelegramDiscoveryReadOnlyEnabled().
// Requires the exact literal "true"; instantly rollback-able by unsetting
// it, no deploy required. Deliberately its own, separate variable — never
// reuses TELEGRAM_DISCOVERY_READ_ONLY_ENABLED (that flag gates a Telegram
// read-only search command; this one gates a Mini App preview write path
// with real odds and a real, if unsigned, preview).
export function isSportmonksFootballPreviewEnabled(): boolean {
  return process.env.SPORTMONKS_FOOTBALL_PREVIEW_ENABLED === "true";
}

const FOOTBALL_SPORT_NAMES = new Set(["football", "soccer"]);

export function isFootballSelectionSport(sport: string): boolean {
  return FOOTBALL_SPORT_NAMES.has(sport.trim().toLowerCase());
}

const COMBINING_DIACRITICS = new RegExp("[̀-ͯ]", "g");

// Same NFD-decompose-then-strip-combining-marks technique already proven
// live in Stage 9.4 (folds "Beşiktaş" -> "besiktas" etc.) — a small, local,
// deterministic normalizer, not a general transliteration library. Uses a
// Unicode-aware \p{L}\p{N} class (not [a-z0-9]) so this only strips
// punctuation/whitespace, never a whole non-Latin script — a plain
// [^a-z0-9] filter would silently delete every Cyrillic character (e.g.
// "Ничья"), breaking DRAW detection for a Russian-language selection.
function normalizeForSideMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const DRAW_KEYWORDS = ["draw", "ничья", "нічия", "x"];

export type SelectionSide = "HOME" | "DRAW" | "AWAY";

// Vertical-slice selection mapping (Stage 10 section 7): only home win,
// draw, away win are supported. Never guesses — a selection phrase that
// doesn't clearly name the draw or either resolved team is UNSUPPORTED,
// not defaulted to anything.
export function inferSelectionSide(selectionText: string, candidate: ResolvedEventCandidate): SelectionSide | null {
  const normalized = normalizeForSideMatch(selectionText);
  const tokens = new Set(normalized.split(" "));

  if (DRAW_KEYWORDS.some((kw) => tokens.has(kw))) return "DRAW";

  const home = candidate.homeTeam ? normalizeForSideMatch(candidate.homeTeam) : null;
  const away = candidate.awayTeam ? normalizeForSideMatch(candidate.awayTeam) : null;

  const mentionsHome = home !== null && home.length > 0 && normalized.includes(home);
  const mentionsAway = away !== null && away.length > 0 && normalized.includes(away);

  if (mentionsAway && !mentionsHome) return "AWAY";
  if (mentionsHome && !mentionsAway) return "HOME";
  return null;
}

// Stage 10.2 — everything the confirm-time signed token / eventual Bet
// persistence needs beyond what the display-only BetSlipPreview shape
// already carries. Read only from data this module itself just verified
// live (the fixture re-check + odds fetch below) — never from anything a
// client could supply.
export interface SportmonksFootballPreviewRawFields {
  readonly providerEventId: string;
  readonly leagueId: number;
  readonly leagueName: string | null;
  readonly stageName: string | null;
  readonly homeTeamId: string | null;
  readonly homeTeamName: string;
  readonly awayTeamId: string | null;
  readonly awayTeamName: string;
  readonly commenceTime: string;
  readonly stateId: number;
  readonly bookmakerId: string;
  readonly bookmakerName: string | null;
  readonly marketId: number;
  readonly marketName: string;
  readonly selectionSide: SelectionSide;
}

export type SportmonksFootballPreviewResult =
  | { readonly kind: "SUCCESS"; readonly preview: BetSlipPreview; readonly raw: SportmonksFootballPreviewRawFields }
  // Not a SINGLE football selection at all — caller falls back to the
  // existing buildBetSlipPreview() pipeline unchanged.
  | { readonly kind: "NOT_APPLICABLE" }
  | { readonly kind: "TEAM_NOT_FOUND" }
  | { readonly kind: "AMBIGUOUS" }
  | { readonly kind: "INVALID_QUERY" }
  | { readonly kind: "UNSUPPORTED_SELECTION" }
  | { readonly kind: "ALREADY_STARTED" }
  | { readonly kind: "ODDS_UNAVAILABLE" }
  | { readonly kind: "FAILED" };

export interface BuildSportmonksFootballPreviewOptions {
  readonly resolver?: Pick<CandidateResolver, "buildDependencies" | "resolve">;
  readonly fetchFixtureById?: (id: string) => Promise<SportmonksFixtureByIdResult>;
  readonly fetchOdds?: (id: string) => Promise<SportmonksOddsFetchResult>;
  readonly now?: () => number;
}

function oddsForSide(side: SelectionSide, snapshot: { homeOdds: string; drawOdds: string; awayOdds: string }): string {
  if (side === "HOME") return snapshot.homeOdds;
  if (side === "DRAW") return snapshot.drawOdds;
  return snapshot.awayOdds;
}

function isPositiveDecimal(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value) && Number(value) > 0;
}

export async function buildSportmonksFootballPreview(
  slip: ParsedBetSlip,
  options: BuildSportmonksFootballPreviewOptions = {},
): Promise<SportmonksFootballPreviewResult> {
  if (slip.type !== "SINGLE" || slip.selections.length !== 1) {
    return { kind: "NOT_APPLICABLE" };
  }

  const selection = slip.selections[0];
  if (!isFootballSelectionSport(selection.sport)) {
    return { kind: "NOT_APPLICABLE" };
  }

  const resolver = options.resolver ?? sportmonksFootballCandidateResolver;
  const fetchFixtureById = options.fetchFixtureById ?? fetchSportmonksFixtureById;
  const fetchOdds = options.fetchOdds ?? fetchSportmonksPreMatchOdds;
  const now = options.now ?? (() => Date.now());

  const buildResult = await resolver.buildDependencies();
  if (buildResult.status === "FAILED") {
    return { kind: "FAILED" };
  }

  const query = selection.event.trim().length > 0 ? selection.event : selection.selection;
  const resolveResult = resolver.resolve(query);

  if (resolveResult.kind === "NOT_FOUND") return { kind: "TEAM_NOT_FOUND" };
  if (resolveResult.kind === "INVALID_QUERY") return { kind: "INVALID_QUERY" };
  if (resolveResult.kind === "AMBIGUOUS") return { kind: "AMBIGUOUS" };
  if (resolveResult.kind === "FAILED") return { kind: "FAILED" };

  const candidate = resolveResult.candidate;

  const side = inferSelectionSide(selection.selection, candidate);
  if (!side) {
    return { kind: "UNSUPPORTED_SELECTION" };
  }

  // Safety re-check (Stage 10 section 8) — re-fetches the specific fixture
  // fresh, independent of whatever Team Index cached moments earlier, so a
  // match that kicked off between resolution and this call is caught.
  const fixtureCheck = await fetchFixtureById(candidate.providerEventId);
  if (fixtureCheck.status !== "SUCCESS") {
    return { kind: "FAILED" };
  }
  const startMs = Date.parse(fixtureCheck.fixture.commenceTime);
  const stillUpcoming = fixtureCheck.fixture.stateId === 1 && !Number.isNaN(startMs) && startMs > now();
  if (!stillUpcoming) {
    return { kind: "ALREADY_STARTED" };
  }

  const oddsResult = await fetchOdds(candidate.providerEventId);
  if (oddsResult.status === "EMPTY") return { kind: "ODDS_UNAVAILABLE" };
  if (oddsResult.status === "FAILED") return { kind: "FAILED" };

  const rawOdds = oddsForSide(side, oddsResult.snapshot);
  if (!isPositiveDecimal(rawOdds)) {
    return { kind: "ODDS_UNAVAILABLE" };
  }
  const currentOdds = Number(rawOdds);

  const effectiveSubmittedOdds = selection.submittedOdds ?? currentOdds;
  const discrepancyPercent =
    selection.submittedOdds !== null && currentOdds !== 0
      ? (Math.abs(selection.submittedOdds - currentOdds) / currentOdds) * 100
      : null;

  const previewSelection: BetSlipPreviewSelection = {
    sport: selection.sport,
    event: `${candidate.homeTeam ?? "?"} vs ${candidate.awayTeam ?? "?"}`,
    market: oddsResult.snapshot.marketName,
    selection: selection.selection,
    // Betting Markets V1, Phase 3.3 — this Sportmonks football vertical
    // slice only ever handles MONEYLINE match-result selections; Totals
    // is not part of this pipeline.
    line: null,
    // Handicap Stage H2 — this Sportmonks football vertical only ever
    // handles MONEYLINE match-result selections (see this file's own
    // comment on `line` above), so there is no canonical participant/line
    // pair to display a SPREAD label from; null is exactly correct, not a
    // placeholder, and never activates normalizeSelectionToEnglish's new
    // SPREAD branch (gated on marketType === "SPREAD").
    marketType: null,
    participant: null,
    submittedOdds: effectiveSubmittedOdds,
    currentOdds,
    oddsStatus: "VERIFIED",
    bookmaker: oddsResult.snapshot.bookmakerName,
    discrepancyPercent,
    homeTeamName: fixtureCheck.fixture.homeTeamName,
    awayTeamName: fixtureCheck.fixture.awayTeamName,
    competitionName: fixtureCheck.fixture.leagueName,
    eventStartTime: fixtureCheck.fixture.commenceTime,
  };

  const stakeDecimal = new Prisma.Decimal(slip.stake);
  const totalOdds = computeTotalOdds([new Prisma.Decimal(effectiveSubmittedOdds)]);
  const potentialWin = computePotentialWin(stakeDecimal, totalOdds);

  return {
    kind: "SUCCESS",
    preview: {
      type: "SINGLE",
      stake: slip.stake,
      totalOdds: totalOdds.toNumber(),
      potentialWin: potentialWin.toNumber(),
      selections: [previewSelection],
    },
    raw: {
      providerEventId: candidate.providerEventId,
      leagueId: fixtureCheck.fixture.leagueId,
      leagueName: fixtureCheck.fixture.leagueName,
      stageName: fixtureCheck.fixture.stageName,
      homeTeamId: fixtureCheck.fixture.homeTeamId,
      homeTeamName: fixtureCheck.fixture.homeTeamName,
      awayTeamId: fixtureCheck.fixture.awayTeamId,
      awayTeamName: fixtureCheck.fixture.awayTeamName,
      commenceTime: fixtureCheck.fixture.commenceTime,
      stateId: fixtureCheck.fixture.stateId,
      bookmakerId: oddsResult.snapshot.bookmakerId,
      bookmakerName: oddsResult.snapshot.bookmakerName,
      marketId: oddsResult.snapshot.marketId,
      marketName: oddsResult.snapshot.marketName,
      selectionSide: side,
    },
  };
}

// Stage 10.2 — signs a real, short-lived HMAC-signed previewToken for a
// SUCCESS result, using the EXISTING signPreviewToken mechanism
// (lib/betPreview/previewToken.ts) — same secret, same 180s TTL, same
// signature/expiry semantics every other SINGLE bet already gets. No new
// token format, no new crypto. providerName: "SPORTMONKS" is the one new
// field that lets the confirm route route revalidation correctly and lets
// createBetFromPreview.ts persist the real provider instead of the
// previous hardcoded "THE_ODDS_API" default.
export function signSportmonksFootballPreviewToken(
  playerId: string,
  result: Extract<SportmonksFootballPreviewResult, { kind: "SUCCESS" }>,
  previewTokenSecret: string,
): string {
  const selection = result.preview.selections[0];
  return signPreviewToken(
    {
      playerId,
      sport: selection.sport,
      event: selection.event,
      outcome: selection.selection,
      stake: result.preview.stake,
      odds: selection.currentOdds,
      // Stage M4.8 — Sportmonks never carries a distinct screenshot/typed
      // reference price at all (this flow's own ParsedBetSlip always has
      // submittedOdds: null — see verifySportmonksPreviewFreshness.ts), so
      // `odds` above is already always the current provider price; this is
      // simply the same value under PreviewTokenPayload's new required
      // field name, not a behavior change.
      acceptedOdds: selection.currentOdds,
      totalOdds: result.preview.totalOdds,
      oddsCheck: null,
      providerName: "SPORTMONKS",
      providerEventId: result.raw.providerEventId,
      providerSportKey: `sportmonks:${result.raw.leagueId}`,
      eventStartTime: result.raw.commenceTime,
      canonicalMarketType: "MONEYLINE_3WAY",
      canonicalSelectionType: result.raw.selectionSide,
      canonicalParticipant: result.raw.selectionSide === "HOME" ? result.raw.homeTeamName : result.raw.selectionSide === "AWAY" ? result.raw.awayTeamName : null,
      canonicalPeriod: "FULL_GAME",
      homeTeamName: result.raw.homeTeamName,
      awayTeamName: result.raw.awayTeamName,
      competitionName: result.raw.leagueName,
    },
    previewTokenSecret,
  );
}
