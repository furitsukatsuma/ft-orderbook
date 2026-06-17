-- AIエージェントが使うSQL早見表

-- 最良売値（板取得）
SELECT MIN(price) AS best_ask, COUNT(*) AS sell_count
FROM orders
WHERE service = 'コードレビュー'
  AND side = 'sell' AND status = 'OPEN'
  AND expires_at > datetime('now');

-- 最良買値
SELECT MAX(price) AS best_bid, COUNT(*) AS buy_count
FROM orders
WHERE service = 'コードレビュー'
  AND side = 'buy' AND status = 'OPEN'
  AND expires_at > datetime('now');

-- 約定サマリー（総売上確認）
SELECT SUM(total_usd) AS revenue, COUNT(*) AS trades
FROM trades
WHERE service = 'コードレビュー';

-- 期限切れ一括処理
UPDATE orders SET status = 'EXPIRED'
WHERE status = 'OPEN' AND expires_at <= datetime('now');
