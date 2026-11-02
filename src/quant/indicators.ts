/**
 * Standard technical indicators computed bar by bar (Wilder smoothing for RSI, ATR and ADX).
 * Values are NaN until enough history exists; nothing is clamped or defaulted.
 */

import type { Candle, IndicatorSnapshot } from './types.js';

export interface IndicatorRow extends IndicatorSnapshot {
  atr14: number;
  sma20: number;
  upperBand: number;
  lowerBand: number;
  donchianHigh20: number; // highest high of the 20 bars before this one
  donchianLow20: number;
}

export const INDICATOR_WARMUP_BARS = 60;

function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
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

function wilderRsi(closes: number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
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
  const rsiOf = (g: number, l: number) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[period] = rsiOf(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = rsiOf(avgGain, avgLoss);
  }
  return out;
}

function wilderAtrAndAdx(candles: Candle[], period: number) {
  const n = candles.length;
  const atr = new Array<number>(n).fill(NaN);
  const adx = new Array<number>(n).fill(NaN);
  const plusDi = new Array<number>(n).fill(NaN);
  const minusDi = new Array<number>(n).fill(NaN);
  if (n <= period * 2) return { atr, adx, plusDi, minusDi };

  const tr = new Array<number>(n).fill(0);
  const plusDm = new Array<number>(n).fill(0);
  const minusDm = new Array<number>(n).fill(0);
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
  const dx = new Array<number>(n).fill(NaN);
  const setDi = (i: number) => {
    const p = trS > 0 ? (100 * pS) / trS : 0;
    const m = trS > 0 ? (100 * mS) / trS : 0;
    plusDi[i] = p;
    minusDi[i] = m;
    dx[i] = p + m > 0 ? (100 * Math.abs(p - m)) / (p + m) : 0;
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

export function computeIndicators(candles: Candle[]): IndicatorRow[] {
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
      ret35: i >= 35 ? c.close / closes[i - 35] - 1 : NaN,
    };
  });
}

export function snapshotOf(row: IndicatorRow): IndicatorSnapshot {
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
    ret35: row.ret35,
  };
}

export function isRowComplete(row: IndicatorRow): boolean {
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
    row.ret35,
  ].every(Number.isFinite);
}

/** Percentile rank (0..1) of `value` within `history`; null when history is too short to be meaningful. */
export function percentileRank(value: number, history: number[]): number | null {
  const clean = history.filter(Number.isFinite);
  if (clean.length < 20) return null;
  let below = 0;
  let equal = 0;
  for (const h of clean) {
    if (h < value) below++;
    else if (h === value) equal++;
  }
  return (below + 0.5 * equal) / clean.length;
}

/** Annualised volatility from hourly closes (about 7 bars per NSE session). */
export function realizedVolAnnual(closes: number[], lookbackBars = 70): number | null {
  if (closes.length < lookbackBars + 1) return null;
  const rets: number[] = [];
  for (let i = closes.length - lookbackBars; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 10) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252 * 7);
}
