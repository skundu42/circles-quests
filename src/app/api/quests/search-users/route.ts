import { NextResponse } from "next/server";
import { CirclesRpc } from "@aboutcircles/sdk-rpc";

import { requireAuth, toErrorResponse } from "../_shared";

export const runtime = "nodejs";

const DEFAULT_CIRCLES_RPC_URL = "https://rpc.aboutcircles.com/";

function getRpc(): CirclesRpc {
  const url =
    process.env.CIRCLES_RPC_URL || process.env.NEXT_PUBLIC_CIRCLES_RPC_URL || DEFAULT_CIRCLES_RPC_URL;
  return new CirclesRpc(url);
}

export async function GET(request: Request) {
  try {
    await requireAuth(request);

    const url = new URL(request.url);
    const query = String(url.searchParams.get("q") || "").trim();
    const requestedLimit = Number(url.searchParams.get("limit") || "8");
    const limit = Number.isFinite(requestedLimit) ? Math.min(20, Math.max(1, requestedLimit)) : 8;

    if (query.length < 2) {
      return NextResponse.json({ users: [] });
    }

    const rpc = getRpc();
    const rows = await rpc.profile.searchProfiles(query, limit, 0);

    const users = rows
      .map((row) => {
        const address = String(row.address || "").toLowerCase();
        if (!address || !address.startsWith("0x")) {
          return null;
        }

        return {
          address,
          name: String(row.name || "Unnamed"),
          imageUrl: row.imageUrl ? String(row.imageUrl) : row.previewImageUrl ? String(row.previewImageUrl) : null,
          avatarType: row.avatarType ? String(row.avatarType) : null,
          description: row.description ? String(row.description) : ""
        };
      })
      .filter(Boolean);

    return NextResponse.json({ users });
  } catch (error) {
    return toErrorResponse(error);
  }
}
