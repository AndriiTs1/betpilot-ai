import { NextRequest } from "next/server";
import { proxyToOperatorApi } from "@/lib/dashboard/operatorApiProxy";
import { requireOperatorApi } from "@/lib/auth/requireOperator";

// Same thin proxy shape as confirm/reject/settle's dashboard routes — no
// request body to forward (the internal route takes no input beyond the
// path's own bet id).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOperatorApi(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  return proxyToOperatorApi(request, `/api/bets/${id}/settlement-retry`, { method: "POST" });
}
