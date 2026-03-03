import { CirclesRpc } from "@aboutcircles/sdk-rpc";
import type { TransactionHistoryRow } from "@aboutcircles/sdk-rpc";
import { createPublicClient, http, isAddress, type Address, type Hex } from "viem";
import { gnosis } from "viem/chains";

export interface RoundWindow {
  date: string;
  startAt: string;
  endAt: string;
}

export interface TxWindowVerification {
  txHash: string;
  blockNumber: number;
  blockTimestamp: number;
  from: string;
  to: string;
}

const DEFAULT_RPC_URL = "https://rpc.aboutcircles.com/";
const DEFAULT_CHAIN_RPC_URL = "https://rpc.aboutcircles.com/";

let cachedCirclesRpc: CirclesRpc | null = null;
let cachedPublicClient: ReturnType<typeof createPublicClient> | null = null;

function circlesRpcUrl(): string {
  return process.env.CIRCLES_RPC_URL || process.env.NEXT_PUBLIC_CIRCLES_RPC_URL || DEFAULT_RPC_URL;
}

function chainRpcUrl(): string {
  return (
    process.env.CIRCLES_CHAIN_RPC_URL ||
    process.env.CIRCLES_RPC_URL ||
    process.env.NEXT_PUBLIC_CIRCLES_RPC_URL ||
    DEFAULT_CHAIN_RPC_URL
  );
}

export function getCirclesRpc(): CirclesRpc {
  if (!cachedCirclesRpc) {
    cachedCirclesRpc = new CirclesRpc(circlesRpcUrl());
  }
  return cachedCirclesRpc;
}

export function getPublicClient() {
  if (!cachedPublicClient) {
    cachedPublicClient = createPublicClient({
      chain: gnosis,
      transport: http(chainRpcUrl())
    });
  }
  return cachedPublicClient;
}

export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function toUtcDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getRoundWindow(date?: string): RoundWindow {
  const base = date ? new Date(`${date}T00:00:00.000Z`) : new Date();
  const datePart = date ?? toUtcDate(base);
  const start = new Date(`${datePart}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return {
    date: datePart,
    startAt: start.toISOString(),
    endAt: end.toISOString()
  };
}

export async function verifyTxAfterRoundStart(params: {
  txHash: string;
  expectedFrom: string;
  roundStartAt: string;
  minConfirmations?: number;
}): Promise<TxWindowVerification> {
  const txHash = params.txHash.trim();
  if (!txHash.startsWith("0x")) {
    throw new Error("txHash must be hex");
  }

  const client = getPublicClient();
  const minConfirmations = Math.max(1, params.minConfirmations ?? 1);

  const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
  const tx = await client.getTransaction({ hash: txHash as Hex });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });

  const startAtSeconds = Math.floor(Date.parse(params.roundStartAt) / 1000);
  const blockTimestamp = Number(block.timestamp);
  const blockNumber = Number(receipt.blockNumber);

  if (blockTimestamp < startAtSeconds) {
    throw new Error("Transaction is older than round start time");
  }

  const expectedFrom = normalizeAddress(params.expectedFrom);
  const txFrom = normalizeAddress(tx.from);

  if (txFrom !== expectedFrom) {
    throw new Error("Transaction sender does not match authenticated user");
  }

  const latest = await client.getBlockNumber();
  const confirmations = Number(latest - receipt.blockNumber) + 1;
  if (confirmations < minConfirmations) {
    throw new Error(`Transaction needs at least ${minConfirmations} confirmations`);
  }

  return {
    txHash,
    blockNumber,
    blockTimestamp,
    from: txFrom,
    to: normalizeAddress(tx.to ?? "0x0000000000000000000000000000000000000000")
  };
}

export async function findRecipientTransferByTxHash(params: {
  recipientAddress: string;
  txHash: string;
  expectedFrom?: string;
  minTimestamp?: number;
  maxPages?: number;
}): Promise<TransactionHistoryRow | null> {
  if (!isAddress(params.recipientAddress)) {
    return null;
  }

  const recipient = normalizeAddress(params.recipientAddress);
  const txHash = normalizeAddress(params.txHash);
  const expectedFrom = params.expectedFrom ? normalizeAddress(params.expectedFrom) : null;

  const rpc = getCirclesRpc();
  const query = rpc.transaction.getTransactionHistory(recipient as Address, 100, "DESC");

  const maxPages = Math.max(1, params.maxPages ?? 8);
  let scanned = 0;

  while (scanned < maxPages && (await query.queryNextPage())) {
    scanned += 1;
    const rows = (query.currentPage?.results ?? []) as TransactionHistoryRow[];

    for (const row of rows) {
      const rowHash = normalizeAddress(row.transactionHash);
      if (rowHash !== txHash) {
        continue;
      }

      if (normalizeAddress(row.to) !== recipient) {
        continue;
      }

      if (expectedFrom && normalizeAddress(row.from) !== expectedFrom) {
        continue;
      }

      if (params.minTimestamp !== undefined && row.timestamp < params.minTimestamp) {
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
