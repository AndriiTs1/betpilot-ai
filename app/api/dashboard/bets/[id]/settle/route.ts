import { NextRequest } from "next/server";
import { proxyToOperatorApi } from "@/lib/dashboard/operatorApiProxy";
import { requireOperatorApi } from "@/lib/auth/requireOperator";

// Same thin proxy shape as confirm/reject's dashboard routes — no new
// routing convention. Unlike confirm/reject (which have no request body),
// this route forwards the raw JSON body through unchanged (never
// re-parsed/re-validated here) — that's handleSettleBet's job on the
// internal route, not this proxy's.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOperatorApi(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const body = await request.text();

  return proxyToOperatorApi(request, `/api/bets/${id}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
