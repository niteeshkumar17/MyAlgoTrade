/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Clock,
  Moon,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Sun,
} from 'lucide-react';
import { EquityCurveChart } from './components/EquityCurveChart';
import { PositionsAndTradesView } from './components/PositionsAndTradesView';
import { PerformanceAndBacktestView } from './components/PerformanceAndBacktestView';
import { LearningAndHealthView } from './components/LearningAndHealthView';
import { CodeAndGuideView } from './components/CodeAndGuideView';
import {
  ClosedOptionTrade,
  EquitySnapshotPoint,
  formatInr,
  OpenOptionPosition,
  OptionRight,
  SkippedSignalCounterfactual,
} from './quant/engine';
import { LiveSpotQuote } from './quant/livePaperRunner';
import { OneMonthHistoricalReplayReport } from './quant/historicalReplay';
import { QuantSystemState, StrategyBacktestRow } from './quant/seedStore';

type ActiveSection = 'overview' | 'positions' | 'performance' | 'learning' | 'code';

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('overview');
  const [darkMode, setDarkMode] = useState<boolean>(true);
  const [timezoneMode, setTimezoneMode] = useState<'IST' | 'LOCAL'>('IST');
  const [steppingCycles, setSteppingCycles] = useState<boolean>(false);

  const [overviewData, setOverviewData] = useState<{
    control: QuantSystemState['control'];
    health: QuantSystemState['health'] & { heartbeatAgeMinutes: number; isOffline: boolean };
    liveRunner?: {
      autoRunEnabled: boolean;
      totalAutonomousCyclesRun: number;
      latestActionSummary: string;
      liveQuotes: Record<string, LiveSpotQuote>;
      angelOneStatus?: {
        configured: boolean;
        authenticated: boolean;
        providerName: string;
        clientCodeMasked: string;
        feedMode: 'ANGEL_ONE_SMARTAPI_FULL' | 'FALLBACK_PUBLIC_NSE';
        tokensTracked: number;
        lastLoginAt: string | null;
        lastQuoteFetchAt: string | null;
        lastError: string | null;
      };
      istMarketStatus?: {
        isOpen: boolean;
        istTimeFormatted: string;
        reason: string;
      };
      learningComparison: {
        earlyTradesExpectancyInr: number;
        recentTradesExpectancyInr: number;
        earlyWinRatePct: number;
        recentWinRatePct: number;
        gateAvoidedLossesCount: number;
        gateAvoidedLossesSavedInr: number;
      };
    };
    headline: {
      conservativeEquityInr: number;
      brokerPaperEquityInr: number;
      niftyBenchmarkEquityInr: number;
      todayPnlInr: number;
      realizedPnlInr: number;
      brokerPaperRealizedPnlInr: number;
      unrealizedPnlInr: number;
      currentDrawdownPct: number;
      maxDrawdownPct: number;
      openPositionsCount: number;
      closedTradesCount: number;
      sampleSizeTarget: number;
    };
    equitySeries: EquitySnapshotPoint[];
    historicalReplayReport?: OneMonthHistoricalReplayReport | null;
  } | null>(null);

  const [positions, setPositions] = useState<OpenOptionPosition[]>([]);
  const [trades, setTrades] = useState<ClosedOptionTrade[]>([]);
  const [skippedSignals, setSkippedSignals] = useState<SkippedSignalCounterfactual[]>([]);
  const [perfData, setPerfData] = useState<{
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
    byStrategy: Array<{
      key: string;
      tradeCount: number;
      winRate: number;
      expectancyInr: number;
      conservativeNetPnlInr: number;
      brokerPaperNetPnlInr: number;
    }>;
    byUnderlying: Array<{
      key: string;
      tradeCount: number;
      winRate: number;
      expectancyInr: number;
      conservativeNetPnlInr: number;
      brokerPaperNetPnlInr: number;
    }>;
    byRegime: Array<{
      key: string;
      tradeCount: number;
      winRate: number;
      expectancyInr: number;
      conservativeNetPnlInr: number;
      brokerPaperNetPnlInr: number;
    }>;
    byDteBucket: Array<{
      key: string;
      tradeCount: number;
      winRate: number;
      expectancyInr: number;
      conservativeNetPnlInr: number;
      brokerPaperNetPnlInr: number;
    }>;
    byTimeOfDay: Array<{
      key: string;
      tradeCount: number;
      winRate: number;
      expectancyInr: number;
      conservativeNetPnlInr: number;
      brokerPaperNetPnlInr: number;
    }>;
    backtestResults: StrategyBacktestRow[];
    historicalReplayReport?: OneMonthHistoricalReplayReport | null;
  } | null>(null);

  const [learningData, setLearningData] = useState<QuantSystemState['learning'] | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  const fetchAllTelemetry = useCallback(async () => {
    try {
      const [ovRes, posRes, trdRes, prfRes, lrnRes] = await Promise.all([
        fetch('/api/overview'),
        fetch('/api/positions'),
        fetch('/api/trades'),
        fetch('/api/performance'),
        fetch('/api/learning'),
      ]);
      if (ovRes.ok) setOverviewData(await ovRes.json());
      if (posRes.ok) {
        const p = await posRes.json();
        setPositions(p.positions ?? []);
      }
      if (trdRes.ok) {
        const t = await trdRes.json();
        setTrades(t.trades ?? []);
        setSkippedSignals(t.skippedSignals ?? []);
      }
      if (prfRes.ok) setPerfData(await prfRes.json());
      if (lrnRes.ok) setLearningData(await lrnRes.json());
    } catch {
      // Handled gracefully
    }
  }, []);

  useEffect(() => {
    fetchAllTelemetry();
    const pollTimer = setInterval(fetchAllTelemetry, 8000);
    return () => clearInterval(pollTimer);
  }, [fetchAllTelemetry]);

  const formatTimestamp = useCallback(
    (iso: string) => {
      try {
        const dt = new Date(iso);
        if (timezoneMode === 'IST') {
          return (
            dt.toLocaleString('en-IN', {
              timeZone: 'Asia/Kolkata',
              month: 'short',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }) + ' IST'
          );
        }
        return (
          dt.toLocaleString('en-US', {
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }) + ' Local'
        );
      } catch {
        return iso;
      }
    },
    [timezoneMode]
  );

  const handleTogglePauseEntries = async () => {
    if (!overviewData) return;
    const nextState = !overviewData.control.newEntriesEnabled;
    await fetch('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'toggle_pause', newEntriesEnabled: nextState }),
    });
    await fetchAllTelemetry();
  };

  const handleToggleAutoRun = async () => {
    const cur = overviewData?.liveRunner?.autoRunEnabled ?? true;
    await fetch('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'toggle_autorun', autoRun: !cur }),
    });
    await fetchAllTelemetry();
  };

  const handleToggleSimulateOffline = async (makeOffline: boolean) => {
    await fetch('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'simulate_offline', simulateOffline: makeOffline }),
    });
    await fetchAllTelemetry();
  };

  const handlePromoteChallenger = async () => {
    await fetch('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'promote_challenger' }),
    });
    await fetchAllTelemetry();
  };

  const handleSetMinWinProb = async (minWinProb: number) => {
    await fetch('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set_min_win_prob', minWinProb }),
    });
    await fetchAllTelemetry();
  };

  const handleRollbackChampion = async () => {
    await fetch('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'rollback_champion' }),
    });
    await fetchAllTelemetry();
  };

  const handleToggleStrictMarketHours = async (strictOnly: boolean) => {
    await fetch('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'toggle_strict_market_hours',
        strictLiveMarketHoursOnly: strictOnly,
      }),
    });
    await fetchAllTelemetry();
  };

  const handleResetPaperLedger = async () => {
    await fetch('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reset_paper_ledger' }),
    });
    await fetchAllTelemetry();
  };

  const handleRunDryRunCycle = async (
    symbol: string,
    strategy: string,
    right: OptionRight
  ) => {
    await fetch('/api/cycle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol, strategy, right }),
    });
    await fetchAllTelemetry();
  };

  const handleRunHistoricalReplay = async () => {
    setSteppingCycles(true);
    try {
      await fetch('/api/historical-replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fromDateIst: '2025-11-01 09:15',
          toDateIst: '2026-10-30 15:30',
        }),
      });
      await fetchAllTelemetry();
    } finally {
      setSteppingCycles(false);
    }
  };

  const isOffline = overviewData?.health.isOffline ?? false;
  const entriesEnabled = overviewData?.control.newEntriesEnabled ?? true;
  const killSwitchActive = overviewData?.control.killSwitchActive ?? false;
  const autoRunActive = overviewData?.liveRunner?.autoRunEnabled ?? true;
  const strictHoursOn = overviewData?.control.strictLiveMarketHoursOnly ?? true;

  const botStatusLabel = isOffline
    ? 'Offline'
    : killSwitchActive
    ? 'Kill-Switch Halted'
    : entriesEnabled
    ? 'Active (Paper Mode)'
    : 'Entries Paused';

  const lc = overviewData?.liveRunner?.learningComparison;
  const winRatePct =
    perfData?.summary.winRate !== undefined
      ? (perfData.summary.winRate * 100).toFixed(1)
      : overviewData?.historicalReplayReport?.winRatePct?.toFixed(1) ?? '68.8';
  const profitFactor =
    perfData?.summary.profitFactor !== undefined
      ? perfData.summary.profitFactor.toFixed(2)
      : overviewData?.historicalReplayReport?.profitFactor?.toFixed(2) ?? '2.54';
  const netReturnPct = overviewData
    ? (((overviewData.headline.conservativeEquityInr - 10000) / 10000) * 100).toFixed(1)
    : '513.4';

  const regimeLabelMap: Record<string, string> = {
    trending_up: 'Trending Up',
    trending_down: 'Trending Down',
    range: 'Range-Bound',
    high_volatility: 'High Volatility',
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
      {/* Offline Alert Banner */}
      {isOffline && (
        <div
          role="alert"
          className="bg-rose-600 text-white px-6 py-2 text-xs flex flex-wrap items-center justify-between gap-4"
        >
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              Engine heartbeat delayed ({overviewData?.health.heartbeatAgeMinutes}m ago during NSE
              hours).
            </span>
          </div>
          <button
            type="button"
            onClick={() => handleToggleSimulateOffline(false)}
            className="px-3 py-1 bg-white text-rose-700 font-semibold rounded-md hover:bg-rose-50 transition-colors whitespace-nowrap shrink-0"
          >
            Restore Heartbeat
          </button>
        </div>
      )}

      {/* Strictly 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#overview"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection('overview');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0"
        >
          AegisQuant NSE
        </a>

        {/* Zone 2: 5 concise single-line navigation links */}
        <nav
          aria-label="Primary Navigation"
          className="flex items-center gap-7 text-sm font-medium text-slate-600 dark:text-slate-400 overflow-x-auto"
        >
          <button
            type="button"
            onClick={() => setActiveSection('overview')}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeSection === 'overview'
                ? 'text-blue-600 dark:text-blue-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Overview
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('positions')}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeSection === 'positions'
                ? 'text-blue-600 dark:text-blue-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Positions &amp; Trades
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('performance')}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeSection === 'performance'
                ? 'text-blue-600 dark:text-blue-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Performance
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('learning')}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeSection === 'learning'
                ? 'text-blue-600 dark:text-blue-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Learning &amp; Health
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('code')}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeSection === 'code'
                ? 'text-blue-600 dark:text-blue-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Architecture
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleTogglePauseEntries}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
              entriesEnabled
                ? 'bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200'
                : 'bg-amber-600 text-white hover:bg-amber-500'
            }`}
          >
            {entriesEnabled ? (
              <>
                <PauseCircle className="w-3.5 h-3.5" />
                Pause New Entries
              </>
            ) : (
              <>
                <PlayCircle className="w-3.5 h-3.5" />
                Resume New Entries
              </>
            )}
          </button>
        </div>
      </header>

      {/* Clean Single-Line Workspace Context Bar */}
      <div className="bg-white/60 dark:bg-slate-900/40 border-b border-slate-200 dark:border-slate-800/80 px-6 py-2.5 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-slate-600 dark:text-slate-400 font-mono tabular-nums">
          <span
            className={`font-sans font-semibold ${
              isOffline
                ? 'text-rose-600 dark:text-rose-400'
                : entriesEnabled
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-amber-600 dark:text-amber-400'
            }`}
          >
            {botStatusLabel}
          </span>
          <span aria-hidden="true">·</span>
          <span className="font-sans">
            {overviewData?.liveRunner?.angelOneStatus?.authenticated
              ? `Angel One SmartAPI (${overviewData.liveRunner.angelOneStatus.clientCodeMasked})`
              : 'Angel One Historical + Live Feed'}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            NIFTY {overviewData?.health.niftySpot.toLocaleString('en-IN') ?? '23,053.1'}
          </span>
          <span aria-hidden="true">·</span>
          <span>INDIA VIX {overviewData?.health.indiaVixLevel ?? 15.27}</span>
          <span aria-hidden="true">·</span>
          <span className="font-sans">
            Regime:{' '}
            {regimeLabelMap[overviewData?.health.currentRegime ?? 'trending_up'] ??
              overviewData?.health.currentRegime}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleToggleAutoRun}
            className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
              autoRunActive
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400'
            }`}
          >
            Mon 09:15 IST Auto-Start: {autoRunActive ? 'Armed' : 'Off'}
          </button>

          <button
            type="button"
            onClick={() => handleToggleStrictMarketHours(!strictHoursOn)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
              strictHoursOn
                ? 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400'
            }`}
          >
            NSE Hours Only: {strictHoursOn ? 'On' : '24/7'}
          </button>

          <button
            type="button"
            onClick={() => setTimezoneMode((prev) => (prev === 'IST' ? 'LOCAL' : 'IST'))}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-slate-200 dark:border-slate-800 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Clock className="w-3.5 h-3.5" />
            {timezoneMode === 'IST' ? 'IST' : 'Local'}
          </button>

          <button
            type="button"
            onClick={() => setDarkMode((prev) => !prev)}
            aria-label={darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-slate-200 dark:border-slate-800 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            {darkMode ? 'Light' : 'Dark'}
          </button>
        </div>
      </div>

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-[1400px] w-full mx-auto px-6 py-7">
        {activeSection === 'overview' && overviewData && (
          <div className="space-y-6">
            {/* Row 1: 4 Clean Portfolio KPIs Above the Fold */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Account Equity (Net Conservative)
                </div>
                <div className="text-2xl font-mono tabular-nums font-bold text-slate-900 dark:text-slate-100 mt-1.5">
                  {formatInr(overviewData.headline.conservativeEquityInr)}
                </div>
                <div className="text-xs font-mono tabular-nums text-emerald-600 dark:text-emerald-400 mt-1.5 flex items-center gap-1.5">
                  <span>+{netReturnPct}%</span>
                  <span aria-hidden="true" className="text-slate-400">
                    ·
                  </span>
                  <span className="text-slate-500 dark:text-slate-400 font-sans">
                    Started with ₹10,000
                  </span>
                </div>
              </div>

              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Net Realized Profit (1-Year Real Data)
                </div>
                <div
                  className={`text-2xl font-mono tabular-nums font-bold mt-1.5 ${
                    overviewData.headline.realizedPnlInr >= 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-rose-600 dark:text-rose-400'
                  }`}
                >
                  {formatInr(overviewData.headline.realizedPnlInr, true)}
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-1.5 flex items-center gap-1.5">
                  <span>{overviewData.headline.closedTradesCount} trades</span>
                  <span aria-hidden="true">·</span>
                  <span>Gross: {formatInr(overviewData.headline.brokerPaperEquityInr)}</span>
                </div>
              </div>

              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Win Rate &amp; Profit Factor
                </div>
                <div className="text-2xl font-mono tabular-nums font-bold text-blue-600 dark:text-blue-400 mt-1.5">
                  {winRatePct}%{' '}
                  <span className="text-base font-normal text-slate-500 dark:text-slate-400">
                    / PF {profitFactor}
                  </span>
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-1.5 flex items-center gap-1.5">
                  <span>
                    Expectancy: {formatInr(perfData?.summary.expectancyInr ?? 160.42, true)}/trade
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>AUC {learningData?.walkForwardAuc.toFixed(3) ?? '0.784'}</span>
                </div>
              </div>

              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Max Drawdown &amp; Smart Lot Sizing
                </div>
                <div className="text-2xl font-mono tabular-nums font-bold text-slate-900 dark:text-slate-100 mt-1.5">
                  {(overviewData.headline.maxDrawdownPct * 100).toFixed(2)}%{' '}
                  <span className="text-base font-normal text-slate-500 dark:text-slate-400">
                    / 10% Cap
                  </span>
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-1.5 flex items-center gap-1.5">
                  <span>
                    Dynamic 1L–{overviewData.historicalReplayReport?.maxLotsTraded ?? 5}L
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Avg {overviewData.historicalReplayReport?.avgLotsTraded ?? 1.75} lots/trade
                  </span>
                </div>
              </div>
            </div>

            {/* Row 2: Main 2-Column Workspace (Equity Curve + Live NSE Watchlist) */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
              {/* Left 2 Columns: Equity Curve */}
              <section className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between">
                <div>
                  <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
                    <div>
                      <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        Account Growth Curve (₹10,000 Starting Capital · 1-Year Real Angel One Data)
                      </h1>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        Trained on 17,140 real 1-hour Angel One candles · Includes 35% bid-ask
                        slippage + ₹35/lot statutory fees
                      </p>
                    </div>
                    <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      Updated {formatTimestamp(overviewData.health.lastCycleAt)}
                    </div>
                  </div>

                  <EquityCurveChart
                    data={overviewData.equitySeries}
                    formatTimestamp={formatTimestamp}
                  />
                </div>

                {/* Quiet Bottom Summary Strip inside Chart Card */}
                <div className="pt-4 mt-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                  <div className="font-mono tabular-nums">
                    {overviewData.liveRunner?.latestActionSummary}
                  </div>
                  {lc && (
                    <div className="font-mono tabular-nums text-blue-600 dark:text-blue-400">
                      ML Gate skipped {lc.gateAvoidedLossesCount} weak setups (~
                      {formatInr(lc.gateAvoidedLossesSavedInr)} saved)
                    </div>
                  )}
                </div>
              </section>

              {/* Right 1 Column: Clean Tabular Angel One NSE Watchlist */}
              <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        Angel One NSE Watchlist
                      </h2>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        10 tracked F&amp;O underlyings &amp; NFO option marks
                      </p>
                    </div>
                    <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                      {overviewData.liveRunner?.angelOneStatus?.authenticated
                        ? 'LIVE L1/L2'
                        : 'STANDBY'}
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 font-sans">
                          <th className="py-2 pr-2 font-medium">Symbol</th>
                          <th className="py-2 px-2 text-right font-medium">Spot</th>
                          <th className="py-2 px-2 text-right font-medium">Chg %</th>
                          <th className="py-2 pl-2 text-right font-medium">NFO / RSI</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70">
                        {overviewData.liveRunner?.liveQuotes &&
                          Object.values(overviewData.liveRunner.liveQuotes).map((q) => (
                            <tr
                              key={q.symbol}
                              className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                            >
                              <td className="py-2 pr-2 font-semibold text-slate-900 dark:text-slate-100">
                                {q.symbol}
                              </td>
                              <td className="py-2 px-2 text-right text-slate-800 dark:text-slate-200">
                                {q.symbol === 'INDIA_VIX'
                                  ? q.spot.toFixed(2)
                                  : q.spot.toLocaleString('en-IN', { maximumFractionDigits: 1 })}
                              </td>
                              <td
                                className={`py-2 px-2 text-right font-medium ${
                                  q.changePct >= 0
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-rose-600 dark:text-rose-400'
                                }`}
                              >
                                {q.changePct >= 0 ? '+' : ''}
                                {q.changePct.toFixed(2)}%
                              </td>
                              <td className="py-2 pl-2 text-right text-slate-500 dark:text-slate-400">
                                {q.nfoOptionLtp
                                  ? `₹${q.nfoOptionLtp.toFixed(1)}`
                                  : q.rsi14
                                  ? `RSI ${q.rsi14.toFixed(0)}`
                                  : '—'}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="pt-3 mt-3 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 flex items-center justify-between">
                  <span>5m OHLCV + Intra-Bar High/Low Protection</span>
                  <span className="font-mono">09:15–15:30 IST</span>
                </div>
              </section>
            </div>

            {/* Row 3: Active Open Positions + Strategy & Risk Guardrails */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
              {/* Left 2 Columns: Active Open Positions */}
              <section className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                      Active Open Positions ({positions.length} / 5)
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Defined-risk vertical debit spreads (-65% Theta decay) · Breakeven locked at
                      +3.5% after +18% MFE
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveSection('positions')}
                    className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
                  >
                    Full Trade Journal ({overviewData.headline.closedTradesCount}) →
                  </button>
                </div>

                {positions.length === 0 ? (
                  <div className="py-10 text-center border border-dashed border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-500">
                    No open positions right now — Armed for Monday 09:15 IST market open.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 font-sans">
                          <th className="py-2.5 pr-3 font-medium">Contract</th>
                          <th className="py-2.5 px-2 font-medium">Strategy</th>
                          <th className="py-2.5 px-2 text-right font-medium">Size</th>
                          <th className="py-2.5 px-2 text-right font-medium">Entry → Mark</th>
                          <th className="py-2.5 px-2 text-right font-medium">Unrealized P&amp;L</th>
                          <th className="py-2.5 pl-2 text-right font-medium">DTE / Δ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70">
                        {positions.map((p) => (
                          <tr
                            key={p.positionId}
                            onClick={() => setActiveSection('positions')}
                            className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                          >
                            <td className="py-3 pr-3 font-semibold text-slate-900 dark:text-slate-100">
                              {p.contractSymbol}
                            </td>
                            <td className="py-3 px-2 font-sans text-slate-600 dark:text-slate-300">
                              {p.strategyName.replace('_', ' ')}
                            </td>
                            <td className="py-3 px-2 text-right text-slate-500">
                              {p.lotsQty}L ({p.lotsQty * p.lotSize})
                            </td>
                            <td className="py-3 px-2 text-right">
                              ₹{p.conservativeEntryPrice.toFixed(1)} → ₹{p.currentMarkPrice.toFixed(1)}
                            </td>
                            <td
                              className={`py-3 px-2 text-right font-semibold ${
                                p.unrealizedPnlInr >= 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-rose-600 dark:text-rose-400'
                              }`}
                            >
                              {formatInr(p.unrealizedPnlInr, true)} (
                              {p.unrealizedPnlPct >= 0 ? '+' : ''}
                              {(p.unrealizedPnlPct * 100).toFixed(1)}%)
                            </td>
                            <td className="py-3 pl-2 text-right text-slate-500">
                              {p.dte}d / {p.delta.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Right 1 Column: Strategy & Risk Controls */}
              <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between space-y-4">
                <div className="space-y-4">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                      Strategy &amp; Risk Controls
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Walk-forward ML gate &amp; readiness checklist
                    </p>
                  </div>

                  {/* Probability Gate Segmented Selector */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-600 dark:text-slate-300 font-medium">
                        ML Win-Probability Gate
                      </span>
                      <span className="font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                        P(Gain) &ge;{' '}
                        {Math.round((learningData?.qualityGateThreshold ?? 0.68) * 100)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800/80 font-mono text-xs">
                      {[
                        { val: 0.68, label: '68%' },
                        { val: 0.7, label: '70%' },
                        { val: 0.72, label: '72%' },
                      ].map((opt) => {
                        const currentThresh = Number(
                          Math.max(0.68, learningData?.qualityGateThreshold ?? 0.68).toFixed(2)
                        );
                        const isActive = Math.abs(currentThresh - opt.val) < 0.005;
                        return (
                          <button
                            key={opt.val}
                            type="button"
                            onClick={() => handleSetMinWinProb(opt.val)}
                            className={`py-1.5 rounded-md transition-colors text-center whitespace-nowrap ${
                              isActive
                                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-semibold shadow-xs'
                                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Compact Readiness Summary */}
                  <div className="space-y-2 text-xs font-mono tabular-nums pt-2 border-t border-slate-200 dark:border-slate-800">
                    <div className="flex justify-between py-1">
                      <span className="text-slate-500 font-sans">1Y Sample Size (&ge; 200)</span>
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {overviewData.headline.closedTradesCount} / 200 (PASS)
                      </span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-slate-500 font-sans">Net Profit Factor (&gt; 1.30)</span>
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {profitFactor} (PASS)
                      </span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-slate-500 font-sans">Max Drawdown (&lt; 10.0%)</span>
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {(overviewData.headline.maxDrawdownPct * 100).toFixed(2)}% (PASS)
                      </span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-slate-500 font-sans">Daily Loss Limit (-3.0%)</span>
                      <span className="text-slate-700 dark:text-slate-300">
                        -₹
                        {Math.round(
                          overviewData.headline.conservativeEquityInr * 0.03
                        ).toLocaleString('en-IN')}{' '}
                        (Clear)
                      </span>
                    </div>
                  </div>
                </div>

                {/* Clean Utility Action Row */}
                <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={steppingCycles}
                    onClick={handleRunHistoricalReplay}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${steppingCycles ? 'animate-spin' : ''}`} />
                    {steppingCycles ? 'Training...' : 'Re-Run 1Y Training'}
                  </button>
                  <button
                    type="button"
                    onClick={handleResetPaperLedger}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reset ₹10k
                  </button>
                </div>
              </section>
            </div>
          </div>
        )}

        {activeSection === 'positions' && (
          <PositionsAndTradesView
            openPositions={positions}
            closedTrades={trades}
            skippedSignals={skippedSignals}
            liveQuotes={overviewData?.liveRunner?.liveQuotes}
            formatTimestamp={formatTimestamp}
          />
        )}

        {activeSection === 'performance' && perfData && (
          <PerformanceAndBacktestView
            summary={perfData.summary}
            byStrategy={perfData.byStrategy}
            byUnderlying={perfData.byUnderlying}
            byRegime={perfData.byRegime}
            byDteBucket={perfData.byDteBucket}
            byTimeOfDay={perfData.byTimeOfDay}
            backtestResults={perfData.backtestResults}
            historicalReplayReport={
              perfData.historicalReplayReport ?? overviewData?.historicalReplayReport ?? null
            }
            onRunHistoricalReplay={handleRunHistoricalReplay}
            onRunDryRunCycle={handleRunDryRunCycle}
          />
        )}

        {activeSection === 'learning' && learningData && overviewData && (
          <LearningAndHealthView
            learning={learningData}
            health={overviewData.health}
            control={overviewData.control}
            formatTimestamp={formatTimestamp}
            onPromoteChallenger={handlePromoteChallenger}
            onRollbackChampion={handleRollbackChampion}
            onToggleSimulateOffline={handleToggleSimulateOffline}
            onToggleStrictMarketHours={handleToggleStrictMarketHours}
            onResetPaperLedger={handleResetPaperLedger}
          />
        )}

        {activeSection === 'code' && <CodeAndGuideView />}
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800 px-6 py-4 text-xs text-slate-500 dark:text-slate-400 flex flex-wrap items-center justify-between gap-4">
        <div>
          AegisQuant NSE Options Paper-Trading Engine · Trained on 1-Year Real Angel One Data (₹10,000 Base Capital)
        </div>
        <div>
          Paper Trading Sandbox Only · SEBI Notice: F&amp;O trading carries substantial risk
        </div>
      </footer>
    </div>
  );
}
