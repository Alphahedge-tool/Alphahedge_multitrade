-- Alphahedge multi-broker: Supabase table for broker accounts.
--
-- WHERE TO RUN THIS:
--   1. Open your Supabase project (https://kozulwdvkvcsuoowghzi.supabase.co)
--   2. Left sidebar -> "SQL Editor"
--   3. Click "+ New query"
--   4. Paste this whole file
--   5. Click "Run" (bottom-right) or press Ctrl+Enter
--   6. Expect: "Success. No rows returned."
--
-- Each row is one broker account; the `broker` column tags it (Angel / Upstox /
-- KotakNeoV3 / APITest), so accounts can be saved and loaded grouped by broker.

create table if not exists public.broker_accounts (
  id             uuid primary key default gen_random_uuid(),
  position       integer not null default 0,   -- row order in the table
  enabled        boolean not null default true,
  alias          text default '',
  client_code    text default '',              -- User ID / UCC
  broker         text not null default 'Angel',-- Angel | Upstox | KotakNeoV3 | APITest
  market_orders  text default 'Allowed',
  api_key        text default '',
  api_secret     text default '',
  totp_secret    text default '',
  pin            text default '',
  phone          text default '',              -- mobile (Upstox/Kotak); with ISD for Kotak
  auto_login     boolean not null default false,
  historical_api boolean not null default false,
  sqoff_time     text default '15:16',
  updated_at     timestamptz not null default now()
);

-- The backend uses the service-role key, which bypasses RLS. We still enable RLS
-- so nothing is readable with a public/anon key by accident.
alter table public.broker_accounts enable row level security;

-- Optional: speed up per-broker loads (?broker=Kotak).
create index if not exists broker_accounts_broker_idx on public.broker_accounts (broker);
```

