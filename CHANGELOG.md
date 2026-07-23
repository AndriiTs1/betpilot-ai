# Changelog

All notable changes to BetPilot AI are documented here, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

This file summarizes what shipped in each version, for anyone consuming the project as a whole. It is distinct from `docs/CHANGELOG.md`, which is a chronological, stage-by-stage log of individual development steps — this file only records versioned releases.

## [1.0.0] — First public release

### Added

- Player-facing Telegram Mini App: balance, active bets, history, and bet submission, authenticated by Telegram's signed `initData`.
- SINGLE and multi-selection EXPRESS (2–10 legs) bet support, sharing one Bet UI Design System (`components/bets/SelectionRow.tsx` / `SelectionList.tsx`) across the Mini App and the operator dashboard.
- AI-powered bet parsing from free text or a coupon screenshot, through one shared parser (`parseBetSlipMessage`) fed by either a player-typed message or OCR-transcribed screenshot text (provider-agnostic OCR abstraction, Claude-backed today).
- Live per-selection odds verification against The Odds API.
- Operator dashboard: pending-bet queue (Confirm/Reject, full selection disclosure before any decision), read-only Active Bets and History, per-player credit/exposure overview.
- Credit-limit risk model: a bet can only be confirmed if it fits within the player's remaining credit after their other confirmed exposure.
- Settlement engine (`lib/bets/settleBet.ts`): grades a confirmed bet WON/LOST/VOID, updates the player's credit, records a ledger transaction, and notifies the player on Telegram. Reachable only via a direct authenticated API call in this release — no dashboard UI (see "Known limitations" in `RELEASE_NOTES_v1.0.0.md`).
- Operator authentication: password login (`scrypt` hashing), database-backed sessions, and route protection across the entire dashboard and its API.
- Closed-demo player onboarding by Telegram username, with one-time ID binding on first `/start`.
- Dedicated sport and Express icons shared between the Mini App and the operator dashboard.
- 505 automated tests covering authentication, the bet lifecycle, settlement, AI parsing, OCR, and odds verification.

### Fixed

- **Credit-limit race condition.** Concurrent confirmation of two different pending bets for the same player could previously let their combined exposure exceed the player's credit limit. Fixed with a `SELECT ... FOR UPDATE` row lock on the player, held for the duration of the confirm transaction. See `RELEASE_NOTES_v1.0.0.md` → "Race-condition protection" for the full explanation.

### Security

- Baseline HTTP security headers (`X-Frame-Options`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`) applied to the operator dashboard and its API surface, closing a clickjacking exposure on financial actions. Not applied to the Telegram Mini App, which is legitimately framed by Telegram Web.
