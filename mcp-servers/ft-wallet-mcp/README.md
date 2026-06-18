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
| `NOTIFY_WEBHOOK_URL` | 汎用 Webhook 通知（Slack / Discord / 任意）。承認待ち・約定・レンジ更新を通知 |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | HTTP API・本番板 |
| `VALID_API_KEYS` | HTTP API の `x-api-key`（カンマ区切り） |
| `FT_WALLET_HTTP_PORT` | HTTP ポート（既定 3099） |
| `FT_WALLET_DB_PATH` | SQLite 保存先（省略可） |

実値は **`.env` のみ**。Git にコミットしない。秘密はサーバ側だけに置き、クライアントへ出さない。

## 約定モデル（人間の金額レンジ + 認証付き承認）

口座主（人間）が **自律約定レンジ `[min, max]`** を決め、その範囲内のマッチは AI が自律で約定します。範囲外は **人間の承認**が必要です。

```
注文がマッチ
  ├─ 約定価格が [min, max] 内 → 自律約定（settled_by=auto）+ 通知
  └─ 範囲外 → PENDING_APPROVAL（両注文を保留）
        → Webhook へ承認トークンを通知
        → 人間が wallet_approve_settlement(order_id, token) で確定
           （トークン一致 = 人間認証。settled_by=human:<id>）
```

- **レンジ未設定なら全件が人間承認**（安全側デフォルト）。
- 承認トークンは **通知先（Webhook）にのみ**送られ、AI への応答には出ません。
- 板はデータ保存のみ。入力はホワイトリスト整形＋プレースホルダSQLで、**不正コードは混入しません**。

## MCP ツール一覧

### Orderbook

| ツール | 説明 |
|--------|------|
| `wallet_place_order` | 指値 / 成り行き注文（マッチ時にレンジ判定） |
| `wallet_check_order` | ステータス確認 |
| `wallet_cancel_order` | キャンセル |
| `wallet_get_orderbook` | 板表示 |
| `wallet_set_auto_settle_band` | 自律約定レンジ `[min,max]` を設定（人間が決める） |
| `wallet_get_auto_settle_band` | 現在のレンジ・約定モード確認 |
| `wallet_approve_settlement` | レンジ外マッチをトークン認証で承認・確定 |
| `wallet_reject_settlement` | レンジ外マッチを却下し板へ戻す |

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

## MCP クライアント接続ガイド（共通）

本サーバは **stdio** で起動する MCP サーバーです。各クライアントには共通して次を指定します。

- **コマンド**: `node`
- **引数**: ビルド済みエントリ `dist/index.js` の**絶対パス**
  （= `<REPO_ROOT>/mcp-servers/ft-wallet-mcp/dist/index.js`）
- **環境変数**: 通知を使うなら `NOTIFY_WEBHOOK_URL`（Slack/Discord/任意の Webhook URL）
  - 承認トークンはこの通知先にのみ届きます。秘密はサーバ側のみ。クライアントUIへは出しません。

### 0. 事前にビルド（必須）

```bash
cd <REPO_ROOT>/mcp-servers/ft-wallet-mcp
cp .env.example .env        # NOTIFY_WEBHOOK_URL を設定（任意）
npm ci
npm run build               # → dist/index.js を生成
```

> `<REPO_ROOT>` は clone 先（例: `~/ft-work/ft-automation`）。パスはすべて絶対パスで指定してください。

### 1. Claude Desktop

`claude_desktop_config.json`（macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "ft-wallet-mcp": {
      "command": "node",
      "args": ["<REPO_ROOT>/mcp-servers/ft-wallet-mcp/dist/index.js"],
      "env": {
        "NOTIFY_WEBHOOK_URL": "https://hooks.slack.com/services/XXX/YYY/ZZZ"
      }
    }
  }
}
```

同梱の [`claude-desktop-config-snippet.json`](claude-desktop-config-snippet.json) も利用できます。

### 2. Cursor

`~/.cursor/mcp.json`（プロジェクト単位なら `<project>/.cursor/mcp.json`）

```json
{
  "mcpServers": {
    "ft-wallet-mcp": {
      "command": "node",
      "args": ["<REPO_ROOT>/mcp-servers/ft-wallet-mcp/dist/index.js"],
      "env": { "NOTIFY_WEBHOOK_URL": "https://hooks.slack.com/services/XXX/YYY/ZZZ" }
    }
  }
}
```

### 3. GPT 系（OpenAI Agents SDK / 対応クライアント）

stdio MCP サーバとして登録します（Python の Agents SDK 例）。

```python
from agents.mcp import MCPServerStdio

ft_wallet = MCPServerStdio(
    params={
        "command": "node",
        "args": ["<REPO_ROOT>/mcp-servers/ft-wallet-mcp/dist/index.js"],
        "env": {"NOTIFY_WEBHOOK_URL": "https://hooks.slack.com/services/XXX/YYY/ZZZ"},
    }
)
# agent = Agent(name="buyer", mcp_servers=[ft_wallet], ...)
```

> 注: ChatGPT デスクトップ等で「コネクタ/MCP」を直接登録できる場合も、コマンドは `node`、
> 引数は `dist/index.js` の絶対パスで同じです。HTTP 専用クライアントには
> [後述の汎用方法](#5-汎用-mcp-クライアントhttp-が必要な場合)を使ってください。

### 4. Gemini 系（Gemini CLI / 対応クライアント）

Gemini CLI の `settings.json`（`~/.gemini/settings.json`）に `mcpServers` を追加:

```json
{
  "mcpServers": {
    "ft-wallet-mcp": {
      "command": "node",
      "args": ["<REPO_ROOT>/mcp-servers/ft-wallet-mcp/dist/index.js"],
      "env": { "NOTIFY_WEBHOOK_URL": "https://hooks.slack.com/services/XXX/YYY/ZZZ" }
    }
  }
}
```

### 5. 汎用 MCP クライアント / HTTP が必要な場合

- **stdio 対応クライアント**: 上記と同様に `command=node` / `args=[dist/index.js 絶対パス]` を渡します。
- **stdio を直接話せないクライアント**: `mcp-remote` などのブリッジを挟みます。

```jsonc
{
  "mcpServers": {
    "ft-wallet-mcp": {
      "command": "node",
      "args": ["<REPO_ROOT>/mcp-servers/ft-wallet-mcp/dist/index.js"],
      "env": { "NOTIFY_WEBHOOK_URL": "https://hooks.slack.com/services/XXX/YYY/ZZZ" }
    }
  }
}
```

### 接続後の最小チェック

1. クライアントのツール一覧に `wallet_*`（`wallet_place_order` など）が出ること。
2. `wallet_get_auto_settle_band` を実行 → レンジ未設定なら「すべて人間承認」が返る。
3. `wallet_set_auto_settle_band({min,max,operator_id})` でレンジ設定 → 範囲外マッチで
   `NOTIFY_WEBHOOK_URL` に承認トークンが届くこと。
4. ブラウザから承認/却下したい場合は [orderbook-admin 管理UI](../../products/orderbook-admin/README.md) を使用。

## 関連パッケージ

- [ft-agent-toolkit](../ft-agent-toolkit/SKILL.md) — 購入前の意図確認・交渉 Layer
- [orderbook UI](../../products/orderbook-ui/README.md) — 静的フロント（板表示）
- [orderbook-admin](../../products/orderbook-admin/README.md) — 口座主向け管理UI（レンジ設定・承認/却下。Astro SSR）

## 未完成メモ

- [ ] MCP と Supabase のデータ同期
- [ ] 本番向け認証（customer_id / API key）
- [ ] Stripe 本番接続
- [ ] 英語ドキュメント
- [ ] npm パッケージ化 or リモート MCP
