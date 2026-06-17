// src/sqlite-db.ts
// SQLiteデータベース層 - orderStoreの永続化版（MCPツール互換）

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.FT_WALLET_DB_PATH
  ? process.env.FT_WALLET_DB_PATH
  : path.join(__dirname, "../../data/ft_wallet.db");

mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db: Database.Database = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    order_id    TEXT PRIMARY KEY,
    type        TEXT NOT NULL CHECK(type IN ('limit','market')),
    side        TEXT NOT NULL CHECK(side IN ('buy','sell')),
    service     TEXT NOT NULL,
    price       REAL,
    qty         INTEGER NOT NULL DEFAULT 1,
    customer_id TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK(status IN ('OPEN','MATCHED','CANCELLED','EXPIRED')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    matched_at  TEXT,
    matched_with TEXT
  );

  CREATE TABLE IF NOT EXISTS trades (
    trade_id    TEXT PRIMARY KEY,
    order_id    TEXT NOT NULL REFERENCES orders(order_id),
    service     TEXT NOT NULL,
    side        TEXT NOT NULL,
    price       REAL NOT NULL,
    qty         INTEGER NOT NULL DEFAULT 1,
    total_usd   REAL NOT NULL,
    fee_usd     REAL NOT NULL DEFAULT 0,
    currency    TEXT NOT NULL DEFAULT 'USD',
    customer_id TEXT NOT NULL,
    traded_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_orders_service_side_status
    ON orders(service, side, status);

  CREATE INDEX IF NOT EXISTS idx_orders_expires
    ON orders(expires_at);

  CREATE INDEX IF NOT EXISTS idx_trades_service
    ON trades(service);
`);

export const stmts: Record<string, Database.Statement> = {
  insertOrder: db.prepare(`
    INSERT INTO orders (order_id, type, side, service, price, qty, customer_id, expires_at)
    VALUES (@order_id, @type, @side, @service, @price, @qty, @customer_id, @expires_at)
  `),

  getBestAsk: db.prepare(`
    SELECT MIN(price) AS best_ask, COUNT(*) AS sell_count
    FROM orders
    WHERE service = ?
      AND side = 'sell'
      AND status = 'OPEN'
      AND expires_at > datetime('now')
  `),

  getBestBid: db.prepare(`
    SELECT MAX(price) AS best_bid, COUNT(*) AS buy_count
    FROM orders
    WHERE service = ?
      AND side = 'buy'
      AND status = 'OPEN'
      AND expires_at > datetime('now')
  `),

  getSellOrders: db.prepare(`
    SELECT order_id, price, qty, expires_at
    FROM orders
    WHERE service = ?
      AND side = 'sell'
      AND status = 'OPEN'
      AND expires_at > datetime('now')
    ORDER BY price ASC, created_at ASC
    LIMIT 20
  `),

  getBuyOrders: db.prepare(`
    SELECT order_id, price, qty, expires_at
    FROM orders
    WHERE service = ?
      AND side = 'buy'
      AND status = 'OPEN'
      AND expires_at > datetime('now')
    ORDER BY price DESC, created_at ASC
    LIMIT 20
  `),

  getOrder: db.prepare(`
    SELECT * FROM orders WHERE order_id = ?
  `),

  updateStatus: db.prepare(`
    UPDATE orders
    SET status = @status, matched_at = @matched_at, matched_with = @matched_with
    WHERE order_id = @order_id
  `),

  cancelOrder: db.prepare(`
    UPDATE orders
    SET status = 'CANCELLED'
    WHERE order_id = @order_id
      AND customer_id = @customer_id
      AND status = 'OPEN'
  `),

  expireOrders: db.prepare(`
    UPDATE orders
    SET status = 'EXPIRED'
    WHERE status = 'OPEN'
      AND expires_at <= datetime('now')
  `),

  insertTrade: db.prepare(`
    INSERT INTO trades (trade_id, order_id, service, side, price, qty, total_usd, fee_usd, currency, customer_id)
    VALUES (@trade_id, @order_id, @service, @side, @price, @qty, @total_usd, @fee_usd, @currency, @customer_id)
  `),

  getTradeSummary: db.prepare(`
    SELECT
      service,
      SUM(CASE WHEN side='sell' THEN qty ELSE 0 END) AS sell_count,
      SUM(CASE WHEN side='buy'  THEN qty ELSE 0 END) AS buy_count,
      CAST(COUNT(*) / 2 AS INTEGER) AS matched_count,
      SUM(total_usd) / 2.0 AS gross_settlement_usd,
      SUM(fee_usd)   AS fee_revenue_usd,
      SUM(CASE WHEN fee_usd > 0 THEN 1 ELSE 0 END) AS taker_count,
      AVG(price)     AS avg_price,
      MAX(price)     AS high,
      MIN(price)     AS low,
      COUNT(*)       AS trade_count
    FROM trades
    WHERE service = ?
  `),

  getServices: db.prepare(`
    SELECT DISTINCT service FROM orders ORDER BY service
  `),
};
