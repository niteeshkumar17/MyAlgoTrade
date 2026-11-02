/** Dashboard numbers computed from the ledger. Nothing here is a stored claim. */

import { suspendedStrategies } from './model.js';
import { computeReadiness, weeksBetween } from './readiness.js';
import { groupStats, type GroupStat } from './stats.js';
import type {
  LedgerState,
  ReadinessReport,
  StrategyName,
} from './types.js';

export interface Scorecards {
  byStrategy: GroupStat[];
  byUnderlying: GroupStat[];
  byRegime: GroupStat[];
  byDirection: GroupStat[];
  byExit: GroupStat[];
}

export interface DashboardPayload {
  generatedAt: string;
  ledgerId: string;
  createdAt: string;
  startingCapitalInr: number;
  cash: number;
  equity: number;
  equityMid: number;
  mtmEquityInr: number;
  dayPnlInr: number;
  realizedPnlInr: number;
  unrealizedPnlInr: number;
  netUnrealizedPnlInr: number;
  estOpenChargesInr: number;
  peakEquity: number;
  maxDrawdownPct: number;
  weeksElapsed: number;
  dailyHalt: boolean;
  killSwitch: LedgerState['killSwitch'];
  control: LedgerState['control'];
  openPositions: LedgerState['openPositions'];
  activeCandidates: LedgerState['activeCandidates'];
  counters: LedgerState['counters'];
  lastCycle: LedgerState['lastCycle'];
  market: LedgerState['market'];
  angel: LedgerState['angel'];
  instrumentsAsOf: LedgerState['instrumentsAsOf'];
  model: LedgerState['model'];
  recentEquity: LedgerState['recentEquity'];
  decisionLog: LedgerState['decisionLog'];
  learningLog: LedgerState['learningLog'];
  suspendedStrategies: StrategyName[];
  tradeScorecards: Scorecards;
  candidateScorecards: Pick<Scorecards, 'byStrategy' | 'byUnderlying' | 'byRegime'>;
  readiness: ReadinessReport;
  config: LedgerState['config'];
}

function cards(
  items: Array<{ strategy: string; underlying: string; regime: string; direction: string; exitReason: string; net: number; r: number }>
): Scorecards {
  return {
    byStrategy: groupStats(items, (t) => t.strategy, (t) => t.net, (t) => t.r),
    byUnderlying: groupStats(items, (t) => t.underlying, (t) => t.net, (t) => t.r),
    byRegime: groupStats(items, (t) => t.regime, (t) => t.net, (t) => t.r),
    byDirection: groupStats(items, (t) => t.direction, (t) => t.net, (t) => t.r),
    byExit: groupStats(items, (t) => t.exitReason, (t) => t.net, (t) => t.r),
  };
}

export function buildDashboard(state: LedgerState, nowMs = Date.now()): DashboardPayload {
  const unrealized = state.openPositions.reduce((sum, p) => sum + p.unrealizedInr, 0);
  const netUnrealized = state.openPositions.reduce((sum, p) => sum + (p.netUnrealizedInr ?? p.unrealizedInr), 0);
  const estCharges = state.openPositions.reduce((sum, p) => sum + (p.estChargesInr ?? 0), 0);
  const realized = state.closedSummaries.reduce((sum, t) => sum + t.netPnlInr, 0);
  const mtmEquity = Math.round((state.startingCapitalInr + realized + unrealized) * 100) / 100;
  const tradeRows = state.closedSummaries.map((t) => ({
    strategy: t.strategy,
    underlying: t.underlying,
    regime: t.regime,
    direction: t.direction,
    exitReason: t.exitReason,
    net: t.netPnlInr,
    r: t.rMultiple,
  }));
  const candidateRows = state.liveSamples.map((s) => ({
    strategy: s.strategy,
    underlying: s.underlying,
    regime: s.regime,
    direction: s.direction,
    exitReason: s.exitReason,
    net: s.pnlPerLotInr,
    r: s.r,
  }));
  const candidateCards = cards(candidateRows);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    ledgerId: state.ledgerId,
    createdAt: state.createdAt,
    startingCapitalInr: state.startingCapitalInr,
    cash: state.cash,
    equity: state.lastEquity,
    equityMid: state.lastEquityMid,
    mtmEquityInr: mtmEquity,
    dayPnlInr: unrealized + realized,
    realizedPnlInr: realized,
    unrealizedPnlInr: unrealized,
    netUnrealizedPnlInr: netUnrealized,
    estOpenChargesInr: estCharges,
    peakEquity: state.peakEquity,
    maxDrawdownPct: state.maxDrawdownPct,
    weeksElapsed: weeksBetween(state.createdAt, nowMs),
    dailyHalt: state.dailyHalt,
    killSwitch: state.killSwitch,
    control: state.control,
    openPositions: state.openPositions,
    activeCandidates: state.activeCandidates,
    counters: state.counters,
    lastCycle: state.lastCycle,
    market: state.market,
    angel: state.angel,
    instrumentsAsOf: state.instrumentsAsOf,
    model: state.model,
    recentEquity: state.recentEquity,
    decisionLog: state.decisionLog,
    learningLog: state.learningLog,
    suspendedStrategies: suspendedStrategies(state.liveSamples),
    tradeScorecards: cards(tradeRows),
    candidateScorecards: {
      byStrategy: candidateCards.byStrategy,
      byUnderlying: candidateCards.byUnderlying,
      byRegime: candidateCards.byRegime,
    },
    readiness: computeReadiness({
      trades: state.closedSummaries,
      ledgerCreatedAt: state.createdAt,
      nowMs,
      maxDrawdownPct: state.maxDrawdownPct,
      liveOosAuc: state.model?.liveOos.auc ?? null,
    }),
    config: state.config,
  };
}
