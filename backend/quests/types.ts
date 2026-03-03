export type QuestId =
  | "add-trust"
  | "mutual-trust-3plus"
  | "send-5-crc"
  | "holdings-threshold"
  | "mint-5-gcrc"
  | "no-blacklisted-trusts"
  | "true-builder";

export type QuestStatus = "locked" | "available" | "completed" | "failed";

export interface QuestInputField {
  id: string;
  label: string;
  type: "address" | "amount" | "text" | "url";
  placeholder?: string;
  required: boolean;
}

export interface QuestDefinition {
  id: QuestId;
  title: string;
  description: string;
  xp: number;
  inputFields: QuestInputField[];
}

export interface QuestCompletion {
  id: string;
  date: string;
  address: string;
  questId: QuestId;
  status: "verified" | "rejected";
  txHash: string;
  input: Record<string, unknown>;
  proof: Record<string, unknown>;
  verifiedAt?: string;
  rejectedAt?: string;
  rejectedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuestsStoreState {
  completions: QuestCompletion[];
}

export interface UserQuestItem {
  id: QuestId;
  title: string;
  description: string;
  xp: number;
  inputFields: QuestInputField[];
  status: QuestStatus;
  unlockWeekday: number;
  isUnlockedToday: boolean;
  completion?: QuestCompletion;
}

export interface TodayQuestsPayload {
  date: string;
  startAt: string;
  endAt: string;
  quests: UserQuestItem[];
  progress: {
    completed: number;
    failed: number;
    total: number;
    totalXp: number;
  };
}

export interface QuestLeaderboardEntry {
  rank: number;
  address: string;
  avatarName: string | null;
  completed: number;
  totalXp: number;
}

export interface PreparedQuestAction {
  questId: QuestId;
  hostTransactions: Array<{ to: string; data: `0x${string}`; value: `0x${string}` }>;
  summary: string;
}
