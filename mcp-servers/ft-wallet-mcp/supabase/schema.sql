-- ft-wallet-mcp / Supabase schema
-- users は auth.users を利用

create extension if not exists pgcrypto;

create table if not exists public.orders (
  order_id text primary key,
  type text not null check (type in ('limit', 'market')),
  side text not null check (side in ('buy', 'sell')),
  service text not null,
  price numeric,
  qty integer not null default 1,
  customer_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'OPEN' check (status in ('OPEN', 'MATCHED', 'CANCELLED', 'EXPIRED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  matched_at timestamptz,
  matched_with text
);

create table if not exists public.trades (
  trade_id text primary key,
  order_id text not null references public.orders(order_id) on delete restrict,
  service text not null,
  side text not null check (side in ('buy', 'sell')),
  price numeric not null,
  qty integer not null default 1,
  total_usd numeric not null,
  fee_usd numeric not null default 0,
  currency text not null default 'USD',
  customer_id uuid not null references auth.users(id) on delete restrict,
  traded_at timestamptz not null default now()
);

create index if not exists idx_orders_service_side_status
  on public.orders(service, side, status);

create index if not exists idx_orders_expires
  on public.orders(expires_at);

create index if not exists idx_trades_service
  on public.trades(service);
