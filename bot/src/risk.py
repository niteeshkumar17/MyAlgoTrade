"""Risk Management, Position Sizing (NSE Lots), Kill Switches, Idempotency & Reconciliation."""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import Any

from .exits import OpenPositionState
from .interfaces import DEFAULT_NSE_LOT_SIZES, BrokerPosition


@dataclass(frozen=True)
class PortfolioRiskSnapshot:
    current_equity_usd: float
    peak_equity_usd: float
    daily_starting_equity_usd: float
    open_positions: list[OpenPositionState]
    control_new_entries_enabled: bool


@dataclass(frozen=True)
class RiskGateDecision:
    allowed: bool
    approved_contracts_qty: int  # Number of NSE lots
    max_risk_budget_usd: float
    rejection_reason: str
    trigger_daily_halt: bool
    trigger_drawdown_kill_switch: bool


@dataclass(frozen=True)
class ReconciliationMismatch:
    contract_symbol: str
    internal_qty: int
    alpaca_qty: int
    description: str


def compute_idempotent_order_id(
    cycle_bucket_iso: str,
    underlying: str,
    strategy_name: str,
    contract_symbol: str,
    side: str,
) -> str:
    """Deterministic idempotency key so restarts or duplicate cycles never double-order."""
    payload = f"{cycle_bucket_iso}|{underlying}|{strategy_name}|{contract_symbol}|{side}"
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]
    return f"aegis-nse-{side.lower()}-{digest}"


def evaluate_entry_risk_and_size(
    portfolio: PortfolioRiskSnapshot,
    underlying: str,
    conservative_entry_price: float,
    fee_per_contract_usd: float,
    risk_cfg: dict[str, Any],
    bandit_allocation_multiplier: float = 1.0,
    lot_size: int | None = None,
) -> RiskGateDecision:
    """Enforce all hard risk limits, kill switches, and compute NSE lot quantity."""
    eq = max(portfolio.current_equity_usd, 1.0)
    peak_eq = max(portfolio.peak_equity_usd, eq)
    day_start_eq = max(portfolio.daily_starting_equity_usd, 1.0)
    units_per_lot = lot_size or DEFAULT_NSE_LOT_SIZES.get(underlying, 75)

    max_risk_pct = float(risk_cfg.get("max_risk_per_trade_pct_equity", 0.015))
    max_open_pos = int(risk_cfg.get("max_open_positions", 5))
    max_total_prem_pct = float(risk_cfg.get("max_total_premium_pct_equity", 0.25))
    max_per_underlying = int(risk_cfg.get("max_positions_per_underlying", 2))
    daily_loss_limit_pct = float(risk_cfg.get("daily_loss_limit_pct_equity", 0.03))
    max_dd_kill_pct = float(risk_cfg.get("max_drawdown_kill_switch_pct", 0.10))

    # 1. Drawdown from peak kill-switch check (10%)
    current_dd_pct = (peak_eq - eq) / peak_eq
    if current_dd_pct >= max_dd_kill_pct:
        return RiskGateDecision(
            allowed=False,
            approved_contracts_qty=0,
            max_risk_budget_usd=0.0,
            rejection_reason=(
                f"KILL SWITCH: Drawdown from peak is {current_dd_pct * 100:.2f}% "
                f"(limit {max_dd_kill_pct * 100:.1f}%). Bot paused for review."
            ),
            trigger_daily_halt=True,
            trigger_drawdown_kill_switch=True,
        )

    # 2. Daily loss limit check (3%)
    daily_loss_pct = (day_start_eq - eq) / day_start_eq
    if daily_loss_pct >= daily_loss_limit_pct:
        return RiskGateDecision(
            allowed=False,
            approved_contracts_qty=0,
            max_risk_budget_usd=0.0,
            rejection_reason=(
                f"DAILY LOSS HALT: Intraday loss is {daily_loss_pct * 100:.2f}% "
                f"(limit {daily_loss_limit_pct * 100:.1f}%). No new entries today."
            ),
            trigger_daily_halt=True,
            trigger_drawdown_kill_switch=False,
        )

    # 3. DB Control row pause switch
    if not portfolio.control_new_entries_enabled:
        return RiskGateDecision(
            allowed=False,
            approved_contracts_qty=0,
            max_risk_budget_usd=0.0,
            rejection_reason="Control table 'new_entries_enabled' is FALSE (Paused).",
            trigger_daily_halt=False,
            trigger_drawdown_kill_switch=False,
        )

    # 4. Max open positions (5)
    if len(portfolio.open_positions) >= max_open_pos:
        return RiskGateDecision(
            allowed=False,
            approved_contracts_qty=0,
            max_risk_budget_usd=0.0,
            rejection_reason=f"Max open positions reached ({len(portfolio.open_positions)}/{max_open_pos}).",
            trigger_daily_halt=False,
            trigger_drawdown_kill_switch=False,
        )

    # 5. Max positions per underlying (2)
    underlying_count = sum(1 for p in portfolio.open_positions if p.underlying == underlying)
    if underlying_count >= max_per_underlying:
        return RiskGateDecision(
            allowed=False,
            approved_contracts_qty=0,
            max_risk_budget_usd=0.0,
            rejection_reason=(
                f"Max positions for {underlying} reached ({underlying_count}/{max_per_underlying})."
            ),
            trigger_daily_halt=False,
            trigger_drawdown_kill_switch=False,
        )

    # 6. Compute per-trade risk budget
    safe_multiplier = max(0.25, min(1.0, bandit_allocation_multiplier))
    risk_budget = round(eq * max_risk_pct * safe_multiplier, 2)

    cost_per_lot = conservative_entry_price * units_per_lot + fee_per_contract_usd
    if cost_per_lot <= 0:
        return RiskGateDecision(
            allowed=False,
            approved_contracts_qty=0,
            max_risk_budget_usd=risk_budget,
            rejection_reason="Invalid lot cost <= 0.",
            trigger_daily_halt=False,
            trigger_drawdown_kill_switch=False,
        )

    # 7. Check aggregate open premium cap (25% of equity)
    current_open_premium = sum(
        p.entry_price * p.qty * DEFAULT_NSE_LOT_SIZES.get(p.underlying, 75)
        for p in portfolio.open_positions
    )
    remaining_premium_capacity = max(0.0, eq * max_total_prem_pct - current_open_premium)

    effective_budget = min(risk_budget, remaining_premium_capacity)
    lots_qty = int(math.floor(effective_budget / cost_per_lot))

    if lots_qty < 1:
        return RiskGateDecision(
            allowed=False,
            approved_contracts_qty=0,
            max_risk_budget_usd=risk_budget,
            rejection_reason=(
                f"1 NSE Lot cost ₹{cost_per_lot:.2f} exceeds available risk budget ₹{effective_budget:.2f}."
            ),
            trigger_daily_halt=False,
            trigger_drawdown_kill_switch=False,
        )

    return RiskGateDecision(
        allowed=True,
        approved_contracts_qty=lots_qty,
        max_risk_budget_usd=risk_budget,
        rejection_reason="",
        trigger_daily_halt=False,
        trigger_drawdown_kill_switch=False,
    )


def reconcile_positions(
    internal_positions: list[OpenPositionState],
    alpaca_positions: list[BrokerPosition],
) -> list[ReconciliationMismatch]:
    """Compare internal conservative ledger positions against broker paper positions every cycle."""
    internal_map = {p.contract_symbol: p.qty for p in internal_positions}
    alpaca_map = {p.contract_symbol: p.qty for p in alpaca_positions}
    all_symbols = sorted(set(internal_map.keys()) | set(alpaca_map.keys()))

    mismatches: list[ReconciliationMismatch] = []
    for sym in all_symbols:
        int_qty = internal_map.get(sym, 0)
        alp_qty = alpaca_map.get(sym, 0)
        if int_qty != alp_qty:
            mismatches.append(
                ReconciliationMismatch(
                    contract_symbol=sym,
                    internal_qty=int_qty,
                    alpaca_qty=alp_qty,
                    description=f"Ledger mismatch on {sym}: internal_lots={int_qty} vs paper_broker_lots={alp_qty}",
                )
            )
    return mismatches
