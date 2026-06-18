// src/services/notify.ts
// 汎用 Webhook 通知アダプタ（サーバ側のみ・秘密はクライアントへ出さない）
//
// NOTIFY_WEBHOOK_URL を 1 つ設定するだけで、Slack / Discord / 任意の Webhook に届く。
//   - Slack   : payload.text を読む
//   - Discord : payload.content を読む
//   - 汎用    : title / message / event / meta を読む
//
// 未設定なら静かにスキップ（決済処理を止めない）。

const WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL ?? "";

export type NotifyEvent = {
  event: string;
  title: string;
  text: string;
  meta?: Record<string, unknown>;
};

export async function notify(e: NotifyEvent): Promise<void> {
  if (!WEBHOOK_URL) return;

  const payload = {
    text: `*${e.title}*\n${e.text}`, // Slack
    content: `**${e.title}**\n${e.text}`, // Discord
    event: e.event,
    title: e.title,
    message: e.text,
    meta: e.meta ?? {},
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    // 通知失敗は致命にしない（板処理は継続）
    console.error("[notify] webhook failed:", (err as Error).message);
  }
}
