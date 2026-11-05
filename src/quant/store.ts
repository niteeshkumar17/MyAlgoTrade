/**
 * Small key-value store on top of the existing config_history table.
 * Writes carry a revision and succeed only if that revision is still current, so two overlapping
 * cycles cannot both commit. The in-memory store is used in tests and when no database is configured.
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { isWithinSessionHours } from './clock.js';

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
  private pgFetchedAt = new Map<string, number>();
  private pgDisabledUntilMs = 0;
  private diskMtimeMs = 0;

  constructor(private pool: pg.Pool | null) {
    this.loadFromDisk();
    if (this.pool) {
      this.ensureSchema().catch((err) => {
        console.warn('[ResilientKvStore] ensureSchema error:', err instanceof Error ? err.message : err);
      });
    }
  }

  private async ensureSchema() {
    if (!this.pool) return;
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS config_history (
          config_version_id VARCHAR PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          is_active_champion BOOLEAN NOT NULL DEFAULT FALSE,
          previous_champion_id VARCHAR,
          config_payload_json JSONB NOT NULL,
          change_summary TEXT
        )
      `);
    } catch (err) {
      this.handlePgError(err);
    }
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(DISK_STORE_PATH)) {
        const stat = fs.statSync(DISK_STORE_PATH);
        const raw = fs.readFileSync(DISK_STORE_PATH, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, Envelope<unknown>>;
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v.rev === 'number' && 'data' in v) {
            this.cache.set(k, v);
          }
        }
        this.diskMtimeMs = stat.mtimeMs;
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
      this.diskMtimeMs = fs.statSync(DISK_STORE_PATH).mtimeMs;
    } catch {
      // ignore disk write error on read-only fs
    }
  }

  private canUsePg(): boolean {
    return Boolean(this.pool) && Date.now() >= this.pgDisabledUntilMs;
  }

  private ttlForKey(key: string): number {
    if (key === KEY_LEASE) return 0;
    if (key === KEY_INSTRUMENTS) return 3_600_000; // 1 hour for 898KB instrument master
    if (key === KEY_ACTIVE) return 60_000; // 60s for active ledger pointer
    return isWithinSessionHours(Date.now()) ? 3_000 : 60_000; // 3s during live NSE hours, 60s during off-hours
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
    if (!this.canUsePg()) {
      try {
        if (fs.existsSync(DISK_STORE_PATH) && fs.statSync(DISK_STORE_PATH).mtimeMs > this.diskMtimeMs) {
          this.loadFromDisk();
        }
      } catch {
        // ignore stat error
      }
    }
    const cached = this.cache.get(key);
    const fetchedAt = this.pgFetchedAt.get(key) ?? 0;
    const ttl = this.ttlForKey(key);

    if (this.canUsePg()) {
      if (cached && fetchedAt > 0 && ttl > 0 && Date.now() - fetchedAt < ttl) {
        return { rev: cached.rev, data: cached.data as T };
      }
      try {
        const res = await this.queryWithRetry(
          `SELECT config_payload_json FROM config_history WHERE config_version_id = $1`,
          [key]
        );
        const payload = res.rows[0]?.config_payload_json as Envelope<T> | undefined;
        if (payload && typeof payload.rev === 'number' && 'data' in payload) {
          this.cache.set(key, payload);
          this.pgFetchedAt.set(key, Date.now());
          this.saveToDisk();
          return { rev: payload.rev, data: payload.data };
        }
        return null;
      } catch (err) {
        this.handlePgError(err);
      }
    }
    return cached ? { rev: cached.rev, data: cached.data as T } : null;
  }

  async put<T>(key: string, data: T, expectedRev: number | null): Promise<{ ok: true; rev: number } | { ok: false }> {
    if (this.canUsePg()) {
      const rev = (expectedRev ?? 0) + 1;
      const envelope: Envelope<T> = { rev, data };
      const payload = JSON.stringify(envelope);
      try {
        const res = await this.queryWithRetry(
          `INSERT INTO config_history (config_version_id, applied_at, is_active_champion, previous_champion_id, config_payload_json, change_summary)
           VALUES ($1, NOW(), FALSE, NULL, $2::jsonb, $3)
           ON CONFLICT (config_version_id) DO UPDATE
           SET config_payload_json = EXCLUDED.config_payload_json, applied_at = NOW(), change_summary = EXCLUDED.change_summary
           WHERE $4::int IS NULL OR (config_history.config_payload_json->>'rev')::int = $4::int`,
          [key, payload, 'paper-v2', expectedRev]
        );
        if (res.rowCount === 0) {
          this.cache.delete(key);
          this.pgFetchedAt.delete(key);
          return { ok: false };
        }
        this.cache.set(key, envelope);
        this.pgFetchedAt.set(key, Date.now());
        if (key !== KEY_LEASE) {
          this.saveToDisk();
        }
        return { ok: true, rev };
      } catch (err) {
        this.handlePgError(err);
      }
    }

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
