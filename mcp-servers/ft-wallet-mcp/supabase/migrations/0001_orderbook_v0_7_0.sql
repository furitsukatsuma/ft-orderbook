-- ft-wallet-mcp / ft-orderbook — Supabase マイグレーション 0001
-- v0.7.0 板/レンジ/承認ロジック対応。
--
-- 目的:
--   orders に status='PENDING_APPROVAL' を許可し approval_token / settled_by を追加、
--   trades に settled_by を追加、settings(key,value,updated_at) を新設する。
--   さらに customer_id を text 化する（MCP は auth.users に紐づかない任意の文字列
--   customer_id を使うため。MCP と管理UI が同一テーブルを R/W できるようにする正本）。
--
-- 特性:
--   - 冪等（idempotent）。新規プロジェクトにも、旧 schema.sql（uuid + auth.users FK・
--     PENDING_APPROVAL 非許可）が既に適用済みのプロジェクトにも、安全に再実行できる。
--   - service_role（service key）からのみアクセスさせるため RLS を有効化（ポリシー無し＝
--     anon/authenticated は全拒否、service_role はバイパス）。
--
-- 適用方法は同ディレクトリの README.md を参照。

create extension if not exists pgcrypto;

-- ────────────────────────────────────────────────────────────
-- orders
-- ────────────────────────────────────────────────────────────
create table if not exists public.orders (
  order_id     text primary key,
  type         text not null check (type in ('limit', 'market')),
  side         text not null check (side in ('buy', 'sell')),
  service      text not null,
  price        numeric,
  qty          integer not null default 1,
  customer_id  text not null,
  status       text not null default 'OPEN',
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  matched_at   timestamptz,
  matched_with text,
  approval_token text,
  settled_by   text
);

-- 列の後付け（既存テーブル向け・IF NOT EXISTS で冪等）
alter table public.orders add column if not exists approval_token text;
alter table public.orders add column if not exists settled_by text;

-- customer_id を text 化：旧スキーマは uuid + auth.users への FK。
-- FK を外し、uuid なら text へ変換する。
do $$
declare r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and contype = 'f'
  loop
    execute format('alter table public.orders drop constraint %I', r.conname);
  end loop;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'customer_id' and data_type = 'uuid'
  ) then
    alter table public.orders alter column customer_id type text using customer_id::text;
  end if;
end $$;

-- status の CHECK 制約を貼り直して PENDING_APPROVAL を許可する。
do $$
declare r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.orders drop constraint %I', r.conname);
  end loop;

  alter table public.orders
    add constraint orders_status_check
    check (status in ('OPEN', 'MATCHED', 'CANCELLED', 'EXPIRED', 'PENDING_APPROVAL'));
end $$;

-- ────────────────────────────────────────────────────────────
-- trades
-- ────────────────────────────────────────────────────────────
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

alter table public.trades add column if not exists settled_by text not null default 'auto';

-- trades.customer_id も text 化（orders と同じ理由）。
do $$
declare r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.trades'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%customer_id%'
  loop
    execute format('alter table public.trades drop constraint %I', r.conname);
  end loop;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'trades'
      and column_name = 'customer_id' and data_type = 'uuid'
  ) then
    alter table public.trades alter column customer_id type text using customer_id::text;
  end if;
end $$;

-- ────────────────────────────────────────────────────────────
-- settings（key/value 設定。auto_settle_min / auto_settle_max を保持）
-- ────────────────────────────────────────────────────────────
create table if not exists public.settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────
-- インデックス
-- ────────────────────────────────────────────────────────────
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

-- ────────────────────────────────────────────────────────────
-- RLS: ポリシー無しで有効化 → anon / authenticated は全拒否。
-- サーバ（service_role / service key）は RLS をバイパスするため動作する。
-- これにより万一 anon キーが流出してもこれらのテーブルは読めない。
-- ────────────────────────────────────────────────────────────
alter table public.orders   enable row level security;
alter table public.trades   enable row level security;
alter table public.settings enable row level security;
