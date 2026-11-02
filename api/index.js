// server.ts
import "dotenv/config";
import express from "express";
import path2 from "node:path";
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
  "RELIANCE",
  "TCS",
  "HDFCBANK",
  "INFY",
  "ICICIBANK",
  "SBIN"
];
var INDEX_UNDERLYINGS = /* @__PURE__ */ new Set(["NIFTY", "BANKNIFTY", "FINNIFTY"]);

// src/quant/angelOneSmartApi.ts
var ANGEL_ONE_NSE_TOKENS = {
  NIFTY: { symbol: "NIFTY", angelToken: "99926000", tradingSymbol: "Nifty 50", exchange: "NSE" },
  BANKNIFTY: { symbol: "BANKNIFTY", angelToken: "99926009", tradingSymbol: "Nifty Bank", exchange: "NSE" },
  FINNIFTY: { symbol: "FINNIFTY", angelToken: "99926037", tradingSymbol: "Nifty Fin Service", exchange: "NSE" },
  INDIA_VIX: { symbol: "INDIA_VIX", angelToken: "99926017", tradingSymbol: "India VIX", exchange: "NSE" },
  RELIANCE: { symbol: "RELIANCE", angelToken: "2885", tradingSymbol: "RELIANCE-EQ", exchange: "NSE" },
  TCS: { symbol: "TCS", angelToken: "11536", tradingSymbol: "TCS-EQ", exchange: "NSE" },
  HDFCBANK: { symbol: "HDFCBANK", angelToken: "1333", tradingSymbol: "HDFCBANK-EQ", exchange: "NSE" },
  INFY: { symbol: "INFY", angelToken: "1594", tradingSymbol: "INFY-EQ", exchange: "NSE" },
  ICICIBANK: { symbol: "ICICIBANK", angelToken: "4963", tradingSymbol: "ICICIBANK-EQ", exchange: "NSE" },
  SBIN: { symbol: "SBIN", angelToken: "3045", tradingSymbol: "SBIN-EQ", exchange: "NSE" }
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
async function fetchQuoteBatch(exchange, tokens) {
  const { apiKey, configured } = credentials();
  if (!configured || tokens.length === 0) return tokens.length === 0 ? [] : null;
  let jwt = await ensureAngelOneSession(false);
  if (!jwt) return null;
  const call = async (token) => {
    const res = await fetch(`${ANGEL_BASE_URL}/rest/secure/angelbroking/market/v1/quote/`, {
      method: "POST",
      headers: headers(apiKey, token),
      body: JSON.stringify({ mode: "FULL", exchangeTokens: { [exchange]: tokens } }),
      signal: AbortSignal.timeout(8e3)
    });
    const data = await res.json();
    return { res, data };
  };
  try {
    let { res, data } = await call(jwt);
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
}
async function fetchSpotQuotes() {
  const metas = Object.values(ANGEL_ONE_NSE_TOKENS);
  const fetched = await fetchQuoteBatch("NSE", metas.map((m) => m.angelToken));
  if (!fetched) return null;
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
  return out;
}
async function fetchOptionQuotes(tokens) {
  const unique = [...new Set(tokens.filter(Boolean))];
  const out = {};
  for (let i = 0; i < unique.length; i += QUOTE_BATCH) {
    const batch = unique.slice(i, i + QUOTE_BATCH);
    const fetched = await fetchQuoteBatch("NFO", batch);
    if (!fetched) return null;
    for (const item of fetched) {
      const leg = toLegQuote(item);
      if (leg) out[leg.token] = leg;
    }
  }
  return out;
}
async function fetchHourlyCandles(symbol, fromIst, toIst) {
  const { apiKey, configured } = credentials();
  const meta = ANGEL_ONE_NSE_TOKENS[symbol];
  if (!configured || !meta) return null;
  const jwt = await ensureAngelOneSession(false);
  if (!jwt) return null;
  try {
    const res = await fetch(`${ANGEL_BASE_URL}/rest/secure/angelbroking/historical/v1/getCandleData`, {
      method: "POST",
      headers: headers(apiKey, jwt),
      body: JSON.stringify({
        exchange: meta.exchange,
        symboltoken: meta.angelToken,
        interval: "ONE_HOUR",
        fromdate: fromIst,
        todate: toIst
      }),
      signal: AbortSignal.timeout(8e3)
    });
    const text = await res.text();
    if (!text.startsWith("{")) return null;
    const payload = JSON.parse(text);
    if (!payload.status || !Array.isArray(payload.data)) return null;
    return payload.data.map((row) => ({
      time: String(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5] ?? 0)
    }));
  } catch (err) {
    lastAngelError = err instanceof Error ? err.message : "Angel candle fetch failed";
    return null;
  }
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
async function downloadInstrumentMaster(nowMs, spotByUnderlying = {}) {
  try {
    const res = await fetch(SCRIP_MASTER_URL, { signal: AbortSignal.timeout(2e4) });
    if (!res.ok) {
      lastAngelError = `Instrument master HTTP ${res.status}`;
      return null;
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) return null;
    return filterScripMaster(rows, nowMs, spotByUnderlying);
  } catch (err) {
    lastAngelError = err instanceof Error ? err.message : "Instrument master download failed";
    return null;
  }
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
  if (i < 4) return null;
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
  if (adxRising && row.adx14 >= 18) {
    if (c.close > row.donchianHigh20) {
      return {
        ...base,
        strategy: "breakout_momentum",
        direction: "CE",
        reason: `Close ${f1(c.close)} above 20-bar high ${f1(row.donchianHigh20)}, ADX ${f1(row.adx14)} rising`
      };
    }
    if (c.close < row.donchianLow20) {
      return {
        ...base,
        strategy: "breakout_momentum",
        direction: "PE",
        reason: `Close ${f1(c.close)} below 20-bar low ${f1(row.donchianLow20)}, ADX ${f1(row.adx14)} rising`
      };
    }
  }
  if (regime === "trending_up" && c.low <= row.ema20 && c.close > row.ema20 && row.rsi14 >= 45 && row.rsi14 <= 70) {
    return {
      ...base,
      strategy: "trend_following",
      direction: "CE",
      reason: `Uptrend (ADX ${f1(row.adx14)}, EMA20>EMA50) pullback to EMA20 held, RSI ${f1(row.rsi14)}`
    };
  }
  if (regime === "trending_down" && c.high >= row.ema20 && c.close < row.ema20 && row.rsi14 >= 30 && row.rsi14 <= 55) {
    return {
      ...base,
      strategy: "trend_following",
      direction: "PE",
      reason: `Downtrend (ADX ${f1(row.adx14)}, EMA20<EMA50) rally to EMA20 rejected, RSI ${f1(row.rsi14)}`
    };
  }
  if (regime === "range" && row.adx14 < 20) {
    if (pc.close < prev.lowerBand && c.close > row.lowerBand && prev.rsi14 <= 35) {
      return {
        ...base,
        strategy: "mean_reversion",
        direction: "CE",
        reason: `Range (ADX ${f1(row.adx14)}): closed back above lower Bollinger band after RSI ${f1(prev.rsi14)}`
      };
    }
    if (pc.close > prev.upperBand && c.close < row.upperBand && prev.rsi14 >= 65) {
      return {
        ...base,
        strategy: "mean_reversion",
        direction: "PE",
        reason: `Range (ADX ${f1(row.adx14)}): closed back below upper Bollinger band after RSI ${f1(prev.rsi14)}`
      };
    }
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
function fitLogistic(samples, lambda = 4, maxIter = 30) {
  if (samples.length < 30) return null;
  const positives = samples.filter((s) => s.y === 1).length;
  if (positives === 0 || positives === samples.length) return null;
  const d = samples[0].x.length;
  const totalW = samples.reduce((a, s) => a + s.weight, 0);
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
    const fit = train.length >= opts.minTrain ? fitLogistic(train, opts.lambda) : null;
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
  if (oos.length === 0) {
    return { n: 0, auc: null, avgR: null, threshold: null, acceptedN: 0, acceptedAvgR: null };
  }
  const sortedP = oos.map((o) => o.p).sort((a, b) => a - b);
  const threshold = sortedP[Math.floor(sortedP.length / 2)];
  const accepted = oos.filter((o) => o.p >= threshold);
  const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return {
    n: oos.length,
    auc: aucScore(oos.map((o) => o.p), oos.map((o) => o.y)),
    avgR: avg(oos.map((o) => o.r)),
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
var GATE_MIN_LIVE_OOS = 100;
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
var MODEL_LAMBDA = 4;
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
function weekBoundaries(samples, skipWeeks) {
  if (samples.length === 0) return [];
  const first = Math.min(...samples.map((s) => s.entryMs));
  const last = Math.max(...samples.map((s) => s.entryMs));
  const out = [];
  let cursor = istWeekStartMs(first);
  for (let i = 0; cursor <= last; i++) {
    if (i >= skipWeeks) out.push(cursor);
    cursor += 7 * 864e5;
  }
  return out;
}
function offlineWalkForward(offline) {
  return walkForward(offline, monthBoundaries(offline, 2), { minTrain: 100, lambda: MODEL_LAMBDA });
}
function trainModelSnapshot(offline, live, nowMs, offlineOosCache) {
  const weightedOffline = offline.map((s) => ({ ...s, weight: OFFLINE_SAMPLE_WEIGHT }));
  const liveSamples = live.map((s) => ({ ...s, weight: 1 }));
  const all = [...weightedOffline, ...liveSamples];
  const fit = fitLogistic(all, MODEL_LAMBDA);
  if (!fit) return null;
  const offlineOosPreds = offlineOosCache?.oos ?? offlineWalkForward(offline).oos;
  const offlineOos = summarizeOos(offlineOosPreds);
  const liveWf = walkForward(all, weekBoundaries(liveSamples, 1), {
    minTrain: 100,
    lambda: MODEL_LAMBDA,
    isTest: (s) => s.source === "LIVE"
  });
  const liveOos = summarizeOos(liveWf.oos);
  const gate = decideGate(offlineOos, liveOos);
  const calibration = calibrationBuckets(gate.source === "LIVE" ? liveWf.oos : offlineOosPreds);
  const stamp = new Date(nowMs).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return {
    version: `lr-${stamp}-${offline.length}o-${live.length}l`,
    trainedAt: new Date(nowMs).toISOString(),
    featureNames: [...FEATURE_NAMES],
    means: fit.means,
    stds: fit.stds,
    weights: fit.weights,
    bias: fit.bias,
    lambda: fit.lambda,
    nOffline: offline.length,
    nLive: live.length,
    offlineWeight: OFFLINE_SAMPLE_WEIGHT,
    offlineOos,
    liveOos,
    calibration,
    gate
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
  const affordable = plans.filter((p) => p.maxLossPerLot <= input.budgetPerTradeInr);
  if (affordable.length > 0) {
    affordable.sort((a, b) => b.width - a.width);
    return { ok: true, plan: affordable[0], affordable: true };
  }
  plans.sort((a, b) => a.maxLossPerLot - b.maxLossPerLot);
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
function exitLevels(plan, cfg) {
  return {
    target: round2(plan.entryDebit + cfg.takeProfitFracOfMaxGain * (plan.width - plan.entryDebit)),
    stop: round2(plan.entryDebit * (1 - cfg.stopLossFracOfDebit))
  };
}
function evaluateSpreadExit(input) {
  if (input.dte <= input.cfg.exitAtDte) return "EXPIRY_RISK";
  const { target, stop } = exitLevels(input.plan, input.cfg);
  if (input.liquidationValue >= target) return "TAKE_PROFIT";
  if (input.liquidationValue <= stop) return "STOP_LOSS";
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
  riskPerTradePct: 0.04,
  maxOpenPositions: 3,
  maxOpenRiskPct: 0.1,
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
  takeProfitFracOfMaxGain: 0.5,
  stopLossFracOfDebit: 0.5,
  maxHoldSessions: 5,
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
  RELIANCE: 500,
  TCS: 225,
  HDFCBANK: 650,
  INFY: 400,
  ICICIBANK: 700,
  SBIN: 750
};
var CACHE_FILE = "angelOne1YearCache.json";
var YEAR_MS = 365 * 864e5;
var RISK_FREE = 0.06;
var MODEL_SPREAD_PCT = { NIFTY: 5e-3, BANKNIFTY: 6e-3, FINNIFTY: 0.015 };
var STOCK_SPREAD_PCT = 0.025;
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
      let exitIdx = -1;
      let exitValue = 0;
      let exitReason = null;
      let exitLongBid = 0;
      let exitShortAsk = 0;
      let sessions = 1;
      let lastDate = dateStr;
      for (let j = i + 1; j < candles.length; j++) {
        const tj = ends[j];
        const dj = istDate(tj);
        if (dj !== lastDate) {
          sessions++;
          lastDate = dj;
        }
        const volJ = volAt(j) ?? vol;
        const tYears = (expiryMs - tj) / YEAR_MS;
        const lq = modelQuote(plan.long.token, bsPrice(closes[j], plan.long.strike, tYears, volJ, RISK_FREE, plan.right), spreadPct, tj);
        const sq = modelQuote(plan.short.token, bsPrice(closes[j], plan.short.strike, tYears, volJ, RISK_FREE, plan.right), spreadPct, tj);
        const liq = Math.max(0, round22(lq.bid - sq.ask));
        const reason = evaluateSpreadExit({
          plan,
          liquidationValue: liq,
          sessionsHeld: sessions,
          dte: calendarDaysBetween(dj, expiry),
          cfg
        });
        if (reason) {
          exitIdx = j;
          exitValue = liq;
          exitReason = reason;
          exitLongBid = lq.bid;
          exitShortAsk = sq.ask;
          break;
        }
      }
      if (exitIdx < 0 || !exitReason) {
        counts.incomplete++;
        continue;
      }
      busyUntil[sig.direction] = exitIdx;
      const entryCash = plan.entryDebit * lot + plan.entryChargesPerLot;
      const exitCash = exitValue * lot - exitChargesFor(exitLongBid, exitShortAsk, lot);
      const pnl = round22(exitCash - entryCash);
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
        sessionsHeld: sessions,
        exitReason,
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
        isIndex
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
function runOfflineResearch(cache, opts = {}) {
  const cfg = opts.cfg ?? DEFAULT_ENGINE_CONFIG;
  const lotSizes = opts.lotSizes ?? RESEARCH_LOT_SIZES;
  const vix = buildVixSeries(cache.INDIA_VIX ?? []);
  const { trades, counts, rejections } = simulateTrades(cache, cfg, lotSizes, vix, false);
  const flipped = simulateTrades(cache, cfg, lotSizes, vix, true);
  const samples = trades.map((t) => ({
    id: t.id,
    x: t.features,
    y: t.pnlPerLotInr > 0 ? 1 : 0,
    r: t.rMultiple,
    entryMs: t.entryMs,
    exitMs: t.exitMs,
    weight: 1,
    source: "OFFLINE"
  }));
  const wf = offlineWalkForward(samples);
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
  const publicTrade = ({ plan, exitLongBid, exitShortAsk, isIndex, ...rest }) => rest;
  const sortedByEntry = [...trades].sort((a, b) => a.entryMs - b.entryMs);
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
      `Exits checked at each hourly close: take profit at ${cfg.takeProfitFracOfMaxGain * 100}% of max gain, stop at ${cfg.stopLossFracOfDebit * 100}% of debit, ${cfg.maxHoldSessions}-session time stop, exit at ${cfg.exitAtDte} days to expiry.`,
      "Expiries: NIFTY weekly on Tuesdays, others on the last Tuesday of the month (holiday shifts ignored).",
      `Lot sizes are today's (e.g. NIFTY ${lotSizes.NIFTY}); per-lot results use them for the whole year.`,
      "Trades still open at the end of the data are dropped."
    ],
    counts,
    rejectionReasons: [...rejections.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n).slice(0, 8),
    summary: summarize(trades),
    oppositeDirectionBaseline: summarize(flipped.trades),
    byStrategy: groupStats(trades, (t) => t.strategy, pnlOf, rOf),
    byUnderlying: groupStats(trades, (t) => t.underlying, pnlOf, rOf),
    byRegime: groupStats(trades, (t) => t.regime, pnlOf, rOf),
    byDirection: groupStats(trades, (t) => t.direction === "CE" ? "Bull call spread" : "Bear put spread", pnlOf, rOf),
    byExitReason: groupStats(trades, (t) => t.exitReason, pnlOf, rOf),
    byMonth: groupStats(trades, (t) => istMonthKey(t.entryMs), pnlOf, rOf).sort((a, b) => a.key.localeCompare(b.key)),
    walkForward: { folds: wf.folds, oos: summarizeOos(wf.oos), calibration: calibrationBuckets(wf.oos) },
    portfolio: simulatePortfolio(trades, cfg),
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
import pg from "pg";
var MemoryKvStore = class {
  constructor() {
    this.rows = /* @__PURE__ */ new Map();
  }
  async get(key) {
    const row = this.rows.get(key);
    return row ? { rev: row.rev, data: row.data } : null;
  }
  async put(key, data, expectedRev) {
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
};
var PgKvStore = class {
  constructor(pool2) {
    this.pool = pool2;
  }
  async get(key) {
    const res = await this.pool.query(
      `SELECT config_payload_json FROM config_history WHERE config_version_id = $1`,
      [key]
    );
    const payload = res.rows[0]?.config_payload_json;
    if (!payload || typeof payload.rev !== "number" || !("data" in payload)) return null;
    return { rev: payload.rev, data: payload.data };
  }
  async put(key, data, expectedRev) {
    const rev = (expectedRev ?? 0) + 1;
    const payload = JSON.stringify({ rev, data });
    if (expectedRev === null) {
      const res2 = await this.pool.query(
        `INSERT INTO config_history (config_version_id, applied_at, is_active_champion, previous_champion_id, config_payload_json, change_summary)
         VALUES ($1, NOW(), FALSE, NULL, $2::jsonb, $3)
         ON CONFLICT (config_version_id) DO NOTHING`,
        [key, payload, "paper-v2"]
      );
      return res2.rowCount === 1 ? { ok: true, rev } : { ok: false };
    }
    const res = await this.pool.query(
      `UPDATE config_history
       SET config_payload_json = $2::jsonb, applied_at = NOW(), change_summary = $4
       WHERE config_version_id = $1 AND (config_payload_json->>'rev')::int = $3`,
      [key, payload, expectedRev, "paper-v2"]
    );
    return res.rowCount === 1 ? { ok: true, rev } : { ok: false };
  }
};
var pool = null;
function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL_RW || process.env.DATABASE_URL_RO || process.env.DATABASE_URL);
}
function createStore() {
  const url = process.env.DATABASE_URL_RW || process.env.DATABASE_URL_RO || process.env.DATABASE_URL || "";
  if (!url) return new MemoryKvStore();
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: 1,
      idleTimeoutMillis: 1e4,
      connectionTimeoutMillis: 1e4
    });
  }
  return new PgKvStore(pool);
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
var TRAIN_EVERY_LABELS = 10;
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
async function withLease(store2, fn) {
  const now = Date.now();
  const current = await store2.get(KEY_LEASE);
  if (current && current.data.until > now && current.data.owner !== OWNER) return { busy: true };
  const claimed = await store2.put(KEY_LEASE, { owner: OWNER, until: now + LEASE_MS }, current ? current.rev : null);
  if (!claimed.ok) return { busy: true };
  try {
    return { busy: false, value: await fn() };
  } finally {
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
async function persist(store2, state, rev) {
  const saved = await store2.put(stateKey(state.ledgerId), state, rev);
  if (!saved.ok) return false;
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
function perLotOutcome(plan, exitValue, longBid, shortAsk) {
  const units = plan.lotSize;
  const entryCash = plan.entryDebit * units + plan.entryChargesPerLot;
  const exitCharges = exitChargesFor(longBid, shortAsk, units);
  const exitCash = exitValue * units - exitCharges;
  const pnl = round23(exitCash - entryCash);
  return { pnl, r: plan.maxLossPerLot > 0 ? pnl / plan.maxLossPerLot : 0, exitCharges };
}
function bumpSession(item, today) {
  if (item.lastSessionDate !== today) {
    item.sessionsHeld += 1;
    item.lastSessionDate = today;
  }
}
function applyMark(item, quotes, nowMs, cfg, state) {
  const marked = markSpread(item.plan, quotes, nowMs, cfg.quoteMaxAgeSec);
  if (!marked.ok) {
    item.staleMarks += 1;
    state.counters.staleMarks += 1;
    return;
  }
  item.staleMarks = 0;
  item.lastMark = marked.mark;
  item.peakValue = Math.max(item.peakValue, marked.mark.liquidationValue);
  item.troughValue = Math.min(item.troughValue, marked.mark.liquidationValue);
}
function exitReasonFor(item, cfg, today) {
  if (!item.lastMark) return null;
  const fromRules = evaluateSpreadExit({
    plan: item.plan,
    liquidationValue: item.lastMark.liquidationValue,
    sessionsHeld: item.sessionsHeld,
    dte: calendarDaysBetween(today, item.plan.expiry),
    cfg
  });
  if (fromRules) return fromRules;
  if (item.staleMarks >= STALE_FORCE_AFTER) return "STALE_DATA_FORCED";
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
  candidate.pnlPerLotMidInr = round23(
    (mark.midValue - candidate.plan.midDebit) * candidate.plan.lotSize - candidate.plan.entryChargesPerLot - outcome.exitCharges
  );
  candidate.rMultiple = outcome.r;
  candidate.win = outcome.pnl > 0;
  state.counters.candidatesClosed += 1;
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
    exitReason: reason
  };
  state.liveSamples.push(sample);
  state.pending.candidates.push(candidate);
  log(state, "CANDIDATE", `${candidate.underlying} ${candidate.direction} ${candidate.strategy} closed ${reason}: ${outcome.pnl.toFixed(0)} \u20B9/lot (${outcome.r.toFixed(2)}R)`, candidate.underlying);
}
function closePosition(state, position, reason, nowMs) {
  const mark = position.lastMark;
  if (!mark) return null;
  const units = position.lots * position.plan.lotSize;
  const exitCharges = exitChargesFor(mark.longBid, mark.shortAsk, units);
  const exitCashIn = round23(mark.liquidationValue * units - exitCharges);
  state.cash = round23(state.cash + exitCashIn);
  const net = round23(exitCashIn - position.entryCashOutInr);
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
    mfePct: position.plan.entryDebit > 0 ? (position.peakValue - position.plan.entryDebit) / position.plan.entryDebit : 0,
    maePct: position.plan.entryDebit > 0 ? (position.troughValue - position.plan.entryDebit) / position.plan.entryDebit : 0,
    exitReason: reason,
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
  log(state, "EXIT", `${position.underlying} ${position.direction} ${position.lots} lot closed ${reason}: ${net >= 0 ? "+" : ""}\u20B9${net.toFixed(0)}`, position.underlying);
  return trade;
}
function revalue(state, niftyLtp) {
  let equity = state.cash;
  let equityMid = state.cash;
  let unrealized = 0;
  for (const pos of state.openPositions) {
    if (!pos.lastMark) continue;
    const value = markValue(pos.lastMark, pos.plan, pos.lots);
    equity += value.liquidationInr;
    equityMid += value.midInr;
    pos.unrealizedInr = round23(value.liquidationInr - pos.entryCashOutInr);
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
function maybeTrain(state, nowMs, force) {
  const labels = state.counters.candidatesClosed;
  if (!force && state.model && labels - state.liveLabelsAtLastTrain < TRAIN_EVERY_LABELS) return;
  const research = getOfflineResearch();
  const offline = research?.samples ?? [];
  const live = state.liveSamples.map((s) => ({
    id: s.id,
    x: s.x,
    y: s.y,
    r: s.r,
    entryMs: s.entryMs,
    exitMs: s.exitMs,
    weight: 1,
    source: "LIVE"
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
  if (cached && cached.data.asOf === today && cached.data.items.length > 0) return cached.data.items;
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
  const finish = async (status, summary) => {
    state.angel = market2.status();
    state.lastCycle = { at: new Date(nowMs).toISOString(), durationMs: Date.now() - started, status, summary };
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
  const fromIst = formatIstForAngel(nowMs - 25 * 864e5);
  const toIst = formatIstForAngel(nowMs);
  const regimes = {};
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
    if (state.activeCandidates.some((c) => c.underlying === plan.underlying && c.direction === sig.direction)) {
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
  if (quoteTokens.size > 0) {
    try {
      const fetched = await market2.fetchOptionQuotes([...quoteTokens]);
      if (!fetched) {
        state.counters.dataErrors += 1;
        log(state, "DATA", "Option quote batch failed; open positions were not marked this cycle");
      } else quotes = fetched;
    } catch (err) {
      state.counters.dataErrors += 1;
      log(state, "DATA", err instanceof Error ? err.message : "Option quote batch failed");
    }
  }
  for (const pos of state.openPositions) {
    bumpSession(pos, today);
    applyMark(pos, quotes, nowMs, cfg, state);
  }
  for (const cand of state.activeCandidates) {
    bumpSession(cand, today);
    applyMark(cand, quotes, nowMs, cfg, state);
  }
  const stillOpen = [];
  for (const pos of state.openPositions) {
    const reason = exitReasonFor(pos, cfg, today);
    if (!reason) {
      stillOpen.push(pos);
      continue;
    }
    closePosition(state, pos, reason, nowMs);
    const cand = state.activeCandidates.find((c) => c.id === pos.candidateId);
    if (cand && !cand.closedAt) {
      cand.lastMark = pos.lastMark;
      cand.peakValue = pos.peakValue;
      cand.troughValue = pos.troughValue;
      cand.sessionsHeld = pos.sessionsHeld;
      closeCandidate(state, cand, reason, nowMs);
    }
  }
  state.openPositions = stillOpen;
  const stillActive = [];
  for (const cand of state.activeCandidates) {
    if (cand.closedAt) continue;
    const reason = exitReasonFor(cand, cfg, today);
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
          entryCashOutInr: decision.cashOutInr,
          maxLossInr: decision.maxLossInr,
          marginBlockedInr: decision.marginInr,
          lastMark: candidate.lastMark,
          peakValue: candidate.peakValue,
          troughValue: candidate.troughValue,
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
  rows.sort((a, b) => Date.parse(b.closedAt || "") - Date.parse(a.closedAt || ""));
  return rows;
}
async function readActiveLedger(store2) {
  const active = await store2.get(KEY_ACTIVE);
  if (!active) return null;
  const row = await store2.get(stateKey(active.data.ledgerId));
  return row?.data ?? null;
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
  const unrealized = state.openPositions.reduce((sum, p) => sum + p.unrealizedInr, 0);
  const realized = state.closedSummaries.reduce((sum, t) => sum + t.netPnlInr, 0);
  const tradeRows = state.closedSummaries.map((t) => ({
    strategy: t.strategy,
    underlying: t.underlying,
    regime: t.regime,
    direction: t.direction,
    exitReason: t.exitReason,
    net: t.netPnlInr,
    r: t.rMultiple
  }));
  const candidateRows = state.liveSamples.map((s) => ({
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
    dayPnlInr: state.lastEquity - state.dayStartEquity,
    realizedPnlInr: realized,
    unrealizedPnlInr: unrealized,
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
    suspendedStrategies: suspendedStrategies(state.liveSamples),
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

// server.ts
var __dirname = path2.dirname(fileURLToPath2(import.meta.url));
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
app.get("/api/state", async (_req, res) => {
  try {
    const state = await readActiveLedger(store);
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
    const distPath = path2.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path2.join(distPath, "index.html"));
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
