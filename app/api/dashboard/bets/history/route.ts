import { NextRequest } from "next/server";
import { proxyToOperatorApi } from "@/lib/dashboard/operatorApiProxy";
import { requireOperatorApi } from "@/lib/auth/requireOperator";

export async function GET(request: NextRequest) {
  const auth = await requireOperatorApi(request);
  if (!auth.ok) return auth.response;

  return proxyToOperatorApi(request, "/api/bets/history");
}
