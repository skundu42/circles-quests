import { randomUUID } from "node:crypto";

import { getSupabaseClient, questsCompletionsTable } from "./db";
import type { QuestCompletion, QuestId } from "./types";

interface QuestCompletionRow {
  id: string;
  date: string;
  address: string;
  quest_id: QuestId;
  status: "verified" | "rejected";
  tx_hash: string;
  input: Record<string, unknown>;
  proof: Record<string, unknown>;
  verified_at: string | null;
  rejected_at: string | null;
  rejected_reason: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function rowToCompletion(row: QuestCompletionRow): QuestCompletion {
  return {
    id: row.id,
    date: row.date,
    address: normalizeAddress(row.address),
    questId: row.quest_id,
    status: row.status,
    txHash: row.tx_hash,
    input: row.input ?? {},
    proof: row.proof ?? {},
    verifiedAt: row.verified_at ?? undefined,
    rejectedAt: row.rejected_at ?? undefined,
    rejectedReason: row.rejected_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function queryRows(params: {
  date?: string;
  address?: string;
  questId?: QuestId;
}): Promise<QuestCompletion[]> {
  const client = getSupabaseClient();
  let query = client
    .from(questsCompletionsTable())
    .select(
      "id,date,address,quest_id,status,tx_hash,input,proof,verified_at,rejected_at,rejected_reason,created_at,updated_at"
    )
    .order("created_at", { ascending: false });

  if (params.date) {
    query = query.eq("date", params.date);
  }

  if (params.address) {
    query = query.eq("address", normalizeAddress(params.address));
  }

  if (params.questId) {
    query = query.eq("quest_id", params.questId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Supabase quest query failed: ${error.message}`);
  }

  return ((data ?? []) as QuestCompletionRow[]).map(rowToCompletion);
}

export async function listCompletionsByDateAddress(date: string, address: string): Promise<QuestCompletion[]> {
  return queryRows({ date, address });
}

export async function getCompletionByQuest(date: string, address: string, questId: QuestId): Promise<QuestCompletion | null> {
  const rows = await queryRows({
    date,
    address,
    questId
  });

  return rows[0] ?? null;
}

export async function upsertCompletion(
  record: Omit<QuestCompletion, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: string }
): Promise<QuestCompletion> {
  const client = getSupabaseClient();
  const now = new Date().toISOString();

  const row: QuestCompletionRow = {
    id: record.id ?? randomUUID(),
    date: record.date,
    address: normalizeAddress(record.address),
    quest_id: record.questId,
    status: record.status,
    tx_hash: record.txHash,
    input: (record.input ?? {}) as Record<string, unknown>,
    proof: (record.proof ?? {}) as Record<string, unknown>,
    verified_at: record.verifiedAt ?? null,
    rejected_at: record.rejectedAt ?? null,
    rejected_reason: record.rejectedReason ?? null,
    created_at: record.createdAt ?? now,
    updated_at: now
  };

  const { data, error } = await client
    .from(questsCompletionsTable())
    .upsert(row, {
      onConflict: "date,address,quest_id"
    })
    .select(
      "id,date,address,quest_id,status,tx_hash,input,proof,verified_at,rejected_at,rejected_reason,created_at,updated_at"
    )
    .single();

  if (error || !data) {
    throw new Error(`Supabase quest upsert failed: ${error?.message || "missing row"}`);
  }

  return rowToCompletion(data as QuestCompletionRow);
}

export async function listCompletionsByDate(date: string): Promise<QuestCompletion[]> {
  return queryRows({ date });
}
