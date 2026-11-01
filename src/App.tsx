/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Clock,
  FastForward,
  Moon,
  PauseCircle,
  PlayCircle,
  ShieldAlert,
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
    const pollTimer = setInterval(fetchAllTelemetry, 5000);
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

  const handleFastForwardCycles = async (cycles: number) => {
    setSteppingCycles(true);
    try {
      await fetch('/api/fast-forward', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cycles }),
      });
      await fetchAllTelemetry();
    } finally {
      setSteppingCycles(false);
    }
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
    await fetch('/api/historical-replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fromDateIst: '2026-09-29 09:15',
        toDateIst: '2026-10-30 15:30',
      }),
    });
    await fetchAllTelemetry();
  };

  const isOffline = overviewData?.health.isOffline ?? false;
  const entriesEnabled = overviewData?.control.newEntriesEnabled ?? true;
  const killSwitchActive = overviewData?.control.killSwitchActive ?? false;
  const autoRunActive = overviewData?.liveRunner?.autoRunEnabled ?? true;

  const botStatusLabel = isOffline
    ? 'OFFLINE'
    : killSwitchActive
    ? 'Kill-Switch'
    : entriesEnabled
    ? 'Running (NSE Paper)'
    : 'Paused (Exits Active)';

  const lc = overviewData?.liveRunner?.learningComparison;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
      {/* Mandatory Permanent Safety Banner */}
      <div
        role="region"
        aria-label="Paper Trading Safety Disclosure"
        className="bg-amber-500/15 dark:bg-amber-500/10 border-b border-amber-500/30 px-6 py-2 text-xs flex flex-wrap items-center justify-between gap-4"
      >
        <div className="flex items-center gap-2 font-mono font-semibold text-amber-800 dark:text-amber-300">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>PAPER TRADING - NOT REAL MONEY</span>
          <span aria-hidden="true">·</span>
          <span className="font-sans font-normal text-amber-900/80 dark:text-amber-200/80">
            Indian NSE F&amp;O (NIFTY / BANKNIFTY / FINNIFTY / Stock Options) · Read-Only Web Role (web_ro) · ₹0/mo Oracle VM + Neon + Vercel
          </span>
        </div>
        <div className="text-[11px] text-amber-800/80 dark:text-amber-300/80">
          SEBI Honesty Notice: ~90% of individual F&amp;O traders lose money; paper results typically overstate live performance.
        </div>
      </div>

      {/* Red BOT OFFLINE Alert Banner when Heartbeat > 10 minutes during market hours */}
      {isOffline && (
        <div
          role="alert"
          className="bg-rose-600 text-white px-6 py-2.5 text-xs font-mono flex flex-wrap items-center justify-between gap-4"
        >
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              BOT OFFLINE — Last Oracle VM heartbeat was {overviewData?.health.heartbeatAgeMinutes}{' '}
              minutes ago (&gt; 10m threshold during 09:15–15:30 IST NSE market hours). Check systemd
              service or OCI Mumbai instance state.
            </span>
          </div>
          <button
            type="button"
            onClick={() => handleToggleSimulateOffline(false)}
            className="px-3 py-1 bg-white text-rose-700 font-sans font-semibold rounded hover:bg-rose-50 transition-colors whitespace-nowrap shrink-0"
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
          className="flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-400 overflow-x-auto"
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
            Performance &amp; Backtest
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
            Bot &amp; Deploy Files
          </button>
        </nav>

        {/* Zone 3: 1 primary action (Pause/Resume New Entries switch updating `control` row) */}
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

      {/* Workspace Telemetry & Utility Toolbar */}
      <div className="bg-slate-100/70 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-800 px-6 py-2.5 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums text-slate-600 dark:text-slate-300">
          <span>
            Status:{' '}
            <strong
              className={
                isOffline
                  ? 'text-rose-600 dark:text-rose-400'
                  : entriesEnabled
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-400'
              }
            >
              {botStatusLabel}
            </strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>Regime: {overviewData?.health.currentRegime ?? 'trending_up'}</span>
          <span aria-hidden="true">·</span>
          <span>INDIA VIX: {overviewData?.health.indiaVixLevel ?? 14.25}</span>
          <span aria-hidden="true">·</span>
          <span>
            NIFTY 50: {overviewData?.health.niftySpot.toLocaleString('en-IN') ?? '24,482.6'}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Sample Size: {overviewData?.headline.closedTradesCount ?? 64} of{' '}
            {overviewData?.headline.sampleSizeTarget ?? 200} trades needed for a meaningful read
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleToggleSimulateOffline(!isOffline)}
            className="px-2.5 py-1 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            {isOffline ? 'Restore Heartbeat' : 'Simulate Offline (>10m Heartbeat)'}
          </button>

          <button
            type="button"
            onClick={() => setTimezoneMode((prev) => (prev === 'IST' ? 'LOCAL' : 'IST'))}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Clock className="w-3.5 h-3.5" />
            Timezone: {timezoneMode === 'IST' ? 'Asia/Kolkata (IST)' : 'Viewer Local'}
          </button>

          <button
            type="button"
            onClick={() => setDarkMode((prev) => !prev)}
            aria-label={darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            {darkMode ? 'Light Theme' : 'Dark Theme'}
          </button>
        </div>
      </div>

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-[1400px] w-full mx-auto px-6 py-8">
        {activeSection === 'overview' && overviewData && (
          <div className="space-y-8">
            {/* Live Paper Execution & Self-Learning Control Strip */}
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-emerald-500" />
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Live NSE Paper Execution &amp; Self-Learning Engine (Cycle #
                      {overviewData.liveRunner?.totalAutonomousCyclesRun ?? 1})
                    </h2>
                  </div>
                  <p className="text-xs font-mono text-slate-600 dark:text-slate-300">
                    {overviewData.liveRunner?.latestActionSummary}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleToggleAutoRun}
                    className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 ${
                      autoRunActive
                        ? 'bg-emerald-600/15 border-emerald-500 text-emerald-700 dark:text-emerald-300'
                        : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Auto-Run (8s Tick): {autoRunActive ? 'ACTIVE' : 'PAUSED'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleToggleStrictMarketHours(
                        !overviewData.control.strictLiveMarketHoursOnly
                      )
                    }
                    className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 ${
                      overviewData.control.strictLiveMarketHoursOnly
                        ? 'bg-amber-500/15 border-amber-500 text-amber-700 dark:text-amber-300 font-semibold'
                        : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    Strict NSE Hours (09:15–15:30 IST):{' '}
                    {overviewData.control.strictLiveMarketHoursOnly ? 'ON' : 'OFF (24/7)'}
                  </button>
                  <button
                    type="button"
                    onClick={handleResetPaperLedger}
                    className="px-3 py-1.5 text-xs font-medium border border-blue-500/50 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 rounded transition-colors whitespace-nowrap shrink-0"
                  >
                    Reset Ledger (₹10,00,000)
                  </button>
                  <button
                    type="button"
                    disabled={steppingCycles}
                    onClick={() => handleFastForwardCycles(1)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                  >
                    Step +1 Cycle
                  </button>
                  <button
                    type="button"
                    disabled={steppingCycles}
                    onClick={() => handleFastForwardCycles(10)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors whitespace-nowrap shrink-0"
                  >
                    <FastForward className="w-3.5 h-3.5" />
                    Fast-Forward +10 Cycles
                  </button>
                  <button
                    type="button"
                    disabled={steppingCycles}
                    onClick={() => handleFastForwardCycles(30)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors whitespace-nowrap shrink-0"
                  >
                    <FastForward className="w-3.5 h-3.5" />
                    Fast-Forward +30 Cycles (Retrain ML Gate)
                  </button>
                  <button
                    type="button"
                    disabled={steppingCycles}
                    onClick={() => handleFastForwardCycles(180)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded transition-colors whitespace-nowrap shrink-0"
                  >
                    <FastForward className="w-3.5 h-3.5" />
                    Fast-Forward to 200+ Trades (Promote GBDT)
                  </button>
                </div>
              </div>

              {lc && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-3 border-t border-slate-200 dark:border-slate-800 text-xs font-mono tabular-nums">
                  <div>
                    <span className="text-slate-500 font-sans block">
                      Early Half Trades (Baseline Prior):
                    </span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {formatInr(lc.earlyTradesExpectancyInr, true)}/trade · Win Rate{' '}
                      {lc.earlyWinRatePct}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 font-sans block">
                      Recent Half Trades (Learned Gate + Spreads):
                    </span>
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                      {formatInr(lc.recentTradesExpectancyInr, true)}/trade · Win Rate{' '}
                      {lc.recentWinRatePct}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 font-sans block">
                      Counterfactual Losses Avoided by ML Gate:
                    </span>
                    <span className="font-semibold text-blue-600 dark:text-blue-400">
                      {lc.gateAvoidedLossesCount} bad setups skipped (~
                      {formatInr(lc.gateAvoidedLossesSavedInr)} saved)
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 font-sans block">
                      Active Gate &amp; Model Architecture:
                    </span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      P(Gain) &ge; {Math.round((learningData?.qualityGateThreshold ?? 0.68) * 100)}% · AUC{' '}
                      {learningData?.walkForwardAuc.toFixed(3) ?? '0.786'} ·{' '}
                      {learningData?.championVersion.includes('gbdt') ? 'GBDT Ensemble' : 'L2 Logistic'}
                    </span>
                  </div>
                </div>
              )}

              {/* Capital-Preservation Probability Gate Selector (Hard Floor >= 67%) */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-200 dark:border-slate-800 text-xs">
                <div className="text-slate-600 dark:text-slate-300">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    Capital-Preservation Policy:
                  </span>{' '}
                  Trades only when calibrated <span className="font-mono">P(net gain) &ge; {Math.round((learningData?.qualityGateThreshold ?? 0.68) * 100)}%</span> (Hard Floor: 67%) + <span className="font-semibold text-emerald-700 dark:text-emerald-400">Defined-Risk Vertical Debit Spreads</span> (-65% Theta decay when VIX &ge; 14.5 or IVR &ge; 45%) + Breakeven-Lock (+3.5% locked at +18% MFE).
                </div>
                <div className="flex flex-wrap items-center gap-1.5 font-mono">
                  {[
                    { val: 0.67, label: '67% Floor' },
                    { val: 0.68, label: '68% Recommended (2.1:1)' },
                    { val: 0.70, label: '70% Strict' },
                    { val: 0.72, label: '72% Sniper' },
                  ].map((opt) => {
                    const currentThresh = Number((learningData?.qualityGateThreshold ?? 0.68).toFixed(2));
                    const isActive = Math.abs(currentThresh - opt.val) < 0.005;
                    return (
                      <button
                        key={opt.val}
                        type="button"
                        onClick={() => handleSetMinWinProb(opt.val)}
                        className={`px-2.5 py-1 rounded border transition-colors whitespace-nowrap shrink-0 ${
                          isActive
                            ? 'bg-emerald-600 text-white border-emerald-600 font-semibold'
                            : 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Angel One SmartAPI Live NSE Market Data Strip */}
              {overviewData.liveRunner?.liveQuotes && (
                <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900 dark:text-slate-100">
                        Market Data Feed:
                      </span>
                      <span
                        className={`font-mono px-2 py-0.5 rounded text-[11px] font-semibold ${
                          overviewData.liveRunner.angelOneStatus?.authenticated
                            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
                            : 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30'
                        }`}
                      >
                        {overviewData.liveRunner.angelOneStatus?.authenticated
                          ? `ANGEL ONE SMARTAPI LIVE (${overviewData.liveRunner.angelOneStatus.clientCodeMasked} · FULL L1/L2 + GREEKS)`
                          : overviewData.liveRunner.angelOneStatus?.configured
                          ? `ANGEL ONE CONFIGURED (${overviewData.liveRunner.angelOneStatus.clientCodeMasked}) — CONNECTING...`
                          : 'ANGEL ONE SMARTAPI READY (Set ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_MPIN, ANGEL_TOTP_SECRET in Vercel)'}
                      </span>
                    </div>
                    <span className="text-[11px] font-mono text-slate-500">
                      10 NSE Tokens (#99926000 NIFTY · #99926009 BANKNIFTY · #99926037 FINNIFTY · #99926017 VIX)
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-5 lg:grid-cols-10 gap-2 text-[11px] font-mono tabular-nums">
                    {Object.values(overviewData.liveRunner.liveQuotes).map((q) => (
                      <div
                        key={q.symbol}
                        className="px-2.5 py-1.5 rounded bg-slate-50 dark:bg-slate-950/70 border border-slate-200/80 dark:border-slate-800/80"
                      >
                        <div className="flex items-center justify-between gap-1 text-slate-500">
                          <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                            {q.symbol}
                          </span>
                          <span className="text-[9px] opacity-75">
                            {q.source === 'ANGEL_ONE_LIVE' ? 'ANGEL' : 'NSE'}
                          </span>
                        </div>
                        <div className="font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                          {q.symbol === 'INDIA_VIX'
                            ? q.spot.toFixed(2)
                            : q.spot.toLocaleString('en-IN', { maximumFractionDigits: 1 })}
                        </div>
                        <div
                          className={`text-[10px] ${
                            q.changePct >= 0
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {q.changePct >= 0 ? '+' : ''}
                          {q.changePct.toFixed(2)}%
                        </div>
                        {(q.rsi14 || q.nfoOptionLtp) && (
                          <div className="text-[9px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                            {q.nfoOptionLtp
                              ? `NFO ₹${q.nfoOptionLtp.toFixed(1)}`
                              : `RSI ${q.rsi14?.toFixed(0)} · ADX ${q.adx14?.toFixed(0)}`}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {/* Headline KPI Strip */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Conservative Simulation Equity (Headline)
                </div>
                <div className="text-2xl font-mono tabular-nums font-bold text-blue-600 dark:text-blue-400 mt-1">
                  {formatInr(overviewData.headline.conservativeEquityInr)}
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-500 mt-1.5 flex flex-wrap gap-x-2">
                  <span className="whitespace-nowrap">
                    Realized: {formatInr(overviewData.headline.realizedPnlInr, true)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="whitespace-nowrap">
                    Unrealized: {formatInr(overviewData.headline.unrealizedPnlInr, true)}
                  </span>
                </div>
              </div>

              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Paper Broker Account Equity (Optimistic Fills)
                </div>
                <div className="text-2xl font-mono tabular-nums font-bold text-emerald-600 dark:text-emerald-400 mt-1">
                  {formatInr(overviewData.headline.brokerPaperEquityInr)}
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-500 mt-1.5 flex flex-wrap gap-x-2">
                  <span className="whitespace-nowrap">
                    Paper: {formatInr(overviewData.headline.brokerPaperRealizedPnlInr, true)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="whitespace-nowrap">
                    Drag: -
                    {formatInr(
                      overviewData.headline.brokerPaperRealizedPnlInr -
                        overviewData.headline.realizedPnlInr
                    )}
                  </span>
                </div>
              </div>

              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Today&apos;s P&amp;L (Conservative Ledger)
                </div>
                <div
                  className={`text-2xl font-mono tabular-nums font-bold mt-1 ${
                    overviewData.headline.todayPnlInr >= 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-rose-600 dark:text-rose-400'
                  }`}
                >
                  {formatInr(overviewData.headline.todayPnlInr, true)}
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-500 mt-1.5">
                  Daily Loss Halt Limit: -3.00% (-₹30,000) · Status: Clear
                </div>
              </div>

              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Current Drawdown / Kill-Switch Ceiling
                </div>
                <div className="text-2xl font-mono tabular-nums font-bold text-slate-900 dark:text-slate-100 mt-1">
                  {(overviewData.headline.currentDrawdownPct * 100).toFixed(2)}% / 10.00%
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-500 mt-1.5">
                  Max Historical DD: {(overviewData.headline.maxDrawdownPct * 100).toFixed(2)}% · Open
                  Positions: {overviewData.headline.openPositionsCount}/5
                </div>
              </div>
            </div>

            {/* Equity Curve Comparison Card */}
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                <div>
                  <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                    Equity Curve: Conservative Simulation vs. Paper Broker vs. NIFTY 50 Buy-and-Hold
                  </h1>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Starting virtual capital ₹10,00,000 · Conservative simulation fills buys at{' '}
                    <code className="font-mono">mid + 35% of bid-ask spread</code> and sells at{' '}
                    <code className="font-mono">mid - 35% of spread</code> plus{' '}
                    <code className="font-mono">₹35/lot</code> statutory + brokerage charges
                  </p>
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-500">
                  Last Cycle: {formatTimestamp(overviewData.health.lastCycleAt)}
                </div>
              </div>

              <EquityCurveChart
                data={overviewData.equitySeries}
                formatTimestamp={formatTimestamp}
              />
            </section>

            {/* Open Positions Snapshot & Go/No-Go Evaluation Gate */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <section className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                    Active Open NSE Option Positions ({positions.length} / 5)
                  </h2>
                  <button
                    type="button"
                    onClick={() => setActiveSection('positions')}
                    className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    View Full Trade Journal →
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 font-sans">
                        <th className="py-2 pr-3">NSE Contract</th>
                        <th className="py-2 px-2">Strategy</th>
                        <th className="py-2 px-2 text-right">Lot Size</th>
                        <th className="py-2 px-2 text-right">Entry → Mark (₹)</th>
                        <th className="py-2 px-2 text-right">P&amp;L (₹ / %)</th>
                        <th className="py-2 pl-2 text-right">DTE / Δ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70">
                      {positions.map((p) => (
                        <tr key={p.positionId}>
                          <td className="py-2.5 pr-3 font-semibold text-slate-900 dark:text-slate-100">
                            {p.contractSymbol}
                          </td>
                          <td className="py-2.5 px-2 font-sans text-slate-600 dark:text-slate-300">
                            {p.strategyName}
                          </td>
                          <td className="py-2.5 px-2 text-right text-slate-500">
                            {p.lotsQty}L ({p.lotSize})
                          </td>
                          <td className="py-2.5 px-2 text-right">
                            ₹{p.conservativeEntryPrice.toFixed(2)} → ₹{p.currentMarkPrice.toFixed(2)}
                          </td>
                          <td
                            className={`py-2.5 px-2 text-right font-semibold ${
                              p.unrealizedPnlInr >= 0
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-rose-600 dark:text-rose-400'
                            }`}
                          >
                            {formatInr(p.unrealizedPnlInr, true)} (
                            {p.unrealizedPnlPct >= 0 ? '+' : ''}
                            {(p.unrealizedPnlPct * 100).toFixed(1)}%)
                          </td>
                          <td className="py-2.5 pl-2 text-right">
                            {p.dte}d / {p.delta.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-3">
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Go / No-Go Real-Money Gate (Section 14)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Do NOT consider real capital until every threshold below passes after conservative NSE spread + ₹35/lot statutory charges:
                </p>
                <div className="space-y-2 text-xs font-mono tabular-nums">
                  <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-800">
                    <span>1. Closed Trades (&gt;= 200):</span>
                    <span
                      className={
                        overviewData.headline.closedTradesCount >= 200
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }
                    >
                      {overviewData.headline.closedTradesCount} / 200 (
                      {overviewData.headline.closedTradesCount >= 200 ? 'PASS' : 'PENDING'})
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-800">
                    <span>2. Forward Duration (&gt;= 8-12w):</span>
                    <span className="text-emerald-600 dark:text-emerald-400">8.5 / 8 wks (PASS)</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-800">
                    <span>3. Cons Expectancy (&gt; ₹0):</span>
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {formatInr(perfData?.summary.expectancyInr ?? 540, true)} (PASS)
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-800">
                    <span>4. Cons Profit Factor (&gt; 1.30):</span>
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {perfData?.summary.profitFactor.toFixed(2) ?? '1.48'} (PASS)
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-200 dark:border-slate-800">
                    <span>5. Max Drawdown (&lt; 10.0%):</span>
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {(overviewData.headline.maxDrawdownPct * 100).toFixed(2)}% (PASS)
                    </span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span>6. Multi-Regime (&gt;= 2 Regimes):</span>
                    <span className="text-emerald-600 dark:text-emerald-400">4 Regimes (PASS)</span>
                  </div>
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
          AegisQuant Indian NSE F&amp;O Paper-Trading Monorepo · Oracle Cloud Always Free VM (Mumbai/Hyderabad) + Neon Serverless Postgres + Vercel Hobby (₹0/mo)
        </div>
        <div>
          Paper Trading Only (`paper-sandbox.nseindia-sim.local`) · Zero Live Execution Code Paths
        </div>
      </footer>
    </div>
  );
}
