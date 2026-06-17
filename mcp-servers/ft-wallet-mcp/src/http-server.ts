// src/http-server.ts（db.ts接続版）
import { createServer, IncomingMessage, ServerResponse } from "http";
import { URL } from "url";
import {
  expireOrders,
  getBestAsk,
  getBestBid,
  getBuyOrders,
  getOrder,
  getSellOrders,
  getServices,
  getTradeSummary,
} from "./db.js";
import { handleStripeWebhook } from "./webhook-stripe.js";
import { handlePaypalWebhook } from "./webhook-paypal.js";

const PORT = parseInt(process.env.FT_WALLET_HTTP_PORT ?? "3099");
const FEE_RATE = 0.01975; // 手数料 1.975%
const validApiKeys = new Set(
  (process.env.VALID_API_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)
);

const RATES: Record<string, number> = {
  USD: 1, EUR: 0.92, JPY: 151, USDC: 1, PT: 100,
};

function setCors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function setSecurityHeaders(res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
}

function sanitizeService(input: string): string {
  // 英数字・各種文字・空白・ハイフンのみ許可（ホワイトリスト）
  return input.replace(/[^\p{L}\p{N}\s-]/gu, "").trim().slice(0, 100);
}

const rateMap = new Map<string, number[]>();
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const maxReqPerMin = 60;
  const hits = (rateMap.get(ip) ?? []).filter((t) => now - t < windowMs);
  hits.push(now);
  rateMap.set(ip, hits);
  // 期限切れのIPバケットを間引いてメモリ肥大化を防ぐ
  for (const [key, bucket] of rateMap) {
    if (!bucket.length || now - bucket[bucket.length - 1] > windowMs) rateMap.delete(key);
  }
  return hits.length > maxReqPerMin;
}

function getClientIp(req: IncomingMessage): string {
  const cfIp = req.headers["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp) return cfIp;

  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff.length > 0) return xff[0].split(",")[0].trim();

  return req.socket.remoteAddress ?? "unknown";
}

function isAuthExemptPath(path: string): boolean {
  return path === "/health" || path.startsWith("/webhook/");
}

function getApiKey(req: IncomingMessage): string {
  const raw = req.headers["x-api-key"];
  if (Array.isArray(raw)) return raw[0]?.trim() ?? "";
  return raw?.trim() ?? "";
}

async function readRawBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > maxBytes) throw new Error("payload too large");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, data: unknown, status = 200) {
  setCors(res);
  setSecurityHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── エンドポイント ──────────────────────────────────────
async function handleOrderbook(service: string, res: ServerResponse) {
  // 期限切れを先に処理
  await expireOrders();

  const ask = await getBestAsk(service);
  const bid = await getBestBid(service);
  const sells = await getSellOrders(service);
  const buys = await getBuyOrders(service);
  const spread = ask.best_ask && bid.best_bid
    ? (ask.best_ask - bid.best_bid).toFixed(4) : null;

  json(res, {
    service,
    timestamp: new Date().toISOString(),
    best_ask: ask.best_ask,
    best_bid: bid.best_bid,
    spread,
    sell_count: ask.sell_count,
    buy_count: bid.buy_count,
    sell_orders: sells,
    buy_orders: buys,
    rates: RATES,
    fee_rate: FEE_RATE,
  });
}

async function handleSummary(service: string, res: ServerResponse) {
  const summary = await getTradeSummary(service);
  json(res, { service, summary });
}

// ── AI エージェント専用エンドポイント ─────────────────────
// GET /ai/best-ask?service=xxx  → 最良売値1行だけ返す（軽量）
async function handleAiBestAsk(service: string, res: ServerResponse) {
  await expireOrders();
  const row = await getBestAsk(service);
  json(res, { service, best_ask: row.best_ask, sell_count: row.sell_count });
}

export function startHttpServer() {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "OPTIONS") {
        setCors(res);
        setSecurityHeaders(res);
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      const path = url.pathname;

      const ip = getClientIp(req);
      if (isRateLimited(ip)) return json(res, { error: "Too many requests" }, 429);

      if (!isAuthExemptPath(path)) {
        const apiKey = getApiKey(req);
        if (!apiKey || !validApiKeys.has(apiKey)) {
          return json(res, { error: "Unauthorized" }, 401);
        }
      }

      if (path === "/webhook/stripe" && req.method === "POST") {
        try {
          const rawBody = await readRawBody(req);
          const signatureHeader = req.headers["stripe-signature"];
          const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
          const result = await handleStripeWebhook(rawBody, signature);
          return json(res, result.body, result.status);
        } catch (error) {
          return json(res, { error: String(error) }, 400);
        }
      }

      if (path === "/webhook/paypal" && req.method === "POST") {
        try {
          const rawBody = await readRawBody(req);
          const result = await handlePaypalWebhook(rawBody, req.headers);
          return json(res, result.body, result.status);
        } catch (error) {
          return json(res, { error: String(error) }, 400);
        }
      }

      if (req.method !== "GET") return json(res, { error: "method not allowed" }, 405);

      const svc = sanitizeService(url.searchParams.get("service") ?? "");

      if (path === "/health") return json(res, { status: "ok", ts: new Date().toISOString() });
      if (path === "/orderbook") return svc ? await handleOrderbook(svc, res) : json(res, { error: "service required" }, 400);
      if (path === "/summary") return svc ? await handleSummary(svc, res) : json(res, { error: "service required" }, 400);
      if (path === "/ai/best-ask") return svc ? await handleAiBestAsk(svc, res) : json(res, { error: "service required" }, 400);
      if (path === "/services") return json(res, { services: await getServices() });

      const m = path.match(/^\/order\/(.+)$/);
      if (m) {
        const order = await getOrder(m[1]);
        return order ? json(res, order) : json(res, { error: "not found" }, 404);
      }

      json(res, { error: "not found" }, 404);
    } catch (error) {
      console.error("[ft-wallet] request failed:", error);
      if (!res.headersSent) return json(res, { error: "internal server error" }, 500);
      res.end();
    }
  });

  // 5分ごとに期限切れ処理
  setInterval(() => {
    expireOrders().catch((error) => {
      console.error("[ft-wallet] expireOrders failed:", error);
    });
  }, 5 * 60 * 1000);

  server.listen(PORT, () => {
    console.log(`[ft-wallet] HTTP API → http://localhost:${PORT}`);
  });
  return server;
}
