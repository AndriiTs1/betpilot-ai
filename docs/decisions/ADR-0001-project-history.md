# ADR-0001: Project history — architectural evolution to date

Date: 2026-07-20

Status: Accepted

## Context

This project has gone through several fundamental pivots since its original conception, none of which were previously written down as a standalone decision record — they exist scattered across commit messages and README updates. This ADR exists specifically to consolidate that history into one place before any further architectural decisions are recorded going forward as their own ADRs.

## Problem

Anyone joining the project, or returning to it after time away, has no single place to understand why the system looks the way it does today rather than the way it was originally planned. `docs/MVP.md`, `docs/architecture/PROJECT_ARCHITECTURE.md`, and `docs/domain/DOMAIN_MODEL.md` still describe the *original* plan, not the current system, and are not kept in sync with it.

## Decision

Record the major architectural pivots to date, in chronological order. This is architectural history only — no implementation detail (file names, function names, schema fields) is the point of this record; see `README.md` for that.

### 1. Original concept: WhatsApp-based betting assistant

The project began as a WhatsApp-first design: a player would message a bookmaker's WhatsApp number, an AI would parse the bet from the message text, and an operator would review it in a dashboard. `docs/MVP.md`, `docs/architecture/PROJECT_ARCHITECTURE.md`, and `docs/domain/DOMAIN_MODEL.md` document this original plan and remain in the repo as historical planning material — intentionally not kept current.

### 2. Migration from WhatsApp to Telegram

The player-facing channel moved from WhatsApp to a Telegram Bot plus a Telegram Mini App. This changed both the identity/authentication model (Telegram's own signed session data replacing whatever WhatsApp-side scheme was originally planned) and the UI surface — a real in-Telegram web app instead of pure chat.

### 3. Migration from Wallet Balance to Credit Limit

The original domain model tracked a player's prepaid wallet balance that bets would draw down against. This was replaced with a credit-limit model: a player has a credit limit and a running current-credit figure, and a bet is accepted into an operator's queue with no upfront check — the operator's own confirm step is where the bet is checked against the player's remaining credit exposure. The wallet/transaction concepts remain in the schema as historical artifacts of the earlier design and are not used by any current application code.

### 4. Operator dashboard with credit-gated confirm/reject

A web dashboard was built for operators to see a queue of pending bets and confirm or reject each one against the player's credit limit, with the player notified back on Telegram. This established the pattern every later bet-creation path would reuse: **a bet is created as pending; only an explicit confirm step actually checks and enforces credit exposure.**

### 5. Bet → Bet + BetSelection (parlay/express groundwork)

The core bet model was extended, additively, to eventually support multi-leg (parlay/accumulator) bets without breaking any existing single-bet data or code — a bet gained a type (single vs. parlay), a combined-odds figure, and a relation to its individual legs. This was done as a read/display capability first — the Mini App can render an existing accumulator's legs — before any code existed that could actually *create* a multi-leg bet.

### 6. Mini App bet submission: preview → confirm architecture

Rather than a bet being created directly from whatever a player typed or uploaded, the system adopted a two-step **preview → confirm** pattern: a preview step parses the input and shows the player exactly what will be submitted — including live odds verification — before anything is written to the database; a separate, explicit confirm step is the only thing that actually creates a bet. This mirrors, on the player-facing side, the same "nothing happens until an explicit confirmation" discipline the operator dashboard already had.

### 7. Signed previewToken

To connect the preview step to the confirm step without persisting a database row in between — and without trusting the client to resend the preview's data unmodified — the preview step returns a short-lived, cryptographically signed token carrying everything the confirm step needs. The confirm step's only job is to verify that signature and act on the token's contents; it never trusts anything else the client claims about what the bet is.

### 8. Idempotent confirm

Because a confirm request could be retried or double-submitted — a slow network, a double-tap, two concurrent requests — the confirm step was made idempotent: each preview token carries a unique identifier enforced at the database level, so confirming the same token more than once, sequentially or concurrently, always results in exactly one bet, never a duplicate.

### 9. Screenshot support

Bet submission was extended from text-only to also accept a photo or screenshot of a bet slip, using the exact same preview → confirm architecture — a screenshot's preview step produces the same kind of signed token a text preview does, so the confirm step required no changes at all to support a second input method.

### 10. Claude Vision for screenshot parsing

Screenshot parsing uses a multimodal (vision-capable) AI model specifically for this purpose — not a separate OCR pipeline, and not the locally-hosted text-only model the system otherwise defaults to for cost/latency reasons, since that model has no vision capability. This was a deliberate simplicity choice: one AI provider, one extraction approach, reused conceptually across both text and image input.

### 11. Shared Preview UI

The player-facing preview screen — bet details plus odds-verification status — was built once and reused for both the text and screenshot submission flows, rather than building two visually and functionally identical screens. Both flows deliberately converge on an identical response shape from their respective preview endpoints specifically so this sharing is possible.

### 12. Parlay/express: detection without confirmation (current, in progress)

Screenshot parsing can detect and extract a multi-selection (parlay/accumulator) bet's individual legs. Confirming a parlay bet is intentionally **not yet supported** — the signed-token format and the confirm step's data model currently only represent a single selection. A detected parlay is shown to the player as a clear, safe failure rather than being silently confirmed as, or collapsed into, a single bet. Extending the token format and the confirm step to support multi-leg bets is future work and has not started.

### 13. Current production status

As of this ADR: the operator dashboard, the Telegram Mini App (balance / active bets / history), and single-selection bet submission — both text and screenshot — are live in production on a real database. Settlement (determining a bet's real-world result and paying out) is not built. Parlay confirmation is not built. The operator dashboard itself has no authentication — a known, previously documented gap, not something newly discovered by this ADR.

## Alternatives

Alternatives considered at each individual pivot point above are not reconstructed in detail here — this ADR exists to establish a historical baseline, not to relitigate decisions already made and shipped. Going forward, new ADRs should record alternatives at the time they're actually being weighed, while the reasoning is still fresh.

## Consequences

- The project's actual architecture has diverged substantially from the original planning documents. Those documents are historical, not current — `README.md` is the current source of truth for *what* the system does, and this ADR is the current source of truth for *why* it looks the way it does.
- The preview → confirm → signed-token pattern (items 6–8) is now the established shape for any future "player submits something that becomes a database row" flow. Screenshot support (item 9) already validated that this pattern generalizes to a second input method with no changes needed to the confirm step itself — any future third input method should be expected to fit the same shape.
- The credit-limit-at-confirm-time model (items 3–4) is now load-bearing for every bet-creation path: nothing outside the operator's explicit confirm action ever checks or moves a player's credit.

## Future work

- Parlay/express confirmation (item 12) needs its own ADR once the token-format and data-model questions it raises are actually decided, not just identified.
- Settlement (determining a bet's real-world result and paying out) has no architecture decided yet; it will need its own ADR before implementation starts.
- Operator dashboard authentication is a known, undecided gap — worth its own ADR before it's built, since the decision will affect how every other operator-facing route should eventually be gated.
