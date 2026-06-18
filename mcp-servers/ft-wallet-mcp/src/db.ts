// src/db.ts
// Supabase データアクセス層（HTTP API + Webhook 用）

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type OrderStatus = "OPEN" | "MATCHED" | "CANCELLED" | "EXPIRED" | "PENDING_APPROVAL";
export type OrderSide = "buy" | "sell";

export type OrderRow = {
  order_id: string;
  type: "limit" | "market";
  side: OrderSide;
  service: string;
  price: number | null;
  qty: number;
  customer_id: string;
  status: OrderStatus;
  created_at: string;
  expires_at: string;
  matched_at: string | null;
  matched_with: string | null;
};

export type TradeRow = {
  trade_id: string;
  order_id: string;
  service: string;
  side: OrderSide;
  price: number;
  qty: number;
  total_usd: number;
  fee_usd: number;
  currency: string;
  customer_id: string;
  traded_at?: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const supabaseUrl = requireEnv("SUPABASE_URL");
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SECRET_KEY;
if (!supabaseServiceKey) {
  throw new Error("SUPABASE_SERVICE_KEY (or SUPABASE_SECRET_KEY) is not set");
}
if (supabaseServiceKey.includes("ここに") || /[^\x20-\x7E]/.test(supabaseServiceKey)) {
  throw new Error("SUPABASE_SERVICE_KEY looks like a placeholder; set the real Supabase secret key");
}

export const db: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function nowIso(): string {
  return new Date().toISOString();
}

function ensure<T>(error: { message: string } | null, data: T): T {
  if (error) throw new Error(error.message);
  return data;
}

export async function expireOrders(): Promise<void> {
  const { error } = await db
    .from("orders")
    .update({ status: "EXPIRED" })
    .in("status", ["OPEN", "PENDING_APPROVAL"])
    .lte("expires_at", nowIso());
  if (error) throw new Error(error.message);
}

export async function getBestAsk(service: string): Promise<{ best_ask: number | null; sell_count: number }> {
  const { data, error } = await db
    .from("orders")
    .select("price")
    .eq("service", service)
    .eq("side", "sell")
    .eq("status", "OPEN")
    .gt("expires_at", nowIso())
    .order("price", { ascending: true })
    .order("created_at", { ascending: true });
  const rows = ensure(error, data ?? []);
  return {
    best_ask: rows.length > 0 ? (rows[0].price as number | null) : null,
    sell_count: rows.length,
  };
}

export async function getBestBid(service: string): Promise<{ best_bid: number | null; buy_count: number }> {
  const { data, error } = await db
    .from("orders")
    .select("price")
    .eq("service", service)
    .eq("side", "buy")
    .eq("status", "OPEN")
    .gt("expires_at", nowIso())
    .order("price", { ascending: false })
    .order("created_at", { ascending: true });
  const rows = ensure(error, data ?? []);
  return {
    best_bid: rows.length > 0 ? (rows[0].price as number | null) : null,
    buy_count: rows.length,
  };
}

export async function getSellOrders(service: string): Promise<Array<Pick<OrderRow, "order_id" | "price" | "qty" | "expires_at">>> {
  const { data, error } = await db
    .from("orders")
    .select("order_id,price,qty,expires_at")
    .eq("service", service)
    .eq("side", "sell")
    .eq("status", "OPEN")
    .gt("expires_at", nowIso())
    .order("price", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(20);
  return ensure(error, data ?? []);
}

export async function getBuyOrders(service: string): Promise<Array<Pick<OrderRow, "order_id" | "price" | "qty" | "expires_at">>> {
  const { data, error } = await db
    .from("orders")
    .select("order_id,price,qty,expires_at")
    .eq("service", service)
    .eq("side", "buy")
    .eq("status", "OPEN")
    .gt("expires_at", nowIso())
    .order("price", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(20);
  return ensure(error, data ?? []);
}

export async function getOrder(orderId: string): Promise<OrderRow | null> {
  const { data, error } = await db.from("orders").select("*").eq("order_id", orderId).maybeSingle();
  return ensure(error, data as OrderRow | null);
}

export async function getServices(): Promise<Array<{ service: string }>> {
  const { data, error } = await db.from("orders").select("service").order("service", { ascending: true });
  const rows = ensure(error, data ?? []);
  const uniq = Array.from(new Set(rows.map((r) => r.service))).filter(Boolean);
  return uniq.map((service) => ({ service }));
}

export async function insertTrade(trade: TradeRow): Promise<void> {
  const { error } = await db.from("trades").insert(trade);
  if (error) throw new Error(error.message);
}

export async function getTradeSummary(service: string): Promise<Record<string, number | string | null>> {
  const { data, error } = await db
    .from("trades")
    .select("service,side,price,qty,total_usd,fee_usd")
    .eq("service", service);
  const rows = ensure(error, data ?? []);

  let sellCount = 0;
  let buyCount = 0;
  let feeRevenue = 0;
  let takerCount = 0;
  let totalUsd = 0;
  let tradeCount = 0;
  let sumPrice = 0;
  let high: number | null = null;
  let low: number | null = null;

  for (const row of rows) {
    tradeCount += 1;
    const qty = Number(row.qty ?? 0);
    const price = Number(row.price ?? 0);
    const fee = Number(row.fee_usd ?? 0);
    const total = Number(row.total_usd ?? 0);
    if (row.side === "sell") sellCount += qty;
    if (row.side === "buy") buyCount += qty;
    if (fee > 0) takerCount += 1;
    feeRevenue += fee;
    totalUsd += total;
    sumPrice += price;
    high = high === null ? price : Math.max(high, price);
    low = low === null ? price : Math.min(low, price);
  }

  return {
    service,
    sell_count: sellCount,
    buy_count: buyCount,
    matched_count: Math.floor(tradeCount / 2),
    gross_settlement_usd: totalUsd / 2,
    fee_revenue_usd: feeRevenue,
    taker_count: takerCount,
    avg_price: tradeCount > 0 ? sumPrice / tradeCount : null,
    high,
    low,
    trade_count: tradeCount,
  };
}
