-- Initial schema for the AI Trading Research Platform (PRD section 14).
--
-- Conventions:
--   * Every timestamp is timestamptz and the server session runs in UTC.
--   * Every price, quantity, balance and fee is NUMERIC, never float.
--   * Simulated and live money live in separate tables with no foreign key
--     path between them, so simulated funds cannot reach live execution.

SET TIME ZONE 'UTC';

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Users and audit
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz
);

CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type  text NOT NULL CHECK (actor_type IN ('admin', 'system', 'agent')),
  actor_id    text NOT NULL,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);

CREATE FUNCTION reject_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------
-- Exchanges, credentials, instruments
-- ---------------------------------------------------------------------------

CREATE TABLE exchanges (
  id                    text PRIMARY KEY,
  name                  text NOT NULL,
  supports_market_data  boolean NOT NULL DEFAULT false,
  -- Market data support never implies live eligibility (PRD 3.3).
  live_trading_eligible boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exchange_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id    text NOT NULL REFERENCES exchanges(id),
  label          text NOT NULL,
  -- Only ciphertext is stored. The key lives outside the database and is
  -- available to the live execution service alone.
  ciphertext     bytea NOT NULL,
  nonce          bytea NOT NULL,
  key_version    integer NOT NULL,
  permissions    text[] NOT NULL,
  ip_restricted  boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  CONSTRAINT exchange_credentials_no_withdraw
    CHECK (NOT ('withdraw' = ANY (permissions))),
  CONSTRAINT exchange_credentials_known_permissions
    CHECK (permissions <@ ARRAY['read', 'trade']::text[])
);

CREATE TABLE instruments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id        text NOT NULL REFERENCES exchanges(id),
  symbol             text NOT NULL CHECK (symbol ~ '^[A-Z0-9]+/[A-Z0-9]+$'),
  exchange_symbol    text NOT NULL,
  base_asset         text NOT NULL,
  quote_asset        text NOT NULL,
  market_type        text NOT NULL DEFAULT 'spot' CHECK (market_type = 'spot'),
  -- Filled from exchange metadata by the market data collector.
  tick_size          numeric CHECK (tick_size > 0),
  lot_size           numeric CHECK (lot_size > 0),
  min_order_size     numeric CHECK (min_order_size > 0),
  enabled            boolean NOT NULL DEFAULT true,
  metadata_synced_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exchange_id, symbol),
  UNIQUE (exchange_id, exchange_symbol)
);

-- ---------------------------------------------------------------------------
-- Market data (TimescaleDB hypertables when the extension is available)
-- ---------------------------------------------------------------------------

CREATE TABLE market_candles (
  exchange_id text NOT NULL,
  symbol      text NOT NULL,
  timeframe   text NOT NULL CHECK (timeframe IN ('1m', '5m', '15m', '1h', '4h', '1d')),
  ts          timestamptz NOT NULL, -- candle open time, UTC
  open        numeric NOT NULL,
  high        numeric NOT NULL,
  low         numeric NOT NULL,
  close       numeric NOT NULL,
  volume      numeric NOT NULL CHECK (volume >= 0),
  is_closed   boolean NOT NULL,
  source      text NOT NULL CHECK (source IN ('rest', 'websocket')),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (exchange_id, symbol, timeframe, ts),
  CHECK (high >= low AND high >= open AND high >= close AND low <= open AND low <= close)
);

CREATE TABLE market_trades (
  exchange_id text NOT NULL,
  symbol      text NOT NULL,
  trade_id    text NOT NULL,
  ts          timestamptz NOT NULL,
  side        text NOT NULL CHECK (side IN ('buy', 'sell')),
  price       numeric NOT NULL CHECK (price > 0),
  size        numeric NOT NULL CHECK (size > 0),
  PRIMARY KEY (exchange_id, symbol, trade_id, ts)
);

CREATE TABLE orderbook_snapshots (
  exchange_id text NOT NULL,
  symbol      text NOT NULL,
  ts          timestamptz NOT NULL,
  -- Arrays of [price, size] pairs as decimal strings, best level first.
  bids        jsonb NOT NULL,
  asks        jsonb NOT NULL,
  checksum    bigint,
  PRIMARY KEY (exchange_id, symbol, ts)
);

CREATE TABLE data_quality_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exchange_id text NOT NULL,
  symbol      text,
  timeframe   text,
  kind        text NOT NULL CHECK (kind IN (
                'gap', 'stale', 'duplicate', 'reconnect', 'rate_limit',
                'checksum_mismatch', 'invalid_payload')),
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX data_quality_events_open_idx ON data_quality_events (detected_at) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- Strategies and research
-- ---------------------------------------------------------------------------

CREATE TABLE strategies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by  text NOT NULL, -- 'admin:<id>', 'researcher:<name>' or 'builtin'
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE strategy_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id       uuid NOT NULL REFERENCES strategies(id),
  version           text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
  spec              jsonb NOT NULL,
  parameters        jsonb NOT NULL DEFAULT '{}'::jsonb,
  spec_hash         text NOT NULL,
  author            text NOT NULL,
  validation_status text NOT NULL DEFAULT 'draft' CHECK (validation_status IN (
                      'draft', 'validating', 'valid', 'invalid', 'approved', 'rejected')),
  validation_report jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (strategy_id, version),
  UNIQUE (strategy_id, spec_hash)
);

-- A version's content can never change; changing parameters means a new
-- version (PRD 6.5). Only the validation status and report may move.
CREATE FUNCTION strategy_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'strategy versions cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.strategy_id IS DISTINCT FROM OLD.strategy_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.spec IS DISTINCT FROM OLD.spec
     OR NEW.parameters IS DISTINCT FROM OLD.parameters
     OR NEW.spec_hash IS DISTINCT FROM OLD.spec_hash
     OR NEW.author IS DISTINCT FROM OLD.author
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'strategy version % is immutable; create a new version instead', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER strategy_versions_immutable
  BEFORE UPDATE OR DELETE ON strategy_versions
  FOR EACH ROW EXECUTE FUNCTION strategy_versions_immutable();

CREATE TABLE research_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  researcher  text NOT NULL CHECK (researcher IN ('market_analyst', 'strategy_developer', 'strategy_optimiser')),
  kind        text NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input       jsonb NOT NULL DEFAULT '{}'::jsonb,
  output      jsonb,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);

CREATE TABLE strategy_candidates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_task_id    uuid REFERENCES research_tasks(id),
  strategy_version_id uuid REFERENCES strategy_versions(id),
  proposed_spec       jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'proposed' CHECK (status IN (
                        'proposed', 'validating', 'invalid', 'backtested', 'approved', 'rejected', 'archived')),
  rejection_reason    text,
  reviewed_by         uuid REFERENCES users(id),
  reviewed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Only an administrator can approve (PRD 6.4 step 8); automatic approval
  -- will be recorded against a configured admin user.
  CHECK (status <> 'approved' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND strategy_version_id IS NOT NULL))
);

CREATE TABLE backtest_runs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_version_id     uuid NOT NULL REFERENCES strategy_versions(id),
  dataset                 text NOT NULL CHECK (dataset IN ('training', 'validation', 'out_of_sample', 'walk_forward')),
  market_data_version     text NOT NULL,
  execution_model_version text NOT NULL,
  fee_config              jsonb NOT NULL,
  slippage_config         jsonb NOT NULL,
  symbols                 text[] NOT NULL,
  period_start            timestamptz NOT NULL,
  period_end              timestamptz NOT NULL CHECK (period_end > period_start),
  status                  text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  metrics                 jsonb,
  error                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  finished_at             timestamptz
);

-- ---------------------------------------------------------------------------
-- Agents and experiments
-- ---------------------------------------------------------------------------

CREATE TABLE agents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name        text NOT NULL,
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  status      text NOT NULL DEFAULT 'paused' CHECK (status IN ('active', 'paused', 'disabled')),
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN (
                       'draft', 'running', 'paused', 'completed', 'stopped')),
  starts_at          timestamptz,
  ends_at            timestamptz,
  market_universe    text[] NOT NULL,
  quote_asset        text NOT NULL DEFAULT 'USDT',
  starting_capital   numeric NOT NULL CHECK (starting_capital > 0),
  simulation_config  jsonb NOT NULL, -- fees, slippage, execution model version
  risk_config        jsonb NOT NULL,
  -- Set at the start of the final evaluation phase (PRD 10.2 phase 4).
  versions_frozen_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE experiment_agents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id       uuid NOT NULL REFERENCES experiments(id),
  agent_id            uuid NOT NULL REFERENCES agents(id),
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions(id),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'removed')),
  joined_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, agent_id)
);

-- A participant's strategy version is fixed for the life of the experiment,
-- and nobody joins once versions are frozen.
CREATE FUNCTION experiment_agents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frozen timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.strategy_version_id IS DISTINCT FROM OLD.strategy_version_id
                           OR NEW.experiment_id IS DISTINCT FROM OLD.experiment_id
                           OR NEW.agent_id IS DISTINCT FROM OLD.agent_id) THEN
    RAISE EXCEPTION 'experiment participants cannot change strategy version' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT versions_frozen_at INTO frozen FROM experiments WHERE id = NEW.experiment_id;
    IF frozen IS NOT NULL THEN
      RAISE EXCEPTION 'experiment % is frozen; no new participants', NEW.experiment_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER experiment_agents_guard
  BEFORE INSERT OR UPDATE ON experiment_agents
  FOR EACH ROW EXECUTE FUNCTION experiment_agents_guard();

-- ---------------------------------------------------------------------------
-- Paper trading (simulated money only)
-- ---------------------------------------------------------------------------

CREATE TABLE simulated_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_agent_id uuid NOT NULL UNIQUE REFERENCES experiment_agents(id),
  quote_asset         text NOT NULL,
  starting_balance    numeric NOT NULL CHECK (starting_balance > 0),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE simulated_balances (
  account_id uuid NOT NULL REFERENCES simulated_accounts(id),
  asset      text NOT NULL,
  -- Spot only: no negative balances, so no shorting or borrowing.
  free       numeric NOT NULL DEFAULT 0 CHECK (free >= 0),
  locked     numeric NOT NULL DEFAULT 0 CHECK (locked >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, asset)
);

CREATE TABLE signals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_agent_id uuid NOT NULL REFERENCES experiment_agents(id),
  symbol              text NOT NULL,
  action              text NOT NULL CHECK (action IN ('BUY', 'SELL', 'HOLD')),
  confidence          numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  timeframe           text NOT NULL,
  payload             jsonb NOT NULL, -- the full signal as received
  outcome             text NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'ignored')),
  rejection_reason    text,
  signal_ts           timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (outcome <> 'rejected' OR rejection_reason IS NOT NULL)
);
CREATE INDEX signals_participant_idx ON signals (experiment_agent_id, received_at DESC);

CREATE TABLE simulated_orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL REFERENCES simulated_accounts(id),
  -- Idempotency key: retries with the same key never create a second order.
  client_order_id         text NOT NULL,
  signal_id               uuid REFERENCES signals(id),
  symbol                  text NOT NULL,
  side                    text NOT NULL CHECK (side IN ('buy', 'sell')),
  type                    text NOT NULL CHECK (type IN ('market', 'limit', 'stop_loss', 'take_profit')),
  status                  text NOT NULL CHECK (status IN (
                            'pending', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected')),
  quantity                numeric NOT NULL CHECK (quantity > 0),
  limit_price             numeric CHECK (limit_price > 0),
  trigger_price           numeric CHECK (trigger_price > 0),
  filled_quantity         numeric NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  average_fill_price      numeric,
  fees_paid               numeric NOT NULL DEFAULT 0 CHECK (fees_paid >= 0),
  reject_reason           text,
  execution_model_version text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, client_order_id),
  CHECK (filled_quantity <= quantity),
  CHECK (type <> 'limit' OR limit_price IS NOT NULL),
  CHECK (type NOT IN ('stop_loss', 'take_profit') OR trigger_price IS NOT NULL),
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);
CREATE INDEX simulated_orders_open_idx ON simulated_orders (account_id) WHERE status IN ('pending', 'open', 'partially_filled');

CREATE TABLE simulated_fills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES simulated_orders(id),
  account_id   uuid NOT NULL REFERENCES simulated_accounts(id),
  ts           timestamptz NOT NULL,
  price        numeric NOT NULL CHECK (price > 0),
  quantity     numeric NOT NULL CHECK (quantity > 0),
  fee          numeric NOT NULL CHECK (fee >= 0),
  fee_asset    text NOT NULL,
  liquidity    text NOT NULL CHECK (liquidity IN ('maker', 'taker')),
  reference_price numeric NOT NULL, -- mid/best price the slippage is measured against
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX simulated_fills_order_idx ON simulated_fills (order_id);

CREATE TRIGGER simulated_fills_append_only
  BEFORE UPDATE OR DELETE ON simulated_fills
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TABLE trades (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES simulated_accounts(id),
  symbol        text NOT NULL,
  quantity      numeric NOT NULL CHECK (quantity > 0),
  entry_price   numeric NOT NULL CHECK (entry_price > 0),
  exit_price    numeric NOT NULL CHECK (exit_price > 0),
  fees          numeric NOT NULL CHECK (fees >= 0),
  realised_pnl  numeric NOT NULL,
  opened_at     timestamptz NOT NULL,
  closed_at     timestamptz NOT NULL CHECK (closed_at >= opened_at)
);
CREATE INDEX trades_account_idx ON trades (account_id, closed_at DESC);

CREATE TABLE portfolio_snapshots (
  account_id      uuid NOT NULL REFERENCES simulated_accounts(id),
  ts              timestamptz NOT NULL,
  quote_balance   numeric NOT NULL,
  positions_value numeric NOT NULL,
  total_value     numeric NOT NULL,
  realised_pnl    numeric NOT NULL,
  unrealised_pnl  numeric NOT NULL,
  fees_paid       numeric NOT NULL,
  PRIMARY KEY (account_id, ts)
);

CREATE TABLE performance_metrics (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES simulated_accounts(id),
  window_start    timestamptz NOT NULL,
  window_end      timestamptz NOT NULL,
  metrics         jsonb NOT NULL, -- net P&L, ROI, drawdown, Sharpe, ... as decimal strings
  composite_score numeric,
  computed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX performance_metrics_account_idx ON performance_metrics (account_id, computed_at DESC);

-- ---------------------------------------------------------------------------
-- Live trading (real money; disabled by default, not used by the MVP)
-- ---------------------------------------------------------------------------

CREATE TABLE live_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id      text NOT NULL REFERENCES exchanges(id),
  credential_id    uuid REFERENCES exchange_credentials(id),
  label            text NOT NULL,
  quote_asset      text NOT NULL,
  capital_limit    numeric NOT NULL CHECK (capital_limit > 0),
  capital_currency text NOT NULL DEFAULT 'GBP',
  enabled          boolean NOT NULL DEFAULT false,
  enabled_by       uuid REFERENCES users(id),
  enabled_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Enabling requires a named administrator and a credential (PRD 11.4).
  CHECK (NOT enabled OR (enabled_by IS NOT NULL AND enabled_at IS NOT NULL AND credential_id IS NOT NULL))
);

-- Live accounts may only be enabled on an exchange flagged as eligible.
CREATE FUNCTION live_accounts_require_eligible_exchange() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled AND NOT (SELECT live_trading_eligible FROM exchanges WHERE id = NEW.exchange_id) THEN
    RAISE EXCEPTION 'exchange % is not eligible for live trading', NEW.exchange_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER live_accounts_require_eligible_exchange
  BEFORE INSERT OR UPDATE ON live_accounts
  FOR EACH ROW EXECUTE FUNCTION live_accounts_require_eligible_exchange();

CREATE TABLE live_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  live_account_id     uuid NOT NULL REFERENCES live_accounts(id),
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions(id),
  client_order_id     text NOT NULL UNIQUE,
  exchange_order_id   text,
  symbol              text NOT NULL,
  side                text NOT NULL CHECK (side IN ('buy', 'sell')),
  type                text NOT NULL CHECK (type IN ('market', 'limit')),
  status              text NOT NULL CHECK (status IN (
                        'pending', 'submitted', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected', 'unknown')),
  quantity            numeric NOT NULL CHECK (quantity > 0),
  limit_price         numeric CHECK (limit_price > 0),
  filled_quantity     numeric NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  average_fill_price  numeric,
  fees_paid           numeric NOT NULL DEFAULT 0,
  fee_asset           text,
  raw_response        jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (filled_quantity <= quantity)
);

-- ---------------------------------------------------------------------------
-- Risk and safety controls
-- ---------------------------------------------------------------------------

CREATE TABLE risk_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_kind         text NOT NULL CHECK (account_kind IN ('simulated', 'live', 'system')),
  simulated_account_id uuid REFERENCES simulated_accounts(id),
  live_account_id      uuid REFERENCES live_accounts(id),
  signal_id            uuid REFERENCES signals(id),
  severity             text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  kind                 text NOT NULL,
  details              jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_by      uuid REFERENCES users(id),
  acknowledged_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (account_kind = 'simulated' AND simulated_account_id IS NOT NULL AND live_account_id IS NULL) OR
    (account_kind = 'live'      AND live_account_id IS NOT NULL AND simulated_account_id IS NULL) OR
    (account_kind = 'system'    AND live_account_id IS NULL AND simulated_account_id IS NULL)
  )
);
CREATE INDEX risk_events_unacknowledged_idx ON risk_events (created_at) WHERE severity = 'critical' AND acknowledged_at IS NULL;

-- Pauses and kill switches. A halt is active while cleared_at is NULL, and
-- clearing a critical halt requires an administrator (PRD 8.3, 11.5).
CREATE TABLE trading_halts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope      text NOT NULL CHECK (scope IN ('global', 'experiment', 'agent', 'live')),
  target_id  uuid,
  reason     text NOT NULL,
  critical   boolean NOT NULL DEFAULT false,
  created_by text NOT NULL, -- 'admin:<id>' or 'system:<component>'
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_by uuid REFERENCES users(id),
  cleared_at timestamptz,
  CHECK ((scope IN ('global', 'live')) = (target_id IS NULL)),
  CHECK ((cleared_at IS NULL) = (cleared_by IS NULL))
);
CREATE INDEX trading_halts_active_idx ON trading_halts (scope, target_id) WHERE cleared_at IS NULL;

-- ---------------------------------------------------------------------------
-- TimescaleDB (optional so tests can run against plain PostgreSQL)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
    PERFORM create_hypertable('market_candles', 'ts', chunk_time_interval => INTERVAL '7 days');
    PERFORM create_hypertable('market_trades', 'ts', chunk_time_interval => INTERVAL '1 day');
    PERFORM create_hypertable('orderbook_snapshots', 'ts', chunk_time_interval => INTERVAL '1 day');
    PERFORM create_hypertable('portfolio_snapshots', 'ts', chunk_time_interval => INTERVAL '7 days');
  ELSE
    RAISE NOTICE 'timescaledb not available; market data tables are plain tables';
  END IF;
END;
$$;
