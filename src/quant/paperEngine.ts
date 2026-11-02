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
import { predictProb, suspendedStrategies, trainModelSnapshot, type Sample } from './model.js';
import { buildSpreadPlan, evaluateSpreadExit, exitChargesFor, markSpread, selectChainLegs } from './options.js';
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
  type ClosedSummary,
  type ClosedTrade,
  type EngineConfig,
  type EquityPoint,
  type ExitReason,
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
const TRAIN_EVERY_LABELS = 10;

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

async function withLease<T>(store: KvStore, fn: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
  const now = Date.now();
  const current = await store.get<{ owner: string; until: number }>(KEY_LEASE);
  if (current && current.data.until > now && current.data.owner !== OWNER) return { busy: true };
  const claimed = await store.put(KEY_LEASE, { owner: OWNER, until: now + LEASE_MS }, current ? current.rev : null);
  if (!claimed.ok) return { busy: true };
  try {
    return { busy: false, value: await fn() };
  } finally {
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

async function persist(store: KvStore, state: LedgerState, rev: number): Promise<boolean> {
  const saved = await store.put(stateKey(state.ledgerId), state, rev);
  if (!saved.ok) return false;
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
  plan: SpreadPlan;
  lastMark: SpreadMark | null;
  peakValue: number;
  troughValue: number;
  sessionsHeld: number;
  lastSessionDate: string;
  staleMarks: number;
}

function bumpSession(item: Tracked, today: string) {
  if (item.lastSessionDate !== today) {
    item.sessionsHeld += 1;
    item.lastSessionDate = today;
  }
}

function applyMark(item: Tracked, quotes: Record<string, LegQuote>, nowMs: number, cfg: EngineConfig, state: LedgerState) {
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
}

function exitReasonFor(item: Tracked, cfg: EngineConfig, today: string): ExitReason | null {
  if (!item.lastMark) return null;
  const fromRules = evaluateSpreadExit({
    plan: item.plan,
    liquidationValue: item.lastMark.liquidationValue,
    sessionsHeld: item.sessionsHeld,
    dte: calendarDaysBetween(today, item.plan.expiry),
    cfg,
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
  candidate.pnlPerLotMidInr = round2(
    (mark.midValue - candidate.plan.midDebit) * candidate.plan.lotSize - candidate.plan.entryChargesPerLot - outcome.exitCharges
  );
  candidate.rMultiple = outcome.r;
  candidate.win = outcome.pnl > 0;
  state.counters.candidatesClosed += 1;
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
  };
  state.liveSamples.push(sample);
  state.pending.candidates.push(candidate);
  log(state, 'CANDIDATE', `${candidate.underlying} ${candidate.direction} ${candidate.strategy} closed ${reason}: ${outcome.pnl.toFixed(0)} ₹/lot (${outcome.r.toFixed(2)}R)`, candidate.underlying);
}

function closePosition(state: LedgerState, position: PaperPosition, reason: ExitReason, nowMs: number): ClosedTrade | null {
  const mark = position.lastMark;
  if (!mark) return null;
  const units = position.lots * position.plan.lotSize;
  const exitCharges = exitChargesFor(mark.longBid, mark.shortAsk, units);
  const exitCashIn = round2(mark.liquidationValue * units - exitCharges);
  state.cash = round2(state.cash + exitCashIn);
  const net = round2(exitCashIn - position.entryCashOutInr);
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
    mfePct: position.plan.entryDebit > 0 ? (position.peakValue - position.plan.entryDebit) / position.plan.entryDebit : 0,
    maePct: position.plan.entryDebit > 0 ? (position.troughValue - position.plan.entryDebit) / position.plan.entryDebit : 0,
    exitReason: reason,
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
  log(state, 'EXIT', `${position.underlying} ${position.direction} ${position.lots} lot closed ${reason}: ${net >= 0 ? '+' : ''}₹${net.toFixed(0)}`, position.underlying);
  return trade;
}

function revalue(state: LedgerState, niftyLtp: number | null) {
  let equity = state.cash;
  let equityMid = state.cash;
  let unrealized = 0;
  for (const pos of state.openPositions) {
    if (!pos.lastMark) continue;
    const value = markValue(pos.lastMark, pos.plan, pos.lots);
    equity += value.liquidationInr;
    equityMid += value.midInr;
    pos.unrealizedInr = round2(value.liquidationInr - pos.entryCashOutInr);
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
  if (!force && state.model && labels - state.liveLabelsAtLastTrain < TRAIN_EVERY_LABELS) return;
  const research = getOfflineResearch();
  const offline = research?.samples ?? [];
  const live: Sample[] = state.liveSamples.map((s) => ({
    id: s.id,
    x: s.x,
    y: s.y,
    r: s.r,
    entryMs: s.entryMs,
    exitMs: s.exitMs,
    weight: 1,
    source: 'LIVE',
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
  if (cached && cached.data.asOf === today && cached.data.items.length > 0) return cached.data.items;
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

  const finish = async (status: NonNullable<LedgerState['lastCycle']>['status'], summary: string) => {
    state.angel = market.status();
    state.lastCycle = { at: new Date(nowMs).toISOString(), durationMs: Date.now() - started, status, summary };
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
  const fromIst = formatIstForAngel(nowMs - 25 * 86_400_000);
  const toIst = formatIstForAngel(nowMs);

  const regimes: MarketSnapshot['regimes'] = {};
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
    if (state.activeCandidates.some((c) => c.underlying === plan.underlying && c.direction === sig.direction)) {
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
    applyMark(pos, quotes, nowMs, cfg, state);
  }
  for (const cand of state.activeCandidates) {
    bumpSession(cand, today);
    applyMark(cand, quotes, nowMs, cfg, state);
  }

  const stillOpen: PaperPosition[] = [];
  for (const pos of state.openPositions) {
    const reason = exitReasonFor(pos, cfg, today);
    if (!reason) {
      stillOpen.push(pos);
      continue;
    }
    closePosition(state, pos, reason, nowMs);
    const cand = state.activeCandidates.find((c) => c.id === pos.candidateId);
    if (cand && !cand.closedAt) {
      cand.lastMark = pos.lastMark;
      cand.peakValue = pos.peakValue;
      cand.troughValue = pos.troughValue;
      cand.sessionsHeld = pos.sessionsHeld;
      closeCandidate(state, cand, reason, nowMs);
    }
  }
  state.openPositions = stillOpen;
  const stillActive: Candidate[] = [];
  for (const cand of state.activeCandidates) {
    if (cand.closedAt) continue;
    const reason = exitReasonFor(cand, cfg, today);
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

export async function readActiveLedger(store: KvStore): Promise<LedgerState | null> {
  const active = await store.get<{ ledgerId: string }>(KEY_ACTIVE);
  if (!active) return null;
  const row = await store.get<LedgerState>(stateKey(active.data.ledgerId));
  return row?.data ?? null;
}
