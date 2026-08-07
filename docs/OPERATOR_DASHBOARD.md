# Operator Dashboard

## Purpose

The operator-facing side of BetPilot AI. An operator reviews bets submitted through the Mini App, confirms or rejects them against the player's credit limit, and settles confirmed bets once a result is known.

## Authentication

Password login (`scrypt` hashing, `node:crypto`) backed by database sessions: a random session token lives only in an `HttpOnly`/`Secure`(prod)/`SameSite=Lax` cookie, and the database stores only its hash. `/` and every `/api/dashboard/*` route require a valid session. See `docs/OPERATOR_AUTH_IMPLEMENTATION.md` for the full implementation details.

## Dashboard overview

Landing view: active players, available credit, and pending bet count, backed by `GET /api/dashboard/overview`.

## Players

Per-player view of `creditLimit`, `currentCredit`, exposure, and bet history (Active / History tabs).

## Pending Queue

Every `PENDING` bet, with all selections shown in full — an EXPRESS bet is never reviewable from a collapsed summary.

## Confirm / Reject

- **Confirm** runs a credit check (remaining credit vs. the bet's stake) and only then flips the bet to `CONFIRMED`.
- **Reject** moves the bet to `REJECTED` — no credit check needed.
- Both are the operator's only manual action on a `PENDING` bet.

## Credit and exposure

- `Player.creditLimit` / `Player.currentCredit` (negative = player owes).
- Exposure = sum of stakes across the player's other `CONFIRMED` bets.
- Available credit = credit limit (reduced by any negative current credit) minus exposure; confirm is rejected (`409`) if the new bet's stake exceeds it.

## Concurrency protection

- **Same-bet protection**: confirm/reject use an atomic conditional update (`where: { status: "PENDING" }`) — a second concurrent confirm/reject of the same bet fails cleanly instead of double-processing it.
- **Different-bets/same-player protection**: confirm locks the player's row (`SELECT ... FOR UPDATE`) for the duration of the credit check + status update, closing a write-skew race where two different pending bets for the same player could otherwise both pass a stale exposure check.
- The player-row lock is applied in the operator confirm flow.

## Settlement

Settlement has both a backend and a dashboard UI:

- The Players view's **Active Bets** tab has **Win / Lose / Void** buttons on each `CONFIRMED` bet, calling the settle endpoint.
- Settling a bet writes a `Transaction`, updates the player's `currentCredit`, and (if enabled) notifies the player.
- Settlement is currently decided and triggered manually by the operator; no real match-result ingestion exists yet.

## Security

- Operator sessions are the primary guard on the dashboard and its API routes.
- The lower-level internal `/api/bets/*` API is separately protected by a static `OPERATOR_SECRET` bearer token, layered underneath the dashboard's session-based proxy routes.
- Standard security headers (`X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`) apply to the operator surface.
- Telegram Mini App authentication (`initData`) is entirely separate from operator sessions — no shared cookie, table, or verification path.

## Current limitations

- No automatic results provider — settlement is manual only.
- No dedicated settlement exception/review queue for cases automation can't resolve later.
- No multi-operator scoping — `/api/dashboard/*` reads across all operators, not just the logged-in one.
