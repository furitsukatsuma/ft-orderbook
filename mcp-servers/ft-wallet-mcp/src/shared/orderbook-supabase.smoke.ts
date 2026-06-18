// src/shared/orderbook-supabase.smoke.ts
//
// 認証情報なしで共有約定ロジック（Supabase 版）を検証するスモークテスト。
// 実 Supabase の代わりに、本コードが使う supabase-js クエリビルダの部分集合を
// 実装したインメモリ Fake を差し込んでシナリオを流す。
//
// 実行:  npm run build && node dist/shared/orderbook-supabase.smoke.js
//
// 検証内容:
//   1. レンジ内マッチ → 自律約定（settled_by=auto, 手数料1.975%）
//   2. レンジ外マッチ → PENDING_APPROVAL（approval_token 付与・通知に token）
//   3. 口座主 approveByOwner → MATCHED 確定 + trades 2件（taker 手数料あり / maker 0）
//   4. 却下 rejectByOwner → 両注文 OPEN へ復帰
//   5. キャンセル / 板取得 / レンジ get-set

import { createSupabaseOrderbook } from "./orderbook-supabase.js";

type Row = Record<string, any>;

// ── インメモリ Fake（必要なメソッドのみ）──────────────────────
class Query implements PromiseLike<{ data: any; error: null }> {
  private filters: Array<(r: Row) => boolean> = [];
  private sorts: Array<{ col: string; asc: boolean }> = [];
  private limitN: number | null = null;
  private mode: "select" | "insert" | "update" | "upsert" = "select";
  private payload: Row | Row[] | null = null;
  private onConflict: string | null = null;
  private wantSelect = false;
  private single = false;

  constructor(private store: Row[], private pkForUpsert?: string) {}

  select(_cols?: string) {
    if (this.mode === "select" && this.payload === null) this.mode = "select";
    this.wantSelect = true;
    return this;
  }
  insert(rows: Row | Row[]) { this.mode = "insert"; this.payload = rows; return this; }
  update(obj: Row) { this.mode = "update"; this.payload = obj; return this; }
  upsert(obj: Row, opts?: { onConflict?: string }) {
    this.mode = "upsert"; this.payload = obj; this.onConflict = opts?.onConflict ?? null; return this;
  }
  eq(col: string, val: any) { this.filters.push((r) => r[col] === val); return this; }
  in(col: string, vals: any[]) { this.filters.push((r) => vals.includes(r[col])); return this; }
  gt(col: string, val: any) { this.filters.push((r) => r[col] > val); return this; }
  gte(col: string, val: any) { this.filters.push((r) => r[col] >= val); return this; }
  lte(col: string, val: any) { this.filters.push((r) => r[col] <= val); return this; }
  not(col: string, op: string, val: any) {
    if (op === "is" && val === null) this.filters.push((r) => r[col] !== null && r[col] !== undefined);
    else this.filters.push((r) => r[col] !== val);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) { this.sorts.push({ col, asc: opts?.ascending !== false }); return this; }
  limit(n: number) { this.limitN = n; return this; }
  maybeSingle() { this.single = true; return this; }

  private matched(): Row[] {
    let rows = this.store.filter((r) => this.filters.every((f) => f(r)));
    for (let i = this.sorts.length - 1; i >= 0; i--) {
      const s = this.sorts[i];
      rows = rows.slice().sort((a, b) => {
        const av = a[s.col], bv = b[s.col];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av < bv ? -1 : 1) * (s.asc ? 1 : -1);
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  private resolve(): { data: any; error: null } {
    if (this.mode === "insert") {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      for (const r of rows) this.store.push({ ...r });
      return { data: null, error: null };
    }
    if (this.mode === "upsert") {
      const obj = this.payload as Row;
      const key = this.pkForUpsert ?? "key";
      const existing = this.store.find((r) => r[key] === obj[key]);
      if (existing) Object.assign(existing, obj);
      else this.store.push({ ...obj });
      return { data: null, error: null };
    }
    if (this.mode === "update") {
      const targets = this.store.filter((r) => this.filters.every((f) => f(r)));
      for (const t of targets) Object.assign(t, this.payload as Row);
      return { data: this.wantSelect ? targets.map((r) => ({ ...r })) : null, error: null };
    }
    // select
    const rows = this.matched();
    if (this.single) return { data: rows[0] ? { ...rows[0] } : null, error: null };
    return { data: rows.map((r) => ({ ...r })), error: null };
  }

  then<TResult1 = { data: any; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: any; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

class FakeClient {
  orders: Row[] = [];
  trades: Row[] = [];
  settings: Row[] = [];
  from(table: string): Query {
    if (table === "orders") return new Query(this.orders, "order_id");
    if (table === "trades") return new Query(this.trades, "trade_id");
    if (table === "settings") return new Query(this.settings, "key");
    throw new Error(`unknown table ${table}`);
  }
}

// ── アサーション ───────────────────────────────────────────
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.error(`  ❌ ${name}`, detail ?? ""); }
}

async function main() {
  const events: any[] = [];
  const client = new FakeClient();
  const ob = createSupabaseOrderbook({
    client: client as any,
    notify: (e) => { events.push(e); },
  });

  console.log("シナリオ A: レンジ内 → 自律約定");
  await ob.setAutoSettleBand({ min: 0, max: 1000, operator_id: "owner-1" });
  const band = await ob.getAutoSettleBandInfo();
  check("レンジ get/set", JSON.stringify((band as any).auto_settle_band) === JSON.stringify({ min: 0, max: 1000 }), band);

  // maker: sell @ 100
  const sell = (await ob.placeOrder({ type: "limit", side: "sell", service: "SQL最適化", price: 100, timeout_minutes: 60, customer_id: "seller-1" })) as any;
  check("sell OPEN", sell.status === "OPEN", sell);
  // taker: buy @ 100 → レンジ内なので自律約定
  const buy = (await ob.placeOrder({ type: "limit", side: "buy", service: "SQL最適化", price: 100, timeout_minutes: 60, customer_id: "buyer-1" })) as any;
  check("buy MATCHED auto", buy.status === "MATCHED" && buy.settled_by === "auto", buy);
  check("手数料=1.975 (100*0.01975)", buy.fee_usd === 1.975, buy.fee_usd);
  check("taker_net=101.975", buy.taker_net_usd === 101.975, buy.taker_net_usd);
  check("trades 2件", client.trades.length === 2, client.trades.length);
  check("maker手数料0", client.trades.some((t) => t.order_id === sell.order_id && t.fee_usd === 0), client.trades);

  console.log("シナリオ B: レンジ外 → 承認待ち → 承認");
  await ob.setAutoSettleBand({ min: 0, max: 50, operator_id: "owner-1" });
  const sell2 = (await ob.placeOrder({ type: "limit", side: "sell", service: "コードレビュー", price: 200, timeout_minutes: 60, customer_id: "seller-2" })) as any;
  const buy2 = (await ob.placeOrder({ type: "limit", side: "buy", service: "コードレビュー", price: 200, timeout_minutes: 60, customer_id: "buyer-2" })) as any;
  check("buy2 PENDING_APPROVAL", buy2.status === "PENDING_APPROVAL", buy2);
  check("approval_required 通知に token", events.some((e) => e.event === "approval_required" && typeof e.meta?.token === "string" && e.meta.token.length === 48), events.at(-1));
  const pending = await ob.listPending();
  check("listPending 1件・約定価格200", pending.length === 1 && pending[0].execution_price === 200, pending);

  const appr = (await ob.approveByOwner({ order_id: buy2.order_id, approver_id: "owner-1" })) as any;
  check("approveByOwner ok", appr.ok === true && appr.execution_price === 200, appr);
  check("settled_by=human:owner-1", appr.settled_by === "human:owner-1", appr.settled_by);
  const buy2after = (await ob.checkOrder({ order_id: buy2.order_id })) as any;
  check("buy2 MATCHED 後", buy2after.status === "MATCHED", buy2after);
  check("trades 合計4件", client.trades.length === 4, client.trades.length);

  console.log("シナリオ C: レンジ外 → 却下 → 板へ復帰");
  const sell3 = (await ob.placeOrder({ type: "limit", side: "sell", service: "翻訳", price: 300, timeout_minutes: 60, customer_id: "seller-3" })) as any;
  const buy3 = (await ob.placeOrder({ type: "limit", side: "buy", service: "翻訳", price: 300, timeout_minutes: 60, customer_id: "buyer-3" })) as any;
  check("buy3 PENDING", buy3.status === "PENDING_APPROVAL", buy3);
  const rej = (await ob.rejectByOwner({ order_id: buy3.order_id })) as any;
  check("rejectByOwner ok", rej.ok === true, rej);
  const sell3after = (await ob.checkOrder({ order_id: sell3.order_id })) as any;
  const buy3after = (await ob.checkOrder({ order_id: buy3.order_id })) as any;
  check("両注文 OPEN 復帰", sell3after.status === "OPEN" && buy3after.status === "OPEN", { sell3after, buy3after });

  console.log("シナリオ D: キャンセル / 板");
  const c = (await ob.cancelOrder({ order_id: buy3.order_id, customer_id: "buyer-3" })) as any;
  check("cancel ok", c.status === "CANCELLED", c);
  const cFail = (await ob.cancelOrder({ order_id: buy3.order_id, customer_id: "buyer-3" })) as any;
  check("再キャンセルは失敗", typeof cFail.error === "string", cFail);
  const book = (await ob.getOrderBook({ service: "翻訳" })) as any;
  check("板 best_sell=300", book.best_sell === 300, book);

  console.log("");
  if (failures === 0) console.log("🎉 全シナリオ成功");
  else { console.error(`💥 ${failures} 件失敗`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
