import { NextRequest } from "next/server";
import { proxyToOperatorApi } from "@/lib/dashboard/operatorApiProxy";
import { requireOperatorApi } from "@/lib/auth/requireOperator";

// Same thin proxy shape as every other dashboard GET-list route
// (app/api/dashboard/bets/pending/route.ts, .../history/route.ts) — real
// per-operator session auth here, forwards to the internal
// GET /api/bets/needs-review (OPERATOR_SECRET attached server-side by
// proxyToOperatorApi, never exposed to the browser). Query params
// (limit/offset) are forwarded as-is via request.url — proxyToOperatorApi
// only needs the path, but the internal route reads its own
// searchParams from `request.url`, so the path itself must carry them.
export async function GET(request: NextRequest) {
  const auth = await requireOperatorApi(request);
  if (!auth.ok) return auth.response;

  const { search } = new URL(request.url);
  return proxyToOperatorApi(request, `/api/bets/needs-review${search}`);
}
