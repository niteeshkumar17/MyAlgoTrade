/**
 * Angel One SmartAPI client.
 * Quotes keep the real bid and ask. A missing order-book side stays at 0; nothing is invented from the LTP.
 * The login token lives in process memory only and is never written to the database.
 */

import crypto from 'node:crypto';

import { calendarDaysBetween, istDate, parseAngelExpiry, parseAngelFeedTime } from './clock.js';
import type { AngelStatusSnapshot, Candle, LegQuote, NfoInstrument, OptionRight, SpotQuote } from './types.js';
import { UNDERLYINGS } from './types.js';

export interface AngelOneTokenMeta {
  symbol: string;
  angelToken: string;
  tradingSymbol: string;
  exchange: 'NSE' | 'NFO';
}

export const ANGEL_ONE_NSE_TOKENS: Record<string, AngelOneTokenMeta> = {
  NIFTY: { symbol: 'NIFTY', angelToken: '99926000', tradingSymbol: 'Nifty 50', exchange: 'NSE' },
  BANKNIFTY: { symbol: 'BANKNIFTY', angelToken: '99926009', tradingSymbol: 'Nifty Bank', exchange: 'NSE' },
  FINNIFTY: { symbol: 'FINNIFTY', angelToken: '99926037', tradingSymbol: 'Nifty Fin Service', exchange: 'NSE' },
  MIDCPNIFTY: { symbol: 'MIDCPNIFTY', angelToken: '99926074', tradingSymbol: 'NIFTY MID SELECT', exchange: 'NSE' },
  INDIA_VIX: { symbol: 'INDIA_VIX', angelToken: '99926017', tradingSymbol: 'India VIX', exchange: 'NSE' },
  RELIANCE: { symbol: 'RELIANCE', angelToken: '2885', tradingSymbol: 'RELIANCE-EQ', exchange: 'NSE' },
  TCS: { symbol: 'TCS', angelToken: '11536', tradingSymbol: 'TCS-EQ', exchange: 'NSE' },
  HDFCBANK: { symbol: 'HDFCBANK', angelToken: '1333', tradingSymbol: 'HDFCBANK-EQ', exchange: 'NSE' },
  INFY: { symbol: 'INFY', angelToken: '1594', tradingSymbol: 'INFY-EQ', exchange: 'NSE' },
  ICICIBANK: { symbol: 'ICICIBANK', angelToken: '4963', tradingSymbol: 'ICICIBANK-EQ', exchange: 'NSE' },
  SBIN: { symbol: 'SBIN', angelToken: '3045', tradingSymbol: 'SBIN-EQ', exchange: 'NSE' },
  BHARTIARTL: { symbol: 'BHARTIARTL', angelToken: '10604', tradingSymbol: 'BHARTIARTL-EQ', exchange: 'NSE' },
  ITC: { symbol: 'ITC', angelToken: '1660', tradingSymbol: 'ITC-EQ', exchange: 'NSE' },
  KOTAKBANK: { symbol: 'KOTAKBANK', angelToken: '1922', tradingSymbol: 'KOTAKBANK-EQ', exchange: 'NSE' },
  LT: { symbol: 'LT', angelToken: '11483', tradingSymbol: 'LT-EQ', exchange: 'NSE' },
  AXISBANK: { symbol: 'AXISBANK', angelToken: '5900', tradingSymbol: 'AXISBANK-EQ', exchange: 'NSE' },
  BAJFINANCE: { symbol: 'BAJFINANCE', angelToken: '317', tradingSymbol: 'BAJFINANCE-EQ', exchange: 'NSE' },
  MARUTI: { symbol: 'MARUTI', angelToken: '10999', tradingSymbol: 'MARUTI-EQ', exchange: 'NSE' },
  ASIANPAINT: { symbol: 'ASIANPAINT', angelToken: '236', tradingSymbol: 'ASIANPAINT-EQ', exchange: 'NSE' },
  SUNPHARMA: { symbol: 'SUNPHARMA', angelToken: '3351', tradingSymbol: 'SUNPHARMA-EQ', exchange: 'NSE' },
  TITAN: { symbol: 'TITAN', angelToken: '3506', tradingSymbol: 'TITAN-EQ', exchange: 'NSE' },
  ULTRACEMCO: { symbol: 'ULTRACEMCO', angelToken: '11532', tradingSymbol: 'ULTRACEMCO-EQ', exchange: 'NSE' },
  TATASTEEL: { symbol: 'TATASTEEL', angelToken: '3499', tradingSymbol: 'TATASTEEL-EQ', exchange: 'NSE' },
  NTPC: { symbol: 'NTPC', angelToken: '11630', tradingSymbol: 'NTPC-EQ', exchange: 'NSE' },
  'M&M': { symbol: 'M&M', angelToken: '2031', tradingSymbol: 'M&M-EQ', exchange: 'NSE' },
  POWERGRID: { symbol: 'POWERGRID', angelToken: '14977', tradingSymbol: 'POWERGRID-EQ', exchange: 'NSE' },
  ADANIENT: { symbol: 'ADANIENT', angelToken: '25', tradingSymbol: 'ADANIENT-EQ', exchange: 'NSE' },
  BAJAJFINSV: { symbol: 'BAJAJFINSV', angelToken: '16675', tradingSymbol: 'BAJAJFINSV-EQ', exchange: 'NSE' },
  WIPRO: { symbol: 'WIPRO', angelToken: '3787', tradingSymbol: 'WIPRO-EQ', exchange: 'NSE' },
  COALINDIA: { symbol: 'COALINDIA', angelToken: '20374', tradingSymbol: 'COALINDIA-EQ', exchange: 'NSE' },
  JSWSTEEL: { symbol: 'JSWSTEEL', angelToken: '11723', tradingSymbol: 'JSWSTEEL-EQ', exchange: 'NSE' },
  HINDALCO: { symbol: 'HINDALCO', angelToken: '1363', tradingSymbol: 'HINDALCO-EQ', exchange: 'NSE' },
  ONGC: { symbol: 'ONGC', angelToken: '2475', tradingSymbol: 'ONGC-EQ', exchange: 'NSE' },
  GRASIM: { symbol: 'GRASIM', angelToken: '1232', tradingSymbol: 'GRASIM-EQ', exchange: 'NSE' },
  TECHM: { symbol: 'TECHM', angelToken: '13538', tradingSymbol: 'TECHM-EQ', exchange: 'NSE' },
  HCLTECH: { symbol: 'HCLTECH', angelToken: '7229', tradingSymbol: 'HCLTECH-EQ', exchange: 'NSE' },
};

const ANGEL_BASE_URL = 'https://apiconnect.angelone.in';
const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const UNDERLYING_SET = new Set<string>(UNDERLYINGS);
const QUOTE_BATCH = 50;

let cachedJwtToken: string | null = null;
let jwtExpiresAtMs = 0;
let lastLoginAtIso: string | null = null;
let lastQuoteFetchAtIso: string | null = null;
let lastAngelError: string | null = null;

function decodeBase32(base32Raw: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = base32Raw.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = alphabet.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateAngelTotp(base32Secret: string, timestampMs: number = Date.now()): string {
  const key = decodeBase32(base32Secret);
  const counter = Math.floor(timestampMs / 1000 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binary % 1_000_000).toString().padStart(6, '0');
}

export function angelCredentialsConfigured(): boolean {
  return Boolean(
    process.env.ANGEL_API_KEY &&
      process.env.ANGEL_CLIENT_CODE &&
      process.env.ANGEL_MPIN &&
      process.env.ANGEL_TOTP_SECRET
  );
}

function credentials() {
  return {
    apiKey: (process.env.ANGEL_API_KEY || '').trim(),
    clientCode: (process.env.ANGEL_CLIENT_CODE || '').trim(),
    mpin: (process.env.ANGEL_MPIN || '').trim(),
    totpSecret: (process.env.ANGEL_TOTP_SECRET || '').trim(),
    configured: angelCredentialsConfigured(),
  };
}

function headers(apiKey: string, jwtToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '02:00:00:00:00:01',
    'X-PrivateKey': apiKey,
  };
  if (jwtToken) h.Authorization = jwtToken.startsWith('Bearer ') ? jwtToken : `Bearer ${jwtToken}`;
  return h;
}

export function getAngelStatus(): AngelStatusSnapshot {
  return {
    configured: angelCredentialsConfigured(),
    authenticated: Boolean(cachedJwtToken && Date.now() < jwtExpiresAtMs),
    lastLoginAt: lastLoginAtIso,
    lastQuoteFetchAt: lastQuoteFetchAtIso,
    lastError: lastAngelError,
  };
}

export async function ensureAngelOneSession(forceRefresh = false): Promise<string | null> {
  const { apiKey, clientCode, mpin, totpSecret, configured } = credentials();
  if (!configured) {
    lastAngelError = 'Angel One credentials are not set';
    return null;
  }
  const now = Date.now();
  if (!forceRefresh && cachedJwtToken && now < jwtExpiresAtMs) return cachedJwtToken;
  try {
    const res = await fetch(`${ANGEL_BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ clientcode: clientCode, password: mpin, totp: generateAngelTotp(totpSecret, now) }),
      signal: AbortSignal.timeout(8000),
    });
    const payload = (await res.json()) as {
      status?: boolean;
      message?: string;
      errorcode?: string;
      data?: { jwtToken?: string };
    };
    if (!res.ok || !payload.status || !payload.data?.jwtToken) {
      lastAngelError = payload.message || payload.errorcode || `Angel login HTTP ${res.status}`;
      cachedJwtToken = null;
      return null;
    }
    cachedJwtToken = payload.data.jwtToken;
    jwtExpiresAtMs = now + 18 * 60 * 60 * 1000;
    lastLoginAtIso = new Date(now).toISOString();
    lastAngelError = null;
    return cachedJwtToken;
  } catch (err) {
    lastAngelError = err instanceof Error ? err.message : 'Angel login failed';
    return null;
  }
}

interface RawQuote {
  symbolToken?: string;
  ltp?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  percentChange?: number;
  tradeVolume?: number;
  opnInterest?: number;
  exchFeedTime?: string;
  exchTradeTime?: string;
  depth?: {
    buy?: Array<{ price?: number | string }>;
    sell?: Array<{ price?: number | string }>;
  };
}

function depthPrice(level: { price?: number | string } | undefined): number {
  const n = Number(level?.price ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toLegQuote(item: RawQuote): LegQuote | null {
  const token = String(item.symbolToken ?? '');
  if (!token) return null;
  const bid = depthPrice(item.depth?.buy?.[0]);
  const ask = depthPrice(item.depth?.sell?.[0]);
  return {
    token,
    ltp: Number(item.ltp ?? 0),
    bid,
    ask,
    hasDepth: bid > 0 || ask > 0,
    feedTimeMs: parseAngelFeedTime(item.exchFeedTime || item.exchTradeTime),
    volume: Number(item.tradeVolume ?? 0),
    oi: Number(item.opnInterest ?? 0),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let lastQuoteCallMs = 0;
let quoteMutex: Promise<unknown> = Promise.resolve();

function enqueueQuoteCall<T>(fn: () => Promise<T>): Promise<T> {
  const next = quoteMutex.then(async () => {
    const elapsed = Date.now() - lastQuoteCallMs;
    if (elapsed < 180) await sleep(180 - elapsed);
    lastQuoteCallMs = Date.now();
    return fn();
  });
  quoteMutex = next.catch(() => undefined);
  return next;
}

async function fetchQuoteBatch(exchange: 'NSE' | 'NFO', tokens: string[]): Promise<RawQuote[] | null> {
  const { apiKey, configured } = credentials();
  if (!configured || tokens.length === 0) return tokens.length === 0 ? [] : null;
  let jwt = await ensureAngelOneSession(false);
  if (!jwt) return null;

  return enqueueQuoteCall(async () => {
    const call = async (token: string) => {
      const res = await fetch(`${ANGEL_BASE_URL}/rest/secure/angelbroking/market/v1/quote/`, {
        method: 'POST',
        headers: headers(apiKey, token),
        body: JSON.stringify({ mode: 'FULL', exchangeTokens: { [exchange]: tokens } }),
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      if (!text.startsWith('{')) {
        return { res, data: { status: false, message: text.slice(0, 120) }, rateLimited: res.status === 403 || text.includes('exceeding access rate') };
      }
      const data = JSON.parse(text) as {
        status?: boolean;
        message?: string;
        errorcode?: string;
        data?: { fetched?: RawQuote[] };
      };
      return { res, data, rateLimited: res.status === 403 || data.errorcode === 'AB1004' };
    };

    try {
      let { res, data, rateLimited } = await call(jwt!);
      if (rateLimited) {
        await sleep(500);
        ({ res, data, rateLimited } = await call(jwt!));
      }
      if (!data.status && (data.errorcode === 'AG8001' || res.status === 401)) {
        jwt = await ensureAngelOneSession(true);
        if (!jwt) return null;
        ({ res, data } = await call(jwt));
      }
      if (!data.status || !Array.isArray(data.data?.fetched)) {
        lastAngelError = data.message || data.errorcode || 'Angel quote fetch failed';
        return null;
      }
      lastQuoteFetchAtIso = new Date().toISOString();
      lastAngelError = null;
      return data.data.fetched;
    } catch (err) {
      lastAngelError = err instanceof Error ? err.message : 'Angel quote fetch failed';
      return null;
    }
  });
}

let cachedSpotQuotes: { atMs: number; data: Record<string, SpotQuote> } | null = null;
let inflightSpotQuotes: Promise<Record<string, SpotQuote> | null> | null = null;

export async function fetchSpotQuotes(): Promise<Record<string, SpotQuote> | null> {
  const now = Date.now();
  if (cachedSpotQuotes && now - cachedSpotQuotes.atMs < 2200) {
    return cachedSpotQuotes.data;
  }
  if (inflightSpotQuotes) return inflightSpotQuotes;

  inflightSpotQuotes = (async () => {
    const metas = Object.values(ANGEL_ONE_NSE_TOKENS);
    const fetched = await fetchQuoteBatch('NSE', metas.map((m) => m.angelToken));
    if (!fetched) return cachedSpotQuotes?.data ?? null;
    const byToken = new Map(metas.map((m) => [m.angelToken, m.symbol]));
    const out: Record<string, SpotQuote> = {};
    for (const item of fetched) {
      const symbol = byToken.get(String(item.symbolToken ?? ''));
      const ltp = Number(item.ltp ?? 0);
      if (!symbol || !(ltp > 0)) continue;
      const prevClose = Number(item.close ?? ltp);
      out[symbol] = {
        symbol,
        ltp,
        open: Number(item.open ?? ltp),
        high: Number(item.high ?? ltp),
        low: Number(item.low ?? ltp),
        prevClose,
        changePct:
          typeof item.percentChange === 'number'
            ? item.percentChange
            : prevClose > 0
              ? ((ltp - prevClose) / prevClose) * 100
              : 0,
        feedTimeMs: parseAngelFeedTime(item.exchFeedTime || item.exchTradeTime),
      };
    }
    if (Object.keys(out).length > 0) {
      cachedSpotQuotes = { atMs: Date.now(), data: out };
    }
    return out;
  })().finally(() => {
    inflightSpotQuotes = null;
  });

  return inflightSpotQuotes;
}

const optionQuoteCache = new Map<string, { atMs: number; quote: LegQuote }>();

export async function fetchOptionQuotes(tokens: string[]): Promise<Record<string, LegQuote> | null> {
  const unique = [...new Set(tokens.filter(Boolean))];
  if (unique.length === 0) return {};
  const now = Date.now();
  const out: Record<string, LegQuote> = {};
  const missing: string[] = [];

  for (const t of unique) {
    const hit = optionQuoteCache.get(t);
    if (hit && now - hit.atMs < 2200) {
      out[t] = hit.quote;
    } else {
      missing.push(t);
    }
  }
  if (missing.length === 0) return out;

  for (let i = 0; i < missing.length; i += QUOTE_BATCH) {
    const batch = missing.slice(i, i + QUOTE_BATCH);
    const fetched = await fetchQuoteBatch('NFO', batch);
    if (!fetched) {
      for (const t of batch) {
        const stale = optionQuoteCache.get(t);
        if (stale) out[t] = stale.quote;
      }
      return Object.keys(out).length > 0 ? out : null;
    }
    const fetchedTime = Date.now();
    for (const item of fetched) {
      const leg = toLegQuote(item);
      if (leg) {
        out[leg.token] = leg;
        optionQuoteCache.set(leg.token, { atMs: fetchedTime, quote: leg });
      }
    }
  }
  return out;
}

export type AngelCandleInterval = 'ONE_MINUTE' | 'FIVE_MINUTE' | 'FIFTEEN_MINUTE' | 'ONE_HOUR' | 'ONE_DAY';

const candleCache = new Map<string, { atMs: number; hourSlot: number; candles: Candle[] }>();
const inflightCandleRequests = new Map<string, Promise<Candle[] | null>>();
let lastCandleCallMs = 0;
let candleMutex: Promise<unknown> = Promise.resolve();

function currentIstHourSlot(nowMs = Date.now()): number {
  return Math.floor((nowMs + 5.5 * 3600_000 - 15 * 60_000) / 3600_000);
}

function enqueueCandleCall<T>(fn: () => Promise<T>): Promise<T> {
  const next = candleMutex.then(async () => {
    const elapsed = Date.now() - lastCandleCallMs;
    if (elapsed < 360) await sleep(360 - elapsed);
    lastCandleCallMs = Date.now();
    return fn();
  });
  candleMutex = next.catch(() => undefined);
  return next;
}

export async function fetchCandlesByToken(
  exchange: 'NSE' | 'NFO',
  symbolToken: string,
  interval: AngelCandleInterval,
  fromIst: string,
  toIst: string
): Promise<Candle[] | null> {
  const { apiKey, configured } = credentials();
  if (!configured || !symbolToken) return null;

  const cacheKey = `${exchange}:${symbolToken}:${interval}`;
  const ttlMs = interval === 'ONE_MINUTE' ? 8_000 : interval === 'FIVE_MINUTE' ? 15_000 : 30_000;
  const cached = candleCache.get(cacheKey);
  if (cached && Date.now() - cached.atMs < ttlMs) {
    return cached.candles;
  }

  const existing = inflightCandleRequests.get(cacheKey);
  if (existing) return existing;

  const promise = enqueueCandleCall(async () => {
    const hitAfterWait = candleCache.get(cacheKey);
    if (hitAfterWait && Date.now() - hitAfterWait.atMs < ttlMs) {
      return hitAfterWait.candles;
    }

    let jwt = await ensureAngelOneSession(false);
    if (!jwt) return cached?.candles ?? null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${ANGEL_BASE_URL}/rest/secure/angelbroking/historical/v1/getCandleData`, {
          method: 'POST',
          headers: headers(apiKey, jwt ?? undefined),
          body: JSON.stringify({
            exchange,
            symboltoken: symbolToken,
            interval,
            fromdate: fromIst,
            todate: toIst,
          }),
          signal: AbortSignal.timeout(8000),
        });
        const text = await res.text();
        if (res.status === 403 || text.includes('exceeding access rate')) {
          await sleep(650 * (attempt + 1));
          lastCandleCallMs = Date.now();
          continue;
        }
        if (res.status === 401) {
          jwt = await ensureAngelOneSession(true);
          if (!jwt) break;
          continue;
        }
        if (!text.startsWith('{')) break;
        const payload = JSON.parse(text) as {
          status?: boolean;
          errorcode?: string;
          data?: Array<[string, number, number, number, number, number]>;
        };
        if (payload.errorcode === 'AB1004') {
          await sleep(650 * (attempt + 1));
          lastCandleCallMs = Date.now();
          continue;
        }
        if (!payload.status || !Array.isArray(payload.data) || payload.data.length === 0) {
          return cached?.candles ?? null;
        }
        const rows: Candle[] = payload.data.map((row) => ({
          time: String(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5] ?? 0),
        }));
        const now = Date.now();
        candleCache.set(cacheKey, { atMs: now, hourSlot: currentIstHourSlot(now), candles: rows });
        return rows;
      } catch (err) {
        lastAngelError = err instanceof Error ? err.message : 'Angel candle fetch failed';
        if (attempt < 2) await sleep(500);
      }
    }
    return cached?.candles ?? null;
  }).finally(() => {
    inflightCandleRequests.delete(cacheKey);
  });

  inflightCandleRequests.set(cacheKey, promise);
  return promise;
}

export async function fetchHourlyCandles(symbol: string, fromIst: string, toIst: string): Promise<Candle[] | null> {
  const meta = ANGEL_ONE_NSE_TOKENS[symbol];
  if (!meta) return null;
  const cacheKey = `${meta.exchange}:${meta.angelToken}:ONE_HOUR`;
  const now = Date.now();
  const slot = currentIstHourSlot(now);
  const cached = candleCache.get(cacheKey);
  // Completed hourly bars only advance at :15 past each hour; reuse within the same :15 slot
  if (cached && cached.hourSlot === slot && cached.candles.length >= 60) {
    return cached.candles;
  }
  return fetchCandlesByToken(meta.exchange, meta.angelToken, 'ONE_HOUR', fromIst, toIst);
}

/**
 * Keep option contracts we can actually trade: our underlyings, expiry inside the next 60 days,
 * and strikes near the current spot when we know it. Strike and tick in the master file are in paise.
 */
export function filterScripMaster(
  rows: unknown[],
  nowMs: number,
  spotByUnderlying: Record<string, number> = {}
): NfoInstrument[] {
  const today = istDate(nowMs);
  const out: NfoInstrument[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    if (row.exch_seg !== 'NFO') continue;
    if (row.instrumenttype !== 'OPTIDX' && row.instrumenttype !== 'OPTSTK') continue;
    const underlying = String(row.name ?? '');
    if (!UNDERLYING_SET.has(underlying)) continue;
    const expiry = parseAngelExpiry(String(row.expiry ?? ''));
    if (!expiry) continue;
    const dte = calendarDaysBetween(today, expiry);
    if (dte < 0 || dte > 60) continue;
    const symbol = String(row.symbol ?? '');
    const right: OptionRight | null = symbol.endsWith('CE') ? 'CE' : symbol.endsWith('PE') ? 'PE' : null;
    if (!right) continue;
    const strike = Number(row.strike) / 100;
    const lotSize = Number(row.lotsize);
    if (!(strike > 0) || !(lotSize > 0)) continue;
    const spot = spotByUnderlying[underlying];
    if (spot > 0 && (strike < spot * 0.88 || strike > spot * 1.12)) continue;
    out.push({
      token: String(row.token),
      symbol,
      underlying,
      expiry,
      strike,
      right,
      lotSize,
      tickSize: Number(row.tick_size) / 100 || 0.05,
    });
  }
  return out;
}

let cachedInstrumentMaster: { atMs: number; instruments: NfoInstrument[] } | null = null;
let inflightInstrumentMaster: Promise<NfoInstrument[] | null> | null = null;

export async function downloadInstrumentMaster(
  nowMs: number,
  spotByUnderlying: Record<string, number> = {}
): Promise<NfoInstrument[] | null> {
  if (cachedInstrumentMaster && Date.now() - cachedInstrumentMaster.atMs < 20 * 60_000) {
    return cachedInstrumentMaster.instruments;
  }
  if (inflightInstrumentMaster) return inflightInstrumentMaster;

  inflightInstrumentMaster = (async () => {
    try {
      const res = await fetch(SCRIP_MASTER_URL, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        lastAngelError = `Instrument master HTTP ${res.status}`;
        return cachedInstrumentMaster?.instruments ?? null;
      }
      const rows = (await res.json()) as unknown[];
      if (!Array.isArray(rows)) return cachedInstrumentMaster?.instruments ?? null;
      const filtered = filterScripMaster(rows, nowMs, spotByUnderlying);
      if (filtered.length > 0) {
        cachedInstrumentMaster = { atMs: Date.now(), instruments: filtered };
      }
      return filtered;
    } catch (err) {
      lastAngelError = err instanceof Error ? err.message : 'Instrument master download failed';
      return cachedInstrumentMaster?.instruments ?? null;
    }
  })().finally(() => {
    inflightInstrumentMaster = null;
  });

  return inflightInstrumentMaster;
}

