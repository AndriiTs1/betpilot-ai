import { NextRequest } from "next/server";
import { proxyToOperatorApi } from "@/lib/dashboard/operatorApiProxy";
import { requireOperatorApi } from "@/lib/auth/requireOperator";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOperatorApi(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  return proxyToOperatorApi(request, `/api/bets/${id}/reject`, { method: "POST" });
}
