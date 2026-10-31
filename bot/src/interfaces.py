"""Pluggable interfaces for market data providers and broker execution adapters.

Primary implementation: Indian NSE F&O Paper-Trading Adapter (NIFTY, BANKNIFTY, FINNIFTY,
RELIANCE, TCS, HDFCBANK, INFY, ICICIBANK, SBIN) with NSE lot sizes and INDIA VIX.
Also retains the Alpaca US Paper interface so brokers/feeds can be swapped without touching
any strategy, risk, or learning code.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal

try:
    import pandas as pd
except ImportError:
    pd = None  # type: ignore[assignment]

OptionRight = Literal["CALL", "PUT"]

DEFAULT_NSE_LOT_SIZES: dict[str, int] = {
    "NIFTY": 75,
    "BANKNIFTY": 30,
    "FINNIFTY": 65,
    "RELIANCE": 500,
    "TCS": 175,
    "HDFCBANK": 550,
    "INFY": 400,
    "ICICIBANK": 700,
    "SBIN": 750,
}


@dataclass(frozen=True)
class OptionContractQuote:
    contract_symbol: str
    underlying: str
    expiration_date: date
    strike: float
    right: OptionRight
    lot_size: int
    bid: float
    ask: float
    mid: float
    spread_pct_of_mid: float
    delta: float
    gamma: float
    theta: float
    vega: float
    implied_volatility: float
    iv_rank_pct: float
    open_interest: int
    volume: int
    quote_timestamp: datetime
    is_halted: bool = False

    @property
    def dte(self) -> int:
        return (self.expiration_date - self.quote_timestamp.date()).days


@dataclass(frozen=True)
class BrokerOrderResult:
    client_order_id: str
    broker_order_id: str
    contract_symbol: str
    side: Literal["BUY", "SELL"]
    qty: int  # Number of NSE lots
    status: Literal["FILLED", "SUBMITTED", "REJECTED", "DRY_RUN"]
    alpaca_fill_price: float | None
    filled_at: datetime | None
    raw_message: str = ""


@dataclass(frozen=True)
class BrokerPosition:
    contract_symbol: str
    underlying: str
    qty: int  # Number of NSE lots
    avg_entry_price: float
    market_price: float
    unrealized_pnl: float


class MarketDataProvider(ABC):
    """Abstract interface for fetching underlying OHLCV bars and option chains."""

    @abstractmethod
    def get_underlying_bars(
        self, symbol: str, lookback_bars: int = 100, timeframe: str = "5Min"
    ) -> pd.DataFrame:
        """Return OHLCV DataFrame with columns: timestamp, open, high, low, close, volume, vwap."""

    @abstractmethod
    def get_option_chain(
        self, underlying: str, min_dte: int = 7, max_dte: int = 45
    ) -> list[OptionContractQuote]:
        """Return candidate option contracts with Greeks, bid/ask, lot_size, OI, volume, and timestamp."""

    @abstractmethod
    def get_option_quote(self, contract_symbol: str) -> OptionContractQuote | None:
        """Fetch latest quote for an individual option contract."""

    @abstractmethod
    def get_vix_proxy_level(self) -> float:
        """Return current INDIA VIX (or US VIX proxy) level for regime classification."""


class BrokerAdapter(ABC):
    """Abstract interface for paper order submission and position reconciliation."""

    @abstractmethod
    def verify_paper_only(self) -> bool:
        """Hard check that this adapter is connected exclusively to a paper-trading endpoint."""

    @abstractmethod
    def submit_option_order(
        self,
        client_order_id: str,
        contract_symbol: str,
        side: Literal["BUY", "SELL"],
        qty: int,
        limit_price: float | None = None,
    ) -> BrokerOrderResult:
        """Submit a long option entry (BUY to open) or exit (SELL to close) order in lots."""

    @abstractmethod
    def list_open_positions(self) -> list[BrokerPosition]:
        """Return all open option positions held in the broker paper account."""
