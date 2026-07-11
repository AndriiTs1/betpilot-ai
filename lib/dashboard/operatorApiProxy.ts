import { NextRequest, NextResponse } from "next/server";

// Server-only proxy: attaches OPERATOR_SECRET to the internal request so the
// dashboard's client-side code never sees it. Forwards the upstream status
// and JSON body as-is (401/404/409/etc.) rather than masking them.

export async function proxyToOperatorApi(
  request: NextRequest,
  path: string,
  init?: RequestInit,
): Promise<NextResponse> {
  const upstreamUrl = new URL(path, request.url);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${process.env.OPERATOR_SECRET}`,
      },
      cache: "no-store",
    });

    const body = await upstreamResponse.json();

    return NextResponse.json(body, { status: upstreamResponse.status });
  } catch (err) {
    console.error(`Dashboard proxy to ${path} failed:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
