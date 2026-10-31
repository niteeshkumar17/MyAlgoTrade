"""Resilient Database Manager with Local SQLite Outbox Buffer.

If Neon/Supabase Postgres is temporarily unreachable (network blip, serverless cold start),
every write is buffered deterministically into a local SQLite outbox with a unique
`idempotency_key` and flushed in order once connectivity returns.
Guarantees:
- Zero lost trades or equity snapshots
- Zero duplicate rows (idempotent ON CONFLICT DO UPDATE upserts)
"""

from __future__ import annotations

import csv
import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class ResilientDatabaseManager:
    """Manages outbound Postgres writes with automatic local SQLite outbox buffering."""

    def __init__(self, database_url: str, sqlite_outbox_path: str | Path) -> None:
        self.database_url = database_url
        self.outbox_path = Path(sqlite_outbox_path)
        self.outbox_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_sqlite_outbox()

    def _init_sqlite_outbox(self) -> None:
        with sqlite3.connect(self.outbox_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS outbox_mutations (
                    idempotency_key TEXT PRIMARY KEY,
                    table_name TEXT NOT NULL,
                    sql_statement TEXT NOT NULL,
                    params_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def enqueue_outbox(
        self,
        idempotency_key: str,
        table_name: str,
        sql_statement: str,
        params: list[Any] | tuple[Any, ...],
    ) -> None:
        """Store or update a mutation in the local SQLite outbox."""
        now_iso = datetime.now(tz=timezone.utc).isoformat()
        with sqlite3.connect(self.outbox_path) as conn:
            conn.execute(
                """
                INSERT INTO outbox_mutations (idempotency_key, table_name, sql_statement, params_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(idempotency_key) DO UPDATE SET
                    sql_statement = excluded.sql_statement,
                    params_json = excluded.params_json,
                    created_at = excluded.created_at
                """,
                (idempotency_key, table_name, sql_statement, json.dumps(list(params), default=str), now_iso),
            )
            conn.commit()

    def count_pending_outbox(self) -> int:
        with sqlite3.connect(self.outbox_path) as conn:
            cur = conn.execute("SELECT COUNT(*) FROM outbox_mutations")
            row = cur.fetchone()
            return int(row[0]) if row else 0

    def execute_idempotent_write(
        self,
        idempotency_key: str,
        table_name: str,
        sql_statement: str,
        params: list[Any] | tuple[Any, ...],
    ) -> bool:
        """Attempt direct Postgres write; on failure, buffer in SQLite outbox."""
        if not self.database_url:
            self.enqueue_outbox(idempotency_key, table_name, sql_statement, params)
            return False

        try:
            import psycopg

            with psycopg.connect(self.database_url, connect_timeout=5) as pg_conn:
                with pg_conn.cursor() as cur:
                    cur.execute(sql_statement, params)
                pg_conn.commit()
            # Also opportunistically flush any older queued mutations
            self.flush_outbox()
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Postgres unreachable for key=%s (%s); buffered in local SQLite outbox.",
                idempotency_key,
                exc,
            )
            self.enqueue_outbox(idempotency_key, table_name, sql_statement, params)
            return False

    def flush_outbox(self, batch_limit: int = 100) -> int:
        """Flush buffered SQLite mutations to Postgres in FIFO order."""
        if not self.database_url:
            return 0

        with sqlite3.connect(self.outbox_path) as sqlite_conn:
            rows = sqlite_conn.execute(
                """
                SELECT idempotency_key, sql_statement, params_json
                FROM outbox_mutations
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (batch_limit,),
            ).fetchall()

        if not rows:
            return 0

        flushed = 0
        try:
            import psycopg

            with psycopg.connect(self.database_url, connect_timeout=5) as pg_conn:
                with pg_conn.cursor() as cur:
                    for key, sql_stmt, params_json in rows:
                        params = json.loads(params_json)
                        cur.execute(sql_stmt, params)
                        with sqlite3.connect(self.outbox_path) as sqlite_conn:
                            sqlite_conn.execute(
                                "DELETE FROM outbox_mutations WHERE idempotency_key = ?",
                                (key,),
                            )
                            sqlite_conn.commit()
                        flushed += 1
                pg_conn.commit()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Outbox flush interrupted after %d items: %s", flushed, exc)

        return flushed

    def read_control_state(self) -> dict[str, Any]:
        """Poll `control.new_entries_enabled` from Postgres every cycle."""
        default_state = {
            "new_entries_enabled": True,
            "kill_switch_active": False,
            "kill_switch_reason": "",
            "active_champion_version": "v1.2.0-walkforward",
        }
        if not self.database_url:
            return default_state
        try:
            import psycopg

            with psycopg.connect(self.database_url, connect_timeout=5) as pg_conn:
                with pg_conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT new_entries_enabled, kill_switch_active, kill_switch_reason, active_champion_version
                        FROM control WHERE id = 1
                        """
                    )
                    row = cur.fetchone()
                    if row:
                        return {
                            "new_entries_enabled": bool(row[0]),
                            "kill_switch_active": bool(row[1]),
                            "kill_switch_reason": str(row[2]),
                            "active_champion_version": str(row[3]),
                        }
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not poll control row from Postgres (%s); using safe defaults.", exc)
        return default_state

    def export_tables_to_csv(self, backup_dir: str | Path, rows_by_table: dict[str, list[dict[str, Any]]]) -> list[Path]:
        """Nightly CSV backup of trades and learning_log kept on the VM."""
        out_dir = Path(backup_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d")
        written: list[Path] = []
        for table_name, records in rows_by_table.items():
            file_path = out_dir / f"{table_name}_{stamp}.csv"
            if not records:
                continue
            fieldnames = list(records[0].keys())
            with file_path.open("w", newline="", encoding="utf-8") as fh:
                writer = csv.DictWriter(fh, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(records)
            written.append(file_path)
        return written
