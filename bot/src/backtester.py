"""Walk-Forward Backtester using historical underlying bars and Black-Scholes option pricing.

NOTE ON APPROXIMATION (Honesty Requirement):
Historical tick-level OPRA option chains are expensive ($1,000s/yr). This walk-forward
backtester prices synthetic 28-DTE ~0.45-delta contracts via Black-Scholes using rolling
realized volatility * iv_multiplier_from_hv (default 1.18), and applies our exact
pessimistic spread (35% of spread) and fee ($0.65/contract) model. Results are clearly
labeled as a Black-Scholes approximation.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
import pandas as pd
from scipy.stats import norm

from .fills import OPTION_MULTIPLIER, compute_roundtrip_pnl, simulate_pessimistic_fill


@dataclass(frozen=True)
class BlackScholesQuote:
    price: float
    delta: float
    theta_daily: float
    bid: float
    ask: float


@dataclass(frozen=True)
class StrategyBacktestMetrics:
    strategy_name: str
    trade_count: int
    win_rate: float
    avg_win_usd: float
    avg_loss_usd: float
    expectancy_usd: float
    profit_factor: float
    max_drawdown_pct: float
    sharpe_ratio: float
    net_pnl_usd: float


def black_scholes_option_quote(
    spot: float,
    strike: float,
    dte_days: int,
    sigma_iv: float,
    risk_free_rate: float,
    right: Literal["CALL", "PUT"],
    assumed_spread_pct: float = 0.048,
) -> BlackScholesQuote:
    """Compute Black-Scholes option price, delta, daily theta, and synthetic bid/ask."""
    t = max(dte_days / 365.0, 1.0 / 365.0)
    sigma = max(sigma_iv, 0.08)
    s = max(spot, 0.01)
    k = max(strike, 0.01)

    d1 = (math.log(s / k) + (risk_free_rate + 0.5 * sigma**2) * t) / (sigma * math.sqrt(t))
    d2 = d1 - sigma * math.sqrt(t)

    if right == "CALL":
        theo = s * float(norm.cdf(d1)) - k * math.exp(-risk_free_rate * t) * float(norm.cdf(d2))
        delta = float(norm.cdf(d1))
        theta_annual = (
            -(s * float(norm.pdf(d1)) * sigma) / (2.0 * math.sqrt(t))
            - risk_free_rate * k * math.exp(-risk_free_rate * t) * float(norm.cdf(d2))
        )
    else:
        theo = k * math.exp(-risk_free_rate * t) * float(norm.cdf(-d2)) - s * float(norm.cdf(-d1))
        delta = float(norm.cdf(d1)) - 1.0
        theta_annual = (
            -(s * float(norm.pdf(d1)) * sigma) / (2.0 * math.sqrt(t))
            + risk_free_rate * k * math.exp(-risk_free_rate * t) * float(norm.cdf(-d2))
        )

    mid = max(0.25, round(theo, 4))
    half_spread = max(0.02, (mid * assumed_spread_pct) / 2.0)
    bid = round(max(0.05, mid - half_spread), 2)
    ask = round(mid + half_spread, 2)

    return BlackScholesQuote(
        price=mid,
        delta=round(delta, 4),
        theta_daily=round(theta_annual / 365.0, 4),
        bid=bid,
        ask=ask,
    )


def run_walk_forward_backtest(
    daily_df: pd.DataFrame,
    config: dict[str, Any],
) -> dict[str, StrategyBacktestMetrics]:
    """Run walk-forward backtest across the 3 strategies using Black-Scholes + pessimistic fills."""
    starting_equity = float(config.get("broker", {}).get("starting_equity_usd", 100000.0))
    fill_cfg = config.get("fill_simulation", {})
    bt_cfg = config.get("backtest", {})
    rf = float(bt_cfg.get("risk_free_rate_annual", 0.045))
    iv_mult = float(bt_cfg.get("iv_multiplier_from_hv", 1.18))

    close = daily_df["close"].astype(float).reset_index(drop=True)
    if len(close) < 60:
        raise ValueError("Walk-forward backtest requires at least 60 bars.")

    ema20 = close.ewm(span=20, adjust=False).mean()
    ema50 = close.ewm(span=50, adjust=False).mean()
    delta = close.diff()
    gain = delta.clip(lower=0.0).rolling(14, min_periods=14).mean()
    loss = (-delta.clip(upper=0.0)).rolling(14, min_periods=14).mean()
    rsi14 = 100.0 - (100.0 / (1.0 + gain / loss.replace(0.0, 1e-9)))
    hv20 = np.log(close / close.shift(1)).rolling(20, min_periods=10).std(ddof=1) * math.sqrt(252)

    results: dict[str, StrategyBacktestMetrics] = {}

    for strat in ("trend_following", "mean_reversion", "breakout_momentum"):
        pnls: list[float] = []
        equity = starting_equity
        peak = starting_equity
        max_dd = 0.0

        i = 50
        while i < len(close) - 6:
            s_now = float(close.iloc[i])
            iv_est = max(0.16, float(hv20.iloc[i] if not np.isnan(hv20.iloc[i]) else 0.20) * iv_mult)

            direction: Literal["CALL", "PUT"] | None = None
            if strat == "trend_following":
                if ema20.iloc[i] > ema50.iloc[i] and s_now > ema20.iloc[i]:
                    direction = "CALL"
                elif ema20.iloc[i] < ema50.iloc[i] and s_now < ema20.iloc[i]:
                    direction = "PUT"
            elif strat == "mean_reversion":
                if rsi14.iloc[i] <= 34.0:
                    direction = "CALL"
                elif rsi14.iloc[i] >= 66.0:
                    direction = "PUT"
            else:
                high_15 = float(close.iloc[i - 15 : i].max())
                low_15 = float(close.iloc[i - 15 : i].min())
                if s_now > high_15:
                    direction = "CALL"
                elif s_now < low_15:
                    direction = "PUT"

            if direction is None:
                i += 1
                continue

            strike = round(s_now * (1.01 if direction == "CALL" else 0.99), 0)
            entry_q = black_scholes_option_quote(s_now, strike, 28, iv_est, rf, direction)
            cost_1 = entry_q.ask * OPTION_MULTIPLIER
            qty = max(1, int((equity * 0.01) // max(cost_1, 1.0)))
            entry_fill = simulate_pessimistic_fill("BUY", qty, entry_q.bid, entry_q.ask, fill_cfg=fill_cfg)

            # Simulate holding up to 5 days with -30% stop / +50% target
            hold_days = 1
            exit_fill = None
            for d in range(1, 6):
                hold_days = d
                s_next = float(close.iloc[i + d])
                iv_next = max(0.15, float(hv20.iloc[i + d] if not np.isnan(hv20.iloc[i + d]) else iv_est) * iv_mult)
                cur_q = black_scholes_option_quote(s_next, strike, 28 - d, iv_next, rf, direction)
                cand_exit = simulate_pessimistic_fill("SELL", qty, cur_q.bid, cur_q.ask, fill_cfg=fill_cfg)
                rt = compute_roundtrip_pnl(qty, entry_fill, cand_exit)
                pct = rt["conservative_pnl_pct"]
                if pct <= -0.30 or pct >= 0.50 or d == 5:
                    exit_fill = cand_exit
                    break

            if exit_fill is not None:
                rt = compute_roundtrip_pnl(qty, entry_fill, exit_fill)
                pnl_usd = rt["conservative_pnl_usd"]
                pnls.append(pnl_usd)
                equity += pnl_usd
                peak = max(peak, equity)
                dd = (peak - equity) / max(peak, 1.0)
                max_dd = max(max_dd, dd)

            i += hold_days + 1

        wins = [x for x in pnls if x > 0]
        losses = [x for x in pnls if x <= 0]
        trade_count = len(pnls)
        win_rate = round(len(wins) / trade_count, 4) if trade_count else 0.0
        avg_win = round(float(np.mean(wins)), 2) if wins else 0.0
        avg_loss = round(float(np.mean(losses)), 2) if losses else 0.0
        expectancy = round(float(np.mean(pnls)), 2) if pnls else 0.0
        gross_win = sum(wins)
        gross_loss = abs(sum(losses))
        pf = round(gross_win / max(gross_loss, 1.0), 2) if gross_win > 0 else 0.0
        std_pnl = float(np.std(pnls, ddof=1)) if len(pnls) > 1 else 1.0
        sharpe = round((expectancy / max(std_pnl, 1e-6)) * math.sqrt(52), 2) if pnls else 0.0

        results[strat] = StrategyBacktestMetrics(
            strategy_name=strat,
            trade_count=trade_count,
            win_rate=win_rate,
            avg_win_usd=avg_win,
            avg_loss_usd=avg_loss,
            expectancy_usd=expectancy,
            profit_factor=pf,
            max_drawdown_pct=round(max_dd, 4),
            sharpe_ratio=sharpe,
            net_pnl_usd=round(sum(pnls), 2),
        )

    return results
