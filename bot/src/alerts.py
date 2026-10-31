"""Free Alert Dispatcher (Telegram Bot API + Optional SMTP Email) & Structured JSON Logging."""

from __future__ import annotations

import json
import logging
import smtplib
from datetime import datetime, timezone
from email.message import EmailMessage
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

import requests

from .config import BotConfig


class JsonLinesFormatter(logging.Formatter):
    """Structured JSONL log formatter for systemd / journald and rotating file logs."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "module": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload)


def configure_structured_logging(log_file_path: str | Path, max_bytes: int = 10_485_760, backups: int = 5) -> None:
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()

    formatter = JsonLinesFormatter()
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    root.addHandler(stream_handler)

    try:
        path = Path(log_file_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(path, maxBytes=max_bytes, backupCount=backups, encoding="utf-8")
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
    except OSError:
        # In read-only test containers, stream handler alone is sufficient
        pass


class AlertDispatcher:
    """Sends zero-cost alerts via Telegram Bot API or SMTP for critical events."""

    def __init__(self, config: BotConfig) -> None:
        self.config = config
        self.logger = logging.getLogger(__name__)

    def send_alert(self, category: str, title: str, message: str) -> bool:
        full_text = f"[AEGIS PAPER BOT | {category}]\n{title}\n{message}"
        self.logger.info("Alert triggered (%s): %s - %s", category, title, message)
        sent = False

        if self.config.telegram_bot_token and self.config.telegram_chat_id:
            try:
                url = f"https://api.telegram.org/bot{self.config.telegram_bot_token}/sendMessage"
                resp = requests.post(
                    url,
                    json={"chat_id": self.config.telegram_chat_id, "text": full_text},
                    timeout=5,
                )
                sent = resp.status_code == 200
            except Exception as exc:  # noqa: BLE001
                self.logger.warning("Telegram alert delivery failed: %s", exc)

        return sent
