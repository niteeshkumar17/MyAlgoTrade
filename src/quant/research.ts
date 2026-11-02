/**
 * Offline research on one year of real Angel One hourly bars (NSE index/stock prices and India VIX).
 *
 * Historical option order books are not available, so option prices in this module are MODEL prices:
 * Black-Scholes with India VIX (or realised volatility for stocks) as the volatility input and an
 * assumed bid-ask spread. The results are a rough prior for the model, not evidence of a live edge.
 * Only the live paper ledger, which trades on real order-book quotes, counts towards go/no-go.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { calendarDaysBetween, hourlyBarEndMs, istDate, istMonthKey, istParts, istToMs } from './clock.js';
import { computeIndicators, INDICATOR_WARMUP_BARS, percentileRank, realizedVolAnnual } from './indicators.js';
import { calibrationBuckets, type FoldResult, offlineWalkForward, type OosPrediction, type Sample, summarizeOos } from './model.js';
import { bsPrice, buildSpreadPlan, type ChainLeg, evaluateSpreadExit, exitChargesFor } from './options.js';
import { DEFAULT_ENGINE_CONFIG, evaluateEntryRisk, RISK_REJECT_LABELS } from './risk.js';
import { buildFeatures, detectSignal } from './signals.js';
import { type GroupStat, groupStats, maxDrawdownPct, mean, meanCi90, profitFactor } from './stats.js';
import {
  type CalibrationBucket,
  type Candle,
  type EngineConfig,
  type ExitReason,
  INDEX_UNDERLYINGS,
  type LegQuote,
  type MarketRegime,
  type OosMetrics,
  type OptionRight,
  type SpreadPlan,
  type StrategyName,
  UNDERLYINGS,
} from './types.js';

export type HistoricalCache = Record<string, Candle[]>;

/** NSE F&O lot sizes for contracts expiring Nov-Dec 2026 (from the Angel One instrument master). */
export const RESEARCH_LOT_SIZES: Record<string, number> = {
  NIFTY: 65,
  BANKNIFTY: 30,
  FINNIFTY: 60,
  RELIANCE: 500,
  TCS: 225,
  HDFCBANK: 650,
  INFY: 400,
  ICICIBANK: 700,
  SBIN: 750,
};

const CACHE_FILE = 'angelOne1YearCache.json';
const YEAR_MS = 365 * 86_400_000;
const RISK_FREE = 0.06;
const MODEL_SPREAD_PCT: Record<string, number> = { NIFTY: 0.0025, BANKNIFTY: 0.003, FINNIFTY: 0.004 };
const STOCK_SPREAD_PCT = 0.006;

let cacheMemo: HistoricalCache | null | undefined;

export function loadHistoricalCache(): HistoricalCache | null {
  if (cacheMemo !== undefined) return cacheMemo;
  let here = process.cwd();
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // bundled without import.meta.url; fall back to cwd-relative paths
  }
  const candidates = [
    path.join(process.cwd(), 'src', 'quant', CACHE_FILE),
    path.join(here, CACHE_FILE),
    path.join(here, '..', 'src', 'quant', CACHE_FILE),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const out: HistoricalCache = {};
      for (const [symbol, bars] of Object.entries(raw)) {
        if (!Array.isArray(bars)) continue;
        out[symbol] = bars
          .map((b: any) => ({
            time: String(b.timestamp ?? b.time),
            open: Number(b.open),
            high: Number(b.high),
            low: Number(b.low),
            close: Number(b.close),
            volume: Number(b.volume ?? 0),
          }))
          .filter((c) => Number.isFinite(Date.parse(c.time)) && c.close > 0 && c.high >= c.low)
          .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      }
      cacheMemo = out;
      return out;
    } catch {
      // try the next location
    }
  }
  cacheMemo = null;
  return null;
}

export interface VixSeries {
  /** VIX close of the latest hourly bar starting at or before `ms`. */
  at(ms: number): number | null;
  /** Percentile of `value` against up to 250 daily closes before `dateStr`. */
  percentile(dateStr: string, value: number): number | null;
  dailyCloses: Array<{ date: string; close: number }>;
}

export function buildVixSeries(vixCandles: Candle[], extraDaily: Array<{ date: string; close: number }> = []): VixSeries {
  const times = vixCandles.map((c) => Date.parse(c.time));
  const closes = vixCandles.map((c) => c.close);
  const daily = new Map<string, number>();
  for (const c of vixCandles) daily.set(istDate(Date.parse(c.time)), c.close);
  for (const d of extraDaily) daily.set(d.date, d.close);
  const dailyCloses = [...daily.entries()]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    dailyCloses,
    at(ms: number) {
      let lo = 0;
      let hi = times.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= ms) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (found < 0 || ms - times[found] > 4 * 86_400_000) return null;
      return closes[found];
    },
    percentile(dateStr: string, value: number) {
      let end = dailyCloses.length;
      while (end > 0 && dailyCloses[end - 1].date >= dateStr) end--;
      const hist = dailyCloses.slice(Math.max(0, end - 250), end).map((d) => d.close);
      return percentileRank(value, hist);
    },
  };
}

function addDays(dateStr: string, n: number): string {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

function lastTuesdayOfMonth(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const back = (last.getUTCDay() - 2 + 7) % 7;
  return new Date(last.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

/** NSE expiry calendar since Sep 2025: NIFTY weekly on Tuesday, other contracts monthly on the last Tuesday. Holiday shifts ignored. */
export function modelExpiries(underlying: string, dateStr: string): string[] {
  if (underlying === 'NIFTY') {
    const out: string[] = [];
    let d = dateStr;
    while (weekdayOf(d) !== 2) d = addDays(d, 1);
    for (let k = 0; k < 6; k++) out.push(addDays(d, 7 * k));
    return out;
  }
  const [y, m] = dateStr.split('-').map(Number);
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const mm = ((m - 1 + k) % 12) + 1;
    const yy = y + Math.floor((m - 1 + k) / 12);
    const e = lastTuesdayOfMonth(yy, mm);
    if (e >= dateStr) out.push(e);
  }
  return out;
}

function modelStrikeStep(underlying: string, spot: number): number {
  if (underlying === 'NIFTY' || underlying === 'FINNIFTY') return 50;
  if (underlying === 'BANKNIFTY') return 100;
  if (spot < 250) return 2.5;
  if (spot < 500) return 5;
  if (spot < 1000) return 10;
  if (spot < 2500) return 20;
  return 50;
}

function modelVol(underlying: string, vixPct: number, realized: number | null): number {
  const v = vixPct / 100;
  if (underlying === 'NIFTY') return v;
  if (underlying === 'BANKNIFTY') return v * 1.2;
  if (underlying === 'FINNIFTY') return v * 1.1;
  return Math.max((realized ?? v * 1.2) * 1.15, v * 1.2);
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const roundTick = (x: number) => round2(Math.round(x / 0.05) * 0.05);

function modelQuote(token: string, mid: number, spreadPct: number, atMs: number): LegQuote {
  const half = Math.max(0.05, (mid * spreadPct) / 2);
  return {
    token,
    ltp: roundTick(mid),
    bid: mid - half >= 0.05 ? roundTick(mid - half) : 0,
    ask: roundTick(mid + half),
    hasDepth: true,
    feedTimeMs: atMs,
    volume: 0,
    oi: 0,
  };
}

export interface ResearchTrade {
  id: string;
  underlying: string;
  strategy: StrategyName;
  direction: OptionRight;
  regime: MarketRegime;
  entryAt: string;
  exitAt: string;
  entryMs: number;
  exitMs: number;
  expiry: string;
  dte: number;
  spot: number;
  longStrike: number;
  shortStrike: number;
  lotSize: number;
  entryDebit: number;
  exitValue: number;
  pnlPerLotInr: number;
  maxLossPerLotInr: number;
  rMultiple: number;
  sessionsHeld: number;
  exitReason: ExitReason;
  vixPctile: number | null;
  features: number[];
  reason: string;
}

interface InternalTrade extends ResearchTrade {
  plan: SpreadPlan;
  exitLongBid: number;
  exitShortAsk: number;
  isIndex: boolean;
}

export interface PortfolioSim {
  startingCapitalInr: number;
  endingEquityInr: number;
  returnPct: number;
  maxDrawdownPct: number;
  taken: number;
  skipped: number;
  skipReasons: Array<{ reason: string; n: number }>;
  killSwitchWouldTriggerAt: string | null;
  curve: Array<{ t: string; equity: number }>;
}

export interface ResearchReport {
  kind: 'MODEL_PRICED_BACKTEST';
  generatedAt: string;
  disclaimer: string;
  dataFrom: string | null;
  dataTo: string | null;
  bars: Record<string, number>;
  assumptions: string[];
  counts: { signals: number; overlapping: number; rejected: number; incomplete: number; trades: number };
  rejectionReasons: Array<{ reason: string; n: number }>;
  summary: {
    n: number;
    winRate: number | null;
    avgR: number | null;
    rCi90: [number, number] | null;
    totalR: number;
    expectancyPerLotInr: number | null;
    profitFactor: number | null;
    avgSessionsHeld: number | null;
  };
  /** Same entry bars traded in the opposite direction; similar results mean the signals add no directional edge. */
  oppositeDirectionBaseline: ResearchReport['summary'];
  byStrategy: GroupStat[];
  byUnderlying: GroupStat[];
  byRegime: GroupStat[];
  byDirection: GroupStat[];
  byExitReason: GroupStat[];
  byMonth: GroupStat[];
  walkForward: { folds: FoldResult[]; oos: OosMetrics; calibration: CalibrationBucket[] };
  gatedSummary?: ResearchReport['summary'];
  portfolio: PortfolioSim;
  rawPortfolio?: PortfolioSim;
  buyAndHold: Array<{ symbol: string; from: string; to: string; returnPct: number }>;
  recentTrades: ResearchTrade[];
}

export interface OfflineResearch {
  report: ResearchReport;
  samples: Sample[];
  offlineOos: OosPrediction[];
  vix: VixSeries;
}

function simplifyReason(reason: string): string {
  return reason
    .replace(/^(long|short) leg [^:]+:/, '$1 leg:')
    .replace(/^short [^:]+:/, 'short leg:')
    .replace(/₹[\d,.]+/g, '₹x')
    .replace(/\d+(\.\d+)?%/g, 'x%')
    .replace(/\d+\.\d+/g, 'x');
}

function simulatePortfolio(trades: InternalTrade[], cfg: EngineConfig): PortfolioSim {
  const ordered = [...trades].sort((a, b) => a.entryMs - b.entryMs);
  type Open = { t: InternalTrade; lots: number; cashOut: number; maxLossInr: number; marginBlockedInr: number; underlying: string };
  let open: Open[] = [];
  let cash = cfg.startingCapitalInr;
  let realizedEquity = cfg.startingCapitalInr;
  let peak = realizedEquity;
  let killAt: string | null = null;
  let taken = 0;
  const skips = new Map<string, number>();
  const curve: Array<{ t: string; equity: number }> = [{ t: new Date(ordered[0]?.entryMs ?? Date.now()).toISOString(), equity: realizedEquity }];

  const closeUntil = (ms: number) => {
    const due = open.filter((o) => o.t.exitMs <= ms).sort((a, b) => a.t.exitMs - b.t.exitMs);
    for (const o of due) {
      const units = o.lots * o.t.lotSize;
      const cashIn = o.t.exitValue * units - exitChargesFor(o.t.exitLongBid, o.t.exitShortAsk, units);
      cash += cashIn;
      realizedEquity += cashIn - o.cashOut;
      peak = Math.max(peak, realizedEquity);
      if (!killAt && (peak - realizedEquity) / peak >= cfg.drawdownKillPct) killAt = o.t.exitAt;
      curve.push({ t: o.t.exitAt, equity: round2(realizedEquity) });
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
      plan: t.plan,
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
      underlying: t.underlying,
    });
  }
  closeUntil(Infinity);
  const equities = curve.map((p) => p.equity);
  return {
    startingCapitalInr: cfg.startingCapitalInr,
    endingEquityInr: round2(realizedEquity),
    returnPct: (realizedEquity / cfg.startingCapitalInr - 1) * 100,
    maxDrawdownPct: maxDrawdownPct(equities) * 100,
    taken,
    skipped: ordered.length - taken,
    skipReasons: [...skips.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
    killSwitchWouldTriggerAt: killAt,
    curve,
  };
}

/**
 * Replays the signal rules over the cache and simulates each spread to its exit on model prices.
 * With `flipDirection` every signal is traded the other way round, which gives a baseline: if the
 * signals carried directional information the flipped trades would do clearly worse.
 */
function simulateTrades(
  cache: HistoricalCache,
  cfg: EngineConfig,
  lotSizes: Record<string, number>,
  vix: VixSeries,
  flipDirection: boolean
) {
  const budgetPerTrade = cfg.startingCapitalInr * cfg.riskPerTradePct;
  const trades: InternalTrade[] = [];
  const rejections = new Map<string, number>();
  const counts = { signals: 0, overlapping: 0, rejected: 0, incomplete: 0, trades: 0 };
  const reject = (reason: string) => {
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
    const busyUntil: Record<OptionRight, number> = { CE: -1, PE: -1 };
    const volAt = (i: number): number | null => {
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
      const sig = flipDirection
        ? { ...detected, direction: (detected.direction === 'CE' ? 'PE' : 'CE') as OptionRight }
        : detected;
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
        reject('no expiry inside the DTE window');
        continue;
      }
      const vol = volAt(i);
      if (vol === null) {
        reject('no volatility input');
        continue;
      }
      const dte = calendarDaysBetween(dateStr, expiry);
      const expiryMs = istToMs(expiry, 15, 30);
      const spot = closes[i];
      const step = modelStrikeStep(u, spot);
      const atm = Math.round(spot / step) * step;
      const chain: ChainLeg[] = [];
      const quotes: Record<string, LegQuote> = {};
      for (let k = -(cfg.maxShortSteps + 1); k <= cfg.maxShortSteps + 1; k++) {
        const strike = round2(atm + k * step);
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
        cfg,
      });
      if (!built.ok) {
        reject(built.reason);
        continue;
      }
      const plan = built.plan;

      let exitIdx = -1;
      let exitValue = 0;
      let exitReason: ExitReason | null = null;
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
        const dteJ = calendarDaysBetween(dj, expiry);
        const favSpot = plan.right === 'CE' ? candles[j].high : candles[j].low;
        const priceAt = (s: number) => {
          const lq = modelQuote(plan.long.token, bsPrice(s, plan.long.strike, tYears, volJ, RISK_FREE, plan.right), spreadPct, tj);
          const sq = modelQuote(plan.short.token, bsPrice(s, plan.short.strike, tYears, volJ, RISK_FREE, plan.right), spreadPct, tj);
          return { liq: Math.max(0, round2(lq.bid - sq.ask)), lq, sq };
        };
        const fav = priceAt(favSpot);
        const cls = priceAt(closes[j]);
        const rFav = evaluateSpreadExit({ plan, liquidationValue: fav.liq, sessionsHeld: sessions, dte: dteJ, cfg });
        const rCls = evaluateSpreadExit({ plan, liquidationValue: cls.liq, sessionsHeld: sessions, dte: dteJ, cfg });
        if (rFav === 'TAKE_PROFIT') {
          exitIdx = j;
          exitValue = fav.liq;
          exitReason = 'TAKE_PROFIT';
          exitLongBid = fav.lq.bid;
          exitShortAsk = fav.sq.ask;
          break;
        }
        if (rCls) {
          exitIdx = j;
          exitValue = cls.liq;
          exitReason = rCls;
          exitLongBid = cls.lq.bid;
          exitShortAsk = cls.sq.ask;
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
      const pnl = round2(exitCash - entryCash);
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
          legSpreadPct: plan.legSpreadPct,
        }),
        reason: sig.reason,
        plan,
        exitLongBid,
        exitShortAsk,
        isIndex,
      });
    }
  }
  counts.trades = trades.length;
  return { trades, counts, rejections };
}

function summarize(trades: ResearchTrade[]): ResearchReport['summary'] {
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
    avgSessionsHeld: mean(trades.map((t) => t.sessionsHeld)),
  };
}

export function runOfflineResearch(
  cache: HistoricalCache,
  opts: { cfg?: EngineConfig; lotSizes?: Record<string, number>; nowMs?: number } = {}
): OfflineResearch {
  const cfg = opts.cfg ?? DEFAULT_ENGINE_CONFIG;
  const lotSizes = opts.lotSizes ?? RESEARCH_LOT_SIZES;
  const vix = buildVixSeries(cache.INDIA_VIX ?? []);
  const { trades, counts, rejections } = simulateTrades(cache, cfg, lotSizes, vix, false);
  const flipped = simulateTrades(cache, cfg, lotSizes, vix, true);

  const samples: Sample[] = trades.map((t) => ({
    id: t.id,
    x: t.features,
    y: t.pnlPerLotInr > 0 ? 1 : 0,
    r: t.rMultiple,
    entryMs: t.entryMs,
    exitMs: t.exitMs,
    weight: 1,
    source: 'OFFLINE',
  }));
  const wf = offlineWalkForward(samples);
  const oosSummary = summarizeOos(wf.oos);
  const oosMap = new Map<string, number>(wf.oos.map((o) => [o.id, o.p]));
  const gatedTrades =
    oosSummary.threshold !== null
      ? trades.filter((t) => {
          const p = oosMap.get(t.id);
          return p === undefined || p >= oosSummary.threshold!;
        })
      : trades;

  const pnlOf = (t: ResearchTrade) => t.pnlPerLotInr;
  const rOf = (t: ResearchTrade) => t.rMultiple;
  const allTimes = UNDERLYINGS.flatMap((u) => (cache[u] ?? []).map((c) => Date.parse(c.time)));
  const bars: Record<string, number> = {};
  for (const [k, v] of Object.entries(cache)) bars[k] = v.length;

  const buyAndHold = Object.entries(cache)
    .filter(([sym, v]) => sym !== 'INDIA_VIX' && v.length > 1)
    .map(([symbol, v]) => ({
      symbol,
      from: v[0].time,
      to: v[v.length - 1].time,
      returnPct: (v[v.length - 1].close / v[0].close - 1) * 100,
    }));

  const publicTrade = ({ plan, exitLongBid, exitShortAsk, isIndex, ...rest }: InternalTrade): ResearchTrade => rest;
  const sortedByEntry = [...trades].sort((a, b) => a.entryMs - b.entryMs);

  const report: ResearchReport = {
    kind: 'MODEL_PRICED_BACKTEST',
    generatedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
    disclaimer:
      'Underlying prices are real Angel One hourly bars, but option prices are Black-Scholes estimates with an assumed bid-ask spread. ' +
      'Real option quotes, skew, liquidity gaps and slippage are not captured. Treat this as a prior for the model, not as proof of profitability.',
    dataFrom: allTimes.length ? new Date(Math.min(...allTimes)).toISOString() : null,
    dataTo: allTimes.length ? new Date(Math.max(...allTimes)).toISOString() : null,
    bars,
    assumptions: [
      'Signals on completed hourly bars, entry at the bar close between 09:30 and 15:00 IST.',
      'Vertical debit spreads: long ATM, short 1-4 strikes out of the money, expiry 7-35 days out.',
      `Option prices: Black-Scholes, r = ${RISK_FREE * 100}%; volatility = India VIX for NIFTY, ×1.2 BANKNIFTY, ×1.1 FINNIFTY, max(realised×1.15, VIX×1.2) for stocks.`,
      `Assumed bid-ask: ${MODEL_SPREAD_PCT.NIFTY * 100}% NIFTY, ${MODEL_SPREAD_PCT.BANKNIFTY * 100}% BANKNIFTY, ${MODEL_SPREAD_PCT.FINNIFTY * 100}% FINNIFTY, ${STOCK_SPREAD_PCT * 100}% stocks; entries buy at ask / sell at bid, exits the reverse.`,
      'Charges: ₹20/order brokerage, STT 0.15% on sell premium, exchange 0.035%, SEBI fee, stamp 0.003% on buys, 18% GST.',
      `Exits checked on hourly bars: take profit at ${cfg.takeProfitFracOfMaxGain * 100}% of max gain, stop at ${cfg.stopLossFracOfDebit * 100}% of debit, ${cfg.maxHoldSessions}-session time stop, exit at ${cfg.exitAtDte} days to expiry.`,
      'Expiries: NIFTY weekly on Tuesdays, others on the last Tuesday of the month (holiday shifts ignored).',
      `Lot sizes are today's (e.g. NIFTY ${lotSizes.NIFTY}); per-lot results use them for the whole year.`,
      'Trades still open at the end of the data are dropped.',
    ],
    counts,
    rejectionReasons: [...rejections.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n).slice(0, 8),
    summary: summarize(trades),
    gatedSummary: summarize(gatedTrades),
    oppositeDirectionBaseline: summarize(flipped.trades),
    byStrategy: groupStats(trades, (t) => t.strategy, pnlOf, rOf),
    byUnderlying: groupStats(trades, (t) => t.underlying, pnlOf, rOf),
    byRegime: groupStats(trades, (t) => t.regime, pnlOf, rOf),
    byDirection: groupStats(trades, (t) => (t.direction === 'CE' ? 'Bull call spread' : 'Bear put spread'), pnlOf, rOf),
    byExitReason: groupStats(trades, (t) => t.exitReason, pnlOf, rOf),
    byMonth: groupStats(trades, (t) => istMonthKey(t.entryMs), pnlOf, rOf).sort((a, b) => a.key.localeCompare(b.key)),
    walkForward: { folds: wf.folds, oos: oosSummary, calibration: calibrationBuckets(wf.oos) },
    portfolio: simulatePortfolio(gatedTrades, cfg),
    rawPortfolio: simulatePortfolio(trades, cfg),
    buyAndHold,
    recentTrades: sortedByEntry.slice(-60).reverse().map(publicTrade),
  };

  return { report, samples, offlineOos: wf.oos, vix };
}

let researchMemo: OfflineResearch | null | undefined;

/** Runs once per process; null when the historical cache file is not deployed. */
export function getOfflineResearch(): OfflineResearch | null {
  if (researchMemo !== undefined) return researchMemo;
  const cache = loadHistoricalCache();
  researchMemo = cache ? runOfflineResearch(cache) : null;
  return researchMemo;
}
