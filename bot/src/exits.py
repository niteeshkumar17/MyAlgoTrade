"""Exit Engine evaluating all open option positions in strict priority order.

Priority hierarchy (highest first):
1. Force-close anything with DTE <= 1
2. Flatten intraday-flagged positions 15 min before market close
3. Hard stop loss (-30% of entry premium)
4. Take profit (+50% of entry premium)
5. Trailing stop (-15% from peak mark once MFE >= +30%)
6. Time stop (held > 7 trading days or DTE <= 5)
7. Signal-reversal exit
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

ExitReasonCode = Literal[
    "FORCE_CLOSE_DTE_1",
    "INTRADAY_PRE_CLOSE_FLATTEN",
    "STOP_LOSS",
    "TAKE_PROFIT",
    "TRAILING_STOP",
    "TIME_STOP_DAYS",
    "TIME_STOP_DTE",
    "SIGNAL_REVERSAL",
    "HOLD",
]


@dataclass(frozen=True)
class OpenPositionState:
    position_id: str
    contract_symbol: str
    underlying: str
    right: Literal["CALL", "PUT"]
    strategy_name: str
    qty: int
    entry_price: float          # Conservative entry price per share
    current_mark_price: float   # Conservative exit mark (mid - 0.35*spread)
    peak_mark_price: float      # Highest mark observed since entry (for MFE & trailing stop)
    trough_mark_price: float    # Lowest mark observed since entry (for MAE)
    dte: int
    trading_days_held: int
    is_intraday_flagged: bool = False


@dataclass(frozen=True)
class ExitDecision:
    should_exit: bool
    exit_reason: ExitReasonCode
    detail: str
    unrealized_pnl_pct: float
    mfe_pct: float
    mae_pct: float


def evaluate_position_exit(
    pos: OpenPositionState,
    exit_cfg: dict[str, Any],
    is_pre_close_window: bool = False,
    latest_signal_direction: Literal["CALL", "PUT", "NONE"] = "NONE",
) -> ExitDecision:
    """Evaluate an open position against the 7 prioritized exit rules."""
    entry_px = max(pos.entry_price, 0.01)
    peak_px = max(pos.peak_mark_price, pos.current_mark_price, entry_px)
    trough_px = min(pos.trough_mark_price, pos.current_mark_price, entry_px)

    pnl_pct = round((pos.current_mark_price - entry_px) / entry_px, 4)
    mfe_pct = round((peak_px - entry_px) / entry_px, 4)
    mae_pct = round((trough_px - entry_px) / entry_px, 4)

    force_dte = int(exit_cfg.get("force_close_dte", 1))
    stop_loss_pct = float(exit_cfg.get("stop_loss_pct", -0.30))
    take_profit_pct = float(exit_cfg.get("take_profit_pct", 0.50))
    trail_activate_pct = float(exit_cfg.get("trail_activation_profit_pct", 0.30))
    trail_dist_pct = float(exit_cfg.get("trail_distance_pct", 0.15))
    max_hold_days = int(exit_cfg.get("max_hold_trading_days", 7))
    time_stop_dte = int(exit_cfg.get("time_stop_dte", 5))
    reversal_enabled = bool(exit_cfg.get("enable_signal_reversal_exit", True))

    # 1. Force close DTE <= 1
    if pos.dte <= force_dte:
        return ExitDecision(
            should_exit=True,
            exit_reason="FORCE_CLOSE_DTE_1",
            detail=f"Force-closing expiring contract (DTE={pos.dte} <= {force_dte})",
            unrealized_pnl_pct=pnl_pct,
            mfe_pct=mfe_pct,
            mae_pct=mae_pct,
        )

    # 2. Flatten intraday-flagged positions 15 min before market close
    if pos.is_intraday_flagged and is_pre_close_window:
        return ExitDecision(
            should_exit=True,
            exit_reason="INTRADAY_PRE_CLOSE_FLATTEN",
            detail="Flattening intraday-flagged position 15m before market close",
            unrealized_pnl_pct=pnl_pct,
            mfe_pct=mfe_pct,
            mae_pct=mae_pct,
        )

    # 3. Stop loss (-30% of premium)
    if pnl_pct <= stop_loss_pct:
        return ExitDecision(
            should_exit=True,
            exit_reason="STOP_LOSS",
            detail=f"Hard stop loss triggered ({pnl_pct * 100:.1f}% <= {stop_loss_pct * 100:.1f}%)",
            unrealized_pnl_pct=pnl_pct,
            mfe_pct=mfe_pct,
            mae_pct=mae_pct,
        )

    # 4. Take profit (+50% of premium)
    if pnl_pct >= take_profit_pct:
        return ExitDecision(
            should_exit=True,
            exit_reason="TAKE_PROFIT",
            detail=f"Take profit target reached (+{pnl_pct * 100:.1f}% >= +{take_profit_pct * 100:.1f}%)",
            unrealized_pnl_pct=pnl_pct,
            mfe_pct=mfe_pct,
            mae_pct=mae_pct,
        )

    # 5. Trailing stop of 15% once +30% MFE achieved
    if mfe_pct >= trail_activate_pct:
        drawdown_from_peak = (peak_px - pos.current_mark_price) / max(peak_px, 1e-9)
        if drawdown_from_peak >= trail_dist_pct:
            return ExitDecision(
                should_exit=True,
                exit_reason="TRAILING_STOP",
                detail=(
                    f"Trailing stop hit: peak gain was +{mfe_pct * 100:.1f}%, "
                    f"pulled back {drawdown_from_peak * 100:.1f}% >= {trail_dist_pct * 100:.1f}%"
                ),
                unrealized_pnl_pct=pnl_pct,
                mfe_pct=mfe_pct,
                mae_pct=mae_pct,
            )

    # 6a. Time stop: held > 7 trading days
    if pos.trading_days_held > max_hold_days:
        return ExitDecision(
            should_exit=True,
            exit_reason="TIME_STOP_DAYS",
            detail=f"Held {pos.trading_days_held} trading days > max {max_hold_days}",
            unrealized_pnl_pct=pnl_pct,
            mfe_pct=mfe_pct,
            mae_pct=mae_pct,
        )

    # 6b. Time stop: DTE <= 5
    if pos.dte <= time_stop_dte:
        return ExitDecision(
            should_exit=True,
            exit_reason="TIME_STOP_DTE",
            detail=f"DTE {pos.dte} <= time-stop threshold {time_stop_dte} (theta acceleration)",
            unrealized_pnl_pct=pnl_pct,
            mfe_pct=mfe_pct,
            mae_pct=mae_pct,
        )

    # 7. Signal-reversal exit
    if reversal_enabled and latest_signal_direction in ("CALL", "PUT"):
        if latest_signal_direction != pos.right:
            return ExitDecision(
                should_exit=True,
                exit_reason="SIGNAL_REVERSAL",
                detail=f"Strategy signal reversed to {latest_signal_direction} while holding {pos.right}",
                unrealized_pnl_pct=pnl_pct,
                mfe_pct=mfe_pct,
                mae_pct=mae_pct,
            )

    return ExitDecision(
        should_exit=False,
        exit_reason="HOLD",
        detail="All exit thresholds intact",
        unrealized_pnl_pct=pnl_pct,
        mfe_pct=mfe_pct,
        mae_pct=mae_pct,
    )
