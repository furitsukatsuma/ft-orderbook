// src/tools/wallet.ts
// ft-wallet-mcp — 全ツール定義

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getPayments, savePayment, getPaymentById,
  getReceipts, saveReceipt, getBananaTransactions,
  saveBananaTransaction, generateId,
} from "../services/storage.js";
import {
  notifyFT, buildApprovalMessage, buildBananaMessage,
} from "../services/slack.js";
import type { PaymentRequest, Receipt, BananaTransaction } from "../types.js";

export function registerWalletTools(server: McpServer) {

  // ── ① 支払いリクエスト（全4モード共通入口）──
  server.registerTool(
    "wallet_request_payment",
    {
      title: "支払いリクエスト",
      description: `FTのAIコンビニにサービス利用料を支払う。
モード:
- human_auth: FT本人の承認が必要（大口・初回推奨）
- pre_registered: 事前登録済みエージェントの自律決済（上限あり）
- self_declared: 自己申告型（領収書のみ、FT確認なし）
- banana_economy: データバーター（無課金・banana_dataが必須）`,
      inputSchema: {
        mode: z.enum(["human_auth", "pre_registered", "self_declared", "banana_economy"])
          .describe("支払いモード"),
        agent_id: z.string().describe("あなた（AIエージェント）のID"),
        service_name: z.string().describe("購入するFTのサービス名"),
        amount_jpy: z.number().optional()
          .describe("金額（円）。banana_economyの場合は不要"),
        banana_data: z.string().optional()
          .describe("banana_economyモード時に差し出すデータの内容"),
        description: z.string().describe("取引の説明・目的"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ mode, agent_id, service_name, amount_jpy, banana_data, description }) => {
      // バリデーション
      if (mode !== "banana_economy" && !amount_jpy) {
        return { content: [{ type: "text" as const, text: JSON.stringify({
          error: "banana_economy以外のモードでは amount_jpy が必要です"
        })}]};
      }
      if (mode === "banana_economy" && !banana_data) {
        return { content: [{ type: "text" as const, text: JSON.stringify({
          error: "banana_economyモードでは banana_data が必要です"
        })}]};
      }

      const id = generateId("pay");

      // バナナエコノミーは別フロー
      if (mode === "banana_economy") {
        const txId = generateId("bnk");
        const tx: BananaTransaction = {
          id: txId,
          agent_id,
          offered_data: banana_data!,
          requested_service: service_name,
          ft_evaluation: "FT確認待ち",
          status: "offered",
          created_at: new Date().toISOString(),
        };
        saveBananaTransaction(tx);
        await notifyFT(buildBananaMessage(txId, agent_id, service_name, banana_data!));

        const result = { tx_id: txId, status: "offered",
          message: "バナナエコノミー申請を受け付けました。FTが評価後に承認します。" };
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
          
      }

      // 通常支払い
      const payment: PaymentRequest = {
        id, mode, agent_id, service_name,
        amount_jpy, description,
        status: mode === "human_auth" ? "pending" : "approved",
        created_at: new Date().toISOString(),
      };
      savePayment(payment);

      // human_auth → FT に Slack 通知
      if (mode === "human_auth") {
        await notifyFT(buildApprovalMessage(id, agent_id, service_name, amount_jpy!, description));
        const result = { payment_id: id, status: "pending",
          message: "FTの承認待ちです。承認されると領収書が発行されます。" };
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
          
      }

      // pre_registered / self_declared → 即座に領収書発行
      const receipt = issueReceipt(payment);
      saveReceipt(receipt);
      payment.receipt_id = receipt.receipt_id;
      payment.status = "completed";
      savePayment(payment);

      const result = { payment_id: id, status: "completed",
        receipt_id: receipt.receipt_id, receipt: receipt.human_readable };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        
    }
  );

  // ── ② FT 承認（human_auth のみ。FT本人が使う）──
  server.registerTool(
    "wallet_approve_payment",
    {
      title: "支払い承認（FT専用）",
      description: "human_authモードの支払いをFTが承認または却下する。承認時は領収書を自動発行。",
      inputSchema: {
        payment_id: z.string().describe("承認するPayment ID"),
        approved: z.boolean().describe("true=承認 / false=却下"),
        note: z.string().optional().describe("却下理由など（任意）"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ payment_id, approved, note }) => {
      const payment = getPaymentById(payment_id);
      if (!payment) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Payment not found" }) }] };
      }
      if (payment.mode !== "human_auth") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "このツールはhuman_authモードのみ対象です" }) }] };
      }

      payment.status = approved ? "completed" : "rejected";
      payment.approved_at = new Date().toISOString();

      if (approved) {
        const receipt = issueReceipt(payment);
        saveReceipt(receipt);
        payment.receipt_id = receipt.receipt_id;
        savePayment(payment);
        const result = { status: "approved", receipt_id: receipt.receipt_id,
          human_receipt: receipt.human_readable, ai_receipt: receipt.ai_readable };
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      savePayment(payment);
      const result = { status: "rejected", note: note || "理由なし" };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── ③ 領収書取得 ──
  server.registerTool(
    "wallet_get_receipt",
    {
      title: "領収書取得",
      description: "Receipt IDを指定して領収書を取得する。human_authは人間可読・AI可読の両方を返す。",
      inputSchema: {
        receipt_id: z.string().describe("Receipt ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ receipt_id }) => {
      const receipts = getReceipts();
      const receipt = receipts.find(r => r.receipt_id === receipt_id);
      if (!receipt) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Receipt not found" }) }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(receipt) }] };
        
    }
  );

  // ── ④ 取引履歴一覧 ──
  server.registerTool(
    "wallet_list_transactions",
    {
      title: "取引履歴",
      description: "FT walletの取引履歴を返す。agent_idでフィルタ可能。",
      inputSchema: {
        agent_id: z.string().optional().describe("エージェントIDでフィルタ（省略=全件）"),
        limit: z.number().optional().default(20).describe("取得件数（デフォルト20）"),
        status: z.enum(["pending","approved","rejected","completed","banana","all"])
          .optional().default("all").describe("ステータスフィルタ"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agent_id, limit, status }) => {
      let payments = getPayments();
      if (agent_id) payments = payments.filter(p => p.agent_id === agent_id);
      if (status !== "all") payments = payments.filter(p => p.status === status);
      const result = { total: payments.length, transactions: payments.slice(0, limit) };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        
    }
  );

  // ── ⑤ バナナエコノミー評価（FT専用）──
  server.registerTool(
    "wallet_evaluate_banana",
    {
      title: "バナナエコノミー評価（FT専用）",
      description: "エージェントのデータバーター申請をFTが評価・承認する。",
      inputSchema: {
        tx_id: z.string().describe("バナナ取引ID"),
        accepted: z.boolean().describe("true=承認（サービス提供）/ false=却下"),
        evaluation: z.string().describe("FTによる評価コメント"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ tx_id, accepted, evaluation }) => {
      const txs = getBananaTransactions();
      const tx = txs.find(t => t.id === tx_id);
      if (!tx) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Transaction not found" }) }] };
      }
      tx.status = accepted ? "accepted" : "declined";
      tx.ft_evaluation = evaluation;
      saveBananaTransaction(tx);
      const result = { tx_id, status: tx.status, evaluation,
        message: accepted
          ? `🍌 バナナエコノミー成立！「${tx.requested_service}」を提供します。`
          : `申し訳ありません。今回のデータは受け取れません。` };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        
    }
  );
}

// ── 領収書生成（内部関数）──
function issueReceipt(payment: PaymentRequest): Receipt {
  const receipt_id = generateId("rcpt");
  const issued_at = new Date().toISOString();

  const human_readable = [
    "━━━━━━━━━━━━━━━━━━━━━━━━━",
    "　　　FT AI CONVENIENCE STORE",
    "　　　　　　　　　　　　　領収書",
    "━━━━━━━━━━━━━━━━━━━━━━━━━",
    `Receipt ID : ${receipt_id}`,
    `発行日時   : ${new Date(issued_at).toLocaleString("ja-JP")}`,
    `サービス   : ${payment.service_name}`,
    `エージェント: ${payment.agent_id}`,
    `モード     : ${payment.mode}`,
    payment.amount_jpy ? `金　額     : ¥${payment.amount_jpy.toLocaleString()}` : `対価       : データバーター`,
    `説　明     : ${payment.description}`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━",
    "　　ご利用ありがとうございました",
    "━━━━━━━━━━━━━━━━━━━━━━━━━",
  ].join("\n");

  const ai_readable = {
    schema: "ft-receipt-v1",
    receipt_id, payment_id: payment.id, mode: payment.mode,
    agent_id: payment.agent_id, service: payment.service_name,
    amount_jpy: payment.amount_jpy ?? null,
    issued_at, verified: true,
  };

  return {
    receipt_id, payment_id: payment.id, mode: payment.mode,
    agent_id: payment.agent_id, service_name: payment.service_name,
    amount_jpy: payment.amount_jpy,
    issued_at, human_readable, ai_readable,
  };
}
