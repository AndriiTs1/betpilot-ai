import { NextRequest, NextResponse } from "next/server";

import { processBet } from "@/lib/bets/betService";

export async function POST(request: NextRequest) {
  const body = await request.json();

  const result = processBet(body);

  return NextResponse.json(result);
}
