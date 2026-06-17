import Stripe from "stripe";
import { insertTrade } from "./db.js";

const FEE_RATE = 0.01975;
const POINTS_PER_USD = 100;

const stripeSecretKey = process.env.STRIPE_SECRET_KEY ?? "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";

// Webhook署名検証自体は API 呼び出しを行わないため、ローカル検証ではダミーキーで初期化可能。
const stripe = new Stripe(stripeSecretKey || "sk_test_dummy");

function roundUsd(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function sanitizeText(input: string): string {
  return input.replace(/[^\p{L}\p{N}\s-]/gu, "").trim().slice(0, 100);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /(UNIQUE constraint failed|duplicate key value)/i.test(error.message);
}

type WebhookResult = {
  status: number;
  body: Record<string, unknown>;
};

export async function handleStripeWebhook(rawBody: Buffer, signature: string | undefined): Promise<WebhookResult> {
  if (!stripeWebhookSecret) {
    return { status: 500, body: { error: "STRIPE_WEBHOOK_SECRET is not set" } };
  }
  if (!signature) {
    return { status: 400, body: { error: "stripe-signature header is required" } };
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret);
  } catch (error) {
    return { status: 400, body: { error: "invalid stripe signature", detail: String(error) } };
  }

  if (event.type !== "payment_intent.succeeded") {
    return { status: 200, body: { received: true, ignored_event: event.type } };
  }

  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const metadata = paymentIntent.metadata ?? {};
  const service = sanitizeText(metadata.service ?? "");
  const customerId = sanitizeText(metadata.customer_id ?? "");
  const orderId = sanitizeText(metadata.order_id ?? "");

  if (!service || !customerId || !orderId) {
    return {
      status: 400,
      body: {
        error: "missing required metadata",
        required: ["service", "customer_id", "order_id"],
      },
    };
  }

  const amountUsd = roundUsd((paymentIntent.amount_received || paymentIntent.amount || 0) / 100);
  const points = Math.floor(amountUsd * POINTS_PER_USD);
  const feeUsd = roundUsd(amountUsd * FEE_RATE);
  const tradeId = `trd-stripe-${paymentIntent.id}`;

  try {
    await insertTrade({
      trade_id: tradeId,
      order_id: orderId,
      service,
      side: "buy",
      price: amountUsd,
      qty: 1,
      total_usd: amountUsd,
      fee_usd: feeUsd,
      currency: (paymentIntent.currency ?? "usd").toUpperCase(),
      customer_id: customerId,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        status: 200,
        body: { received: true, duplicate: true, payment_intent_id: paymentIntent.id },
      };
    }
    return { status: 500, body: { error: "failed to record trade", detail: String(error) } };
  }

  return {
    status: 200,
    body: {
      received: true,
      payment_intent_id: paymentIntent.id,
      service,
      customer_id: customerId,
      order_id: orderId,
      total_usd: amountUsd,
      fee_usd: feeUsd,
      points,
      point_rate: `${POINTS_PER_USD}pt/USD`,
    },
  };
}
