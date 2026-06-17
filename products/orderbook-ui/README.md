# FT Orderbook UI

静的 1 ファイル（`index.html`）。ローカルまたは任意の静的ホストで配布できます。

## ローカル

```bash
cd products/orderbook-ui
python3 -m http.server 8765
# → http://localhost:8765/index.html
```

API エンドポイントは `index.html` 内の設定に依存します。自己ホスト時は MCP / HTTP API の URL を合わせてください。

詳細: リポジトリ直下 [README.md](../../README.md) と [docs/quickstart.md](../../docs/quickstart.md)
