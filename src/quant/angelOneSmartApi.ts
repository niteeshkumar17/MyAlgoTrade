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
  INDIA_VIX: { symbol: 'INDIA_VIX', angelToken: '99926017', tradingSymbol: 'India VIX', exchange: 'NSE' },
  RELIANCE: { symbol: 'RELIANCE', angelToken: '2885', tradingSymbol: 'RELIANCE-EQ', exchange: 'NSE' },
  TCS: { symbol: 'TCS', angelToken: '11536', tradingSymbol: 'TCS-EQ', exchange: 'NSE' },
  HDFCBANK: { symbol: 'HDFCBANK', angelToken: '1333', tradingSymbol: 'HDFCBANK-EQ', exchange: 'NSE' },
  INFY: { symbol: 'INFY', angelToken: '1594', tradingSymbol: 'INFY-EQ', exchange: 'NSE' },
  ICICIBANK: { symbol: 'ICICIBANK', angelToken: '4963', tradingSymbol: 'ICICIBANK-EQ', exchange: 'NSE' },
  SBIN: { symbol: 'SBIN', angelToken: '3045', tradingSymbol: 'SBIN-EQ', exchange: 'NSE' },
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

async function fetchQuoteBatch(exchange: 'NSE' | 'NFO', tokens: string[]): Promise<RawQuote[] | null> {
  const { apiKey, configured } = credentials();
  if (!configured || tokens.length === 0) return tokens.length === 0 ? [] : null;
  let jwt = await ensureAngelOneSession(false);
  if (!jwt) return null;

  const call = async (token: string) => {
    const res = await fetch(`${ANGEL_BASE_URL}/rest/secure/angelbroking/market/v1/quote/`, {
      method: 'POST',
      headers: headers(apiKey, token),
      body: JSON.stringify({ mode: 'FULL', exchangeTokens: { [exchange]: tokens } }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as {
      status?: boolean;
      message?: string;
      errorcode?: string;
      data?: { fetched?: RawQuote[] };
    };
    return { res, data };
  };

  try {
    let { res, data } = await call(jwt);
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
}

export async function fetchSpotQuotes(): Promise<Record<string, SpotQuote> | null> {
  const metas = Object.values(ANGEL_ONE_NSE_TOKENS);
  const fetched = await fetchQuoteBatch('NSE', metas.map((m) => m.angelToken));
  if (!fetched) return null;
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
  return out;
}

export async function fetchOptionQuotes(tokens: string[]): Promise<Record<string, LegQuote> | null> {
  const unique = [...new Set(tokens.filter(Boolean))];
  const out: Record<string, LegQuote> = {};
  for (let i = 0; i < unique.length; i += QUOTE_BATCH) {
    const batch = unique.slice(i, i + QUOTE_BATCH);
    const fetched = await fetchQuoteBatch('NFO', batch);
    if (!fetched) return null;
    for (const item of fetched) {
      const leg = toLegQuote(item);
      if (leg) out[leg.token] = leg;
    }
  }
  return out;
}

export async function fetchHourlyCandles(symbol: string, fromIst: string, toIst: string): Promise<Candle[] | null> {
  const { apiKey, configured } = credentials();
  const meta = ANGEL_ONE_NSE_TOKENS[symbol];
  if (!configured || !meta) return null;
  const jwt = await ensureAngelOneSession(false);
  if (!jwt) return null;
  try {
    const res = await fetch(`${ANGEL_BASE_URL}/rest/secure/angelbroking/historical/v1/getCandleData`, {
      method: 'POST',
      headers: headers(apiKey, jwt),
      body: JSON.stringify({
        exchange: meta.exchange,
        symboltoken: meta.angelToken,
        interval: 'ONE_HOUR',
        fromdate: fromIst,
        todate: toIst,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    if (!text.startsWith('{')) return null;
    const payload = JSON.parse(text) as { status?: boolean; data?: Array<[string, number, number, number, number, number]> };
    if (!payload.status || !Array.isArray(payload.data)) return null;
    return payload.data.map((row) => ({
      time: String(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5] ?? 0),
    }));
  } catch (err) {
    lastAngelError = err instanceof Error ? err.message : 'Angel candle fetch failed';
    return null;
  }
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

export async function downloadInstrumentMaster(
  nowMs: number,
  spotByUnderlying: Record<string, number> = {}
): Promise<NfoInstrument[] | null> {
  try {
    const res = await fetch(SCRIP_MASTER_URL, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      lastAngelError = `Instrument master HTTP ${res.status}`;
      return null;
    }
    const rows = (await res.json()) as unknown[];
    if (!Array.isArray(rows)) return null;
    return filterScripMaster(rows, nowMs, spotByUnderlying);
  } catch (err) {
    lastAngelError = err instanceof Error ? err.message : 'Instrument master download failed';
    return null;
  }
}
