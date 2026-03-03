import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { isAddress, type Address } from "viem";

import { getPublicClient, normalizeAddress } from "./chain";
import { getSupabaseClient, questsAuthChallengesTable } from "./db";

export class QuestAuthError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 401) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface AuthTokenPayload {
  sub: string;
  address: string;
  iat: number;
  exp: number;
  iss: string;
}

interface AuthChallengeRow {
  id: string;
  address: string;
  nonce: string;
  message: string;
  issued_at: string;
  expires_at: string;
  status: "issued" | "used" | "expired";
  used_at: string | null;
  created_at: string;
  updated_at: string;
}

const TOKEN_ISSUER = "circles-quests";
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_SECONDS = 24 * 60 * 60;

function getAuthSecret(): string {
  return process.env.QUEST_AUTH_SECRET || process.env.NEXTAUTH_SECRET || "dev-only-secret";
}

function base64url(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromBase64url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 ? "=".repeat(4 - (normalized.length % 4)) : "";
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function sign(data: string): string {
  const signature = createHmac("sha256", getAuthSecret()).update(data).digest("base64");
  return signature.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function createToken(payload: AuthTokenPayload): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = sign(`${encodedHeader}.${encodedPayload}`);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function decodeToken(token: string): AuthTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = sign(`${encodedHeader}.${encodedPayload}`);
  if (signature !== expected) {
    return null;
  }

  try {
    const header = JSON.parse(fromBase64url(encodedHeader)) as { alg?: string; typ?: string };
    if (header.alg !== "HS256" || header.typ !== "JWT") {
      return null;
    }

    const payload = JSON.parse(fromBase64url(encodedPayload)) as Partial<AuthTokenPayload>;
    if (
      payload.iss !== TOKEN_ISSUER ||
      !payload.sub ||
      !payload.address ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) {
      return null;
    }

    return payload as AuthTokenPayload;
  } catch {
    return null;
  }
}

async function expireStaleChallenges(nowIso: string) {
  const client = getSupabaseClient();
  const { error } = await client
    .from(questsAuthChallengesTable())
    .update({ status: "expired", updated_at: nowIso })
    .eq("status", "issued")
    .lte("expires_at", nowIso);

  if (error) {
    throw new Error(`Supabase challenge expiry failed: ${error.message}`);
  }
}

async function saveAuthChallenge(row: AuthChallengeRow) {
  const client = getSupabaseClient();
  const { error } = await client.from(questsAuthChallengesTable()).insert(row);

  if (error) {
    throw new Error(`Supabase challenge insert failed: ${error.message}`);
  }
}

async function getAuthChallengeById(id: string): Promise<AuthChallengeRow | null> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from(questsAuthChallengesTable())
    .select("id,address,nonce,message,issued_at,expires_at,status,used_at,created_at,updated_at")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase challenge fetch failed: ${error.message}`);
  }

  return (data as AuthChallengeRow | null) ?? null;
}

async function consumeAuthChallenge(id: string, nowIso: string): Promise<AuthChallengeRow | null> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from(questsAuthChallengesTable())
    .update({
      status: "used",
      used_at: nowIso,
      updated_at: nowIso
    })
    .eq("id", id)
    .eq("status", "issued")
    .select("id,address,nonce,message,issued_at,expires_at,status,used_at,created_at,updated_at")
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase challenge consume failed: ${error.message}`);
  }

  return (data as AuthChallengeRow | null) ?? null;
}

export async function issueWalletChallenge(address: string): Promise<{
  challengeId: string;
  message: string;
  expiresAt: string;
}> {
  if (!isAddress(address)) {
    throw new QuestAuthError("address is invalid", 400);
  }

  const normalized = normalizeAddress(address);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  await expireStaleChallenges(nowIso);

  const issuedAt = nowIso;
  const expiresAt = new Date(now + CHALLENGE_TTL_MS).toISOString();
  const challengeId = randomUUID();
  const nonce = randomBytes(16).toString("hex");

  const message = [
    "Circles Quests login",
    `Address: ${normalized}`,
    `Nonce: ${nonce}`,
    `Challenge ID: ${challengeId}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`
  ].join("\n");

  await saveAuthChallenge({
    id: challengeId,
    address: normalized,
    nonce,
    message,
    issued_at: issuedAt,
    expires_at: expiresAt,
    status: "issued",
    used_at: null,
    created_at: issuedAt,
    updated_at: issuedAt
  });

  return {
    challengeId,
    message,
    expiresAt
  };
}

export async function verifyWalletChallenge(params: {
  address: string;
  challengeId: string;
  signature: string;
}): Promise<{ token: string; expiresAt: string }> {
  if (!isAddress(params.address)) {
    throw new QuestAuthError("address is invalid", 400);
  }

  const normalizedAddress = normalizeAddress(params.address) as Address;
  const challengeId = params.challengeId.trim();
  const signature = params.signature.trim();

  if (!challengeId || !signature) {
    throw new QuestAuthError("challengeId and signature are required", 400);
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  await expireStaleChallenges(nowIso);

  const challenge = await getAuthChallengeById(challengeId);
  if (!challenge) {
    throw new QuestAuthError("challenge not found", 404);
  }

  if (challenge.status !== "issued") {
    throw new QuestAuthError("challenge already used", 409);
  }

  if (normalizeAddress(challenge.address) !== normalizedAddress) {
    throw new QuestAuthError("challenge/address mismatch", 403);
  }

  if (Date.parse(challenge.expires_at) <= now) {
    throw new QuestAuthError("challenge expired", 401);
  }

  const client = getPublicClient();
  const isValidSignature = await client.verifyMessage({
    address: normalizedAddress,
    message: challenge.message,
    signature: signature as `0x${string}`
  });

  if (!isValidSignature) {
    throw new QuestAuthError("signature verification failed", 401);
  }

  const consumed = await consumeAuthChallenge(challenge.id, nowIso);
  if (!consumed || consumed.status !== "used") {
    throw new QuestAuthError("could not consume challenge", 409);
  }

  const nowSeconds = Math.floor(now / 1000);
  const exp = nowSeconds + TOKEN_TTL_SECONDS;

  const token = createToken({
    sub: normalizedAddress,
    address: normalizedAddress,
    iat: nowSeconds,
    exp,
    iss: TOKEN_ISSUER
  });

  return {
    token,
    expiresAt: new Date(exp * 1000).toISOString()
  };
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) {
    return null;
  }

  const [kind, value] = header.split(" ");
  if ((kind ?? "").toLowerCase() !== "bearer" || !value) {
    return null;
  }

  return value.trim();
}

export async function authenticateRequest(request: Request): Promise<{ userId: string; address: string }> {
  const token = readBearerToken(request);
  if (!token) {
    throw new QuestAuthError("missing bearer token", 401);
  }

  const payload = decodeToken(token);
  if (!payload) {
    throw new QuestAuthError("invalid or expired token", 401);
  }

  return {
    userId: payload.sub,
    address: normalizeAddress(payload.address)
  };
}
