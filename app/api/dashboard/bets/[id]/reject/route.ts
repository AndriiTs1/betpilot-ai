import { NextRequest } from "next/server";
import { proxyToOperatorApi } from "@/lib/dashboard/operatorApiProxy";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return proxyToOperatorApi(request, `/api/bets/${id}/reject`, { method: "POST" });
}
