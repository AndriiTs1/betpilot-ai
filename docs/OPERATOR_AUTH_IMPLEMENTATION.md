# Operator Authentication — Implementation Notes (Stage 5.0B)

This document describes the authentication **foundation** built in Stage 5.0B, per the architecture approved in `OPERATOR_AUTH_AUDIT.md`. It covers what exists today: password hashing, database-backed sessions, and cookie policy — as standalone, tested utilities. **Nothing in this stage is wired into a route yet.** There is no login page, no login API route, no logout UI, no middleware, and no Dashboard/API route protection — those are Stage 5.0C (login UI) and Stage 5.0D (route protection), not this one. Today, `/` and every `/api/dashboard/*` route are exactly as unprotected as `OPERATOR_AUTH_AUDIT.md` found them.

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
- **What this stage does *not* protect**: `/` and every `/api/dashboard/*` route remain exactly as open as `OPERATOR_AUTH_AUDIT.md` found them. This document is not a claim that the Dashboard is now secured — only that the primitives it will be secured with now exist and are tested.
