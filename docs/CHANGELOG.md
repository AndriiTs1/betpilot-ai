# Changelog

A chronological log of completed development stages. See `docs/decisions/` for the architectural reasoning behind the significant pivots — this file is "what shipped and when," not "why."

## Stage 1–2B

Initial Prisma schema (`Bet`, `BetSelection`, `BetType`, `totalOdds`), the credit-limit risk model (`Player.creditLimit`/`currentCredit`), and the operator dashboard's confirm/reject-against-credit-limit flow.

## Stage 3D

Mini App renders parlay/accumulator bets — selections shown across Active Bets, History, and the Bet tab's recent-activity list.

## Stage 4.0A

Read-only audit of the (at the time, orphaned) bet-submission pipeline and preview/confirm security design.

## Stage 4.0B

Fixed odds-verification semantics: `matched` (event/market/selection found) and `withinTolerance` (submitted odds close enough to the source price) split into two independent verdicts instead of one always-false flag.

## Stage 4.1 / 4.1A

Text bet preview endpoint — parses a free-text message, verifies odds, returns a preview. No database writes. Error responses sanitized to never leak parser/provider internals to the client.

## Stage 4.2 / 4.2A

Mini App text-bet input UI — message entry, preview card, odds-verification status. Currency labels removed from the preview display (the app shows plain numbers, no currency).

## Stage 4.3

Signed, short-lived `previewToken` — carries a preview's content between the preview and (not yet built) confirm step without a database row in between.

## Stage 4.4A

Idempotent bet confirmation (backend): confirming the same `previewToken` more than once, sequentially or concurrently, creates exactly one `Bet`, enforced at the database level.

## Stage 4.4B

Bet confirmation flow (UI): a confirm button on the preview screen, loading/error states, and a success screen for the newly created bet.

## UI polish

Hero banner sizing/spacing on the Mini App's welcome screen adjusted for mobile and desktop viewports.

## Stage 4.5A

Screenshot bet submission — read-only audit and architecture decision. Confirmed the existing confirm endpoint and signed-token format are safely reusable for a single-selection screenshot bet without any backend changes.

## Stage 4.5B

Screenshot upload endpoint — server-side validation only (Telegram auth, MIME allow-list, size limit, no AI call yet, no database writes).

## Stage 4.5C

Claude Vision integrated into the screenshot endpoint: multimodal parsing, magic-byte file-signature validation, single-vs-parlay detection, and the same odds-verification + signed-token response the text flow already returns.

## Stage 4.5D

Screenshot upload UI (gallery + camera capture, preview, confirm) — reuses the same preview screen and confirm flow the text-bet UI already has.

## Stage 4.5E

Production review of the screenshot recognition pipeline: architecture summary, prompt/validation weaknesses, bookmaker-specific considerations, and a prioritized list of recommended improvements. Analysis only — no code changed.

## Documentation

`README.md` updated to reflect the shipped text and screenshot bet-submission flow (previously described as unbuilt); `docs/decisions/` (Architecture Decision Records) and this changelog introduced.
