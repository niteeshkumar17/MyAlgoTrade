/** Position sizing and portfolio risk limits for new paper entries. */

import { entryChargesFor, estimateShortLegMargin, maxLossFor } from './options.js';
import type { EngineConfig, PaperPosition, SpreadPlan } from './types.js';

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  startingCapitalInr: 50_000,
  riskPerTradePct: 0.04,
  maxOpenPositions: 3,
  maxOpenRiskPct: 0.1,
  maxPositionsPerUnderlying: 1,
  dailyLossHaltPct: 0.03,
  drawdownKillPct: 0.1,
  maxCapitalUsePct: 0.9,
  exposureMarginPctIndex: 0.02,
  exposureMarginPctStock: 0.035,
  entryStartMinuteIst: 9 * 60 + 30,
  entryEndMinuteIst: 15 * 60,
  minDte: 7,
  maxDte: 35,
  exitAtDte: 2,
  takeProfitFracOfMaxGain: 0.5,
  stopLossFracOfDebit: 0.5,
  maxHoldSessions: 5,
  maxLegSpreadPct: 0.08,
  minLongLegPrice: 1,
  maxShortSteps: 4,
  minDebitRatio: 0.2,
  maxDebitRatio: 0.8,
  quoteMaxAgeSec: 120,
  cycleMinIntervalSec: 240,
};

const MAX_LOTS = 10;

export type RiskRejectCode =
  | 'PAUSED'
  | 'KILL_SWITCH'
  | 'DAILY_HALT'
  | 'MAX_POSITIONS'
  | 'SAME_UNDERLYING'
  | 'PER_TRADE_RISK'
  | 'OPEN_RISK'
  | 'CAPITAL';

export const RISK_REJECT_LABELS: Record<RiskRejectCode, string> = {
  PAUSED: 'Entries paused',
  KILL_SWITCH: 'Drawdown kill switch active',
  DAILY_HALT: 'Daily loss limit hit',
  MAX_POSITIONS: 'Max open positions reached',
  SAME_UNDERLYING: 'Already holding that underlying',
  PER_TRADE_RISK: '1 lot risks more than the per-trade limit',
  OPEN_RISK: 'Total open risk limit',
  CAPITAL: 'Not enough free capital for debit + margin',
};

export type RiskDecision =
  | { allowed: true; lots: number; maxLossInr: number; marginInr: number; cashOutInr: number }
  | { allowed: false; code: RiskRejectCode; reason: string };

const inr = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`;

export function evaluateEntryRisk(input: {
  cfg: EngineConfig;
  equity: number;
  cash: number;
  entriesEnabled: boolean;
  killSwitchActive: boolean;
  dailyHalt: boolean;
  openPositions: Array<Pick<PaperPosition, 'underlying' | 'maxLossInr' | 'marginBlockedInr'>>;
  isIndex: boolean;
  plan: SpreadPlan;
}): RiskDecision {
  const { cfg, plan } = input;
  if (!input.entriesEnabled) return { allowed: false, code: 'PAUSED', reason: 'New entries are paused' };
  if (input.killSwitchActive) {
    return { allowed: false, code: 'KILL_SWITCH', reason: 'Drawdown kill switch is active' };
  }
  if (input.dailyHalt) {
    return { allowed: false, code: 'DAILY_HALT', reason: 'Daily loss limit hit; no new entries until the next session' };
  }
  if (input.openPositions.length >= cfg.maxOpenPositions) {
    return {
      allowed: false,
      code: 'MAX_POSITIONS',
      reason: `Already ${input.openPositions.length} open positions (max ${cfg.maxOpenPositions})`,
    };
  }
  const sameUnderlying = input.openPositions.filter((p) => p.underlying === plan.underlying).length;
  if (sameUnderlying >= cfg.maxPositionsPerUnderlying) {
    return { allowed: false, code: 'SAME_UNDERLYING', reason: `Already holding a ${plan.underlying} position` };
  }

  const budget = input.equity * cfg.riskPerTradePct;
  let lots = Math.min(MAX_LOTS, Math.floor(budget / plan.maxLossPerLot));
  if (lots < 1) {
    return {
      allowed: false,
      code: 'PER_TRADE_RISK',
      reason: `1 lot risks ${inr(plan.maxLossPerLot)}, above the ${inr(budget)} per-trade limit (${(cfg.riskPerTradePct * 100).toFixed(0)}% of equity)`,
    };
  }

  const openRisk = input.openPositions.reduce((a, p) => a + p.maxLossInr, 0);
  const riskRoom = input.equity * cfg.maxOpenRiskPct - openRisk;
  lots = Math.min(lots, Math.floor(riskRoom / plan.maxLossPerLot));
  if (lots < 1) {
    return {
      allowed: false,
      code: 'OPEN_RISK',
      reason: `Open risk ${inr(openRisk)} plus this trade would exceed ${inr(input.equity * cfg.maxOpenRiskPct)} (${(cfg.maxOpenRiskPct * 100).toFixed(0)}% of equity)`,
    };
  }

  const blocked = input.openPositions.reduce((a, p) => a + p.marginBlockedInr, 0);
  const capitalLimit = input.cash * cfg.maxCapitalUsePct - blocked;
  for (; lots >= 1; lots--) {
    const units = lots * plan.lotSize;
    const cashOut = plan.entryDebit * units + entryChargesFor(plan, units);
    const margin = estimateShortLegMargin(plan, lots, input.isIndex, cfg);
    if (cashOut + margin <= capitalLimit) {
      return { allowed: true, lots, maxLossInr: maxLossFor(plan, lots), marginInr: margin, cashOutInr: cashOut };
    }
  }
  const units = plan.lotSize;
  const need = plan.entryDebit * units + entryChargesFor(plan, units) + estimateShortLegMargin(plan, 1, input.isIndex, cfg);
  return {
    allowed: false,
    code: 'CAPITAL',
    reason: `Needs ${inr(need)} (debit + estimated short-leg margin) but only ${inr(Math.max(0, capitalLimit))} is free`,
  };
}
