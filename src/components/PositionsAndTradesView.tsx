import React, { useMemo, useState } from 'react';
import {
  ClosedOptionTrade,
  formatInr,
  OpenOptionPosition,
  PostMortemLabel,
  SkippedSignalCounterfactual,
  StrategyName,
} from '../quant/engine';

interface PositionsAndTradesViewProps {
  openPositions: OpenOptionPosition[];
  closedTrades: ClosedOptionTrade[];
  skippedSignals: SkippedSignalCounterfactual[];
  formatTimestamp: (iso: string) => string;
}

const POST_MORTEM_LABELS: Array<{ value: 'ALL' | PostMortemLabel; label: string }> = [
  { value: 'ALL', label: 'All Post-Mortems' },
  { value: 'optimal_exit', label: 'Optimal Exit' },
  { value: 'wrong_direction', label: 'Wrong Direction' },
  { value: 'theta_or_iv_crush', label: 'Theta / INDIA VIX Crush' },
  { value: 'stopped_out_then_reversed', label: 'Stopped Out Then Reversed' },
  { value: 'winner_given_back', label: 'Winner Given Back' },
  { value: 'bad_fill_wide_spread', label: 'Bad Fill (Wide Spread)' },
  { value: 'wrong_regime', label: 'Wrong Regime' },
];

export const PositionsAndTradesView: React.FC<PositionsAndTradesViewProps> = ({
  openPositions,
  closedTrades,
  skippedSignals,
  formatTimestamp,
}) => {
  const [subTab, setSubTab] = useState<'trades' | 'counterfactuals'>('trades');
  const [strategyFilter, setStrategyFilter] = useState<'ALL' | StrategyName>('ALL');
  const [postMortemFilter, setPostMortemFilter] = useState<'ALL' | PostMortemLabel>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'closedAt' | 'conservativePnlInr' | 'dteAtEntry'>('closedAt');

  const filteredTrades = useMemo(() => {
    return closedTrades
      .filter((t) => {
        if (strategyFilter !== 'ALL' && t.strategyName !== strategyFilter) return false;
        if (postMortemFilter !== 'ALL' && t.postMortemLabel !== postMortemFilter) return false;
        if (
          searchQuery.trim() !== '' &&
          !t.underlying.toLowerCase().includes(searchQuery.toLowerCase()) &&
          !t.contractSymbol.toLowerCase().includes(searchQuery.toLowerCase()) &&
          !t.entryReason.toLowerCase().includes(searchQuery.toLowerCase())
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'conservativePnlInr') return b.conservativePnlInr - a.conservativePnlInr;
        if (sortBy === 'dteAtEntry') return b.dteAtEntry - a.dteAtEntry;
        return new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime();
      });
  }, [closedTrades, strategyFilter, postMortemFilter, searchQuery, sortBy]);

  return (
    <div className="space-y-8">
      {/* Section 1: Open NSE F&O Positions */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Open NSE F&amp;O Paper Positions ({openPositions.length} / 5 Max Cap)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Marks reflect Conservative Simulation exit values (mid - 35% of bid-ask spread) · Evaluated every 5 minutes during 09:15–15:30 IST
            </p>
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
            Max Risk/Trade: 1.5% Equity (₹15,000) · Max Total Premium: 25.0% Equity
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 font-medium">
                <th className="py-2.5 pr-4">NSE Contract</th>
                <th className="py-2.5 px-3">Strategy · Regime</th>
                <th className="py-2.5 px-3 text-right">Lots (Units)</th>
                <th className="py-2.5 px-3 text-right">Cons Entry</th>
                <th className="py-2.5 px-3 text-right">Current Mark</th>
                <th className="py-2.5 px-3 text-right">Unrealized P&amp;L (₹)</th>
                <th className="py-2.5 px-3 text-right">Delta / Theta</th>
                <th className="py-2.5 px-3 text-right">DTE</th>
                <th className="py-2.5 pl-3 text-right">Stop (-30%) / Target (+50%)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70 font-mono tabular-nums">
              {openPositions.map((pos, idx) => {
                const isPos = pos.unrealizedPnlInr >= 0;
                return (
                  <tr
                    key={`${pos.positionId}-${idx}`}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-3 pr-4 font-semibold text-slate-900 dark:text-slate-100">
                      <div>{pos.contractSymbol}</div>
                      <div className="text-[11px] font-sans font-normal text-slate-500 dark:text-slate-400">
                        {pos.underlying} · {pos.strike} {pos.right} · Exp {pos.expirationDate}
                        {pos.angelToken ? ` · Angel NFO #${pos.angelToken}` : ' · Angel Spot + BS'}
                      </div>
                    </td>
                    <td className="py-3 px-3 font-sans text-slate-600 dark:text-slate-300">
                      {pos.strategyName} · {pos.regimeAtEntry}
                    </td>
                    <td className="py-3 px-3 text-right">
                      {pos.lotsQty}L ({pos.lotsQty * pos.lotSize})
                    </td>
                    <td className="py-3 px-3 text-right">
                      ₹{pos.conservativeEntryPrice.toFixed(2)}
                    </td>
                    <td className="py-3 px-3 text-right">₹{pos.currentMarkPrice.toFixed(2)}</td>
                    <td
                      className={`py-3 px-3 text-right font-semibold ${
                        isPos
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-rose-600 dark:text-rose-400'
                      }`}
                    >
                      {formatInr(pos.unrealizedPnlInr, true)} (
                      {isPos ? '+' : ''}
                      {(pos.unrealizedPnlPct * 100).toFixed(1)}%)
                    </td>
                    <td className="py-3 px-3 text-right text-slate-600 dark:text-slate-300">
                      Δ {pos.delta.toFixed(2)} / Θ {pos.theta.toFixed(2)}
                    </td>
                    <td className="py-3 px-3 text-right">{pos.dte}d</td>
                    <td className="py-3 pl-3 text-right text-slate-600 dark:text-slate-400">
                      ₹{pos.stopLossPrice.toFixed(2)} / ₹{pos.takeProfitPrice.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Section 2: Closed Trade Journal & Counterfactual Skipped Signals */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Trade Journal, Post-Mortem Labels &amp; Counterfactual Log
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Every closed NSE trade is labeled automatically; skipped signals are tracked counterfactually so the ML quality gate avoids survivorship bias
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setSubTab('trades')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subTab === 'trades'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Closed Trades ({closedTrades.length})
            </button>
            <button
              type="button"
              onClick={() => setSubTab('counterfactuals')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subTab === 'counterfactuals'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Counterfactual Skipped Signals ({skippedSignals.length})
            </button>
          </div>
        </div>

        {subTab === 'trades' ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div>
                <label
                  htmlFor="trade-search-input"
                  className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1"
                >
                  Search NSE Underlying or Thesis
                </label>
                <input
                  id="trade-search-input"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="e.g. NIFTY, BANKNIFTY, RELIANCE..."
                  className="w-full px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label
                  htmlFor="strategy-filter-select"
                  className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1"
                >
                  Filter by Strategy
                </label>
                <select
                  id="strategy-filter-select"
                  value={strategyFilter}
                  onChange={(e) => setStrategyFilter(e.target.value as 'ALL' | StrategyName)}
                  className="w-full px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-slate-900 dark:text-slate-100"
                >
                  <option value="ALL">All Strategies</option>
                  <option value="trend_following">trend_following</option>
                  <option value="mean_reversion">mean_reversion</option>
                  <option value="breakout_momentum">breakout_momentum</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="postmortem-filter-select"
                  className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1"
                >
                  Filter by Post-Mortem Diagnosis
                </label>
                <select
                  id="postmortem-filter-select"
                  value={postMortemFilter}
                  onChange={(e) => setPostMortemFilter(e.target.value as 'ALL' | PostMortemLabel)}
                  className="w-full px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-slate-900 dark:text-slate-100"
                >
                  {POST_MORTEM_LABELS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="trade-sort-select"
                  className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1"
                >
                  Sort By
                </label>
                <select
                  id="trade-sort-select"
                  value={sortBy}
                  onChange={(e) =>
                    setSortBy(e.target.value as 'closedAt' | 'conservativePnlInr' | 'dteAtEntry')
                  }
                  className="w-full px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-slate-900 dark:text-slate-100"
                >
                  <option value="closedAt">Closed Time (Newest First)</option>
                  <option value="conservativePnlInr">Conservative P&amp;L ₹ (Highest First)</option>
                  <option value="dteAtEntry">DTE at Entry</option>
                </select>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 font-medium">
                    <th className="py-2.5 pr-3">Trade / NSE Contract</th>
                    <th className="py-2.5 px-3">Strategy · Regime</th>
                    <th className="py-2.5 px-3 text-right">Cons Entry → Exit</th>
                    <th className="py-2.5 px-3 text-right">Conservative P&amp;L (₹)</th>
                    <th className="py-2.5 px-3 text-right">Paper Broker P&amp;L (₹)</th>
                    <th className="py-2.5 px-3 text-right">MAE / MFE</th>
                    <th className="py-2.5 pl-3">Exit Reason · Post-Mortem Label</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70">
                  {filteredTrades.slice(0, 25).map((t, idx) => {
                    const isWin = t.conservativePnlInr > 0;
                    return (
                      <tr
                        key={`${t.tradeId}-${idx}`}
                        className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                      >
                        <td className="py-3 pr-3">
                          <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {t.contractSymbol}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">
                            {t.tradeId} · {formatTimestamp(t.closedAt)} · {t.lotsQty}L ({t.lotSize}/lot) · DTE{' '}
                            {t.dteAtEntry} · Δ {t.deltaAtEntry}
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <div className="text-slate-800 dark:text-slate-200 font-medium">
                            {t.strategyName} · {t.regimeAtEntry}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 max-w-xs truncate">
                            {t.entryReason}
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          ₹{t.conservativeEntryPrice.toFixed(2)} → ₹{t.conservativeExitPrice.toFixed(2)}
                          <div className="text-[11px] text-slate-500">
                            Spread {(t.spreadPctAtEntry * 100).toFixed(1)}% · Charges ₹
                            {t.feesTotalInr.toFixed(0)}
                          </div>
                        </td>
                        <td
                          className={`py-3 px-3 text-right font-mono tabular-nums font-semibold ${
                            isWin
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {formatInr(t.conservativePnlInr, true)}
                          <div className="text-[11px] font-normal">
                            {isWin ? '+' : ''}
                            {(t.conservativePnlPct * 100).toFixed(1)}%
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                          {formatInr(t.brokerPaperPnlInr, true)}
                          <div className="text-[11px]">
                            {(t.brokerPaperPnlPct * 100).toFixed(1)}%
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                          {(t.maePct * 100).toFixed(1)}% / +{(t.mfePct * 100).toFixed(1)}%
                        </td>
                        <td className="py-3 pl-3">
                          <div className="font-mono text-slate-800 dark:text-slate-200">
                            {t.exitReason} · {t.postMortemLabel}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 max-w-md">
                            {t.diagnosisNotes}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 font-medium">
                  <th className="py-2.5 pr-4">Signal ID / Time</th>
                  <th className="py-2.5 px-3">NSE Underlying · Strategy</th>
                  <th className="py-2.5 px-3 text-right">Conf / Gate Prob</th>
                  <th className="py-2.5 px-3">Skip / Filter Reason</th>
                  <th className="py-2.5 pl-3 text-right">Simulated 5d Counterfactual Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70">
                {skippedSignals.map((sig, idx) => {
                  const savedLoss = sig.counterfactualPnlPct < 0;
                  return (
                    <tr key={`${sig.signalId}-${idx}`}>
                      <td className="py-3 pr-4 font-mono tabular-nums">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">
                          {sig.signalId}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {formatTimestamp(sig.generatedAt)}
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {sig.underlying} · {sig.direction} · {sig.strategyName}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Regime: {sig.regime} · {sig.counterfactualContract}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums">
                        {(sig.confidence * 100).toFixed(0)}% / P(win)={(sig.qualityGateProb * 100).toFixed(0)}%
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-300">
                        {sig.skipReason}
                      </td>
                      <td
                        className={`py-3 pl-3 text-right font-mono tabular-nums font-semibold ${
                          savedLoss
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-amber-600 dark:text-amber-400'
                        }`}
                      >
                        ₹{sig.counterfactualEntryPrice.toFixed(2)} → ₹
                        {sig.counterfactualExitPrice.toFixed(2)} (
                        {(sig.counterfactualPnlPct * 100).toFixed(1)}%)
                        <div className="text-[11px] font-sans font-normal text-slate-500">
                          {savedLoss ? 'Filter Avoided Loss' : 'Missed Winner (Logged for Retrain)'}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
