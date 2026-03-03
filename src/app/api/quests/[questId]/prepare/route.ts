import { NextResponse } from "next/server";

import { prepareQuestAction } from "@backend/quests/service";

import { requireAuth, toErrorResponse } from "../../_shared";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: { questId: string } }
) {
  try {
    const auth = await requireAuth(request);
    const body = (await request.json()) as Record<string, unknown>;

    const input =
      body.input && typeof body.input === "object" && !Array.isArray(body.input)
        ? (body.input as Record<string, unknown>)
        : undefined;

    const action = await prepareQuestAction({
      address: auth.address,
      questId: params.questId,
      input
    });

    return NextResponse.json({ action });
  } catch (error) {
    return toErrorResponse(error);
  }
}
