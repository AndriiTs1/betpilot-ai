# BetPilot AI

AI-powered sports betting operations platform. A player opens a Telegram Mini App to see their credit/balance and bet history, and (once submission is wired up — see below) will send a bet as text or a coupon screenshot; an LLM will extract the structured bet (sport, event, selection, stake, odds); the odds get checked against a live sportsbook API; an operator reviews the request in a web dashboard and confirms or rejects it against the player's credit limit; the player gets notified back on Telegram.

Live deployment: [betpilot-ai-five.vercel.app](https://betpilot-ai-five.vercel.app) · Repo: [AndriiTs1/betpilot-ai](https://github.com/AndriiTs1/betpilot-ai)

> `docs/MVP.md`, `docs/architecture/PROJECT_ARCHITECTURE.md`, `docs/domain/DOMAIN_MODEL.md` are the **original pre-implementation planning docs** (WhatsApp + wallet-balance design). The actual system diverged from them (Telegram instead of WhatsApp, a credit-limit model instead of a wallet balance, a Mini App instead of in-chat text parsing — see below) and they have not been updated to match. Treat this README as the source of truth for current behavior.

## Status

Operator workflow (queue, confirm/reject against credit limit, player notification) and the player-facing Telegram Mini App (balance, active bets, history) are built and running in production on a real Postgres database. **Bet submission itself is not wired up yet** — the Mini App's "Отправить ставку" flow is UI-only (opens a bottom sheet, no backend call), and the AI-parsing/odds-verification pipeline that used to run off the bot webhook is now orphaned dead code since the webhook was pivoted to a Mini-App-only redirect (see below). Settlement (grading bets after a match finishes and paying out) is also not implemented. See [What's not done](#whats-not-done-yet).

## What's been built

**Data layer**

- Prisma 7 schema on Neon Postgres (`prisma/schema.prisma`), 4 migrations applied: `Operator`, `Player`, `Bet`, `OddsSnapshot`, `Transaction`, `Message`, `Wallet`.
- Prisma 7's new `"prisma-client"` generator (full TS source, output to `lib/generated/prisma`, gitignored, regenerated via `postinstall`) with the `@prisma/adapter-neon` driver adapter for serverless.
- `prisma/seed.ts` — test fixtures (one operator, two players: `Andrii`, `Zegna`).

**AI bet parsing — implemented but currently orphaned** (`lib/ai/betParser.ts`, `lib/telegram/betHandler.ts`, `lib/bets/betService.ts`)

- `parseBetMessage()` extracts `{ sport, event, selection, stake, odds }` from a free-text message. Dual provider, switchable via `AI_PROVIDER` env var: local **Ollama** (default, no API key) or **Claude** (`@anthropic-ai/sdk`, strict tool-use schema).
- `processBet()`/`handleIncomingBet()` chain this into a full "parse → verify odds → create Bet" flow, with **no credit check at creation** (by design — the operator should see risky requests too).
- **Confirmed dead code**: nothing calls `processBet`/`handleIncomingBet`/`parseBetMessage` from any live route today (verified by grep). This chain was built for the earlier WhatsApp/in-chat-text design; once the Telegram webhook was pivoted to Mini-App-only (see below), it lost its only caller. Fully reusable logic, but not currently reachable by any user action.

**Odds verification — same status: implemented, orphaned** (`lib/odds/oddsVerifier.ts`)

- Looks up the event on **The Odds API** and compares the player-submitted odds against the live market, with sport-key mapping and fuzzy RU/EN team-name matching. Only ever called from the dead `betService.ts` chain above, so also currently unreachable. Known bug: `matched` is hardcoded to `false` even on a successful match (never actually set `true`) — hasn't surfaced as a live bug only because the calling code is dead.

**Telegram integration** (`lib/telegram/`, `app/api/webhooks/telegram/`)

- `POST /api/webhooks/telegram` — the bot webhook, now **Mini-App-only**: `/start` sends a welcome message with an inline "Open app" button (`web_app` deep link into `/miniapp`); any other text, command, or photo gets the same generic redirect nudge back to the Mini App. The webhook never parses message content into a bet and never creates a `Bet` row — it's purely a router.
- Verified via `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET` (`lib/auth/telegramWebhookAuth.ts`, constant-time compare).
- `lib/telegram/sendMessage.ts` — outbound messages via the Bot API (`parse_mode: "HTML"`).
- `lib/telegram/escapeHtml.ts` — escapes `&`/`<`/`>` in player-controlled text (event/outcome) before interpolating into HTML messages.
- Player confirm/reject notifications are sent from the bet-action routes (see below), not the webhook.

**Telegram Mini App** (`app/miniapp/`, `components/miniapp/`, `app/api/miniapp/me`)

- Player-facing PWA-like app opened from the bot's "Open app" button. Verifies Telegram `initData` server-side (`lib/telegram/verifyInitData.ts`, HMAC-SHA256 per Telegram's spec, rejects data older than 5 minutes) via `Authorization: tma <initData>` on `GET /api/miniapp/me`.
- 4-tab bottom navigation (`BottomNav.tsx`): **Bet** (`BetScreen.tsx`), **Active** (`ActiveBetsScreen.tsx`), **History** (`HistoryScreen.tsx`), **Balance** (`BalanceScreen.tsx`) — active/history are classified client-side purely from the existing `Bet.status` values, no separate API/query needed.
- `BetScreen.tsx` — current "AI Assistant First" composition: compact status header, one primary CTA that opens `BetActionSheet.tsx` (a hand-rolled, no-dependency bottom sheet — Escape/backdrop-click/focus/scroll-lock handled manually) offering "Отправить скриншот" / "Написать ставку", a compact credit summary bar, and the last 2 bets. **Both options in the sheet are currently no-ops** — see [What's not done](#whats-not-done-yet).
- `WelcomeBanner.tsx` — one-shot, auto-dismissing (~2.75s) greeting shown once per session, respects `prefers-reduced-motion`.
- `MiniAppBackground.tsx` — static, decorative "premium sports arena" background (layered CSS gradients, no images/canvas/video), shared across all tabs via `app/miniapp/layout.tsx`.

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

**Infra / ops**

- Deployed on Vercel, GitHub auto-deploy on push to `main` (has occasionally not fired — see below), Neon Postgres.
- `lib/auth/operatorAuth.ts` — constant-time (`timingSafeEqual`) Bearer-token check for the internal API.
- Diagnosed and fixed a 3-part production incident: missing `OPERATOR_SECRET`, internal fetches hitting Vercel's SSO-gated raw deployment URL instead of the stable production alias, and a corrupted (triple-pasted) secret value.
- `VERCEL_PROJECT_PRODUCTION_URL` used (not `request.url`) so internal dashboard→API fetches don't get redirected to a login page by Vercel Deployment Protection.

## What's not done yet

- **Bet submission from the Mini App is UI-only.** `BetActionSheet.tsx`'s two options ("Отправить скриншот" / "Написать ставку") only close the sheet — no API call, no handler. There is currently **no way for a player to create a bet at all** (the old webhook text-parsing path is also dead — see above), only to view existing ones. A researched-but-not-yet-approved plan exists for a minimal text + screenshot submission flow (new `POST /api/miniapp/bets/text` and `/screenshot` routes, reusing `betParser.ts`/`oddsVerifier.ts`, Claude multimodal instead of a separate OCR lib, `@vercel/blob` for image storage).
- **Express/parlay (multi-leg) bets are not supported by the schema.** `Bet` has scalar `sport`/`event`/`outcome`/`odds` fields — exactly one event per row, no child table. Confirmed (researched, not yet implemented) that a `BetSelection` child model + `Bet.type: SINGLE | PARLAY` + `Bet.totalOdds` + a separate `BetSelectionStatus` enum would be needed to represent a multi-leg slip, price it, partially void a leg, or display it correctly. Single bets work today without any schema change.
- **`types/bet.ts`'s `BetStatus` is out of sync with Prisma's.** Prisma: `PENDING/CONFIRMED/REJECTED/SETTLED_WIN/SETTLED_LOSS/VOID`. `types/bet.ts`: a completely different 7-value union (`RECEIVED/AI_ANALYZED/WAITING_CONFIRMATION/CONFIRMED/SETTLED/PAID/REJECTED`) that shares only 2 of 7 values. Confirmed dead — nothing imports it as a status type (only `oddsVerifier.ts` reads its `Bet` interface shape, which itself has a naming bug: `selection` vs. Prisma's `outcome`). `components/bets/StatusBadge.tsx` is the one place that's correctly in sync with Prisma. Should be deleted/rewritten as part of whichever task next touches `oddsVerifier.ts`.
- **AI parsing (`lib/ai/betParser.ts`) and odds verification (`lib/odds/oddsVerifier.ts`) are implemented but orphaned** — no live caller since the webhook pivoted to Mini-App-only (see above). Fully reusable for the submission-flow plan above, but not reachable by any user action today. `oddsVerifier.ts` also has a pre-existing bug: `matched` is hardcoded `false` even on a successful match.
- **Settlement.** Nothing determines match results or moves `currentCredit`/creates payout records after a bet is graded. `Bet.status` has `SETTLED_WIN`/`SETTLED_LOSS`/`VOID` in the enum but nothing ever sets them.
- **`Wallet` and `Transaction` models are dead code.** Both still exist in `prisma/schema.prisma` and get seeded/cleaned up in `prisma/seed.ts`, but no application code reads or writes them anymore since the switch to the credit-limit model (confirmed via grep: zero `.wallet.*`/`.transaction.*` calls outside `seed.ts`). Either wire them into settlement or drop them.
- **No operator authentication for the dashboard itself.** `app/page.tsx` and `GET /api/dashboard/overview` / `GET /api/dashboard/players` have no login and no secret check — only the bet action routes are gated. Anyone with the URL can currently view all players, balances, and bet history.
- **Dead/leftover files**: `components/bets/BetPreview.tsx` (empty), `lib/wallet/balance.ts` + `types/wallet.ts` (unused, pre-date the credit-limit model), `types/player.ts` (unused).
- **`docs/`** (`MVP.md`, `PROJECT_ARCHITECTURE.md`, `DOMAIN_MODEL.md`) describe the original WhatsApp/wallet/NestJS plan and don't reflect the current Telegram/credit-limit/Mini-App/Next.js-only implementation.
- **No automated tests.** Correctness currently rests on `tsc --noEmit` + `eslint` + manual verification (and ad-hoc Playwright checks during development, not committed as a test suite).
- **No multi-operator scoping**: schema allows multiple `Operator`s, but nothing in the UI/API scopes by operator — `/api/dashboard/*` reads across all operators.
- Git→Vercel auto-deploy has silently not fired at least once after a push (root cause not diagnosed — worked around with `vercel --prod`); worth keeping an eye on.

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
    miniapp/me/                  GET — player's own summary + recent bets (initData-verified)
    webhooks/telegram/           Telegram bot webhook — Mini-App-only redirect
components/
  dashboard/                     Overview stat cards
  bets/                          BetQueue (auto-refresh), BetHistory, StatusBadge
  players/                       PlayerList, PlayerCard (responsive)
  miniapp/                       BottomNav, BetScreen, BetActionSheet, ActiveBetsScreen,
                                  HistoryScreen, BalanceScreen, WelcomeBanner, MiniAppBackground
lib/
  ai/betParser.ts                Ollama/Claude bet extraction (orphaned, see "What's not done yet")
  odds/oddsVerifier.ts           The Odds API integration (orphaned, same caveat)
  bets/                          betService (orchestration, orphaned), serialize
  telegram/                      webhook handler, sendMessage, escapeHtml, verifyInitData
  auth/                          operatorAuth.ts (Bearer-token), telegramWebhookAuth.ts (secret_token)
  players/credit.ts              computeRemainingCredit — shared credit-limit math
  dashboard/operatorApiProxy.ts  server-side secret injection
  db/client.ts                   Prisma singleton (Neon adapter)
  wallet/                        legacy, unused (see "What's not done yet")
types/                           Shared domain types — types/bet.ts is stale/out of sync with Prisma, see above
prisma/                          schema, migrations, seed
docs/                            Pre-implementation planning docs (outdated, see note above)
```
