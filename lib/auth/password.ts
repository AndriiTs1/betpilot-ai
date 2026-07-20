// Server-only: uses node:crypto. Not importable into a "use client"
// component without an immediate build failure (Node core modules aren't
// available in a browser bundle) — that existing hard failure is why the
// `server-only` package wasn't added as a new dependency for this file; see
// docs/OPERATOR_AUTH_IMPLEMENTATION.md.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// util.promisify can only infer one overload of crypto.scrypt's several —
// it resolves to the 3-arg (no options) form, even though the options-
// accepting overload exists and works fine at runtime. Cast to the actual
// signature used below rather than dropping the N/r/p options.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

// scrypt cost parameters. N = 2^14 keeps peak memory (~128 * N * r bytes =
// 16 MiB) under Node's default scrypt maxmem (32 MiB) with no extra tuning
// needed — this is the same N used in Node's own crypto.scrypt() docs
// example. Stored explicitly per-hash (not assumed from these constants) so
// a future change here never breaks verification of hashes created today.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

const HASH_PREFIX = "scrypt";
const HASH_FORMAT_VERSION = "v1";

export const MIN_OPERATOR_PASSWORD_LENGTH = 12;

export class InvalidPasswordError extends Error {}

function assertValidPassword(password: string): void {
  if (typeof password !== "string" || password.length < MIN_OPERATOR_PASSWORD_LENGTH) {
    throw new InvalidPasswordError(`Password must be at least ${MIN_OPERATOR_PASSWORD_LENGTH} characters`);
  }
}

// Stored format: scrypt$v1$N$r$p$saltHex$hashHex
export async function hashPassword(password: string): Promise<string> {
  assertValidPassword(password);

  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  return [
    HASH_PREFIX,
    HASH_FORMAT_VERSION,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("hex"),
    derivedKey.toString("hex"),
  ].join("$");
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

// Never throws — returns null for any malformed input so verifyPassword can
// fail safely (false) instead of leaking a parsing exception to its caller.
function parseStoredHash(stored: string): ParsedHash | null {
  if (typeof stored !== "string") return null;

  const parts = stored.split("$");
  if (parts.length !== 7) return null;

  const [prefix, version, nStr, rStr, pStr, saltHex, hashHex] = parts;
  if (prefix !== HASH_PREFIX || version !== HASH_FORMAT_VERSION) return null;

  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (
    !Number.isInteger(N) ||
    N <= 0 ||
    !Number.isInteger(r) ||
    r <= 0 ||
    !Number.isInteger(p) ||
    p <= 0
  ) {
    return null;
  }

  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return null;
  if (saltHex.length % 2 !== 0 || hashHex.length % 2 !== 0 || hashHex.length === 0) return null;

  return { N, r, p, salt: Buffer.from(saltHex, "hex"), hash: Buffer.from(hashHex, "hex") };
}

function safeCompare(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Never throws for a malformed storedHash or bad input — returns false
// instead, since a corrupt/tampered stored value must fail exactly like a
// wrong password, not surface a distinguishable error to the caller.
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (typeof password !== "string") return false;

  const parsed = parseStoredHash(storedHash);
  if (!parsed) return false;

  try {
    const derivedKey = await scrypt(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
    });

    return safeCompare(derivedKey, parsed.hash);
  } catch {
    // scrypt() itself can throw (e.g. parameters implying memory beyond
    // maxmem) — treat as a failed verification, never a crash.
    return false;
  }
}
