import { NextRequest } from "next/server";
import { proxyToOperatorApi } from "@/lib/dashboard/operatorApiProxy";

export async function GET(request: NextRequest) {
  return proxyToOperatorApi(request, "/api/bets/history");
}
