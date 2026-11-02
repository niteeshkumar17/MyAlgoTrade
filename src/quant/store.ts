/**
 * Small key-value store on top of the existing config_history table.
 * Writes carry a revision and succeed only if that revision is still current, so two overlapping
 * cycles cannot both commit. The in-memory store is used in tests and when no database is configured.
 */

import pg from 'pg';

export interface KvRow<T> {
  rev: number;
  data: T;
}

export interface KvStore {
  get<T>(key: string): Promise<KvRow<T> | null>;
  put<T>(key: string, data: T, expectedRev: number | null): Promise<{ ok: true; rev: number } | { ok: false }>;
}

interface Envelope<T> {
  rev: number;
  data: T;
}

export class MemoryKvStore implements KvStore {
  private rows = new Map<string, Envelope<unknown>>();

  async get<T>(key: string): Promise<KvRow<T> | null> {
    const row = this.rows.get(key);
    return row ? { rev: row.rev, data: row.data as T } : null;
  }

  async put<T>(key: string, data: T, expectedRev: number | null): Promise<{ ok: true; rev: number } | { ok: false }> {
    const current = this.rows.get(key);
    if (expectedRev === null) {
      if (current) return { ok: false };
      this.rows.set(key, { rev: 1, data });
      return { ok: true, rev: 1 };
    }
    if (!current || current.rev !== expectedRev) return { ok: false };
    const rev = expectedRev + 1;
    this.rows.set(key, { rev, data });
    return { ok: true, rev };
  }
}

export class PgKvStore implements KvStore {
  constructor(private pool: pg.Pool) {}

  async get<T>(key: string): Promise<KvRow<T> | null> {
    const res = await this.pool.query(
      `SELECT config_payload_json FROM config_history WHERE config_version_id = $1`,
      [key]
    );
    const payload = res.rows[0]?.config_payload_json as Envelope<T> | undefined;
    if (!payload || typeof payload.rev !== 'number' || !('data' in payload)) return null;
    return { rev: payload.rev, data: payload.data };
  }

  async put<T>(key: string, data: T, expectedRev: number | null): Promise<{ ok: true; rev: number } | { ok: false }> {
    const rev = (expectedRev ?? 0) + 1;
    const payload = JSON.stringify({ rev, data });
    if (expectedRev === null) {
      const res = await this.pool.query(
        `INSERT INTO config_history (config_version_id, applied_at, is_active_champion, previous_champion_id, config_payload_json, change_summary)
         VALUES ($1, NOW(), FALSE, NULL, $2::jsonb, $3)
         ON CONFLICT (config_version_id) DO NOTHING`,
        [key, payload, 'paper-v2']
      );
      return res.rowCount === 1 ? { ok: true, rev } : { ok: false };
    }
    const res = await this.pool.query(
      `UPDATE config_history
       SET config_payload_json = $2::jsonb, applied_at = NOW(), change_summary = $4
       WHERE config_version_id = $1 AND (config_payload_json->>'rev')::int = $3`,
      [key, payload, expectedRev, 'paper-v2']
    );
    return res.rowCount === 1 ? { ok: true, rev } : { ok: false };
  }
}

let pool: pg.Pool | null = null;

export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL_RW || process.env.DATABASE_URL_RO || process.env.DATABASE_URL);
}

export function createStore(): KvStore {
  const url = process.env.DATABASE_URL_RW || process.env.DATABASE_URL_RO || process.env.DATABASE_URL || '';
  if (!url) return new MemoryKvStore();
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return new PgKvStore(pool);
}

export const KEY_ACTIVE = 'PAPER_V2:ACTIVE';
export const KEY_LEASE = 'PAPER_V2:LEASE';
export const KEY_INSTRUMENTS = 'PAPER_V2:INSTRUMENTS';

export const stateKey = (ledgerId: string) => `PAPER_V2:${ledgerId}:STATE`;
export const tradesKey = (ledgerId: string, month: string) => `PAPER_V2:${ledgerId}:TRADES:${month}`;
export const candidatesKey = (ledgerId: string, month: string) => `PAPER_V2:${ledgerId}:CANDIDATES:${month}`;
export const equityKey = (ledgerId: string, month: string) => `PAPER_V2:${ledgerId}:EQUITY:${month}`;
