"""Trade Journal, Automatic Post-Mortem Classifier, and Counterfactual Signal Tracker.

Implements Section 6A, 6B, and 6C:
- Full entry/exit feature logging
- Automatic post-mortem label per closed trade:
  1. wrong_direction
  2. theta_or_iv_crush (right direction in underlying, but option lost money)
  3. stopped_out_then_reversed (stop too tight; contract rebounded strongly after stop-out)
  4. winner_given_back (target/trail too loose; MFE >= +25% turned into small gain or loss)
  5. bad_fill_wide_spread (spread slippage/fees consumed the edge)
  6. wrong_regime (volatility/trend regime flipped against strategy assumptions)
  7. optimal_exit (clean winner captured near MFE)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

PostMortemLabel = Literal[
    "wrong_direction",
    "theta_or_iv_crush",
    "stopped_out_then_reversed",
    "winner_given_back",
    "bad_fill_wide_spread",
    "wrong_regime",
    "optimal_exit",
]


@dataclass(frozen=True)
class EntryFeatureRecord:
    trade_id: str
    strategy_name: str
    underlying: str
    direction: Literal["CALL", "PUT"]
    regime: str
    confidence: float
    rsi_14: float
    adx_14: float
    atr_pct: float
    iv_rank_pct: float
    abs_delta: float
    dte: int
    spread_pct: float
    time_of_day_bucket: str
    weekday: int
    vix_proxy: float
    dist_from_ema20_pct: float
    dist_from_vwap_pct: float


@dataclass(frozen=True)
class ClosedTradeOutcome:
    trade_id: str
    direction: Literal["CALL", "PUT"]
    exit_reason: str
    conservative_pnl_usd: float
    conservative_pnl_pct: float
    alpaca_pnl_usd: float
    hold_minutes: int
    mae_pct: float
    mfe_pct: float
    spread_pct_at_entry: float
    underlying_return_pct: float
    iv_change_pct: float
    post_exit_60m_option_return_pct: float
    regime_at_entry: str
    regime_at_exit: str


@dataclass(frozen=True)
class PostMortemResult:
    trade_id: str
    primary_label: PostMortemLabel
    underlying_return_pct: float
    iv_change_pct: float
    post_exit_60m_option_return_pct: float
    peak_mfe_giveback_pct: float
    diagnosis_notes: str


def classify_time_of_day_bucket(ts_et: datetime) -> str:
    """Classify Eastern Time timestamp into session bucket."""
    minutes_from_open = (ts_et.hour * 60 + ts_et.minute) - (9 * 60 + 30)
    if minutes_from_open < 60:
        return "OPEN_0930_1030"
    if minutes_from_open < 240:
        return "MIDDAY_1030_1330"
    return "AFTERNOON_1330_1600"


def classify_post_mortem(outcome: ClosedTradeOutcome) -> PostMortemResult:
    """Deterministically assign a post-mortem label and explanation to a closed trade."""
    pnl_pct = outcome.conservative_pnl_pct
    mfe_pct = outcome.mfe_pct
    giveback = round(max(0.0, mfe_pct - pnl_pct), 4)

    # Check if underlying moved in the predicted direction
    signed_underlying_move = (
        outcome.underlying_return_pct
        if outcome.direction == "CALL"
        else -outcome.underlying_return_pct
    )

    # 1. Stopped out then reversed (stop too tight)
    if (
        outcome.exit_reason == "STOP_LOSS"
        and outcome.post_exit_60m_option_return_pct >= 0.25
    ):
        return PostMortemResult(
            trade_id=outcome.trade_id,
            primary_label="stopped_out_then_reversed",
            underlying_return_pct=outcome.underlying_return_pct,
            iv_change_pct=outcome.iv_change_pct,
            post_exit_60m_option_return_pct=outcome.post_exit_60m_option_return_pct,
            peak_mfe_giveback_pct=giveback,
            diagnosis_notes=(
                f"Stopped out at {pnl_pct * 100:.1f}%, but contract rebounded "
                f"+{outcome.post_exit_60m_option_return_pct * 100:.1f}% within 60m. Stop loss was too tight for current ATR."
            ),
        )

    # 2. Winner given back (target/trail too loose)
    if mfe_pct >= 0.25 and pnl_pct <= 0.05:
        return PostMortemResult(
            trade_id=outcome.trade_id,
            primary_label="winner_given_back",
            underlying_return_pct=outcome.underlying_return_pct,
            iv_change_pct=outcome.iv_change_pct,
            post_exit_60m_option_return_pct=outcome.post_exit_60m_option_return_pct,
            peak_mfe_giveback_pct=giveback,
            diagnosis_notes=(
                f"Reached +{mfe_pct * 100:.1f}% MFE but closed at {pnl_pct * 100:.1f}% "
                f"(gave back {giveback * 100:.1f}%). Consider tighter trail activation."
            ),
        )

    # 3. Right direction in underlying, but lost to theta decay or IV crush
    if pnl_pct < 0 and signed_underlying_move > 0.002 and (outcome.iv_change_pct < -0.04 or outcome.hold_minutes > 1200):
        return PostMortemResult(
            trade_id=outcome.trade_id,
            primary_label="theta_or_iv_crush",
            underlying_return_pct=outcome.underlying_return_pct,
            iv_change_pct=outcome.iv_change_pct,
            post_exit_60m_option_return_pct=outcome.post_exit_60m_option_return_pct,
            peak_mfe_giveback_pct=giveback,
            diagnosis_notes=(
                f"Underlying moved favorably (+{signed_underlying_move * 100:.2f}%), "
                f"but option lost {pnl_pct * 100:.1f}% due to IV change ({outcome.iv_change_pct * 100:.1f}%) and theta decay."
            ),
        )

    # 4. Bad fill / wide spread drag (Alpaca paper was profitable, conservative sim lost money)
    if outcome.alpaca_pnl_usd > 0 and outcome.conservative_pnl_usd <= 0 and outcome.spread_pct_at_entry >= 0.055:
        return PostMortemResult(
            trade_id=outcome.trade_id,
            primary_label="bad_fill_wide_spread",
            underlying_return_pct=outcome.underlying_return_pct,
            iv_change_pct=outcome.iv_change_pct,
            post_exit_60m_option_return_pct=outcome.post_exit_60m_option_return_pct,
            peak_mfe_giveback_pct=giveback,
            diagnosis_notes=(
                f"Alpaca mid fill showed +${outcome.alpaca_pnl_usd:.2f}, but entry spread "
                f"({outcome.spread_pct_at_entry * 100:.1f}%) + fees turned conservative P&L negative (${outcome.conservative_pnl_usd:.2f})."
            ),
        )

    # 5. Wrong regime (regime flipped during hold and trade lost)
    if pnl_pct < 0 and outcome.regime_at_entry != outcome.regime_at_exit:
        return PostMortemResult(
            trade_id=outcome.trade_id,
            primary_label="wrong_regime",
            underlying_return_pct=outcome.underlying_return_pct,
            iv_change_pct=outcome.iv_change_pct,
            post_exit_60m_option_return_pct=outcome.post_exit_60m_option_return_pct,
            peak_mfe_giveback_pct=giveback,
            diagnosis_notes=(
                f"Regime shifted from '{outcome.regime_at_entry}' to '{outcome.regime_at_exit}' during hold."
            ),
        )

    # 6. Wrong direction
    if pnl_pct <= 0:
        return PostMortemResult(
            trade_id=outcome.trade_id,
            primary_label="wrong_direction",
            underlying_return_pct=outcome.underlying_return_pct,
            iv_change_pct=outcome.iv_change_pct,
            post_exit_60m_option_return_pct=outcome.post_exit_60m_option_return_pct,
            peak_mfe_giveback_pct=giveback,
            diagnosis_notes=(
                f"Underlying moved {signed_underlying_move * 100:.2f}% against {outcome.direction} thesis."
            ),
        )

    # 7. Clean winning trade
    return PostMortemResult(
        trade_id=outcome.trade_id,
        primary_label="optimal_exit",
        underlying_return_pct=outcome.underlying_return_pct,
        iv_change_pct=outcome.iv_change_pct,
        post_exit_60m_option_return_pct=outcome.post_exit_60m_option_return_pct,
        peak_mfe_giveback_pct=giveback,
        diagnosis_notes=(
            f"Captured +{pnl_pct * 100:.1f}% conservative gain (MFE +{mfe_pct * 100:.1f}%) via {outcome.exit_reason}."
        ),
    )
