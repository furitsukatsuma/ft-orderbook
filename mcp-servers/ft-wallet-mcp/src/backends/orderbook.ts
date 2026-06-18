// src/backends/orderbook.ts
// 板ツールのバックエンド切替。
// ─────────────────────────────────────────────────────────────
// 既存のローカル stdio 利用（SQLite）を壊さないため、env で切り替える:
//   - FT_WALLET_BACKEND=supabase|sqlite で明示指定（最優先）
//   - 未指定なら SUPABASE_URL + SUPABASE_SERVICE_KEY(/SECRET_KEY) があれば supabase
//   - どちらも無ければ sqlite（従来どおり）にフォールバック
//
// sqlite モジュール（better-sqlite3 を import 時に開く）は supabase 利用時には
// 読み込まないよう、必ず動的 import で遅延ロードする。

export type OrderbookHandlers = {
  placeOrder: (args: {
    type: "limit" | "market";
    side: "buy" | "sell";
    service: string;
    price?: number;
    timeout_minutes: number;
    customer_id: string;
  }) => Promise<unknown>;
  checkOrder: (args: { order_id: string }) => Promise<unknown>;
  cancelOrder: (args: { order_id: string; customer_id: string }) => Promise<unknown>;
  getOrderBook: (args: { service: string }) => Promise<unknown>;
  setAutoSettleBand: (args: { min: number; max: number; operator_id: string }) => Promise<unknown>;
  getAutoSettleBandInfo: () => Promise<unknown>;
  approveSettlement: (args: { order_id: string; token: string; approver_id: string }) => Promise<unknown>;
  rejectSettlement: (args: { order_id: string; token: string; approver_id: string }) => Promise<unknown>;
};

export type SelectedBackend = { backend: "supabase" | "sqlite"; handlers: OrderbookHandlers };

function hasSupabaseEnv(): boolean {
  return Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY));
}

export function resolveBackendName(): "supabase" | "sqlite" {
  const explicit = (process.env.FT_WALLET_BACKEND ?? "").trim().toLowerCase();
  if (explicit === "supabase") return "supabase";
  if (explicit === "sqlite") return "sqlite";
  return hasSupabaseEnv() ? "supabase" : "sqlite";
}

export async function getOrderbookBackend(): Promise<SelectedBackend> {
  const name = resolveBackendName();

  if (name === "supabase") {
    if (!hasSupabaseEnv()) {
      throw new Error(
        "FT_WALLET_BACKEND=supabase ですが SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定です。" +
          "env を設定するか FT_WALLET_BACKEND=sqlite にしてください。"
      );
    }
    const [{ createSupabaseOrderbook }, { createClient }, { notify }] = await Promise.all([
      import("../shared/orderbook-supabase.js"),
      import("@supabase/supabase-js"),
      import("../services/notify.js"),
    ]);
    const url = process.env.SUPABASE_URL as string;
    const key = (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SECRET_KEY) as string;
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const core = createSupabaseOrderbook({ client, notify });
    const handlers: OrderbookHandlers = {
      placeOrder: core.placeOrder,
      checkOrder: core.checkOrder,
      cancelOrder: core.cancelOrder,
      getOrderBook: core.getOrderBook,
      setAutoSettleBand: core.setAutoSettleBand,
      getAutoSettleBandInfo: core.getAutoSettleBandInfo,
      approveSettlement: core.approveSettlement,
      rejectSettlement: core.rejectSettlement,
    };
    return { backend: "supabase", handlers };
  }

  // sqlite（従来）。better-sqlite3 はここで初めて読み込まれる。
  const sqlite = await import("../tools/orderbook.js");
  const handlers: OrderbookHandlers = {
    placeOrder: sqlite.placeOrder,
    checkOrder: sqlite.checkOrder,
    cancelOrder: sqlite.cancelOrder,
    getOrderBook: sqlite.getOrderBook,
    setAutoSettleBand: sqlite.setAutoSettleBand,
    getAutoSettleBandInfo: sqlite.getAutoSettleBandInfo,
    approveSettlement: sqlite.approveSettlement,
    rejectSettlement: sqlite.rejectSettlement,
  };
  return { backend: "sqlite", handlers };
}
