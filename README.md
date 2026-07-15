# BetPilot AI

AI-powered sports betting operations platform. A player sends a bet request in free-form text to a Telegram bot; an LLM extracts the structured bet (sport, event, selection, stake, odds); the odds are checked against a live sportsbook API; an operator reviews the request in a web dashboard and confirms or rejects it against the player's credit limit; the player gets notified back on Telegram.

Live deployment: [betpilot-ai-five.vercel.app](https://betpilot-ai-five.vercel.app) · Repo: [AndriiTs1/betpilot-ai](https://github.com/AndriiTs1/betpilot-ai)

> `docs/MVP.md`, `docs/architecture/PROJECT_ARCHITECTURE.md`, `docs/domain/DOMAIN_MODEL.md` are the **original pre-implementation planning docs** (WhatsApp + wallet-balance design). The actual system diverged from them (Telegram instead of WhatsApp, a credit-limit model instead of a wallet balance — see below) and they have not been updated to match. Treat this README as the source of truth for current behavior.

## Status

Core operator workflow is built and running in production: Telegram intake → AI parsing → odds verification → operator confirm/reject → player notification, backed by a real Postgres database. Settlement (grading bets after a match finishes and paying out) is not implemented yet — see [What's not done](#whats-not-done-yet).

## What's been built

**Data layer**
- Prisma 7 schema on Neon Postgres (`prisma/schema.prisma`), 4 migrations applied: `Operator`, `Player`, `Bet`, `OddsSnapshot`, `Transaction`, `Message`, `Wallet`.
- Prisma 7's new `"prisma-client"` generator (full TS source, output to `lib/generated/prisma`, gitignored, regenerated via `postinstall`) with the `@prisma/adapter-neon` driver adapter for serverless.
- `prisma/seed.ts` — test fixtures (one operator, two players: `Andrii`, `Zegna`).

**AI bet parsing** (`lib/ai/betParser.ts`)
- Extracts `{ sport, event, selection, stake, odds }` from a free-text message.
- Dual provider, switchable via `AI_PROVIDER` env var: local **Ollama** (default, no API key) or **Claude** (`@anthropic-ai/sdk`, strict tool-use schema). Production runs on Claude.

**Odds verification** (`lib/odds/oddsVerifier.ts`)
- Looks up the event on **The Odds API** and compares the player-submitted odds against the live market, with sport-key mapping and fuzzy RU/EN team-name matching.

**Telegram integration** (`lib/telegram/`, `app/api/webhooks/telegram/`)
- `POST /api/webhooks/telegram` — the bot webhook. Parses the Telegram update, looks up the player by `telegramId`, runs it through the AI parser + odds check + credit-aware bet creation, replies with an HTML-formatted status message (bet accepted / parse failed / not registered / error).
- `lib/telegram/sendMessage.ts` — outbound messages via the Bot API (`parse_mode: "HTML"`).
- `lib/telegram/escapeHtml.ts` — escapes `&`/`<`/`>` in player-controlled text (event/outcome) before interpolating into HTML messages.
- Player confirm/reject notifications are sent from the bet-action routes (see below), not the webhook.

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
| `POST /api/webhooks/telegram` | Telegram-side (no verification on our end yet) | Bot webhook |

**Infra / ops**
- Deployed on Vercel, GitHub auto-deploy on push to `main` (has occasionally not fired — see below), Neon Postgres.
- `lib/auth/operatorAuth.ts` — constant-time (`timingSafeEqual`) Bearer-token check for the internal API.
- Diagnosed and fixed a 3-part production incident: missing `OPERATOR_SECRET`, internal fetches hitting Vercel's SSO-gated raw deployment URL instead of the stable production alias, and a corrupted (triple-pasted) secret value.
- `VERCEL_PROJECT_PRODUCTION_URL` used (not `request.url`) so internal dashboard→API fetches don't get redirected to a login page by Vercel Deployment Protection.

## What's not done yet

- **Settlement.** Nothing determines match results or moves `currentCredit`/creates payout records after a bet is graded. `Bet.status` has `SETTLED_WIN`/`SETTLED_LOSS`/`VOID` in the enum but nothing ever sets them.
- **`Wallet` and `Transaction` models are dead code.** Both still exist in `prisma/schema.prisma` and get seeded/cleaned up in `prisma/seed.ts`, but no application code reads or writes them anymore since the switch to the credit-limit model (confirmed via grep: zero `.wallet.*`/`.transaction.*` calls outside `seed.ts`). Either wire them into settlement or drop them.
- **No operator authentication for the dashboard itself.** `app/page.tsx` and `GET /api/dashboard/overview` / `GET /api/dashboard/players` have no login and no secret check — only the bet action routes are gated. Anyone with the URL can currently view all players, balances, and bet history.
- **No Telegram webhook signature verification.** `POST /api/webhooks/telegram` trusts any POST body; Telegram supports a `secret_token` on `setWebhook` that isn't set up.
- **Dead/leftover files**: `components/bets/BetPreview.tsx` (empty), `lib/wallet/balance.ts` + `types/wallet.ts` (unused, pre-date the credit-limit model), `types/player.ts` (unused).
- **`docs/`** (`MVP.md`, `PROJECT_ARCHITECTURE.md`, `DOMAIN_MODEL.md`) describe the original WhatsApp/wallet/NestJS plan and don't reflect the current Telegram/credit-limit/Next.js-only implementation.
- **No automated tests.** Correctness currently rests on `tsc --noEmit` + `eslint` + manual verification.
- **No player-facing balance/history view**, no multi-operator support (schema allows multiple `Operator`s, but nothing in the UI/API scopes by operator — `/api/dashboard/*` reads across all operators).
- Git→Vercel auto-deploy has silently not fired at least once after a push (root cause not diagnosed — worked around with `vercel --prod`); worth keeping an eye on.

## Tech Stack

- **Next.js 16.2.10** (App Router, Turbopack) — see `AGENTS.md`, this version has breaking changes vs. older Next.js docs/training data.
- **React 19.2.4**, **TypeScript**, **Tailwind CSS v4**
- **Prisma 7.8.0** + `@prisma/adapter-neon`, **Neon Postgres**
- **Zod v4** (LLM output validation)
- **Anthropic SDK** (`@anthropic-ai/sdk`) + local **Ollama** — dual AI provider
- **The Odds API** — live odds
- **Telegram Bot API** — player messaging
- **Tabler Icons** webfont
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
  api/
    bets/                        Internal operator API (Bearer-token protected)
      pending/ history/ [id]/confirm/ [id]/reject/
    dashboard/                   Browser-facing routes
      overview/ players/         direct Prisma reads, unauthenticated
      bets/                      proxy to /api/bets/* (injects OPERATOR_SECRET)
    webhooks/telegram/           Telegram bot webhook
components/
  dashboard/                     Overview stat cards
  bets/                          BetQueue (auto-refresh), BetHistory, StatusBadge
  players/                       PlayerList, PlayerCard (responsive)
lib/
  ai/betParser.ts                Ollama/Claude bet extraction
  odds/oddsVerifier.ts           The Odds API integration
  bets/                          betService (orchestration), serialize
  telegram/                      webhook handler, sendMessage, escapeHtml
  auth/operatorAuth.ts           Bearer-token check
  dashboard/operatorApiProxy.ts  server-side secret injection
  db/client.ts                   Prisma singleton (Neon adapter)
  wallet/                        legacy, unused (see "What's not done yet")
types/                           Shared domain types (partially superseded by Prisma's generated types)
prisma/                          schema, migrations, seed
docs/                            Pre-implementation planning docs (outdated, see note above)
```
