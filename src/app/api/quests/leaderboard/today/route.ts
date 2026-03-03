import { NextResponse } from "next/server";

import { getTodayLeaderboard } from "@backend/quests/service";

import { toErrorResponse } from "../../_shared";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const rawLimit = Number(url.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 20;

    const leaderboard = await getTodayLeaderboard(limit);
    return NextResponse.json({ leaderboard });
  } catch (error) {
    return toErrorResponse(error);
  }
}
