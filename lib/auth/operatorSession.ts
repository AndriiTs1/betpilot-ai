// Server-only: uses node:crypto and Prisma directly. Not importable into a
// "use client" component without an immediate build failure (Node core
// modules and the generated Prisma client aren't available in a browser
// bundle) — see the note in lib/auth/password.ts on why the `server-only`
// package wasn't added as a new dependency for this.
//
// Strictly separate from Telegram player authentication (lib/telegram/
// verifyInitData.ts): different cookie, different table, no shared secret
// or code path. This file must never be imported by anything under
// app/api/miniapp/* or app/miniapp/*, and vice versa.

import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";

const DEFAULT_SESSION_TTL_HOURS = 12;
const RAW_TOKEN_BYTES = 32; // 256 bits
const LAST_USED_UPDATE_THROTTLE_MS = 5 * 60 * 1000; // avoid a write on every single request

export const OPERATOR_SESSION_COOKIE_NAME =
  process.env.OPERATOR_SESSION_COOKIE_NAME?.trim() || "betpilot_operator_session";

function resolveSessionTtlHours(): number {
  const raw = process.env.OPERATOR_SESSION_TTL_HOURS;
  if (!raw) return DEFAULT_SESSION_TTL_HOURS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `OPERATOR_SESSION_TTL_HOURS="${raw}" is not a positive number — falling back to ${DEFAULT_SESSION_TTL_HOURS}h.`,
    );
    return DEFAULT_SESSION_TTL_HOURS;
  }

  return parsed;
}

export function getOperatorSessionTtlMs(): number {
  return resolveSessionTtlHours() * 60 * 60 * 1000;
}

// SHA-256 of the raw token — the DB only ever stores this. Lookup-only (not
// a password an attacker could feasibly guess offline), so a fast hash is
// correct here; scrypt is for low-entropy secrets, not a 256-bit random
// token, which needs no slow KDF to resist brute-forcing.
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

// Cheap, pre-DB shape check — rejects obviously-malformed input without a
// wasted query. Matches the base64url alphabet randomBytes(32) produces.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{40,50}$/;

interface OperatorSessionRow {
  id: string;
  operatorId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

// The minimal slice of Prisma's OperatorSession delegate these functions
// actually call, defined locally rather than importing Prisma's generic
// delegate type — so a plain in-memory fake can stand in for tests instead
// of a real database connection (this project has a single shared Neon DB
// with no separate dev/staging copy; tests must not touch it).
export interface OperatorSessionStore {
  create(args: {
    data: { operatorId: string; tokenHash: string; expiresAt: Date };
  }): Promise<OperatorSessionRow>;
  findUnique(args: { where: { tokenHash: string } }): Promise<OperatorSessionRow | null>;
  update(args: {
    where: { id: string };
    data: Partial<Pick<OperatorSessionRow, "lastUsedAt" | "revokedAt">>;
  }): Promise<OperatorSessionRow>;
  updateMany(args: {
    where: { operatorId?: string; tokenHash?: string; revokedAt?: null };
    data: { revokedAt: Date };
  }): Promise<{ count: number }>;
  deleteMany(args: { where: { expiresAt: { lt: Date } } }): Promise<{ count: number }>;
}

// Bridges Prisma's richly-generic delegate type to the minimal interface
// above. Safe because every call site below matches Prisma's real method
// shapes exactly — this exists only so tests can inject a lightweight fake.
const defaultStore = prisma.operatorSession as unknown as OperatorSessionStore;

export interface CreatedOperatorSession {
  token: string;
  expiresAt: Date;
}

export async function createOperatorSession(
  operatorId: string,
  store: OperatorSessionStore = defaultStore,
): Promise<CreatedOperatorSession> {
  const token = randomBytes(RAW_TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + getOperatorSessionTtlMs());

  await store.create({ data: { operatorId, tokenHash: hashToken(token), expiresAt } });

  return { token, expiresAt };
}

export type OperatorSessionValidation =
  | { valid: true; operatorId: string }
  | { valid: false; reason: "malformed" | "not_found" | "expired" | "revoked" };

// Every failure path returns the same shape (valid: false); `reason` exists
// for internal logging/tests only. No route in this stage — or any future
// one — should echo it back in an HTTP response: distinguishing
// "not_found" from "expired" from "revoked" to a caller is exactly the kind
// of detail a generic auth failure must not leak.
export async function validateOperatorSession(
  rawToken: string | null | undefined,
  store: OperatorSessionStore = defaultStore,
): Promise<OperatorSessionValidation> {
  if (!rawToken || !TOKEN_SHAPE.test(rawToken)) {
    return { valid: false, reason: "malformed" };
  }

  const session = await store.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!session) return { valid: false, reason: "not_found" };
  if (session.revokedAt) return { valid: false, reason: "revoked" };
  if (session.expiresAt.getTime() <= Date.now()) return { valid: false, reason: "expired" };

  const shouldTouch =
    !session.lastUsedAt || Date.now() - session.lastUsedAt.getTime() > LAST_USED_UPDATE_THROTTLE_MS;

  if (shouldTouch) {
    // Best-effort — a failed lastUsedAt write must never fail the request
    // this session is authorizing.
    await store
      .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }

  return { valid: true, operatorId: session.operatorId };
}

// Convenience wrapper for Route Handlers / middleware (Stage 5.0D) — reads
// the cookie off a NextRequest and validates it in one call.
export async function getOperatorSessionFromRequest(
  request: NextRequest,
  store: OperatorSessionStore = defaultStore,
): Promise<OperatorSessionValidation> {
  const rawToken = request.cookies.get(OPERATOR_SESSION_COOKIE_NAME)?.value ?? null;
  return validateOperatorSession(rawToken, store);
}

export async function revokeOperatorSession(
  rawToken: string,
  store: OperatorSessionStore = defaultStore,
): Promise<void> {
  if (!TOKEN_SHAPE.test(rawToken)) return;

  // updateMany, not update-by-id: silently affects zero rows for an
  // unknown/already-revoked token rather than throwing — logout must behave
  // identically whether or not the session still existed.
  await store.updateMany({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllOperatorSessions(
  operatorId: string,
  store: OperatorSessionStore = defaultStore,
): Promise<number> {
  const result = await store.updateMany({
    where: { operatorId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

// Hard-deletes sessions past their natural expiry. Revoked-but-not-yet-
// expired sessions are left alone (not this function's concern) so a
// revoked session still exists briefly as an audit trail until it would
// have expired anyway.
export async function cleanupExpiredOperatorSessions(
  store: OperatorSessionStore = defaultStore,
): Promise<number> {
  const result = await store.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}
