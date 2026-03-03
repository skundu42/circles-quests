import { NextResponse } from "next/server";

import { claimQuest } from "@backend/quests/service";

import { requireAuth, toErrorResponse } from "../../_shared";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: { questId: string } }
) {
  try {
    const auth = await requireAuth(request);
    const body = (await request.json()) as Record<string, unknown>;

    const txHash = String(body.txHash ?? "").trim();

    const input =
      body.input && typeof body.input === "object" && !Array.isArray(body.input)
        ? (body.input as Record<string, unknown>)
        : undefined;

    const result = await claimQuest({
      address: auth.address,
      questId: params.questId,
      txHash,
      input
    });

    return NextResponse.json({ result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
