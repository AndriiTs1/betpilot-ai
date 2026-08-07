# BetPilot AI

AI-powered sports betting operations platform. A player submits a bet as text or a screenshot through a Telegram Mini App; AI/OCR extracts a structured bet, odds are verified against a live sportsbook API, and an operator confirms or rejects it against the player's credit limit from a web dashboard.

Live deployment: [betpilot-ai-five.vercel.app](https://betpilot-ai-five.vercel.app) · Repo: [AndriiTs1/betpilot-ai](https://github.com/AndriiTs1/betpilot-ai)

## How it works

```
Player → Telegram Mini App → Text / Screenshot → AI / OCR
       → Odds verification → Operator review → Confirm / Reject → Settlement
```

## Current features

- SINGLE bets
- EXPRESS bets (2–10 selections)
- AI text parsing (Claude, tool-use extraction)
- Screenshot OCR → same parser as text
- Per-selection odds verification against a live provider
- Telegram Mini App (player-facing)
- Operator dashboard (review/confirm/reject/settle)
- Credit-limit enforcement, concurrency-safe
- Settlement (backend + dashboard UI)
- Operator authentication (password + database sessions)

## Player Mini App

- Tabs: **Bet**, **Active**, **History**, **Balance**
- Submit a bet as text or a screenshot
- AI/OCR-parsed preview with live odds check, then confirm
- Authenticated via Telegram `initData` (`Authorization: tma <initData>`)

## Operator Dashboard

- Session-based login (`/operator/login`)
- Overview (active players, available credit, pending bets)
- Player list with per-player credit/exposure
- Pending queue: **Confirm** / **Reject** against the player's credit limit
- Settlement: **Win** / **Lose** / **Void** buttons on confirmed bets

## Odds

- **The Odds API** is the main runtime provider today.
- Football **1X2** — supported.
- Football **totals** — supported (The Odds API only).
- **Sportmonks** — partial, feature-flagged: football only, a limited set of leagues, 1X2 only, SINGLE bets only, disabled by default (`SPORTMONKS_FOOTBALL_PREVIEW_ENABLED`).
- A provider-agnostic `OddsProvider` interface and a provider registry exist, but production routing is not fully wired through them yet — The Odds API and Sportmonks currently run as two separate pipelines.
- Spreads/handicaps and non-football sports (basketball, tennis, hockey) are not yet supported end-to-end.

See `docs/ODDS_SUPPORT_MATRIX.md` and `docs/ODDS_PROVIDER_DESIGN.md` for the target design and staged migration plan.

## Tech Stack

- **Next.js 16.2.10** (App Router, Turbopack) — see `AGENTS.md`, this version has breaking changes vs. older training data
- **React 19.2.4**, TypeScript, Tailwind CSS v4
- **Prisma 7.8.0** + `@prisma/adapter-neon`, Neon Postgres
- **Anthropic Claude** (bet parsing + OCR) with local Ollama as a text-only dev fallback
- **The Odds API** (primary odds provider), Sportmonks (partial, flagged)
- Telegram Bot API + Telegram Mini Apps
- Deployed on Vercel

## Quality

- `npm run lint` — PASS
- `npm test` — PASS, 2228 tests (`node --test`, no Jest/Vitest)
- `npm run build` — PASS
- `npx tsc --noEmit` — currently **FAIL**: 12 TypeScript errors, all confined to test files (type-fixture mismatches), no production code affected

## Known gaps

- No automatic settlement — nothing ingests real match results; settlement is a manual operator action today.
- No distributed rate limiting — Mini App rate limits are in-memory and per server instance.
- No screenshot persistence — uploaded images exist only in memory for the request.
- No multi-operator scoping — the dashboard reads across all operators.
- Odds provider registry exists but production odds routing isn't fully wired through it yet.
- Spreads/handicaps and non-football sports are not yet supported end-to-end.

## Development

```bash
npm install
npm run dev
npm run lint
npm test
npm run build
npx tsc --noEmit
```

Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `OPERATOR_SECRET`, `TELEGRAM_BOT_TOKEN`, etc. before running.

## Documentation

- `docs/ODDS_SUPPORT_MATRIX.md`, `docs/ODDS_PROVIDER_DESIGN.md` — current odds architecture design and target state
- `docs/decisions/` — Architecture Decision Records (why key decisions were made)
- `docs/OPERATOR_AUTH_IMPLEMENTATION.md` — operator authentication design

`docs/MVP.md`, `docs/architecture/`, `docs/domain/`, and `docs/CHANGELOG.md` are historical pre-implementation planning docs and stage logs — **outdated, not a source of truth**. This README reflects the current system; the code itself is the ultimate source of truth.
