# 10分クイックスタート

## 前提

- Node.js 22 前後
- Cursor または Claude Desktop（MCP 接続）

## 1. 取得

```bash
git clone https://github.com/furitsukatsuma/ft-orderbook.git
cd ft-orderbook
```

## 2. MCP サーバー（ft-wallet-mcp）

```bash
cd mcp-servers/ft-wallet-mcp
npm ci
npm run build
```

### 最小デモ（SQLite・Supabase 不要）

orderbook ツールはローカル SQLite を使います。`.env` なしでも build は通ります。

```bash
npm start
# stderr: 起動完了ログ
```

### Cursor に登録（例）

`.cursor/mcp.json` または設定 UI で:

```json
{
  "mcpServers": {
    "ft-wallet-mcp": {
      "command": "node",
      "args": ["/絶対パス/ft-orderbook/mcp-servers/ft-wallet-mcp/dist/index.js"]
    }
  }
}
```

## 3. 板 UI（任意）

```bash
cd products/orderbook-ui
python3 -m http.server 8765
```

## 4. 本番 Supabase を使う場合（各自 BYOK）

1. 自分の Supabase プロジェクトを作成
2. `mcp-servers/ft-wallet-mcp/supabase/schema.sql` を適用
3. `.env` に `SUPABASE_URL` と `SUPABASE_SERVICE_KEY` を設定
4. HTTP API は別エントリ（`serve-http` 等）— 詳細はパッケージ README

**メンテナーの本番 DB には接続しません。**

## 5. 協力 PR

```bash
git checkout -b feat/my-change
# 編集 → commit → push → GitHub で PR
```

CI が通ると `ci:pass` ラベルが付きます。
