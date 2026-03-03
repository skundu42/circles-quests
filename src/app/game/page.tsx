"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, Trophy } from "lucide-react";

import type { QuestCompletion, QuestLeaderboardEntry, TodayQuestsPayload, UserQuestItem } from "@/types/quests";

type SignatureType = "erc1271" | "raw";

type MiniappSdk = {
  onWalletChange: (callback: (address: string | null) => void) => void | (() => void);
  signMessage: (message: string, signatureType?: SignatureType) => Promise<{ signature: string; verified: boolean }>;
  sendTransactions: (
    txs: Array<{ to: string; data: `0x${string}`; value: `0x${string}` }>
  ) => Promise<string[]>;
};

interface ApiErrorResponse {
  error?: string;
}

interface AuthChallengeResponse extends ApiErrorResponse {
  challenge?: {
    challengeId: string;
    message: string;
    expiresAt: string;
  };
}

interface AuthVerifyResponse extends ApiErrorResponse {
  session?: {
    token: string;
    expiresAt: string;
  };
}

interface QuestsTodayResponse extends ApiErrorResponse {
  payload?: TodayQuestsPayload;
}

interface LeaderboardResponse extends ApiErrorResponse {
  leaderboard?: QuestLeaderboardEntry[];
}

interface PrepareQuestResponse extends ApiErrorResponse {
  action?: {
    questId: string;
    summary: string;
    hostTransactions: Array<{ to: string; data: `0x${string}`; value: `0x${string}` }>;
  };
}

interface ClaimQuestResponse extends ApiErrorResponse {
  result?: {
    completion: QuestCompletion;
    payload: TodayQuestsPayload;
  };
}

interface SearchUser {
  address: string;
  name: string;
  imageUrl: string | null;
  avatarType: string | null;
  description: string;
}

interface SearchUsersResponse extends ApiErrorResponse {
  users?: SearchUser[];
}

interface LocalSession {
  address: string;
  token: string;
  expiresAt: string;
}

const SESSION_STORAGE_KEY = "quests-session-v1";

function nowMs(): number {
  return Date.now();
}

function toShortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function parseStoredSession(raw: string | null): LocalSession | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LocalSession>;
    if (!parsed.address || !parsed.token || !parsed.expiresAt) {
      return null;
    }

    if (Date.parse(parsed.expiresAt) <= nowMs()) {
      return null;
    }

    return {
      address: parsed.address,
      token: parsed.token,
      expiresAt: parsed.expiresAt
    };
  } catch {
    return null;
  }
}

async function loadSdk(): Promise<MiniappSdk> {
  const sdkModule = await import("@aboutcircles/miniapp-sdk");
  return sdkModule as unknown as MiniappSdk;
}

function normalizeInputValue(value: string): string {
  return value.trim();
}

export default function GamePage() {
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [tokenExpiry, setTokenExpiry] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [runningQuestId, setRunningQuestId] = useState<string | null>(null);
  const [questsPayload, setQuestsPayload] = useState<TodayQuestsPayload | null>(null);
  const [leaderboard, setLeaderboard] = useState<QuestLeaderboardEntry[]>([]);
  const [activeQuestId, setActiveQuestId] = useState<string | null>(null);
  const [draftInputs, setDraftInputs] = useState<Record<string, Record<string, string>>>({});
  const [status, setStatus] = useState("Connect wallet in the host app.");
  const [error, setError] = useState<string | null>(null);
  const [questDetailError, setQuestDetailError] = useState<string | null>(null);
  const [addressSearchFieldId, setAddressSearchFieldId] = useState<string | null>(null);
  const [addressSearchQuery, setAddressSearchQuery] = useState("");
  const [addressSearchResults, setAddressSearchResults] = useState<SearchUser[]>([]);
  const [addressSearchLoading, setAddressSearchLoading] = useState(false);
  const [addressSearchError, setAddressSearchError] = useState<string | null>(null);
  const isLoadedStatus = status.startsWith("Loaded quests for ");

  const activeQuest = useMemo(() => {
    if (!activeQuestId || !questsPayload) {
      return null;
    }

    return questsPayload.quests.find((quest) => quest.id === activeQuestId) ?? null;
  }, [activeQuestId, questsPayload]);

  const activeDraft = useMemo(() => {
    if (!activeQuest) {
      return {} as Record<string, string>;
    }

    return draftInputs[activeQuest.id] ?? {};
  }, [activeQuest, draftInputs]);

  const setDraftField = useCallback((questId: string, fieldId: string, value: string) => {
    setDraftInputs((current) => ({
      ...current,
      [questId]: {
        ...(current[questId] ?? {}),
        [fieldId]: value
      }
    }));
  }, []);

  const fetchLeaderboard = useCallback(async () => {
    try {
      const response = await fetch("/api/quests/leaderboard/today?limit=10", {
        cache: "no-store"
      });
      const payload = (await response.json()) as LeaderboardResponse;

      if (response.ok) {
        setLeaderboard(payload.leaderboard ?? []);
      }
    } catch {
      // Keep stale leaderboard.
    }
  }, []);

  const authenticateWallet = useCallback(async (address: string) => {
    setAuthenticating(true);
    setError(null);
    setStatus("Requesting wallet challenge...");

    try {
      const sdk = await loadSdk();

      const challengeResponse = await fetch(
        `/api/quests/auth/challenge?address=${encodeURIComponent(address)}`,
        { cache: "no-store" }
      );
      const challengePayload = (await challengeResponse.json()) as AuthChallengeResponse;

      if (!challengeResponse.ok || !challengePayload.challenge) {
        throw new Error(challengePayload.error || "Could not get auth challenge");
      }

      setStatus("Sign auth challenge...");
      const signed = await sdk.signMessage(challengePayload.challenge.message, "erc1271");

      const verifyResponse = await fetch("/api/quests/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          challengeId: challengePayload.challenge.challengeId,
          signature: signed.signature
        })
      });
      const verifyPayload = (await verifyResponse.json()) as AuthVerifyResponse;

      if (!verifyResponse.ok || !verifyPayload.session) {
        throw new Error(verifyPayload.error || "Authentication failed");
      }

      const session: LocalSession = {
        address: address.toLowerCase(),
        token: verifyPayload.session.token,
        expiresAt: verifyPayload.session.expiresAt
      };

      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      setToken(session.token);
      setTokenExpiry(session.expiresAt);
      setStatus("Authenticated.");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Authentication failed";
      setError(message);
      setStatus("Authentication failed.");
    } finally {
      setAuthenticating(false);
    }
  }, []);

  const fetchQuests = useCallback(async (sessionToken?: string) => {
    setLoading(true);

    try {
      const headers = sessionToken ? { Authorization: `Bearer ${sessionToken}` } : undefined;
      const response = await fetch("/api/quests/today", {
        cache: "no-store",
        headers
      });

      const payload = (await response.json()) as QuestsTodayResponse;
      if (!response.ok || !payload.payload) {
        if (response.status === 401 && sessionToken) {
          localStorage.removeItem(SESSION_STORAGE_KEY);
          setToken(null);
          setTokenExpiry(null);
          setStatus("Session expired. Re-authenticating...");
          if (connectedAddress) {
            void authenticateWallet(connectedAddress);
          }
          return;
        }
        throw new Error(payload.error || "Could not load quests");
      }

      const todayPayload = payload.payload;
      setQuestsPayload(todayPayload);
      setActiveQuestId((current) => current ?? todayPayload.quests[0]?.id ?? null);
      setStatus(`Loaded quests for ${todayPayload.date}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not load quests";
      setError(message);
      setStatus("Failed to load quests.");
    } finally {
      setLoading(false);
    }
  }, [connectedAddress, authenticateWallet]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let mounted = true;

    void loadSdk()
      .then((sdk) => {
        if (!mounted) {
          return;
        }

        const maybeCleanup = sdk.onWalletChange((address) => {
          const normalized = address?.trim().toLowerCase() || null;
          setConnectedAddress(normalized);
          setReady(Boolean(normalized));

          if (!normalized) {
            setToken(null);
            setTokenExpiry(null);
            setStatus("Connect wallet in the host app.");
            return;
          }

          const stored = parseStoredSession(localStorage.getItem(SESSION_STORAGE_KEY));
          if (stored && stored.address === normalized) {
            setToken(stored.token);
            setTokenExpiry(stored.expiresAt);
            setStatus("Session restored.");
          } else {
            setToken(null);
            setTokenExpiry(null);
            void authenticateWallet(normalized);
          }
        });

        if (typeof maybeCleanup === "function") {
          cleanup = maybeCleanup;
        }
      })
      .catch(() => {
        if (!mounted) {
          return;
        }

        setReady(false);
        setStatus("Miniapp SDK unavailable in this context.");
      });

    return () => {
      mounted = false;
      cleanup?.();
    };
  }, [authenticateWallet]);

  useEffect(() => {
    void fetchQuests();
    void fetchLeaderboard();
  }, [fetchQuests, fetchLeaderboard]);

  useEffect(() => {
    if (!token || !connectedAddress) {
      return;
    }

    if (tokenExpiry && Date.parse(tokenExpiry) <= nowMs()) {
      setToken(null);
      setTokenExpiry(null);
      localStorage.removeItem(SESSION_STORAGE_KEY);
      void fetchQuests();
      void authenticateWallet(connectedAddress);
      return;
    }

    void fetchQuests(token);
    void fetchLeaderboard();
  }, [token, tokenExpiry, connectedAddress, fetchQuests, fetchLeaderboard, authenticateWallet]);

  useEffect(() => {
    setAddressSearchFieldId(null);
    setAddressSearchQuery("");
    setAddressSearchResults([]);
    setAddressSearchError(null);
    setQuestDetailError(null);
  }, [activeQuest?.id]);

  useEffect(() => {
    if (!token || !addressSearchFieldId) {
      setAddressSearchLoading(false);
      return;
    }

    const query = addressSearchQuery.trim();
    if (query.length < 2) {
      setAddressSearchResults([]);
      setAddressSearchError(query ? "Enter at least 2 characters to search." : null);
      setAddressSearchLoading(false);
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      setAddressSearchLoading(true);
      setAddressSearchError(null);

      void fetch(`/api/quests/search-users?q=${encodeURIComponent(query)}&limit=8`, {
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`
        }
      })
        .then(async (response) => {
          const payload = (await response.json()) as SearchUsersResponse;
          if (!response.ok) {
            throw new Error(payload.error || "Search failed");
          }

          setAddressSearchResults(payload.users ?? []);
          if (!payload.users?.length) {
            setAddressSearchError("No matching Circles users found.");
          }
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) {
            return;
          }
          const message = e instanceof Error ? e.message : "Search failed";
          setAddressSearchError(message);
          setAddressSearchResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setAddressSearchLoading(false);
          }
        });
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [token, addressSearchFieldId, addressSearchQuery]);

  const runQuest = useCallback(async () => {
    if (!activeQuest) {
      return;
    }

    if (!token) {
      setStatus("Sign in with your wallet to execute quests.");
      setQuestDetailError("Sign in with your wallet to execute quests.");
      return;
    }

    if (!connectedAddress) {
      return;
    }

    if (activeQuest.status === "completed") {
      setStatus("Quest already completed for today.");
      setQuestDetailError("Quest already completed for today.");
      return;
    }

    const input: Record<string, string> = {};
    for (const field of activeQuest.inputFields) {
      const value = normalizeInputValue(activeDraft[field.id] ?? "");

      if (field.required && !value) {
        setQuestDetailError(`${field.label} is required.`);
        return;
      }

      if (value) {
        input[field.id] = value;
      }
    }

    setRunningQuestId(activeQuest.id);
    setQuestDetailError(null);
    setStatus(`Preparing ${activeQuest.title}...`);

    try {
      const prepareResponse = await fetch(`/api/quests/${activeQuest.id}/prepare`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ input })
      });
      const preparePayload = (await prepareResponse.json()) as PrepareQuestResponse;

      if (!prepareResponse.ok || !preparePayload.action) {
        throw new Error(preparePayload.error || "Could not prepare quest action");
      }

      setStatus(preparePayload.action.summary);

      let txHash = "";
      let txHashes: string[] = [];
      if (preparePayload.action.hostTransactions.length > 0) {
        const sdk = await loadSdk();
        try {
          txHashes = await sdk.sendTransactions(preparePayload.action.hostTransactions);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (message.toLowerCase().includes("user rejected") || message.toLowerCase().includes("denied")) {
            throw new Error("Transaction was rejected in wallet.");
          }

          throw new Error(`Failed to send transaction: ${message}`);
        }

        txHash = txHashes?.[txHashes.length - 1] ?? "";
        if (!txHash) {
          throw new Error("No transaction hash returned by wallet.");
        }
      }

      setStatus("Verifying quest completion...");
      const claimResponse = await fetch(`/api/quests/${activeQuest.id}/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          txHash: txHash || undefined,
          txHashes: txHashes.length ? txHashes : undefined,
          input
        })
      });
      const claimPayload = (await claimResponse.json()) as ClaimQuestResponse;

      if (!claimResponse.ok || !claimPayload.result) {
        throw new Error(claimPayload.error || "Quest claim failed");
      }

      setQuestsPayload(claimPayload.result.payload);

      if (claimPayload.result.completion.status === "verified") {
        setQuestDetailError(null);
        setStatus("Quest completed.");
      } else {
        const failureReason = claimPayload.result.completion.rejectedReason || "Verification failed";
        setQuestDetailError(failureReason);
        setStatus(`Quest failed: ${failureReason}`);
      }

      await fetchLeaderboard();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Quest execution failed";
      setQuestDetailError(message);
      setStatus("Quest execution failed.");
    } finally {
      setRunningQuestId(null);
    }
  }, [token, connectedAddress, activeQuest, activeDraft, fetchLeaderboard]);

  return (
    <main className="min-h-screen px-4 py-8 md:py-10">
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <section className="rounded-3xl border border-ink/15 bg-white/85 p-5 shadow-[0_18px_50px_-28px_rgba(13,19,48,0.45)]">
          <div>
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="font-display text-3xl text-ink md:text-4xl">Circles Daily Quest App</h1>
                {questsPayload ? (
                  <div className="ml-auto inline-flex rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-700">
                    Loaded quests for {questsPayload.date}
                  </div>
                ) : isLoadedStatus ? (
                  <div className="ml-auto inline-flex rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-700">
                    {status}
                  </div>
                ) : null}
              </div>
              <p className="mt-2 text-sm text-ink/70">Complete quests and receieve weekly rewards</p>
            </div>
          </div>

          {!questsPayload && !isLoadedStatus ? (
            <p className="mt-3 text-sm text-ink/75">{status}</p>
          ) : null}
          {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}

          {questsPayload ? (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-emerald-300/45 bg-emerald-50/70 p-3">
                <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-700">Completed</p>
                <p className="mt-1 font-display text-2xl leading-none text-emerald-700">{questsPayload.progress.completed}</p>
              </div>
              <div className="rounded-2xl border border-amber-300/45 bg-amber-50/70 p-3">
                <p className="text-[11px] uppercase tracking-[0.16em] text-amber-700">Total XP</p>
                <p className="mt-1 font-display text-2xl leading-none text-amber-700">{questsPayload.progress.totalXp}</p>
              </div>
            </div>
          ) : null}
        </section>

        <section className="rounded-3xl border-2 border-marine/30 bg-gradient-to-br from-white via-white to-marine/5 p-5 shadow-[0_20px_50px_-28px_rgba(13,19,48,0.55)]">
          <p className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-ink/70">
            <Trophy className="h-4 w-4 text-marine" />
            Leaderboard
          </p>
          <div className="mt-3 space-y-2">
            {leaderboard.length ? (
              leaderboard.map((entry) => {
                const rowTone =
                  entry.rank === 1
                    ? "border-amber-300 bg-amber-50/85"
                    : entry.rank === 2
                      ? "border-slate-300 bg-slate-50/90"
                      : entry.rank === 3
                        ? "border-orange-300 bg-orange-50/90"
                        : "border-ink/10 bg-white";

                const rankTone =
                  entry.rank === 1
                    ? "border-amber-400 bg-amber-200 text-amber-950"
                    : entry.rank === 2
                      ? "border-slate-400 bg-slate-200 text-slate-900"
                      : entry.rank === 3
                        ? "border-orange-400 bg-orange-200 text-orange-950"
                        : "border-ink/20 bg-ink/5 text-ink";

                return (
                  <div key={`${entry.rank}-${entry.address}`} className={`rounded-2xl border px-3 py-2.5 text-xs ${rowTone}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-sm font-bold ${rankTone}`}>
                          #{entry.rank}
                        </div>
                        <p className="truncate text-xs font-semibold text-ink">{entry.avatarName || "Unnamed Avatar"}</p>
                      </div>
                      <div className="ml-auto text-right">
                        <p className="font-mono text-[11px] text-ink/65">{toShortAddress(entry.address)}</p>
                        <p className="mt-1 text-ink/75">{entry.totalXp} XP • {entry.completed} quests completed</p>
                      </div>
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-sm text-ink/65">No entries yet.</p>
            )}
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-[1.8fr_1fr]">
          <div className="rounded-3xl border border-ink/15 bg-white/85 p-4 md:p-5">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink/60">Daily Quests</p>
              {loading ? (
                <span className="inline-flex items-center gap-1 text-xs text-ink/60">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading
                </span>
              ) : null}
            </div>

            <div className="space-y-2">
              {(questsPayload?.quests ?? []).map((quest) => (
                <button
                  key={quest.id}
                  type="button"
                  onClick={() => {
                    setActiveQuestId(quest.id);
                  }}
                  className={[
                    "w-full rounded-xl border p-3 text-left transition",
                    activeQuestId === quest.id ? "ring-2 ring-marine/40" : "",
                    quest.status === "completed"
                      ? "border-emerald-300 bg-emerald-50"
                      : quest.status === "failed"
                        ? "border-red-300 bg-red-50"
                        : "border-ink/15 bg-white hover:border-marine/40"
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-ink">{quest.title}</p>
                    <span className="text-xs text-ink/60">{quest.xp} XP</span>
                  </div>
                  <p className="mt-1 text-xs text-ink/70">{quest.description}</p>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="rounded-3xl border border-ink/15 bg-white/85 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink/60">Quest Detail</p>

              {!activeQuest ? (
                <p className="mt-3 text-sm text-ink/70">Select a quest to execute it in-app.</p>
              ) : (
                <div className="mt-3 space-y-3">
                  <div>
                    <p className="text-sm font-semibold text-ink">{activeQuest.title}</p>
                    <p className="mt-1 text-xs text-ink/70">{activeQuest.description}</p>
                  </div>

                  <div className="rounded-xl border border-ink/10 bg-white p-3 text-xs text-ink/75">
                    <p>XP: {activeQuest.xp}</p>
                    <p className="capitalize">Status: {activeQuest.status}</p>
                    {activeQuest.completion?.status === "rejected" ? (
                      <p className="mt-1 text-red-600">Reason: {activeQuest.completion.rejectedReason || "Verification failed"}</p>
                    ) : null}
                  </div>

                  {questDetailError ? (
                    <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                      {questDetailError}
                    </p>
                  ) : null}

                  {!token ? (
                    <p className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Sign in with your wallet to interact with quests.
                    </p>
                  ) : null}

                  {activeQuest.inputFields.map((field) => {
                    if (field.type === "address") {
                      const showResults = addressSearchFieldId === field.id;

                      return (
                        <div key={field.id} className="space-y-2 rounded-xl border border-ink/10 bg-white p-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink/60">
                            {field.label}
                          </p>
                          <input
                            type="text"
                            value={activeDraft[field.id] ?? ""}
                            onFocus={(event) => {
                              setAddressSearchFieldId(field.id);
                              setAddressSearchQuery("");
                              setAddressSearchResults([]);
                              setAddressSearchError(null);
                            }}
                            onChange={(event) => {
                              setDraftField(activeQuest.id, field.id, event.target.value);
                              setAddressSearchFieldId(field.id);
                              setAddressSearchQuery(event.target.value);
                              setAddressSearchError(null);
                            }}
                            placeholder={field.placeholder || "Search avatar name or paste address"}
                            disabled={!token}
                            className="w-full rounded-xl border border-ink/15 bg-white px-3 py-2 text-xs outline-none focus:border-marine/45 disabled:cursor-not-allowed disabled:opacity-60"
                          />

                          {showResults && addressSearchLoading ? (
                            <p className="text-xs text-ink/60">Searching avatars...</p>
                          ) : null}

                          {showResults && addressSearchError ? (
                            <p className="text-xs text-red-600">{addressSearchError}</p>
                          ) : null}

                          {showResults && addressSearchResults.length ? (
                            <div className="max-h-40 space-y-1 overflow-auto pr-1">
                              {addressSearchResults.map((user) => (
                                <button
                                  key={`${field.id}-${user.address}`}
                                  type="button"
                                  onClick={() => {
                                    setDraftField(activeQuest.id, field.id, user.address);
                                    setAddressSearchFieldId(null);
                                    setAddressSearchQuery("");
                                    setAddressSearchResults([]);
                                    setAddressSearchError(null);
                                    setStatus(`Selected ${user.name} (${toShortAddress(user.address)})`);
                                  }}
                                  disabled={!token}
                                  className="w-full rounded-lg border border-ink/10 bg-white px-2.5 py-2 text-left hover:border-marine/35 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  <p className="text-xs font-semibold text-ink">{user.name || "Unnamed"}</p>
                                  <p className="mt-0.5 font-mono text-[11px] text-ink/70">{user.address}</p>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    }

                    return (
                      <input
                        key={field.id}
                        type={field.type === "url" ? "url" : field.type === "amount" ? "number" : "text"}
                        value={activeDraft[field.id] ?? ""}
                        onChange={(event) => {
                          setDraftField(activeQuest.id, field.id, event.target.value);
                        }}
                        placeholder={field.placeholder || field.label}
                        inputMode={field.type === "amount" ? "decimal" : undefined}
                        min={field.type === "amount" ? "0" : undefined}
                        step={field.type === "amount" ? "0.000000000000000001" : undefined}
                        disabled={!token}
                        className="w-full rounded-xl border border-ink/15 bg-white px-3 py-2 text-xs outline-none focus:border-marine/45 disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    );
                  })}

                  {activeQuest.status === "completed" ? (
                    <div className="inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
                      <CheckCircle2 className="h-4 w-4" />
                      Completed
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        void runQuest();
                      }}
                      disabled={!token || runningQuestId !== null}
                      className="w-full rounded-xl bg-marine px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {runningQuestId === activeQuest.id ? (
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Running...
                        </span>
                      ) : !token ? (
                        "Sign In To Confirm"
                      ) : (
                        "Confirm"
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

      </div>
    </main>
  );
}
