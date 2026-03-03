import { NextResponse } from "next/server";

import { authenticateRequest, QuestAuthError } from "@backend/quests/auth";
import { QuestError } from "@backend/quests/service";

export function toErrorResponse(error: unknown) {
  if (error instanceof QuestAuthError || error instanceof QuestError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }

  return NextResponse.json(
    {
      error: error instanceof Error ? error.message : "Unexpected quests error"
    },
    { status: 500 }
  );
}

export async function requireAuth(request: Request): Promise<{ userId: string; address: string }> {
  return authenticateRequest(request);
}
