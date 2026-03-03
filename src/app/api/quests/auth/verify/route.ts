import { NextResponse } from "next/server";

import { verifyWalletChallenge } from "@backend/quests/auth";

import { toErrorResponse } from "../../_shared";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const address = String(body.address ?? "").trim();
    const challengeId = String(body.challengeId ?? "").trim();
    const signature = String(body.signature ?? "").trim();

    const session = await verifyWalletChallenge({
      address,
      challengeId,
      signature
    });

    return NextResponse.json({ session });
  } catch (error) {
    return toErrorResponse(error);
  }
}
