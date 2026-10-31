/**
 * Angel One SmartAPI Market Data Integration (Zero-Cost Live NSE Feed)
 *
 * Uses the official Angel One SmartAPI REST endpoints (`https://apiconnect.angelone.in`)
 * for ALL market data types:
 *   1. Auto-Login (`loginByPassword`) with native RFC-6238 Base32 TOTP generation
 *   2. Live NSE Spot, Index & INDIA VIX Quotes + 5-Level Orderbook Depth (`market/v1/quote/`, mode="FULL")
 *   3. Live NSE F&O Option Greeks & Implied Volatility (`marketData/v1/optionGreek`)
 *   4. Intraday 5-Minute OHLCV Candles (`historical/v1/getCandleData`)
 *
 * Credentials are read strictly from server environment variables:
 *   - ANGEL_API_KEY       (SmartAPI Market Feed / Trading API Key)
 *   - ANGEL_CLIENT_CODE   (Angel One Client ID, e.g. A123456)
 *   - ANGEL_MPIN          (4-digit Angel One MPIN / Password)
 *   - ANGEL_TOTP_SECRET   (Base32 TOTP secret from Angel One SmartAPI "Enable TOTP" screen)
 */

import crypto from 'node:crypto';

export interface AngelOneTokenMeta {
  symbol: string;
  angelToken: string;
  tradingSymbol: string;
  exchange: 'NSE' | 'NFO';
}

export const ANGEL_ONE_NSE_TOKENS: Record<string, AngelOneTokenMeta> = {
  NIFTY: {
    symbol: 'NIFTY',
    angelToken: '99926000',
    tradingSymbol: 'Nifty 50',
    exchange: 'NSE',
  },
  BANKNIFTY: {
    symbol: 'BANKNIFTY',
    angelToken: '99926009',
    tradingSymbol: 'Nifty Bank',
    exchange: 'NSE',
  },
  FINNIFTY: {
    symbol: 'FINNIFTY',
    angelToken: '99926037',
    tradingSymbol: 'Nifty Fin Service',
    exchange: 'NSE',
  },
  INDIA_VIX: {
    symbol: 'INDIA_VIX',
    angelToken: '99926017',
    tradingSymbol: 'India VIX',
    exchange: 'NSE',
  },
  RELIANCE: {
    symbol: 'RELIANCE',
    angelToken: '2885',
    tradingSymbol: 'RELIANCE-EQ',
    exchange: 'NSE',
  },
  TCS: {
    symbol: 'TCS',
    angelToken: '11536',
    tradingSymbol: 'TCS-EQ',
    exchange: 'NSE',
  },
  HDFCBANK: {
    symbol: 'HDFCBANK',
    angelToken: '1333',
    tradingSymbol: 'HDFCBANK-EQ',
    exchange: 'NSE',
  },
  INFY: {
    symbol: 'INFY',
    angelToken: '1594',
    tradingSymbol: 'INFY-EQ',
    exchange: 'NSE',
  },
  ICICIBANK: {
    symbol: 'ICICIBANK',
    angelToken: '4963',
    tradingSymbol: 'ICICIBANK-EQ',
    exchange: 'NSE',
  },
  SBIN: {
    symbol: 'SBIN',
    angelToken: '3045',
    tradingSymbol: 'SBIN-EQ',
    exchange: 'NSE',
  },
};

export interface AngelOneQuoteItem {
  symbol: string;
  angelToken: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  percentChange: number;
  bestBid: number;
  bestAsk: number;
  spreadPctOfMid: number;
  tradeVolume: number;
  openInterest: number;
  updatedAt: string;
}

export interface AngelOneOptionGreekSummary {
  underlying: string;
  expiryDate: string;
  atmImpliedVolatilityPct: number;
  atmCallDelta: number;
  atmPutDelta: number;
  atmTheta: number;
  atmVega: number;
  updatedAt: string;
}

export interface AngelOneConnectionStatus {
  configured: boolean;
  authenticated: boolean;
  providerName: string;
  clientCodeMasked: string;
  feedMode: 'ANGEL_ONE_SMARTAPI_FULL' | 'FALLBACK_PUBLIC_NSE';
  tokensTracked: number;
  lastLoginAt: string | null;
  lastQuoteFetchAt: string | null;
  lastError: string | null;
}

const ANGEL_BASE_URL = 'https://apiconnect.angelone.in';

let cachedJwtToken: string | null = null;
let cachedFeedToken: string | null = null;
let jwtExpiresAtMs = 0;
let lastLoginAtIso: string | null = null;
let lastQuoteFetchAtIso: string | null = null;
let lastAngelError: string | null = null;
const cachedOptionGreeks: Record<string, AngelOneOptionGreekSummary> = {};

/**
 * Decode standard RFC-4648 Base32 secret string into a Buffer for TOTP HMAC-SHA1.
 */
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

/**
 * Generate a 6-digit RFC-6238 TOTP code from Base32 secret (`ANGEL_TOTP_SECRET`).
 */
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
  const otp = binary % 1_000_000;
  return otp.toString().padStart(6, '0');
}

function getAngelCredentials() {
  const apiKey = (
    process.env.ANGELONE_API_KEY ||
    process.env.ANGEL_API_KEY ||
    process.env.ANGEL_SMARTAPI_KEY ||
    ''
  ).trim();
  const clientCode = (
    process.env.ANGELONE_CLIENT_CODE ||
    process.env.ANGEL_CLIENT_CODE ||
    process.env.ANGEL_CLIENT_ID ||
    ''
  ).trim();
  const mpin = (
    process.env.ANGELONE_MPIN ||
    process.env.ANGEL_MPIN ||
    process.env.ANGEL_PASSWORD ||
    ''
  ).trim();
  const totpSecret = (
    process.env.ANGELONE_TOTP_SECRET ||
    process.env.ANGEL_TOTP_SECRET ||
    ''
  ).trim();
  const configured = Boolean(apiKey && clientCode && mpin && totpSecret);
  return { apiKey, clientCode, mpin, totpSecret, configured };
}

function buildAngelHeaders(apiKey: string, jwtToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '02:00:00:00:00:01',
    'X-PrivateKey': apiKey,
  };
  if (jwtToken) {
    headers.Authorization = jwtToken.startsWith('Bearer ') ? jwtToken : `Bearer ${jwtToken}`;
  }
  return headers;
}

/**
 * Authenticate with Angel One SmartAPI (`loginByPassword`) and cache JWT for 18 hours.
 */
export async function ensureAngelOneSession(forceRefresh: boolean = false): Promise<string | null> {
  const { apiKey, clientCode, mpin, totpSecret, configured } = getAngelCredentials();
  if (!configured) {
    return null;
  }

  const now = Date.now();
  if (!forceRefresh && cachedJwtToken && now < jwtExpiresAtMs) {
    return cachedJwtToken;
  }

  try {
    const totp = generateAngelTotp(totpSecret, now);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);

    const res = await fetch(
      `${ANGEL_BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`,
      {
        method: 'POST',
        headers: buildAngelHeaders(apiKey),
        body: JSON.stringify({
          clientcode: clientCode,
          password: mpin,
          totp,
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);

    const payload = (await res.json()) as {
      status?: boolean;
      message?: string;
      errorcode?: string;
      data?: {
        jwtToken?: string;
        refreshToken?: string;
        feedToken?: string;
      };
    };

    if (!res.ok || !payload?.status || !payload?.data?.jwtToken) {
      lastAngelError =
        payload?.message || payload?.errorcode || `Angel login HTTP ${res.status}`;
      return null;
    }

    cachedJwtToken = payload.data.jwtToken;
    cachedFeedToken = payload.data.feedToken ?? null;
    // Cache JWT for 18 hours (Angel One daily tokens reset at ~05:30 IST)
    jwtExpiresAtMs = now + 18 * 60 * 60 * 1000;
    lastLoginAtIso = new Date(now).toISOString();
    lastAngelError = null;
    return cachedJwtToken;
  } catch (err) {
    lastAngelError = err instanceof Error ? err.message : 'Angel login network error';
    return null;
  }
}

/**
 * Fetch FULL L1/L2 Market Quotes for all 10 NSE symbols (`NIFTY`, `BANKNIFTY`, `FINNIFTY`,
 * `INDIA_VIX`, `RELIANCE`, `TCS`, `HDFCBANK`, `INFY`, `ICICIBANK`, `SBIN`) in a single
 * batched request to Angel One SmartAPI (`market/v1/quote/`).
 */
export async function fetchAngelOneFullMarketQuotes(): Promise<Record<string, AngelOneQuoteItem> | null> {
  const { apiKey, configured } = getAngelCredentials();
  if (!configured) return null;

  let jwt = await ensureAngelOneSession(false);
  if (!jwt) return null;

  const tokenList = Object.values(ANGEL_ONE_NSE_TOKENS).map((t) => t.angelToken);
  const tokenToSymbol = new Map<string, string>();
  for (const [sym, meta] of Object.entries(ANGEL_ONE_NSE_TOKENS)) {
    tokenToSymbol.set(meta.angelToken, sym);
  }

  const executeQuoteCall = async (token: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const response = await fetch(
      `${ANGEL_BASE_URL}/rest/secure/angelbroking/market/v1/quote/`,
      {
        method: 'POST',
        headers: buildAngelHeaders(apiKey, token),
        body: JSON.stringify({
          mode: 'FULL',
          exchangeTokens: {
            NSE: tokenList,
          },
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
    return response;
  };

  try {
    let res = await executeQuoteCall(jwt);
    let data = (await res.json()) as {
      status?: boolean;
      message?: string;
      errorcode?: string;
      data?: {
        fetched?: Array<{
          exchange?: string;
          tradingSymbol?: string;
          symbolToken?: string;
          ltp?: number;
          open?: number;
          high?: number;
          low?: number;
          close?: number;
          percentChange?: number;
          tradeVolume?: number;
          opnInterest?: number;
          depth?: {
            buy?: Array<{ price?: number; quantity?: number; orders?: number }>;
            sell?: Array<{ price?: number; quantity?: number; orders?: number }>;
          };
        }>;
      };
    };

    // Auto-retry once if JWT token expired (AG8001 / Invalid Token)
    if (!data?.status && (data?.errorcode === 'AG8001' || res.status === 401)) {
      jwt = await ensureAngelOneSession(true);
      if (!jwt) return null;
      res = await executeQuoteCall(jwt);
      data = await res.json();
    }

    if (!data?.status || !Array.isArray(data?.data?.fetched)) {
      lastAngelError = data?.message || data?.errorcode || 'Angel quote fetch unsuccessful';
      return null;
    }

    const nowIso = new Date().toISOString();
    lastQuoteFetchAtIso = nowIso;
    lastAngelError = null;

    const results: Record<string, AngelOneQuoteItem> = {};
    for (const item of data.data.fetched) {
      const sym = tokenToSymbol.get(String(item.symbolToken || ''));
      if (!sym) continue;
      const ltp = Number(item.ltp ?? 0);
      if (ltp <= 0) continue;

      const close = Number(item.close ?? ltp);
      const pctChange =
        typeof item.percentChange === 'number'
          ? Number(item.percentChange.toFixed(2))
          : close > 0
          ? Number((((ltp - close) / close) * 100).toFixed(2))
          : 0;

      const rawBid = Number(item.depth?.buy?.[0]?.price ?? 0);
      const rawAsk = Number(item.depth?.sell?.[0]?.price ?? 0);
      const bestBid = rawBid > 0 ? rawBid : Number((ltp * 0.9992).toFixed(2));
      const bestAsk = rawAsk > 0 && rawAsk >= bestBid ? rawAsk : Number((ltp * 1.0008).toFixed(2));
      const mid = (bestBid + bestAsk) / 2;
      const spreadPctOfMid = mid > 0 ? Number(((bestAsk - bestBid) / mid).toFixed(5)) : 0.0016;

      results[sym] = {
        symbol: sym,
        angelToken: String(item.symbolToken),
        ltp: Number(ltp.toFixed(2)),
        open: Number((item.open ?? ltp).toFixed(2)),
        high: Number((item.high ?? ltp).toFixed(2)),
        low: Number((item.low ?? ltp).toFixed(2)),
        close: Number(close.toFixed(2)),
        percentChange: pctChange,
        bestBid,
        bestAsk,
        spreadPctOfMid,
        tradeVolume: Number(item.tradeVolume ?? 0),
        openInterest: Number(item.opnInterest ?? 0),
        updatedAt: nowIso,
      };
    }

    return Object.keys(results).length > 0 ? results : null;
  } catch (err) {
    lastAngelError = err instanceof Error ? err.message : 'Angel quote network error';
    return null;
  }
}

/**
 * Fetch live NSE Option Greeks (`delta`, `gamma`, `theta`, `vega`, `impliedVolatility`)
 * from Angel One SmartAPI (`marketData/v1/optionGreek`) for an underlying (`NIFTY`, `BANKNIFTY`, `FINNIFTY`).
 */
export async function fetchAngelOneOptionGreeks(
  underlying: string,
  expiryDate: string = '26NOV2026'
): Promise<AngelOneOptionGreekSummary | null> {
  const { apiKey, configured } = getAngelCredentials();
  if (!configured) return null;

  const jwt = await ensureAngelOneSession(false);
  if (!jwt) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(
      `${ANGEL_BASE_URL}/rest/secure/angelbroking/marketData/v1/optionGreek`,
      {
        method: 'POST',
        headers: buildAngelHeaders(apiKey, jwt),
        body: JSON.stringify({
          name: underlying,
          expirydate: expiryDate,
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);

    const payload = (await res.json()) as {
      status?: boolean;
      data?: Array<{
        name?: string;
        expiry?: string;
        strikePrice?: string | number;
        optionType?: 'CE' | 'PE';
        delta?: string | number;
        gamma?: string | number;
        theta?: string | number;
        vega?: string | number;
        impliedVolatility?: string | number;
      }>;
    };

    if (!payload?.status || !Array.isArray(payload?.data) || payload.data.length === 0) {
      return cachedOptionGreeks[underlying] ?? null;
    }

    const calls = payload.data.filter((r) => r.optionType === 'CE' && Number(r.impliedVolatility) > 0);
    const puts = payload.data.filter((r) => r.optionType === 'PE' && Number(r.impliedVolatility) > 0);
    const atmCall =
      calls.sort((a, b) => Math.abs(Number(a.delta) - 0.5) - Math.abs(Number(b.delta) - 0.5))[0] ??
      calls[0];
    const atmPut =
      puts.sort((a, b) => Math.abs(Math.abs(Number(a.delta)) - 0.5) - Math.abs(Math.abs(Number(b.delta)) - 0.5))[0] ??
      puts[0];

    const summary: AngelOneOptionGreekSummary = {
      underlying,
      expiryDate,
      atmImpliedVolatilityPct: Number(atmCall?.impliedVolatility ?? atmPut?.impliedVolatility ?? 14.5),
      atmCallDelta: Number(atmCall?.delta ?? 0.52),
      atmPutDelta: Number(atmPut?.delta ?? -0.48),
      atmTheta: Number(atmCall?.theta ?? -12.4),
      atmVega: Number(atmCall?.vega ?? 18.2),
      updatedAt: new Date().toISOString(),
    };
    cachedOptionGreeks[underlying] = summary;
    return summary;
  } catch {
    return cachedOptionGreeks[underlying] ?? null;
  }
}

/**
 * Fetch 5-minute intraday OHLCV candles from Angel One SmartAPI (`historical/v1/getCandleData`)
 * to compute live 14-period RSI, ADX, and ATR% for technical signals.
 */
export async function fetchAngelOneFiveMinCandles(
  symbol: string,
  fromDateIst: string,
  toDateIst: string
): Promise<Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }> | null> {
  const { apiKey, configured } = getAngelCredentials();
  const meta = ANGEL_ONE_NSE_TOKENS[symbol];
  if (!configured || !meta) return null;

  const jwt = await ensureAngelOneSession(false);
  if (!jwt) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      `${ANGEL_BASE_URL}/rest/secure/angelbroking/historical/v1/getCandleData`,
      {
        method: 'POST',
        headers: buildAngelHeaders(apiKey, jwt),
        body: JSON.stringify({
          exchange: meta.exchange,
          symboltoken: meta.angelToken,
          interval: 'FIVE_MINUTE',
          fromdate: fromDateIst,
          todate: toDateIst,
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);

    const payload = (await res.json()) as {
      status?: boolean;
      data?: Array<[string, number, number, number, number, number]>;
    };

    if (!payload?.status || !Array.isArray(payload.data)) return null;
    return payload.data.map((row) => ({
      timestamp: String(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
  } catch {
    return null;
  }
}

export interface AngelOneNfoOptionQuote {
  underlying: string;
  tradingSymbol: string;
  symbolToken: string;
  expiryCode: string;
  strike: number;
  right: 'CE' | 'PE';
  ltp: number;
  bestBid: number;
  bestAsk: number;
  spreadPctOfMid: number;
  openInterest: number;
  tradeVolume: number;
  updatedAt: string;
}

interface ScripMasterOptionEntry {
  underlying: string;
  tradingSymbol: string;
  symbolToken: string;
  expiryCode: string;
  strike: number;
  right: 'CE' | 'PE';
}

const cachedNfoScripByUnderlying: Record<string, ScripMasterOptionEntry[]> = {};
const cachedNfoScripFetchedAt: Record<string, number> = {};
const cachedNfoOptionQuotes: Record<string, AngelOneNfoOptionQuote> = {};
let nfoOptionsTrackedCount = 0;

/**
 * Parse an Angel One NFO option trading symbol like `NIFTY01DEC2623050CE` or `RELIANCE23NOV261180PE`
 */
export function parseAngelNfoOptionSymbol(
  underlying: string,
  tradingSymbol: string,
  symbolToken: string
): ScripMasterOptionEntry | null {
  if (!tradingSymbol.startsWith(underlying)) return null;
  const rest = tradingSymbol.slice(underlying.length);
  const match = rest.match(/^(\d{2}[A-Z]{3}\d{2})(\d+(?:\.\d+)?)(CE|PE)$/);
  if (!match) return null;
  const [, expiryCode, strikeRaw, right] = match;
  const strike = Number(strikeRaw);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    underlying,
    tradingSymbol,
    symbolToken: String(symbolToken),
    expiryCode,
    strike,
    right: right as 'CE' | 'PE',
  };
}

/**
 * Discover and cache real NFO Option Scrip Master tokens (`symboltoken`, `tradingsymbol`)
 * from Angel One `order/v1/searchScrip` for an NSE underlying (`NIFTY`, `BANKNIFTY`, `FINNIFTY`, etc.).
 */
export async function ensureAngelNfoScripCache(
  underlying: string
): Promise<ScripMasterOptionEntry[]> {
  const now = Date.now();
  if (
    cachedNfoScripByUnderlying[underlying] &&
    cachedNfoScripByUnderlying[underlying].length > 0 &&
    now - (cachedNfoScripFetchedAt[underlying] ?? 0) < 6 * 3600 * 1000
  ) {
    return cachedNfoScripByUnderlying[underlying];
  }

  const { apiKey, configured } = getAngelCredentials();
  if (!configured) return [];

  const jwt = await ensureAngelOneSession(false);
  if (!jwt) return [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(
      `${ANGEL_BASE_URL}/rest/secure/angelbroking/order/v1/searchScrip`,
      {
        method: 'POST',
        headers: buildAngelHeaders(apiKey, jwt),
        body: JSON.stringify({
          exchange: 'NFO',
          searchscrip: underlying,
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);

    const text = await res.text();
    if (!text.startsWith('{')) return cachedNfoScripByUnderlying[underlying] ?? [];
    const payload = JSON.parse(text) as {
      status?: boolean;
      data?: Array<{
        exchange?: string;
        tradingsymbol?: string;
        symboltoken?: string;
      }>;
    };

    if (!payload?.status || !Array.isArray(payload.data)) {
      return cachedNfoScripByUnderlying[underlying] ?? [];
    }

    const parsed: ScripMasterOptionEntry[] = [];
    for (const row of payload.data) {
      if (row.exchange !== 'NFO' || !row.tradingsymbol || !row.symboltoken) continue;
      const item = parseAngelNfoOptionSymbol(underlying, row.tradingsymbol, row.symboltoken);
      if (item) parsed.push(item);
    }

    if (parsed.length > 0) {
      cachedNfoScripByUnderlying[underlying] = parsed;
      cachedNfoScripFetchedAt[underlying] = now;
    }
    return parsed;
  } catch {
    return cachedNfoScripByUnderlying[underlying] ?? [];
  }
}

/**
 * Fetch real live NFO Option L1/L2 Quotes (`ltp`, `bestBid`, `bestAsk`, `openInterest`, `tradeVolume`)
 * from Angel One (`market/v1/quote/`, `exchangeTokens: { NFO: [...] }`) for a target underlying, strike, and right.
 */
export async function fetchAngelOneLiveOptionPairQuotes(params: {
  underlying: string;
  targetStrike: number;
  shortStrike: number;
  right: 'CE' | 'PE';
}): Promise<{
  longLeg: AngelOneNfoOptionQuote | null;
  shortLeg: AngelOneNfoOptionQuote | null;
}> {
  const scripList = await ensureAngelNfoScripCache(params.underlying);
  if (scripList.length === 0) {
    return { longLeg: null, shortLeg: null };
  }

  // Prefer nearest liquid monthly/weekly expiry (e.g. NOV26 or DEC26)
  const rightFiltered = scripList.filter((s) => s.right === params.right);
  if (rightFiltered.length === 0) return { longLeg: null, shortLeg: null };

  const preferredExpiry =
    rightFiltered.find((s) => s.expiryCode.includes('NOV26'))?.expiryCode ||
    rightFiltered.find((s) => s.expiryCode.includes('DEC26'))?.expiryCode ||
    rightFiltered[0].expiryCode;

  const sameExpiry = rightFiltered.filter((s) => s.expiryCode === preferredExpiry);
  const pool = sameExpiry.length > 0 ? sameExpiry : rightFiltered;

  const sortedForLong = [...pool].sort(
    (a, b) => Math.abs(a.strike - params.targetStrike) - Math.abs(b.strike - params.targetStrike)
  );
  const longEntry = sortedForLong[0];

  const sortedForShort = [...pool]
    .filter((s) => s.symbolToken !== longEntry?.symbolToken)
    .sort((a, b) => Math.abs(a.strike - params.shortStrike) - Math.abs(b.strike - params.shortStrike));
  const shortEntry = sortedForShort[0] ?? longEntry;

  if (!longEntry) return { longLeg: null, shortLeg: null };

  const nowMs = Date.now();
  const cachedLong = cachedNfoOptionQuotes[longEntry.symbolToken];
  const cachedShort = shortEntry ? cachedNfoOptionQuotes[shortEntry.symbolToken] : null;
  if (
    cachedLong &&
    nowMs - Date.parse(cachedLong.updatedAt) < 25000 &&
    (!shortEntry || (cachedShort && nowMs - Date.parse(cachedShort.updatedAt) < 25000))
  ) {
    return { longLeg: cachedLong, shortLeg: cachedShort ?? null };
  }

  const { apiKey, configured } = getAngelCredentials();
  if (!configured) return { longLeg: null, shortLeg: null };
  const jwt = await ensureAngelOneSession(false);
  if (!jwt) return { longLeg: null, shortLeg: null };

  const tokensToQuery = Array.from(
    new Set([longEntry.symbolToken, shortEntry?.symbolToken].filter(Boolean) as string[])
  );

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${ANGEL_BASE_URL}/rest/secure/angelbroking/market/v1/quote/`, {
      method: 'POST',
      headers: buildAngelHeaders(apiKey, jwt),
      body: JSON.stringify({
        mode: 'FULL',
        exchangeTokens: { NFO: tokensToQuery },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await res.text();
    if (!text.startsWith('{')) {
      return { longLeg: cachedLong ?? null, shortLeg: cachedShort ?? null };
    }
    const payload = JSON.parse(text) as {
      status?: boolean;
      data?: {
        fetched?: Array<{
          symbolToken?: string;
          tradingSymbol?: string;
          ltp?: number;
          tradeVolume?: number;
          opnInterest?: number;
          depth?: {
            buy?: Array<{ price?: number }>;
            sell?: Array<{ price?: number }>;
          };
        }>;
      };
    };

    if (!payload?.status || !Array.isArray(payload.data?.fetched)) {
      return { longLeg: cachedLong ?? null, shortLeg: cachedShort ?? null };
    }

    const nowIso = new Date().toISOString();
    for (const item of payload.data.fetched) {
      const tok = String(item.symbolToken || '');
      const meta = tok === longEntry.symbolToken ? longEntry : shortEntry;
      if (!meta) continue;
      const ltp = Number(item.ltp ?? 0);
      if (ltp <= 0) continue;

      const rawBid = Number(item.depth?.buy?.[0]?.price ?? 0);
      const rawAsk = Number(item.depth?.sell?.[0]?.price ?? 0);
      const bestBid = rawBid > 0 ? rawBid : Number(Math.max(0.5, ltp * 0.988).toFixed(2));
      const bestAsk =
        rawAsk > 0 && rawAsk >= bestBid ? rawAsk : Number((ltp * 1.012).toFixed(2));
      const mid = (bestBid + bestAsk) / 2;
      const spreadPctOfMid = mid > 0 ? Number(((bestAsk - bestBid) / mid).toFixed(4)) : 0.024;

      cachedNfoOptionQuotes[tok] = {
        underlying: meta.underlying,
        tradingSymbol: meta.tradingSymbol,
        symbolToken: tok,
        expiryCode: meta.expiryCode,
        strike: meta.strike,
        right: meta.right,
        ltp: Number(ltp.toFixed(2)),
        bestBid,
        bestAsk,
        spreadPctOfMid,
        openInterest: Number(item.opnInterest ?? 0),
        tradeVolume: Number(item.tradeVolume ?? 0),
        updatedAt: nowIso,
      };
    }

    nfoOptionsTrackedCount = Object.keys(cachedNfoOptionQuotes).length;
    return {
      longLeg: cachedNfoOptionQuotes[longEntry.symbolToken] ?? null,
      shortLeg: shortEntry ? cachedNfoOptionQuotes[shortEntry.symbolToken] ?? null : null,
    };
  } catch {
    return { longLeg: cachedLong ?? null, shortLeg: cachedShort ?? null };
  }
}

/**
 * Fetch batch NFO quotes by `symbolToken` array to revalue open paper positions from live Angel One NFO orderbooks.
 */
export async function fetchAngelOneNfoQuotesByTokens(
  tokens: string[]
): Promise<Record<string, { ltp: number; bestBid: number; bestAsk: number; openInterest: number; tradeVolume: number }>> {
  const uniqueTokens = Array.from(new Set(tokens.filter(Boolean)));
  if (uniqueTokens.length === 0) return {};

  const { apiKey, configured } = getAngelCredentials();
  if (!configured) return {};
  const jwt = await ensureAngelOneSession(false);
  if (!jwt) return {};

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3800);
    const res = await fetch(`${ANGEL_BASE_URL}/rest/secure/angelbroking/market/v1/quote/`, {
      method: 'POST',
      headers: buildAngelHeaders(apiKey, jwt),
      body: JSON.stringify({
        mode: 'FULL',
        exchangeTokens: { NFO: uniqueTokens.slice(0, 20) },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await res.text();
    if (!text.startsWith('{')) return {};
    const payload = JSON.parse(text) as {
      status?: boolean;
      data?: {
        fetched?: Array<{
          symbolToken?: string;
          ltp?: number;
          tradeVolume?: number;
          opnInterest?: number;
          depth?: {
            buy?: Array<{ price?: number }>;
            sell?: Array<{ price?: number }>;
          };
        }>;
      };
    };

    if (!payload?.status || !Array.isArray(payload.data?.fetched)) return {};
    const map: Record<
      string,
      { ltp: number; bestBid: number; bestAsk: number; openInterest: number; tradeVolume: number }
    > = {};
    for (const item of payload.data.fetched) {
      const tok = String(item.symbolToken || '');
      const ltp = Number(item.ltp ?? 0);
      if (!tok || ltp <= 0) continue;
      const rawBid = Number(item.depth?.buy?.[0]?.price ?? 0);
      const rawAsk = Number(item.depth?.sell?.[0]?.price ?? 0);
      const bestBid = rawBid > 0 ? rawBid : Number(Math.max(0.5, ltp * 0.988).toFixed(2));
      const bestAsk =
        rawAsk > 0 && rawAsk >= bestBid ? rawAsk : Number((ltp * 1.012).toFixed(2));
      map[tok] = {
        ltp: Number(ltp.toFixed(2)),
        bestBid,
        bestAsk,
        openInterest: Number(item.opnInterest ?? 0),
        tradeVolume: Number(item.tradeVolume ?? 0),
      };
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Return safe read-only telemetry on the Angel One SmartAPI connection status
 * (never exposes raw API keys, MPIN, or TOTP secrets).
 */
export function getAngelOneConnectionStatus(): AngelOneConnectionStatus {
  const { clientCode, configured } = getAngelCredentials();
  const masked =
    clientCode.length >= 4
      ? `${clientCode.slice(0, 2)}***${clientCode.slice(-2)}`
      : configured
      ? 'CONFIGURED'
      : 'NOT_SET';

  return {
    configured,
    authenticated: Boolean(configured && cachedJwtToken && Date.now() < jwtExpiresAtMs),
    providerName:
      'Angel One SmartAPI (NSE Spot + NFO Option L2 Depth + 5m OHLCV Technicals)',
    clientCodeMasked: masked,
    feedMode:
      configured && cachedJwtToken ? 'ANGEL_ONE_SMARTAPI_FULL' : 'FALLBACK_PUBLIC_NSE',
    tokensTracked: Object.keys(ANGEL_ONE_NSE_TOKENS).length + nfoOptionsTrackedCount,
    lastLoginAt: lastLoginAtIso,
    lastQuoteFetchAt: lastQuoteFetchAtIso,
    lastError: lastAngelError,
  };
}

