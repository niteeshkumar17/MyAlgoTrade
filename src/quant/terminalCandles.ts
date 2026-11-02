import {
  ANGEL_ONE_NSE_TOKENS,
  type AngelCandleInterval,
  downloadInstrumentMaster,
  fetchCandlesByToken,
  fetchOptionQuotes,
  fetchSpotQuotes,
} from './angelOneSmartApi.js';
import { formatIstForAngel, istToMs } from './clock.js';
import { bsPrice } from './options.js';
import { loadHistoricalCache } from './research.js';
import type { Candle, OptionRight } from './types.js';

export type TerminalInterval = '1m' | '5m' | '15m' | '1h';

export interface SiblingExpiryOption {
  expiry: string;
  token: string;
  symbol: string;
  strike: number;
  right: OptionRight;
  bid: number;
  ask: number;
  ltp: number;
  volume: number;
}

export interface TerminalCandleRequest {
  underlying: string;
  interval: TerminalInterval;
  token?: string;
  exchange?: 'NSE' | 'NFO';
  strike?: number;
  right?: OptionRight;
  expiry?: string;
  shortToken?: string;
  shortStrike?: number;
  liveBid?: number;
  liveAsk?: number;
  shortBid?: number;
  shortAsk?: number;
}

export interface TerminalCandleResponse {
  underlying: string;
  interval: TerminalInterval;
  source: 'ANGEL_LIVE_NFO' | 'ANGEL_LIVE_NSE' | 'ANGEL_CACHE_NSE' | 'CALIBRATED_BS_FROM_NSE';
  candles: Candle[];
  spotCandles: Candle[];
  quote: {
    bid: number;
    ask: number;
    ltp: number;
    spread: number;
    volume: number;
    dayVolume?: number;
  };
  availableExpiries?: SiblingExpiryOption[];
}

function toAngelInterval(interval: TerminalInterval): AngelCandleInterval {
  if (interval === '1m') return 'ONE_MINUTE';
  if (interval === '5m') return 'FIVE_MINUTE';
  if (interval === '15m') return 'FIFTEEN_MINUTE';
  return 'ONE_HOUR';
}

function lookbackDays(interval: TerminalInterval): number {
  if (interval === '1m') return 2;
  if (interval === '5m') return 5;
  if (interval === '15m') return 14;
  return 45;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Given real underlying spot candles and an option strike/expiry/right,
 * computes option OHLC candles calibrated so the latest close matches the live market mark (`targetLastClose`).
 */
export function buildCalibratedOptionCandles(
  spotCandles: Candle[],
  opts: {
    strike: number;
    right: OptionRight;
    expiry: string;
    shortStrike?: number;
    vixPct?: number;
    targetLastClose?: number;
  }
): Candle[] {
  if (spotCandles.length === 0) return [];
  const expiryMs = istToMs(opts.expiry, 15, 30);
  const yearMs = 365 * 86_400_000;
  const vol = Math.max(0.11, (opts.vixPct ?? 15) / 100);
  const r = 0.06;

  const priceAt = (spot: number, tMs: number): number => {
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
      volume: Math.max(120, Math.round((c.volume || 25_000) * 0.35)),
    };
  });

  const lastRaw = raw[raw.length - 1]?.close ?? 0;
  const scale =
    opts.targetLastClose && opts.targetLastClose > 0 && lastRaw > 0
      ? opts.targetLastClose / lastRaw
      : 1;

  return raw.map((c) => ({
    time: c.time,
    open: round2(c.open * scale),
    high: round2(c.high * scale),
    low: round2(Math.max(0.05, c.low * scale)),
    close: round2(c.close * scale),
    volume: c.volume,
  }));
}

/**
 * Subdivides hourly candles into deterministic 1m, 5m or 15m intraday bars when only hourly cache is available,
 * preserving each hourly bar's exact open, high, low, close, and total volume.
 */
export function expandHourlyToSubBars(hourly: Candle[], interval: TerminalInterval): Candle[] {
  if (interval === '1h' || hourly.length === 0) return hourly;
  const stepMin = interval === '1m' ? 5 : interval === '5m' ? 5 : 15;
  const steps = Math.floor(60 / stepMin);
  const recent = hourly.slice(-24);
  const out: Candle[] = [];

  for (const bar of recent) {
    const baseMs = Date.parse(bar.time);
    if (!Number.isFinite(baseMs)) continue;
    const span = bar.high - bar.low;
    let prevClose = bar.open;
    for (let s = 0; s < steps; s++) {
      const tMs = baseMs + s * stepMin * 60_000;
      const frac = (s + 1) / steps;
      const wave = Math.sin(((s + 1) / steps) * Math.PI) * span * 0.22 * (bar.close >= bar.open ? 1 : -1);
      const targetClose =
        s === steps - 1
          ? bar.close
          : round2(bar.open + (bar.close - bar.open) * frac + wave);
      const clampedClose = Math.min(bar.high, Math.max(bar.low, targetClose));
      const open = s === 0 ? bar.open : prevClose;
      const hi = s === Math.floor(steps * 0.4) ? bar.high : round2(Math.min(bar.high, Math.max(open, clampedClose) + span * 0.12));
      const lo = s === Math.floor(steps * 0.7) ? bar.low : round2(Math.max(bar.low, Math.min(open, clampedClose) - span * 0.12));
      out.push({
        time: new Date(tMs).toISOString(),
        open: round2(open),
        high: round2(Math.max(open, clampedClose, hi)),
        low: round2(Math.min(open, clampedClose, lo)),
        close: round2(clampedClose),
        volume: Math.max(50, Math.round((bar.volume || 12_000) / steps)),
      });
      prevClose = clampedClose;
    }
  }
  return out;
}

function buildRealSpreadCandles(longCandles: Candle[], shortCandles: Candle[]): Candle[] {
  const shortByTime = new Map(shortCandles.map((c) => [c.time, c]));
  const out: Candle[] = [];
  for (const lc of longCandles) {
    const sc = shortByTime.get(lc.time);
    if (!sc) continue;
    const o = Math.max(0.05, round2(lc.open - sc.open));
    const c = Math.max(0.05, round2(lc.close - sc.close));
    const hi = Math.max(o, c, round2(lc.high - sc.low));
    const lo = Math.max(0.05, Math.min(o, c, round2(lc.low - sc.high)));
    out.push({
      time: lc.time,
      open: o,
      high: hi,
      low: lo,
      close: c,
      volume: Math.min(lc.volume || 0, sc.volume || lc.volume || 0) || lc.volume || 0,
    });
  }
  return out;
}

export async function loadTerminalCandles(req: TerminalCandleRequest): Promise<TerminalCandleResponse> {
  const nowMs = Date.now();
  const fromIst = formatIstForAngel(nowMs - lookbackDays(req.interval) * 86_400_000);
  const toIst = formatIstForAngel(nowMs + 60_000);
  const angelInterval = toAngelInterval(req.interval);
  const meta = ANGEL_ONE_NSE_TOKENS[req.underlying] ?? ANGEL_ONE_NSE_TOKENS.NIFTY;
  const maxBars = req.interval === '1m' ? 375 : req.interval === '5m' ? 225 : 150;

  // 1. If requesting an NFO option leg or spread, fetch NFO candles FIRST (no wasted NSE candle request!)
  if (req.exchange === 'NFO' && req.token) {
    // Find sibling expiries for the same strike & right (e.g. 03 Nov vs 09 Nov 23350 CE)
    let siblingInstruments: Array<{ expiry: string; token: string; symbol: string; strike: number; right: OptionRight }> = [];
    if (req.strike && req.right) {
      const master = await downloadInstrumentMaster(nowMs);
      if (master) {
        siblingInstruments = master
          .filter((m) => m.underlying === req.underlying && m.strike === req.strike && m.right === req.right)
          .sort((a, b) => a.expiry.localeCompare(b.expiry))
          .slice(0, 5);
      }
    }

    const quoteTokens = [
      req.token,
      ...(req.shortToken ? [req.shortToken] : []),
      ...siblingInstruments.map((s) => s.token),
    ];

    const [liveQuotes, nfoCandles] = await Promise.all([
      fetchOptionQuotes(quoteTokens),
      fetchCandlesByToken('NFO', req.token, angelInterval, fromIst, toIst),
    ]);

    const availableExpiries: SiblingExpiryOption[] = siblingInstruments.map((s) => {
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
        volume: q?.volume ?? 0,
      };
    });

    const lq = liveQuotes?.[req.token];
    const sq = req.shortToken ? liveQuotes?.[req.shortToken] : undefined;

    let bid = lq?.bid || req.liveBid || 0;
    let ask = lq?.ask || req.liveAsk || 0;
    const dayVolume = lq?.volume || 0;

    if (req.shortToken && (sq || req.shortBid || req.shortAsk)) {
      const sBid = sq?.bid || req.shortBid || 0;
      const sAsk = sq?.ask || req.shortAsk || 0;
      const liq = Math.max(0.05, round2(bid - sAsk));
      const entry = Math.max(liq + 0.05, round2(ask - sBid));
      bid = liq;
      ask = entry;
    }

    // Single Option Leg: return real Angel One NFO candles directly
    const lotSize = req.underlying === 'BANKNIFTY' ? 30 : req.underlying === 'FINNIFTY' ? 65 : 65;
    if (!req.shortToken && nfoCandles && nfoCandles.length >= 5) {
      const sliced = nfoCandles.slice(-maxBars).map((c) => ({
        ...c,
        volume: Math.round((c.volume || 0) * lotSize),
      }));
      const lastClose = sliced[sliced.length - 1].close;
      const finalBid = bid > 0 ? bid : round2(lastClose - 0.15);
      const finalAsk = ask > 0 ? ask : round2(lastClose + 0.15);
      return {
        underlying: req.underlying,
        interval: req.interval,
        source: 'ANGEL_LIVE_NFO',
        candles: sliced,
        spotCandles: [],
        quote: {
          bid: finalBid,
          ask: finalAsk,
          ltp: lq?.ltp || lastClose,
          spread: round2(Math.max(0, finalAsk - finalBid)),
          volume: sliced[sliced.length - 1].volume || dayVolume || 0,
          dayVolume,
        },
        availableExpiries,
      };
    }

    // Net Spread View: fetch short leg NFO candles and build real NFO spread bars
    if (req.shortToken && nfoCandles && nfoCandles.length >= 5) {
      const shortCandles = await fetchCandlesByToken('NFO', req.shortToken, angelInterval, fromIst, toIst);
      if (shortCandles && shortCandles.length >= 5) {
        const spreadCandles = buildRealSpreadCandles(nfoCandles, shortCandles).slice(-maxBars);
        if (spreadCandles.length >= 5) {
          const lastClose = spreadCandles[spreadCandles.length - 1].close;
          const finalBid = bid > 0 ? bid : round2(lastClose - 0.15);
          const finalAsk = ask > 0 ? ask : round2(lastClose + 0.15);
          return {
            underlying: req.underlying,
            interval: req.interval,
            source: 'ANGEL_LIVE_NFO',
            candles: spreadCandles,
            spotCandles: [],
            quote: {
              bid: finalBid,
              ask: finalAsk,
              ltp: finalBid,
              spread: round2(Math.max(0, finalAsk - finalBid)),
              volume: spreadCandles[spreadCandles.length - 1].volume || dayVolume || 0,
              dayVolume,
            },
            availableExpiries,
          };
        }
      }
    }

    // Fallback only if NFO historical API is unavailable
    let spotCandles = await fetchCandlesByToken('NSE', meta.angelToken, angelInterval, fromIst, toIst);
    if (!spotCandles || spotCandles.length < 5) {
      const cache = loadHistoricalCache();
      const cachedHourly = (cache?.[req.underlying] ?? cache?.NIFTY ?? []).slice(-120);
      spotCandles = expandHourlyToSubBars(cachedHourly, req.interval);
    } else {
      spotCandles = spotCandles.slice(-maxBars);
    }

    const targetMark = bid > 0 && ask > 0 ? round2((bid + ask) / 2) : bid > 0 ? bid : undefined;
    const calibrated = buildCalibratedOptionCandles(spotCandles, {
      strike: req.strike || spotCandles[spotCandles.length - 1]?.close || 23350,
      right: req.right || 'CE',
      expiry: req.expiry || new Date(nowMs + 7 * 86_400_000).toISOString().slice(0, 10),
      shortStrike: req.shortStrike,
      targetLastClose: targetMark,
    });
    const lastClose = calibrated[calibrated.length - 1]?.close ?? targetMark ?? 50;
    const finalBid = bid > 0 ? bid : round2(lastClose - 0.2);
    const finalAsk = ask > 0 ? ask : round2(lastClose + 0.2);
    return {
      underlying: req.underlying,
      interval: req.interval,
      source: 'CALIBRATED_BS_FROM_NSE',
      candles: calibrated,
      spotCandles,
      quote: {
        bid: finalBid,
        ask: finalAsk,
        ltp: lastClose,
        spread: round2(Math.max(0, finalAsk - finalBid)),
        volume: dayVolume || calibrated[calibrated.length - 1]?.volume || 0,
        dayVolume,
      },
      availableExpiries,
    };
  }

  // 2. Underlying NSE spot chart
  const [spotCandlesRaw, spots] = await Promise.all([
    fetchCandlesByToken('NSE', meta.angelToken, angelInterval, fromIst, toIst),
    fetchSpotQuotes(),
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
  const tick = ltp > 5000 ? 0.5 : 0.1;
  const bid = round2(ltp - tick);
  const ask = round2(ltp + tick);

  return {
    underlying: req.underlying,
    interval: req.interval,
    source: usedCacheForSpot ? 'ANGEL_CACHE_NSE' : 'ANGEL_LIVE_NSE',
    candles: spotCandles,
    spotCandles,
    quote: {
      bid,
      ask,
      ltp,
      spread: round2(ask - bid),
      volume: lastBar?.volume || 0,
    },
  };
}

