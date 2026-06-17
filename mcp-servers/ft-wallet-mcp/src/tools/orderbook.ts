// ft-wallet-mcp v0.6.0
// src/tools/orderbook.ts — SQLite連携の注文板 + マッチングエンジン

import { z } from "zod";
import { db, stmts } from "../sqlite-db.js";

export type OrderType = "limit" | "market";
export type OrderSide = "buy" | "sell";
type DbOrderStatus = "OPEN" | "MATCHED" | "CANCELLED" | "EXPIRED";
const FEE_RATE = 0.01975;

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
  };
  return messages[status];
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
  const { type, side, service, price, timeout_minutes, customer_id } = params;
  stmts.expireOrders.run();

  if (type === "limit" && (price === undefined || price <= 0)) {
    return { error: "指値注文には0より大きい価格が必要です" };
  }
  if (type === "market" && price !== undefined) {
    return { error: "成り行き注文では price は指定しないでください" };
  }
  if (timeout_minutes < 1 || timeout_minutes > 1440) {
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
    const matchedAt = toSqliteDate(new Date());
    stmts.updateStatus.run({
      status: "MATCHED",
      matched_at: matchedAt,
      matched_with: matchedOrder.order_id,
      order_id: orderId,
    });
    stmts.updateStatus.run({
      status: "MATCHED",
      matched_at: matchedAt,
      matched_with: orderId,
      order_id: matchedOrder.order_id,
    });

    const baseTotal = executionPrice;
    const fee = roundUsd(baseTotal * FEE_RATE);
    const takerOrderId = orderId;
    const makerOrderId = matchedOrder.order_id;
    const takerCustomerId = customer_id;
    const makerCustomerId = matchedOrder.customer_id;
    const takerNetUsd = side === "buy"
      ? roundUsd(baseTotal + fee) // 買いテイカーはベース+手数料を支払う
      : roundUsd(baseTotal - fee); // 売りテイカーは受取額から手数料控除

    stmts.insertTrade.run({
      trade_id: generateTradeId(),
      order_id: takerOrderId,
      service,
      side,
      price: executionPrice,
      qty: 1,
      total_usd: baseTotal,
      fee_usd: fee,
      currency: "USD",
      customer_id: takerCustomerId,
    });
    stmts.insertTrade.run({
      trade_id: generateTradeId(),
      order_id: makerOrderId,
      service,
      side: matchedOrder.side,
      price: executionPrice,
      qty: 1,
      total_usd: baseTotal,
      fee_usd: 0,
      currency: "USD",
      customer_id: makerCustomerId,
    });

    return {
      status: "MATCHED",
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
      message: `✅ 約定！${service} → テイカー(${side})に手数料$${fee}（${(FEE_RATE * 100).toFixed(3)}%）`,
      next_step: "wallet_approve_payment を呼び出して決済を完了してください",
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
};
