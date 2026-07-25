import { NextResponse } from "next/server";

// One shared 429 shape for every route this step touches — avoids three
// independent copies of the same status/header/body construction. Never
// exposes the limiter key, the route's internal bucket state, or any
// storage detail; only the one number a client actually needs to act on.
export function rateLimitedResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: "RATE_LIMITED", retryAfterSeconds },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    },
  );
}
