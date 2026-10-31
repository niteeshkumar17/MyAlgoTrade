"""Configuration loader and hard paper-trading safety guard (Indian NSE & US Paper)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore[assignment]

try:
    from dotenv import load_dotenv
except ImportError:
    def load_dotenv(*_args: Any, **_kwargs: Any) -> bool:
        return False

ALLOWED_PAPER_HOSTS = {
    "paper-sandbox.nseindia-sim.local",
    "paper-api.alpaca.markets",
}


class LiveTradingForbiddenError(RuntimeError):
    """Raised when any configuration attempts to use a live broker endpoint."""


def assert_paper_trading_url(url: str) -> str:
    """Hard safety guard: refuse to start unless URL points strictly to an approved paper endpoint."""
    if not url or not isinstance(url, str):
        raise LiveTradingForbiddenError("Broker base URL is empty or missing.")
    cleaned = url.strip().rstrip("/")
    parsed = urlparse(cleaned)
    if parsed.scheme != "https" or parsed.netloc not in ALLOWED_PAPER_HOSTS:
        raise LiveTradingForbiddenError(
            f"CRITICAL SAFETY VIOLATION: Broker URL '{url}' is NOT an approved paper-trading "
            f"endpoint ({ALLOWED_PAPER_HOSTS}). Live trading code paths are strictly forbidden."
        )
    if "live" in cleaned.lower():
        raise LiveTradingForbiddenError("URL contains 'live'; aborting startup immediately.")
    return cleaned


@dataclass(frozen=True)
class BotConfig:
    raw: dict[str, Any]
    broker_provider: str
    paper_endpoint_url: str
    nse_data_api_key: str
    database_url: str
    telegram_bot_token: str
    telegram_chat_id: str
    oci_par_backup_url: str

    @property
    def dry_run(self) -> bool:
        return bool(self.raw.get("system", {}).get("dry_run", False))

    @property
    def decision_cycle_minutes(self) -> int:
        val = int(self.raw.get("system", {}).get("decision_cycle_minutes", 5))
        return max(1, min(15, val))


def load_bot_config(config_path: str | Path | None = None) -> BotConfig:
    """Load YAML config and environment secrets, enforcing paper-only safety checks."""
    load_dotenv()
    resolved_path = Path(
        config_path
        or os.environ.get("AEGIS_CONFIG_PATH")
        or Path(__file__).resolve().parents[1] / "config.yaml"
    )
    if yaml is not None and resolved_path.exists():
        with resolved_path.open("r", encoding="utf-8") as fh:
            raw_cfg: dict[str, Any] = yaml.safe_load(fh)
    else:
        raw_cfg = {
            "system": {"dry_run": False, "decision_cycle_minutes": 5},
            "broker": {
                "provider": "indian_nse_paper",
                "paper_trading_only": True,
                "nse_paper_endpoint": "https://paper-sandbox.nseindia-sim.local",
                "alpaca_base_url": "https://paper-api.alpaca.markets",
            },
        }

    broker_cfg = raw_cfg.get("broker", {})
    if not broker_cfg.get("paper_trading_only", True):
        raise LiveTradingForbiddenError("paper_trading_only flag in config.yaml must be True.")

    env_paper_flag = os.environ.get("PAPER_TRADING_ONLY", "true").lower()
    if env_paper_flag != "true":
        raise LiveTradingForbiddenError("PAPER_TRADING_ONLY env var must be 'true'.")

    provider = os.environ.get("BROKER_PROVIDER", broker_cfg.get("provider", "indian_nse_paper"))
    yaml_url = (
        broker_cfg.get("nse_paper_endpoint", "https://paper-sandbox.nseindia-sim.local")
        if provider == "indian_nse_paper"
        else broker_cfg.get("alpaca_base_url", "https://paper-api.alpaca.markets")
    )
    env_url = os.environ.get("NSE_PAPER_ENDPOINT") or os.environ.get("ALPACA_BASE_URL") or yaml_url

    assert_paper_trading_url(yaml_url)
    validated_url = assert_paper_trading_url(env_url)

    return BotConfig(
        raw=raw_cfg,
        broker_provider=provider,
        paper_endpoint_url=validated_url,
        nse_data_api_key=os.environ.get("NSE_DATA_API_KEY", ""),
        database_url=os.environ.get("DATABASE_URL", ""),
        telegram_bot_token=os.environ.get("TELEGRAM_BOT_TOKEN", ""),
        telegram_chat_id=os.environ.get("TELEGRAM_CHAT_ID", ""),
        oci_par_backup_url=os.environ.get("OCI_PAR_BACKUP_UPLOAD_URL", ""),
    )
