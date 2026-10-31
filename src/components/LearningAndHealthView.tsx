import React from 'react';
import { formatInr } from '../quant/engine';
import { QuantSystemState } from '../quant/seedStore';

interface LearningAndHealthViewProps {
  learning: QuantSystemState['learning'];
  health: QuantSystemState['health'] & { heartbeatAgeMinutes: number; isOffline: boolean };
  control: QuantSystemState['control'];
  formatTimestamp: (iso: string) => string;
  onPromoteChallenger: () => Promise<void>;
  onRollbackChampion: () => Promise<void>;
  onToggleSimulateOffline: (makeOffline: boolean) => Promise<void>;
  onToggleStrictMarketHours: (strictOnly: boolean) => Promise<void>;
  onResetPaperLedger: () => Promise<void>;
}

export const LearningAndHealthView: React.FC<LearningAndHealthViewProps> = ({
  learning,
  health,
  control,
  formatTimestamp,
  onPromoteChallenger,
  onRollbackChampion,
  onToggleSimulateOffline,
  onToggleStrictMarketHours,
  onResetPaperLedger,
}) => {
  return (
    <div className="space-y-8">
      {/* Champion vs Challenger Shadow Mode & Model Governance */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Champion vs. Challenger (Shadow Mode Governance)
            </h2>
            <span className="text-xs font-mono text-slate-500">
              Active: {learning.championVersion} · Shadow: {learning.challengerVersion}
            </span>
          </div>

          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed mb-4">
            {learning.championVsChallenger.statusSummary}
          </p>

          <div className="grid grid-cols-2 gap-4 py-3 border-y border-slate-200 dark:border-slate-800 text-xs font-mono tabular-nums mb-4">
            <div>
              <div className="text-slate-500 font-sans">
                Active Champion ({learning.championVersion})
              </div>
              <div className="mt-1">
                Expectancy:{' '}
                <span className="font-semibold">
                  {formatInr(learning.championVsChallenger.championExpectancyInr, true)}/trade
                </span>
              </div>
              <div>
                Max Drawdown:{' '}
                {(learning.championVsChallenger.championMaxDrawdownPct * 100).toFixed(1)}%
              </div>
            </div>
            <div>
              <div className="text-slate-500 font-sans">
                Shadow Challenger ({learning.challengerVersion})
              </div>
              <div className="mt-1 text-emerald-600 dark:text-emerald-400">
                Expectancy:{' '}
                <span className="font-semibold">
                  {formatInr(learning.championVsChallenger.challengerExpectancyInr, true)}/trade
                </span>
              </div>
              <div>
                Max Drawdown:{' '}
                {(learning.championVsChallenger.challengerMaxDrawdownPct * 100).toFixed(1)}% · Shadow
                Trades: {learning.championVsChallenger.shadowTradesCompleted}/
                {learning.championVsChallenger.minShadowTradesRequired}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onPromoteChallenger}
              disabled={!learning.championVsChallenger.readyToPromote}
              className={`px-4 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                learning.championVsChallenger.readyToPromote
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                  : 'bg-slate-200 dark:bg-slate-800 text-slate-500 cursor-not-allowed'
              }`}
            >
              Promote Shadow Challenger ({learning.challengerVersion})
            </button>
            <button
              type="button"
              onClick={onRollbackChampion}
              className="px-4 py-2 text-xs font-medium border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              Rollback to Previous Champion ({learning.previousChampionVersion})
            </button>
          </div>
        </section>

        {/* Trade-Quality Gate Feature Importances */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Trade-Quality Gate ({learning.modelType})
            </h2>
            <span className="text-xs font-mono tabular-nums text-slate-500">
              Walk-Forward AUC: {learning.walkForwardAuc.toFixed(3)} · Gate Threshold: P(win) &gt;={' '}
              {(learning.qualityGateThreshold * 100).toFixed(0)}%
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
            {learning.closedTradesCount >= 200 || learning.championVersion.includes('gbdt')
              ? `200-Trade Statistical Milestone Active (${learning.closedTradesCount}/200 closed NSE trades): ${learning.championVersion} (${learning.modelType}) is live, capturing non-linear Vertical Spread × INDIA VIX and Midday × Spread interactions.`
              : `Anti-overfitting guard: Uses L2-regularized Logistic Regression until >= 200 closed NSE trades (${learning.closedTradesCount}/200 completed · ${learning.tradesNeededForGbdt} more needed), trained strictly via time-ordered walk-forward splits.`}
          </p>

          <div className="space-y-2.5 text-xs">
            {learning.featureImportances.map((item) => {
              const isPositive = item.weight >= 0;
              const widthPct = Math.min(100, Math.round((Math.abs(item.weight) / 1.5) * 100));
              return (
                <div key={item.feature} className="space-y-1">
                  <div className="flex justify-between font-mono tabular-nums">
                    <span className="font-medium text-slate-800 dark:text-slate-200">
                      {item.feature}
                    </span>
                    <span
                      className={
                        isPositive
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-rose-600 dark:text-rose-400'
                      }
                    >
                      {isPositive ? '+' : ''}
                      {item.weight.toFixed(2)} ·{' '}
                      <span className="font-sans text-slate-500">{item.description}</span>
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                    <div
                      className={`h-full ${isPositive ? 'bg-emerald-500' : 'bg-rose-500'}`}
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Capital-Allocation Bandit (Thompson Sampling) */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Thompson Sampling Capital-Allocation Bandit (Strategy × Regime × NSE Underlying)
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 mb-4">
          Enforces &gt;= 30 closed trades per bucket before adapting from uniform prior, and maintains a hard 5.0% minimum allocation floor so no NSE bucket is permanently starved.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 font-sans">
                <th className="py-2 pr-4">Strategy × Regime × NSE Underlying Bucket</th>
                <th className="py-2 px-3 text-right">Wins / Losses</th>
                <th className="py-2 px-3 text-right">Total Trades</th>
                <th className="py-2 px-3 text-right">Bandit Weight</th>
                <th className="py-2 px-3 text-right">Risk Budget Mult (Cap 1.0x)</th>
                <th className="py-2 pl-3">Adaptation Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70">
              {learning.banditAllocations.map((b) => (
                <tr key={b.bucketKey}>
                  <td className="py-2.5 pr-4 font-semibold text-slate-900 dark:text-slate-100">
                    {b.bucketKey}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    {b.wins}W / {b.losses}L
                  </td>
                  <td className="py-2.5 px-3 text-right">{b.totalTrades}</td>
                  <td className="py-2.5 px-3 text-right text-blue-600 dark:text-blue-400 font-semibold">
                    {(b.allocationWeight * 100).toFixed(1)}%
                  </td>
                  <td className="py-2.5 px-3 text-right">{b.riskBudgetMultiplier.toFixed(2)}x</td>
                  <td className="py-2.5 pl-3 font-sans text-slate-600 dark:text-slate-300">
                    {b.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Learning Audit Log & Bot Health / SQLite Outbox Telemetry */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-3">
            Learning Audit Log (Bounded ±10% Saturday 10:00 IST Tuning &amp; Promotions)
          </h3>
          <div className="divide-y divide-slate-200 dark:divide-slate-800/70">
            {learning.learningLog.map((entry, idx) => (
              <div
                key={`${entry.logId}-${idx}`}
                className="py-3.5 first:pt-1 last:pb-1 text-xs space-y-1"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-slate-500">
                  <span>
                    {entry.logId} · {entry.changeCategory} · Model {entry.modelVersion}
                  </span>
                  <span>{formatTimestamp(entry.loggedAt)}</span>
                </div>
                <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                  {entry.parameterOrBucket}: {entry.oldValue} → {entry.newValue} (N=
                  {entry.sampleSize} · 90% CI: {entry.bootstrapCi90})
                </div>
                <p className="text-slate-600 dark:text-slate-300">{entry.reasonAndEvidence}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Oracle Cloud Mumbai VM &amp; DB Outbox Health
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Outbound-only VM telemetry · Heartbeat &gt; 10m during 09:15–15:30 IST triggers red OFFLINE banner
            </p>
          </div>

          <div className="space-y-2 text-xs font-mono tabular-nums">
            <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-800">
              <span className="text-slate-500">Bot Instance:</span>
              <span>{health.botId}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-800">
              <span className="text-slate-500">Last Heartbeat:</span>
              <span>
                {formatTimestamp(health.heartbeatAt)} ({health.heartbeatAgeMinutes}m ago)
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-800">
              <span className="text-slate-500">Last DB Write:</span>
              <span>{formatTimestamp(health.lastDbWriteAt)}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-800">
              <span className="text-slate-500">NIFTY 50 / BANKNIFTY Spot:</span>
              <span>
                {health.niftySpot.toLocaleString('en-IN')} /{' '}
                {health.bankNiftySpot.toLocaleString('en-IN')}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-800">
              <span className="text-slate-500">SQLite Outbox Queue:</span>
              <span>{health.sqliteOutboxPending} pending rows</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-800">
              <span className="text-slate-500">Ledger vs Paper Mismatches:</span>
              <span>{health.reconciliationMismatches}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-800">
              <span className="text-slate-500">Stale Quotes Rejected (&gt;180s):</span>
              <span>{health.staleQuotesRejected}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-800">
              <span className="text-slate-500">VM Memory / Budget:</span>
              <span>{health.memoryRssMb} MB / 380.0 MB</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-500">Control Row Updated By:</span>
              <span>{control.updatedBy}</span>
            </div>
          </div>

          <div className="pt-2 space-y-2">
            <button
              type="button"
              onClick={() => onToggleStrictMarketHours(!control.strictLiveMarketHoursOnly)}
              className={`w-full px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                control.strictLiveMarketHoursOnly
                  ? 'bg-amber-500/15 border-amber-500 text-amber-600 dark:text-amber-300 font-semibold'
                  : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {control.strictLiveMarketHoursOnly
                ? 'Strict Live NSE Hours (09:15–15:30 IST): ON (Click for 24/7)'
                : 'Enable Strict Live NSE Hours Only (09:15–15:30 IST)'}
            </button>

            <button
              type="button"
              onClick={onResetPaperLedger}
              className="w-full px-3 py-2 text-xs font-medium rounded-lg border border-blue-500/50 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 transition-colors"
            >
              Reset Paper Ledger to ₹10,00,000 (Keep {learning.championVersion})
            </button>

            <button
              type="button"
              onClick={() => onToggleSimulateOffline(!health.isOffline)}
              className={`w-full px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                health.isOffline
                  ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-500'
                  : 'border-rose-500/50 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10'
              }`}
            >
              {health.isOffline
                ? 'Restore Live Heartbeat (Clear OFFLINE Banner)'
                : 'Simulate VM Stopped (>10m Heartbeat Test Step F)'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
