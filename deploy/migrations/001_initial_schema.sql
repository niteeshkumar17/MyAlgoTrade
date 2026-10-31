-- ============================================================================
-- 001_initial_schema.sql
-- Complete Postgres Schema for AegisQuant Self-Learning Options Bot
-- Compatible with Neon Serverless Postgres and Supabase Postgres (PG 15/16)
-- ============================================================================

BEGIN;

-- 1. Control table (Single-row kill switch & pause gate)
CREATE TABLE IF NOT EXISTS control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    new_entries_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    kill_switch_active BOOLEAN NOT NULL DEFAULT FALSE,
    kill_switch_reason TEXT NOT NULL DEFAULT '',
    active_champion_version TEXT NOT NULL DEFAULT 'v1.0.0-baseline',
    active_challenger_version TEXT NOT NULL DEFAULT 'v1.1.0-shadow',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by TEXT NOT NULL DEFAULT 'system_init'
);

INSERT INTO control (id, new_entries_enabled, kill_switch_active, kill_switch_reason, updated_by)
VALUES (1, TRUE, FALSE, '', 'migration_001')
ON CONFLICT (id) DO NOTHING;

-- 2. Bot Health & Heartbeat (Polled by Vercel dashboard; >10m during market hours = OFFLINE)
CREATE TABLE IF NOT EXISTS bot_health (
    bot_id TEXT PRIMARY KEY,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_cycle_at TIMESTAMPTZ,
    last_cycle_status TEXT NOT NULL DEFAULT 'OK',
    market_open BOOLEAN NOT NULL DEFAULT FALSE,
    current_regime TEXT NOT NULL DEFAULT 'trending_up',
    sqlite_outbox_pending INTEGER NOT NULL DEFAULT 0,
    reconciliation_mismatches INTEGER NOT NULL DEFAULT 0,
    stale_quotes_rejected INTEGER NOT NULL DEFAULT 0,
    skipped_cycles INTEGER NOT NULL DEFAULT 0,
    memory_rss_mb NUMERIC(8,2) NOT NULL DEFAULT 142.5,
    last_error TEXT NOT NULL DEFAULT '',
    last_db_write_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Equity Snapshots (Logged every 5-minute cycle during market hours)
CREATE TABLE IF NOT EXISTS equity_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    recorded_at TIMESTAMPTZ NOT NULL,
    conservative_equity_usd NUMERIC(14,2) NOT NULL,
    alpaca_equity_usd NUMERIC(14,2) NOT NULL,
    spy_benchmark_equity_usd NUMERIC(14,2) NOT NULL,
    realized_pnl_usd NUMERIC(14,2) NOT NULL,
    unrealized_pnl_usd NUMERIC(14,2) NOT NULL,
    drawdown_pct NUMERIC(8,4) NOT NULL,
    open_positions_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_equity_snapshots_recorded_at ON equity_snapshots (recorded_at DESC);

-- 4. Signals (Both TAKEN and SKIPPED for counterfactual learning)
CREATE TABLE IF NOT EXISTS signals (
    signal_id TEXT PRIMARY KEY,
    generated_at TIMESTAMPTZ NOT NULL,
    underlying TEXT NOT NULL,
    strategy_name TEXT NOT NULL,
    direction TEXT NOT NULL,
    regime TEXT NOT NULL,
    confidence NUMERIC(6,4) NOT NULL,
    quality_gate_prob NUMERIC(6,4) NOT NULL,
    action_taken TEXT NOT NULL CHECK (action_taken IN ('TAKEN', 'SKIPPED', 'SHADOW_CHALLENGER')),
    skip_reason TEXT NOT NULL DEFAULT '',
    reason_summary TEXT NOT NULL,
    -- Counterfactual tracking for skipped signals (simulated 5-day outcome)
    counterfactual_contract TEXT,
    counterfactual_entry_price NUMERIC(10,4),
    counterfactual_exit_price NUMERIC(10,4),
    counterfactual_pnl_pct NUMERIC(8,4),
    counterfactual_evaluated BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_signals_generated_at ON signals (generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_action_strategy ON signals (action_taken, strategy_name);

-- 5. Orders (Idempotent order ledger for both Conservative Sim and Alpaca Paper)
CREATE TABLE IF NOT EXISTS orders (
    client_order_id TEXT PRIMARY KEY,
    broker_order_id TEXT NOT NULL,
    trade_id TEXT NOT NULL,
    contract_symbol TEXT NOT NULL,
    underlying TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    qty INTEGER NOT NULL,
    bid_at_order NUMERIC(10,4) NOT NULL,
    ask_at_order NUMERIC(10,4) NOT NULL,
    mid_at_order NUMERIC(10,4) NOT NULL,
    spread_pct_at_order NUMERIC(8,4) NOT NULL,
    conservative_fill_price NUMERIC(10,4) NOT NULL,
    alpaca_fill_price NUMERIC(10,4) NOT NULL,
    fee_usd NUMERIC(8,2) NOT NULL,
    status TEXT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_trade_id ON orders (trade_id);

-- 6. Open Positions (Live mark-to-market state)
CREATE TABLE IF NOT EXISTS positions (
    position_id TEXT PRIMARY KEY,
    trade_id TEXT NOT NULL UNIQUE,
    contract_symbol TEXT NOT NULL,
    underlying TEXT NOT NULL,
    right_type TEXT NOT NULL CHECK (right_type IN ('CE', 'PE', 'CALL', 'PUT')),
    lot_size INTEGER NOT NULL DEFAULT 75,
    strike NUMERIC(10,2) NOT NULL,
    expiration_date DATE NOT NULL,
    dte INTEGER NOT NULL,
    strategy_name TEXT NOT NULL,
    regime_at_entry TEXT NOT NULL,
    qty INTEGER NOT NULL,
    conservative_entry_price NUMERIC(10,4) NOT NULL,
    alpaca_entry_price NUMERIC(10,4) NOT NULL,
    current_mark_price NUMERIC(10,4) NOT NULL,
    peak_mark_price NUMERIC(10,4) NOT NULL,
    trough_mark_price NUMERIC(10,4) NOT NULL,
    unrealized_pnl_usd NUMERIC(12,2) NOT NULL,
    unrealized_pnl_pct NUMERIC(8,4) NOT NULL,
    delta NUMERIC(6,4) NOT NULL,
    theta NUMERIC(8,4) NOT NULL,
    iv_rank_pct NUMERIC(6,2) NOT NULL,
    stop_loss_price NUMERIC(10,4) NOT NULL,
    take_profit_price NUMERIC(10,4) NOT NULL,
    trailing_stop_activation_price NUMERIC(10,4) NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_positions_underlying ON positions (underlying);

-- 7. Closed Trades (Master trade journal)
CREATE TABLE IF NOT EXISTS trades (
    trade_id TEXT PRIMARY KEY,
    contract_symbol TEXT NOT NULL,
    underlying TEXT NOT NULL,
    right_type TEXT NOT NULL CHECK (right_type IN ('CE', 'PE', 'CALL', 'PUT')),
    lot_size INTEGER NOT NULL DEFAULT 75,
    strategy_name TEXT NOT NULL,
    regime_at_entry TEXT NOT NULL,
    is_shadow_challenger BOOLEAN NOT NULL DEFAULT FALSE,
    model_version TEXT NOT NULL,
    qty INTEGER NOT NULL,
    dte_at_entry INTEGER NOT NULL,
    delta_at_entry NUMERIC(6,4) NOT NULL,
    iv_rank_at_entry NUMERIC(6,2) NOT NULL,
    spread_pct_at_entry NUMERIC(8,4) NOT NULL,
    confidence_at_entry NUMERIC(6,4) NOT NULL,
    conservative_entry_price NUMERIC(10,4) NOT NULL,
    conservative_exit_price NUMERIC(10,4) NOT NULL,
    alpaca_entry_price NUMERIC(10,4) NOT NULL,
    alpaca_exit_price NUMERIC(10,4) NOT NULL,
    fees_total_usd NUMERIC(8,2) NOT NULL,
    conservative_pnl_usd NUMERIC(12,2) NOT NULL,
    conservative_pnl_pct NUMERIC(8,4) NOT NULL,
    alpaca_pnl_usd NUMERIC(12,2) NOT NULL,
    alpaca_pnl_pct NUMERIC(8,4) NOT NULL,
    mae_pct NUMERIC(8,4) NOT NULL,
    mfe_pct NUMERIC(8,4) NOT NULL,
    hold_minutes INTEGER NOT NULL,
    entry_reason TEXT NOT NULL,
    exit_reason TEXT NOT NULL,
    post_mortem_label TEXT NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades (closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_strategy_regime ON trades (strategy_name, regime_at_entry);
CREATE INDEX IF NOT EXISTS idx_trades_underlying ON trades (underlying);

-- 8. Entry Features Table (Feature vector stored at trade entry for walk-forward ML training)
CREATE TABLE IF NOT EXISTS features (
    trade_id TEXT PRIMARY KEY REFERENCES trades(trade_id) ON DELETE CASCADE,
    rsi_14 NUMERIC(6,2) NOT NULL,
    adx_14 NUMERIC(6,2) NOT NULL,
    atr_pct NUMERIC(8,4) NOT NULL,
    iv_rank_pct NUMERIC(6,2) NOT NULL,
    abs_delta NUMERIC(6,4) NOT NULL,
    dte INTEGER NOT NULL,
    spread_pct NUMERIC(8,4) NOT NULL,
    time_of_day_bucket TEXT NOT NULL,
    weekday INTEGER NOT NULL,
    vix_proxy NUMERIC(6,2) NOT NULL,
    dist_from_ema20_pct NUMERIC(8,4) NOT NULL,
    dist_from_vwap_pct NUMERIC(8,4) NOT NULL
);

-- 9. Post-Mortems Table (Detailed automated diagnosis per closed trade)
CREATE TABLE IF NOT EXISTS post_mortems (
    trade_id TEXT PRIMARY KEY REFERENCES trades(trade_id) ON DELETE CASCADE,
    primary_label TEXT NOT NULL,
    underlying_return_pct NUMERIC(8,4) NOT NULL,
    iv_change_pct NUMERIC(8,4) NOT NULL,
    post_exit_60m_option_return_pct NUMERIC(8,4) NOT NULL,
    peak_mfe_giveback_pct NUMERIC(8,4) NOT NULL,
    diagnosis_notes TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_post_mortems_label ON post_mortems (primary_label);

-- 10. Model Versions (Versioned, seeded, explainable quality-gate & bandit models)
CREATE TABLE IF NOT EXISTS model_versions (
    version_id TEXT PRIMARY KEY,
    model_type TEXT NOT NULL,
    role_status TEXT NOT NULL CHECK (role_status IN ('CHAMPION', 'CHALLENGER', 'ARCHIVED')),
    trained_at TIMESTAMPTZ NOT NULL,
    training_sample_size INTEGER NOT NULL,
    validation_auc NUMERIC(6,4) NOT NULL,
    validation_expectancy_usd NUMERIC(10,2) NOT NULL,
    feature_weights_json JSONB NOT NULL,
    bandit_allocations_json JSONB NOT NULL,
    parameters_json JSONB NOT NULL
);

-- 11. Learning Log (Audit log of every adaptation, parameter tweak, promotion, or rollback)
CREATE TABLE IF NOT EXISTS learning_log (
    log_id TEXT PRIMARY KEY,
    logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    change_category TEXT NOT NULL,
    model_version TEXT NOT NULL,
    parameter_or_bucket TEXT NOT NULL,
    old_value TEXT NOT NULL,
    new_value TEXT NOT NULL,
    sample_size INTEGER NOT NULL,
    bootstrap_ci_90 TEXT NOT NULL,
    reason_and_evidence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_log_logged_at ON learning_log (logged_at DESC);

-- 12. Config History (Snapshots of config.yaml + tuned bounds for 1-command rollback)
CREATE TABLE IF NOT EXISTS config_history (
    config_version_id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active_champion BOOLEAN NOT NULL DEFAULT FALSE,
    previous_champion_id TEXT,
    config_payload_json JSONB NOT NULL,
    change_summary TEXT NOT NULL
);

COMMIT;
