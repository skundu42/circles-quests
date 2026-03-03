import { NextResponse } from "next/server";

import { getTodayQuests } from "@backend/quests/service";

import { requireAuth, toErrorResponse } from "../_shared";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const hasAuthHeader = Boolean(
      request.headers.get("authorization") ?? request.headers.get("Authorization")
    );

    const payload = hasAuthHeader
      ? await getTodayQuests((await requireAuth(request)).address)
      : await getTodayQuests();

    return NextResponse.json({ payload });
  } catch (error) {
    return toErrorResponse(error);
  }
}
