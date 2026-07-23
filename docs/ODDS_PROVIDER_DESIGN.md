# BetPilot AI — Odds Domain and Provider Design

> Status: **Step 4 — analysis-and-documentation-only** (cross-checked against `docs/ODDS_SUPPORT_MATRIX.md` for policy consistency in Step 4A). No production code, Prisma schema, or test files change as part of this document. Every "current" claim below was re-verified against current code during this step (`lib/odds/oddsVerifier.ts`, `lib/betPreview/previewToken.ts`, `lib/bets/createBetFromPreview.ts`, `types/oddsSnapshot.ts`, `prisma/schema.prisma`, and the three preview/confirm routes), not carried over from memory of earlier steps.
>
> **Relationship to `docs/ODDS_SUPPORT_MATRIX.md`**: that document defines product scope and target support (which sports/leagues/markets) and summarizes the same confirmation policy this document details in full — `acceptedOdds` mechanics, the `OddsProvider` contract, and the full domain model are this document's contribution, derived from that scope. Both documents state the same policy; this one is the implementation-level detail.

## 1. Purpose and Scope

This document defines the canonical, provider-neutral **odds domain model** and the **`OddsProvider` contract** the next implementation stage (Step 5+) should build against. It defines:

- a fixed vocabulary for sport, market, period, and selection that every parser output, provider response, and persisted record should eventually converge on;
- the request/response shapes a provider adapter must implement, independent of any specific vendor;
- the verification statuses, reason codes, and confirmation policy that replace today's `NOT_FOUND`/`UNAVAILABLE` conflation (Step 2 audit) and today's fully-permissive confirmation policy (`lib/bets/betSlipRules.ts`'s `canSubmitBetSlip`);
- the persistence shape needed to audit what was actually checked, per bet;
- a staged, no-big-bang migration path from the current concrete `verifyOdds()` implementation to this design.

It intentionally does **not**: implement `OddsProvider` or any adapter, refactor `lib/odds/oddsVerifier.ts`, change parser behavior or its tool schema, change preview/confirm route behavior, modify `prisma/schema.prisma`, or write executable TypeScript beyond illustrative pseudocode signatures where the task explicitly allows them for clarity.

**Why the core domain must not expose The Odds API's sport keys or response shapes**: the Step 2 audit found that `lib/odds/oddsVerifier.ts`'s `SPORT_KEY_ALIASES`, `OddsApiEvent`/`OddsApiMarket`/`OddsApiOutcome` shapes, and the fixed `regions=eu&markets=h2h` request are woven directly into the one function everything else calls. That is exactly why "add a second provider" today means rewriting the file, not implementing an interface — there is no seam. A provider-neutral core is the seam: `CanonicalEvent`, `CanonicalSelection`, and `VerificationResult` (Sections 4, 5, 7) must be expressible without knowing what a `sport_key` is, so a future second adapter only has to translate *into* these shapes, never *for* them.

**Relationship to `docs/ODDS_SUPPORT_MATRIX.md`**: that document is the product-level source of truth for *what* the next MVP should support (Football/Basketball/Tennis/Ice Hockey; Moneyline 2-way/3-way, Totals, Double Chance, BTTS, and Spread for Basketball/Ice Hockey with football's Spread left conditional). This document is the *how* — the domain types and contracts that make those product decisions implementable without hardcoding them the way `oddsVerifier.ts` does today. Every enum and validation rule below is scoped to what the Support Matrix actually asked for; nothing here expands product scope beyond it.

## 2. Design Principles

- **Provider-neutral core.** No file outside a provider adapter package may import or reference a vendor-specific type, key, or endpoint shape.
- **One model for SINGLE and EXPRESS.** `CanonicalSelection` is the same shape whether it's the one selection of a SINGLE bet or one leg of an EXPRESS bet — mirrors the existing, sound `BetSlipSelectionInput`/`ParsedBetSlip` design (`lib/bets/betSlip.ts`), which already gets this right and should not be redesigned, only extended.
- **No implicit sport/league/market assumptions.** No default league (today's `"football"` → `soccer_epl` default), no default market (today's implicit `h2h`-only). An unset `league`/`market` is a value to be resolved or explicitly rejected, never silently substituted.
- **No silent guesses.** Event resolution must surface `AMBIGUOUS_EVENT` rather than picking a highest-scoring candidate with no signal exposed (today's `findMatchingEvent` behavior, Step 2 audit Section 5).
- **Decimal-safe odds.** All odds values that cross a request/response/persistence boundary are decimal strings, never JS `number` — extends the pattern `lib/betPreview/previewToken.ts`'s EXPRESS payload and `lib/bets/expressMath.ts` already use for stake/totalOdds math, to the odds-comparison path itself (today's `oddsVerifier.ts` computes `discrepancyPercent` with plain JS floating-point arithmetic — a real, current gap against this principle, not a hypothetical one).
- **Immutable verification snapshots.** A verification attempt is a fact that happened at a point in time; it is never overwritten in place. Today's `BetSelection.currentOdds`/`oddsStatus` and `OddsSnapshot`'s single row are mutable-in-effect (there is exactly one "current" value); the target model appends a new snapshot per attempt instead (Section 15).
- **Explicit failure reasons.** Every blocking outcome carries a `VerificationReasonCode` distinct enough to separate "not covered yet" from "provider is down" from "ambiguous" — directly resolving the Step 2 audit's confirmed `mapOddsStatus.ts` conflation.
- **Explicit acceptance of changed odds.** `ODDS_CHANGED` never auto-promotes to a confirmable state; `acceptedOdds` stays `null` until a recorded, player-initiated acceptance action sets it.
- **No normal confirmation of unverified selections.** Every reason code except `VERIFIED` (and `ODDS_CHANGED` after explicit acceptance) blocks the standard player confirmation path — a deliberate tightening of today's `canSubmitBetSlip`, which currently allows every status through.
- **A second provider must be addable without touching preview business rules.** `buildBetSlipPreview.ts`'s eventual replacement orchestration logic (parallel per-selection verification, previewToken gating, partial-failure handling) must depend only on the `OddsProvider` interface, never on `TheOddsApiProvider` or The Odds API's response shape.

## 3. Canonical Enumerations

### Sport

```
FOOTBALL
BASKETBALL
TENNIS
ICE_HOCKEY
AMERICAN_FOOTBALL
UNKNOWN
```

Only the four MVP-required sports from the Support Matrix get dedicated members, plus `AMERICAN_FOOTBALL` (deferred at the product level, but already fully mapped in `oddsVerifier.ts` today — keeping it as a named enum member, not `UNKNOWN`, costs nothing and avoids re-litigating the mapping if the pending product decision on NFL/dashboard inclusion resolves in favor of it).

**Deferred sports (Baseball, Volleyball, Golf, Esports, MMA/Boxing, Cricket, Rugby) belong in `UNKNOWN`, not as dedicated members, at this stage.** Reasoning: the Support Matrix found these have UI icons (`sportIcons.tsx`) but zero provider mapping — adding them as named `Sport` enum members before any provider can verify them would recreate exactly the "parser/UI recognition presented as support" conflation Section 1 exists to prevent. Adding a member later is a pure-additive, low-risk change (the enum is a closed set consumed by validation and capability-matching logic, not a value baked into persisted rows in a way that would need backfilling); prematurely encoding an unverifiable sport is the higher-risk direction.

### MarketType

```
MONEYLINE_2WAY
MONEYLINE_3WAY
DOUBLE_CHANCE
TOTALS
SPREAD
BOTH_TEAMS_TO_SCORE
DRAW_NO_BET
TEAM_TOTAL
EXACT_SCORE
PLAYER_PROP
OUTRIGHT
UNKNOWN
```

`DRAW_NO_BET`, `TEAM_TOTAL`, `EXACT_SCORE`, `PLAYER_PROP`, `OUTRIGHT` are included in the enum (per the Support Matrix's own canonical taxonomy) even though all five are `DEFERRED`/out-of-MVP — the enum is the full taxonomy the domain model can *name*; the Support Matrix's per-market MVP status governs what the capabilities model (Section 11) and confirmation policy (Section 8) actually allow through. Naming a deferred market is not the same as supporting it — the same distinction Section 1 draws for sports.

### Period

```
FULL_GAME
REGULATION
FIRST_HALF
SECOND_HALF
FIRST_QUARTER
MATCH
SET
UNKNOWN
```

`REGULATION` exists specifically so **ice hockey's regulation-time 3-way market and full-game 2-way market are never conflated** (Support Matrix Section 6) — a `CanonicalSelection` with `sport: ICE_HOCKEY, marketType: MONEYLINE_3WAY` must carry `period: REGULATION`, never `FULL_GAME`, and a `MONEYLINE_2WAY` for the same fixture must carry `FULL_GAME` (including OT/shootout) — these are two different selections against two different (period, market) pairs, not one market with two labels.

Deliberately **not** included: `THIRD_QUARTER`, `OVERTIME`, `SECOND_SET`, or any more granular period. These only become meaningful once a period-scoped market (a deferred, `PLAYER_PROP`/`TEAM_TOTAL`-adjacent concept) is actually in scope — adding them now would be over-modeling ahead of evidence, the same anti-pattern Section 3's `Sport` reasoning avoids.

### SelectionType

```
HOME
DRAW
AWAY
PARTICIPANT
HOME_OR_DRAW
DRAW_OR_AWAY
HOME_OR_AWAY
OVER
UNDER
YES
NO
```

- `HOME`/`AWAY`/`DRAW` — used when the event's participants have structural home/away roles (team sports: football, basketball, hockey, NFL). "Home" here is a **structural label matching the provider's own home/away convention** (mirrors today's `resolveTeamOrder`'s forward/backward orientation, Step 2 audit Section 5) — it is never a claim about which team has home advantage, which matters for neutral-venue fixtures.
- `PARTICIPANT` — used when the event's participants are named individuals or entities rather than home/away roles (tennis singles today; any future individual-participant sport). **Requires `participant` (name, plus `participantId` when the provider candidate supplies one) to be set** — a `PARTICIPANT` selection with no participant identity is invalid input, never resolved positionally.
- `HOME_OR_DRAW` / `DRAW_OR_AWAY` / `HOME_OR_AWAY` — the three, and only three, canonical Double Chance combinations (mirrors today's `normalizeSelectionToEnglish.ts` display labels exactly, now made structurally real instead of cosmetic).
- `OVER` / `UNDER` — require `line` to be set (Totals, Team Total).
- `YES` / `NO` — used for Both Teams to Score; requires no `participant`/`line`.

**When `participant`/`line`/`side` are required** (elaborated fully in Section 5's validation table): `participant` is required for `PARTICIPANT` and for `SPREAD` (the side the line applies to); `line` is required for `TOTALS`, `SPREAD`, `TEAM_TOTAL`; neither is required or permitted for `HOME`/`DRAW`/`AWAY`/`YES`/`NO`/the three Double Chance values.

### VerificationStatus

```
VERIFIED
ODDS_CHANGED
FAILED
NOT_CHECKED
```

Kept deliberately small. **Detailed causes live in `VerificationReasonCode` (below), not in an ever-expanding `VerificationStatus`**, for the same reason `docs/ODDS_SUPPORT_MATRIX.md` Section 9 recommended a small public surface: the confirmation policy (Section 8) and every UI consumer only need to answer "is this confirmable, confirmable-with-acceptance, or blocked" — that's a 3-4-way branch. Reason codes exist for logging, operator tooling, and precise product decisions about *why* something is blocked, which is a different audience and a different (larger, more volatile) vocabulary than the one a status enum consumed by every UI branch should carry.

### VerificationReasonCode

```
NONE
EVENT_NOT_FOUND
MARKET_NOT_SUPPORTED
SELECTION_NOT_FOUND
SPORT_NOT_SUPPORTED
LEAGUE_NOT_SUPPORTED
PROVIDER_UNAVAILABLE
PROVIDER_TIMEOUT
PROVIDER_RATE_LIMITED
PROVIDER_INVALID_RESPONSE
AMBIGUOUS_EVENT
INVALID_INPUT
ODDS_OUTSIDE_TOLERANCE
NOT_CHECKED
```

| Reason code | Classification |
|---|---|
| `NONE` | Success — pairs only with `VERIFIED` |
| `EVENT_NOT_FOUND` | Matching failure — coverage exists (sport/league/market all supported) but this specific fixture wasn't found |
| `MARKET_NOT_SUPPORTED` | Coverage failure — not retryable; retrying doesn't change provider coverage |
| `SELECTION_NOT_FOUND` | Matching failure — the market/event were found, the specific outcome wasn't |
| `SPORT_NOT_SUPPORTED` | Coverage failure — not retryable |
| `LEAGUE_NOT_SUPPORTED` | Coverage failure — not retryable |
| `PROVIDER_UNAVAILABLE` | Provider failure — retryable (bounded, Section 17) |
| `PROVIDER_TIMEOUT` | Provider failure — retryable (bounded) |
| `PROVIDER_RATE_LIMITED` | Provider failure — retryable only after backoff; also an observability signal (Section 17) |
| `PROVIDER_INVALID_RESPONSE` | Provider failure — retryable cautiously; may indicate a provider schema change and should be logged distinctly from a plain timeout, since repeated occurrences need human attention, not just a retry loop |
| `AMBIGUOUS_EVENT` | Matching failure — not retryable without more input (e.g. a `league` or narrower `eventStartTime` window) |
| `INVALID_INPUT` | Input failure — not retryable without correcting the input itself |
| `ODDS_OUTSIDE_TOLERANCE` | Comparison outcome, not a failure — pairs with `ODDS_CHANGED`, not `FAILED` |
| `NOT_CHECKED` | No attempt made — pairs only with `NOT_CHECKED` status; not an error, a state |

`VerificationStatus`-to-`VerificationReasonCode` pairing: `VERIFIED` ↔ `NONE`. `ODDS_CHANGED` ↔ `ODDS_OUTSIDE_TOLERANCE`. `NOT_CHECKED` ↔ `NOT_CHECKED`. `FAILED` ↔ any of the remaining eleven codes.

## 4. Canonical Event Model

```
CanonicalEvent
  sport: Sport                          — required
  league: League | null                 — required when the sport's capability model has leagues (Section 11); see below
  leagueId: string | null               — stable machine key (e.g. "EPL"), optional until a League lookup exists
  eventName: string | null              — display/log convenience only, never used for matching once participants exist
  participants: Participant[]           — required, ordered; the general-purpose representation
  homeParticipant: Participant | null   — derived accessor, only meaningful for home/away-structured sports
  awayParticipant: Participant | null   — derived accessor, same caveat
  eventStartTime: DateTime | null       — required for MVP resolution (Section 9); "unsafe to guess" below
```

`providerEventId` and `providerName` are **deliberately absent from `CanonicalEvent` itself** — they belong only in `ProviderEventCandidate` (Section 7, the resolution-time response) and in persisted `ProviderReference` rows (Section 15). `CanonicalEvent` is what the domain layer reasons about *before and after* talking to any provider; provider identifiers are what a specific adapter call *returns*, and they must not leak upstream into request construction or into any type a second provider's adapter would have to fabricate a fake value for.

**Which fields belong in the core request** (Section 6's `FindEventsRequest`/`GetEventMarketsRequest`): `sport`, `league` (when known), `participants` (as free-text names at request time — normalization happens during resolution, Section 9), `eventStartTime` (when known, to narrow the candidate window). **Which belong only in snapshots/adapters**: `providerEventId`, `providerName`, and any provider-specific match-confidence internals.

**Tennis and other non-home/away sports**: represented purely through `participants: Participant[]` (2 entries for singles). `homeParticipant`/`awayParticipant` are `null` for tennis — never populated by convention or by arbitrarily picking `participants[0]`/`participants[1]` as "home"/"away," which would fabricate a distinction the sport doesn't have. Any selection against a tennis event uses `SelectionType.PARTICIPANT`, never `HOME`/`AWAY` (Section 3).

**Home/away should be optional, derived roles over ordered `participants`, not independently-set fields.** Recommendation: `homeParticipant`/`awayParticipant` are computed accessors (`participants[0]`/`participants[1]` for sports whose capability model declares `hasHomeAwayStructure: true`), never separately assignable — this prevents the two representations from ever disagreeing with each other, a class of bug the current codebase doesn't have (today there's only one representation) but that a naive two-field design would introduce.

**Unsafe to guess**: `league` (Support Matrix Section 7 — must not fall back to a default league); `eventStartTime` (must come from a resolved provider candidate, never defaulted to "now" or left silently absent when the resolution process needs it for disambiguation, Section 9); participant identity for a `PARTICIPANT` selection when multiple same-surname/ambiguous participants exist in the candidate data (must surface `AMBIGUOUS_EVENT` or a selection-level equivalent rather than picking one).

## 5. Canonical Market and Selection Model

```
CanonicalSelection
  selectionId: string            — required; a stable per-leg identifier (does not exist today — each
                                    EXPRESS leg is purely array-positional in ParsedBetSlip/BetSlipSelectionInput)
  sport: Sport                   — required
  league: League | null          — required once known; never substituted by sport (see below)
  event: EventReference          — required; either free-text (pre-resolution) or a resolved
                                    CanonicalEvent/ProviderEventCandidate reference (post-resolution)
  marketType: MarketType         — required
  period: Period                 — required (defaults to FULL_GAME/MATCH per sport when not period-scoped)
  selectionType: SelectionType   — required
  participant: Participant | null— conditionally required, see validation rules
  line: DecimalString | null     — conditionally required, see validation rules
  submittedOdds: DecimalString | null — as today (nullable: a player can omit odds for a leg)
```

**Validation rules**:

| Market | Permitted `selectionType` | `participant` | `line` |
|---|---|---|---|
| `MONEYLINE_2WAY` | `HOME`/`AWAY` (team sports) or `PARTICIPANT` ×2 (individual sports) — **never `DRAW`** | Required only for `PARTICIPANT` | Not permitted |
| `MONEYLINE_3WAY` | `HOME`/`DRAW`/`AWAY` only | Not permitted | Not permitted |
| `DOUBLE_CHANCE` | `HOME_OR_DRAW`/`DRAW_OR_AWAY`/`HOME_OR_AWAY` only — no other combination | Not permitted | Not permitted |
| `TOTALS` | `OVER`/`UNDER` only | Not permitted | **Required** |
| `SPREAD` | `HOME`/`AWAY`/`PARTICIPANT` (whichever side the sport uses) | **Required** — the line is always expressed relative to the named participant/side (e.g. `participant: TeamA, line: -1.5` means TeamA −1.5) | **Required** |
| `BOTH_TEAMS_TO_SCORE` | `YES`/`NO` only | Not permitted | Not permitted |
| `TEAM_TOTAL` (deferred) | `OVER`/`UNDER` | Required (which team's total) | Required |
| `DRAW_NO_BET`, `EXACT_SCORE`, `PLAYER_PROP`, `OUTRIGHT` (deferred) | Not modeled to selection-type granularity yet — out of MVP scope, see Support Matrix Section 11 | — | — |
| `UNKNOWN` | Any (unclassified) | — | — |

Additional rules, stated explicitly per the task:

- **`league` cannot be replaced by `sport`.** A `CanonicalSelection` with `league: null` for a sport whose capability model requires a league (football, per the Support Matrix's EPL-default finding) must resolve to `LEAGUE_NOT_SUPPORTED`/`AMBIGUOUS_EVENT` rather than defaulting — there is no fallback league constant anywhere in this design.
- **Participant winner selections must preserve participant identity.** A `PARTICIPANT` selection carries at minimum a `name`, and a `participantId` once resolution has occurred (Section 9) — never resolved by list position alone.
- **`UNKNOWN` market cannot be provider-verified or confirmed in the normal flow.** No `FindEventsRequest`/`GetEventMarketsRequest` is ever issued for `marketType: UNKNOWN` (Section 6); it resolves directly to `FAILED`/`MARKET_NOT_SUPPORTED` without a network call, and per Section 8's confirmation policy, `MARKET_NOT_SUPPORTED` is blocking.

## 6. Provider Request Contract

Three separate operations, not one monolithic method — discovery, market retrieval, and verification are genuinely different concerns with different callers (a future Telegram lookup needs only discovery; preview/confirm need full verification; a hypothetical "refresh this already-matched event's board" needs only market retrieval).

### `FindEventsRequest`

```
sport: Sport                     — required
league: League | null            — optional but strongly recommended when known
participants: string[] | null    — optional, free-text names (pre-normalization)
eventStartFrom: DateTime | null  — optional window start
eventStartTo: DateTime | null    — optional window end
query: string | null             — optional free-text fallback, for future NL search
limit: number                    — default small (e.g. 10)
```

Used by discovery-only callers: a future Telegram odds-lookup command, future natural-language odds queries.

### `GetEventMarketsRequest`

```
providerEventReference: opaque   — required; obtained from a prior FindEvents resolution
marketTypes: MarketType[]        — required; never "give me everything"
period: Period | null            — optional, defaults to the sport's primary period
region: string | null            — provider-specific (today: "eu"), passed through, never hardcoded in the domain layer
bookmakerPolicy: BookmakerPolicy — e.g. { preferred: "pinnacle", fallback: "any" } — makes today's
                                    hardcoded pickBookmaker() Pinnacle-preference an explicit, overridable policy
```

Used once an event is already resolved — retrieves prices for specific markets only.

### `VerifySelectionRequest`

```
selection: CanonicalSelection            — required
submittedOdds: DecimalString             — required
tolerancePolicy: TolerancePolicy | null  — optional override of the default (Section 8)
context: { playerId, previewId }         — for logging/audit correlation only, never sent to the provider
priorEventReference: opaque | null       — optional; skips re-resolution on a confirm-time recheck of an
                                            already-resolved event (Section 9/13)
```

Used by preview and confirm-time recheck — composes discovery (unless `priorEventReference` is given) + market retrieval + comparison into one result.

**What the current The Odds API adapter can support immediately vs. what needs new provider functionality**: The Odds API has exactly one relevant endpoint (`/sports/{sport_key}/odds`) that always returns the full odds board for a sport_key — it has no dedicated event-search or event-by-ID endpoint. This means `GetEventMarketsRequest` and the discovery half of `FindEventsRequest` map onto the **same underlying HTTP call** in the adapter (fetch the board, then either return it as candidates or filter it to one matched event) — exactly what `fetchOddsForSport()` + `findMatchingEvent()` already do today, just now expressed as two interface methods backed by one shared fetch. `VerifySelectionRequest` is a direct translation of what `verifyOdds()` does today end-to-end. **Capability discovery (Section 11) is not a live endpoint The Odds API exposes** — it must be a static, hand-maintained descriptor in the adapter, not a real API call. This is a known, explicit limitation of this specific provider, not a gap in the interface design.

## 7. Provider Response Contract

### `ProviderEventCandidate`

```
sport, league, participants, eventStartTime   — the CanonicalEvent fields this candidate represents
providerEventReference: opaque                — required; the only provider identifier the domain layer retains
confidence: number                            — the resolution score (Section 9)
matchOrientation: "forward" | "backward" | null — preserved from today's resolveTeamOrder concept
```

### `ProviderOutcome`

```
marketType: MarketType
period: Period
selectionType: SelectionType
participant: Participant | null
line: DecimalString | null
currentOdds: DecimalString
bookmaker: string
providerTimestamp: DateTime | null   — when the provider itself last updated this price; The Odds API does
                                        not expose this today (a known, honestly-flagged current gap)
providerOutcomeReference: opaque | null
```

### `VerificationResult`

```
status: VerificationStatus
reasonCode: VerificationReasonCode
submittedOdds: DecimalString
currentOdds: DecimalString | null
acceptedOdds: DecimalString | null        — see below
differencePercent: DecimalString | null
matchedEvent: ProviderEventCandidate | null
matchedMarket: MarketType | null
matchedOutcome: ProviderOutcome | null
provider: string
bookmaker: string | null
providerEventReference: opaque | null
providerMarketReference: opaque | null
providerOutcomeReference: opaque | null
checkedAt: DateTime                       — our own timestamp
providerTimestamp: DateTime | null
retryable: boolean                        — derived from reasonCode (Section 3's classification table)
publicMessage: string                     — a short message KEY (e.g. "odds.market_not_supported"), never
                                             raw provider text
diagnostics: DiagnosticMetadata           — server-only, bounded (Section 16) — never sent to the client
```

**`acceptedOdds` may remain `null` until explicit acceptance.** On `VERIFIED`, the verification step itself sets `acceptedOdds = currentOdds` (per the task's explicit instruction — this is the one case where acceptance is automatic, because there is nothing to accept: the player's number and the provider's number already agree within tolerance). On `ODDS_CHANGED`, `VerificationResult.acceptedOdds` is **always `null`** — it is populated only by a separate, later "accept" action (Section 12), never by the verification call that produced the `ODDS_CHANGED` status.

## 8. Odds Comparison Policy

- **Decimal-string inputs only, no native floating-point arithmetic.** `submittedOdds`/`currentOdds` are compared as decimals (e.g. via `Prisma.Decimal` or an equivalent arbitrary-precision type), matching `lib/bets/expressMath.ts`'s existing convention. **Current gap against this principle**: `oddsVerifier.ts`'s `discrepancyPercent = Number((((bet.odds - price) / price) * 100).toFixed(2))` performs this in plain JS floating-point today — flagged here as a target-state correction, not fixed in this step (`oddsVerifier.ts` is explicitly out of scope).
- **Percentage comparison as the MVP default**, matching today's `ODDS_TOLERANCE_PERCENT = 3` convention — familiar, already proven in production, already covered by 18+ tests. Absolute-difference comparison is noted as a real future consideration (a 3% move matters differently at 1.02 vs. 3.09), but recommend deferring a dual-mode policy until there's product evidence it's needed — don't build it speculatively.
- **Tolerance should be configurable by policy, not a single hardcoded constant** — recommend market-type-scoped at minimum (a policy object keyed by `MarketType`, defaulting to one global value for MVP parity with today), not per-provider (no current evidence two providers would need different tolerances for the same market) and not per-request-arbitrary (would make behavior unpredictable/untestable). The important structural change from today is that the tolerance is a **named, swappable config value the comparison function receives**, not a module-level constant buried inside the comparison logic the way `ODDS_TOLERANCE_PERCENT` is today.
- **Rounding**: compare at full decimal precision; round only `differencePercent` for display/storage, to 2 decimal places (matches today's `.toFixed(2)`).
- **Boundary behavior**: `abs(differencePercent) <= tolerance` → `VERIFIED` (today's exact inclusive `<=`) — keep inclusive, avoids a confusing "exactly at the limit" rejection.
- **Null/malformed odds**: a missing `submittedOdds` means the selection is `NOT_CHECKED` (mirrors today's `submittedOdds !== null` gate in `buildBetSlipPreview.ts`) — never treated as 0 or silently skipped. A malformed decimal string is rejected as `INVALID_INPUT` **before** any comparison is attempted — never leniently parsed.
- **Movement direction**: recommend retaining it as derivable diagnostic data (the sign of `differencePercent` already carries it) rather than a new dedicated persisted field — useful for a future policy decision (e.g. "only block if odds moved against the player") but not required for MVP UI or persistence.

## 9. Event Resolution and Ambiguity

A deterministic resolution process, replacing today's single-pass `findMatchingEvent`:

1. **Validate sport/league** against the resolved provider's capabilities (Section 11) — reject immediately with `SPORT_NOT_SUPPORTED`/`LEAGUE_NOT_SUPPORTED`, **zero network calls**, before any request is issued.
2. **Identify a candidate time window** — use `eventStartTime` if known (a tight window); otherwise a bounded forward-looking default window (e.g. "next N days") — **never an unbounded "any time" search**, which is exactly what invites the "which round of fixtures" ambiguity a wide-open board search creates.
3. **Normalize participants** — reuse today's `normalizeTeamName`/`TEAM_ALIASES` concept, promoted to a provider-neutral, domain-layer table (not buried inside the adapter, since alias needs don't depend on which provider is behind the request).
4. **Retrieve candidates** via the provider's discovery operation.
5. **Score candidates** — reuse today's word-overlap concept (`overlapScore`), but require the resolver to keep the **full ranked list**, not just the single winner today's `findMatchingEvent` returns.
6. **Reject ambiguity** — if the top two candidates' scores are within a configured delta of each other (recommend starting at **0.10–0.15**, tunable), return `AMBIGUOUS_EVENT` rather than picking the higher score. **This explicitly replaces today's silent "first highest score wins" behavior** (Step 2/3 audit's confirmed gap) — it must not be carried into the target design.
7. **Retain the provider event reference** on the `VerificationResult`/snapshot once resolved, so a confirm-time recheck (Section 13/14) can pass it as `priorEventReference` and skip re-resolution — reducing both latency and repeated ambiguity risk on the same, already-settled fixture.

Specific parameters:

- **Minimum confidence**: keep today's `EVENT_MATCH_THRESHOLD = 0.5` as the MVP starting point — proven in production with dedicated test coverage; revisit only with evidence.
- **Ambiguity delta**: a new concept (0.10–0.15 recommended starting value) — must be a named, tunable constant, not implied by the absence of a check.
- **Required time checks**: any candidate whose `eventStartTime` has already passed is **excluded from candidacy entirely**, not merely deprioritized — this closes the gap (flagged in `docs/ODDS_SUPPORT_MATRIX.md` Section 10) where nothing today prevents matching an in-progress or finished event's stale price against a bet the product treats as pre-match.
- **Reversed participant order**: preserve today's forward/backward scoring exactly (`resolveTeamOrder`'s proven logic, Step 2 audit Section 5) — carried into the canonical resolver unchanged in spirit, not redesigned.
- **Multilingual aliases**: preserve and extend today's `TEAM_ALIASES` table, promoted to the domain layer (Step 3).
- **Unsplittable event input**: preserve today's whole-string-overlap fallback, but treat it as inherently lower-confidence — cap it below the auto-accept threshold so it is always routed through the ambiguity check, since it carries less structural signal than a cleanly split two-participant comparison.
- **Multiple competitions with similar fixtures**: this is precisely why `league` must be a real, populated input whenever available (Section 4/7) — if two different competitions have a same-named-team fixture on the same day and `league` is unknown, the resolver must surface `AMBIGUOUS_EVENT` rather than guess between them.

## 10. Provider Interface Shape

Conceptual signatures — pseudocode only, not implementation:

```
interface OddsProvider {
  getCapabilities(): ProviderCapabilities
  findEvents(request: FindEventsRequest): ProviderEventCandidate[]
  getEventMarkets(request: GetEventMarketsRequest): ProviderOutcome[]
  verifySelection(request: VerifySelectionRequest): VerificationResult
  healthCheck(): { ok: boolean, latencyMs: number, message: string }
}
```

| Method | Responsibility | I/O | Failure behavior | Caching |
|---|---|---|---|---|
| `getCapabilities()` | Static/config-driven descriptor (Section 11) | No network I/O required | Should not fail — a misconfigured adapter fails at construction, not per-call | Cacheable indefinitely per deploy |
| `findEvents()` | Discovery only | Network I/O | Returns an empty candidate list on no matches; provider errors surface as a thrown/returned failure the caller maps to `PROVIDER_*` reason codes | Short-TTL (mirrors today's 45s cache) |
| `getEventMarkets()` | Market/price retrieval for an already-identified event | Network I/O | Same failure shape as `findEvents()` | Same short-TTL tier |
| `verifySelection()` | Composes capability check → (`findEvents` unless `priorEventReference`) → `getEventMarkets` → comparison (Section 8) | Network I/O (unless fully short-circuited by cache) | Returns a `VerificationResult` with a `FAILED`/`NOT_CHECKED` status and reason code — **never throws for an expected business outcome**, only for genuine adapter-level bugs | **Not cacheable itself** — always composed fresh from its cacheable sub-calls, since a stale `VerificationResult` is exactly the "silently trust an old price" failure mode this design exists to prevent |
| `healthCheck()` | Circuit-breaker/observability input (Section 17) | Network I/O | Returns `ok: false` rather than throwing | Not on the hot path of a normal preview |

**Layer separation**:

- **Domain interface** — `OddsProvider` above. Pure contract; imports nothing vendor-specific.
- **Provider adapter** — `TheOddsApiProvider implements OddsProvider`. Owns every The-Odds-API-specific concern: `sport_key` aliasing, the fixed `regions=eu&markets=h2h` request shape, its response JSON structure. This is where today's `oddsVerifier.ts` logic relocates to, in the migration plan (Section 18), not into the domain layer.
- **Provider registry/resolver** — a thin `getProvider(name?: string): OddsProvider` lookup. Trivial for MVP (exactly one registered provider) — exists only so "add a second provider" (a Section 2 design goal) isn't blocked later. **Must not be over-built now**: no dynamic multi-provider routing/fallback logic is justified until there's an actual second provider to route between.
- **Verification orchestration service** — `OddsVerificationService`, the new home for what `buildBetSlipPreview.ts` currently does inline (`Promise.allSettled` over per-selection `verifyOddsFn` calls). Depends only on `OddsProvider`. `buildBetSlipPreview.ts`'s eventual dependency is on this service, never on any concrete provider (Section 2's stated goal, made concrete here).

## 11. Provider Capabilities Model

A static-per-adapter descriptor (not necessarily a live provider call — see Section 6's note that The Odds API has no capability-discovery endpoint):

```
ProviderCapabilities
  supportedSports: Sport[]
  supportedLeagues: Map<Sport, League[]>
  supportedMarkets: Map<Sport, MarketType[]>        — not every market applies to every sport
                                                       (Support Matrix Section 6's compatibility table)
  supportedPeriods: Map<MarketType, Period[]>
  supportedRegions: string[]
  livePrematchSupport: "PREMATCH_ONLY" | "LIVE_AND_PREMATCH"   — TheOddsApiProvider: PREMATCH_ONLY
  bookmakerCoverage: string                          — descriptive (e.g. "eu region, Pinnacle-preferred")
  eventSearchSupport: boolean                        — TheOddsApiProvider: false (board-fetch+filter, no
                                                         dedicated search endpoint)
  eventByIdLookupSupport: boolean
  rateLimits: RateLimitDescriptor | null              — unknown for The Odds API's current plan; left null/
                                                         to-be-configured rather than fabricated
```

**How the system rejects unsupported requests before consuming provider quota**: `OddsVerificationService` checks the request's `(sport, league, marketType, period)` tuple against the resolved provider's `getCapabilities()` result **synchronously, in-process**, before calling `findEvents`/`getEventMarkets`. An unsupported combination short-circuits directly to the matching reason code (`SPORT_NOT_SUPPORTED`/`LEAGUE_NOT_SUPPORTED`/`MARKET_NOT_SUPPORTED`) with **zero network calls**. This is a direct generalization of what `oddsVerifier.ts:447-449` already does today for sport alone (`getSportKeys(bet.sport) === null` → early return) — the target design extends the same pattern to league, market, and period.

## 12. Confirmation State Model

A trimmed lifecycle — not every state the task lists needs to be independently persisted; `CONFIRMABLE` in particular is better modeled as a **computed predicate**, not a stored state, to avoid a state that could drift out of sync with the fields it's derived from.

```
PARSED → VALIDATED → CHECK_PENDING → { VERIFIED | ODDS_CHANGED | FAILED | NOT_CHECKED }
                                            │
                              (ODDS_CHANGED only) → ACCEPTED
                                            │
                     [CONFIRMABLE — computed: status ∈ {VERIFIED, ACCEPTED} AND
                                    acceptedOdds is set AND not stale]
                                            │
                          RECHECK_REQUIRED → RECHECKED → CONFIRMED
                                            │
                                          FAILED (terminal, no path forward without a new preview cycle)
```

- **`PARSED`**: raw parser output, not yet structurally validated against Section 5's rules.
- **`VALIDATED`**: passed `CanonicalSelection` structural validation — ready to attempt verification.
- **`CHECK_PENDING`**: verification in flight. For MVP's synchronous-per-preview-request model this is transient (not meaningfully persisted); it remains a real state in the model because it's the natural extension point if verification ever becomes async/queued.
- **`VERIFIED`**: `currentOdds` exists; `acceptedOdds` is auto-set to `currentOdds` (Section 7); **confirmation is allowed only after a confirm-time recheck** (Section 13) — being `VERIFIED` at preview time is necessary but not sufficient for `CONFIRMED`.
- **`ODDS_CHANGED`**: `currentOdds` exists; `acceptedOdds` **remains `null`** until an explicit, recorded player acceptance action sets `acceptedOdds = currentOdds` and transitions the selection to `ACCEPTED`. A confirm-time recheck is still required even after `ACCEPTED` — the price can move again between acceptance and confirm.
- **`FAILED` / `NOT_CHECKED`**: normal player confirmation is blocked, with no computed path to `CONFIRMABLE`. The only way forward is a fresh preview cycle (new parse/verify attempt) or the manual override pathway below — never a direct state mutation of the same failed attempt.

**Manual operator override** — a separate pathway, not a state on this lifecycle:

- Modeled as its own concept (e.g. a conceptual `ManualOddsOverride` record, not a Prisma change in this step) storing: `operatorId`, `reason` (free text, required, non-empty), `timestamp`, `submittedOdds`, `overrideAcceptedOdds` (the operator-accepted price, which may differ from any provider price since the provider may have returned nothing at all).
- **Must never write `VerificationStatus.VERIFIED`** — doing so would misrepresent an operator's manual judgment call as a provider-confirmed price. Instead, a persisted `confirmationMethod: PROVIDER_VERIFIED | MANUAL_OVERRIDE` field (Section 15) keeps every `CONFIRMED` bet's history honest about *how* it reached that state.
- Explicitly future scope — this design only reserves the concept and its non-negotiable constraint (never masquerade as `VERIFIED`); it is not built in Step 4 or implied to be built in Step 5 (Section 21).

## 13. SINGLE and EXPRESS Orchestration

One shared model, extending `lib/bets/betSlip.ts`'s already-correct `ParsedBetSlip`/`BetSlipSelectionInput` pattern rather than replacing it:

```
BetDraft
  type: "SINGLE" | "EXPRESS"
  selections: CanonicalSelection[]
  stake: DecimalString
  combinedOdds: { submittedTotal: DecimalString | null, acceptedTotal: DecimalString | null }
  verificationSummary: { allConfirmable: boolean, anyBlocking: boolean, worstStatus: VerificationStatus }
```

- **Every leg is verified independently, in parallel** — preserve today's `Promise.allSettled` concurrency model exactly (Step 2 audit found it sound); no change to this part of the design.
- **Combined odds**: `submittedTotal` is computed from `submittedOdds` as soon as every leg has one — this supports the existing fast, early preview display (today's UX, worth preserving) and exists purely for **display/comparison**, not for confirmation eligibility. **`acceptedTotal` — the only total that may back a confirmable token — is computed exclusively from `acceptedOdds`**, recomputed once every leg reaches a terminal accepted state (`VERIFIED` or `ACCEPTED`). It is never computed from `currentOdds` directly (current odds alone doesn't reflect explicit acceptance) and **never silently retains `submittedOdds` as `acceptedOdds` after a leg's price has changed** — directly satisfying the task's explicit instruction.
- **Token issuance rule (tightened vs. today)**: no EXPRESS token is redeemable unless **every leg has a non-null `acceptedOdds` and no leg carries a blocking `reasonCode`**. This directly fixes the Step 3 audit's confirmed gap where today's `buildBetSlipPreview.ts:138,179` gates EXPRESS token issuance only on every leg having a non-null *submitted* odds — meaning a fully `UNAVAILABLE` EXPRESS slip can be confirmed today. Under this design it cannot.
- **Partial failures**: a leg with a blocking status keeps the whole slip out of the computed `CONFIRMABLE` predicate, but every leg's individual status is still shown in preview (preserves today's per-leg display, which is correct and unaffected) — the change is only in what's redeemable, not what's rendered.
- **Confirm-time recheck**: every leg gets a fresh `verifySelection()` call at confirm time, using the retained `providerEventReference` (Section 9) to skip re-resolution. If any leg's recheck produces a new blocking status or a new `ODDS_CHANGED` requiring re-acceptance, **confirm fails for the whole slip atomically** — recommend keeping EXPRESS confirmation all-or-nothing (symmetrical with `createBetFromPreview.ts`'s existing atomic nested-create transaction), rather than introducing a partial-confirm model without stronger product evidence for it.
- **Maximum concurrency**: bounded naturally by `MAX_EXPRESS_SELECTIONS = 10` (existing constant, `lib/bets/betSlipRules.ts`) — no additional client-side throttling needed at current product scale.
- **Provider request deduplication**: legs sharing the same `(sport, league, timeWindow)` should share one `findEvents`/`getEventMarkets` fetch — already effectively true today via the 45s process-level cache keyed by `sportKey`; recommend keeping that caching tier (Section 17) but re-keying it on the canonical `(sport, league, timeWindow)` tuple instead of a raw provider `sportKey`, so the caching concern itself becomes provider-neutral.

## 14. Preview Token Design

**Current token fields** (fully re-read from `lib/betPreview/previewToken.ts` this step): SINGLE (`PreviewTokenPayload`) carries `sport/event/outcome/stake/odds/totalOdds` plus a minimal `oddsCheck: {matched, withinTolerance, sourceOdds, bookmaker}`. EXPRESS (`ExpressPreviewTokenPayload`) carries `stake/totalOdds/potentialWin` plus per-selection `{sport, event, outcome, market, submittedOdds, currentOdds, oddsStatus}` as decimal strings — notably **no bookmaker or discrepancy on the EXPRESS shape at all**, and neither shape has any provider reference, `checkedAt`, or acceptance-tracking field.

**Target token contents**:

```
AnyPreviewTokenPayload (SINGLE | EXPRESS, unchanged discriminated-union shape)
  playerId, previewId, issuedAt, expiresAt   — unchanged
  selections: CanonicalSelection[]           — the full canonical selection, not raw sport/event/outcome
                                                strings, so a redeemed token is self-describing against the
                                                domain model, not just against whatever the provider returned
  submittedOdds, currentOdds, acceptedOdds   — all three, per selection (today only submittedOdds/currentOdds
                                                exist; acceptedOdds is new)
  reasonCode                                 — per selection
  providerEventReference / providerMarketReference / providerOutcomeReference  — opaque, needed so a
                                                confirm-time recheck can skip re-resolution (Section 9/13)
  checkedAt, providerTimestamp
  oddsAcceptanceVersion: { acceptedAt: DateTime } | null   — required before acceptedOdds may be trusted at
                                                confirm time; makes the "accept" action auditable, not just a
                                                UI-only gesture that leaves no trace
```

**What can safely be trusted from the token**: player identity (`playerId`, HMAC-protected against tampering) and the fact that an acceptance action occurred (if `oddsAcceptanceVersion` is present and the token is unexpired) — because the token is signed, its contents can't be forged client-side.

**What must always be reloaded/rechecked**: `currentOdds` and verification status — the token's `currentOdds` is a snapshot of "what the provider said at preview time," never a guarantee of "what the provider says now," regardless of how recently the token was issued.

**What becomes invalid after `ODDS_CHANGED`**: a token issued while a selection is `ODDS_CHANGED`, with no `oddsAcceptanceVersion`, must **not be redeemable for confirm at all** — confirm rejects it (a distinct failure from expiry) until a new preview cycle captures explicit acceptance and reissues the token. This is the token-level enforcement of Section 13's redeemability gate.

**Why confirm-time provider recheck remains necessary even with HMAC signing**: HMAC signing proves the token's contents weren't altered client-side after issuance — it proves nothing about whether the *provider's* price is still accurate 30–180 seconds later. Signing guarantees integrity of what was captured; it cannot guarantee the captured data is still true. This is the reason Section 8/13's recheck requirement exists as an independent control, not something the crypto model can substitute for.

## 15. Persistence Requirements

**No Prisma changes are made in this step.** The table below is a conceptual target, evaluated against the current schema (`prisma/schema.prisma`, re-confirmed this step: `Bet`, `BetSelection { sport, event, outcome, odds, market, currentOdds, oddsStatus }`, `OddsSnapshot { sourceOdds, submittedOdds, matched, checkedAt }` — no `league`/`period`/`selectionType`/`line`/`bookmaker`/`reasonCode`/`acceptedOdds`/provider-ID fields exist anywhere today).

**Recommend immutable verification snapshots** rather than continuing to overwrite one mutable "current" value per selection. Today, `BetSelection.currentOdds`/`oddsStatus` and `OddsSnapshot`'s single row are each the *only* record of a verification attempt — once confirm-time recheck exists (Section 13), a recheck would silently destroy the preview-time snapshot the moment it overwrites these columns, making "what did we check, and when" unanswerable after the fact. A new, append-only `OddsVerificationSnapshot` concept (one row per verification attempt — preview-time check, confirm-time recheck, or any future re-verification) fixes this: `Bet`/`BetSelection` reference the *latest accepted* snapshot; nothing is ever overwritten.

| Field | Bet | BetSelection | OddsVerificationSnapshot | ProviderReference |
|---|---|---|---|---|
| Canonical sport | — | Yes (existing) | Yes (denormalized copy, for audit even if `BetSelection` ever changes) | — |
| League | — | **New** | Yes | — |
| Event start time | — | New (display convenience) | Yes (the time actually used for matching) | — |
| Market | — | Yes (existing column, currently always `null`) | Yes | — |
| Period | — | New | Yes | — |
| Selection type | — | New (today: free-text `outcome` only) | Yes | — |
| Line | — | New | Yes | — |
| Participant identity | — | New (structured) | Yes | Referenced by ID |
| Submitted odds | Yes (SINGLE legacy `odds`) | Yes (existing) | Yes (immutable copy at time of check) | — |
| Current odds | — | Existing (kept as a "latest known" convenience field) | Yes (the authoritative, immutable per-attempt value) | — |
| Accepted odds | **New** | **New** | Yes (authoritative) | — |
| Verification status | — | Yes (existing `oddsStatus`) | Yes (authoritative per attempt) | — |
| Reason code | — | **New** | Yes (authoritative) | — |
| Provider | — | — | New | Yes |
| Bookmaker | — | **New** (today: display-only in preview, never persisted to `BetSelection`) | Yes | — |
| Provider event ID | — | — | — | New |
| Provider market ID | — | — | — | New |
| Provider outcome ID | — | — | — | New |
| `checkedAt` | — | — | New | — |
| `providerTimestamp` | — | — | New (nullable — provider-dependent) | — |
| Difference percent | — | — | New | — |
| User acceptance timestamp | — | New (or on the accepting snapshot itself) | Yes (the `ACCEPTED`-transition snapshot) | — |
| Confirm-time recheck result | — | — | A second snapshot row per selection, `attemptType: CONFIRM_RECHECK` | — |
| Manual override metadata | New, separate table (not `OddsVerificationSnapshot` — Section 12) | — | — | — |
| `confirmationMethod` (`PROVIDER_VERIFIED` \| `MANUAL_OVERRIDE`) | New | — | — | — |

## 16. Error and Public Message Policy

Four distinct things, kept structurally separate:

1. **Internal reason code** (`VerificationReasonCode`) — precise, for logging/operator tooling/policy branching.
2. **Retryable flag** — derived from the reason code (Section 3's classification), consumed by retry logic (Section 17), never independently set.
3. **Safe public message key** — a short, fixed string (e.g. `"odds.market_not_supported"`, `"odds.provider_unavailable"`) the client maps to localized copy — **never raw provider text**, never a reason code's own name exposed verbatim as user-facing prose.
4. **Detailed server diagnostic** — a structured, bounded object: `durationMs`, provider name, `sportKeyTried`-equivalent (whatever coverage identifier the adapter used), a truncated error *class* name — never a raw error message string that might embed response body content.

**No raw provider response body, request URL (which embeds the API key today, per `oddsVerifier.ts:406`), event text, odds values, or private request contents should ever be logged through a generic error path.** This preserves and extends the Step 2 audit's confirmed-good finding that today's structured logs (`lib/logging/structuredLog.ts`'s `odds_*` events) are already content-free — but flags one current gap against this principle worth carrying into the target design: `oddsVerifier.ts` throws `Error` objects with the provider's raw response body text embedded in the message (`fetchOddsForSport`'s `throw new Error(...${body})`), which are then passed to `console.error` at the calling routes. This is server-side-only today (not client-facing) but should not be the pattern the target adapter follows — diagnostics should be structured fields from the start, not pre-formatted strings that might carry provider response content.

**What can be logged safely**: `reasonCode`, `retryable`, `durationMs`, provider name, `sport` (already player-visible), `selectionIndex` — matches exactly what `buildBetSlipPreview.ts`'s existing `odds_check_not_matched`/`odds_check_rejected` events already log today, extended with the new reason-code granularity.

## 17. Caching, Quota, and Concurrency Design

- **Cache layers**: one process-memory layer (L1), matching today's 45s-TTL `Map` in `oddsVerifier.ts`, re-keyed on the canonical `(sport, league, timeWindow)` tuple (Section 13) instead of a raw `sportKey`. **No L2/distributed cache is recommended for MVP** — serverless multi-instance deployment means a process cache is inherently instance-local and inconsistent across instances; this is an accepted, known limitation today and remains one here, not something this design step tries to solve without infrastructure work.
- **TTL categories**: event/market/price data ~45s (price-sensitive, matches today exactly); capabilities data effectively deploy-scoped/near-infinite (Section 11 — rarely changes, no reason to refetch per request).
- **Per-request deduplication**: EXPRESS legs sharing a resolved event reuse one fetch — a natural byproduct of the sport/league-keyed cache, not separate logic.
- **Process cache limitations in serverless**: explicitly acknowledged — each function instance has its own cache; a cold instance always misses. This is accepted as-is; solving it (e.g. a shared external cache) is out of scope without evidence of a real performance problem.
- **Maximum parallel provider calls**: bounded by `MAX_EXPRESS_SELECTIONS = 10` today — sufficient at current scale, no additional concurrency limiter needed.
- **Retry/backoff**: recommend **one bounded retry** (short fixed delay) for `PROVIDER_TIMEOUT`/`PROVIDER_RATE_LIMITED` only. **Never retry** coverage-failure reason codes (`MARKET_NOT_SUPPORTED`, `SPORT_NOT_SUPPORTED`, `LEAGUE_NOT_SUPPORTED`) — retrying a guaranteed-same-outcome failure only wastes quota, which is exactly why Section 3's `retryable` classification exists as an operational signal, not just documentation.
- **Timeout**: keep today's `8000ms` constant as the MVP starting point — a proven value with no evidence it needs changing.
- **Circuit breaker**: not justified for MVP at current scale with a single provider — flag as a later-phase concern (Section 18, beyond Phase J) if/when a second provider or materially higher traffic exists. Do not build it speculatively now.
- **Quota/rate-limit observability**: recommend a simple log-based signal whenever `PROVIDER_RATE_LIMITED` is hit (Section 16's safe-diagnostics policy already covers what's loggable) — no dedicated dashboard or infrastructure required for MVP.

## 18. Migration from Current Implementation

No big-bang rewrite. Each phase is independently shippable and independently revertible.

| Phase | Description | Files likely affected | Compatibility risk | Required tests | Rollback |
|---|---|---|---|---|---|
| A | Introduce canonical domain types (enums, `CanonicalEvent`, `CanonicalSelection`, `VerificationResult`, etc.) | New files only (e.g. `lib/odds/domain/*.ts`) | None — purely additive, nothing imports these yet | Type/validation-rule unit tests (Section 5's table) | Delete the new files |
| B | Introduce `VerificationReasonCode` and its classification | Extends A's new files | None — still not wired into any runtime path | Classification-table unit tests | Trivial |
| C | Wrap current `verifyOdds()` in a `TheOddsApiProvider` adapter | New files (e.g. `lib/odds/providers/theOddsApi/*.ts`) that internally call the **existing, unmodified** `lib/odds/oddsVerifier.ts` and translate `OddsCheckResult` → `VerificationResult` | Low — new code path, not yet consumed by any route; `oddsVerifier.ts` itself stays untouched | Adapter tests re-asserting every existing `oddsVerifier.test.ts` scenario through the adapter's translated output | Delete the adapter; zero blast radius |
| D | Introduce `OddsVerificationService` (provider-neutral orchestration) | New file, constructed with an injected `OddsProvider` | Low-medium — still not called by `buildBetSlipPreview.ts` | Service tests with a fake `OddsProvider` (mirrors today's `fakeVerifyOddsFn` pattern in `buildBetSlipPreview.test.ts`) | Trivial — unused code |
| E | Change `buildBetSlipPreview.ts`'s dependency from `verifyOdds` directly to `OddsVerificationService.verifySelection`, preserving external output shape | `lib/bets/buildBetSlipPreview.ts` | **Medium** — first phase touching a currently-live file; must be output-compatible, not a behavior change | Full existing `buildBetSlipPreview.test.ts` + the three route tests must stay green; add explicit output-parity tests (old path vs. new path, same fixtures) | Revert the one dependency-swap commit; `oddsVerifier.ts` and the adapter remain intact underneath either way |
| F | Extend parser output with `league`/`market`/`period`/`line` | `lib/ai/betParser.ts`, `lib/ai/betParserPrompt.ts` | **Higher** — AI prompt/schema changes can regress extraction quality broadly; explicitly out of this step's ("do not change parser behavior") and Step 5's scope — its own dedicated, carefully-scoped step | Extended `betParser.test.ts` + a broader eval set of real/synthetic messages, not just unit assertions | Revert schema/prompt; every downstream consumer already tolerates `market: null`/no `league` today, so reverting is safe |
| G | Introduce immutable verification persistence (`OddsVerificationSnapshot`-equivalent) | `prisma/schema.prisma` (new migration), `lib/bets/createBetFromPreview.ts` | **High** — real schema change on the single shared production DB (ADR-0001) — explicitly out of scope for Step 4 and Step 5 | Full regression on `createBetFromPreview.test.ts`; new snapshot-write tests | Additive-only migration (new nullable columns/table, no drops) — "rollback" means "stop writing to the new columns," not reversing the migration |
| H | Add confirm-time recheck | `app/api/miniapp/bets/text/confirm/route.ts`, `lib/bets/createBetFromPreview.ts` | Medium-high — a real behavior change (confirm can now fail where it never did); needs explicit product sign-off on the new failure UX | New confirm-route tests for the recheck-fails path | Feature-flag the recheck call; revert to trusting the token as before |
| I | Extend markets one at a time (Totals → Double Chance → BTTS → Spread, matching the Support Matrix's evidence ranking) | Adapter-level selection-classification logic (the target-state home for what `classifySingleSelection` does today) | Medium per market, isolated — a broken market's classifier can be disabled independently (falls back to `MARKET_NOT_SUPPORTED`) without affecting already-shipped markets | New dedicated test file per market, following today's `oddsVerifier.test.ts` fetch-stub pattern | Per-market disable, no cross-market blast radius |
| J | Add Telegram odds lookup | New command handler(s), using `OddsVerificationService.findEvents` | Low to existing flows (purely additive); higher product-scope risk (new user-facing surface) | New command-handler tests | Remove the command registration |

## 19. Test Strategy

- **Canonical model validation** — Section 5's per-market validation rules, as pure unit tests (no I/O).
- **Provider contract tests** — a shared test suite any `OddsProvider` implementation must pass (interface-level, not adapter-specific), so a second provider can be validated against the same expectations.
- **Adapter tests** — `TheOddsApiProvider`-specific, via `global.fetch` stubbing (today's proven pattern in `oddsVerifier.test.ts`) — zero real network calls.
- **Event ambiguity** — dedicated tests for the new `AMBIGUOUS_EVENT` path (Section 9): near-tied scores, unsplittable input routed through the ambiguity check, multi-competition same-day fixture collisions.
- **Each sport × market combination** — one dedicated test group per `(Sport, MarketType)` pair in MVP scope (Support Matrix Section 6), following today's per-scenario style.
- **Decimal odds comparison** — boundary tests (exactly at tolerance, just inside, just outside), decimal-string malformed-input rejection.
- **Timeout/rate-limit/provider-error paths** — one test per `PROVIDER_*` reason code, asserting `retryable` classification is honored.
- **SINGLE** and **EXPRESS** — orchestration-level tests via an injected fake `OddsProvider`/`OddsVerificationService` (mirrors today's `fakeVerifyOddsFn` pattern), covering the tightened token-issuance gate (Section 13).
- **Preview token** — signing/verification/expiry tests extended for the new fields (`acceptedOdds`, `oddsAcceptanceVersion`, provider references), following `previewToken.test.ts`'s existing structure.
- **Confirm-time recheck** — new scenarios: recheck reaffirms, recheck discovers a new `ODDS_CHANGED`, recheck discovers a new blocking failure.
- **Persistence** — snapshot-write tests once Phase G exists (fake/in-memory Prisma client, matching today's `createBetFromPreview.test.ts` convention — never a real DB in the standard suite).
- **Security/log leakage** — assert no raw provider response body, URL, or API key ever appears in a thrown error message or log call (Section 16) — extends today's existing `buildBetSlipPreview.test.ts` test that already asserts odds-check failures never log selection/event/market content.
- **No real network calls in the standard test suite** — preserved as an absolute rule throughout every phase, matching the current suite's proven discipline (Step 2 audit Section 11, re-confirmed: 648/648 passing with zero real network calls).
- **Optional, manually-triggered provider smoke test** — a one-off script (e.g. `scripts/odds-provider-smoke.ts`), run outside CI with a real API key, deliberately **not** matching any `*.test.ts` glob `npm test` picks up — for occasional manual confidence-checking against the real Odds API, never part of the standard suite.

## 20. Architecture Decisions

- **Interface boundaries**: `OddsProvider` (domain contract) → `TheOddsApiProvider` (adapter) → provider registry (trivial lookup) → `OddsVerificationService` (orchestration) → `buildBetSlipPreview.ts`'s eventual replacement caller. No layer above `TheOddsApiProvider` may reference The Odds API's types or endpoints.
- **Public statuses**: the small four-value `VerificationStatus` (`VERIFIED`/`ODDS_CHANGED`/`FAILED`/`NOT_CHECKED`) is final for the public/UI surface; all detail lives in `VerificationReasonCode`.
- **Reason codes**: the fourteen-value `VerificationReasonCode` list (Section 3) is final for this design; new codes may be added additively later, none of the existing ones should be removed or repurposed.
- **`acceptedOdds` policy**: `VERIFIED` auto-sets `acceptedOdds = currentOdds`; `ODDS_CHANGED` requires a recorded, explicit player acceptance action before `acceptedOdds` is ever set; `acceptedOdds` is never silently backfilled from `submittedOdds`.
- **Normal confirmation blocking policy**: `VERIFIED` (always allowed) and `ODDS_CHANGED`-after-explicit-acceptance (conditionally allowed) are the only two paths to a confirmable selection in the normal player flow; every other status/reason-code combination blocks, per the task's own blocking-outcomes list (Section 8, incorporated verbatim into this design).
- **Event ambiguity policy**: `AMBIGUOUS_EVENT` is a hard block in the normal flow, with no silent best-guess fallback, ever — replacing today's confirmed "first highest score wins" behavior.
- **Token policy**: previewTokens carry the full canonical selection plus explicit acceptance tracking; confirm always performs a fresh provider recheck regardless of token freshness, because HMAC signing guarantees integrity, not currency, of the token's price data.
- **Persistence strategy**: immutable, append-only verification snapshots, referenced by `Bet`/`BetSelection` rather than overwritten in place — deferred to a schema-changing phase (G), explicitly not part of Step 4 or Step 5.
- **The Odds API should initially be wrapped, not replaced.** Every phase in Section 18 preserves `oddsVerifier.ts`'s proven matching logic (event orientation scoring, 1X2 classification, team aliasing) inside the new adapter rather than rewriting it — the Step 2 audit found this logic sound and well-tested; the problem being solved is the *absence of an interface around it*, not the logic itself.

## 21. Acceptance Criteria for Step 5

Step 5 should implement **only** Phases A–D of Section 18's migration plan — canonical domain types, reason codes, the `OddsProvider` interface, and a `TheOddsApiProvider` adapter wrapping today's unmodified `verifyOdds()` — plus their tests. It should **not** touch `buildBetSlipPreview.ts`, the parser, Prisma, or the confirm route (those are Phases E onward, each its own future step).

Testable criteria:

1. Every enum in Section 3 exists as a canonical type, with the exact values listed, and unit tests confirming the `VerificationStatus` ↔ `VerificationReasonCode` pairing rules.
2. `CanonicalSelection`'s validation rules (Section 5's table) are implemented and unit-tested for every MVP-scoped `(Sport, MarketType)` combination — including the negative cases (`MONEYLINE_2WAY` must reject `DRAW`, `DOUBLE_CHANCE` must reject anything outside its three combinations, etc.).
3. `OddsProvider` exists as a pure interface/contract with no implementation logic and no import of any The-Odds-API-specific type.
4. `TheOddsApiProvider` implements `OddsProvider` by calling the existing, byte-for-byte unmodified `lib/odds/oddsVerifier.ts` internally, translating its output into `VerificationResult` — every existing `oddsVerifier.test.ts` scenario has a corresponding adapter-level test asserting the translated output is faithful (same event matched, same odds, same effective pass/fail outcome).
5. `oddsVerifier.ts` itself has zero diff — Step 5 wraps it, never edits it.
6. No currently-live route (`text/preview`, `text/confirm`, `screenshot/preview`) changes behavior — none of them import or depend on the new types/adapter yet.
7. The full existing 648-test suite still passes unmodified, with zero real network calls anywhere in the new adapter/type tests either.
8. `git diff` at the end of Step 5 touches only new files under the new domain/provider module paths, plus their tests — no existing production file is modified.

Step 5 is not implemented as part of this task.

README: added one link to `docs/ODDS_PROVIDER_DESIGN.md` in the Documentation section, no other content edited.
