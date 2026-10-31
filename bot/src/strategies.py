"""Strategy Engine and Contract Selector.

Implements the 3 required strategy modules:
1. Trend-following: EMA20/50 alignment, price vs VWAP, ADX filter.
2. Mean-reversion: RSI(14) extremes + Bollinger re-entry, only in low-trend ('range') regimes.
3. Breakout/momentum: N-bar high/low break, volume > 1.5x average, ATR expansion.

And the strict Contract Selector enforcing all config.yaml guardrails.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Literal

from .interfaces import OptionContractQuote
from .regime import IndicatorSnapshot, MarketRegime

SignalDirection = Literal["CALL", "PUT", "NONE"]


@dataclass(frozen=True)
class StrategySignal:
    strategy_name: Literal["trend_following", "mean_reversion", "breakout_momentum"]
    underlying: str
    direction: SignalDirection
    confidence: float
    reason: str
    regime: MarketRegime
    indicators: IndicatorSnapshot


@dataclass(frozen=True)
class ContractSelectionResult:
    selected: OptionContractQuote | None
    rejection_reasons: list[str]


def evaluate_trend_following(
    underlying: str,
    ind: IndicatorSnapshot,
    regime: MarketRegime,
    cfg: dict[str, Any],
) -> StrategySignal:
    allowed = cfg.get("allowed_regimes", ["trending_up", "trending_down"])
    if regime not in allowed:
        return StrategySignal(
            strategy_name="trend_following",
            underlying=underlying,
            direction="NONE",
            confidence=0.0,
            reason=f"Regime '{regime}' not permitted for trend_following (allowed={allowed})",
            regime=regime,
            indicators=ind,
        )

    min_adx = float(cfg.get("min_adx", 22.0))
    if ind.adx14 < min_adx:
        return StrategySignal(
            strategy_name="trend_following",
            underlying=underlying,
            direction="NONE",
            confidence=0.25,
            reason=f"ADX {ind.adx14:.1f} below trend threshold {min_adx:.1f}",
            regime=regime,
            indicators=ind,
        )

    if ind.ema20 > ind.ema50 and ind.close > ind.vwap and ind.close > ind.ema20:
        adx_boost = min(0.22, (ind.adx14 - min_adx) * 0.012)
        conf = round(min(0.95, 0.68 + adx_boost), 3)
        return StrategySignal(
            strategy_name="trend_following",
            underlying=underlying,
            direction="CALL",
            confidence=conf,
            reason=(
                f"Bullish EMA20({ind.ema20:.2f})>EMA50({ind.ema50:.2f}), "
                f"Close({ind.close:.2f})>VWAP({ind.vwap:.2f}), ADX={ind.adx14:.1f}"
            ),
            regime=regime,
            indicators=ind,
        )

    if ind.ema20 < ind.ema50 and ind.close < ind.vwap and ind.close < ind.ema20:
        adx_boost = min(0.22, (ind.adx14 - min_adx) * 0.012)
        conf = round(min(0.95, 0.68 + adx_boost), 3)
        return StrategySignal(
            strategy_name="trend_following",
            underlying=underlying,
            direction="PUT",
            confidence=conf,
            reason=(
                f"Bearish EMA20({ind.ema20:.2f})<EMA50({ind.ema50:.2f}), "
                f"Close({ind.close:.2f})<VWAP({ind.vwap:.2f}), ADX={ind.adx14:.1f}"
            ),
            regime=regime,
            indicators=ind,
        )

    return StrategySignal(
        strategy_name="trend_following",
        underlying=underlying,
        direction="NONE",
        confidence=0.30,
        reason="EMA20/50 and VWAP alignment incomplete",
        regime=regime,
        indicators=ind,
    )


def evaluate_mean_reversion(
    underlying: str,
    ind: IndicatorSnapshot,
    regime: MarketRegime,
    cfg: dict[str, Any],
) -> StrategySignal:
    allowed = cfg.get("allowed_regimes", ["range"])
    if regime not in allowed:
        return StrategySignal(
            strategy_name="mean_reversion",
            underlying=underlying,
            direction="NONE",
            confidence=0.0,
            reason=f"Regime '{regime}' not permitted for mean_reversion (requires low-trend range)",
            regime=regime,
            indicators=ind,
        )

    max_adx = float(cfg.get("max_adx", 20.0))
    if ind.adx14 > max_adx:
        return StrategySignal(
            strategy_name="mean_reversion",
            underlying=underlying,
            direction="NONE",
            confidence=0.20,
            reason=f"ADX {ind.adx14:.1f} exceeds low-trend ceiling {max_adx:.1f}",
            regime=regime,
            indicators=ind,
        )

    oversold = float(cfg.get("rsi_oversold", 28.0))
    overbought = float(cfg.get("rsi_overbought", 72.0))

    # Bollinger lower band re-entry + oversold RSI
    if ind.rsi14 <= oversold and ind.prev_close < ind.prev_bb_lower and ind.close >= ind.bb_lower:
        conf = round(min(0.92, 0.66 + (oversold - ind.rsi14) * 0.015), 3)
        return StrategySignal(
            strategy_name="mean_reversion",
            underlying=underlying,
            direction="CALL",
            confidence=conf,
            reason=(
                f"Oversold RSI({ind.rsi14:.1f}<={oversold}) + Bollinger lower band re-entry "
                f"({ind.close:.2f}>={ind.bb_lower:.2f})"
            ),
            regime=regime,
            indicators=ind,
        )

    # Bollinger upper band re-entry + overbought RSI
    if ind.rsi14 >= overbought and ind.prev_close > ind.prev_bb_upper and ind.close <= ind.bb_upper:
        conf = round(min(0.92, 0.66 + (ind.rsi14 - overbought) * 0.015), 3)
        return StrategySignal(
            strategy_name="mean_reversion",
            underlying=underlying,
            direction="PUT",
            confidence=conf,
            reason=(
                f"Overbought RSI({ind.rsi14:.1f}>={overbought}) + Bollinger upper band re-entry "
                f"({ind.close:.2f}<={ind.bb_upper:.2f})"
            ),
            regime=regime,
            indicators=ind,
        )

    return StrategySignal(
        strategy_name="mean_reversion",
        underlying=underlying,
        direction="NONE",
        confidence=0.15,
        reason=f"No RSI extreme ({ind.rsi14:.1f}) with Bollinger re-entry",
        regime=regime,
        indicators=ind,
    )


def evaluate_breakout_momentum(
    underlying: str,
    ind: IndicatorSnapshot,
    regime: MarketRegime,
    cfg: dict[str, Any],
) -> StrategySignal:
    allowed = cfg.get("allowed_regimes", ["trending_up", "trending_down", "high_volatility"])
    if regime not in allowed:
        return StrategySignal(
            strategy_name="breakout_momentum",
            underlying=underlying,
            direction="NONE",
            confidence=0.0,
            reason=f"Regime '{regime}' not permitted for breakout_momentum",
            regime=regime,
            indicators=ind,
        )

    min_vol_mult = float(cfg.get("min_volume_multiple", 1.5))
    min_atr_exp = float(cfg.get("min_atr_expansion_ratio", 1.15))

    if ind.volume_multiple < min_vol_mult or ind.atr_expansion_ratio < min_atr_exp:
        return StrategySignal(
            strategy_name="breakout_momentum",
            underlying=underlying,
            direction="NONE",
            confidence=0.25,
            reason=(
                f"Volume mult {ind.volume_multiple:.2f}x (min {min_vol_mult}x) or "
                f"ATR expansion {ind.atr_expansion_ratio:.2f} (min {min_atr_exp}) insufficient"
            ),
            regime=regime,
            indicators=ind,
        )

    if ind.close > ind.n_bar_high:
        conf = round(min(0.94, 0.67 + (ind.volume_multiple - min_vol_mult) * 0.1), 3)
        return StrategySignal(
            strategy_name="breakout_momentum",
            underlying=underlying,
            direction="CALL",
            confidence=conf,
            reason=(
                f"Bullish 20-bar breakout ({ind.close:.2f}>{ind.n_bar_high:.2f}), "
                f"Vol={ind.volume_multiple:.2f}x avg, ATR exp={ind.atr_expansion_ratio:.2f}x"
            ),
            regime=regime,
            indicators=ind,
        )

    if ind.close < ind.n_bar_low:
        conf = round(min(0.94, 0.67 + (ind.volume_multiple - min_vol_mult) * 0.1), 3)
        return StrategySignal(
            strategy_name="breakout_momentum",
            underlying=underlying,
            direction="PUT",
            confidence=conf,
            reason=(
                f"Bearish 20-bar breakdown ({ind.close:.2f}<{ind.n_bar_low:.2f}), "
                f"Vol={ind.volume_multiple:.2f}x avg, ATR exp={ind.atr_expansion_ratio:.2f}x"
            ),
            regime=regime,
            indicators=ind,
        )

    return StrategySignal(
        strategy_name="breakout_momentum",
        underlying=underlying,
        direction="NONE",
        confidence=0.20,
        reason="Price inside N-bar high/low channel",
        regime=regime,
        indicators=ind,
    )


def has_earnings_in_holding_window(
    underlying: str,
    today: date,
    holding_window_days: int,
    earnings_map: dict[str, list[str]],
) -> bool:
    """Return True if an earnings date for `underlying` falls within [today, today + holding_window_days]."""
    dates_str = earnings_map.get(underlying, [])
    window_end = today + timedelta(days=holding_window_days)
    for d_str in dates_str:
        try:
            ed = date.fromisoformat(d_str)
            if today <= ed <= window_end:
                return True
        except ValueError:
            continue
    return False


def select_best_option_contract(
    chain: list[OptionContractQuote],
    direction: Literal["CALL", "PUT"],
    selection_cfg: dict[str, Any],
    earnings_map: dict[str, list[str]] | None = None,
    earnings_dates: dict[str, date] | None = None,
    today: date | None = None,
) -> ContractSelectionResult:
    """Filter option chain according to strict config.yaml rules and select the closest to target DTE & delta."""
    rejections: list[str] = []
    if not chain:
        return ContractSelectionResult(selected=None, rejection_reasons=["Empty option chain"])

    underlying = chain[0].underlying
    ref_today = today or chain[0].quote_timestamp.date()
    hold_days = int(selection_cfg.get("estimated_holding_window_days", 5))

    if earnings_dates and underlying in earnings_dates:
        ed = earnings_dates[underlying]
        if ref_today <= ed <= ref_today + timedelta(days=hold_days):
            return ContractSelectionResult(
                selected=None,
                rejection_reasons=[f"Corporate results fall inside {hold_days}-day holding window for {underlying}"],
            )

    if earnings_map and has_earnings_in_holding_window(underlying, ref_today, hold_days, earnings_map):
        return ContractSelectionResult(
            selected=None,
            rejection_reasons=[f"Earnings event falls inside {hold_days}-day holding window for {underlying}"],
        )

    hard_floor_dte = int(selection_cfg.get("hard_floor_dte", 4))
    min_dte = max(hard_floor_dte, int(selection_cfg.get("min_dte", 7)))
    max_dte = int(selection_cfg.get("max_dte", 45))
    target_dte = int(selection_cfg.get("target_dte", 18))
    min_delta = float(selection_cfg.get("min_abs_delta", 0.35))
    max_delta = float(selection_cfg.get("max_abs_delta", 0.55))
    target_delta = float(selection_cfg.get("target_abs_delta", 0.45))
    max_spread_pct = float(selection_cfg.get("max_spread_pct_of_mid", 0.08))
    min_oi = int(selection_cfg.get("min_open_interest", 500))
    min_vol = int(selection_cfg.get("min_daily_volume", 100))
    max_ivr = float(selection_cfg.get("max_iv_rank_pct", 85.0))
    min_ivr = float(selection_cfg.get("min_iv_rank_pct", 10.0))

    valid: list[OptionContractQuote] = []
    for c in chain:
        if c.right != direction:
            continue
        if c.is_halted:
            rejections.append(f"{c.contract_symbol}: halted")
            continue
        if c.bid <= 0.0:
            rejections.append(f"{c.contract_symbol}: zero bid ({c.bid})")
            continue
        if c.dte < hard_floor_dte or not (min_dte <= c.dte <= max_dte):
            rejections.append(f"{c.contract_symbol}: DTE {c.dte} outside [{min_dte}, {max_dte}]")
            continue
        abs_d = abs(c.delta)
        if not (min_delta <= abs_d <= max_delta):
            rejections.append(f"{c.contract_symbol}: |delta| {abs_d:.2f} outside [{min_delta}, {max_delta}]")
            continue
        if c.spread_pct_of_mid > max_spread_pct:
            rejections.append(
                f"{c.contract_symbol}: spread {c.spread_pct_of_mid * 100:.1f}% > {max_spread_pct * 100:.1f}%"
            )
            continue
        if c.open_interest < min_oi:
            rejections.append(f"{c.contract_symbol}: OI {c.open_interest} < {min_oi}")
            continue
        if c.volume < min_vol:
            rejections.append(f"{c.contract_symbol}: volume {c.volume} < {min_vol}")
            continue
        if not (min_ivr <= c.iv_rank_pct <= max_ivr):
            rejections.append(
                f"{c.contract_symbol}: IV rank {c.iv_rank_pct:.1f}% outside [{min_ivr}, {max_ivr}]"
            )
            continue
        valid.append(c)

    if not valid:
        return ContractSelectionResult(selected=None, rejection_reasons=rejections)

    # Score candidates by proximity to target delta (0.45), target DTE (28), and tightest spread
    valid.sort(
        key=lambda x: (
            abs(abs(x.delta) - target_delta) * 2.5
            + abs(x.dte - target_dte) / 30.0
            + x.spread_pct_of_mid * 3.0
        )
    )
    return ContractSelectionResult(selected=valid[0], rejection_reasons=rejections)
