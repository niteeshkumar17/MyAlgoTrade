/**
 * Small key-value store on top of the existing config_history table.
 * Writes carry a revision and succeed only if that revision is still current, so two overlapping
 * cycles cannot both commit. The in-memory store is used in tests and when no database is configured.
 */

import fs from 'node:fs';
import path from 'node:path';
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

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('exceeded the quota') || msg.includes('quota') || msg.includes('upgrade your plan');
}

function isTransientPgError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (isQuotaError(err)) return false;
  const msg = err.message.toLowerCase();
  const code = (err as { code?: string }).code ?? '';
  return (
    msg.includes('connection terminated') ||
    msg.includes('client has encountered a connection error') ||
    msg.includes('connection reset') ||
    msg.includes('socket hang up') ||
    msg.includes('timeout') ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === '57P01' ||
    code === '08006' ||
    code === '08003'
  );
}

const DISK_STORE_PATH = path.resolve(process.cwd(), '.data', 'kv-store.json');

export class ResilientKvStore implements KvStore {
  private cache = new Map<string, Envelope<unknown>>();
  private pgDisabledUntilMs = 0;

  constructor(private pool: pg.Pool | null) {
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(DISK_STORE_PATH)) {
        const raw = fs.readFileSync(DISK_STORE_PATH, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, Envelope<unknown>>;
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v.rev === 'number' && 'data' in v) {
            this.cache.set(k, v);
          }
        }
      }
    } catch {
      // ignore corrupt disk cache
    }
  }

  private saveToDisk() {
    try {
      const dir = path.dirname(DISK_STORE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, Envelope<unknown>> = {};
      for (const [k, v] of this.cache.entries()) {
        obj[k] = v;
      }
      const tmp = `${DISK_STORE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
      fs.renameSync(tmp, DISK_STORE_PATH);
    } catch {
      // ignore disk write error on read-only fs
    }
  }

  private canUsePg(): boolean {
    return Boolean(this.pool) && Date.now() >= this.pgDisabledUntilMs;
  }

  private handlePgError(err: unknown) {
    if (isQuotaError(err)) {
      // Pause Neon queries for 15 minutes when free-tier quota is exceeded
      this.pgDisabledUntilMs = Date.now() + 15 * 60_000;
    } else {
      // Pause briefly for 15 seconds on other DB connectivity errors
      this.pgDisabledUntilMs = Date.now() + 15_000;
    }
  }

  private async queryWithRetry(text: string, values: unknown[]): Promise<pg.QueryResult> {
    if (!this.pool) throw new Error('No pool');
    try {
      return await this.pool.query(text, values);
    } catch (err) {
      if (!isTransientPgError(err)) throw err;
      return await this.pool.query(text, values);
    }
  }

  async get<T>(key: string): Promise<KvRow<T> | null> {
    const cached = this.cache.get(key);
    if (cached && key !== KEY_LEASE) {
      return { rev: cached.rev, data: cached.data as T };
    }
    if (this.canUsePg()) {
      try {
        const res = await this.queryWithRetry(
          `SELECT config_payload_json FROM config_history WHERE config_version_id = $1`,
          [key]
        );
        const payload = res.rows[0]?.config_payload_json as Envelope<T> | undefined;
        if (payload && typeof payload.rev === 'number' && 'data' in payload) {
          this.cache.set(key, payload);
          this.saveToDisk();
          return { rev: payload.rev, data: payload.data };
        }
        return cached ? { rev: cached.rev, data: cached.data as T } : null;
      } catch (err) {
        this.handlePgError(err);
      }
    }
    return cached ? { rev: cached.rev, data: cached.data as T } : null;
  }

  async put<T>(key: string, data: T, expectedRev: number | null): Promise<{ ok: true; rev: number } | { ok: false }> {
    const current = this.cache.get(key);
    if (expectedRev === null) {
      if (current) return { ok: false };
    } else if (current && current.rev !== expectedRev) {
      return { ok: false };
    }
    const rev = (expectedRev ?? 0) + 1;
    const envelope: Envelope<T> = { rev, data };
    this.cache.set(key, envelope);
    if (key !== KEY_LEASE) {
      this.saveToDisk();
    }

    if (this.canUsePg()) {
      const payload = JSON.stringify(envelope);
      try {
        await this.queryWithRetry(
          `INSERT INTO config_history (config_version_id, applied_at, is_active_champion, previous_champion_id, config_payload_json, change_summary)
           VALUES ($1, NOW(), FALSE, NULL, $2::jsonb, $3)
           ON CONFLICT (config_version_id) DO UPDATE
           SET config_payload_json = EXCLUDED.config_payload_json, applied_at = NOW(), change_summary = EXCLUDED.change_summary`,
          [key, payload, 'paper-v2']
        );
      } catch (err) {
        this.handlePgError(err);
      }
    }
    return { ok: true, rev };
  }
}

let pool: pg.Pool | null = null;
let singletonStore: ResilientKvStore | null = null;

export function databaseConfigured(): boolean {
  return Boolean(
    process.env.DATABASE_URL_RW ||
      process.env.DATABASE_URL_RO ||
      process.env.DATABASE_URL ||
      fs.existsSync(DISK_STORE_PATH)
  );
}

export function createStore(): KvStore {
  if (singletonStore) return singletonStore;
  const url = process.env.DATABASE_URL_RW || process.env.DATABASE_URL_RO || process.env.DATABASE_URL || '';
  if (url && !pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: 2,
      idleTimeoutMillis: 15_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
    });
    pool.on('error', (err) => {
      console.warn('[pg.Pool] Idle client connection closed by server:', err.message);
    });
  }
  singletonStore = new ResilientKvStore(pool);
  return singletonStore;
}

export const KEY_ACTIVE = 'PAPER_V2:ACTIVE';
export const KEY_LEASE = 'PAPER_V2:LEASE';
export const KEY_INSTRUMENTS = 'PAPER_V2:INSTRUMENTS';

export const stateKey = (ledgerId: string) => `PAPER_V2:${ledgerId}:STATE`;
export const tradesKey = (ledgerId: string, month: string) => `PAPER_V2:${ledgerId}:TRADES:${month}`;
export const candidatesKey = (ledgerId: string, month: string) => `PAPER_V2:${ledgerId}:CANDIDATES:${month}`;
export const equityKey = (ledgerId: string, month: string) => `PAPER_V2:${ledgerId}:EQUITY:${month}`;
