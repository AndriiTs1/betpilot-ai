// Server-only: touches Prisma and (through password.ts/operatorSession.ts)
// node:crypto directly. See lib/auth/password.ts's note on why the
// `server-only` package wasn't added as a new dependency.

import { prisma } from "@/lib/db/client";
import { verifyPassword } from "./password";
import { createOperatorSession, type OperatorSessionStore, type CreatedOperatorSession } from "./operatorSession";

// A precomputed, valid-format scrypt hash (see password.ts's stored format)
// for a password no real operator will ever submit. Checked whenever the
// looked-up operator doesn't exist or has no passwordHash yet, so
// verifyPassword's expensive scrypt step runs exactly once on every login
// attempt regardless of outcome — this is what keeps "unknown phone" and
// "wrong password" from being distinguishable by response time. Generated
// once via hashPassword(); its own salt/derived key carry no meaning beyond
// "a syntactically valid hash nothing will ever match."
const DUMMY_PASSWORD_HASH =
  "scrypt$v1$16384$8$1$fd428ba4e86cecc702a594eb7545556a$cf8d66e80719ca461761d78e957326d03de5eb0d5affe0181f48a717dee913512810a789eb412089103b7a4e9703fc981d6c6140cdc8c5214b48471cba0e1b6b";

// The minimal slice of Prisma's Operator delegate this file actually calls —
// same reasoning as OperatorSessionStore in operatorSession.ts: lets tests
// inject a plain in-memory fake instead of touching the real, shared
// database.
export interface OperatorLookup {
  findUnique(args: {
    where: { phone: string };
  }): Promise<{ id: string; passwordHash: string | null } | null>;
}

// Bridges Prisma's richly-generic delegate type to the minimal interface
// above — same pattern, and same justification, as operatorSession.ts's
// defaultStore.
const defaultLookup = prisma.operator as unknown as OperatorLookup;

// Conservative on purpose: trim only, no digit reformatting or
// country-code guessing — matches scripts/create-operator.ts's own
// normalization exactly, since Operator.phone is stored verbatim as
// whatever that script was given.
export function normalizeOperatorPhone(rawPhone: string): string {
  return rawPhone.trim();
}

// Pulled out of the route handler so "malformed body" is a plain unit test
// against parsed JSON, not something that requires constructing a fake
// NextRequest. Returns null for anything that isn't a well-formed
// { phone, password } payload — the route handler maps that to a single
// generic 400, never a per-field error.
export function parseOperatorLoginRequestBody(body: unknown): { phone: string; password: string } | null {
  if (
    typeof body !== "object" ||
    body === null ||
    !("phone" in body) ||
    !("password" in body) ||
    typeof (body as { phone: unknown }).phone !== "string" ||
    typeof (body as { password: unknown }).password !== "string"
  ) {
    return null;
  }

  const phone = normalizeOperatorPhone((body as { phone: string }).phone);
  const password = (body as { password: string }).password;

  if (!phone || !password) return null;

  return { phone, password };
}

export type OperatorLoginResult = ({ ok: true } & CreatedOperatorSession & { operatorId: string }) | { ok: false };

// Deliberately takes no HTTP concerns (no headers, no cookies, no request
// object) — phone and password in, a login outcome out. The route handler
// owns rate limiting and cookie-setting; this function owns only the
// credential-check-and-session-creation decision, so it's testable without
// a fake NextRequest and without touching the real database.
export async function attemptOperatorLogin(
  phone: string,
  password: string,
  lookup: OperatorLookup = defaultLookup,
  sessionStore?: OperatorSessionStore,
): Promise<OperatorLoginResult> {
  const operator = await lookup.findUnique({ where: { phone } });

  // Always run the real scrypt computation — against the operator's real
  // hash if one exists, otherwise against the fixed dummy hash above — so
  // this call's cost is the same whether or not the operator/hash exists.
  const passwordValid = await verifyPassword(password, operator?.passwordHash ?? DUMMY_PASSWORD_HASH);

  if (!operator || !operator.passwordHash || !passwordValid) {
    return { ok: false };
  }

  const session = await createOperatorSession(operator.id, sessionStore);
  return { ok: true, operatorId: operator.id, ...session };
}
