/**
 * Option pricing, NSE charges and vertical debit spread construction / valuation.
 *
 * Fill convention: entries buy the long leg at the ask and sell the short leg at the bid;
 * exits sell the long leg at the bid and buy the short leg back at the ask. That is what a
 * marketable order gets for one or two lots, so paper results are not flattered by mid fills.
 */

import type {
  EngineConfig,
  ExitReason,
  ExitRuleVersion,
  LegQuote,
  OptionRight,
  SpreadMark,
  SpreadPlan,
} from './types.js';

export interface ChargesConfig {
  brokeragePerOrderInr: number;
  sttSellPct: number;
  exchangeTxnPct: number;
  sebiPct: number;
  stampBuyPct: number;
  gstPct: number;
}

/**
 * Angel One flat ₹20/order brokerage plus statutory charges on option premium.
 * STT uses 0.15% of sell-side premium, the higher of the recently applicable rates, to stay conservative.
 */
export const DEFAULT_CHARGES: ChargesConfig = {
  brokeragePerOrderInr: 20,
  sttSellPct: 0.0015,
  exchangeTxnPct: 0.0003503,
  sebiPct: 0.000001,
  stampBuyPct: 0.00003,
  gstPct: 0.18,
};

const round2 = (x: number) => Math.round(x * 100) / 100;

export function legCharges(
  side: 'BUY' | 'SELL',
  price: number,
  units: number,
  cfg: ChargesConfig = DEFAULT_CHARGES
): number {
  if (units <= 0) return 0;
  const turnover = Math.max(0, price) * units;
  const brokerage = cfg.brokeragePerOrderInr;
  const stt = side === 'SELL' ? turnover * cfg.sttSellPct : 0;
  const exch = turnover * cfg.exchangeTxnPct;
  const sebi = turnover * cfg.sebiPct;
  const stamp = side === 'BUY' ? turnover * cfg.stampBuyPct : 0;
  const gst = (brokerage + exch + sebi) * cfg.gstPct;
  return round2(brokerage + stt + exch + sebi + stamp + gst);
}

export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

export function bsPrice(
  spot: number,
  strike: number,
  tYears: number,
  vol: number,
  r: number,
  right: OptionRight
): number {
  if (tYears <= 0 || vol <= 0) {
    return Math.max(0, right === 'CE' ? spot - strike : strike - spot);
  }
  const sqrtT = Math.sqrt(tYears);
  const d1 = (Math.log(spot / strike) + (r + 0.5 * vol * vol) * tYears) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  if (right === 'CE') return spot * normCdf(d1) - strike * Math.exp(-r * tYears) * normCdf(d2);
  return strike * Math.exp(-r * tYears) * normCdf(-d2) - spot * normCdf(-d1);
}

export function bsDelta(
  spot: number,
  strike: number,
  tYears: number,
  vol: number,
  r: number,
  right: OptionRight
): number {
  if (tYears <= 0 || vol <= 0) {
    if (right === 'CE') return spot > strike ? 1 : 0;
    return spot < strike ? -1 : 0;
  }
  const d1 =
    (Math.log(spot / strike) + (r + 0.5 * vol * vol) * tYears) / (vol * Math.sqrt(tYears));
  return right === 'CE' ? normCdf(d1) : normCdf(d1) - 1;
}

/** Implied volatility by bisection; null when the price is outside the no-arbitrage range. */
export function impliedVol(
  price: number,
  spot: number,
  strike: number,
  tYears: number,
  r: number,
  right: OptionRight
): number | null {
  if (!(price > 0) || tYears <= 0) return null;
  const intrinsic = Math.max(0, right === 'CE' ? spot - strike * Math.exp(-r * tYears) : strike * Math.exp(-r * tYears) - spot);
  if (price < intrinsic) return null;
  let lo = 0.005;
  let hi = 3;
  if (bsPrice(spot, strike, tYears, hi, r, right) < price) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(spot, strike, tYears, mid, r, right) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export function quoteIssue(
  q: LegQuote | undefined,
  nowMs: number,
  maxAgeSec: number,
  need: { bid: boolean; ask: boolean }
): string | null {
  if (!q) return 'no quote';
  if (need.bid && !(q.bid > 0)) return 'no bid in order book';
  if (need.ask && !(q.ask > 0)) return 'no ask in order book';
  if (q.bid > 0 && q.ask > 0 && q.ask < q.bid) return 'crossed order book';
  if (q.feedTimeMs !== null && nowMs - q.feedTimeMs > maxAgeSec * 1000) {
    return `stale quote (${Math.round((nowMs - q.feedTimeMs) / 1000)}s old)`;
  }
  return null;
}

function legSpreadPct(q: LegQuote): number {
  const mid = (q.bid + q.ask) / 2;
  return mid > 0 ? (q.ask - q.bid) / mid : Infinity;
}

function legMid(q: LegQuote): number {
  if (q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  return q.bid > 0 ? q.bid : q.ask;
}

export interface ChainLeg {
  token: string;
  symbol: string;
  strike: number;
  lotSize: number;
}

export type SpreadBuildConfig = Pick<
  EngineConfig,
  'maxLegSpreadPct' | 'minLongLegPrice' | 'maxShortSteps' | 'minDebitRatio' | 'maxDebitRatio' | 'quoteMaxAgeSec'
>;

export interface BuildSpreadInput {
  underlying: string;
  right: OptionRight;
  expiry: string;
  dte: number;
  spot: number;
  chain: ChainLeg[];
  quotes: Record<string, LegQuote>;
  budgetPerTradeInr: number;
  nowMs: number;
  cfg: SpreadBuildConfig;
  charges?: ChargesConfig;
}

export type BuildSpreadResult =
  | { ok: true; plan: SpreadPlan; affordable: boolean }
  | { ok: false; reason: string };

/** Long leg at the strike nearest spot; short leg 1..maxShortSteps listed strikes further out of the money. */
export function selectChainLegs(
  chain: ChainLeg[],
  spot: number,
  right: OptionRight,
  maxShortSteps: number
): ChainLeg[] {
  const sorted = [...chain].sort((a, b) => a.strike - b.strike);
  if (sorted.length === 0) return [];
  let atm = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].strike - spot) < Math.abs(sorted[atm].strike - spot)) atm = i;
  }
  const picked = [sorted[atm]];
  for (let s = 1; s <= maxShortSteps; s++) {
    const idx = right === 'CE' ? atm + s : atm - s;
    if (idx < 0 || idx >= sorted.length) break;
    picked.push(sorted[idx]);
  }
  return picked;
}

export function buildSpreadPlan(input: BuildSpreadInput): BuildSpreadResult {
  const charges = input.charges ?? DEFAULT_CHARGES;
  const { cfg } = input;
  const legs = selectChainLegs(input.chain, input.spot, input.right, cfg.maxShortSteps);
  if (legs.length < 2) return { ok: false, reason: 'option chain has no strikes beyond the ATM strike' };

  const long = legs[0];
  const lq = input.quotes[long.token];
  const longIssue = quoteIssue(lq, input.nowMs, cfg.quoteMaxAgeSec, { bid: true, ask: true });
  if (longIssue || !lq) return { ok: false, reason: `long leg ${long.symbol}: ${longIssue}` };
  if (lq.ask < cfg.minLongLegPrice) {
    return { ok: false, reason: `long leg ${long.symbol}: ask ₹${lq.ask} below ₹${cfg.minLongLegPrice}` };
  }
  const longSpread = legSpreadPct(lq);
  if (longSpread > cfg.maxLegSpreadPct) {
    return {
      ok: false,
      reason: `long leg ${long.symbol}: bid-ask ${(longSpread * 100).toFixed(1)}% wider than ${(cfg.maxLegSpreadPct * 100).toFixed(0)}%`,
    };
  }

  const plans: SpreadPlan[] = [];
  const rejections: string[] = [];
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
    const entryChargesPerLot = round2(legCharges('BUY', lq.ask, lot, charges) + legCharges('SELL', sq.bid, lot, charges));
    const exitChargesWorstPerLot = round2(legCharges('SELL', 0, lot, charges) + legCharges('BUY', 0, lot, charges));
    const exitChargesBestPerLot = round2(legCharges('SELL', width, lot, charges) + legCharges('BUY', 0, lot, charges));
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
      maxGainPerLot: round2((width - debit) * lot - entryChargesPerLot - exitChargesBestPerLot),
    });
  }

  if (plans.length === 0) {
    return { ok: false, reason: rejections[0] ?? 'no valid short strike' };
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

export type MarkResult = { ok: true; mark: SpreadMark } | { ok: false; reason: string };

export function markSpread(
  plan: Pick<SpreadPlan, 'long' | 'short'>,
  quotes: Record<string, LegQuote>,
  nowMs: number,
  maxAgeSec: number
): MarkResult {
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
      midValue: round2(legMid(lq) - legMid(sq)),
    },
  };
}

export type ExitConfig = Pick<
  EngineConfig,
  'exitAtDte' | 'takeProfitFracOfMaxGain' | 'stopLossFracOfDebit' | 'maxHoldSessions'
> &
  Partial<
    Pick<
      EngineConfig,
      | 'runnerArmMfeFrac'
      | 'runnerKeepFrac'
      | 'runnerCeilingFracOfMaxGain'
      | 'runnerMinAdx'
      | 'runnerMinNetDelta'
      | 'runnerMinTradingDte'
    >
  >;

export type DynamicExitStage =
  | 'INITIAL'
  | 'TIME_DECAY'
  | 'BREAKEVEN_LOCK'
  | 'PROFIT_TRAIL'
  | 'RUNNER_MODE';

export interface ExitLevelDetails {
  target: number;
  fixed30Target: number;
  ceilingTarget: number;
  stop: number;
  initialStop: number;
  runnerFloorAtArm: number;
  runnerFloorAtArmV31: number;
  runnerFloorAtArmLearned: number;
  runnerFloorV3: number;
  runnerFloorV31: number;
  runnerFloorLearned: number;
  runnerCushionV3: number;
  runnerCushionV31: number;
  keepFracActive: number;
  peakValue: number;
  mfeFracOfMaxGain: number;
  ratcheted: boolean;
  runnerArmed: boolean;
  stage: DynamicExitStage;
}

/**
 * Computes the fraction of peak profit kept by Runner Mode:
 * - RUNNER_V3: constant keep = 2/3 (allowed fall = 33.33% of peak profit)
 * - RUNNER_V3_1: allowed fall tapers linearly from 20% at 30% MFE (keep = 80%) to 33.33% at 60% MFE (keep = 66.67%),
 *   protecting early stallers (locking +₹282 to +₹376 more per RELIANCE lot between 30% and 45% MFE) and converging with v3 by 60% MFE.
 */
export function runnerKeepFracForMfe(
  mfeFrac: number,
  variant: ExitRuleVersion = 'RUNNER_V3',
  baseKeepFrac = 2 / 3,
  armMfeFrac = 0.3,
  learnedInitialKeepFrac?: number | null
): number {
  if (variant === 'RUNNER_V3_1' || variant === 'ADAPTIVE_LEARNED') {
    const startKeep =
      variant === 'ADAPTIVE_LEARNED' && learnedInitialKeepFrac != null
        ? Math.max(baseKeepFrac, Math.min(0.85, learnedInitialKeepFrac))
        : 0.8;
    const startAllowedFall = 1 - startKeep;
    const convergeMfe = 0.6;
    const progress = Math.max(0, Math.min(1, (mfeFrac - armMfeFrac) / Math.max(0.01, convergeMfe - armMfeFrac)));
    const allowedFall = startAllowedFall + progress * (1 - baseKeepFrac - startAllowedFall);
    return 1 - allowedFall;
  }
  return baseKeepFrac;
}

/**
 * Updates the sliding mark buffer (up to N=3 quotes) and returns the median confirmed mark.
 * Ensures a single glitchy tick never artificially raises the confirmed peak P.
 */
export function updateConfirmedMark(
  recentMarks: number[] | undefined,
  nextMark: number,
  windowSize = 3
): { recentMarks: number[]; confirmedMark: number } {
  const clean = (recentMarks ?? []).filter((m) => Number.isFinite(m) && m >= 0);
  clean.push(round2(nextMark));
  while (clean.length > windowSize) clean.shift();
  const sorted = [...clean].sort((a, b) => a - b);
  const confirmedMark = sorted[Math.floor(sorted.length / 2)] ?? round2(nextMark);
  return { recentMarks: clean, confirmedMark };
}

/** Estimates net spread delta |delta_long - delta_short| for the Runner Trend Gate. */
export function estimateSpreadNetDelta(
  plan: Pick<SpreadPlan, 'long' | 'short' | 'right' | 'spotAtEntry' | 'dte'>,
  spot: number,
  dte: number,
  mark?: SpreadMark | null
): number {
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

export interface RunnerTrendGateInput {
  right: OptionRight;
  spot: number;
  ema20: number;
  vwap: number;
  adx14: number;
  prevAdx14: number;
  tradingDte: number;
  spreadNetDelta: number;
  cfg?: ExitConfig;
}

export interface RunnerTrendGateResult {
  passed: boolean;
  reason: string;
}

/**
 * Evaluates the Exit Engine v3 Runner Trend Gate at MFE% >= 30%:
 * 1) ADX(14) >= 20 and rising
 * 2) Underlying price above VWAP and EMA20 (for CE) or below VWAP and EMA20 (for PE)
 * 3) trading_days_to_expiry > 7
 * 4) spread net delta >= 0.20
 */
export function evaluateRunnerTrendGate(input: RunnerTrendGateInput): RunnerTrendGateResult {
  const minAdx = input.cfg?.runnerMinAdx ?? 20;
  const minDelta = input.cfg?.runnerMinNetDelta ?? 0.2;
  const minTradingDte = input.cfg?.runnerMinTradingDte ?? 7;

  const adxOk = input.adx14 >= minAdx && input.adx14 > input.prevAdx14;
  const vwapEmaOk =
    input.right === 'CE'
      ? input.spot > input.ema20 && input.spot >= input.vwap
      : input.spot < input.ema20 && input.spot <= input.vwap;
  const dteOk = input.tradingDte > minTradingDte;
  const deltaOk = input.spreadNetDelta >= minDelta;

  const passed = adxOk && vwapEmaOk && dteOk && deltaOk;
  const parts: string[] = [
    `ADX ${input.adx14.toFixed(1)} (${adxOk ? 'rising' : 'weak/flat'})`,
    `Spot vs VWAP/EMA20 ${vwapEmaOk ? 'aligned' : 'below'}`,
    `${input.tradingDte}d trading DTE`,
    `Δ ${input.spreadNetDelta.toFixed(2)}`,
  ];
  return {
    passed,
    reason: `${passed ? 'RUNNER ARMED' : 'GATE FAILED (30% TP)'}: ${parts.join(' · ')}`,
  };
}

export function exitLevels(
  plan: Pick<SpreadPlan, 'entryDebit' | 'width'>,
  cfg: ExitConfig,
  opts?: {
    peakValue?: number;
    sessionsHeld?: number;
    runnerArmed?: boolean;
    previousFloor?: number;
    previousFloorV31?: number;
    previousFloorLearned?: number;
    atrEquivalent?: number;
    variant?: ExitRuleVersion;
    learnedKeepFrac?: number | null;
    learnedEarlyStopTightened?: boolean;
  }
): ExitLevelDetails {
  const maxGain = Math.max(0.01, plan.width - plan.entryDebit);
  const armMfeFrac = cfg.runnerArmMfeFrac ?? cfg.takeProfitFracOfMaxGain ?? 0.3;
  const baseKeepFrac = cfg.runnerKeepFrac ?? 2 / 3;
  const ceilingFrac = cfg.runnerCeilingFracOfMaxGain ?? 0.75;
  const variant: ExitRuleVersion = opts?.variant ?? 'RUNNER_V3';
  const learnedInitKeep =
    opts?.learnedKeepFrac != null ? Math.max(baseKeepFrac, Math.min(0.85, opts.learnedKeepFrac)) : 0.8;

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

  // Always compute v3 (constant 2/3), v3.1 (tapered 80% -> 66.7%), and learned (tapered learnedInitKeep -> 66.7%) candidate floors
  const rawFloorV3 = round2(plan.entryDebit + baseKeepFrac * peakGain);
  const keepV31 = runnerKeepFracForMfe(Math.max(armMfeFrac, mfeFrac), 'RUNNER_V3_1', baseKeepFrac, armMfeFrac);
  const rawFloorV31 = round2(plan.entryDebit + keepV31 * peakGain);
  const keepLearned = runnerKeepFracForMfe(
    Math.max(armMfeFrac, mfeFrac),
    'ADAPTIVE_LEARNED',
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

  let target = fixed30Target;
  let stop = initialStop;
  let stage: DynamicExitStage = 'INITIAL';
  let ratcheted = false;

  if (runnerArmed) {
    // Stage 4: Exit Engine v3 / v3.1 / Adaptive Learned Runner Mode up to 75% ceiling
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
    const prev =
      variant === 'ADAPTIVE_LEARNED'
        ? (opts?.previousFloorLearned ?? opts?.previousFloorV31 ?? opts?.previousFloor ?? initialStop)
        : variant === 'RUNNER_V3_1'
          ? (opts?.previousFloorV31 ?? opts?.previousFloor ?? initialStop)
          : (opts?.previousFloor ?? initialStop);
    stop = round2(Math.max(prev, rawFloor));
    stage = 'RUNNER_MODE';
    ratcheted = stop > initialStop;
  } else if (mfeFrac >= 0.22) {
    // Stage 3: High-Water-Mark Profit-Lock Trail (73%–99% of target reached, e.g. 22% -> 29.5% of maxGain)
    const lockedMaxGainFrac = Math.min(mfeFrac * 0.7, 0.1 + (mfeFrac - 0.22) * 1.3);
    stop = round2(Math.max(opts?.previousFloor ?? initialStop, plan.entryDebit + lockedMaxGainFrac * maxGain));
    stage = 'PROFIT_TRAIL';
    ratcheted = stop > initialStop;
  } else if (mfeFrac >= 0.16) {
    // Stage 2: Break-Even + Brokerage/STT Cost-Recovery Floor (16% -> 22% of maxGain)
    const lockedMaxGainFrac = 0.05 + ((mfeFrac - 0.16) / 0.06) * 0.05;
    stop = round2(Math.max(opts?.previousFloor ?? initialStop, plan.entryDebit + lockedMaxGainFrac * maxGain));
    stage = 'BREAKEVEN_LOCK';
    ratcheted = stop > initialStop;
  } else if (mfeFrac >= 0.11) {
    // Stage 1b: Risk-Halving Ratchet (11% -> 16% of maxGain cuts max stop loss in half from -72% to -32%)
    stop = round2(Math.max(opts?.previousFloor ?? initialStop, plan.entryDebit * (1 - cfg.stopLossFracOfDebit * 0.45)));
    stage = 'TIME_DECAY';
    ratcheted = stop > initialStop;
  } else if (variant === 'ADAPTIVE_LEARNED' && opts?.learnedEarlyStopTightened && mfeFrac < 0.1) {
    // Self-Learning Early Loss Cut: tightens stop from -72% to -38% when recovery probability drops in stagnant sessions
    stop = round2(Math.max(opts?.previousFloor ?? initialStop, plan.entryDebit * (1 - cfg.stopLossFracOfDebit * 0.53)));
    stage = 'TIME_DECAY';
    ratcheted = stop > initialStop;
  } else if (sessionsHeld >= 6 && mfeFrac < 0.1) {
    // Stage 1c: Time-Decay Stop Tightening for stagnant spreads after 6 sessions
    stop = round2(Math.max(opts?.previousFloor ?? initialStop, plan.entryDebit * (1 - cfg.stopLossFracOfDebit * 0.72)));
    stage = 'TIME_DECAY';
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
    stage,
  };
}

export function evaluateSpreadExit(input: {
  plan: Pick<SpreadPlan, 'entryDebit' | 'width'>;
  liquidationValue: number;
  peakValue?: number;
  sessionsHeld: number;
  dte: number;
  cfg: ExitConfig;
  runnerArmed?: boolean;
  runnerTrendGatePassed?: boolean | null;
  previousFloor?: number;
  previousFloorV31?: number;
  atrEquivalent?: number;
  variant?: ExitRuleVersion;
  learnedKeepFrac?: number | null;
  learnedEarlyStopTightened?: boolean;
}): ExitReason | null {
  const tradingDte = Math.round((input.dte * 5) / 7);
  if (input.dte <= input.cfg.exitAtDte || (input.runnerArmed && tradingDte <= 5)) {
    return 'EXPIRY_RISK';
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
    learnedEarlyStopTightened: input.learnedEarlyStopTightened,
  });

  if (input.runnerArmed) {
    // In Runner Mode: exit as TAKE_PROFIT only at the 75% ceiling, or TRAIL_STOP if price hits the runner floor
    if (input.liquidationValue >= lvls.ceilingTarget) return 'TAKE_PROFIT';
    if (input.liquidationValue <= lvls.stop) return 'TRAIL_STOP';
    if (input.sessionsHeld > input.cfg.maxHoldSessions) return 'TIME_STOP';
    return null;
  }

  // Not yet armed: check if MFE reached 30% target
  if (input.liquidationValue >= lvls.fixed30Target || effectivePeak >= lvls.fixed30Target) {
    if (input.runnerTrendGatePassed === true) {
      // Trend Gate passed at 30%: transition into Runner Mode instead of selling at 30%
      const armedLvls = exitLevels(input.plan, input.cfg, {
        peakValue: effectivePeak,
        sessionsHeld: input.sessionsHeld,
        runnerArmed: true,
        previousFloor: input.previousFloor ?? lvls.stop,
        previousFloorV31: input.previousFloorV31 ?? lvls.stop,
        atrEquivalent: input.atrEquivalent,
        variant: input.variant,
        learnedKeepFrac: input.learnedKeepFrac,
        learnedEarlyStopTightened: input.learnedEarlyStopTightened,
      });
      if (input.liquidationValue >= armedLvls.ceilingTarget) return 'TAKE_PROFIT';
      if (input.liquidationValue <= armedLvls.stop) return 'TRAIL_STOP';
      if (input.sessionsHeld > input.cfg.maxHoldSessions) return 'TIME_STOP';
      return null;
    }
    // Trend Gate failed (or using fixed-30% Ladder v2): take the 30% profit now
    if (input.liquidationValue >= lvls.fixed30Target) return 'TAKE_PROFIT';
  }

  if (input.liquidationValue <= lvls.stop) {
    // Rule 6: TRAIL_STOP for floor hits above initial stop; STOP_LOSS only for initial stop hits
    return lvls.stop > lvls.initialStop ? 'TRAIL_STOP' : 'STOP_LOSS';
  }
  if (input.sessionsHeld > input.cfg.maxHoldSessions) return 'TIME_STOP';
  return null;
}

export function entryChargesFor(plan: SpreadPlan, units: number, charges = DEFAULT_CHARGES): number {
  return round2(legCharges('BUY', plan.long.ask, units, charges) + legCharges('SELL', plan.short.bid, units, charges));
}

export function exitChargesFor(longBid: number, shortAsk: number, units: number, charges = DEFAULT_CHARGES): number {
  return round2(legCharges('SELL', longBid, units, charges) + legCharges('BUY', shortAsk, units, charges));
}

export function maxLossFor(plan: SpreadPlan, lots: number, charges = DEFAULT_CHARGES): number {
  const units = lots * plan.lotSize;
  return round2(
    plan.entryDebit * units + entryChargesFor(plan, units, charges) + exitChargesFor(0, 0, units, charges)
  );
}

/** Rough exchange exposure margin blocked for the short leg; the long leg caps the loss but not the margin. */
export function estimateShortLegMargin(
  plan: SpreadPlan,
  lots: number,
  isIndex: boolean,
  cfg: Pick<EngineConfig, 'exposureMarginPctIndex' | 'exposureMarginPctStock'>
): number {
  const pct = isIndex ? cfg.exposureMarginPctIndex : cfg.exposureMarginPctStock;
  return round2(plan.spotAtEntry * lots * plan.lotSize * pct);
}

export interface PayoffPoint {
  spot: number;
  movePct: number;
  pnlInr: number;
}

/** Profit and loss at expiry for a held debit spread, net of the charges already paid and exit brokerage. */
export function spreadPayoffAtExpiry(
  plan: SpreadPlan,
  lots: number,
  spotNow: number,
  entryCashOutInr: number
) {
  const units = lots * plan.lotSize;
  const k = plan.long.strike;
  const exitCost = exitChargesFor(0, 0, units);
  const valueAt = (s: number) => {
    const intrinsic = plan.right === 'CE' ? s - k : k - s;
    return Math.min(Math.max(intrinsic, 0), plan.width);
  };
  const points: PayoffPoint[] = [];
  for (let step = -10; step <= 10; step++) {
    const movePct = step * 0.5;
    const s = spotNow * (1 + movePct / 100);
    points.push({ spot: round2(s), movePct, pnlInr: round2(valueAt(s) * units - exitCost - entryCashOutInr) });
  }
  const perUnitCost = (entryCashOutInr + exitCost) / units;
  return {
    points,
    breakevenSpot: round2(plan.right === 'CE' ? k + perUnitCost : k - perUnitCost),
    maxProfitInr: round2(plan.width * units - exitCost - entryCashOutInr),
    maxLossInr: round2(-(entryCashOutInr + exitCost)),
  };
}
