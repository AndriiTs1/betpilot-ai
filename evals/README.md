# BetPilot Screenshot Ground-Truth Evaluation (EVAL-1)

Foundation for measuring the real screenshot → structured-bet pipeline
objectively, against a labeled dataset, instead of manually eyeballing a
few screenshots after a prompt/model change.

**Current dataset size: 0 real cases.** This is expected — see
["Adding the first examples"](#adding-the-first-examples) below. The
infrastructure is designed to be useful before any screenshots exist: the
runner and its tests work correctly against an empty dataset.

## What this evaluates

The real production pipeline, end to end, with no parallel/duplicated
logic:

```
image (evals/screenshots/<file>)
  → recognizeBetSlipScreenshot()   lib/ocr/recognizeBetSlipScreenshot.ts
      → detectBettingRegion()      lib/ocr/regionDetection.ts        (Claude)
      → crop
      → claudeOcrProvider          lib/ocr/claudeOcrProvider.ts      (Claude, free-text transcription)
  → parseBetSlipMessage(text, "OCR")  lib/ai/betParser.ts            (Claude, tool-use extraction)
  → ParsedBetSlip
  → evals/compareResult.ts vs. the case's `expected`
```

This is a **live, paid** evaluation — every case makes real Claude API
calls (region detection + OCR + parsing). It is never run as part of
`npm test`, and `npm test` incurs zero Anthropic API cost as a result.

## Running it

```
npm run eval:screenshots
```

Requires, in your environment (e.g. `.env.local`):

- `ANTHROPIC_API_KEY` — a real key with usage budget.
- `AI_PROVIDER=claude` — without this, `parseBetSlipMessage()` silently
  falls back to the local Ollama parser (see `lib/ai/betParser.ts`), which
  would produce a misleading, non-Claude "evaluation". The runner checks
  this explicitly and refuses to run with a clear error if it's missing.

If either is missing, the runner fails immediately with an actionable
message — it never silently substitutes a mock or fake result.

Output:
- A concise human-readable summary printed to the console (aggregate
  metrics, then every non-`PASS` case with exactly which field(s)
  differed — failures are never hidden behind the aggregate percentage).
- A full machine-readable JSON report written to `evals/reports/<timestamp>.json`.
  **Reports are gitignored** (`.gitignore`'s `/evals/reports/*` rule) — they're
  run artifacts, not source, matching this repo's existing `/coverage`
  convention. Keep/share a specific report manually (e.g. attach it to a PR
  description) if you want to preserve it.

## Case schema (`evals/caseSchema.ts`)

Each entry in `cases.json` is validated against a Zod schema at load time.
Shape summary (see `caseSchema.ts` for the authoritative, fully-commented
version):

```jsonc
{
  "id": "ru-spread-01",
  "image": "ru-spread-01.png",           // relative to evals/screenshots/
  "language": "RU",                       // "RU" | "UA" | "EN"
  "inputType": "BOOKMAKER_SCREENSHOT",    // "BOOKMAKER_SCREENSHOT" | "COUPON_SCREENSHOT" | "SCORE_PANEL_SCREENSHOT"
  "betType": "SINGLE",                    // "SINGLE" | "EXPRESS"
  "expected": {
    // null means: this input should be REJECTED by the real pipeline
    // (illegible slip, unsupported market, etc.) — not a bet at all.
    "type": "SINGLE",
    "stake": "100",
    "selections": [
      {
        "sport": "Football",
        "league": "Premier League",       // optional
        "event": "Arsenal vs Coventry City",
        "market": "Handicap",
        "selection": "Arsenal -1.5",
        "odds": "1.90",
        "line": "-1.5",
        // Optional canonical enrichment, NOT compared in EVAL-1 — see
        // "Known limitations" below.
        "marketType": "SPREAD",
        "selectionType": "PARTICIPANT",
        "participant": "Arsenal"
      }
    ]
  },
  "criticalFields": ["league"],           // optional — elevate normally-non-critical fields for this case
  "notes": "adversarial: similar-sounding away team name"
}
```

The compared fields mirror `lib/bets/betSlip.ts`'s real `ParsedBetSlip`/
`BetSlipSelectionInput` shape exactly — the actual production output at
this pipeline stage — not an invented parallel shape.

## Scoring (`evals/compareResult.ts`)

Every case gets exactly one verdict:

- **PASS** — no field differences (or, for a `expected: null` case, the
  pipeline correctly rejected it).
- **NON_CRITICAL_MISMATCH** — some field differed, but only in
  non-critical fields (currently: `league` only, by default).
- **CRITICAL_MISMATCH** — a dangerous difference: wrong `type`, `sport`,
  `event`, `market`, `selection`, `line`, `odds`, or `stake` — or the
  pipeline accepted an input that should have been rejected, or rejected
  one that should have been accepted.
- **PIPELINE_ERROR** — the run itself failed (network error, OCR
  provider error, missing screenshot file, Claude timeout) — distinct from
  a legitimate "the model declined to extract a bet" REJECTED outcome.
  Excluded from every accuracy denominator (it isn't a measurement of
  extraction quality, it's an infrastructure failure for that attempt).

Numeric fields (`line`, `odds`, `stake`) are compared via `Prisma.Decimal`
equality — never native floating point, and a handicap line's **sign is
always significant** (`-1.5` and `+1.5` are never equal). Free-text fields
are compared after light normalization (trim/whitespace/case) — not fuzzy
matching.

A case's `criticalFields` can elevate any field beyond the defaults for
that specific case (e.g. an adversarial similar-team-names case should set
`criticalFields: ["event", "selection"]`, since getting the team name
subtly wrong is the entire point of that case, even though `event`/
`selection` are already critical by default — see `compareResult.ts` for
the exact default set).

## Metrics

Reported per run: case count, exact-match accuracy, per-field accuracy
(`sport`/`event`/`market`/`selection`/`line`/`odds`/`stake`/`betType`),
critical error count/rate, pipeline error count. With zero comparable
cases, every rate is `null` — never `NaN`, never a fabricated 100%.

**`participant` accuracy is always `null`** in EVAL-1 — see "Known
limitations" below.

## Comparing two runs (prompt A vs. prompt B)

1. Run `npm run eval:screenshots` on the current prompt — note the report
   path.
2. Change `chatPrompt`/`ocrPrompt` (or whatever you're testing) and re-run.
3. Diff the two reports' `summary` blocks, and their per-case `cases[]`
   arrays for anything that flipped verdict. Each report's `metadata`
   records `promptFingerprints` (a short hash, not the full prompt text) so
   you can confirm two reports actually used different prompts before
   trusting a delta.

There is no automated A/B diff tool in EVAL-1 — comparing two JSON reports
by hand (or with `jq`/a script) is sufficient for this foundation's scope.

## Known limitations (deliberate, EVAL-1 scope)

- **`participant`/`marketType`/`selectionType` are not compared.**
  `ParsedBetSlip` (the real pipeline's output at the stage this eval is
  scoped to) carries no canonical classification yet — that happens later,
  downstream, during odds verification (`lib/odds/shorthandClassifier.ts`
  etc.), which is a different pipeline stage this foundation does not
  reach into (reusing it here would mean evaluating a different stage than
  stated, and would duplicate classification logic this stage is
  explicitly not supposed to duplicate). A wrong participant still shows
  up reliably as a `selection`/`event` text diff.
- **`OCR_SYSTEM_PROMPT` (claudeOcrProvider.ts) and
  `REGION_DETECTION_SYSTEM_PROMPT` (regionDetection.ts) fingerprints are
  not captured.** Both are module-private (not exported); exporting them
  purely for this eval would be a production-file change outside EVAL-1's
  "evaluation infrastructure ONLY" scope. `chatPrompt`/`ocrPrompt` (already
  exported, `lib/ai/betParserPrompt.ts`) are fingerprinted directly.
- **Model/temperature metadata is hardcoded** in `evals/metadata.ts`
  (`claude-sonnet-4-6`, parser temperature `0.1`, OCR temperature `0`),
  matching the real literals in `lib/ai/betParser.ts`/
  `lib/ocr/claudeOcrProvider.ts` — which are not exported constants. If
  those literals ever change, `evals/metadata.ts` must be updated to match
  by hand; nothing enforces this automatically.
- **Free-text comparison is exact-after-normalization, not fuzzy.** No
  Levenshtein/similarity scoring — a natural next iteration once real
  cases reveal how much harmless OCR wording variance actually occurs.
- **EXPRESS legs are compared by index**, not matched/reordered — a
  correct extraction that lists the same legs in a different order would
  currently show as mismatches. Worth revisiting once real EXPRESS cases
  exist.
- **No automated prompt-A-vs-B diff tool** — see above.

## Privacy / sanitization policy

Screenshots may contain personally identifying or sensitive information:
usernames, account IDs, account balances, personal names, QR codes,
internal bet/ticket IDs, or other identifying details a real bookmaker app
shows around the bet slip itself.

**Do not commit a real, unmodified user screenshot.** Before adding a
screenshot to `evals/screenshots/`:

1. Crop or blur out any balance figures, account/username fields, QR
   codes, and ticket/reference IDs that aren't the bet information itself.
2. Prefer a **synthetic-but-realistic** example — construct or recreate a
   bookmaker-style slip with fabricated stakes/odds/usernames rather than
   using a real player's actual bet whenever practical.
3. If a real screenshot must be used, confirm every identifying element
   above has been removed or replaced before it's added to this directory.
4. Never include a real player's name, phone number, Telegram ID/username,
   or account balance anywhere in `evals/`.

## Adding the first examples

Target for the first useful dataset: **30–50 cases.** Recommended
distribution (adjust as real screenshots become available — do not claim
this coverage until it's actually true):

**Languages:** RU, UA, EN — aim for a real presence of all three, not just
RU (which is already the best-covered language in this codebase's other
text-based fixtures).

**Markets:** MONEYLINE, TOTALS, SPREAD — include SPREAD whole/half lines
*and* quarter lines (even though quarter-line confirmation itself stays
gated behind H1's provider capability check — this eval measures
*extraction*, not confirmability).

**Bet types:** both SINGLE and EXPRESS (2–3 legs).

**Prioritize these specifically** (per the task's own safety framing):

- SPREAD with both positive and negative lines.
- Whole, half, and quarter lines.
- Similar/confusable team names (e.g. a club and its reserve/B-team).
- Multi-word team names.
- A screenshot with stake, odds, and line all visible together.
- A screenshot with odds missing/not legible.
- Multiple selections in one slip (EXPRESS).
- Different bookmaker UI/formatting styles — don't over-fit the dataset to
  one app's layout.
- At least a few cases where `expected: null` (the slip should be
  rejected) — a battery/status-bar screenshot, an unrelated app screenshot,
  or a genuinely illegible slip.

Add each case's image to `evals/screenshots/` (sanitized per the policy
above) and a matching entry to `cases.json`, then run
`npm run eval:screenshots` to confirm it loads and scores as expected
before considering it part of the dataset.
