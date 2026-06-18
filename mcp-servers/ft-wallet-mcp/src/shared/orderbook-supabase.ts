// src/shared/orderbook-supabase.ts
//
// ft-orderbook 共有約定ロジック（Supabase 版・正本）。
// ─────────────────────────────────────────────────────────────
// このモジュールは MCP（ft-wallet-mcp, Node）と 管理UI（orderbook-admin, Cloudflare
// Workers）の **両方** が import する単一の共有モジュール。両者が同じ Supabase テーブル
// （orders / trades / settings）を同じロジックで R/W することを保証する。
//
// 設計方針:
//   - 依存は `@supabase/supabase-js` の型のみ（実体クライアントは注入）。process.env や
//     node:* を一切 import しない → Node でも V8 隔離環境（Workers）でも動く。
//   - 通知（Webhook）は副作用なので `notify` コールバックを注入（未指定なら何もしない）。
//   - 数値ロジック（手数料率 1.975%・約定確定の計算）は SQLite 版 finalizeSettlement と
//     完全一致させること。FEE_RATE を変える場合はここだけを変えればよい（両系統が参照）。
//
// 注意:
//   - 承認トークンは randomBytes 相当を Web Crypto（globalThis.crypto）で生成する。
//   - supabase-js はクライアント側マルチステートメント TX を持たないため、SQLite 版と
//     同様に逐次更新する（既存挙動と同等のレース特性）。

// 注意: ここでは `@supabase/supabase-js` の SupabaseClient 型を直接は使わない。
// このモジュールは複数パッケージ（ft-wallet-mcp / orderbook-admin）から import され、
// それぞれが別インストールの supabase-js を持つため、具体型を要求すると nominal な
// 型不一致（protected メンバ由来）が起きる。実際に使うのは `.from(table)` だけなので、
// 構造的な最小インターフェースで受ける（実行時は本物のクライアントを注入する）。
export type SupabaseClientLike = { from: (relation: string) => any };

type Row = Record<string, any>;

export type OrderType = "limit" | "market";
export type OrderSide = "buy" | "sell";
export type DbOrderStatus = "OPEN" | "MATCHED" | "CANCELLED" | "EXPIRED" | "PENDING_APPROVAL";

export const FEE_RATE = 0.01975;

const KEY_AUTO_MIN = "auto_settle_min";
const KEY_AUTO_MAX = "auto_settle_max";
const SERVICE_MAX_LEN = 100;

export type DbOrderRow = {
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

export type Band = { min: number; max: number } | null;

export type NotifyEvent = {
  event: string;
  title: string;
  text: string;
  meta?: Record<string, unknown>;
};
export type NotifyFn = (e: NotifyEvent) => void | Promise<void>;

export type PendingItem = {
  order_id: string;
  service: string;
  taker_side: OrderSide;
  customer_id: string;
  execution_price: number | null;
  matched_with: string | null;
  matched_at: string | null;
  created_at: string;
};

export type SupabaseOrderbookOptions = {
  client: SupabaseClientLike;
  notify?: NotifyFn;
  feeRate?: number;
};

// ── ユーティリティ（SQLite 版と同一）─────────────────────────
function sanitizeService(input: string): string {
  return input.replace(/[^\p{L}\p{N}\s-]/gu, "").trim().slice(0, SERVICE_MAX_LEN);
}

function roundUsd(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function generateOrderId(): string {
  return `ord-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
}

function generateTradeId(): string {
  return `trd-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function expiryIsoAfterMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

// Web Crypto による承認トークン（Node 20+ / Workers どちらにも globalThis.crypto がある）
function generateApprovalToken(bytes = 24): string {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
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

export function createSupabaseOrderbook(opts: SupabaseOrderbookOptions) {
  const db = opts.client;
  const FEE = opts.feeRate ?? FEE_RATE;
  const notify: NotifyFn = opts.notify ?? (() => {});

  function fail(error: { message: string } | null): void {
    if (error) throw new Error(error.message);
  }

  // ── 設定 / レンジ ─────────────────────────────────────────
  async function getSetting(key: string): Promise<string | undefined> {
    const { data, error } = await db.from("settings").select("value").eq("key", key).maybeSingle();
    fail(error);
    return (data?.value as string | undefined) ?? undefined;
  }

  async function setSetting(key: string, value: string): Promise<void> {
    const { error } = await db
      .from("settings")
      .upsert({ key, value, updated_at: nowIso() }, { onConflict: "key" });
    fail(error);
  }

  async function getBand(): Promise<Band> {
    const min = Number(await getSetting(KEY_AUTO_MIN));
    const max = Number(await getSetting(KEY_AUTO_MAX));
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (max < min) return null;
    return { min, max };
  }

  async function isWithinBand(price: number): Promise<boolean> {
    const band = await getBand();
    return band !== null && price >= band.min && price <= band.max;
  }

  // ── 期限切れ処理 ──────────────────────────────────────────
  async function expireOrders(): Promise<void> {
    const { error } = await db
      .from("orders")
      .update({ status: "EXPIRED" })
      .in("status", ["OPEN", "PENDING_APPROVAL"])
      .lte("expires_at", nowIso());
    fail(error);
  }

  // ── マッチング探索 ────────────────────────────────────────
  async function findMatchForLimitOrder(
    side: OrderSide,
    service: string,
    price: number
  ): Promise<DbOrderRow | undefined> {
    let q = db
      .from("orders")
      .select("*")
      .eq("service", service)
      .eq("status", "OPEN")
      .not("price", "is", null)
      .gt("expires_at", nowIso());

    if (side === "buy") {
      q = q.eq("side", "sell").lte("price", price).order("price", { ascending: true });
    } else {
      q = q.eq("side", "buy").gte("price", price).order("price", { ascending: false });
    }
    const { data, error } = await q.order("created_at", { ascending: true }).limit(1);
    fail(error);
    return (data?.[0] as DbOrderRow | undefined) ?? undefined;
  }

  async function findMatchForMarketOrder(side: OrderSide, service: string): Promise<DbOrderRow | undefined> {
    let q = db
      .from("orders")
      .select("*")
      .eq("service", service)
      .eq("status", "OPEN")
      .not("price", "is", null)
      .gt("expires_at", nowIso());

    if (side === "buy") {
      q = q.eq("side", "sell").order("price", { ascending: true });
    } else {
      q = q.eq("side", "buy").order("price", { ascending: false });
    }
    const { data, error } = await q.order("created_at", { ascending: true }).limit(1);
    fail(error);
    return (data?.[0] as DbOrderRow | undefined) ?? undefined;
  }

  async function getOrder(orderId: string): Promise<DbOrderRow | undefined> {
    const { data, error } = await db.from("orders").select("*").eq("order_id", orderId).maybeSingle();
    fail(error);
    return (data as DbOrderRow | null) ?? undefined;
  }

  async function getBestAsk(service: string): Promise<{ best_ask: number | null; sell_count: number }> {
    const { data, error } = await db
      .from("orders")
      .select("price")
      .eq("service", service)
      .eq("side", "sell")
      .eq("status", "OPEN")
      .gt("expires_at", nowIso())
      .order("price", { ascending: true });
    fail(error);
    const rows = data ?? [];
    return { best_ask: rows.length ? (rows[0].price as number | null) : null, sell_count: rows.length };
  }

  async function getBestBid(service: string): Promise<{ best_bid: number | null; buy_count: number }> {
    const { data, error } = await db
      .from("orders")
      .select("price")
      .eq("service", service)
      .eq("side", "buy")
      .eq("status", "OPEN")
      .gt("expires_at", nowIso())
      .order("price", { ascending: false });
    fail(error);
    const rows = data ?? [];
    return { best_bid: rows.length ? (rows[0].price as number | null) : null, buy_count: rows.length };
  }

  async function getSellOrders(service: string) {
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
    fail(error);
    return data ?? [];
  }

  async function getBuyOrders(service: string) {
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
    fail(error);
    return data ?? [];
  }

  async function getBookSummary(service: string) {
    const ask = await getBestAsk(service);
    const bid = await getBestBid(service);
    return { buy_count: bid.buy_count, sell_count: ask.sell_count, best_buy: bid.best_bid, best_sell: ask.best_ask };
  }

  // ── 約定確定（自律 / 人間承認 共通。SQLite 版 finalizeSettlement と同一計算）──
  async function finalizeSettlement(args: {
    takerOrderId: string;
    takerSide: OrderSide;
    takerCustomerId: string;
    maker: DbOrderRow;
    service: string;
    executionPrice: number;
    settledBy: string;
  }): Promise<{ baseTotal: number; fee: number; takerNetUsd: number }> {
    const { takerOrderId, takerSide, takerCustomerId, maker, service, executionPrice, settledBy } = args;
    const matchedAt = nowIso();

    fail(
      (
        await db
          .from("orders")
          .update({ status: "MATCHED", settled_by: settledBy, approval_token: null, matched_at: matchedAt, matched_with: maker.order_id })
          .eq("order_id", takerOrderId)
      ).error
    );
    fail(
      (
        await db
          .from("orders")
          .update({ status: "MATCHED", settled_by: settledBy, approval_token: null, matched_at: matchedAt, matched_with: takerOrderId })
          .eq("order_id", maker.order_id)
      ).error
    );

    const baseTotal = executionPrice;
    const fee = roundUsd(baseTotal * FEE);
    const takerNetUsd = takerSide === "buy" ? roundUsd(baseTotal + fee) : roundUsd(baseTotal - fee);

    fail(
      (
        await db.from("trades").insert([
          {
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
          },
          {
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
          },
        ])
      ).error
    );

    return { baseTotal, fee, takerNetUsd };
  }

  // ── 1. 注文を出す ─────────────────────────────────────────
  async function placeOrder(params: {
    type: OrderType;
    side: OrderSide;
    service: string;
    price?: number;
    timeout_minutes: number;
    customer_id: string;
  }) {
    const { type, side, timeout_minutes, customer_id } = params;
    const price = params.price;
    await expireOrders();

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
    const expiresAt = expiryIsoAfterMinutes(timeout_minutes);
    const matchedOrder =
      type === "market" ? await findMatchForMarketOrder(side, service) : await findMatchForLimitOrder(side, service, price as number);

    if (type === "market" && !matchedOrder) {
      return { status: "REJECTED", reason: "成り行き注文のため、現在マッチ可能な板がありません", service };
    }

    const executionPrice = matchedOrder ? matchedOrder.price : null;
    fail(
      (
        await db.from("orders").insert({
          order_id: orderId,
          type,
          side,
          service,
          price: type === "market" ? executionPrice : price,
          qty: 1,
          customer_id,
          status: "OPEN",
          expires_at: expiresAt,
        })
      ).error
    );

    if (matchedOrder && executionPrice !== null) {
      if (await isWithinBand(executionPrice)) {
        const { baseTotal, fee, takerNetUsd } = await finalizeSettlement({
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
          fee_rate: FEE,
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
      const token = generateApprovalToken();
      const matchedAt = nowIso();
      fail(
        (
          await db
            .from("orders")
            .update({ status: "PENDING_APPROVAL", matched_at: matchedAt, matched_with: matchedOrder.order_id, approval_token: token })
            .eq("order_id", orderId)
            .eq("status", "OPEN")
        ).error
      );
      fail(
        (
          await db
            .from("orders")
            .update({ status: "PENDING_APPROVAL", matched_at: matchedAt, matched_with: orderId, approval_token: null })
            .eq("order_id", matchedOrder.order_id)
            .eq("status", "OPEN")
        ).error
      );

      const band = await getBand();
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
      current_book: await getBookSummary(service),
    };
  }

  // ── 2. 注文状況を確認 ─────────────────────────────────────
  async function checkOrder(params: { order_id: string }) {
    await expireOrders();
    const order = await getOrder(params.order_id);
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

  // ── 3. 注文キャンセル ─────────────────────────────────────
  async function cancelOrder(params: { order_id: string; customer_id: string }) {
    const { data, error } = await db
      .from("orders")
      .update({ status: "CANCELLED" })
      .eq("order_id", params.order_id)
      .eq("customer_id", params.customer_id)
      .eq("status", "OPEN")
      .select("order_id");
    fail(error);
    if (!data || data.length === 0) {
      return { error: "注文が見つからないか、キャンセル権限がないか、すでにOPENではありません" };
    }
    return { status: "CANCELLED", order_id: params.order_id, message: "🚫 注文をキャンセルしました" };
  }

  // ── 4. 取引板を見る ───────────────────────────────────────
  async function getOrderBook(params: { service: string }) {
    await expireOrders();
    const ask = await getBestAsk(params.service);
    const bid = await getBestBid(params.service);
    const sells = await getSellOrders(params.service);
    const buys = await getBuyOrders(params.service);
    const spread = ask.best_ask !== null && bid.best_bid !== null ? (ask.best_ask - bid.best_bid).toFixed(4) : null;
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

  // 内部共通: 承認確定（トークン検証は呼び出し側で行う）
  async function finalizeApproval(taker: DbOrderRow, approverId: string) {
    if (!taker.matched_with) return { error: "対向注文が見つかりません" } as const;
    const maker = await getOrder(taker.matched_with);
    if (!maker || maker.status !== "PENDING_APPROVAL") {
      return { error: "対向注文が承認待ち状態ではありません" } as const;
    }
    const executionPrice = maker.price;
    if (executionPrice === null || !Number.isFinite(executionPrice)) {
      return { error: "約定価格を確定できません" } as const;
    }
    const settledBy = `human:${approverId}`;
    const { baseTotal, fee, takerNetUsd } = await finalizeSettlement({
      takerOrderId: taker.order_id,
      takerSide: taker.side,
      takerCustomerId: taker.customer_id,
      maker,
      service: taker.service,
      executionPrice,
      settledBy,
    });
    void notify({
      event: "human_settled",
      title: "人間承認により約定が確定しました",
      text: `${taker.service} を $${executionPrice} で約定（承認者: ${approverId}）`,
      meta: { order_id: taker.order_id, matched_with: maker.order_id, price: executionPrice, fee_usd: fee },
    });
    return {
      ok: true as const,
      maker,
      executionPrice,
      baseTotal,
      fee,
      takerNetUsd,
      settledBy,
    };
  }

  // ── 5. 人間の承認で約定確定（MCP・トークン認証）────────────
  async function approveSettlement(params: { order_id: string; token: string; approver_id: string }) {
    const order = await getOrder(params.order_id);
    if (!order) return { error: "注文が見つかりません" };
    if (order.status !== "PENDING_APPROVAL") return { error: `承認できません（現在のステータス: ${order.status}）` };
    if (!order.approval_token || order.approval_token !== params.token) {
      return { error: "承認トークンが一致しません（人間認証に失敗）" };
    }
    const res = await finalizeApproval(order, params.approver_id);
    if ("error" in res) return res;
    return {
      status: "MATCHED",
      settled_by: res.settledBy,
      order_id: order.order_id,
      matched_order_id: res.maker.order_id,
      service: order.service,
      execution_price: res.executionPrice,
      fee_rate: FEE,
      fee_usd: res.fee,
      settlement_usd: res.baseTotal,
      taker_net_usd: res.takerNetUsd,
      message: `✅ 承認約定！${order.service} → $${res.executionPrice}（承認者: ${params.approver_id}）`,
    };
  }

  // ── 6. 却下（MCP・トークン認証）────────────────────────────
  async function rejectSettlement(params: { order_id: string; token: string; approver_id: string }) {
    const order = await getOrder(params.order_id);
    if (!order) return { error: "注文が見つかりません" };
    if (order.status !== "PENDING_APPROVAL") return { error: `却下できません（現在のステータス: ${order.status}）` };
    if (!order.approval_token || order.approval_token !== params.token) {
      return { error: "承認トークンが一致しません（人間認証に失敗）" };
    }
    await reopenPair(order);
    void notify({
      event: "approval_rejected",
      title: "承認が却下されました",
      text: `${order.service} のマッチを却下し、両注文を板に戻しました（却下者: ${params.approver_id}）`,
      meta: { order_id: order.order_id, matched_with: order.matched_with },
    });
    return { status: "REOPENED", order_id: order.order_id, message: "🚫 却下しました。両注文は板（OPEN）に戻りました。" };
  }

  async function reopenPair(order: DbOrderRow): Promise<void> {
    const reopen = async (oid: string) => {
      fail(
        (
          await db
            .from("orders")
            .update({ status: "OPEN", matched_at: null, matched_with: null, approval_token: null })
            .eq("order_id", oid)
            .eq("status", "PENDING_APPROVAL")
        ).error
      );
    };
    await reopen(order.order_id);
    if (order.matched_with) await reopen(order.matched_with);
  }

  // ── 7. 自律約定レンジ設定 ─────────────────────────────────
  async function setAutoSettleBand(params: { min: number; max: number; operator_id: string }) {
    const { min, max } = params;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
      return { error: "min/max は有限の数値で、0 <= min <= max にしてください" };
    }
    await setSetting(KEY_AUTO_MIN, String(min));
    await setSetting(KEY_AUTO_MAX, String(max));
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

  // ── 8. 現在のレンジを確認 ─────────────────────────────────
  async function getAutoSettleBandInfo() {
    const band = await getBand();
    return {
      auto_settle_band: band,
      mode: band ? "範囲内は自律約定 / 範囲外は人間承認" : "未設定 → すべて人間承認（安全側デフォルト）",
    };
  }

  // ── 管理UI 向け: 承認待ち一覧（taker 側のみ列挙）────────────
  async function listPending(limit = 100): Promise<PendingItem[]> {
    const { data, error } = await db
      .from("orders")
      .select("order_id,service,side,customer_id,matched_with,matched_at,created_at")
      .eq("status", "PENDING_APPROVAL")
      .not("approval_token", "is", null)
      .order("matched_at", { ascending: false })
      .limit(limit);
    fail(error);
    const rows = (data ?? []) as Row[];
    // 約定価格は maker（matched_with）の price を引く
    const makerIds = Array.from(new Set(rows.map((r: Row) => r.matched_with).filter(Boolean))) as string[];
    const priceById = new Map<string, number | null>();
    if (makerIds.length > 0) {
      const { data: makers, error: mErr } = await db.from("orders").select("order_id,price").in("order_id", makerIds);
      fail(mErr);
      for (const m of (makers ?? []) as Row[]) priceById.set(m.order_id as string, (m.price as number | null) ?? null);
    }
    return rows.map((r: Row) => ({
      order_id: r.order_id as string,
      service: r.service as string,
      taker_side: r.side as OrderSide,
      customer_id: r.customer_id as string,
      execution_price: r.matched_with ? priceById.get(r.matched_with as string) ?? null : null,
      matched_with: (r.matched_with as string | null) ?? null,
      matched_at: (r.matched_at as string | null) ?? null,
      created_at: r.created_at as string,
    }));
  }

  // ── 管理UI 向け: 口座主による承認（トークン不要・ADMIN_KEY で認証済み前提）──
  async function approveByOwner(params: { order_id: string; approver_id: string }) {
    const taker = await getOrder(params.order_id);
    if (!taker) return { ok: false as const, status: 404, error: "注文が見つかりません" };
    if (taker.status !== "PENDING_APPROVAL") {
      return { ok: false as const, status: 409, error: `承認できません（現在のステータス: ${taker.status}）` };
    }
    if (!taker.approval_token) {
      return { ok: false as const, status: 400, error: "この注文は承認対象（taker側）ではありません" };
    }
    const res = await finalizeApproval(taker, params.approver_id);
    if ("error" in res) return { ok: false as const, status: 409, error: res.error };
    return {
      ok: true as const,
      order_id: taker.order_id,
      matched_order_id: res.maker.order_id,
      service: taker.service,
      execution_price: res.executionPrice,
      fee_usd: res.fee,
      settlement_usd: res.baseTotal,
      settled_by: res.settledBy,
    };
  }

  // ── 管理UI 向け: 口座主による却下（トークン不要）───────────
  async function rejectByOwner(params: { order_id: string }) {
    const taker = await getOrder(params.order_id);
    if (!taker) return { ok: false as const, status: 404, error: "注文が見つかりません" };
    if (taker.status !== "PENDING_APPROVAL") {
      return { ok: false as const, status: 409, error: `却下できません（現在のステータス: ${taker.status}）` };
    }
    if (!taker.approval_token) {
      return { ok: false as const, status: 400, error: "この注文は却下対象（taker側）ではありません" };
    }
    await reopenPair(taker);
    return { ok: true as const, order_id: taker.order_id, matched_order_id: taker.matched_with, service: taker.service };
  }

  return {
    placeOrder,
    checkOrder,
    cancelOrder,
    getOrderBook,
    approveSettlement,
    rejectSettlement,
    setAutoSettleBand,
    getAutoSettleBandInfo,
    // 管理UI 用
    getBand,
    listPending,
    approveByOwner,
    rejectByOwner,
    // 期限処理（HTTP/cron から呼べる）
    expireOrders,
  };
}

export type SupabaseOrderbook = ReturnType<typeof createSupabaseOrderbook>;
