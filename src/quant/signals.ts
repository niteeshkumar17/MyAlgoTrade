/**
 * Market regime, strategy triggers and the model's feature vector, evaluated on completed hourly bars.
 * The same functions drive the offline research and the live engine so the model sees identical inputs.
 */

import { hourlyBarEndMs, istParts } from './clock.js';
import { type IndicatorRow, isRowComplete, snapshotOf } from './indicators.js';
import type {
  Candle,
  IndicatorSnapshot,
  MarketRegime,
  OptionRight,
  StrategyName,
} from './types.js';

export interface SignalEvent {
  barIndex: number;
  barStartMs: number;
  barEndMs: number;
  strategy: StrategyName;
  direction: OptionRight;
  regime: MarketRegime;
  spot: number;
  indicators: IndicatorSnapshot;
  reason: string;
}

export function classifyRegime(row: IndicatorRow, vixPctile: number | null): MarketRegime {
  if (vixPctile !== null && vixPctile >= 0.8) return 'high_volatility';
  if (row.adx14 >= 22 && row.ema20 > row.ema50 && row.plusDi > row.minusDi) return 'trending_up';
  if (row.adx14 >= 22 && row.ema20 < row.ema50 && row.minusDi > row.plusDi) return 'trending_down';
  return 'range';
}

const f1 = (x: number) => x.toFixed(1);

/**
 * At most one trigger per bar, checked in priority order:
 * 1. breakout_momentum: close beyond the prior 20-bar high/low while ADX is rising.
 * 2. trend_following: in a trending regime, the bar tags EMA20 and closes back on the trend side.
 * 3. mean_reversion: in a range regime, price closes back inside a Bollinger band it had closed outside.
 */
export function detectSignal(
  candles: Candle[],
  rows: IndicatorRow[],
  i: number,
  vixPctile: number | null
): SignalEvent | null {
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
    indicators: snapshotOf(row),
  };

  const adxRising = row.adx14 > rows[i - 3].adx14;
  if (adxRising && row.adx14 >= 18) {
    if (c.close > row.donchianHigh20) {
      return {
        ...base,
        strategy: 'breakout_momentum',
        direction: 'CE',
        reason: `Close ${f1(c.close)} above 20-bar high ${f1(row.donchianHigh20)}, ADX ${f1(row.adx14)} rising`,
      };
    }
    if (c.close < row.donchianLow20) {
      return {
        ...base,
        strategy: 'breakout_momentum',
        direction: 'PE',
        reason: `Close ${f1(c.close)} below 20-bar low ${f1(row.donchianLow20)}, ADX ${f1(row.adx14)} rising`,
      };
    }
  }

  if (regime === 'trending_up' && c.low <= row.ema20 && c.close > row.ema20 && row.rsi14 >= 45 && row.rsi14 <= 70) {
    return {
      ...base,
      strategy: 'trend_following',
      direction: 'CE',
      reason: `Uptrend (ADX ${f1(row.adx14)}, EMA20>EMA50) pullback to EMA20 held, RSI ${f1(row.rsi14)}`,
    };
  }
  if (regime === 'trending_down' && c.high >= row.ema20 && c.close < row.ema20 && row.rsi14 >= 30 && row.rsi14 <= 55) {
    return {
      ...base,
      strategy: 'trend_following',
      direction: 'PE',
      reason: `Downtrend (ADX ${f1(row.adx14)}, EMA20<EMA50) rally to EMA20 rejected, RSI ${f1(row.rsi14)}`,
    };
  }

  if (regime === 'range' && row.adx14 < 20) {
    if (pc.close < prev.lowerBand && c.close > row.lowerBand && prev.rsi14 <= 35) {
      return {
        ...base,
        strategy: 'mean_reversion',
        direction: 'CE',
        reason: `Range (ADX ${f1(row.adx14)}): closed back above lower Bollinger band after RSI ${f1(prev.rsi14)}`,
      };
    }
    if (pc.close > prev.upperBand && c.close < row.upperBand && prev.rsi14 >= 65) {
      return {
        ...base,
        strategy: 'mean_reversion',
        direction: 'PE',
        reason: `Range (ADX ${f1(row.adx14)}): closed back below upper Bollinger band after RSI ${f1(prev.rsi14)}`,
      };
    }
  }
  return null;
}

export const FEATURE_NAMES = [
  'strategy_trend',
  'strategy_breakout',
  'direction_call',
  'trend_alignment',
  'rsi_directional',
  'adx_level',
  'atr_pct',
  'bollinger_directional',
  'return_1d_directional',
  'return_1w_directional',
  'vix_percentile',
  'is_index',
  'days_to_expiry',
  'debit_to_width',
  'leg_bid_ask_pct',
  'session_morning',
  'session_afternoon',
] as const;

export const FEATURE_DESCRIPTIONS: Record<(typeof FEATURE_NAMES)[number], string> = {
  strategy_trend: 'Signal came from trend_following (vs mean_reversion)',
  strategy_breakout: 'Signal came from breakout_momentum (vs mean_reversion)',
  direction_call: 'Bullish call spread (vs bearish put spread)',
  trend_alignment: 'EMA20−EMA50 gap in ATRs, signed by trade direction',
  rsi_directional: 'RSI(14) distance from 50, signed by trade direction',
  adx_level: 'ADX(14) trend strength',
  atr_pct: 'Hourly ATR as % of price',
  bollinger_directional: 'Position inside Bollinger bands, signed by direction',
  return_1d_directional: 'Last 7-bar (≈1 day) return, signed by direction',
  return_1w_directional: 'Last 35-bar (≈1 week) return, signed by direction',
  vix_percentile: 'India VIX percentile vs the trailing year',
  is_index: 'Index option (vs stock option)',
  days_to_expiry: 'Calendar days to expiry / 30',
  debit_to_width: 'Spread debit as a fraction of strike width',
  leg_bid_ask_pct: 'Average bid-ask spread of both legs (%)',
  session_morning: 'Signal bar closed by 11:15 IST',
  session_afternoon: 'Signal bar closed at or after 13:15 IST',
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function buildFeatures(
  sig: Pick<SignalEvent, 'strategy' | 'direction' | 'indicators' | 'spot' | 'barEndMs'>,
  ctx: { vixPctile: number | null; isIndex: boolean; dte: number; debitRatio: number; legSpreadPct: number }
): number[] {
  const dir = sig.direction === 'CE' ? 1 : -1;
  const ind = sig.indicators;
  const atrAbs = ind.atrPct * sig.spot;
  const minute = istParts(sig.barEndMs).minuteOfDay;
  return [
    sig.strategy === 'trend_following' ? 1 : 0,
    sig.strategy === 'breakout_momentum' ? 1 : 0,
    dir > 0 ? 1 : 0,
    atrAbs > 0 ? clamp(((ind.ema20 - ind.ema50) / atrAbs) * dir, -6, 6) : 0,
    (dir * (ind.rsi14 - 50)) / 20,
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
    minute >= 13 * 60 + 15 ? 1 : 0,
  ];
}
