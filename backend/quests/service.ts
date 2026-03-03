import { CirclesRpc } from "@aboutcircles/sdk-rpc";
import type { TransactionHistoryRow } from "@aboutcircles/sdk-rpc";
import { Core, circlesConfig } from "@aboutcircles/sdk-core";
import { isAddress, parseUnits, type Address } from "viem";

import {
  findRecipientTransferByTxHash,
  getRoundWindow,
  normalizeAddress,
  verifyTxAfterRoundStart
} from "@backend/quests/chain";
import { getCompletionByQuest, listCompletionsByDate, listCompletionsByDateAddress, upsertCompletion } from "./store";
import { buildAddTrustAction, buildCreateGroupAction, buildJoinGroupAction, buildPaymentAction } from "./tx-builder";
import type {
  PreparedQuestAction,
  QuestCompletion,
  QuestDefinition,
  QuestId,
  QuestLeaderboardEntry,
  TodayQuestsPayload,
  UserQuestItem
} from "./types";

const DEFAULT_CIRCLES_RPC_URL = "https://rpc.aboutcircles.com/";
const MIN_CONFIRMATIONS = Number(process.env.QUEST_MIN_CONFIRMATIONS || "1");

const SEND_MIN_CRC = process.env.QUEST_SEND_MIN_CRC || "5";
const SEND_EXECUTION_CRC = process.env.QUEST_SEND_EXECUTION_CRC || "5.1";
const GCRC_MINT_AMOUNT_CRC = process.env.QUEST_GCRC_MINT_AMOUNT_CRC || "5";
const GCRC_GROUP_ADDRESS = "0xc19bc204eb1c1d5b3fe500e5e5dfabab625f286c" as Address;

const BLACKLIST_API_URL =
  "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/blacklist?include_reason=false&v2_only=true";
const BLACKLIST_CACHE_TTL_MS = 5 * 60 * 1000;
const GROUP_IMAGE_MAX_INPUT_CHARS = Number(process.env.QUEST_GROUP_IMAGE_MAX_INPUT_CHARS || "700000");

let blacklistCache: { expiresAt: number; addresses: Set<string> } | null = null;

const QUESTS: QuestDefinition[] = [
  {
    id: "add-trust",
    title: "Add Trust",
    description: "Search for a Circles user and add a trust edge.",
    xp: 70,
    inputFields: [
      {
        id: "targetAddress",
        label: "Circles User",
        type: "address",
        placeholder: "Search and pick, or paste address",
        required: true
      }
    ]
  },
  {
    id: "mutual-trust-3plus",
    title: "More Than 3 Mutual Trusts",
    description: "Have more than 3 mutual trust relationships.",
    xp: 120,
    inputFields: []
  },
  {
    id: "send-5-crc",
    title: "Send More Than 5 CRC",
    description: "Send more than 5 CRC to any Circles avatar.",
    xp: 140,
    inputFields: [
      {
        id: "recipientAddress",
        label: "Recipient Address",
        type: "address",
        placeholder: "0x...",
        required: true
      }
    ]
  },
  {
    id: "mint-5-gcrc",
    title: "Mint 5 gCRC",
    description: "Mint 5 gCRC for the fixed Gnosis group.",
    xp: 160,
    inputFields: []
  },
  {
    id: "create-group",
    title: "Create a Group",
    description: "Create a new group with name, description, and image.",
    xp: 190,
    inputFields: [
      {
        id: "groupName",
        label: "Group Name",
        type: "text",
        placeholder: "Builders Guild",
        required: true
      },
      {
        id: "groupDescription",
        label: "Description",
        type: "text",
        placeholder: "What the group is about",
        required: true
      },
      {
        id: "groupImageUrl",
        label: "Group Image",
        type: "image",
        placeholder: "Upload group image",
        required: true
      }
    ]
  },
  {
    id: "no-blacklisted-trusts",
    title: "No Blacklisted Trusts",
    description: "Verify you currently trust no blacklisted addresses.",
    xp: 150,
    inputFields: []
  }
];

const QUEST_ORDER: QuestId[] = [
  "add-trust",
  "mutual-trust-3plus",
  "send-5-crc",
  "mint-5-gcrc",
  "create-group",
  "no-blacklisted-trusts"
];

export class QuestError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function getRpc(): CirclesRpc {
  const url =
    process.env.CIRCLES_RPC_URL || process.env.NEXT_PUBLIC_CIRCLES_RPC_URL || DEFAULT_CIRCLES_RPC_URL;
  return new CirclesRpc(url);
}

function getCore(): Core {
  const rpcUrl =
    process.env.CIRCLES_RPC_URL || process.env.NEXT_PUBLIC_CIRCLES_RPC_URL || DEFAULT_CIRCLES_RPC_URL;
  return new Core({
    ...circlesConfig[100],
    circlesRpcUrl: rpcUrl
  });
}

function getQuestOrThrow(questId: string): QuestDefinition {
  const quest = QUESTS.find((item) => item.id === questId);
  if (!quest) {
    throw new QuestError("Quest not found", 404);
  }
  return quest;
}

function validateAddress(value: string, fieldName: string): Address {
  const trimmed = String(value || "").trim();
  if (!isAddress(trimmed)) {
    throw new QuestError(`${fieldName} is invalid`, 400);
  }
  return normalizeAddress(trimmed) as Address;
}

function parseAmountCRC(raw: unknown, fallback: string): string {
  const input = String(raw ?? "").trim();
  const value = input || fallback;

  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(value)) {
    throw new QuestError("Amount must be a decimal string with up to 18 decimals", 400);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new QuestError("Amount must be greater than 0", 400);
  }

  return value;
}

function isValidGroupImageInput(value: string): boolean {
  if (!value) {
    return false;
  }

  if (value.length > GROUP_IMAGE_MAX_INPUT_CHARS) {
    return false;
  }

  const lower = value.toLowerCase();
  if (lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("ipfs://")) {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }

  return /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(value);
}

async function getSignerSafeAddress(signer: Address): Promise<Address> {
  const core = getCore();
  return core.referralsModule.computeAddress(signer);
}

function requiresOnchainProof(questId: QuestId): boolean {
  return (
    questId === "add-trust" ||
    questId === "send-5-crc" ||
    questId === "mint-5-gcrc" ||
    questId === "create-group"
  );
}

function mapQuestStatus(params: {
  quest: QuestDefinition;
  completion?: QuestCompletion;
  unlockWeekday: number;
}): UserQuestItem {
  const { quest, completion, unlockWeekday } = params;
  const isUnlockedToday = true;

  if (!completion) {
    return {
      ...quest,
      status: "available",
      unlockWeekday,
      isUnlockedToday
    };
  }

  if (completion.status === "verified") {
    return {
      ...quest,
      status: "completed",
      unlockWeekday,
      isUnlockedToday,
      completion
    };
  }

  return {
    ...quest,
    status: "failed",
    unlockWeekday,
    isUnlockedToday,
    completion
  };
}

function deriveProgress(items: UserQuestItem[]): TodayQuestsPayload["progress"] {
  const completed = items.filter((item) => item.status === "completed").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const totalXp = items.reduce((sum, item) => {
    if (item.status !== "completed") {
      return sum;
    }
    return sum + item.xp;
  }, 0);

  return {
    completed,
    failed,
    total: items.length,
    totalXp
  };
}

export async function getTodayQuests(address?: string): Promise<TodayQuestsPayload> {
  const window = getRoundWindow();
  const normalizedAddress = address ? validateAddress(address, "address") : null;

  const completions = normalizedAddress
    ? await listCompletionsByDateAddress(window.date, normalizedAddress)
    : [];
  const completionMap = new Map<QuestId, QuestCompletion>(
    completions.map((completion) => [completion.questId, completion])
  );

  const quests = QUEST_ORDER.map((questId, unlockWeekday) => {
    const quest = getQuestOrThrow(questId);
    return mapQuestStatus({
      quest,
      completion: completionMap.get(quest.id),
      unlockWeekday
    });
  });

  return {
    date: window.date,
    startAt: window.startAt,
    endAt: window.endAt,
    quests,
    progress: deriveProgress(quests)
  };
}

async function verifyAddTrust(address: Address, targetAddress: Address): Promise<boolean> {
  const rpc = getRpc();
  const trusts = await rpc.trust.getTrusts(address);
  return trusts.some((relation) => normalizeAddress(relation.objectAvatar) === normalizeAddress(targetAddress));
}

async function getMutualTrustCount(address: Address): Promise<number> {
  const rpc = getRpc();
  const mutuals = await rpc.trust.getMutualTrusts(address);
  return mutuals.length;
}

async function findTransferForQuest(params: {
  txHash: string;
  fromAddress?: Address;
  recipientAddress: Address;
  startAt: string;
}): Promise<TransactionHistoryRow | null> {
  const minTimestamp = Math.floor(Date.parse(params.startAt) / 1000);

  return findRecipientTransferByTxHash({
    recipientAddress: params.recipientAddress,
    txHash: params.txHash,
    expectedFrom: params.fromAddress,
    minTimestamp,
    maxPages: 10
  });
}

async function findTransferForQuestToken(params: {
  txHash: string;
  recipientAddress: Address;
  tokenAddress: Address;
  startAt: string;
}): Promise<TransactionHistoryRow | null> {
  const rpc = getRpc();
  const query = rpc.transaction.getTransactionHistory(params.recipientAddress, 100, "DESC");
  const minTimestamp = Math.floor(Date.parse(params.startAt) / 1000);

  let scanned = 0;
  while (scanned < 10 && (await query.queryNextPage())) {
    scanned += 1;
    const rows = (query.currentPage?.results ?? []) as TransactionHistoryRow[];

    for (const row of rows) {
      if (normalizeAddress(row.transactionHash) !== normalizeAddress(params.txHash)) {
        continue;
      }

      if (Number(row.timestamp) < minTimestamp) {
        continue;
      }

      if (normalizeAddress(row.tokenAddress) !== normalizeAddress(params.tokenAddress)) {
        continue;
      }

      if (normalizeAddress(row.to) !== normalizeAddress(params.recipientAddress)) {
        continue;
      }

      return row;
    }

    if (!query.currentPage?.hasMore) {
      break;
    }
  }

  return null;
}

async function verifyJoinedGroupSinceStart(params: {
  memberAddress: Address;
  groupAddress: Address;
  startAt: string;
  expectedTxHash?: string;
}): Promise<boolean> {
  const rpc = getRpc();
  const startTimestamp = Math.floor(Date.parse(params.startAt) / 1000);
  const query = rpc.group.getGroupMemberships(params.memberAddress, 100, "DESC");

  let scanned = 0;
  while (scanned < 6 && (await query.queryNextPage())) {
    scanned += 1;
    const rows = query.currentPage?.results ?? [];

    for (const row of rows) {
      if (normalizeAddress(row.group) !== normalizeAddress(params.groupAddress)) {
        continue;
      }

      if (Number(row.timestamp) < startTimestamp) {
        continue;
      }

      if (
        params.expectedTxHash &&
        normalizeAddress(row.transactionHash) !== normalizeAddress(params.expectedTxHash)
      ) {
        continue;
      }

      return true;
    }

    if (!query.currentPage?.hasMore) {
      break;
    }
  }

  return false;
}

async function verifyGroupCreatedSinceStart(params: {
  ownerAddress: Address;
  startAt: string;
  txHash: string;
  expectedName?: string;
}): Promise<{ ok: boolean; groupAddress?: string; name?: string }> {
  const rpc = getRpc();
  const startTimestamp = Math.floor(Date.parse(params.startAt) / 1000);
  const groups = await rpc.group.findGroups(100, {
    ownerIn: [params.ownerAddress]
  });

  const matched = groups.find((group) => {
    if (Number(group.timestamp) < startTimestamp) {
      return false;
    }

    if (normalizeAddress(group.transactionHash) !== normalizeAddress(params.txHash)) {
      return false;
    }

    if (params.expectedName && String(group.name || "").trim() !== params.expectedName) {
      return false;
    }

    return true;
  });

  if (!matched) {
    return { ok: false };
  }

  return {
    ok: true,
    groupAddress: matched.group,
    name: matched.name
  };
}

async function loadBlacklistedAddresses(): Promise<Set<string>> {
  const now = Date.now();
  if (blacklistCache && blacklistCache.expiresAt > now) {
    return blacklistCache.addresses;
  }

  const response = await fetch(BLACKLIST_API_URL, {
    headers: {
      accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Blacklist API failed with status ${response.status}`);
  }

  const payload = (await response.json()) as unknown;

  let rawList: unknown[] = [];
  if (Array.isArray(payload)) {
    rawList = payload;
  } else if (payload && typeof payload === "object") {
    const maybeObject = payload as Record<string, unknown>;
    if (Array.isArray(maybeObject.addresses)) {
      rawList = maybeObject.addresses;
    }
  }

  const addresses = new Set<string>();
  for (const value of rawList) {
    const candidate = String(value || "").trim().toLowerCase();
    if (candidate && isAddress(candidate)) {
      addresses.add(candidate);
    }
  }

  blacklistCache = {
    expiresAt: now + BLACKLIST_CACHE_TTL_MS,
    addresses
  };

  return addresses;
}

async function verifyNoBlacklistedTrusts(address: Address): Promise<{
  ok: boolean;
  trustedCount: number;
  blacklistedMatches: string[];
  blacklistSize: number;
}> {
  const rpc = getRpc();
  const [trusts, blacklist] = await Promise.all([rpc.trust.getTrusts(address), loadBlacklistedAddresses()]);

  const trusted = trusts
    .map((relation) => normalizeAddress(relation.objectAvatar))
    .filter((item) => isAddress(item));

  const matches = trusted.filter((trustedAddress) => blacklist.has(trustedAddress));

  return {
    ok: matches.length === 0,
    trustedCount: trusted.length,
    blacklistedMatches: matches,
    blacklistSize: blacklist.size
  };
}

function readInput(input: Record<string, unknown> | undefined, key: string): string {
  if (!input) {
    return "";
  }

  const value = input[key];
  return String(value ?? "").trim();
}

function humanizeVerificationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes("older than round start")) {
    return "This transaction is from before today's quest window started. Submit a new transaction.";
  }

  if (normalized.includes("sender does not match")) {
    return "Transaction sender does not match your connected wallet.";
  }

  if (normalized.includes("confirmations")) {
    return "Transaction is still confirming. Please retry in a moment.";
  }

  if (normalized.includes("not found")) {
    return "Transaction could not be verified onchain yet. Please retry shortly.";
  }

  return message;
}

export async function prepareQuestAction(params: {
  address: string;
  questId: string;
  input?: Record<string, unknown>;
}): Promise<PreparedQuestAction> {
  const address = validateAddress(params.address, "address");
  const quest = getQuestOrThrow(params.questId);
  const window = getRoundWindow();

  const existing = await getCompletionByQuest(window.date, address, quest.id);
  if (existing?.status === "verified") {
    throw new QuestError("Quest already completed for today", 409);
  }

  if (quest.id === "add-trust") {
    const targetAddress = validateAddress(readInput(params.input, "targetAddress"), "targetAddress");
    return {
      questId: quest.id,
      summary: `Add trust to ${targetAddress}`,
      hostTransactions: await buildAddTrustAction({
        actorAddress: address,
        targetAddress
      })
    };
  }

  if (quest.id === "mutual-trust-3plus") {
    return {
      questId: quest.id,
      summary: "No transaction needed. We will verify your mutual trust count.",
      hostTransactions: []
    };
  }

  if (quest.id === "send-5-crc") {
    const recipientAddress = validateAddress(readInput(params.input, "recipientAddress"), "recipientAddress");
    const amountCRC = parseAmountCRC(readInput(params.input, "amountCRC"), SEND_EXECUTION_CRC);

    const minAmount = parseUnits(SEND_MIN_CRC, 18);
    const requestedAmount = parseUnits(amountCRC, 18);
    if (requestedAmount <= minAmount) {
      throw new QuestError(`Amount must be greater than ${SEND_MIN_CRC} CRC`, 400);
    }

    return {
      questId: quest.id,
      summary: `Send ${amountCRC} CRC to ${recipientAddress}`,
      hostTransactions: await buildPaymentAction({
        actorAddress: address,
        recipientAddress,
        amountCRC,
        dataTag: `quest:${window.date}:${quest.id}:${address}`
      })
    };
  }

  if (quest.id === "mint-5-gcrc") {
    return {
      questId: quest.id,
      summary: `Mint ${GCRC_MINT_AMOUNT_CRC} gCRC for group ${GCRC_GROUP_ADDRESS}`,
      hostTransactions: await buildJoinGroupAction({
        actorAddress: address,
        groupAddress: GCRC_GROUP_ADDRESS,
        amountCRC: GCRC_MINT_AMOUNT_CRC
      })
    };
  }

  if (quest.id === "create-group") {
    const groupName = readInput(params.input, "groupName");
    const groupDescription = readInput(params.input, "groupDescription");
    const groupImageUrl = readInput(params.input, "groupImageUrl");

    if (!groupName) {
      throw new QuestError("groupName is required", 400);
    }

    if (groupName.length > 19) {
      throw new QuestError("Group name must be 19 characters or fewer", 400);
    }

    if (!groupDescription) {
      throw new QuestError("groupDescription is required", 400);
    }

    if (!groupImageUrl) {
      throw new QuestError("groupImageUrl is required", 400);
    }

    if (!isValidGroupImageInput(groupImageUrl)) {
      throw new QuestError(
        "groupImageUrl must be a valid image URL (http/https/ipfs) or uploaded image payload",
        400
      );
    }

    return {
      questId: quest.id,
      summary: `Deploy Safe + create group \"${groupName}\"`,
      hostTransactions: await buildCreateGroupAction({
        actorAddress: address,
        groupName,
        groupDescription,
        groupImageUrl
      })
    };
  }

  if (quest.id === "no-blacklisted-trusts") {
    return {
      questId: quest.id,
      summary: "No transaction needed. We will verify trusted addresses against the blacklist.",
      hostTransactions: []
    };
  }

  throw new QuestError("Unsupported quest", 400);
}

export async function claimQuest(params: {
  address: string;
  questId: string;
  txHash?: string;
  input?: Record<string, unknown>;
}): Promise<{ completion: QuestCompletion; payload: TodayQuestsPayload }> {
  const address = validateAddress(params.address, "address");
  const quest = getQuestOrThrow(params.questId);
  const window = getRoundWindow();
  const txHash = String(params.txHash || "").trim();
  const needsTx = requiresOnchainProof(quest.id);

  if (needsTx && (!txHash || !txHash.startsWith("0x"))) {
    throw new QuestError("txHash is required", 400);
  }

  const existing = await getCompletionByQuest(window.date, address, quest.id);
  if (existing?.status === "verified") {
    return {
      completion: existing,
      payload: await getTodayQuests(address)
    };
  }

  let verified = false;
  let reason = "Verification failed";
  let proof: Record<string, unknown> = {};

  try {
    if (needsTx) {
      const tx = await verifyTxAfterRoundStart({
        txHash,
        expectedFrom: address,
        roundStartAt: window.startAt,
        minConfirmations: MIN_CONFIRMATIONS
      });

      proof.tx = tx;
    }

    if (quest.id === "add-trust") {
      const targetAddress = validateAddress(readInput(params.input, "targetAddress"), "targetAddress");
      verified = await verifyAddTrust(address, targetAddress);
      reason = verified ? "ok" : "Trust edge does not exist yet";
      proof.targetAddress = targetAddress;
    } else if (quest.id === "mutual-trust-3plus") {
      const count = await getMutualTrustCount(address);
      verified = count > 3;
      reason = verified ? "ok" : "Need more than 3 mutual trusts";
      proof.mutualTrustCount = count;
    } else if (quest.id === "send-5-crc") {
      const recipientAddress = validateAddress(readInput(params.input, "recipientAddress"), "recipientAddress");
      const transfer = await findTransferForQuest({
        txHash,
        recipientAddress,
        startAt: window.startAt
      });

      if (!transfer) {
        reason = "Transfer to the selected recipient was not found";
      } else {
        const amountAtto = transfer.attoCircles ?? BigInt(transfer.value);
        const minAtto = parseUnits(SEND_MIN_CRC, 18);

        verified = amountAtto > minAtto;
        reason = verified ? "ok" : `Transfer amount must be greater than ${SEND_MIN_CRC} CRC`;

        proof.recipientAddress = recipientAddress;
        proof.transferTimestamp = transfer.timestamp;
        proof.transferBlockNumber = transfer.blockNumber;
        proof.transferAmountAttoCircles = amountAtto.toString();
        proof.minRequiredAttoCircles = minAtto.toString();
      }
    } else if (quest.id === "mint-5-gcrc") {
      const transfer = await findTransferForQuestToken({
        txHash,
        recipientAddress: address,
        tokenAddress: GCRC_GROUP_ADDRESS,
        startAt: window.startAt
      });

      if (!transfer) {
        reason = "No qualifying gCRC mint transfer found for this transaction";
      } else {
        const amountAtto = transfer.attoCircles ?? BigInt(transfer.value);
        const minAtto = parseUnits(GCRC_MINT_AMOUNT_CRC, 18);

        const joinedGroup = await verifyJoinedGroupSinceStart({
          memberAddress: address,
          groupAddress: GCRC_GROUP_ADDRESS,
          startAt: window.startAt,
          expectedTxHash: txHash
        });

        verified = amountAtto >= minAtto && joinedGroup;

        if (!joinedGroup) {
          reason = "Group membership for the required gCRC group was not found in this round";
        } else if (amountAtto < minAtto) {
          reason = `Mint amount is below ${GCRC_MINT_AMOUNT_CRC} gCRC`;
        } else {
          reason = "ok";
        }

        proof.groupAddress = GCRC_GROUP_ADDRESS;
        proof.transferTokenAddress = transfer.tokenAddress;
        proof.transferAmountAttoCircles = amountAtto.toString();
        proof.minRequiredAttoCircles = minAtto.toString();
        proof.joinedGroup = joinedGroup;
      }
    } else if (quest.id === "create-group") {
      const expectedName = readInput(params.input, "groupName");
      const expectedOwner = await getSignerSafeAddress(address);
      const creation = await verifyGroupCreatedSinceStart({
        ownerAddress: expectedOwner,
        startAt: window.startAt,
        txHash,
        expectedName: expectedName || undefined
      });

      verified = creation.ok;
      reason = verified ? "ok" : "Group creation not indexed yet or transaction does not match";
      proof.groupOwner = expectedOwner;
      proof.groupAddress = creation.groupAddress ?? null;
      proof.groupName = creation.name ?? null;
    } else if (quest.id === "no-blacklisted-trusts") {
      const result = await verifyNoBlacklistedTrusts(address);
      verified = result.ok;
      reason = verified
        ? "ok"
        : `You currently trust ${result.blacklistedMatches.length} blacklisted address(es).`;
      proof.trustedCount = result.trustedCount;
      proof.blacklistSize = result.blacklistSize;
      proof.blacklistedMatches = result.blacklistedMatches;
    }
  } catch (error) {
    reason = humanizeVerificationError(error);
  }

  const completion = await upsertCompletion({
    date: window.date,
    address,
    questId: quest.id,
    status: verified ? "verified" : "rejected",
    txHash: txHash ? normalizeAddress(txHash) : "0x",
    input: params.input ?? {},
    proof,
    verifiedAt: verified ? new Date().toISOString() : undefined,
    rejectedAt: verified ? undefined : new Date().toISOString(),
    rejectedReason: verified ? undefined : reason
  });

  return {
    completion,
    payload: await getTodayQuests(address)
  };
}

async function resolveLeaderboardAvatarNames(addresses: string[]): Promise<Map<string, string>> {
  const unique = Array.from(
    new Set(addresses.map((address) => normalizeAddress(address)).filter((address) => isAddress(address)))
  );
  if (!unique.length) {
    return new Map();
  }

  try {
    const rpc = getRpc();
    const profiles = await rpc.profile.getProfileByAddressBatch(unique as Address[]);
    const names = new Map<string, string>();

    unique.forEach((address, index) => {
      const row = profiles[index] as Record<string, unknown> | null | undefined;
      const name = typeof row?.name === "string" ? row.name.trim() : "";
      if (name) {
        names.set(address, name);
      }
    });

    return names;
  } catch {
    return new Map();
  }
}

export async function getTodayLeaderboard(limit: number = 20): Promise<QuestLeaderboardEntry[]> {
  const window = getRoundWindow();
  const completions = await listCompletionsByDate(window.date);

  const buckets = new Map<string, { completed: number; totalXp: number }>();

  for (const completion of completions) {
    if (completion.status !== "verified") {
      continue;
    }

    const quest = QUESTS.find((item) => item.id === completion.questId);
    if (!quest) {
      continue;
    }

    const key = normalizeAddress(completion.address);
    if (!buckets.has(key)) {
      buckets.set(key, {
        completed: 0,
        totalXp: 0
      });
    }

    const bucket = buckets.get(key)!;
    bucket.completed += 1;
    bucket.totalXp += quest.xp;
  }

  const ranked = Array.from(buckets.entries())
    .map(([address, value]) => ({ address, ...value }))
    .sort((a, b) => {
      if (b.totalXp !== a.totalXp) {
        return b.totalXp - a.totalXp;
      }
      return b.completed - a.completed;
    })
    .slice(0, Math.max(1, limit));

  const avatarNames = await resolveLeaderboardAvatarNames(ranked.map((item) => item.address));

  return ranked.map((item, index) => ({
    rank: index + 1,
    address: item.address,
    avatarName: avatarNames.get(item.address) ?? null,
    completed: item.completed,
    totalXp: item.totalXp
  }));
}
