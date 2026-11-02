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
  const affordable = plans.filter((p) => p.maxLossPerLot <= input.budgetPerTradeInr);
  if (affordable.length > 0) {
    affordable.sort((a, b) => b.width - a.width);
    return { ok: true, plan: affordable[0], affordable: true };
  }
  plans.sort((a, b) => a.maxLossPerLot - b.maxLossPerLot);
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
>;

export function exitLevels(plan: Pick<SpreadPlan, 'entryDebit' | 'width'>, cfg: ExitConfig) {
  return {
    target: round2(plan.entryDebit + cfg.takeProfitFracOfMaxGain * (plan.width - plan.entryDebit)),
    stop: round2(plan.entryDebit * (1 - cfg.stopLossFracOfDebit)),
  };
}

export function evaluateSpreadExit(input: {
  plan: Pick<SpreadPlan, 'entryDebit' | 'width'>;
  liquidationValue: number;
  sessionsHeld: number;
  dte: number;
  cfg: ExitConfig;
}): ExitReason | null {
  if (input.dte <= input.cfg.exitAtDte) return 'EXPIRY_RISK';
  const { target, stop } = exitLevels(input.plan, input.cfg);
  if (input.liquidationValue >= target) return 'TAKE_PROFIT';
  if (input.liquidationValue <= stop) return 'STOP_LOSS';
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
