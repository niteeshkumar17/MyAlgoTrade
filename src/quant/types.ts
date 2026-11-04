/**
 * Shared types for the paper-training engine, the API and the dashboard.
 * Everything here is plain data so it can be persisted as JSON and imported by the UI as types only.
 */

export type OptionRight = 'CE' | 'PE';
export type StrategyName = 'trend_following' | 'mean_reversion' | 'breakout_momentum';
export type MarketRegime = 'trending_up' | 'trending_down' | 'range' | 'high_volatility';

export const UNDERLYINGS = [
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'RELIANCE',
  'TCS',
  'HDFCBANK',
  'INFY',
  'ICICIBANK',
  'SBIN',
  'BHARTIARTL',
  'ITC',
  'KOTAKBANK',
  'LT',
  'AXISBANK',
  'BAJFINANCE',
  'MARUTI',
  'ASIANPAINT',
  'SUNPHARMA',
  'TITAN',
  'ULTRACEMCO',
  'TATASTEEL',
  'NTPC',
  'M&M',
  'POWERGRID',
  'ADANIENT',
  'BAJAJFINSV',
  'WIPRO',
  'COALINDIA',
  'JSWSTEEL',
  'HINDALCO',
  'ONGC',
  'GRASIM',
  'TECHM',
  'HCLTECH',
] as const;

export const INDEX_UNDERLYINGS = new Set<string>(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']);

export const WATCHLIST_SYMBOLS = [
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'INDIA_VIX',
  'RELIANCE',
  'TCS',
  'HDFCBANK',
  'INFY',
  'ICICIBANK',
  'SBIN',
  'BHARTIARTL',
  'ITC',
  'KOTAKBANK',
  'LT',
  'AXISBANK',
  'BAJFINANCE',
  'MARUTI',
  'ASIANPAINT',
  'SUNPHARMA',
  'TITAN',
  'ULTRACEMCO',
  'TATASTEEL',
  'NTPC',
  'M&M',
  'POWERGRID',
  'ADANIENT',
  'BAJAJFINSV',
  'WIPRO',
  'COALINDIA',
  'JSWSTEEL',
  'HINDALCO',
  'ONGC',
  'GRASIM',
  'TECHM',
  'HCLTECH',
] as const;

export interface Candle {
  time: string; // bar start, ISO with +05:30 offset (as returned by Angel One)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface NfoInstrument {
  token: string;
  symbol: string;
  underlying: string;
  expiry: string; // YYYY-MM-DD
  strike: number;
  right: OptionRight;
  lotSize: number;
  tickSize: number;
}

export interface LegQuote {
  token: string;
  ltp: number;
  bid: number; // 0 when the order book has no buyers
  ask: number; // 0 when the order book has no sellers
  hasDepth: boolean;
  feedTimeMs: number | null; // exchange feed timestamp, null if the broker did not send one
  volume: number;
  oi: number;
}

export interface SpotQuote {
  symbol: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  changePct: number;
  feedTimeMs: number | null;
}

export type ExitReason =
  | 'TAKE_PROFIT'
  | 'TRAIL_STOP'
  | 'STOP_LOSS'
  | 'TIME_STOP'
  | 'EXPIRY_RISK'
  | 'STALE_DATA_FORCED';

export type ExitRuleVersion = 'LADDER_V2' | 'RUNNER_V3' | 'RUNNER_V3_1' | 'ADAPTIVE_LEARNED';

export interface ChallengerEngineTradeLog {
  floor: number;
  lockedProfitPerLotInr: number;
  exitValue?: number;
  exitReason?: ExitReason;
  pnlPerLotInr?: number;
}

export interface SpreadLegSnapshot {
  token: string;
  symbol: string;
  strike: number;
  bid: number;
  ask: number;
}

/** A vertical debit spread priced from an order-book snapshot (per unit unless stated otherwise). */
export interface SpreadPlan {
  underlying: string;
  right: OptionRight;
  expiry: string;
  dte: number;
  lotSize: number;
  spotAtEntry: number;
  long: SpreadLegSnapshot;
  short: SpreadLegSnapshot;
  width: number;
  entryDebit: number; // long ask - short bid
  midDebit: number;
  debitRatio: number; // entryDebit / width
  legSpreadPct: number; // average (ask - bid) / mid of both legs
  entryChargesPerLot: number;
  exitChargesWorstPerLot: number;
  maxLossPerLot: number; // debit + all charges if the spread expires worthless
  maxGainPerLot: number; // width - debit - charges if the spread finishes fully in the money
}

export interface SpreadMark {
  at: string;
  longBid: number;
  longAsk: number;
  shortBid: number;
  shortAsk: number;
  liquidationValue: number; // long bid - short ask: what closing right now would realise per unit
  midValue: number;
}

export interface IndicatorSnapshot {
  ema20: number;
  ema50: number;
  rsi14: number;
  adx14: number;
  plusDi: number;
  minusDi: number;
  atrPct: number;
  pctB: number;
  ret7: number;
  ret35: number;
}

/**
 * Every signal that can be priced becomes a candidate and is tracked to its exit on real quotes,
 * whether or not the paper ledger takes it. Closed candidates are the model's training labels.
 */
export interface Candidate {
  id: string;
  createdAt: string;
  underlying: string;
  strategy: StrategyName;
  direction: OptionRight;
  regime: MarketRegime;
  signalBarStart: string;
  reason: string;
  indicators: IndicatorSnapshot;
  vix: number;
  vixPctile: number;
  features: number[];
  modelProb: number | null;
  modelVersion: string | null;
  gateActive: boolean;
  gateThreshold: number | null;
  plan: SpreadPlan;
  affordable: boolean;
  takenByLedger: boolean;
  positionId: string | null;
  skipReason: string | null;
  lastMark: SpreadMark | null;
  peakValue: number;
  troughValue: number;
  /** Sliding window of last N valid marks used to compute median confirmedPeakValue (P). */
  recentMarks?: number[];
  /** Confirmed peak mark P (median of recent marks / bar closes) so one glitchy tick never raises P. */
  confirmedPeakValue?: number;
  /** Exit rule version frozen at entry so rules never change on an already open trade. */
  exitRuleVersion?: ExitRuleVersion;
  /** True once MFE% >= 30% and the underlying Trend Gate passed. */
  runnerArmed?: boolean;
  /** Monotonic Runner Mode v3 floor: max(previousFloor, E + 0.667 * (P - E)). */
  runnerFloor?: number;
  /** Monotonic Runner Mode v3.1 floor: allowed fall 20% -> 33.3% from 30% -> 60% MFE. */
  runnerFloorV31?: number;
  /** Monotonic Self-Learning Adaptive floor combining RUNNER_V3_1 with learned runner/stagnation probabilities. */
  runnerFloorLearned?: number;
  runnerTrendGatePassed?: boolean | null;
  runnerTrendGateReason?: string | null;
  /** Self-learning exit model's predicted P(Eventual MFE >= 60% | Reached 30%, features). */
  learnedRunnerProb?: number | null;
  /** Self-learning exit model's predicted P(Profitable Recovery | features, sessionsHeld, mfeFrac). */
  learnedRecoveryProb?: number | null;
  /** Learned initial keep fraction at 30% MFE (adapts between 0.667 for big runners and 0.82 for staller protection). */
  learnedKeepFrac?: number | null;
  /** True when the self-learning exit policy tightens the stop early due to multi-session stagnation/reversal. */
  learnedEarlyStopTightened?: boolean;
  /** Human-readable explanation of the self-learning exit policy's current action on this trade. */
  learnedExitAction?: string | null;
  /** Counterfactual exit value if the fixed-30% rule had been used instead of Runner Mode (or vice-versa). */
  counterfactualFixed30ExitValue?: number;
  counterfactualFixed30PnlPerLotInr?: number;
  /** Counterfactual exit value and PnL under RUNNER_V3_1 (20% -> 33.3% tapered allowed fall). */
  counterfactualV31ExitValue?: number;
  counterfactualV31PnlPerLotInr?: number;
  /** Counterfactual exit value and PnL under ADAPTIVE_LEARNED. */
  counterfactualLearnedExitValue?: number;
  counterfactualLearnedPnlPerLotInr?: number;
  /** Per-trade Challenger Registry snapshot across LADDER_V2, RUNNER_V3, RUNNER_V3_1, and ADAPTIVE_LEARNED. */
  challengerEngines?: Record<ExitRuleVersion, ChallengerEngineTradeLog>;
  sessionsHeld: number;
  lastSessionDate: string;
  staleMarks: number;
  closedAt?: string;
  exitReason?: ExitReason;
  exitValue?: number;
  pnlPerLotInr?: number;
  pnlPerLotMidInr?: number;
  rMultiple?: number;
  win?: boolean;
}

export interface PaperPosition {
  id: string;
  candidateId: string;
  openedAt: string;
  underlying: string;
  strategy: StrategyName;
  direction: OptionRight;
  regime: MarketRegime;
  lots: number;
  plan: SpreadPlan;
  features?: number[];
  entryCashOutInr: number;
  maxLossInr: number;
  marginBlockedInr: number;
  lastMark: SpreadMark | null;
  peakValue: number;
  troughValue: number;
  recentMarks?: number[];
  confirmedPeakValue?: number;
  exitRuleVersion?: ExitRuleVersion;
  runnerArmed?: boolean;
  runnerFloor?: number;
  runnerFloorV31?: number;
  runnerFloorLearned?: number;
  runnerTrendGatePassed?: boolean | null;
  runnerTrendGateReason?: string | null;
  learnedRunnerProb?: number | null;
  learnedRecoveryProb?: number | null;
  learnedKeepFrac?: number | null;
  learnedEarlyStopTightened?: boolean;
  learnedExitAction?: string | null;
  counterfactualFixed30ExitValue?: number;
  counterfactualV31ExitValue?: number;
  counterfactualLearnedExitValue?: number;
  challengerEngines?: Record<ExitRuleVersion, ChallengerEngineTradeLog>;
  sessionsHeld: number;
  lastSessionDate: string;
  staleMarks: number;
  /** Market MTM P&L: (current liquidation mark - entry debit) * qty, matching professional broker terminals. */
  unrealizedInr: number;
  /** Net P&L after deducting both entry and estimated exit brokerage + statutory charges. */
  netUnrealizedInr?: number;
  /** Total estimated round-trip (4-order) brokerage + statutory charges for this position. */
  estChargesInr?: number;
  /** Individual MTM P&L on the long option leg. */
  longLegPnlInr?: number;
  /** Individual MTM P&L on the short hedge option leg. */
  shortLegPnlInr?: number;
  modelProb: number | null;
  entryReason: string;
}

export interface ClosedTrade {
  id: string;
  candidateId: string;
  underlying: string;
  strategy: StrategyName;
  direction: OptionRight;
  regimeAtEntry: MarketRegime;
  lots: number;
  lotSize: number;
  expiry: string;
  dteAtEntry: number;
  longSymbol: string;
  shortSymbol: string;
  longStrike: number;
  shortStrike: number;
  width: number;
  openedAt: string;
  closedAt: string;
  holdMinutes: number;
  sessionsHeld: number;
  entryDebit: number;
  exitValue: number;
  entryCashOutInr: number;
  exitCashInInr: number;
  chargesInr: number;
  netPnlInr: number;
  pnlAtMidInr: number;
  maxLossInr: number;
  rMultiple: number;
  /** Peak confirmed mark P since entry. */
  confirmedPeakValue?: number;
  /** MFE% of Max Gain: (P - E) / (W - E). */
  mfeOfMaxGainPct?: number;
  mfePct: number;
  maePct: number;
  exitReason: ExitReason;
  exitRuleVersion?: ExitRuleVersion;
  runnerArmed?: boolean;
  runnerTrendGatePassed?: boolean | null;
  learnedRunnerProb?: number | null;
  learnedRecoveryProb?: number | null;
  learnedKeepFrac?: number | null;
  /** What the fixed-30% rule would have returned on this trade (counterfactual). */
  counterfactualFixed30PnlInr?: number;
  /** What RUNNER_V3_1 would have returned on this trade (counterfactual). */
  counterfactualV31PnlInr?: number;
  /** What ADAPTIVE_LEARNED would have returned on this trade (counterfactual). */
  counterfactualLearnedPnlInr?: number;
  challengerEngines?: Record<ExitRuleVersion, ChallengerEngineTradeLog>;
  modelProb: number | null;
  entryReason: string;
}

export interface EquityPoint {
  t: string;
  equity: number; // cash + open positions at liquidation value net of exit charges
  equityMid: number; // cash + open positions at mid prices (optimistic reference)
  cash: number;
  benchmark: number | null; // starting capital invested in NIFTY at ledger start
  drawdownPct: number;
  openPositions: number;
}

export type LogKind =
  | 'CYCLE'
  | 'SIGNAL'
  | 'ENTRY'
  | 'SKIP'
  | 'EXIT'
  | 'CANDIDATE'
  | 'RISK'
  | 'DATA'
  | 'ADMIN'
  | 'MODEL'
  | 'ERROR';

export interface LogEntry {
  t: string;
  kind: LogKind;
  underlying?: string;
  message: string;
}

export interface GateStatus {
  active: boolean;
  threshold: number | null;
  source: 'LIVE' | 'OFFLINE' | 'NONE';
  reason: string;
}

export interface OosMetrics {
  n: number;
  auc: number | null;
  avgR: number | null;
  threshold: number | null;
  acceptedN: number;
  acceptedAvgR: number | null;
}

export interface CalibrationBucket {
  lo: number;
  hi: number;
  n: number;
  avgPred: number;
  winRate: number;
}

export interface ExitPolicySnapshot {
  version: string;
  trainedAt: string;
  baseEngine: ExitRuleVersion;
  nOffline: number;
  nLive: number;
  nReached30: number;
  /** Logistic regression head predicting P(Eventual MFE >= 60% | Reached 30%, features). */
  runnerMeans: number[];
  runnerStds: number[];
  runnerWeights: number[];
  runnerBias: number;
  runnerOosAuc: number | null;
  /** Logistic regression head predicting P(Profitable Recovery | features) for early stagnation stop tightening. */
  recoveryMeans: number[];
  recoveryStds: number[];
  recoveryWeights: number[];
  recoveryBias: number;
  recoveryOosAuc: number | null;
  /** Out-of-sample expectancy and lift over fixed engines. */
  oosExpectancyInr: number;
  oosLiftOverLadderInr: number;
  oosLiftOverV31Inr: number;
  oosEarlyStopsSavedCount: number;
  topRunnerDrivers: Array<{ feature: string; weight: number }>;
  summaryNote: string;
}

export interface ModelSnapshot {
  version: string;
  trainedAt: string;
  featureNames: string[];
  means: number[];
  stds: number[];
  weights: number[];
  bias: number;
  lambda: number;
  nOffline: number;
  nLive: number;
  offlineWeight: number;
  offlineOos: OosMetrics;
  liveOos: OosMetrics;
  calibration: CalibrationBucket[];
  gate: GateStatus;
  exitPolicy?: ExitPolicySnapshot;
}

export interface EngineConfig {
  startingCapitalInr: number;
  riskPerTradePct: number;
  maxOpenPositions: number;
  maxOpenRiskPct: number;
  maxPositionsPerUnderlying: number;
  dailyLossHaltPct: number;
  drawdownKillPct: number;
  maxCapitalUsePct: number;
  exposureMarginPctIndex: number;
  exposureMarginPctStock: number;
  entryStartMinuteIst: number;
  entryEndMinuteIst: number;
  minDte: number;
  maxDte: number;
  exitAtDte: number;
  takeProfitFracOfMaxGain: number;
  stopLossFracOfDebit: number;
  maxHoldSessions: number;
  /** Runner Mode v3: MFE% of maxGain at which Runner Mode evaluates the Trend Gate (default 0.30). */
  runnerArmMfeFrac?: number;
  /** Runner Mode v3: Fraction of peak profit locked by the continuous trail once armed (default 2/3 = 0.6667). */
  runnerKeepFrac?: number;
  /** Runner Mode v3: Hard ceiling MFE% of maxGain for Runner Mode exits (default 0.75). */
  runnerCeilingFracOfMaxGain?: number;
  /** Runner Mode v3: Minimum ADX(14) required at arming (default 20). */
  runnerMinAdx?: number;
  /** Runner Mode v3: Minimum net spread delta required at arming (default 0.20). */
  runnerMinNetDelta?: number;
  /** Runner Mode v3: Minimum trading days to expiry required at arming (default 7). */
  runnerMinTradingDte?: number;
  maxLegSpreadPct: number;
  minLongLegPrice: number;
  maxShortSteps: number;
  minDebitRatio: number;
  maxDebitRatio: number;
  quoteMaxAgeSec: number;
  cycleMinIntervalSec: number;
}

export interface MarketSnapshot {
  at: string;
  live: boolean;
  liveReason: string;
  spots: Record<string, SpotQuote>;
  vix: number | null;
  vixPctile: number | null;
  regimes: Record<string, { regime: MarketRegime; rsi14: number; adx14: number; barStart: string }>;
}

export interface AngelStatusSnapshot {
  configured: boolean;
  authenticated: boolean;
  lastLoginAt: string | null;
  lastQuoteFetchAt: string | null;
  lastError: string | null;
}

export interface LiveSampleRecord {
  id: string;
  x: number[];
  y: 0 | 1;
  r: number;
  pnlPerLotInr: number;
  entryMs: number;
  exitMs: number;
  strategy: StrategyName;
  underlying: string;
  direction: OptionRight;
  regime: MarketRegime;
  exitReason: ExitReason;
  mfeMaxFrac?: number;
  sessionsHeld?: number;
  pnlLadderV2Inr?: number;
  pnlRunnerV3Inr?: number;
  pnlRunnerV31Inr?: number;
}

export interface ClosedSummary {
  id: string;
  closedAt: string;
  underlying: string;
  strategy: StrategyName;
  direction: OptionRight;
  regime: MarketRegime;
  exitReason: ExitReason;
  netPnlInr: number;
  rMultiple: number;
}

export interface ReadinessCheck {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface ReadinessReport {
  readyForRealMoney: boolean;
  checks: ReadinessCheck[];
  note: string;
}

export interface LedgerState {
  schema: 2;
  ledgerId: string;
  createdAt: string;
  startingCapitalInr: number;
  config: EngineConfig;
  cash: number;
  peakEquity: number;
  maxDrawdownPct: number;
  lastEquity: number;
  lastEquityMid: number;
  dayDate: string | null;
  dayStartEquity: number;
  dailyHalt: boolean;
  killSwitch: { active: boolean; reason: string | null; at: string | null };
  control: { entriesEnabled: boolean; updatedAt: string; updatedBy: string };
  benchmarkStartNifty: number | null;
  openPositions: PaperPosition[];
  activeCandidates: Candidate[];
  lastSignalBar: Record<string, string>;
  counters: {
    cycles: number;
    tradingCycles: number;
    candidatesCreated: number;
    candidatesClosed: number;
    tradesOpened: number;
    tradesClosed: number;
    plansRejected: number;
    staleMarks: number;
    dataErrors: number;
  };
  lastCycle: {
    at: string;
    durationMs: number;
    status: 'TRADED' | 'MARKET_CLOSED' | 'MARKET_NOT_LIVE' | 'DATA_ERROR' | 'OFF_HOURS';
    summary: string;
  } | null;
  lastEquityPointAt: string | null;
  market: MarketSnapshot | null;
  angel: AngelStatusSnapshot | null;
  instrumentsAsOf: string | null;
  model: ModelSnapshot | null;
  liveLabelsAtLastTrain: number;
  /** One row per closed shadow candidate. These are the live training labels. */
  liveSamples: LiveSampleRecord[];
  /** One row per closed paper-ledger trade, used for the go/no-go checks. */
  closedSummaries: ClosedSummary[];
  recentEquity: EquityPoint[];
  decisionLog: LogEntry[];
  learningLog: LogEntry[];
  pending: {
    trades: ClosedTrade[];
    candidates: Candidate[];
    equity: EquityPoint[];
  };
}
