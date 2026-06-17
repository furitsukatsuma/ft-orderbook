// src/services/storage.ts
// SQLiteベースのストレージ

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import type { PaymentRequest, Receipt, BananaTransaction } from "../types.js";

const DATA_DIR = join(process.env.HOME || "~", "ft-automation", "wallet-data");
const DB_PATH = join(DATA_DIR, "wallet.db");

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

ensureDir();
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    service_name TEXT NOT NULL,
    amount_jpy REAL,
    banana_data TEXT,
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    receipt_id TEXT
  );

  CREATE TABLE IF NOT EXISTS receipts (
    receipt_id TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    service_name TEXT NOT NULL,
    amount_jpy REAL,
    banana_data TEXT,
    issued_at TEXT NOT NULL,
    human_readable TEXT NOT NULL,
    ai_readable_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS banana_transactions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    offered_data TEXT NOT NULL,
    requested_service TEXT NOT NULL,
    ft_evaluation TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

type PaymentRow = {
  id: string;
  mode: PaymentRequest["mode"];
  agent_id: string;
  service_name: string;
  amount_jpy: number | null;
  banana_data: string | null;
  description: string;
  status: PaymentRequest["status"];
  created_at: string;
  approved_at: string | null;
  receipt_id: string | null;
};

type ReceiptRow = {
  receipt_id: string;
  payment_id: string;
  mode: Receipt["mode"];
  agent_id: string;
  service_name: string;
  amount_jpy: number | null;
  banana_data: string | null;
  issued_at: string;
  human_readable: string;
  ai_readable_json: string;
};

function mapPaymentRow(row: PaymentRow): PaymentRequest {
  return {
    id: row.id,
    mode: row.mode,
    agent_id: row.agent_id,
    service_name: row.service_name,
    amount_jpy: row.amount_jpy ?? undefined,
    banana_data: row.banana_data ?? undefined,
    description: row.description,
    status: row.status,
    created_at: row.created_at,
    approved_at: row.approved_at ?? undefined,
    receipt_id: row.receipt_id ?? undefined,
  };
}

function mapReceiptRow(row: ReceiptRow): Receipt {
  return {
    receipt_id: row.receipt_id,
    payment_id: row.payment_id,
    mode: row.mode,
    agent_id: row.agent_id,
    service_name: row.service_name,
    amount_jpy: row.amount_jpy ?? undefined,
    banana_data: row.banana_data ?? undefined,
    issued_at: row.issued_at,
    human_readable: row.human_readable,
    ai_readable: JSON.parse(row.ai_readable_json),
  };
}

// ── Payment Requests ──
export function getPayments(): PaymentRequest[] {
  const rows = db.prepare("SELECT * FROM payments ORDER BY created_at DESC").all() as PaymentRow[];
  return rows.map(mapPaymentRow);
}

export function savePayment(payment: PaymentRequest): void {
  db.prepare(`
    INSERT INTO payments (
      id, mode, agent_id, service_name, amount_jpy, banana_data, description,
      status, created_at, approved_at, receipt_id
    ) VALUES (
      @id, @mode, @agent_id, @service_name, @amount_jpy, @banana_data, @description,
      @status, @created_at, @approved_at, @receipt_id
    )
    ON CONFLICT(id) DO UPDATE SET
      mode = excluded.mode,
      agent_id = excluded.agent_id,
      service_name = excluded.service_name,
      amount_jpy = excluded.amount_jpy,
      banana_data = excluded.banana_data,
      description = excluded.description,
      status = excluded.status,
      created_at = excluded.created_at,
      approved_at = excluded.approved_at,
      receipt_id = excluded.receipt_id
  `).run({
    ...payment,
    amount_jpy: payment.amount_jpy ?? null,
    banana_data: payment.banana_data ?? null,
    approved_at: payment.approved_at ?? null,
    receipt_id: payment.receipt_id ?? null,
  });
}

export function getPaymentById(id: string): PaymentRequest | undefined {
  const row = db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as PaymentRow | undefined;
  return row ? mapPaymentRow(row) : undefined;
}

// ── Receipts ──
export function getReceipts(): Receipt[] {
  const rows = db.prepare("SELECT * FROM receipts ORDER BY issued_at DESC").all() as ReceiptRow[];
  return rows.map(mapReceiptRow);
}

export function saveReceipt(receipt: Receipt): void {
  db.prepare(`
    INSERT INTO receipts (
      receipt_id, payment_id, mode, agent_id, service_name, amount_jpy,
      banana_data, issued_at, human_readable, ai_readable_json
    ) VALUES (
      @receipt_id, @payment_id, @mode, @agent_id, @service_name, @amount_jpy,
      @banana_data, @issued_at, @human_readable, @ai_readable_json
    )
    ON CONFLICT(receipt_id) DO UPDATE SET
      payment_id = excluded.payment_id,
      mode = excluded.mode,
      agent_id = excluded.agent_id,
      service_name = excluded.service_name,
      amount_jpy = excluded.amount_jpy,
      banana_data = excluded.banana_data,
      issued_at = excluded.issued_at,
      human_readable = excluded.human_readable,
      ai_readable_json = excluded.ai_readable_json
  `).run({
    ...receipt,
    amount_jpy: receipt.amount_jpy ?? null,
    banana_data: receipt.banana_data ?? null,
    ai_readable_json: JSON.stringify(receipt.ai_readable),
  });
}

// ── Banana Transactions ──
export function getBananaTransactions(): BananaTransaction[] {
  return db
    .prepare("SELECT * FROM banana_transactions ORDER BY created_at DESC")
    .all() as BananaTransaction[];
}

export function saveBananaTransaction(tx: BananaTransaction): void {
  db.prepare(`
    INSERT INTO banana_transactions (
      id, agent_id, offered_data, requested_service, ft_evaluation, status, created_at
    ) VALUES (
      @id, @agent_id, @offered_data, @requested_service, @ft_evaluation, @status, @created_at
    )
    ON CONFLICT(id) DO UPDATE SET
      agent_id = excluded.agent_id,
      offered_data = excluded.offered_data,
      requested_service = excluded.requested_service,
      ft_evaluation = excluded.ft_evaluation,
      status = excluded.status,
      created_at = excluded.created_at
  `).run(tx);
}

// ── ID Generator ──
export function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
