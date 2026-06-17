// src/services/slack.ts
// Slack Webhook で FT に通知を送る

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

interface SlackMessage {
  text: string;
  blocks?: object[];
}

export async function notifyFT(message: SlackMessage): Promise<void> {
  if (!WEBHOOK_URL) {
    console.warn("[ft-wallet] SLACK_WEBHOOK_URL が未設定です。通知をスキップします。");
    return;
  }
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
  } catch (err) {
    console.error("[ft-wallet] Slack通知失敗:", err);
  }
}

export function buildApprovalMessage(
  paymentId: string,
  agentId: string,
  service: string,
  amount: number,
  description: string
): SlackMessage {
  return {
    text: `💰 支払い承認リクエスト: ${service} ¥${amount.toLocaleString()}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "💰 FT Wallet — 承認リクエスト" }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*サービス:*\n${service}` },
          { type: "mrkdwn", text: `*金額:*\n¥${amount.toLocaleString()}` },
          { type: "mrkdwn", text: `*エージェント:*\n${agentId}` },
          { type: "mrkdwn", text: `*Payment ID:*\n\`${paymentId}\`` },
        ]
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*説明:*\n${description}` }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `承認: \`wallet_approve_payment\` に \`${paymentId}\` と \`approved: true\` を渡してください`
          }
        ]
      }
    ]
  };
}

export function buildBananaMessage(
  txId: string,
  agentId: string,
  service: string,
  offeredData: string
): SlackMessage {
  return {
    text: `🍌 バナナエコノミー申請: ${agentId} が ${service} をリクエスト`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🍌 バナナエコノミー申請" }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*エージェント:*\n${agentId}` },
          { type: "mrkdwn", text: `*希望サービス:*\n${service}` },
          { type: "mrkdwn", text: `*TX ID:*\n\`${txId}\`` },
        ]
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*差し出すデータ:*\n${offeredData}` }
      }
    ]
  };
}
