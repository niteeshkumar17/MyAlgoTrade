"""Market calendar utilities supporting Indian NSE (Asia/Kolkata, 09:15-15:30 IST) and US NYSE."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

try:
    import pandas as pd
except ImportError:
    pd = None  # type: ignore[assignment]

try:
    import pandas_market_calendars as mcal
except ImportError:
    mcal = None

IST_TZ = ZoneInfo("Asia/Kolkata")


@dataclass(frozen=True)
class SessionWindow:
    trading_date: date
    market_open: datetime
    market_close: datetime
    is_early_close: bool


class MarketCalendar:
    """NSE/BSE (XBOM) market calendar in Asia/Kolkata (09:15 - 15:30 IST), skipping Indian holidays."""

    def __init__(self, exchange: str = "XBOM", timezone_name: str = "Asia/Kolkata") -> None:
        self.exchange = exchange
        self.tz = ZoneInfo(timezone_name)
        self._cal = mcal.get_calendar(exchange) if mcal is not None else None

    def now_ist(self) -> datetime:
        return datetime.now(tz=self.tz)

    def now_et(self) -> datetime:
        return self.now_ist()

    def get_session(self, dt: date | datetime | None = None) -> SessionWindow | None:
        target_dt = dt or self.now_ist()
        target_date = target_dt.date() if isinstance(target_dt, datetime) else target_dt

        if self._cal is not None:
            sched = self._cal.schedule(start_date=target_date, end_date=target_date)
            if sched.empty:
                return None
            row = sched.iloc[0]
            open_local = row["market_open"].tz_convert(self.tz).to_pydatetime()
            close_local = row["market_close"].tz_convert(self.tz).to_pydatetime()
            is_early = close_local.hour < 15
            return SessionWindow(
                trading_date=target_date,
                market_open=open_local,
                market_close=close_local,
                is_early_close=is_early,
            )

        # Deterministic NSE weekday fallback (09:15 IST to 15:30 IST)
        if target_date.weekday() >= 5:
            return None
        open_ist = datetime.combine(target_date, time(9, 15), tzinfo=self.tz)
        close_ist = datetime.combine(target_date, time(15, 30), tzinfo=self.tz)
        return SessionWindow(
            trading_date=target_date,
            market_open=open_ist,
            market_close=close_ist,
            is_early_close=False,
        )

    def is_market_open(self, now: datetime | None = None) -> bool:
        current = (now or self.now_ist()).astimezone(self.tz)
        session = self.get_session(current.date())
        if session is None:
            return False
        return session.market_open <= current < session.market_close

    def is_in_pre_close_flatten_window(
        self, flatten_minutes_before_close: int = 15, now: datetime | None = None
    ) -> bool:
        current = (now or self.now_ist()).astimezone(self.tz)
        session = self.get_session(current.date())
        if session is None:
            return False
        flatten_start = session.market_close - timedelta(minutes=flatten_minutes_before_close)
        return flatten_start <= current <= session.market_close

    def trading_days_between(self, start_date: date, end_date: date) -> int:
        if end_date <= start_date:
            return 0
        if self._cal is not None:
            sched = self._cal.schedule(start_date=start_date, end_date=end_date)
            return max(0, len(sched) - 1)
        if pd is not None:
            days = pd.bdate_range(start=start_date, end=end_date)
            return max(0, len(days) - 1)
        # Pure stdlib business day counter
        count = 0
        cur = start_date
        while cur < end_date:
            cur += timedelta(days=1)
            if cur.weekday() < 5:
                count += 1
        return count
