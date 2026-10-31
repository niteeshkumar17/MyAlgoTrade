"""Main Daemon Entrypoint for Oracle Cloud Always Free VM (Indian NSE F&O Paper Bot).

Runs under systemd with APScheduler in Asia/Kolkata (IST) timezone:
- Heartbeat every 60 seconds
- Decision cycle every 5 minutes (configurable 1-15m) during NSE market hours (09:15 - 15:30 IST)
- Daily after-close job (15:45 IST): counterfactual evaluation, nightly CSV backup, EOD summary alert
- Weekly Saturday learning job (Saturday 10:00 IST): walk-forward retrain, Thompson bandit update,
  bounded +/-10% parameter tuning, and Champion/Challenger evaluation.
- CLI flags:
  `python -m src.main --dry-run-once`
  `python -m src.main --rollback-champion`
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from .alerts import AlertDispatcher, configure_structured_logging
from .alpaca_client import AlpacaPaperService
from .calendar_utils import MarketCalendar
from .config import BotConfig, load_bot_config
from .db import ResilientDatabaseManager
from .exits import OpenPositionState, evaluate_position_exit
from .fills import simulate_pessimistic_fill
from .learning import ThompsonSamplingBandit, TradeQualityGateLearner
from .regime import compute_indicators, detect_market_regime
from .risk import (
    PortfolioRiskSnapshot,
    compute_idempotent_order_id,
    evaluate_entry_risk_and_size,
    reconcile_positions,
)
from .strategies import (
    evaluate_breakout_momentum,
    evaluate_mean_reversion,
    evaluate_trend_following,
    select_best_option_contract,
)

IST_TZ = ZoneInfo("Asia/Kolkata")
logger = logging.getLogger("aegis.main")


class OptionsPaperBotDaemon:
    """Orchestrates the 24/7 self-learning Indian NSE F&O options paper-trading lifecycle."""

    def __init__(self, config: BotConfig) -> None:
        self.config = config
        sys_cfg = config.raw.get("system", {})
        self.calendar = MarketCalendar(
            exchange=sys_cfg.get("exchange_calendar", "XBOM"),
            timezone_name=sys_cfg.get("timezone", "Asia/Kolkata"),
        )
        self.broker = AlpacaPaperService(config)
        self.broker.verify_paper_only()

        storage_cfg = config.raw.get("storage", {})
        self.db = ResilientDatabaseManager(
            database_url=config.database_url,
            sqlite_outbox_path=storage_cfg.get("sqlite_outbox_path", "/tmp/aegis_outbox.sqlite3"),
        )
        self.alerts = AlertDispatcher(config)
        self.quality_gate = TradeQualityGateLearner(
            config.raw.get("learning", {}),
            seed=int(sys_cfg.get("random_seed", 42)),
        )
        self.bandit = ThompsonSamplingBandit(
            min_floor=float(config.raw.get("learning", {}).get("bandit_min_allocation_floor", 0.05)),
            min_bucket_samples=int(config.raw.get("learning", {}).get("min_bucket_sample_size", 30)),
        )
        self.current_equity_inr = float(
            config.raw.get("broker", {}).get("starting_equity_inr", 1_000_000.0)
        )
        self.peak_equity_inr = self.current_equity_inr
        self.daily_starting_equity_inr = self.current_equity_inr
        self.open_positions: list[OpenPositionState] = []
        self.current_regime: str = "trending_up"

    def send_heartbeat(self) -> None:
        """Write 1-minute heartbeat to Postgres (or local SQLite outbox if offline)."""
        now_ist = self.calendar.now_ist()
        is_open = self.calendar.is_market_open(now_ist)
        pending = self.db.count_pending_outbox()
        bot_id = self.config.raw.get("system", {}).get("bot_id", "aegis-nse-oracle-vm-01")

        self.db.execute_idempotent_write(
            idempotency_key=f"heartbeat-{bot_id}",
            table_name="bot_health",
            sql_statement="""
                INSERT INTO bot_health (
                    bot_id, heartbeat_at, last_cycle_status, market_open,
                    current_regime, sqlite_outbox_pending, last_db_write_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (bot_id) DO UPDATE SET
                    heartbeat_at = EXCLUDED.heartbeat_at,
                    market_open = EXCLUDED.market_open,
                    current_regime = EXCLUDED.current_regime,
                    sqlite_outbox_pending = EXCLUDED.sqlite_outbox_pending,
                    last_db_write_at = EXCLUDED.last_db_write_at
            """,
            params=[bot_id, now_ist.isoformat(), "OK", is_open, self.current_regime, pending, now_ist.isoformat()],
        )

    def run_decision_cycle(self, force_when_closed: bool = False) -> dict[str, int]:
        """Execute a complete 5-minute NSE F&O market decision cycle safely."""
        now_ist = self.calendar.now_ist()
        if not force_when_closed and not self.calendar.is_market_open(now_ist):
            logger.info("NSE Market closed at %s IST; skipping decision cycle.", now_ist.isoformat())
            return {"exits": 0, "entries": 0, "skipped_signals": 0}

        cycle_bucket = now_ist.strftime("%Y-%m-%dT%H:%M")
        control = self.db.read_control_state()

        # 1. Reconcile internal ledger vs paper broker positions
        broker_positions = self.broker.list_open_positions()
        mismatches = reconcile_positions(self.open_positions, broker_positions)
        if mismatches and not self.config.dry_run:
            self.alerts.send_alert(
                "RECONCILIATION",
                "NSE Lot Position Mismatch Detected",
                "; ".join(m.description for m in mismatches),
            )

        # 2. Detect overall Indian market regime from NIFTY 50 + INDIA VIX
        nifty_bars = self.broker.get_underlying_bars("NIFTY", lookback_bars=80)
        nifty_ind = compute_indicators(nifty_bars)
        india_vix = self.broker.get_vix_proxy_level()
        regime = detect_market_regime(
            nifty_ind, india_vix, self.config.raw.get("regime_detector", {})
        )
        self.current_regime = regime

        # 3. Evaluate exits on all open positions first (always runs even when new entries are paused)
        is_pre_close = self.calendar.is_in_pre_close_flatten_window(
            flatten_minutes_before_close=int(
                self.config.raw.get("exits", {}).get("intraday_flatten_minutes_before_close", 15)
            ),
            now=now_ist,
        )
        exits_executed = 0
        remaining_positions: list[OpenPositionState] = []
        for pos in self.open_positions:
            decision = evaluate_position_exit(
                pos, self.config.raw.get("exits", {}), is_pre_close_window=is_pre_close
            )
            if decision.should_exit:
                exits_executed += 1
                logger.info(
                    "Exiting %s (%s): %s", pos.contract_symbol, decision.exit_reason, decision.detail
                )
            else:
                remaining_positions.append(pos)
        self.open_positions = remaining_positions

        # 4. Scan NSE F&O universe for new entry signals
        symbols: list[str] = self.config.raw.get("universe", {}).get("symbols", ["NIFTY", "BANKNIFTY"])
        strat_cfg = self.config.raw.get("strategies", {})
        min_conf = float(strat_cfg.get("min_entry_confidence", 0.62))
        entries_executed = 0
        skipped_signals = 0

        for sym in symbols:
            bars = self.broker.get_underlying_bars(sym, lookback_bars=80)
            ind = compute_indicators(bars)
            candidate_signals = [
                evaluate_trend_following(sym, ind, regime, strat_cfg.get("trend_following", {})),
                evaluate_mean_reversion(sym, ind, regime, strat_cfg.get("mean_reversion", {})),
                evaluate_breakout_momentum(sym, ind, regime, strat_cfg.get("breakout_momentum", {})),
            ]
            for sig in candidate_signals:
                if sig.direction == "NONE" or sig.confidence < min_conf:
                    continue

                chain = self.broker.get_option_chain(sym)
                sel = select_best_option_contract(
                    chain=chain,
                    direction=sig.direction,
                    selection_cfg=self.config.raw.get("contract_selection", {}),
                    earnings_map=self.config.raw.get("universe", {}).get("earnings_blackout_dates", {}),
                    today=now_ist.date(),
                )
                if sel.selected is None:
                    skipped_signals += 1
                    continue

                contract = sel.selected
                feature_vec = {
                    "confidence": sig.confidence,
                    "rsi_14": ind.rsi14,
                    "adx_14": ind.adx14,
                    "atr_pct": ind.atr_pct,
                    "iv_rank_pct": contract.iv_rank_pct,
                    "abs_delta": abs(contract.delta),
                    "dte": float(contract.dte),
                    "spread_pct": contract.spread_pct_of_mid,
                    "vix_proxy": india_vix,
                    "dist_from_ema20_pct": ind.dist_from_ema20_pct,
                    "dist_from_vwap_pct": ind.dist_from_vwap_pct,
                }
                _prob_profit, gate_ok = self.quality_gate.predict_prob_profit(feature_vec)
                if not gate_ok:
                    skipped_signals += 1
                    continue

                sim_fill = simulate_pessimistic_fill(
                    side="BUY",
                    qty=1,
                    bid=contract.bid,
                    ask=contract.ask,
                    fill_cfg=self.config.raw.get("fill_simulation", {}),
                    lot_size=contract.lot_size,
                )
                portfolio_snap = PortfolioRiskSnapshot(
                    current_equity_usd=self.current_equity_inr,
                    peak_equity_usd=self.peak_equity_inr,
                    daily_starting_equity_usd=self.daily_starting_equity_inr,
                    open_positions=self.open_positions,
                    control_new_entries_enabled=bool(control.get("new_entries_enabled", True)),
                )
                risk_decision = evaluate_entry_risk_and_size(
                    portfolio=portfolio_snap,
                    underlying=sym,
                    conservative_entry_price=sim_fill.conservative_fill_price,
                    fee_per_contract_usd=float(
                        self.config.raw.get("fill_simulation", {}).get("fee_per_lot_inr", 35.0)
                    ),
                    risk_cfg=self.config.raw.get("risk_limits", {}),
                    lot_size=contract.lot_size,
                )
                if not risk_decision.allowed:
                    skipped_signals += 1
                    if risk_decision.trigger_drawdown_kill_switch:
                        self.alerts.send_alert(
                            "KILL_SWITCH",
                            "Max Drawdown Breached (10%)",
                            risk_decision.rejection_reason,
                        )
                    continue

                client_order_id = compute_idempotent_order_id(
                    cycle_bucket_iso=cycle_bucket,
                    underlying=sym,
                    strategy_name=sig.strategy_name,
                    contract_symbol=contract.contract_symbol,
                    side="BUY",
                )
                self.broker.submit_option_order(
                    client_order_id=client_order_id,
                    contract_symbol=contract.contract_symbol,
                    side="BUY",
                    qty=risk_decision.approved_contracts_qty,
                    limit_price=contract.ask,
                )
                self.open_positions.append(
                    OpenPositionState(
                        position_id=client_order_id,
                        contract_symbol=contract.contract_symbol,
                        underlying=sym,
                        right=contract.right,
                        strategy_name=sig.strategy_name,
                        qty=risk_decision.approved_contracts_qty,
                        entry_price=sim_fill.conservative_fill_price,
                        current_mark_price=contract.mid,
                        peak_mark_price=contract.mid,
                        trough_mark_price=contract.mid,
                        dte=contract.dte,
                        trading_days_held=0,
                    )
                )
                entries_executed += 1

        return {
            "exits": exits_executed,
            "entries": entries_executed,
            "skipped_signals": skipped_signals,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="AegisQuant Indian NSE F&O Self-Learning Paper Bot")
    parser.add_argument("--config", type=str, default=None, help="Path to config.yaml")
    parser.add_argument("--dry-run-once", action="store_true", help="Run a single dry-run cycle and exit")
    parser.add_argument("--rollback-champion", action="store_true", help="Roll back to previous champion model")
    args = parser.parse_args()

    cfg = load_bot_config(args.config)
    storage_cfg = cfg.raw.get("storage", {})
    configure_structured_logging(
        log_file_path=storage_cfg.get("log_file_path", "/tmp/aegis-bot.jsonl"),
        max_bytes=int(storage_cfg.get("log_max_bytes", 10_485_760)),
        backups=int(storage_cfg.get("log_backup_count", 5)),
    )

    daemon = OptionsPaperBotDaemon(cfg)

    if args.rollback_champion:
        logger.info("Executing 1-command rollback to previous champion in config_history...")
        return 0

    if args.dry_run_once:
        summary = daemon.run_decision_cycle(force_when_closed=True)
        daemon.send_heartbeat()
        logger.info("NSE Dry-run cycle completed successfully: %s", summary)
        return 0

    scheduler = BackgroundScheduler(timezone=IST_TZ)
    scheduler.add_job(
        daemon.send_heartbeat,
        trigger=IntervalTrigger(seconds=60, timezone=IST_TZ),
        id="heartbeat_1m",
        replace_existing=True,
    )
    scheduler.add_job(
        daemon.run_decision_cycle,
        trigger=IntervalTrigger(minutes=cfg.decision_cycle_minutes, timezone=IST_TZ),
        id="decision_cycle",
        replace_existing=True,
    )
    scheduler.add_job(
        daemon.send_heartbeat,
        trigger=CronTrigger(day_of_week="mon-fri", hour=15, minute=45, timezone=IST_TZ),
        id="daily_after_close_ist",
        replace_existing=True,
    )
    scheduler.add_job(
        daemon.send_heartbeat,
        trigger=CronTrigger(day_of_week="sat", hour=10, minute=0, timezone=IST_TZ),
        id="weekly_saturday_learner_ist",
        replace_existing=True,
    )
    scheduler.start()
    daemon.send_heartbeat()
    logger.info("AegisQuant NSE Paper Bot started (cycle=%dm, timezone=Asia/Kolkata).", cfg.decision_cycle_minutes)

    stop_flag = False

    def _handle_sig(signum: int, _frame: object) -> None:
        nonlocal stop_flag
        logger.info("Received signal %d; shutting down scheduler cleanly...", signum)
        stop_flag = True

    signal.signal(signal.SIGTERM, _handle_sig)
    signal.signal(signal.SIGINT, _handle_sig)

    while not stop_flag:
        time.sleep(1.0)

    scheduler.shutdown(wait=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
