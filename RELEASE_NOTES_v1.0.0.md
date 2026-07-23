# BetPilot AI v1.0.0

## Overview

BetPilot AI is an AI-powered sports betting operations platform. A player submits a bet through a Telegram Mini App — as free text or a coupon screenshot — an LLM extracts a structured bet (single selection, or a 2–10 leg accumulator), the odds are checked against a live sportsbook feed, and an operator reviews the request in a web dashboard and confirms or rejects it against the player's credit limit. This is the first public release.

## Major features

### SINGLE and EXPRESS bet support

A player can submit either a single-selection bet or a 2–10 leg EXPRESS (accumulator). Both types are parsed, odds-verified per leg, and stored through the same schema (`Bet` + `BetSelection`), and both render through one shared **Bet UI Design System** (`components/bets/SelectionRow.tsx` / `SelectionList.tsx`) across the Mini App and the operator dashboard — full, uncollapsed selection disclosure wherever a decision is being made (Preview, Confirmation Ticket, operator Pending Queue), and a compact "first 3 + N more" summary in review contexts (Active Bets, History).

### AI text and screenshot parsing

One shared parser (`parseBetSlipMessage`) extracts a bet slip from either a player-typed message or OCR-transcribed screenshot text. Screenshots go through a dedicated, provider-agnostic OCR step first (Claude-based today, swappable behind an `OcrProvider` interface), then the same parsing and odds-verification logic the text flow uses. Dual AI provider support (Claude in production; local Ollama for development, text-only).

### Odds verification

Every selection is checked against The Odds API's live market at preview time — event/market/selection match and price-tolerance are tracked as independent verdicts, surfaced to both the player (before confirming) and the operator (before approving) as a per-selection status, never silently assumed.

### Operator workflow

- **Pending Queue** — the operator's one manual decision point: Confirm or Reject a new request. Every selection of an EXPRESS bet is always shown in full before the buttons; nothing can be approved from a collapsed summary.
- **Active Bets / History** — read-only. Won/Lost/Void are lifecycle status badges, not operator-clickable actions.
- **Credit-limit enforcement** — a bet can only be confirmed if the player's other confirmed exposure plus this bet's stake stays within their credit limit.

### Telegram Mini App

Player-facing balance, active bets, history, and bet submission (text or screenshot), authenticated by Telegram's own signed `initData` (HMAC-verified server-side, 5-minute freshness window). A closed-demo onboarding flow lets an operator invite a player by Telegram username before they've ever opened the bot.

### Operator authentication

Real password-based login (`scrypt` hashing, database-backed sessions, `HttpOnly`/`Secure`/`SameSite=Lax` cookies) protects the entire operator dashboard and its API. A separate legacy `OPERATOR_SECRET` bearer token continues to gate the lower-level internal API as an additional, still-active layer.

## Security improvements

- **Baseline HTTP security headers** — `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` — applied to the operator dashboard and its API surface, closing a clickjacking exposure on financial actions (Confirm/Reject/Settle). Deliberately not applied to the Telegram Mini App, which is legitimately loaded inside Telegram Web's own iframe.
- **Credit-limit concurrency protection** — see "Race-condition protection" below.

## Race-condition protection

Two confirms for the same bet, and two confirms for different bets belonging to the same player, are both now safe under real concurrency:

- **Same bet, confirmed twice concurrently** — an atomic conditional status update ensures exactly one request succeeds; the other is rejected with a clear "no longer pending" response. (Pre-existing protection, re-verified with new tests.)
- **Two different bets, same player, confirmed concurrently** — a `SELECT ... FOR UPDATE` lock on the player's row, held for the duration of the confirm transaction, guarantees the second request always sees the first request's already-committed exposure before deciding. Previously, both requests could read the same pre-commit exposure snapshot and both be approved even though their combined stake exceeded the player's credit limit; now the player's combined confirmed exposure can never exceed their credit limit. Verified with concurrency tests that reproduce the original race when the lock is removed.

## Testing summary

**505 automated tests** (`node --test`, no DOM-rendering test infra — component logic is tested via exported pure functions, not rendered trees), including:

- Operator authentication: password hashing, session lifecycle, login rate limiting, route protection
- Bet lifecycle: confirm (including the new concurrency tests), reject, settlement (win/loss/void math, idempotency, races)
- AI parsing, OCR, and odds verification
- Preview-token signing/verification and idempotent bet creation for both SINGLE and EXPRESS

## Known limitations (deferred to V2)

- **Automatic settlement is not implemented.** The settlement engine (`lib/bets/settleBet.ts`) can grade a bet and update credit/ledger, but nothing ingests real match results — settlement today only happens via a direct, manually-triggered API call, with no operator dashboard UI for it.
- **No rate limiting** on the Mini App's bet preview/confirm endpoints.
- **Screenshot uploads are not persisted** — an operator cannot review the original image behind a confirmed bet after the fact.
- **No multi-operator scoping** — the schema supports multiple operators, but the dashboard and its API currently read across all of them.
- Several small dead-code items (`types/bet.ts`, `types/player.ts`, the unused `Wallet` model and its helpers) remain from earlier design iterations and are scheduled for removal in a future cleanup pass.

These are intentionally out of scope for this release and do not block it — see `README.md`'s "What's not done yet" section for the complete, current list.
