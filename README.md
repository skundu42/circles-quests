# Circles Quest App

A Circles quests/task-completion app with in-app actions and server-side verification.

## Active Quests

1. Add trust (search + pick a Circles user)
2. Have more than 3 mutual trusts
3. Send more than 5 CRC to any Circles avatar
4. Mint 5 gCRC for group `0xc19bc204eb1c1d5b3fe500e5e5dfabab625f286c`
5. Create a group (name, description, image)
6. Validate you trust no blacklisted address

## Core Flow

1. Wallet auth (`challenge -> sign -> verify -> JWT`)
2. Load today's quests (`GET /api/quests/today`)
3. Prepare action (`POST /api/quests/:questId/prepare`)
4. Execute tx in miniapp (if quest is tx-backed)
5. Claim quest (`POST /api/quests/:questId/claim`)
6. Server verifies and updates progress + leaderboard

## API

- `GET /api/quests/auth/challenge?address=0x...`
- `POST /api/quests/auth/verify`
- `GET /api/quests/today` (auth)
- `POST /api/quests/:questId/prepare` (auth)
- `POST /api/quests/:questId/claim` (auth)
- `GET /api/quests/leaderboard/today?limit=20`
- `GET /api/quests/search-users?q=...&limit=...` (auth)

## Environment Variables

- `CIRCLES_RPC_URL`
- `CIRCLES_CHAIN_RPC_URL`
- `NEXT_PUBLIC_CIRCLES_RPC_URL`
- `QUEST_AUTH_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_QUEST_COMPLETIONS_TABLE` (default: `quest_completions`)
- `SUPABASE_QUEST_AUTH_CHALLENGES_TABLE` (default: `quest_auth_challenges`)
- `QUEST_MIN_CONFIRMATIONS`
- `QUEST_SEND_MIN_CRC`
- `QUEST_SEND_EXECUTION_CRC`
- `QUEST_GCRC_MINT_AMOUNT_CRC`
- `QUEST_GROUP_IMAGE_MAX_INPUT_CHARS` (optional, default: `700000`)

## Supabase Setup (Required)

Run this SQL in Supabase SQL Editor:

```sql
create extension if not exists pgcrypto;

create table if not exists public.quest_completions (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  address text not null,
  quest_id text not null,
  status text not null check (status in ('verified', 'rejected')),
  tx_hash text not null,
  input jsonb not null default '{}'::jsonb,
  proof jsonb not null default '{}'::jsonb,
  verified_at timestamptz,
  rejected_at timestamptz,
  rejected_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (date, address, quest_id)
);

create index if not exists idx_quest_completions_date on public.quest_completions (date);
create index if not exists idx_quest_completions_address on public.quest_completions (address);

create table if not exists public.quest_auth_challenges (
  id uuid primary key,
  address text not null,
  nonce text not null,
  message text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null check (status in ('issued', 'used', 'expired')),
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_quest_auth_challenges_expires_at
  on public.quest_auth_challenges (expires_at);

create index if not exists idx_quest_auth_challenges_address
  on public.quest_auth_challenges (address);
```

If you enabled RLS, allow your server role key to read/write these tables (or keep RLS disabled for these backend-only tables).

## Project Layout

- Frontend: `src/app/game/page.tsx`
- Quests API: `src/app/api/quests/*`
- Domain logic: `backend/quests/*`

## Local Setup

1. Install dependencies

```bash
npm install
```

2. Create env file

```bash
cp .env.example .env.local
```

3. Fill Supabase credentials and run app

```bash
npm run dev
```

4. Open

- `http://localhost:3000/game`
