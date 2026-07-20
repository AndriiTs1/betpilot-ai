# Operator Authentication — Implementation Notes (Stages 5.0B–5.0C)

This document describes the operator authentication work built so far, per the architecture approved in `OPERATOR_AUTH_AUDIT.md`. **Stage 5.0B** (password hashing, database-backed sessions, cookie policy) built the standalone, tested utilities. **Stage 5.0C** (this update) wires those utilities into a real login page, a login API route, and a logout API route.

**Still true after Stage 5.0C**: `/` and every `/api/dashboard/*` route are exactly as unprotected as `OPERATOR_AUTH_AUDIT.md` originally found them. Logging in now creates a real, valid session cookie — but nothing anywhere checks for that cookie before serving the Dashboard or its API routes yet. That is Stage 5.0D's job, deliberately not started here. See "What Stage 5.0C does *not* do" at the end of this document.

## Password hash format

`lib/auth/password.ts` hashes passwords with `node:crypto`'s built-in `scrypt` — no new dependency (`bcrypt`/`argon2` were considered and rejected for this reason; Node's own `crypto.scrypt` docs example uses the same cost parameters chosen here).

Stored format (7 `$`-separated fields):

```
scrypt$v1$16384$8$1$<saltHex>$<hashHex>
```

| Field | Meaning |
|---|---|
| `scrypt` | Algorithm prefix |
| `v1` | Format version |
| `16384` | `N` — CPU/memory cost parameter (2^14) |
| `8` | `r` — block size |
| `1` | `p` — parallelization |
| `<saltHex>` | 16-byte random salt, hex-encoded |
| `<hashHex>` | 64-byte derived key, hex-encoded |

`N`/`r`/`p` are read back from the stored string at verification time, not assumed from the current constants — a future change to these parameters (e.g. raising `N`) never breaks verification of hashes created under the old ones; both live side by side until a password is next changed.

`N = 2^14` was chosen specifically because peak scrypt memory usage (`128 * N * r` bytes ≈ 16 MiB) stays under Node's default `scrypt` `maxmem` (32 MiB) with no extra tuning — a higher, OWASP-style `N` (e.g. 2^17) would require explicitly raising `maxmem` and was judged unnecessary for a small, low-traffic operator login.

`verifyPassword(password, storedHash)`:
- Parses the stored format defensively — any malformed value (wrong field count, wrong prefix/version, non-numeric cost parameters, non-hex salt/hash) returns `false` immediately, **never throws**.
- Recomputes the derived key using the stored salt and cost parameters, then compares with `crypto.timingSafeEqual` (matching the constant-time comparison pattern already used elsewhere in this codebase — `lib/auth/operatorAuth.ts`, `lib/auth/telegramWebhookAuth.ts`).
- `scrypt()` itself throwing (e.g. a corrupt hash implying parameters beyond `maxmem`) is caught and treated as a failed verification, not a crash.

`hashPassword(password)` rejects passwords shorter than `MIN_OPERATOR_PASSWORD_LENGTH` (12 characters) by throwing `InvalidPasswordError` — enforced both here and in the provisioning script, so no caller can accidentally hash a weak credential.

Passwords and hashes are never logged anywhere in this code — no `console.log`/`console.error` in `password.ts` ever includes either.

## Session token lifecycle

`lib/auth/operatorSession.ts` implements database-backed sessions, per the audit's recommendation (§6: revocability matters more than saving one indexed read, for an app where an operator action moves real credit exposure).

1. **Creation** (`createOperatorSession(operatorId)`): generates a 256-bit random token via `crypto.randomBytes(32)`, base64url-encoded. The **raw token is returned to the caller and is never stored anywhere** — only its SHA-256 hex digest (`tokenHash`) is written to the `OperatorSession` row, alongside `operatorId` and `expiresAt`.
2. **Validation** (`validateOperatorSession(rawToken)` / `getOperatorSessionFromRequest(request)`): re-hashes the presented token and looks it up by `tokenHash` (unique, indexed). Rejects — uniformly, as `{ valid: false }` — a token that is malformed (fails a cheap shape check before any query), not found, revoked (`revokedAt` set), or expired (`expiresAt` in the past). The internal `reason` field (`"malformed" | "not_found" | "expired" | "revoked"`) exists **only** for logging/tests; no future route should ever echo it back in an HTTP response — the whole point of a generic failure is that "wrong token" and "expired token" and "someone else's revoked token" must look identical from the outside.
3. **Touch**: on a valid session, `lastUsedAt` is updated — but only if it's unset or more than 5 minutes old, to avoid a database write on every single request. A failed touch-write never fails the request it's authorizing (best-effort, swallowed).
4. **Revocation** (`revokeOperatorSession(rawToken)` / `revokeAllOperatorSessions(operatorId)`): sets `revokedAt`. Uses `updateMany` (not update-by-id), so revoking an already-revoked or unknown token silently affects zero rows rather than throwing — logout must behave identically whether or not the session still existed.
5. **Cleanup** (`cleanupExpiredOperatorSessions()`): hard-deletes rows past their natural `expiresAt`. Revoked-but-not-yet-expired rows are deliberately left alone — they remain a brief audit trail until they would have expired anyway. Not yet wired to a cron/scheduled job in this stage.

Why SHA-256 (not scrypt) for the token hash: the session token is 256 bits of cryptographic randomness, not a human-chosen low-entropy secret — a slow password KDF exists to defend against offline brute-forcing of *guessable* inputs, which doesn't apply to a token no one could ever guess. A fast, unsalted hash is the correct and standard choice for this lookup.

**Testability**: every function accepts an optional `store` parameter (default: the real Prisma `operatorSession` delegate). Tests inject a small in-memory fake instead — this project has one shared Neon database with no separate dev/staging copy, so the test suite must never touch it; see `lib/auth/operatorSession.test.ts`.

## Cookie policy

`lib/auth/operatorSessionCookie.ts` is the single place cookie flags are decided — every future route that sets or clears this cookie must use `buildOperatorSessionCookie()` / `buildOperatorSessionClearCookie()`, never construct options inline, so the flags can't drift between routes.

| Flag | Value | Why |
|---|---|---|
| Name | `betpilot_operator_session` (configurable, see below) | |
| `HttpOnly` | always `true` | Never readable by JavaScript — the raw token exists only here and in the DB's hash |
| `Secure` | `true` whenever `NODE_ENV === "production"` | Both `next build`/`next start` and Vercel's own build set `NODE_ENV=production` for every deployed environment (preview and production alike, both served over HTTPS) — `false` only in local `next dev` |
| `SameSite` | `Lax` | Standard, safe default; blocks the classic cross-site form-POST CSRF vector. See `OPERATOR_AUTH_AUDIT.md` §6 for the full CSRF reasoning |
| `Path` | `/` | |
| `Max-Age` | seconds until the session's `expiresAt` | Kept aligned with the actual DB session lifetime — never a longer client-side cookie life than the server-side session it represents |

No `Domain` attribute is set (host-only cookie), per the audit's "no Domain unless required."

## Session revocation

Revocation is a live database check on every request that uses the session — there is no locally-decodable/signed token that could remain valid after its DB row is gone. Revoking a session (`revokeOperatorSession`) or all of an operator's sessions (`revokeAllOperatorSessions`) takes effect on the very next request; there is no caching or short trust window to wait out.

Session **expiration** is purely time-based (`OPERATOR_SESSION_TTL_HOURS`, default 12) — no sliding renewal in this stage. Deferred, per the audit, as unnecessary complexity for the MVP.

## Operator provisioning

`scripts/create-operator.ts` (`npm run operator:create`) is the only intended way to create the first operator or rotate a password. It is **not** an HTTP endpoint — it's a manual script run locally with production `DATABASE_URL` access, adding no new internet-facing attack surface (whoever runs it already has the DB access level required to run it).

```
OPERATOR_NAME="Jane Operator" \
OPERATOR_PHONE="+41000000000" \
OPERATOR_PASSWORD="a-long-random-password" \
npm run operator:create
```

- Reads `OPERATOR_NAME` / `OPERATOR_PHONE` / `OPERATOR_PASSWORD` from the environment — never hardcoded, never accepted as a CLI argument (which would leak into shell history the same way).
- Validates password length via the shared `MIN_OPERATOR_PASSWORD_LENGTH` constant before hashing.
- `upsert`s by `phone`: creates the `Operator` if it doesn't exist, or updates its `name`/`passwordHash` if it does — safe to re-run to rotate a password later, using this same script as the interim "password reset" mechanism (the audit explicitly defers building a self-service reset flow for MVP).
- Prints only a safe summary (name, phone, id, and whether it was a create or an update) — the password and its hash are never printed or logged.

**Deviation from the literal task wording, explained**: the task described this script as accepting "email and password." `Operator` has no `email` field — `OPERATOR_AUTH_AUDIT.md` §7 explicitly proposed reusing the existing, already-unique `phone` field as the login identifier instead of adding a new one, and this stage's own Prisma-changes section only asked for `passwordHash` and `sessions` to be added to `Operator`, not `email`. The script therefore uses `OPERATOR_PHONE`, matching the approved architecture and the actual schema, rather than introducing a field nothing else in the project uses.

`prisma/seed.ts`'s existing behavior is untouched — it still creates its test operator (`TEST_OPERATOR_PHONE = "+10000000000"`) with no password, exactly as before. That operator simply has `passwordHash: null` until `create-operator.ts` is run against it.

## Environment variables

Both are optional — sensible defaults apply if unset, matching this project's existing `.env.example` convention:

| Variable | Default | Purpose |
|---|---|---|
| `OPERATOR_SESSION_TTL_HOURS` | `12` | Session lifetime. A non-numeric or non-positive value logs a warning and falls back to the default rather than crashing. |
| `OPERATOR_SESSION_COOKIE_NAME` | `betpilot_operator_session` | Cookie name. Change only if it collides with something else in a given deployment. |

Neither is (or should ever be) prefixed `NEXT_PUBLIC_` — both are read only in server-side code.

## Security assumptions

- **Strict separation from Telegram player authentication**: `lib/auth/operatorSession.ts` shares no code, no secret material, and no session store with `lib/telegram/verifyInitData.ts`. A valid Telegram `initData` header carries no weight against an operator route, and vice versa, by construction (different cookie, different table, different verification function entirely).
- **Server-only boundary without the `server-only` package**: every file in this stage that touches `node:crypto` or Prisma directly (`password.ts`, `operatorSession.ts`) already cannot be imported into a `"use client"` component without an immediate build failure — Node core modules and the generated Prisma client aren't available in a browser bundle. Since that hard failure already exists, adding the `server-only` npm package would only supply a friendlier error message on top of a failure mode that was already impossible to silently ship; it was judged not "technically unavoidable" (the bar this stage's own instructions set for new dependencies) and was deliberately not added. Each file carries a comment stating this explicitly.
- **No secrets exposed to the client**: `passwordHash`, `tokenHash`, and the raw session token are never returned from any function whose result could plausibly flow into a client component or an HTTP response body in this stage. (No route consumes any of this yet, but the shape of every return value already excludes them — `OperatorSessionValidation`'s success case carries only `operatorId`.)
- **Generic failure behavior**: both `validateOperatorSession` and `revokeOperatorSession` return/behave identically regardless of *why* a token failed or whether it existed — the distinguishing detail (`reason`) is retained only for internal use, never surfaced.
- **`OPERATOR_SECRET` is untouched**: the existing static-secret check on `/api/bets/*` (`lib/auth/operatorAuth.ts`) is not modified or removed in this stage. It remains in place as-is until a later stage explicitly retires or supersedes it once session-based auth is actually protecting the routes that matter.
- **What Stage 5.0B does *not* protect**: `/` and every `/api/dashboard/*` route remain exactly as open as `OPERATOR_AUTH_AUDIT.md` found them. This document is not a claim that the Dashboard is now secured — only that the primitives it will be secured with now exist and are tested.

---

## Stage 5.0C — Login and logout

### Login route

`POST /api/operator/auth/login` (`app/api/operator/auth/login/route.ts`).

**Request body**:
```json
{ "phone": "+41000000000", "password": "..." }
```

**Success response** — `200`:
```json
{ "ok": true }
```
The response also carries a `Set-Cookie` header for the session, built exclusively via `buildOperatorSessionCookie()` (Stage 5.0B) — no cookie options are ever constructed inline in the route.

**Failure response** — `401`, identical shape for every failure reason:
```json
{ "ok": false, "error": "INVALID_CREDENTIALS" }
```
This single response covers: unknown phone, an operator with no `passwordHash` set yet, a wrong password, *and* a rate-limited request (see below) — deliberately indistinguishable from one another.

**Malformed request** — `400`:
```json
{ "ok": false, "error": "INVALID_REQUEST" }
```
Used for non-JSON bodies, missing/wrong-typed `phone`/`password` fields, or a phone/password that's blank after trimming. This is safe to distinguish from `INVALID_CREDENTIALS` — a malformed request reveals nothing about whether any particular phone number has an account; it's a client-side shape error, checked before the database is ever touched.

**Unexpected server error** — `500`:
```json
{ "ok": false, "error": "INTERNAL_ERROR" }
```
Matches this codebase's existing convention on every other route (e.g. `app/api/miniapp/bets/text/preview/route.ts`) for a genuinely unexpected exception — not an account-enumeration vector, since it's symmetric regardless of which phone was submitted.

**Login logic is split across two testable, DI-friendly functions in `lib/auth/operatorLogin.ts`, not inlined in the route**:
- `parseOperatorLoginRequestBody(body)` — pure validation of the already-JSON-parsed body; returns `{ phone, password } | null`. Tested directly with a table of malformed inputs, no `NextRequest` needed.
- `attemptOperatorLogin(phone, password, lookup?, sessionStore?)` — looks up the `Operator` by `phone`, verifies the password, and creates a session on success. Takes no HTTP concerns at all (no headers, no cookies) so it's testable with an injected in-memory `OperatorLookup` and `OperatorSessionStore`, never the real database.

**Constant-time defense against account enumeration**: `attemptOperatorLogin` always calls `verifyPassword()` — the expensive `scrypt` step — exactly once per attempt, whether or not the operator exists or has a `passwordHash` set yet. When there's no real hash to check against, it checks against a fixed, precomputed, valid-format dummy hash (`DUMMY_PASSWORD_HASH` in `operatorLogin.ts`) instead of skipping the computation. Without this, "unknown phone" (near-instant, no `scrypt` call) would be measurably faster than "wrong password" (one real `scrypt` call), which is exactly the kind of timing side-channel an attacker could use to enumerate valid phone numbers. A test (`lib/auth/operatorLogin.test.ts`) asserts the two paths land within the same order of magnitude.

### Logout route

`POST /api/operator/auth/logout` (`app/api/operator/auth/logout/route.ts`).

**Always responds** `200 { "ok": true }` — regardless of whether a session cookie was present, valid, expired, or already revoked. Behavior:
1. Read the session cookie, if present.
2. If present, call `revokeOperatorSession(token)` (Stage 5.0B) — which itself already no-ops safely for any token that doesn't match an active session, rather than throwing.
3. Always clear the cookie via `buildOperatorSessionClearCookie()`.

This route has no branch that can fail the request — it's idempotent by construction, not by an explicit "already logged out" check, because Stage 5.0B's `revokeOperatorSession` was already built to behave that way.

### Already-authenticated login behavior

`app/operator/login/page.tsx` is a Server Component. On every request, it reads the session cookie via `next/headers`'s `cookies()` and calls `validateOperatorSession()` directly (Stage 5.0B). If the session is valid, it calls `redirect("/")` before rendering the form at all — an already-authenticated operator never sees the login form flash on screen.

**Deviation from the task's literal wording, explained**: the task's preferred behavior said "redirect to `/dashboard`." No `/dashboard` route exists in this project — the Dashboard's actual route is `/` (`app/page.tsx`), confirmed in `OPERATOR_AUTH_AUDIT.md`'s own route matrix. The redirect target used is `/`, matching what actually exists. If a future stage introduces a real `/dashboard` route as part of protecting it, this redirect target needs a one-line update to match.

This check is intentionally **local to the login page only** — no `middleware.ts` was added (there still isn't one anywhere in this project), and `/` itself is not gated by this change in any way. An operator who is not logged in can still open `/` directly and see the Dashboard, exactly as before — this redirect only decides what the *login page itself* shows to someone who's already got a valid session.

### Rate-limiting policy

`lib/auth/loginRateLimit.ts` — an in-memory limiter, keyed by `` `${clientIp}|${normalizedPhone}` ``, checked in the login route before any database/`scrypt` work happens.

- **Policy**: 5 failed attempts within a 15-minute window blocks further attempts for that key. A successful login clears the count for that key outright.
- **Client IP** is read from the `x-forwarded-for` header (what Vercel sets); falls back to the literal string `"unknown"` locally, where there's no proxy in front of the dev server.
- **Response when rate-limited**: the exact same `401 { "ok": false, "error": "INVALID_CREDENTIALS" }` as a wrong password — not a distinct `429`, and not a distinct error code. The task's requirement to "not reveal which key triggered the limit" was interpreted conservatively here: the response doesn't reveal that a rate limit was hit *at all*, only that the attempt failed, exactly like every other failure reason.

**Known limitation — explicitly not a production-grade rate limiter**, documented directly in `loginRateLimit.ts`'s file header as well as here:
1. **Per-instance only.** Vercel serverless functions don't share memory across concurrent invocations or regions. The `Map` backing a limiter instance is *not* a global counter across a real multi-instance deployment — an attacker whose requests happen to land on several different warm instances could exceed the intended 5-attempt limit before any single instance's counter reaches it.
2. **Resets on cold start or redeploy.** A fresh function instance starts with an empty `Map`; any accumulated failure count is lost.

A durable store (Vercel KV/Upstash, or a database table) would remove both limitations. Deliberately not introduced in this stage — the task explicitly ruled out adding Redis solely for this, and this in-memory version is judged an acceptable *basic* defense (not a complete one) for a small, low-traffic, internal operator login. `createLoginRateLimiter()` is a factory (not a bare module-level `Map`) specifically so this can be swapped for a durable-store-backed implementation later without changing its interface or any caller.

### Login page

`/operator/login` (`app/operator/login/page.tsx` + `components/operator/OperatorLoginForm.tsx`).

- Server Component page (already-authenticated redirect, above) rendering a Client Component form.
- Plain `fetch()` + React state — no third-party auth UI library.
- Phone (`type="tel"`) and password (`type="password"`) inputs, each with a real `<label htmlFor>` (not just `aria-label`) for accessibility; native `required` attributes; a real `<form onSubmit>` so Enter submits naturally, with no custom key handling needed.
- Loading state disables both inputs and the submit button and changes its label to "Signing in...".
- On failure: the password field is cleared and a single generic message ("Invalid phone or password.") is shown in a `role="alert"` element — the same message regardless of why the login failed, matching the API's own generic error.
- Visual design deliberately matches the **Dashboard's** existing Tailwind palette (`bg-slate-950`/`bg-slate-900`/`border-slate-800`, plain `green-500`/`red-950` accents, Tabler icon font) rather than the Mini App's distinct green-glow/inline-style theme — this page leads into the Dashboard, not the Mini App, and the existing per-domain icon-library convention (Mini App → `lucide-react`, Dashboard → Tabler icon font) is preserved rather than crossed. One restrained radial gradient behind the card is the only gradient on the page.

### What Stage 5.0C does *not* do

- **No Dashboard or API route protection.** `/` and every `/api/dashboard/*` route are byte-for-byte unchanged from Stage 5.0B (confirmed via `git diff` before this stage's commit) — they remain fully open to an unauthenticated caller. Logging in successfully now produces a real, valid session cookie, but nothing checks for it anywhere except the login page's own already-authenticated redirect.
- **No `middleware.ts`.** Still none anywhere in this project.
- **No session revocation UI**, no "log out everywhere" action, no password reset flow — all explicitly deferred, per the original audit.
- **`OPERATOR_SECRET`** (the pre-existing static-secret check on `/api/bets/*`) is untouched.
