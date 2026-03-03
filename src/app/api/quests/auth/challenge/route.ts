import { NextResponse } from "next/server";

import { issueWalletChallenge } from "@backend/quests/auth";

import { toErrorResponse } from "../../_shared";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const address = String(url.searchParams.get("address") ?? "").trim();

    if (!address) {
      return NextResponse.json({ error: "address is required" }, { status: 400 });
    }

    const challenge = await issueWalletChallenge(address);
    return NextResponse.json({ challenge });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const address = String(body.address ?? "").trim();

    if (!address) {
      return NextResponse.json({ error: "address is required" }, { status: 400 });
    }

    const challenge = await issueWalletChallenge(address);
    return NextResponse.json({ challenge });
  } catch (error) {
    return toErrorResponse(error);
  }
}
