"""Comprehensive unit test suite for the Python Indian NSE F&O options paper-trading bot (/bot/tests/test_bot_core.py)."""

from __future__ import annotations

import tempfile
import unittest
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from src.calendar_utils import MarketCalendar
from src.config import LiveTradingForbiddenError, assert_paper_trading_url, load_bot_config
from src.db import ResilientDatabaseManager
from src.exits import OpenPositionState, evaluate_position_exit
from src.fills import compute_roundtrip_pnl, simulate_pessimistic_fill, simulate_vertical_debit_spread_fill
from src.interfaces import OptionContractQuote
from src.journal import ClosedTradeOutcome, classify_post_mortem
from src.learning import (
    ThompsonSamplingBandit,
    TradeQualityGateLearner,
    evaluate_champion_vs_challenger,
    propose_bounded_parameter_update,
)
from src.risk import (
    PortfolioRiskSnapshot,
    compute_idempotent_order_id,
    evaluate_entry_risk_and_size,
)
from src.strategies import select_best_option_contract


class TestBotCore(unittest.TestCase):
    def test_1_hard_paper_url_guard_rejects_live(self) -> None:
        self.assertEqual(
            assert_paper_trading_url("https://paper-sandbox.nseindia-sim.local"),
            "https://paper-sandbox.nseindia-sim.local",
        )
        self.assertEqual(
            assert_paper_trading_url("https://paper-api.alpaca.markets"),
            "https://paper-api.alpaca.markets",
        )
        with self.assertRaises(LiveTradingForbiddenError):
            assert_paper_trading_url("https://api.kite.trade")
        with self.assertRaises(LiveTradingForbiddenError):
            assert_paper_trading_url("https://api.upstox.com/v2")
        with self.assertRaises(LiveTradingForbiddenError):
            assert_paper_trading_url("https://live-api.alpaca.markets")

        cfg = load_bot_config()
        self.assertEqual(cfg.paper_endpoint_url, "https://paper-sandbox.nseindia-sim.local")

    def test_2_ist_market_calendar_hours_and_preclose_flatten(self) -> None:
        cal = MarketCalendar(exchange="XBOM", timezone_name="Asia/Kolkata")
        ist = ZoneInfo("Asia/Kolkata")
        # Monday 10:30 IST -> Market Open
        mon_open = datetime(2026, 11, 2, 10, 30, tzinfo=ist)
        self.assertTrue(cal.is_market_open(mon_open))
        self.assertFalse(cal.is_in_pre_close_flatten_window(15, mon_open))

        # Monday 15:20 IST -> Inside 15:15-15:30 IST pre-close flatten window
        mon_preclose = datetime(2026, 11, 2, 15, 20, tzinfo=ist)
        self.assertTrue(cal.is_market_open(mon_preclose))
        self.assertTrue(cal.is_in_pre_close_flatten_window(15, mon_preclose))

        # Monday 16:00 IST -> Market Closed
        mon_after = datetime(2026, 11, 2, 16, 0, tzinfo=ist)
        self.assertFalse(cal.is_market_open(mon_after))

    def test_3_pessimistic_fill_simulator_nse_lots(self) -> None:
        # NIFTY lot_size = 75, qty = 2 lots (150 units), Bid ₹200.00, Ask ₹208.00 -> Mid ₹204.00, Spread ₹8.00
        # Buy: 204 + 0.35 * 8 = ₹206.80 per unit -> 206.80 * 150 + ₹70 (₹35 * 2 lots) = ₹31,090.00
        buy_fill = simulate_pessimistic_fill("BUY", qty=2, bid=200.0, ask=208.0, lot_size=75)
        self.assertAlmostEqual(buy_fill.conservative_fill_price, 206.80, places=2)
        self.assertAlmostEqual(buy_fill.fee_usd, 70.0, places=2)
        self.assertAlmostEqual(
            buy_fill.total_conservative_cash_flow_usd, -(206.80 * 150 + 70.0), places=2
        )

        with self.assertRaises(ValueError):
            simulate_pessimistic_fill("BUY", qty=1, bid=0.0, ask=5.0, lot_size=75)

        sell_fill = simulate_pessimistic_fill("SELL", qty=2, bid=245.0, ask=253.0, lot_size=75)
        rt = compute_roundtrip_pnl(2, buy_fill, sell_fill)
        self.assertLess(rt["conservative_pnl_usd"], rt["alpaca_pnl_usd"])

    def test_4_contract_selector_filters_and_results_blackout(self) -> None:
        now = datetime(2026, 10, 26, 5, 30, tzinfo=timezone.utc)
        good_contract = OptionContractQuote(
            contract_symbol="NIFTY26NOV24500CE",
            underlying="NIFTY",
            expiration_date=date(2026, 11, 26),
            strike=24500.0,
            right="CALL",
            lot_size=75,
            bid=218.0,
            ask=224.0,
            mid=221.0,
            spread_pct_of_mid=0.0271,
            delta=0.46,
            gamma=0.002,
            theta=-8.5,
            vega=14.2,
            implied_volatility=0.145,
            iv_rank_pct=36.0,
            open_interest=24000,
            volume=8500,
            quote_timestamp=now,
        )
        cfg = {
            "min_dte": 7,
            "max_dte": 45,
            "hard_floor_dte": 4,
            "target_dte": 18,
            "min_abs_delta": 0.35,
            "max_abs_delta": 0.55,
            "target_abs_delta": 0.45,
            "max_spread_pct_of_mid": 0.08,
            "min_open_interest": 500,
            "min_daily_volume": 100,
            "max_iv_rank_pct": 85.0,
            "min_iv_rank_pct": 10.0,
            "estimated_holding_window_days": 5,
        }
        res = select_best_option_contract([good_contract], "CALL", cfg, today=now.date())
        self.assertIsNotNone(res.selected)
        self.assertEqual(res.selected.contract_symbol, "NIFTY26NOV24500CE")

        # Corporate results blackout filter
        res_blackout = select_best_option_contract(
            [good_contract],
            "CALL",
            cfg,
            earnings_dates={"NIFTY": date(2026, 10, 28)},
            today=now.date(),
        )
        self.assertIsNone(res_blackout.selected)

    def test_5_exit_priority_hierarchy(self) -> None:
        cfg = {
            "force_close_dte": 1,
            "stop_loss_pct": -0.30,
            "take_profit_pct": 0.50,
            "trail_activation_profit_pct": 0.30,
            "trail_distance_pct": 0.15,
            "max_hold_trading_days": 5,
            "time_stop_dte": 3,
            "enable_signal_reversal_exit": True,
        }
        pos = OpenPositionState(
            position_id="p1",
            contract_symbol="BANKNIFTY26NOV52000CE",
            underlying="BANKNIFTY",
            right="CALL",
            strategy_name="trend_following",
            qty=2,
            entry_price=400.0,
            current_mark_price=470.0,
            peak_mark_price=560.0,
            trough_mark_price=390.0,
            dte=14,
            trading_days_held=2,
        )
        dec = evaluate_position_exit(pos, cfg)
        self.assertTrue(dec.should_exit)
        self.assertEqual(dec.exit_reason, "TRAILING_STOP")

    def test_6_nse_lot_risk_sizing_and_kill_switches(self) -> None:
        risk_cfg = {
            "max_risk_per_trade_pct": 0.015,
            "max_total_open_premium_pct": 0.25,
            "max_open_positions": 5,
            "max_positions_per_underlying": 2,
            "daily_loss_limit_pct": 0.03,
            "max_drawdown_kill_switch_pct": 0.10,
            "consecutive_losses_cooldown_trigger": 5,
            "fee_per_lot_inr": 35.0,
        }
        snap = PortfolioRiskSnapshot(
            current_equity_usd=1000000.0,
            peak_equity_usd=1000000.0,
            daily_starting_equity_usd=1000000.0,
            open_positions=[],
            control_new_entries_enabled=True,
        )
        # NIFTY 1 lot @ ₹150 * 75 = ₹11,250 + ₹35 = ₹11,285 <= ₹15,000 cap -> 1 lot
        dec = evaluate_entry_risk_and_size(snap, "NIFTY", 150.0, 35.0, risk_cfg, lot_size=75)
        self.assertTrue(dec.allowed)
        self.assertEqual(dec.approved_contracts_qty, 1)

        # Idempotent client order ID is deterministic
        cid1 = compute_idempotent_order_id("2026-11-02T10:00", "NIFTY", "trend_following", "NIFTY26NOV24500CE", "BUY")
        cid2 = compute_idempotent_order_id("2026-11-02T10:00", "NIFTY", "trend_following", "NIFTY26NOV24500CE", "BUY")
        self.assertEqual(cid1, cid2)

    def test_7_post_mortem_classifier_and_learning_guards(self) -> None:
        outcome = ClosedTradeOutcome(
            trade_id="NSE-101",
            direction="CALL",
            exit_reason="STOP_LOSS",
            conservative_pnl_usd=-3445.0,
            conservative_pnl_pct=-0.30,
            alpaca_pnl_usd=-3150.0,
            hold_minutes=145,
            mae_pct=-0.31,
            mfe_pct=0.06,
            spread_pct_at_entry=0.025,
            underlying_return_pct=-0.0028,
            iv_change_pct=0.01,
            post_exit_60m_option_return_pct=0.34,
            regime_at_entry="trending_up",
            regime_at_exit="trending_up",
        )
        pm = classify_post_mortem(outcome)
        self.assertEqual(pm.primary_label, "stopped_out_then_reversed")

        # Bounded ±10% tuning
        prop = propose_bounded_parameter_update(
            parameter_name="quality_gate.min_win_probability",
            current_value=0.55,
            proposed_raw_value=0.75,
            hard_min=0.45,
            hard_max=0.70,
            trade_pnls_before=[100.0] * 40,
            trade_pnls_after=[450.0] * 40,
            max_weekly_step_pct=0.10,
            min_trades=30,
        )
        self.assertAlmostEqual(prop.new_value, 0.55 * 1.10, places=4)

        # Thompson Bandit 30-trade minimum & 5% floor
        bandit = ThompsonSamplingBandit(min_trades_per_bucket=30, min_allocation_floor_pct=0.05)
        weights = bandit.compute_allocations(
            {
                "trend_following|trending_up|NIFTY": (22, 10),
                "breakout_momentum|high_volatility|RELIANCE": (2, 32),
            }
        )
        for b in weights.values():
            self.assertGreaterEqual(b.allocation_weight, 0.05)

        # Champion vs Challenger promotion guard
        promo = evaluate_champion_vs_challenger(
            champion_pnls=[485.0] * 55,
            challenger_shadow_pnls=[640.0] * 55,
            champion_max_dd=0.048,
            challenger_max_dd=0.041,
            min_shadow_trades=50,
        )
        self.assertTrue(promo["promote"])

    def test_8_sqlite_outbox_idempotency(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db = ResilientDatabaseManager(database_url="", sqlite_outbox_path=f"{tmp}/outbox.sqlite3")
            db.execute_idempotent_write("key-1", "trades", "INSERT INTO trades VALUES (%s)", ["t1"])
            db.execute_idempotent_write("key-1", "trades", "INSERT INTO trades VALUES (%s)", ["t1-updated"])
            self.assertEqual(db.count_pending_outbox(), 1)

    def test_9_vertical_debit_spread_and_gbdt_200_trade_milestone(self) -> None:
        # NIFTY Bull Call Spread: Buy 0.50Δ CE (Bid 210, Ask 216) + Sell 0.25Δ OTM CE (Bid 84, Ask 88)
        spread_fill = simulate_vertical_debit_spread_fill(
            "BULL_CALL_SPREAD",
            qty=1,
            long_bid=210.0,
            long_ask=216.0,
            short_bid=84.0,
            short_ask=88.0,
            lot_size=75,
        )
        self.assertEqual(spread_fill.total_fee_inr, 70.0)
        self.assertGreater(spread_fill.max_risk_reduction_pct, 0.35)
        self.assertEqual(spread_fill.theta_decay_reduction_pct, 0.65)

        learner = TradeQualityGateLearner({"gradient_boosting_min_trades": 200, "quality_gate_min_prob_profit": 0.68})
        self.assertEqual(learner.min_trades_for_gbdt, 200)
        prob_single, _ = learner.predict_prob_profit(
            {"confidence": 0.72, "adx_14": 25.0, "iv_rank_pct": 58.0, "spread_pct": 0.028, "is_vertical_spread": 0.0}
        )
        prob_spread, passed_spread = learner.predict_prob_profit(
            {"confidence": 0.72, "adx_14": 25.0, "iv_rank_pct": 58.0, "spread_pct": 0.028, "is_vertical_spread": 1.0}
        )
        self.assertGreater(prob_spread, prob_single)
        self.assertTrue(passed_spread)


if __name__ == "__main__":
    unittest.main()

