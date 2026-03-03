import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supabaseClient: SupabaseClient | null = null;

function readEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for Supabase-backed quests storage`);
  }
  return value;
}

export function getSupabaseClient(): SupabaseClient {
  if (supabaseClient) {
    return supabaseClient;
  }

  const url = readEnv("SUPABASE_URL");
  const serviceRoleKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");

  supabaseClient = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  return supabaseClient;
}

export function questsCompletionsTable(): string {
  return process.env.SUPABASE_QUEST_COMPLETIONS_TABLE?.trim() || "quest_completions";
}

export function questsAuthChallengesTable(): string {
  return process.env.SUPABASE_QUEST_AUTH_CHALLENGES_TABLE?.trim() || "quest_auth_challenges";
}
