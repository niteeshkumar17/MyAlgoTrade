import {
  ANGEL_ONE_NSE_TOKENS,
  type AngelCandleInterval,
  fetchCandlesByToken,
  fetchOptionQuotes,
  fetchSpotQuotes,
} from './angelOneSmartApi.js';
import { formatIstForAngel, istToMs } from './clock.js';
import { bsPrice } from './options.js';
import { loadHistoricalCache } from './research.js';
import type { Candle, OptionRight } from './types.js';

export type TerminalInterval = '5m' | '15m' | '1h';

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
  };
}

function toAngelInterval(interval: TerminalInterval): AngelCandleInterval {
  if (interval === '5m') return 'FIVE_MINUTE';
  if (interval === '15m') return 'FIFTEEN_MINUTE';
  return 'ONE_HOUR';
}

function lookbackDays(interval: TerminalInterval): number {
  if (interval === '5m') return 6;
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
 * Subdivides hourly candles into deterministic 5m or 15m intraday bars when only hourly cache is available,
 * preserving each hourly bar's exact open, high, low, close, and total volume.
 */
export function expandHourlyToSubBars(hourly: Candle[], interval: TerminalInterval): Candle[] {
  if (interval === '1h' || hourly.length === 0) return hourly;
  const stepMin = interval === '5m' ? 5 : 15;
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

export async function loadTerminalCandles(req: TerminalCandleRequest): Promise<TerminalCandleResponse> {
  const nowMs = Date.now();
  const fromIst = formatIstForAngel(nowMs - lookbackDays(req.interval) * 86_400_000);
  const toIst = formatIstForAngel(nowMs + 60_000);
  const angelInterval = toAngelInterval(req.interval);
  const meta = ANGEL_ONE_NSE_TOKENS[req.underlying] ?? ANGEL_ONE_NSE_TOKENS.NIFTY;

  // 1. Fetch underlying spot candles (try live Angel One first, then 1Y cache)
  let spotCandles = await fetchCandlesByToken('NSE', meta.angelToken, angelInterval, fromIst, toIst);
  let usedCacheForSpot = false;
  if (!spotCandles || spotCandles.length < 10) {
    const cache = loadHistoricalCache();
    const cachedHourly = (cache?.[req.underlying] ?? cache?.NIFTY ?? []).slice(-120);
    spotCandles = expandHourlyToSubBars(cachedHourly, req.interval);
    usedCacheForSpot = true;
  } else {
    spotCandles = spotCandles.slice(-140);
  }

  // 2. If requesting an NFO option leg or spread
  if (req.exchange === 'NFO' && req.token) {
    const liveQuotes = await fetchOptionQuotes([req.token, ...(req.shortToken ? [req.shortToken] : [])]);
    const lq = liveQuotes?.[req.token];
    const sq = req.shortToken ? liveQuotes?.[req.shortToken] : undefined;

    let bid = lq?.bid || req.liveBid || 0;
    let ask = lq?.ask || req.liveAsk || 0;
    let volume = lq?.volume || 0;

    if (req.shortToken && (sq || req.shortBid || req.shortAsk)) {
      const sBid = sq?.bid || req.shortBid || 0;
      const sAsk = sq?.ask || req.shortAsk || 0;
      const liq = Math.max(0.05, round2(bid - sAsk));
      const entry = Math.max(liq + 0.05, round2(ask - sBid));
      bid = liq;
      ask = entry;
    }

    // Try direct NFO historical candles when viewing a single option leg
    if (!req.shortToken) {
      const nfoCandles = await fetchCandlesByToken('NFO', req.token, angelInterval, fromIst, toIst);
      if (nfoCandles && nfoCandles.length >= 10) {
        const sliced = nfoCandles.slice(-140);
        const lastClose = sliced[sliced.length - 1].close;
        const finalBid = bid > 0 ? bid : round2(lastClose - 0.15);
        const finalAsk = ask > 0 ? ask : round2(lastClose + 0.15);
        return {
          underlying: req.underlying,
          interval: req.interval,
          source: 'ANGEL_LIVE_NFO',
          candles: sliced,
          spotCandles,
          quote: {
            bid: finalBid,
            ask: finalAsk,
            ltp: lq?.ltp || lastClose,
            spread: round2(Math.max(0, finalAsk - finalBid)),
            volume: volume || sliced[sliced.length - 1].volume || 0,
          },
        };
      }
    }

    // Calibrated Black-Scholes option / spread candles from the real spot candles
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
        volume: volume || calibrated[calibrated.length - 1]?.volume || 0,
      },
    };
  }

  // 3. Underlying NSE spot chart
  const spots = await fetchSpotQuotes();
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
