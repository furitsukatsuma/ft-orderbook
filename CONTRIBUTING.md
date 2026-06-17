# 協力してくれる方へ（CONTRIBUTING）

**fork → PR → CI が通ったらマージ** で回します。  
チャットや DM で都度許可をもらう必要はありません（public 化後を想定）。

## いまのリポジトリについて

- **本リポジトリは **public 配布用** です。
- 招待された開発者は clone してブランチ → PR でも OK です。
- **Collaborator 招待（write 権限）は原則しません。** マージはメンテナー側で PR 経由に統一します。

## 基本フロー（public 後）

```
1. GitHub 上で fork
2. ブランチを切って変更
3. main へ Pull Request
4. PR CI が自動実行（build）
5. ci:pass ラベルが付いたらマージ可能
6. メンテナーがまとめてマージ（あなたへの個別返信は不要）
```

## 開発の入口

| 触りたいもの | パス |
|--------------|------|
| ft-orderbook / wallet MCP | `mcp-servers/ft-wallet-mcp/` |
| エージェント交渉ツール | `mcp-servers/ft-agent-toolkit/` |
| プロダクト概要 | `docs/` |

## ローカル確認

```bash
cd mcp-servers/ft-wallet-mcp
cp .env.example .env   # 実値はコミットしない
npm ci && npm run build
```

## PR のルール

- **1 PR = 1 意図**（docs だけ / 1 パッケージだけ、がレビューしやすい）
- `.env` や API キーは **絶対にコミットしない**
- CI が赤い PR はマージしません。ログを見て修正を push してください

## CI（自動）

ワークフロー: `.github/workflows/pr-ci.yml`

| 変更パス | 実行内容 |
|----------|----------|
| `mcp-servers/ft-wallet-mcp/**` | `npm ci` + `npm run build` |
| `mcp-servers/ft-agent-toolkit/**` | 同上 |

成功すると PR に **`ci:pass`** ラベルが付きます。

## メンテナー（自分用メモ）

- 週1など **まとめて `ci:pass` の PR をマージ** で十分
- write 招待は、長期コメンティで PR が安定してから検討

## 質問・バグ報告

- **public 後:** GitHub Issue（テンプレートに沿って）
- 緊急でない限り、DM での個別承認は不要です
