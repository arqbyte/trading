-- OKX is a market data source only. Live eligibility stays false until the
-- administrator verifies it (PRD 3.3, 19).
INSERT INTO exchanges (id, name, supports_market_data, live_trading_eligible)
VALUES ('okx', 'OKX', true, false);

-- Initial market universe (PRD 4.1). Precision fields are filled in by the
-- market data collector from OKX instrument metadata.
INSERT INTO instruments (exchange_id, symbol, exchange_symbol, base_asset, quote_asset)
VALUES
  ('okx', 'BTC/USDT',  'BTC-USDT',  'BTC',  'USDT'),
  ('okx', 'ETH/USDT',  'ETH-USDT',  'ETH',  'USDT'),
  ('okx', 'SOL/USDT',  'SOL-USDT',  'SOL',  'USDT'),
  ('okx', 'XRP/USDT',  'XRP-USDT',  'XRP',  'USDT'),
  ('okx', 'DOGE/USDT', 'DOGE-USDT', 'DOGE', 'USDT');
