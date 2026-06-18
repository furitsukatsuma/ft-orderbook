-- ft-wallet-mcp / ft-orderbook — Supabase スキーマ（正本・新規構築用）
--
-- これは「新規プロジェクトを一発で作る」ためのスキーマ。
-- 既存プロジェクトの移行（ALTER）は migrations/0001_orderbook_v0_7_0.sql を使うこと。
-- 両者は同じ最終形に収束する（冪等）。
--
-- 設計メモ:
--   - customer_id は text（auth.users に紐づかない任意 ID。MCP がそのまま使う）。
--   - status に PENDING_APPROVAL を含む。approval_token / settled_by を持つ。
--   - settings(key,value,updated_at) に auto_settle_min / auto_settle_max を保持。
--   - RLS 有効・ポリシー無し → service key（service_role）だけが R/W 可能。

create extension if not exists pgcrypto;

create table if not exists public.orders (
  order_id     text primary key,
  type         text not null check (type in ('limit', 'market')),
  side         text not null check (side in ('buy', 'sell')),
  service      text not null,
  price        numeric,
  qty          integer not null default 1,
  customer_id  text not null,
  status       text not null default 'OPEN'
                 check (status in ('OPEN', 'MATCHED', 'CANCELLED', 'EXPIRED', 'PENDING_APPROVAL')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  matched_at   timestamptz,
  matched_with text,
  approval_token text,
  settled_by   text
);

create table if not exists public.trades (
  trade_id    text primary key,
  order_id    text not null references public.orders(order_id) on delete restrict,
  service     text not null,
  side        text not null check (side in ('buy', 'sell')),
  price       numeric not null,
  qty         integer not null default 1,
  total_usd   numeric not null,
  fee_usd     numeric not null default 0,
  currency    text not null default 'USD',
  customer_id text not null,
  settled_by  text not null default 'auto',
  traded_at   timestamptz not null default now()
);

create table if not exists public.settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_orders_service_side_status
  on public.orders(service, side, status);
create index if not exists idx_orders_expires
  on public.orders(expires_at);
create index if not exists idx_orders_status
  on public.orders(status);
create index if not exists idx_orders_matched_with
  on public.orders(matched_with);
create index if not exists idx_trades_service
  on public.trades(service);

alter table public.orders   enable row level security;
alter table public.trades   enable row level security;
alter table public.settings enable row level security;
