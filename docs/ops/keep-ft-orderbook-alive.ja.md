# Supabase 無料プロジェクトの稼働確認

対象は Supabase プロジェクト `ft-orderbook` です。

## 自動実行

GitHub Actions の `Keep Supabase active` が毎日 12:37（日本時間）に実行されます。
`orders`、`trades`、`settings` へ1件以下の読み取りを各1回だけ行い、データの追加・更新・削除はしません。

Supabase は無料プロジェクトの停止判定を、直近7日間の利用状況で行います。公式説明では、通常は毎日数回のDBリクエストが停止回避の目安とされているため、6日ごとの1回ではなく、この軽量な日次確認にしています。

## GitHub Secrets

リポジトリの Settings → Secrets and variables → Actions に、次の2件を登録します。

- `SUPABASE_URL`: 対象プロジェクトのAPI URL
- `SUPABASE_PUBLISHABLE_KEY`: 公開用キー（`service_role` / secret key は使用禁止）

## 見方と手動実行

1. GitHub の Actions を開く
2. 左側の `Keep Supabase active` を選ぶ
3. 最新実行が緑色なら正常
4. 手動確認は `Run workflow` → `Run workflow`

失敗時はGitHub Actionsの標準通知で確認できます。HTTP 540 の場合はプロジェクトが停止済みなので、Supabase Studioで一度 `Resume project` を実行してから、このワークフローを再実行します。
