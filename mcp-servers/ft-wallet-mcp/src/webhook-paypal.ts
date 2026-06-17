import type { IncomingHttpHeaders } from "http";
import { insertTrade } from "./db.js";

const FEE_RATE = 0.01975;
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID ?? "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET ?? "";
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID ?? "";
const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE ?? "https://api-m.paypal.com";

type WebhookResult = {
  status: number;
  body: Record<string, unknown>;
};

type PaypalMeta = {
  order_id: string;
  service: string;
  customer_id: string;
};

function roundUsd(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function sanitizeText(input: string): string {
  return input.replace(/[^\p{L}\p{N}\s:_-]/gu, "").trim().slice(0, 100);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /(UNIQUE constraint failed|duplicate key value)/i.test(error.message);
}

function headerValue(headers: IncomingHttpHeaders, key: string): string {
  const value = headers[key];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function parseMetaFromCustomId(customId: string): PaypalMeta | null {
  const trimmed = customId.trim();
  if (!trimmed) return null;

  // JSON 形式: {"order_id":"...","service":"...","customer_id":"..."}
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const order_id = sanitizeText(String(parsed.order_id ?? ""));
      const service = sanitizeText(String(parsed.service ?? ""));
      const customer_id = sanitizeText(String(parsed.customer_id ?? ""));
      if (order_id && service && customer_id) return { order_id, service, customer_id };
    } catch {
      // ignore
    }
  }

  // key=value 形式: order_id=...;service=...;customer_id=...
  const map: Record<string, string> = {};
  for (const pair of trimmed.split(/[;,]/)) {
    const [k, v] = pair.split("=").map((x) => x?.trim() ?? "");
    if (k && v) map[k] = v;
  }
  const order_id = sanitizeText(map.order_id ?? "");
  const service = sanitizeText(map.service ?? "");
  const customer_id = sanitizeText(map.customer_id ?? "");
  if (order_id && service && customer_id) return { order_id, service, customer_id };

  return null;
}

async function getPaypalAccessToken(): Promise<string> {
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) {
    throw new Error(`paypal oauth failed: ${response.status} ${await response.text()}`);
  }
  const token = (await response.json()) as { access_token?: string };
  if (!token.access_token) throw new Error("paypal oauth missing access_token");
  return token.access_token;
}

async function verifyPaypalSignature(
  headers: IncomingHttpHeaders,
  webhookEvent: unknown
): Promise<boolean> {
  const transmissionId = headerValue(headers, "paypal-transmission-id");
  const transmissionTime = headerValue(headers, "paypal-transmission-time");
  const certUrl = headerValue(headers, "paypal-cert-url");
  const authAlgo = headerValue(headers, "paypal-auth-algo");
  const transmissionSig = headerValue(headers, "paypal-transmission-sig");

  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    throw new Error("missing PayPal signature headers");
  }

  const accessToken = await getPaypalAccessToken();
  const response = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      transmission_id: transmissionId,
      transmission_time: transmissionTime,
      cert_url: certUrl,
      auth_algo: authAlgo,
      transmission_sig: transmissionSig,
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event: webhookEvent,
    }),
  });

  if (!response.ok) {
    throw new Error(`paypal verify failed: ${response.status} ${await response.text()}`);
  }

  const verify = (await response.json()) as { verification_status?: string };
  return verify.verification_status === "SUCCESS";
}

export async function handlePaypalWebhook(
  rawBody: Buffer,
  headers: IncomingHttpHeaders
): Promise<WebhookResult> {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYPAL_WEBHOOK_ID) {
    return {
      status: 500,
      body: { error: "PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET/PAYPAL_WEBHOOK_ID are required" },
    };
  }

  let event: any;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "invalid JSON body" } };
  }

  try {
    const verified = await verifyPaypalSignature(headers, event);
    if (!verified) return { status: 400, body: { error: "invalid paypal webhook signature" } };
  } catch (error) {
    return { status: 400, body: { error: "paypal signature verification failed", detail: String(error) } };
  }

  if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
    return { status: 200, body: { received: true, ignored_event: event.event_type ?? null } };
  }

  const resource = event.resource ?? {};
  const customId = sanitizeText(String(resource.custom_id ?? ""));
  const meta = parseMetaFromCustomId(customId);
  if (!meta) {
    return {
      status: 400,
      body: {
        error: "custom_id metadata required",
        expected: "JSON or key=value with order_id, service, customer_id",
      },
    };
  }

  const grossUsd = Number(resource.amount?.value ?? 0);
  if (!Number.isFinite(grossUsd) || grossUsd <= 0) {
    return { status: 400, body: { error: "invalid capture amount" } };
  }
  const feeUsd = roundUsd(grossUsd * FEE_RATE);
  const points = Math.floor(grossUsd * 100);
  const captureId = sanitizeText(String(resource.id ?? ""));
  const currency = sanitizeText(String(resource.amount?.currency_code ?? "USD")).toUpperCase();
  const tradeId = `trd-paypal-${captureId || sanitizeText(String(event.id ?? Date.now()))}`;

  try {
    await insertTrade({
      trade_id: tradeId,
      order_id: meta.order_id,
      service: meta.service,
      side: "buy",
      price: roundUsd(grossUsd),
      qty: 1,
      total_usd: roundUsd(grossUsd),
      fee_usd: feeUsd,
      currency,
      customer_id: meta.customer_id,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { status: 200, body: { received: true, duplicate: true, capture_id: captureId } };
    }
    return { status: 500, body: { error: "failed to record PayPal trade", detail: String(error) } };
  }

  return {
    status: 200,
    body: {
      received: true,
      event_type: event.event_type,
      capture_id: captureId,
      order_id: meta.order_id,
      service: meta.service,
      customer_id: meta.customer_id,
      total_usd: roundUsd(grossUsd),
      fee_usd: feeUsd,
      points,
      point_rate: "100pt/USD",
    },
  };
}
