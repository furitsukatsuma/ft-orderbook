// ft-wallet-mcp v0.7.0
// src/tools/orderbook.ts — SQLite連携の注文板 + マッチングエンジン
// 約定方針: 人間が決めた金額レンジ内なら自律約定 / 範囲外は人間の認証付き承認

import { z } from "zod";
import { randomBytes } from "crypto";
import { db, stmts } from "../sqlite-db.js";
import { notify } from "../services/notify.js";

export type OrderType = "limit" | "market";
export type OrderSide = "buy" | "sell";
type DbOrderStatus = "OPEN" | "MATCHED" | "CANCELLED" | "EXPIRED" | "PENDING_APPROVAL";
const FEE_RATE = 0.01975;

// 設定キー（ハードコード定数のみ。ユーザー入力を SQL/識別子に渡さない）
const KEY_AUTO_MIN = "auto_settle_min";
const KEY_AUTO_MAX = "auto_settle_max";
const SERVICE_MAX_LEN = 100;

// サービス名のホワイトリスト整形（文字・数字・空白・ハイフンのみ、長さ制限）
function sanitizeService(input: string): string {
  return input.replace(/[^\p{L}\p{N}\s-]/gu, "").trim().slice(0, SERVICE_MAX_LEN);
}

function getSetting(key: string): string | undefined {
  const row = stmts.getSetting.get(key) as { value: string } | undefined;
  return row?.value;
}

// 自律約定レンジ。未設定なら null = すべて人間承認（安全側デフォルト）
function getAutoSettleBand(): { min: number; max: number } | null {
  const min = Number(getSetting(KEY_AUTO_MIN));
  const max = Number(getSetting(KEY_AUTO_MAX));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max < min) return null;
  return { min, max };
}

function isWithinBand(price: number): boolean {
  const band = getAutoSettleBand();
  return band !== null && price >= band.min && price <= band.max;
}

type DbOrderRow = {
  order_id: string;
  type: OrderType;
  side: OrderSide;
  service: string;
  price: number | null;
  qty: number;
  customer_id: string;
  status: DbOrderStatus;
  created_at: string;
  expires_at: string;
  matched_at: string | null;
  matched_with: string | null;
  approval_token: string | null;
  settled_by: string | null;
};

function generateOrderId(): string {
  return `ord-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
}

function generateTradeId(): string {
  return `trd-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
}

function roundUsd(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function toSqliteDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function expiryAfterMinutes(minutes: number): string {
  return toSqliteDate(new Date(Date.now() + minutes * 60 * 1000));
}

function findMatchForLimitOrder(side: OrderSide, service: string, price: number): DbOrderRow | undefined {
  if (side === "buy") {
    return db.prepare(`
      SELECT *
      FROM orders
      WHERE service = ?
        AND side = 'sell'
        AND status = 'OPEN'
        AND price IS NOT NULL
        AND price <= ?
        AND expires_at > datetime('now')
      ORDER BY price ASC, created_at ASC
      LIMIT 1
    `).get(service, price) as DbOrderRow | undefined;
  }

  return db.prepare(`
    SELECT *
    FROM orders
    WHERE service = ?
      AND side = 'buy'
      AND status = 'OPEN'
      AND price IS NOT NULL
      AND price >= ?
      AND expires_at > datetime('now')
    ORDER BY price DESC, created_at ASC
    LIMIT 1
  `).get(service, price) as DbOrderRow | undefined;
}

function findMatchForMarketOrder(side: OrderSide, service: string): DbOrderRow | undefined {
  if (side === "buy") {
    return db.prepare(`
      SELECT *
      FROM orders
      WHERE service = ?
        AND side = 'sell'
        AND status = 'OPEN'
        AND price IS NOT NULL
        AND expires_at > datetime('now')
      ORDER BY price ASC, created_at ASC
      LIMIT 1
    `).get(service) as DbOrderRow | undefined;
  }

  return db.prepare(`
    SELECT *
    FROM orders
    WHERE service = ?
      AND side = 'buy'
      AND status = 'OPEN'
      AND price IS NOT NULL
      AND expires_at > datetime('now')
    ORDER BY price DESC, created_at ASC
    LIMIT 1
  `).get(service) as DbOrderRow | undefined;
}

function getBookSummary(service: string) {
  const ask = stmts.getBestAsk.get(service) as { best_ask: number | null; sell_count: number };
  const bid = stmts.getBestBid.get(service) as { best_bid: number | null; buy_count: number };
  return {
    buy_count: bid.buy_count,
    sell_count: ask.sell_count,
    best_buy: bid.best_bid,
    best_sell: ask.best_ask,
  };
}

function getStatusMessage(status: DbOrderStatus): string {
  const messages: Record<DbOrderStatus, string> = {
    OPEN: "⏳ 待機中 — マッチを探しています",
    MATCHED: "✅ 約定済み — wallet_approve で決済してください",
    CANCELLED: "🚫 キャンセル済み",
    EXPIRED: "⌛ 期限切れ — 再注文してください",
    PENDING_APPROVAL: "🔐 人間の承認待ち — レンジ外のため確定保留中",
  };
  return messages[status];
}

// 約定の確定（自律 or 人間承認の両方から呼ぶ）。両注文を MATCHED にし trades を記録
function finalizeSettlement(args: {
  takerOrderId: string;
  takerSide: OrderSide;
  takerCustomerId: string;
  maker: DbOrderRow;
  service: string;
  executionPrice: number;
  settledBy: string;
}) {
  const { takerOrderId, takerSide, takerCustomerId, maker, service, executionPrice, settledBy } = args;
  const matchedAt = toSqliteDate(new Date());

  stmts.finalizeOrder.run({
    status: "MATCHED",
    settled_by: settledBy,
    matched_at: matchedAt,
    matched_with: maker.order_id,
    order_id: takerOrderId,
  });
  stmts.finalizeOrder.run({
    status: "MATCHED",
    settled_by: settledBy,
    matched_at: matchedAt,
    matched_with: takerOrderId,
    order_id: maker.order_id,
  });

  const baseTotal = executionPrice;
  const fee = roundUsd(baseTotal * FEE_RATE);
  const takerNetUsd = takerSide === "buy"
    ? roundUsd(baseTotal + fee)
    : roundUsd(baseTotal - fee);

  stmts.insertTrade.run({
    trade_id: generateTradeId(),
    order_id: takerOrderId,
    service,
    side: takerSide,
    price: executionPrice,
    qty: 1,
    total_usd: baseTotal,
    fee_usd: fee,
    currency: "USD",
    customer_id: takerCustomerId,
    settled_by: settledBy,
  });
  stmts.insertTrade.run({
    trade_id: generateTradeId(),
    order_id: maker.order_id,
    service,
    side: maker.side,
    price: executionPrice,
    qty: 1,
    total_usd: baseTotal,
    fee_usd: 0,
    currency: "USD",
    customer_id: maker.customer_id,
    settled_by: settledBy,
  });

  return { baseTotal, fee, takerNetUsd };
}

// 1. 注文を出す
export async function placeOrder(params: {
  type: OrderType;
  side: OrderSide;
  service: string;
  price?: number;
  timeout_minutes: number;
  customer_id: string;
}) {
  const { type, side, timeout_minutes, customer_id } = params;
  const price = params.price;
  stmts.expireOrders.run();

  const service = sanitizeService(params.service ?? "");
  if (!service) {
    return { error: "サービス名が不正です（文字・数字・空白・ハイフンのみ／100文字以内）" };
  }
  if (type === "limit" && (price === undefined || !Number.isFinite(price) || price <= 0)) {
    return { error: "指値注文には0より大きい有限の価格が必要です" };
  }
  if (type === "market" && price !== undefined) {
    return { error: "成り行き注文では price は指定しないでください" };
  }
  if (!Number.isFinite(timeout_minutes) || timeout_minutes < 1 || timeout_minutes > 1440) {
    return { error: "時間制限は1分〜1440分（24時間）の範囲で設定してください" };
  }

  const orderId = generateOrderId();
  const expiresAt = expiryAfterMinutes(timeout_minutes);
  const matchedOrder = type === "market"
    ? findMatchForMarketOrder(side, service)
    : findMatchForLimitOrder(side, service, price as number);

  if (type === "market" && !matchedOrder) {
    return {
      status: "REJECTED",
      reason: "成り行き注文のため、現在マッチ可能な板がありません",
      service,
    };
  }

  const executionPrice = matchedOrder ? matchedOrder.price : null;
  stmts.insertOrder.run({
    order_id: orderId,
    type,
    side,
    service,
    price: type === "market" ? executionPrice : price,
    qty: 1,
    customer_id,
    expires_at: expiresAt,
  });

  if (matchedOrder && executionPrice !== null) {
    // 金額レンジ内 → 自律約定 / 範囲外 → 人間の承認待ち
    if (isWithinBand(executionPrice)) {
      const { baseTotal, fee, takerNetUsd } = finalizeSettlement({
        takerOrderId: orderId,
        takerSide: side,
        takerCustomerId: customer_id,
        maker: matchedOrder,
        service,
        executionPrice,
        settledBy: "auto",
      });

      void notify({
        event: "auto_settled",
        title: "自律約定が成立しました",
        text: `${service} を $${executionPrice} で約定（レンジ内・自動）`,
        meta: { order_id: orderId, matched_with: matchedOrder.order_id, price: executionPrice, fee_usd: fee },
      });

      return {
        status: "MATCHED",
        settled_by: "auto",
        order_id: orderId,
        matched_order_id: matchedOrder.order_id,
        service,
        execution_price: executionPrice,
        fee_rate: FEE_RATE,
        fee_usd: fee,
        taker_side: side,
        maker_side: matchedOrder.side,
        settlement_usd: baseTotal,
        taker_net_usd: takerNetUsd,
        message: `✅ 自律約定！${service} → $${executionPrice}（レンジ内・手数料$${fee}）`,
        next_step: "wallet_approve_payment を呼び出して決済を完了してください",
      };
    }

    // 範囲外: 両者を承認待ちにして人間に通知（トークンは taker 側のみ保持）
    const token = randomBytes(24).toString("hex");
    const matchedAt = toSqliteDate(new Date());
    stmts.setPendingApproval.run({
      matched_at: matchedAt,
      matched_with: matchedOrder.order_id,
      approval_token: token,
      order_id: orderId,
    });
    stmts.setPendingApproval.run({
      matched_at: matchedAt,
      matched_with: orderId,
      approval_token: null,
      order_id: matchedOrder.order_id,
    });

    const band = getAutoSettleBand();
    void notify({
      event: "approval_required",
      title: "人間の承認が必要です",
      text:
        `${service} がマッチしましたが、約定価格 $${executionPrice} は自律レンジ` +
        `（${band ? `$${band.min}〜$${band.max}` : "未設定"}）外です。\n` +
        `承認するには wallet_approve_settlement を order_id=${orderId} と下記トークンで実行してください。\n` +
        `token: ${token}`,
      meta: { order_id: orderId, matched_with: matchedOrder.order_id, price: executionPrice, token },
    });

    return {
      status: "PENDING_APPROVAL",
      order_id: orderId,
      matched_order_id: matchedOrder.order_id,
      service,
      execution_price: executionPrice,
      auto_settle_band: band,
      message: "🔐 レンジ外のため人間の承認待ちです。承認トークンは通知先（Webhook）に送信しました。",
      next_step: "口座主が通知のトークンで wallet_approve_settlement を実行すると約定します。",
    };
  }

  return {
    status: "OPEN",
    order_id: orderId,
    type,
    side,
    service,
    price: type === "market" ? "成り行き" : price,
    expires_at: expiresAt,
    message: `📋 注文受付 → ${timeout_minutes}分以内にマッチを待ちます`,
    current_book: getBookSummary(service),
  };
}

// 2. 注文状況を確認
export async function checkOrder(params: { order_id: string }) {
  stmts.expireOrders.run();
  const order = stmts.getOrder.get(params.order_id) as DbOrderRow | undefined;
  if (!order) return { error: "注文が見つかりません" };

  return {
    order_id: order.order_id,
    status: order.status,
    service: order.service,
    price: order.price ?? "成り行き",
    expires_at: order.expires_at,
    matched_order_id: order.matched_with ?? null,
    message: getStatusMessage(order.status),
  };
}

// 3. 注文キャンセル
export async function cancelOrder(params: { order_id: string; customer_id: string }) {
  const result = stmts.cancelOrder.run({
    order_id: params.order_id,
    customer_id: params.customer_id,
  });
  if (result.changes === 0) {
    return { error: "注文が見つからないか、キャンセル権限がないか、すでにOPENではありません" };
  }

  return {
    status: "CANCELLED",
    order_id: params.order_id,
    message: "🚫 注文をキャンセルしました",
  };
}

// 4. 取引板を見る
export async function getOrderBook(params: { service: string }) {
  stmts.expireOrders.run();
  const ask = stmts.getBestAsk.get(params.service) as { best_ask: number | null; sell_count: number };
  const bid = stmts.getBestBid.get(params.service) as { best_bid: number | null; buy_count: number };
  const sells = stmts.getSellOrders.all(params.service);
  const buys = stmts.getBuyOrders.all(params.service);
  const spread = ask.best_ask !== null && bid.best_bid !== null
    ? (ask.best_ask - bid.best_bid).toFixed(4)
    : null;

  return {
    service: params.service,
    best_buy: bid.best_bid ?? "なし",
    best_sell: ask.best_ask ?? "なし",
    spread: spread ? `$${spread}` : "N/A",
    buy_orders: buys,
    sell_orders: sells,
    market_orders: 0,
  };
}

// 5. 人間の承認で約定を確定（範囲外マッチ用・トークン認証）
export async function approveSettlement(params: {
  order_id: string;
  token: string;
  approver_id: string;
}) {
  const order = stmts.getOrder.get(params.order_id) as DbOrderRow | undefined;
  if (!order) return { error: "注文が見つかりません" };
  if (order.status !== "PENDING_APPROVAL") {
    return { error: `承認できません（現在のステータス: ${order.status}）` };
  }
  if (!order.approval_token || order.approval_token !== params.token) {
    return { error: "承認トークンが一致しません（人間認証に失敗）" };
  }
  if (!order.matched_with) return { error: "対向注文が見つかりません" };

  const maker = stmts.getOrder.get(order.matched_with) as DbOrderRow | undefined;
  if (!maker || maker.status !== "PENDING_APPROVAL") {
    return { error: "対向注文が承認待ち状態ではありません" };
  }

  const executionPrice = maker.price;
  if (executionPrice === null || !Number.isFinite(executionPrice)) {
    return { error: "約定価格を確定できません" };
  }

  const settledBy = `human:${params.approver_id}`;
  const { baseTotal, fee, takerNetUsd } = finalizeSettlement({
    takerOrderId: order.order_id,
    takerSide: order.side,
    takerCustomerId: order.customer_id,
    maker,
    service: order.service,
    executionPrice,
    settledBy,
  });

  void notify({
    event: "human_settled",
    title: "人間承認により約定が確定しました",
    text: `${order.service} を $${executionPrice} で約定（承認者: ${params.approver_id}）`,
    meta: { order_id: order.order_id, matched_with: maker.order_id, price: executionPrice, fee_usd: fee },
  });

  return {
    status: "MATCHED",
    settled_by: settledBy,
    order_id: order.order_id,
    matched_order_id: maker.order_id,
    service: order.service,
    execution_price: executionPrice,
    fee_rate: FEE_RATE,
    fee_usd: fee,
    settlement_usd: baseTotal,
    taker_net_usd: takerNetUsd,
    message: `✅ 承認約定！${order.service} → $${executionPrice}（承認者: ${params.approver_id}）`,
  };
}

// 6. 承認を却下して両注文を板へ戻す
export async function rejectSettlement(params: {
  order_id: string;
  token: string;
  approver_id: string;
}) {
  const order = stmts.getOrder.get(params.order_id) as DbOrderRow | undefined;
  if (!order) return { error: "注文が見つかりません" };
  if (order.status !== "PENDING_APPROVAL") {
    return { error: `却下できません（現在のステータス: ${order.status}）` };
  }
  if (!order.approval_token || order.approval_token !== params.token) {
    return { error: "承認トークンが一致しません（人間認証に失敗）" };
  }

  stmts.reopenOrder.run({ order_id: order.order_id });
  if (order.matched_with) stmts.reopenOrder.run({ order_id: order.matched_with });

  void notify({
    event: "approval_rejected",
    title: "承認が却下されました",
    text: `${order.service} のマッチを却下し、両注文を板に戻しました（却下者: ${params.approver_id}）`,
    meta: { order_id: order.order_id, matched_with: order.matched_with },
  });

  return {
    status: "REOPENED",
    order_id: order.order_id,
    message: "🚫 却下しました。両注文は板（OPEN）に戻りました。",
  };
}

// 7. 自律約定の金額レンジを設定（人間＝口座主が決める）
export async function setAutoSettleBand(params: {
  min: number;
  max: number;
  operator_id: string;
}) {
  const { min, max } = params;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    return { error: "min/max は有限の数値で、0 <= min <= max にしてください" };
  }
  stmts.setSetting.run({ key: KEY_AUTO_MIN, value: String(min) });
  stmts.setSetting.run({ key: KEY_AUTO_MAX, value: String(max) });

  void notify({
    event: "band_updated",
    title: "自律約定レンジを更新しました",
    text: `自律約定レンジ = $${min} 〜 $${max}（設定者: ${params.operator_id}）。範囲外は人間承認になります。`,
    meta: { min, max, operator_id: params.operator_id },
  });

  return {
    status: "OK",
    auto_settle_band: { min, max },
    message: `✅ 自律約定レンジを $${min}〜$${max} に設定しました。範囲外は人間承認です。`,
  };
}

// 8. 現在の自律約定レンジを確認
export async function getAutoSettleBandInfo() {
  const band = getAutoSettleBand();
  return {
    auto_settle_band: band,
    mode: band ? "範囲内は自律約定 / 範囲外は人間承認" : "未設定 → すべて人間承認（安全側デフォルト）",
  };
}

// ── MCPツール定義（index.tsに追加するスキーマ）──────────
export const orderbookTools = {
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
    handler: placeOrder,
  },
  wallet_check_order: {
    description: "注文のステータスを確認する",
    schema: z.object({
      order_id: z.string().describe("注文ID"),
    }),
    handler: checkOrder,
  },
  wallet_cancel_order: {
    description: "未約定の注文をキャンセルする",
    schema: z.object({
      order_id: z.string().describe("注文ID"),
      customer_id: z.string().describe("注文者のID（本人確認）"),
    }),
    handler: cancelOrder,
  },
  wallet_get_orderbook: {
    description: "サービスの取引板（板情報）を表示する",
    schema: z.object({
      service: z.string().describe("確認するサービス名"),
    }),
    handler: getOrderBook,
  },
  wallet_set_auto_settle_band: {
    description: "自律約定の金額レンジを設定する（人間＝口座主が決める）。範囲内は自動約定、範囲外は人間承認",
    schema: z.object({
      min: z.number().min(0).describe("自律約定を許す最小価格（USD）"),
      max: z.number().min(0).describe("自律約定を許す最大価格（USD）"),
      operator_id: z.string().describe("設定する口座主のID"),
    }),
    handler: setAutoSettleBand,
  },
  wallet_get_auto_settle_band: {
    description: "現在の自律約定レンジと約定モードを確認する",
    schema: z.object({}),
    handler: getAutoSettleBandInfo,
  },
  wallet_approve_settlement: {
    description: "レンジ外でマッチした注文を、人間が承認トークンで認証して約定確定する",
    schema: z.object({
      order_id: z.string().describe("承認待ち注文のID（taker側）"),
      token: z.string().describe("通知（Webhook）に届いた承認トークン"),
      approver_id: z.string().describe("承認する人間のID"),
    }),
    handler: approveSettlement,
  },
  wallet_reject_settlement: {
    description: "レンジ外でマッチした注文を却下し、両注文を板（OPEN）に戻す",
    schema: z.object({
      order_id: z.string().describe("承認待ち注文のID（taker側）"),
      token: z.string().describe("通知（Webhook）に届いた承認トークン"),
      approver_id: z.string().describe("却下する人間のID"),
    }),
    handler: rejectSettlement,
  },
};
