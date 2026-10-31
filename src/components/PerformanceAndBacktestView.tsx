import React, { useState } from 'react';
import { formatInr, NSE_LOT_SIZES, OptionRight, simulatePessimisticFill } from '../quant/engine';
import { StrategyBacktestRow } from '../quant/seedStore';

interface BreakdownGroup {
  key: string;
  tradeCount: number;
  winRate: number;
  expectancyInr: number;
  conservativeNetPnlInr: number;
  brokerPaperNetPnlInr: number;
}

interface PerformanceAndBacktestViewProps {
  summary: {
    tradeCount: number;
    sampleSizeTarget: number;
    winRate: number;
    avgWinInr: number;
    avgLossInr: number;
    profitFactor: number;
    expectancyInr: number;
    maxDrawdownPct: number;
    sharpeRatio: number;
    totalConservativeRealizedPnlInr: number;
    totalBrokerPaperRealizedPnlInr: number;
  };
  byStrategy: BreakdownGroup[];
  byUnderlying: BreakdownGroup[];
  byRegime: BreakdownGroup[];
  byDteBucket: BreakdownGroup[];
  byTimeOfDay: BreakdownGroup[];
  backtestResults: StrategyBacktestRow[];
  onRunDryRunCycle: (symbol: string, strategy: string, right: OptionRight) => Promise<void>;
}

export const PerformanceAndBacktestView: React.FC<PerformanceAndBacktestViewProps> = ({
  summary,
  byStrategy,
  byUnderlying,
  byRegime,
  byDteBucket,
  byTimeOfDay,
  backtestResults,
  onRunDryRunCycle,
}) => {
  const [simSymbol, setSimSymbol] = useState('NIFTY');
  const [simBid, setSimBid] = useState('145.00');
  const [simAsk, setSimAsk] = useState('148.50');
  const [simLots, setSimLots] = useState('1');
  const [cycleSymbol, setCycleSymbol] = useState('NIFTY');
  const [cycleStrategy, setCycleStrategy] = useState('trend_following');
  const [cycleRight, setCycleRight] = useState<OptionRight>('CE');
  const [runningCycle, setRunningCycle] = useState(false);

  const lotSize = NSE_LOT_SIZES[simSymbol] ?? 75;
  const parsedBid = Math.max(0.5, Number(simBid) || 145);
  const parsedAsk = Math.max(parsedBid + 0.05, Number(simAsk) || 148.5);
  const parsedLots = Math.max(1, Math.min(20, Math.floor(Number(simLots) || 1)));
  const previewBuyFill = simulatePessimisticFill('BUY', parsedLots, parsedBid, parsedAsk, lotSize);
  const previewSellFill = simulatePessimisticFill('SELL', parsedLots, parsedBid, parsedAsk, lotSize);

  const sampleProgressPct = Math.min(
    100,
    Math.round((summary.tradeCount / summary.sampleSizeTarget) * 100)
  );

  const handleCycleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunningCycle(true);
    try {
      await onRunDryRunCycle(cycleSymbol, cycleStrategy, cycleRight);
    } finally {
      setRunningCycle(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Sample-Size Meter & Go/No-Go Statistical Readiness */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Statistical Sample-Size Meter &amp; SEBI F&amp;O Go/No-Go Readiness
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Honesty rule: SEBI studies show ~90% of individual NSE F&amp;O traders lose money net of statutory charges. At least 200 closed trades across &gt;= 8-12 weeks and &gt;= 2 regimes are required before any statistical conclusion is meaningful.
            </p>
          </div>
          <div className="font-mono tabular-nums text-sm font-semibold text-blue-600 dark:text-blue-400">
            {summary.tradeCount} of {summary.sampleSizeTarget} closed trades ({sampleProgressPct}%)
          </div>
        </div>

        <div className="w-full h-2.5 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden mb-5">
          <div
            className="h-full bg-blue-600 transition-all duration-300"
            style={{ width: `${sampleProgressPct}%` }}
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 pt-2 border-t border-slate-200 dark:border-slate-800">
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Win Rate (Cons)</div>
            <div className="text-lg font-mono tabular-nums font-semibold mt-0.5">
              {(summary.winRate * 100).toFixed(1)}%
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Avg Win / Avg Loss</div>
            <div className="text-base font-mono tabular-nums font-semibold mt-0.5 flex flex-wrap items-center gap-x-1">
              <span className="whitespace-nowrap text-emerald-600 dark:text-emerald-400">
                +₹{Math.round(summary.avgWinInr).toLocaleString('en-IN')}
              </span>
              <span>/</span>
              <span className="whitespace-nowrap text-rose-600 dark:text-rose-400">
                -₹{Math.round(Math.abs(summary.avgLossInr)).toLocaleString('en-IN')}
              </span>
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Profit Factor</div>
            <div className="text-lg font-mono tabular-nums font-semibold mt-0.5">
              {summary.profitFactor.toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Expectancy / Trade</div>
            <div
              className={`text-lg font-mono tabular-nums font-semibold mt-0.5 ${
                summary.expectancyInr >= 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-rose-600 dark:text-rose-400'
              }`}
            >
              {formatInr(summary.expectancyInr, true)}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Max Drawdown</div>
            <div className="text-lg font-mono tabular-nums font-semibold mt-0.5">
              {(summary.maxDrawdownPct * 100).toFixed(2)}%
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Sharpe-Style Ratio</div>
            <div className="text-lg font-mono tabular-nums font-semibold mt-0.5">
              {summary.sharpeRatio.toFixed(2)}
            </div>
          </div>
        </div>
      </section>

      {/* Multi-Dimensional Breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-3">
            Breakdown by Strategy &amp; Market Regime (₹ INR)
          </h3>
          <table className="w-full text-left border-collapse text-xs font-mono tabular-nums mb-6">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 font-sans">
                <th className="py-2">Strategy</th>
                <th className="py-2 text-right">Trades</th>
                <th className="py-2 text-right">Win Rate</th>
                <th className="py-2 text-right">Expectancy (₹)</th>
                <th className="py-2 text-right">Cons Net P&amp;L (₹)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70">
              {byStrategy.map((row) => {
                const isPos = row.conservativeNetPnlInr >= 0;
                return (
                  <tr key={row.key}>
                    <td className="py-2.5 font-semibold text-slate-900 dark:text-slate-100">
                      {row.key}
                    </td>
                    <td className="py-2.5 text-right">{row.tradeCount}</td>
                    <td className="py-2.5 text-right">{(row.winRate * 100).toFixed(1)}%</td>
                    <td
                      className={`py-2.5 text-right ${
                        row.expectancyInr >= 0
                          ? 'text-slate-700 dark:text-slate-200'
                          : 'text-rose-600 dark:text-rose-400'
                      }`}
                    >
                      {formatInr(row.expectancyInr, true)}
                    </td>
                    <td
                      className={`py-2.5 text-right font-semibold ${
                        isPos
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-rose-600 dark:text-rose-400'
                      }`}
                    >
                      {formatInr(row.conservativeNetPnlInr, true)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
            Performance by Market Regime (NIFTY 50 + INDIA VIX)
          </h4>
          <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 font-sans">
                <th className="py-2">Regime</th>
                <th className="py-2 text-right">Trades</th>
                <th className="py-2 text-right">Win Rate</th>
                <th className="py-2 text-right">Cons Net P&amp;L (₹)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70">
              {byRegime.map((row) => (
                <tr key={row.key}>
                  <td className="py-2 font-medium text-slate-900 dark:text-slate-100">{row.key}</td>
                  <td className="py-2 text-right">{row.tradeCount}</td>
                  <td className="py-2 text-right">{(row.winRate * 100).toFixed(1)}%</td>
                  <td
                    className={`py-2 text-right ${
                      row.conservativeNetPnlInr >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    {formatInr(row.conservativeNetPnlInr, true)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-3">
            Breakdown by NSE Underlying, DTE Bucket &amp; IST Session Window
          </h3>
          <table className="w-full text-left border-collapse text-xs font-mono tabular-nums mb-6">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 font-sans">
                <th className="py-2">NSE Underlying</th>
                <th className="py-2 text-right">Trades</th>
                <th className="py-2 text-right">Win Rate</th>
                <th className="py-2 text-right">Cons Net P&amp;L</th>
                <th className="py-2 text-right">Paper Broker P&amp;L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70">
              {byUnderlying.slice(0, 6).map((row) => (
                <tr key={row.key}>
                  <td className="py-2 font-semibold text-slate-900 dark:text-slate-100">
                    {row.key} (Lot {NSE_LOT_SIZES[row.key] ?? 75})
                  </td>
                  <td className="py-2 text-right">{row.tradeCount}</td>
                  <td className="py-2 text-right">{(row.winRate * 100).toFixed(1)}%</td>
                  <td
                    className={`py-2 text-right ${
                      row.conservativeNetPnlInr >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    {formatInr(row.conservativeNetPnlInr, true)}
                  </td>
                  <td className="py-2 text-right text-slate-500">
                    {formatInr(row.brokerPaperNetPnlInr, true)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-slate-200 dark:border-slate-800 text-xs font-mono tabular-nums">
            <div>
              <div className="font-sans font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                By NSE Expiry Bucket
              </div>
              {byDteBucket.map((b) => (
                <div key={b.key} className="flex justify-between py-1">
                  <span>{b.key}</span>
                  <span>
                    {b.tradeCount}t · {(b.winRate * 100).toFixed(0)}% ·{' '}
                    {formatInr(b.conservativeNetPnlInr, true)}
                  </span>
                </div>
              ))}
            </div>
            <div>
              <div className="font-sans font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                By Session Window (IST)
              </div>
              {byTimeOfDay.map((b) => (
                <div key={b.key} className="flex justify-between py-1">
                  <span>{b.key.replace(/_/g, ' ')}</span>
                  <span>
                    {b.tradeCount}t · {(b.winRate * 100).toFixed(0)}% ·{' '}
                    {formatInr(b.conservativeNetPnlInr, true)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* Walk-Forward Black-Scholes Backtester & Realistic NSE Lot Fill Simulator */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Walk-Forward Pre-Paper Backtester (NSE Black-Scholes Approximation)
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-4">
            Approximation disclosure: Prices historical 18-DTE ~0.45-delta NSE options via Black-Scholes (RBI 91d T-bill r=6.8%, estimated IV = 1.18 × 20-day realized vol) and applies the exact mid ± 35% spread + ₹35/lot fee model.
          </p>

          <table className="w-full text-left border-collapse text-xs font-mono tabular-nums mb-5">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 font-sans">
                <th className="py-2">Strategy</th>
                <th className="py-2 text-right">Trades</th>
                <th className="py-2 text-right">Win %</th>
                <th className="py-2 text-right">Expectancy (₹)</th>
                <th className="py-2 text-right">PF</th>
                <th className="py-2 text-right">Max DD</th>
                <th className="py-2 text-right">Sharpe</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70">
              {backtestResults.map((bt) => (
                <tr key={bt.strategyName}>
                  <td className="py-2.5 font-semibold text-slate-900 dark:text-slate-100">
                    {bt.strategyName}
                  </td>
                  <td className="py-2.5 text-right">{bt.tradeCount}</td>
                  <td className="py-2.5 text-right">{(bt.winRate * 100).toFixed(1)}%</td>
                  <td className="py-2.5 text-right text-emerald-600 dark:text-emerald-400">
                    {formatInr(bt.expectancyInr, true)}
                  </td>
                  <td className="py-2.5 text-right">{bt.profitFactor.toFixed(2)}</td>
                  <td className="py-2.5 text-right">{(bt.maxDrawdownPct * 100).toFixed(1)}%</td>
                  <td className="py-2.5 text-right">{bt.sharpeRatio.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <form
            onSubmit={handleCycleSubmit}
            className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3"
          >
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              Execute Dry-Run 5-Minute IST Decision Cycle (Test Verification Step E/F)
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label
                  htmlFor="cycle-symbol"
                  className="block text-[11px] text-slate-500 mb-1"
                >
                  NSE Underlying
                </label>
                <select
                  id="cycle-symbol"
                  value={cycleSymbol}
                  onChange={(e) => setCycleSymbol(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded"
                >
                  <option value="NIFTY">NIFTY (Lot 75)</option>
                  <option value="BANKNIFTY">BANKNIFTY (Lot 30)</option>
                  <option value="FINNIFTY">FINNIFTY (Lot 65)</option>
                  <option value="RELIANCE">RELIANCE (Lot 500)</option>
                  <option value="TCS">TCS (Lot 175)</option>
                  <option value="HDFCBANK">HDFCBANK (Lot 550)</option>
                  <option value="ICICIBANK">ICICIBANK (Lot 700)</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="cycle-strategy"
                  className="block text-[11px] text-slate-500 mb-1"
                >
                  Strategy Module
                </label>
                <select
                  id="cycle-strategy"
                  value={cycleStrategy}
                  onChange={(e) => setCycleStrategy(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded"
                >
                  <option value="trend_following">trend_following</option>
                  <option value="breakout_momentum">breakout_momentum</option>
                  <option value="mean_reversion">mean_reversion</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="cycle-right"
                  className="block text-[11px] text-slate-500 mb-1"
                >
                  Option Type (CE / PE)
                </label>
                <select
                  id="cycle-right"
                  value={cycleRight}
                  onChange={(e) => setCycleRight(e.target.value as OptionRight)}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded"
                >
                  <option value="CE">CE (Long Call)</option>
                  <option value="PE">PE (Long Put)</option>
                </select>
              </div>
            </div>
            <button
              type="submit"
              disabled={runningCycle}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              {runningCycle ? 'Running Decision Cycle...' : 'Run Dry-Run Cycle & Log NSE Paper Trade'}
            </button>
          </form>
        </section>

        {/* Pessimistic Fill Simulator Calculator */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Pessimistic NSE Fill Simulator Inspector (Section 4)
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-4">
            Inspect how the internal ledger penalizes paper fills: Buy at <code className="font-mono">mid + 35% spread</code>, Sell at <code className="font-mono">mid - 35% spread</code>, plus <code className="font-mono">₹35/lot</code> statutory + brokerage charges.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div>
              <label htmlFor="sim-symbol" className="block text-[11px] text-slate-500 mb-1">
                NSE Symbol
              </label>
              <select
                id="sim-symbol"
                value={simSymbol}
                onChange={(e) => setSimSymbol(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded"
              >
                {Object.entries(NSE_LOT_SIZES).map(([sym, ls]) => (
                  <option key={sym} value={sym}>
                    {sym} ({ls})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="sim-bid" className="block text-[11px] text-slate-500 mb-1">
                Option Bid (₹)
              </label>
              <input
                id="sim-bid"
                type="number"
                step="0.50"
                value={simBid}
                onChange={(e) => setSimBid(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded"
              />
            </div>
            <div>
              <label htmlFor="sim-ask" className="block text-[11px] text-slate-500 mb-1">
                Option Ask (₹)
              </label>
              <input
                id="sim-ask"
                type="number"
                step="0.50"
                value={simAsk}
                onChange={(e) => setSimAsk(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded"
              />
            </div>
            <div>
              <label htmlFor="sim-qty" className="block text-[11px] text-slate-500 mb-1">
                Lots Qty
              </label>
              <input
                id="sim-qty"
                type="number"
                min="1"
                max="20"
                value={simLots}
                onChange={(e) => setSimLots(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded"
              />
            </div>
          </div>

          <div className="space-y-2.5 text-xs font-mono tabular-nums pt-3 border-t border-slate-200 dark:border-slate-800">
            <div className="flex justify-between">
              <span className="text-slate-500">Lot Size / Total Contract Units:</span>
              <span>
                {lotSize} units/lot × {parsedLots} lot = {previewBuyFill.totalUnits} units
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Quote Mid / Bid-Ask Spread:</span>
              <span>
                ₹{previewBuyFill.mid.toFixed(2)} / ₹{previewBuyFill.spread.toFixed(2)} (
                {(previewBuyFill.spreadPctOfMid * 100).toFixed(2)}% of mid)
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Conservative Entry Fill (mid + 35% spread):</span>
              <span className="font-semibold text-blue-600 dark:text-blue-400">
                ₹{previewBuyFill.conservativeFillPrice.toFixed(2)} / unit
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Conservative Exit Fill (mid - 35% spread):</span>
              <span className="font-semibold text-blue-600 dark:text-blue-400">
                ₹{previewSellFill.conservativeFillPrice.toFixed(2)} / unit
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">
                Roundtrip Charges (₹35/lot × {parsedLots}L × 2 legs):
              </span>
              <span>₹{(previewBuyFill.feeInr * 2).toFixed(2)}</span>
            </div>
            <div className="flex justify-between pt-2 border-t border-slate-200 dark:border-slate-800">
              <span className="text-slate-600 dark:text-slate-300 font-sans font-medium">
                Immediate Roundtrip Slippage + Charges Drag vs Mid:
              </span>
              <span className="font-semibold text-rose-600 dark:text-rose-400">
                -₹{(previewBuyFill.slippageVsMidInr + previewSellFill.slippageVsMidInr).toFixed(2)}
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
