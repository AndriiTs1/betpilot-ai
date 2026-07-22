# BetPilot AI

AI-powered sports betting operations platform. A player opens a Telegram Mini App to see their credit/balance and bet history, and sends a bet as text or a coupon screenshot; an LLM extracts the structured bet (sport, event, selection, stake, odds); the odds get checked against a live sportsbook API; an operator reviews the request in a web dashboard and confirms or rejects it against the player's credit limit; the player gets notified back on Telegram.

Live deployment: [betpilot-ai-five.vercel.app](https://betpilot-ai-five.vercel.app) · Repo: [AndriiTs1/betpilot-ai](https://github.com/AndriiTs1/betpilot-ai)

> `docs/MVP.md`, `docs/architecture/PROJECT_ARCHITECTURE.md`, `docs/domain/DOMAIN_MODEL.md` are the **original pre-implementation planning docs** (WhatsApp + wallet-balance design). The actual system diverged from them (Telegram instead of WhatsApp, a credit-limit model instead of a wallet balance, a Mini App instead of in-chat text parsing — see below) and they have not been updated to match. Treat this README as the source of truth for current behavior.

## Documentation

Current project documentation:

- `README.md` — what the system does today (this file)
- `docs/CHANGELOG.md` — chronological log of completed development stages
- `docs/decisions/` — Architecture Decision Records (ADRs): why significant technical/product decisions were made
- `docs/architecture/`, `docs/domain/` — original pre-implementation planning docs (outdated, see note above)

**README is the source of truth for current behavior. Architecture decisions are stored as ADRs** — see `docs/decisions/README.md` for the format and rules, and `docs/decisions/ADR-0001-project-history.md` for how the system got here.

## Status

Operator workflow (queue, confirm/reject against credit limit, player notification) and the player-facing Telegram Mini App (balance, active bets, history) are built and running in production on a real Postgres database. **Bet submission is now wired up** for both text and screenshot input — a player can describe a bet or upload/photograph a bet-slip screenshot, get an AI-parsed preview with live odds verification, and confirm it into a real `Bet` row that lands in the operator's existing queue. Only single-selection (non-parlay) bets can be confirmed today — a detected parlay/express is shown to the player but safely rejected at confirm time (see below). Settlement (grading bets after a match finishes and paying out) is also not implemented. See [What's not done](#whats-not-done-yet).

## What's been built

**Data layer**

- Prisma 7 schema on Neon Postgres (`prisma/schema.prisma`), 6 migrations applied: `Operator`, `Player`, `Bet` (including `previewId`, a unique idempotency key for confirm — see "Bet submission" below), `BetSelection`, `OddsSnapshot`, `Transaction`, `Message`, `Wallet`.
- Prisma 7's new `"prisma-client"` generator (full TS source, output to `lib/generated/prisma`, gitignored, regenerated via `postinstall`) with the `@prisma/adapter-neon` driver adapter for serverless.
- `prisma/seed.ts` — test fixtures (one operator, two players: `Andrii`, `Zegna`).
- **In-progress `Bet` → `Bet` + `BetSelection` migration** (parlay/express support), done in small additive stages, each shipped and verified in production before the next:
  - `Bet` gained `type: BetType` (`SINGLE | PARLAY`, defaults `SINGLE`), `totalOdds: Decimal?`, and a `selections: BetSelection[]` relation. The old `sport`/`event`/`outcome`/`odds` scalar fields on `Bet` are **kept, unchanged** — nothing reads `selections` as the source of truth yet.
  - New `BetSelection` model (`sport`/`event`/`outcome`/`odds`, FK to `Bet` with `onDelete: Cascade`) — one row per leg of a bet. No `BetSelectionStatus` yet; results are still tracked only on `Bet.status`.
  - `scripts/backfill-bet-selections.ts` — idempotent, transactional backfill utility (selects `type: SINGLE` bets with zero selections, creates one matching `BetSelection` + sets `totalOdds = odds`; re-running is a safe no-op). Already run once in production — all existing bets now have exactly one `BetSelection` each.
  - `GET /api/bets/pending`, `/api/bets/history`, `/api/miniapp/me`, `GET /api/dashboard/players` now all fetch and return `selections`/`totalOdds` alongside the old flat fields (`lib/bets/serialize.ts`'s `serializeBet`/`serializeBetSelection` make the Decimal→string conversion explicit rather than relying on `Prisma.Decimal.toJSON()`'s implicit behavior). `components/miniapp/types.ts`'s `RecentBet` type now matches this contract (`totalOdds`, `selections: MiniAppBetSelection[]`, both required).
  - **The Mini App now renders accumulators** — see `BetSelectionsList.tsx` below. The **operator dashboard does not**: `BetQueueItem.tsx`/`BetHistory.tsx`/`PlayerCard.tsx` still render only the old flat `event`/`outcome`/`odds` fields, unaffected by this migration so far.
  - **Not done yet**: nothing creates a `BetSelection` for a bet confirmed today (text/screenshot confirm both only ever produce a `type: SINGLE` `Bet` with the flat fields — see "Bet submission" below), there's still no `BetSelectionStatus` (a single leg can't be voided/settled independently of the whole slip), `OddsSnapshot` is still tied to `Bet` rather than per-selection, and the operator dashboard hasn't been updated to match the Mini App. See [What's not done](#whats-not-done-yet).

**AI bet parsing** (`lib/ai/betParser.ts`)

- `parseBetMessage()` extracts `{ sport, event, selection, stake, odds }` from a free-text message. Dual provider, switchable via `AI_PROVIDER` env var: local **Ollama** (default, no API key) or **Claude** (`@anthropic-ai/sdk`, strict tool-use schema). Called live from `POST /api/miniapp/bets/text/preview`.
- `parseImageWithClaude()` extracts the same fields from a bet-slip screenshot via Claude's multimodal API — always Claude regardless of `AI_PROVIDER` (Ollama's default model has no vision support). Detects `SINGLE` vs `PARLAY` (multi-selection); a detected parlay's legs are returned to the client but can't be confirmed yet (see "Bet submission" below). Called live from `POST /api/miniapp/bets/screenshot/preview`.
- `processBet()`/`handleIncomingBet()` (`lib/bets/betService.ts`, `lib/telegram/betHandler.ts`) — the older WhatsApp-era chain that parsed a message and created a `Bet` directly, with no preview step — remain dead code, fully superseded by the preview → confirm flow below. Not called from any live route today.

**Odds verification** (`lib/odds/oddsVerifier.ts`)

- Looks up the event on **The Odds API** and compares the player-submitted odds against the live market, with sport-key mapping and fuzzy RU/EN team-name matching. Called live from both `POST /api/miniapp/bets/text/preview` and `POST /api/miniapp/bets/screenshot/preview`. `matched` (event/market/selection actually found) and `withinTolerance` (submitted odds close enough to the source price) are separate verdicts, not conflated into one flag.

**Telegram integration** (`lib/telegram/`, `app/api/webhooks/telegram/`)

- `POST /api/webhooks/telegram` — the bot webhook, now **Mini-App-only**: `/start` sends a welcome message with an inline "Open app" button (`web_app` deep link into `/miniapp`); any other text, command, or photo gets the same generic redirect nudge back to the Mini App. The webhook never parses message content into a bet and never creates a `Bet` row — it's purely a router.
- Verified via `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET` (`lib/auth/telegramWebhookAuth.ts`, constant-time compare).
- `lib/telegram/sendMessage.ts` — outbound messages via the Bot API (`parse_mode: "HTML"`).
- `lib/telegram/escapeHtml.ts` — escapes `&`/`<`/`>` in player-controlled text (event/outcome) before interpolating into HTML messages.
- Player confirm/reject notifications are sent from the bet-action routes (see below), not the webhook.

**Telegram Mini App** (`app/miniapp/`, `components/miniapp/`, `app/api/miniapp/me`)

- Player-facing PWA-like app opened from the bot's "Open app" button. Verifies Telegram `initData` server-side (`lib/telegram/verifyInitData.ts`, HMAC-SHA256 per Telegram's spec, rejects data older than 5 minutes) via `Authorization: tma <initData>` on `GET /api/miniapp/me`.
- 4-tab bottom navigation (`BottomNav.tsx`): **Bet** (`BetScreen.tsx`), **Active** (`ActiveBetsScreen.tsx`), **History** (`HistoryScreen.tsx`), **Balance** (`BalanceScreen.tsx`) — active/history are classified client-side purely from the existing `Bet.status` values, no separate API/query needed.
- `BetScreen.tsx` — current "AI Assistant First" composition: compact status header, one primary CTA that opens `BetActionSheet.tsx` (a hand-rolled, no-dependency bottom sheet — Escape/backdrop-click/focus/scroll-lock handled manually) offering "Отправить скриншот" / "Написать ставку", a compact credit summary bar, and the last 2 bets. Both options now open a real preview → confirm flow — see "Bet submission" below.
- `BetSelectionsList.tsx` — renders an accumulator's legs. Purely presentational: returns `null` for a single/missing/empty `selections` array (leaving a single bet's card exactly as it always looked), otherwise a native `<details>/<summary>` ("Экспресс ×N", no library, no JS state, collapsed by default) listing each leg's `sport`/`event`/`outcome`/`odds`. Wired into `ActiveBetsScreen.tsx` and `HistoryScreen.tsx` (full expandable list) and, more compactly, into `BetScreen.tsx`'s "Последняя активность" mini-list (single-line `Экспресс ×N · {event}` label, no expansion — that row has no room for a second line). All three also switch the displayed odds from `bet.odds` to `bet.totalOdds` whenever `selections.length > 1`. No real accumulator exists in production yet to visually confirm against live data — verified locally instead via a mocked multi-leg response.
- `WelcomeBanner.tsx` — one-shot, auto-dismissing (~2.75s) greeting shown once per session, respects `prefers-reduced-motion`.
- `MiniAppBackground.tsx` — static, decorative "premium sports arena" background (layered CSS gradients, no images/canvas/video), shared across all tabs via `app/miniapp/layout.tsx`.

**Bet submission — text and screenshot** (`components/miniapp/BetTextForm.tsx`, `BetScreenshotForm.tsx`, `BetPreviewCard.tsx`, `app/api/miniapp/bets/`)

- Player flow: describe a bet as text or upload/photograph a bet-slip screenshot → AI-parsed preview with live odds verification → confirm → a real `Bet` row (`status: PENDING`) lands in the same queue the operator dashboard already reads, confirms, and rejects against the credit limit — no changes needed on the operator side.
- `POST /api/miniapp/bets/text/preview` and `POST /api/miniapp/bets/screenshot/preview` are preview-only: zero DB writes beyond a read-only `Player` lookup. Each parses the input (`betParser.ts`), verifies odds (`oddsVerifier.ts`), and returns a short-lived HMAC-signed `previewToken` (`lib/betPreview/previewToken.ts`, 180s TTL, versioned payload) carrying everything the confirm step needs — nothing is persisted between preview and confirm.
- `POST /api/miniapp/bets/text/confirm` verifies the `previewToken`, then creates the `Bet` (+ `OddsSnapshot` if odds were checked) inside one transaction (`lib/bets/createBetFromPreview.ts`). Idempotent and race-safe: `Bet.previewId` has a unique DB constraint, so confirming the same token twice — sequentially or concurrently — returns the same `Bet` instead of creating a duplicate. The screenshot flow reuses this exact same confirm endpoint; it doesn't have (or need) its own.
- Screenshot upload additionally validates the file server-side before it ever reaches Claude: MIME allow-list (`image/jpeg`/`png`/`webp`, no SVG), a 10 MB size limit, and a real magic-byte signature check (catches a mislabeled/renamed file even when its declared `Content-Type` looks fine). The image only ever exists in memory for the duration of the request — never written to disk or a storage bucket.
- **Only single-selection (non-parlay) bets can be confirmed today.** The screenshot parser can detect a multi-selection (parlay/accumulator) slip and returns the recognized legs to the client, but `previewToken`/confirm only model a single selection — a detected parlay gets an explicit `422 PARLAY_CONFIRM_NOT_SUPPORTED` instead of silently being confirmed as (or collapsed into) a single bet. See [What's not done](#whats-not-done-yet).
- `PreviewCard`/`OddsStatus` (`BetPreviewCard.tsx`) are the one preview UI both `BetTextForm` and `BetScreenshotForm` render — the two flows return an identical response contract, so there's exactly one preview screen, not two.

**Credit-limit risk model** (replaced an earlier `Wallet.balance` design)

- `Player.creditLimit` / `Player.currentCredit` (`currentCredit` negative = player owes; positive = player is up).
- A bet is accepted into the queue with **no** credit check (operator should see risky requests too).
- On **confirm**, `POST /api/bets/[id]/confirm` computes `remaining credit = currentCredit < 0 ? creditLimit + currentCredit : creditLimit`, subtracts the player's other `CONFIRMED` exposure (`bet.aggregate` sum), and rejects with `409` if the new bet's stake exceeds what's left. The status flip to `CONFIRMED` is an atomic conditional update (`where: { status: "PENDING" }`) to guard against concurrent confirm/reject races.
- No money actually moves yet — that's deferred to settlement (not built).

**Operator dashboard** (`app/page.tsx` + `components/`)

- `DashboardOverview` — Active Players, Available Credit, Pending Bets, Played/Not-Played stat cards, backed by `GET /api/dashboard/overview`.
- `BetQueue` — pending bets with Confirm/Reject actions, **auto-refreshes every 10s** (`setInterval`, cleaned up on unmount) without flashing "Loading..." or clobbering the visible list on a transient background fetch error (only the very first load can set the error state).
- `BetHistory` — last 50 resolved (non-`PENDING`) bets, read-only, shared `StatusBadge` component (also used in `PlayerCard`).
- `PlayerList` / `PlayerCard` — per-player credit limit, current credit, exposure, bet count, next settlement date (15th / last day of month, `Europe/Zurich`), recent bets. Responsive: separate compact layout below the `lg` breakpoint.

**API surface**
| Route | Auth | Purpose |
|---|---|---|
| `GET/POST /api/bets/pending`, `/api/bets/history`, `/api/bets/[id]/confirm`, `/api/bets/[id]/reject` | `Authorization: Bearer OPERATOR_SECRET` | Internal operator API (Prisma queries live here) |
| `GET /api/dashboard/bets/pending`, `/api/dashboard/bets/history`, `POST /api/dashboard/bets/[id]/confirm`, `/api/dashboard/bets/[id]/reject` | none (browser-facing) | Thin proxy — injects `OPERATOR_SECRET` server-side via `lib/dashboard/operatorApiProxy.ts` so the browser never sees it |
| `GET /api/dashboard/overview`, `GET /api/dashboard/players` | **none** | Direct Prisma reads, no auth check at all (see [Known gaps](#whats-not-done-yet)) |
| `POST /api/webhooks/telegram` | `X-Telegram-Bot-Api-Secret-Token` vs `TELEGRAM_WEBHOOK_SECRET` | Bot webhook — Mini-App-only redirect, never creates a `Bet` |
| `GET /api/miniapp/me` | `Authorization: tma <initData>` (Telegram Mini App HMAC verification) | Player's own credit/exposure summary + last 20 bets (read-only) |
| `POST /api/miniapp/bets/text/preview`, `POST /api/miniapp/bets/screenshot/preview` | `Authorization: tma <initData>` | AI-parsed bet preview + odds check + signed `previewToken`; zero DB writes |
| `POST /api/miniapp/bets/text/confirm` | `Authorization: tma <initData>` | Verifies `previewToken`, creates the `Bet` (idempotent). Shared by both preview routes |

**Infra / ops**

- Deployed on Vercel, GitHub auto-deploy on push to `main` (has occasionally not fired — see below), Neon Postgres.
- `lib/auth/operatorAuth.ts` — constant-time (`timingSafeEqual`) Bearer-token check for the internal API.
- Diagnosed and fixed a 3-part production incident: missing `OPERATOR_SECRET`, internal fetches hitting Vercel's SSO-gated raw deployment URL instead of the stable production alias, and a corrupted (triple-pasted) secret value.
- `VERCEL_PROJECT_PRODUCTION_URL` used (not `request.url`) so internal dashboard→API fetches don't get redirected to a login page by Vercel Deployment Protection.

## Closed-demo player onboarding

A closed demo has no public sign-up: every player is invited by an operator before they ever open the bot, using only virtual/demo credit — no deposit, withdrawal, payment, or payout logic exists or is implied by this flow.

- `Player.telegramUsername` (`String? @unique`, normalized: no leading `@`, lowercase) is a **one-time onboarding aid only** — never an authentication credential. Mini App access (`GET /api/miniapp/me`) continues to authenticate exclusively by matching signed `initData`'s `user.id` against `Player.telegramId`, exactly as before this feature.
- **Invite**: an operator runs `npm run player:invite` (`scripts/invite-player.ts`, same manual/local-DB-access pattern as `npm run operator:create`) to create a Player row with a known `telegramUsername` and `telegramId: null` — "invited, not yet bound." Idempotent: safe to re-run (e.g. to update `name`/`phoneNumber`/credit fields), never touches `telegramId` on an existing row.
  ```bash
  PLAYER_NAME="Denis" PLAYER_TELEGRAM_USERNAME="kda0508" \
  PLAYER_PHONE="+380676210203" OPERATOR_PHONE="+10000000000" \
  npm run player:invite
  ```
- **Bind**: the first time that real Telegram account sends `/start`, `lib/telegram/bindInvitedPlayer.ts`'s `bindInvitedPlayerByTelegramUsername()` runs inside the existing webhook handler (`app/api/webhooks/telegram/route.ts`) and atomically sets `telegramId` on the matching invited row via a single `UPDATE ... WHERE telegramUsername = ? AND telegramId IS NULL` — race-safe under concurrent duplicate `/start`s (only one can ever match), idempotent on repeat (`telegramId` already set means the row no longer matches), and never reassigns an already-bound row to a different Telegram account. A username with no invited match is a silent no-op — the bot's welcome message is identical either way, so it never leaks which usernames are registered. This never auto-creates a Player.
- Once bound, the player is indistinguishable from any other — `telegramUsername` is never consulted again.

## What's not done yet

- **Parlay/express bets can't be confirmed.** The screenshot parser detects a multi-selection slip and returns its legs to the client (`422 PARLAY_CONFIRM_NOT_SUPPORTED`), and the text parser could in principle be extended the same way, but `previewToken`'s payload and `createBetFromPreview.ts` only model a single selection — `Bet.type` is hardcoded to `SINGLE` on every confirm-created row. `BetSelection`/`Bet.totalOdds` exist in the schema and are already backfilled/displayed for existing accumulators (see "Data layer"), but nothing **creates** a `BetSelection` for a newly confirmed bet, and the **operator dashboard** (`BetQueueItem.tsx`/`BetHistory.tsx`/`PlayerCard.tsx`) still renders only the old flat fields. There's also still no `BetSelectionStatus` (a single leg can't be voided/settled independently), and `OddsSnapshot` is still tied to `Bet` rather than per-selection. Single-selection bets — text or screenshot — are unaffected by any of this and work today.
- **No rate limiting** on `POST /api/miniapp/bets/text/preview`, `/text/confirm`, or `/screenshot/preview` — a registered player (or anyone who can forge valid-looking requests past Telegram auth) can call these as fast as the AI provider/odds API will respond. Not exploited, just not built yet.
- **Screenshot uploads are never persisted.** By design for now (see "Bet submission" above) — the image only exists in memory for the request. No storage integration (`@vercel/blob` or otherwise) exists, which also means there's no way for an operator to later review the original screenshot behind a confirmed bet.
- **`types/bet.ts`'s `BetStatus` is out of sync with Prisma's.** Prisma: `PENDING/CONFIRMED/REJECTED/SETTLED_WIN/SETTLED_LOSS/VOID`. `types/bet.ts`: a completely different 7-value union (`RECEIVED/AI_ANALYZED/WAITING_CONFIRMATION/CONFIRMED/SETTLED/PAID/REJECTED`) that shares only 2 of 7 values, and its own `Currency = "USDC"` no longer matches the Mini App UI (which now shows plain numbers, no currency label). Confirmed dead — nothing imports it. `components/bets/StatusBadge.tsx` is the one place that's correctly in sync with Prisma. Should be deleted as part of whichever task next touches this area.
- **Settlement.** Nothing determines match results or moves `currentCredit`/creates payout records after a bet is graded. `Bet.status` has `SETTLED_WIN`/`SETTLED_LOSS`/`VOID` in the enum but nothing ever sets them.
- **`Wallet` and `Transaction` models are dead code.** Both still exist in `prisma/schema.prisma` and get seeded/cleaned up in `prisma/seed.ts`, but no application code reads or writes them anymore since the switch to the credit-limit model (confirmed via grep: zero `.wallet.*`/`.transaction.*` calls outside `seed.ts`). Either wire them into settlement or drop them.
- **No operator authentication for the dashboard itself.** `app/page.tsx` and `GET /api/dashboard/overview` / `GET /api/dashboard/players` have no login and no secret check — only the bet action routes are gated. Anyone with the URL can currently view all players, balances, and bet history. `POST /api/dashboard/bets/[id]/confirm` / `/reject` are also unauthenticated at the client-facing layer (they proxy to the real, secret-protected `/api/bets/*` routes server-side, but nothing checks who's allowed to trigger that proxy).
- **Dead/leftover files**: `components/bets/BetPreview.tsx` (empty), `lib/wallet/balance.ts` + `types/wallet.ts` (unused, pre-date the credit-limit model), `types/player.ts` (unused).
- **`docs/`** (`MVP.md`, `PROJECT_ARCHITECTURE.md`, `DOMAIN_MODEL.md`) describe the original WhatsApp/wallet/NestJS plan and don't reflect the current Telegram/credit-limit/Mini-App/Next.js-only implementation.
- **No automated tests.** Correctness currently rests on `tsc --noEmit` + `eslint` + manual verification (and ad-hoc Playwright checks during development, not committed as a test suite).
- **No multi-operator scoping**: schema allows multiple `Operator`s, but nothing in the UI/API scopes by operator — `/api/dashboard/*` reads across all operators.
- Git→Vercel auto-deploy has repeatedly not fired after a push in practice (root cause not diagnosed — worked around with `vercel --prod` when noticed); worth keeping an eye on, it isn't reliable.

## Tech Stack

- **Next.js 16.2.10** (App Router, Turbopack) — see `AGENTS.md`, this version has breaking changes vs. older Next.js docs/training data.
- **React 19.2.4**, **TypeScript**, **Tailwind CSS v4**
- **Prisma 7.8.0** + `@prisma/adapter-neon`, **Neon Postgres**
- **Zod v4** (LLM output validation)
- **Anthropic SDK** (`@anthropic-ai/sdk`) + local **Ollama** — dual AI provider
- **The Odds API** — live odds
- **Telegram Bot API** + **Telegram Mini Apps** — player messaging and the `/miniapp` player-facing UI
- **Tabler Icons** webfont (operator dashboard) + **lucide-react** (Mini App)
- Deployed on **Vercel**

## Getting Started

```bash
npm install                 # runs `prisma generate` via postinstall
cp .env.example .env        # fill in DATABASE_URL, OPERATOR_SECRET, TELEGRAM_BOT_TOKEN, etc.
npm run db:seed             # optional: seed test operator + players
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the dashboard. See `.env.example` for every required variable and where to get it (Neon, Ollama/Anthropic, The Odds API, Telegram `@BotFather`).

```bash
npx tsc --noEmit   # typecheck
npm run lint       # eslint
npm run build      # production build
```

## Project Structure

```
app/
  page.tsx                       Operator dashboard page
  miniapp/                       Player-facing Telegram Mini App
    layout.tsx                   Renders MiniAppBackground behind every tab
    page.tsx                     Script loading, initData fetch, banner/data screen switch
  api/
    bets/                        Internal operator API (Bearer-token protected)
      pending/ history/ [id]/confirm/ [id]/reject/
    dashboard/                   Browser-facing routes
      overview/ players/         direct Prisma reads, unauthenticated
      bets/                      proxy to /api/bets/* (injects OPERATOR_SECRET)
    miniapp/
      me/                        GET — player's own summary + recent bets (initData-verified)
      bets/text/preview/         POST — text bet AI preview + odds check + signed previewToken
      bets/text/confirm/         POST — verifies previewToken, creates the Bet (idempotent)
      bets/screenshot/preview/   POST — same contract as text preview, multipart image input
    webhooks/telegram/           Telegram bot webhook — Mini-App-only redirect
components/
  dashboard/                     Overview stat cards
  bets/                          BetQueue (auto-refresh), BetHistory, StatusBadge
  players/                       PlayerList, PlayerCard (responsive)
  miniapp/                       BottomNav, BetScreen, BetActionSheet, ActiveBetsScreen,
                                  HistoryScreen, BalanceScreen, WelcomeBanner, MiniAppBackground,
                                  BetSelectionsList (renders accumulator legs, or nothing for a single bet),
                                  BetTextForm / BetScreenshotForm (preview -> confirm UI, share
                                  BetPreviewCard.tsx for the actual preview render),
                                  betPreviewApi.ts / betScreenshotApi.ts / betConfirmApi.ts (client API layer)
lib/
  ai/betParser.ts                Ollama/Claude text extraction + Claude-only image (multimodal) extraction
  odds/oddsVerifier.ts           The Odds API integration — live, called from both preview routes
  betPreview/previewToken.ts     Signed, short-lived (180s) HMAC token carrying a preview's content
  bets/                          betService (orchestration, orphaned — see "What's not done yet"),
                                  createBetFromPreview.ts (idempotent confirm-time Bet creation), serialize
  telegram/                      webhook handler, sendMessage, escapeHtml, verifyInitData
  auth/                          operatorAuth.ts (Bearer-token), telegramWebhookAuth.ts (secret_token)
  players/credit.ts              computeRemainingCredit — shared credit-limit math
  dashboard/operatorApiProxy.ts  server-side secret injection
  db/client.ts                   Prisma singleton (Neon adapter)
  wallet/                        legacy, unused (see "What's not done yet")
types/                           Shared domain types — types/bet.ts is stale/out of sync with Prisma, see above
prisma/                          schema, migrations, seed
scripts/                         backfill-bet-selections.ts — idempotent Bet -> BetSelection backfill utility
docs/                            Pre-implementation planning docs (outdated, see note above)
```
