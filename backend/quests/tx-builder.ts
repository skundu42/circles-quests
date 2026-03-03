import { Sdk } from "@aboutcircles/sdk";
import type { Address, TransactionRequest } from "@aboutcircles/sdk-types";
import { cidV0ToHex } from "@aboutcircles/sdk-utils";
import { createPublicClient, http, parseUnits } from "viem";
import { gnosis } from "viem/chains";

const DEFAULT_CHAIN_RPC_URL = "https://rpc.aboutcircles.com/";

function toHexValue(value: bigint): `0x${string}` {
  return `0x${value.toString(16)}`;
}

function toHostTransaction(tx: TransactionRequest): { to: string; data: `0x${string}`; value: `0x${string}` } {
  return {
    to: tx.to,
    data: tx.data,
    value: toHexValue(tx.value ?? 0n)
  };
}

function chainRpcUrl(): string {
  return (
    process.env.CIRCLES_CHAIN_RPC_URL ||
    process.env.CIRCLES_RPC_URL ||
    process.env.NEXT_PUBLIC_CIRCLES_RPC_URL ||
    DEFAULT_CHAIN_RPC_URL
  );
}

function createGroupSymbol(name: string): string {
  const alnum = name
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 6);

  if (alnum.length >= 3) {
    return alnum;
  }

  return `${alnum}GRP`.slice(0, 3);
}

async function collectHostTransactions(
  actorAddress: Address,
  perform: (sdk: Sdk, avatar: Awaited<ReturnType<Sdk["getAvatar"]>>) => Promise<TransactionRequest[] | void>
): Promise<Array<{ to: string; data: `0x${string}`; value: `0x${string}` }>> {
  const publicClient = createPublicClient({
    chain: gnosis,
    transport: http(chainRpcUrl())
  });

  const collected: TransactionRequest[] = [];

  const runner = {
    address: actorAddress,
    publicClient,
    async init() {
      return undefined;
    },
    async estimateGas(tx: TransactionRequest): Promise<bigint> {
      return publicClient.estimateGas({
        account: actorAddress,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gasPrice: tx.gasPrice,
        nonce: tx.nonce
      });
    },
    async call(tx: TransactionRequest): Promise<`0x${string}`> {
      const result = await publicClient.call({
        account: actorAddress,
        to: tx.to,
        data: tx.data,
        value: tx.value
      });

      return (result.data ?? "0x") as `0x${string}`;
    },
    async resolveName() {
      return null;
    },
    async sendTransaction(txs: TransactionRequest[]) {
      collected.push(...txs);
      return {
        transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000000"
      };
    }
  };

  const sdk = new Sdk(undefined, runner);
  const avatar = await sdk.getAvatar(actorAddress);

  const maybeTxs = await perform(sdk, avatar);
  if (Array.isArray(maybeTxs) && maybeTxs.length) {
    collected.push(...maybeTxs);
  }

  if (!collected.length) {
    throw new Error("Could not construct transactions for this quest action.");
  }

  return collected.map(toHostTransaction);
}

export async function buildAddTrustAction(params: {
  actorAddress: Address;
  targetAddress: Address;
}): Promise<Array<{ to: string; data: `0x${string}`; value: `0x${string}` }>> {
  return collectHostTransactions(params.actorAddress, async (_sdk, avatar) => {
    await avatar.trust.add(params.targetAddress);
  });
}

export async function buildPaymentAction(params: {
  actorAddress: Address;
  recipientAddress: Address;
  amountCRC: string;
  dataTag: string;
}): Promise<Array<{ to: string; data: `0x${string}`; value: `0x${string}` }>> {
  const amountAtto = parseUnits(params.amountCRC, 18);

  if (amountAtto <= 0n) {
    throw new Error("amountCRC must be greater than zero.");
  }

  return collectHostTransactions(params.actorAddress, async (_sdk, avatar) => {
    await avatar.transfer.advanced(params.recipientAddress, amountAtto, {
      useWrappedBalances: true,
      txData: new TextEncoder().encode(params.dataTag)
    });
  });
}

export async function buildJoinGroupAction(params: {
  actorAddress: Address;
  groupAddress: Address;
  amountCRC: string;
}): Promise<Array<{ to: string; data: `0x${string}`; value: `0x${string}` }>> {
  const amountAtto = parseUnits(params.amountCRC, 18);

  if (amountAtto <= 0n) {
    throw new Error("amountCRC must be greater than zero.");
  }

  return collectHostTransactions(params.actorAddress, async (_sdk, avatar) => {
    const maybeWithGroupToken = avatar as unknown as {
      groupToken?: { mint: (group: Address, amount: bigint) => Promise<unknown> };
    };

    if (!maybeWithGroupToken.groupToken?.mint) {
      throw new Error("Connected avatar does not support group minting.");
    }

    await maybeWithGroupToken.groupToken.mint(params.groupAddress, amountAtto);
  });
}

export async function buildCreateGroupAction(params: {
  actorAddress: Address;
  groupName: string;
  groupDescription: string;
  groupImageUrl: string;
}): Promise<Array<{ to: string; data: `0x${string}`; value: `0x${string}` }>> {
  const groupName = params.groupName.trim();
  if (!groupName) {
    throw new Error("groupName is required.");
  }

  if (groupName.length > 19) {
    throw new Error("Group name must be 19 characters or fewer.");
  }

  const symbol = createGroupSymbol(groupName);

  return collectHostTransactions(params.actorAddress, async (sdk) => {
    const sdkWithInternals = sdk as unknown as {
      core?: {
        referralsModule?: {
          computeAddress?: (signer: Address) => Promise<Address>;
          createAccount?: (signer: Address) => TransactionRequest;
        };
        baseGroupFactory?: {
          createBaseGroup: (
            owner: Address,
            service: Address,
            feeCollection: Address,
            initialConditions: Address[],
            name: string,
            symbol: string,
            metadataDigest: `0x${string}`
          ) => TransactionRequest;
        };
      };
    };

    const profileCreator = sdk.profiles?.create;
    const referralsModule = sdkWithInternals.core?.referralsModule;
    const baseGroupFactory = sdkWithInternals.core?.baseGroupFactory;

    if (!profileCreator || !referralsModule?.computeAddress || !referralsModule?.createAccount || !baseGroupFactory?.createBaseGroup) {
      throw new Error("SDK does not expose required group creation internals in this environment.");
    }

    const profile = {
      name: groupName,
      description: params.groupDescription.trim(),
      imageUrl: params.groupImageUrl.trim(),
      previewImageUrl: params.groupImageUrl.trim()
    };

    const profileCid = await profileCreator(profile);
    const metadataDigest = cidV0ToHex(profileCid) as `0x${string}`;
    const safeAddress = await referralsModule.computeAddress(params.actorAddress);

    const publicClient = createPublicClient({
      chain: gnosis,
      transport: http(chainRpcUrl())
    });
    const safeCode = await publicClient.getCode({ address: safeAddress });

    const txs: TransactionRequest[] = [];
    if (!safeCode || safeCode === "0x") {
      txs.push(referralsModule.createAccount(params.actorAddress));
    }

    txs.push(
      baseGroupFactory.createBaseGroup(
        safeAddress,
        safeAddress,
        safeAddress,
        [],
        groupName,
        symbol,
        metadataDigest
      )
    );

    return txs;
  });
}
