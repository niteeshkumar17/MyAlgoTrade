/** Go/no-go for real-money trading. Every check is computed from the paper ledger; none of them are hardcoded. */

import { groupStats, meanCi90, profitFactor } from './stats.js';
import type { ClosedSummary, ReadinessReport } from './types.js';

export function weeksBetween(fromIso: string, nowMs: number): number {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return 0;
  return (nowMs - from) / (7 * 86_400_000);
}

export function computeReadiness(input: {
  trades: ClosedSummary[];
  ledgerCreatedAt: string;
  nowMs: number;
  maxDrawdownPct: number;
  liveOosAuc: number | null;
}): ReadinessReport {
  const { trades } = input;
  const weeks = weeksBetween(input.ledgerCreatedAt, input.nowMs);
  const pnls = trades.map((t) => t.netPnlInr);
  const ci = meanCi90(pnls);
  const pf = profitFactor(pnls);
  const byRegime = groupStats(trades, (t) => t.regime, (t) => t.netPnlInr, (t) => t.rMultiple);
  const positiveRegimes = byRegime.filter((g) => g.n >= 20 && (g.expectancyInr ?? 0) > 0);

  const checks = [
    {
      id: 'sample',
      label: 'At least 200 closed paper trades',
      pass: trades.length >= 200,
      detail: `${trades.length} closed`,
    },
    {
      id: 'weeks',
      label: 'At least 8 weeks of paper trading',
      pass: weeks >= 8,
      detail: `${weeks.toFixed(1)} weeks since this ledger started`,
    },
    {
      id: 'expectancy',
      label: 'Expectancy 90% confidence interval is above zero',
      pass: ci !== null && ci[0] > 0,
      detail: ci ? `₹${ci[0].toFixed(0)} to ₹${ci[1].toFixed(0)} per trade` : 'Needs at least 10 closed trades',
    },
    {
      id: 'profit-factor',
      label: 'Profit factor above 1.30',
      pass: pf !== null && pf > 1.3,
      detail: pf === null ? 'No losing trades yet' : pf.toFixed(2),
    },
    {
      id: 'drawdown',
      label: 'Maximum drawdown under 10%',
      pass: input.maxDrawdownPct < 10,
      detail: `${input.maxDrawdownPct.toFixed(2)}%`,
    },
    {
      id: 'regimes',
      label: 'Positive in at least 2 regimes with 20 trades each',
      pass: positiveRegimes.length >= 2,
      detail:
        byRegime.length === 0
          ? 'No closed trades yet'
          : byRegime.map((g) => `${g.key} ${g.n} trades, avg ₹${(g.expectancyInr ?? 0).toFixed(0)}`).join('; '),
    },
  ];

  return {
    readyForRealMoney: checks.every((c) => c.pass),
    checks,
    note:
      input.liveOosAuc === null
        ? 'Live out-of-sample AUC is not available yet. It is shown for information and is not a pass/fail check.'
        : `Live out-of-sample AUC is ${input.liveOosAuc.toFixed(3)}. It is information, not a pass/fail check.`,
  };
}
