# Supabase-backed broker accounts

Store your broker accounts (Angel / Upstox / Kotak) in Supabase so the app can
load them on open and auto-login the enabled ones. The **Go backend** talks to
Supabase with the **service-role key** (never sent to the browser); the browser
only calls the backend's `/api/accounts` endpoints.

## 1. Create a Supabase project

1. Go to https://supabase.com → **New project**. Pick a name + database password.
2. Once it's ready, open **Project Settings → API** and copy:
   - **Project URL**  → e.g. `https://abcdxyz.supabase.co`
   - **service_role key** (under *Project API keys* → `service_role`, click *Reveal*).
     ⚠️ This is a secret admin key. Keep it on the backend only — never in the
     frontend or in git.

## 2. Create the table

Open **SQL Editor → New query**, paste this, and **Run**:

```sql
create table if not exists public.broker_accounts (
  id           uuid primary key default gen_random_uuid(),
  position     integer not null default 0,   -- row order in the table
  enabled      boolean not null default true,
  alias        text default '',
  client_code  text default '',              -- User ID / UCC
  broker       text not null default 'Angel',-- Angel | Upstox | KotakNeoV3 | APITest
  market_orders text default 'Allowed',
  api_key      text default '',
  api_secret   text default '',
  totp_secret  text default '',
  pin          text default '',
  phone        text default '',              -- mobile (Upstox/Kotak); with ISD for Kotak
  auto_login   boolean not null default false,
  historical_api boolean not null default false,
  sqoff_time   text default '15:16',
  updated_at   timestamptz not null default now()
);

-- The backend uses the service-role key, which bypasses RLS. We still enable RLS
-- so nothing is readable with the public anon key by accident.
alter table public.broker_accounts enable row level security;
```

## 3. Point the backend at Supabase

Set these env vars before starting the backend (PowerShell):

```powershell
$env:SUPABASE_URL = "https://YOUR-PROJECT.supabase.co"
$env:SUPABASE_SERVICE_KEY = "your-service-role-key"
cd go-backend
go run .
```

That's it. When Supabase is configured the app loads accounts from it on open and
auto-logs in the enabled ones. If the env vars are absent, the app falls back to
its local IndexedDB storage exactly as before — so nothing breaks without it.

## Notes

- Secrets are stored as plain columns. This is a personal/self-hosted tool; if you
  later want them encrypted at rest, we can add pgcrypto or Supabase Vault.
- `position` preserves the row order you see in the table.
```
