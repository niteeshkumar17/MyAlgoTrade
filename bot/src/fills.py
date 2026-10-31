"""Realistic Pessimistic Paper Fill Simulator for Indian NSE F&O Options.

Paper sandboxes fill options optimistically at mid or last traded price (LTP).
This module computes our headline 'Conservative Simulation' ledger fills:
- ENTRY (BUY):  fill_price = mid + 0.35 * (ask - bid), plus ₹35/lot statutory & brokerage fee
- EXIT  (SELL): fill_price = mid - 0.35 * (ask - bid), plus ₹35/lot statutory & brokerage fee
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

DEFAULT_LOT_SIZE = 75  # NIFTY default lot size (75 units per lot)


@dataclass(frozen=True)
class SimulatedFill:
    side: Literal["BUY", "SELL"]
    qty: int               # Number of lots
    lot_size: int          # Units per lot (e.g., NIFTY=75, BANKNIFTY=30)
    bid: float
    ask: float
    mid: float
    spread: float
    spread_pct_of_mid: float
    conservative_fill_price: float
    alpaca_fill_price: float
    fee_usd: float         # Total fee in account currency (INR ₹ for NSE, USD $ for US)
    total_conservative_cash_flow_usd: float
    total_alpaca_cash_flow_usd: float
    slippage_vs_mid_usd: float


def simulate_pessimistic_fill(
    side: Literal["BUY", "SELL"],
    qty: int,
    bid: float,
    ask: float,
    alpaca_fill_price: float | None = None,
    fill_cfg: dict[str, Any] | None = None,
    lot_size: int = DEFAULT_LOT_SIZE,
) -> SimulatedFill:
    """Calculate pessimistic fill price and total cost/proceeds including per-lot fees."""
    cfg = fill_cfg or {}
    slippage_frac = float(cfg.get("spread_slippage_fraction", 0.35))
    fee_per_lot = float(
        cfg.get("fee_per_lot_inr", cfg.get("fee_per_contract_usd", 35.0))
    )
    reject_zero_bid = bool(cfg.get("reject_zero_bid", True))

    if qty <= 0:
        raise ValueError(f"Lot quantity must be positive, got {qty}")
    if lot_size <= 0:
        raise ValueError(f"lot_size must be positive, got {lot_size}")
    if reject_zero_bid and bid <= 0.0:
        raise ValueError(f"Cannot simulate fill on contract with zero/negative bid ({bid})")
    if ask < bid:
        raise ValueError(f"Inverted quote: ask ({ask}) < bid ({bid})")

    mid = (bid + ask) / 2.0
    spread = ask - bid
    spread_pct = spread / max(mid, 1e-9)
    fee_total = round(qty * fee_per_lot, 2)
    total_units = qty * lot_size

    if side == "BUY":
        cons_price = round(mid + slippage_frac * spread, 4)
        alp_price = round(alpaca_fill_price if alpaca_fill_price is not None else mid, 4)
        cons_cash = -round(cons_price * total_units + fee_total, 2)
        alp_cash = -round(alp_price * total_units, 2)
        slip_val = round((cons_price - mid) * total_units + fee_total, 2)
    else:
        cons_price = round(max(0.05, mid - slippage_frac * spread), 4)
        alp_price = round(alpaca_fill_price if alpaca_fill_price is not None else mid, 4)
        cons_cash = round(cons_price * total_units - fee_total, 2)
        alp_cash = round(alp_price * total_units, 2)
        slip_val = round((mid - cons_price) * total_units + fee_total, 2)

    return SimulatedFill(
        side=side,
        qty=qty,
        lot_size=lot_size,
        bid=round(bid, 4),
        ask=round(ask, 4),
        mid=round(mid, 4),
        spread=round(spread, 4),
        spread_pct_of_mid=round(spread_pct, 4),
        conservative_fill_price=cons_price,
        alpaca_fill_price=alp_price,
        fee_usd=fee_total,
        total_conservative_cash_flow_usd=cons_cash,
        total_alpaca_cash_flow_usd=alp_cash,
        slippage_vs_mid_usd=slip_val,
    )


def compute_roundtrip_pnl(
    qty: int,
    entry_fill: SimulatedFill,
    exit_fill: SimulatedFill,
) -> dict[str, float]:
    """Compute both Conservative Simulation P&L and Optimistic Broker Paper P&L."""
    if qty <= 0:
        raise ValueError("qty must be > 0")

    entry_cost_cons = abs(entry_fill.total_conservative_cash_flow_usd)
    exit_proceeds_cons = exit_fill.total_conservative_cash_flow_usd
    pnl_cons = round(exit_proceeds_cons - entry_cost_cons, 2)
    pnl_cons_pct = round(pnl_cons / max(entry_cost_cons, 1e-9), 4)

    entry_cost_alp = abs(entry_fill.total_alpaca_cash_flow_usd)
    exit_proceeds_alp = exit_fill.total_alpaca_cash_flow_usd
    pnl_alp = round(exit_proceeds_alp - entry_cost_alp, 2)
    pnl_alp_pct = round(pnl_alp / max(entry_cost_alp, 1e-9), 4)

    return {
        "conservative_pnl_usd": pnl_cons,
        "conservative_pnl_pct": pnl_cons_pct,
        "alpaca_pnl_usd": pnl_alp,
        "alpaca_pnl_pct": pnl_alp_pct,
        "execution_drag_usd": round(pnl_alp - pnl_cons, 2),
    }


@dataclass(frozen=True)
class VerticalDebitSpreadFill:
    spread_type: Literal["BULL_CALL_SPREAD", "BEAR_PUT_SPREAD"]
    qty: int
    lot_size: int
    long_leg_fill: SimulatedFill
    short_leg_fill: SimulatedFill
    conservative_net_debit_per_unit: float
    broker_net_debit_per_unit: float
    total_fee_inr: float
    total_conservative_debit_inr: float
    total_broker_debit_inr: float
    max_risk_reduction_pct: float
    theta_decay_reduction_pct: float


def simulate_vertical_debit_spread_fill(
    spread_type: Literal["BULL_CALL_SPREAD", "BEAR_PUT_SPREAD"],
    qty: int,
    long_bid: float,
    long_ask: float,
    short_bid: float,
    short_ask: float,
    lot_size: int = DEFAULT_LOT_SIZE,
    fill_cfg: dict[str, Any] | None = None,
) -> VerticalDebitSpreadFill:
    """Simulate a 2-leg defined-risk vertical debit spread (Buy ~0.50Δ ATM, Sell ~0.25Δ OTM).

    - Long leg is bought pessimistically at mid + 35% of spread (+ ₹35/lot fee).
    - Short hedge leg is sold pessimistically at mid - 35% of spread (+ ₹35/lot fee).
    - Total entry fee = ₹70/lot (2 legs x ₹35/lot).
    """
    long_fill = simulate_pessimistic_fill("BUY", qty, long_bid, long_ask, fill_cfg=fill_cfg, lot_size=lot_size)
    short_fill = simulate_pessimistic_fill("SELL", qty, short_bid, short_ask, fill_cfg=fill_cfg, lot_size=lot_size)

    cons_net_debit = round(max(1.0, long_fill.conservative_fill_price - short_fill.conservative_fill_price), 4)
    broker_net_debit = round(max(1.0, long_fill.alpaca_fill_price - short_fill.alpaca_fill_price), 4)
    total_fee = round(long_fill.fee_usd + short_fill.fee_usd, 2)
    total_units = qty * lot_size
    total_cons_debit = round(cons_net_debit * total_units + total_fee, 2)
    total_broker_debit = round(broker_net_debit * total_units, 2)

    naked_cost = abs(long_fill.total_conservative_cash_flow_usd)
    risk_reduction = round(max(0.0, (naked_cost - total_cons_debit) / max(naked_cost, 1e-9)), 4)

    return VerticalDebitSpreadFill(
        spread_type=spread_type,
        qty=qty,
        lot_size=lot_size,
        long_leg_fill=long_fill,
        short_leg_fill=short_fill,
        conservative_net_debit_per_unit=cons_net_debit,
        broker_net_debit_per_unit=broker_net_debit,
        total_fee_inr=total_fee,
        total_conservative_debit_inr=total_cons_debit,
        total_broker_debit_inr=total_broker_debit,
        max_risk_reduction_pct=risk_reduction,
        theta_decay_reduction_pct=0.65,
    )

