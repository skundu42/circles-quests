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
import { buildAddTrustAction, buildMintGroupAction, buildPaymentAction } from "./tx-builder";
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
const ENFORCE_TX_SENDER_MATCH = String(process.env.QUEST_ENFORCE_TX_SENDER_MATCH || "false").toLowerCase() === "true";

const SEND_MIN_CRC = process.env.QUEST_SEND_MIN_CRC || "5";
const SEND_EXECUTION_CRC = process.env.QUEST_SEND_EXECUTION_CRC || "5.1";
const MUTUAL_TRUST_MIN = Number(process.env.QUEST_MUTUAL_TRUST_MIN || "10");
const MUTUAL_TRUST_BONUS_EVERY = Number(process.env.QUEST_MUTUAL_TRUST_BONUS_EVERY || "20");
const MUTUAL_TRUST_BONUS_XP = Number(process.env.QUEST_MUTUAL_TRUST_BONUS_XP || "10");
const HOLDINGS_MIN_CRC = process.env.QUEST_HOLDINGS_MIN_CRC || "5000";
const HOLDINGS_BONUS_EVERY_CRC = process.env.QUEST_HOLDINGS_BONUS_EVERY_CRC || "1000";
const HOLDINGS_BONUS_XP = Number(process.env.QUEST_HOLDINGS_BONUS_XP || "20");
const GCRC_MINT_AMOUNT_CRC = process.env.QUEST_GCRC_MINT_AMOUNT_CRC || "5";
const GCRC_GROUP_ADDRESS = "0xc19bc204eb1c1d5b3fe500e5e5dfabab625f286c" as Address;
const TRUE_BUILDER_GROUP_ADDRESS = "0x4e2564e5df6c1fb10c1a018538de36e4d5844de5" as Address;

const BLACKLIST_API_URL =
  "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/blacklist?include_reason=false&v2_only=true";
const BLACKLIST_CACHE_TTL_MS = 5 * 60 * 1000;

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
    title: "More Than 10 Mutual Trusts",
    description: `Have more than ${MUTUAL_TRUST_MIN} mutual trust relationships. Earn +${MUTUAL_TRUST_BONUS_XP} XP for every ${MUTUAL_TRUST_BONUS_EVERY} extra mutual trusts.`,
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
      },
      {
        id: "amountCRC",
        label: "Amount (CRC)",
        type: "amount",
        placeholder: "5.1",
        required: true
      }
    ]
  },
  {
    id: "holdings-threshold",
    title: "Holdings Threshold",
    description: `Hold at least ${HOLDINGS_MIN_CRC} CRC in total balance. Earn +${HOLDINGS_BONUS_XP} XP for every extra ${HOLDINGS_BONUS_EVERY_CRC} CRC.`,
    xp: 130,
    inputFields: []
  },
  {
    id: "mint-5-gcrc",
    title: "Mint 5 gCRC",
    description: "Mint 5 gCRC for the fixed Gnosis group.",
    xp: 160,
    inputFields: []
  },
  {
    id: "no-blacklisted-trusts",
    title: "No Blacklisted Trusts",
    description: "Verify you currently trust no blacklisted addresses.",
    xp: 150,
    inputFields: []
  },
  {
    id: "true-builder",
    title: "True builder",
    description: `Verify you are currently a member of group Open Internet Club.`,
    xp: 170,
    inputFields: []
  }
];

const QUEST_ORDER: QuestId[] = [
  "add-trust",
  "mutual-trust-3plus",
  "send-5-crc",
  "holdings-threshold",
  "mint-5-gcrc",
  "no-blacklisted-trusts",
  "true-builder"
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

function requiresOnchainProof(questId: QuestId): boolean {
  return questId === "add-trust" || questId === "send-5-crc" || questId === "mint-5-gcrc";
}

function expectedTxSender(address: Address): Address | undefined {
  return ENFORCE_TX_SENDER_MATCH ? address : undefined;
}

function parseOptionalNonNegativeInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : NaN;

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.floor(parsed);
}

function parseOptionalBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value >= 0n ? value : null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }

    return BigInt(Math.floor(value));
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (!/^\d+$/.test(trimmed)) {
      return null;
    }

    return BigInt(trimmed);
  }

  return null;
}

function getMutualTrustBonusXp(mutualTrustCount: number): number {
  const threshold = Math.max(0, MUTUAL_TRUST_MIN);
  if (mutualTrustCount <= threshold) {
    return 0;
  }

  const extra = mutualTrustCount - threshold;
  const every = Math.max(1, MUTUAL_TRUST_BONUS_EVERY);
  const bonusPerStep = Math.max(0, MUTUAL_TRUST_BONUS_XP);
  const steps = Math.floor(extra / every);

  return steps * bonusPerStep;
}

function getHoldingsBonusXp(totalBalanceAtto: bigint): number {
  const minAtto = parseUnits(HOLDINGS_MIN_CRC, 18);
  if (totalBalanceAtto <= minAtto) {
    return 0;
  }

  const extraAtto = totalBalanceAtto - minAtto;
  const stepAtto = parseUnits(HOLDINGS_BONUS_EVERY_CRC, 18);
  const safeStepAtto = stepAtto > 0n ? stepAtto : 1n;
  const bonusPerStep = Math.max(0, HOLDINGS_BONUS_XP);
  if (bonusPerStep === 0) {
    return 0;
  }

  const steps = extraAtto / safeStepAtto;
  const maxSteps = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / bonusPerStep));
  const clampedSteps = steps > maxSteps ? maxSteps : steps;

  return Number(clampedSteps) * bonusPerStep;
}

function getCompletionAwardedXp(quest: QuestDefinition, completion?: QuestCompletion): number {
  if (!completion || completion.status !== "verified") {
    return 0;
  }

  const proof = completion.proof ?? {};
  const explicitAwardedXp = parseOptionalNonNegativeInteger(proof.awardedXp);
  if (explicitAwardedXp !== null) {
    return explicitAwardedXp;
  }

  if (quest.id === "mutual-trust-3plus") {
    const mutualTrustCount = parseOptionalNonNegativeInteger(proof.mutualTrustCount);
    if (mutualTrustCount !== null) {
      return quest.xp + getMutualTrustBonusXp(mutualTrustCount);
    }
  }

  if (quest.id === "holdings-threshold") {
    const totalBalanceAtto = parseOptionalBigInt(proof.totalBalanceAttoCircles);
    if (totalBalanceAtto !== null) {
      return quest.xp + getHoldingsBonusXp(totalBalanceAtto);
    }
  }

  return quest.xp;
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
      xp: getCompletionAwardedXp(quest, completion),
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
  const core = getCore();
  try {
    return await core.hubV2.isTrusted(address, targetAddress);
  } catch {
    // Fallback to RPC-derived trust graph if direct chain read fails.
    const rpc = getRpc();
    const trusts = await rpc.trust.getTrusts(address);
    const mutuals = await rpc.trust.getMutualTrusts(address);
    const candidates = [...trusts, ...mutuals];
    return candidates.some((relation) => normalizeAddress(relation.objectAvatar) === normalizeAddress(targetAddress));
  }
}

async function findTrustRelationForQuest(params: {
  txHash: string;
  trusterAddress: Address;
  trusteeAddress: Address;
  startAt: string;
}): Promise<{ blockNumber: number; timestamp: number } | null> {
  const rpc = getRpc();
  const query = rpc.trust.getTrustRelations(params.trusterAddress, 100, "DESC");
  const minTimestamp = Math.floor(Date.parse(params.startAt) / 1000);

  let scanned = 0;
  while (scanned < 10 && (await query.queryNextPage())) {
    scanned += 1;
    const rows = (query.currentPage?.results ?? []) as Array<{
      blockNumber: number;
      timestamp: number;
      transactionHash: string;
      truster: string;
      trustee: string;
    }>;

    for (const row of rows) {
      if (normalizeAddress(row.transactionHash) !== normalizeAddress(params.txHash)) {
        continue;
      }

      if (Number(row.timestamp) < minTimestamp) {
        continue;
      }

      if (normalizeAddress(row.truster) !== normalizeAddress(params.trusterAddress)) {
        continue;
      }

      if (normalizeAddress(row.trustee) !== normalizeAddress(params.trusteeAddress)) {
        continue;
      }

      return {
        blockNumber: Number(row.blockNumber),
        timestamp: Number(row.timestamp)
      };
    }

    if (!query.currentPage?.hasMore) {
      break;
    }
  }

  return null;
}

async function wasAlreadyTrustedBeforeTx(params: {
  txHash: string;
  trusterAddress: Address;
  trusteeAddress: Address;
  txBlockNumber: number;
  txTransactionIndex: number;
  txTimestamp: number;
}): Promise<{
  alreadyTrusted: boolean;
  previousRelation: { blockNumber: number; timestamp: number; expiryTime: string; transactionHash: string } | null;
}> {
  const rpc = getRpc();
  const query = rpc.trust.getTrustRelations(params.trusterAddress, 100, "DESC");

  let scanned = 0;
  while (scanned < 20 && (await query.queryNextPage())) {
    scanned += 1;
    const rows = (query.currentPage?.results ?? []) as Array<{
      blockNumber: number;
      timestamp: number;
      transactionIndex: number;
      transactionHash: string;
      truster: string;
      trustee: string;
      expiryTime: string | number;
    }>;

    for (const row of rows) {
      if (normalizeAddress(row.truster) !== normalizeAddress(params.trusterAddress)) {
        continue;
      }

      if (normalizeAddress(row.trustee) !== normalizeAddress(params.trusteeAddress)) {
        continue;
      }

      if (normalizeAddress(row.transactionHash) === normalizeAddress(params.txHash)) {
        continue;
      }

      const rowBlock = Number(row.blockNumber);
      const rowTxIndex = Number(row.transactionIndex);
      const rowTimestamp = Number(row.timestamp);

      const isBeforeByBlock =
        rowBlock < params.txBlockNumber ||
        (rowBlock === params.txBlockNumber && rowTxIndex < params.txTransactionIndex);

      if (!isBeforeByBlock) {
        continue;
      }

      if (rowTimestamp > params.txTimestamp) {
        continue;
      }

      const expiryTime = BigInt(row.expiryTime);
      const wasActive = expiryTime > BigInt(params.txTimestamp);

      return {
        alreadyTrusted: wasActive,
        previousRelation: {
          blockNumber: rowBlock,
          timestamp: rowTimestamp,
          expiryTime: expiryTime.toString(),
          transactionHash: normalizeAddress(row.transactionHash)
        }
      };
    }

    if (!query.currentPage?.hasMore) {
      break;
    }
  }

  return {
    alreadyTrusted: false,
    previousRelation: null
  };
}

async function getMutualTrustCount(address: Address): Promise<number> {
  const rpc = getRpc();
  const mutuals = await rpc.trust.getMutualTrusts(address);
  return mutuals.length;
}

async function getTotalHoldingsAtto(address: Address): Promise<bigint> {
  const rpc = getRpc();
  return rpc.balance.getTotalBalance(address, true);
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
  memberAddress: Address;
  tokenAddress: Address;
  startAt: string;
}): Promise<TransactionHistoryRow | null> {
  const rpc = getRpc();
  const minTimestamp = Math.floor(Date.parse(params.startAt) / 1000);
  const expectedTxHash = normalizeAddress(params.txHash);
  const expectedToken = normalizeAddress(params.tokenAddress);
  const memberAddress = normalizeAddress(params.memberAddress);

  const scanHistory = async (historyAddress: Address): Promise<TransactionHistoryRow | null> => {
    const query = rpc.transaction.getTransactionHistory(historyAddress, 100, "DESC");
    let scanned = 0;

    while (scanned < 10 && (await query.queryNextPage())) {
      scanned += 1;
      const rows = (query.currentPage?.results ?? []) as TransactionHistoryRow[];

      for (const row of rows) {
        if (normalizeAddress(row.transactionHash) !== expectedTxHash) {
          continue;
        }

        if (Number(row.timestamp) < minTimestamp) {
          continue;
        }

        if (normalizeAddress(row.tokenAddress) !== expectedToken) {
          continue;
        }

        const from = normalizeAddress(row.from);
        const to = normalizeAddress(row.to);
        if (from !== memberAddress && to !== memberAddress) {
          continue;
        }

        return row;
      }

      if (!query.currentPage?.hasMore) {
        break;
      }
    }

    return null;
  };

  const fromMemberHistory = await scanHistory(params.memberAddress);
  if (fromMemberHistory) {
    return fromMemberHistory;
  }

  if (normalizeAddress(params.tokenAddress) !== memberAddress) {
    const fromGroupHistory = await scanHistory(params.tokenAddress);
    if (fromGroupHistory) {
      return fromGroupHistory;
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

async function verifyCurrentGroupMembership(params: {
  memberAddress: Address;
  groupAddress: Address;
}): Promise<{ isMember: boolean; expiryTime: number | null }> {
  const rpc = getRpc();
  const now = Math.floor(Date.now() / 1000);
  const query = rpc.group.getGroupMemberships(params.memberAddress, 100, "DESC");

  let scanned = 0;
  while (scanned < 10 && (await query.queryNextPage())) {
    scanned += 1;
    const rows = query.currentPage?.results ?? [];

    for (const row of rows) {
      if (normalizeAddress(row.group) !== normalizeAddress(params.groupAddress)) {
        continue;
      }

      const expiryTime = Number(row.expiryTime);
      return {
        isMember: Number.isFinite(expiryTime) ? expiryTime > now : false,
        expiryTime: Number.isFinite(expiryTime) ? expiryTime : null
      };
    }

    if (!query.currentPage?.hasMore) {
      break;
    }
  }

  return {
    isMember: false,
    expiryTime: null
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

function parseCandidateTxHashes(params: { txHash?: string; txHashes?: string[] }): string[] {
  const candidates = [
    String(params.txHash ?? "").trim(),
    ...((params.txHashes ?? []).map((value) => String(value ?? "").trim()))
  ];

  const unique = new Set<string>();
  const out: string[] = [];

  for (const candidate of candidates) {
    if (!candidate || !candidate.startsWith("0x")) {
      continue;
    }

    const normalized = normalizeAddress(candidate);
    if (unique.has(normalized)) {
      continue;
    }

    unique.add(normalized);
    out.push(normalized);
  }

  return out;
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
    const alreadyTrusted = await verifyAddTrust(address, targetAddress);
    if (alreadyTrusted) {
      throw new QuestError("You already trust this address. Pick someone you do not currently trust.", 400);
    }

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

  if (quest.id === "holdings-threshold") {
    return {
      questId: quest.id,
      summary: `No transaction needed. We will verify your total balance is at least ${HOLDINGS_MIN_CRC} CRC.`,
      hostTransactions: []
    };
  }

  if (quest.id === "mint-5-gcrc") {
    return {
      questId: quest.id,
      summary: `Mint ${GCRC_MINT_AMOUNT_CRC} gCRC for group ${GCRC_GROUP_ADDRESS}`,
      hostTransactions: await buildMintGroupAction({
        actorAddress: address,
        groupAddress: GCRC_GROUP_ADDRESS,
        amountCRC: GCRC_MINT_AMOUNT_CRC
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

  if (quest.id === "true-builder") {
    return {
      questId: quest.id,
      summary: `No transaction needed. We will verify membership in ${TRUE_BUILDER_GROUP_ADDRESS}.`,
      hostTransactions: []
    };
  }

  throw new QuestError("Unsupported quest", 400);
}

export async function claimQuest(params: {
  address: string;
  questId: string;
  txHash?: string;
  txHashes?: string[];
  input?: Record<string, unknown>;
}): Promise<{ completion: QuestCompletion; payload: TodayQuestsPayload }> {
  const address = validateAddress(params.address, "address");
  const quest = getQuestOrThrow(params.questId);
  const window = getRoundWindow();
  const candidateTxHashes = parseCandidateTxHashes({
    txHash: params.txHash,
    txHashes: params.txHashes
  });
  const txHash = candidateTxHashes[0] ?? "";
  const needsTx = requiresOnchainProof(quest.id);

  if (needsTx && !candidateTxHashes.length) {
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
  let verifiedTx: Awaited<ReturnType<typeof verifyTxAfterRoundStart>> | null = null;
  let completionTxHash = txHash;

  try {
    if (needsTx && quest.id !== "mint-5-gcrc") {
      verifiedTx = await verifyTxAfterRoundStart({
        txHash,
        expectedFrom: expectedTxSender(address),
        roundStartAt: window.startAt,
        minConfirmations: MIN_CONFIRMATIONS
      });

      proof.tx = verifiedTx;
    }

    if (quest.id === "add-trust") {
      const targetAddress = validateAddress(readInput(params.input, "targetAddress"), "targetAddress");
      if (!verifiedTx) {
        throw new Error("Transaction verification missing");
      }

      const priorTrustState = await wasAlreadyTrustedBeforeTx({
        txHash,
        trusterAddress: address,
        trusteeAddress: targetAddress,
        txBlockNumber: verifiedTx.blockNumber,
        txTransactionIndex: verifiedTx.transactionIndex,
        txTimestamp: verifiedTx.blockTimestamp
      });
      const trustRelation = await findTrustRelationForQuest({
        txHash,
        trusterAddress: address,
        trusteeAddress: targetAddress,
        startAt: window.startAt
      });
      const trustExists = await verifyAddTrust(address, targetAddress);

      verified = !priorTrustState.alreadyTrusted && Boolean(trustRelation) && trustExists;
      if (priorTrustState.alreadyTrusted) {
        reason = "You already trusted this address before this transaction.";
      } else if (!trustRelation) {
        reason = "No matching trust action for this transaction was found";
      } else if (!trustExists) {
        reason = "Trust edge does not exist yet";
      } else {
        reason = "ok";
      }

      proof.targetAddress = targetAddress;
      proof.priorTrustState = priorTrustState;
      proof.trustRelation = trustRelation;
    } else if (quest.id === "mutual-trust-3plus") {
      const count = await getMutualTrustCount(address);
      verified = count > MUTUAL_TRUST_MIN;
      reason = verified ? "ok" : `Need more than ${MUTUAL_TRUST_MIN} mutual trusts`;
      const bonusXp = verified ? getMutualTrustBonusXp(count) : 0;
      proof.mutualTrustCount = count;
      proof.baseXp = quest.xp;
      proof.bonusXp = bonusXp;
      proof.awardedXp = verified ? quest.xp + bonusXp : 0;
    } else if (quest.id === "send-5-crc") {
      const recipientAddress = validateAddress(readInput(params.input, "recipientAddress"), "recipientAddress");
      const transfer = await findTransferForQuest({
        txHash,
        fromAddress: address,
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
    } else if (quest.id === "holdings-threshold") {
      const totalAtto = await getTotalHoldingsAtto(address);
      const minAtto = parseUnits(HOLDINGS_MIN_CRC, 18);
      verified = totalAtto >= minAtto;
      reason = verified ? "ok" : `Hold at least ${HOLDINGS_MIN_CRC} CRC to complete this quest`;
      const bonusXp = verified ? getHoldingsBonusXp(totalAtto) : 0;
      proof.totalBalanceAttoCircles = totalAtto.toString();
      proof.minRequiredAttoCircles = minAtto.toString();
      proof.baseXp = quest.xp;
      proof.bonusXp = bonusXp;
      proof.awardedXp = verified ? quest.xp + bonusXp : 0;
    } else if (quest.id === "mint-5-gcrc") {
      let verifiedTxForMint: Awaited<ReturnType<typeof verifyTxAfterRoundStart>> | null = null;
      let lastFailureReason = "Mint transaction could not be verified yet. Please retry shortly.";

      for (const candidateHash of candidateTxHashes) {
        try {
          const candidateVerifiedTx = await verifyTxAfterRoundStart({
            txHash: candidateHash,
            expectedFrom: expectedTxSender(address),
            roundStartAt: window.startAt,
            minConfirmations: MIN_CONFIRMATIONS
          });

          verifiedTxForMint = candidateVerifiedTx;
          completionTxHash = candidateHash;
          break;
        } catch (error) {
          lastFailureReason = humanizeVerificationError(error);
        }
      }

      if (!verifiedTxForMint) {
        reason = lastFailureReason;
      } else {
        verified = true;
        reason = "ok";
        proof.groupAddress = GCRC_GROUP_ADDRESS;
        proof.matchedTxHash = completionTxHash;
        proof.tx = verifiedTxForMint;
        proof.mintVerificationMode = "tx_success";
      }
    } else if (quest.id === "no-blacklisted-trusts") {
      const result = await verifyNoBlacklistedTrusts(address);
      verified = result.ok;
      reason = verified
        ? "ok"
        : `You currently trust ${result.blacklistedMatches.length} blacklisted address(es).`;
      proof.trustedCount = result.trustedCount;
      proof.blacklistSize = result.blacklistSize;
      proof.blacklistedMatches = result.blacklistedMatches;
    } else if (quest.id === "true-builder") {
      const membership = await verifyCurrentGroupMembership({
        memberAddress: address,
        groupAddress: TRUE_BUILDER_GROUP_ADDRESS
      });

      verified = membership.isMember;
      reason = verified
        ? "ok"
        : `You are not currently an active member of ${TRUE_BUILDER_GROUP_ADDRESS}`;
      proof.groupAddress = TRUE_BUILDER_GROUP_ADDRESS;
      proof.isMember = membership.isMember;
      proof.expiryTime = membership.expiryTime;
    }
  } catch (error) {
    reason = humanizeVerificationError(error);
  }

  if (verified && parseOptionalNonNegativeInteger(proof.awardedXp) === null) {
    proof.baseXp = quest.xp;
    proof.awardedXp = quest.xp;
  }

  const completion = await upsertCompletion({
    date: window.date,
    address,
    questId: quest.id,
    status: verified ? "verified" : "rejected",
    txHash: completionTxHash ? normalizeAddress(completionTxHash) : "0x",
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

export async function getTodayLeaderboard(limit: number = 10): Promise<QuestLeaderboardEntry[]> {
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
    bucket.totalXp += getCompletionAwardedXp(quest, completion);
  }

  const ranked = Array.from(buckets.entries())
    .map(([address, value]) => ({ address, ...value }))
    .sort((a, b) => {
      if (b.totalXp !== a.totalXp) {
        return b.totalXp - a.totalXp;
      }
      return b.completed - a.completed;
    })
    .slice(0, Math.max(1, Math.min(10, limit)));

  const avatarNames = await resolveLeaderboardAvatarNames(ranked.map((item) => item.address));

  return ranked.map((item, index) => ({
    rank: index + 1,
    address: item.address,
    avatarName: avatarNames.get(item.address) ?? null,
    completed: item.completed,
    totalXp: item.totalXp
  }));
}
