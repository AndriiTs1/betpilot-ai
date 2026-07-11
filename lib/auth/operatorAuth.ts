import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}

export function isOperatorAuthorized(request: NextRequest): boolean {
  const expected = process.env.OPERATOR_SECRET;
  if (!expected) return false;

  const header = request.headers.get("authorization");
  if (!header) return false;

  const [scheme, token] = header.split(" ");
  if (!token || scheme?.toLowerCase() !== "bearer") return false;

  return safeCompare(token, expected);
}
