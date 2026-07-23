# Screenshot Recognition Report — Stage 4.5E

> **Historical document — superseded architecture.** This report describes the previous direct-Claude-Vision screenshot parsing design (a single multimodal call straight from image bytes to structured bet fields, via `extract_single_bet_from_image`/`extract_parlay_bet_from_image`). That design has since been replaced by an OCR-first pipeline: a provider-agnostic OCR step transcribes the image to text (`lib/ocr/`), and the same parser the text-bet flow uses (`lib/ai/betParser.ts`) extracts the structured bet from that text — there is no separate image-to-structured-data call anymore. `README.md` and the current code under `lib/ocr/`, `lib/ai/`, and the preview/confirm flow are the source of truth for actual behavior today. This document is kept only as a historical record of the architecture and findings at the time it was written, and is not being updated to match the current pipeline.

Analysis-only. No code, UI, backend, confirm, previewToken, Prisma, dashboard, or settlement logic was modified while producing this document.

## Executive Summary

The screenshot bet-submission pipeline (Stage 4.5B–D) is architecturally sound for its current, deliberately narrow scope: single-selection bets only, decimal odds only, no image persistence. Its central safety property is that every identified gap in this report **fails safe** — an explicit rejection or a `422`, never a silently wrong `Bet` written to the database. That property comes from the design (a mandatory `reject_bet` escape hatch, a second independent Zod validation layer, no auto-confirm of ambiguous data), not from anything having been empirically tested against real bookmaker screenshots — no such testing has happened yet (see Methodology below).

Stage 4.5F closed the single highest-likelihood silent-bad-data risk identified during this review: an unbounded odds value that could let a misread decimal (`2,10` → `210`) pass validation undetected. Everything else in §3/§4 remains an unimplemented, prioritized recommendation, not a fix already made.

PARLAY bets are detected but intentionally not confirmable — the signed-token format and the confirm step's data model only represent a single selection today (§6). This is a known, documented gap, not an oversight.

The most valuable next step is empirical, not further code changes: running Appendix A's test matrix against real bookmaker screenshots. Every recommendation in this report beyond the odds cap is currently a hypothesis grounded in code review and general bookmaker-UI knowledge, not a measured finding.

## Out of Scope

This report, and the Stage 4.5F change it documents, do **not** cover:

- Implementing PARLAY confirmation (token format, `Bet`/`BetSelection` creation, settlement) — tracked separately in §6 and ADR-0001's Future work.
- Any prompt change beyond what Stage 4.5F required (the odds-cap addition touched validation only, not `CLAUDE_IMAGE_SYSTEM_PROMPT`).
- American/fractional odds support, comma-decimal stake parsing, or any other schema/prompt change proposed in §4 — these are proposals only, not implemented.
- Empirical accuracy testing against real bookmaker screenshots — blocked in this environment by the lack of real or synthetic sample images (see Methodology).
- Rate limiting on the screenshot endpoint — a pre-existing, separately documented gap (README, §7 risk table), unaffected by this pass.
- Any change to the operator dashboard, settlement, Prisma schema, confirm endpoint, or previewToken format.
- Currency handling, multi-image/stitched screenshots, and Bet Builder / same-game-multi support — all listed as future work in §5, none started.

## Methodology & a hard limitation, stated upfront

This report is **static analysis** — a close reading of the actual prompt, tool schemas, Zod validation, and client code, plus general knowledge of how the named bookmakers' UIs are typically laid out. It is **not** a report of measured results from real screenshots.

I have no way to obtain real bookmaker screenshots in this environment (no web browsing/scraping was used — deliberately, since scraping bookmaker UIs isn't an appropriate use of that capability even if it existed here, and no image-generation tool is available to fabricate realistic fakes). Section "Appendix A" below is therefore a **test plan/checklist template with empty result columns**, not a completed test matrix. Every "Actual result" / "Claude confidence" / "Recognition errors" cell is honestly marked `NOT RUN — needs a real screenshot`, not filled with invented numbers.

**If you can share real screenshots** (yours, sample/demo images from these bookmakers, or synthetic ones you generate), I can run them through the actual production endpoint and fill this matrix with genuine results in a follow-up pass.

Everything else in this report — the architecture summary, strengths, weaknesses, and recommendations — is fully grounded in the real, current code (re-read in full immediately before writing this).

---

## 1. Current architecture summary

```
multipart image (BetScreenshotForm.tsx, client-side MIME/size pre-check)
  -> POST /api/miniapp/bets/screenshot/preview
       -> Telegram initData verification (same as text flow)
       -> Player lookup (read-only)
       -> server-side MIME allow-list (image/jpeg|png|webp) + 10MB size check
       -> magic-byte signature check (JPEG/PNG/WEBP headers, catches a
          mislabeled/renamed file even if Content-Type looks right)
       -> single arrayBuffer() read -> base64
       -> parseImageWithClaude() [lib/ai/betParser.ts]
            -> Anthropic Vision model, tool_choice: "any", 3 tools:
                 extract_single_bet_from_image
                 extract_parlay_bet_from_image
                 reject_bet (shared with the text-parsing path)
            -> Zod validation (betFieldsSchema for SINGLE, a new
               parlayBetFieldsSchema for PARLAY) — trims strings first,
               rejects empty-after-trim, requires odds > 0 and finite
       -> SINGLE: verifyOdds() [unchanged] -> signPreviewToken() [unchanged]
          -> same response contract as text preview
       -> PARLAY: 422 PARLAY_CONFIRM_NOT_SUPPORTED + the recognized legs
          echoed back (no previewToken signed — the payload literally can't
          represent it: PreviewTokenPayload.type is a "SINGLE" literal)
```

Confirm (`POST /api/miniapp/bets/text/confirm`) and everything downstream of a signed token is completely unaware this preview came from an image — it's the exact same code path as the text flow.

---

## Architecture Scorecard

Qualitative, evidence-grounded — each rating cites the section of this report it's based on. No numeric scores are given; a number would imply a precision this analysis doesn't have, since none of it is backed by measured results (see Methodology).

| Dimension | Rating | Evidence |
|---|---|---|
| Fail-safe design (reject over guess) | **Strong** | `reject_bet` always available, prompt prefers refusal (§2); every gap in §3 fails as a rejection or `422`, never a wrong `Bet` (§7) |
| Input validation (MIME/size/magic-byte) | **Strong** | Server-side allow-list + magic-byte signature check before the file ever reaches the AI call (§1, §2) |
| Odds plausibility validation | **Adequate** | Upper bound implemented Stage 4.5F (§3.2); no equivalent bound on `stake` yet (§3.2 "Still open") |
| Non-decimal (American/fractional) odds support | **Missing** | Not supported in prompt, schema, or `oddsVerifier.ts` (§3.1) |
| Multi-bet vs. multi-leg disambiguation | **Weak** | No rule distinguishing a bet-history list from a real parlay slip (§3.3) |
| Settled-vs-open bet detection | **Missing** | No instruction to refuse a settled-bet receipt (§3.4) |
| Confidence signaling | **Missing** | Extraction is all-or-nothing; no partial-confidence field exists anywhere in the pipeline (§3.7) |
| PARLAY confirm readiness | **Missing, by design** | Detection works; confirmation is explicitly unbuilt pending a token/data-model decision (§6) |
| Architectural documentation | **Strong** | ADR-0001, `docs/CHANGELOG.md`, and this report itself cover the design and its known gaps |
| Empirical validation against real screenshots | **Missing** | No real or synthetic bookmaker screenshots were available in this environment (Methodology) |

## 2. Strengths

- **Tool-use, not free-text JSON parsing.** Claude must commit to a structured, schema-validated call (`strict: true`, `additionalProperties: false`) — there's no risk of unparseable prose, markdown fences, or partial JSON the way a plain-text completion approach would have.
- **A real refusal path exists and is cheap to trigger.** `reject_bet` is always available to Claude, and the prompt explicitly tells it to prefer refusing over guessing. This is the single most important safety property for a financial-adjacent feature — it means the *default failure mode* is "nothing happens" rather than "a plausible-looking wrong bet gets created."
- **Zod is a second, independent gate after Claude commits.** Even if Claude's tool call passes the JSON-schema-strict check, empty-after-trim strings and non-positive odds/stake still get rejected before anything reaches `verifyOdds`/`signPreviewToken`. Two independent validation layers (Anthropic's strict tool schema, then Zod) catch different failure classes.
- **The prompt already names two specific, real confusion risks** (promo/balance/potential-win vs. stake; combined parlay odds vs. per-leg odds) rather than a generic "be careful" — these read like they were written after thinking about actual bet-slip layouts, not guessed abstractly.
- **PARLAY is detected, not silently mangled.** The easy wrong move here would have been to just take the first selection and confirm it as if it were the whole bet. Instead, a detected parlay is a distinct, explicit, safe-failure branch — the user is told the truth (multi-selection detected, can't confirm yet) instead of getting a wrong single bet confirmed.
- **No image persistence** removes an entire class of risk (stale/leaked screenshots, storage-access-control bugs) at the cost of not being able to re-inspect a submission later — a reasonable tradeoff for the current stage.
- **Magic-byte validation happens before the file ever reaches Claude** — a mislabeled non-image file can't burn an API call or leak into a Claude request.

---

## 3. Weaknesses

Ordered roughly by how much they'd actually bite in practice, not by how they were discovered.

### 3.1 Decimal-only odds assumption is baked into validation, not just the prompt (highest concrete risk)

`betFieldsSchema`/`parlaySelectionFieldsSchema` both require `odds: z.number().positive()`. American odds are frequently **negative** for favorites (e.g. `-150`). If a screenshot genuinely shows American odds and Claude reads them correctly as `-150`, the Zod layer rejects the whole extraction as `"incomplete"` — the failure looks identical to "Claude couldn't read the odds at all," when actually it read them fine, just in an unsupported format. This is silent and indistinguishable from a genuine misread in the current error reporting. Matches the test matrix's own "American odds (future support)" item — confirmed as a real, current gap, not yet supported anywhere in the pipeline (prompt, schema, or `oddsVerifier.ts`, which also only compares decimal odds against The Odds API's decimal quotes).

### 3.2 No plausibility upper bound on odds — a misread comma/decimal could silently pass

**Status: implemented (Stage 4.5F).** `betFieldsSchema` and `parlaySelectionFieldsSchema` (`lib/ai/betParser.ts`) now share a `MAX_DECIMAL_ODDS = 1000` constant and reject any odds value above it (`z.number().finite().positive().max(MAX_DECIMAL_ODDS).nullable()`) with a dedicated "Decimal odds exceed the supported maximum" message, instead of silently accepting a misread like `2,10` → `210`. This closes the odds half of the risk described below.

Before Stage 4.5F, nothing capped how large `odds` could be — if Claude misread `2,10` (comma-decimal, common in RU/DE/IT-locale bookmaker UIs) as the integer `210` instead of `2.10`, that value sailed through `.positive()` without complaint. Real decimal bookmaker odds are essentially never above the low hundreds even for extreme longshots.

**Still open**: the same class of risk for `stake` with thousands-separator confusion (`1.000,00` EU-style vs `1,000.00` US-style formatting) — no plausibility check exists there yet; out of scope for Stage 4.5F, which was odds-only by design.

### 3.3 No disambiguation between "one slip, multiple legs" and "multiple unrelated slips in one screenshot"

The prompt says "call `extract_parlay_bet_from_image` if the slip shows two or more selections" but never addresses a **bet-history or bet-list screen** — several independent, unrelated bets stacked vertically (e.g. a "My Bets" tab showing 3 past tickets). That's visually "multiple selections" in the frame but semantically nothing like a parlay. Nothing in the prompt tells Claude to check whether the multiple legs share one stake/one slip container versus being separate cards/rows. This is a real, plausible source of a false-positive PARLAY classification (or worse, a nonsensical SINGLE extraction stitched from two unrelated tickets).

### 3.4 No instruction to distinguish an open slip from a settled bet receipt

A screenshot could just as easily be a **history entry for an already-settled bet** (with a "Won"/"Lost" badge and a payout figure) as an active slip about to be placed. The prompt never tells Claude to check for settlement/result indicators and refuse (or flag) a screenshot that's a receipt rather than a submission. Confirming a stale, already-resolved bet as if it were new is a believable real-world mistake a player could make by picking the wrong screenshot.

### 3.5 No "Bet Builder" / same-game-multi guidance

Several bookmakers (Bet365 notably) offer same-game multis that are visually multi-leg but are priced and settled as a single combined-odds bet, not as independent legs each with their own odds. The current binary SINGLE/PARLAY model plus the "each with its own odds" instruction doesn't map cleanly onto this bet type — Claude has no guidance on what to do when a slip shows multiple legs but only **one combined odds figure**, which is neither the `extract_single_bet_from_image` shape (one selection) nor a clean fit for `extract_parlay_bet_from_image` (which expects a per-leg odds value, nullable, but the schema and prompt don't say "if you only have one combined figure for the whole slip, put it — where?").

### 3.6 No promotional/UI-chrome exclusion beyond the one stake-vs-balance rule

The prompt calls out promo/balance/potential-win only in the context of not confusing it with **stake**. It says nothing about promotional banners, "boosted odds" badges, loyalty widgets, or navigation chrome bleeding into the **sport/event/selection** fields — e.g. a "🔥 Boosted!" banner or a cross-sell widget for an unrelated match rendered near the actual slip.

### 3.7 No confidence signal anywhere in the pipeline

The tool schemas are binary: Claude either commits to concrete values for every required field, or calls `reject_bet`. There's no middle ground — e.g. "I'm confident about sport/event/selection but the odds digit is partially obscured by glare." The client also has no way to show the player "we're not fully sure about this field, please double-check" — it's all-or-nothing. This directly limits how useful a "Claude confidence" column in a real test matrix could ever be, since the model currently has no field to report it in.

### 3.8 Sport-name freeform text vs. `oddsVerifier.ts`'s fixed alias map

`SPORT_KEY_ALIASES` in `oddsVerifier.ts` matches on a small fixed set of lowercased strings (`football`, `soccer`, `футбол`, specific league names). Nothing normalizes Claude's freeform `sport` output before it reaches that lookup. This isn't new to screenshots (the text flow has the exact same exposure), but screenshots make it *more* likely to surface: bookmaker UIs often label sports with icons, abbreviations, or region-specific names ("Ice Hockey" vs "Hockey", "Am. Football" vs "American Football") that a live typed message from a player is less likely to produce verbatim.

### 3.9 No few-shot / negative examples

The entire prompt is abstract rules, zero concrete examples of a correct extraction or a specific wrong one to avoid. This is a generic, well-established prompting gap rather than a bug — LLMs generally follow negative examples ("here's exactly the kind of mistake not to make") more reliably than abstract prohibitions alone, especially for perceptual/vision tasks where "what counts as ambiguous" is hard to specify purely in words.

---

## 4. Recommended prompt & validation improvements

**Proposals only — nothing below has been implemented.**

1. **Add an explicit odds-format rule to the prompt**: "Odds shown may be decimal (e.g. 2.10), fractional (e.g. 5/2), or American (e.g. +150 / -110). Convert fractional or American odds to their decimal equivalent before reporting. If you cannot confidently convert, treat odds as unreadable (null) rather than guessing." — pairs with a schema/roadmap decision (§5) on whether to actually support non-decimal input yet.
2. **Add an explicit decimal-separator rule**: "Some bookmaker interfaces use a comma as the decimal separator (e.g. 2,10 meaning 2.10) rather than a period. Read the numeric value, not the punctuation style." Cheap, targeted mitigation for 3.2's most likely real-world trigger.
3. ~~Add a plausibility upper bound in Zod~~ — **implemented in Stage 4.5F** (odds only; a `.max(...)` on stake is still open, see §3.2). Turns a silent 100x misread into an explicit, catchable validation failure instead of a plausible-looking wrong number reaching `verifyOdds`.
4. **Add an explicit "one slip vs. a list of bets" rule**: "If the image shows a list or history of multiple separate, independently-placed bets (e.g. a bet-history screen), this is not a parlay — call reject_bet, since only one bet can be submitted per screenshot." Directly closes 3.3.
5. **Add an explicit settled-bet rule**: "If the slip shows a result/settlement indicator (Won, Lost, Void, Cashed Out, a payout amount for a bet already graded), call reject_bet — only an open, not-yet-placed bet slip should be extracted." Directly closes 3.4.
6. **Add an explicit same-game-multi/Bet Builder note**, once a product decision is made on how (or whether) to represent it — see §6.
7. **Broaden the promo/chrome exclusion rule** from "stake only" to "any sport/event/selection field": "Ignore promotional banners, odds-boost badges, loyalty widgets, and navigation elements — extract only the fields of the actual bet slip itself."
8. **Add 2–3 short negative examples directly in the system prompt** (text description of a wrong extraction and why it's wrong — e.g. "if a boosted-odds badge shows '2.50 → 3.00', the actual odds being wagered is 3.00, not 2.50") once real screenshots make it clear which mistakes are actually common enough to be worth calling out by name, rather than guessing which ones matter most.
9. **Add an optional confidence/uncertain-fields signal** to both extraction tool schemas (e.g. `confidence: "high" | "low"`, or a `low_confidence_fields: string[]`), and surface it in the preview UI as a "please double-check" hint rather than blocking. This is a genuine schema change, not just a prompt tweak — flagged here as a proposal for a future stage, not something to slip in now.
10. **Post-processing**: normalize `sport` against a small canonical list (or feed `oddsVerifier.ts`'s existing alias keys back into the tool's field description as examples) before it reaches `verifyOdds`, to reduce the freeform-text-vs-fixed-alias-map mismatch in 3.8 — could be done without touching the prompt at all, purely as a mapping step after Zod validation.

None of these are large refactors; most are single-paragraph prompt additions or one-line Zod changes. They're listed here as a prioritized menu, not a mandate — see §8 for a suggested order.

---

## 5. Future support roadmap

Explicitly not built now, listed for later scoping:

- **American / fractional odds support** — needs the prompt rule (§4.1), a schema decision (accept negative odds? convert client-side vs. server-side? how does `oddsVerifier.ts`'s decimal-only comparison handle it?), and product sign-off on whether "convert everything to decimal" is the right universal internal representation (very likely yes, for consistency with the existing text flow and `Bet.odds`'s `Decimal(6,2)` column).
- **Confidence signaling** end-to-end (§4.9) — schema, prompt, and a UI treatment for "low confidence, please verify."
- **Same-game-multi / Bet Builder handling** (§3.5) — needs a product decision first: treat as SINGLE with a combined odds figure, treat as a new third bet-type, or explicitly refuse for now with a clear message. Recommend explicit refusal (extend the reject/parlay-not-supported pattern) until there's a concrete need, rather than guessing a data model for it.
- **Multi-image / stitched screenshots** — no support today for a bet slip that doesn't fit in one screenshot (long accumulator, scrolled view). Not addressed by this stage's scope; worth a line item once real usage surfaces it as an actual problem rather than a hypothetical one.
- **Currency-aware stake** — matches the text flow's own existing, already-documented limitation (no `currency` field anywhere in `ParsedBet`); screenshots from crypto-native books (see Appendix B, Stake) make this concretely visible rather than theoretical.

---

## Future Production Metrics

Nothing below is a measured value — no real screenshot volume has gone through this pipeline yet. This is a specification of what's worth instrumenting once it does, so that the hypotheses in §3/§7 can be checked against real usage instead of re-argued from code review alone.

- **Preview success rate**, split by outcome: `200` (SINGLE, ready to confirm) vs. each error code (`AI_TIMEOUT`, `AI_UNAVAILABLE`, `INCOMPLETE_BET_DATA`, `IMAGE_NOT_RECOGNIZED`, `PARLAY_CONFIRM_NOT_SUPPORTED`, `INVALID_IMAGE_SIGNATURE`, etc.). A skewed distribution would point directly at which §3 weakness is actually biting in practice.
- **`reject_bet` rate** — how often Claude refuses outright, as a fraction of all submissions. A useful signal for whether the prompt is too conservative or not conservative enough.
- **PARLAY detection rate** (`PARLAY_CONFIRM_NOT_SUPPORTED` frequency) — direct evidence of real demand for PARLAY confirm, to prioritize §6 against other work instead of guessing.
- **`MAX_DECIMAL_ODDS` rejection rate** (Stage 4.5F) — expected to be ~0 in legitimate use; a nonzero rate would mean either real American-odds usage reaching the endpoint or a genuine misread, both worth knowing about.
- **Preview → confirm conversion rate** for screenshots specifically, compared against the text flow's own conversion rate — a UX/trust signal for whether players abandon after seeing the extracted preview.
- **Anthropic Vision call latency** (p50/p95) — cost and UX planning; the current timeout (`CLAUDE_IMAGE_TIMEOUT_MS`) was set without production latency data.
- **Submitted file MIME type distribution** — would confirm or correct the assumption that all three allowed formats (JPEG/PNG/WEBP) are actually worth supporting.

None of these exist as dashboards or logs today; this section is a proposal for what to build, not a report of what's being tracked.

---

## 6. PARLAY readiness

**Detection: ready. Confirmation: not ready, and the gap is bigger than "just wire it up."**

What exists today: `extract_parlay_bet_from_image` reliably produces a typed, Zod-validated `{stake, selections[]}` shape, and the route returns it to the client as a safe `422`. That part is solid groundwork.

What's still missing before PARLAY can actually be *confirmed*, confirmed in the Stage 4.5A audit and unchanged since:

1. `PreviewTokenPayload.type` is a hardcoded `"SINGLE"` literal — the signed token format itself has no slot for multiple selections. This needs a payload version bump (the token already carries a version field, `v: 1`, for exactly this kind of change) or a parallel token shape.
2. `createBetFromPreview.ts` hardcodes `type: "SINGLE"` on `Bet.create` and never touches `BetSelection` at all — real work, not a flag flip.
3. No `BetSelectionStatus` exists yet, so even if a parlay bet got created with real `BetSelection` rows, a single leg couldn't be voided/settled independently of the whole slip — a settlement-side gap, not just a confirm-side one.
4. The operator dashboard (`BetQueueItem.tsx`/`BetHistory.tsx`/`PlayerCard.tsx`) still only renders flat single-bet fields — an operator confirming a parlay today would see incomplete/wrong information even if the data existed.
5. §3.5's Bet Builder ambiguity means "PARLAY" as currently modeled (independent legs, each with its own odds) may not even be the right shape for every real multi-leg bet type a screenshot could show.

Recommendation: don't start PARLAY confirm work until (1)–(2) have an explicit design decision (this is exactly the kind of question worth its own short architecture review, the same way Stage 4.4A preceded Stage 4.4B), and until at least a couple of real parlay screenshots have been run through the existing detection path to confirm the `selections[]` shape actually matches what real slips produce.

---

## 7. Risk assessment

| Risk | Likelihood (informed guess, not measured) | Impact | Notes |
|---|---|---|---|
| Odds misread by 10x/100x via comma/decimal confusion (§3.2) | Medium | High | Silently passes validation today; a wrong odds value reaching `verifyOdds`/preview could mislead a player into confirming a bet at odds they didn't actually see |
| American/fractional odds rejected as "incomplete" (§3.1) | Medium (depends on player base's bookmakers) | Low-Medium | Fails safe (rejection, not a wrong bet) but produces a confusing "we couldn't read this" message for a screenshot that was actually perfectly legible |
| False PARLAY from a bet-history screen (§3.3) | Low-Medium | Medium | Fails safe today (422, no Bet created) — annoying, not dangerous, until PARLAY confirm exists, at which point this becomes higher-impact |
| Settled-bet receipt read as a live slip (§3.4) | Low-Medium | Medium | Currently would extract as SINGLE and let the player confirm a stale, already-resolved bet as if new — no safeguard catches this today |
| Promo/chrome text bleeding into sport/event (§3.6) | Low | Low-Medium | Odds/stake are the financially sensitive fields; a wrong event/sport string is more likely to surface as an odds-verification mismatch (safe) than to silently succeed |
| No rate limiting on the endpoint (pre-existing, noted in README) | Medium | Medium | Each screenshot preview call costs a real Claude Vision request; unrelated to recognition quality but worth naming here since it directly affects the cost/abuse surface of this exact feature |

Nothing in this table is a "the feature is broken" finding — every identified failure mode either fails safe today (rejection or a `422`, no wrong `Bet` created) or is a data-quality issue that would surface as an odds-verification mismatch the player can see before confirming. The risk is real but bounded by the architecture's existing safe-failure design, not by luck.

---

## 8. Priority list before Stage 5

Ordered by (safety impact) ÷ (effort), highest first:

1. ~~Add the odds plausibility upper bound in Zod~~ (§4.3) — **done, Stage 4.5F**. Smallest possible change, closed the highest-likelihood silent-bad-data risk (§3.2). Not yet validated against real screenshots (no real screenshot testing has been performed at any point in this report).
2. **Add the comma-decimal and settled-bet-receipt prompt rules** (§4.2, §4.5) — both single paragraphs, both close believable real-world confusions.
3. **Add the "list of bets vs. one slip" prompt rule** (§4.4) — closes the false-PARLAY risk before any real player hits it.
4. **Run a real test pass** using Appendix A once real screenshots are available — this should happen before, not after, deeper prompt tuning, since further prompt changes without real data are just more guessing.
5. **Decide the American/fractional odds product question** (§4.1, §5) — needs a decision, not just code; block on product input rather than guessing the right internal representation.
6. **PARLAY confirm architecture decision** (§6) — explicitly sequence this as its own short design pass before any implementation, matching how Stage 4.4A preceded 4.4B.
7. Confidence signaling (§4.9) and the Bet Builder question (§3.5/§5) — lower urgency, larger design surface; revisit after 1–6 land and real usage data exists.

---

## Production Validation Checklist

Actionable items to work through before, or shortly after, real screenshot volume starts flowing — not a report of anything already verified.

- [ ] Run Appendix A's test matrix against real screenshots from each of the seven named bookmakers.
- [ ] Confirm `MAX_DECIMAL_ODDS = 1000` (Stage 4.5F) doesn't false-positive-reject any real legitimate decimal odds sampled from those bookmakers.
- [ ] Manually spot-check a sample of real confirmed screenshot-sourced bets against their source screenshot, looking specifically for a silent misread that stayed within the odds cap (e.g. `2.10` read as `21.0`).
- [ ] Once instrumented (see Future Production Metrics above), confirm the error-code distribution in production logs looks sane — no single code dominating in a way that suggests a systemic prompt or validation problem.
- [ ] Spot-check production logs to confirm no image bytes, base64 payloads, or `initData` ever appear in them — a check on actual log output, not just a re-read of the logging code.
- [ ] Decide the American/fractional odds product question (§4.1, §5) before a player reports decimal-only support as a bug.
- [ ] Decide the Bet Builder / same-game-multi handling (§3.5) before it's reported as a misclassification.
- [ ] Revisit rate limiting on the endpoint (§7) before any marketing push meaningfully increases screenshot volume.

---

## Final Decision

The screenshot bet-submission pipeline is safe to keep running in production for single-selection bets as it stands today. This conclusion rests on the architecture, not on measured accuracy: every weakness identified in §3 fails safe — an explicit rejection or a `422` — rather than producing a silently wrong `Bet` (§7). Stage 4.5F removed the one gap in this review most likely to have produced bad data silently (an unbounded odds value).

PARLAY confirmation should not begin until (a) the token-format and data-model questions in §6 have an explicit decision, and (b) at least a few real parlay screenshots have been run through the existing detection path to confirm the `selections[]` shape matches what real bookmaker UIs actually produce.

The recommendations in §4 beyond the odds cap already implemented are hypotheses, not validated fixes — they should be prioritized by what real screenshot testing (Appendix A) actually reveals, not by how plausible each one reads on paper. That test pass, not further prompt or validation changes, is the single most valuable next step for this feature.

---

## Appendix A — Testing checklist / matrix (template, not yet executed)

Every row below needs a real screenshot to produce genuine results. Columns marked `NOT RUN` are honestly empty, not placeholders for invented data.

| # | Case | Format | Theme | Orientation | Bookmaker (if applicable) | Expected result | Actual result | Claude confidence | Recognition errors |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Clean single bet | JPEG | Dark | Portrait | — | SINGLE, all fields | NOT RUN | NOT RUN | NOT RUN |
| 2 | Clean single bet | PNG | Dark | Portrait | — | SINGLE, all fields | NOT RUN | NOT RUN | NOT RUN |
| 3 | Clean single bet | WEBP | Dark | Portrait | — | SINGLE, all fields | NOT RUN | NOT RUN | NOT RUN |
| 4 | Clean single bet | JPEG | Light | Portrait | — | SINGLE, all fields | NOT RUN | NOT RUN | NOT RUN |
| 5 | Clean single bet | JPEG | Dark | Landscape | — | SINGLE, all fields | NOT RUN | NOT RUN | NOT RUN |
| 6 | Cropped screenshot (missing part of the slip) | JPEG | Dark | Portrait | — | reject_bet or incomplete | NOT RUN | NOT RUN | NOT RUN |
| 7 | Low quality / compressed | JPEG | Dark | Portrait | — | reject_bet or incomplete | NOT RUN | NOT RUN | NOT RUN |
| 8 | Multiple selections (true parlay, one slip) | PNG | Dark | Portrait | — | PARLAY, all legs | NOT RUN | NOT RUN | NOT RUN |
| 9 | Multiple unrelated bets (bet-history list) | PNG | Dark | Portrait | — | reject_bet (see §3.3/§4.4 — not yet implemented, so current behavior may misclassify as PARLAY) | NOT RUN | NOT RUN | NOT RUN |
| 10 | Fully unreadable / random image | JPEG | — | — | — | reject_bet | NOT RUN | NOT RUN | NOT RUN |
| 11 | Missing stake field | PNG | Dark | Portrait | — | incomplete / reject_bet | NOT RUN | NOT RUN | NOT RUN |
| 12 | Missing odds field | PNG | Dark | Portrait | — | SINGLE with `odds: null` | NOT RUN | NOT RUN | NOT RUN |
| 13 | Decimal odds | JPEG | Dark | Portrait | — | SINGLE, correct decimal value | NOT RUN | NOT RUN | NOT RUN |
| 14 | American odds (+150/-110 style) | JPEG | Dark | Portrait | — | Currently expected to fail (§3.1, §5 — not yet supported) | NOT RUN | NOT RUN | NOT RUN |
| 15 | Comma decimal separator (2,10) | JPEG | Dark | Portrait | — | SINGLE, correctly parsed as 2.10 (§3.2 risk) | NOT RUN | NOT RUN | NOT RUN |
| 16 | Settled bet receipt (Won/Lost badge) | PNG | Dark | Portrait | — | Currently expected to extract as SINGLE (§3.4 — no safeguard yet) | NOT RUN | NOT RUN | NOT RUN |
| 17 | Bet365 slip | — | — | — | Bet365 | See Appendix B | NOT RUN | NOT RUN | NOT RUN |
| 18 | Pinnacle slip | — | — | — | Pinnacle | See Appendix B | NOT RUN | NOT RUN | NOT RUN |
| 19 | Betano slip (boosted odds) | — | — | — | Betano | See Appendix B | NOT RUN | NOT RUN | NOT RUN |
| 20 | 1xBet slip | — | — | — | 1xBet | See Appendix B | NOT RUN | NOT RUN | NOT RUN |
| 21 | Marathonbet slip | — | — | — | Marathonbet | See Appendix B | NOT RUN | NOT RUN | NOT RUN |
| 22 | Melbet slip | — | — | — | Melbet | See Appendix B | NOT RUN | NOT RUN | NOT RUN |
| 23 | Stake slip (crypto stake) | — | — | — | Stake | See Appendix B | NOT RUN | NOT RUN | NOT RUN |

Per-row fields to record once real screenshots are available, per the stage spec: **Bookmaker, Language, Image quality, Expected result, Actual result, Claude confidence, Recognition errors.**

---

## Appendix B — Bookmaker-specific considerations (informed hypothesis, not measured)

Based on general knowledge of each platform's typical UI conventions — **not verified against actual screenshots from these bookmakers in this session.**

- **Bet365** — offers a user-selectable odds format (decimal/fractional/American), so a screenshot's odds format depends on the account's region settings, not just the bookmaker. Also offers "Bet Builder" (same-game multi) slips that are visually multi-leg but priced as one combined bet — directly relevant to §3.5. *Hint needed*: yes, both for odds-format variability and Bet Builder detection.
- **Pinnacle** — decimal odds by default for most markets, comparatively minimal/uncluttered UI (less promotional chrome than most competitors), which likely reduces §3.6's risk specifically for this bookmaker. *Hint needed*: low priority relative to others.
- **Betano** — frequently displays "boosted odds" with a struck-through original value next to the boosted one — a concrete, likely-common trigger for misreading which number is the actually-wagered odds. *Hint needed*: yes, a specific boosted-odds rule (already drafted as an example under §4.8).
- **1xBet** — dense, market-heavy layouts with many adjacent odds figures, multiple selectable odds formats, and common usage in comma-decimal locales. Likely the highest combined risk surface among the named bookmakers for both §3.2 (comma-decimal) and general adjacent-cell misreads. *Hint needed*: yes, highest priority for real-screenshot testing.
- **Marathonbet** — similar table-dense layout and comma-decimal-locale usage to 1xBet; similar risk profile. *Hint needed*: yes, likely shares 1xBet's hints once drafted.
- **Melbet** — same operator family/style as 1xBet; expect a very similar risk profile. *Hint needed*: likely shares 1xBet's hints, worth confirming rather than assuming once real screenshots exist.
- **Stake** — crypto-native; stakes/payouts are commonly shown in crypto units (BTC/ETH/USDT) with many decimal places, sometimes alongside a fiat-equivalent conversion — a distinct dual-number ambiguity not covered by any current rule (§5, currency-aware stake). *Hint needed*: yes, and likely needs a schema-level decision (what does "stake" mean when the UI shows two different numbers in two different units?) rather than just a prompt tweak.

None of the above should be treated as verified fact — it's a prioritization aid for which bookmakers to test first once real screenshots are available, not a substitute for actually testing them.
