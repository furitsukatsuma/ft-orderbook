# ft-wallet-mcp

FT AI Convenience Store 向け **MCP サーバー**。  
ウォレット（支払い・領収書）と **ft-orderbook**（指値・成り行き板）を AI エージェントから操作します。

> **ステータス: WIP（開発中）** — 本番決済・認証・データ正本の一本化は未完了です。

## ドキュメントの見分け

| 読みたいこと | どこを見る |
|--------------|------------|
| プロダクト全体像 | [`docs/products/ft-orderbook.md`](../../docs/products/ft-orderbook.md) |
| Supabase keep-alive 等の運用 | [`docs/ops/keep-ft-orderbook-alive.ja.md`](../../docs/ops/keep-ft-orderbook-alive.ja.md) |
| 他 MCP との統合方針 | [`../README.md`](../README.md) |

## 構成

```
src/
  index.ts          # MCP stdio エントリ（ツール登録）
  http-server.ts    # REST API + Webhook（Supabase）
  sqlite-db.ts      # MCP orderbook 用 SQLite
  db.ts             # Supabase クライアント（HTTP 用）
  tools/
    wallet.ts       # 決済・領収書ツール
    orderbook.ts    # 板ツール（SQLite）
supabase/schema.sql # 本番 DB スキーマ（orders / trades）
```

### データ正本（現状）

| 経路 | 保存 |
|------|------|
| MCP `wallet_*` orderbook ツール | SQLite |
| HTTP API / 本番 UI | Supabase |

→ **将来は Supabase 一本化を推奨**（[`docs/products/ft-orderbook.md`](../../docs/products/ft-orderbook.md) 参照）

## セットアップ

```bash
cp .env.example .env
npm ci
npm run build
npm start          # MCP stdio
# HTTP API は別エントリ（serve-http 等）— 要 .env の SUPABASE_* 
```

### 主な環境変数

| 変数 | 用途 |
|------|------|
| `SLACK_WEBHOOK_URL` | FT 承認通知（wallet human_auth） |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | HTTP API・本番板 |
| `VALID_API_KEYS` | HTTP API の `x-api-key`（カンマ区切り） |
| `FT_WALLET_HTTP_PORT` | HTTP ポート（既定 3099） |

実値は **`.env` のみ**。Git にコミットしない。

## MCP ツール一覧

### Orderbook

| ツール | 説明 |
|--------|------|
| `wallet_place_order` | 指値 / 成り行き注文 |
| `wallet_check_order` | ステータス確認 |
| `wallet_cancel_order` | キャンセル |
| `wallet_get_orderbook` | 板表示 |

### Wallet

| ツール | 説明 |
|--------|------|
| `wallet_request_payment` | 支払いリクエスト（4モード） |
| `wallet_approve_payment` | FT 承認（human_auth） |
| `wallet_get_receipt` | 領収書取得 |
| `wallet_list_transactions` | 取引履歴 |
| `wallet_evaluate_banana` | バナナエコノミー評価 |

## AI エージェント向けの設計

- ツール説明・Zod スキーマで **引数が明示**（Claude / Cursor 向き）
- 応答は JSON テキスト（パースしやすい）
- [`ai-agent-sql-cheatsheet.sql`](ai-agent-sql-cheatsheet.sql) — SQL を書けるモデル向け

### 接続例（Claude Desktop）

[`claude-desktop-config-snippet.json`](claude-desktop-config-snippet.json) を編集し、**`args` のパスを自分の clone 先に変更**してください。

## 関連パッケージ

- [ft-agent-toolkit](../ft-agent-toolkit/SKILL.md) — 購入前の意図確認・交渉 Layer
- [orderbook UI](../../products/orderbook-ui/README.md) — 静的フロント

## 未完成メモ

- [ ] MCP と Supabase のデータ同期
- [ ] 本番向け認証（customer_id / API key）
- [ ] Stripe 本番接続
- [ ] 英語ドキュメント
- [ ] npm パッケージ化 or リモート MCP
