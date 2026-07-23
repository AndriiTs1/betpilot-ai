# BetPilot AI — Odds Support Matrix

> Status: **Step 3 — product-level definition, analysis-and-documentation-only** (confirmation-policy sections corrected in Step 4A for consistency with `docs/ODDS_PROVIDER_DESIGN.md` — see the note below). This document does not change any runtime behavior. It defines what the next MVP should support; it does not implement it. The Step 2 audit (`lib/odds/oddsVerifier.ts` et al.) is the code-level source this document is grounded in — every "current" claim below was re-verified against current code during this step, not carried over from memory.
>
> **Relationship to `docs/ODDS_PROVIDER_DESIGN.md`**: this document defines product **scope** (which sports/leagues/markets the next MVP should support) and the **target confirmation policy** at a product level. `docs/ODDS_PROVIDER_DESIGN.md` is the implementation design derived from that scope — the canonical domain types, the `OddsProvider` contract, and the full acceptance-mechanics detail (`acceptedOdds`, confirm-time recheck, token design). Both documents state the same confirmation policy; where this document summarizes it, the Provider Design document is the more detailed treatment.

## 1. Purpose

BetPilot AI has five separate layers that can each "recognize" a sport, league, or market, and they are not aligned today:

1. **Parser recognition** — what `lib/ai/betParser.ts`'s AI tool schema can capture as free-text `sport`/`event`/`selection` strings. The parser has no allow-list: it will happily extract "MMA", "Cricket", or "Esports" as a `sport` value, because nothing constrains it. Recognition here proves nothing about whether the bet can be verified.
2. **Provider verification** — whether `lib/odds/oddsVerifier.ts` can actually map that sport to a live `sport_key` on The Odds API, find the fixture, find the market (today: `h2h` only), and find the selection. This is the only layer that produces a real "was this actually checked against a live price" answer.
3. **UI display** — whether a sport/selection renders with a real icon or copy (`components/miniapp/sportIcons.tsx`) or a display-only text normalization (`lib/bets/normalizeSelectionToEnglish.ts`). Both exist independently of provider verification and must never be read as evidence of it — `sportIcons.tsx` renders a Baseball, Volleyball, or Golf icon today with zero corresponding provider support, and `normalizeSelectionToEnglish.ts` relabels "Обе забьют" as "Both Teams to Score — Yes" as a pure cosmetic string rewrite, with no connection to `oddsVerifier.ts` whatsoever.
4. **Confirmation eligibility** — whether a bet slip is currently allowed to be submitted for operator review regardless of its odds-verification outcome. Per `lib/bets/betSlipRules.ts:79-101`, this is already a deliberately permissive **current** policy: every `BetSelectionOddsStatus` value (`VERIFIED`, `ODDS_CHANGED`, `NOT_FOUND`, `UNAVAILABLE`) is currently submittable — the operator's manual Confirm/Reject is the only real gate today, not the odds check. **This is current-state fact, not the target policy** — Section 8 defines the target MVP's blocking-by-default confirmation policy, which replaces this permissive behavior.
5. **Persisted support** — what actually survives to `OddsSnapshot`/`BetSelection` in Postgres, per the Step 2 audit's Section 9: notably, `market` is a real, structurally-wired Prisma column (`prisma/schema.prisma:202`, displayed in `components/bets/SelectionRow.tsx:77` and `components/miniapp/BetTicket.tsx:250`) that is nevertheless **hardcoded to `null` at both construction sites** in `lib/ai/betParser.ts:442,462` — the column exists and displays correctly, but nothing ever populates it today.

Conflating any of these five layers is the single biggest risk this document exists to prevent. A sport icon or a display-normalized selection label is not evidence of provider support. A submittable bet slip is not evidence of a verified price. A Prisma column existing is not evidence it is ever populated.

This file is the **source of truth for the next odds architecture stage (Step 4)**. Step 4's `OddsProvider` interface design, its status/reason-code enum, and its persistence-model changes should all trace back to a decision recorded here. Nothing in this document is implemented by this step.

## 2. Support Levels

Applied to sports, leagues, and markets as a product-scope classification:

- **CURRENT** — already works end-to-end today: parser can produce it, `oddsVerifier.ts` can map/fetch/match it, and a confirmed bet can carry a real verified price for it.
- **MVP_REQUIRED** — not fully working today, but the next MVP stage must deliver it, based on evidence of real product need (existing UI/icon investment, existing display-normalization investment, or an explicit statement in README/CHANGELOG).
- **DEFERRED** — plausible and possibly desirable eventually, but not required for the next MVP; no strong current evidence justifies building it now.
- **UNSUPPORTED** — explicitly out of scope; building it would contradict the product's current scope (private, pre-match, operator-mediated betting) or the evidence available.
- **DISPLAY_ONLY** — exists visually or textually (icon, normalized label) but is not, and is not planned to become, provider-verifiable in the covered timeframe. Distinguishes "the UI shows something for this" from "this is or will be checked against a live price."

Applied to individual sport/market/league combinations as a verification-capability classification:

- **FULLY_VERIFIABLE** — parser can extract it, the provider can be queried for it, event matching and selection matching both work today, and a real price is returned.
- **PARTIALLY_VERIFIABLE** — some part of the chain works (e.g., the sport maps to a real `sport_key` and the market is fetched) but another part is structurally incomplete (e.g., only 1X2 shorthand resolves, not full alternate-market selections).
- **PARSED_ONLY** — the parser can capture it as free text, but no code path attempts provider verification for it at all (e.g., any sport with no `SPORT_KEY_ALIASES` entry).
- **DISPLAY_ONLY** — same meaning as the support-level term above, applied at the individual-item level.
- **NOT_SUPPORTED** — no parser recognition, no provider path, and no display treatment.

## 3. Product Scope

BetPilot AI is a **private, operator-mediated, pre-match Telegram betting assistant** — not a public sportsbook, not a self-service exchange, and (per Section 11) not currently an in-play product. The next MVP should stay narrow: cover the sports the product has already visibly invested in (dedicated PNG icons in `sportIcons.tsx`, explicit dashboard inclusion in `DASHBOARD_SPORT_KEYS`), not every sport the AI parser happens to be able to transcribe.

| Sport | Parser recognition (current) | Provider mapping (current) | Next-MVP decision | Required league coverage | Notes |
|---|---|---|---|---|---|
| Football / Soccer | Yes — no allow-list, free text | Yes, but generic "football"/"soccer" → `soccer_epl` only (`oddsVerifier.ts:54-56`); specific league aliases exist but are practically unreachable (Section 4) | **MVP_REQUIRED** | EPL, La Liga, Serie A, Bundesliga, Ligue 1, UEFA CL, UEFA EL, major internationals (see Section 4) | Highest existing investment: dedicated icon, dashboard inclusion, most test coverage. Current EPL-only default is the clearest concrete gap in the whole system. |
| Basketball | Yes | Yes, `basketball_nba` only | **MVP_REQUIRED** | NBA (MVP); EuroLeague evaluated, not required (Section 4) | Dedicated icon + dashboard inclusion. |
| Tennis | Yes | Yes, but only the 4 Grand Slams, only in-tournament (`TENNIS_SPORT_KEYS`, `oddsVerifier.ts:42-51`) | **MVP_REQUIRED** | ATP/WTA tour-level, not just Slams (gap — see Section 4) | Dedicated icon + dashboard inclusion. Current provider coverage is real but seasonally narrow — a tennis bet placed outside a Slam window today cannot verify at all. |
| Ice Hockey | Yes | Yes, `icehockey_nhl` only | **MVP_REQUIRED** | NHL (MVP); KHL/European leagues evaluated, not required (Section 4) | Dedicated icon + dashboard inclusion — same tier of existing investment as football/basketball/tennis. |
| American Football | Yes | Yes, `americanfootball_nfl` (`oddsVerifier.ts:66-67`) | **DEFERRED** | — | Has a dedicated icon (`AmericanFootballIcon`) and full provider mapping, but is **excluded from `DASHBOARD_SPORT_KEYS`** (`sportIcons.tsx:219`) — the operator dashboard's own deliberate "sports this project currently supports end to end" set omits it. That is direct, current-code evidence the product does not yet treat NFL as a first-tier sport, despite the technical plumbing existing. Recommend deferring formal MVP commitment until the dashboard inclusion gap is itself a deliberate decision, not an oversight — flag for product confirmation rather than assuming either way. |
| Baseball | Yes (free text) | No — no `SPORT_KEY_ALIASES` entry | **DISPLAY_ONLY today; DEFERRED for MVP** | — | Has a dedicated hand-drawn icon (`BaseballIcon`) but zero provider path. Icon existing is not evidence of a product requirement to verify it — no README/CHANGELOG mention. |
| Volleyball | Yes (free text) | No | **DISPLAY_ONLY today; DEFERRED for MVP** | — | Same pattern as Baseball — icon exists, provider mapping does not. |
| Esports | Yes (free text) | No — no icon either (falls to `TrophyIcon` fallback) | **DEFERRED** | — | No investment at any layer beyond the parser being unable to refuse it. |
| MMA / Boxing | Yes (free text) | No, no icon | **DEFERRED** | — | Same as Esports. |
| Cricket | Yes (free text) | No, no icon | **DEFERRED** | — | Same as Esports. |
| Rugby | Yes (free text) | No, no icon | **DEFERRED** | — | Same as Esports. |
| Golf | Yes (free text) | No, has a dedicated icon (`GolfIcon`) | **DISPLAY_ONLY today; DEFERRED for MVP** | — | Same pattern as Baseball/Volleyball — icon exists, no provider path, no explicit product statement requiring it. Golf's match-play/outright structure also does not fit the h2h-2-way model cleanly even if added later. |
| Other / unknown | Falls through to `TrophyIcon` fallback in UI, `NOT_FOUND` note in provider (`oddsVerifier.ts:448`) | No | **UNSUPPORTED** | — | Deliberate design already treats unrecognized sport as a distinct fallback (never silently mislabeled as a known sport) — this behavior should be preserved and formalized, not changed, in Step 4. |

## 4. League / Competition Matrix

**Football**

| Competition | Current provider key | Next-MVP status | Reason |
|---|---|---|---|
| EPL | `soccer_epl` (also the default for generic "football") | MVP_REQUIRED | Already the de facto default; highest existing usage assumption |
| La Liga | `soccer_spain_la_liga` (alias exists, unreachable in practice — Section 6/12 gap) | MVP_REQUIRED | Top-tier European league; no product reason to exclude it once the generic-default gap is fixed |
| Serie A | `soccer_italy_serie_a` (same reachability gap) | MVP_REQUIRED | Same as La Liga |
| Bundesliga | `soccer_germany_bundesliga` (same gap) | MVP_REQUIRED | Same as La Liga |
| Ligue 1 | `soccer_france_ligue_one` (same gap) | MVP_REQUIRED | Same as La Liga |
| UEFA Champions League | `soccer_uefa_champs_league` (same gap) | MVP_REQUIRED | Explicitly aliased already in code — clear signal it was already considered important |
| UEFA Europa League | Not aliased today | DEFERRED | No current code investment; add only if product evidence (real player demand) emerges |
| International tournaments (World Cup, Euros, etc.) | Not aliased today | DEFERRED | No current code investment; typically short, calendar-bound windows — treat like tennis Slams: evaluate again once general league coverage is fixed |
| Other domestic leagues (outside the big 5 + CL) | Not aliased | DEFERRED | No evidence of demand; keep MVP scope to leagues already reflected in code |

**Basketball**

| Competition | Current provider key | Next-MVP status | Reason |
|---|---|---|---|
| NBA | `basketball_nba` | MVP_REQUIRED | Only basketball league currently wired at all |
| EuroLeague | Not aliased | DEFERRED | No current evidence |
| NCAA | Not aliased | DEFERRED | No current evidence; also raises additional identity/disambiguation complexity (team-name collisions) not worth taking on without demand |
| Other leagues | Not aliased | DEFERRED | Same as above |

**Tennis**

| Competition | Current provider key | Next-MVP status | Reason |
|---|---|---|---|
| Grand Slams (AO, RG, Wimbledon, US Open) | `TENNIS_SPORT_KEYS`, all 4, ATP+WTA | MVP_REQUIRED | Already fully wired |
| ATP/WTA tour-level (non-Slam) | Not aliased — The Odds API has no persistent year-round tour key per the existing code comment (`oddsVerifier.ts`, tennis section) | MVP_REQUIRED, flagged as a real gap | Tennis has a dedicated icon and dashboard inclusion, implying year-round relevance, but the provider genuinely cannot serve this today without a materially different request strategy (per-tournament keys, not a single alias) — this is a Step 4 design input, not something fixable by a mapping-table edit alone |
| Challenger / ITF | Not aliased | DEFERRED | No evidence, and The Odds API's own coverage at this tier is a real external constraint, not just a mapping gap |

**Ice Hockey**

| Competition | Current provider key | Next-MVP status | Reason |
|---|---|---|---|
| NHL | `icehockey_nhl` | MVP_REQUIRED | Only hockey league currently wired |
| KHL | Not aliased | DEFERRED | No current evidence |
| European leagues | Not aliased | DEFERRED | No current evidence |

**American Football**

| Competition | Current provider key | Next-MVP status | Reason |
|---|---|---|---|
| NFL | `americanfootball_nfl` | DEFERRED (tracks the sport-level decision in Section 3 — dashboard exclusion is the deciding signal) | Wired but not in `DASHBOARD_SPORT_KEYS` — treat as a product question to resolve before committing, not an automatic MVP add |
| NCAA | Not aliased | DEFERRED | No evidence |

No league above is marked MVP_REQUIRED without either (a) it already being the active default/alias in `oddsVerifier.ts`, or (b) a sport already carrying the sport-level MVP_REQUIRED classification from Section 3 for which reasonable full coverage requires it (the big-5 leagues + Champions League for football, since "football" cannot mean EPL-only forever).

## 5. Canonical Market Matrix

A **canonical market taxonomy** is a fixed, provider-independent vocabulary that every parser output and every provider response must both map onto — it does not exist in the codebase today (the closest thing, `market: string | null` on `BetSlipSelectionInput`/`BetSelection`, is free text, not a closed enum). Proposed taxonomy, evaluated against current evidence:

| Canonical market | Example inputs | Current parser | Current provider verification | Next MVP status | Confirmation policy | Notes |
|---|---|---|---|---|---|---|
| `MONEYLINE_2WAY` | "Arsenal Win", team-name selection in tennis/basketball/hockey | Captured as free-text `selection`, no market tag | Verified via `extractOutcomePrice`'s team-name fuzzy match against `h2h` (`oddsVerifier.ts:290-317`) — works for 2-way sports | MVP_REQUIRED | **Blocking-by-default (target, Section 8/9): confirmable only as `VERIFIED` (`acceptedOdds = currentOdds`) or `ODDS_CHANGED` after explicit acceptance; every other reason code blocks** | Fully working today for football/basketball/tennis/hockey team-name selections |
| `MONEYLINE_3WAY` | "1", "X", "2", "П1", "Х", "П2" | Captured as free text; **display-normalized** by `normalizeSelectionToEnglish.ts:71-75` (П1→Home Win, Х→Draw, П2→Away Win) | Verified via `classifySingleSelection`/`resolveTeamOrder` (Step 2 audit Section 3/5) — this is the best-covered path in the whole system, with 18+ dedicated tests | MVP_REQUIRED | Same blocking-by-default policy as `MONEYLINE_2WAY` | The one market genuinely production-hardened today; the canonical taxonomy should treat this as the reference implementation, not bolt others on ad hoc |
| `DOUBLE_CHANCE` | "1X", "X2", "12", "1Х", "Х2" | Captured as free text; **display-normalized** by `normalizeSelectionToEnglish.ts:77-81` (1X→"Home or Draw", etc.) | **Explicitly rejected** by `oddsVerifier.ts` — the code comment states combined notation "must never be treated as a single FIRST_TEAM/DRAW/SECOND_TEAM outcome" and scores 0 against fuzzy name matching, so it is always unmatched | MVP_REQUIRED (evaluate carefully, per task guidance) — recommend **yes**: this is display-normalized already, meaning real player input contains it, but is silently unverifiable today, a direct example of the parser/UI-vs-provider gap this whole document exists to close | Same blocking-by-default policy as `MONEYLINE_2WAY`, once implemented | Currently: UI shows a clean "Home or Draw" label while the backend can never verify it — this exact combination is why display normalization must never be mistaken for provider support (Section 1) |
| `TOTALS` | "Over 2.5", "ТБ 2.5", "Under 2.5", "ТМ 2.5" | Captured as free text; **display-normalized** by `normalizeSelectionToEnglish.ts:86-88,140,146` | **Not verified at all** — `oddsVerifier.ts` only ever requests `markets=h2h` (`oddsVerifier.ts:406`); a totals market is never fetched from the provider | MVP_REQUIRED | Same blocking-by-default policy as `MONEYLINE_2WAY`, once implemented; until implemented, `MARKET_NOT_SUPPORTED` blocks every Totals selection | Same "display-ready, backend-blind" pattern as Double Chance — arguably the strongest evidence in the whole repo that Totals is a real, already-anticipated product need |
| `SPREAD` / Handicap | "-1.5 handicap", "Гандикап -1.5" | **Not recognized at all** — no pattern in `normalizeSelectionToEnglish.ts`, no handling anywhere | Not verified | MVP_REQUIRED for Basketball and Ice Hockey; **conditional/partial for Football** (per `docs/ODDS_PROVIDER_DESIGN.md` Section 1) — since the task's product principles call for spreads as a common pre-match market, but there is currently **zero code evidence** (unlike Totals/Double Chance, which at least have display normalization) that a player has ever submitted one | Same policy as Totals | Weakest evidence of the "common markets" set — flag explicitly as the one MVP_REQUIRED market recommendation not backed by any current parsing/display artifact, purely by the stated product principle of prioritizing common pre-match markets |
| `BOTH_TEAMS_TO_SCORE` | "Both teams to score", "Обе забьют", "BTTS - Yes/No" | Captured as free text; **display-normalized** by `normalizeSelectionToEnglish.ts:83-84,134-135`, including a Yes/No split | Not verified — same `h2h`-only limitation | MVP_REQUIRED (evaluate carefully) — recommend **yes**, same reasoning as Double Chance/Totals: real display investment already exists | Same policy as Totals | Football-specific by nature (Section 6) |
| `DRAW_NO_BET` | "Draw No Bet" | Not recognized anywhere | Not verified | DEFERRED | `MARKET_NOT_SUPPORTED` — blocks | No parser, display, or provider evidence at any layer |
| `TEAM_TOTAL` | "Team Total Over 1.5" | Not recognized anywhere | Not verified | DEFERRED | `MARKET_NOT_SUPPORTED` — blocks | No evidence; more granular variant of Totals, lower priority |
| `EXACT_SCORE` | "2:1", "Correct Score 2-1" | Not recognized anywhere | Not verified | DEFERRED (Section 11 — explicit candidate) | `MARKET_NOT_SUPPORTED` — blocks | Combinatorially large outcome space, no current evidence |
| `PLAYER_PROP` | "Ronaldo to score", any player-specific market | Not recognized anywhere | Not verified | DEFERRED (Section 11 — explicit candidate) | `MARKET_NOT_SUPPORTED` — blocks | No evidence; also structurally the hardest to verify (needs player-level provider data BetPilot has never queried) |
| `OUTRIGHT` | "Man City to win the league" | Not recognized anywhere | Not verified | DEFERRED (Section 11 — explicit candidate) | `MARKET_NOT_SUPPORTED` — blocks | Season-long, not pre-match single-event; out of scope for the current event-matching model entirely |
| `UNKNOWN` | Anything not matching a canonical market pattern | This is the current de facto behavior for everything except bare 1X2 | Falls through to fuzzy name matching, usually `NOT_FOUND` | Required as a formal fallback bucket, not a feature to build | `MARKET_NOT_SUPPORTED` — blocks; never confirmable in the normal flow | This bucket is what "market must be structurally identifiable; raw text alone is not enough" (task's product principles) is arguing against as a permanent state — `UNKNOWN` should shrink as the canonical set above is implemented, never be the intended steady state |

## 6. Sport × Market Compatibility

Not every market applies to every sport. This matrix defines intended applicability for MVP-scoped sports (Section 3); it is a target, not a current-state description — today, only the `Moneyline`/`3-way` columns for football/basketball/tennis/hockey are actually provider-verifiable (Section 5).

| Sport | Moneyline (2-way) | 3-way | Totals | Spread | BTTS | Double Chance | Props |
|---|---|---|---|---|---|---|---|
| Football | N/A (football is 3-way by default) | Yes | Yes | Evaluate (Asian handicap is common but adds complexity — see Section 12 gap) | Yes | Yes | Deferred |
| Basketball | Yes | N/A (no draw outcome) | Yes | Yes | N/A (not a scoring-pattern sport in this sense) | N/A | Deferred |
| Tennis | Yes | N/A (no draw outcome) | Yes (total games/sets) | Yes (game/set handicap) | N/A | N/A | Deferred |
| Ice Hockey | Yes — **full-game (incl. OT/shootout) 2-way**, must not be conflated with regulation-time markets | Yes — **regulation-time (60-minute) 3-way**, a structurally distinct market from full-game moneyline, not a variant of it | Yes | Yes | N/A | Evaluate — double chance is meaningful for the regulation-time 3-way variant only | Deferred |
| American Football (deferred at sport level — table entry retained for completeness only) | Yes | N/A | Yes | Yes | N/A | N/A | Deferred |

The Ice Hockey regulation-time/full-game distinction is called out explicitly per the task's product principles: The Odds API's `h2h` market for `icehockey_nhl` returns full-game (including overtime/shootout) prices today — a canonical `MONEYLINE_3WAY` (regulation-time) market for hockey does **not** currently exist in this integration and must be modeled as a separate canonical market with its own `period` value (Section 7), not derived from or merged with the 2-way full-game price.

## 7. Canonical Input Requirements

| Field | Required / Optional / Derivable / Unsafe to guess | Current state |
|---|---|---|
| `sport` | Required | Free text today (`BetSlipSelectionInput.sport`); needs to become a closed, canonical value for real market/league resolution — currently the single biggest source of the EPL-only-default bug (Section 3) |
| `league` | **Required for football at minimum; currently does not exist as a field anywhere** | Not captured by the parser tool schema at all — the prompt asks the model to identify "league/competition" conceptually (`betParserPrompt.ts:40`) but no tool-schema property exists to hold it, so it is silently dropped even when the model "sees" it. This is the direct cause of the generic-"football"-means-EPL default. **League cannot remain implicit forever** — without it, football verification cannot expand beyond a single hardcoded league default no matter how many aliases are added, since nothing in the actual data ever selects among them. |
| `event` | Required | Free text (team1/team2 or a single descriptive string) — works today via fuzzy matching, imperfect but functional |
| `eventStartTime` | Optional today; should become required for MVP | Not captured anywhere today. Without it, event matching has no way to disambiguate same-named fixtures on different dates, and no way to reject an odds check against a fixture that has already started (a real, currently-unguarded risk — nothing prevents matching an in-progress or finished event's stale `h2h` price against a "pre-match" bet) |
| `market` | **Required — currently exists as a column/field but is always null (Section 1)** | Structurally wired (`BetSlipSelectionInput.market`, `BetSelection.market`, UI display) but never populated (`betParser.ts:442,462` hardcode `null`). Cannot remain implicit forever, same as `league` — every canonical market in Section 5 depends on this field actually being populated with a value from a closed vocabulary, not left to be re-derived from `selection` text alone |
| `period` | Required once any period-scoped market (Section 6's hockey regulation-time example) is supported; optional/defaultable ("full game") otherwise | Does not exist anywhere in the current schema |
| `selection` | Required | Free text; this is the one field the current fuzzy-matching pipeline is built around, and it should remain free text at the input layer (players/OCR won't produce canonical tokens) — but must always be paired with a resolved `market` rather than being asked to imply the market itself |
| `line` | Required for `TOTALS`/`SPREAD`/`TEAM_TOTAL`; not applicable otherwise | Does not exist as a separate field today — the numeric line (e.g. "2.5") is embedded inside the free-text `selection` string and extracted only by `normalizeSelectionToEnglish.ts`'s display regex, never surfaced as structured data available to verification |
| `submittedOdds` | Required for verification; optional at parse time (player may omit) | Already nullable and handled correctly today (`BetSlipSelectionInput.submittedOdds: number | null`) |
| Participant/team orientation | Derivable, not required as separate input | Already correctly handled by `resolveTeamOrder`/`findMatchingEvent`'s forward/backward scoring (Step 2 audit Section 5) — this is one part of the pipeline that should be preserved as-is into Step 4, not redesigned |

**Unsafe to guess**: `league` and `market` must never be inferred by falling back to a default (the current EPL-default and `h2h`-only-market behaviors are exactly this anti-pattern, tolerated today only because the product is small). Step 4 should not "fix" the defaults by picking smarter defaults — it should make these fields explicit, required inputs with an honest `MARKET_NOT_SUPPORTED`/`LEAGUE_NOT_SUPPORTED` outcome (Section 9) when they cannot be confidently determined, rather than silently guessing.

## 8. Verification Policy

**CURRENT runtime behavior**: `lib/bets/betSlipRules.ts:79-101`'s `canSubmitBetSlip` is **presently permissive** — every `BetSelectionOddsStatus` value (`VERIFIED`, `ODDS_CHANGED`, `NOT_FOUND`, `UNAVAILABLE`, `PENDING`) is currently submittable, and `lib/bets/createBetFromPreview.ts` writes whatever `submittedOdds` the player typed into `Bet.odds`/`BetSelection.odds` regardless of verification outcome. There is no `acceptedOdds` concept anywhere in the current codebase — confirmed by grep against `lib`, `app`, `components`, `types`, `prisma` during Step 4. **This section previously described that permissive policy as the one to carry forward into the MVP; that was a mistake, corrected below.** The authoritative target policy is defined jointly here and in `docs/ODDS_PROVIDER_DESIGN.md` Sections 8/12/20, and the two documents must not diverge.

**TARGET MVP policy — blocking-by-default. Not implemented by this step:**

Three odds fields, matching `docs/ODDS_PROVIDER_DESIGN.md`'s terminology exactly:

- **`submittedOdds`** — the odds originally supplied by the player.
- **`currentOdds`** — the live odds returned by the provider during verification.
- **`acceptedOdds`** — the final odds accepted for `Bet` creation, payout calculation, and settlement. **`acceptedOdds` is the only field a confirmed `Bet`/`BetSelection` may source its confirmed odds or payout math from — never `submittedOdds` directly, once verification has run.**

- **Verification mandatory when**: `submittedOdds` is present for a selection (mirrors current behavior — `buildBetSlipPreview.ts` already skips `verifyOddsFn` entirely when `submittedOdds === null`, which should remain the trigger condition).
- **`VERIFIED`**: `currentOdds` exists; `acceptedOdds = currentOdds` is set automatically (there is nothing to accept — the player's and provider's numbers already agree within tolerance); a confirm-time recheck is still required before `CONFIRMED`.
- **`ODDS_CHANGED`**: `currentOdds` exists; `acceptedOdds` **remains `null` until the player explicitly accepts the provider's current price**; only after that explicit acceptance does `acceptedOdds = currentOdds`, and a confirm-time recheck is still required afterward. Normal confirmation is **blocked** until acceptance occurs — this is a correction of this document's earlier claim that `ODDS_CHANGED` was "informational, not blocking."
- **All other outcomes block normal player confirmation, with `acceptedOdds` remaining `null`.** This includes every one of: `EVENT_NOT_FOUND`, `MARKET_NOT_SUPPORTED`, `SELECTION_NOT_FOUND`, `SPORT_NOT_SUPPORTED`, `LEAGUE_NOT_SUPPORTED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `PROVIDER_RATE_LIMITED`, `PROVIDER_INVALID_RESPONSE`, `AMBIGUOUS_EVENT`, `INVALID_INPUT`, `NOT_CHECKED`. **This document previously described the `NOT_FOUND`-family as "informational, not blocking" — that was incorrect and is corrected here.** None of these reason codes may ever produce a confirmable selection in the normal player flow, regardless of how "honest" or "legitimate" the underlying cause is (e.g., a genuinely-out-of-coverage market is still blocking, not merely a soft warning).
- **Unsupported markets**: must surface as a distinct `MARKET_NOT_SUPPORTED` outcome (Section 9), never silently coerced into `NOT_FOUND`'s current catch-all meaning (Step 2 audit's confirmed `mapOddsStatus.ts` conflation) — and, per the target policy above, `MARKET_NOT_SUPPORTED` blocks.
- **Provider unavailable**: must surface as `PROVIDER_UNAVAILABLE`/`PROVIDER_TIMEOUT`/`PROVIDER_RATE_LIMITED`/`PROVIDER_INVALID_RESPONSE`, kept distinct from `SPORT_NOT_SUPPORTED`/`MARKET_NOT_SUPPORTED` — this is the core fix to the Step 2 audit's P1 finding on `NOT_FOUND` conflation, formalized here. All four block.
- **Ambiguous event matching**: must never be silently resolved to a best-guess winner (Section 5's current tie-break gap) — must surface as `AMBIGUOUS_EVENT` and **block** confirmation until `eventStartTime` (Section 7) or another disambiguator resolves it.
- **Submitted vs. provider vs. accepted odds**: the **provider's price (`currentOdds`) is the source of truth for verification** (whether the bet is `VERIFIED`/`ODDS_CHANGED`), but **`acceptedOdds` — not `submittedOdds` — is what the confirmed bet is actually placed, paid out, and settled at**. This is a deliberate correction of this document's earlier claim ("the player's submitted odds remain the odds the bet is actually placed and settled at ... should not change") — under the target policy, `submittedOdds` is never used as the accepted/settled price once verification has run; it is retained only for display/comparison and audit.
- **Confirm-time recheck**: the next MVP must perform a fresh recheck at confirm time for every selection, not only trust the ≤180s-old preview token (Step 2 audit Section 10's P1 finding) — required for both `VERIFIED` and post-acceptance `ODDS_CHANGED` selections alike. This document defines the requirement; the mechanism is a Step 4+ design decision (see `docs/ODDS_PROVIDER_DESIGN.md` Section 13/14).
- **EXPRESS and per-leg verifiability**: **every leg must have a non-null `acceptedOdds` and must pass its confirm-time recheck before the EXPRESS is confirmable — a single leg with a blocking reason code (or an unaccepted `ODDS_CHANGED`) blocks the entire EXPRESS.** This document previously stated the opposite ("EXPRESS should not require every leg to be VERIFIED... nothing in the product evidence justifies tightening it") — that was incorrect and is corrected here; it also directly contradicted `docs/ODDS_PROVIDER_DESIGN.md` Section 13, which already specified this tightened rule. The EXPRESS slip's **submitted total may be displayed for comparison only**; the **confirmable combined odds and payout must be computed from `acceptedOdds` alone**.
- **Manual operator override**: a **future, separate, operator-only pathway** — not part of the normal player confirmation flow described above. It must record operator identity, a reason, a timestamp, `submittedOdds`, and the operator-accepted `acceptedOdds`, and it **must never be represented as `VERIFIED`** — a manually-confirmed bet's `confirmationMethod` must stay distinguishable from a provider-verified one in every persisted record and UI surface. See `docs/ODDS_PROVIDER_DESIGN.md` Section 12 for the full design.

## 9. Status and Reason Model

**Corrected from this document's earlier version**: every row below previously marked "Non-blocking" for the `*_NOT_FOUND`/`*_NOT_SUPPORTED`/`NOT_CHECKED` family was wrong — under the authoritative target policy (`docs/ODDS_PROVIDER_DESIGN.md` Sections 3/8/20), **only `VERIFIED` and `ODDS_CHANGED`-after-explicit-acceptance are non-blocking**; every other status/reason code blocks normal player confirmation. `PROVIDER_RATE_LIMITED` and `PROVIDER_INVALID_RESPONSE` are also added below — they exist in `docs/ODDS_PROVIDER_DESIGN.md`'s reason-code enum but were missing from this table.

| Status | Internal reason code / Public UI state | Blocking? |
|---|---|---|
| `VERIFIED` | Public UI state (already exists as `BetSelectionOddsStatus.VERIFIED`) | **Not blocking** — `acceptedOdds = currentOdds`, confirmable after confirm-time recheck |
| `ODDS_CHANGED` | Public UI state (already exists) | **Blocking until explicit acceptance.** `acceptedOdds` stays `null` until the player explicitly accepts `currentOdds`; only then does it become non-blocking (still subject to confirm-time recheck) |
| `EVENT_NOT_FOUND` | New — currently folded into `NOT_FOUND`. Should become a specific internal reason code, surfaced publicly as part of a `NOT_FOUND`-family UI state (players do not need the internal distinction, operators might) | **Blocking** — `acceptedOdds` remains `null` |
| `MARKET_NOT_SUPPORTED` | New — currently indistinguishable from `EVENT_NOT_FOUND`/`SELECTION_NOT_FOUND`. Should be both an internal reason code and a distinct public state, since it has a different remedy (there is nothing wrong with the bet, the system just can't check this market yet) | **Blocking** — visually distinct from a "real" not-found, but blocking all the same; there is nothing wrong with the bet, but it still cannot be confirmed without a verified price |
| `SELECTION_NOT_FOUND` | New — internal reason code, folds into the same public `NOT_FOUND`-family state as `EVENT_NOT_FOUND` for now | **Blocking** |
| `SPORT_NOT_SUPPORTED` | New — internal reason code (today: `getSportKeys` returning `null`, currently mapped to the same generic `NOT_FOUND`). Public state can share `MARKET_NOT_SUPPORTED`'s "not yet covered" family rather than needing its own copy | **Blocking** |
| `LEAGUE_NOT_SUPPORTED` | New — does not exist as a concept at all today, since `league` isn't captured (Section 7). Once `league` is a real field, this becomes its own internal reason code, same public family as `SPORT_NOT_SUPPORTED` | **Blocking** |
| `PROVIDER_UNAVAILABLE` | New distinct code — today collapses into the same `NOT_FOUND`/`UNAVAILABLE` path as everything else | **Blocking** (Section 8) |
| `PROVIDER_TIMEOUT` | New — a specific case of `PROVIDER_UNAVAILABLE`; worth keeping as its own internal reason code (operators may want to distinguish "down" from "slow") but can share the same public blocking state | **Blocking** |
| `PROVIDER_RATE_LIMITED` | New — quota exhaustion, distinct from a timeout for operator observability (`docs/ODDS_PROVIDER_DESIGN.md` Section 17) | **Blocking** |
| `PROVIDER_INVALID_RESPONSE` | New — the provider responded but with an unexpected/malformed shape; distinct from a clean timeout since repeated occurrences may indicate a provider schema change needing human attention | **Blocking** |
| `AMBIGUOUS_EVENT` | New — does not exist as a concept today (Section 5/8) | **Blocking** |
| `INVALID_INPUT` | New — e.g. a selection string that doesn't parse into any recognizable shape at all; distinct from "not found in the provider's data" | **Blocking** — blocks preview generation entirely when caught early (closer to today's `BetSlipValidationError` gate), and blocks confirmation if reached at verification time |
| `NOT_CHECKED` | Maps to today's existing `UNAVAILABLE`/`PENDING` semantics — verification never ran (no submitted odds, or an EXPRESS leg intentionally skipped) | **Blocking** — `acceptedOdds` remains `null`; must remain visually distinct from `VERIFIED` |

General principle: **every currently-conflated failure reason in `mapOddsStatus.ts` (Step 2 audit's confirmed P1 finding) should become its own internal reason code**, but the *public*, player-facing state surface should stay small (a handful of UI states, not fourteen) — the granularity exists for operators/logs/debugging, not because the player needs to see fourteen different variants of "couldn't verify this." **The blocking/non-blocking policy itself, however, is a strict binary determined solely by status and `acceptedOdds`, not varied per reason-code family**: `VERIFIED` and accepted `ODDS_CHANGED` are the only two non-blocking outcomes, full stop.

## 10. Current vs Target Gap

| Area | Current state | Target MVP state | Gap |
|---|---|---|---|
| Sports | 5 sports have any provider mapping (football/basketball/tennis/hockey/NFL); NFL excluded from dashboard | Football/basketball/tennis/hockey formally MVP_REQUIRED; NFL status resolved explicitly, not left ambiguous | Product decision needed on NFL; no code gap for the other four beyond league breadth |
| Leagues | Football hardcoded to EPL by default; other big-5 leagues aliased but practically unreachable (no `league` field ever populated) | `league` becomes a real, captured field; default-to-EPL behavior removed | Requires both a parser-schema change and an `oddsVerifier.ts` request-construction change |
| Markets | Only `h2h` ever requested; only bare 1X2 shorthand verified | Totals, Double Chance, BTTS, Spread added as canonical markets, each independently requested/verified | Requires new provider requests per market type, new canonical-market vocabulary, new selection-classification logic per market (analogous to today's `classifySingleSelection` but generalized) |
| Parser output | `market` field exists, hardcoded to `null`; no `league`, `eventStartTime`, `period`, or `line` fields exist | All of the above become real, populated tool-schema fields | Requires `lib/ai/betParser.ts` tool-schema and prompt changes — explicitly out of scope for this step ("do not refactor parser logic") and for Step 4's interface design alone; flagged here as a dependency for a later step |
| Provider request | Fixed `regions=eu&markets=h2h` | Multi-market requests per canonical market needed for that selection | New request-construction logic, likely provider-specific — exactly the kind of detail an `OddsProvider` abstraction (Step 4) should isolate |
| Event matching | Fuzzy word-overlap, no tie-break signal, no `eventStartTime` disambiguation | Same fuzzy approach retained (Step 2 audit found it functionally sound for its current scope) but gains an explicit `AMBIGUOUS_EVENT` outcome and `eventStartTime`-based disambiguation | Behavioral addition, not a rewrite, of `findMatchingEvent` |
| Selection matching | 1X2-shorthand exact-token classification (robust) + fuzzy name fallback (works for team-name selections only) | Extended with per-canonical-market classification (totals line parsing, BTTS yes/no, double-chance combos) | New classification functions per market, following the existing `classifySingleSelection` pattern |
| Status mapping | 4 statuses, `NOT_FOUND`/`UNAVAILABLE` each conflate multiple reasons | Full reason-code model from Section 9, small public surface | New enum + mapping layer |
| Confirmation | **Permissive**: no re-check at confirm time; every `BetSelectionOddsStatus` (`VERIFIED`/`ODDS_CHANGED`/`NOT_FOUND`/`UNAVAILABLE`) is currently submittable (`betSlipRules.ts:79-101`); `submittedOdds` is written directly to `Bet`/`BetSelection` with no `acceptedOdds` concept anywhere | **Blocking-by-default**: only `VERIFIED` and `ODDS_CHANGED`-after-explicit-acceptance are confirmable; every other status/reason code blocks; confirm-time recheck required for both; confirmed odds/payout sourced from `acceptedOdds` only, never `submittedOdds` directly; EXPRESS requires every leg to have `acceptedOdds` and pass its recheck, one blocking leg blocks the whole slip | New `acceptedOdds` field/tracking, explicit-acceptance UI flow for `ODDS_CHANGED`, confirm-time recheck call site, and replacement of today's permissive `betSlipRules.ts` policy with the blocking-by-default one — design detailed in `docs/ODDS_PROVIDER_DESIGN.md` Sections 8, 12, 13 |
| Persistence | No bookmaker/provider-ID/discrepancy on `BetSelection`; no verification timestamp for EXPRESS legs; `market` column always null; no `acceptedOdds`/`reasonCode` field anywhere | Persist enough to audit "what was actually checked and against what" (Section 12's acceptance criteria), including immutable per-attempt snapshots and `acceptedOdds` as the sole source of confirmed/settled odds | Schema additions (out of scope for this step and for Step 5 — see `docs/ODDS_PROVIDER_DESIGN.md` Section 15/18 Phase G) |
| Tests | Strong coverage of 1X2/team-name matching (37+ dedicated tests), zero real-network calls | Equivalent coverage for each new canonical market | New test suites per market, following the existing fetch-stub pattern |
| Observability | Content-free structured logs (status/duration/index only) — a deliberate, sound design choice (Step 2 audit Section 10) | Same design principle retained, extended to cover new reason codes | Additive only, no redesign needed |

## 11. Explicitly Deferred Scope

Not built in the next MVP, with no current product evidence overriding the default deferral:

- **Live/in-play odds** — the current architecture (45s cache TTL, single-request-per-preview model, no websocket/streaming client, no `eventStartTime` field to even know if an event has started) has no safe path to in-play odds today. Confirmed not already supported: nothing in `oddsVerifier.ts` requests or reads in-play state from The Odds API. Out of scope per the task's own instruction and confirmed by code, not assumed.
- **Player props** — no parser, display, or provider evidence anywhere (Section 5).
- **Exact score** — same, no evidence.
- **Outrights/futures** — same, no evidence; also structurally incompatible with the current single-event `findMatchingEvent` model (a season-long outright has no single "event" to match against).
- **Same-game parlays / bet builders** — no evidence; EXPRESS today is a multi-*event* accumulator, not a multi-selection-within-one-event product, and nothing suggests the latter is wanted.
- **Bookmaker-specific custom markets** — no evidence, and directly contradicts the "canonical, provider-independent market taxonomy" goal of Section 5.
- **Automatic settlement from provider results** — explicitly listed as not-done in `README.md`'s "What's not done yet" section already; this document does not change that scope, only notes it's consistent with keeping odds verification and settlement as separate concerns.
- **Websocket streaming** — no evidence of need; the current 45s-cache/request-per-check model is adequate for a pre-match, operator-mediated product at current scale.

Nothing in this list is deferred against explicit contrary evidence — README's "What's not done yet" section and the full grep sweep of `components/miniapp`/`components/bets` turned up no mention of any of the above as a stated goal.

## 12. Acceptance Criteria for the Next Architecture Stage

Testable design acceptance criteria for Step 4:

1. Every supported selection maps to exactly one canonical market from Section 5's taxonomy — no selection is verified against an implicit or guessed market.
2. `sport` and `league` are never conflated in the interface design — a football bet's league is a first-class input, not inferred from the sport string (Section 7).
3. Parser recognition is never presented, in any API response or UI state, as equivalent to provider verification — the distinction from Section 1 must be structurally enforced (e.g., a selection the parser captured but the provider never checked cannot render with the same visual treatment as `VERIFIED`).
4. `MARKET_NOT_SUPPORTED`/`SPORT_NOT_SUPPORTED`/`LEAGUE_NOT_SUPPORTED` (a "we don't cover this yet" family) are structurally distinct, in both the internal reason-code enum and any persisted data, from `PROVIDER_UNAVAILABLE`/`PROVIDER_TIMEOUT` (a "something went wrong" family) — this directly resolves the Step 2 audit's confirmed `NOT_FOUND` conflation finding.
5. No `AMBIGUOUS_EVENT` case can be silently accepted as a confident match — the interface must expose enough information (a confidence score or a competing-candidates list) for the caller to detect and block ambiguity, not just return one winner as `findMatchingEvent` does today.
6. SINGLE and EXPRESS continue to share one canonical model end-to-end (matching the existing, sound `ParsedBetSlip`/`BetSlipSelectionInput` design) — the interface must not introduce a second, parallel shape for either bet type.
7. Provider-specific identifiers (The Odds API's `sport_key`, bookmaker `key`, event `id`) never leak into core domain types (`OddsVerificationInput`, `OddsCheckResult`, or their Step 4 successors) — they stay inside the provider-adapter implementation.
8. The interface design must demonstrate, on paper, that a second provider could be added by implementing the interface alone, with zero changes to `buildBetSlipPreview.ts`'s business rules (selection iteration, parallel verification, previewToken gating policy).
9. Confirmation policy (Section 8) is explicit and testable for every status in Section 9's model — no status is left with undefined confirm-time behavior. **`acceptedOdds` is the only field a `Bet`/`BetSelection` may source its confirmed odds, payout, or settlement math from** — `submittedOdds` is never treated as the accepted price once verification has run.
10. Persisted data is sufficient to answer, after the fact, exactly what was checked: which provider, which market, which bookmaker, what price, at what time — for both SINGLE and EXPRESS legs equally (today this is asymmetric and incomplete even for SINGLE — Step 2 audit Section 9).
11. **Blocking-by-default is enforced identically for SINGLE and EXPRESS**: normal player confirmation is only reachable via `VERIFIED` or explicitly-accepted `ODDS_CHANGED`; for EXPRESS, a single leg with any other status/reason code blocks the entire slip — no partial-confirm path exists in the normal flow.

## 13. Final Recommended MVP Matrix

**Sports**

| Sport | MVP status |
|---|---|
| Football / Soccer | MVP_REQUIRED |
| Basketball | MVP_REQUIRED |
| Tennis | MVP_REQUIRED |
| Ice Hockey | MVP_REQUIRED |
| American Football | DEFERRED (pending explicit product decision — see Section 3) |
| Baseball, Volleyball, Golf | DEFERRED (DISPLAY_ONLY today, no provider-support evidence) |
| Esports, MMA/Boxing, Cricket, Rugby | DEFERRED (no investment at any layer) |
| Other/unknown | UNSUPPORTED |

**Leagues** (only for MVP_REQUIRED sports)

| Sport | MVP_REQUIRED leagues | Deferred |
|---|---|---|
| Football | EPL, La Liga, Serie A, Bundesliga, Ligue 1, UEFA Champions League | UEFA Europa League, international tournaments, other domestic leagues |
| Basketball | NBA | EuroLeague, NCAA, others |
| Tennis | Grand Slams (existing) + ATP/WTA tour-level (new — flagged as a real design gap, not a simple mapping addition) | Challenger/ITF |
| Ice Hockey | NHL | KHL, European leagues |

**Markets**

| Canonical market | MVP status |
|---|---|
| `MONEYLINE_2WAY` | MVP_REQUIRED (already working) |
| `MONEYLINE_3WAY` | MVP_REQUIRED (already working, best-covered path today) |
| `DOUBLE_CHANCE` | MVP_REQUIRED (strong display-layer evidence, currently backend-blind) |
| `TOTALS` | MVP_REQUIRED (strong display-layer evidence, currently backend-blind) |
| `BOTH_TEAMS_TO_SCORE` | MVP_REQUIRED (strong display-layer evidence, currently backend-blind, football-specific) |
| `SPREAD` | MVP_REQUIRED for basketball/hockey (per task's product principles); evaluate again for football specifically (Asian handicap complexity) before committing |
| `DRAW_NO_BET`, `TEAM_TOTAL` | DEFERRED |
| `EXACT_SCORE`, `PLAYER_PROP`, `OUTRIGHT` | DEFERRED |
| `UNKNOWN` | Permanent fallback bucket, not a feature — should shrink over time, never a target state |

This recommendation is conservative by design: it extends coverage only where current code (display normalization, existing aliases, dashboard inclusion) already shows product investment, and defers everything else pending explicit evidence — consistent with the task's instruction not to select or compare providers, and not to over-scope the next MVP.
