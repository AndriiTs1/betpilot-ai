# Operator Authentication Architecture Audit — Stage 5.0A

Analysis-only. No production code, schema, or dependencies were changed while producing this document. Every claim below is backed by a specific file read during this audit — file paths are cited throughout so each finding can be re-verified directly against the code.

## 1. Executive Summary

The operator Dashboard (`app/page.tsx` and everything under `app/api/dashboard/*`) has **no authentication at all** today. Two of its six API routes (`GET /api/dashboard/overview`, `GET /api/dashboard/players`) query Prisma directly with zero access check. The other four (`bets/pending`, `bets/history`, `bets/[id]/confirm`, `bets/[id]/reject`) proxy to a secret-protected internal API, but the proxy always attaches the real secret server-side regardless of who called it — so from a browser's perspective, all six routes are open to anyone on the internet who knows the URL. This is not a new finding: `README.md` already documents it accurately (lines 94, 115), and this audit independently confirms it by reading every relevant file.

An `Operator` model already exists in `prisma/schema.prisma`, but it has no password or credential field — it's a pure data-ownership record (`id`, `name`, `phone`, `createdAt`), not an identity used for login. The only thing currently gating operator *actions* is a single static shared secret (`OPERATOR_SECRET`) compared with `timingSafeEqual`, checked on 4 of 10 operator-relevant routes, and never checked on the routes a browser actually calls.

There is no session mechanism anywhere in this codebase — no cookies, no `next/headers` cookie usage, no JWT/session library — for either players or operators. Player identity is instead re-verified per-request from signed Telegram `initData`, which is architecturally sound and unrelated to the operator gap.

**Recommendation** (detailed in §5–6): build a minimal internal operator login on top of the existing `Operator` model — hashed passwords (Node's built-in `crypto.scrypt`, no new dependency), an `HttpOnly`/`Secure`/`SameSite=Lax` session cookie, a new `OperatorSession` table for revocability, and a `middleware.ts` (this project's first) gating `/` and `/api/dashboard/*`. This is Option D from §5, and it is functionally the minimal, in-character instantiation of Option A — not a fifth, different design.

## 2. Current Authentication State

Two entirely separate, non-overlapping authentication domains exist in the codebase today, plus a third mechanism for the Telegram bot webhook:

| Domain | Mechanism | Where | Stateful? |
|---|---|---|---|
| Telegram Mini App (players) | HMAC-SHA256 verification of Telegram's signed `initData`, 5-minute TTL | `lib/telegram/verifyInitData.ts`, called from every `/api/miniapp/*` route | No — re-verified every request |
| Telegram bot webhook | Static secret compared via `timingSafeEqual` against the `X-Telegram-Bot-Api-Secret-Token` header | `lib/auth/telegramWebhookAuth.ts`, called from `app/api/webhooks/telegram/route.ts` | No |
| Operator API (`/api/bets/*` only) | Static shared secret (`OPERATOR_SECRET`) as a Bearer token, compared via `timingSafeEqual` | `lib/auth/operatorAuth.ts`, called from `app/api/bets/{pending,history,[id]/confirm,[id]/reject}/route.ts` | No |
| Dashboard page (`/`) and `/api/dashboard/*` | **None** | — | — |

`app/page.tsx` is a Server Component with no auth check, no redirect, no login gate — it renders `DashboardOverview`, `BetQueue`, `BetHistory`, and `PlayerList` unconditionally for anyone who requests the URL. All four of those are `"use client"` components (confirmed via grep) that call `fetch()` against `/api/dashboard/*` with no `Authorization` header — they *can't* send one, since the browser never has `OPERATOR_SECRET`.

The `/api/dashboard/*` routes fall into two groups:

- **`overview` and `players`** (`app/api/dashboard/overview/route.ts`, `app/api/dashboard/players/route.ts`) call `prisma.*.findMany`/`aggregate` directly. No import of `isOperatorAuthorized`, no check of any kind.
- **`bets/pending`, `bets/history`, `bets/[id]/confirm`, `bets/[id]/reject`** are one-line proxies (`lib/dashboard/operatorApiProxy.ts` → `proxyToOperatorApi`) that forward the incoming request to the real, secret-protected `/api/bets/*` route — but the proxy itself attaches `Authorization: Bearer ${process.env.OPERATOR_SECRET}` unconditionally, server-side, regardless of what (if anything) the original caller sent. The secret never reaches the browser (good — confirmed no `NEXT_PUBLIC_*` vars exist anywhere and `OPERATOR_SECRET` is referenced in exactly two server-only files), but the *effect* is that the proxy route itself checks nothing about the caller before doing this.

Net result: every one of the six `/api/dashboard/*` routes returns real operator data, or performs a real confirm/reject mutation, for a completely anonymous request.

## 3. Security Findings

Answering the ten audit questions directly:

**1. Which Dashboard pages are currently public?**
All of them — there is only one Dashboard page, `/` (`app/page.tsx`), and it is fully public. There is no separate `/dashboard` route group; the Dashboard *is* the app's root route.

**2. Which operator API endpoints are currently callable without authentication?**
All six under `/api/dashboard/*`:
`GET overview`, `GET players`, `GET bets/pending`, `GET bets/history`, `POST bets/[id]/confirm`, `POST bets/[id]/reject`.
The four underlying `/api/bets/*` routes are protected by `OPERATOR_SECRET`, but nothing outside the dashboard proxy calls them directly today, so that protection currently only matters if someone bypasses the dashboard's own (nonexistent) front door and hits `/api/bets/*` directly without the secret — which correctly fails.

**3. Is authorization enforced only in the UI or also on the server?**
Neither, for the six open routes above — there's no UI-level redirect/gate (no login page exists at all) and no server-side check either. For the four `/api/bets/*` routes, enforcement is server-side only (a header check in the route handler) — there's no corresponding UI concept of "logged in" to enforce anything client-side even if it wanted to.

**4. Does an Operator model already exist?**
Yes (`prisma/schema.prisma:41-48`) — `id`, `name`, `phone` (unique), `createdAt`, and a `players Player[]` relation. It's a multi-tenancy/ownership record, not an authentication identity: no password field, no session relation, nothing that represents "logged in as this operator."

**5. Are operator passwords or credentials stored anywhere?**
No. The only credential-shaped thing in the system is `OPERATOR_SECRET`, a single static string in the environment, shared by whoever knows it, compared with constant-time equality. It is not a password (not per-person, not hashed, not stored in the DB, not rotatable without an env change + redeploy).

**6. Is there any existing session mechanism?**
No. A repository-wide search for `cookies()`, `next/headers` cookie imports, `Set-Cookie`, `localStorage`, and `sessionStorage` across `app/`, `components/`, and `lib/` returned zero matches. No session library (`iron-session`, `next-auth`, `jose`, `jsonwebtoken`) appears in `package.json`. Every existing "auth" check in this app is a fully stateless, per-request verification — nothing persists a login.

**7. Can Telegram player authentication accidentally grant access to operator functionality?**
No direct leakage path exists — the two mechanisms share no code, no secret material, and (since neither has a session) no session store to cross-contaminate. A verified `initData` header would simply be ignored by `isOperatorAuthorized` (which only looks at a Bearer token) and vice versa. The real risk isn't cross-domain leakage between these two checks — it's that operator functionality mostly doesn't check *anything*, so the question of "could Telegram auth grant operator access" is moot next to "operator access requires no auth at all" for two-thirds of the surface.

**8. Are there IDOR risks where a caller can access another player's data?**
On the **player side**: no. Every `/api/miniapp/*` route derives the player identity itself, server-side, from verified `initData` → `telegramId` → `Player.findUnique` (`app/api/miniapp/me/route.ts:39-41`). The text-confirm route trusts a signed, HMAC-protected `previewToken` for the player/bet identity, not a client-supplied ID. No route accepts a raw player ID from the client and trusts it for authorization.

On the **operator side**: the shape is broader than classic IDOR — it isn't "caller A can see player B's data by guessing an ID," it's "any caller, with no identity at all, sees every player's data unconditionally" (`app/api/dashboard/players/route.ts` returns `name`, `telegramId`, `phoneNumber`, `creditLimit`, `currentCredit`, and full recent bet history for every player in the database, to anyone).

There is also a **latent, currently-masked cross-operator IDOR**: `Player.operatorId` exists in the schema (multi-tenancy groundwork), but no query anywhere (`/api/dashboard/players`, `/api/bets/pending`, `/api/bets/history`, etc.) filters by it — every query is global across all operators. Today this is invisible because the deployment has one operator in practice. The moment a second `Operator` row exists, without a query-scoping fix, Operator A would see Operator B's players. This is a data-scoping bug distinct from the authentication gap, but the two are related — this audit flags it as a **near-term follow-up once real operator identity exists**, not something to silently fold into the auth stages below.

**9. Are secrets or privileged identifiers exposed to client components?**
No. Confirmed via `grep -rn "NEXT_PUBLIC_"` (zero matches) and confirmed `OPERATOR_SECRET` is referenced in exactly two files, both server-only (`lib/auth/operatorAuth.ts`, `lib/dashboard/operatorApiProxy.ts`), never imported by a `"use client"` file. This part of the design is already correct — the vulnerability is a missing caller check, not a leaked secret.

**10. Which routes must be protected immediately?**
`/` and all six `/api/dashboard/*` routes — see the full matrix in §4.

## 4. Route Protection Matrix

| Route / group | Current access | Required access | Protection mechanism (proposed) | Server-side check location |
|---|---|---|---|---|
| `GET /` (Dashboard page) | Public | Operator session | Redirect to `/login` if no valid session | `middleware.ts` (new) |
| `GET /login` (new) | N/A | Public (must work while logged out) | None — intentionally open | — |
| `POST /api/auth/login` (new) | N/A | Public, rate-limited | Brute-force lockout (Stage 5.0E) | Route handler |
| `POST /api/auth/logout` (new) | N/A | Requires a session to invalidate; safe no-op without one | Session lookup + revoke | Route handler |
| `GET /api/dashboard/overview` | **Public — no check at all** | Operator session | Session-validating helper | Route handler |
| `GET /api/dashboard/players` | **Public — no check at all** | Operator session | Session-validating helper | Route handler |
| `GET /api/dashboard/bets/pending` | **Public** (proxy always injects the real secret) | Operator session | Session check added before proxying | Route handler (proxy layer) |
| `GET /api/dashboard/bets/history` | **Public** (same proxy pattern) | Operator session | Same | Route handler |
| `POST /api/dashboard/bets/[id]/confirm` | **Public** (same proxy pattern) | Operator session | Same | Route handler |
| `POST /api/dashboard/bets/[id]/reject` | **Public** (same proxy pattern) | Operator session | Same | Route handler |
| `GET /api/bets/pending` | Protected (`OPERATOR_SECRET` Bearer) | Unchanged, or retire once session auth lands upstream | `isOperatorAuthorized` (existing) | Route handler (unchanged) |
| `GET /api/bets/history` | Protected | Unchanged | Existing | Unchanged |
| `POST /api/bets/[id]/confirm` | Protected | Unchanged | Existing | Unchanged |
| `POST /api/bets/[id]/reject` | Protected | Unchanged | Existing | Unchanged |
| Player management endpoints | `GET /api/dashboard/players` *is* the only player-listing endpoint today; no separate create/edit-player API exists | Operator session (see row above) | — | — |
| Settlement endpoints | None exist yet (confirmed: not built, per `ADR-0001` item 13) | N/A — protect identically when built | — | — |
| `GET /miniapp` (Mini App shell) | Public page shell; all real data is gated per-request | Unchanged — this is correct as-is | `verifyInitData` per API call | `/api/miniapp/*` route handlers (unchanged) |
| `GET /api/miniapp/me` | Protected (`verifyInitData`) | Unchanged | Existing | Unchanged |
| `POST /api/miniapp/bets/text/preview` | Protected | Unchanged | Existing | Unchanged |
| `POST /api/miniapp/bets/text/confirm` | Protected | Unchanged | Existing | Unchanged |
| `POST /api/miniapp/bets/screenshot/preview` | Protected | Unchanged | Existing | Unchanged |
| `POST /api/webhooks/telegram` | Protected (`X-Telegram-Bot-Api-Secret-Token`) | Unchanged | Existing | Unchanged |

## 5. Authentication Options

Evaluated only against this project's actual shape: a handful of manually-provisioned, trusted operators (not self-service signup, not a large org with existing SSO), deployed on Vercel, using Prisma/Postgres, App Router.

### Option A — Email/password with secure server-side sessions
- **Security**: high, if built correctly (hashed passwords, `HttpOnly` cookie, server-validated session).
- **Complexity**: medium — password hashing, a session store, login/logout routes, route gating.
- **Dependency cost**: can be zero new dependencies (Node's built-in `crypto.scrypt` for hashing; a DB table for sessions) or moderate if `bcrypt`/`argon2` packages are used instead (native bindings, occasionally awkward in serverless bundling).
- **Suitability for a small private team**: good — direct mapping of "each operator has a login."
- **Vercel**: full compatibility — cookies and serverless functions work natively; no filesystem session state needed if DB-backed.
- **Prisma**: additive migration only (`Operator.passwordHash` + a new `OperatorSession` table).
- **App Router**: full compatibility — Route Handlers and Server Components both read cookies via `next/headers`.
- **Future multi-operator**: excellent — this *is* per-operator identity, and it's what finally makes the existing `operatorId` scoping meaningful.

### Option B — Magic-link authentication
- **Security**: reasonable (no password to steal or brute-force), but shifts trust entirely to email delivery/possession, and this project has **no email-sending infrastructure today at all**.
- **Complexity**: medium-high — needs a transactional email provider integration (new external dependency + API key + cost), token generation/expiry, **and still needs a session mechanism afterward** — a magic link only replaces the credential-entry step, it doesn't remove the need for everything Option A already requires.
- **Dependency cost**: adds an external email service dependency purely for this, plus deliverability/retry concerns — meaningfully higher than A for a 1–2 operator team.
- **Suitability**: overkill — solves a "forgot password" UX problem that barely matters for a couple of known operators who can be handed credentials directly.
- **Vercel/Prisma/App Router**: all fine technically, but this option doesn't reduce the implementation surface versus A — it adds an external service on top of it.
- **Future multi-operator**: fine, but no better than A.

### Option C — External provider / Auth.js-compatible OAuth
- **Security**: potentially very high if backed by a real, hardened IdP (Google Workspace, GitHub, etc.); Auth.js itself is well-maintained.
- **Complexity**: highest of the four here — registering an OAuth app, configuring Auth.js's adapter and its own schema shape (`Account`/`Session`/`VerificationToken`, which don't map cleanly onto this project's minimal `Operator` model without extra work), managing callback URLs per environment.
- **Dependency cost**: highest — a new heavy dependency plus its own DB schema additions plus reliance on a third-party IdP's availability.
- **Suitability for a small private team**: poor fit here — this shines when you need federated sign-in for many external users; for a few manually-provisioned operators it's substantial machinery for no real benefit.
- **Vercel**: fine (Auth.js is part of Vercel's own ecosystem) — the one place this option looks attractive on paper.
- **Prisma**: fine, but requires adopting Auth.js's schema conventions or writing a custom adapter around the existing `Operator` model.
- **App Router**: fine.
- **Future multi-operator**: fine, but so is A, at a fraction of the setup cost.

### Option D — Minimal internal operator login backed by the existing Operator model
This is, functionally, **Option A implemented directly on top of the schema that already exists**, not a distinct fifth design — presented separately here only because the prompt asked for it as its own option, and because "reuse `Operator`, don't add a parallel identity system" is itself a decision worth stating explicitly.
- **Security**: high, built with the same rigor as A.
- **Complexity**: lowest — extends a model that already exists and already has the right relation shape (`Operator.players`).
- **Dependency cost**: lowest — buildable with zero new dependencies (`node:crypto`'s `scrypt`, no email provider, no OAuth app).
- **Suitability**: best fit for the actual need.
- **Vercel/Prisma/App Router**: most natural fit of all four — this project already has two other "compare a shared secret server-side" mechanisms (`OPERATOR_SECRET`, `TELEGRAM_WEBHOOK_SECRET`); a real per-operator credential system is an in-character progression of a pattern this codebase already uses, not a foreign one.
- **Future multi-operator**: excellent — identical ceiling to Option A, because it is Option A.

**Recommendation: Option D**, built with Option A's security properties. B and C both solve problems this project doesn't have (self-service password recovery at scale, federated identity for many external users) at a dependency and complexity cost this project's actual size doesn't justify.

## 6. Recommended Architecture

- **Password hashing**: `node:crypto`'s `scrypt` (built into Node, already available, zero new dependency) — store `salt` + `hash`, not a third-party package, unless the implementation stage finds a concrete reason to prefer `bcrypt`/`argon2`.
- **Session cookie**: `HttpOnly`, `Secure` in any deployed environment (Vercel always serves HTTPS — `Secure` should be unconditional outside local `http://localhost` dev), `SameSite=Lax` as the standard, safe default (`Strict` is also viable given operators navigate directly rather than arriving via an external link, and can be decided in 5.0B).
- **Session expiration**: a short absolute TTL (proposed ~12 hours) — short enough to bound the damage of a stolen cookie, long enough not to interrupt a working shift. Final number to be confirmed in 5.0B, not fixed by this audit.
- **Server-side session validation**: every request re-validates the session token against the database — the cookie's mere presence is never trusted, mirroring the discipline already used for `initData`/`OPERATOR_SECRET`/webhook-secret verification elsewhere in this codebase.
- **Route protection**: a new `middleware.ts` (this project has none today) gates `/` and any future `/dashboard/*` pages; a shared server-side helper (parallel in shape to today's `isOperatorAuthorized`) gates every `/api/dashboard/*` route, including the two that currently have no check at all.
- **API authorization**: applied uniformly to all six `/api/dashboard/*` routes — no more "some routes proxy through a secret, some check nothing" split.
- **Logout**: a `POST /api/auth/logout` that deletes (or marks `revokedAt` on) the session row server-side and clears the cookie — logout must invalidate server-side state, not just clear the client's cookie.
- **Brute-force protection**: tracked in the database (or an external store like Vercel KV/Upstash), **not in-memory** — Vercel serverless functions don't reliably share memory across invocations/regions, so an in-memory counter would be silently ineffective. Proposed: a small failed-attempt counter + lockout window on `Operator` (or a dedicated table), detailed in Stage 5.0E.
- **Generic login errors**: "Invalid email or password" (or "Invalid phone or password," see below) for every failure case — unknown identifier and wrong password must be indistinguishable, including in response timing, matching the constant-time-comparison discipline this codebase already applies elsewhere.
- **No credentials in localStorage**: the session lives only in the `HttpOnly` cookie; nothing is duplicated into `localStorage`/`sessionStorage`, consistent with this project's existing precedent of never persisting tokens/`initData` client-side beyond memory.
- **No operator secret exposed to the browser**: continues the already-correct existing practice.
- **Clear Player/Operator separation**: a distinct cookie name, a distinct verification helper, no shared session store between the two domains. `verifyInitData` and the Mini App flow are not touched by any of this work.

**Database-backed vs. signed-cookie sessions**: **recommend database-backed** (an `OperatorSession` table; the cookie holds only an opaque session ID). A signed/JWT cookie avoids one DB read per request, but cannot be revoked before its natural expiry without reintroducing a server-side denylist — which defeats the purpose. For an app where an operator action moves real credit exposure, immediate revocability (an operator leaves, a laptop is lost) matters more than saving one indexed query. This project's Mini App flow already does a comparable per-request cryptographic check (`verifyInitData`) as a matter of course, so a per-request session-table lookup is not a new category of cost.

**Session revocation**: deleting the session row (or setting `revokedAt`) makes it fail validation on the very next request. Self-logout is MVP; an admin-initiated "revoke all sessions for operator X" falls out of the same design for free later but is not required for MVP.

**First operator account creation**: a one-time, manually-run script (e.g. `scripts/create-operator.ts`, executed locally with production `DATABASE_URL` access) that hashes a provided password and inserts the `Operator` row directly — never an HTTP-exposed "register" endpoint. This adds no new internet-facing attack surface: running it already requires the same DB access level the project owner already has.

**Password reset for MVP**: **not required**. This project has no email-sending infrastructure today, and adding one solely for password reset contradicts "smallest secure solution appropriate for BetPilot AI." A lost password can be handled out-of-band by re-running the same bootstrap script to set a new hash directly. Revisit once the operator team is large enough that this becomes a real operational burden.

**CSRF protection**: `SameSite=Lax` already blocks the classic cross-site form-POST vector for state-changing requests, and every mutating action in this app already goes through same-origin `fetch()` calls (confirmed — `BetQueueItem.tsx` uses `fetch()`, not a plain HTML form), which cross-site JavaScript cannot forge with the session cookie attached. Given that, a full CSRF-token scheme is not required for MVP. A cheap additional layer worth adding in Stage 5.0D regardless: verifying the `Origin`/`Referer` header on state-changing requests matches the app's own origin — inexpensive insurance, not a substitute for the SameSite cookie doing the real work.

## 7. Data Model Changes (proposed — not applied)

```prisma
model Operator {
  id           String   @id @default(cuid())
  name         String
  phone        String   @unique
  passwordHash String
  createdAt    DateTime @default(now())

  players  Player[]
  sessions OperatorSession[]
}

model OperatorSession {
  id         String    @id @default(cuid())
  operatorId String
  operator   Operator  @relation(fields: [operatorId], references: [id])

  expiresAt  DateTime
  createdAt  DateTime  @default(now())
  revokedAt  DateTime?

  @@index([operatorId])
}
```

- `phone` (already unique on `Operator`) is proposed as the login identifier rather than adding a new `email` field — it's already the unique human-facing identifier on this model, and this is an internal tool, not a consumer product that needs email-based account recovery.
- `passwordHash` is added as non-nullable in the type above, but the actual migration needs an explicit decision (nullable-then-backfilled-via-script, vs. requiring the bootstrap script to run before the migration is considered "complete") — left for Stage 5.0B, not decided here.
- Stage 5.0E's brute-force tracking (a failed-attempt counter and lockout window) is deliberately left out of this schema sketch — it's that stage's own migration, not bundled in here.
- All changes are additive; nothing removes or renames an existing `Operator` field, so `Player.operatorId` and every existing relation is unaffected.

## 8. Session Lifecycle

1. **Login**: operator submits phone + password → server looks up `Operator` by `phone`, verifies password against `passwordHash` via `scrypt` → on success, creates an `OperatorSession` row with an `expiresAt` a fixed TTL from now, sets the session ID as an `HttpOnly`/`Secure`/`SameSite=Lax` cookie.
2. **Validation**: every request to a protected route/page looks up the session by the cookie's ID, checks `revokedAt IS NULL AND expiresAt > now()`. Any failure (missing cookie, malformed cookie, unknown ID, expired, revoked) is treated identically — redirect to `/login` (pages) or `401` (API), with no distinction in the response that would help an attacker tell these cases apart.
3. **Expiration**: purely time-based (`expiresAt`) — no sliding renewal is proposed for MVP, to keep the design simple; can be added later if operators find the fixed TTL annoying in practice.
4. **Revocation**: explicit logout deletes/marks the session row `revokedAt`. A stolen-but-not-yet-expired cookie becomes worthless the moment it's revoked, since validation is a live DB check every time — never a locally-decodable token trusted without a lookup.
5. **Logout**: clears the cookie **and** revokes the row server-side — both, not just one.

## 9. Implementation Stages

### Stage 5.0B — Authentication foundation
- **Files likely created**: `lib/auth/operatorPassword.ts` (scrypt hash/verify), `lib/auth/operatorSession.ts` (create/validate/revoke session, cookie constants), `lib/auth/requireOperatorSession.ts` (route-handler guard, parallel in shape to the existing `isOperatorAuthorized`), `scripts/create-operator.ts` (manual bootstrap, not an HTTP endpoint).
- **Files likely modified**: `prisma/schema.prisma` only (the model changes in §7).
- **Migration**: yes — additive `passwordHash` on `Operator`, new `OperatorSession` table.
- **Risks**: this touches the `Operator` table that `Player.operatorId` depends on; additive-only, but this project runs on a single shared Neon database with no separate dev/staging copy, so the migration needs to be reviewed carefully before it's applied there.
- **Validation steps**: `npx prisma validate`, review `npx prisma migrate diff` output before applying, `npx tsc --noEmit`, a manual hash/verify round-trip check, confirm nothing yet imports these new files (they're inert until 5.0C/D wire them in).
- **Rollback**: additive-only — drop the new table/column or simply leave them unused while reverting code; no existing flow depends on them yet, so there's no data-loss risk.

### Stage 5.0C — Operator login UI
- **Files likely created**: `app/login/page.tsx`, a login form client component, `app/api/auth/login/route.ts`, `app/api/auth/logout/route.ts`.
- **Files likely modified**: none required yet — the Dashboard isn't gated until 5.0D, so this stage is additive and isolated.
- **Migration**: none (foundation already landed in 5.0B).
- **Risks**: this is the first *unauthenticated-by-definition* endpoint (`/api/auth/login`) — pair it with the generic-error requirement from day one (constant behavior regardless of which check failed, same discipline as this codebase's existing `timingSafeEqual` usage) even if rate limiting itself waits for 5.0E.
- **Validation steps**: manual login/logout against a seeded operator account, inspect cookie flags in browser devtools (`HttpOnly`/`Secure`/`SameSite`), confirm the error message is identical for "unknown phone" and "wrong password," `tsc`/`lint`/`build`.
- **Rollback**: remove the new routes/pages — nothing else depends on them yet, so this is a clean, isolated revert.

### Stage 5.0D — Dashboard and API route protection
- **Files likely created**: `middleware.ts` (this project's first).
- **Files likely modified**: all six `/api/dashboard/*` route files (add the session guard), possibly a small shared client-side helper for handling a `401`/redirect from the existing dashboard `fetch()` calls.
- **Migration**: none.
- **Risks**: the highest-risk stage — it's the one that can lock out the legitimate operator (misconfigured middleware matcher, or a cookie domain/path mismatch between local/preview/production; this project's own `operatorApiProxy.ts` already documents a real prior incident from exactly this class of environment-URL mismatch) or, worse, fail *open* instead of *closed*. Every check added here must default to denying access on any uncertainty.
- **Validation steps**: confirm all six previously-open routes now reject an unauthenticated request, confirm they succeed with a valid session cookie, confirm direct navigation to `/` while logged out redirects to `/login`, re-verify confirm/reject/history/players work end-to-end for a logged-in operator, confirm `/miniapp` and `/api/miniapp/*` are completely untouched by the new middleware matcher.
- **Rollback**: a straight code revert of `middleware.ts` and the route-handler changes fully restores prior (insecure but functional) behavior — no schema involved.

### Stage 5.0E — Rate limiting, session revocation, security validation
- **Files likely created**: a failed-login tracking mechanism (`lib/auth/loginRateLimit.ts` or similar).
- **Files likely modified**: `app/api/auth/login/route.ts` (add the lockout check).
- **Migration**: yes, if tracking attempts in Postgres (recommended over in-memory, per the serverless-statelessness reasoning in §6) — a small counter/`lockedUntil` addition.
- **Risks**: an overly aggressive lockout is a self-inflicted DoS against the legitimate operator — needs sane thresholds and a clear, time-based unlock path (or manual reset via the same bootstrap script used for account creation).
- **Validation steps**: simulate repeated failed logins and confirm lockout triggers and later clears; confirm cookie flags specifically on a real deployed (Vercel) environment, not just locally; confirm an expired session is actually rejected after its TTL; confirm logout invalidates server-side by replaying the old cookie value and confirming rejection, not just clearing the client cookie.
- **Rollback**: additive — disable the rate-limit check without touching earlier stages if thresholds prove too strict; tune forward rather than rolling back.

## 10. Testing Plan

No tests have been run — this stage is analysis-only. The following scenarios should be exercised once implementation lands:

- Valid login with correct phone + password succeeds and sets a session cookie with the expected flags.
- Invalid password for a known operator fails with the generic error message.
- Unknown phone/identifier fails with the **same** generic error message (not a different one).
- An expired session (past `expiresAt`) is rejected on the next request and redirects to `/login`.
- A revoked session (logged out, or administratively revoked) is rejected immediately, even before its natural expiry.
- A request with no session cookie at all is rejected on every protected route.
- A malformed/tampered session cookie value is rejected, not treated as "no cookie" in a way that skips validation.
- Logout clears the cookie **and** the server-side session row is confirmed gone/revoked by replaying the old cookie value afterward.
- Direct navigation to `/` with no session redirects to `/login` rather than rendering any Dashboard content.
- Direct `curl`/API calls to each of the six `/api/dashboard/*` routes with no cookie return `401`, including `overview` and `players`, which today return real data unconditionally.
- A Telegram-authenticated player request (valid `initData`, no operator session) is rejected by every operator route — confirms the two domains stay separated.
- Repeated failed login attempts trigger the lockout at the configured threshold, and the lockout clears as designed afterward.
- Cookie flags (`HttpOnly`, `Secure`, `SameSite`) are inspected on an actual deployed Vercel environment, not assumed from local `http://localhost` behavior, given this project's prior real incident with preview-URL/production-URL differences.

## 11. Risks and Mitigations

- **Single shared Neon database, no dev/staging copy** — every migration in this plan must be reviewed (`prisma migrate diff`) before being applied to the one real database this project has, exactly as this session has already been doing for prior schema-adjacent stages.
- **Locking out the legitimate operator during Stage 5.0D rollout** — mitigate by testing the full flow (including a real deployed-environment cookie check) before considering that stage complete, and by defaulting every new check to fail-closed rather than fail-open.
- **Prematurely retiring `OPERATOR_SECRET`** — keep it in place on the low-level `/api/bets/*` routes as defense-in-depth through the transition; only consider retiring it in a later cleanup once the dashboard-layer session auth has been live and verified.
- **Latent cross-operator IDOR** (`operatorId` not enforced in any query) — out of scope for the authentication work itself, but should be tracked as a near-term follow-up once real operator identity exists, since a second `Operator` row would otherwise immediately leak data across operators.
- **Environment/cookie mismatches across local, preview, and production** — this project has one documented real incident of exactly this class of bug (`lib/dashboard/operatorApiProxy.ts`'s comment about Vercel Deployment Protection and raw preview URLs). Mitigate by explicitly testing cookie behavior on a real Vercel deployment, not only `localhost`, before Stage 5.0D is considered done.
- **In-memory rate limiting silently not working** — Vercel serverless functions don't reliably share memory across invocations; any brute-force protection must be backed by the database (or an external store), not a process-local counter.

## 12. Final Decision

Recommend proceeding with **Option D** (minimal internal login on the existing `Operator` model, built with Option A's security properties): `scrypt` password hashing, a database-backed `OperatorSession` table, an `HttpOnly`/`Secure`/`SameSite=Lax` cookie, and a new `middleware.ts` gating `/` and `/api/dashboard/*`. Magic-link and OAuth (Options B/C) are both explicitly not recommended — they solve problems this project doesn't have, at a dependency and complexity cost the actual team size doesn't justify. Password reset is deferred; CSRF token infrastructure is deferred in favor of `SameSite=Lax` plus an `Origin` header check, given every mutating request already goes through same-origin `fetch()`.

This is a proposal, not a decision — no ADR has been created (per instruction, ADRs are written only after the architecture is approved), and no implementation has started. Waiting for explicit approval before Stage 5.0B begins.
