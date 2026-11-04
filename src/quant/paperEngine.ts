/**
 * Paper-training cycle.
 *
 * Every signal that can be priced on the live order book becomes a shadow candidate and is held to
 * its exit, so the model gets a label either way. The ₹ ledger takes a subset that fits the risk
 * limits and, once the gate has earned it, the model's ranking. No order is ever sent to a broker.
 */

import { calendarDaysBetween, formatIstForAngel, hourlyBarEndMs, istDate, istMonthKey, istParts, isWithinSessionHours } from './clock.js';
import { computeIndicators, isRowComplete, snapshotOf } from './indicators.js';
import type { MarketData } from './marketData.js';
import { predictExitDecision, predictProb, suspendedStrategies, trainModelSnapshot, type Sample } from './model.js';
import {
  buildSpreadPlan,
  estimateSpreadNetDelta,
  evaluateRunnerTrendGate,
  evaluateSpreadExit,
  exitChargesFor,
  exitLevels,
  markSpread,
  selectChainLegs,
  updateConfirmedMark,
} from './options.js';
import { buildVixSeries, getOfflineResearch, loadHistoricalCache, type HistoricalCache } from './research.js';
import { DEFAULT_ENGINE_CONFIG, evaluateEntryRisk } from './risk.js';
import { buildFeatures, classifyRegime, detectSignal } from './signals.js';
import {
  candidatesKey,
  equityKey,
  KEY_ACTIVE,
  KEY_INSTRUMENTS,
  KEY_LEASE,
  stateKey,
  tradesKey,
  type KvStore,
} from './store.js';
import {
  INDEX_UNDERLYINGS,
  UNDERLYINGS,
  type AngelStatusSnapshot,
  type Candidate,
  type Candle,
  type ChallengerEngineTradeLog,
  type ClosedSummary,
  type ClosedTrade,
  type EngineConfig,
  type EquityPoint,
  type ExitReason,
  type ExitRuleVersion,
  type LedgerState,
  type LegQuote,
  type LiveSampleRecord,
  type LogEntry,
  type LogKind,
  type MarketSnapshot,
  type NfoInstrument,
  type PaperPosition,
  type SpotQuote,
  type SpreadMark,
  type SpreadPlan,
} from './types.js';

const LEASE_MS = 90_000;
const OWNER = `paper-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const STALE_FORCE_AFTER = 12;
const TRAIN_EVERY_LABELS = 1;

export interface CycleResult {
  ran: boolean;
  summary: string;
  ledgerId: string | null;
  equity: number | null;
  persisted: boolean;
}

export function createInitialLedger(nowMs: number, capital = 50_000): LedgerState {
  const starting = Number.isFinite(capital) && capital > 0 ? capital : 50_000;
  const now = new Date(nowMs).toISOString();
  return {
    schema: 2,
    ledgerId: `L${nowMs.toString(36)}`,
    createdAt: now,
    startingCapitalInr: starting,
    config: { ...DEFAULT_ENGINE_CONFIG, startingCapitalInr: starting },
    cash: starting,
    peakEquity: starting,
    maxDrawdownPct: 0,
    lastEquity: starting,
    lastEquityMid: starting,
    dayDate: null,
    dayStartEquity: starting,
    dailyHalt: false,
    killSwitch: { active: false, reason: null, at: null },
    control: { entriesEnabled: true, updatedAt: now, updatedBy: 'system' },
    benchmarkStartNifty: null,
    openPositions: [],
    activeCandidates: [],
    lastSignalBar: {},
    counters: {
      cycles: 0,
      tradingCycles: 0,
      candidatesCreated: 0,
      candidatesClosed: 0,
      tradesOpened: 0,
      tradesClosed: 0,
      plansRejected: 0,
      staleMarks: 0,
      dataErrors: 0,
    },
    lastCycle: null,
    lastEquityPointAt: null,
    market: null,
    angel: null,
    instrumentsAsOf: null,
    model: null,
    liveLabelsAtLastTrain: 0,
    liveSamples: [],
    closedSummaries: [],
    recentEquity: [],
    decisionLog: [],
    learningLog: [],
    pending: { trades: [], candidates: [], equity: [] },
  };
}

function log(state: LedgerState, kind: LogKind, message: string, underlying?: string) {
  const entry: LogEntry = { t: new Date().toISOString(), kind, message, ...(underlying ? { underlying } : {}) };
  const bucket = kind === 'MODEL' ? state.learningLog : state.decisionLog;
  bucket.unshift(entry);
  if (state.decisionLog.length > 80) state.decisionLog.length = 80;
  if (state.learningLog.length > 40) state.learningLog.length = 40;
}

function startingCapitalFromEnv(): number {
  const n = Number(process.env.PAPER_STARTING_CAPITAL_INR);
  return Number.isFinite(n) && n > 0 ? n : 50_000;
}

let cycleInFlight = false;

async function withLease<T>(store: KvStore, fn: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
  if (cycleInFlight) return { busy: true };
  const now = Date.now();
  const current = await store.get<{ owner: string; until: number }>(KEY_LEASE);
  if (current && current.data.until > now && current.data.owner !== OWNER) return { busy: true };
  const claimed = await store.put(KEY_LEASE, { owner: OWNER, until: now + LEASE_MS }, current ? current.rev : null);
  if (!claimed.ok) return { busy: true };
  cycleInFlight = true;
  try {
    return { busy: false, value: await fn() };
  } finally {
    cycleInFlight = false;
    const held = await store.get<{ owner: string; until: number }>(KEY_LEASE);
    if (held && held.data.owner === OWNER) {
      await store.put(KEY_LEASE, { owner: OWNER, until: 0 }, held.rev);
    }
  }
}

async function loadOrCreate(store: KvStore, nowMs: number): Promise<{ state: LedgerState; rev: number }> {
  let active = await store.get<{ ledgerId: string }>(KEY_ACTIVE);
  if (!active) {
    const fresh = createInitialLedger(nowMs, startingCapitalFromEnv());
    const created = await store.put(KEY_ACTIVE, { ledgerId: fresh.ledgerId }, null);
    if (!created.ok) {
      active = await store.get<{ ledgerId: string }>(KEY_ACTIVE);
    } else {
      const saved = await store.put(stateKey(fresh.ledgerId), fresh, null);
      return { state: fresh, rev: saved.ok ? saved.rev : 1 };
    }
  }
  if (!active) throw new Error('Could not create the paper ledger');
  const row = await store.get<LedgerState>(stateKey(active.data.ledgerId));
  if (!row) {
    const fresh = createInitialLedger(nowMs, startingCapitalFromEnv());
    fresh.ledgerId = active.data.ledgerId;
    const saved = await store.put(stateKey(fresh.ledgerId), fresh, null);
    return { state: fresh, rev: saved.ok ? saved.rev : 1 };
  }
  return { state: row.data, rev: row.rev };
}

async function archivePending(store: KvStore, state: LedgerState): Promise<boolean> {
  const groups: Array<{ items: Array<{ id?: string; t?: string; closedAt?: string }>; keyFor: (month: string) => string }> = [
    { items: state.pending.trades, keyFor: (m) => tradesKey(state.ledgerId, m) },
    { items: state.pending.candidates, keyFor: (m) => candidatesKey(state.ledgerId, m) },
    { items: state.pending.equity, keyFor: (m) => equityKey(state.ledgerId, m) },
  ];
  for (const group of groups) {
    const byMonth = new Map<string, unknown[]>();
    for (const item of group.items) {
      const when = Date.parse(item.closedAt || item.t || '');
      const month = Number.isFinite(when) ? istMonthKey(when) : istMonthKey(Date.now());
      const list = byMonth.get(month);
      if (list) list.push(item);
      else byMonth.set(month, [item]);
    }
    for (const [month, items] of byMonth) {
      const key = group.keyFor(month);
      const existing = await store.get<unknown[]>(key);
      const merged = new Map<string, unknown>();
      for (const old of existing?.data ?? []) {
        const id = (old as { id?: string; t?: string }).id || (old as { t?: string }).t;
        if (id) merged.set(id, old);
      }
      for (const item of items) {
        const id = (item as { id?: string }).id || (item as { t?: string }).t;
        if (id) merged.set(id, item);
      }
      const saved = await store.put(key, [...merged.values()], existing ? existing.rev : null);
      if (!saved.ok) return false;
    }
  }
  return true;
}

function mergeMonotonicState(target: LedgerState, latest: LedgerState) {
  const closedIds = new Set(latest.closedSummaries.map((s) => s.id));
  for (const s of latest.closedSummaries) {
    if (!target.closedSummaries.some((x) => x.id === s.id)) {
      target.closedSummaries.push(s);
    }
  }
  for (const t of latest.pending.trades) {
    if (!target.pending.trades.some((x) => x.id === t.id)) {
      target.pending.trades.push(t);
    }
  }
  target.openPositions = target.openPositions.filter((pos) => !closedIds.has(`T-${pos.id}`));
  for (const pos of target.openPositions) {
    const other = latest.openPositions.find((p) => p.id === pos.id);
    if (!other) continue;
    pos.peakValue = Math.max(pos.peakValue ?? pos.plan.entryDebit, other.peakValue ?? other.plan.entryDebit);
    pos.confirmedPeakValue = Math.max(
      pos.confirmedPeakValue ?? pos.peakValue,
      other.confirmedPeakValue ?? other.peakValue
    );
    pos.runnerFloor = Math.max(pos.runnerFloor ?? 0, other.runnerFloor ?? 0);
    pos.runnerFloorV31 = Math.max(pos.runnerFloorV31 ?? 0, other.runnerFloorV31 ?? 0);
    pos.runnerFloorLearned = Math.max(pos.runnerFloorLearned ?? 0, other.runnerFloorLearned ?? 0);
    pos.runnerArmed = Boolean(pos.runnerArmed || other.runnerArmed);
    if (pos.runnerTrendGatePassed == null && other.runnerTrendGatePassed != null) {
      pos.runnerTrendGatePassed = other.runnerTrendGatePassed;
      pos.runnerTrendGateReason = other.runnerTrendGateReason;
    }
  }
  for (const cand of target.activeCandidates) {
    const other = latest.activeCandidates.find((c) => c.id === cand.id);
    if (!other) continue;
    cand.peakValue = Math.max(cand.peakValue ?? cand.plan.entryDebit, other.peakValue ?? other.plan.entryDebit);
    cand.confirmedPeakValue = Math.max(
      cand.confirmedPeakValue ?? cand.peakValue,
      other.confirmedPeakValue ?? other.peakValue
    );
    cand.runnerFloor = Math.max(cand.runnerFloor ?? 0, other.runnerFloor ?? 0);
    cand.runnerFloorV31 = Math.max(cand.runnerFloorV31 ?? 0, other.runnerFloorV31 ?? 0);
    cand.runnerFloorLearned = Math.max(cand.runnerFloorLearned ?? 0, other.runnerFloorLearned ?? 0);
    cand.runnerArmed = Boolean(cand.runnerArmed || other.runnerArmed);
  }
}

async function persist(store: KvStore, state: LedgerState, rev: number): Promise<boolean> {
  let saved = await store.put(stateKey(state.ledgerId), state, rev);
  if (!saved.ok) {
    const latest = await store.get<LedgerState>(stateKey(state.ledgerId));
    if (latest) {
      mergeMonotonicState(state, latest.data);
    }
    saved = await store.put(stateKey(state.ledgerId), state, latest ? latest.rev : null);
  }
  if (!saved.ok) return false;
  lastLiveStateMemo = state;
  lastLiveRefreshMs = Date.now();
  const pendingCount = state.pending.trades.length + state.pending.candidates.length + state.pending.equity.length;
  if (pendingCount === 0) return true;
  const archived = await archivePending(store, state);
  if (!archived) return true;
  state.pending = { trades: [], candidates: [], equity: [] };
  const cleared = await store.put(stateKey(state.ledgerId), state, saved.rev);
  return cleared.ok;
}

function mergeCandles(base: Candle[], extra: Candle[]): Candle[] {
  const map = new Map<string, Candle>();
  for (const c of base) map.set(c.time, c);
  for (const c of extra) if (c.close > 0 && c.high >= c.low) map.set(c.time, c);
  return [...map.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function lastCompleteIndex(candles: Candle[], nowMs: number): number {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (hourlyBarEndMs(Date.parse(candles[i].time)) <= nowMs) return i;
  }
  return -1;
}

function entryMark(plan: SpreadPlan, nowMs: number): SpreadMark {
  const mid = (bid: number, ask: number) => (bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask);
  return {
    at: new Date(nowMs).toISOString(),
    longBid: plan.long.bid,
    longAsk: plan.long.ask,
    shortBid: plan.short.bid,
    shortAsk: plan.short.ask,
    liquidationValue: round2(plan.long.bid - plan.short.ask),
    midValue: round2(mid(plan.long.bid, plan.long.ask) - mid(plan.short.bid, plan.short.ask)),
  };
}

function markValue(mark: SpreadMark, plan: SpreadPlan, lots: number) {
  const units = lots * plan.lotSize;
  const exitCharges = exitChargesFor(mark.longBid, mark.shortAsk, units);
  const midCharges = exitChargesFor(Math.max(mark.longBid, 0), Math.max(mark.shortAsk, 0), units);
  return {
    liquidationInr: round2(mark.liquidationValue * units - exitCharges),
    midInr: round2(mark.midValue * units - midCharges),
    exitCharges,
  };
}

function perLotOutcome(plan: SpreadPlan, exitValue: number, longBid: number, shortAsk: number) {
  const units = plan.lotSize;
  const entryCash = plan.entryDebit * units + plan.entryChargesPerLot;
  const exitCharges = exitChargesFor(longBid, shortAsk, units);
  const exitCash = exitValue * units - exitCharges;
  const pnl = round2(exitCash - entryCash);
  return { pnl, r: plan.maxLossPerLot > 0 ? pnl / plan.maxLossPerLot : 0, exitCharges };
}

interface Tracked {
  id?: string;
  candidateId?: string;
  features?: number[];
  underlying: string;
  direction: 'CE' | 'PE';
  plan: SpreadPlan;
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
  counterfactualFixed30PnlPerLotInr?: number;
  counterfactualV31ExitValue?: number;
  counterfactualV31PnlPerLotInr?: number;
  counterfactualLearnedExitValue?: number;
  counterfactualLearnedPnlPerLotInr?: number;
  challengerEngines?: Record<ExitRuleVersion, ChallengerEngineTradeLog>;
  sessionsHeld: number;
  lastSessionDate: string;
  staleMarks: number;
}

export interface UnderlyingTrendContext {
  spot: number;
  ema20: number;
  vwap: number;
  adx14: number;
  prevAdx14: number;
}

function bumpSession(item: Tracked, today: string) {
  if (item.lastSessionDate !== today) {
    item.sessionsHeld += 1;
    item.lastSessionDate = today;
  }
}

function resolveFeaturesFor(item: Tracked, state: LedgerState): number[] {
  if (item.features && item.features.length > 0) return item.features;
  if (item.candidateId) {
    const cand = state.activeCandidates.find((c) => c.id === item.candidateId);
    if (cand && cand.features.length > 0) return cand.features;
  }
  return [];
}

function applyMark(
  item: Tracked,
  quotes: Record<string, LegQuote>,
  nowMs: number,
  cfg: EngineConfig,
  state: LedgerState,
  trendMap?: Record<string, UnderlyingTrendContext>,
  todayStr?: string
) {
  const marked = markSpread(item.plan, quotes, nowMs, cfg.quoteMaxAgeSec);
  if (!marked.ok) {
    item.staleMarks += 1;
    state.counters.staleMarks += 1;
    return;
  }
  item.staleMarks = 0;
  item.lastMark = marked.mark;
  item.peakValue = Math.max(item.peakValue, marked.mark.liquidationValue);
  item.troughValue = Math.min(item.troughValue, marked.mark.liquidationValue);

  // Rule 1: Update confirmedPeakValue (P) from validated order-book mark (already filtered for <=8% spread width and freshness)
  const { recentMarks, confirmedMark } = updateConfirmedMark(item.recentMarks, marked.mark.liquidationValue, 3);
  item.recentMarks = recentMarks;
  item.confirmedPeakValue = Math.max(
    item.confirmedPeakValue ?? item.plan.entryDebit,
    confirmedMark,
    item.peakValue
  );

  const maxGain = Math.max(0.01, item.plan.width - item.plan.entryDebit);
  const armFrac = cfg.runnerArmMfeFrac ?? cfg.takeProfitFracOfMaxGain ?? 0.3;
  const fixed30Target = round2(item.plan.entryDebit + armFrac * maxGain);

  // Record counterfactual fixed-30% exit the first time liquidation mark hits 30% of max gain
  if (item.counterfactualFixed30ExitValue === undefined && marked.mark.liquidationValue >= fixed30Target) {
    item.counterfactualFixed30ExitValue = marked.mark.liquidationValue;
    item.counterfactualFixed30PnlPerLotInr = perLotOutcome(
      item.plan,
      marked.mark.liquidationValue,
      marked.mark.longBid,
      marked.mark.shortAsk
    ).pnl;
  }

  // Evaluate Self-Learning Contextual Exit Policy (ADAPTIVE_LEARNED) on every mark
  const confirmedMfe = (item.confirmedPeakValue - item.plan.entryDebit) / maxGain;
  const tCtx = trendMap?.[item.underlying];
  const spot = tCtx?.spot ?? state.market?.spots?.[item.underlying]?.ltp ?? item.plan.spotAtEntry;
  const reg = state.market?.regimes?.[item.underlying];
  const adx14 = tCtx?.adx14 ?? reg?.adx14 ?? 22;
  const prevAdx14 = tCtx?.prevAdx14 ?? adx14 - 0.5;
  const ema20 = tCtx?.ema20 ?? item.plan.spotAtEntry;
  const vwap = tCtx?.vwap ?? item.plan.spotAtEntry;
  const trendAligned =
    item.direction === 'CE' ? spot >= ema20 && spot >= vwap : spot <= ema20 && spot <= vwap;
  const adxRising = adx14 >= (cfg.runnerMinAdx ?? 20) && adx14 >= prevAdx14;

  const features = resolveFeaturesFor(item, state);
  const learnedDecision = predictExitDecision(state.model?.exitPolicy, features, {
    mfeFrac: Math.max(0, confirmedMfe),
    sessionsHeld: item.sessionsHeld,
    trendAligned,
    adxRising,
    defaultStopLossFrac: cfg.stopLossFracOfDebit,
  });
  item.learnedRunnerProb = learnedDecision.runnerProb;
  item.learnedRecoveryProb = learnedDecision.recoveryProb;
  item.learnedKeepFrac = learnedDecision.learnedKeepFrac;
  item.learnedEarlyStopTightened = learnedDecision.earlyStopTighten;
  item.learnedExitAction = learnedDecision.actionSummary;

  // Rule 3: Evaluate Trend Gate + Learned Runner Continuation Gate at arming (confirmed MFE% >= 0.30)
  if (!item.runnerArmed && item.runnerTrendGatePassed == null && confirmedMfe >= armFrac) {
    const today = todayStr ?? istDate(nowMs);
    const dte = calendarDaysBetween(today, item.plan.expiry);
    const tradingDte = Math.round((dte * 5) / 7);
    const netDelta = estimateSpreadNetDelta(item.plan, spot, dte, marked.mark);
    const gate = evaluateRunnerTrendGate({
      right: item.direction,
      spot,
      ema20,
      vwap,
      adx14,
      prevAdx14,
      tradingDte,
      spreadNetDelta: netDelta,
      cfg,
    });
    if (gate.passed && learnedDecision.takeImmediate30 && item.exitRuleVersion === 'ADAPTIVE_LEARNED') {
      item.runnerTrendGatePassed = false;
      item.runnerTrendGateReason = `SELF-LEARNING EXIT (30% TP): ${learnedDecision.actionSummary}`;
    } else {
      item.runnerTrendGatePassed = gate.passed;
      item.runnerTrendGateReason = gate.passed
        ? `${gate.reason} · Learned keep ${(learnedDecision.learnedKeepFrac * 100).toFixed(1)}%`
        : gate.reason;
      if (gate.passed) {
        item.runnerArmed = true;
      }
    }
  }

  // Rule 4: Monotonic floor updates for all 4 Challenger Registry engines (LADDER_V2, RUNNER_V3, RUNNER_V3_1, ADAPTIVE_LEARNED)
  const effectivePeak = item.confirmedPeakValue ?? item.peakValue;
  const ladderLvls = exitLevels(item.plan, cfg, {
    peakValue: effectivePeak,
    sessionsHeld: item.sessionsHeld,
    runnerArmed: false,
    previousFloor: item.runnerFloor,
    variant: 'LADDER_V2',
  });
  const lvlsV3 = exitLevels(item.plan, cfg, {
    peakValue: effectivePeak,
    sessionsHeld: item.sessionsHeld,
    runnerArmed: item.runnerArmed,
    previousFloor: item.runnerFloor,
    previousFloorV31: item.runnerFloorV31,
    variant: 'RUNNER_V3',
  });
  const lvlsV31 = exitLevels(item.plan, cfg, {
    peakValue: effectivePeak,
    sessionsHeld: item.sessionsHeld,
    runnerArmed: item.runnerArmed,
    previousFloor: item.runnerFloor,
    previousFloorV31: item.runnerFloorV31,
    variant: 'RUNNER_V3_1',
  });
  const lvlsLearned = exitLevels(item.plan, cfg, {
    peakValue: effectivePeak,
    sessionsHeld: item.sessionsHeld,
    runnerArmed: item.runnerArmed && !learnedDecision.takeImmediate30,
    previousFloor: item.runnerFloor,
    previousFloorV31: item.runnerFloorLearned ?? item.runnerFloorV31,
    variant: 'ADAPTIVE_LEARNED',
    learnedKeepFrac: item.learnedKeepFrac,
    learnedEarlyStopTightened: item.learnedEarlyStopTightened,
  });
  item.runnerFloor = lvlsV3.stop;
  item.runnerFloorV31 = lvlsV31.stop;
  item.runnerFloorLearned = lvlsLearned.stop;

  // Record counterfactual RUNNER_V3_1 exit if mark hits the tighter v3.1 floor while armed
  if (
    item.runnerArmed &&
    item.counterfactualV31ExitValue === undefined &&
    marked.mark.liquidationValue <= item.runnerFloorV31
  ) {
    item.counterfactualV31ExitValue = item.runnerFloorV31;
    item.counterfactualV31PnlPerLotInr = perLotOutcome(
      item.plan,
      item.runnerFloorV31,
      marked.mark.longBid,
      marked.mark.shortAsk
    ).pnl;
  }

  // Record counterfactual ADAPTIVE_LEARNED exit if mark hits the learned floor
  if (
    item.counterfactualLearnedExitValue === undefined &&
    ((item.runnerArmed && marked.mark.liquidationValue <= item.runnerFloorLearned) ||
      (!item.runnerArmed && item.learnedEarlyStopTightened && marked.mark.liquidationValue <= item.runnerFloorLearned))
  ) {
    item.counterfactualLearnedExitValue = item.runnerFloorLearned;
    item.counterfactualLearnedPnlPerLotInr = perLotOutcome(
      item.plan,
      item.runnerFloorLearned,
      marked.mark.longBid,
      marked.mark.shortAsk
    ).pnl;
  }

  const lot = item.plan.lotSize;
  const ladderFloor = item.counterfactualFixed30ExitValue !== undefined ? fixed30Target : ladderLvls.stop;
  item.challengerEngines = {
    LADDER_V2: {
      floor: ladderFloor,
      lockedProfitPerLotInr: round2((ladderFloor - item.plan.entryDebit) * lot),
      exitValue: item.counterfactualFixed30ExitValue,
      pnlPerLotInr: item.counterfactualFixed30PnlPerLotInr,
    },
    RUNNER_V3: {
      floor: lvlsV3.runnerFloorV3,
      lockedProfitPerLotInr: round2((lvlsV3.runnerFloorV3 - item.plan.entryDebit) * lot),
    },
    RUNNER_V3_1: {
      floor: lvlsV31.runnerFloorV31,
      lockedProfitPerLotInr: round2((lvlsV31.runnerFloorV31 - item.plan.entryDebit) * lot),
      exitValue: item.counterfactualV31ExitValue,
      pnlPerLotInr: item.counterfactualV31PnlPerLotInr,
    },
    ADAPTIVE_LEARNED: {
      floor: item.runnerFloorLearned,
      lockedProfitPerLotInr: round2((item.runnerFloorLearned - item.plan.entryDebit) * lot),
      exitValue: item.counterfactualLearnedExitValue,
      pnlPerLotInr: item.counterfactualLearnedPnlPerLotInr,
    },
  };
}

function exitReasonFor(item: Tracked, cfg: EngineConfig, today: string, isCandidate = false): ExitReason | null {
  if (!item.lastMark) return null;
  // Promote ADAPTIVE_LEARNED (built on morning winner RUNNER_V3_1 + online self-learning)
  const variant: ExitRuleVersion = isCandidate
    ? (item.exitRuleVersion ?? 'ADAPTIVE_LEARNED')
    : (item.exitRuleVersion ?? 'ADAPTIVE_LEARNED');
  const useRunner = variant === 'RUNNER_V3' || variant === 'RUNNER_V3_1' || variant === 'ADAPTIVE_LEARNED';
  const effectivePeak = item.confirmedPeakValue ?? item.peakValue;
  const fromRules = evaluateSpreadExit({
    plan: item.plan,
    liquidationValue: item.lastMark.liquidationValue,
    peakValue: effectivePeak,
    sessionsHeld: item.sessionsHeld,
    dte: calendarDaysBetween(today, item.plan.expiry),
    cfg,
    runnerArmed: useRunner ? item.runnerArmed : false,
    runnerTrendGatePassed: useRunner ? item.runnerTrendGatePassed : false,
    previousFloor: useRunner ? item.runnerFloor : undefined,
    previousFloorV31:
      variant === 'ADAPTIVE_LEARNED'
        ? (item.runnerFloorLearned ?? item.runnerFloorV31)
        : useRunner
          ? item.runnerFloorV31
          : undefined,
    variant,
    learnedKeepFrac: item.learnedKeepFrac,
    learnedEarlyStopTightened: item.learnedEarlyStopTightened,
  });
  if (fromRules) return fromRules;
  if (item.staleMarks >= STALE_FORCE_AFTER) return 'STALE_DATA_FORCED';
  return null;
}

function closeCandidate(state: LedgerState, candidate: Candidate, reason: ExitReason, nowMs: number) {
  const mark = candidate.lastMark;
  if (!mark) return;
  const outcome = perLotOutcome(candidate.plan, mark.liquidationValue, mark.longBid, mark.shortAsk);
  candidate.closedAt = new Date(nowMs).toISOString();
  candidate.exitReason = reason;
  candidate.exitValue = mark.liquidationValue;
  candidate.pnlPerLotInr = outcome.pnl;
  if (candidate.counterfactualFixed30PnlPerLotInr === undefined) {
    candidate.counterfactualFixed30PnlPerLotInr = outcome.pnl;
  }
  if (candidate.counterfactualV31PnlPerLotInr === undefined) {
    candidate.counterfactualV31PnlPerLotInr = outcome.pnl;
  }
  if (candidate.counterfactualLearnedPnlPerLotInr === undefined) {
    candidate.counterfactualLearnedPnlPerLotInr = outcome.pnl;
  }
  if (candidate.challengerEngines) {
    candidate.challengerEngines.RUNNER_V3.exitValue = mark.liquidationValue;
    candidate.challengerEngines.RUNNER_V3.exitReason = reason;
    candidate.challengerEngines.RUNNER_V3.pnlPerLotInr = outcome.pnl;
    if (candidate.challengerEngines.LADDER_V2.pnlPerLotInr === undefined) {
      candidate.challengerEngines.LADDER_V2.exitValue = mark.liquidationValue;
      candidate.challengerEngines.LADDER_V2.exitReason = reason;
      candidate.challengerEngines.LADDER_V2.pnlPerLotInr = candidate.counterfactualFixed30PnlPerLotInr;
    }
    if (candidate.challengerEngines.RUNNER_V3_1.pnlPerLotInr === undefined) {
      candidate.challengerEngines.RUNNER_V3_1.exitValue = candidate.counterfactualV31ExitValue ?? mark.liquidationValue;
      candidate.challengerEngines.RUNNER_V3_1.exitReason =
        candidate.counterfactualV31ExitValue !== undefined ? 'TRAIL_STOP' : reason;
      candidate.challengerEngines.RUNNER_V3_1.pnlPerLotInr = candidate.counterfactualV31PnlPerLotInr;
    }
    if (candidate.challengerEngines.ADAPTIVE_LEARNED.pnlPerLotInr === undefined) {
      candidate.challengerEngines.ADAPTIVE_LEARNED.exitValue =
        candidate.counterfactualLearnedExitValue ?? mark.liquidationValue;
      candidate.challengerEngines.ADAPTIVE_LEARNED.exitReason =
        candidate.counterfactualLearnedExitValue !== undefined ? 'TRAIL_STOP' : reason;
      candidate.challengerEngines.ADAPTIVE_LEARNED.pnlPerLotInr = candidate.counterfactualLearnedPnlPerLotInr;
    }
  }
  candidate.pnlPerLotMidInr = round2(
    (mark.midValue - candidate.plan.midDebit) * candidate.plan.lotSize - candidate.plan.entryChargesPerLot - outcome.exitCharges
  );
  candidate.rMultiple = outcome.r;
  candidate.win = outcome.pnl > 0;
  state.counters.candidatesClosed += 1;
  const maxGain = Math.max(0.01, candidate.plan.width - candidate.plan.entryDebit);
  const confirmedP = candidate.confirmedPeakValue ?? candidate.peakValue;
  const mfeMaxFrac = Number(Math.max(0, (confirmedP - candidate.plan.entryDebit) / maxGain).toFixed(4));
  const sample: LiveSampleRecord = {
    id: candidate.id,
    x: candidate.features,
    y: outcome.pnl > 0 ? 1 : 0,
    r: outcome.r,
    pnlPerLotInr: outcome.pnl,
    entryMs: Date.parse(candidate.createdAt),
    exitMs: nowMs,
    strategy: candidate.strategy,
    underlying: candidate.underlying,
    direction: candidate.direction,
    regime: candidate.regime,
    exitReason: reason,
    mfeMaxFrac,
    sessionsHeld: candidate.sessionsHeld,
    pnlLadderV2Inr: candidate.counterfactualFixed30PnlPerLotInr,
    pnlRunnerV3Inr: outcome.pnl,
    pnlRunnerV31Inr: candidate.counterfactualV31PnlPerLotInr,
  };
  state.liveSamples.push(sample);
  state.pending.candidates.push(candidate);
  const cfNote =
    candidate.counterfactualFixed30PnlPerLotInr !== outcome.pnl || candidate.counterfactualV31PnlPerLotInr !== outcome.pnl
      ? ` [LADDER_V2: ₹${candidate.counterfactualFixed30PnlPerLotInr.toFixed(0)} · V3.1: ₹${candidate.counterfactualV31PnlPerLotInr.toFixed(0)} · LEARNED: ₹${candidate.counterfactualLearnedPnlPerLotInr.toFixed(0)}]`
      : '';
  log(
    state,
    'CANDIDATE',
    `${candidate.underlying} ${candidate.direction} ${candidate.strategy} closed ${reason}: ${outcome.pnl.toFixed(0)} ₹/lot (${outcome.r.toFixed(2)}R)${cfNote}`,
    candidate.underlying
  );
}

function closePosition(state: LedgerState, position: PaperPosition, reason: ExitReason, nowMs: number): ClosedTrade | null {
  const mark = position.lastMark;
  if (!mark) return null;
  const units = position.lots * position.plan.lotSize;
  const exitCharges = exitChargesFor(mark.longBid, mark.shortAsk, units);
  const exitCashIn = round2(mark.liquidationValue * units - exitCharges);
  state.cash = round2(state.cash + exitCashIn);
  const net = round2(exitCashIn - position.entryCashOutInr);
  const confirmedP = position.confirmedPeakValue ?? position.peakValue;
  const maxGain = Math.max(0.01, position.plan.width - position.plan.entryDebit);
  const cfPerLot =
    position.counterfactualFixed30ExitValue !== undefined
      ? perLotOutcome(position.plan, position.counterfactualFixed30ExitValue, mark.longBid, mark.shortAsk).pnl
      : round2(net / Math.max(1, position.lots));
  const v31PerLot =
    position.counterfactualV31ExitValue !== undefined
      ? perLotOutcome(position.plan, position.counterfactualV31ExitValue, mark.longBid, mark.shortAsk).pnl
      : round2(net / Math.max(1, position.lots));
  const learnedPerLot =
    position.counterfactualLearnedExitValue !== undefined
      ? perLotOutcome(position.plan, position.counterfactualLearnedExitValue, mark.longBid, mark.shortAsk).pnl
      : round2(net / Math.max(1, position.lots));
  const trade: ClosedTrade = {
    id: `T-${position.id}`,
    candidateId: position.candidateId,
    underlying: position.underlying,
    strategy: position.strategy,
    direction: position.direction,
    regimeAtEntry: position.regime,
    lots: position.lots,
    lotSize: position.plan.lotSize,
    expiry: position.plan.expiry,
    dteAtEntry: position.plan.dte,
    longSymbol: position.plan.long.symbol,
    shortSymbol: position.plan.short.symbol,
    longStrike: position.plan.long.strike,
    shortStrike: position.plan.short.strike,
    width: position.plan.width,
    openedAt: position.openedAt,
    closedAt: new Date(nowMs).toISOString(),
    holdMinutes: Math.max(0, Math.round((nowMs - Date.parse(position.openedAt)) / 60000)),
    sessionsHeld: position.sessionsHeld,
    entryDebit: position.plan.entryDebit,
    exitValue: mark.liquidationValue,
    entryCashOutInr: position.entryCashOutInr,
    exitCashInInr: exitCashIn,
    chargesInr: round2(position.entryCashOutInr - position.plan.entryDebit * units + exitCharges),
    netPnlInr: net,
    pnlAtMidInr: round2(mark.midValue * units - exitCharges - (position.plan.midDebit * units + (position.entryCashOutInr - position.plan.entryDebit * units))),
    maxLossInr: position.maxLossInr,
    rMultiple: position.maxLossInr > 0 ? net / position.maxLossInr : 0,
    confirmedPeakValue: confirmedP,
    mfeOfMaxGainPct: round2(((confirmedP - position.plan.entryDebit) / maxGain) * 100),
    mfePct: position.plan.entryDebit > 0 ? (confirmedP - position.plan.entryDebit) / position.plan.entryDebit : 0,
    maePct: position.plan.entryDebit > 0 ? (position.troughValue - position.plan.entryDebit) / position.plan.entryDebit : 0,
    exitReason: reason,
    exitRuleVersion: position.exitRuleVersion ?? 'ADAPTIVE_LEARNED',
    runnerArmed: Boolean(position.runnerArmed),
    runnerTrendGatePassed: position.runnerTrendGatePassed ?? null,
    learnedRunnerProb: position.learnedRunnerProb ?? null,
    learnedRecoveryProb: position.learnedRecoveryProb ?? null,
    learnedKeepFrac: position.learnedKeepFrac ?? null,
    counterfactualFixed30PnlInr: round2(cfPerLot * position.lots),
    counterfactualV31PnlInr: round2(v31PerLot * position.lots),
    counterfactualLearnedPnlInr: round2(learnedPerLot * position.lots),
    challengerEngines: position.challengerEngines,
    modelProb: position.modelProb,
    entryReason: position.entryReason,
  };
  state.counters.tradesClosed += 1;
  state.pending.trades.push(trade);
  const summary: ClosedSummary = {
    id: trade.id,
    closedAt: trade.closedAt,
    underlying: trade.underlying,
    strategy: trade.strategy,
    direction: trade.direction,
    regime: trade.regimeAtEntry,
    exitReason: trade.exitReason,
    netPnlInr: trade.netPnlInr,
    rMultiple: trade.rMultiple,
  };
  state.closedSummaries.push(summary);
  log(state, 'EXIT', `${position.underlying} ${position.direction} ${position.lots} lot closed ${reason}: ${net >= 0 ? '+' : ''}₹${net.toFixed(0)} (MFE ${trade.mfeOfMaxGainPct?.toFixed(1)}% of maxGain)`, position.underlying);
  return trade;
}

function revalue(state: LedgerState, niftyLtp: number | null) {
  const seenClosed = new Set<string>();
  state.closedSummaries = state.closedSummaries.filter((s) => {
    if (!s || !s.id || seenClosed.has(s.id)) return false;
    seenClosed.add(s.id);
    return true;
  });
  const realizedInr = state.closedSummaries.reduce((sum, s) => sum + (Number.isFinite(s.netPnlInr) ? s.netPnlInr : 0), 0);
  const openCostInr = state.openPositions.reduce((sum, p) => sum + (Number.isFinite(p.entryCashOutInr) ? p.entryCashOutInr : 0), 0);
  state.cash = round2(state.startingCapitalInr + realizedInr - openCostInr);

  let equity = state.cash;
  let equityMid = state.cash;
  let unrealized = 0;
  for (const pos of state.openPositions) {
    if (!pos.lastMark) continue;
    const units = pos.lots * pos.plan.lotSize;
    const value = markValue(pos.lastMark, pos.plan, pos.lots);
    equity += value.liquidationInr;
    equityMid += value.midInr;
    const entryCharges = round2(pos.entryCashOutInr - pos.plan.entryDebit * units);
    pos.estChargesInr = round2(entryCharges + value.exitCharges);
    pos.netUnrealizedInr = round2(value.liquidationInr - pos.entryCashOutInr);
    pos.longLegPnlInr = round2((pos.lastMark.longBid - pos.plan.long.ask) * units);
    pos.shortLegPnlInr = round2((pos.plan.short.bid - pos.lastMark.shortAsk) * units);
    pos.unrealizedInr = round2((pos.lastMark.liquidationValue - pos.plan.entryDebit) * units);
    unrealized += pos.unrealizedInr;
  }
  equity = round2(equity);
  equityMid = round2(equityMid);
  state.lastEquity = equity;
  state.lastEquityMid = equityMid;
  if (equity > state.peakEquity) state.peakEquity = equity;
  const dd = state.peakEquity > 0 ? ((state.peakEquity - equity) / state.peakEquity) * 100 : 0;
  if (dd > state.maxDrawdownPct) state.maxDrawdownPct = round2(dd);
  if (niftyLtp && niftyLtp > 0 && state.benchmarkStartNifty === null) state.benchmarkStartNifty = niftyLtp;
  const benchmark =
    state.benchmarkStartNifty && niftyLtp
      ? round2((state.startingCapitalInr * niftyLtp) / state.benchmarkStartNifty)
      : null;
  const cfg = state.config;
  if (state.dayStartEquity > 0 && (equity - state.dayStartEquity) / state.dayStartEquity <= -cfg.dailyLossHaltPct) {
    if (!state.dailyHalt) log(state, 'RISK', `Daily loss limit hit at ₹${equity.toFixed(0)}`);
    state.dailyHalt = true;
  }
  if (!state.killSwitch.active && state.peakEquity > 0 && dd >= cfg.drawdownKillPct * 100) {
    state.killSwitch = {
      active: true,
      reason: `Equity ₹${equity.toFixed(0)} is ${dd.toFixed(1)}% below the peak of ₹${state.peakEquity.toFixed(0)}`,
      at: new Date().toISOString(),
    };
    state.control = { ...state.control, entriesEnabled: false, updatedAt: new Date().toISOString(), updatedBy: 'kill-switch' };
    log(state, 'RISK', state.killSwitch.reason || 'Drawdown kill switch tripped');
  }
  return { equity, equityMid, unrealized, drawdownPct: round2(dd), benchmark };
}

function pushEquityPoint(state: LedgerState, nowMs: number, point: Omit<EquityPoint, 't'>) {
  const full: EquityPoint = { t: new Date(nowMs).toISOString(), ...point };
  state.recentEquity.push(full);
  if (state.recentEquity.length > 500) state.recentEquity.splice(0, state.recentEquity.length - 500);
  state.pending.equity.push(full);
  state.lastEquityPointAt = full.t;
}

function maybeTrain(state: LedgerState, nowMs: number, force: boolean) {
  const labels = state.counters.candidatesClosed;
  const research = getOfflineResearch();
  const offline = research?.samples ?? [];
  const priorChanged = Boolean(
    state.model &&
      (!state.model.exitPolicy ||
        (offline.length > 0 &&
          (state.model.nOffline !== offline.length ||
            Math.abs((state.model.offlineOos.acceptedAvgR ?? 0) - (research?.report.walkForward.oos.acceptedAvgR ?? 0)) > 1e-6)))
  );
  if (!force && !priorChanged && state.model && labels - state.liveLabelsAtLastTrain < TRAIN_EVERY_LABELS) return;
  const live: Sample[] = state.liveSamples.map((s) => ({
    id: s.id,
    x: s.x,
    y: s.y,
    r: s.r,
    entryMs: s.entryMs,
    exitMs: s.exitMs,
    weight: 1,
    source: 'LIVE',
    mfeMaxFrac: s.mfeMaxFrac,
    sessionsHeld: s.sessionsHeld,
    pnlLadderV2Inr: s.pnlLadderV2Inr ?? s.pnlPerLotInr,
    pnlRunnerV3Inr: s.pnlRunnerV3Inr ?? s.pnlPerLotInr,
    pnlRunnerV31Inr: s.pnlRunnerV31Inr ?? s.pnlPerLotInr,
  }));
  if (offline.length + live.length < 30) {
    log(state, 'MODEL', 'Not enough closed samples to fit a model yet. Signals are taken whenever risk limits allow.');
    return;
  }
  const snap = trainModelSnapshot(offline, live, nowMs, research ? { oos: research.offlineOos } : undefined);
  if (!snap) {
    log(state, 'MODEL', 'Model fit did not converge. The previous model, if any, is unchanged.');
    return;
  }
  state.model = snap;
  state.liveLabelsAtLastTrain = labels;
  log(state, 'MODEL', `${snap.version}: ${snap.gate.reason}`);
}

function marketLive(spots: Record<string, SpotQuote>, nowMs: number): { live: boolean; reason: string } {
  const within = isWithinSessionHours(nowMs);
  if (!within) {
    const p = istParts(nowMs);
    const weekend = p.weekday === 0 || p.weekday === 6;
    return { live: false, reason: weekend ? 'Weekend' : p.minuteOfDay < 9 * 60 + 15 ? 'Before 09:15 IST' : 'After 15:30 IST' };
  }
  const nifty = spots.NIFTY;
  if (!nifty) return { live: false, reason: 'NIFTY quote missing' };
  if (nifty.feedTimeMs === null) return { live: false, reason: 'NIFTY quote has no exchange timestamp' };
  const ageSec = (nowMs - nifty.feedTimeMs) / 1000;
  if (ageSec > 180) return { live: false, reason: `NIFTY quote is ${Math.round(ageSec)}s old` };
  return { live: true, reason: `NIFTY feed ${Math.round(ageSec)}s old` };
}

let cacheMemo: HistoricalCache | null | undefined;
function history(): HistoricalCache | null {
  if (cacheMemo === undefined) cacheMemo = loadHistoricalCache();
  return cacheMemo;
}

async function loadInstruments(
  store: KvStore,
  market: MarketData,
  nowMs: number,
  spots: Record<string, SpotQuote>
): Promise<NfoInstrument[]> {
  const today = istDate(nowMs);
  const cached = await store.get<{ asOf: string; items: NfoInstrument[] }>(KEY_INSTRUMENTS);
  const expectedCount = Object.keys(spots).filter((k) => k !== 'INDIA_VIX').length;
  const cachedCount = cached ? new Set(cached.data.items.map((i) => i.underlying)).size : 0;
  if (cached && cached.data.asOf === today && cached.data.items.length > 0 && cachedCount >= expectedCount) {
    return cached.data.items;
  }
  const spotByUnderlying: Record<string, number> = {};
  for (const [sym, q] of Object.entries(spots)) if (q.ltp > 0) spotByUnderlying[sym] = q.ltp;
  const items = await market.fetchInstruments(nowMs, spotByUnderlying);
  if (!items || items.length === 0) return cached?.data.items ?? [];
  await store.put(KEY_INSTRUMENTS, { asOf: today, items }, cached ? cached.rev : null);
  return items;
}

export async function runPaperCycle(
  store: KvStore,
  market: MarketData,
  opts: { nowMs?: number; force?: boolean; train?: boolean; history?: HistoricalCache } = {}
): Promise<CycleResult> {
  const leased = await withLease(store, () => runPaperCycleUnlocked(store, market, opts));
  if (leased.busy) {
    return { ran: false, summary: 'Another cycle is still running', ledgerId: null, equity: null, persisted: false };
  }
  return leased.value;
}

async function runPaperCycleUnlocked(
  store: KvStore,
  market: MarketData,
  opts: { nowMs?: number; force?: boolean; train?: boolean; history?: HistoricalCache }
): Promise<CycleResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const train = opts.train !== false;
  let loaded: { state: LedgerState; rev: number };
  try {
    loaded = await loadOrCreate(store, nowMs);
  } catch (err) {
    return {
      ran: false,
      summary: err instanceof Error ? err.message : 'Ledger load failed',
      ledgerId: null,
      equity: null,
      persisted: false,
    };
  }
  const { state } = loaded;
  let rev = loaded.rev;
  const cfg = state.config;
  const elapsed = state.lastCycle ? nowMs - Date.parse(state.lastCycle.at) : Infinity;
  if (!opts.force && elapsed < cfg.cycleMinIntervalSec * 1000) {
    return {
      ran: false,
      summary: `Next cycle in ${Math.ceil((cfg.cycleMinIntervalSec * 1000 - elapsed) / 1000)}s`,
      ledgerId: state.ledgerId,
      equity: state.lastEquity,
      persisted: false,
    };
  }

  const started = Date.now();
  state.counters.cycles += 1;
  state.angel = market.status();
  const today = istDate(nowMs);
  if (state.dayDate !== today) {
    state.dayStartEquity = state.lastEquity;
    state.dayDate = today;
    state.dailyHalt = false;
  }

  if (train) {
    try {
      maybeTrain(state, nowMs, false);
    } catch (err) {
      log(state, 'ERROR', err instanceof Error ? err.message : 'Training failed');
    }
  }
  if (state.model) {
    for (const cand of state.activeCandidates) {
      if (cand.modelProb === null && cand.features.length === state.model.weights.length) {
        cand.modelProb = predictProb(state.model, cand.features);
        cand.modelVersion = state.model.version;
        cand.gateActive = Boolean(state.model.gate.active);
        cand.gateThreshold = state.model.gate.threshold;
      }
    }
    for (const pos of state.openPositions) {
      if (pos.modelProb === null) {
        const cand = state.activeCandidates.find((c) => c.id === pos.candidateId);
        if (cand && cand.modelProb !== null) pos.modelProb = cand.modelProb;
      }
    }
  }

  const prevCycleStatus = state.lastCycle?.status;
  const finish = async (status: NonNullable<LedgerState['lastCycle']>['status'], summary: string) => {
    state.angel = market.status();
    state.lastCycle = { at: new Date(nowMs).toISOString(), durationMs: Date.now() - started, status, summary };
    const isIdleOffHours =
      (status === 'OFF_HOURS' || status === 'MARKET_CLOSED') &&
      prevCycleStatus === status &&
      !opts.force &&
      state.pending.trades.length === 0 &&
      state.pending.candidates.length === 0 &&
      state.pending.equity.length === 0;
    if (isIdleOffHours) {
      lastLiveStateMemo = state;
      lastLiveRefreshMs = nowMs;
      return { ran: true, summary, ledgerId: state.ledgerId, equity: state.lastEquity, persisted: true };
    }
    log(state, 'CYCLE', summary);
    const persisted = await persist(store, state, rev);
    return { ran: true, summary, ledgerId: state.ledgerId, equity: state.lastEquity, persisted };
  };

  let spots: Record<string, SpotQuote> | null = null;
  try {
    spots = await market.fetchSpots();
  } catch (err) {
    state.counters.dataErrors += 1;
    state.angel = { ...state.angel, lastError: err instanceof Error ? err.message : 'Spot fetch failed' } as AngelStatusSnapshot;
    return finish('DATA_ERROR', 'Spot quotes failed');
  }
  if (!spots || !spots.NIFTY) {
    state.counters.dataErrors += 1;
    return finish('DATA_ERROR', 'NIFTY spot quote was not returned');
  }

  const live = marketLive(spots, nowMs);
  const vix = spots.INDIA_VIX?.ltp ?? null;
  const session = istParts(nowMs);
  if (!live.live) {
    const status = isWithinSessionHours(nowMs) ? 'MARKET_NOT_LIVE' : session.minuteOfDay >= 15 * 60 + 30 && session.weekday >= 1 && session.weekday <= 5 ? 'MARKET_CLOSED' : 'OFF_HOURS';
    state.market = {
      at: new Date(nowMs).toISOString(),
      live: false,
      liveReason: live.reason,
      spots,
      vix,
      vixPctile: null,
      regimes: state.market?.regimes ?? {},
    };
    return finish(status, live.reason);
  }

  state.counters.tradingCycles += 1;
  const cache = opts.history ?? history();
  const vixSeries = buildVixSeries(cache?.INDIA_VIX ?? []);
  const vixPctile = vix === null ? null : vixSeries.percentile(today, vix);
  const fromIst = formatIstForAngel(nowMs - 35 * 86_400_000);
  const toIst = formatIstForAngel(nowMs);

  const regimes: MarketSnapshot['regimes'] = {};
  const trendMap: Record<string, UnderlyingTrendContext> = {};
  const signalPlans: Array<{ underlying: string; candles: Candle[]; index: number }> = [];
  for (const underlying of UNDERLYINGS) {
    let fresh: Candle[] | null = null;
    try {
      fresh = await market.fetchCandles(underlying, fromIst, toIst);
    } catch {
      fresh = null;
    }
    const candles = mergeCandles(cache?.[underlying] ?? [], fresh ?? []);
    if (candles.length < 80) {
      if (!fresh) state.counters.dataErrors += 1;
      continue;
    }
    const rows = computeIndicators(candles);
    const idx = lastCompleteIndex(candles, nowMs);
    if (idx < 0 || !isRowComplete(rows[idx])) continue;
    const barStart = candles[idx].time;
    const barEnd = hourlyBarEndMs(Date.parse(barStart));
    regimes[underlying] = {
      regime: classifyRegime(rows[idx], vixPctile),
      rsi14: rows[idx].rsi14,
      adx14: rows[idx].adx14,
      barStart,
    };
    // Compute session VWAP for the underlying Trend Gate
    const barDate = istDate(Date.parse(barStart));
    let pv = 0;
    let vv = 0;
    for (let k = Math.max(0, idx - 8); k <= idx; k++) {
      if (istDate(Date.parse(candles[k].time)) === barDate) {
        const typ = (candles[k].high + candles[k].low + candles[k].close) / 3;
        const vol = candles[k].volume || 1;
        pv += typ * vol;
        vv += vol;
      }
    }
    trendMap[underlying] = {
      spot: spots[underlying]?.ltp ?? candles[idx].close,
      ema20: rows[idx].ema20,
      vwap: vv > 0 ? pv / vv : candles[idx].close,
      adx14: rows[idx].adx14,
      prevAdx14: idx > 0 ? rows[idx - 1].adx14 : rows[idx].adx14,
    };
    if (nowMs - barEnd > 60 * 60 * 1000) continue;
    signalPlans.push({ underlying, candles, index: idx });
  }

  let instruments: NfoInstrument[] = [];
  try {
    instruments = await loadInstruments(store, market, nowMs, spots);
    if (instruments.length > 0) state.instrumentsAsOf = today;
  } catch (err) {
    state.counters.dataErrors += 1;
    log(state, 'DATA', err instanceof Error ? err.message : 'Instrument master failed');
  }

  const quoteTokens = new Set<string>();
  for (const pos of state.openPositions) {
    quoteTokens.add(pos.plan.long.token);
    quoteTokens.add(pos.plan.short.token);
  }
  for (const cand of state.activeCandidates) {
    quoteTokens.add(cand.plan.long.token);
    quoteTokens.add(cand.plan.short.token);
  }

  interface PendingSignal {
    underlying: string;
    index: number;
    candles: Candle[];
    expiry: string;
    dte: number;
    tokens: string[];
  }
  const pendingSignals: PendingSignal[] = [];
  const minute = istParts(nowMs).minuteOfDay;
  const entriesOpen = minute >= cfg.entryStartMinuteIst && minute <= cfg.entryEndMinuteIst;

  for (const plan of signalPlans) {
    const rows = computeIndicators(plan.candles);
    const sig = detectSignal(plan.candles, rows, plan.index, vixPctile);
    if (!sig) continue;
    const key = `${plan.underlying}:${sig.direction}`;
    const barTime = plan.candles[plan.index].time;
    if (state.lastSignalBar[key] === barTime) continue;
    if (state.activeCandidates.some((c) => c.underlying === plan.underlying && c.direction === sig.direction && c.signalBarStart === barTime)) {
      state.lastSignalBar[key] = barTime;
      continue;
    }
    if (!entriesOpen) {
      state.lastSignalBar[key] = barTime;
      log(state, 'SKIP', `${plan.underlying} signal outside the 09:30–15:00 entry window`, plan.underlying);
      continue;
    }
    if (instruments.length === 0) {
      log(state, 'DATA', `${plan.underlying} signal is waiting for the instrument master`, plan.underlying);
      continue;
    }
    const expiry = pickExpiry(instruments, plan.underlying, today, cfg);
    if (!expiry) {
      state.lastSignalBar[key] = barTime;
      state.counters.plansRejected += 1;
      log(state, 'SKIP', `${plan.underlying} has no expiry between ${cfg.minDte} and ${cfg.maxDte} days`, plan.underlying);
      continue;
    }
    const chain = instruments.filter((i) => i.underlying === plan.underlying && i.expiry === expiry && i.right === sig.direction);
    const legs = selectChainLegs(
      chain.map((c) => ({ token: c.token, symbol: c.symbol, strike: c.strike, lotSize: c.lotSize })),
      spots[plan.underlying]?.ltp ?? plan.candles[plan.index].close,
      sig.direction,
      cfg.maxShortSteps
    );
    for (const leg of legs) quoteTokens.add(leg.token);
    pendingSignals.push({
      underlying: plan.underlying,
      index: plan.index,
      candles: plan.candles,
      expiry,
      dte: calendarDaysBetween(today, expiry),
      tokens: legs.map((l) => l.token),
    });
  }

  let quotes: Record<string, LegQuote> = {};
  if (quoteTokens.size > 0) {
    try {
      const fetched = await market.fetchOptionQuotes([...quoteTokens]);
      if (!fetched) {
        state.counters.dataErrors += 1;
        log(state, 'DATA', 'Option quote batch failed; open positions were not marked this cycle');
      } else quotes = fetched;
    } catch (err) {
      state.counters.dataErrors += 1;
      log(state, 'DATA', err instanceof Error ? err.message : 'Option quote batch failed');
    }
  }

  for (const pos of state.openPositions) {
    bumpSession(pos, today);
    applyMark(pos, quotes, nowMs, cfg, state, trendMap, today);
  }
  for (const cand of state.activeCandidates) {
    bumpSession(cand, today);
    applyMark(cand, quotes, nowMs, cfg, state, trendMap, today);
  }

  const stillOpen: PaperPosition[] = [];
  for (const pos of state.openPositions) {
    const reason = exitReasonFor(pos, cfg, today, false);
    if (!reason) {
      stillOpen.push(pos);
      continue;
    }
    closePosition(state, pos, reason, nowMs);
    const cand = state.activeCandidates.find((c) => c.id === pos.candidateId);
    if (cand && !cand.closedAt) {
      cand.lastMark = pos.lastMark;
      cand.peakValue = pos.peakValue;
      cand.confirmedPeakValue = pos.confirmedPeakValue;
      cand.troughValue = pos.troughValue;
      cand.sessionsHeld = pos.sessionsHeld;
      closeCandidate(state, cand, reason, nowMs);
    }
  }
  state.openPositions = stillOpen;
  const stillActive: Candidate[] = [];
  for (const cand of state.activeCandidates) {
    if (cand.closedAt) continue;
    const reason = exitReasonFor(cand, cfg, today, true);
    if (!reason) {
      stillActive.push(cand);
      continue;
    }
    closeCandidate(state, cand, reason, nowMs);
  }
  state.activeCandidates = stillActive;

  revalue(state, spots.NIFTY?.ltp ?? null);
  const suspended = new Set(suspendedStrategies(state.liveSamples));
  for (const pending of pendingSignals) {
    const rows = computeIndicators(pending.candles);
    const sig = detectSignal(pending.candles, rows, pending.index, vixPctile);
    const spot = spots[pending.underlying]?.ltp;
    if (!sig || !(spot && spot > 0)) continue;
    const chain = instruments
      .filter((i) => i.underlying === pending.underlying && i.expiry === pending.expiry && i.right === sig.direction)
      .map((c) => ({ token: c.token, symbol: c.symbol, strike: c.strike, lotSize: c.lotSize }));
    const built = buildSpreadPlan({
      underlying: pending.underlying,
      right: sig.direction,
      expiry: pending.expiry,
      dte: pending.dte,
      spot,
      chain,
      quotes,
      budgetPerTradeInr: state.lastEquity * cfg.riskPerTradePct,
      nowMs,
      cfg,
    });
    if (!built.ok) {
      state.counters.plansRejected += 1;
      log(state, 'SKIP', `${pending.underlying} ${sig.direction}: ${built.reason}`, pending.underlying);
      continue;
    }
    if (
      state.activeCandidates.some(
        (c) =>
          c.underlying === pending.underlying &&
          c.direction === sig.direction &&
          c.plan.expiry === pending.expiry &&
          c.plan.long.strike === built.plan.long.strike &&
          c.plan.short.strike === built.plan.short.strike
      )
    ) {
      state.lastSignalBar[`${pending.underlying}:${sig.direction}`] = pending.candles[pending.index].time;
      continue;
    }
    const features = buildFeatures(sig, {
      vixPctile,
      isIndex: INDEX_UNDERLYINGS.has(pending.underlying),
      dte: pending.dte,
      debitRatio: built.plan.debitRatio,
      legSpreadPct: built.plan.legSpreadPct,
    });
    const model = state.model;
    const modelProb =
      model && features.length === model.weights.length
        ? predictProb(model, features)
        : null;
    let skip: string | null = null;
    if (!built.affordable) skip = `1 lot risks ₹${built.plan.maxLossPerLot.toFixed(0)}, above the per-trade budget`;
    else if (suspended.has(sig.strategy)) skip = `${sig.strategy} is suspended: its live results are negative with 90% confidence`;
    else if (model?.gate.active && model.gate.threshold !== null && (modelProb === null || modelProb < model.gate.threshold)) {
      skip = `Model probability ${modelProb === null ? 'n/a' : modelProb.toFixed(2)} is below the gate ${model.gate.threshold.toFixed(2)}`;
    }

    const initialLearned = predictExitDecision(state.model?.exitPolicy, features, {
      mfeFrac: 0,
      sessionsHeld: 1,
      trendAligned: true,
      adxRising: true,
      defaultStopLossFrac: cfg.stopLossFracOfDebit,
    });
    const initStop = round2(built.plan.entryDebit * (1 - cfg.stopLossFracOfDebit));

    const candidate: Candidate = {
      id: `C-${pending.underlying}-${sig.direction}-${Date.parse(pending.candles[pending.index].time)}`,
      createdAt: new Date(nowMs).toISOString(),
      underlying: pending.underlying,
      strategy: sig.strategy,
      direction: sig.direction,
      regime: sig.regime,
      signalBarStart: pending.candles[pending.index].time,
      reason: sig.reason,
      indicators: snapshotOf(rows[pending.index]),
      vix: vix ?? 0,
      vixPctile: vixPctile ?? 0,
      features,
      modelProb,
      modelVersion: model?.version ?? null,
      gateActive: Boolean(model?.gate.active),
      gateThreshold: model?.gate.threshold ?? null,
      plan: built.plan,
      affordable: built.affordable,
      takenByLedger: false,
      positionId: null,
      skipReason: skip,
      lastMark: entryMark(built.plan, nowMs),
      peakValue: built.plan.entryDebit,
      troughValue: built.plan.entryDebit,
      recentMarks: [built.plan.entryDebit],
      confirmedPeakValue: built.plan.entryDebit,
      exitRuleVersion: 'ADAPTIVE_LEARNED',
      runnerArmed: false,
      runnerFloor: initStop,
      runnerFloorV31: initStop,
      runnerFloorLearned: initStop,
      runnerTrendGatePassed: null,
      runnerTrendGateReason: null,
      learnedRunnerProb: initialLearned.runnerProb,
      learnedRecoveryProb: initialLearned.recoveryProb,
      learnedKeepFrac: initialLearned.learnedKeepFrac,
      learnedEarlyStopTightened: initialLearned.earlyStopTighten,
      learnedExitAction: initialLearned.actionSummary,
      sessionsHeld: 1,
      lastSessionDate: today,
      staleMarks: 0,
    };

    if (!skip) {
      const decision = evaluateEntryRisk({
        cfg,
        equity: state.lastEquity,
        cash: state.cash,
        entriesEnabled: state.control.entriesEnabled,
        killSwitchActive: state.killSwitch.active,
        dailyHalt: state.dailyHalt,
        openPositions: state.openPositions,
        isIndex: INDEX_UNDERLYINGS.has(pending.underlying),
        plan: built.plan,
      });
      if (!decision.allowed) {
        candidate.skipReason = decision.reason;
        log(state, 'SKIP', `${pending.underlying} ${sig.direction}: ${decision.reason}`, pending.underlying);
      } else {
        const position: PaperPosition = {
          id: `P-${candidate.id}`,
          candidateId: candidate.id,
          openedAt: candidate.createdAt,
          underlying: candidate.underlying,
          strategy: candidate.strategy,
          direction: candidate.direction,
          regime: candidate.regime,
          lots: decision.lots,
          plan: built.plan,
          entryCashOutInr: decision.cashOutInr,
          maxLossInr: decision.maxLossInr,
          marginBlockedInr: decision.marginInr,
          lastMark: candidate.lastMark,
          peakValue: candidate.peakValue,
          troughValue: candidate.troughValue,
          recentMarks: [built.plan.entryDebit],
          confirmedPeakValue: built.plan.entryDebit,
          exitRuleVersion: 'ADAPTIVE_LEARNED',
          runnerArmed: false,
          runnerFloor: initStop,
          runnerFloorV31: initStop,
          runnerFloorLearned: initStop,
          runnerTrendGatePassed: null,
          runnerTrendGateReason: null,
          learnedRunnerProb: initialLearned.runnerProb,
          learnedRecoveryProb: initialLearned.recoveryProb,
          learnedKeepFrac: initialLearned.learnedKeepFrac,
          learnedEarlyStopTightened: initialLearned.earlyStopTighten,
          learnedExitAction: initialLearned.actionSummary,
          sessionsHeld: 1,
          lastSessionDate: today,
          staleMarks: 0,
          unrealizedInr: 0,
          modelProb,
          entryReason: sig.reason,
        };
        state.cash = round2(state.cash - decision.cashOutInr);
        state.openPositions.push(position);
        state.counters.tradesOpened += 1;
        candidate.takenByLedger = true;
        candidate.positionId = position.id;
        candidate.skipReason = null;
        log(state, 'ENTRY', `${pending.underlying} ${sig.direction} ${decision.lots} lot, debit ₹${built.plan.entryDebit.toFixed(2)}, cash out ₹${decision.cashOutInr.toFixed(0)}`, pending.underlying);
      }
    } else {
      log(state, 'SKIP', `${pending.underlying} ${sig.direction}: ${skip}`, pending.underlying);
    }
    state.lastSignalBar[`${pending.underlying}:${sig.direction}`] = pending.candles[pending.index].time;
    state.activeCandidates.push(candidate);
    state.counters.candidatesCreated += 1;
    log(state, 'SIGNAL', sig.reason, pending.underlying);
  }

  const valued = revalue(state, spots.NIFTY?.ltp ?? null);
  pushEquityPoint(state, nowMs, {
    equity: valued.equity,
    equityMid: valued.equityMid,
    cash: state.cash,
    benchmark: valued.benchmark,
    drawdownPct: valued.drawdownPct,
    openPositions: state.openPositions.length,
  });
  state.market = {
    at: new Date(nowMs).toISOString(),
    live: true,
    liveReason: live.reason,
    spots,
    vix,
    vixPctile,
    regimes,
  };
  if (train) {
    try {
      maybeTrain(state, nowMs, false);
    } catch (err) {
      log(state, 'ERROR', err instanceof Error ? err.message : 'Training failed');
    }
  }
  return finish(
    'TRADED',
    `Live cycle. Equity ₹${valued.equity.toFixed(0)}, ${state.openPositions.length} open, ${state.activeCandidates.length} candidates tracked.`
  );
}

function pickExpiry(instruments: NfoInstrument[], underlying: string, today: string, cfg: EngineConfig): string | null {
  const expiries = [...new Set(instruments.filter((i) => i.underlying === underlying).map((i) => i.expiry))].sort();
  return (
    expiries.find((e) => {
      const dte = calendarDaysBetween(today, e);
      return dte >= cfg.minDte && dte <= cfg.maxDte;
    }) ?? null
  );
}

export async function resetPaperLedger(
  store: KvStore,
  nowMs: number,
  capital?: number
): Promise<{ ok: true; state: LedgerState } | { ok: false; error: string }> {
  const leased = await withLease(store, async () => {
    const fresh = createInitialLedger(nowMs, capital ?? startingCapitalFromEnv());
    const active = await store.get<{ ledgerId: string }>(KEY_ACTIVE);
    const saved = await store.put(stateKey(fresh.ledgerId), fresh, null);
    if (!saved.ok) return { ok: false as const, error: 'Could not create the new ledger' };
    const pointed = await store.put(KEY_ACTIVE, { ledgerId: fresh.ledgerId }, active ? active.rev : null);
    if (!pointed.ok) return { ok: false as const, error: 'Could not switch the active ledger' };
    return { ok: true as const, state: fresh };
  });
  if (leased.busy) return { ok: false, error: 'A cycle is running. Try again in a moment.' };
  return leased.value;
}

export async function mutateLedger(
  store: KvStore,
  nowMs: number,
  mutator: (state: LedgerState) => void
): Promise<{ ok: true; state: LedgerState } | { ok: false; error: string }> {
  const leased = await withLease(store, async () => {
    const loaded = await loadOrCreate(store, nowMs);
    mutator(loaded.state);
    const persisted = await persist(store, loaded.state, loaded.rev);
    if (!persisted) return { ok: false as const, error: 'The ledger changed while saving. Try again.' };
    return { ok: true as const, state: loaded.state };
  });
  if (leased.busy) return { ok: false, error: 'A cycle is running. Try again in a moment.' };
  return leased.value;
}

export async function readJournal(
  store: KvStore,
  ledgerId: string,
  kind: 'trades' | 'candidates',
  month?: string
): Promise<unknown[]> {
  const state = await store.get<LedgerState>(stateKey(ledgerId));
  const pending = kind === 'trades' ? state?.data.pending.trades ?? [] : state?.data.pending.candidates ?? [];
  const months = month
    ? [month]
    : [istMonthKey(Date.now()), istMonthKey(Date.now() - 32 * 86_400_000)];
  const rows: unknown[] = [];
  for (const m of months) {
    const key = kind === 'trades' ? tradesKey(ledgerId, m) : candidatesKey(ledgerId, m);
    const archived = await store.get<unknown[]>(key);
    if (archived) rows.push(...archived.data);
  }
  const seen = new Set(rows.map((r) => (r as { id?: string }).id));
  for (const item of pending) {
    const when = Date.parse((item as { closedAt?: string }).closedAt || '');
    if (month && Number.isFinite(when) && istMonthKey(when) !== month) continue;
    if (!seen.has(item.id)) rows.push(item);
  }
  rows.sort((a, b) => Date.parse((b as { closedAt?: string }).closedAt || '') - Date.parse((a as { closedAt?: string }).closedAt || ''));
  return rows;
}

function hydrateLearnedExitFields(state: LedgerState) {
  const policy = state.model?.exitPolicy;
  const cfg = state.config;
  for (const cand of state.activeCandidates) {
    cand.exitRuleVersion = 'ADAPTIVE_LEARNED';
    const maxGain = Math.max(0.01, cand.plan.width - cand.plan.entryDebit);
    const peak = cand.confirmedPeakValue ?? cand.peakValue;
    const mfeFrac = Math.max(0, (peak - cand.plan.entryDebit) / maxGain);
    const dec = predictExitDecision(policy, cand.features, {
      mfeFrac,
      sessionsHeld: cand.sessionsHeld,
      defaultStopLossFrac: cfg.stopLossFracOfDebit,
    });
    cand.learnedRunnerProb = dec.runnerProb;
    cand.learnedRecoveryProb = dec.recoveryProb;
    cand.learnedKeepFrac = dec.learnedKeepFrac;
    cand.learnedEarlyStopTightened = dec.earlyStopTighten;
    cand.learnedExitAction = dec.actionSummary;
  }
  for (const pos of state.openPositions) {
    pos.exitRuleVersion = 'ADAPTIVE_LEARNED';
    const features = resolveFeaturesFor(pos, state);
    const maxGain = Math.max(0.01, pos.plan.width - pos.plan.entryDebit);
    const peak = pos.confirmedPeakValue ?? pos.peakValue;
    const mfeFrac = Math.max(0, (peak - pos.plan.entryDebit) / maxGain);
    const dec = predictExitDecision(policy, features, {
      mfeFrac,
      sessionsHeld: pos.sessionsHeld,
      defaultStopLossFrac: cfg.stopLossFracOfDebit,
    });
    pos.learnedRunnerProb = dec.runnerProb;
    pos.learnedRecoveryProb = dec.recoveryProb;
    pos.learnedKeepFrac = dec.learnedKeepFrac;
    pos.learnedEarlyStopTightened = dec.earlyStopTighten;
    pos.learnedExitAction = dec.actionSummary;
  }
}

export async function readActiveLedger(store: KvStore): Promise<LedgerState | null> {
  const loaded = await loadOrCreate(store, Date.now());
  const state = loaded.state;
  try {
    maybeTrain(state, Date.now(), false);
  } catch {
    // ignore
  }
  hydrateLearnedExitFields(state);
  revalue(state, state.market?.spots?.NIFTY?.ltp ?? null);
  return state;
}

let lastLiveRefreshMs = 0;
let lastLiveStateMemo: LedgerState | null = null;
let lastDbPersistMs = 0;

/**
 * Fast real-time quote & position mark refresher (< 250ms).
 * Fetches live Angel One NSE spot quotes and NFO option quotes for open positions/candidates
 * in parallel without running the heavy 9-symbol historical candle scan.
 */
export async function refreshLiveState(
  store: KvStore,
  market: MarketData,
  nowMs = Date.now()
): Promise<LedgerState | null> {
  if (lastLiveStateMemo && nowMs - lastLiveRefreshMs < 1800) {
    return lastLiveStateMemo;
  }
  const loaded = await loadOrCreate(store, nowMs);
  const row = { data: loaded.state, rev: loaded.rev };

  const state = row.data;
  state.config = { ...DEFAULT_ENGINE_CONFIG };
  // Deduplicate any identical active shadow contracts (keep the earliest entry)
  const seenContracts = new Set<string>();
  state.activeCandidates = state.activeCandidates.filter((c) => {
    const contractKey = `${c.underlying}:${c.direction}:${c.plan.expiry}:${c.plan.long.strike}:${c.plan.short.strike}`;
    if (seenContracts.has(contractKey) && !c.takenByLedger) return false;
    seenContracts.add(contractKey);
    return true;
  });
  try {
    maybeTrain(state, nowMs, false);
  } catch {
    // ignore background train errors during fast quote refresh
  }
  hydrateLearnedExitFields(state);
  const cfg = state.config;

  const quoteTokens = new Set<string>();
  for (const pos of state.openPositions) {
    quoteTokens.add(pos.plan.long.token);
    quoteTokens.add(pos.plan.short.token);
  }
  for (const cand of state.activeCandidates) {
    quoteTokens.add(cand.plan.long.token);
    quoteTokens.add(cand.plan.short.token);
  }

  try {
    const [spots, optionQuotes] = await Promise.all([
      market.fetchSpots().catch(() => null),
      quoteTokens.size > 0 ? market.fetchOptionQuotes([...quoteTokens]).catch(() => null) : Promise.resolve(null),
    ]);

    state.angel = market.status();

    if (spots && spots.NIFTY) {
      const live = marketLive(spots, nowMs);
      state.market = {
        at: new Date(nowMs).toISOString(),
        live: live.live,
        liveReason: live.reason,
        spots,
        vix: spots.INDIA_VIX?.ltp ?? state.market?.vix ?? null,
        vixPctile: state.market?.vixPctile ?? null,
        regimes: state.market?.regimes ?? {},
      };
    }

    const today = istDate(nowMs);
    let exitExecuted = false;
    let floorOrPeakRaised = false;
    if (optionQuotes && Object.keys(optionQuotes).length > 0) {
      const stillOpen: PaperPosition[] = [];
      for (const pos of state.openPositions) {
        const prevPeak = pos.peakValue ?? pos.plan.entryDebit;
        const prevFloor = Math.max(pos.runnerFloor ?? 0, pos.runnerFloorV31 ?? 0, pos.runnerFloorLearned ?? 0);
        pos.exitRuleVersion = 'ADAPTIVE_LEARNED';
        applyMark(pos, optionQuotes, nowMs, cfg, state, undefined, today);
        const nextPeak = pos.peakValue ?? pos.plan.entryDebit;
        const nextFloor = Math.max(pos.runnerFloor ?? 0, pos.runnerFloorV31 ?? 0, pos.runnerFloorLearned ?? 0);
        if (nextPeak > prevPeak || nextFloor > prevFloor) {
          floorOrPeakRaised = true;
        }
        const reason = exitReasonFor(pos, cfg, today, false);
        if (!reason) {
          stillOpen.push(pos);
          continue;
        }
        closePosition(state, pos, reason, nowMs);
        exitExecuted = true;
        const cand = state.activeCandidates.find((c) => c.id === pos.candidateId);
        if (cand && !cand.closedAt) {
          cand.lastMark = pos.lastMark;
          cand.peakValue = pos.peakValue;
          cand.confirmedPeakValue = pos.confirmedPeakValue;
          cand.troughValue = pos.troughValue;
          cand.sessionsHeld = pos.sessionsHeld;
          closeCandidate(state, cand, reason, nowMs);
        }
      }
      state.openPositions = stillOpen;

      const stillActive: Candidate[] = [];
      for (const cand of state.activeCandidates) {
        if (cand.closedAt) continue;
        cand.exitRuleVersion = 'ADAPTIVE_LEARNED';
        applyMark(cand, optionQuotes, nowMs, cfg, state, undefined, today);
        const reason = exitReasonFor(cand, cfg, today, true);
        if (!reason) {
          stillActive.push(cand);
          continue;
        }
        closeCandidate(state, cand, reason, nowMs);
        exitExecuted = true;
      }
      state.activeCandidates = stillActive;
    }

    revalue(state, state.market?.spots?.NIFTY?.ltp ?? null);
    lastLiveRefreshMs = nowMs;
    lastLiveStateMemo = state;

    // Persist immediately if an exit executed or if any position's peak/floor ratcheted up
    if (exitExecuted || floorOrPeakRaised) {
      lastDbPersistMs = nowMs;
      await persist(store, state, row.rev).catch(() => {});
    } else if (nowMs - lastDbPersistMs >= 15_000 && state.market?.live && !cycleInFlight) {
      lastDbPersistMs = nowMs;
      await persist(store, state, row.rev).catch(() => {});
    }

    // Trigger a new hourly signal scan cycle if a new :15 hourly bar completed since the last cycle
    const lastCycleMs = state.lastCycle ? Date.parse(state.lastCycle.at) : 0;
    const istMin = istParts(nowMs).minuteOfDay;
    const barBoundaryPassed =
      state.market?.live &&
      istMin >= 9 * 60 + 30 &&
      istMin <= 15 * 60 + 20 &&
      Math.floor((nowMs + 5.5 * 3600_000 - 15 * 60_000) / 3600_000) >
        Math.floor((lastCycleMs + 5.5 * 3600_000 - 15 * 60_000) / 3600_000);

    if (barBoundaryPassed && !cycleInFlight) {
      void runPaperCycle(store, market, { force: true }).catch(() => {});
    }
  } catch {
    revalue(state, state.market?.spots?.NIFTY?.ltp ?? null);
  }

  return state;
}

