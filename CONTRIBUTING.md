# 協力してくれる方へ（CONTRIBUTING）

**fork → PR → CI が通ったらマージ** で回します。  
チャットや DM で都度許可をもらう必要はありません。

## このリポジトリについて

- **public 無料配布**（MIT）— 使えそうならどうぞ、BYOK・自己ホスト
- **利益目的の販売はメンテナー側では行いません**
- **write 招待は原則しません** — PR 経由でお願いします

## 基本フロー

```
1. GitHub 上で fork
2. ブランチを切って変更
3. main へ Pull Request
4. PR CI が自動 build
5. ci:pass ラベル → マージ可能
6. メンテナーがまとめてマージ
```

## 開発の入口

| 触りたいもの | パス |
|--------------|------|
| ft-orderbook / wallet MCP | `mcp-servers/ft-wallet-mcp/` |
| エージェント交渉ツール | `mcp-servers/ft-agent-toolkit/` |
| クイックスタート | `docs/quickstart.md` |
| Issue の書き方 | `docs/issues.md` |

## ローカル確認

```bash
cd mcp-servers/ft-wallet-mcp
cp .env.example .env   # 実値はコミットしない
npm ci && npm run build
```

## PR のルール

- **1 PR = 1 意図**
- `.env` や API キーは **コミットしない**
- CI が赤い PR はマージしません

## 含まれないもの

個人運用・Secrets・keep-alive などは [docs/WHAT-IS-NOT-HERE.md](docs/WHAT-IS-NOT-HERE.md) を参照。

## 質問・要望・「使いにくい」など

**GitHub Issue でどうぞ**（DM 不要）。

- 例: 「色が見えない」「使いにくい」「こうしてほしい」
- 書き方: [docs/issues.md](docs/issues.md)
- コードまで直す人 → 上の PR フローへ
