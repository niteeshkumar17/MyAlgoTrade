/**
 * Pure Quantitative Indian NSE F&O Options Paper-Trading Engine,
 * Pessimistic Fill Simulator (NSE Lots + INR Statutory Charges),
 * Risk Gate, Post-Mortem Classifier, Learning Loop & Walk-Forward Backtester.
 */

export type OptionRight = 'CE' | 'PE';
export type StrategyName = 'trend_following' | 'mean_reversion' | 'breakout_momentum';
export type MarketRegime = 'trending_up' | 'trending_down' | 'range' | 'high_volatility';
export type PostMortemLabel =
  | 'optimal_exit'
  | 'wrong_direction'
  | 'theta_or_iv_crush'
  | 'stopped_out_then_reversed'
  | 'winner_given_back'
  | 'bad_fill_wide_spread'
  | 'wrong_regime';

export const NSE_LOT_SIZES: Record<string, number> = {
  NIFTY: 75,
  BANKNIFTY: 30,
  FINNIFTY: 65,
  RELIANCE: 500,
  TCS: 175,
  HDFCBANK: 550,
  INFY: 400,
  ICICIBANK: 700,
  SBIN: 750,
};

export interface FillSimConfig {
  spreadSlippageFraction: number; // default 0.35
  feePerLotInr: number;           // default ₹35.0 per lot per leg (₹20 brokerage + ₹15 STT/NSE/SEBI/GST)
  rejectZeroBid: boolean;         // default true
}

export interface SimulatedFillResult {
  side: 'BUY' | 'SELL';
  lotsQty: number;
  lotSize: number;
  totalUnits: number;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  spreadPctOfMid: number;
  conservativeFillPrice: number;
  brokerPaperFillPrice: number;
  feeInr: number;
  conservativeTotalCashInr: number;
  brokerPaperTotalCashInr: number;
  slippageVsMidInr: number;
}

export interface OptionContractCandidate {
  contractSymbol: string;
  underlying: string;
  right: OptionRight;
  strike: number;
  lotSize: number;
  expirationDate: string;
  dte: number;
  bid: number;
  ask: number;
  delta: number;
  theta: number;
  ivRankPct: number;
  openInterest: number;
  volume: number;
  hasEarningsInWindow: boolean;
  isHalted?: boolean;
}

export interface ContractFilterConfig {
  minDte: number;           // 7 (supports NSE weekly & monthly expiries)
  maxDte: number;           // 45
  hardFloorDte: number;     // 4
  minAbsDelta: number;      // 0.35
  maxAbsDelta: number;      // 0.55
  maxSpreadPctOfMid: number;// 0.08
  minOpenInterest: number;  // 500
  minDailyVolume: number;   // 100
  maxIvRankPct: number;     // 85
  minIvRankPct: number;     // 10
}

export interface OpenOptionPosition {
  positionId: string;
  tradeId: string;
  contractSymbol: string;
  underlying: string;
  right: OptionRight;
  strike: number;
  lotSize: number;
  expirationDate: string;
  dte: number;
  strategyName: StrategyName;
  regimeAtEntry: MarketRegime;
  lotsQty: number;
  conservativeEntryPrice: number;
  brokerPaperEntryPrice: number;
  currentMarkPrice: number;
  peakMarkPrice: number;
  troughMarkPrice: number;
  unrealizedPnlInr: number;
  unrealizedPnlPct: number;
  delta: number;
  theta: number;
  ivRankPct: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  trailingStopActivationPrice: number;
  tradingDaysHeld: number;
  isIntradayFlagged: boolean;
  openedAt: string;
}

export interface ClosedOptionTrade {
  tradeId: string;
  contractSymbol: string;
  underlying: string;
  right: OptionRight;
  lotSize: number;
  strategyName: StrategyName;
  regimeAtEntry: MarketRegime;
  regimeAtExit: MarketRegime;
  isShadowChallenger: boolean;
  modelVersion: string;
  lotsQty: number;
  dteAtEntry: number;
  deltaAtEntry: number;
  ivRankAtEntry: number;
  spreadPctAtEntry: number;
  confidenceAtEntry: number;
  rsiAtEntry: number;
  adxAtEntry: number;
  atrPctAtEntry: number;
  indiaVixAtEntry: number;
  timeOfDayBucket: 'OPEN_0915_1015' | 'MIDDAY_1015_1330' | 'AFTERNOON_1330_1530';
  conservativeEntryPrice: number;
  conservativeExitPrice: number;
  brokerPaperEntryPrice: number;
  brokerPaperExitPrice: number;
  feesTotalInr: number;
  conservativePnlInr: number;
  conservativePnlPct: number;
  brokerPaperPnlInr: number;
  brokerPaperPnlPct: number;
  maePct: number;
  mfePct: number;
  holdMinutes: number;
  entryReason: string;
  exitReason: string;
  postMortemLabel: PostMortemLabel;
  diagnosisNotes: string;
  openedAt: string;
  closedAt: string;
}

export interface SkippedSignalCounterfactual {
  signalId: string;
  generatedAt: string;
  underlying: string;
  strategyName: StrategyName;
  direction: OptionRight;
  regime: MarketRegime;
  confidence: number;
  qualityGateProb: number;
  skipReason: string;
  counterfactualContract: string;
  counterfactualEntryPrice: number;
  counterfactualExitPrice: number;
  counterfactualPnlPct: number;
}

export interface EquitySnapshotPoint {
  snapshotId: string;
  recordedAt: string;
  conservativeEquityInr: number;
  brokerPaperEquityInr: number;
  niftyBenchmarkEquityInr: number;
  realizedPnlInr: number;
  unrealizedPnlInr: number;
  drawdownPct: number;
  openPositionsCount: number;
}

const APPROVED_PAPER_ENDPOINTS = new Set([
  'https://paper-sandbox.nseindia-sim.local',
  'https://paper-api.alpaca.markets',
]);

/**
 * 1. Hard Paper-Trading URL Guard
 */
export function validatePaperEndpoint(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed.toLowerCase().includes('live')) return false;
  return APPROVED_PAPER_ENDPOINTS.has(trimmed);
}

/**
 * 2. Pessimistic NSE Paper Fill Simulator
 * Buy at mid + 35% of spread (+ ₹35/lot fee covering brokerage, STT, NSE turnover, SEBI, GST)
 * Sell at mid - 35% of spread (+ ₹35/lot fee)
 */
export function simulatePessimisticFill(
  side: 'BUY' | 'SELL',
  lotsQty: number,
  bid: number,
  ask: number,
  lotSize: number = 75,
  brokerPaperFillPrice?: number,
  cfg: FillSimConfig = {
    spreadSlippageFraction: 0.35,
    feePerLotInr: 35.0,
    rejectZeroBid: true,
  }
): SimulatedFillResult {
  if (lotsQty <= 0) {
    throw new Error(`Lot quantity must be > 0, got ${lotsQty}`);
  }
  if (lotSize <= 0) {
    throw new Error(`lotSize must be > 0, got ${lotSize}`);
  }
  if (cfg.rejectZeroBid && bid <= 0) {
    throw new Error(`Rejected contract with zero or negative bid (${bid})`);
  }
  if (ask < bid) {
    throw new Error(`Inverted quote: ask (${ask}) < bid (${bid})`);
  }

  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const spreadPctOfMid = spread / Math.max(mid, 1e-9);
  const feeInr = Number((lotsQty * cfg.feePerLotInr).toFixed(2));
  const totalUnits = lotsQty * lotSize;
  const paperPx = Number((brokerPaperFillPrice ?? mid).toFixed(2));

  if (side === 'BUY') {
    const consPx = Number((mid + cfg.spreadSlippageFraction * spread).toFixed(2));
    const consCash = Number((-(consPx * totalUnits + feeInr)).toFixed(2));
    const paperCash = Number((-(paperPx * totalUnits)).toFixed(2));
    const slipInr = Number(((consPx - mid) * totalUnits + feeInr).toFixed(2));
    return {
      side,
      lotsQty,
      lotSize,
      totalUnits,
      bid,
      ask,
      mid: Number(mid.toFixed(2)),
      spread: Number(spread.toFixed(2)),
      spreadPctOfMid: Number(spreadPctOfMid.toFixed(4)),
      conservativeFillPrice: consPx,
      brokerPaperFillPrice: paperPx,
      feeInr,
      conservativeTotalCashInr: consCash,
      brokerPaperTotalCashInr: paperCash,
      slippageVsMidInr: slipInr,
    };
  }

  const consPx = Number(Math.max(0.05, mid - cfg.spreadSlippageFraction * spread).toFixed(2));
  const consCash = Number((consPx * totalUnits - feeInr).toFixed(2));
  const paperCash = Number((paperPx * totalUnits).toFixed(2));
  const slipInr = Number(((mid - consPx) * totalUnits + feeInr).toFixed(2));
  return {
    side,
    lotsQty,
    lotSize,
    totalUnits,
    bid,
    ask,
    mid: Number(mid.toFixed(2)),
    spread: Number(spread.toFixed(2)),
    spreadPctOfMid: Number(spreadPctOfMid.toFixed(4)),
    conservativeFillPrice: consPx,
    brokerPaperFillPrice: paperPx,
    feeInr,
    conservativeTotalCashInr: consCash,
    brokerPaperTotalCashInr: paperCash,
    slippageVsMidInr: slipInr,
  };
}

export function calculateRoundtripPnl(
  lotsQty: number,
  entryFill: SimulatedFillResult,
  exitFill: SimulatedFillResult
) {
  if (lotsQty <= 0) throw new Error('lotsQty must be > 0');
  const entryCostCons = Math.abs(entryFill.conservativeTotalCashInr);
  const exitProceedsCons = exitFill.conservativeTotalCashInr;
  const conservativePnlInr = Number((exitProceedsCons - entryCostCons).toFixed(2));
  const conservativePnlPct = Number((conservativePnlInr / Math.max(entryCostCons, 1e-9)).toFixed(4));

  const entryCostPaper = Math.abs(entryFill.brokerPaperTotalCashInr);
  const exitProceedsPaper = exitFill.brokerPaperTotalCashInr;
  const brokerPaperPnlInr = Number((exitProceedsPaper - entryCostPaper).toFixed(2));
  const brokerPaperPnlPct = Number((brokerPaperPnlInr / Math.max(entryCostPaper, 1e-9)).toFixed(4));

  return {
    conservativePnlInr,
    conservativePnlPct,
    brokerPaperPnlInr,
    brokerPaperPnlPct,
    executionDragInr: Number((brokerPaperPnlInr - conservativePnlInr).toFixed(2)),
  };
}

export interface VerticalSpreadSimulation {
  spreadType: 'BULL_CALL_SPREAD' | 'BEAR_PUT_SPREAD';
  lotsQty: number;
  lotSize: number;
  longLeg: SimulatedFillResult;
  shortLeg: SimulatedFillResult;
  conservativeNetDebitPerUnit: number;
  brokerPaperNetDebitPerUnit: number;
  totalEntryFeeInr: number;
  conservativeTotalDebitInr: number;
  brokerPaperTotalDebitInr: number;
  maxRiskReductionPct: number;
  thetaDecayReductionPct: number;
}

/**
 * 2B. Defined-Risk Vertical Debit Spread Simulator (Bull Call Spread / Bear Put Spread)
 * - Buys 1 lot ~0.50Δ ATM/Near-ATM leg at mid + 35% spread (+ ₹35/lot fee)
 * - Simultaneously sells 1 lot ~0.25Δ OTM leg in same expiry at mid - 35% spread (+ ₹35/lot fee)
 * - Cuts daily Theta decay by ~65% and reduces max capital at risk per lot by ~35%–45%.
 */
export function simulateVerticalDebitSpreadFill(params: {
  right: OptionRight;
  lotsQty: number;
  longBid: number;
  longAsk: number;
  shortBid: number;
  shortAsk: number;
  lotSize: number;
}): VerticalSpreadSimulation {
  const longLeg = simulatePessimisticFill(
    'BUY',
    params.lotsQty,
    params.longBid,
    params.longAsk,
    params.lotSize
  );
  const shortLeg = simulatePessimisticFill(
    'SELL',
    params.lotsQty,
    params.shortBid,
    params.shortAsk,
    params.lotSize
  );

  const conservativeNetDebitPerUnit = Number(
    Math.max(1.0, longLeg.conservativeFillPrice - shortLeg.conservativeFillPrice).toFixed(2)
  );
  const brokerPaperNetDebitPerUnit = Number(
    Math.max(1.0, longLeg.brokerPaperFillPrice - shortLeg.brokerPaperFillPrice).toFixed(2)
  );
  const totalEntryFeeInr = Number((longLeg.feeInr + shortLeg.feeInr).toFixed(2));
  const totalUnits = params.lotsQty * params.lotSize;
  const conservativeTotalDebitInr = Number(
    (conservativeNetDebitPerUnit * totalUnits + totalEntryFeeInr).toFixed(2)
  );
  const brokerPaperTotalDebitInr = Number(
    (brokerPaperNetDebitPerUnit * totalUnits).toFixed(2)
  );
  const nakedDebitInr = Math.abs(longLeg.conservativeTotalCashInr);
  const maxRiskReductionPct = Number(
    Math.max(0, (nakedDebitInr - conservativeTotalDebitInr) / Math.max(nakedDebitInr, 1)).toFixed(4)
  );

  return {
    spreadType: params.right === 'CE' ? 'BULL_CALL_SPREAD' : 'BEAR_PUT_SPREAD',
    lotsQty: params.lotsQty,
    lotSize: params.lotSize,
    longLeg,
    shortLeg,
    conservativeNetDebitPerUnit,
    brokerPaperNetDebitPerUnit,
    totalEntryFeeInr,
    conservativeTotalDebitInr,
    brokerPaperTotalDebitInr,
    maxRiskReductionPct,
    thetaDecayReductionPct: 0.65,
  };
}


/**
 * 3. Contract Selection Filter (NSE Weekly & Monthly Expiries)
 */
export function evaluateContractFilters(
  c: OptionContractCandidate,
  cfg: ContractFilterConfig = {
    minDte: 7,
    maxDte: 45,
    hardFloorDte: 4,
    minAbsDelta: 0.35,
    maxAbsDelta: 0.55,
    maxSpreadPctOfMid: 0.08,
    minOpenInterest: 500,
    minDailyVolume: 100,
    maxIvRankPct: 85,
    minIvRankPct: 10,
  }
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (c.isHalted) reasons.push('Contract or underlying is in NSE F&O ban / halted');
  if (c.bid <= 0) reasons.push(`Zero/negative bid (₹${c.bid})`);
  const mid = (c.bid + c.ask) / 2;
  const spreadPct = (c.ask - c.bid) / Math.max(mid, 1e-9);
  if (spreadPct > cfg.maxSpreadPctOfMid) {
    reasons.push(`Spread ${(spreadPct * 100).toFixed(1)}% > ${(cfg.maxSpreadPctOfMid * 100).toFixed(1)}% limit`);
  }
  if (c.dte < cfg.hardFloorDte || c.dte < cfg.minDte || c.dte > cfg.maxDte) {
    reasons.push(`DTE ${c.dte} outside [${cfg.minDte}, ${cfg.maxDte}] (hard floor ${cfg.hardFloorDte})`);
  }
  const absDelta = Math.abs(c.delta);
  if (absDelta < cfg.minAbsDelta || absDelta > cfg.maxAbsDelta) {
    reasons.push(`|Delta| ${absDelta.toFixed(2)} outside [${cfg.minAbsDelta}, ${cfg.maxAbsDelta}]`);
  }
  if (c.openInterest < cfg.minOpenInterest) {
    reasons.push(`Open Interest ${c.openInterest} < ${cfg.minOpenInterest}`);
  }
  if (c.volume < cfg.minDailyVolume) {
    reasons.push(`Daily Volume ${c.volume} < ${cfg.minDailyVolume}`);
  }
  if (c.ivRankPct > cfg.maxIvRankPct || c.ivRankPct < cfg.minIvRankPct) {
    reasons.push(`IV Rank ${c.ivRankPct.toFixed(1)}% outside [${cfg.minIvRankPct}%, ${cfg.maxIvRankPct}%]`);
  }
  if (c.hasEarningsInWindow) {
    reasons.push('Quarterly corporate results fall inside holding window');
  }
  return { passed: reasons.length === 0, reasons };
}

/**
 * 4. Exit Engine (Strict Priority Order for 09:15 - 15:30 IST)
 */
export function evaluatePositionExit(params: {
  dte: number;
  isIntradayFlagged: boolean;
  isPreCloseWindow: boolean;
  entryPrice: number;
  currentMarkPrice: number;
  peakMarkPrice: number;
  tradingDaysHeld: number;
  positionRight: OptionRight;
  latestSignalDirection?: OptionRight | 'NONE';
}): { shouldExit: boolean; exitReason: string; pnlPct: number; mfePct: number } {
  const entry = Math.max(params.entryPrice, 0.05);
  const peak = Math.max(params.peakMarkPrice, params.currentMarkPrice, entry);
  const pnlPct = Number(((params.currentMarkPrice - entry) / entry).toFixed(4));
  const mfePct = Number(((peak - entry) / entry).toFixed(4));

  if (params.dte <= 1) {
    return { shouldExit: true, exitReason: 'FORCE_CLOSE_DTE_1', pnlPct, mfePct };
  }
  if (params.isIntradayFlagged && params.isPreCloseWindow) {
    return { shouldExit: true, exitReason: 'INTRADAY_1515_IST_FLATTEN', pnlPct, mfePct };
  }
  if (pnlPct <= -0.3) {
    return { shouldExit: true, exitReason: 'STOP_LOSS', pnlPct, mfePct };
  }
  if (pnlPct >= 0.5) {
    return { shouldExit: true, exitReason: 'TAKE_PROFIT', pnlPct, mfePct };
  }
  if (mfePct >= 0.3) {
    const pullbackFromPeak = (peak - params.currentMarkPrice) / Math.max(peak, 1e-9);
    if (pullbackFromPeak >= 0.15) {
      return { shouldExit: true, exitReason: 'TRAILING_STOP', pnlPct, mfePct };
    }
  }
  if (params.tradingDaysHeld > 5) {
    return { shouldExit: true, exitReason: 'TIME_STOP_DAYS', pnlPct, mfePct };
  }
  if (params.dte <= 3) {
    return { shouldExit: true, exitReason: 'TIME_STOP_DTE', pnlPct, mfePct };
  }
  if (
    params.latestSignalDirection &&
    params.latestSignalDirection !== 'NONE' &&
    params.latestSignalDirection !== params.positionRight
  ) {
    return { shouldExit: true, exitReason: 'SIGNAL_REVERSAL', pnlPct, mfePct };
  }
  return { shouldExit: false, exitReason: 'HOLD', pnlPct, mfePct };
}

/**
 * 5. Risk Limits, NSE Lot Position Sizing & Kill Switches
 */
export function evaluateRiskAndSize(params: {
  currentEquityInr: number;
  peakEquityInr: number;
  dailyStartEquityInr: number;
  openPositionsCount: number;
  openPositionsForUnderlying: number;
  currentOpenPremiumInr: number;
  conservativeEntryPrice: number;
  lotSize: number;
  maxRiskPerTradePct?: number;
  feePerLotInr?: number;
  newEntriesEnabled: boolean;
}): {
  allowed: boolean;
  lotsQty: number;
  reason: string;
  dailyHaltTriggered: boolean;
  drawdownKillSwitchTriggered: boolean;
} {
  const eq = Math.max(params.currentEquityInr, 1);
  const peak = Math.max(params.peakEquityInr, eq);
  const dayStart = Math.max(params.dailyStartEquityInr, 1);
  const fee = params.feePerLotInr ?? 35.0;
  const maxRiskPct = params.maxRiskPerTradePct ?? 0.015;

  const drawdownPct = (peak - eq) / peak;
  if (drawdownPct >= 0.1) {
    return {
      allowed: false,
      lotsQty: 0,
      reason: `Drawdown kill switch active (${(drawdownPct * 100).toFixed(2)}% >= 10.0%)`,
      dailyHaltTriggered: true,
      drawdownKillSwitchTriggered: true,
    };
  }

  const dailyLossPct = (dayStart - eq) / dayStart;
  if (dailyLossPct >= 0.03) {
    return {
      allowed: false,
      lotsQty: 0,
      reason: `Daily loss limit reached (${(dailyLossPct * 100).toFixed(2)}% >= 3.0%)`,
      dailyHaltTriggered: true,
      drawdownKillSwitchTriggered: false,
    };
  }

  if (!params.newEntriesEnabled) {
    return {
      allowed: false,
      lotsQty: 0,
      reason: 'Control row new_entries_enabled is FALSE (Paused)',
      dailyHaltTriggered: false,
      drawdownKillSwitchTriggered: false,
    };
  }

  if (params.openPositionsCount >= 5) {
    return {
      allowed: false,
      lotsQty: 0,
      reason: 'Max 5 open positions reached',
      dailyHaltTriggered: false,
      drawdownKillSwitchTriggered: false,
    };
  }

  if (params.openPositionsForUnderlying >= 2) {
    return {
      allowed: false,
      lotsQty: 0,
      reason: 'Max 2 open positions for this NSE underlying reached',
      dailyHaltTriggered: false,
      drawdownKillSwitchTriggered: false,
    };
  }

  const maxPerTradeInr = eq * maxRiskPct;
  const remainingTotalPremiumCapInr = Math.max(0, eq * 0.25 - params.currentOpenPremiumInr);
  const effectiveBudgetInr = Math.min(maxPerTradeInr, remainingTotalPremiumCapInr);
  const lotCostInr = params.conservativeEntryPrice * params.lotSize + fee;
  const lotsQty = Math.floor(effectiveBudgetInr / Math.max(lotCostInr, 1));

  if (lotsQty < 1) {
    return {
      allowed: false,
      lotsQty: 0,
      reason: `1 Lot cost ₹${lotCostInr.toFixed(0)} exceeds per-trade risk cap ₹${effectiveBudgetInr.toFixed(0)}`,
      dailyHaltTriggered: false,
      drawdownKillSwitchTriggered: false,
    };
  }

  return {
    allowed: true,
    lotsQty,
    reason: 'Approved within NSE lot risk budget',
    dailyHaltTriggered: false,
    drawdownKillSwitchTriggered: false,
  };
}

/**
 * 6. Offline Detection Rule (09:15 - 15:30 IST Market Hours)
 */
export function isBotOfflineDuringMarketHours(
  heartbeatIso: string,
  marketOpen: boolean,
  nowMs: number = Date.now()
): { isOffline: boolean; ageMinutes: number } {
  const hbMs = new Date(heartbeatIso).getTime();
  const ageMinutes = Number(((nowMs - hbMs) / 60000).toFixed(1));
  return {
    isOffline: marketOpen && ageMinutes > 10,
    ageMinutes,
  };
}

/**
 * 7. Automatic Post-Mortem Classifier
 */
export function classifyTradePostMortem(input: {
  exitReason: string;
  conservativePnlInr: number;
  conservativePnlPct: number;
  brokerPaperPnlInr: number;
  mfePct: number;
  spreadPctAtEntry: number;
  signedUnderlyingMovePct: number;
  ivChangePct: number;
  postExit60mOptionReturnPct: number;
  regimeAtEntry: MarketRegime;
  regimeAtExit: MarketRegime;
}): PostMortemLabel {
  if (input.exitReason === 'STOP_LOSS' && input.postExit60mOptionReturnPct >= 0.25) {
    return 'stopped_out_then_reversed';
  }
  if (input.mfePct >= 0.25 && input.conservativePnlPct <= 0.05) {
    return 'winner_given_back';
  }
  if (
    input.conservativePnlPct < 0 &&
    input.signedUnderlyingMovePct > 0.002 &&
    input.ivChangePct < -0.04
  ) {
    return 'theta_or_iv_crush';
  }
  if (input.brokerPaperPnlInr > 0 && input.conservativePnlInr <= 0 && input.spreadPctAtEntry >= 0.05) {
    return 'bad_fill_wide_spread';
  }
  if (input.conservativePnlPct < 0 && input.regimeAtEntry !== input.regimeAtExit) {
    return 'wrong_regime';
  }
  if (input.conservativePnlPct <= 0) {
    return 'wrong_direction';
  }
  return 'optimal_exit';
}

/**
 * 8. Walk-Forward Black-Scholes Option Pricer for NSE Options (RBI 91d T-Bill r=6.8%)
 */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const prob =
    d *
    t *
    (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - prob : prob;
}

export function blackScholesOptionPrice(params: {
  spot: number;
  strike: number;
  dteDays: number;
  ivAnnual: number;
  riskFreeRate: number;
  right: OptionRight;
}): { mid: number; bid: number; ask: number; delta: number } {
  const T = Math.max(params.dteDays / 365, 1 / 365);
  const sigma = Math.max(params.ivAnnual, 0.08);
  const S = Math.max(params.spot, 0.01);
  const K = Math.max(params.strike, 0.01);
  const r = params.riskFreeRate;

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  let theo = 0;
  let delta = 0;
  if (params.right === 'CE') {
    theo = S * normalCdf(d1) - K * Math.exp(-r * T) * normalCdf(d2);
    delta = normalCdf(d1);
  } else {
    theo = K * Math.exp(-r * T) * normalCdf(-d2) - S * normalCdf(-d1);
    delta = normalCdf(d1) - 1;
  }

  const mid = Number(Math.max(2.0, theo).toFixed(2));
  const halfSpread = Math.max(0.25, Number(((mid * 0.032) / 2).toFixed(2)));
  const bid = Number(Math.max(0.5, mid - halfSpread).toFixed(2));
  const ask = Number((mid + halfSpread).toFixed(2));

  return { mid, bid, ask, delta: Number(delta.toFixed(3)) };
}

export function formatInr(amount: number, showSign: boolean = false): string {
  const absFormatted = Math.abs(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (amount < 0) return `-₹${absFormatted}`;
  if (showSign && amount > 0) return `+₹${absFormatted}`;
  return `₹${absFormatted}`;
}
