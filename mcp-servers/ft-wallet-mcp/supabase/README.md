# Supabase スキーマ / マイグレーション

ft-orderbook の板・約定・承認・設定データの**正本（source of truth）**を Supabase（Postgres）に置く。
MCP（`FT_WALLET_BACKEND=supabase`）と管理UI（`products/orderbook-admin`）は**同じテーブル**を R/W する。

## ファイル

| ファイル | 用途 |
|---|---|
| `schema.sql` | 新規プロジェクトを一発で構築する最終形スキーマ |
| `migrations/0001_orderbook_v0_7_0.sql` | 既存（旧 `schema.sql` 適用済み）からの冪等 ALTER 移行 |

両者は同じ最終形（`orders`/`trades`/`settings`、`PENDING_APPROVAL`・`approval_token`・`settled_by`、`customer_id text`）に収束する。どちらも**何度実行しても安全**。

## テーブル概要

- `orders` — 注文。`status in (OPEN, MATCHED, CANCELLED, EXPIRED, PENDING_APPROVAL)`、`approval_token`（taker 側のみ保持）、`settled_by`（`auto` / `human:<id>`）。`customer_id` は text。
- `trades` — 約定。`settled_by`、`fee_usd`（taker のみ手数料、手数料率 1.975%）。
- `settings` — `auto_settle_min` / `auto_settle_max`（自律約定レンジ）を key/value で保持。

RLS は有効・ポリシー無し → **service_role（service key）のみ** R/W 可能。anon/authenticated は全拒否（万一 anon キーが漏れても読めない）。サーバ側は必ず **service key** を使う。

## 適用方法

### A. Supabase MCP（このリポジトリで繋がっている場合）

エージェントが `plugin-supabase-supabase` の `apply_migration` で
`migrations/0001_orderbook_v0_7_0.sql` を適用できる。プロジェクトが未接続なら下記 B/C を使う。

### B. Supabase ダッシュボード（手動・最短）

1. https://supabase.com/dashboard → 対象プロジェクト → **SQL Editor**
2. 新規プロジェクトなら `schema.sql`、既存移行なら `migrations/0001_orderbook_v0_7_0.sql` の中身を貼り付け
3. **Run**

### C. Supabase CLI（ローカル/CI）

```bash
# 接続文字列は Dashboard → Project Settings → Database → Connection string (URI)
psql "postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres" \
  -f migrations/0001_orderbook_v0_7_0.sql
```

## 適用後の確認

```sql
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='orders' order by ordinal_position;
-- approval_token / settled_by があり、customer_id が text であること

select pg_get_constraintdef(oid) from pg_constraint
where conrelid='public.orders'::regclass and conname='orders_status_check';
-- PENDING_APPROVAL を含むこと
```

## サーバ側 env（実値はコミット禁止）

| 変数 | 用途 |
|---|---|
| `SUPABASE_URL` | プロジェクト URL（`https://<ref>.supabase.co`） |
| `SUPABASE_SERVICE_KEY` | service_role key（**サーバ専用・秘密**） |

MCP は `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` があれば自動で supabase バックエンドを使う
（`FT_WALLET_BACKEND` で明示も可。無ければ sqlite フォールバック）。
