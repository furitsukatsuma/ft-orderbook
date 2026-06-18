# かんたん使い方ガイド（初心者向け）

FT Orderbook の **「範囲内は AI が自律約定 / 範囲外は人間が承認」** という仕組みを、
コマンド例つきで最短に説明します。専門知識は不要です。

> このガイドは **MCP ツールの使い方** が中心です。管理キーや本番の配線は扱いません。
> 環境構築は [quickstart.md](quickstart.md) を先に済ませてください。

---

## 0. 全体像（30秒）

1. **あなた（人間）が金額レンジ `[min, max]` を決める**
2. AI が出した注文が他の注文とマッチしたとき…
   - **価格がレンジ内** → AI が**自律的に約定**（あなたの手は不要）
   - **価格がレンジ外** → **承認待ち**になり、通知（Slack/Discord）に**承認トークン**が届く
3. あなたが通知のトークンで**承認**すれば確定、**却下**すれば板に戻る

トークンは**通知先にしか出ない**ので、「通知を受け取れる本人だけが承認できる」＝**本人認証**になります。

---

## 1. 金額レンジの設定（どこで・どうやって）

レンジは **AI クライアント（Cursor / Claude Desktop など）** から MCP ツールを呼ぶだけです。
AI への指示文の例:

```
wallet_set_auto_settle_band を min=0, max=100, operator_id="自分の名前" で呼んで
```

ツールに渡る引数（JSON イメージ）:

```json
{ "min": 0, "max": 100, "operator_id": "your-name" }
```

これで「**0〜100 ドルの約定は自動 / それ以外は承認が必要**」になります。

現在のレンジを確認したいとき:

```
wallet_get_auto_settle_band を呼んで
```

> ⚠️ **未設定だと全件が人間承認になります**（安全側のデフォルト）。
> まず一度 `wallet_set_auto_settle_band` を呼んでレンジを決めるのがおすすめです。

---

## 2. 人間認証（承認）の流れ

レンジ外の価格でマッチすると、注文は `PENDING_APPROVAL`（承認待ち）になります。

1. 通知先（Slack / Discord）に **承認トークン** つきのメッセージが届く
2. そのトークンを使って **承認** または **却下** する

**承認して確定:**

```
wallet_approve_settlement を order_id="ord-xxxx", token="通知に届いたトークン", approver_id="自分の名前" で呼んで
```

```json
{ "order_id": "ord-xxxx", "token": "<通知に届いたトークン>", "approver_id": "your-name" }
```

**却下して板に戻す:**

```
wallet_reject_settlement を order_id="ord-xxxx", token="通知に届いたトークン", approver_id="自分の名前" で呼んで
```

> 🔐 **トークンは通知先にしか届きません。** 通知を受け取れる人だけが承認できる仕組みなので、
> トークンの一致がそのまま「口座主による本人承認」になります。トークンは他人に共有しないでください。

注文の状況を確認したいとき:

```
wallet_check_order を order_id="ord-xxxx" で呼んで
```

---

## 3. 通知設定（Slack / Discord）

承認トークンを受け取るために、通知先を 1 つだけ設定します。

1. Slack か Discord で **Incoming Webhook URL** を発行する
2. その URL を環境変数 `NOTIFY_WEBHOOK_URL` に入れる

`.env` の例:

```bash
NOTIFY_WEBHOOK_URL=https://hooks.slack.com/services/XXXX/YYYY/ZZZZ
# Discord の場合:
# NOTIFY_WEBHOOK_URL=https://discord.com/api/webhooks/XXXX/YYYY
```

- Slack でも Discord でも **同じ 1 つの変数**でOK（自動で形式を合わせて送ります）
- **未設定でも動きます**が、その場合は承認トークンが通知されず受け取れません

---

## 4. 板（オーダーブック）の見方

`board-demo.html` を**ブラウザで開くだけ**でデモが見られます（サーバ不要・`file://` 単体でOK）。

```bash
# ダブルクリックで開くか、ブラウザにドラッグするだけ
open products/orderbook-ui/board-demo.html   # macOS
```

見方のポイント:

- **緑の縁（レンジ内）** = 自律約定の対象
- **赤の縁（レンジ外）** = 人間の承認が必要
- 「🔐 人間の承認待ち」欄 = いま承認が必要な注文
- 上部の「自律約定レンジ」 = あなたが設定した `[min, max]`

> デモはサンプルデータ表示です。`board-demo.html` 内の「ライブ API」に切り替えると実データを取得しますが、
> その場合は `python3 -m http.server` 等で開くと確実です（CORS のため）。

---

## 5. スマホ・常時公開について（次のステップ）

いまのデモは手元のブラウザで見る前提です。**スマホからブラウザの管理画面で承認まで完結する常時公開構成（Cloudflare 等）** は、次のステップで対応予定です。具体的なホスティング手順やキー管理はこの公開ガイドでは扱いません。現時点では、AI クライアントから MCP ツールを呼ぶ方法（本ガイド）で承認まで完結できます。

---

## ツール早見表

| やりたいこと | ツール | 主な引数 |
|--------------|--------|----------|
| レンジ設定 | `wallet_set_auto_settle_band` | `min`, `max`, `operator_id` |
| レンジ確認 | `wallet_get_auto_settle_band` | （なし） |
| 注文を出す | `wallet_place_order` | `type`, `side`, `service`, `price`, `timeout_minutes`, `customer_id` |
| 注文状況 | `wallet_check_order` | `order_id` |
| 注文キャンセル | `wallet_cancel_order` | `order_id`, `customer_id` |
| 板を見る | `wallet_get_orderbook` | `service` |
| 承認（確定） | `wallet_approve_settlement` | `order_id`, `token`, `approver_id` |
| 却下（板に戻す） | `wallet_reject_settlement` | `order_id`, `token`, `approver_id` |

詳しい接続手順は [quickstart.md](quickstart.md) を参照してください。
