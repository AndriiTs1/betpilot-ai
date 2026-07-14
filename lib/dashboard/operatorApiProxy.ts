import { NextRequest, NextResponse } from "next/server";

// Server-only proxy: attaches OPERATOR_SECRET to the internal request so the
// dashboard's client-side code never sees it. Forwards the upstream status
// and JSON body as-is (401/404/409/etc.) rather than masking them.

function resolveUpstreamBase(request: NextRequest): string {
  // request.url can resolve to a raw per-deployment URL (e.g.
  // betpilot-xxxxx.vercel.app) instead of the public production alias —
  // Vercel Deployment Protection gates those raw URLs behind an SSO login
  // page, so an internal fetch built from request.url can get back an HTML
  // login page instead of our API's JSON (this caused a real incident:
  // "SyntaxError: Unexpected token '<', \"<!DOCTYPE \"...").
  // VERCEL_PROJECT_PRODUCTION_URL is the stable, unprotected production
  // domain and is always set on Vercel; fall back to request.url's own
  // origin for local dev, where that env var doesn't exist.
  const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return productionUrl ? `https://${productionUrl}` : new URL(request.url).origin;
}

export async function proxyToOperatorApi(
  request: NextRequest,
  path: string,
  init?: RequestInit,
): Promise<NextResponse> {
  const upstreamUrl = new URL(path, resolveUpstreamBase(request));

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${process.env.OPERATOR_SECRET}`,
      },
      cache: "no-store",
    });

    const contentType = upstreamResponse.headers.get("content-type") ?? "";

    if (!contentType.includes("application/json")) {
      const bodyText = await upstreamResponse.text();
      console.error(
        `Dashboard proxy to ${path} got a non-JSON response ` +
          `(status ${upstreamResponse.status}, content-type "${contentType}"): ` +
          bodyText.slice(0, 500),
      );
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    const body = await upstreamResponse.json();

    return NextResponse.json(body, { status: upstreamResponse.status });
  } catch (err) {
    console.error(`Dashboard proxy to ${path} failed:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
