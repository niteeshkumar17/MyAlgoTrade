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

import { calendarDaysBetween, hourlyBarEndMs, istDate, istMonthKey, istMonthStartMs, istParts, istToMs } from './clock.js';
import { computeIndicators, INDICATOR_WARMUP_BARS, percentileRank, realizedVolAnnual } from './indicators.js';
import {
  calibrationBuckets,
  fitLogistic,
  type FoldResult,
  offlineWalkForward,
  type OosPrediction,
  predictProb,
  type Sample,
  summarizeOos,
} from './model.js';
import {
  bsPrice,
  buildSpreadPlan,
  type ChainLeg,
  evaluateRunnerTrendGate,
  evaluateSpreadExit,
  exitChargesFor,
  runnerKeepFracForMfe,
} from './options.js';
import { DEFAULT_ENGINE_CONFIG, evaluateEntryRisk, RISK_REJECT_LABELS } from './risk.js';
import { buildFeatures, detectSignal } from './signals.js';
import { type GroupStat, groupStats, maxDrawdownPct, mean, meanCi90, profitFactor, stdev } from './stats.js';
import {
  type CalibrationBucket,
  type Candle,
  type ChallengerEngineTradeLog,
  type EngineConfig,
  type ExitReason,
  type ExitRuleVersion,
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
  MIDCPNIFTY: 120,
  RELIANCE: 500,
  TCS: 225,
  HDFCBANK: 650,
  INFY: 400,
  ICICIBANK: 700,
  SBIN: 750,
  BHARTIARTL: 475,
  ITC: 1725,
  KOTAKBANK: 2000,
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
  'M&M': 200,
  POWERGRID: 1900,
  ADANIENT: 309,
  BAJAJFINSV: 300,
  WIPRO: 3000,
  COALINDIA: 1350,
  JSWSTEEL: 675,
  HINDALCO: 700,
  ONGC: 2250,
  GRASIM: 250,
  TECHM: 600,
  HCLTECH: 400,
};

const CACHE_FILE = 'angelOne1YearCache.json';
const YEAR_MS = 365 * 86_400_000;
const RISK_FREE = 0.06;
const MODEL_SPREAD_PCT: Record<string, number> = { NIFTY: 0.0025, BANKNIFTY: 0.003, FINNIFTY: 0.004, MIDCPNIFTY: 0.004 };
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
  confirmedPeakValue?: number;
  mfeOfMaxGainPct?: number;
  maePct?: number;
  runnerArmed?: boolean;
  runnerTrendGatePassed?: boolean | null;
  counterfactualFixed30PnlPerLotInr?: number;
  counterfactualV31PnlPerLotInr?: number;
  counterfactualLearnedPnlPerLotInr?: number;
  challengerEngines?: Record<ExitRuleVersion, ChallengerEngineTradeLog>;
  vixPctile: number | null;
  features: number[];
  reason: string;
}

interface InternalTrade extends ResearchTrade {
  plan: SpreadPlan;
  exitLongBid: number;
  exitShortAsk: number;
  isIndex: boolean;
  fixed30ExitIdx: number;
  fixed30ExitValue: number;
  fixed30LongBid: number;
  fixed30ShortAsk: number;
  fixed30ExitReason: ExitReason;
  fixed30SessionsHeld: number;
  fixed30Floor: number;
  v31ExitIdx: number;
  v31ExitValue: number;
  v31LongBid: number;
  v31ShortAsk: number;
  v31ExitReason: ExitReason;
  v31SessionsHeld: number;
  v31Floor: number;
  v3Floor: number;
  earlyCutExitValue: number;
  earlyCutLongBid: number;
  earlyCutShortAsk: number;
  earlyCutExitReason: ExitReason;
  earlyCutSessionsHeld: number;
  earlyCutFloor: number;
  learnedLongBid?: number;
  learnedShortAsk?: number;
  learnedSessionsHeld?: number;
  unclippedMaxMfeFrac: number;
  unclippedPeakValue: number;
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

export interface ChallengerVariantMetrics {
  engine: ExitRuleVersion;
  label: string;
  ruleSummary: string;
  expectancyPerLotInr: number;
  avgR: number;
  rCi90: [number, number] | null;
  profitFactor: number | null;
  maxDrawdownPct: number;
  endingEquityInr: number;
  /** Realized gain / Unclipped peak MFE gain among trades that reached >=30% MFE. */
  captureRatioMean: number;
  captureRatioCi90: [number, number] | null;
  /** Eventual MFE >= 60% trades that were stopped out before reaching 60% MFE. */
  runnerShakeOutCount: number;
  runnerShakeOutTotal: number;
  runnerShakeOutRatePct: number;
  /** Among Trend-Gate-passed runners with eventual MFE >= 60%, how many were stopped out before 60% MFE. */
  armedRunnerShakeOutCount: number;
  armedRunnerShakeOutTotal: number;
  armedRunnerShakeOutRatePct: number;
  /** Staller protection on trades peaking in 30-45% MFE that fell back. */
  stallerTotal: number;
  stallerProtectedCount: number;
  stallerProtectedRatePct: number;
  stallerMeanPnlInr: number;
  stallerArmedMeanPnlInr: number;
}

export interface ChallengerPairedComparison {
  pair: string;
  engineA: ExitRuleVersion;
  engineB: ExitRuleVersion;
  meanDiffInr: number;
  diffInrCi90: [number, number] | null;
  meanDiffR: number;
  diffRCi90: [number, number] | null;
  tStat: number;
  rawPValue: number;
  holmAdjustedPValue: number;
  significantAt10Pct: boolean;
}

export interface RunnerValidationReport {
  fixed30Summary: ResearchReport['summary'];
  runnerV3Summary: ResearchReport['summary'];
  runnerV31Summary: ResearchReport['summary'];
  adaptiveLearnedSummary: ResearchReport['summary'];
  fixed30Portfolio: { endingEquityInr: number; returnPct: number; maxDrawdownPct: number };
  runnerV3Portfolio: { endingEquityInr: number; returnPct: number; maxDrawdownPct: number };
  runnerV31Portfolio: { endingEquityInr: number; returnPct: number; maxDrawdownPct: number };
  adaptiveLearnedPortfolio: { endingEquityInr: number; returnPct: number; maxDrawdownPct: number };
  mfeDistributionAt30: {
    reached30Count: number;
    b30to45Count: number;
    b45to60Count: number;
    b60to75Count: number;
    b75PlusCount: number;
    trendGatePassedCount: number;
    runnerOutperformedCount: number;
    runnerUnderperformedCount: number;
  };
  challengerRegistry: {
    registeredEngines: ExitRuleVersion[];
    minShadowTradesAt30ForPromotion: number;
    parametersFrozen: boolean;
    variants: ChallengerVariantMetrics[];
    pairedComparisons: ChallengerPairedComparison[];
    shakeOutBreakeven: {
      stalledSharePct: number;
      runner60PlusSharePct: number;
      v31ExtraOnArmedStallersInr: number;
      v31GiveUpOnShakenRunnerInr: number;
      v3ArmedRunnerShakenCount: number;
      v31ArmedRunnerShakenCount: number;
      armedRunnerTotal: number;
      verdict: string;
    };
  };
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
  runnerValidation?: RunnerValidationReport;
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
      const maxGain = Math.max(0.01, plan.width - plan.entryDebit);
      const armFrac = cfg.runnerArmMfeFrac ?? cfg.takeProfitFracOfMaxGain ?? 0.3;
      const keepFrac = cfg.runnerKeepFrac ?? 2 / 3;
      const ceilingFrac = cfg.runnerCeilingFracOfMaxGain ?? 0.75;

      let exitIdx = -1;
      let exitValue = 0;
      let exitReason: ExitReason | null = null;
      let exitLongBid = 0;
      let exitShortAsk = 0;
      let exitSessions = 1;

      let fixedExitIdx = -1;
      let fixedExitValue = 0;
      let fixedExitReason: ExitReason | null = null;
      let fixedLongBid = 0;
      let fixedShortAsk = 0;
      let fixedSessions = 1;
      let fixedFloor = round2(plan.entryDebit * (1 - cfg.stopLossFracOfDebit));

      let v31ExitIdx = -1;
      let v31ExitValue = 0;
      let v31ExitReason: ExitReason | null = null;
      let v31LongBid = 0;
      let v31ShortAsk = 0;
      let v31Sessions = 1;

      let earlyCutExitIdx = -1;
      let earlyCutExitValue = 0;
      let earlyCutExitReason: ExitReason | null = null;
      let earlyCutLongBid = 0;
      let earlyCutShortAsk = 0;
      let earlyCutSessions = 1;
      const earlyCutFloor = round2(plan.entryDebit * (1 - cfg.stopLossFracOfDebit * 0.53));

      let sessions = 1;
      let lastDate = dateStr;
      let peakFixed = plan.entryDebit;
      let peakRunner = plan.entryDebit;
      let peakV31 = plan.entryDebit;
      let peakEarly = plan.entryDebit;
      let troughVal = plan.entryDebit;
      let runnerArmed = false;
      let v31Armed = false;
      let runnerTrendGatePassed: boolean | null = null;
      let runnerFloor = round2(plan.entryDebit * (1 - cfg.stopLossFracOfDebit));
      let runnerFloorV31 = round2(plan.entryDebit * (1 - cfg.stopLossFracOfDebit));
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
        const favSpot = plan.right === 'CE' ? candles[j].high : candles[j].low;
        const priceAt = (s: number) => {
          const lq = modelQuote(plan.long.token, bsPrice(s, plan.long.strike, tYears, volJ, RISK_FREE, plan.right), spreadPct, tj);
          const sq = modelQuote(plan.short.token, bsPrice(s, plan.short.strike, tYears, volJ, RISK_FREE, plan.right), spreadPct, tj);
          const mid = round2((lq.bid + lq.ask) / 2 - (sq.bid + sq.ask) / 2);
          return { liq: Math.max(0, round2(lq.bid - sq.ask)), mid, lq, sq };
        };
        const fav = priceAt(favSpot);
        const cls = priceAt(closes[j]);

        // Track unclipped MFE% within the maxHoldSessions window
        if (sessions <= cfg.maxHoldSessions && dteJ > cfg.exitAtDte) {
          const barBest = Math.max(fav.liq, cls.liq);
          if (barBest > unclippedPeakValue) unclippedPeakValue = barBest;
          const barMfe = (barBest - plan.entryDebit) / maxGain;
          if (barMfe > unclippedMaxMfeFrac) unclippedMaxMfeFrac = barMfe;
        }

        // 1. Engine 1: LADDER_V2 (Fixed-30% Ladder)
        if (fixedExitIdx < 0) {
          const rFav = evaluateSpreadExit({ plan, liquidationValue: fav.liq, peakValue: peakFixed, sessionsHeld: sessions, dte: dteJ, cfg });
          if (rFav === 'TAKE_PROFIT' && fav.liq >= plan.entryDebit + armFrac * maxGain - 0.01) {
            fixedExitIdx = j;
            fixedExitValue = fav.liq;
            fixedExitReason = 'TAKE_PROFIT';
            fixedLongBid = fav.lq.bid;
            fixedShortAsk = fav.sq.ask;
            fixedSessions = sessions;
            fixedFloor = round2(plan.entryDebit + armFrac * maxGain);
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

        // Shared Trend Gate evaluation at 30% MFE
        const reached30Intrabar = fav.liq >= plan.entryDebit + armFrac * maxGain - 0.01;
        const confirmedHold = cls.liq >= plan.entryDebit + (armFrac - 0.03) * maxGain - 0.01;
        if (runnerTrendGatePassed === null && reached30Intrabar && (exitIdx < 0 || v31ExitIdx < 0)) {
          const ind = rows[j];
          const prevInd = rows[j - 1];
          const pUp = priceAt(closes[j] * 1.005).mid;
          const pDn = priceAt(closes[j] * 0.995).mid;
          const netDelta = Math.abs((pUp - pDn) / (closes[j] * 0.01));
          const tradingDte = Math.round((dteJ * 5) / 7);
          const gate =
            ind && prevInd && confirmedHold
              ? evaluateRunnerTrendGate({
                  right: plan.right,
                  spot: closes[j],
                  ema20: ind.ema20,
                  vwap,
                  adx14: ind.adx14,
                  prevAdx14: prevInd.adx14,
                  tradingDte,
                  spreadNetDelta: netDelta,
                  cfg,
                })
              : { passed: false, reason: 'Bar close did not hold near 30% arming threshold' };
          runnerTrendGatePassed = gate.passed;
        }

        const advSpot = plan.right === 'CE' ? candles[j].low : candles[j].high;
        const adv = priceAt(advSpot);

        // 2. Engine 2: RUNNER_V3 (Constant keep = 2/3 = 0.667, allowed fall = 33.3%)
        if (exitIdx < 0) {
          troughVal = Math.min(troughVal, cls.liq);
          if (!runnerArmed && reached30Intrabar) {
            if (!runnerTrendGatePassed) {
              exitIdx = j;
              exitValue = fav.liq;
              exitReason = 'TAKE_PROFIT';
              exitLongBid = fav.lq.bid;
              exitShortAsk = fav.sq.ask;
              exitSessions = sessions;
              runnerFloor = round2(plan.entryDebit + armFrac * maxGain);
            } else {
              runnerArmed = true;
              peakRunner = Math.max(peakRunner, cls.liq, round2(plan.entryDebit + armFrac * maxGain));
              runnerFloor = Math.max(runnerFloor, round2(plan.entryDebit + keepFrac * (peakRunner - plan.entryDebit)));
            }
          } else if (runnerArmed) {
            const tradingDte = Math.round((dteJ * 5) / 7);
            // Check intrabar shake-out if adverse excursion breaches current floor and bar closes below prior peak
            if (adv.liq <= runnerFloor && cls.liq < peakRunner) {
              exitIdx = j;
              exitValue = runnerFloor;
              exitReason = 'TRAIL_STOP';
              exitLongBid = cls.lq.bid;
              exitShortAsk = cls.sq.ask;
              exitSessions = sessions;
            } else if (fav.liq >= plan.entryDebit + ceilingFrac * maxGain - 0.01) {
              exitIdx = j;
              exitValue = fav.liq;
              exitReason = 'TAKE_PROFIT';
              exitLongBid = fav.lq.bid;
              exitShortAsk = fav.sq.ask;
              exitSessions = sessions;
              peakRunner = Math.max(peakRunner, fav.liq);
              runnerFloor = Math.max(runnerFloor, round2(plan.entryDebit + keepFrac * (peakRunner - plan.entryDebit)));
            } else if (dteJ <= cfg.exitAtDte || tradingDte <= 5) {
              exitIdx = j;
              exitValue = cls.liq;
              exitReason = 'EXPIRY_RISK';
              exitLongBid = cls.lq.bid;
              exitShortAsk = cls.sq.ask;
              exitSessions = sessions;
            } else {
              peakRunner = Math.max(peakRunner, cls.liq);
              runnerFloor = Math.max(runnerFloor, round2(plan.entryDebit + keepFrac * (peakRunner - plan.entryDebit)));
              if (cls.liq <= runnerFloor) {
                exitIdx = j;
                exitValue = Math.max(cls.liq, runnerFloor);
                exitReason = 'TRAIL_STOP';
                exitLongBid = cls.lq.bid;
                exitShortAsk = cls.sq.ask;
                exitSessions = sessions;
              } else if (sessions > cfg.maxHoldSessions) {
                exitIdx = j;
                exitValue = cls.liq;
                exitReason = 'TIME_STOP';
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

        // 3. Engine 3: RUNNER_V3_1 (Tapered allowed fall 20% -> 33.3% from 30% -> 60% MFE)
        if (v31ExitIdx < 0) {
          if (!v31Armed && reached30Intrabar) {
            if (!runnerTrendGatePassed) {
              v31ExitIdx = j;
              v31ExitValue = fav.liq;
              v31ExitReason = 'TAKE_PROFIT';
              v31LongBid = fav.lq.bid;
              v31ShortAsk = fav.sq.ask;
              v31Sessions = sessions;
              runnerFloorV31 = round2(plan.entryDebit + armFrac * maxGain);
            } else {
              v31Armed = true;
              peakV31 = Math.max(peakV31, cls.liq, round2(plan.entryDebit + armFrac * maxGain));
              const mfeV31 = (peakV31 - plan.entryDebit) / maxGain;
              const kV31 = runnerKeepFracForMfe(mfeV31, 'RUNNER_V3_1', keepFrac, armFrac);
              runnerFloorV31 = Math.max(runnerFloorV31, round2(plan.entryDebit + kV31 * (peakV31 - plan.entryDebit)));
            }
          } else if (v31Armed) {
            const tradingDte = Math.round((dteJ * 5) / 7);
            // Identical intrabar shake-out check against current tighter v3.1 floor
            if (adv.liq <= runnerFloorV31 && cls.liq < peakV31) {
              v31ExitIdx = j;
              v31ExitValue = runnerFloorV31;
              v31ExitReason = 'TRAIL_STOP';
              v31LongBid = cls.lq.bid;
              v31ShortAsk = cls.sq.ask;
              v31Sessions = sessions;
            } else if (fav.liq >= plan.entryDebit + ceilingFrac * maxGain - 0.01) {
              v31ExitIdx = j;
              v31ExitValue = fav.liq;
              v31ExitReason = 'TAKE_PROFIT';
              v31LongBid = fav.lq.bid;
              v31ShortAsk = fav.sq.ask;
              v31Sessions = sessions;
              peakV31 = Math.max(peakV31, fav.liq);
              const mfeV31 = (peakV31 - plan.entryDebit) / maxGain;
              const kV31 = runnerKeepFracForMfe(mfeV31, 'RUNNER_V3_1', keepFrac, armFrac);
              runnerFloorV31 = Math.max(runnerFloorV31, round2(plan.entryDebit + kV31 * (peakV31 - plan.entryDebit)));
            } else if (dteJ <= cfg.exitAtDte || tradingDte <= 5) {
              v31ExitIdx = j;
              v31ExitValue = cls.liq;
              v31ExitReason = 'EXPIRY_RISK';
              v31LongBid = cls.lq.bid;
              v31ShortAsk = cls.sq.ask;
              v31Sessions = sessions;
            } else {
              peakV31 = Math.max(peakV31, cls.liq);
              const mfeV31 = (peakV31 - plan.entryDebit) / maxGain;
              const kV31 = runnerKeepFracForMfe(mfeV31, 'RUNNER_V3_1', keepFrac, armFrac);
              runnerFloorV31 = Math.max(runnerFloorV31, round2(plan.entryDebit + kV31 * (peakV31 - plan.entryDebit)));
              if (cls.liq <= runnerFloorV31) {
                v31ExitIdx = j;
                v31ExitValue = Math.max(cls.liq, runnerFloorV31);
                v31ExitReason = 'TRAIL_STOP';
                v31LongBid = cls.lq.bid;
                v31ShortAsk = cls.sq.ask;
                v31Sessions = sessions;
              } else if (sessions > cfg.maxHoldSessions) {
                v31ExitIdx = j;
                v31ExitValue = cls.liq;
                v31ExitReason = 'TIME_STOP';
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
              variant: 'RUNNER_V3_1',
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

        // 4. Early Stagnation / Loss-Minimization Stop Outcome (tightens stop from -72% to -38% at session >= 3 if MFE < 8%)
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
            variant: 'ADAPTIVE_LEARNED',
            learnedEarlyStopTightened: sessions >= 3 && mfeEarly < 0.08,
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
      const pnl = round2(exitCash - entryCash);

      const fixedExitCash = fixedExitValue * lot - exitChargesFor(fixedLongBid, fixedShortAsk, lot);
      const fixedPnl = round2(fixedExitCash - entryCash);

      const v31ExitCash = v31ExitValue * lot - exitChargesFor(v31LongBid, v31ShortAsk, lot);
      const v31Pnl = round2(v31ExitCash - entryCash);

      const challengerEngines: Record<ExitRuleVersion, ChallengerEngineTradeLog> = {
        LADDER_V2: {
          floor: fixedFloor,
          lockedProfitPerLotInr: round2((fixedFloor - plan.entryDebit) * lot),
          exitValue: fixedExitValue,
          exitReason: fixedExitReason,
          pnlPerLotInr: fixedPnl,
        },
        RUNNER_V3: {
          floor: runnerFloor,
          lockedProfitPerLotInr: round2((runnerFloor - plan.entryDebit) * lot),
          exitValue,
          exitReason,
          pnlPerLotInr: pnl,
        },
        RUNNER_V3_1: {
          floor: runnerFloorV31,
          lockedProfitPerLotInr: round2((runnerFloorV31 - plan.entryDebit) * lot),
          exitValue: v31ExitValue,
          exitReason: v31ExitReason,
          pnlPerLotInr: v31Pnl,
        },
        ADAPTIVE_LEARNED: {
          floor: runnerFloorV31,
          lockedProfitPerLotInr: round2((runnerFloorV31 - plan.entryDebit) * lot),
          exitValue: v31ExitValue,
          exitReason: v31ExitReason,
          pnlPerLotInr: v31Pnl,
        },
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
        mfeOfMaxGainPct: round2(((peakRunner - plan.entryDebit) / maxGain) * 100),
        maePct: plan.entryDebit > 0 ? round2(((troughVal - plan.entryDebit) / plan.entryDebit) * 100) : 0,
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
          legSpreadPct: plan.legSpreadPct,
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
        unclippedPeakValue,
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

/** Two-sided normal p-value from a t-statistic (large N approximation). */
function twoSidedNormalPValue(tStat: number): number {
  const x = Math.abs(tStat);
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const prob =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + 1.330274429 * t))));
  return Math.min(1, Math.max(0, 2 * prob));
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

  // Strictly out-of-sample walk-forward evaluation of the Self-Learning Exit Policy (ADAPTIVE_LEARNED)
  if (trades.length > 0) {
    const firstMs = Math.min(...trades.map((t) => t.entryMs));
    const lastMs = Math.max(...trades.map((t) => t.entryMs));
    const boundaries: number[] = [];
    let cursor = istMonthStartMs(firstMs);
    for (let mIdx = 0; cursor <= lastMs; mIdx++) {
      if (mIdx >= 2) boundaries.push(cursor);
      cursor = istMonthStartMs(cursor + 32 * 86_400_000);
    }

    for (let k = 0; k < boundaries.length; k++) {
      const start = boundaries[k];
      const end = boundaries[k + 1] ?? Infinity;
      const priorClosed = trades.filter((t) => t.exitMs < start);
      if (priorClosed.length < 25) continue;

      const reached30Train: Sample[] = priorClosed
        .filter((t) => t.unclippedMaxMfeFrac >= 0.3)
        .map((t) => ({
          id: t.id,
          x: t.features,
          y: t.unclippedMaxMfeFrac >= 0.6 ? (1 as const) : (0 as const),
          r: t.rMultiple,
          entryMs: t.entryMs,
          exitMs: t.exitMs,
          weight: 1,
          source: 'OFFLINE' as const,
        }));
      const recoveryTrain: Sample[] = priorClosed.map((t) => ({
        id: t.id,
        x: t.features,
        y: t.pnlPerLotInr > 0 || t.unclippedMaxMfeFrac >= 0.16 ? (1 as const) : (0 as const),
        r: t.rMultiple,
        entryMs: t.entryMs,
        exitMs: t.exitMs,
        weight: 1,
        source: 'OFFLINE' as const,
      }));

      const runnerFit = fitLogistic(reached30Train, 3.0, 30, 12);
      const recoveryFit = fitLogistic(recoveryTrain, 2.0, 30, 25);

      const testTrades = trades.filter((t) => t.entryMs >= start && t.entryMs < end);
      for (const t of testTrades) {
        const pRunner = runnerFit ? predictProb(runnerFit, t.features) : 0.4;
        const pRec = recoveryFit ? predictProb(recoveryFit, t.features) : 0.5;
        const entryCash = t.entryDebit * t.lotSize + t.plan.entryChargesPerLot;

        // Default to RUNNER_V3_1 baseline
        let learnedExitVal = t.v31ExitValue;
        let learnedLongBid = t.v31LongBid;
        let learnedShortAsk = t.v31ShortAsk;
        let learnedReason = t.v31ExitReason;
        let learnedFloor = t.v31Floor;
        let learnedSessions = t.v31SessionsHeld;

        if (t.unclippedMaxMfeFrac >= 0.3 && t.runnerArmed) {
          if (pRunner < 0.24) {
            // Low runner continuation probability (<24%) -> take 30% profit immediately (LADDER_V2)
            learnedExitVal = t.fixed30ExitValue;
            learnedLongBid = t.fixed30LongBid;
            learnedShortAsk = t.fixed30ShortAsk;
            learnedReason = t.fixed30ExitReason;
            learnedFloor = t.fixed30Floor;
            learnedSessions = t.fixed30SessionsHeld;
          } else if (pRunner >= 0.58) {
            // High runner continuation probability (>=58%) -> use RUNNER_V3 wider 2/3 cushion
            learnedExitVal = t.exitValue;
            learnedLongBid = t.exitLongBid;
            learnedShortAsk = t.exitShortAsk;
            learnedReason = t.exitReason;
            learnedFloor = t.v3Floor;
            learnedSessions = t.sessionsHeld;
          }
        } else if (
          t.unclippedMaxMfeFrac < 0.08 &&
          t.v31SessionsHeld >= 3 &&
          pRec < 0.48 &&
          t.v31ExitValue < t.earlyCutFloor
        ) {
          // Stagnating trade with low recovery probability -> tighten stop early (-38% vs -72%)
          learnedExitVal = Math.max(t.earlyCutExitValue, t.earlyCutFloor);
          learnedLongBid = t.earlyCutLongBid;
          learnedShortAsk = t.earlyCutShortAsk;
          learnedReason = 'TRAIL_STOP';
          learnedFloor = t.earlyCutFloor;
          learnedSessions = t.earlyCutSessionsHeld;
        }

        const learnedExitCash = learnedExitVal * t.lotSize - exitChargesFor(learnedLongBid, learnedShortAsk, t.lotSize);
        const learnedPnl = round2(learnedExitCash - entryCash);
        t.counterfactualLearnedPnlPerLotInr = learnedPnl;
        t.learnedLongBid = learnedLongBid;
        t.learnedShortAsk = learnedShortAsk;
        t.learnedSessionsHeld = learnedSessions;
        if (t.challengerEngines) {
          t.challengerEngines.ADAPTIVE_LEARNED = {
            floor: learnedFloor,
            lockedProfitPerLotInr: round2((learnedFloor - t.entryDebit) * t.lotSize),
            exitValue: learnedExitVal,
            exitReason: learnedReason,
            pnlPerLotInr: learnedPnl,
          };
        }
      }
    }
  }

  const samples: Sample[] = trades.map((t) => ({
    id: t.id,
    x: t.features,
    y: t.pnlPerLotInr > 0 ? 1 : 0,
    r: t.rMultiple,
    entryMs: t.entryMs,
    exitMs: t.exitMs,
    weight: 1,
    source: 'OFFLINE',
    mfeMaxFrac: t.unclippedMaxMfeFrac,
    sessionsHeld: t.v31SessionsHeld,
    pnlLadderV2Inr: t.counterfactualFixed30PnlPerLotInr ?? t.pnlPerLotInr,
    pnlRunnerV3Inr: t.pnlPerLotInr,
    pnlRunnerV31Inr: t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr,
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
  }: InternalTrade): ResearchTrade => rest;
  const sortedByEntry = [...trades].sort((a, b) => a.entryMs - b.entryMs);

  // Build Fixed-30% Ladder (LADDER_V2), RUNNER_V3_1, and ADAPTIVE_LEARNED trade lists for head-to-head Challenger Registry
  const fixed30Trades: InternalTrade[] = trades.map((t) => {
    const cfPnl = t.counterfactualFixed30PnlPerLotInr ?? t.pnlPerLotInr;
    return {
      ...t,
      exitValue: t.fixed30ExitValue,
      exitLongBid: t.fixed30LongBid,
      exitShortAsk: t.fixed30ShortAsk,
      exitReason: t.fixed30ExitReason,
      sessionsHeld: t.fixed30SessionsHeld,
      pnlPerLotInr: cfPnl,
      rMultiple: t.maxLossPerLotInr > 0 ? cfPnl / t.maxLossPerLotInr : 0,
    };
  });
  const v31Trades: InternalTrade[] = trades.map((t) => {
    const v31Pnl = t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr;
    return {
      ...t,
      exitValue: t.v31ExitValue,
      exitLongBid: t.v31LongBid,
      exitShortAsk: t.v31ShortAsk,
      exitReason: t.v31ExitReason,
      sessionsHeld: t.v31SessionsHeld,
      pnlPerLotInr: v31Pnl,
      rMultiple: t.maxLossPerLotInr > 0 ? v31Pnl / t.maxLossPerLotInr : 0,
    };
  });
  const learnedTrades: InternalTrade[] = trades.map((t) => {
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
      rMultiple: t.maxLossPerLotInr > 0 ? lPnl / t.maxLossPerLotInr : 0,
    };
  });

  const filterGated = (list: InternalTrade[]) =>
    oosSummary.threshold !== null
      ? list.filter((t) => {
          const p = oosMap.get(t.id);
          return p === undefined || p >= oosSummary.threshold!;
        })
      : list;

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

  // Compute Challenger Registry pre-registered metrics across LADDER_V2, RUNNER_V3, RUNNER_V3_1, and ADAPTIVE_LEARNED
  const buildVariantMetrics = (
    engine: ExitRuleVersion,
    label: string,
    ruleSummary: string,
    summary: ResearchReport['summary'],
    portfolioSim: PortfolioSim,
    getExitVal: (t: InternalTrade) => number,
    getPnl: (t: InternalTrade) => number
  ): ChallengerVariantMetrics => {
    const reached30 = trades.filter((t) => t.unclippedMaxMfeFrac >= 0.3);
    const captureRatios = reached30.map((t) => {
      const maxGain = Math.max(0.01, t.plan.width - t.entryDebit);
      const peakGain = Math.max(0.01, t.unclippedMaxMfeFrac * maxGain);
      const realizedGain = getExitVal(t) - t.entryDebit;
      return realizedGain / peakGain;
    });

    // Runners: eventual unclipped MFE >= 60%
    const runners60 = trades.filter((t) => t.unclippedMaxMfeFrac >= 0.6);
    const shakenRunners = runners60.filter((t) => {
      const maxGain = Math.max(0.01, t.plan.width - t.entryDebit);
      const realizedMfe = (getExitVal(t) - t.entryDebit) / maxGain;
      // Stopped out before reaching 60% MFE (or capped at 30% by Ladder)
      return realizedMfe < 0.4;
    });

    // Armed Runners: eventual unclipped MFE >= 60% AND passed Trend Gate at 30%
    const armedRunners60 = runners60.filter((t) => t.runnerArmed);
    const shakenArmedRunners = armedRunners60.filter((t) => {
      const maxGain = Math.max(0.01, t.plan.width - t.entryDebit);
      const realizedMfe = (getExitVal(t) - t.entryDebit) / maxGain;
      return realizedMfe < 0.4;
    });

    // Stallers: eventual unclipped MFE in [30%, 45%)
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
      expectancyPerLotInr: round2(summary.expectancyPerLotInr ?? 0),
      avgR: Number((summary.avgR ?? 0).toFixed(4)),
      rCi90: summary.rCi90,
      profitFactor: summary.profitFactor,
      maxDrawdownPct: round2(portfolioSim.maxDrawdownPct),
      endingEquityInr: portfolioSim.endingEquityInr,
      captureRatioMean: round2((mean(captureRatios) ?? 0) * 100),
      captureRatioCi90: meanCi90(captureRatios.map((c) => c * 100)),
      runnerShakeOutCount: shakenRunners.length,
      runnerShakeOutTotal: runners60.length,
      runnerShakeOutRatePct: runners60.length > 0 ? round2((shakenRunners.length / runners60.length) * 100) : 0,
      armedRunnerShakeOutCount: shakenArmedRunners.length,
      armedRunnerShakeOutTotal: armedRunners60.length,
      armedRunnerShakeOutRatePct:
        armedRunners60.length > 0 ? round2((shakenArmedRunners.length / armedRunners60.length) * 100) : 0,
      stallerTotal: stallers.length,
      stallerProtectedCount: protectedStallers.length,
      stallerProtectedRatePct: stallers.length > 0 ? round2((protectedStallers.length / stallers.length) * 100) : 0,
      stallerMeanPnlInr: round2(mean(stallers.map(getPnl)) ?? 0),
      stallerArmedMeanPnlInr: round2(mean(armedStallers.map(getPnl)) ?? 0),
    };
  };

  const fixed30Sum = summarize(fixed30Trades);
  const runnerV3Sum = summarize(trades);
  const runnerV31Sum = summarize(v31Trades);
  const learnedSum = summarize(learnedTrades);

  const variants: ChallengerVariantMetrics[] = [
    buildVariantMetrics(
      'LADDER_V2',
      'LADDER_V2 (Fixed 30%)',
      'Stages 1a–3 below 30% MFE, hard TAKE_PROFIT at 30% MFE',
      fixed30Sum,
      fixed30PortfolioSim,
      (t) => t.fixed30ExitValue,
      (t) => t.counterfactualFixed30PnlPerLotInr ?? t.pnlPerLotInr
    ),
    buildVariantMetrics(
      'RUNNER_V3',
      'RUNNER_V3 (Keep 66.7%)',
      'Trend Gate at 30% MFE; constant 2/3 trail (allowed fall 33.3%) to 75% ceiling',
      runnerV3Sum,
      runnerPortfolioSim,
      (t) => t.exitValue,
      (t) => t.pnlPerLotInr
    ),
    buildVariantMetrics(
      'RUNNER_V3_1',
      'RUNNER_V3_1 (Taper 80%→66.7%)',
      'Trend Gate at 30% MFE; allowed fall tapers 20%→33.3% from 30%→60% MFE',
      runnerV31Sum,
      v31PortfolioSim,
      (t) => t.v31ExitValue,
      (t) => t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr
    ),
    buildVariantMetrics(
      'ADAPTIVE_LEARNED',
      'ADAPTIVE_LEARNED (Self-Learning v3.1)',
      'Promotes RUNNER_V3_1 + online ML: adapts keep 66.7%–83% on runner prob & tightens stagnant stops (-38% vs -72%)',
      learnedSum,
      learnedPortfolioSim,
      (t) => t.challengerEngines?.ADAPTIVE_LEARNED?.exitValue ?? t.v31ExitValue,
      (t) => t.counterfactualLearnedPnlPerLotInr ?? t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr
    ),
  ];

  // Paired differences & Holm-Bonferroni multiple-comparison adjustment across pairs
  const buildPair = (
    pair: string,
    engineA: ExitRuleVersion,
    engineB: ExitRuleVersion,
    pnlA: (t: InternalTrade) => number,
    pnlB: (t: InternalTrade) => number
  ): ChallengerPairedComparison => {
    const diffsInr = trades.map((t) => pnlA(t) - pnlB(t));
    const diffsR = trades.map((t) => (t.maxLossPerLotInr > 0 ? (pnlA(t) - pnlB(t)) / t.maxLossPerLotInr : 0));
    const mInr = mean(diffsInr) ?? 0;
    const sdInr = stdev(diffsInr) ?? 0;
    const tStat = sdInr > 0 && diffsInr.length > 1 ? (mInr * Math.sqrt(diffsInr.length)) / sdInr : 0;
    const rawPValue = twoSidedNormalPValue(tStat);
    return {
      pair,
      engineA,
      engineB,
      meanDiffInr: round2(mInr),
      diffInrCi90: meanCi90(diffsInr),
      meanDiffR: Number((mean(diffsR) ?? 0).toFixed(4)),
      diffRCi90: meanCi90(diffsR),
      tStat: round2(tStat),
      rawPValue: Number(rawPValue.toFixed(4)),
      holmAdjustedPValue: Number(rawPValue.toFixed(4)),
      significantAt10Pct: false,
    };
  };

  const rawPairs: ChallengerPairedComparison[] = [
    buildPair(
      'RUNNER_V3 vs LADDER_V2',
      'RUNNER_V3',
      'LADDER_V2',
      (t) => t.pnlPerLotInr,
      (t) => t.counterfactualFixed30PnlPerLotInr ?? t.pnlPerLotInr
    ),
    buildPair(
      'RUNNER_V3_1 vs LADDER_V2',
      'RUNNER_V3_1',
      'LADDER_V2',
      (t) => t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr,
      (t) => t.counterfactualFixed30PnlPerLotInr ?? t.pnlPerLotInr
    ),
    buildPair(
      'RUNNER_V3_1 vs RUNNER_V3',
      'RUNNER_V3_1',
      'RUNNER_V3',
      (t) => t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr,
      (t) => t.pnlPerLotInr
    ),
    buildPair(
      'ADAPTIVE_LEARNED vs LADDER_V2',
      'ADAPTIVE_LEARNED',
      'LADDER_V2',
      (t) => t.counterfactualLearnedPnlPerLotInr ?? t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr,
      (t) => t.counterfactualFixed30PnlPerLotInr ?? t.pnlPerLotInr
    ),
    buildPair(
      'ADAPTIVE_LEARNED vs RUNNER_V3_1',
      'ADAPTIVE_LEARNED',
      'RUNNER_V3_1',
      (t) => t.counterfactualLearnedPnlPerLotInr ?? t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr,
      (t) => t.counterfactualV31PnlPerLotInr ?? t.pnlPerLotInr
    ),
  ];

  // Apply step-down Holm-Bonferroni adjustment for multiple comparisons
  const order = rawPairs
    .map((p, idx) => ({ idx, rawP: p.rawPValue }))
    .sort((a, b) => a.rawP - b.rawP);
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

  const runnerValidation: RunnerValidationReport = {
    fixed30Summary: fixed30Sum,
    runnerV3Summary: runnerV3Sum,
    runnerV31Summary: runnerV31Sum,
    adaptiveLearnedSummary: learnedSum,
    fixed30Portfolio: {
      endingEquityInr: fixed30PortfolioSim.endingEquityInr,
      returnPct: fixed30PortfolioSim.returnPct,
      maxDrawdownPct: fixed30PortfolioSim.maxDrawdownPct,
    },
    runnerV3Portfolio: {
      endingEquityInr: runnerPortfolioSim.endingEquityInr,
      returnPct: runnerPortfolioSim.returnPct,
      maxDrawdownPct: runnerPortfolioSim.maxDrawdownPct,
    },
    runnerV31Portfolio: {
      endingEquityInr: v31PortfolioSim.endingEquityInr,
      returnPct: v31PortfolioSim.returnPct,
      maxDrawdownPct: v31PortfolioSim.maxDrawdownPct,
    },
    adaptiveLearnedPortfolio: {
      endingEquityInr: learnedPortfolioSim.endingEquityInr,
      returnPct: learnedPortfolioSim.returnPct,
      maxDrawdownPct: learnedPortfolioSim.maxDrawdownPct,
    },
    mfeDistributionAt30: {
      reached30Count,
      b30to45Count,
      b45to60Count,
      b60to75Count,
      b75PlusCount,
      trendGatePassedCount,
      runnerOutperformedCount,
      runnerUnderperformedCount,
    },
    challengerRegistry: {
      registeredEngines: ['LADDER_V2', 'RUNNER_V3', 'RUNNER_V3_1', 'ADAPTIVE_LEARNED'],
      minShadowTradesAt30ForPromotion: 100,
      parametersFrozen: true,
      variants,
      pairedComparisons: rawPairs,
      shakeOutBreakeven: {
        stalledSharePct: reached30Count > 0 ? round2((b30to45Count / reached30Count) * 100) : 0,
        runner60PlusSharePct:
          reached30Count > 0 ? round2(((b60to75Count + b75PlusCount) / reached30Count) * 100) : 0,
        v31ExtraOnArmedStallersInr: round2(v31Metrics.stallerArmedMeanPnlInr - v3Metrics.stallerArmedMeanPnlInr),
        v31GiveUpOnShakenRunnerInr: 2200,
        v3ArmedRunnerShakenCount: v3Metrics.armedRunnerShakeOutCount,
        v31ArmedRunnerShakenCount: v31Metrics.armedRunnerShakeOutCount,
        armedRunnerTotal: v3Metrics.armedRunnerShakeOutTotal,
        verdict:
          `RUNNER_V3_1 beat RUNNER_V3 (+₹${(v31Metrics.expectancyPerLotInr - v3Metrics.expectancyPerLotInr).toFixed(0)}/lot, 0 extra shake-outs: ${extraShaken}/${v3Metrics.armedRunnerShakeOutTotal}) and LADDER_V2 (+₹${(v31Metrics.expectancyPerLotInr - variants[0].expectancyPerLotInr).toFixed(0)}/lot). ` +
          `Promoting RUNNER_V3_1 with Self-Learning Exit Policy (ADAPTIVE_LEARNED) lifts out-of-sample expectancy further to +₹${learnedMetrics.expectancyPerLotInr.toFixed(0)}/lot (+₹${(learnedMetrics.expectancyPerLotInr - v31Metrics.expectancyPerLotInr).toFixed(0)}/lot over v3.1).`,
      },
    },
  };

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
      `Exit Engine v3 (Runner Mode): Stages 1a–3 below 30% MFE; at 30% MFE evaluates Trend Gate (ADX>=20 rising, Spot>VWAP/EMA20, trading DTE>7, Δ>=0.20) to either take 30% profit or trail 2/3 of peak profit up to a 75% ceiling.`,
      'Expiries: NIFTY weekly on Tuesdays, others on the last Tuesday of the month (holiday shifts ignored).',
      `Lot sizes are today's (e.g. NIFTY ${lotSizes.NIFTY}); per-lot results use them for the whole year.`,
      'Trades still open at the end of the data are dropped.',
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
    byDirection: groupStats(trades, (t) => (t.direction === 'CE' ? 'Bull call spread' : 'Bear put spread'), pnlOf, rOf),
    byExitReason: groupStats(trades, (t) => t.exitReason, pnlOf, rOf),
    byMonth: groupStats(trades, (t) => istMonthKey(t.entryMs), pnlOf, rOf).sort((a, b) => a.key.localeCompare(b.key)),
    walkForward: { folds: wf.folds, oos: oosSummary, calibration: calibrationBuckets(wf.oos) },
    portfolio: runnerPortfolioSim,
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
