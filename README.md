# BetPilot AI

AI-powered sports betting operations platform. A player opens a Telegram Mini App to see their credit/balance and bet history, and sends a bet as text or a coupon screenshot; an LLM extracts a structured bet — **single or multi-selection (EXPRESS, 2–10 legs)** — and the odds get checked against a live sportsbook API; an operator reviews the request in a web dashboard and confirms or rejects it against the player's credit limit; the player gets notified back on Telegram. SINGLE and EXPRESS bets share one consistent card/list UI across both the Mini App and the operator dashboard.

Live deployment: [betpilot-ai-five.vercel.app](https://betpilot-ai-five.vercel.app) · Repo: [AndriiTs1/betpilot-ai](https://github.com/AndriiTs1/betpilot-ai)

> `docs/MVP.md`, `docs/architecture/PROJECT_ARCHITECTURE.md`, `docs/domain/DOMAIN_MODEL.md` are the **original pre-implementation planning docs** (WhatsApp + wallet-balance design). The actual system diverged from them (Telegram instead of WhatsApp, a credit-limit model instead of a wallet balance, a Mini App instead of in-chat text parsing — see below) and they have not been updated to match. Treat this README as the source of truth for current behavior.

## Documentation

Current project documentation:

- `README.md` — what the system does today (this file)
- `RELEASE_NOTES_v1.0.0.md` — what shipped in the v1.0.0 release
- `CHANGELOG.md` — versioned change history in [Keep a Changelog](https://keepachangelog.com/) format
- `docs/CHANGELOG.md` — chronological log of completed development stages, a different document from the root `CHANGELOG.md` above. **Stops at Stage 5.0D** (operator dashboard/API auth) — everything from EXPRESS bet support onward (settlement, OCR, the Bet UI Design System, sport icons, the v1.0 release hardening) shipped afterward and isn't logged there; this README and the root `CHANGELOG.md` reflect it, this file doesn't.
- `docs/decisions/` — Architecture Decision Records (ADRs): why significant technical/product decisions were made
- `docs/architecture/`, `docs/domain/` — original pre-implementation planning docs (outdated, see note above)
- `OPERATOR_AUTH_AUDIT.md`, `docs/OPERATOR_AUTH_IMPLEMENTATION.md` — the approved design and implementation notes for operator authentication

**README is the source of truth for current behavior. Architecture decisions are stored as ADRs** — see `docs/decisions/README.md` for the format and rules, and `docs/decisions/ADR-0001-project-history.md` for how the system got here.

## Status

**v1.0.** Operator authentication (session-based login, every dashboard page and API route protected), the operator workflow (queue, confirm/reject against credit limit, player notification), and the player-facing Telegram Mini App (balance, active bets, history, bet submission) are built and running in production on a real Postgres database. The credit-limit check is safe under concurrent confirms (a `SELECT ... FOR UPDATE` row lock closes a write-skew race — see "Credit-limit risk model" below), baseline HTTP security headers protect the operator surface, and 648 automated tests cover authentication, the bet lifecycle, and settlement.

Both **SINGLE and EXPRESS (2–10 selection accumulator) bets** can be submitted as text or a screenshot, AI-parsed, odds-verified per leg, and confirmed into a real `Bet` (+ `BetSelection` rows for EXPRESS). The Mini App and the operator dashboard share one **Bet UI Design System** (`components/bets/SelectionRow.tsx` / `SelectionList.tsx`) so a bet's selections render with the same information hierarchy everywhere — full, uncollapsed disclosure in decision contexts (Preview, Confirmation Ticket, operator Pending Queue), and a "first 3 + N more" summary in review contexts (Active Bets, History).

**Settlement exists as a backend service** (`lib/bets/settleBet.ts` — grades a confirmed bet WON/LOST/VOID, writes a `Transaction`, updates the player's credit, and notifies them on Telegram) but has **no operator-facing UI** — manual Won/Lost/Void buttons were deliberately removed from the dashboard; the only way to settle a bet today is a direct authenticated API call. See [What's not done](#whats-not-done-yet).

## What's been built

**Data layer**

- Prisma 7 schema on Neon Postgres (`prisma/schema.prisma`), 9 migrations applied: `Operator` (+ `passwordHash`, `OperatorSession`), `Player` (+ `telegramUsername` for closed-demo onboarding), `Bet` (`type: BetType` = `SINGLE | EXPRESS`, `totalOdds`, `previewId` unique idempotency key), `BetSelection` (one row per EXPRESS leg: `sport`/`event`/`outcome`/`market`/`odds`/`currentOdds`/`oddsStatus: BetSelectionOddsStatus`), `OddsSnapshot`, `Transaction`, `Message`, `Wallet`.
- Prisma 7's `"prisma-client"` generator (full TS source, output to `lib/generated/prisma`, gitignored, regenerated via `postinstall`) with the `@prisma/adapter-neon` driver adapter for serverless.
- A SINGLE `Bet` still has zero `BetSelection` rows (its event/outcome/odds live directly on `Bet`); an EXPRESS `Bet` always has ≥2 `BetSelection` rows and null `event`/`outcome`/`odds` on `Bet` itself. `MIN_EXPRESS_SELECTIONS = 2` / `MAX_EXPRESS_SELECTIONS = 10` (`lib/bets/betSlipRules.ts`) are enforced server-side. `lib/bets/mapBetForDisplay.ts` is the one canonical function every UI surface uses to read either shape safely (with a legacy fallback for a couple of pre-migration zero-selection rows), instead of each screen branching on `selections.length` itself.
- `BetSelectionOddsStatus` (`PENDING/VERIFIED/ODDS_CHANGED/NOT_FOUND/UNAVAILABLE`) is a **separate concept from `Bet.status`** — one is per-leg odds-verification outcome, the other is the parent bet's lifecycle. The two are never rendered as the same badge anywhere.
- `scripts/backfill-bet-selections.ts` — idempotent, transactional backfill utility from the original single-selection-only schema; already run once in production.
- `prisma/seed.ts` — test fixtures. `scripts/reset-test-data.ts` — resets the **one shared Neon database** (no separate dev/staging copy) down to a single known player for local end-to-end testing.

**AI bet parsing and OCR** (`lib/ai/betParser.ts`, `lib/ocr/`)

- `parseBetSlipMessage()` is the one parser both the text and screenshot flows call — it classifies and extracts either a `SINGLE` or `EXPRESS` bet slip (event/selection/stake/odds per leg) from free text, distinguishing a `BetSlipParseMode` of `"CHAT"` (player-typed message) or `"OCR"` (OCR-transcribed screenshot text) only for prompt-tuning purposes, not different output shapes. Dual provider, switchable via `AI_PROVIDER`: local **Ollama** (default, no API key, no EXPRESS/tool-use support — local dev only) or **Claude** (`@anthropic-ai/sdk`, strict tool-use schema); production always runs `AI_PROVIDER=claude`.
- Screenshots go through a separate, provider-agnostic **OCR step first**: `lib/ocr/recognizeScreenshot.ts` takes raw image bytes and an `OcrProvider` and returns transcribed text (`lib/ocr/claudeOcrProvider.ts` is the only implementation today, but nothing in `lib/ocr/` itself knows about Telegram, bets, or Claude specifically), then that text is normalized (`normalizeOcrText.ts`) and handed to the same `parseBetSlipMessage()` the text flow uses. This replaced an earlier design where the screenshot flow called its own separate Claude-vision-multimodal parser directly.
- `MAX_DECIMAL_ODDS = 1000` — values above this are rejected during AI output validation (guards against an OCR/decimal-separator misread reaching preview).
- The earlier WhatsApp-era chain that parsed a message and created a `Bet` directly, with no preview step, has been removed entirely — the preview → confirm flow described below is the only bet-creation path today.

**Odds verification** (`lib/odds/oddsVerifier.ts`)

- Looks up the event on **The Odds API** and compares the player-submitted odds against the live market, with sport-key mapping and fuzzy RU/EN team-name matching, per selection (an EXPRESS bet's legs are verified independently). `matched` (event/market/selection actually found) and `withinTolerance` (submitted odds close enough to the source price) are separate verdicts, mapped into the leg's `BetSelectionOddsStatus` (`lib/odds/mapOddsStatus.ts`).

**Telegram integration** (`lib/telegram/`, `app/api/webhooks/telegram/`)

- `POST /api/webhooks/telegram` — the bot webhook, **Mini-App-only**: `/start` sends a welcome message with an inline "Open app" button (`web_app` deep link into `/miniapp`); any other text, command, or photo gets the same generic redirect nudge back to the Mini App. The webhook never parses message content into a bet itself.
- Verified via `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET` (`lib/auth/telegramWebhookAuth.ts`, constant-time compare).
- `lib/telegram/sendMessage.ts` — outbound messages via the Bot API (`parse_mode: "HTML"`); `lib/telegram/escapeHtml.ts` escapes player-controlled text before interpolating it.
- Player-facing notifications are sent from the confirm and settle routes, not the webhook: bet confirmation, and — when a settlement is triggered via the API — win/loss/void with payout figures.

**Operator authentication** (`lib/auth/`, `app/operator/login/`, `app/api/operator/auth/`)

- Real password login, not the internal `OPERATOR_SECRET` bearer token (which is a separate, still-active mechanism gating the lower-level `/api/bets/*` routes — see API surface below).
- `lib/auth/password.ts` — `scrypt`-based hashing (Node's built-in `node:crypto`), versioned stored format, timing-safe comparison.
- `lib/auth/operatorSession.ts` / `operatorSessionCookie.ts` — database-backed sessions: a random 256-bit token lives only in an `HttpOnly`/`Secure`(prod)/`SameSite=Lax` cookie; the database stores only its SHA-256 hash. Default 12h TTL (`OPERATOR_SESSION_TTL_HOURS`).
- `POST /api/operator/auth/login` / `logout`, backed by `attemptOperatorLogin` (`lib/auth/operatorLogin.ts`): a constant-time dummy-hash comparison runs even for an unknown phone, so "unknown phone" and "wrong password" can't be told apart by response time; basic in-memory brute-force protection (`lib/auth/loginRateLimit.ts`, 5 attempts / 15 min per IP+phone, per-instance only).
- `lib/auth/requireOperator.ts` — the one shared gate every protected page/route calls: `requireOperatorPage()` (redirects to `/operator/login`) for Server Components, `requireOperatorApi()` (`401`) for Route Handlers. `/` (the Dashboard) and every `/api/dashboard/*` route are gated this way. No `middleware.ts` — deliberately evaluated and rejected in favor of this explicit per-route pattern (see `docs/OPERATOR_AUTH_IMPLEMENTATION.md`).
- `scripts/create-operator.ts` (`npm run operator:create`) — manual, one-off provisioning using `Operator.phone` as the login identifier.

**Telegram Mini App** (`app/miniapp/`, `components/miniapp/`, `app/api/miniapp/me`)

- Player-facing PWA-like app opened from the bot's "Open app" button. Verifies Telegram `initData` server-side (`lib/telegram/verifyInitData.ts`, HMAC-SHA256, rejects data older than 1 hour) via `Authorization: tma <initData>`.
- 4-tab bottom navigation (`BottomNav.tsx`): **Bet** (`BetScreen.tsx`), **Active** (`ActiveBetsScreen.tsx`), **History** (`HistoryScreen.tsx`), **Balance** (`BalanceScreen.tsx`) — active/history classified client-side from `Bet.status`.
- `BetScreen.tsx` — "AI Assistant First" composition: one primary CTA opens `BetActionSheet.tsx` (hand-rolled bottom sheet, no dependency) offering text or screenshot submission, a compact credit summary, and the last 2 bets ("Recent Activity" — a deliberately compact teaser, distinct from the full Active Bets tab).
- `BetPreviewCard.tsx` (`PreviewCard`/`OddsStatus`) is the one preview UI both `BetTextForm.tsx` and `BetScreenshotForm.tsx` render — full, unconditional selection disclosure (a decision context: the player is about to confirm).
- `BetTicket.tsx` — the post-confirmation ticket screen (perforated dividers, side notches, animated checkmark, decorative barcode). Renders every selection ("Leg N" per EXPRESS leg) — also full disclosure, same reasoning as Preview.
- `ActiveBetsScreen.tsx` / `HistoryScreen.tsx` — a bet's selections render via `BetSelectionsList.tsx` → the shared `SelectionList` (`components/bets/SelectionList.tsx`) in `mode="list"`: 1–3 selections shown directly, more than 3 shows the first 3 plus an expandable "+N more" control, never collapsed to a bare count.
- `sportIcons.tsx` — Football/Basketball/Tennis/Hockey render prepared PNG artwork (`public/icons/sports/`); every other sport falls back to a small hand-drawn SVG. `ExpressIcon` (`public/icons/express.png`) is a dedicated icon for any bet with more than one selection, used everywhere a card shows one icon for the whole bet — an EXPRESS bet can span multiple sports, so no single sport icon can represent it.
- `WelcomeBanner.tsx` — one-shot auto-dismissing (~2.75s) greeting, respects `prefers-reduced-motion`. `MiniAppBackground.tsx` — static decorative background shared across all tabs via `app/miniapp/layout.tsx`.

**Bet submission — text and screenshot** (`BetTextForm.tsx`, `BetScreenshotForm.tsx`, `app/api/miniapp/bets/`)

- Player flow: describe a bet as text, or upload/photograph a bet-slip screenshot → AI-parsed preview (SINGLE or EXPRESS) with per-leg live odds verification → confirm → a real `Bet` row (`status: PENDING`, + `BetSelection` rows for EXPRESS) lands in the same queue the operator dashboard reads, confirms, and rejects against the credit limit.
- `POST /api/miniapp/bets/text/preview` and `POST /api/miniapp/bets/screenshot/preview` are preview-only: zero DB writes beyond a read-only `Player` lookup. Each parses the input, verifies odds per selection, and returns a short-lived HMAC-signed `previewToken` (`lib/betPreview/previewToken.ts`, 180s TTL, versioned payload — a `SINGLE` and an `EXPRESS` payload are distinct, verified shapes) carrying everything the confirm step needs.
- `POST /api/miniapp/bets/text/confirm` verifies the `previewToken`, then creates the `Bet` (+ `BetSelection` rows and their own `oddsStatus` for EXPRESS, or + `OddsSnapshot` for SINGLE) inside one transaction (`lib/bets/createBetFromPreview.ts`). Idempotent and race-safe via `Bet.previewId`'s unique constraint — confirming the same token twice, sequentially or concurrently, returns the same `Bet`. The screenshot flow reuses this exact same confirm endpoint.
- Screenshot upload validates the file server-side before OCR ever runs: MIME allow-list (`image/jpeg`/`png`/`webp`, no SVG), a size limit, and a real magic-byte signature check. The image only exists in memory for the request — never persisted to disk or a storage bucket.

**Credit-limit risk model** (replaced an earlier `Wallet.balance` design)

- `Player.creditLimit` / `Player.currentCredit` (`currentCredit` negative = player owes; positive = player is up).
- A bet is accepted into the queue with **no** credit check (operator should see risky requests too).
- On **confirm**, `POST /api/bets/[id]/confirm` computes remaining credit, subtracts the player's other `CONFIRMED` exposure, and rejects with `409` if the new bet's stake exceeds what's left. The status flip to `CONFIRMED` is an atomic conditional update (`where: { status: "PENDING" }`) guarding against a concurrent confirm/reject of the *same* bet.
- **Concurrency-safe across different bets, too.** The exposure check runs inside the same transaction as a `SELECT ... FOR UPDATE` lock on the player's row. This closes a write-skew race where two *different* PENDING bets for the same player, confirmed at nearly the same instant, could each read a stale, pre-commit exposure snapshot and both be approved even though their combined stake exceeds the limit — a real gap the row lock and its dedicated concurrency tests (`app/api/bets/confirm.route.test.ts`) close and verify, including a test that reproduces the original bug when the lock is removed.

**Settlement** (`lib/bets/settleBet.ts`, `lib/bets/settlementRules.ts`, `POST /api/bets/[id]/settle`)

- Grades a `CONFIRMED` bet as `SETTLED_WIN` / `SETTLED_LOSS` / `VOID`: computes payout, writes a `Transaction`, updates `Player.currentCredit`, and notifies the player on Telegram — all inside one atomic operation. `lib/bets/settlementRules.ts` is the pure, dependency-free source of truth for transition eligibility; settlement is final (once settled, only the exact same repeat request is idempotently accepted, never a different result).
- **Backend-complete, UI-absent by design.** There is no button anywhere in the operator dashboard that calls this — Won/Lost/Void were deliberately removed from `PlayerCard.tsx`'s Active Bets table (they're now read-only lifecycle status badges, same component as everywhere else). The only way to trigger settlement today is a direct, authenticated `POST /api/bets/[id]/settle` (or its dashboard-session-authenticated proxy at `/api/dashboard/bets/[id]/settle`) call. This is intentional: manual settlement is meant to exist only as a future exception workflow once an automated settlement pipeline (ingesting real match results) is built — see [What's not done](#whats-not-done-yet).

**Operator dashboard** (`app/page.tsx` + `components/`)

- Requires operator login (see "Operator authentication" above) — every route below is session-gated.
- `DashboardOverview` — Active Players, Available Credit, Pending Bets, stat cards, backed by `GET /api/dashboard/overview`.
- `BetQueue` / `BetQueueItem.tsx` — the operator's **only** manual action on a bet: Confirm or Reject a `PENDING` request. Every selection is always rendered in full (`SelectionList` in `mode="full"`) before the buttons — an EXPRESS bet can never be approved based on a collapsed summary. Auto-refreshes every 10s.
- `PlayerList` / `PlayerCard.tsx` — per-player credit limit, exposure, bet count, next settlement date, and two **read-only** tabs (Active Bets, History). SINGLE and EXPRESS both render through the same `SelectionRow`/`SelectionList` family the Mini App uses: desktop table rows show a compact "Express ×N" + joined-event summary that expands into the full per-leg detail inline; the mobile card variant applies the same "first 3 + N more" rule. Small (20px box, artwork rendered oversized and cropped to fill it) sport/Express icons sit to the left of every event, resolved via `getDashboardSportIcon()` — an unrecognized sport renders no icon rather than a wrong one.
- `StatusBadge.tsx` — the one shared lifecycle-status badge (`PENDING/CONFIRMED/REJECTED/SETTLED_WIN/SETTLED_LOSS/VOID`) used identically by the queue, the player card, and the Mini App.

**API surface**
| Route | Auth | Purpose |
|---|---|---|
| `GET/POST /api/bets/pending`, `/api/bets/history`, `/api/bets/[id]/confirm`, `/api/bets/[id]/reject`, `/api/bets/[id]/settle` | `Authorization: Bearer OPERATOR_SECRET` | Internal operator API (Prisma queries live here) |
| `GET /api/dashboard/bets/pending`, `/api/dashboard/bets/history`, `POST /api/dashboard/bets/[id]/confirm`, `/api/dashboard/bets/[id]/reject`, `/api/dashboard/bets/[id]/settle` | operator session cookie | Thin proxy — injects `OPERATOR_SECRET` server-side (`lib/dashboard/operatorApiProxy.ts`) so the browser never sees it |
| `GET /api/dashboard/overview`, `GET /api/dashboard/players` | operator session cookie | Direct Prisma reads |
| `POST /api/operator/auth/login`, `POST /api/operator/auth/logout` | none (login itself) / operator session (logout) | Operator dashboard authentication |
| `POST /api/webhooks/telegram` | `X-Telegram-Bot-Api-Secret-Token` vs `TELEGRAM_WEBHOOK_SECRET` | Bot webhook — Mini-App-only redirect |
| `GET /api/miniapp/me` | `Authorization: tma <initData>` | Player's own credit/exposure summary + last 20 bets |
| `POST /api/miniapp/bets/text/preview`, `POST /api/miniapp/bets/screenshot/preview` | `Authorization: tma <initData>` | AI-parsed SINGLE/EXPRESS bet preview + per-leg odds check + signed `previewToken`; zero DB writes |
| `POST /api/miniapp/bets/text/confirm` | `Authorization: tma <initData>` | Verifies `previewToken`, creates the `Bet` (+ `BetSelection`s for EXPRESS), idempotent. Shared by both preview routes |
| `GET/POST /api/dashboard/debug/screenshot-preview` | operator session cookie | Internal diagnostic tool (`app/debug/screenshot/`) — runs a real screenshot through the OCR/parse pipeline for an operator to inspect, outside the player-facing flow |

**Infra / ops**

- Deployed on Vercel, GitHub auto-deploy on push to `main` (has occasionally not fired — see below), Neon Postgres, **one shared database with no separate dev/staging copy** (see `docs/decisions/ADR-0001-project-history.md`).
- `lib/auth/operatorAuth.ts` — constant-time (`timingSafeEqual`) Bearer-token check for the internal `/api/bets/*` API, layered underneath the session-cookie check on the dashboard proxy routes, not replaced by it.
- `VERCEL_PROJECT_PRODUCTION_URL` used (not `request.url`) so internal dashboard→API fetches don't get redirected to a login page by Vercel Deployment Protection.
- **Security headers** (`next.config.ts`'s `headers()`): `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` — scoped to the operator dashboard and its API surface (`/`, `/operator/*`, `/debug/*`, `/api/bets/*`, `/api/dashboard/*`, `/api/operator/*`). Deliberately **excludes** `/miniapp` and `/api/miniapp/*`: Telegram Web legitimately loads the Mini App inside its own `<iframe>`, and framing it out would break the app in production.

## Closed-demo player onboarding

A closed demo has no public sign-up: every player is invited by an operator before they ever open the bot, using only virtual/demo credit — no deposit, withdrawal, payment, or payout logic exists or is implied by this flow.

- `Player.telegramUsername` (`String? @unique`, normalized: no leading `@`, lowercase) is a **one-time onboarding aid only** — never an authentication credential. Mini App access continues to authenticate exclusively by matching signed `initData`'s `user.id` against `Player.telegramId`.
- **Invite**: an operator runs `npm run player:invite` (`scripts/invite-player.ts`) to create a Player row with a known `telegramUsername` and `telegramId: null` — "invited, not yet bound." Idempotent.
  ```bash
  PLAYER_NAME="Denis" PLAYER_TELEGRAM_USERNAME="kda0508" \
  PLAYER_PHONE="+380676210203" OPERATOR_PHONE="+10000000000" \
  npm run player:invite
  ```
- **Bind**: the first time that real Telegram account sends `/start`, `lib/telegram/bindInvitedPlayer.ts` atomically sets `telegramId` on the matching invited row (race-safe, idempotent, never reassigns an already-bound row). A username with no invited match is a silent no-op.
- Once bound, the player is indistinguishable from any other — `telegramUsername` is never consulted again.

## What's not done yet

- **Automatic settlement.** `lib/bets/settleBet.ts` can grade a bet, but nothing ingests real match results to decide WON/LOST/VOID — settlement only happens today via a direct, manual API call with no dashboard UI. A future automated pipeline (result ingestion → auto-settle) and, separately, a manual "Settlement Issues / Manual Review" exception workflow for bets automation can't resolve are both explicitly deferred — see the Bet UI Design System's architecture note in `components/players/PlayerCard.tsx`.
- **No rate limiting** on `POST /api/miniapp/bets/text/preview`, `/text/confirm`, or `/screenshot/preview` — a registered player (or anyone who can forge valid-looking requests past Telegram auth) can call these as fast as the AI provider/odds API will respond.
- **Screenshot uploads are never persisted.** The image only exists in memory for the request — no storage integration exists, so there's no way for an operator to later review the original screenshot behind a confirmed bet.
- **`types/player.ts`, `lib/wallet/balance.ts`, `lib/wallet/transaction.ts` are dead code** — zero imports anywhere, pre-date the credit-limit model.
- **`Wallet` model is unused application-wide** (only referenced by `scripts/reset-test-data.ts`'s cleanup and the generated Prisma client). `Transaction` **is** now used — `settleBet.ts` writes one per settlement — so it's no longer dead, unlike `Wallet`.
- **No operator scoping**: schema allows multiple `Operator`s, but nothing in the UI/API scopes by operator — `/api/dashboard/*` reads across all operators.
- **Desktop table vs. card layout divergence for Dashboard EXPRESS bets** beyond the current expandable-row treatment is a still-open, lower-priority polish item (see the Bet UI Design System risk notes).
- **`docs/`** (`MVP.md`, `PROJECT_ARCHITECTURE.md`, `DOMAIN_MODEL.md`) and **`docs/CHANGELOG.md`** describe an earlier stage of the system and haven't been kept current — see the note at the top of this file and in the Documentation section.
- Git→Vercel auto-deploy has repeatedly not fired after a push in practice (root cause not diagnosed — worked around with `vercel --prod` when noticed); worth keeping an eye on, it isn't reliable.

## Tech Stack

- **Next.js 16.2.10** (App Router, Turbopack) — see `AGENTS.md`, this version has breaking changes vs. older Next.js docs/training data.
- **React 19.2.4**, **TypeScript**, **Tailwind CSS v4**
- **Prisma 7.8.0** + `@prisma/adapter-neon`, **Neon Postgres**
- **Zod v4** (LLM output validation)
- **Anthropic SDK** (`@anthropic-ai/sdk`) + local **Ollama** — dual AI provider for bet parsing; Claude also does OCR (screenshot → text) and runs in production for both
- **The Odds API** — live odds
- **Telegram Bot API** + **Telegram Mini Apps** — player messaging and the `/miniapp` player-facing UI
- **Tabler Icons** webfont (operator dashboard) + **lucide-react** (Mini App) + prepared PNG artwork for sport/Express icons, shared by both surfaces
- **`node --test`** (Node's built-in test runner, via `tsx`) — the project's one test framework; no Jest/Vitest. **648 tests**, covering operator auth, the bet lifecycle (confirm/reject/settle, including dedicated confirm-route concurrency tests), AI parsing, OCR, and odds verification. No DOM-rendering test infra (no jsdom/@testing-library) — component tests exercise pure/exported logic only, not rendered trees
- Deployed on **Vercel**

## Getting Started

```bash
npm install                 # runs `prisma generate` via postinstall
cp .env.example .env        # fill in DATABASE_URL, OPERATOR_SECRET, TELEGRAM_BOT_TOKEN, etc.
npm run db:seed             # optional: seed test operator + players
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the dashboard (requires an operator login — see `npm run operator:create`, or "Closed-demo player onboarding" below for inviting a test player). See `.env.example` for every required variable and where to get it (Neon, Ollama/Anthropic, The Odds API, Telegram `@BotFather`).

```bash
npx tsc --noEmit   # typecheck
npm run lint       # eslint
npm test           # node --test — unit tests (pure logic only, no DOM/browser tests)
npm run build      # production build
```

## Project Structure

```
app/
  page.tsx                       Operator dashboard page (requires operator login)
  operator/login/                Operator login page
  debug/screenshot/              Operator-only OCR/parse pipeline diagnostic tool
  miniapp/                       Player-facing Telegram Mini App
    layout.tsx                   Renders MiniAppBackground behind every tab
    page.tsx                     Script loading, initData fetch, banner/data screen switch
  api/
    bets/                        Internal operator API (Bearer-token protected)
      pending/ history/ [id]/confirm/ [id]/reject/ [id]/settle/
    dashboard/                   Browser-facing routes (operator session protected)
      overview/ players/         direct Prisma reads
      bets/                      proxy to /api/bets/* (injects OPERATOR_SECRET)
      debug/screenshot-preview/  diagnostic pipeline for app/debug/screenshot/
    operator/auth/                login/ logout/
    miniapp/
      me/                        GET — player's own summary + recent bets (initData-verified)
      bets/text/preview/         POST — text bet AI preview (SINGLE/EXPRESS) + odds check + signed previewToken
      bets/text/confirm/         POST — verifies previewToken, creates the Bet (+ BetSelections), idempotent
      bets/screenshot/preview/   POST — OCR the image, then the same parse/preview contract as text
    webhooks/telegram/           Telegram bot webhook — Mini-App-only redirect
components/
  dashboard/                     Overview stat cards, EmptyState
  bets/                          BetQueue/BetQueueItem (Confirm/Reject), StatusBadge,
                                  SelectionRow / SelectionList (the shared Bet UI Design System —
                                  used by both the Dashboard and the Mini App)
  players/                       PlayerList, PlayerCard (Active Bets/History, read-only, responsive)
  operator/                      OperatorLoginForm
  debug/                         ScreenshotDebugForm
  miniapp/                       BottomNav, BetScreen, BetActionSheet, ActiveBetsScreen, HistoryScreen,
                                  BalanceScreen, WelcomeBanner, MiniAppBackground, BetTicket,
                                  BetSelectionsList (wraps the shared SelectionList),
                                  BetPreviewCard (PreviewCard/OddsStatus — shared preview UI),
                                  BetTextForm / BetScreenshotForm,
                                  sportIcons.tsx (sport + dedicated Express icons, shared with Dashboard),
                                  betPreviewApi.ts / betScreenshotApi.ts / betConfirmApi.ts / mergeConfirmedBet.ts
lib/
  ai/betParser.ts                parseBetSlipMessage — the one SINGLE/EXPRESS-aware parser both
                                  text and OCR-transcribed input go through (Ollama/Claude)
  ocr/                           Provider-agnostic OCR abstraction (OcrProvider), recognizeScreenshot,
                                  claudeOcrProvider (the only implementation today), normalizeOcrText
  odds/                          oddsVerifier.ts (The Odds API), mapOddsStatus.ts (-> BetSelectionOddsStatus)
  betPreview/previewToken.ts     Signed, short-lived (180s) HMAC token — SINGLE and EXPRESS payload shapes
  bets/                          createBetFromPreview.ts (idempotent confirm-time Bet/BetSelection creation),
                                  betSlipRules.ts (MIN/MAX_EXPRESS_SELECTIONS), mapBetForDisplay.ts
                                  (canonical SINGLE/EXPRESS read model), settleBet.ts / settlementRules.ts
                                  (backend-complete, no dashboard UI — see "What's not done yet"), serialize.ts
  telegram/                      webhook handler, sendMessage, escapeHtml, verifyInitData, bindInvitedPlayer
  auth/                          operatorAuth.ts (Bearer-token), operatorLogin.ts, operatorSession(Cookie).ts,
                                  password.ts, loginRateLimit.ts, requireOperator.ts, telegramWebhookAuth.ts
  players/credit.ts              computeRemainingCredit — shared credit-limit math
  dashboard/operatorApiProxy.ts  server-side secret injection
  db/client.ts                   Prisma singleton (Neon adapter)
  wallet/                        dead code, unused (see "What's not done yet")
types/                           Shared domain types — bet.ts/player.ts are stale/unused, see above
prisma/                          schema, migrations, seed
scripts/                         backfill-bet-selections.ts, create-operator.ts, invite-player.ts,
                                  reset-test-data.ts (resets the shared dev DB to one known player)
docs/                            CHANGELOG (behind current state), decisions/ (ADRs, current),
                                  pre-implementation planning docs (outdated, see note above)
```
