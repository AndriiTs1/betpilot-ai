# Telegram Mini App

## Purpose

The player-facing side of BetPilot AI. A player opens the Mini App from the bot, submits a bet as text or a screenshot, and tracks its status through confirmation and settlement — no deposits, withdrawals, or real-money payout rails; balances are tracked against a credit-limit model (`currentCredit`), which settlement updates with the bet's result.

## Player flow

```
Telegram bot
→ Open Mini App
→ Submit bet (text or screenshot)
→ Preview (AI/OCR-parsed, odds-checked)
→ Confirm
→ Pending
→ Operator decision
→ Active / History
```

## Screens

Four tabs, bottom navigation:

- **Bet** — compose and submit a new bet (text or screenshot)
- **Active** — bets not yet settled (`PENDING`, `CONFIRMED`)
- **History** — settled/closed bets (`REJECTED`, `SETTLED_WIN`, `SETTLED_LOSS`, `VOID`)
- **Balance** — credit limit and current credit summary

## Bet submission

- **Text** — describe the bet in a free-text message
- **Screenshot** — upload or photograph a bet-slip image
- **SINGLE** — one selection
- **EXPRESS** — 2–10 selections (`MIN_EXPRESS_SELECTIONS` / `MAX_EXPRESS_SELECTIONS`, `lib/bets/betSlipRules.ts`)

## AI and OCR

- Text messages are parsed by `parseBetSlipMessage()` (`lib/ai/betParser.ts`).
- A screenshot goes through OCR first (`lib/ocr/`) to produce plain text.
- That OCR text is parsed by the **same** `parseBetSlipMessage()` — there is no separate image-to-structured-data path.
- **Claude** runs in production for both text parsing and OCR.
- **Ollama** is a local, text-only dev fallback — no OCR support, no EXPRESS detection.

## Preview and confirm

- Preview performs zero `Bet` writes — it only parses, verifies odds, and returns a signed `previewToken`.
- `previewToken` is short-lived (180s) and HMAC-signed (`lib/betPreview/previewToken.ts`) — it carries the bet content itself, so confirm never trusts client-supplied bet data.
- Confirm creates a `PENDING` `Bet` (+ `BetSelection` rows for EXPRESS).
- Screenshot and text submissions share the same confirm endpoint — there is no separate screenshot-confirm route.
- `Bet.previewId` is a unique constraint, so confirming the same token twice — sequentially or concurrently — is idempotent and returns the same `Bet`.

## Odds verification

- Each selection is checked against a live odds provider before preview is returned.
- **The Odds API** is the main runtime provider today.
- **Sportmonks** exists as a partial, feature-flagged path (football, limited leagues, 1X2, SINGLE only) — off by default.

See `docs/ODDS_SUPPORT_MATRIX.md` and `docs/ODDS_PROVIDER_DESIGN.md` for provider/market coverage details.

## Authentication

Every Mini App request is authenticated via Telegram's signed `initData` (`Authorization: tma <initData>`, verified in `lib/telegram/verifyInitData.ts`). The player is resolved server-side from the verified Telegram identity — the client never asserts its own player ID.

## Bet lifecycle

`PENDING → CONFIRMED → SETTLED_WIN / SETTLED_LOSS / VOID`, or `PENDING → REJECTED`. These are the only statuses (`BetStatus` in `prisma/schema.prisma`).

## Notifications

Bet-status Telegram notifications (confirmed / rejected / settled) exist in code (`lib/telegram/betStatusNotifications.ts`) and are wired into the confirm/reject/settle routes, but are gated by `BET_TELEGRAM_NOTIFICATIONS_ENABLED` — disabled by default (any value other than the literal `"true"` keeps them off).

## Current limitations

- Screenshot images are never persisted — they exist only in memory for the request.
- Mini App rate limiting is in-memory and per server instance, not distributed.
- No automatic result ingestion — settlement is currently triggered manually by the operator.
- Odds provider/sport coverage is limited to football (1X2 and totals via The Odds API); other sports and markets are not yet supported end-to-end.
