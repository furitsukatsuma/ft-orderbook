// src/tools/orderbook-schemas.ts
// 取引板ツールの zod スキーマ（バックエンド非依存）。
// SQLite / Supabase いずれのバックエンドでもツールの入出力契約は同一。
// 実体ハンドラは src/backends/orderbook.ts が env に応じて差し込む。

import { z } from "zod";

// 各ツールの handler キーは、バックエンドが返すハンドラ集合の関数名に対応する。
export const orderbookSchemas = {
  wallet_place_order: {
    description: "指値・成り行き注文を出す。買いたいAIは buy、売るオーナー側は sell を指定",
    schema: z.object({
      type: z.enum(["limit", "market"]).describe("limit=指値 / market=成り行き"),
      side: z.enum(["buy", "sell"]).describe("buy=購入 / sell=販売"),
      service: z.string().describe("取引するサービス名（例: SQL最適化、コードレビュー）"),
      price: z.number().optional().describe("指値価格（ドル）。成り行きの場合は省略"),
      timeout_minutes: z.number().min(1).max(1440).describe("有効期限（分）。売り手が決定権を持つ"),
      customer_id: z.string().describe("注文者のID"),
    }),
    handler: "placeOrder",
  },
  wallet_check_order: {
    description: "注文のステータスを確認する",
    schema: z.object({ order_id: z.string().describe("注文ID") }),
    handler: "checkOrder",
  },
  wallet_cancel_order: {
    description: "未約定の注文をキャンセルする",
    schema: z.object({
      order_id: z.string().describe("注文ID"),
      customer_id: z.string().describe("注文者のID（本人確認）"),
    }),
    handler: "cancelOrder",
  },
  wallet_get_orderbook: {
    description: "サービスの取引板（板情報）を表示する",
    schema: z.object({ service: z.string().describe("確認するサービス名") }),
    handler: "getOrderBook",
  },
  wallet_set_auto_settle_band: {
    description: "自律約定の金額レンジを設定する（人間＝口座主が決める）。範囲内は自動約定、範囲外は人間承認",
    schema: z.object({
      min: z.number().min(0).describe("自律約定を許す最小価格（USD）"),
      max: z.number().min(0).describe("自律約定を許す最大価格（USD）"),
      operator_id: z.string().describe("設定する口座主のID"),
    }),
    handler: "setAutoSettleBand",
  },
  wallet_get_auto_settle_band: {
    description: "現在の自律約定レンジと約定モードを確認する",
    schema: z.object({}),
    handler: "getAutoSettleBandInfo",
  },
  wallet_approve_settlement: {
    description: "レンジ外でマッチした注文を、人間が承認トークンで認証して約定確定する",
    schema: z.object({
      order_id: z.string().describe("承認待ち注文のID（taker側）"),
      token: z.string().describe("通知（Webhook）に届いた承認トークン"),
      approver_id: z.string().describe("承認する人間のID"),
    }),
    handler: "approveSettlement",
  },
  wallet_reject_settlement: {
    description: "レンジ外でマッチした注文を却下し、両注文を板（OPEN）に戻す",
    schema: z.object({
      order_id: z.string().describe("承認待ち注文のID（taker側）"),
      token: z.string().describe("通知（Webhook）に届いた承認トークン"),
      approver_id: z.string().describe("却下する人間のID"),
    }),
    handler: "rejectSettlement",
  },
} as const;
