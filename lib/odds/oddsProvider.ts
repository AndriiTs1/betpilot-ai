// Step 5 — provider-neutral request/response contracts and the OddsProvider
// interface itself. See docs/ODDS_PROVIDER_DESIGN.md Sections 4, 6, 7, 10.
//
// Provider-specific identifiers (sport_key, bookmaker key, event/market/
// outcome ID) live ONLY in this file's Provider*Reference types — never in
// lib/odds/domain.ts's CanonicalEvent/CanonicalSelection. This is the seam
// docs/ODDS_PROVIDER_DESIGN.md Section 1 calls "why the core domain must
// not expose The Odds API's sport keys or response shapes."

import type { CanonicalEvent, CanonicalParticipant, CanonicalSelection, MarketType, Period, Sport, SelectionType } from "./domain";
import type { VerificationReasonCode, VerificationResult } from "./verification";

// Only one provider exists today. This union is deliberately a closed set
// (not a bare `string`) so a typo can't silently create a new "provider"
// at compile time — extending it for a second provider is a pure-additive
// change, per docs/ODDS_PROVIDER_DESIGN.md Section 2's "a second provider
// must be addable without touching preview business rules."
export type ProviderName = "THE_ODDS_API";

/* -------------------------------------------------------------------------- */
/* Provider references (never appear on CanonicalEvent/CanonicalSelection)    */
/* -------------------------------------------------------------------------- */

export interface ProviderEventReference {
  readonly provider: ProviderName;
  readonly eventId: string;
  readonly sportKey?: string;
  readonly rawLeagueKey?: string;
}

export interface ProviderMarketReference {
  readonly provider: ProviderName;
  readonly marketId?: string;
  readonly marketKey?: string;
}

export interface ProviderOutcomeReference {
  readonly provider: ProviderName;
  readonly outcomeId?: string;
  readonly outcomeKey?: string;
}

/* -------------------------------------------------------------------------- */
/* Provider response types                                                    */
/* -------------------------------------------------------------------------- */

// `matchMetadata` is intentionally a closed, safe field set — never a
// grab-bag for raw provider payload content (docs/ODDS_PROVIDER_DESIGN.md
// Section 16's "no raw provider response... through a generic error path"
// applies equally to success-path diagnostics).
export interface ProviderEventMatchMetadata {
  readonly score?: number;
  readonly orientation?: "forward" | "backward";
}

export interface ProviderEventCandidate {
  readonly event: CanonicalEvent;
  readonly reference: ProviderEventReference;
  readonly confidence?: number;
  readonly matchMetadata?: ProviderEventMatchMetadata;
}

export interface ProviderOutcome {
  readonly marketType: MarketType;
  readonly period: Period;
  readonly selectionType: SelectionType;
  readonly participant?: CanonicalParticipant;
  readonly line?: string;
  readonly currentOdds: string;
  readonly bookmaker?: string;
  readonly providerTimestamp?: string;
  readonly marketReference?: ProviderMarketReference;
  readonly outcomeReference?: ProviderOutcomeReference;
}

// Success/failure result wrapper for the two discovery-style OddsProvider
// methods (findEvents/getEventMarkets) — verifySelection() does not use
// this wrapper because it always returns a VerificationResult, which
// already carries its own status/reasonCode (docs/ODDS_PROVIDER_DESIGN.md
// Section 10: "Do not throw expected provider/domain failures from the
// public contract. Expected failures should be returned as typed results.")
export type ProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasonCode: VerificationReasonCode; readonly retryable: boolean; readonly message: string };

export interface ProviderHealthResult {
  readonly healthy: boolean;
  readonly provider: ProviderName;
  readonly checkedAt: string;
  readonly latencyMs?: number;
  readonly reasonCode?: VerificationReasonCode;
  readonly diagnosticCode?: string;
}

/* -------------------------------------------------------------------------- */
/* Provider request types                                                     */
/* -------------------------------------------------------------------------- */

export interface FindEventsRequest {
  readonly sport: Sport;
  readonly league?: string;
  readonly participants?: readonly string[];
  readonly query?: string;
  readonly eventStartFrom?: string;
  readonly eventStartTo?: string;
  readonly limit?: number;
}

export interface GetEventMarketsRequest {
  readonly eventReference: ProviderEventReference;
  readonly marketTypes: readonly MarketType[];
  readonly period?: Period;
  readonly region?: string;
  readonly bookmakerPolicy?: BookmakerPolicy;
}

export interface BookmakerPolicy {
  readonly preferred?: string;
  readonly fallback: "any" | "none";
}

// Decimal strings, matching the domain layer's decimal-safety rule — never
// a JS number (docs/ODDS_PROVIDER_DESIGN.md Section 8).
export interface TolerancePolicy {
  readonly absolute?: string;
  readonly percentage?: string;
}

// Modeled now even though confirm-time recheck isn't implemented until a
// later step (docs/ODDS_PROVIDER_DESIGN.md Section 5's "the interface may
// model the context" even before it's used) — purely a request-context
// tag; lib/odds/theOddsApiProvider.ts does not branch on it in Step 5.
export type VerificationContext = "PREVIEW" | "CONFIRM" | "TELEGRAM_LOOKUP" | "MANUAL";

export interface VerifySelectionRequest {
  readonly selection: CanonicalSelection;
  readonly submittedOdds?: string;
  readonly tolerancePolicy?: TolerancePolicy;
  readonly context?: VerificationContext;
  readonly previouslyResolvedEventReference?: ProviderEventReference;
}

/* -------------------------------------------------------------------------- */
/* Capabilities                                                               */
/* -------------------------------------------------------------------------- */

// What a specific adapter instance can honestly do RIGHT NOW — never the
// Support Matrix's future MVP target (docs/ODDS_PROVIDER_DESIGN.md
// Section 11 and the Step 5 task's own explicit "must be conservative"
// instruction). lib/odds/theOddsApiProvider.ts populates this
// conservatively; see that file's own capabilities constant and code
// comments for exactly what evidence backs each field.
export interface OddsProviderCapabilities {
  readonly provider: ProviderName;
  readonly supportedSports: readonly Sport[];
  readonly supportedMarketTypes: readonly MarketType[];
  // false: the adapter does not accept/use a `league` value from the
  // request today — sport-level provider defaults apply unconditionally
  // (e.g. generic football always resolves to EPL). Do not read this as
  // "leagues aren't supported" — read it as "league selection isn't wired
  // up to this adapter's request path yet."
  readonly leagueSelectionSupported: boolean;
  readonly livePrematchSupport: "PREMATCH_ONLY" | "LIVE_AND_PREMATCH";
  readonly eventSearchSupported: boolean;
  readonly eventByIdLookupSupported: boolean;
  readonly regions: readonly string[];
  readonly notes: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* The OddsProvider contract                                                  */
/* -------------------------------------------------------------------------- */

export interface OddsProvider {
  readonly name: ProviderName;

  // No network I/O — a static/config-driven descriptor
  // (docs/ODDS_PROVIDER_DESIGN.md Section 10).
  getCapabilities(): OddsProviderCapabilities;

  findEvents(request: FindEventsRequest): Promise<ProviderResult<readonly ProviderEventCandidate[]>>;

  getEventMarkets(request: GetEventMarketsRequest): Promise<ProviderResult<readonly ProviderOutcome[]>>;

  verifySelection(request: VerifySelectionRequest): Promise<VerificationResult>;

  healthCheck(): Promise<ProviderHealthResult>;
}
