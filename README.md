# BetPilot AI

AI-powered WhatsApp betting assistant platform.

The system receives betting requests from players via WhatsApp, uses AI to extract bet details (sport, event, selection, odds, stake), asks the operator to confirm or reject, stores the bet, and manages player USDC balances.

See [`docs/MVP.md`](docs/MVP.md) for scope, [`docs/architecture/PROJECT_ARCHITECTURE.md`](docs/architecture/PROJECT_ARCHITECTURE.md) for architecture, and [`docs/domain/DOMAIN_MODEL.md`](docs/domain/DOMAIN_MODEL.md) for the domain model.

## Status

Phase 1 — Foundation. Dashboard UI and domain types are scaffolded; AI parsing, odds verification, and wallet logic are currently stubbed pending real database and AI integration.

## Tech Stack

- Next.js (App Router), TypeScript, Tailwind CSS
- React 19

## Getting Started

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the dashboard.

## Project Structure

```
app/                     App Router pages and API routes
  api/webhooks/whatsapp/  WhatsApp webhook endpoint
components/
  dashboard/             Overview stats
  bets/                  Bet queue and confirmation UI
  players/               Player list and profiles
lib/
  ai/                    Bet message parsing (stub)
  bets/                  Bet processing orchestration
  odds/                  Odds verification (stub)
  wallet/                Balance and transaction logic
  whatsapp/              Incoming message handling
types/                   Shared domain types
docs/                    Product, architecture, and domain docs
```
