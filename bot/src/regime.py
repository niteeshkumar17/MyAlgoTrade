"""Market Regime Detector and Technical Indicator Engine.

Classifies market regime into:
- trending_up
- trending_down
- range
- high_volatility
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

try:
    import numpy as np
    import pandas as pd
except ImportError:
    np = None  # type: ignore[assignment]
    pd = None  # type: ignore[assignment]

MarketRegime = Literal["trending_up", "trending_down", "range", "high_volatility"]


@dataclass(frozen=True)
class IndicatorSnapshot:
    close: float
    vwap: float
    ema20: float
    ema50: float
    rsi14: float
    adx14: float
    atr14: float
    atr_pct: float
    atr_expansion_ratio: float
    bb_upper: float
    bb_lower: float
    bb_mid: float
    prev_close: float
    prev_bb_upper: float
    prev_bb_lower: float
    n_bar_high: float
    n_bar_low: float
    volume_multiple: float
    realized_vol_annualized: float
    dist_from_ema20_pct: float
    dist_from_vwap_pct: float


def compute_indicators(df: pd.DataFrame, lookback_bars: int = 20) -> IndicatorSnapshot:
    """Compute technical features required by strategies, regime detector, and trade journal."""
    if len(df) < 30:
        raise ValueError("Require at least 30 bars to compute stable indicators.")

    close = df["close"].astype(float)
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    volume = df["volume"].astype(float)
    vwap = df["vwap"].astype(float) if "vwap" in df.columns else (high + low + close) / 3.0

    ema20_series = close.ewm(span=20, adjust=False).mean()
    ema50_series = close.ewm(span=50, adjust=False).mean()

    # RSI(14)
    delta = close.diff()
    gain = delta.clip(lower=0.0).rolling(window=14, min_periods=14).mean()
    loss = (-delta.clip(upper=0.0)).rolling(window=14, min_periods=14).mean()
    rs = gain / loss.replace(0.0, 1e-9)
    rsi14_series = 100.0 - (100.0 / (1.0 + rs))

    # True Range & ATR(14)
    prev_close_s = close.shift(1)
    tr = pd.concat(
        [
            (high - low).abs(),
            (high - prev_close_s).abs(),
            (low - prev_close_s).abs(),
        ],
        axis=1,
    ).max(axis=1)
    atr14_series = tr.rolling(window=14, min_periods=14).mean()
    atr_baseline = tr.rolling(window=28, min_periods=20).mean()

    # Simplified directional movement for ADX(14)
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
    tr_smooth = pd.Series(tr).rolling(14, min_periods=14).mean().replace(0.0, 1e-9)
    plus_di = 100.0 * (pd.Series(plus_dm, index=df.index).rolling(14, min_periods=14).mean() / tr_smooth)
    minus_di = 100.0 * (pd.Series(minus_dm, index=df.index).rolling(14, min_periods=14).mean() / tr_smooth)
    dx = (100.0 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0.0, 1e-9)).fillna(18.0)
    adx14_series = dx.rolling(window=14, min_periods=1).mean()

    # Bollinger Bands(20, 2.0)
    bb_mid_s = close.rolling(window=20, min_periods=20).mean()
    bb_std_s = close.rolling(window=20, min_periods=20).std(ddof=0)
    bb_upper_s = bb_mid_s + 2.0 * bb_std_s
    bb_lower_s = bb_mid_s - 2.0 * bb_std_s

    # N-bar high/low excluding current bar
    n_high = float(high.iloc[-(lookback_bars + 1) : -1].max())
    n_low = float(low.iloc[-(lookback_bars + 1) : -1].min())

    avg_vol = float(volume.iloc[-21:-1].mean()) if len(volume) > 21 else float(volume.mean())
    vol_mult = float(volume.iloc[-1]) / max(avg_vol, 1.0)

    log_rets = np.log(close / close.shift(1)).dropna()
    # Annualized realized vol assuming 78 five-minute bars per day * 252 trading days
    realized_vol = float(log_rets.tail(20).std(ddof=1) * np.sqrt(252 * 78)) if len(log_rets) >= 5 else 0.18

    c_last = float(close.iloc[-1])
    vwap_last = float(vwap.iloc[-1])
    ema20_last = float(ema20_series.iloc[-1])
    ema50_last = float(ema50_series.iloc[-1])
    atr_last = float(atr14_series.iloc[-1]) if not np.isnan(atr14_series.iloc[-1]) else c_last * 0.005
    atr_base_last = float(atr_baseline.iloc[-1]) if not np.isnan(atr_baseline.iloc[-1]) else atr_last

    return IndicatorSnapshot(
        close=c_last,
        vwap=vwap_last,
        ema20=ema20_last,
        ema50=ema50_last,
        rsi14=float(rsi14_series.iloc[-1]) if not np.isnan(rsi14_series.iloc[-1]) else 50.0,
        adx14=float(adx14_series.iloc[-1]) if not np.isnan(adx14_series.iloc[-1]) else 20.0,
        atr14=atr_last,
        atr_pct=round((atr_last / max(c_last, 1e-9)) * 100.0, 4),
        atr_expansion_ratio=round(atr_last / max(atr_base_last, 1e-9), 4),
        bb_upper=float(bb_upper_s.iloc[-1]) if not np.isnan(bb_upper_s.iloc[-1]) else c_last * 1.01,
        bb_lower=float(bb_lower_s.iloc[-1]) if not np.isnan(bb_lower_s.iloc[-1]) else c_last * 0.99,
        bb_mid=float(bb_mid_s.iloc[-1]) if not np.isnan(bb_mid_s.iloc[-1]) else c_last,
        prev_close=float(close.iloc[-2]),
        prev_bb_upper=float(bb_upper_s.iloc[-2]) if not np.isnan(bb_upper_s.iloc[-2]) else c_last * 1.01,
        prev_bb_lower=float(bb_lower_s.iloc[-2]) if not np.isnan(bb_lower_s.iloc[-2]) else c_last * 0.99,
        n_bar_high=n_high,
        n_bar_low=n_low,
        volume_multiple=round(vol_mult, 3),
        realized_vol_annualized=round(realized_vol, 4),
        dist_from_ema20_pct=round(((c_last - ema20_last) / max(ema20_last, 1e-9)) * 100.0, 4),
        dist_from_vwap_pct=round(((c_last - vwap_last) / max(vwap_last, 1e-9)) * 100.0, 4),
    )


def detect_market_regime(
    spy_indicators: IndicatorSnapshot,
    vix_proxy: float,
    regime_cfg: dict[str, Any],
) -> MarketRegime:
    """Classify overall market regime using SPY trend, realized vol, and VIX proxy."""
    high_vol_thresh = float(regime_cfg.get("high_vol_annualized_threshold", 0.28))
    vix_high_thresh = float(regime_cfg.get("vix_proxy_high_threshold", 26.0))
    adx_thresh = float(regime_cfg.get("adx_trend_threshold", 22.0))

    if spy_indicators.realized_vol_annualized >= high_vol_thresh or vix_proxy >= vix_high_thresh:
        return "high_volatility"

    if spy_indicators.adx14 >= adx_thresh:
        if spy_indicators.ema20 > spy_indicators.ema50 and spy_indicators.close >= spy_indicators.ema20:
            return "trending_up"
        if spy_indicators.ema20 < spy_indicators.ema50 and spy_indicators.close <= spy_indicators.ema20:
            return "trending_down"

    return "range"
