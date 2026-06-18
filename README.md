# ft-orderbook

**無料配布・BYOK** の AI 向け注文板（orderbook）と MCP ツール群です。  
利益目的ではなく、**協力的・友好的な開発者**が fork して使ったり PR したりするための **public ミラー** です。

> 個人運用・Secrets・keep-alive などは **含みません**。→ [docs/WHAT-IS-NOT-HERE.md](docs/WHAT-IS-NOT-HERE.md)

## 含まれるもの

| パス | 内容 |
|------|------|
| `mcp-servers/ft-wallet-mcp/` | ウォレット + orderbook MCP |
| `mcp-servers/ft-agent-toolkit/` | 購入・交渉 Layer ツール |
| `products/orderbook-ui/` | 静的板 UI |

## 使ってみる（最短）

```bash
git clone https://github.com/furitsukatsuma/ft-orderbook.git
cd ft-orderbook/mcp-servers/ft-wallet-mcp
cp .env.example .env   # 任意。SQLite デモなら空でも可
npm ci && npm run build && npm start
```

詳細: [docs/quickstart.md](docs/quickstart.md)

はじめての方は [かんたん使い方ガイド](docs/usage.ja.md)（レンジ設定・人間承認・通知・板の見方）もどうぞ。

要望・バグ・「使いにくい」は [Issues](https://github.com/furitsukatsuma/ft-orderbook/issues) へ（[書き方](docs/issues.md)）。

## 協力する

**fork → PR → CI（`ci:pass`）→ マージ**。DM での個別許可は不要です。

初めて Issue / PR / コメントをくれた方には、**絵文字リアクションだけ**自動で歓迎します（❤️ 🎉 🚀 など。本文での自動返信はしません）。

→ [CONTRIBUTING.md](CONTRIBUTING.md)

## ライセンス

MIT — 商用利用も可能ですが、メンテナーが課金・サポートを売る予定はありません（各自 BYOK・自己ホスト）。

## ステータス

WIP（開発中）。本番認証・データ正本の一本化などは未完了です。
