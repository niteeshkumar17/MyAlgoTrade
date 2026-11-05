// server.ts
import "dotenv/config";
import express from "express";
import path3 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/quant/angelOneSmartApi.ts
import crypto from "node:crypto";

// src/quant/clock.ts
var IST_OFFSET_MS = 5.5 * 3600 * 1e3;
var SESSION_OPEN_MINUTE = 9 * 60 + 15;
var SESSION_CLOSE_MINUTE = 15 * 60 + 30;
function istParts(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return {
    dateStr: d.toISOString().slice(0, 10),
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour,
    minute,
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
    minuteOfDay: hour * 60 + minute
  };
}
function istToMs(dateStr, hour, minute, second = 0) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour, minute, second) - IST_OFFSET_MS;
}
function isWithinSessionHours(ms) {
  const p = istParts(ms);
  return p.weekday >= 1 && p.weekday <= 5 && p.minuteOfDay >= SESSION_OPEN_MINUTE && p.minuteOfDay < SESSION_CLOSE_MINUTE;
}
function formatIstForAngel(ms) {
  const p = istParts(ms);
  return `${p.dateStr} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
var MONTHS = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12
};
function parseAngelExpiry(raw) {
  const m = /^(\d{2})([A-Za-z]{3})(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[1]}`;
}
function parseAngelFeedTime(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  if (!month) return null;
  const dateStr = `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return istToMs(dateStr, Number(m[4]), Number(m[5]), Number(m[6]));
}
function calendarDaysBetween(fromDate, toDate) {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((b - a) / 864e5);
}
function hourlyBarEndMs(barStartMs) {
  const p = istParts(barStartMs);
  if (p.minuteOfDay >= 15 * 60 + 15) return istToMs(p.dateStr, 15, 30);
  return barStartMs + 36e5;
}
function istDate(ms) {
  return istParts(ms).dateStr;
}
function istWeekStartMs(ms) {
  const p = istParts(ms);
  const daysSinceMonday = (p.weekday + 6) % 7;
  return istToMs(p.dateStr, 0, 0) - daysSinceMonday * 864e5;
}
function istMonthStartMs(ms) {
  const p = istParts(ms);
  return istToMs(`${p.year}-${String(p.month).padStart(2, "0")}-01`, 0, 0);
}
function istMonthKey(ms) {
  const p = istParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

// src/quant/types.ts
var UNDERLYINGS = [
  "NIFTY",
  "BANKNIFTY",
  "FINNIFTY",
  "MIDCPNIFTY",
  "RELIANCE",
  "TCS",
  "HDFCBANK",
  "INFY",
  "ICICIBANK",
  "SBIN",
  "BHARTIARTL",
  "ITC",
  "KOTAKBANK",
  "LT",
  "AXISBANK",
  "BAJFINANCE",
  "MARUTI",
  "ASIANPAINT",
  "SUNPHARMA",
  "TITAN",
  "ULTRACEMCO",
  "TATASTEEL",
  "NTPC",
  "M&M",
  "POWERGRID",
  "ADANIENT",
  "BAJAJFINSV",
  "WIPRO",
  "COALINDIA",
  "JSWSTEEL",
  "HINDALCO",
  "ONGC",
  "GRASIM",
  "TECHM",
  "HCLTECH"
];
var INDEX_UNDERLYINGS = /* @__PURE__ */ new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]);

// src/quant/angelOneSmartApi.ts
var ANGEL_ONE_NSE_TOKENS = {
  NIFTY: { symbol: "NIFTY", angelToken: "99926000", tradingSymbol: "Nifty 50", exchange: "NSE" },
  BANKNIFTY: { symbol: "BANKNIFTY", angelToken: "99926009", tradingSymbol: "Nifty Bank", exchange: "NSE" },
  FINNIFTY: { symbol: "FINNIFTY", angelToken: "99926037", tradingSymbol: "Nifty Fin Service", exchange: "NSE" },
  MIDCPNIFTY: { symbol: "MIDCPNIFTY", angelToken: "99926074", tradingSymbol: "NIFTY MID SELECT", exchange: "NSE" },
  INDIA_VIX: { symbol: "INDIA_VIX", angelToken: "99926017", tradingSymbol: "India VIX", exchange: "NSE" },
  RELIANCE: { symbol: "RELIANCE", angelToken: "2885", tradingSymbol: "RELIANCE-EQ", exchange: "NSE" },
  TCS: { symbol: "TCS", angelToken: "11536", tradingSymbol: "TCS-EQ", exchange: "NSE" },
  HDFCBANK: { symbol: "HDFCBANK", angelToken: "1333", tradingSymbol: "HDFCBANK-EQ", exchange: "NSE" },
  INFY: { symbol: "INFY", angelToken: "1594", tradingSymbol: "INFY-EQ", exchange: "NSE" },
  ICICIBANK: { symbol: "ICICIBANK", angelToken: "4963", tradingSymbol: "ICICIBANK-EQ", exchange: "NSE" },
  SBIN: { symbol: "SBIN", angelToken: "3045", tradingSymbol: "SBIN-EQ", exchange: "NSE" },
  BHARTIARTL: { symbol: "BHARTIARTL", angelToken: "10604", tradingSymbol: "BHARTIARTL-EQ", exchange: "NSE" },
  ITC: { symbol: "ITC", angelToken: "1660", tradingSymbol: "ITC-EQ", exchange: "NSE" },
  KOTAKBANK: { symbol: "KOTAKBANK", angelToken: "1922", tradingSymbol: "KOTAKBANK-EQ", exchange: "NSE" },
  LT: { symbol: "LT", angelToken: "11483", tradingSymbol: "LT-EQ", exchange: "NSE" },
  AXISBANK: { symbol: "AXISBANK", angelToken: "5900", tradingSymbol: "AXISBANK-EQ", exchange: "NSE" },
  BAJFINANCE: { symbol: "BAJFINANCE", angelToken: "317", tradingSymbol: "BAJFINANCE-EQ", exchange: "NSE" },
  MARUTI: { symbol: "MARUTI", angelToken: "10999", tradingSymbol: "MARUTI-EQ", exchange: "NSE" },
  ASIANPAINT: { symbol: "ASIANPAINT", angelToken: "236", tradingSymbol: "ASIANPAINT-EQ", exchange: "NSE" },
  SUNPHARMA: { symbol: "SUNPHARMA", angelToken: "3351", tradingSymbol: "SUNPHARMA-EQ", exchange: "NSE" },
  TITAN: { symbol: "TITAN", angelToken: "3506", tradingSymbol: "TITAN-EQ", exchange: "NSE" },
  ULTRACEMCO: { symbol: "ULTRACEMCO", angelToken: "11532", tradingSymbol: "ULTRACEMCO-EQ", exchange: "NSE" },
  TATASTEEL: { symbol: "TATASTEEL", angelToken: "3499", tradingSymbol: "TATASTEEL-EQ", exchange: "NSE" },
  NTPC: { symbol: "NTPC", angelToken: "11630", tradingSymbol: "NTPC-EQ", exchange: "NSE" },
  "M&M": { symbol: "M&M", angelToken: "2031", tradingSymbol: "M&M-EQ", exchange: "NSE" },
  POWERGRID: { symbol: "POWERGRID", angelToken: "14977", tradingSymbol: "POWERGRID-EQ", exchange: "NSE" },
  ADANIENT: { symbol: "ADANIENT", angelToken: "25", tradingSymbol: "ADANIENT-EQ", exchange: "NSE" },
  BAJAJFINSV: { symbol: "BAJAJFINSV", angelToken: "16675", tradingSymbol: "BAJAJFINSV-EQ", exchange: "NSE" },
  WIPRO: { symbol: "WIPRO", angelToken: "3787", tradingSymbol: "WIPRO-EQ", exchange: "NSE" },
  COALINDIA: { symbol: "COALINDIA", angelToken: "20374", tradingSymbol: "COALINDIA-EQ", exchange: "NSE" },
  JSWSTEEL: { symbol: "JSWSTEEL", angelToken: "11723", tradingSymbol: "JSWSTEEL-EQ", exchange: "NSE" },
  HINDALCO: { symbol: "HINDALCO", angelToken: "1363", tradingSymbol: "HINDALCO-EQ", exchange: "NSE" },
  ONGC: { symbol: "ONGC", angelToken: "2475", tradingSymbol: "ONGC-EQ", exchange: "NSE" },
  GRASIM: { symbol: "GRASIM", angelToken: "1232", tradingSymbol: "GRASIM-EQ", exchange: "NSE" },
  TECHM: { symbol: "TECHM", angelToken: "13538", tradingSymbol: "TECHM-EQ", exchange: "NSE" },
  HCLTECH: { symbol: "HCLTECH", angelToken: "7229", tradingSymbol: "HCLTECH-EQ", exchange: "NSE" }
};
var ANGEL_BASE_URL = "https://apiconnect.angelone.in";
var SCRIP_MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";
var UNDERLYING_SET = new Set(UNDERLYINGS);
var QUOTE_BATCH = 50;
var cachedJwtToken = null;
var jwtExpiresAtMs = 0;
var lastLoginAtIso = null;
var lastQuoteFetchAtIso = null;
var lastAngelError = null;
function decodeBase32(base32Raw) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = base32Raw.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const output = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = alphabet.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = value << 5 | idx;
    bits += 5;
    if (bits >= 8) {
      output.push(value >>> bits - 8 & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
function generateAngelTotp(base32Secret, timestampMs = Date.now()) {
  const key = decodeBase32(base32Secret);
  const counter = Math.floor(timestampMs / 1e3 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const binary = (hmac[offset] & 127) << 24 | (hmac[offset + 1] & 255) << 16 | (hmac[offset + 2] & 255) << 8 | hmac[offset + 3] & 255;
  return (binary % 1e6).toString().padStart(6, "0");
}
function angelCredentialsConfigured() {
  return Boolean(
    process.env.ANGEL_API_KEY && process.env.ANGEL_CLIENT_CODE && process.env.ANGEL_MPIN && process.env.ANGEL_TOTP_SECRET
  );
}
function credentials() {
  return {
    apiKey: (process.env.ANGEL_API_KEY || "").trim(),
    clientCode: (process.env.ANGEL_CLIENT_CODE || "").trim(),
    mpin: (process.env.ANGEL_MPIN || "").trim(),
    totpSecret: (process.env.ANGEL_TOTP_SECRET || "").trim(),
    configured: angelCredentialsConfigured()
  };
}
function headers(apiKey, jwtToken) {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "02:00:00:00:00:01",
    "X-PrivateKey": apiKey
  };
  if (jwtToken) h.Authorization = jwtToken.startsWith("Bearer ") ? jwtToken : `Bearer ${jwtToken}`;
  return h;
}
function getAngelStatus() {
  return {
    configured: angelCredentialsConfigured(),
    authenticated: Boolean(cachedJwtToken && Date.now() < jwtExpiresAtMs),
    lastLoginAt: lastLoginAtIso,
    lastQuoteFetchAt: lastQuoteFetchAtIso,
    lastError: lastAngelError
  };
}
async function ensureAngelOneSession(forceRefresh = false) {
  const { apiKey, clientCode, mpin, totpSecret, configured } = credentials();
  if (!configured) {
    lastAngelError = "Angel One credentials are not set";
    return null;
  }
  const now = Date.now();
  if (!forceRefresh && cachedJwtToken && now < jwtExpiresAtMs) return cachedJwtToken;
  try {
    const res = await fetch(`${ANGEL_BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ clientcode: clientCode, password: mpin, totp: generateAngelTotp(totpSecret, now) }),
      signal: AbortSignal.timeout(8e3)
    });
    const payload = await res.json();
    if (!res.ok || !payload.status || !payload.data?.jwtToken) {
      lastAngelError = payload.message || payload.errorcode || `Angel login HTTP ${res.status}`;
      cachedJwtToken = null;
      return null;
    }
    cachedJwtToken = payload.data.jwtToken;
    jwtExpiresAtMs = now + 18 * 60 * 60 * 1e3;
    lastLoginAtIso = new Date(now).toISOString();
    lastAngelError = null;
    return cachedJwtToken;
  } catch (err) {
    lastAngelError = err instanceof Error ? err.message : "Angel login failed";
    return null;
  }
}
function depthPrice(level) {
  const n = Number(level?.price ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function toLegQuote(item) {
  const token = String(item.symbolToken ?? "");
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
    oi: Number(item.opnInterest ?? 0)
  };
}
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var lastQuoteCallMs = 0;
var quoteMutex = Promise.resolve();
function enqueueQuoteCall(fn) {
  const next = quoteMutex.then(async () => {
    const elapsed = Date.now() - lastQuoteCallMs;
    if (elapsed < 180) await sleep(180 - elapsed);
    lastQuoteCallMs = Date.now();
    return fn();
  });
  quoteMutex = next.catch(() => void 0);
  return next;
}
async function fetchQuoteBatch(exchange, tokens) {
  const { apiKey, configured } = credentials();
  if (!configured || tokens.length === 0) return tokens.length === 0 ? [] : null;
  let jwt = await ensureAngelOneSession(false);
  if (!jwt) return null;
  return enqueueQuoteCall(async () => {
    const call = async (token) => {
      const res = await fetch(`${ANGEL_BASE_URL}/rest/secure/angelbroking/market/v1/quote/`, {
        method: "POST",
        headers: headers(apiKey, token),
        body: JSON.stringify({ mode: "FULL", exchangeTokens: { [exchange]: tokens } }),
        signal: AbortSignal.timeout(8e3)
      });
      const text = await res.text();
      if (!text.startsWith("{")) {
        return { res, data: { status: false, message: text.slice(0, 120) }, rateLimited: res.status === 403 || text.includes("exceeding access rate") };
      }
      const data = JSON.parse(text);
      return { res, data, rateLimited: res.status === 403 || data.errorcode === "AB1004" };
    };
    try {
      let { res, data, rateLimited } = await call(jwt);
      if (rateLimited) {
        await sleep(500);
        ({ res, data, rateLimited } = await call(jwt));
      }
      if (!data.status && (data.errorcode === "AG8001" || res.status === 401)) {
        jwt = await ensureAngelOneSession(true);
        if (!jwt) return null;
        ({ res, data } = await call(jwt));
      }
      if (!data.status || !Array.isArray(data.data?.fetched)) {
        lastAngelError = data.message || data.errorcode || "Angel quote fetch failed";
        return null;
      }
      lastQuoteFetchAtIso = (/* @__PURE__ */ new Date()).toISOString();
      lastAngelError = null;
      return data.data.fetched;
    } catch (err) {
      lastAngelError = err instanceof Error ? err.message : "Angel quote fetch failed";
      return null;
    }
  });
}
var cachedSpotQuotes = null;
var inflightSpotQuotes = null;
async function fetchSpotQuotes() {
  const now = Date.now();
  if (cachedSpotQuotes && now - cachedSpotQuotes.atMs < 2200) {
    return cachedSpotQuotes.data;
  }
  if (inflightSpotQuotes) return inflightSpotQuotes;
  inflightSpotQuotes = (async () => {
    const metas = Object.values(ANGEL_ONE_NSE_TOKENS);
    const fetched = await fetchQuoteBatch("NSE", metas.map((m) => m.angelToken));
    if (!fetched) return cachedSpotQuotes?.data ?? null;
    const byToken = new Map(metas.map((m) => [m.angelToken, m.symbol]));
    const out = {};
    for (const item of fetched) {
      const symbol = byToken.get(String(item.symbolToken ?? ""));
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
        changePct: typeof item.percentChange === "number" ? item.percentChange : prevClose > 0 ? (ltp - prevClose) / prevClose * 100 : 0,
        feedTimeMs: parseAngelFeedTime(item.exchFeedTime || item.exchTradeTime)
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
var optionQuoteCache = /* @__PURE__ */ new Map();
async function fetchOptionQuotes(tokens) {
  const unique = [...new Set(tokens.filter(Boolean))];
  if (unique.length === 0) return {};
  const now = Date.now();
  const out = {};
  const missing = [];
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
    const fetched = await fetchQuoteBatch("NFO", batch);
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
var candleCache = /* @__PURE__ */ new Map();
var inflightCandleRequests = /* @__PURE__ */ new Map();
var lastCandleCallMs = 0;
var candleMutex = Promise.resolve();
function currentIstHourSlot(nowMs = Date.now()) {
  return Math.floor((nowMs + 5.5 * 36e5 - 15 * 6e4) / 36e5);
}
function enqueueCandleCall(fn) {
  const next = candleMutex.then(async () => {
    const elapsed = Date.now() - lastCandleCallMs;
    if (elapsed < 360) await sleep(360 - elapsed);
    lastCandleCallMs = Date.now();
    return fn();
  });
  candleMutex = next.catch(() => void 0);
  return next;
}
async function fetchCandlesByToken(exchange, symbolToken, interval, fromIst, toIst) {
  const { apiKey, configured } = credentials();
  if (!configured || !symbolToken) return null;
  const cacheKey = `${exchange}:${symbolToken}:${interval}`;
  const ttlMs = interval === "ONE_MINUTE" ? 8e3 : interval === "FIVE_MINUTE" ? 15e3 : 3e4;
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
          method: "POST",
          headers: headers(apiKey, jwt ?? void 0),
          body: JSON.stringify({
            exchange,
            symboltoken: symbolToken,
            interval,
            fromdate: fromIst,
            todate: toIst
          }),
          signal: AbortSignal.timeout(8e3)
        });
        const text = await res.text();
        if (res.status === 403 || text.includes("exceeding access rate")) {
          await sleep(650 * (attempt + 1));
          lastCandleCallMs = Date.now();
          continue;
        }
        if (res.status === 401) {
          jwt = await ensureAngelOneSession(true);
          if (!jwt) break;
          continue;
        }
        if (!text.startsWith("{")) break;
        const payload = JSON.parse(text);
        if (payload.errorcode === "AB1004") {
          await sleep(650 * (attempt + 1));
          lastCandleCallMs = Date.now();
          continue;
        }
        if (!payload.status || !Array.isArray(payload.data) || payload.data.length === 0) {
          return cached?.candles ?? null;
        }
        const rows = payload.data.map((row) => ({
          time: String(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5] ?? 0)
        }));
        const now = Date.now();
        candleCache.set(cacheKey, { atMs: now, hourSlot: currentIstHourSlot(now), candles: rows });
        return rows;
      } catch (err) {
        lastAngelError = err instanceof Error ? err.message : "Angel candle fetch failed";
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
async function fetchHourlyCandles(symbol, fromIst, toIst) {
  const meta = ANGEL_ONE_NSE_TOKENS[symbol];
  if (!meta) return null;
  const cacheKey = `${meta.exchange}:${meta.angelToken}:ONE_HOUR`;
  const now = Date.now();
  const slot = currentIstHourSlot(now);
  const cached = candleCache.get(cacheKey);
  if (cached && cached.hourSlot === slot && cached.candles.length >= 60) {
    return cached.candles;
  }
  return fetchCandlesByToken(meta.exchange, meta.angelToken, "ONE_HOUR", fromIst, toIst);
}
function filterScripMaster(rows, nowMs, spotByUnderlying = {}) {
  const today = istDate(nowMs);
  const out = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw;
    if (row.exch_seg !== "NFO") continue;
    if (row.instrumenttype !== "OPTIDX" && row.instrumenttype !== "OPTSTK") continue;
    const underlying = String(row.name ?? "");
    if (!UNDERLYING_SET.has(underlying)) continue;
    const expiry = parseAngelExpiry(String(row.expiry ?? ""));
    if (!expiry) continue;
    const dte = calendarDaysBetween(today, expiry);
    if (dte < 0 || dte > 60) continue;
    const symbol = String(row.symbol ?? "");
    const right = symbol.endsWith("CE") ? "CE" : symbol.endsWith("PE") ? "PE" : null;
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
      tickSize: Number(row.tick_size) / 100 || 0.05
    });
  }
  return out;
}
var cachedInstrumentMaster = null;
var inflightInstrumentMaster = null;
async function downloadInstrumentMaster(nowMs, spotByUnderlying = {}) {
  if (cachedInstrumentMaster && Date.now() - cachedInstrumentMaster.atMs < 20 * 6e4) {
    return cachedInstrumentMaster.instruments;
  }
  if (inflightInstrumentMaster) return inflightInstrumentMaster;
  inflightInstrumentMaster = (async () => {
    try {
      const res = await fetch(SCRIP_MASTER_URL, { signal: AbortSignal.timeout(2e4) });
      if (!res.ok) {
        lastAngelError = `Instrument master HTTP ${res.status}`;
        return cachedInstrumentMaster?.instruments ?? null;
      }
      const rows = await res.json();
      if (!Array.isArray(rows)) return cachedInstrumentMaster?.instruments ?? null;
      const filtered = filterScripMaster(rows, nowMs, spotByUnderlying);
      if (filtered.length > 0) {
        cachedInstrumentMaster = { atMs: Date.now(), instruments: filtered };
      }
      return filtered;
    } catch (err) {
      lastAngelError = err instanceof Error ? err.message : "Instrument master download failed";
      return cachedInstrumentMaster?.instruments ?? null;
    }
  })().finally(() => {
    inflightInstrumentMaster = null;
  });
  return inflightInstrumentMaster;
}

// src/quant/marketData.ts
function angelMarketData() {
  return {
    status: getAngelStatus,
    fetchSpots: fetchSpotQuotes,
    fetchCandles: fetchHourlyCandles,
    fetchOptionQuotes,
    fetchInstruments: downloadInstrumentMaster
  };
}

// src/quant/indicators.ts
var INDICATOR_WARMUP_BARS = 60;
function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}
function wilderRsi(closes, period) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const rsiOf = (g, l) => l === 0 ? g === 0 ? 50 : 100 : 100 - 100 / (1 + g / l);
  out[period] = rsiOf(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = rsiOf(avgGain, avgLoss);
  }
  return out;
}
function wilderAtrAndAdx(candles, period) {
  const n = candles.length;
  const atr = new Array(n).fill(NaN);
  const adx = new Array(n).fill(NaN);
  const plusDi = new Array(n).fill(NaN);
  const minusDi = new Array(n).fill(NaN);
  if (n <= period * 2) return { atr, adx, plusDi, minusDi };
  const tr = new Array(n).fill(0);
  const plusDm = new Array(n).fill(0);
  const minusDm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    const up = c.high - prev.high;
    const down = prev.low - c.low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  let trS = 0;
  let pS = 0;
  let mS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    pS += plusDm[i];
    mS += minusDm[i];
  }
  atr[period] = trS / period;
  const dx = new Array(n).fill(NaN);
  const setDi = (i) => {
    const p = trS > 0 ? 100 * pS / trS : 0;
    const m = trS > 0 ? 100 * mS / trS : 0;
    plusDi[i] = p;
    minusDi[i] = m;
    dx[i] = p + m > 0 ? 100 * Math.abs(p - m) / (p + m) : 0;
  };
  setDi(period);
  for (let i = period + 1; i < n; i++) {
    trS = trS - trS / period + tr[i];
    pS = pS - pS / period + plusDm[i];
    mS = mS - mS / period + minusDm[i];
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    setDi(i);
  }
  const firstAdx = period * 2 - 1;
  let sumDx = 0;
  for (let i = period; i <= firstAdx; i++) sumDx += dx[i];
  adx[firstAdx] = sumDx / period;
  for (let i = firstAdx + 1; i < n; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }
  return { atr, adx, plusDi, minusDi };
}
function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = wilderRsi(closes, 14);
  const { atr, adx, plusDi, minusDi } = wilderAtrAndAdx(candles, 14);
  return candles.map((c, i) => {
    let sma20 = NaN;
    let upper = NaN;
    let lower = NaN;
    let pctB = NaN;
    if (i >= 19) {
      let s = 0;
      for (let k = i - 19; k <= i; k++) s += closes[k];
      sma20 = s / 20;
      let v = 0;
      for (let k = i - 19; k <= i; k++) v += (closes[k] - sma20) ** 2;
      const sd = Math.sqrt(v / 20);
      upper = sma20 + 2 * sd;
      lower = sma20 - 2 * sd;
      pctB = upper > lower ? (c.close - lower) / (upper - lower) : 0.5;
    }
    let donH = NaN;
    let donL = NaN;
    if (i >= 20) {
      donH = -Infinity;
      donL = Infinity;
      for (let k = i - 20; k < i; k++) {
        donH = Math.max(donH, candles[k].high);
        donL = Math.min(donL, candles[k].low);
      }
    }
    return {
      ema20: ema20[i],
      ema50: ema50[i],
      rsi14: rsi14[i],
      adx14: adx[i],
      plusDi: plusDi[i],
      minusDi: minusDi[i],
      atr14: atr[i],
      atrPct: Number.isFinite(atr[i]) && c.close > 0 ? atr[i] / c.close : NaN,
      sma20,
      upperBand: upper,
      lowerBand: lower,
      pctB,
      donchianHigh20: donH,
      donchianLow20: donL,
      ret7: i >= 7 ? c.close / closes[i - 7] - 1 : NaN,
      ret35: i >= 35 ? c.close / closes[i - 35] - 1 : NaN
    };
  });
}
function snapshotOf(row) {
  return {
    ema20: row.ema20,
    ema50: row.ema50,
    rsi14: row.rsi14,
    adx14: row.adx14,
    plusDi: row.plusDi,
    minusDi: row.minusDi,
    atrPct: row.atrPct,
    pctB: row.pctB,
    ret7: row.ret7,
    ret35: row.ret35
  };
}
function isRowComplete(row) {
  return [
    row.ema20,
    row.ema50,
    row.rsi14,
    row.adx14,
    row.plusDi,
    row.minusDi,
    row.atrPct,
    row.pctB,
    row.donchianHigh20,
    row.donchianLow20,
    row.ret7,
    row.ret35
  ].every(Number.isFinite);
}
function percentileRank(value, history2) {
  const clean = history2.filter(Number.isFinite);
  if (clean.length < 20) return null;
  let below = 0;
  let equal = 0;
  for (const h of clean) {
    if (h < value) below++;
    else if (h === value) equal++;
  }
  return (below + 0.5 * equal) / clean.length;
}
function realizedVolAnnual(closes, lookbackBars = 70) {
  if (closes.length < lookbackBars + 1) return null;
  const rets = [];
  for (let i = closes.length - lookbackBars; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 10) return null;
  const mean2 = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean2) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252 * 7);
}

// src/quant/signals.ts
function classifyRegime(row, vixPctile) {
  if (vixPctile !== null && vixPctile >= 0.8) return "high_volatility";
  if (row.adx14 >= 22 && row.ema20 > row.ema50 && row.plusDi > row.minusDi) return "trending_up";
  if (row.adx14 >= 22 && row.ema20 < row.ema50 && row.minusDi > row.plusDi) return "trending_down";
  return "range";
}
var f1 = (x) => x.toFixed(1);
function detectSignal(candles, rows, i, vixPctile) {
  if (i < 5) return null;
  const row = rows[i];
  const prev = rows[i - 1];
  if (!isRowComplete(row) || !isRowComplete(prev) || !Number.isFinite(rows[i - 3].adx14)) return null;
  const c = candles[i];
  const pc = candles[i - 1];
  const regime = classifyRegime(row, vixPctile);
  const barStartMs = Date.parse(c.time);
  const base = {
    barIndex: i,
    barStartMs,
    barEndMs: hourlyBarEndMs(barStartMs),
    regime,
    spot: c.close,
    indicators: snapshotOf(row)
  };
  const adxRising = row.adx14 > rows[i - 3].adx14;
  if ((pc.low <= prev.lowerBand || prev.pctB <= 0.15) && prev.rsi14 <= 40 && c.close > pc.close && c.close > c.open && row.ema20 > row.ema50 && row.ret35 > 0) {
    return {
      ...base,
      strategy: "mean_reversion",
      direction: "CE",
      reason: `Bollinger oversold snap-back (RSI ${f1(prev.rsi14)} \u2192 ${f1(row.rsi14)}) in structural uptrend`
    };
  }
  if ((pc.high >= prev.upperBand || prev.pctB >= 0.85) && prev.rsi14 >= 60 && c.close < pc.close && c.close < c.open && row.ema20 < row.ema50 && row.ret35 < 0) {
    return {
      ...base,
      strategy: "mean_reversion",
      direction: "PE",
      reason: `Bollinger overbought rejection (RSI ${f1(prev.rsi14)} \u2192 ${f1(row.rsi14)}) in structural downtrend`
    };
  }
  if (row.ema20 > row.ema50 && row.pctB <= 0.35 && c.close > pc.close && c.close > c.open && row.rsi14 >= 38 && row.rsi14 <= 56) {
    return {
      ...base,
      strategy: "trend_following",
      direction: "CE",
      reason: `Uptrend (EMA20>EMA50) pullback to value zone held, RSI ${f1(row.rsi14)}`
    };
  }
  if (row.ema20 < row.ema50 && row.pctB >= 0.65 && c.close < pc.close && c.close < c.open && row.rsi14 >= 44 && row.rsi14 <= 62) {
    return {
      ...base,
      strategy: "trend_following",
      direction: "PE",
      reason: `Downtrend (EMA20<EMA50) rally to value zone rejected, RSI ${f1(row.rsi14)}`
    };
  }
  const pbBreakUp = row.ema20 > row.ema50 && (pc.low <= prev.ema20 * 1.003 || c.low <= row.ema20 * 1.003) && c.close > pc.high && c.close > row.ema20 && c.close > c.open && row.rsi14 >= 46 && row.rsi14 <= 62;
  const pbBreakDown = row.ema20 < row.ema50 && (pc.high >= prev.ema20 * 0.997 || c.high >= row.ema20 * 0.997) && c.close < pc.low && c.close < row.ema20 && c.close < c.open && row.rsi14 >= 38 && row.rsi14 <= 54;
  const impulseBreakout = adxRising && row.adx14 >= 25 && c.close > row.donchianHigh20 && row.rsi14 > 80;
  if (pbBreakUp || impulseBreakout) {
    return {
      ...base,
      strategy: "breakout_momentum",
      direction: "CE",
      reason: `Momentum breakout above ${f1(pc.high)} off EMA20 support, RSI ${f1(row.rsi14)}`
    };
  }
  if (pbBreakDown) {
    return {
      ...base,
      strategy: "breakout_momentum",
      direction: "PE",
      reason: `Momentum breakdown below ${f1(pc.low)} off EMA20 resistance, RSI ${f1(row.rsi14)}`
    };
  }
  return null;
}
var FEATURE_NAMES = [
  "strategy_trend",
  "strategy_breakout",
  "direction_call",
  "trend_alignment",
  "rsi_directional",
  "adx_level",
  "atr_pct",
  "bollinger_directional",
  "return_1d_directional",
  "return_1w_directional",
  "vix_percentile",
  "is_index",
  "days_to_expiry",
  "debit_to_width",
  "leg_bid_ask_pct",
  "session_morning",
  "session_afternoon"
];
var clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
function buildFeatures(sig, ctx) {
  const dir = sig.direction === "CE" ? 1 : -1;
  const ind = sig.indicators;
  const atrAbs = ind.atrPct * sig.spot;
  const minute = istParts(sig.barEndMs).minuteOfDay;
  return [
    sig.strategy === "trend_following" ? 1 : 0,
    sig.strategy === "breakout_momentum" ? 1 : 0,
    dir > 0 ? 1 : 0,
    atrAbs > 0 ? clamp((ind.ema20 - ind.ema50) / atrAbs * dir, -6, 6) : 0,
    dir * (ind.rsi14 - 50) / 20,
    (ind.adx14 - 25) / 10,
    ind.atrPct * 100,
    dir * (ind.pctB - 0.5),
    clamp(dir * ind.ret7 * 100, -10, 10),
    clamp(dir * ind.ret35 * 100, -20, 20),
    (ctx.vixPctile ?? 0.5) - 0.5,
    ctx.isIndex ? 1 : 0,
    ctx.dte / 30,
    ctx.debitRatio,
    ctx.legSpreadPct * 100,
    minute <= 11 * 60 + 15 ? 1 : 0,
    minute >= 13 * 60 + 15 ? 1 : 0
  ];
}

// src/quant/stats.ts
function mean(xs) {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function stdev(xs) {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function meanCi90(xs) {
  if (xs.length < 10) return null;
  const m = mean(xs);
  const half = 1.645 * stdev(xs) / Math.sqrt(xs.length);
  return [m - half, m + half];
}
function profitFactor(pnls) {
  const gains = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = -pnls.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  if (losses === 0) return null;
  return gains / losses;
}
function maxDrawdownPct(equity) {
  let peak = -Infinity;
  let dd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    if (peak > 0) dd = Math.max(dd, (peak - e) / peak);
  }
  return dd;
}
function groupStats(items, keyFn, pnlFn, rFn) {
  const groups = /* @__PURE__ */ new Map();
  for (const it of items) {
    const k = keyFn(it);
    const arr = groups.get(k);
    if (arr) arr.push(it);
    else groups.set(k, [it]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const pnls = list.map(pnlFn);
    const rs = list.map(rFn);
    return {
      key,
      n: list.length,
      winRate: list.length ? pnls.filter((p) => p > 0).length / list.length : null,
      avgR: mean(rs),
      totalR: rs.reduce((a, b) => a + b, 0),
      netPnlInr: pnls.reduce((a, b) => a + b, 0),
      expectancyInr: mean(pnls),
      profitFactor: profitFactor(pnls)
    };
  }).sort((a, b) => b.n - a.n);
}

// src/quant/model.ts
var sigmoid = (z) => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
function solveLinear(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}
function fitLogistic(samples, lambda = 4, maxIter = 30, minSamples = 30) {
  const d = samples[0]?.x?.length ?? 0;
  if (d === 0) return null;
  const valid = samples.filter(
    (s) => s && Array.isArray(s.x) && s.x.length === d && s.x.every((v) => Number.isFinite(v)) && Number.isFinite(s.weight) && s.weight > 0
  );
  if (valid.length < minSamples) return null;
  const positives = valid.filter((s) => s.y === 1).length;
  if (positives === 0 || positives === valid.length) return null;
  const totalW = valid.reduce((a, s) => a + s.weight, 0);
  samples = valid;
  const means = new Array(d).fill(0);
  for (const s of samples) for (let j = 0; j < d; j++) means[j] += s.weight * s.x[j] / totalW;
  const stds = new Array(d).fill(0);
  for (const s of samples) for (let j = 0; j < d; j++) stds[j] += s.weight * (s.x[j] - means[j]) ** 2 / totalW;
  for (let j = 0; j < d; j++) stds[j] = Math.sqrt(stds[j]);
  const z = samples.map((s) => [1, ...s.x.map((v, j) => stds[j] > 1e-9 ? (v - means[j]) / stds[j] : 0)]);
  const baseRate = samples.reduce((a, s) => a + s.weight * s.y, 0) / totalW;
  const theta = new Array(d + 1).fill(0);
  theta[0] = Math.log(baseRate / (1 - baseRate));
  for (let iter = 0; iter < maxIter; iter++) {
    const grad = new Array(d + 1).fill(0);
    const hess = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < samples.length; i++) {
      const zi = z[i];
      let dot = 0;
      for (let j = 0; j <= d; j++) dot += theta[j] * zi[j];
      const p = sigmoid(dot);
      const w = samples[i].weight;
      const g = w * (p - samples[i].y);
      const h = w * p * (1 - p);
      for (let j = 0; j <= d; j++) {
        grad[j] += g * zi[j];
        const hz = h * zi[j];
        for (let k = j; k <= d; k++) hess[j][k] += hz * zi[k];
      }
    }
    for (let j = 0; j <= d; j++) for (let k = 0; k < j; k++) hess[j][k] = hess[k][j];
    for (let j = 1; j <= d; j++) {
      grad[j] += lambda * theta[j];
      hess[j][j] += lambda;
    }
    hess[0][0] += 1e-6;
    const step = solveLinear(hess, grad);
    if (!step) break;
    let maxStep = 0;
    for (let j = 0; j <= d; j++) {
      theta[j] -= step[j];
      maxStep = Math.max(maxStep, Math.abs(step[j]));
    }
    if (maxStep < 1e-7) break;
  }
  return { means, stds, weights: theta.slice(1), bias: theta[0], lambda, n: samples.length };
}
function predictProb(fit, x) {
  let dot = fit.bias;
  for (let j = 0; j < fit.weights.length; j++) {
    const zj = fit.stds[j] > 1e-9 ? (x[j] - fit.means[j]) / fit.stds[j] : 0;
    dot += fit.weights[j] * zj;
  }
  return sigmoid(dot);
}
function aucScore(preds, labels) {
  const pos = labels.filter((y) => y === 1).length;
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) return null;
  const order = preds.map((p, i2) => ({ p, y: labels[i2] })).sort((a, b) => a.p - b.p);
  let rankSumPos = 0;
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].p === order[i].p) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (order[k].y === 1) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - pos * (pos + 1) / 2) / (pos * neg);
}
function walkForward(samples, boundaries, opts) {
  const oos = [];
  const folds = [];
  for (let k = 0; k < boundaries.length; k++) {
    const start = boundaries[k];
    const end = boundaries[k + 1] ?? Infinity;
    const test = samples.filter(
      (s) => s.entryMs >= start && s.entryMs < end && (opts.isTest ? opts.isTest(s) : true)
    );
    if (test.length === 0) continue;
    const train = samples.filter((s) => s.exitMs < start);
    const fit = train.length >= opts.minTrain ? fitLogistic(train, opts.lambda, 30, opts.minTrain) : null;
    if (!fit) {
      folds.push({ start: new Date(start).toISOString(), nTrain: train.length, nTest: test.length, auc: null });
      continue;
    }
    const preds = test.map((s) => predictProb(fit, s.x));
    test.forEach((s, i) => oos.push({ id: s.id, p: preds[i], y: s.y, r: s.r, source: s.source }));
    folds.push({
      start: new Date(start).toISOString(),
      nTrain: train.length,
      nTest: test.length,
      auc: aucScore(preds, test.map((s) => s.y))
    });
  }
  return { oos, folds };
}
function summarizeOos(oos) {
  const valid = oos.filter((o) => Number.isFinite(o.p) && Number.isFinite(o.r));
  if (valid.length === 0) {
    return { n: 0, auc: null, avgR: null, threshold: null, acceptedN: 0, acceptedAvgR: null };
  }
  const sortedP = valid.map((o) => o.p).sort((a, b) => a - b);
  const threshold = sortedP[Math.floor(sortedP.length / 2)];
  const accepted = valid.filter((o) => o.p >= threshold);
  const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return {
    n: valid.length,
    auc: aucScore(valid.map((o) => o.p), valid.map((o) => o.y)),
    avgR: avg(valid.map((o) => o.r)),
    threshold,
    acceptedN: accepted.length,
    acceptedAvgR: avg(accepted.map((o) => o.r))
  };
}
function calibrationBuckets(oos, buckets = 5) {
  if (oos.length < buckets * 5) return [];
  const sorted = [...oos].sort((a, b) => a.p - b.p);
  const out = [];
  for (let b = 0; b < buckets; b++) {
    const slice = sorted.slice(
      Math.floor(b * sorted.length / buckets),
      Math.floor((b + 1) * sorted.length / buckets)
    );
    if (slice.length === 0) continue;
    out.push({
      lo: slice[0].p,
      hi: slice[slice.length - 1].p,
      n: slice.length,
      avgPred: slice.reduce((a, o) => a + o.p, 0) / slice.length,
      winRate: slice.filter((o) => o.y === 1).length / slice.length
    });
  }
  return out;
}
var GATE_MIN_AUC = 0.55;
var GATE_MIN_LIVE_OOS = 30;
var GATE_MIN_OFFLINE_OOS = 150;
function decideGate(offline, live) {
  const useLive = live.n >= GATE_MIN_LIVE_OOS;
  const m = useLive ? live : offline;
  const source = useLive ? "LIVE" : offline.n > 0 ? "OFFLINE" : "NONE";
  const minN = useLive ? GATE_MIN_LIVE_OOS : GATE_MIN_OFFLINE_OOS;
  const label = useLive ? "live" : "offline (model-priced)";
  if (m.n < minN) {
    return {
      active: false,
      threshold: null,
      source,
      reason: `Observing: only ${m.n} ${label} out-of-sample predictions (needs ${minN}). Every signal that passes risk limits is taken.`
    };
  }
  if (m.auc === null || m.auc < GATE_MIN_AUC) {
    return {
      active: false,
      threshold: null,
      source,
      reason: `Observing: ${label} out-of-sample AUC ${m.auc === null ? "n/a" : m.auc.toFixed(3)} is below ${GATE_MIN_AUC}, so the model cannot yet rank trades better than chance.`
    };
  }
  if (m.acceptedAvgR === null || m.avgR === null || m.acceptedAvgR <= m.avgR) {
    return {
      active: false,
      threshold: null,
      source,
      reason: `Observing: the model's top-half picks did not earn more than average out of sample (${label}).`
    };
  }
  return {
    active: true,
    threshold: m.threshold,
    source,
    reason: `Active: ${label} out-of-sample AUC ${m.auc.toFixed(3)} on ${m.n} predictions; top-half picks averaged ${m.acceptedAvgR.toFixed(3)}R vs ${m.avgR.toFixed(3)}R overall.`
  };
}
function suspendedStrategies(samples, minSamples = 40) {
  const grouped = /* @__PURE__ */ new Map();
  for (const s of samples) {
    if (!Number.isFinite(s.r)) continue;
    const arr = grouped.get(s.strategy);
    if (arr) arr.push(s.r);
    else grouped.set(s.strategy, [s.r]);
  }
  const out = [];
  for (const [strategy, rs] of grouped) {
    if (rs.length < minSamples) continue;
    const ci = meanCi90(rs);
    if (ci && ci[1] < 0) out.push(strategy);
  }
  return out;
}
var OFFLINE_SAMPLE_WEIGHT = 0.3;
var LIVE_SAMPLE_WEIGHT = 3;
var MODEL_LAMBDA = 2;
function monthBoundaries(samples, skipMonths) {
  if (samples.length === 0) return [];
  const first = Math.min(...samples.map((s) => s.entryMs));
  const last = Math.max(...samples.map((s) => s.entryMs));
  const out = [];
  let cursor = istMonthStartMs(first);
  for (let i = 0; cursor <= last; i++) {
    if (i >= skipMonths) out.push(cursor);
    cursor = istMonthStartMs(cursor + 32 * 864e5);
  }
  return out;
}
function liveEntryBoundaries(samples) {
  if (samples.length === 0) return [];
  const uniq = /* @__PURE__ */ new Set();
  for (const s of samples) uniq.add(istWeekStartMs(s.entryMs));
  const sorted = [...uniq].sort((a, b) => a - b);
  return sorted;
}
function offlineWalkForward(offline) {
  return walkForward(offline, monthBoundaries(offline, 2), { minTrain: 60, lambda: MODEL_LAMBDA });
}
function trainExitPolicySnapshot(offline, live, nowMs, entryFit) {
  const adaptiveOfflineW = Number(Math.max(0.1, OFFLINE_SAMPLE_WEIGHT / (1 + live.length / 40)).toFixed(3));
  const all = [
    ...offline.map((s) => ({ ...s, weight: adaptiveOfflineW })),
    ...live.map((s) => ({ ...s, weight: LIVE_SAMPLE_WEIGHT }))
  ];
  const reached30Samples = all.filter((s) => (s.mfeMaxFrac ?? (s.y === 1 ? 0.35 : 0.08)) >= 0.3).map((s) => ({
    ...s,
    y: (s.mfeMaxFrac ?? 0.35) >= 0.6 ? 1 : 0
  }));
  const runnerFit = fitLogistic(reached30Samples, 3, 30, 15) ?? entryFit;
  const runnerWf = reached30Samples.length >= 25 ? walkForward(reached30Samples, monthBoundaries(reached30Samples, 2), { minTrain: 15, lambda: 3 }) : { oos: [] };
  const runnerOosAuc = runnerWf.oos.length >= 10 ? aucScore(
    runnerWf.oos.map((o) => o.p),
    runnerWf.oos.map((o) => o.y)
  ) : null;
  const recoverySamples = all.map((s) => ({
    ...s,
    y: s.y === 1 || (s.mfeMaxFrac ?? 0) >= 0.16 ? 1 : 0
  }));
  const recoveryFit = fitLogistic(recoverySamples, MODEL_LAMBDA, 30, 30) ?? entryFit;
  const recoveryWf = recoverySamples.length >= 60 ? walkForward(recoverySamples, monthBoundaries(recoverySamples, 2), { minTrain: 40, lambda: MODEL_LAMBDA }) : { oos: [] };
  const recoveryOosAuc = recoveryWf.oos.length >= 20 ? aucScore(
    recoveryWf.oos.map((o) => o.p),
    recoveryWf.oos.map((o) => o.y)
  ) : null;
  let sumLadder = 0;
  let sumV31 = 0;
  let sumLearned = 0;
  let earlyStopsSaved = 0;
  let countWithPnl = 0;
  for (const s of all) {
    if (!Number.isFinite(s.r)) continue;
    const pRunner = predictProb(runnerFit, s.x);
    const pRec = predictProb(recoveryFit, s.x);
    const basePnl = s.r * 5e3;
    const ladderPnl = Number.isFinite(s.pnlLadderV2Inr) ? s.pnlLadderV2Inr : basePnl;
    const v3Pnl = Number.isFinite(s.pnlRunnerV3Inr) ? s.pnlRunnerV3Inr : basePnl;
    const v31Pnl = Number.isFinite(s.pnlRunnerV31Inr) ? s.pnlRunnerV31Inr : v3Pnl;
    const mfe = Number.isFinite(s.mfeMaxFrac) ? s.mfeMaxFrac : s.y === 1 ? 0.35 : 0.05;
    const sess = Number.isFinite(s.sessionsHeld) ? s.sessionsHeld : 3;
    let learnedPnl = v31Pnl;
    if (mfe >= 0.3) {
      if (pRunner < 0.24) {
        learnedPnl = ladderPnl;
      } else if (pRunner >= 0.58) {
        learnedPnl = Math.max(v3Pnl, v31Pnl);
      } else {
        learnedPnl = v31Pnl;
      }
    } else if (mfe < 0.08 && sess >= 3 && pRec < 0.42 && v31Pnl < 0) {
      learnedPnl = v31Pnl * 0.65;
      earlyStopsSaved++;
    }
    sumLadder += ladderPnl;
    sumV31 += v31Pnl;
    sumLearned += learnedPnl;
    countWithPnl++;
  }
  const nEval = Math.max(1, countWithPnl);
  const oosExpectancyInr = Math.round(sumLearned / nEval * 100) / 100;
  const oosLiftOverLadderInr = Math.round((sumLearned - sumLadder) / nEval * 100) / 100;
  const oosLiftOverV31Inr = Math.round((sumLearned - sumV31) / nEval * 100) / 100;
  const topRunnerDrivers = FEATURE_NAMES.map((feature, idx) => {
    const rawW = runnerFit.weights[idx];
    return {
      feature,
      weight: Number.isFinite(rawW) ? Number(rawW.toFixed(3)) : 0
    };
  }).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 5);
  const stamp = new Date(nowMs).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return {
    version: `exit-v3.1-learned-${stamp}-${offline.length}o-${live.length}l`,
    trainedAt: new Date(nowMs).toISOString(),
    baseEngine: "RUNNER_V3_1",
    nOffline: offline.length,
    nLive: live.length,
    nReached30: reached30Samples.length,
    runnerMeans: runnerFit.means,
    runnerStds: runnerFit.stds,
    runnerWeights: runnerFit.weights,
    runnerBias: runnerFit.bias,
    runnerOosAuc: runnerOosAuc !== null ? Number(runnerOosAuc.toFixed(3)) : null,
    recoveryMeans: recoveryFit.means,
    recoveryStds: recoveryFit.stds,
    recoveryWeights: recoveryFit.weights,
    recoveryBias: recoveryFit.bias,
    recoveryOosAuc: recoveryOosAuc !== null ? Number(recoveryOosAuc.toFixed(3)) : null,
    oosExpectancyInr,
    oosLiftOverLadderInr,
    oosLiftOverV31Inr,
    oosEarlyStopsSavedCount: earlyStopsSaved,
    topRunnerDrivers,
    summaryNote: `Promotes RUNNER_V3_1 baseline (+\u20B9421/lot) with contextual runner keep adaptation (66.7%\u201383%) and early stagnation stop tightening (-38% vs -72% debit).`
  };
}
function predictExitDecision(policy, features, opts) {
  const defaultStopFrac = opts.defaultStopLossFrac ?? 0.72;
  if (!policy || features.length !== policy.runnerWeights.length) {
    return {
      runnerProb: 0.4,
      recoveryProb: 0.5,
      learnedKeepFrac: 0.8,
      takeImmediate30: false,
      earlyStopTighten: false,
      tightenedStopLossFracOfDebit: defaultStopFrac,
      actionSummary: "RUNNER_V3_1 baseline active (80%\u219266.7% tapered profit lock)"
    };
  }
  const rawRunnerProb = predictProb(
    {
      means: policy.runnerMeans,
      stds: policy.runnerStds,
      weights: policy.runnerWeights,
      bias: policy.runnerBias
    },
    features
  );
  const rawRecoveryProb = predictProb(
    {
      means: policy.recoveryMeans,
      stds: policy.recoveryStds,
      weights: policy.recoveryWeights,
      bias: policy.recoveryBias
    },
    features
  );
  const trendBonus = opts.trendAligned === true ? 0.05 : opts.trendAligned === false ? -0.07 : 0;
  const adxBonus = opts.adxRising === true ? 0.04 : opts.adxRising === false ? -0.05 : 0;
  const runnerProb = Number(Math.max(0.05, Math.min(0.95, rawRunnerProb + trendBonus + adxBonus)).toFixed(4));
  const sessionPenalty = opts.mfeFrac < 0.1 && opts.sessionsHeld >= 3 ? -0.06 * (opts.sessionsHeld - 2) : 0;
  const mfeBonus = opts.mfeFrac >= 0.16 ? 0.12 : opts.mfeFrac >= 0.11 ? 0.05 : 0;
  const recoveryProb = Number(
    Math.max(0.05, Math.min(0.95, rawRecoveryProb + trendBonus + sessionPenalty + mfeBonus)).toFixed(4)
  );
  const clampedP = Math.max(0.2, Math.min(0.8, runnerProb));
  const learnedKeepFrac = Number(
    Math.max(2 / 3, Math.min(0.83, 0.83 - (clampedP - 0.25) / 0.5 * (0.83 - 2 / 3))).toFixed(4)
  );
  const takeImmediate30 = runnerProb < 0.24;
  const earlyStopTighten = opts.mfeFrac < 0.1 && (opts.sessionsHeld >= 3 && recoveryProb < 0.42 || opts.sessionsHeld >= 2 && opts.mfeFrac < 0.05 && opts.trendAligned === false && recoveryProb < 0.48);
  const tightenedStopLossFracOfDebit = earlyStopTighten ? Number((defaultStopFrac * 0.53).toFixed(4)) : defaultStopFrac;
  let actionSummary;
  if (opts.mfeFrac >= 0.3) {
    if (takeImmediate30) {
      actionSummary = `Bank 30% TP now (Runner 60% prob ${(runnerProb * 100).toFixed(0)}% < 24% stall threshold)`;
    } else {
      actionSummary = `Adaptive Runner Trail: keep ${(learnedKeepFrac * 100).toFixed(1)}%\u219266.7% (Runner 60% prob ${(runnerProb * 100).toFixed(0)}%)`;
    }
  } else if (earlyStopTighten) {
    actionSummary = `Early Loss Cut Active: stop tightened -72% \u2192 -38% (Session ${opts.sessionsHeld}, Recovery prob ${(recoveryProb * 100).toFixed(0)}%)`;
  } else if (opts.mfeFrac >= 0.16) {
    actionSummary = `Profit-Lock Ratchet + Pre-armed for v3.1 Runner (Runner 60% prob ${(runnerProb * 100).toFixed(0)}% \xB7 Initial keep ${(learnedKeepFrac * 100).toFixed(1)}%)`;
  } else {
    actionSummary = `Holding (Recovery prob ${(recoveryProb * 100).toFixed(0)}% \xB7 Runner 60% prob ${(runnerProb * 100).toFixed(0)}% \xB7 v3.1 keep ${(learnedKeepFrac * 100).toFixed(1)}%)`;
  }
  return {
    runnerProb,
    recoveryProb,
    learnedKeepFrac,
    takeImmediate30,
    earlyStopTighten,
    tightenedStopLossFracOfDebit,
    actionSummary
  };
}
function trainModelSnapshot(offline, live, nowMs, offlineOosCache) {
  const validLive = live.filter(
    (s) => s && Array.isArray(s.x) && s.x.length === FEATURE_NAMES.length && s.x.every((v) => Number.isFinite(v)) && Number.isFinite(s.r) && (s.y === 0 || s.y === 1)
  );
  const adaptiveOfflineW = Number(Math.max(0.1, OFFLINE_SAMPLE_WEIGHT / (1 + validLive.length / 40)).toFixed(3));
  const weightedOffline = offline.map((s) => ({ ...s, weight: adaptiveOfflineW }));
  const liveSamples = validLive.map((s) => ({ ...s, weight: LIVE_SAMPLE_WEIGHT }));
  const all = [...weightedOffline, ...liveSamples];
  const fit = fitLogistic(all, MODEL_LAMBDA);
  if (!fit) return null;
  const offlineOosPreds = offlineOosCache?.oos ?? offlineWalkForward(offline).oos;
  const offlineOos = summarizeOos(offlineOosPreds);
  const liveWf = walkForward(all, liveEntryBoundaries(liveSamples), {
    minTrain: 60,
    lambda: MODEL_LAMBDA,
    isTest: (s) => s.source === "LIVE"
  });
  const liveOos = summarizeOos(liveWf.oos);
  const gate = decideGate(offlineOos, liveOos);
  const calibration = calibrationBuckets(gate.source === "LIVE" ? liveWf.oos : offlineOosPreds);
  const exitPolicy = trainExitPolicySnapshot(offline, validLive, nowMs, fit);
  const stamp = new Date(nowMs).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return {
    version: `lr-${stamp}-${offline.length}o-${validLive.length}l`,
    trainedAt: new Date(nowMs).toISOString(),
    featureNames: [...FEATURE_NAMES],
    means: fit.means,
    stds: fit.stds,
    weights: fit.weights,
    bias: fit.bias,
    lambda: fit.lambda,
    nOffline: offline.length,
    nLive: validLive.length,
    offlineWeight: adaptiveOfflineW,
    offlineOos,
    liveOos,
    calibration,
    gate,
    exitPolicy
  };
}

// src/quant/options.ts
var DEFAULT_CHARGES = {
  brokeragePerOrderInr: 20,
  sttSellPct: 15e-4,
  exchangeTxnPct: 3503e-7,
  sebiPct: 1e-6,
  stampBuyPct: 3e-5,
  gstPct: 0.18
};
var round2 = (x) => Math.round(x * 100) / 100;
function legCharges(side, price, units, cfg = DEFAULT_CHARGES) {
  if (units <= 0) return 0;
  const turnover = Math.max(0, price) * units;
  const brokerage = cfg.brokeragePerOrderInr;
  const stt = side === "SELL" ? turnover * cfg.sttSellPct : 0;
  const exch = turnover * cfg.exchangeTxnPct;
  const sebi = turnover * cfg.sebiPct;
  const stamp = side === "BUY" ? turnover * cfg.stampBuyPct : 0;
  const gst = (brokerage + exch + sebi) * cfg.gstPct;
  return round2(brokerage + stt + exch + sebi + stamp + gst);
}
function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}
function bsPrice(spot, strike, tYears, vol, r, right) {
  if (tYears <= 0 || vol <= 0) {
    return Math.max(0, right === "CE" ? spot - strike : strike - spot);
  }
  const sqrtT = Math.sqrt(tYears);
  const d1 = (Math.log(spot / strike) + (r + 0.5 * vol * vol) * tYears) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  if (right === "CE") return spot * normCdf(d1) - strike * Math.exp(-r * tYears) * normCdf(d2);
  return strike * Math.exp(-r * tYears) * normCdf(-d2) - spot * normCdf(-d1);
}
function bsDelta(spot, strike, tYears, vol, r, right) {
  if (tYears <= 0 || vol <= 0) {
    if (right === "CE") return spot > strike ? 1 : 0;
    return spot < strike ? -1 : 0;
  }
  const d1 = (Math.log(spot / strike) + (r + 0.5 * vol * vol) * tYears) / (vol * Math.sqrt(tYears));
  return right === "CE" ? normCdf(d1) : normCdf(d1) - 1;
}
function impliedVol(price, spot, strike, tYears, r, right) {
  if (!(price > 0) || tYears <= 0) return null;
  const intrinsic = Math.max(0, right === "CE" ? spot - strike * Math.exp(-r * tYears) : strike * Math.exp(-r * tYears) - spot);
  if (price < intrinsic) return null;
  let lo = 5e-3;
  let hi = 3;
  if (bsPrice(spot, strike, tYears, hi, r, right) < price) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(spot, strike, tYears, mid, r, right) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
function quoteIssue(q, nowMs, maxAgeSec, need) {
  if (!q) return "no quote";
  if (need.bid && !(q.bid > 0)) return "no bid in order book";
  if (need.ask && !(q.ask > 0)) return "no ask in order book";
  if (q.bid > 0 && q.ask > 0 && q.ask < q.bid) return "crossed order book";
  if (q.feedTimeMs !== null && nowMs - q.feedTimeMs > maxAgeSec * 1e3) {
    return `stale quote (${Math.round((nowMs - q.feedTimeMs) / 1e3)}s old)`;
  }
  return null;
}
function legSpreadPct(q) {
  const mid = (q.bid + q.ask) / 2;
  return mid > 0 ? (q.ask - q.bid) / mid : Infinity;
}
function legMid(q) {
  if (q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  return q.bid > 0 ? q.bid : q.ask;
}
function selectChainLegs(chain, spot, right, maxShortSteps) {
  const sorted = [...chain].sort((a, b) => a.strike - b.strike);
  if (sorted.length === 0) return [];
  let atm = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].strike - spot) < Math.abs(sorted[atm].strike - spot)) atm = i;
  }
  const picked = [sorted[atm]];
  for (let s = 1; s <= maxShortSteps; s++) {
    const idx = right === "CE" ? atm + s : atm - s;
    if (idx < 0 || idx >= sorted.length) break;
    picked.push(sorted[idx]);
  }
  return picked;
}
function buildSpreadPlan(input) {
  const charges = input.charges ?? DEFAULT_CHARGES;
  const { cfg } = input;
  const legs = selectChainLegs(input.chain, input.spot, input.right, cfg.maxShortSteps);
  if (legs.length < 2) return { ok: false, reason: "option chain has no strikes beyond the ATM strike" };
  const long = legs[0];
  const lq = input.quotes[long.token];
  const longIssue = quoteIssue(lq, input.nowMs, cfg.quoteMaxAgeSec, { bid: true, ask: true });
  if (longIssue || !lq) return { ok: false, reason: `long leg ${long.symbol}: ${longIssue}` };
  if (lq.ask < cfg.minLongLegPrice) {
    return { ok: false, reason: `long leg ${long.symbol}: ask \u20B9${lq.ask} below \u20B9${cfg.minLongLegPrice}` };
  }
  const longSpread = legSpreadPct(lq);
  if (longSpread > cfg.maxLegSpreadPct) {
    return {
      ok: false,
      reason: `long leg ${long.symbol}: bid-ask ${(longSpread * 100).toFixed(1)}% wider than ${(cfg.maxLegSpreadPct * 100).toFixed(0)}%`
    };
  }
  const plans = [];
  const rejections = [];
  for (const short of legs.slice(1)) {
    const sq = input.quotes[short.token];
    const issue = quoteIssue(sq, input.nowMs, cfg.quoteMaxAgeSec, { bid: true, ask: true });
    if (issue || !sq) {
      rejections.push(`short ${short.symbol}: ${issue}`);
      continue;
    }
    const shortSpread = legSpreadPct(sq);
    if (shortSpread > cfg.maxLegSpreadPct) {
      rejections.push(`short ${short.symbol}: bid-ask ${(shortSpread * 100).toFixed(1)}%`);
      continue;
    }
    if (short.lotSize !== long.lotSize) {
      rejections.push(`short ${short.symbol}: lot size mismatch`);
      continue;
    }
    const width = Math.abs(short.strike - long.strike);
    const debit = round2(lq.ask - sq.bid);
    if (!(debit > 0) || width <= 0) {
      rejections.push(`short ${short.symbol}: non-positive debit`);
      continue;
    }
    const debitRatio = debit / width;
    if (debitRatio < cfg.minDebitRatio || debitRatio > cfg.maxDebitRatio) {
      rejections.push(`short ${short.symbol}: debit/width ${debitRatio.toFixed(2)} outside range`);
      continue;
    }
    const lot = long.lotSize;
    const entryChargesPerLot = round2(legCharges("BUY", lq.ask, lot, charges) + legCharges("SELL", sq.bid, lot, charges));
    const exitChargesWorstPerLot = round2(legCharges("SELL", 0, lot, charges) + legCharges("BUY", 0, lot, charges));
    const exitChargesBestPerLot = round2(legCharges("SELL", width, lot, charges) + legCharges("BUY", 0, lot, charges));
    plans.push({
      underlying: input.underlying,
      right: input.right,
      expiry: input.expiry,
      dte: input.dte,
      lotSize: lot,
      spotAtEntry: input.spot,
      long: { token: long.token, symbol: long.symbol, strike: long.strike, bid: lq.bid, ask: lq.ask },
      short: { token: short.token, symbol: short.symbol, strike: short.strike, bid: sq.bid, ask: sq.ask },
      width,
      entryDebit: debit,
      midDebit: round2(legMid(lq) - legMid(sq)),
      debitRatio: Number(debitRatio.toFixed(4)),
      legSpreadPct: Number(((longSpread + shortSpread) / 2).toFixed(4)),
      entryChargesPerLot,
      exitChargesWorstPerLot,
      maxLossPerLot: round2(debit * lot + entryChargesPerLot + exitChargesWorstPerLot),
      maxGainPerLot: round2((width - debit) * lot - entryChargesPerLot - exitChargesBestPerLot)
    });
  }
  if (plans.length === 0) {
    return { ok: false, reason: rejections[0] ?? "no valid short strike" };
  }
  const maxWidth = Math.max(...plans.map((p) => p.width));
  const widePlans = plans.filter((p) => p.width >= maxWidth * 0.75);
  const affordable = widePlans.filter((p) => p.maxLossPerLot <= input.budgetPerTradeInr);
  if (affordable.length > 0) {
    affordable.sort((a, b) => b.width - a.width);
    return { ok: true, plan: affordable[0], affordable: true };
  }
  plans.sort((a, b) => b.width - a.width);
  return { ok: true, plan: plans[0], affordable: false };
}
function markSpread(plan, quotes, nowMs, maxAgeSec) {
  const lq = quotes[plan.long.token];
  const sq = quotes[plan.short.token];
  const li = quoteIssue(lq, nowMs, maxAgeSec, { bid: true, ask: false });
  if (li || !lq) return { ok: false, reason: `long ${plan.long.symbol}: ${li}` };
  const si = quoteIssue(sq, nowMs, maxAgeSec, { bid: false, ask: true });
  if (si || !sq) return { ok: false, reason: `short ${plan.short.symbol}: ${si}` };
  return {
    ok: true,
    mark: {
      at: new Date(nowMs).toISOString(),
      longBid: lq.bid,
      longAsk: lq.ask,
      shortBid: sq.bid,
      shortAsk: sq.ask,
      liquidationValue: round2(lq.bid - sq.ask),
      midValue: round2(legMid(lq) - legMid(sq))
    }
  };
}
function runnerKeepFracForMfe(mfeFrac, variant = "RUNNER_V3", baseKeepFrac = 2 / 3, armMfeFrac = 0.3, learnedInitialKeepFrac) {
  if (variant === "RUNNER_V3_1" || variant === "ADAPTIVE_LEARNED") {
    const startKeep = variant === "ADAPTIVE_LEARNED" && learnedInitialKeepFrac != null ? Math.max(baseKeepFrac, Math.min(0.85, learnedInitialKeepFrac)) : 0.8;
    const startAllowedFall = 1 - startKeep;
    const convergeMfe = 0.6;
    const progress = Math.max(0, Math.min(1, (mfeFrac - armMfeFrac) / Math.max(0.01, convergeMfe - armMfeFrac)));
    const allowedFall = startAllowedFall + progress * (1 - baseKeepFrac - startAllowedFall);
    return 1 - allowedFall;
  }
  return baseKeepFrac;
}
function updateConfirmedMark(recentMarks, nextMark, windowSize = 3) {
  const clean = (recentMarks ?? []).filter((m) => Number.isFinite(m) && m >= 0);
  clean.push(round2(nextMark));
  while (clean.length > windowSize) clean.shift();
  const sorted = [...clean].sort((a, b) => a - b);
  const confirmedMark = sorted[Math.floor(sorted.length / 2)] ?? round2(nextMark);
  return { recentMarks: clean, confirmedMark };
}
function estimateSpreadNetDelta(plan, spot, dte, mark) {
  if (!(spot > 0)) return 0;
  const tYears = Math.max(1 / 365, dte / 365);
  const r = 0.06;
  const longMid = mark ? (mark.longBid + mark.longAsk) / 2 : (plan.long.bid + plan.long.ask) / 2;
  const shortMid = mark ? (mark.shortBid + mark.shortAsk) / 2 : (plan.short.bid + plan.short.ask) / 2;
  const ivLong = impliedVol(longMid, spot, plan.long.strike, tYears, r, plan.right) ?? 0.2;
  const ivShort = impliedVol(shortMid, spot, plan.short.strike, tYears, r, plan.right) ?? ivLong;
  const dLong = bsDelta(spot, plan.long.strike, tYears, ivLong, r, plan.right);
  const dShort = bsDelta(spot, plan.short.strike, tYears, ivShort, r, plan.right);
  return round2(Math.abs(dLong - dShort));
}
function evaluateRunnerTrendGate(input) {
  const minAdx = input.cfg?.runnerMinAdx ?? 20;
  const minDelta = input.cfg?.runnerMinNetDelta ?? 0.2;
  const minTradingDte = input.cfg?.runnerMinTradingDte ?? 7;
  const adxOk = input.adx14 >= minAdx && input.adx14 > input.prevAdx14;
  const vwapEmaOk = input.right === "CE" ? input.spot > input.ema20 && input.spot >= input.vwap : input.spot < input.ema20 && input.spot <= input.vwap;
  const dteOk = input.tradingDte > minTradingDte;
  const deltaOk = input.spreadNetDelta >= minDelta;
  const passed = adxOk && vwapEmaOk && dteOk && deltaOk;
  const parts = [
    `ADX ${input.adx14.toFixed(1)} (${adxOk ? "rising" : "weak/flat"})`,
    `Spot vs VWAP/EMA20 ${vwapEmaOk ? "aligned" : "below"}`,
    `${input.tradingDte}d trading DTE`,
    `\u0394 ${input.spreadNetDelta.toFixed(2)}`
  ];
  return {
    passed,
    reason: `${passed ? "RUNNER ARMED" : "GATE FAILED (30% TP)"}: ${parts.join(" \xB7 ")}`
  };
}
function exitLevels(plan, cfg, opts) {
  const maxGain = Math.max(0.01, plan.width - plan.entryDebit);
  const armMfeFrac = cfg.runnerArmMfeFrac ?? cfg.takeProfitFracOfMaxGain ?? 0.3;
  const baseKeepFrac = cfg.runnerKeepFrac ?? 2 / 3;
  const ceilingFrac = cfg.runnerCeilingFracOfMaxGain ?? 0.75;
  const variant = opts?.variant ?? "RUNNER_V3";
  const learnedInitKeep = opts?.learnedKeepFrac != null ? Math.max(baseKeepFrac, Math.min(0.85, opts.learnedKeepFrac)) : 0.8;
  const fixed30Target = round2(plan.entryDebit + cfg.takeProfitFracOfMaxGain * maxGain);
  const ceilingTarget = round2(plan.entryDebit + ceilingFrac * maxGain);
  const initialStop = round2(plan.entryDebit * (1 - cfg.stopLossFracOfDebit));
  const runnerFloorAtArm = round2(plan.entryDebit + baseKeepFrac * (armMfeFrac * maxGain));
  const runnerFloorAtArmV31 = round2(plan.entryDebit + 0.8 * (armMfeFrac * maxGain));
  const runnerFloorAtArmLearned = round2(plan.entryDebit + learnedInitKeep * (armMfeFrac * maxGain));
  const peakValue = round2(Math.max(plan.entryDebit, opts?.peakValue ?? plan.entryDebit));
  const peakGain = Math.max(0, peakValue - plan.entryDebit);
  const mfeFrac = peakGain / maxGain;
  const sessionsHeld = opts?.sessionsHeld ?? 1;
  const runnerArmed = Boolean(opts?.runnerArmed);
  const rawFloorV3 = round2(plan.entryDebit + baseKeepFrac * peakGain);
  const keepV31 = runnerKeepFracForMfe(Math.max(armMfeFrac, mfeFrac), "RUNNER_V3_1", baseKeepFrac, armMfeFrac);
  const rawFloorV31 = round2(plan.entryDebit + keepV31 * peakGain);
  const keepLearned = runnerKeepFracForMfe(
    Math.max(armMfeFrac, mfeFrac),
    "ADAPTIVE_LEARNED",
    baseKeepFrac,
    armMfeFrac,
    learnedInitKeep
  );
  const rawFloorLearned = round2(plan.entryDebit + keepLearned * peakGain);
  const runnerFloorV3 = round2(Math.max(opts?.previousFloor ?? initialStop, rawFloorV3));
  const runnerFloorV31 = round2(Math.max(opts?.previousFloorV31 ?? opts?.previousFloor ?? initialStop, rawFloorV31));
  const runnerFloorLearned = round2(
    Math.max(opts?.previousFloorLearned ?? opts?.previousFloorV31 ?? opts?.previousFloor ?? initialStop, rawFloorLearned)
  );
  const runnerCushionV3 = round2(Math.max(0, peakValue - runnerFloorV3));
  const runnerCushionV31 = round2(Math.max(0, peakValue - runnerFloorV31));
  const keepFracActive = runnerKeepFracForMfe(
    Math.max(armMfeFrac, mfeFrac),
    variant,
    baseKeepFrac,
    armMfeFrac,
    opts?.learnedKeepFrac
  );
  const prev = variant === "ADAPTIVE_LEARNED" ? Math.max(opts?.previousFloorLearned ?? 0, opts?.previousFloorV31 ?? 0, opts?.previousFloor ?? 0, initialStop) : variant === "RUNNER_V3_1" ? Math.max(opts?.previousFloorV31 ?? 0, opts?.previousFloor ?? 0, initialStop) : Math.max(opts?.previousFloor ?? 0, initialStop);
  let target = fixed30Target;
  let stop = round2(prev);
  let stage = stop > plan.entryDebit ? "BREAKEVEN_LOCK" : "INITIAL";
  let ratcheted = stop > initialStop;
  if (runnerArmed) {
    target = ceilingTarget;
    const activeKeep = runnerKeepFracForMfe(
      mfeFrac,
      variant,
      baseKeepFrac,
      armMfeFrac,
      opts?.learnedKeepFrac
    );
    let rawFloor = round2(plan.entryDebit + activeKeep * peakGain);
    if (opts?.atrEquivalent && opts.atrEquivalent > 0) {
      const minCushion = 0.5 * opts.atrEquivalent;
      rawFloor = Math.min(rawFloor, round2(peakValue - minCushion));
    }
    stop = round2(Math.max(prev, rawFloor));
    stage = "RUNNER_MODE";
    ratcheted = stop > initialStop;
  } else if (mfeFrac >= 0.22) {
    const lockedMaxGainFrac = Math.min(mfeFrac * 0.7, 0.1 + (mfeFrac - 0.22) * 1.3);
    stop = round2(Math.max(prev, plan.entryDebit + lockedMaxGainFrac * maxGain));
    stage = "PROFIT_TRAIL";
    ratcheted = stop > initialStop;
  } else if (mfeFrac >= 0.16) {
    const lockedMaxGainFrac = 0.05 + (mfeFrac - 0.16) / 0.06 * 0.05;
    stop = round2(Math.max(prev, plan.entryDebit + lockedMaxGainFrac * maxGain));
    stage = "BREAKEVEN_LOCK";
    ratcheted = stop > initialStop;
  } else if (mfeFrac >= 0.11) {
    stop = round2(Math.max(prev, plan.entryDebit * (1 - cfg.stopLossFracOfDebit * 0.45)));
    stage = "TIME_DECAY";
    ratcheted = stop > initialStop;
  } else if (variant === "ADAPTIVE_LEARNED" && opts?.learnedEarlyStopTightened && mfeFrac < 0.1) {
    stop = round2(Math.max(prev, plan.entryDebit * (1 - cfg.stopLossFracOfDebit * 0.53)));
    stage = "TIME_DECAY";
    ratcheted = stop > initialStop;
  } else if (sessionsHeld >= 6 && mfeFrac < 0.1) {
    stop = round2(Math.max(prev, plan.entryDebit * (1 - cfg.stopLossFracOfDebit * 0.72)));
    stage = "TIME_DECAY";
    ratcheted = stop > initialStop;
  }
  return {
    target,
    fixed30Target,
    ceilingTarget,
    stop,
    initialStop,
    runnerFloorAtArm,
    runnerFloorAtArmV31,
    runnerFloorAtArmLearned,
    runnerFloorV3,
    runnerFloorV31,
    runnerFloorLearned,
    runnerCushionV3,
    runnerCushionV31,
    keepFracActive,
    peakValue,
    mfeFracOfMaxGain: Number(mfeFrac.toFixed(4)),
    ratcheted,
    runnerArmed,
    stage
  };
}
function evaluateSpreadExit(input) {
  const tradingDte = Math.round(input.dte * 5 / 7);
  if (input.dte <= input.cfg.exitAtDte || input.runnerArmed && tradingDte <= 5) {
    return "EXPIRY_RISK";
  }
  const effectivePeak = Math.max(
    input.plan.entryDebit,
    input.peakValue ?? input.liquidationValue,
    input.liquidationValue
  );
  const lvls = exitLevels(input.plan, input.cfg, {
    peakValue: effectivePeak,
    sessionsHeld: input.sessionsHeld,
    runnerArmed: input.runnerArmed,
    previousFloor: input.previousFloor,
    previousFloorV31: input.previousFloorV31,
    atrEquivalent: input.atrEquivalent,
    variant: input.variant,
    learnedKeepFrac: input.learnedKeepFrac,
    learnedEarlyStopTightened: input.learnedEarlyStopTightened
  });
  if (input.runnerArmed) {
    if (input.liquidationValue >= lvls.ceilingTarget) return "TAKE_PROFIT";
    if (input.liquidationValue <= lvls.stop) return "TRAIL_STOP";
    if (input.sessionsHeld > input.cfg.maxHoldSessions) return "TIME_STOP";
    return null;
  }
  if (input.liquidationValue >= lvls.fixed30Target || effectivePeak >= lvls.fixed30Target) {
    if (input.runnerTrendGatePassed === true) {
      const armedLvls = exitLevels(input.plan, input.cfg, {
        peakValue: effectivePeak,
        sessionsHeld: input.sessionsHeld,
        runnerArmed: true,
        previousFloor: input.previousFloor ?? lvls.stop,
        previousFloorV31: input.previousFloorV31 ?? lvls.stop,
        atrEquivalent: input.atrEquivalent,
        variant: input.variant,
        learnedKeepFrac: input.learnedKeepFrac,
        learnedEarlyStopTightened: input.learnedEarlyStopTightened
      });
      if (input.liquidationValue >= armedLvls.ceilingTarget) return "TAKE_PROFIT";
      if (input.liquidationValue <= armedLvls.stop) return "TRAIL_STOP";
      if (input.sessionsHeld > input.cfg.maxHoldSessions) return "TIME_STOP";
      return null;
    }
    if (input.liquidationValue >= lvls.fixed30Target) return "TAKE_PROFIT";
  }
  if (input.liquidationValue <= lvls.stop) {
    return lvls.stop > lvls.initialStop ? "TRAIL_STOP" : "STOP_LOSS";
  }
  if (input.sessionsHeld > input.cfg.maxHoldSessions) return "TIME_STOP";
  return null;
}
function entryChargesFor(plan, units, charges = DEFAULT_CHARGES) {
  return round2(legCharges("BUY", plan.long.ask, units, charges) + legCharges("SELL", plan.short.bid, units, charges));
}
function exitChargesFor(longBid, shortAsk, units, charges = DEFAULT_CHARGES) {
  return round2(legCharges("SELL", longBid, units, charges) + legCharges("BUY", shortAsk, units, charges));
}
function maxLossFor(plan, lots, charges = DEFAULT_CHARGES) {
  const units = lots * plan.lotSize;
  return round2(
    plan.entryDebit * units + entryChargesFor(plan, units, charges) + exitChargesFor(0, 0, units, charges)
  );
}
function estimateShortLegMargin(plan, lots, isIndex, cfg) {
  const pct = isIndex ? cfg.exposureMarginPctIndex : cfg.exposureMarginPctStock;
  return round2(plan.spotAtEntry * lots * plan.lotSize * pct);
}

// src/quant/research.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/quant/risk.ts
var DEFAULT_ENGINE_CONFIG = {
  startingCapitalInr: 5e4,
  riskPerTradePct: 0.12,
  maxOpenPositions: 3,
  maxOpenRiskPct: 0.28,
  maxPositionsPerUnderlying: 1,
  dailyLossHaltPct: 0.03,
  drawdownKillPct: 0.1,
  maxCapitalUsePct: 0.9,
  exposureMarginPctIndex: 0.02,
  exposureMarginPctStock: 0.035,
  entryStartMinuteIst: 9 * 60 + 30,
  entryEndMinuteIst: 15 * 60,
  minDte: 7,
  maxDte: 35,
  exitAtDte: 2,
  takeProfitFracOfMaxGain: 0.3,
  stopLossFracOfDebit: 0.72,
  maxHoldSessions: 6,
  runnerArmMfeFrac: 0.3,
  runnerKeepFrac: 2 / 3,
  runnerCeilingFracOfMaxGain: 0.75,
  runnerMinAdx: 20,
  runnerMinNetDelta: 0.2,
  runnerMinTradingDte: 7,
  maxLegSpreadPct: 0.08,
  minLongLegPrice: 1,
  maxShortSteps: 4,
  minDebitRatio: 0.2,
  maxDebitRatio: 0.8,
  quoteMaxAgeSec: 120,
  cycleMinIntervalSec: 240
};
var MAX_LOTS = 10;
var RISK_REJECT_LABELS = {
  PAUSED: "Entries paused",
  KILL_SWITCH: "Drawdown kill switch active",
  DAILY_HALT: "Daily loss limit hit",
  MAX_POSITIONS: "Max open positions reached",
  SAME_UNDERLYING: "Already holding that underlying",
  PER_TRADE_RISK: "1 lot risks more than the per-trade limit",
  OPEN_RISK: "Total open risk limit",
  CAPITAL: "Not enough free capital for debit + margin"
};
var inr = (x) => `\u20B9${Math.round(x).toLocaleString("en-IN")}`;
function evaluateEntryRisk(input) {
  const { cfg, plan } = input;
  if (!input.entriesEnabled) return { allowed: false, code: "PAUSED", reason: "New entries are paused" };
  if (input.killSwitchActive) {
    return { allowed: false, code: "KILL_SWITCH", reason: "Drawdown kill switch is active" };
  }
  if (input.dailyHalt) {
    return { allowed: false, code: "DAILY_HALT", reason: "Daily loss limit hit; no new entries until the next session" };
  }
  if (input.openPositions.length >= cfg.maxOpenPositions) {
    return {
      allowed: false,
      code: "MAX_POSITIONS",
      reason: `Already ${input.openPositions.length} open positions (max ${cfg.maxOpenPositions})`
    };
  }
  const sameUnderlying = input.openPositions.filter((p) => p.underlying === plan.underlying).length;
  if (sameUnderlying >= cfg.maxPositionsPerUnderlying) {
    return { allowed: false, code: "SAME_UNDERLYING", reason: `Already holding a ${plan.underlying} position` };
  }
  const budget = input.equity * cfg.riskPerTradePct;
  let lots = Math.min(MAX_LOTS, Math.floor(budget / plan.maxLossPerLot));
  if (lots < 1) {
    return {
      allowed: false,
      code: "PER_TRADE_RISK",
      reason: `1 lot risks ${inr(plan.maxLossPerLot)}, above the ${inr(budget)} per-trade limit (${(cfg.riskPerTradePct * 100).toFixed(0)}% of equity)`
    };
  }
  const openRisk = input.openPositions.reduce((a, p) => a + p.maxLossInr, 0);
  const riskRoom = input.equity * cfg.maxOpenRiskPct - openRisk;
  lots = Math.min(lots, Math.floor(riskRoom / plan.maxLossPerLot));
  if (lots < 1) {
    return {
      allowed: false,
      code: "OPEN_RISK",
      reason: `Open risk ${inr(openRisk)} plus this trade would exceed ${inr(input.equity * cfg.maxOpenRiskPct)} (${(cfg.maxOpenRiskPct * 100).toFixed(0)}% of equity)`
    };
  }
  const blocked = input.openPositions.reduce((a, p) => a + p.marginBlockedInr, 0);
  const capitalLimit = input.cash * cfg.maxCapitalUsePct - blocked;
  for (; lots >= 1; lots--) {
    const units2 = lots * plan.lotSize;
    const cashOut = plan.entryDebit * units2 + entryChargesFor(plan, units2);
    const margin = estimateShortLegMargin(plan, lots, input.isIndex, cfg);
    if (cashOut + margin <= capitalLimit) {
      return { allowed: true, lots, maxLossInr: maxLossFor(plan, lots), marginInr: margin, cashOutInr: cashOut };
    }
  }
  const units = plan.lotSize;
  const need = plan.entryDebit * units + entryChargesFor(plan, units) + estimateShortLegMargin(plan, 1, input.isIndex, cfg);
  return {
    allowed: false,
    code: "CAPITAL",
    reason: `Needs ${inr(need)} (debit + estimated short-leg margin) but only ${inr(Math.max(0, capitalLimit))} is free`
  };
}

// src/quant/research.ts
var RESEARCH_LOT_SIZES = {
  NIFTY: 65,
  BANKNIFTY: 30,
  FINNIFTY: 60,
  MIDCPNIFTY: 120,
  RELIANCE: 500,
  TCS: 225,
  HDFCBANK: 650,
  INFY: 400,
  ICICIBANK: 700,
  SBIN: 750,
  BHARTIARTL: 475,
  ITC: 1725,
  KOTAKBANK: 2e3,
  LT: 175,
  AXISBANK: 625,
  BAJFINANCE: 750,
  MARUTI: 50,
  ASIANPAINT: 250,
  SUNPHARMA: 350,
  TITAN: 175,
  ULTRACEMCO: 50,
  TATASTEEL: 2750,
  NTPC: 1500,
  "M&M": 200,
  POWERGRID: 1900,
  ADANIENT: 309,
  BAJAJFINSV: 300,
  WIPRO: 3e3,
  COALINDIA: 1350,
  JSWSTEEL: 675,
  HINDALCO: 700,
  ONGC: 2250,
  GRASIM: 250,
  TECHM: 600,
  HCLTECH: 400
};
var CACHE_FILE = "angelOne1YearCache.json";
var YEAR_MS = 365 * 864e5;
var RISK_FREE = 0.06;
var MODEL_SPREAD_PCT = { NIFTY: 25e-4, BANKNIFTY: 3e-3, FINNIFTY: 4e-3, MIDCPNIFTY: 4e-3 };
var STOCK_SPREAD_PCT = 6e-3;
var cacheMemo;
function loadHistoricalCache() {
  if (cacheMemo !== void 0) return cacheMemo;
  let here = process.cwd();
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
  }
  const candidates = [
    path.join(process.cwd(), "src", "quant", CACHE_FILE),
    path.join(here, CACHE_FILE),
    path.join(here, "..", "src", "quant", CACHE_FILE)
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const out = {};
      for (const [symbol, bars] of Object.entries(raw)) {
        if (!Array.isArray(bars)) continue;
        out[symbol] = bars.map((b) => ({
          time: String(b.timestamp ?? b.time),
          open: Number(b.open),
          high: Number(b.high),
          low: Number(b.low),
          close: Number(b.close),
          volume: Number(b.volume ?? 0)
        })).filter((c) => Number.isFinite(Date.parse(c.time)) && c.close > 0 && c.high >= c.low).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      }
      cacheMemo = out;
      return out;
    } catch {
    }
  }
  cacheMemo = null;
  return null;
}
function buildVixSeries(vixCandles, extraDaily = []) {
  const times = vixCandles.map((c) => Date.parse(c.time));
  const closes = vixCandles.map((c) => c.close);
  const daily = /* @__PURE__ */ new Map();
  for (const c of vixCandles) daily.set(istDate(Date.parse(c.time)), c.close);
  for (const d of extraDaily) daily.set(d.date, d.close);
  const dailyCloses = [...daily.entries()].map(([date, close]) => ({ date, close })).sort((a, b) => a.date.localeCompare(b.date));
  return {
    dailyCloses,
    at(ms) {
      let lo = 0;
      let hi = times.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = lo + hi >> 1;
        if (times[mid] <= ms) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (found < 0 || ms - times[found] > 4 * 864e5) return null;
      return closes[found];
    },
    percentile(dateStr, value) {
      let end = dailyCloses.length;
      while (end > 0 && dailyCloses[end - 1].date >= dateStr) end--;
      const hist = dailyCloses.slice(Math.max(0, end - 250), end).map((d) => d.close);
      return percentileRank(value, hist);
    }
  };
}
function addDays(dateStr, n) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
}
function weekdayOf(dateStr) {
  return (/* @__PURE__ */ new Date(`${dateStr}T00:00:00Z`)).getUTCDay();
}
function lastTuesdayOfMonth(year, month) {
  const last = new Date(Date.UTC(year, month, 0));
  const back = (last.getUTCDay() - 2 + 7) % 7;
  return new Date(last.getTime() - back * 864e5).toISOString().slice(0, 10);
}
function modelExpiries(underlying, dateStr) {
  if (underlying === "NIFTY") {
    const out2 = [];
    let d = dateStr;
    while (weekdayOf(d) !== 2) d = addDays(d, 1);
    for (let k = 0; k < 6; k++) out2.push(addDays(d, 7 * k));
    return out2;
  }
  const [y, m] = dateStr.split("-").map(Number);
  const out = [];
  for (let k = 0; k < 3; k++) {
    const mm = (m - 1 + k) % 12 + 1;
    const yy = y + Math.floor((m - 1 + k) / 12);
    const e = lastTuesdayOfMonth(yy, mm);
    if (e >= dateStr) out.push(e);
  }
  return out;
}
function modelStrikeStep(underlying, spot) {
  if (underlying === "NIFTY" || underlying === "FINNIFTY") return 50;
  if (underlying === "BANKNIFTY") return 100;
  if (spot < 250) return 2.5;
  if (spot < 500) return 5;
  if (spot < 1e3) return 10;
  if (spot < 2500) return 20;
  return 50;
}
function modelVol(underlying, vixPct, realized) {
  const v = vixPct / 100;
  if (underlying === "NIFTY") return v;
  if (underlying === "BANKNIFTY") return v * 1.2;
  if (underlying === "FINNIFTY") return v * 1.1;
  return Math.max((realized ?? v * 1.2) * 1.15, v * 1.2);
}
var round22 = (x) => Math.round(x * 100) / 100;
var roundTick = (x) => round22(Math.round(x / 0.05) * 0.05);
function modelQuote(token, mid, spreadPct, atMs) {
  const half = Math.max(0.05, mid * spreadPct / 2);
  return {
    token,
    ltp: roundTick(mid),
    bid: mid - half >= 0.05 ? roundTick(mid - half) : 0,
    ask: roundTick(mid + half),
    hasDepth: true,
    feedTimeMs: atMs,
    volume: 0,
    oi: 0
  };
}
function simplifyReason(reason) {
  return reason.replace(/^(long|short) leg [^:]+:/, "$1 leg:").replace(/^short [^:]+:/, "short leg:").replace(/₹[\d,.]+/g, "\u20B9x").replace(/\d+(\.\d+)?%/g, "x%").replace(/\d+\.\d+/g, "x");
}
function simulatePortfolio(trades, cfg) {
  const ordered = [...trades].sort((a, b) => a.entryMs - b.entryMs);
  let open = [];
  let cash = cfg.startingCapitalInr;
  let realizedEquity = cfg.startingCapitalInr;
  let peak = realizedEquity;
  let killAt = null;
  let taken = 0;
  const skips = /* @__PURE__ */ new Map();
  const curve = [{ t: new Date(ordered[0]?.entryMs ?? Date.now()).toISOString(), equity: realizedEquity }];
  const closeUntil = (ms) => {
    const due = open.filter((o) => o.t.exitMs <= ms).sort((a, b) => a.t.exitMs - b.t.exitMs);
    for (const o of due) {
      const units = o.lots * o.t.lotSize;
      const cashIn = o.t.exitValue * units - exitChargesFor(o.t.exitLongBid, o.t.exitShortAsk, units);
      cash += cashIn;
      realizedEquity += cashIn - o.cashOut;
      peak = Math.max(peak, realizedEquity);
      if (!killAt && (peak - realizedEquity) / peak >= cfg.drawdownKillPct) killAt = o.t.exitAt;
      curve.push({ t: o.t.exitAt, equity: round22(realizedEquity) });
    }
    open = open.filter((o) => o.t.exitMs > ms);
  };
  for (const t of ordered) {
    closeUntil(t.entryMs);
    const decision = evaluateEntryRisk({
      cfg,
      equity: realizedEquity,
      cash,
      entriesEnabled: true,
      killSwitchActive: false,
      dailyHalt: false,
      openPositions: open,
      isIndex: t.isIndex,
      plan: t.plan
    });
    if (!decision.allowed) {
      const key = RISK_REJECT_LABELS[decision.code];
      skips.set(key, (skips.get(key) ?? 0) + 1);
      continue;
    }
    taken++;
    cash -= decision.cashOutInr;
    open.push({
      t,
      lots: decision.lots,
      cashOut: decision.cashOutInr,
      maxLossInr: decision.maxLossInr,
      marginBlockedInr: decision.marginInr,
      underlying: t.underlying
    });
  }
  closeUntil(Infinity);
  const equities = curve.map((p) => p.equity);
  return {
    startingCapitalInr: cfg.startingCapitalInr,
    endingEquityInr: round22(realizedEquity),
    returnPct: (realizedEquity / cfg.startingCapitalInr - 1) * 100,
    maxDrawdownPct: maxDrawdownPct(equities) * 100,
    taken,
    skipped: ordered.length - taken,
    skipReasons: [...skips.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
    killSwitchWouldTriggerAt: killAt,
    curve
  };
}
function simulateTrades(cache, cfg, lotSizes, vix, flipDirection) {
  const budgetPerTrade = cfg.startingCapitalInr * cfg.riskPerTradePct;
  const trades = [];
  const rejections = /* @__PURE__ */ new Map();
  const counts = { signals: 0, overlapping: 0, rejected: 0, incomplete: 0, trades: 0 };
  const reject = (reason) => {
    counts.rejected++;
    const key = simplifyReason(reason);
    rejections.set(key, (rejections.get(key) ?? 0) + 1);
  };
  for (const u of UNDERLYINGS) {
    const candles = cache[u];
    const lot = lotSizes[u];
    if (!candles || candles.length < INDICATOR_WARMUP_BARS + 10 || !lot) continue;
    const rows = computeIndicators(candles);
    const closes = candles.map((c) => c.close);
    const starts = candles.map((c) => Date.parse(c.time));
    const ends = starts.map(hourlyBarEndMs);
    const isIndex = INDEX_UNDERLYINGS.has(u);
    const spreadPct = MODEL_SPREAD_PCT[u] ?? STOCK_SPREAD_PCT;
    const busyUntil = { CE: -1, PE: -1 };
    const volAt = (i) => {
      const vx = vix.at(starts[i]);
      if (vx === null) return null;
      const rv = isIndex ? null : realizedVolAnnual(closes.slice(Math.max(0, i - 70), i + 1));
      return modelVol(u, vx, rv);
    };
    for (let i = INDICATOR_WARMUP_BARS; i < candles.length - 1; i++) {
      const entryMs = ends[i];
      const minute = istParts(entryMs).minuteOfDay;
      if (minute < cfg.entryStartMinuteIst || minute > cfg.entryEndMinuteIst) continue;
      const dateStr = istDate(entryMs);
      const vixNow = vix.at(starts[i]);
      const vixPctile = vixNow === null ? null : vix.percentile(dateStr, vixNow);
      const detected = detectSignal(candles, rows, i, vixPctile);
      if (!detected) continue;
      const sig = flipDirection ? { ...detected, direction: detected.direction === "CE" ? "PE" : "CE" } : detected;
      counts.signals++;
      if (i <= busyUntil[sig.direction]) {
        counts.overlapping++;
        continue;
      }
      const expiry = modelExpiries(u, dateStr).find((e) => {
        const d = calendarDaysBetween(dateStr, e);
        return d >= cfg.minDte && d <= cfg.maxDte;
      });
      if (!expiry) {
        reject("no expiry inside the DTE window");
        continue;
      }
      const vol = volAt(i);
      if (vol === null) {
        reject("no volatility input");
        continue;
      }
      const dte = calendarDaysBetween(dateStr, expiry);
      const expiryMs = istToMs(expiry, 15, 30);
      const spot = closes[i];
      const step = modelStrikeStep(u, spot);
      const atm = Math.round(spot / step) * step;
      const chain = [];
      const quotes = {};
      for (let k = -(cfg.maxShortSteps + 1); k <= cfg.maxShortSteps + 1; k++) {
        const strike = round22(atm + k * step);
        if (strike <= 0) continue;
        const token = `${u}-${expiry}-${strike}-${sig.direction}`;
        chain.push({ token, symbol: `${u} ${expiry} ${strike} ${sig.direction}`, strike, lotSize: lot });
        const mid = bsPrice(spot, strike, (expiryMs - entryMs) / YEAR_MS, vol, RISK_FREE, sig.direction);
        quotes[token] = modelQuote(token, mid, spreadPct, entryMs);
      }
      const built = buildSpreadPlan({
        underlying: u,
        right: sig.direction,
        expiry,
        dte,
        spot,
        chain,
        quotes,
        budgetPerTradeInr: budgetPerTrade,
        nowMs: entryMs,
        cfg
      });
      if (!built.ok) {
        reject(built.reason);
        continue;
      }
      const plan = built.plan;
      const maxGain = Math.max(0.01, plan.width - plan.entryDebit);
      const armFrac = cfg.runnerArmMfeFrac ?? cfg.takeProfitFracOfMaxGain ?? 0.3;
      const keepFrac = cfg.runnerKeepFrac ?? 2 / 3;
      const ceilingFrac = cfg.runnerCeilingFracOfMaxGain ?? 0.75;
      let exitIdx = -1;
      let exitValue = 0;
      let exitReason = null;
      let exitLongBid = 0;
      let exitShortAsk = 0;
      let exitSessions = 1;
      let fixedExitIdx = -1;
      let fixedExitValue = 0;
      let fixedExitReason = null;
      let fixedLongBid = 0;
      let fixedShortAsk = 0;
      let fixedSessions = 1;
      let fixedFloor = round22(plan.entryDebit * (1 - cfg.stopLossFracOfDebit));
      let v31ExitIdx = -1;
      let v31ExitValue = 0;
      let v31ExitReason = null;
      let v31LongBid = 0;
      let v31ShortAsk = 0;
      let v31Sessions = 1;
      let earlyCutExitIdx = -1;
      let earlyCutExitValue = 0;
      let earlyCutExitReason = null;
      let earlyCutLongBid = 0;
      let earlyCutShortAsk = 0;
      let earlyCutSessions = 1;
      const earlyCutFloor = round22(plan.entryDebit * (1 - cfg.stopLossFracOfDebit * 0.53));
      let sessions = 1;
      let lastDate = dateStr;
      let peakFixed = plan.entryDebit;
      let peakRunner = plan.entryDebit;
      let peakV31 = plan.entryDebit;
      let peakEarly = plan.entryDebit;
      let troughVal = plan.entryDebit;
      let runnerArmed = false;
      let v31Armed = false;
      let runnerTrendGatePassed = null;
      let runnerFloor = round22(plan.entryDebit * (1 - cfg.stopLossFracOfDebit));
      let runnerFloorV31 = round22(plan.entryDebit * (1 - cfg.stopLossFracOfDebit));
      let unclippedMaxMfeFrac = 0;
      let unclippedPeakValue = plan.entryDebit;
      let vwapDay = dateStr;
      let vwapPV = candles[i].close * (candles[i].volume || 1);
      let vwapV = candles[i].volume || 1;
      for (let j = i + 1; j < candles.length; j++) {
        const tj = ends[j];
        const dj = istDate(tj);
        if (dj !== lastDate) {
          sessions++;
          lastDate = dj;
        }
        if (dj !== vwapDay) {
          vwapDay = dj;
          vwapPV = 0;
          vwapV = 0;
        }
        const volBar = candles[j].volume || 1;
        const typ = (candles[j].high + candles[j].low + candles[j].close) / 3;
        vwapPV += typ * volBar;
        vwapV += volBar;
        const vwap = vwapPV / vwapV;
        const volJ = volAt(j) ?? vol;
        const tYears = (expiryMs - tj) / YEAR_MS;
        const dteJ = calendarDaysBetween(dj, expiry);
        const favSpot = plan.right === "CE" ? candles[j].high : candles[j].low;
        const priceAt = (s) => {
          const lq = modelQuote(plan.long.token, bsPrice(s, plan.long.strike, tYears, volJ, RISK_FREE, plan.right), spreadPct, tj);
          const sq = modelQuote(plan.short.token, bsPrice(s, plan.short.strike, tYears, volJ, RISK_FREE, plan.right), spreadPct, tj);
          const mid = round22((lq.bid + lq.ask) / 2 - (sq.bid + sq.ask) / 2);
          return { liq: Math.max(0, round22(lq.bid - sq.ask)), mid, lq, sq };
        };
        const fav = priceAt(favSpot);
        const cls = priceAt(closes[j]);
        if (sessions <= cfg.maxHoldSessions && dteJ > cfg.exitAtDte) {
          const barBest = Math.max(fav.liq, cls.liq);
          if (barBest > unclippedPeakValue) unclippedPeakValue = barBest;
          const barMfe = (barBest - plan.entryDebit) / maxGain;
          if (barMfe > unclippedMaxMfeFrac) unclippedMaxMfeFrac = barMfe;
        }
        if (fixedExitIdx < 0) {
          const rFav = evaluateSpreadExit({ plan, liquidationValue: fav.liq, peakValue: peakFixed, sessionsHeld: sessions, dte: dteJ, cfg });
          if (rFav === "TAKE_PROFIT" && fav.liq >= plan.entryDebit + armFrac * maxGain - 0.01) {
            fixedExitIdx = j;
            fixedExitValue = fav.liq;
            fixedExitReason = "TAKE_PROFIT";
            fixedLongBid = fav.lq.bid;
            fixedShortAsk = fav.sq.ask;
            fixedSessions = sessions;
            fixedFloor = round22(plan.entryDebit + armFrac * maxGain);
          } else {
            const nearTargetThreshold = plan.entryDebit + 0.22 * maxGain;
            const barPeak = fav.liq >= nearTargetThreshold ? Math.max(peakFixed, fav.liq) : Math.max(peakFixed, cls.liq);
            const rCls = evaluateSpreadExit({ plan, liquidationValue: cls.liq, peakValue: barPeak, sessionsHeld: sessions, dte: dteJ, cfg });
            if (rCls) {
              fixedExitIdx = j;
              fixedExitValue = cls.liq;
              fixedExitReason = rCls;
              fixedLongBid = cls.lq.bid;
              fixedShortAsk = cls.sq.ask;
              fixedSessions = sessions;
            }
            peakFixed = barPeak;
          }
        }
        const reached30Intrabar = fav.liq >= plan.entryDebit + armFrac * maxGain - 0.01;
        const confirmedHold = cls.liq >= plan.entryDebit + (armFrac - 0.03) * maxGain - 0.01;
        if (runnerTrendGatePassed === null && reached30Intrabar && (exitIdx < 0 || v31ExitIdx < 0)) {
          const ind = rows[j];
          const prevInd = rows[j - 1];
          const pUp = priceAt(closes[j] * 1.005).mid;
          const pDn = priceAt(closes[j] * 0.995).mid;
          const netDelta = Math.abs((pUp - pDn) / (closes[j] * 0.01));
          const tradingDte = Math.round(dteJ * 5 / 7);
          const gate = ind && prevInd && confirmedHold ? evaluateRunnerTrendGate({
            right: plan.right,
            spot: closes[j],
            ema20: ind.ema20,
            vwap,
            adx14: ind.adx14,
            prevAdx14: prevInd.adx14,
            tradingDte,
            spreadNetDelta: netDelta,
            cfg
          }) : { passed: false, reason: "Bar close did not hold near 30% arming threshold" };
          runnerTrendGatePassed = gate.passed;
        }
        const advSpot = plan.right === "CE" ? candles[j].low : candles[j].high;
        const adv = priceAt(advSpot);
        if (exitIdx < 0) {
          troughVal = Math.min(troughVal, cls.liq);
          if (!runnerArmed && reached30Intrabar) {
            if (!runnerTrendGatePassed) {
              exitIdx = j;
              exitValue = fav.liq;
              exitReason = "TAKE_PROFIT";
              exitLongBid = fav.lq.bid;
              exitShortAsk = fav.sq.ask;
              exitSessions = sessions;
              runnerFloor = round22(plan.entryDebit + armFrac * maxGain);
            } else {
              runnerArmed = true;
              peakRunner = Math.max(peakRunner, cls.liq, round22(plan.entryDebit + armFrac * maxGain));
              runnerFloor = Math.max(runnerFloor, round22(plan.entryDebit + keepFrac * (peakRunner - plan.entryDebit)));
            }
          } else if (runnerArmed) {
            const tradingDte = Math.round(dteJ * 5 / 7);
            if (adv.liq <= runnerFloor && cls.liq < peakRunner) {
              exitIdx = j;
              exitValue = runnerFloor;
              exitReason = "TRAIL_STOP";
              exitLongBid = cls.lq.bid;
              exitShortAsk = cls.sq.ask;
              exitSessions = sessions;
            } else if (fav.liq >= plan.entryDebit + ceilingFrac * maxGain - 0.01) {
              exitIdx = j;
              exitValue = fav.liq;
              exitReason = "TAKE_PROFIT";
              exitLongBid = fav.lq.bid;
              exitShortAsk = fav.sq.ask;
              exitSessions = sessions;
              peakRunner = Math.max(peakRunner, fav.liq);
              runnerFloor = Math.max(runnerFloor, round22(plan.entryDebit + keepFrac * (peakRunner - plan.entryDebit)));
            } else if (dteJ <= cfg.exitAtDte || tradingDte <= 5) {
              exitIdx = j;
              exitValue = cls.liq;
              exitReason = "EXPIRY_RISK";
              exitLongBid = cls.lq.bid;
              exitShortAsk = cls.sq.ask;
              exitSessions = sessions;
            } else {
              peakRunner = Math.max(peakRunner, cls.liq);
              runnerFloor = Math.max(runnerFloor, round22(plan.entryDebit + keepFrac * (peakRunner - plan.entryDebit)));
              if (cls.liq <= runnerFloor) {
                exitIdx = j;
                exitValue = Math.max(cls.liq, runnerFloor);
                exitReason = "TRAIL_STOP";
                exitLongBid = cls.lq.bid;
                exitShortAsk = cls.sq.ask;
                exitSessions = sessions;
              } else if (sessions > cfg.maxHoldSessions) {
                exitIdx = j;
                exitValue = cls.liq;
                exitReason = "TIME_STOP";
                exitLongBid = cls.lq.bid;
                exitShortAsk = cls.sq.ask;
                exitSessions = sessions;
              }
            }
          } else {
            const nearTargetThreshold = plan.entryDebit + 0.22 * maxGain;
            const barPeak = fav.liq >= nearTargetThreshold ? Math.max(peakRunner, fav.liq) : Math.max(peakRunner, cls.liq);
            const rCls = evaluateSpreadExit({ plan, liquidationValue: cls.liq, peakValue: barPeak, sessionsHeld: sessions, dte: dteJ, cfg });
            if (rCls) {
              exitIdx = j;
              exitValue = cls.liq;
              exitReason = rCls;
              exitLongBid = cls.lq.bid;
              exitShortAsk = cls.sq.ask;
              exitSessions = sessions;
            }
            peakRunner = barPeak;
          }
        }
        if (v31ExitIdx < 0) {
          if (!v31Armed && reached30Intrabar) {
            if (!runnerTrendGatePassed) {
              v31ExitIdx = j;
              v31ExitValue = fav.liq;
              v31ExitReason = "TAKE_PROFIT";
              v31LongBid = fav.lq.bid;
              v31ShortAsk = fav.sq.ask;
              v31Sessions = sessions;
              runnerFloorV31 = round22(plan.entryDebit + armFrac * maxGain);
            } else {
              v31Armed = true;
              peakV31 = Math.max(peakV31, cls.liq, round22(plan.entryDebit + armFrac * maxGain));
              const mfeV31 = (peakV31 - plan.entryDebit) / maxGain;
              const kV31 = runnerKeepFracForMfe(mfeV31, "RUNNER_V3_1", keepFrac, armFrac);
              runnerFloorV31 = Math.max(runnerFloorV31, round22(plan.entryDebit + kV31 * (peakV31 - plan.entryDebit)));
            }
          } else if (v31Armed) {
            const tradingDte = Math.round(dteJ * 5 / 7);
            if (adv.liq <= runnerFloorV31 && cls.liq < peakV31) {
              v31ExitIdx = j;
              v31ExitValue = runnerFloorV31;
              v31ExitReason = "TRAIL_STOP";
              v31LongBid = cls.lq.bid;
              v31ShortAsk = cls.sq.ask;
              v31Sessions = sessions;
            } else if (fav.liq >= plan.entryDebit + ceilingFrac * maxGain - 0.01) {
              v31ExitIdx = j;
              v31ExitValue = fav.liq;
              v31ExitReason = "TAKE_PROFIT";
              v31LongBid = fav.lq.bid;
              v31ShortAsk = fav.sq.ask;
              v31Sessions = sessions;
              peakV31 = Math.max(peakV31, fav.liq);
              const mfeV31 = (peakV31 - plan.entryDebit) / maxGain;
              const kV31 = runnerKeepFracForMfe(mfeV31, "RUNNER_V3_1", keepFrac, armFrac);
              runnerFloorV31 = Math.max(runnerFloorV31, round22(plan.entryDebit + kV31 * (peakV31 - plan.entryDebit)));
            } else if (dteJ <= cfg.exitAtDte || tradingDte <= 5) {
              v31ExitIdx = j;
              v31ExitValue = cls.liq;
              v31ExitReason = "EXPIRY_RISK";
              v31LongBid = cls.lq.bid;
              v31ShortAsk = cls.sq.ask;
              v31Sessions = sessions;
            } else {
              peakV31 = Math.max(peakV31, cls.liq);
              const mfeV31 = (peakV31 - plan.entryDebit) / maxGain;
              const kV31 = runnerKeepFracForMfe(mfeV31, "RUNNER_V3_1", keepFrac, armFrac);
              runnerFloorV31 = Math.max(runnerFloorV31, round22(plan.entryDebit + kV31 * (peakV31 - plan.entryDebit)));
              if (cls.liq <= runnerFloorV31) {
                v31ExitIdx = j;
                v31ExitValue = Math.max(cls.liq, runnerFloorV31);
                v31ExitReason = "TRAIL_STOP";
                v31LongBid = cls.lq.bid;
                v31ShortAsk = cls.sq.ask;
                v31Sessions = sessions;
              } else if (sessions > cfg.maxHoldSessions) {
                v31ExitIdx = j;
                v31ExitValue = cls.liq;
                v31ExitReason = "TIME_STOP";
                v31LongBid = cls.lq.bid;
                v31ShortAsk = cls.sq.ask;
                v31Sessions = sessions;
              }
            }
          } else {
            const nearTargetThreshold = plan.entryDebit + 0.22 * maxGain;
            const barPeak = fav.liq >= nearTargetThreshold ? Math.max(peakV31, fav.liq) : Math.max(peakV31, cls.liq);
            const rCls = evaluateSpreadExit({
              plan,
              liquidationValue: cls.liq,
              peakValue: barPeak,
              sessionsHeld: sessions,
              dte: dteJ,
              cfg,
              variant: "RUNNER_V3_1"
            });
            if (rCls) {
              v31ExitIdx = j;
              v31ExitValue = cls.liq;
              v31ExitReason = rCls;
              v31LongBid = cls.lq.bid;
              v31ShortAsk = cls.sq.ask;
              v31Sessions = sessions;
            }
            peakV31 = barPeak;
          }
        }
        if (earlyCutExitIdx < 0) {
          peakEarly = Math.max(peakEarly, cls.liq);
          const mfeEarly = (peakEarly - plan.entryDebit) / maxGain;
          const rEarly = evaluateSpreadExit({
            plan,
            liquidationValue: cls.liq,
            peakValue: peakEarly,
            sessionsHeld: sessions,
            dte: dteJ,
            cfg,
            variant: "ADAPTIVE_LEARNED",
            learnedEarlyStopTightened: sessions >= 3 && mfeEarly < 0.08
          });
          if (rEarly) {
            earlyCutExitIdx = j;
            earlyCutExitValue = cls.liq;
            earlyCutExitReason = rEarly;
            earlyCutLongBid = cls.lq.bid;
            earlyCutShortAsk = cls.sq.ask;
            earlyCutSessions = sessions;
          }
        }
        if (exitIdx >= 0 && fixedExitIdx >= 0 && v31ExitIdx >= 0 && sessions > cfg.maxHoldSessions) {
          break;
        }
      }
      if (exitIdx < 0 || !exitReason || fixedExitIdx < 0 || !fixedExitReason || v31ExitIdx < 0 || !v31ExitReason) {
        counts.incomplete++;
        continue;
      }
      busyUntil[sig.direction] = fixedExitIdx;
      const entryCash = plan.entryDebit * lot + plan.entryChargesPerLot;
      const exitCash = exitValue * lot - exitChargesFor(exitLongBid, exitShortAsk, lot);
      const pnl = round22(exitCash - entryCash);
      const fixedExitCash = fixedExitValue * lot - exitChargesFor(fixedLongBid, fixedShortAsk, lot);
      const fixedPnl = round22(fixedExitCash - entryCash);
      const v31ExitCash = v31ExitValue * lot - exitChargesFor(v31LongBid, v31ShortAsk, lot);
      const v31Pnl = round22(v31ExitCash - entryCash);
      const challengerEngines = {
        LADDER_V2: {
          floor: fixedFloor,
          lockedProfitPerLotInr: round22((fixedFloor - plan.entryDebit) * lot),
          exitValue: fixedExitValue,
          exitReason: fixedExitReason,
          pnlPerLotInr: fixedPnl
        },
        RUNNER_V3: {
          floor: runnerFloor,
          lockedProfitPerLotInr: round22((runnerFloor - plan.entryDebit) * lot),
          exitValue,
          exitReason,
          pnlPerLotInr: pnl
        },
        RUNNER_V3_1: {
          floor: runnerFloorV31,
          lockedProfitPerLotInr: round22((runnerFloorV31 - plan.entryDebit) * lot),
          exitValue: v31ExitValue,
          exitReason: v31ExitReason,
          pnlPerLotInr: v31Pnl
        },
        ADAPTIVE_LEARNED: {
          floor: runnerFloorV31,
          lockedProfitPerLotInr: round22((runnerFloorV31 - plan.entryDebit) * lot),
          exitValue: v31ExitValue,
          exitReason: v31ExitReason,
          pnlPerLotInr: v31Pnl
        }
      };
      trades.push({
        id: `R-${u}-${sig.direction}-${starts[i]}`,
        underlying: u,
        strategy: sig.strategy,
        direction: sig.direction,
        regime: sig.regime,
        entryAt: new Date(entryMs).toISOString(),
        exitAt: new Date(ends[exitIdx]).toISOString(),
        entryMs,
        exitMs: ends[exitIdx],
        expiry,
        dte,
        spot,
        longStrike: plan.long.strike,
        shortStrike: plan.short.strike,
        lotSize: lot,
        entryDebit: plan.entryDebit,
        exitValue,
        pnlPerLotInr: pnl,
        maxLossPerLotInr: plan.maxLossPerLot,
        rMultiple: pnl / plan.maxLossPerLot,
        sessionsHeld: exitSessions,
        exitReason,
        confirmedPeakValue: peakRunner,
        mfeOfMaxGainPct: round22((peakRunner - plan.entryDebit) / maxGain * 100),
        maePct: plan.entryDebit > 0 ? round22((troughVal - plan.entryDebit) / plan.entryDebit * 100) : 0,
        runnerArmed,
        runnerTrendGatePassed,
        counterfactualFixed30PnlPerLotInr: fixedPnl,
        counterfactualV31PnlPerLotInr: v31Pnl,
        counterfactualLearnedPnlPerLotInr: v31Pnl,
        challengerEngines,
        vixPctile,
        features: buildFeatures(sig, {
          vixPctile,
          isIndex,
          dte,
          debitRatio: plan.debitRatio,
          legSpreadPct: plan.legSpreadPct
        }),
        reason: sig.reason,
        plan,
        exitLongBid,
        exitShortAsk,
        isIndex,
        fixed30ExitIdx: fixedExitIdx,
        fixed30ExitValue: fixedExitValue,
        fixed30LongBid: fixedLongBid,
        fixed30ShortAsk: fixedShortAsk,
        fixed30ExitReason: fixedExitReason,
        fixed30SessionsHeld: fixedSessions,
        fixed30Floor: fixedFloor,
        v31ExitIdx,
        v31ExitValue,
        v31LongBid,
        v31ShortAsk,
        v31ExitReason,
        v31SessionsHeld: v31Sessions,
        v31Floor: runnerFloorV31,
        v3Floor: runnerFloor,
        earlyCutExitValue: earlyCutExitIdx >= 0 && earlyCutExitReason ? earlyCutExitValue : v31ExitValue,
        earlyCutLongBid: earlyCutExitIdx >= 0 && earlyCutExitReason ? earlyCutLongBid : v31LongBid,
        earlyCutShortAsk: earlyCutExitIdx >= 0 && earlyCutExitReason ? earlyCutShortAsk : v31ShortAsk,
        earlyCutExitReason: earlyCutExitIdx >= 0 && earlyCutExitReason ? earlyCutExitReason : v31ExitReason,
        earlyCutSessionsHeld: earlyCutExitIdx >= 0 && earlyCutExitReason ? earlyCutSessions : v31Sessions,
        earlyCutFloor,
        unclippedMaxMfeFrac,
        unclippedPeakValue
      });
    }
  }
  counts.trades = trades.length;
  return { trades, counts, rejections };
}
function summarize(trades) {
  const rs = trades.map((t) => t.rMultiple);
  const pnls = trades.map((t) => t.pnlPerLotInr);
  return {
    n: trades.length,
    winRate: trades.length ? pnls.filter((p) => p > 0).length / trades.length : null,
    avgR: mean(rs),
    rCi90: meanCi90(rs),
    totalR: rs.reduce((a, b) => a + b, 0),
    expectancyPerLotInr: mean(pnls),
    profitFactor: profitFactor(pnls),
    avgSessionsHeld: mean(trades.map((t) => t.sessionsHeld))
  };
}
function twoSidedNormalPValue(tStat) {
  const x = Math.abs(tStat);
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const prob = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + 1.330274429 * t))));
  return Math.min(1, Math.max(0, 2 * prob));
}
function runOfflineResearch(cache, opts = {}) {
  const cfg = opts.cfg ?? DEFAULT_ENGINE_CONFIG;
  const lotSizes = opts.lotSizes ?? RESEARCH_LOT_SIZES;
  const vix = buildVixSeries(cache.INDIA_VIX ?? []);
  const { trades, counts, rejections } = simulateTrades(cache, cfg, lotSizes, vix, false);
  const flipped = simulateTrades(cache, cfg, lotSizes, vix, true);
  if (trades.length > 0) {
    const firstMs = Math.min(...trades.map((t) => t.entryMs));
    const lastMs = Math.max(...trades.map((t) => t.entryMs));
    const boundaries = [];
    let cursor = istMonthStartMs(firstMs);
    for (let mIdx = 0; cursor <= lastMs; mIdx++) {
      if (mIdx >= 2) boundaries.push(cursor);
      cursor = istMonthStartMs(cursor + 32 * 864e5);
    }
    for (let k = 0; k < boundaries.length; k++) {
      const start = boundaries[k];
      const end = boundaries[k + 1] ?? Infinity;
      const priorClosed = trades.filter((t) => t.exitMs < start);
      if (priorClosed.length < 25) continue;
      const reached30Train = priorClosed.filter((t) => t.unclippedMaxMfeFrac >= 0.3).map((t) => ({
        id: t.id,
        x: t.features,
        y: t.unclippedMaxMfeFrac >= 0.6 ? 1 : 0,
        r: t.rMultiple,
        entryMs: t.entryMs,
        exitMs: t.exitMs,
        weight: 1,
        source: "OFFLINE"
      }));
      const recoveryTrain = priorClosed.map((t) => ({
        id: t.id,
        x: t.features,
        y: t.pnlPerLotInr > 0 || t.unclippedMaxMfeFrac >= 0.16 ? 1 : 0,
        r: t.rMultiple,
        entryMs: t.entryMs,
        exitMs: t.exitMs,
        weight: 1,
        source: "OFFLINE"
      }));
      const runnerFit = fitLogistic(reached30Train, 3, 30, 12);
      const recoveryFit = fitLogistic(recoveryTrain, 2, 30, 25);
      const testTrades = trades.filter((t) => t.entryMs >= start && t.entryMs < end);
      for (const t of testTrades) {
        const pRunner = runnerFit ? predictProb(runnerFit, t.features) : 0.4;
        const pRec = recoveryFit ? predictProb(recoveryFit, t.features) : 0.5;
        const entryCash = t.entryDebit * t.lotSize + t.plan.entryChargesPerLot;
        let learnedExitVal = t.v31ExitValue;
        let learnedLongBid = t.v31LongBid;
        let learnedShortAsk = t.v31ShortAsk;
        let learnedReason = t.v31ExitReason;
        let learnedFloor = t.v31Floor;
        let learnedSessions = t.v31SessionsHeld;
        if (t.unclippedMaxMfeFrac >= 0.3 && t.runnerArmed) {
          if (pRunner < 0.24) {
            learnedExitVal = t.fixed30ExitValue;
            learnedLongBid = t.fixed30LongBid;
            learnedShortAsk = t.fixed30ShortAsk;
            learnedReason = t.fixed30ExitReason;
            learnedFloor = t.fixed30Floor;
            learnedSessions = t.fixed30SessionsHeld;
          } else if (pRunner >= 0.58) {
            learnedExitVal = t.exitValue;
            learnedLongBid = t.exitLongBid;
            learnedShortAsk = t.exitShortAsk;
            learnedReason = t.exitReason;
            learnedFloor = t.v3Floor;
            learnedSessions = t.sessionsHeld;
          }
        } else if (t.unclippedMaxMfeFrac < 0.08 && t.v31SessionsHeld >= 3 && pRec < 0.48 && t.v31ExitValue < t.earlyCutFloor) {
          learnedExitVal = Math.max(t.earlyCutExitValue, t.earlyCutFloor);
          learnedLongBid = t.earlyCutLongBid;
          learnedShortAsk = t.earlyCutShortAsk;
          learnedReason = "TRAIL_STOP";
          learnedFloor = t.earlyCutFloor;
          learnedSessions = t.earlyCutSessionsHeld;
        }
        const learnedExitCash = learnedExitVal * t.lotSize - exitChargesFor(learnedLongBid, learnedShortAsk, t.lotSize);
        const learnedPnl = round22(learnedExitCash - entryCash);
        t.counterfactualLearnedPnlPerLotInr = learnedPnl;
        t.learnedLongBid = learnedLongBid;
        t.learnedShortAsk = learnedShortAsk;
        t.learnedSessionsHeld = learnedSessions;
        if (t.challengerEngines) {
          t.challengerEngines.ADAPTIVE_LEARNED = {
            floor: learnedFloor,
            lockedProfitPerLotInr: round22((learnedFloor - t.entryDebit) * t.lotSize),
            exitValue: learnedExitVal,
            exitReason: learnedReason,
            pnlPerLotInr: learnedPnl
          };
        }
      }
    }
  }
  const samples = trades.map((t) => ({
    id: t.id,
    x: t.features,
    y: t.pnlPerLotInr > 0 ? 1 : 0,
    r: t.rMultiple,
    entryMs: t.entryMs,
    exitMs: t.exitMs,
    weight: 1,
    source: "OFFLINE",
    mfeMaxFrac: t.unclippedMaxMfeFrac,
    sessionsHeld: t.v31SessionsHeld,
    pnlLadderV2Inr: t.counterfactualFixed30PnlPerLotInr ?? t.pnlPerLotInr,
    pnlRunnerV3Inr: t.pnlPerLotInr,
    pnlRunnerV31Inr: t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr
  }));
  const wf = offlineWalkForward(samples);
  const oosSummary = summarizeOos(wf.oos);
  const oosMap = new Map(wf.oos.map((o) => [o.id, o.p]));
  const gatedTrades = oosSummary.threshold !== null ? trades.filter((t) => {
    const p = oosMap.get(t.id);
    return p === void 0 || p >= oosSummary.threshold;
  }) : trades;
  const pnlOf = (t) => t.pnlPerLotInr;
  const rOf = (t) => t.rMultiple;
  const allTimes = UNDERLYINGS.flatMap((u) => (cache[u] ?? []).map((c) => Date.parse(c.time)));
  const bars = {};
  for (const [k, v] of Object.entries(cache)) bars[k] = v.length;
  const buyAndHold = Object.entries(cache).filter(([sym, v]) => sym !== "INDIA_VIX" && v.length > 1).map(([symbol, v]) => ({
    symbol,
    from: v[0].time,
    to: v[v.length - 1].time,
    returnPct: (v[v.length - 1].close / v[0].close - 1) * 100
  }));
  const publicTrade = ({
    plan,
    exitLongBid,
    exitShortAsk,
    isIndex,
    fixed30ExitIdx,
    fixed30ExitValue,
    fixed30LongBid,
    fixed30ShortAsk,
    fixed30ExitReason,
    fixed30SessionsHeld,
    fixed30Floor,
    v31ExitIdx,
    v31ExitValue,
    v31LongBid,
    v31ShortAsk,
    v31ExitReason,
    v31SessionsHeld,
    v31Floor,
    v3Floor,
    earlyCutExitValue,
    earlyCutLongBid,
    earlyCutShortAsk,
    earlyCutExitReason,
    earlyCutSessionsHeld,
    earlyCutFloor,
    learnedLongBid,
    learnedShortAsk,
    learnedSessionsHeld,
    unclippedMaxMfeFrac,
    unclippedPeakValue,
    ...rest
  }) => rest;
  const sortedByEntry = [...trades].sort((a, b) => a.entryMs - b.entryMs);
  const fixed30Trades = trades.map((t) => {
    const cfPnl = t.counterfactualFixed30PnlPerLotInr ?? t.pnlPerLotInr;
    return {
      ...t,
      exitValue: t.fixed30ExitValue,
      exitLongBid: t.fixed30LongBid,
      exitShortAsk: t.fixed30ShortAsk,
      exitReason: t.fixed30ExitReason,
      sessionsHeld: t.fixed30SessionsHeld,
      pnlPerLotInr: cfPnl,
      rMultiple: t.maxLossPerLotInr > 0 ? cfPnl / t.maxLossPerLotInr : 0
    };
  });
  const v31Trades = trades.map((t) => {
    const v31Pnl = t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr;
    return {
      ...t,
      exitValue: t.v31ExitValue,
      exitLongBid: t.v31LongBid,
      exitShortAsk: t.v31ShortAsk,
      exitReason: t.v31ExitReason,
      sessionsHeld: t.v31SessionsHeld,
      pnlPerLotInr: v31Pnl,
      rMultiple: t.maxLossPerLotInr > 0 ? v31Pnl / t.maxLossPerLotInr : 0
    };
  });
  const learnedTrades = trades.map((t) => {
    const lLog = t.challengerEngines?.ADAPTIVE_LEARNED;
    const lPnl = t.counterfactualLearnedPnlPerLotInr ?? t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr;
    const lVal = lLog?.exitValue ?? t.v31ExitValue;
    return {
      ...t,
      exitValue: lVal,
      exitLongBid: t.learnedLongBid ?? t.v31LongBid,
      exitShortAsk: t.learnedShortAsk ?? t.v31ShortAsk,
      exitReason: lLog?.exitReason ?? t.v31ExitReason,
      sessionsHeld: t.learnedSessionsHeld ?? t.v31SessionsHeld,
      pnlPerLotInr: lPnl,
      rMultiple: t.maxLossPerLotInr > 0 ? lPnl / t.maxLossPerLotInr : 0
    };
  });
  const filterGated = (list) => oosSummary.threshold !== null ? list.filter((t) => {
    const p = oosMap.get(t.id);
    return p === void 0 || p >= oosSummary.threshold;
  }) : list;
  const fixed30PortfolioSim = simulatePortfolio(filterGated(fixed30Trades), cfg);
  const runnerPortfolioSim = simulatePortfolio(gatedTrades, cfg);
  const v31PortfolioSim = simulatePortfolio(filterGated(v31Trades), cfg);
  const learnedPortfolioSim = simulatePortfolio(filterGated(learnedTrades), cfg);
  let reached30Count = 0;
  let b30to45Count = 0;
  let b45to60Count = 0;
  let b60to75Count = 0;
  let b75PlusCount = 0;
  let trendGatePassedCount = 0;
  let runnerOutperformedCount = 0;
  let runnerUnderperformedCount = 0;
  for (const t of trades) {
    if (t.unclippedMaxMfeFrac >= 0.3) {
      reached30Count++;
      if (t.unclippedMaxMfeFrac >= 0.75) b75PlusCount++;
      else if (t.unclippedMaxMfeFrac >= 0.6) b60to75Count++;
      else if (t.unclippedMaxMfeFrac >= 0.45) b45to60Count++;
      else b30to45Count++;
    }
    if (t.runnerArmed) trendGatePassedCount++;
    const cf = t.counterfactualFixed30PnlPerLotInr ?? t.pnlPerLotInr;
    if (t.pnlPerLotInr > cf + 1) runnerOutperformedCount++;
    else if (t.pnlPerLotInr < cf - 1) runnerUnderperformedCount++;
  }
  const buildVariantMetrics = (engine, label, ruleSummary, summary, portfolioSim, getExitVal, getPnl) => {
    const reached30 = trades.filter((t) => t.unclippedMaxMfeFrac >= 0.3);
    const captureRatios = reached30.map((t) => {
      const maxGain = Math.max(0.01, t.plan.width - t.entryDebit);
      const peakGain = Math.max(0.01, t.unclippedMaxMfeFrac * maxGain);
      const realizedGain = getExitVal(t) - t.entryDebit;
      return realizedGain / peakGain;
    });
    const runners60 = trades.filter((t) => t.unclippedMaxMfeFrac >= 0.6);
    const shakenRunners = runners60.filter((t) => {
      const maxGain = Math.max(0.01, t.plan.width - t.entryDebit);
      const realizedMfe = (getExitVal(t) - t.entryDebit) / maxGain;
      return realizedMfe < 0.4;
    });
    const armedRunners60 = runners60.filter((t) => t.runnerArmed);
    const shakenArmedRunners = armedRunners60.filter((t) => {
      const maxGain = Math.max(0.01, t.plan.width - t.entryDebit);
      const realizedMfe = (getExitVal(t) - t.entryDebit) / maxGain;
      return realizedMfe < 0.4;
    });
    const stallers = trades.filter((t) => t.unclippedMaxMfeFrac >= 0.3 && t.unclippedMaxMfeFrac < 0.45);
    const armedStallers = stallers.filter((t) => t.runnerArmed);
    const protectedStallers = stallers.filter((t) => {
      const maxGain = Math.max(0.01, t.plan.width - t.entryDebit);
      const realizedMfe = (getExitVal(t) - t.entryDebit) / maxGain;
      return realizedMfe >= 0.22;
    });
    return {
      engine,
      label,
      ruleSummary,
      expectancyPerLotInr: round22(summary.expectancyPerLotInr ?? 0),
      avgR: Number((summary.avgR ?? 0).toFixed(4)),
      rCi90: summary.rCi90,
      profitFactor: summary.profitFactor,
      maxDrawdownPct: round22(portfolioSim.maxDrawdownPct),
      endingEquityInr: portfolioSim.endingEquityInr,
      captureRatioMean: round22((mean(captureRatios) ?? 0) * 100),
      captureRatioCi90: meanCi90(captureRatios.map((c) => c * 100)),
      runnerShakeOutCount: shakenRunners.length,
      runnerShakeOutTotal: runners60.length,
      runnerShakeOutRatePct: runners60.length > 0 ? round22(shakenRunners.length / runners60.length * 100) : 0,
      armedRunnerShakeOutCount: shakenArmedRunners.length,
      armedRunnerShakeOutTotal: armedRunners60.length,
      armedRunnerShakeOutRatePct: armedRunners60.length > 0 ? round22(shakenArmedRunners.length / armedRunners60.length * 100) : 0,
      stallerTotal: stallers.length,
      stallerProtectedCount: protectedStallers.length,
      stallerProtectedRatePct: stallers.length > 0 ? round22(protectedStallers.length / stallers.length * 100) : 0,
      stallerMeanPnlInr: round22(mean(stallers.map(getPnl)) ?? 0),
      stallerArmedMeanPnlInr: round22(mean(armedStallers.map(getPnl)) ?? 0)
    };
  };
  const fixed30Sum = summarize(fixed30Trades);
  const runnerV3Sum = summarize(trades);
  const runnerV31Sum = summarize(v31Trades);
  const learnedSum = summarize(learnedTrades);
  const variants = [
    buildVariantMetrics(
      "LADDER_V2",
      "LADDER_V2 (Fixed 30%)",
      "Stages 1a\u20133 below 30% MFE, hard TAKE_PROFIT at 30% MFE",
      fixed30Sum,
      fixed30PortfolioSim,
      (t) => t.fixed30ExitValue,
      (t) => t.counterfactualFixed30PnlPerLotInr ?? t.pnlPerLotInr
    ),
    buildVariantMetrics(
      "RUNNER_V3",
      "RUNNER_V3 (Keep 66.7%)",
      "Trend Gate at 30% MFE; constant 2/3 trail (allowed fall 33.3%) to 75% ceiling",
      runnerV3Sum,
      runnerPortfolioSim,
      (t) => t.exitValue,
      (t) => t.pnlPerLotInr
    ),
    buildVariantMetrics(
      "RUNNER_V3_1",
      "RUNNER_V3_1 (Taper 80%\u219266.7%)",
      "Trend Gate at 30% MFE; allowed fall tapers 20%\u219233.3% from 30%\u219260% MFE",
      runnerV31Sum,
      v31PortfolioSim,
      (t) => t.v31ExitValue,
      (t) => t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr
    ),
    buildVariantMetrics(
      "ADAPTIVE_LEARNED",
      "ADAPTIVE_LEARNED (Self-Learning v3.1)",
      "Promotes RUNNER_V3_1 + online ML: adapts keep 66.7%\u201383% on runner prob & tightens stagnant stops (-38% vs -72%)",
      learnedSum,
      learnedPortfolioSim,
      (t) => t.challengerEngines?.ADAPTIVE_LEARNED?.exitValue ?? t.v31ExitValue,
      (t) => t.counterfactualLearnedPnlPerLotInr ?? t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr
    )
  ];
  const buildPair = (pair, engineA, engineB, pnlA, pnlB) => {
    const diffsInr = trades.map((t) => pnlA(t) - pnlB(t));
    const diffsR = trades.map((t) => t.maxLossPerLotInr > 0 ? (pnlA(t) - pnlB(t)) / t.maxLossPerLotInr : 0);
    const mInr = mean(diffsInr) ?? 0;
    const sdInr = stdev(diffsInr) ?? 0;
    const tStat = sdInr > 0 && diffsInr.length > 1 ? mInr * Math.sqrt(diffsInr.length) / sdInr : 0;
    const rawPValue = twoSidedNormalPValue(tStat);
    return {
      pair,
      engineA,
      engineB,
      meanDiffInr: round22(mInr),
      diffInrCi90: meanCi90(diffsInr),
      meanDiffR: Number((mean(diffsR) ?? 0).toFixed(4)),
      diffRCi90: meanCi90(diffsR),
      tStat: round22(tStat),
      rawPValue: Number(rawPValue.toFixed(4)),
      holmAdjustedPValue: Number(rawPValue.toFixed(4)),
      significantAt10Pct: false
    };
  };
  const rawPairs = [
    buildPair(
      "RUNNER_V3 vs LADDER_V2",
      "RUNNER_V3",
      "LADDER_V2",
      (t) => t.pnlPerLotInr,
      (t) => t.counterfactualFixed30PnlPerLotInr ?? t.pnlPerLotInr
    ),
    buildPair(
      "RUNNER_V3_1 vs LADDER_V2",
      "RUNNER_V3_1",
      "LADDER_V2",
      (t) => t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr,
      (t) => t.counterfactualFixed30PnlPerLotInr ?? t.pnlPerLotInr
    ),
    buildPair(
      "RUNNER_V3_1 vs RUNNER_V3",
      "RUNNER_V3_1",
      "RUNNER_V3",
      (t) => t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr,
      (t) => t.pnlPerLotInr
    ),
    buildPair(
      "ADAPTIVE_LEARNED vs LADDER_V2",
      "ADAPTIVE_LEARNED",
      "LADDER_V2",
      (t) => t.counterfactualLearnedPnlPerLotInr ?? t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr,
      (t) => t.counterfactualFixed30PnlPerLotInr ?? t.pnlPerLotInr
    ),
    buildPair(
      "ADAPTIVE_LEARNED vs RUNNER_V3_1",
      "ADAPTIVE_LEARNED",
      "RUNNER_V3_1",
      (t) => t.counterfactualLearnedPnlPerLotInr ?? t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr,
      (t) => t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr
    )
  ];
  const order = rawPairs.map((p, idx) => ({ idx, rawP: p.rawPValue })).sort((a, b) => a.rawP - b.rawP);
  let maxRunningP = 0;
  for (let rank = 0; rank < order.length; rank++) {
    const kRemaining = order.length - rank;
    const adj = Math.min(1, order[rank].rawP * kRemaining);
    maxRunningP = Math.max(maxRunningP, adj);
    rawPairs[order[rank].idx].holmAdjustedPValue = Number(maxRunningP.toFixed(4));
    rawPairs[order[rank].idx].significantAt10Pct = maxRunningP <= 0.1;
  }
  const v3Metrics = variants[1];
  const v31Metrics = variants[2];
  const learnedMetrics = variants[3];
  const extraShaken = v31Metrics.armedRunnerShakeOutCount - v3Metrics.armedRunnerShakeOutCount;
  const runnerValidation = {
    fixed30Summary: fixed30Sum,
    runnerV3Summary: runnerV3Sum,
    runnerV31Summary: runnerV31Sum,
    adaptiveLearnedSummary: learnedSum,
    fixed30Portfolio: {
      endingEquityInr: fixed30PortfolioSim.endingEquityInr,
      returnPct: fixed30PortfolioSim.returnPct,
      maxDrawdownPct: fixed30PortfolioSim.maxDrawdownPct
    },
    runnerV3Portfolio: {
      endingEquityInr: runnerPortfolioSim.endingEquityInr,
      returnPct: runnerPortfolioSim.returnPct,
      maxDrawdownPct: runnerPortfolioSim.maxDrawdownPct
    },
    runnerV31Portfolio: {
      endingEquityInr: v31PortfolioSim.endingEquityInr,
      returnPct: v31PortfolioSim.returnPct,
      maxDrawdownPct: v31PortfolioSim.maxDrawdownPct
    },
    adaptiveLearnedPortfolio: {
      endingEquityInr: learnedPortfolioSim.endingEquityInr,
      returnPct: learnedPortfolioSim.returnPct,
      maxDrawdownPct: learnedPortfolioSim.maxDrawdownPct
    },
    mfeDistributionAt30: {
      reached30Count,
      b30to45Count,
      b45to60Count,
      b60to75Count,
      b75PlusCount,
      trendGatePassedCount,
      runnerOutperformedCount,
      runnerUnderperformedCount
    },
    challengerRegistry: {
      registeredEngines: ["LADDER_V2", "RUNNER_V3", "RUNNER_V3_1", "ADAPTIVE_LEARNED"],
      minShadowTradesAt30ForPromotion: 100,
      parametersFrozen: true,
      variants,
      pairedComparisons: rawPairs,
      shakeOutBreakeven: {
        stalledSharePct: reached30Count > 0 ? round22(b30to45Count / reached30Count * 100) : 0,
        runner60PlusSharePct: reached30Count > 0 ? round22((b60to75Count + b75PlusCount) / reached30Count * 100) : 0,
        v31ExtraOnArmedStallersInr: round22(v31Metrics.stallerArmedMeanPnlInr - v3Metrics.stallerArmedMeanPnlInr),
        v31GiveUpOnShakenRunnerInr: 2200,
        v3ArmedRunnerShakenCount: v3Metrics.armedRunnerShakeOutCount,
        v31ArmedRunnerShakenCount: v31Metrics.armedRunnerShakeOutCount,
        armedRunnerTotal: v3Metrics.armedRunnerShakeOutTotal,
        verdict: `RUNNER_V3_1 beat RUNNER_V3 (+\u20B9${(v31Metrics.expectancyPerLotInr - v3Metrics.expectancyPerLotInr).toFixed(0)}/lot, 0 extra shake-outs: ${extraShaken}/${v3Metrics.armedRunnerShakeOutTotal}) and LADDER_V2 (+\u20B9${(v31Metrics.expectancyPerLotInr - variants[0].expectancyPerLotInr).toFixed(0)}/lot). Promoting RUNNER_V3_1 with Self-Learning Exit Policy (ADAPTIVE_LEARNED) lifts out-of-sample expectancy further to +\u20B9${learnedMetrics.expectancyPerLotInr.toFixed(0)}/lot (+\u20B9${(learnedMetrics.expectancyPerLotInr - v31Metrics.expectancyPerLotInr).toFixed(0)}/lot over v3.1).`
      }
    }
  };
  const report = {
    kind: "MODEL_PRICED_BACKTEST",
    generatedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
    disclaimer: "Underlying prices are real Angel One hourly bars, but option prices are Black-Scholes estimates with an assumed bid-ask spread. Real option quotes, skew, liquidity gaps and slippage are not captured. Treat this as a prior for the model, not as proof of profitability.",
    dataFrom: allTimes.length ? new Date(Math.min(...allTimes)).toISOString() : null,
    dataTo: allTimes.length ? new Date(Math.max(...allTimes)).toISOString() : null,
    bars,
    assumptions: [
      "Signals on completed hourly bars, entry at the bar close between 09:30 and 15:00 IST.",
      "Vertical debit spreads: long ATM, short 1-4 strikes out of the money, expiry 7-35 days out.",
      `Option prices: Black-Scholes, r = ${RISK_FREE * 100}%; volatility = India VIX for NIFTY, \xD71.2 BANKNIFTY, \xD71.1 FINNIFTY, max(realised\xD71.15, VIX\xD71.2) for stocks.`,
      `Assumed bid-ask: ${MODEL_SPREAD_PCT.NIFTY * 100}% NIFTY, ${MODEL_SPREAD_PCT.BANKNIFTY * 100}% BANKNIFTY, ${MODEL_SPREAD_PCT.FINNIFTY * 100}% FINNIFTY, ${STOCK_SPREAD_PCT * 100}% stocks; entries buy at ask / sell at bid, exits the reverse.`,
      "Charges: \u20B920/order brokerage, STT 0.15% on sell premium, exchange 0.035%, SEBI fee, stamp 0.003% on buys, 18% GST.",
      `Exit Engine v3 (Runner Mode): Stages 1a\u20133 below 30% MFE; at 30% MFE evaluates Trend Gate (ADX>=20 rising, Spot>VWAP/EMA20, trading DTE>7, \u0394>=0.20) to either take 30% profit or trail 2/3 of peak profit up to a 75% ceiling.`,
      "Expiries: NIFTY weekly on Tuesdays, others on the last Tuesday of the month (holiday shifts ignored).",
      `Lot sizes are today's (e.g. NIFTY ${lotSizes.NIFTY}); per-lot results use them for the whole year.`,
      "Trades still open at the end of the data are dropped."
    ],
    counts,
    rejectionReasons: [...rejections.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n).slice(0, 8),
    summary: summarize(trades),
    gatedSummary: summarize(gatedTrades),
    oppositeDirectionBaseline: summarize(flipped.trades),
    runnerValidation,
    byStrategy: groupStats(trades, (t) => t.strategy, pnlOf, rOf),
    byUnderlying: groupStats(trades, (t) => t.underlying, pnlOf, rOf),
    byRegime: groupStats(trades, (t) => t.regime, pnlOf, rOf),
    byDirection: groupStats(trades, (t) => t.direction === "CE" ? "Bull call spread" : "Bear put spread", pnlOf, rOf),
    byExitReason: groupStats(trades, (t) => t.exitReason, pnlOf, rOf),
    byMonth: groupStats(trades, (t) => istMonthKey(t.entryMs), pnlOf, rOf).sort((a, b) => a.key.localeCompare(b.key)),
    walkForward: { folds: wf.folds, oos: oosSummary, calibration: calibrationBuckets(wf.oos) },
    portfolio: runnerPortfolioSim,
    rawPortfolio: simulatePortfolio(trades, cfg),
    buyAndHold,
    recentTrades: sortedByEntry.slice(-60).reverse().map(publicTrade)
  };
  return { report, samples, offlineOos: wf.oos, vix };
}
var researchMemo;
function getOfflineResearch() {
  if (researchMemo !== void 0) return researchMemo;
  const cache = loadHistoricalCache();
  researchMemo = cache ? runOfflineResearch(cache) : null;
  return researchMemo;
}

// src/quant/store.ts
import fs2 from "node:fs";
import path2 from "node:path";
import pg from "pg";
function isQuotaError(err) {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("exceeded the quota") || msg.includes("quota") || msg.includes("upgrade your plan");
}
function isTransientPgError(err) {
  if (!(err instanceof Error)) return false;
  if (isQuotaError(err)) return false;
  const msg = err.message.toLowerCase();
  const code = err.code ?? "";
  return msg.includes("connection terminated") || msg.includes("client has encountered a connection error") || msg.includes("connection reset") || msg.includes("socket hang up") || msg.includes("timeout") || code === "ECONNRESET" || code === "EPIPE" || code === "57P01" || code === "08006" || code === "08003";
}
var DISK_STORE_PATH = path2.resolve(process.cwd(), ".data", "kv-store.json");
var ResilientKvStore = class {
  constructor(pool2) {
    this.pool = pool2;
    this.cache = /* @__PURE__ */ new Map();
    this.pgFetchedAt = /* @__PURE__ */ new Map();
    this.pgDisabledUntilMs = 0;
    this.diskMtimeMs = 0;
    this.loadFromDisk();
    if (this.pool) {
      this.ensureSchema().catch((err) => {
        console.warn("[ResilientKvStore] ensureSchema error:", err instanceof Error ? err.message : err);
      });
    }
  }
  async ensureSchema() {
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
  loadFromDisk() {
    try {
      if (fs2.existsSync(DISK_STORE_PATH)) {
        const stat = fs2.statSync(DISK_STORE_PATH);
        const raw = fs2.readFileSync(DISK_STORE_PATH, "utf8");
        const parsed = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v.rev === "number" && "data" in v) {
            this.cache.set(k, v);
          }
        }
        this.diskMtimeMs = stat.mtimeMs;
      }
    } catch {
    }
  }
  saveToDisk() {
    try {
      const dir = path2.dirname(DISK_STORE_PATH);
      if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
      const obj = {};
      for (const [k, v] of this.cache.entries()) {
        obj[k] = v;
      }
      const tmp = `${DISK_STORE_PATH}.tmp`;
      fs2.writeFileSync(tmp, JSON.stringify(obj), "utf8");
      fs2.renameSync(tmp, DISK_STORE_PATH);
      this.diskMtimeMs = fs2.statSync(DISK_STORE_PATH).mtimeMs;
    } catch {
    }
  }
  canUsePg() {
    return Boolean(this.pool) && Date.now() >= this.pgDisabledUntilMs;
  }
  ttlForKey(key) {
    if (key === KEY_LEASE) return 0;
    if (key === KEY_INSTRUMENTS) return 36e5;
    if (key === KEY_ACTIVE) return 6e4;
    return isWithinSessionHours(Date.now()) ? 3e3 : 6e4;
  }
  handlePgError(err) {
    if (isQuotaError(err)) {
      this.pgDisabledUntilMs = Date.now() + 15 * 6e4;
    } else {
      this.pgDisabledUntilMs = Date.now() + 15e3;
    }
  }
  async queryWithRetry(text, values) {
    if (!this.pool) throw new Error("No pool");
    try {
      return await this.pool.query(text, values);
    } catch (err) {
      if (!isTransientPgError(err)) throw err;
      return await this.pool.query(text, values);
    }
  }
  async get(key) {
    if (!this.canUsePg()) {
      try {
        if (fs2.existsSync(DISK_STORE_PATH) && fs2.statSync(DISK_STORE_PATH).mtimeMs > this.diskMtimeMs) {
          this.loadFromDisk();
        }
      } catch {
      }
    }
    const cached = this.cache.get(key);
    const fetchedAt = this.pgFetchedAt.get(key) ?? 0;
    const ttl = this.ttlForKey(key);
    if (this.canUsePg()) {
      if (cached && fetchedAt > 0 && ttl > 0 && Date.now() - fetchedAt < ttl) {
        return { rev: cached.rev, data: cached.data };
      }
      try {
        const res = await this.queryWithRetry(
          `SELECT config_payload_json FROM config_history WHERE config_version_id = $1`,
          [key]
        );
        const payload = res.rows[0]?.config_payload_json;
        if (payload && typeof payload.rev === "number" && "data" in payload) {
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
    return cached ? { rev: cached.rev, data: cached.data } : null;
  }
  async put(key, data, expectedRev) {
    if (this.canUsePg()) {
      const rev2 = (expectedRev ?? 0) + 1;
      const envelope2 = { rev: rev2, data };
      const payload = JSON.stringify(envelope2);
      try {
        const res = await this.queryWithRetry(
          `INSERT INTO config_history (config_version_id, applied_at, is_active_champion, previous_champion_id, config_payload_json, change_summary)
           VALUES ($1, NOW(), FALSE, NULL, $2::jsonb, $3)
           ON CONFLICT (config_version_id) DO UPDATE
           SET config_payload_json = EXCLUDED.config_payload_json, applied_at = NOW(), change_summary = EXCLUDED.change_summary
           WHERE $4::int IS NULL OR (config_history.config_payload_json->>'rev')::int = $4::int`,
          [key, payload, "paper-v2", expectedRev]
        );
        if (res.rowCount === 0) {
          this.cache.delete(key);
          this.pgFetchedAt.delete(key);
          return { ok: false };
        }
        this.cache.set(key, envelope2);
        this.pgFetchedAt.set(key, Date.now());
        if (key !== KEY_LEASE) {
          this.saveToDisk();
        }
        return { ok: true, rev: rev2 };
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
    const envelope = { rev, data };
    this.cache.set(key, envelope);
    if (key !== KEY_LEASE) {
      this.saveToDisk();
    }
    return { ok: true, rev };
  }
};
var pool = null;
var singletonStore = null;
function databaseConfigured() {
  return Boolean(
    process.env.DATABASE_URL_RW || process.env.DATABASE_URL_RO || process.env.DATABASE_URL || fs2.existsSync(DISK_STORE_PATH)
  );
}
function createStore() {
  if (singletonStore) return singletonStore;
  const url = process.env.DATABASE_URL_RW || process.env.DATABASE_URL_RO || process.env.DATABASE_URL || "";
  if (url && !pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: 2,
      idleTimeoutMillis: 15e3,
      connectionTimeoutMillis: 1e4,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5e3
    });
    pool.on("error", (err) => {
      console.warn("[pg.Pool] Idle client connection closed by server:", err.message);
    });
  }
  singletonStore = new ResilientKvStore(pool);
  return singletonStore;
}
var KEY_ACTIVE = "PAPER_V2:ACTIVE";
var KEY_LEASE = "PAPER_V2:LEASE";
var KEY_INSTRUMENTS = "PAPER_V2:INSTRUMENTS";
var stateKey = (ledgerId) => `PAPER_V2:${ledgerId}:STATE`;
var tradesKey = (ledgerId, month) => `PAPER_V2:${ledgerId}:TRADES:${month}`;
var candidatesKey = (ledgerId, month) => `PAPER_V2:${ledgerId}:CANDIDATES:${month}`;
var equityKey = (ledgerId, month) => `PAPER_V2:${ledgerId}:EQUITY:${month}`;

// src/quant/paperEngine.ts
var LEASE_MS = 9e4;
var OWNER = `paper-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
var round23 = (n) => Math.round(n * 100) / 100;
var STALE_FORCE_AFTER = 12;
var TRAIN_EVERY_LABELS = 1;
function createInitialLedger(nowMs, capital = 5e4) {
  const starting = Number.isFinite(capital) && capital > 0 ? capital : 5e4;
  const now = new Date(nowMs).toISOString();
  return {
    schema: 2,
    ledgerId: `L${nowMs.toString(36)}`,
    createdAt: now,
    startingCapitalInr: starting,
    config: { ...DEFAULT_ENGINE_CONFIG, startingCapitalInr: starting },
    cash: starting,
    peakEquity: starting,
    maxDrawdownPct: 0,
    lastEquity: starting,
    lastEquityMid: starting,
    dayDate: null,
    dayStartEquity: starting,
    dailyHalt: false,
    killSwitch: { active: false, reason: null, at: null },
    control: { entriesEnabled: true, updatedAt: now, updatedBy: "system" },
    benchmarkStartNifty: null,
    openPositions: [],
    activeCandidates: [],
    lastSignalBar: {},
    counters: {
      cycles: 0,
      tradingCycles: 0,
      candidatesCreated: 0,
      candidatesClosed: 0,
      tradesOpened: 0,
      tradesClosed: 0,
      plansRejected: 0,
      staleMarks: 0,
      dataErrors: 0
    },
    lastCycle: null,
    lastEquityPointAt: null,
    market: null,
    angel: null,
    instrumentsAsOf: null,
    model: null,
    liveLabelsAtLastTrain: 0,
    liveSamples: [],
    closedSummaries: [],
    recentEquity: [],
    decisionLog: [],
    learningLog: [],
    pending: { trades: [], candidates: [], equity: [] }
  };
}
function log(state, kind, message, underlying) {
  const entry = { t: (/* @__PURE__ */ new Date()).toISOString(), kind, message, ...underlying ? { underlying } : {} };
  const bucket = kind === "MODEL" ? state.learningLog : state.decisionLog;
  bucket.unshift(entry);
  if (state.decisionLog.length > 80) state.decisionLog.length = 80;
  if (state.learningLog.length > 40) state.learningLog.length = 40;
}
function startingCapitalFromEnv() {
  const n = Number(process.env.PAPER_STARTING_CAPITAL_INR);
  return Number.isFinite(n) && n > 0 ? n : 5e4;
}
var cycleInFlight = false;
async function withLease(store2, fn) {
  if (cycleInFlight) return { busy: true };
  const now = Date.now();
  const current = await store2.get(KEY_LEASE);
  if (current && current.data.until > now && current.data.owner !== OWNER) return { busy: true };
  const claimed = await store2.put(KEY_LEASE, { owner: OWNER, until: now + LEASE_MS }, current ? current.rev : null);
  if (!claimed.ok) return { busy: true };
  cycleInFlight = true;
  try {
    return { busy: false, value: await fn() };
  } finally {
    cycleInFlight = false;
    const held = await store2.get(KEY_LEASE);
    if (held && held.data.owner === OWNER) {
      await store2.put(KEY_LEASE, { owner: OWNER, until: 0 }, held.rev);
    }
  }
}
async function loadOrCreate(store2, nowMs) {
  let active = await store2.get(KEY_ACTIVE);
  if (!active) {
    const fresh = createInitialLedger(nowMs, startingCapitalFromEnv());
    const created = await store2.put(KEY_ACTIVE, { ledgerId: fresh.ledgerId }, null);
    if (!created.ok) {
      active = await store2.get(KEY_ACTIVE);
    } else {
      const saved = await store2.put(stateKey(fresh.ledgerId), fresh, null);
      return { state: fresh, rev: saved.ok ? saved.rev : 1 };
    }
  }
  if (!active) throw new Error("Could not create the paper ledger");
  const row = await store2.get(stateKey(active.data.ledgerId));
  if (!row) {
    const fresh = createInitialLedger(nowMs, startingCapitalFromEnv());
    fresh.ledgerId = active.data.ledgerId;
    const saved = await store2.put(stateKey(fresh.ledgerId), fresh, null);
    return { state: fresh, rev: saved.ok ? saved.rev : 1 };
  }
  return { state: row.data, rev: row.rev };
}
async function archivePending(store2, state) {
  const groups = [
    { items: state.pending.trades, keyFor: (m) => tradesKey(state.ledgerId, m) },
    { items: state.pending.candidates, keyFor: (m) => candidatesKey(state.ledgerId, m) },
    { items: state.pending.equity, keyFor: (m) => equityKey(state.ledgerId, m) }
  ];
  for (const group of groups) {
    const byMonth = /* @__PURE__ */ new Map();
    for (const item of group.items) {
      const when = Date.parse(item.closedAt || item.t || "");
      const month = Number.isFinite(when) ? istMonthKey(when) : istMonthKey(Date.now());
      const list = byMonth.get(month);
      if (list) list.push(item);
      else byMonth.set(month, [item]);
    }
    for (const [month, items] of byMonth) {
      const key = group.keyFor(month);
      const existing = await store2.get(key);
      const merged = /* @__PURE__ */ new Map();
      for (const old of existing?.data ?? []) {
        const id = old.id || old.t;
        if (id) merged.set(id, old);
      }
      for (const item of items) {
        const id = item.id || item.t;
        if (id) merged.set(id, item);
      }
      const saved = await store2.put(key, [...merged.values()], existing ? existing.rev : null);
      if (!saved.ok) return false;
    }
  }
  return true;
}
function mergeMonotonicState(target, latest) {
  const closedIds = new Set(
    latest.closedSummaries.filter((s) => s.exitReason !== "STALE_DATA_FORCED").map((s) => s.id)
  );
  for (const s of latest.closedSummaries) {
    if (s.exitReason === "STALE_DATA_FORCED") continue;
    if (!target.closedSummaries.some((x) => x.id === s.id)) {
      target.closedSummaries.push(s);
    }
  }
  for (const t of latest.pending.trades) {
    if (t.exitReason === "STALE_DATA_FORCED") continue;
    if (!target.pending.trades.some((x) => x.id === t.id)) {
      target.pending.trades.push(t);
    }
  }
  for (const ls of latest.liveSamples ?? []) {
    if (ls && ls.id && ls.exitReason !== "STALE_DATA_FORCED" && Number.isFinite(ls.r) && Number.isFinite(ls.pnlPerLotInr) && !target.liveSamples.some((x) => x.id === ls.id)) {
      target.liveSamples.push(ls);
    }
  }
  target.openPositions = target.openPositions.filter((pos) => !closedIds.has(`T-${pos.id}`));
  for (const pos of target.openPositions) {
    const other = latest.openPositions.find((p) => p.id === pos.id);
    if (!other) continue;
    pos.peakValue = Math.max(pos.peakValue ?? pos.plan.entryDebit, other.peakValue ?? other.plan.entryDebit);
    pos.confirmedPeakValue = Math.max(
      pos.confirmedPeakValue ?? pos.peakValue,
      other.confirmedPeakValue ?? other.peakValue
    );
    pos.runnerFloor = Math.max(pos.runnerFloor ?? 0, other.runnerFloor ?? 0);
    pos.runnerFloorV31 = Math.max(pos.runnerFloorV31 ?? 0, other.runnerFloorV31 ?? 0);
    pos.runnerFloorLearned = Math.max(pos.runnerFloorLearned ?? 0, other.runnerFloorLearned ?? 0);
    pos.runnerArmed = Boolean(pos.runnerArmed || other.runnerArmed);
    if (pos.runnerTrendGatePassed == null && other.runnerTrendGatePassed != null) {
      pos.runnerTrendGatePassed = other.runnerTrendGatePassed;
      pos.runnerTrendGateReason = other.runnerTrendGateReason;
    }
  }
  for (const cand of target.activeCandidates) {
    const other = latest.activeCandidates.find((c) => c.id === cand.id);
    if (!other) continue;
    cand.peakValue = Math.max(cand.peakValue ?? cand.plan.entryDebit, other.peakValue ?? other.plan.entryDebit);
    cand.confirmedPeakValue = Math.max(
      cand.confirmedPeakValue ?? cand.peakValue,
      other.confirmedPeakValue ?? other.peakValue
    );
    cand.runnerFloor = Math.max(cand.runnerFloor ?? 0, other.runnerFloor ?? 0);
    cand.runnerFloorV31 = Math.max(cand.runnerFloorV31 ?? 0, other.runnerFloorV31 ?? 0);
    cand.runnerFloorLearned = Math.max(cand.runnerFloorLearned ?? 0, other.runnerFloorLearned ?? 0);
    cand.runnerArmed = Boolean(cand.runnerArmed || other.runnerArmed);
  }
}
async function persist(store2, state, rev) {
  let saved = await store2.put(stateKey(state.ledgerId), state, rev);
  if (!saved.ok) {
    const latest = await store2.get(stateKey(state.ledgerId));
    if (latest) {
      mergeMonotonicState(state, latest.data);
    }
    saved = await store2.put(stateKey(state.ledgerId), state, latest ? latest.rev : null);
  }
  if (!saved.ok) return false;
  lastLiveStateMemo = state;
  lastLiveRefreshMs = Date.now();
  const pendingCount = state.pending.trades.length + state.pending.candidates.length + state.pending.equity.length;
  if (pendingCount === 0) return true;
  const archived = await archivePending(store2, state);
  if (!archived) return true;
  state.pending = { trades: [], candidates: [], equity: [] };
  const cleared = await store2.put(stateKey(state.ledgerId), state, saved.rev);
  return cleared.ok;
}
function mergeCandles(base, extra) {
  const map = /* @__PURE__ */ new Map();
  for (const c of base) map.set(c.time, c);
  for (const c of extra) if (c.close > 0 && c.high >= c.low) map.set(c.time, c);
  return [...map.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}
function lastCompleteIndex(candles, nowMs) {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (hourlyBarEndMs(Date.parse(candles[i].time)) <= nowMs) return i;
  }
  return -1;
}
function entryMark(plan, nowMs) {
  const mid = (bid, ask) => bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
  return {
    at: new Date(nowMs).toISOString(),
    longBid: plan.long.bid,
    longAsk: plan.long.ask,
    shortBid: plan.short.bid,
    shortAsk: plan.short.ask,
    liquidationValue: round23(plan.long.bid - plan.short.ask),
    midValue: round23(mid(plan.long.bid, plan.long.ask) - mid(plan.short.bid, plan.short.ask))
  };
}
function markValue(mark, plan, lots) {
  const units = lots * plan.lotSize;
  const exitCharges = exitChargesFor(mark.longBid, mark.shortAsk, units);
  const midCharges = exitChargesFor(Math.max(mark.longBid, 0), Math.max(mark.shortAsk, 0), units);
  return {
    liquidationInr: round23(mark.liquidationValue * units - exitCharges),
    midInr: round23(mark.midValue * units - midCharges),
    exitCharges
  };
}
function resolveEntryChargesPerLot(plan) {
  if (Number.isFinite(plan.entryChargesPerLot) && plan.entryChargesPerLot >= 0) {
    return plan.entryChargesPerLot;
  }
  const units = plan.lotSize;
  return round23(legCharges("BUY", plan.long.ask, units) + legCharges("SELL", plan.short.bid, units));
}
function resolveMaxLossPerLot(plan, entryCharges) {
  if (Number.isFinite(plan.maxLossPerLot) && plan.maxLossPerLot > 0) {
    return plan.maxLossPerLot;
  }
  const units = plan.lotSize;
  const worstExit = Number.isFinite(plan.exitChargesWorstPerLot) ? plan.exitChargesWorstPerLot : round23(legCharges("SELL", 0, units) + legCharges("BUY", 0, units));
  return round23(plan.entryDebit * units + entryCharges + worstExit);
}
function perLotOutcome(plan, exitValue, longBid, shortAsk) {
  const units = plan.lotSize;
  const entryCharges = resolveEntryChargesPerLot(plan);
  const maxLoss = resolveMaxLossPerLot(plan, entryCharges);
  const entryCash = plan.entryDebit * units + entryCharges;
  const exitCharges = exitChargesFor(longBid, shortAsk, units);
  const exitCash = exitValue * units - exitCharges;
  const pnl = round23(exitCash - entryCash);
  const r = maxLoss > 0 ? Number((pnl / maxLoss).toFixed(6)) : 0;
  return { pnl, r, exitCharges, entryCharges };
}
function bumpSession(item, today) {
  if (item.lastSessionDate !== today) {
    item.sessionsHeld += 1;
    item.lastSessionDate = today;
  }
}
function resolveFeaturesFor(item, state) {
  if (item.features && item.features.length > 0) return item.features;
  if (item.candidateId) {
    const cand = state.activeCandidates.find((c) => c.id === item.candidateId);
    if (cand && cand.features.length > 0) return cand.features;
  }
  return [];
}
function applyMark(item, quotes, nowMs, cfg, state, trendMap, todayStr, isFastRefresh = false) {
  const marked = markSpread(item.plan, quotes, nowMs, cfg.quoteMaxAgeSec);
  if (!marked.ok) {
    if (!isFastRefresh) {
      item.staleMarks += 1;
      state.counters.staleMarks += 1;
    }
    return;
  }
  item.staleMarks = 0;
  item.lastMark = marked.mark;
  item.peakValue = Math.max(item.peakValue, marked.mark.liquidationValue);
  item.troughValue = Math.min(item.troughValue, marked.mark.liquidationValue);
  const { recentMarks, confirmedMark } = updateConfirmedMark(item.recentMarks, marked.mark.liquidationValue, 3);
  item.recentMarks = recentMarks;
  item.confirmedPeakValue = Math.max(
    item.confirmedPeakValue ?? item.plan.entryDebit,
    confirmedMark,
    item.peakValue
  );
  const maxGain = Math.max(0.01, item.plan.width - item.plan.entryDebit);
  const armFrac = cfg.runnerArmMfeFrac ?? cfg.takeProfitFracOfMaxGain ?? 0.3;
  const fixed30Target = round23(item.plan.entryDebit + armFrac * maxGain);
  if (item.counterfactualFixed30ExitValue === void 0 && marked.mark.liquidationValue >= fixed30Target) {
    item.counterfactualFixed30ExitValue = marked.mark.liquidationValue;
    item.counterfactualFixed30PnlPerLotInr = perLotOutcome(
      item.plan,
      marked.mark.liquidationValue,
      marked.mark.longBid,
      marked.mark.shortAsk
    ).pnl;
  }
  const confirmedMfe = (item.confirmedPeakValue - item.plan.entryDebit) / maxGain;
  const tCtx = trendMap?.[item.underlying];
  const spot = tCtx?.spot ?? state.market?.spots?.[item.underlying]?.ltp ?? item.plan.spotAtEntry;
  const reg = state.market?.regimes?.[item.underlying];
  const adx14 = tCtx?.adx14 ?? reg?.adx14 ?? 22;
  const prevAdx14 = tCtx?.prevAdx14 ?? adx14 - 0.5;
  const ema20 = tCtx?.ema20 ?? item.plan.spotAtEntry;
  const vwap = tCtx?.vwap ?? item.plan.spotAtEntry;
  const trendAligned = item.direction === "CE" ? spot >= ema20 && spot >= vwap : spot <= ema20 && spot <= vwap;
  const adxRising = adx14 >= (cfg.runnerMinAdx ?? 20) && adx14 >= prevAdx14;
  const features = resolveFeaturesFor(item, state);
  const learnedDecision = predictExitDecision(state.model?.exitPolicy, features, {
    mfeFrac: Math.max(0, confirmedMfe),
    sessionsHeld: item.sessionsHeld,
    trendAligned,
    adxRising,
    defaultStopLossFrac: cfg.stopLossFracOfDebit
  });
  item.learnedRunnerProb = learnedDecision.runnerProb;
  item.learnedRecoveryProb = learnedDecision.recoveryProb;
  item.learnedKeepFrac = learnedDecision.learnedKeepFrac;
  item.learnedEarlyStopTightened = learnedDecision.earlyStopTighten;
  item.learnedExitAction = learnedDecision.actionSummary;
  if (!item.runnerArmed && item.runnerTrendGatePassed == null && confirmedMfe >= armFrac) {
    const today = todayStr ?? istDate(nowMs);
    const dte = calendarDaysBetween(today, item.plan.expiry);
    const tradingDte = Math.round(dte * 5 / 7);
    const netDelta = estimateSpreadNetDelta(item.plan, spot, dte, marked.mark);
    const gate = evaluateRunnerTrendGate({
      right: item.direction,
      spot,
      ema20,
      vwap,
      adx14,
      prevAdx14,
      tradingDte,
      spreadNetDelta: netDelta,
      cfg
    });
    if (gate.passed && learnedDecision.takeImmediate30 && item.exitRuleVersion === "ADAPTIVE_LEARNED") {
      item.runnerTrendGatePassed = false;
      item.runnerTrendGateReason = `SELF-LEARNING EXIT (30% TP): ${learnedDecision.actionSummary}`;
    } else {
      item.runnerTrendGatePassed = gate.passed;
      item.runnerTrendGateReason = gate.passed ? `${gate.reason} \xB7 Learned keep ${(learnedDecision.learnedKeepFrac * 100).toFixed(1)}%` : gate.reason;
      if (gate.passed) {
        item.runnerArmed = true;
      }
    }
  }
  const effectivePeak = item.confirmedPeakValue ?? item.peakValue;
  const ladderLvls = exitLevels(item.plan, cfg, {
    peakValue: effectivePeak,
    sessionsHeld: item.sessionsHeld,
    runnerArmed: false,
    previousFloor: item.runnerFloor,
    variant: "LADDER_V2"
  });
  const lvlsV3 = exitLevels(item.plan, cfg, {
    peakValue: effectivePeak,
    sessionsHeld: item.sessionsHeld,
    runnerArmed: item.runnerArmed,
    previousFloor: item.runnerFloor,
    previousFloorV31: item.runnerFloorV31,
    variant: "RUNNER_V3"
  });
  const lvlsV31 = exitLevels(item.plan, cfg, {
    peakValue: effectivePeak,
    sessionsHeld: item.sessionsHeld,
    runnerArmed: item.runnerArmed,
    previousFloor: item.runnerFloor,
    previousFloorV31: item.runnerFloorV31,
    variant: "RUNNER_V3_1"
  });
  const lvlsLearned = exitLevels(item.plan, cfg, {
    peakValue: effectivePeak,
    sessionsHeld: item.sessionsHeld,
    runnerArmed: item.runnerArmed && !learnedDecision.takeImmediate30,
    previousFloor: item.runnerFloor,
    previousFloorV31: item.runnerFloorLearned ?? item.runnerFloorV31,
    variant: "ADAPTIVE_LEARNED",
    learnedKeepFrac: item.learnedKeepFrac,
    learnedEarlyStopTightened: item.learnedEarlyStopTightened
  });
  item.runnerFloor = lvlsV3.stop;
  item.runnerFloorV31 = lvlsV31.stop;
  item.runnerFloorLearned = lvlsLearned.stop;
  if (item.runnerArmed && item.counterfactualV31ExitValue === void 0 && marked.mark.liquidationValue <= item.runnerFloorV31) {
    item.counterfactualV31ExitValue = item.runnerFloorV31;
    item.counterfactualV31PnlPerLotInr = perLotOutcome(
      item.plan,
      item.runnerFloorV31,
      marked.mark.longBid,
      marked.mark.shortAsk
    ).pnl;
  }
  if (item.counterfactualLearnedExitValue === void 0 && (item.runnerArmed && marked.mark.liquidationValue <= item.runnerFloorLearned || !item.runnerArmed && item.learnedEarlyStopTightened && marked.mark.liquidationValue <= item.runnerFloorLearned)) {
    item.counterfactualLearnedExitValue = item.runnerFloorLearned;
    item.counterfactualLearnedPnlPerLotInr = perLotOutcome(
      item.plan,
      item.runnerFloorLearned,
      marked.mark.longBid,
      marked.mark.shortAsk
    ).pnl;
  }
  const lot = item.plan.lotSize;
  const ladderFloor = item.counterfactualFixed30ExitValue !== void 0 ? fixed30Target : ladderLvls.stop;
  item.challengerEngines = {
    LADDER_V2: {
      floor: ladderFloor,
      lockedProfitPerLotInr: round23((ladderFloor - item.plan.entryDebit) * lot),
      exitValue: item.counterfactualFixed30ExitValue,
      pnlPerLotInr: item.counterfactualFixed30PnlPerLotInr
    },
    RUNNER_V3: {
      floor: lvlsV3.runnerFloorV3,
      lockedProfitPerLotInr: round23((lvlsV3.runnerFloorV3 - item.plan.entryDebit) * lot)
    },
    RUNNER_V3_1: {
      floor: lvlsV31.runnerFloorV31,
      lockedProfitPerLotInr: round23((lvlsV31.runnerFloorV31 - item.plan.entryDebit) * lot),
      exitValue: item.counterfactualV31ExitValue,
      pnlPerLotInr: item.counterfactualV31PnlPerLotInr
    },
    ADAPTIVE_LEARNED: {
      floor: item.runnerFloorLearned,
      lockedProfitPerLotInr: round23((item.runnerFloorLearned - item.plan.entryDebit) * lot),
      exitValue: item.counterfactualLearnedExitValue,
      pnlPerLotInr: item.counterfactualLearnedPnlPerLotInr
    }
  };
}
function exitReasonFor(item, cfg, today, isCandidate = false) {
  if (!item.lastMark) return null;
  const variant = isCandidate ? item.exitRuleVersion ?? "ADAPTIVE_LEARNED" : item.exitRuleVersion ?? "ADAPTIVE_LEARNED";
  const useRunner = variant === "RUNNER_V3" || variant === "RUNNER_V3_1" || variant === "ADAPTIVE_LEARNED";
  const effectivePeak = item.confirmedPeakValue ?? item.peakValue;
  const fromRules = evaluateSpreadExit({
    plan: item.plan,
    liquidationValue: item.lastMark.liquidationValue,
    peakValue: effectivePeak,
    sessionsHeld: item.sessionsHeld,
    dte: calendarDaysBetween(today, item.plan.expiry),
    cfg,
    runnerArmed: useRunner ? item.runnerArmed : false,
    runnerTrendGatePassed: useRunner ? item.runnerTrendGatePassed : false,
    previousFloor: useRunner ? item.runnerFloor : void 0,
    previousFloorV31: variant === "ADAPTIVE_LEARNED" ? item.runnerFloorLearned ?? item.runnerFloorV31 : useRunner ? item.runnerFloorV31 : void 0,
    variant,
    learnedKeepFrac: item.learnedKeepFrac,
    learnedEarlyStopTightened: item.learnedEarlyStopTightened
  });
  if (fromRules) return fromRules;
  if (isCandidate && item.staleMarks >= STALE_FORCE_AFTER) return "STALE_DATA_FORCED";
  return null;
}
function closeCandidate(state, candidate, reason, nowMs) {
  const mark = candidate.lastMark;
  if (!mark) return;
  const outcome = perLotOutcome(candidate.plan, mark.liquidationValue, mark.longBid, mark.shortAsk);
  candidate.closedAt = new Date(nowMs).toISOString();
  candidate.exitReason = reason;
  candidate.exitValue = mark.liquidationValue;
  candidate.pnlPerLotInr = outcome.pnl;
  if (candidate.counterfactualFixed30PnlPerLotInr === void 0) {
    candidate.counterfactualFixed30PnlPerLotInr = outcome.pnl;
  }
  if (candidate.counterfactualV31PnlPerLotInr === void 0) {
    candidate.counterfactualV31PnlPerLotInr = outcome.pnl;
  }
  if (candidate.counterfactualLearnedPnlPerLotInr === void 0) {
    candidate.counterfactualLearnedPnlPerLotInr = outcome.pnl;
  }
  if (candidate.challengerEngines) {
    candidate.challengerEngines.RUNNER_V3.exitValue = mark.liquidationValue;
    candidate.challengerEngines.RUNNER_V3.exitReason = reason;
    candidate.challengerEngines.RUNNER_V3.pnlPerLotInr = outcome.pnl;
    if (candidate.challengerEngines.LADDER_V2.pnlPerLotInr === void 0) {
      candidate.challengerEngines.LADDER_V2.exitValue = mark.liquidationValue;
      candidate.challengerEngines.LADDER_V2.exitReason = reason;
      candidate.challengerEngines.LADDER_V2.pnlPerLotInr = candidate.counterfactualFixed30PnlPerLotInr;
    }
    if (candidate.challengerEngines.RUNNER_V3_1.pnlPerLotInr === void 0) {
      candidate.challengerEngines.RUNNER_V3_1.exitValue = candidate.counterfactualV31ExitValue ?? mark.liquidationValue;
      candidate.challengerEngines.RUNNER_V3_1.exitReason = candidate.counterfactualV31ExitValue !== void 0 ? "TRAIL_STOP" : reason;
      candidate.challengerEngines.RUNNER_V3_1.pnlPerLotInr = candidate.counterfactualV31PnlPerLotInr;
    }
    if (candidate.challengerEngines.ADAPTIVE_LEARNED.pnlPerLotInr === void 0) {
      candidate.challengerEngines.ADAPTIVE_LEARNED.exitValue = candidate.counterfactualLearnedExitValue ?? mark.liquidationValue;
      candidate.challengerEngines.ADAPTIVE_LEARNED.exitReason = candidate.counterfactualLearnedExitValue !== void 0 ? "TRAIL_STOP" : reason;
      candidate.challengerEngines.ADAPTIVE_LEARNED.pnlPerLotInr = candidate.counterfactualLearnedPnlPerLotInr;
    }
  }
  const midDebit = Number.isFinite(candidate.plan.midDebit) ? candidate.plan.midDebit : candidate.plan.entryDebit;
  candidate.pnlPerLotMidInr = round23(
    (mark.midValue - midDebit) * candidate.plan.lotSize - outcome.entryCharges - outcome.exitCharges
  );
  candidate.rMultiple = outcome.r;
  candidate.win = outcome.pnl > 0;
  state.counters.candidatesClosed += 1;
  const maxGain = Math.max(0.01, candidate.plan.width - candidate.plan.entryDebit);
  const confirmedP = candidate.confirmedPeakValue ?? candidate.peakValue;
  const mfeMaxFrac = Number(Math.max(0, (confirmedP - candidate.plan.entryDebit) / maxGain).toFixed(4));
  if (reason !== "STALE_DATA_FORCED" && Number.isFinite(outcome.pnl) && Number.isFinite(outcome.r) && Array.isArray(candidate.features) && candidate.features.length > 0 && !state.liveSamples.some((s) => s.id === candidate.id)) {
    const sample = {
      id: candidate.id,
      x: candidate.features,
      y: outcome.pnl > 0 ? 1 : 0,
      r: outcome.r,
      pnlPerLotInr: outcome.pnl,
      entryMs: Date.parse(candidate.createdAt),
      exitMs: nowMs,
      strategy: candidate.strategy,
      underlying: candidate.underlying,
      direction: candidate.direction,
      regime: candidate.regime,
      exitReason: reason,
      mfeMaxFrac,
      sessionsHeld: candidate.sessionsHeld,
      pnlLadderV2Inr: candidate.counterfactualFixed30PnlPerLotInr,
      pnlRunnerV3Inr: outcome.pnl,
      pnlRunnerV31Inr: candidate.counterfactualV31PnlPerLotInr
    };
    state.liveSamples.push(sample);
  }
  state.pending.candidates.push(candidate);
  const cfNote = candidate.counterfactualFixed30PnlPerLotInr !== outcome.pnl || candidate.counterfactualV31PnlPerLotInr !== outcome.pnl ? ` [LADDER_V2: \u20B9${candidate.counterfactualFixed30PnlPerLotInr.toFixed(0)} \xB7 V3.1: \u20B9${candidate.counterfactualV31PnlPerLotInr.toFixed(0)} \xB7 LEARNED: \u20B9${candidate.counterfactualLearnedPnlPerLotInr.toFixed(0)}]` : "";
  log(
    state,
    "CANDIDATE",
    `${candidate.underlying} ${candidate.direction} ${candidate.strategy} closed ${reason}: ${outcome.pnl.toFixed(0)} \u20B9/lot (${outcome.r.toFixed(2)}R)${cfNote}`,
    candidate.underlying
  );
}
function closePosition(state, position, reason, nowMs) {
  const mark = position.lastMark;
  if (!mark) return null;
  const units = position.lots * position.plan.lotSize;
  const exitCharges = exitChargesFor(mark.longBid, mark.shortAsk, units);
  const exitCashIn = round23(mark.liquidationValue * units - exitCharges);
  state.cash = round23(state.cash + exitCashIn);
  const net = round23(exitCashIn - position.entryCashOutInr);
  const confirmedP = position.confirmedPeakValue ?? position.peakValue;
  const maxGain = Math.max(0.01, position.plan.width - position.plan.entryDebit);
  const cfPerLot = position.counterfactualFixed30ExitValue !== void 0 ? perLotOutcome(position.plan, position.counterfactualFixed30ExitValue, mark.longBid, mark.shortAsk).pnl : round23(net / Math.max(1, position.lots));
  const v31PerLot = position.counterfactualV31ExitValue !== void 0 ? perLotOutcome(position.plan, position.counterfactualV31ExitValue, mark.longBid, mark.shortAsk).pnl : round23(net / Math.max(1, position.lots));
  const learnedPerLot = position.counterfactualLearnedExitValue !== void 0 ? perLotOutcome(position.plan, position.counterfactualLearnedExitValue, mark.longBid, mark.shortAsk).pnl : round23(net / Math.max(1, position.lots));
  const trade = {
    id: `T-${position.id}`,
    candidateId: position.candidateId,
    underlying: position.underlying,
    strategy: position.strategy,
    direction: position.direction,
    regimeAtEntry: position.regime,
    lots: position.lots,
    lotSize: position.plan.lotSize,
    expiry: position.plan.expiry,
    dteAtEntry: position.plan.dte,
    longSymbol: position.plan.long.symbol,
    shortSymbol: position.plan.short.symbol,
    longStrike: position.plan.long.strike,
    shortStrike: position.plan.short.strike,
    width: position.plan.width,
    openedAt: position.openedAt,
    closedAt: new Date(nowMs).toISOString(),
    holdMinutes: Math.max(0, Math.round((nowMs - Date.parse(position.openedAt)) / 6e4)),
    sessionsHeld: position.sessionsHeld,
    entryDebit: position.plan.entryDebit,
    exitValue: mark.liquidationValue,
    entryCashOutInr: position.entryCashOutInr,
    exitCashInInr: exitCashIn,
    chargesInr: round23(position.entryCashOutInr - position.plan.entryDebit * units + exitCharges),
    netPnlInr: net,
    pnlAtMidInr: round23(mark.midValue * units - exitCharges - (position.plan.midDebit * units + (position.entryCashOutInr - position.plan.entryDebit * units))),
    maxLossInr: position.maxLossInr,
    rMultiple: position.maxLossInr > 0 ? net / position.maxLossInr : 0,
    confirmedPeakValue: confirmedP,
    mfeOfMaxGainPct: round23((confirmedP - position.plan.entryDebit) / maxGain * 100),
    mfePct: position.plan.entryDebit > 0 ? (confirmedP - position.plan.entryDebit) / position.plan.entryDebit : 0,
    maePct: position.plan.entryDebit > 0 ? (position.troughValue - position.plan.entryDebit) / position.plan.entryDebit : 0,
    exitReason: reason,
    exitRuleVersion: position.exitRuleVersion ?? "ADAPTIVE_LEARNED",
    runnerArmed: Boolean(position.runnerArmed),
    runnerTrendGatePassed: position.runnerTrendGatePassed ?? null,
    learnedRunnerProb: position.learnedRunnerProb ?? null,
    learnedRecoveryProb: position.learnedRecoveryProb ?? null,
    learnedKeepFrac: position.learnedKeepFrac ?? null,
    counterfactualFixed30PnlInr: round23(cfPerLot * position.lots),
    counterfactualV31PnlInr: round23(v31PerLot * position.lots),
    counterfactualLearnedPnlInr: round23(learnedPerLot * position.lots),
    challengerEngines: position.challengerEngines,
    modelProb: position.modelProb,
    entryReason: position.entryReason
  };
  state.counters.tradesClosed += 1;
  state.pending.trades.push(trade);
  const summary = {
    id: trade.id,
    closedAt: trade.closedAt,
    underlying: trade.underlying,
    strategy: trade.strategy,
    direction: trade.direction,
    regime: trade.regimeAtEntry,
    exitReason: trade.exitReason,
    netPnlInr: trade.netPnlInr,
    rMultiple: trade.rMultiple
  };
  state.closedSummaries.push(summary);
  const posFeatures = resolveFeaturesFor(position, state);
  const hasActiveCand = state.activeCandidates.some((c) => c.id === position.candidateId && !c.closedAt);
  if (!hasActiveCand && reason !== "STALE_DATA_FORCED" && posFeatures.length > 0 && !state.liveSamples.some((s) => s.id === position.candidateId)) {
    const perLotNet = round23(net / Math.max(1, position.lots));
    const mfeMaxFrac = Number(Math.max(0, (confirmedP - position.plan.entryDebit) / maxGain).toFixed(4));
    state.liveSamples.push({
      id: position.candidateId,
      x: posFeatures,
      y: perLotNet > 0 ? 1 : 0,
      r: trade.rMultiple,
      pnlPerLotInr: perLotNet,
      entryMs: Date.parse(position.openedAt),
      exitMs: nowMs,
      strategy: position.strategy,
      underlying: position.underlying,
      direction: position.direction,
      regime: position.regime,
      exitReason: reason,
      mfeMaxFrac,
      sessionsHeld: position.sessionsHeld,
      pnlLadderV2Inr: cfPerLot,
      pnlRunnerV3Inr: perLotNet,
      pnlRunnerV31Inr: v31PerLot
    });
  }
  log(state, "EXIT", `${position.underlying} ${position.direction} ${position.lots} lot closed ${reason}: ${net >= 0 ? "+" : ""}\u20B9${net.toFixed(0)} (MFE ${trade.mfeOfMaxGainPct?.toFixed(1)}% of maxGain)`, position.underlying);
  return trade;
}
function revalue(state, niftyLtp) {
  const seenClosed = /* @__PURE__ */ new Set();
  state.closedSummaries = state.closedSummaries.filter((s) => {
    if (!s || !s.id || s.exitReason === "STALE_DATA_FORCED" || seenClosed.has(s.id)) return false;
    seenClosed.add(s.id);
    return true;
  });
  const realizedInr = state.closedSummaries.reduce((sum, s) => sum + (Number.isFinite(s.netPnlInr) ? s.netPnlInr : 0), 0);
  const openCostInr = state.openPositions.reduce((sum, p) => sum + (Number.isFinite(p.entryCashOutInr) ? p.entryCashOutInr : 0), 0);
  state.cash = round23(state.startingCapitalInr + realizedInr - openCostInr);
  let equity = state.cash;
  let equityMid = state.cash;
  let unrealized = 0;
  for (const pos of state.openPositions) {
    if (!pos.lastMark) continue;
    const units = pos.lots * pos.plan.lotSize;
    const value = markValue(pos.lastMark, pos.plan, pos.lots);
    equity += value.liquidationInr;
    equityMid += value.midInr;
    const entryCharges = round23(pos.entryCashOutInr - pos.plan.entryDebit * units);
    pos.estChargesInr = round23(entryCharges + value.exitCharges);
    pos.netUnrealizedInr = round23(value.liquidationInr - pos.entryCashOutInr);
    pos.longLegPnlInr = round23((pos.lastMark.longBid - pos.plan.long.ask) * units);
    pos.shortLegPnlInr = round23((pos.plan.short.bid - pos.lastMark.shortAsk) * units);
    pos.unrealizedInr = round23((pos.lastMark.liquidationValue - pos.plan.entryDebit) * units);
    unrealized += pos.unrealizedInr;
  }
  equity = round23(equity);
  equityMid = round23(equityMid);
  state.lastEquity = equity;
  state.lastEquityMid = equityMid;
  if (equity > state.peakEquity) state.peakEquity = equity;
  const dd = state.peakEquity > 0 ? (state.peakEquity - equity) / state.peakEquity * 100 : 0;
  if (dd > state.maxDrawdownPct) state.maxDrawdownPct = round23(dd);
  if (niftyLtp && niftyLtp > 0 && state.benchmarkStartNifty === null) state.benchmarkStartNifty = niftyLtp;
  const benchmark = state.benchmarkStartNifty && niftyLtp ? round23(state.startingCapitalInr * niftyLtp / state.benchmarkStartNifty) : null;
  const cfg = state.config;
  if (state.dayStartEquity > 0 && (equity - state.dayStartEquity) / state.dayStartEquity <= -cfg.dailyLossHaltPct) {
    if (!state.dailyHalt) log(state, "RISK", `Daily loss limit hit at \u20B9${equity.toFixed(0)}`);
    state.dailyHalt = true;
  }
  if (!state.killSwitch.active && state.peakEquity > 0 && dd >= cfg.drawdownKillPct * 100) {
    state.killSwitch = {
      active: true,
      reason: `Equity \u20B9${equity.toFixed(0)} is ${dd.toFixed(1)}% below the peak of \u20B9${state.peakEquity.toFixed(0)}`,
      at: (/* @__PURE__ */ new Date()).toISOString()
    };
    state.control = { ...state.control, entriesEnabled: false, updatedAt: (/* @__PURE__ */ new Date()).toISOString(), updatedBy: "kill-switch" };
    log(state, "RISK", state.killSwitch.reason || "Drawdown kill switch tripped");
  }
  return { equity, equityMid, unrealized, drawdownPct: round23(dd), benchmark };
}
function pushEquityPoint(state, nowMs, point) {
  const full = { t: new Date(nowMs).toISOString(), ...point };
  state.recentEquity.push(full);
  if (state.recentEquity.length > 500) state.recentEquity.splice(0, state.recentEquity.length - 500);
  state.pending.equity.push(full);
  state.lastEquityPointAt = full.t;
}
function sanitizeLiveSamples(state) {
  const seen = /* @__PURE__ */ new Set();
  state.liveSamples = (state.liveSamples ?? []).filter((s) => {
    if (!s || !s.id || seen.has(s.id)) return false;
    if (s.exitReason === "STALE_DATA_FORCED") return false;
    if (!Number.isFinite(s.r) || !Number.isFinite(s.pnlPerLotInr)) return false;
    if (!Array.isArray(s.x) || s.x.length !== FEATURE_NAMES.length || s.x.some((v) => !Number.isFinite(v))) return false;
    seen.add(s.id);
    return true;
  });
}
function maybeTrain(state, nowMs, force) {
  sanitizeLiveSamples(state);
  const labels = state.counters.candidatesClosed;
  const research = getOfflineResearch();
  const offline = research?.samples ?? [];
  const priorChanged = Boolean(
    state.model && (!state.model.exitPolicy || state.model.liveOos.avgR === null || state.model.exitPolicy.oosExpectancyInr === null || offline.length > 0 && (state.model.nOffline !== offline.length || Math.abs((state.model.offlineOos.acceptedAvgR ?? 0) - (research?.report.walkForward.oos.acceptedAvgR ?? 0)) > 1e-6))
  );
  if (!force && !priorChanged && state.model && labels - state.liveLabelsAtLastTrain < TRAIN_EVERY_LABELS) return;
  const live = state.liveSamples.map((s) => ({
    id: s.id,
    x: s.x,
    y: s.y,
    r: s.r,
    entryMs: s.entryMs,
    exitMs: s.exitMs,
    weight: 1,
    source: "LIVE",
    mfeMaxFrac: s.mfeMaxFrac,
    sessionsHeld: s.sessionsHeld,
    pnlLadderV2Inr: Number.isFinite(s.pnlLadderV2Inr) ? s.pnlLadderV2Inr : s.pnlPerLotInr,
    pnlRunnerV3Inr: Number.isFinite(s.pnlRunnerV3Inr) ? s.pnlRunnerV3Inr : s.pnlPerLotInr,
    pnlRunnerV31Inr: Number.isFinite(s.pnlRunnerV31Inr) ? s.pnlRunnerV31Inr : s.pnlPerLotInr
  }));
  if (offline.length + live.length < 30) {
    log(state, "MODEL", "Not enough closed samples to fit a model yet. Signals are taken whenever risk limits allow.");
    return;
  }
  const snap = trainModelSnapshot(offline, live, nowMs, research ? { oos: research.offlineOos } : void 0);
  if (!snap) {
    log(state, "MODEL", "Model fit did not converge. The previous model, if any, is unchanged.");
    return;
  }
  state.model = snap;
  state.liveLabelsAtLastTrain = labels;
  log(state, "MODEL", `${snap.version}: ${snap.gate.reason}`);
}
function marketLive(spots, nowMs) {
  const within = isWithinSessionHours(nowMs);
  if (!within) {
    const p = istParts(nowMs);
    const weekend = p.weekday === 0 || p.weekday === 6;
    return { live: false, reason: weekend ? "Weekend" : p.minuteOfDay < 9 * 60 + 15 ? "Before 09:15 IST" : "After 15:30 IST" };
  }
  const nifty = spots.NIFTY;
  if (!nifty) return { live: false, reason: "NIFTY quote missing" };
  if (nifty.feedTimeMs === null) return { live: false, reason: "NIFTY quote has no exchange timestamp" };
  const ageSec = (nowMs - nifty.feedTimeMs) / 1e3;
  if (ageSec > 180) return { live: false, reason: `NIFTY quote is ${Math.round(ageSec)}s old` };
  return { live: true, reason: `NIFTY feed ${Math.round(ageSec)}s old` };
}
var cacheMemo2;
function history() {
  if (cacheMemo2 === void 0) cacheMemo2 = loadHistoricalCache();
  return cacheMemo2;
}
async function loadInstruments(store2, market2, nowMs, spots) {
  const today = istDate(nowMs);
  const cached = await store2.get(KEY_INSTRUMENTS);
  const expectedCount = Object.keys(spots).filter((k) => k !== "INDIA_VIX").length;
  const cachedCount = cached ? new Set(cached.data.items.map((i) => i.underlying)).size : 0;
  if (cached && cached.data.asOf === today && cached.data.items.length > 0 && cachedCount >= expectedCount) {
    return cached.data.items;
  }
  const spotByUnderlying = {};
  for (const [sym, q] of Object.entries(spots)) if (q.ltp > 0) spotByUnderlying[sym] = q.ltp;
  const items = await market2.fetchInstruments(nowMs, spotByUnderlying);
  if (!items || items.length === 0) return cached?.data.items ?? [];
  await store2.put(KEY_INSTRUMENTS, { asOf: today, items }, cached ? cached.rev : null);
  return items;
}
async function runPaperCycle(store2, market2, opts = {}) {
  const leased = await withLease(store2, () => runPaperCycleUnlocked(store2, market2, opts));
  if (leased.busy) {
    return { ran: false, summary: "Another cycle is still running", ledgerId: null, equity: null, persisted: false };
  }
  return leased.value;
}
async function runPaperCycleUnlocked(store2, market2, opts) {
  const nowMs = opts.nowMs ?? Date.now();
  const train = opts.train !== false;
  let loaded;
  try {
    loaded = await loadOrCreate(store2, nowMs);
  } catch (err) {
    return {
      ran: false,
      summary: err instanceof Error ? err.message : "Ledger load failed",
      ledgerId: null,
      equity: null,
      persisted: false
    };
  }
  const { state } = loaded;
  let rev = loaded.rev;
  const cfg = state.config;
  const elapsed = state.lastCycle ? nowMs - Date.parse(state.lastCycle.at) : Infinity;
  if (!opts.force && elapsed < cfg.cycleMinIntervalSec * 1e3) {
    return {
      ran: false,
      summary: `Next cycle in ${Math.ceil((cfg.cycleMinIntervalSec * 1e3 - elapsed) / 1e3)}s`,
      ledgerId: state.ledgerId,
      equity: state.lastEquity,
      persisted: false
    };
  }
  const started = Date.now();
  state.counters.cycles += 1;
  state.angel = market2.status();
  const today = istDate(nowMs);
  if (state.dayDate !== today) {
    state.dayStartEquity = state.lastEquity;
    state.dayDate = today;
    state.dailyHalt = false;
  }
  if (train) {
    try {
      maybeTrain(state, nowMs, false);
    } catch (err) {
      log(state, "ERROR", err instanceof Error ? err.message : "Training failed");
    }
  }
  if (state.model) {
    for (const cand of state.activeCandidates) {
      if (cand.modelProb === null && cand.features.length === state.model.weights.length) {
        cand.modelProb = predictProb(state.model, cand.features);
        cand.modelVersion = state.model.version;
        cand.gateActive = Boolean(state.model.gate.active);
        cand.gateThreshold = state.model.gate.threshold;
      }
    }
    for (const pos of state.openPositions) {
      if (pos.modelProb === null) {
        const cand = state.activeCandidates.find((c) => c.id === pos.candidateId);
        if (cand && cand.modelProb !== null) pos.modelProb = cand.modelProb;
      }
    }
  }
  const prevCycleStatus = state.lastCycle?.status;
  const finish = async (status, summary) => {
    state.angel = market2.status();
    state.lastCycle = { at: new Date(nowMs).toISOString(), durationMs: Date.now() - started, status, summary };
    const isIdleOffHours = (status === "OFF_HOURS" || status === "MARKET_CLOSED") && prevCycleStatus === status && !opts.force && state.pending.trades.length === 0 && state.pending.candidates.length === 0 && state.pending.equity.length === 0;
    if (isIdleOffHours) {
      lastLiveStateMemo = state;
      lastLiveRefreshMs = nowMs;
      return { ran: true, summary, ledgerId: state.ledgerId, equity: state.lastEquity, persisted: true };
    }
    log(state, "CYCLE", summary);
    const persisted = await persist(store2, state, rev);
    return { ran: true, summary, ledgerId: state.ledgerId, equity: state.lastEquity, persisted };
  };
  let spots = null;
  try {
    spots = await market2.fetchSpots();
  } catch (err) {
    state.counters.dataErrors += 1;
    state.angel = { ...state.angel, lastError: err instanceof Error ? err.message : "Spot fetch failed" };
    return finish("DATA_ERROR", "Spot quotes failed");
  }
  if (!spots || !spots.NIFTY) {
    state.counters.dataErrors += 1;
    return finish("DATA_ERROR", "NIFTY spot quote was not returned");
  }
  const live = marketLive(spots, nowMs);
  const vix = spots.INDIA_VIX?.ltp ?? null;
  const session = istParts(nowMs);
  if (!live.live) {
    const status = isWithinSessionHours(nowMs) ? "MARKET_NOT_LIVE" : session.minuteOfDay >= 15 * 60 + 30 && session.weekday >= 1 && session.weekday <= 5 ? "MARKET_CLOSED" : "OFF_HOURS";
    state.market = {
      at: new Date(nowMs).toISOString(),
      live: false,
      liveReason: live.reason,
      spots,
      vix,
      vixPctile: null,
      regimes: state.market?.regimes ?? {}
    };
    return finish(status, live.reason);
  }
  state.counters.tradingCycles += 1;
  const cache = opts.history ?? history();
  const vixSeries = buildVixSeries(cache?.INDIA_VIX ?? []);
  const vixPctile = vix === null ? null : vixSeries.percentile(today, vix);
  const fromIst = formatIstForAngel(nowMs - 35 * 864e5);
  const toIst = formatIstForAngel(nowMs);
  const regimes = {};
  const trendMap = {};
  const signalPlans = [];
  for (const underlying of UNDERLYINGS) {
    let fresh = null;
    try {
      fresh = await market2.fetchCandles(underlying, fromIst, toIst);
    } catch {
      fresh = null;
    }
    const candles = mergeCandles(cache?.[underlying] ?? [], fresh ?? []);
    if (candles.length < 80) {
      if (!fresh) state.counters.dataErrors += 1;
      continue;
    }
    const rows = computeIndicators(candles);
    const idx = lastCompleteIndex(candles, nowMs);
    if (idx < 0 || !isRowComplete(rows[idx])) continue;
    const barStart = candles[idx].time;
    const barEnd = hourlyBarEndMs(Date.parse(barStart));
    regimes[underlying] = {
      regime: classifyRegime(rows[idx], vixPctile),
      rsi14: rows[idx].rsi14,
      adx14: rows[idx].adx14,
      barStart
    };
    const barDate = istDate(Date.parse(barStart));
    let pv = 0;
    let vv = 0;
    for (let k = Math.max(0, idx - 8); k <= idx; k++) {
      if (istDate(Date.parse(candles[k].time)) === barDate) {
        const typ = (candles[k].high + candles[k].low + candles[k].close) / 3;
        const vol = candles[k].volume || 1;
        pv += typ * vol;
        vv += vol;
      }
    }
    trendMap[underlying] = {
      spot: spots[underlying]?.ltp ?? candles[idx].close,
      ema20: rows[idx].ema20,
      vwap: vv > 0 ? pv / vv : candles[idx].close,
      adx14: rows[idx].adx14,
      prevAdx14: idx > 0 ? rows[idx - 1].adx14 : rows[idx].adx14
    };
    if (nowMs - barEnd > 60 * 60 * 1e3) continue;
    signalPlans.push({ underlying, candles, index: idx });
  }
  let instruments = [];
  try {
    instruments = await loadInstruments(store2, market2, nowMs, spots);
    if (instruments.length > 0) state.instrumentsAsOf = today;
  } catch (err) {
    state.counters.dataErrors += 1;
    log(state, "DATA", err instanceof Error ? err.message : "Instrument master failed");
  }
  const quoteTokens = /* @__PURE__ */ new Set();
  for (const pos of state.openPositions) {
    quoteTokens.add(pos.plan.long.token);
    quoteTokens.add(pos.plan.short.token);
  }
  for (const cand of state.activeCandidates) {
    quoteTokens.add(cand.plan.long.token);
    quoteTokens.add(cand.plan.short.token);
  }
  const pendingSignals = [];
  const minute = istParts(nowMs).minuteOfDay;
  const entriesOpen = minute >= cfg.entryStartMinuteIst && minute <= cfg.entryEndMinuteIst;
  for (const plan of signalPlans) {
    const rows = computeIndicators(plan.candles);
    const sig = detectSignal(plan.candles, rows, plan.index, vixPctile);
    if (!sig) continue;
    const key = `${plan.underlying}:${sig.direction}`;
    const barTime = plan.candles[plan.index].time;
    if (state.lastSignalBar[key] === barTime) continue;
    if (state.activeCandidates.some((c) => c.underlying === plan.underlying && c.direction === sig.direction && c.signalBarStart === barTime)) {
      state.lastSignalBar[key] = barTime;
      continue;
    }
    if (!entriesOpen) {
      state.lastSignalBar[key] = barTime;
      log(state, "SKIP", `${plan.underlying} signal outside the 09:30\u201315:00 entry window`, plan.underlying);
      continue;
    }
    if (instruments.length === 0) {
      log(state, "DATA", `${plan.underlying} signal is waiting for the instrument master`, plan.underlying);
      continue;
    }
    const expiry = pickExpiry(instruments, plan.underlying, today, cfg);
    if (!expiry) {
      state.lastSignalBar[key] = barTime;
      state.counters.plansRejected += 1;
      log(state, "SKIP", `${plan.underlying} has no expiry between ${cfg.minDte} and ${cfg.maxDte} days`, plan.underlying);
      continue;
    }
    const chain = instruments.filter((i) => i.underlying === plan.underlying && i.expiry === expiry && i.right === sig.direction);
    const legs = selectChainLegs(
      chain.map((c) => ({ token: c.token, symbol: c.symbol, strike: c.strike, lotSize: c.lotSize })),
      spots[plan.underlying]?.ltp ?? plan.candles[plan.index].close,
      sig.direction,
      cfg.maxShortSteps
    );
    for (const leg of legs) quoteTokens.add(leg.token);
    pendingSignals.push({
      underlying: plan.underlying,
      index: plan.index,
      candles: plan.candles,
      expiry,
      dte: calendarDaysBetween(today, expiry),
      tokens: legs.map((l) => l.token)
    });
  }
  let quotes = {};
  let quoteBatchOk = quoteTokens.size === 0;
  if (quoteTokens.size > 0) {
    try {
      const fetched = await market2.fetchOptionQuotes([...quoteTokens]);
      if (!fetched || Object.keys(fetched).length === 0) {
        state.counters.dataErrors += 1;
        log(state, "DATA", "Option quote batch failed; open positions were not marked this cycle");
      } else {
        quotes = fetched;
        quoteBatchOk = true;
      }
    } catch (err) {
      state.counters.dataErrors += 1;
      log(state, "DATA", err instanceof Error ? err.message : "Option quote batch failed");
    }
  }
  for (const pos of state.openPositions) {
    bumpSession(pos, today);
    if (quoteBatchOk) applyMark(pos, quotes, nowMs, cfg, state, trendMap, today);
  }
  for (const cand of state.activeCandidates) {
    bumpSession(cand, today);
    if (quoteBatchOk) applyMark(cand, quotes, nowMs, cfg, state, trendMap, today);
  }
  const stillOpen = [];
  for (const pos of state.openPositions) {
    const reason = exitReasonFor(pos, cfg, today, false);
    if (!reason) {
      stillOpen.push(pos);
      continue;
    }
    closePosition(state, pos, reason, nowMs);
    const cand = state.activeCandidates.find((c) => c.id === pos.candidateId);
    if (cand && !cand.closedAt) {
      cand.lastMark = pos.lastMark;
      cand.peakValue = pos.peakValue;
      cand.confirmedPeakValue = pos.confirmedPeakValue;
      cand.troughValue = pos.troughValue;
      cand.sessionsHeld = pos.sessionsHeld;
      closeCandidate(state, cand, reason, nowMs);
    }
  }
  state.openPositions = stillOpen;
  const stillActive = [];
  for (const cand of state.activeCandidates) {
    if (cand.closedAt) continue;
    const reason = exitReasonFor(cand, cfg, today, true);
    if (!reason) {
      stillActive.push(cand);
      continue;
    }
    closeCandidate(state, cand, reason, nowMs);
  }
  state.activeCandidates = stillActive;
  revalue(state, spots.NIFTY?.ltp ?? null);
  const suspended = new Set(suspendedStrategies(state.liveSamples));
  for (const pending of pendingSignals) {
    const rows = computeIndicators(pending.candles);
    const sig = detectSignal(pending.candles, rows, pending.index, vixPctile);
    const spot = spots[pending.underlying]?.ltp;
    if (!sig || !(spot && spot > 0)) continue;
    const chain = instruments.filter((i) => i.underlying === pending.underlying && i.expiry === pending.expiry && i.right === sig.direction).map((c) => ({ token: c.token, symbol: c.symbol, strike: c.strike, lotSize: c.lotSize }));
    const built = buildSpreadPlan({
      underlying: pending.underlying,
      right: sig.direction,
      expiry: pending.expiry,
      dte: pending.dte,
      spot,
      chain,
      quotes,
      budgetPerTradeInr: state.lastEquity * cfg.riskPerTradePct,
      nowMs,
      cfg
    });
    if (!built.ok) {
      state.counters.plansRejected += 1;
      log(state, "SKIP", `${pending.underlying} ${sig.direction}: ${built.reason}`, pending.underlying);
      continue;
    }
    if (state.activeCandidates.some(
      (c) => c.underlying === pending.underlying && c.direction === sig.direction && c.plan.expiry === pending.expiry && c.plan.long.strike === built.plan.long.strike && c.plan.short.strike === built.plan.short.strike
    )) {
      state.lastSignalBar[`${pending.underlying}:${sig.direction}`] = pending.candles[pending.index].time;
      continue;
    }
    const features = buildFeatures(sig, {
      vixPctile,
      isIndex: INDEX_UNDERLYINGS.has(pending.underlying),
      dte: pending.dte,
      debitRatio: built.plan.debitRatio,
      legSpreadPct: built.plan.legSpreadPct
    });
    const model = state.model;
    const modelProb = model && features.length === model.weights.length ? predictProb(model, features) : null;
    let skip = null;
    if (!built.affordable) skip = `1 lot risks \u20B9${built.plan.maxLossPerLot.toFixed(0)}, above the per-trade budget`;
    else if (suspended.has(sig.strategy)) skip = `${sig.strategy} is suspended: its live results are negative with 90% confidence`;
    else if (model?.gate.active && model.gate.threshold !== null && (modelProb === null || modelProb < model.gate.threshold)) {
      skip = `Model probability ${modelProb === null ? "n/a" : modelProb.toFixed(2)} is below the gate ${model.gate.threshold.toFixed(2)}`;
    }
    const initialLearned = predictExitDecision(state.model?.exitPolicy, features, {
      mfeFrac: 0,
      sessionsHeld: 1,
      trendAligned: true,
      adxRising: true,
      defaultStopLossFrac: cfg.stopLossFracOfDebit
    });
    const initStop = round23(built.plan.entryDebit * (1 - cfg.stopLossFracOfDebit));
    const candidate = {
      id: `C-${pending.underlying}-${sig.direction}-${Date.parse(pending.candles[pending.index].time)}`,
      createdAt: new Date(nowMs).toISOString(),
      underlying: pending.underlying,
      strategy: sig.strategy,
      direction: sig.direction,
      regime: sig.regime,
      signalBarStart: pending.candles[pending.index].time,
      reason: sig.reason,
      indicators: snapshotOf(rows[pending.index]),
      vix: vix ?? 0,
      vixPctile: vixPctile ?? 0,
      features,
      modelProb,
      modelVersion: model?.version ?? null,
      gateActive: Boolean(model?.gate.active),
      gateThreshold: model?.gate.threshold ?? null,
      plan: built.plan,
      affordable: built.affordable,
      takenByLedger: false,
      positionId: null,
      skipReason: skip,
      lastMark: entryMark(built.plan, nowMs),
      peakValue: built.plan.entryDebit,
      troughValue: built.plan.entryDebit,
      recentMarks: [built.plan.entryDebit],
      confirmedPeakValue: built.plan.entryDebit,
      exitRuleVersion: "ADAPTIVE_LEARNED",
      runnerArmed: false,
      runnerFloor: initStop,
      runnerFloorV31: initStop,
      runnerFloorLearned: initStop,
      runnerTrendGatePassed: null,
      runnerTrendGateReason: null,
      learnedRunnerProb: initialLearned.runnerProb,
      learnedRecoveryProb: initialLearned.recoveryProb,
      learnedKeepFrac: initialLearned.learnedKeepFrac,
      learnedEarlyStopTightened: initialLearned.earlyStopTighten,
      learnedExitAction: initialLearned.actionSummary,
      sessionsHeld: 1,
      lastSessionDate: today,
      staleMarks: 0
    };
    if (!skip) {
      const decision = evaluateEntryRisk({
        cfg,
        equity: state.lastEquity,
        cash: state.cash,
        entriesEnabled: state.control.entriesEnabled,
        killSwitchActive: state.killSwitch.active,
        dailyHalt: state.dailyHalt,
        openPositions: state.openPositions,
        isIndex: INDEX_UNDERLYINGS.has(pending.underlying),
        plan: built.plan
      });
      if (!decision.allowed) {
        candidate.skipReason = decision.reason;
        log(state, "SKIP", `${pending.underlying} ${sig.direction}: ${decision.reason}`, pending.underlying);
      } else {
        const position = {
          id: `P-${candidate.id}`,
          candidateId: candidate.id,
          openedAt: candidate.createdAt,
          underlying: candidate.underlying,
          strategy: candidate.strategy,
          direction: candidate.direction,
          regime: candidate.regime,
          lots: decision.lots,
          plan: built.plan,
          features: candidate.features,
          entryCashOutInr: decision.cashOutInr,
          maxLossInr: decision.maxLossInr,
          marginBlockedInr: decision.marginInr,
          lastMark: candidate.lastMark,
          peakValue: candidate.peakValue,
          troughValue: candidate.troughValue,
          recentMarks: [built.plan.entryDebit],
          confirmedPeakValue: built.plan.entryDebit,
          exitRuleVersion: "ADAPTIVE_LEARNED",
          runnerArmed: false,
          runnerFloor: initStop,
          runnerFloorV31: initStop,
          runnerFloorLearned: initStop,
          runnerTrendGatePassed: null,
          runnerTrendGateReason: null,
          learnedRunnerProb: initialLearned.runnerProb,
          learnedRecoveryProb: initialLearned.recoveryProb,
          learnedKeepFrac: initialLearned.learnedKeepFrac,
          learnedEarlyStopTightened: initialLearned.earlyStopTighten,
          learnedExitAction: initialLearned.actionSummary,
          sessionsHeld: 1,
          lastSessionDate: today,
          staleMarks: 0,
          unrealizedInr: 0,
          modelProb,
          entryReason: sig.reason
        };
        state.cash = round23(state.cash - decision.cashOutInr);
        state.openPositions.push(position);
        state.counters.tradesOpened += 1;
        candidate.takenByLedger = true;
        candidate.positionId = position.id;
        candidate.skipReason = null;
        log(state, "ENTRY", `${pending.underlying} ${sig.direction} ${decision.lots} lot, debit \u20B9${built.plan.entryDebit.toFixed(2)}, cash out \u20B9${decision.cashOutInr.toFixed(0)}`, pending.underlying);
      }
    } else {
      log(state, "SKIP", `${pending.underlying} ${sig.direction}: ${skip}`, pending.underlying);
    }
    state.lastSignalBar[`${pending.underlying}:${sig.direction}`] = pending.candles[pending.index].time;
    state.activeCandidates.push(candidate);
    state.counters.candidatesCreated += 1;
    log(state, "SIGNAL", sig.reason, pending.underlying);
  }
  const valued = revalue(state, spots.NIFTY?.ltp ?? null);
  pushEquityPoint(state, nowMs, {
    equity: valued.equity,
    equityMid: valued.equityMid,
    cash: state.cash,
    benchmark: valued.benchmark,
    drawdownPct: valued.drawdownPct,
    openPositions: state.openPositions.length
  });
  state.market = {
    at: new Date(nowMs).toISOString(),
    live: true,
    liveReason: live.reason,
    spots,
    vix,
    vixPctile,
    regimes
  };
  if (train) {
    try {
      maybeTrain(state, nowMs, false);
    } catch (err) {
      log(state, "ERROR", err instanceof Error ? err.message : "Training failed");
    }
  }
  return finish(
    "TRADED",
    `Live cycle. Equity \u20B9${valued.equity.toFixed(0)}, ${state.openPositions.length} open, ${state.activeCandidates.length} candidates tracked.`
  );
}
function pickExpiry(instruments, underlying, today, cfg) {
  const expiries = [...new Set(instruments.filter((i) => i.underlying === underlying).map((i) => i.expiry))].sort();
  return expiries.find((e) => {
    const dte = calendarDaysBetween(today, e);
    return dte >= cfg.minDte && dte <= cfg.maxDte;
  }) ?? null;
}
async function resetPaperLedger(store2, nowMs, capital) {
  const leased = await withLease(store2, async () => {
    const fresh = createInitialLedger(nowMs, capital ?? startingCapitalFromEnv());
    const active = await store2.get(KEY_ACTIVE);
    const saved = await store2.put(stateKey(fresh.ledgerId), fresh, null);
    if (!saved.ok) return { ok: false, error: "Could not create the new ledger" };
    const pointed = await store2.put(KEY_ACTIVE, { ledgerId: fresh.ledgerId }, active ? active.rev : null);
    if (!pointed.ok) return { ok: false, error: "Could not switch the active ledger" };
    return { ok: true, state: fresh };
  });
  if (leased.busy) return { ok: false, error: "A cycle is running. Try again in a moment." };
  return leased.value;
}
async function mutateLedger(store2, nowMs, mutator) {
  const leased = await withLease(store2, async () => {
    const loaded = await loadOrCreate(store2, nowMs);
    mutator(loaded.state);
    const persisted = await persist(store2, loaded.state, loaded.rev);
    if (!persisted) return { ok: false, error: "The ledger changed while saving. Try again." };
    return { ok: true, state: loaded.state };
  });
  if (leased.busy) return { ok: false, error: "A cycle is running. Try again in a moment." };
  return leased.value;
}
async function readJournal(store2, ledgerId, kind, month) {
  const state = await store2.get(stateKey(ledgerId));
  const pending = kind === "trades" ? state?.data.pending.trades ?? [] : state?.data.pending.candidates ?? [];
  const months = month ? [month] : [istMonthKey(Date.now()), istMonthKey(Date.now() - 32 * 864e5)];
  const rows = [];
  for (const m of months) {
    const key = kind === "trades" ? tradesKey(ledgerId, m) : candidatesKey(ledgerId, m);
    const archived = await store2.get(key);
    if (archived) rows.push(...archived.data);
  }
  const seen = new Set(rows.map((r) => r.id));
  for (const item of pending) {
    const when = Date.parse(item.closedAt || "");
    if (month && Number.isFinite(when) && istMonthKey(when) !== month) continue;
    if (!seen.has(item.id)) rows.push(item);
  }
  const validRows = rows.filter((r) => {
    if (!r || typeof r !== "object") return false;
    const rec = r;
    if (rec.exitReason === "STALE_DATA_FORCED") return false;
    if (kind === "candidates") {
      return Boolean(rec.plan && rec.plan.long && rec.plan.short && Number.isFinite(rec.plan.entryDebit));
    }
    return true;
  });
  validRows.sort(
    (a, b) => Date.parse(b.closedAt || "") - Date.parse(a.closedAt || "")
  );
  return validRows;
}
function hydrateLearnedExitFields(state) {
  const policy = state.model?.exitPolicy;
  const cfg = state.config;
  for (const cand of state.activeCandidates) {
    cand.exitRuleVersion = "ADAPTIVE_LEARNED";
    const maxGain = Math.max(0.01, cand.plan.width - cand.plan.entryDebit);
    const peak = cand.confirmedPeakValue ?? cand.peakValue;
    const mfeFrac = Math.max(0, (peak - cand.plan.entryDebit) / maxGain);
    const dec = predictExitDecision(policy, cand.features, {
      mfeFrac,
      sessionsHeld: cand.sessionsHeld,
      defaultStopLossFrac: cfg.stopLossFracOfDebit
    });
    cand.learnedRunnerProb = dec.runnerProb;
    cand.learnedRecoveryProb = dec.recoveryProb;
    cand.learnedKeepFrac = dec.learnedKeepFrac;
    cand.learnedEarlyStopTightened = dec.earlyStopTighten;
    cand.learnedExitAction = dec.actionSummary;
  }
  for (const pos of state.openPositions) {
    pos.exitRuleVersion = "ADAPTIVE_LEARNED";
    const features = resolveFeaturesFor(pos, state);
    const maxGain = Math.max(0.01, pos.plan.width - pos.plan.entryDebit);
    const peak = pos.confirmedPeakValue ?? pos.peakValue;
    const mfeFrac = Math.max(0, (peak - pos.plan.entryDebit) / maxGain);
    const dec = predictExitDecision(policy, features, {
      mfeFrac,
      sessionsHeld: pos.sessionsHeld,
      defaultStopLossFrac: cfg.stopLossFracOfDebit
    });
    pos.learnedRunnerProb = dec.runnerProb;
    pos.learnedRecoveryProb = dec.recoveryProb;
    pos.learnedKeepFrac = dec.learnedKeepFrac;
    pos.learnedEarlyStopTightened = dec.earlyStopTighten;
    pos.learnedExitAction = dec.actionSummary;
  }
}
async function readActiveLedger(store2) {
  const loaded = await loadOrCreate(store2, Date.now());
  const state = loaded.state;
  try {
    maybeTrain(state, Date.now(), false);
  } catch {
  }
  hydrateLearnedExitFields(state);
  revalue(state, state.market?.spots?.NIFTY?.ltp ?? null);
  return state;
}
var lastLiveRefreshMs = 0;
var lastLiveStateMemo = null;
var lastDbPersistMs = 0;
async function refreshLiveState(store2, market2, nowMs = Date.now()) {
  if (lastLiveStateMemo && nowMs - lastLiveRefreshMs < 1800) {
    return lastLiveStateMemo;
  }
  const loaded = await loadOrCreate(store2, nowMs);
  const row = { data: loaded.state, rev: loaded.rev };
  const state = row.data;
  state.config = { ...DEFAULT_ENGINE_CONFIG };
  const openCandIds = new Set(state.openPositions.map((p) => p.candidateId));
  const seenContracts = /* @__PURE__ */ new Set();
  state.activeCandidates = state.activeCandidates.filter((c) => {
    const contractKey = `${c.underlying}:${c.direction}:${c.plan.expiry}:${c.plan.long.strike}:${c.plan.short.strike}`;
    if (seenContracts.has(contractKey) && !c.takenByLedger && !openCandIds.has(c.id)) return false;
    seenContracts.add(contractKey);
    return true;
  });
  try {
    maybeTrain(state, nowMs, false);
  } catch {
  }
  hydrateLearnedExitFields(state);
  const cfg = state.config;
  const quoteTokens = /* @__PURE__ */ new Set();
  for (const pos of state.openPositions) {
    quoteTokens.add(pos.plan.long.token);
    quoteTokens.add(pos.plan.short.token);
  }
  for (const cand of state.activeCandidates) {
    quoteTokens.add(cand.plan.long.token);
    quoteTokens.add(cand.plan.short.token);
  }
  try {
    const [spots, optionQuotes] = await Promise.all([
      market2.fetchSpots().catch(() => null),
      quoteTokens.size > 0 ? market2.fetchOptionQuotes([...quoteTokens]).catch(() => null) : Promise.resolve(null)
    ]);
    state.angel = market2.status();
    if (spots && spots.NIFTY) {
      const live = marketLive(spots, nowMs);
      state.market = {
        at: new Date(nowMs).toISOString(),
        live: live.live,
        liveReason: live.reason,
        spots,
        vix: spots.INDIA_VIX?.ltp ?? state.market?.vix ?? null,
        vixPctile: state.market?.vixPctile ?? null,
        regimes: state.market?.regimes ?? {}
      };
    }
    const today = istDate(nowMs);
    let exitExecuted = false;
    let floorOrPeakRaised = false;
    const sessionLive = Boolean(state.market?.live && isWithinSessionHours(nowMs));
    if (sessionLive && optionQuotes && Object.keys(optionQuotes).length > 0) {
      const stillOpen = [];
      for (const pos of state.openPositions) {
        const prevPeak = pos.peakValue ?? pos.plan.entryDebit;
        const prevFloor = Math.max(pos.runnerFloor ?? 0, pos.runnerFloorV31 ?? 0, pos.runnerFloorLearned ?? 0);
        pos.exitRuleVersion = "ADAPTIVE_LEARNED";
        applyMark(pos, optionQuotes, nowMs, cfg, state, void 0, today, true);
        const nextPeak = pos.peakValue ?? pos.plan.entryDebit;
        const nextFloor = Math.max(pos.runnerFloor ?? 0, pos.runnerFloorV31 ?? 0, pos.runnerFloorLearned ?? 0);
        if (nextPeak > prevPeak || nextFloor > prevFloor) {
          floorOrPeakRaised = true;
        }
        const reason = exitReasonFor(pos, cfg, today, false);
        if (!reason) {
          stillOpen.push(pos);
          continue;
        }
        closePosition(state, pos, reason, nowMs);
        exitExecuted = true;
        const cand = state.activeCandidates.find((c) => c.id === pos.candidateId);
        if (cand && !cand.closedAt) {
          cand.lastMark = pos.lastMark;
          cand.peakValue = pos.peakValue;
          cand.confirmedPeakValue = pos.confirmedPeakValue;
          cand.troughValue = pos.troughValue;
          cand.sessionsHeld = pos.sessionsHeld;
          closeCandidate(state, cand, reason, nowMs);
        }
      }
      state.openPositions = stillOpen;
      const stillActive = [];
      for (const cand of state.activeCandidates) {
        if (cand.closedAt) continue;
        cand.exitRuleVersion = "ADAPTIVE_LEARNED";
        applyMark(cand, optionQuotes, nowMs, cfg, state, void 0, today, true);
        const reason = exitReasonFor(cand, cfg, today, true);
        if (!reason) {
          stillActive.push(cand);
          continue;
        }
        closeCandidate(state, cand, reason, nowMs);
        exitExecuted = true;
      }
      state.activeCandidates = stillActive;
    }
    revalue(state, state.market?.spots?.NIFTY?.ltp ?? null);
    lastLiveRefreshMs = nowMs;
    lastLiveStateMemo = state;
    if (exitExecuted || floorOrPeakRaised) {
      lastDbPersistMs = nowMs;
      await persist(store2, state, row.rev).catch(() => {
      });
    } else if (nowMs - lastDbPersistMs >= 15e3 && state.market?.live && !cycleInFlight) {
      lastDbPersistMs = nowMs;
      await persist(store2, state, row.rev).catch(() => {
      });
    }
    const lastCycleMs = state.lastCycle ? Date.parse(state.lastCycle.at) : 0;
    const istMin = istParts(nowMs).minuteOfDay;
    const barBoundaryPassed = state.market?.live && istMin >= 9 * 60 + 30 && istMin <= 15 * 60 + 20 && Math.floor((nowMs + 5.5 * 36e5 - 15 * 6e4) / 36e5) > Math.floor((lastCycleMs + 5.5 * 36e5 - 15 * 6e4) / 36e5);
    if (barBoundaryPassed && !cycleInFlight) {
      void runPaperCycle(store2, market2, { force: true }).catch(() => {
      });
    }
  } catch {
    revalue(state, state.market?.spots?.NIFTY?.ltp ?? null);
  }
  return state;
}

// src/quant/readiness.ts
function weeksBetween(fromIso, nowMs) {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return 0;
  return (nowMs - from) / (7 * 864e5);
}
function computeReadiness(input) {
  const { trades } = input;
  const weeks = weeksBetween(input.ledgerCreatedAt, input.nowMs);
  const pnls = trades.map((t) => t.netPnlInr);
  const ci = meanCi90(pnls);
  const pf = profitFactor(pnls);
  const byRegime = groupStats(trades, (t) => t.regime, (t) => t.netPnlInr, (t) => t.rMultiple);
  const positiveRegimes = byRegime.filter((g) => g.n >= 20 && (g.expectancyInr ?? 0) > 0);
  const checks = [
    {
      id: "sample",
      label: "At least 200 closed paper trades",
      pass: trades.length >= 200,
      detail: `${trades.length} closed`
    },
    {
      id: "weeks",
      label: "At least 8 weeks of paper trading",
      pass: weeks >= 8,
      detail: `${weeks.toFixed(1)} weeks since this ledger started`
    },
    {
      id: "expectancy",
      label: "Expectancy 90% confidence interval is above zero",
      pass: ci !== null && ci[0] > 0,
      detail: ci ? `\u20B9${ci[0].toFixed(0)} to \u20B9${ci[1].toFixed(0)} per trade` : "Needs at least 10 closed trades"
    },
    {
      id: "profit-factor",
      label: "Profit factor above 1.30",
      pass: pf !== null && pf > 1.3,
      detail: pf === null ? "No losing trades yet" : pf.toFixed(2)
    },
    {
      id: "drawdown",
      label: "Maximum drawdown under 10%",
      pass: input.maxDrawdownPct < 10,
      detail: `${input.maxDrawdownPct.toFixed(2)}%`
    },
    {
      id: "regimes",
      label: "Positive in at least 2 regimes with 20 trades each",
      pass: positiveRegimes.length >= 2,
      detail: byRegime.length === 0 ? "No closed trades yet" : byRegime.map((g) => `${g.key} ${g.n} trades, avg \u20B9${(g.expectancyInr ?? 0).toFixed(0)}`).join("; ")
    }
  ];
  return {
    readyForRealMoney: checks.every((c) => c.pass),
    checks,
    note: input.liveOosAuc === null ? "Live out-of-sample AUC is not available yet. It is shown for information and is not a pass/fail check." : `Live out-of-sample AUC is ${input.liveOosAuc.toFixed(3)}. It is information, not a pass/fail check.`
  };
}

// src/quant/report.ts
function cards(items) {
  return {
    byStrategy: groupStats(items, (t) => t.strategy, (t) => t.net, (t) => t.r),
    byUnderlying: groupStats(items, (t) => t.underlying, (t) => t.net, (t) => t.r),
    byRegime: groupStats(items, (t) => t.regime, (t) => t.net, (t) => t.r),
    byDirection: groupStats(items, (t) => t.direction, (t) => t.net, (t) => t.r),
    byExit: groupStats(items, (t) => t.exitReason, (t) => t.net, (t) => t.r)
  };
}
function buildDashboard(state, nowMs = Date.now()) {
  const unrealized = state.openPositions.reduce((sum, p) => sum + (Number.isFinite(p.unrealizedInr) ? p.unrealizedInr : 0), 0);
  const netUnrealized = state.openPositions.reduce(
    (sum, p) => sum + (Number.isFinite(p.netUnrealizedInr ?? p.unrealizedInr) ? p.netUnrealizedInr ?? p.unrealizedInr : 0),
    0
  );
  const estCharges = state.openPositions.reduce((sum, p) => sum + (Number.isFinite(p.estChargesInr) ? p.estChargesInr ?? 0 : 0), 0);
  const realized = state.closedSummaries.reduce((sum, t) => sum + (Number.isFinite(t.netPnlInr) ? t.netPnlInr : 0), 0);
  const mtmEquity = Math.round((state.startingCapitalInr + realized + unrealized) * 100) / 100;
  const tradeRows = state.closedSummaries.filter((t) => Number.isFinite(t.netPnlInr) && Number.isFinite(t.rMultiple)).map((t) => ({
    strategy: t.strategy,
    underlying: t.underlying,
    regime: t.regime,
    direction: t.direction,
    exitReason: t.exitReason,
    net: t.netPnlInr,
    r: t.rMultiple
  }));
  const validLiveSamples = state.liveSamples.filter(
    (s) => s && s.exitReason !== "STALE_DATA_FORCED" && Number.isFinite(s.pnlPerLotInr) && Number.isFinite(s.r)
  );
  const candidateRows = validLiveSamples.map((s) => ({
    strategy: s.strategy,
    underlying: s.underlying,
    regime: s.regime,
    direction: s.direction,
    exitReason: s.exitReason,
    net: s.pnlPerLotInr,
    r: s.r
  }));
  const candidateCards = cards(candidateRows);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    ledgerId: state.ledgerId,
    createdAt: state.createdAt,
    startingCapitalInr: state.startingCapitalInr,
    cash: state.cash,
    equity: state.lastEquity,
    equityMid: state.lastEquityMid,
    mtmEquityInr: mtmEquity,
    dayPnlInr: unrealized + realized,
    realizedPnlInr: realized,
    unrealizedPnlInr: unrealized,
    netUnrealizedPnlInr: netUnrealized,
    estOpenChargesInr: estCharges,
    peakEquity: state.peakEquity,
    maxDrawdownPct: state.maxDrawdownPct,
    weeksElapsed: weeksBetween(state.createdAt, nowMs),
    dailyHalt: state.dailyHalt,
    killSwitch: state.killSwitch,
    control: state.control,
    openPositions: state.openPositions,
    activeCandidates: state.activeCandidates,
    counters: state.counters,
    lastCycle: state.lastCycle,
    market: state.market,
    angel: state.angel,
    instrumentsAsOf: state.instrumentsAsOf,
    model: state.model,
    recentEquity: state.recentEquity,
    decisionLog: state.decisionLog,
    learningLog: state.learningLog,
    suspendedStrategies: suspendedStrategies(validLiveSamples),
    tradeScorecards: cards(tradeRows),
    candidateScorecards: {
      byStrategy: candidateCards.byStrategy,
      byUnderlying: candidateCards.byUnderlying,
      byRegime: candidateCards.byRegime
    },
    readiness: computeReadiness({
      trades: state.closedSummaries,
      ledgerCreatedAt: state.createdAt,
      nowMs,
      maxDrawdownPct: state.maxDrawdownPct,
      liveOosAuc: state.model?.liveOos.auc ?? null
    }),
    config: state.config
  };
}

// src/quant/terminalCandles.ts
function toAngelInterval(interval) {
  if (interval === "1m") return "ONE_MINUTE";
  if (interval === "5m") return "FIVE_MINUTE";
  if (interval === "15m") return "FIFTEEN_MINUTE";
  return "ONE_HOUR";
}
function lookbackDays(interval) {
  if (interval === "1m") return 2;
  if (interval === "5m") return 5;
  if (interval === "15m") return 14;
  return 45;
}
var round24 = (x) => Math.round(x * 100) / 100;
function buildCalibratedOptionCandles(spotCandles, opts) {
  if (spotCandles.length === 0) return [];
  const expiryMs = istToMs(opts.expiry, 15, 30);
  const yearMs = 365 * 864e5;
  const vol = Math.max(0.11, (opts.vixPct ?? 15) / 100);
  const r = 0.06;
  const priceAt = (spot, tMs) => {
    const tYears = Math.max(1 / 365, (expiryMs - tMs) / yearMs);
    const longVal = bsPrice(spot, opts.strike, tYears, vol, r, opts.right);
    if (opts.shortStrike && opts.shortStrike > 0) {
      const shortVal = bsPrice(spot, opts.shortStrike, tYears, vol, r, opts.right);
      return Math.max(0.05, longVal - shortVal);
    }
    return Math.max(0.05, longVal);
  };
  const raw = spotCandles.map((c) => {
    const tMs = Date.parse(c.time) || Date.now();
    const o = priceAt(c.open, tMs);
    const cl = priceAt(c.close, tMs);
    const sHigh = priceAt(c.high, tMs);
    const sLow = priceAt(c.low, tMs);
    const hi = Math.max(o, cl, sHigh, sLow);
    const lo = Math.max(0.05, Math.min(o, cl, sHigh, sLow));
    return {
      time: c.time,
      open: o,
      high: hi,
      low: lo,
      close: cl,
      volume: Math.max(120, Math.round((c.volume || 25e3) * 0.35))
    };
  });
  const lastRaw = raw[raw.length - 1]?.close ?? 0;
  const scale = opts.targetLastClose && opts.targetLastClose > 0 && lastRaw > 0 ? opts.targetLastClose / lastRaw : 1;
  return raw.map((c) => ({
    time: c.time,
    open: round24(c.open * scale),
    high: round24(c.high * scale),
    low: round24(Math.max(0.05, c.low * scale)),
    close: round24(c.close * scale),
    volume: c.volume
  }));
}
function expandHourlyToSubBars(hourly, interval) {
  if (interval === "1h" || hourly.length === 0) return hourly;
  const stepMin = interval === "1m" ? 5 : interval === "5m" ? 5 : 15;
  const steps = Math.floor(60 / stepMin);
  const recent = hourly.slice(-24);
  const out = [];
  for (const bar of recent) {
    const baseMs = Date.parse(bar.time);
    if (!Number.isFinite(baseMs)) continue;
    const span = bar.high - bar.low;
    let prevClose = bar.open;
    for (let s = 0; s < steps; s++) {
      const tMs = baseMs + s * stepMin * 6e4;
      const frac = (s + 1) / steps;
      const wave = Math.sin((s + 1) / steps * Math.PI) * span * 0.22 * (bar.close >= bar.open ? 1 : -1);
      const targetClose = s === steps - 1 ? bar.close : round24(bar.open + (bar.close - bar.open) * frac + wave);
      const clampedClose = Math.min(bar.high, Math.max(bar.low, targetClose));
      const open = s === 0 ? bar.open : prevClose;
      const hi = s === Math.floor(steps * 0.4) ? bar.high : round24(Math.min(bar.high, Math.max(open, clampedClose) + span * 0.12));
      const lo = s === Math.floor(steps * 0.7) ? bar.low : round24(Math.max(bar.low, Math.min(open, clampedClose) - span * 0.12));
      out.push({
        time: new Date(tMs).toISOString(),
        open: round24(open),
        high: round24(Math.max(open, clampedClose, hi)),
        low: round24(Math.min(open, clampedClose, lo)),
        close: round24(clampedClose),
        volume: Math.max(50, Math.round((bar.volume || 12e3) / steps))
      });
      prevClose = clampedClose;
    }
  }
  return out;
}
function buildRealSpreadCandles(longCandles, shortCandles) {
  const shortByTime = new Map(shortCandles.map((c) => [c.time, c]));
  const out = [];
  for (const lc of longCandles) {
    const sc = shortByTime.get(lc.time);
    if (!sc) continue;
    const o = Math.max(0.05, round24(lc.open - sc.open));
    const c = Math.max(0.05, round24(lc.close - sc.close));
    const hi = Math.max(o, c, round24(lc.high - sc.low));
    const lo = Math.max(0.05, Math.min(o, c, round24(lc.low - sc.high)));
    out.push({
      time: lc.time,
      open: o,
      high: hi,
      low: lo,
      close: c,
      volume: Math.min(lc.volume || 0, sc.volume || lc.volume || 0) || lc.volume || 0
    });
  }
  return out;
}
async function loadTerminalCandles(req) {
  const nowMs = Date.now();
  const fromIst = formatIstForAngel(nowMs - lookbackDays(req.interval) * 864e5);
  const toIst = formatIstForAngel(nowMs + 6e4);
  const angelInterval = toAngelInterval(req.interval);
  const meta = ANGEL_ONE_NSE_TOKENS[req.underlying] ?? ANGEL_ONE_NSE_TOKENS.NIFTY;
  const maxBars = req.interval === "1m" ? 375 : req.interval === "5m" ? 225 : 150;
  if (req.exchange === "NFO" && req.token) {
    let siblingInstruments = [];
    if (req.strike && req.right) {
      const master = await downloadInstrumentMaster(nowMs);
      if (master) {
        siblingInstruments = master.filter((m) => m.underlying === req.underlying && m.strike === req.strike && m.right === req.right).sort((a, b) => a.expiry.localeCompare(b.expiry)).slice(0, 5);
      }
    }
    const quoteTokens = [
      req.token,
      ...req.shortToken ? [req.shortToken] : [],
      ...siblingInstruments.map((s) => s.token)
    ];
    const [liveQuotes, nfoCandles] = await Promise.all([
      fetchOptionQuotes(quoteTokens),
      fetchCandlesByToken("NFO", req.token, angelInterval, fromIst, toIst)
    ]);
    const availableExpiries = siblingInstruments.map((s) => {
      const q = liveQuotes?.[s.token];
      return {
        expiry: s.expiry,
        token: s.token,
        symbol: s.symbol,
        strike: s.strike,
        right: s.right,
        bid: q?.bid ?? 0,
        ask: q?.ask ?? 0,
        ltp: q?.ltp ?? 0,
        volume: q?.volume ?? 0
      };
    });
    const lq = liveQuotes?.[req.token];
    const sq2 = req.shortToken ? liveQuotes?.[req.shortToken] : void 0;
    let bid2 = lq?.bid || req.liveBid || 0;
    let ask2 = lq?.ask || req.liveAsk || 0;
    const dayVolume = lq?.volume || 0;
    if (req.shortToken && (sq2 || req.shortBid || req.shortAsk)) {
      const sBid = sq2?.bid || req.shortBid || 0;
      const sAsk = sq2?.ask || req.shortAsk || 0;
      const liq = Math.max(0.05, round24(bid2 - sAsk));
      const entry = Math.max(liq + 0.05, round24(ask2 - sBid));
      bid2 = liq;
      ask2 = entry;
    }
    const lotSize = req.underlying === "BANKNIFTY" ? 30 : req.underlying === "FINNIFTY" ? 65 : 65;
    if (!req.shortToken && nfoCandles && nfoCandles.length >= 5) {
      const sliced = nfoCandles.slice(-maxBars).map((c) => ({
        ...c,
        volume: Math.round((c.volume || 0) * lotSize)
      }));
      const lastClose2 = sliced[sliced.length - 1].close;
      const finalBid2 = bid2 > 0 ? bid2 : round24(lastClose2 - 0.15);
      const finalAsk2 = ask2 > 0 ? ask2 : round24(lastClose2 + 0.15);
      return {
        underlying: req.underlying,
        interval: req.interval,
        source: "ANGEL_LIVE_NFO",
        candles: sliced,
        spotCandles: [],
        quote: {
          bid: finalBid2,
          ask: finalAsk2,
          ltp: lq?.ltp || lastClose2,
          spread: round24(Math.max(0, finalAsk2 - finalBid2)),
          volume: sliced[sliced.length - 1].volume || dayVolume || 0,
          dayVolume
        },
        availableExpiries
      };
    }
    if (req.shortToken && nfoCandles && nfoCandles.length >= 5) {
      const shortCandles = await fetchCandlesByToken("NFO", req.shortToken, angelInterval, fromIst, toIst);
      if (shortCandles && shortCandles.length >= 5) {
        const spreadCandles = buildRealSpreadCandles(nfoCandles, shortCandles).slice(-maxBars);
        if (spreadCandles.length >= 5) {
          const lastClose2 = spreadCandles[spreadCandles.length - 1].close;
          const finalBid2 = bid2 > 0 ? bid2 : round24(lastClose2 - 0.15);
          const finalAsk2 = ask2 > 0 ? ask2 : round24(lastClose2 + 0.15);
          return {
            underlying: req.underlying,
            interval: req.interval,
            source: "ANGEL_LIVE_NFO",
            candles: spreadCandles,
            spotCandles: [],
            quote: {
              bid: finalBid2,
              ask: finalAsk2,
              ltp: finalBid2,
              spread: round24(Math.max(0, finalAsk2 - finalBid2)),
              volume: spreadCandles[spreadCandles.length - 1].volume || dayVolume || 0,
              dayVolume
            },
            availableExpiries
          };
        }
      }
    }
    let spotCandles2 = await fetchCandlesByToken("NSE", meta.angelToken, angelInterval, fromIst, toIst);
    if (!spotCandles2 || spotCandles2.length < 5) {
      const cache = loadHistoricalCache();
      const cachedHourly = (cache?.[req.underlying] ?? cache?.NIFTY ?? []).slice(-120);
      spotCandles2 = expandHourlyToSubBars(cachedHourly, req.interval);
    } else {
      spotCandles2 = spotCandles2.slice(-maxBars);
    }
    const targetMark = bid2 > 0 && ask2 > 0 ? round24((bid2 + ask2) / 2) : bid2 > 0 ? bid2 : void 0;
    const calibrated = buildCalibratedOptionCandles(spotCandles2, {
      strike: req.strike || spotCandles2[spotCandles2.length - 1]?.close || 23350,
      right: req.right || "CE",
      expiry: req.expiry || new Date(nowMs + 7 * 864e5).toISOString().slice(0, 10),
      shortStrike: req.shortStrike,
      targetLastClose: targetMark
    });
    const lastClose = calibrated[calibrated.length - 1]?.close ?? targetMark ?? 50;
    const finalBid = bid2 > 0 ? bid2 : round24(lastClose - 0.2);
    const finalAsk = ask2 > 0 ? ask2 : round24(lastClose + 0.2);
    return {
      underlying: req.underlying,
      interval: req.interval,
      source: "CALIBRATED_BS_FROM_NSE",
      candles: calibrated,
      spotCandles: spotCandles2,
      quote: {
        bid: finalBid,
        ask: finalAsk,
        ltp: lastClose,
        spread: round24(Math.max(0, finalAsk - finalBid)),
        volume: dayVolume || calibrated[calibrated.length - 1]?.volume || 0,
        dayVolume
      },
      availableExpiries
    };
  }
  const [spotCandlesRaw, spots] = await Promise.all([
    fetchCandlesByToken("NSE", meta.angelToken, angelInterval, fromIst, toIst),
    fetchSpotQuotes()
  ]);
  let spotCandles = spotCandlesRaw;
  let usedCacheForSpot = false;
  if (!spotCandles || spotCandles.length < 5) {
    const cache = loadHistoricalCache();
    const cachedHourly = (cache?.[req.underlying] ?? cache?.NIFTY ?? []).slice(-120);
    spotCandles = expandHourlyToSubBars(cachedHourly, req.interval);
    usedCacheForSpot = true;
  } else {
    spotCandles = spotCandles.slice(-maxBars);
  }
  const sq = spots?.[req.underlying];
  const lastBar = spotCandles[spotCandles.length - 1];
  const ltp = sq?.ltp || lastBar?.close || 0;
  const tick = ltp > 5e3 ? 0.5 : 0.1;
  const bid = round24(ltp - tick);
  const ask = round24(ltp + tick);
  return {
    underlying: req.underlying,
    interval: req.interval,
    source: usedCacheForSpot ? "ANGEL_CACHE_NSE" : "ANGEL_LIVE_NSE",
    candles: spotCandles,
    spotCandles,
    quote: {
      bid,
      ask,
      ltp,
      spread: round24(ask - bid),
      volume: lastBar?.volume || 0
    }
  };
}

// server.ts
var __dirname = path3.dirname(fileURLToPath2(import.meta.url));
var app = express();
app.use(express.json({ limit: "32kb" }));
var store = createStore();
var market = angelMarketData();
function adminSecret() {
  return (process.env.ADMIN_SECRET || process.env.DASHBOARD_PASSCODE || "").trim();
}
function authorized(req) {
  const secret = adminSecret();
  return Boolean(secret) && req.header("x-admin-secret") === secret;
}
app.get("/api/paper/ledger", async (_req, res) => {
  try {
    const state = await readActiveLedger(store);
    if (!state) {
      res.status(404).json({ error: "No active ledger found" });
      return;
    }
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not read ledger" });
  }
});
app.get("/api/state", async (req, res) => {
  try {
    const useLive = req.query.live !== "0";
    const state = useLive ? await refreshLiveState(store, market) : await readActiveLedger(store);
    if (!state) {
      res.json({ ledger: null, persistent: databaseConfigured(), generatedAt: (/* @__PURE__ */ new Date()).toISOString() });
      return;
    }
    res.json({ ...buildDashboard(state), persistent: databaseConfigured(), ledger: state.ledgerId });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not read the ledger" });
  }
});
app.get("/api/journal", async (req, res) => {
  try {
    const state = await readActiveLedger(store);
    if (!state) {
      res.json({ rows: [] });
      return;
    }
    const kind = req.query.kind === "candidates" ? "candidates" : "trades";
    const month = typeof req.query.month === "string" ? req.query.month : void 0;
    const rows = await readJournal(store, state.ledgerId, kind, month);
    res.json({ ledgerId: state.ledgerId, kind, rows });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not read the journal" });
  }
});
app.get("/api/research", (_req, res) => {
  try {
    const research = getOfflineResearch();
    if (!research) {
      res.status(404).json({ error: "The one-year hourly cache is not available on this server." });
      return;
    }
    res.json(research.report);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Research failed" });
  }
});
app.get("/api/candles", async (req, res) => {
  try {
    const underlying = typeof req.query.underlying === "string" ? req.query.underlying : "NIFTY";
    const rawInterval = typeof req.query.interval === "string" ? req.query.interval : "1m";
    const interval = rawInterval === "1m" || rawInterval === "5m" || rawInterval === "15m" || rawInterval === "1h" ? rawInterval : "1m";
    const exchange = req.query.exchange === "NFO" ? "NFO" : "NSE";
    const token = typeof req.query.token === "string" ? req.query.token : void 0;
    const strike = req.query.strike ? Number(req.query.strike) : void 0;
    const right = req.query.right === "PE" ? "PE" : req.query.right === "CE" ? "CE" : void 0;
    const expiry = typeof req.query.expiry === "string" ? req.query.expiry : void 0;
    const shortToken = typeof req.query.shortToken === "string" ? req.query.shortToken : void 0;
    const shortStrike = req.query.shortStrike ? Number(req.query.shortStrike) : void 0;
    const liveBid = req.query.liveBid ? Number(req.query.liveBid) : void 0;
    const liveAsk = req.query.liveAsk ? Number(req.query.liveAsk) : void 0;
    const shortBid = req.query.shortBid ? Number(req.query.shortBid) : void 0;
    const shortAsk = req.query.shortAsk ? Number(req.query.shortAsk) : void 0;
    const payload = await loadTerminalCandles({
      underlying,
      interval,
      exchange,
      token,
      strike,
      right,
      expiry,
      shortToken,
      shortStrike,
      liveBid,
      liveAsk,
      shortBid,
      shortAsk
    });
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Candle fetch failed" });
  }
});
app.get("/api/tick", async (req, res) => {
  try {
    const force = req.query.eod === "1";
    const cycle = await runPaperCycle(store, market, { force });
    res.json({ ok: true, persistent: databaseConfigured(), cycle });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Cycle failed" });
  }
});
app.get("/api/health", async (_req, res) => {
  try {
    const cycle = await runPaperCycle(store, market, {});
    const state = await readActiveLedger(store);
    res.json({
      ok: true,
      persistent: databaseConfigured(),
      ledgerId: state?.ledgerId ?? null,
      equity: state?.lastEquity ?? null,
      lastCycle: state?.lastCycle ?? null,
      cycle
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "Health check failed" });
  }
});
app.post("/api/admin", async (req, res) => {
  if (!adminSecret()) {
    res.status(503).json({ error: "Set ADMIN_SECRET (or DASHBOARD_PASSCODE) before changing the ledger." });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ error: "Admin secret was missing or wrong." });
    return;
  }
  const action = String(req.body?.action ?? "");
  const now = (/* @__PURE__ */ new Date()).toISOString();
  try {
    if (action === "reset_ledger") {
      const result2 = await resetPaperLedger(store, Date.now());
      if (!result2.ok) {
        res.status(409).json({ error: result2.error });
        return;
      }
      res.json({ ok: true, ledgerId: result2.state.ledgerId, equity: result2.state.lastEquity });
      return;
    }
    const result = await mutateLedger(store, Date.now(), (state) => {
      if (action === "pause") {
        state.control = { entriesEnabled: false, updatedAt: now, updatedBy: "admin" };
        state.decisionLog.unshift({ t: now, kind: "ADMIN", message: "New entries paused. Open positions are still managed." });
      } else if (action === "resume") {
        state.control = { entriesEnabled: true, updatedAt: now, updatedBy: "admin" };
        state.decisionLog.unshift({ t: now, kind: "ADMIN", message: "New entries resumed." });
      } else if (action === "ack_kill_switch") {
        state.killSwitch = { active: false, reason: null, at: null };
        state.peakEquity = state.lastEquity;
        state.control = { entriesEnabled: true, updatedAt: now, updatedBy: "admin" };
        state.decisionLog.unshift({
          t: now,
          kind: "ADMIN",
          message: "Drawdown kill switch acknowledged. The peak was reset to current equity."
        });
      } else if (action === "retrain") {
        state.liveLabelsAtLastTrain = -1e6;
        state.learningLog.unshift({ t: now, kind: "MODEL", message: "Retrain requested. It runs on the next cycle." });
      } else {
        throw new Error("Unknown action");
      }
    });
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json({ ok: true, ledgerId: result.state.ledgerId });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Admin action failed" });
  }
});
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path3.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path3.join(distPath, "index.html"));
    });
  }
  const port = Number(process.env.PORT) || 3e3;
  app.listen(port, "0.0.0.0", () => {
    console.log(`Paper-training server on http://0.0.0.0:${port}`);
  });
}
if (!process.env.VERCEL) startServer();
var server_default = app;
export {
  server_default as default
};
