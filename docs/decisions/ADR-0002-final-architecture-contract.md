# ADR-0002: Final Architecture Contract & Sector Roadmap

Date: 2026-08-19

Status: Accepted

## Context

Two independent architectural audits of BetPilot AI were conducted (read-only, no production code changed). The first covered the whole repository end to end — lifecycle/state management, security, data layer, concurrency, dependencies, and test coverage — and identified the root causes behind a recurring "fix one thing, another breaks" pattern. The second re-audited the codebase specifically against a product contract the project owner fixed for BetPilot's recognition → odds → confirmation → settlement pipeline (AI extracts, deterministic code decides; one odds provider as source of truth; mandatory player confirmation; EXPRESS per-leg resolution; operator Accept/Reject-only; automatic settlement with a safe manual fallback). Both audits verified every claim against the actual code (file:line citations), not against existing documentation, which was found in several places to be stale relative to the real system.

The project owner has since made one additional, final product decision on settlement (see below), closing the one open question the second audit flagged before this contract could be locked.

## Problem

The project needed a small, durable set of architectural invariants — verified against real code, not aspirational — plus an ordered, boundaries-respecting roadmap to close the confirmed gaps without re-entering the patch-loop pattern (a local fix reopening a previously-closed case elsewhere) that motivated the first audit.

## Decision

### Final settlement decision (owner-selected)

- Unambiguous result → automatic settlement.
- Ambiguous/conflicting result → `NEEDS_REVIEW`.
- Operator makes the final manual call on `NEEDS_REVIEW`.
- Player receives the result/notification.
- Player confirmation is **not** required for settlement and **cannot** block it.
- No silent overrides. No guessing on ambiguous results.

### 1. Final Architecture Contract

**Recognition.** AI only extracts and structures information. AI never makes a business decision, never determines the final odds, never confirms a bet, never settles a bet.

**Validation.** After AI produces a candidate, every decision is made by deterministic code.

**Odds.** The single source of truth for the final coefficient is the active odds provider. Odds read from a player's text, screenshot, or an old slip are never final without fresh provider verification.

**Player confirmation.** The player always sees the final bet structure with current odds before submission. A change in odds requires a new, explicit confirmation.

**EXPRESS.** Each leg resolves independently. An unavailable leg must not force the player to rebuild the whole EXPRESS. The player can exclude the problem leg. After exclusion: EXPRESS recalculates, a new preview is produced, confirmation is required again. Minimum/maximum leg count follows the current EXPRESS rule.

**Operator.** For now, Accept/Reject only. Cannot edit stake, odds, market, or selections.

**Settlement.** Unambiguous result → automatic settlement. Ambiguous → `NEEDS_REVIEW`. Operator resolves `NEEDS_REVIEW`. No silent override, no double settlement, no guessing. Player confirmation is not required and cannot block settlement.

**Reliability.** When correctness of a result cannot be proven, the system fails closed.

**Scope — not designed now:** voice input, WhatsApp/other channels, unnecessary multi-provider architecture, premature scalability.

### 2. Invariant verification against actual code

| Invariant | Status | Mechanism / file |
|---|---|---|
| AI extracts / code decides | ALREADY GUARANTEED | Everything after `parseBetSlipMessage()` / `recognizeBetSlipScreenshot()` is plain TypeScript with no AI call; `lib/bets/buildBetSlipPreview.ts` is fully deterministic. |
| Odds provider = single source of truth | ALREADY GUARANTEED | `lib/odds/oddsVerifier.ts:889-898` returns `sourceOdds` only on a confirmed provider match; `buildBetSlipPreview.ts:569-604` computes `totalOdds`/`potentialWin` exclusively from `effectiveVerifiedOdds`, never from `submittedOdds`. In-code comments document a prior violation of this rule that was found and fixed. |
| Player confirmation mandatory; odds change requires new confirmation | ALREADY GUARANTEED | Signed `previewToken`; the confirm route always re-verifies freshness live (`verifyPreviewFreshness`); `ODDS_CHANGED_RECONFIRM_REQUIRED` returns a new preview + new token — the old one is never auto-accepted (`betConfirmApi.ts`). |
| EXPRESS: independent per-leg resolution | ALREADY GUARANTEED | `buildBetSlipPreview.ts` resolves odds for every selection independently via `OddsVerificationService.verifyMany()`. |
| EXPRESS: leg removal without rebuilding the whole bet | **NOT GUARANTEED** | No `removeSelection`/`removeLeg`/`dropSelection` code exists anywhere in the repo (confirmed by grep). `components/miniapp/canConfirmBetSlip.ts:96-110` blocks confirmation of the entire EXPRESS if even one leg is `NOT_FOUND`/`UNAVAILABLE`/`PENDING`. |
| EXPRESS min/max legs = 2–10 | ALREADY GUARANTEED | `lib/bets/betSlipRules.ts` defines `MIN_EXPRESS_SELECTIONS=2`, `MAX_EXPRESS_SELECTIONS=10`, enforced in `lib/bets/createBetFromPreview.ts:224-234` and independently (documented, intentional duplication) in `lib/betPreview/previewToken.ts:556-566`. |
| Operator cannot edit stake/odds/market/selections | ALREADY GUARANTEED | `app/api/bets/[id]/confirm/route.ts` and `.../reject/route.ts` read no request body at all — only the URL `id` and the auth header; no edit input exists anywhere in `components/operator/`. |
| Settlement: unambiguous result → automatic | PARTIALLY GUARANTEED | `lib/bets/settlement/autoSettleSingleBet.ts` / `autoSettleExpressBet.ts` / `pollConfirmedBetResults.ts` are real and call the same safe primitives as manual settle, but `app/api/internal/poll-results/route.ts` is not yet wired to any scheduler — the mechanism exists, the automation is not live. |
| Settlement: ambiguous → `NEEDS_REVIEW` | **NOT GUARANTEED** | `SettlementReviewStatus`/`SettlementReviewReason` (19 specific reasons, e.g. `PARTICIPANT_MISMATCH`, `AMBIGUOUS_PARTICIPANT_MATCH`, `INVALID_SCORE` — `prisma/schema.prisma:80-125`) and the corresponding `Bet` fields already exist in the schema, but zero application code references them (confirmed by grep). The taxonomy is fully designed but not wired in. |
| No silent override / double settlement | ALREADY GUARANTEED | `lib/bets/settlementRules.ts::decideSettlementTransition` is the single decision point: repeating the same terminal status is `IDEMPOTENT`; requesting a different one over an already-settled bet throws `SettlementConflictError` — never a silent overwrite. |
| Player confirmation not required for / cannot block settlement | ALREADY GUARANTEED (no change needed) | No settlement code path (manual or automatic) reads or waits on any player-side state (confirmed by grep across `settleBet.ts`, `settlementRules.ts`, and both settle routes). |
| Fail closed when correctness can't be proven | PARTIALLY GUARANTEED | Fully enforced at the odds/single-bet level (see above). The design intent is visible in the `SettlementReviewReason` taxonomy, but since that taxonomy isn't wired in yet, this guarantee isn't active at the settlement-ambiguity level. |
| Cross-operator data isolation (carried over from the first audit; not part of the new contract text but directly under the Reliability/Security priority) | **NOT GUARANTEED** | `Player.operatorId` exists in the schema but is filtered nowhere in `/api/dashboard/*` or `/api/bets/*` queries — a second `Operator` row would leak data across operators today. |

8 of 12 verified invariants are already guaranteed by real, working code — several with in-code regression comments documenting a past violation that was found and fixed. The two EXPRESS/settlement gaps are not new designs, but completion of infrastructure that was already designed and partially built (a settlement review taxonomy already sitting in the schema, unused). The IDOR item is a live security gap outside the new contract's text but within its Reliability/Security priority, carried forward from the first audit.

### 3. Final Sector Roadmap

The originally proposed order (0 → 6) is sound; one addition is proposed and explained below, not a reordering.

**Deviation from the proposed order:** the given list has no dedicated slot for the cross-operator IDOR fix found in the first audit. It is small, independent, and shares no files with Sectors 1–6. Recommendation: fold it into Sector 0 rather than adding a numbered sector, since it is a pure baseline correctness fix, not new product work.

#### Sector 0 — Architecture Contract / baseline
- **Purpose:** lock in this document as the single architectural source of truth; fix cross-operator IDOR as the only active security deviation found in either audit.
- **Files/areas allowed:** this ADR; `app/api/dashboard/*/route.ts`, `app/api/bets/*/route.ts` (add `operatorId` scoping to existing Prisma queries).
- **Areas forbidden:** any recognition/odds/settlement logic.
- **Dependencies:** none.
- **Definition of Done:** this ADR merged; every dashboard/bets query filters by `operatorId`; a second test `Operator` cannot see the first operator's players.
- **Automated verification:** `tsc`, `lint`, `test`, `build`; a new test covering operator scoping.
- **Manual verification:** create a second local test operator, confirm data isolation.
- **Regression risk:** LOW.
- **Rollback boundary:** additive `WHERE` clauses per route, no schema migration.

#### Sector 1 — EXPRESS per-leg recovery
- **Purpose:** close the one confirmed live contract violation — leg removal, recalculation, mandatory reconfirm.
- **Files/areas allowed:** `lib/bets/buildBetSlipPreview.ts` (support excluded legs), `lib/betPreview/previewToken.ts` (only if a new signing parameter is needed — not the crypto logic itself), `components/miniapp/canConfirmBetSlip.ts`, `BetPreviewCard.tsx`, the EXPRESS selections-list component, a new preview-request parameter.
- **Areas forbidden:** the SINGLE path, the confirm route (beyond reusing the existing reconfirm mechanism), odds-provider code, settlement, operator routes.
- **Dependencies:** Sector 0.
- **Definition of Done:** a player can exclude an unavailable leg (hard floor at `MIN_EXPRESS_SELECTIONS = 2` — removal that would drop below 2 is disabled, offering full-bet Cancel instead); exclusion produces a new preview with recalculated `totalOdds` and requires explicit reconfirmation through the existing reconfirm mechanism.
- **Automated verification:** new unit tests for leg-exclusion recalculation; full `npm test`/`tsc`/`build`/`lint`.
- **Manual verification:** a real EXPRESS with a deliberately unavailable leg (e.g. an already-started event), end to end.
- **Regression risk:** LOW.
- **Rollback boundary:** one sector, one commit; reverts cleanly without touching SINGLE/settlement/operator code.

#### Sector 2 — OCR real regression corpus
- **Purpose:** close the one confirmed structural test-pyramid gap — zero real images in OCR tests, in the most frequently patched area of the codebase.
- **Files/areas allowed:** new fixtures + tests under `lib/testing/` / `lib/ocr/`.
- **Areas forbidden:** `betParser.ts` / `lib/ocr/*` production logic.
- **Dependencies:** none; can run in parallel with Sector 1, sequenced after it in this roadmap.
- **Definition of Done:** 2–3 real or high-fidelity synthetic fixtures per bookmaker for the 7 named in `SCREENSHOT_RECOGNITION_REPORT.md` Appendix A, run through the real pipeline, results recorded in tests.
- **Automated verification:** `npm test`.
- **Manual verification:** visual check that fixtures resemble real bookmaker slips, not trivial stand-ins.
- **Regression risk:** LOW.
- **Rollback boundary:** isolated to test files.

#### Sector 3 — Confirm/error recovery UX
- **Purpose:** fix the confirmed gap where `SELECTION_UNAVAILABLE`/`VERIFICATION_UNAVAILABLE` return a generic message and don't reset the stale token, inviting a pointless resubmit of an already-rejected token.
- **Files/areas allowed:** `betConfirmApi.ts` (messages + `shouldResetPreviewAfterConfirmFailure`).
- **Areas forbidden:** `verifyPreviewFreshness`/`decideFreshnessOutcome` logic itself — client-side handling of existing codes only.
- **Dependencies:** none technically; sequenced after Sectors 1–2.
- **Definition of Done:** distinct, actionable messaging for both codes; correct token reset preventing a meaningless retry.
- **Automated verification:** existing confirm-route tests + new cases for both codes.
- **Manual verification:** force `VERIFICATION_UNAVAILABLE` in dev, check the UX.
- **Regression risk:** LOW.
- **Rollback boundary:** single file, clean revert.

#### Sector 4 — Test/documentation/dead-code cleanup
- **Purpose:** remove `lib/odds/providerRegistry.ts` (dead code, zero callers), sync README / `OPERATOR_AUTH_AUDIT.md` / stale in-code comments (e.g. `oddsVerificationService.ts`'s header, which contradicts its own now-live wiring) with reality; optionally extract repeated `className` strings into named constants where `components/miniapp/*.test.ts` currently regex-matches raw source text.
- **Files/areas allowed:** the dead file and its test, markdown docs, comments, targeted className-constant extraction in files already touched by Sector 1.
- **Areas forbidden:** any recognition/odds/settlement/confirm production logic.
- **Dependencies:** logically easiest after Sector 1 (shared files for the className work), not strictly ordered otherwise.
- **Definition of Done:** grep confirms zero references to removed dead code; docs reflect actual current state (test count, `tsc` status, operator-auth status).
- **Automated verification:** `tsc`/`build`/`test`.
- **Manual verification:** a read-through of README/docs against the code.
- **Regression risk:** LOW.
- **Rollback boundary:** docs + one dead file removed — trivial revert.

#### Sector 5 — Automatic settlement + NEEDS_REVIEW
- **Purpose:** implement the owner's final settlement decision using the settlement-review schema that's already designed but not wired in.
- **Files/areas allowed:** application code populating `settlementReviewStatus`/`settlementReviewReason`/`lastSettlementErrorMessage` inside `autoSettleSingleBet.ts`/`autoSettleExpressBet.ts`/`pollConfirmedBetResults.ts` on ambiguity; a new operator-facing route/UI to resolve `NEEDS_REVIEW` (accepting one of the candidate outcomes — never a free-form odds/stake edit); wiring `poll-results` to a scheduler.
- **Areas forbidden:** `lib/bets/settlementRules.ts::decideSettlementTransition` stays untouched — it is already the correct single source of truth for the status transition. `NEEDS_REVIEW` must be set **before** this function is ever called (when auto-settlement cannot decide a `SettlementTarget`), not as a new branch inside it. `SETTLEMENT_TARGET_STATUSES` (the settle route's public surface) is not to be widened — `SETTLED_HALF_WIN`/`SETTLED_HALF_LOSS` are intentionally excluded pending a separate, already-flagged future decision (`H4-B3`); do not conflate the two changes.
- **Dependencies:** none technical, but sequenced last among the feature sectors because it is the one sector that activates new automation over real money — best built on an already-stabilized base.
- **Definition of Done:** unambiguous results settle automatically through the existing safe primitives; an ambiguous result (per the `SettlementReviewReason` taxonomy) moves the bet to `NEEDS_REVIEW` with no status/money change; the operator explicitly resolves `NEEDS_REVIEW` through the new UI; `SettlementConflictError`/idempotency invariants remain green under all new tests.
- **Automated verification:** expanded settlement tests, including a simulated race between the auto-poller and a manual settle (must produce `SettlementConflictError`, never a silent overwrite); `tsc`/`lint`/`build`/`test`.
- **Manual verification:** staged rollout — dry-run/log-only against real completed matches first, then full activation; confirm `NEEDS_REVIEW` genuinely blocks automatic settlement and requires an explicit operator action.
- **Regression risk:** MEDIUM–HIGH — the only sector introducing new automation over money; requires its own Architecture Review stop before implementation begins (see §F below).
- **Rollback boundary:** the cron can be disabled independently of the code (flag/env), no revert required; the review fields/flow are additive, no migration of existing settled rows.

#### Sector 6 — Final regression / real-device / production QA
- **Purpose:** end-to-end verification of the whole roadmap before declaring the cycle complete.
- **Files/areas allowed:** test scenarios / QA checklists only — no new production changes.
- **Areas forbidden:** any new feature work "while we're at it."
- **Dependencies:** Sectors 0–5 complete.
- **Definition of Done:** full regression suite green; manual pass of SINGLE, EXPRESS (including leg removal), operator confirm/reject, settlement (automatic + `NEEDS_REVIEW`) on a real/staging environment.
- **Automated verification:** full `npm test`/`tsc`/`lint`/`build`.
- **Manual verification:** a checklist per sector, including cookie flags on a real Vercel deployment (an open item carried from the first audit).
- **Regression risk:** LOW by itself; this is where risk accumulated in Sectors 1–5 would surface.
- **Rollback boundary:** N/A — a gate, not a change.

### 4. Working rule (confirmed)

Architecture decision → ONE bounded implementation → targeted tests → full regression → typecheck → lint/build → manual QA → review diff → commit → next step. Any change requiring work outside the current sector's boundaries is a STOP: explain the dependency, obtain a new architecture decision, then proceed.

### 5. Anti-regression rules

1. Every bug found gets a regression test at or before the fix (already an existing house convention — continue it, don't reinvent it).
2. No production change is made solely to pass a brittle test — a test that blocks a legitimate change gets fixed, not worked around.
3. No new OCR heuristic without regression evidence (a fixture demonstrating the specific real case it closes) — nothing added "just in case."
4. No incidental changes to a neighboring layer "while we're in there" — if Sector 1 turns out to require an odds-provider change, that's a STOP and a new decision, not a silently widened diff.
5. No broad refactors inside a single feature sector — one sector, one narrow diff.
6. The full test suite is required before every commit, never a partial run.
7. One logical commit per completed sector — sectors are never split or merged across commits.

### 6. Existing architecture — not to be touched

The following guarantees, already verified correct by both audits, remain unchanged without a separate, explicit architectural justification: provider-odds source-of-truth (`oddsVerifier.ts`/`buildBetSlipPreview.ts`), the `previewToken` mechanism, live re-verification on confirm, mandatory reconfirm after an odds change, credit-limit `SELECT ... FOR UPDATE` concurrency control, `decideSettlementTransition` (settlement transition protection), the operator Accept/Reject-only boundary, and the AI-extracts/code-decides split. No sector in this roadmap touches these mechanisms — only builds around them.

## Alternatives

- **A full recognition-pipeline or settlement rewrite** was considered and rejected — both audits found the core architecture (preview/token/confirm cycle, odds reconciliation, settlement transition guard) already sound and, in several places, already defended by in-code regression comments documenting a past violation that was fixed. A rewrite would discard working, verified safety guarantees for no found benefit.
- **One large sector covering EXPRESS + settlement together** was considered and rejected — the two are independent in code (no shared files) and differ sharply in regression risk (LOW vs. MEDIUM–HIGH, since only settlement introduces new automation over real money). Splitting them keeps each rollback boundary clean and lets Sector 5 get its own Architecture Review stop without blocking the EXPRESS fix behind it.
- **Adding IDOR as its own numbered sector** was considered and rejected in favor of folding it into Sector 0 — it shares no files with any other sector and is a pure baseline correctness fix, not new product work; giving it a full sector slot would overstate its scope.

## Consequences

- Every future change to recognition, odds, EXPRESS, confirmation, operator flow, or settlement must be checked against this contract before implementation; a change that would violate an "ALREADY GUARANTEED" row requires a new ADR justifying it, not a silent diff.
- The roadmap's sector boundaries are binding for the "one bounded implementation" working rule in §4 — scope creep across a sector boundary is a required STOP, not a judgment call made mid-implementation.
- Sector 5 (automatic settlement) is explicitly gated behind its own Architecture Review stop before implementation starts, since it is the only sector that turns on new automation over real money.
- `SettlementReviewStatus`/`SettlementReviewReason` and the `Bet` review fields already in `prisma/schema.prisma` are now understood to be a deliberate, designed-but-unwired scaffold for Sector 5 — future work should extend this taxonomy, not replace it.

## Future work

- Sector 5 needs its own follow-up ADR at the point implementation actually starts, recording: who resolves `NEEDS_REVIEW` in edge cases, whether a dry-run period precedes full cron activation, and the exact operator-facing resolution UX.
- `SETTLED_HALF_WIN`/`SETTLED_HALF_LOSS` (schema-level since `H4-B1`/`H4-B3`, not yet reachable through any public route) need their own future ADR before they're exposed — explicitly out of scope for Sector 5.
- The odds-provider abstraction (`lib/odds/providerRegistry.ts`, currently dead code) should stay deleted/frozen until a second live provider actually needs routing between two sources — reintroducing it earlier would be the premature scaling this contract's Scope section explicitly excludes.
