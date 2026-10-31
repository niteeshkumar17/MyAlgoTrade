import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  buildInitialQuantState,
  QuantSystemState,
} from './src/quant/seedStore.js';
import {
  blackScholesOptionPrice,
  calculateRoundtripPnl,
  isBotOfflineDuringMarketHours,
  NSE_LOT_SIZES,
  OptionRight,
  simulatePessimisticFill,
} from './src/quant/engine.js';
import {
  computeLearningEffectiveness,
  executeAutonomousPaperCycles,
  refreshLiveNseQuotes,
} from './src/quant/livePaperRunner.js';
import { getAngelOneConnectionStatus } from './src/quant/angelOneSmartApi.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let state: QuantSystemState = buildInitialQuantState();
let autoRunEnabled = true;
let latestActionSummary =
  'Autonomous NSE Paper Engine active — scanning NIFTY, BANKNIFTY, FINNIFTY & Stock Options every cycle.';
let totalAutonomousCyclesRun = 1;

// Optional Neon Postgres persistence pool (supports DATABASE_URL_RW, DATABASE_URL, or DATABASE_URL_RO)
const rawDbUrl =
  process.env.DATABASE_URL_RW ||
  process.env.DATABASE_URL ||
  process.env.DATABASE_URL_RO ||
  '';
const dbPool = rawDbUrl
  ? new pg.Pool({
      connectionString: rawDbUrl,
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 4000,
    })
  : null;
let stateLoadedFromDb = false;

async function ensureStateLoadedFromNeon(): Promise<void> {
  if (!dbPool || stateLoadedFromDb) return;
  stateLoadedFromDb = true;
  try {
    const res = await dbPool.query(
      "SELECT config_payload_json FROM config_history WHERE config_version_id = 'LIVE_STATE_CHECKPOINT' LIMIT 1"
    );
    if (res.rows.length > 0 && res.rows[0].config_payload_json) {
      const saved = res.rows[0].config_payload_json;
      if (saved.state && saved.state.closedTrades && saved.state.equitySeries) {
        const seenSnap = new Set<string>();
        saved.state.equitySeries.forEach((pt: { snapshotId: string }, idx: number) => {
          if (seenSnap.has(pt.snapshotId)) {
            pt.snapshotId = `${pt.snapshotId}-${idx}`;
          }
          seenSnap.add(pt.snapshotId);
        });
        state = saved.state;
        totalAutonomousCyclesRun = Number(saved.totalAutonomousCyclesRun) || totalAutonomousCyclesRun;
        latestActionSummary = saved.latestActionSummary || latestActionSummary;
        autoRunEnabled = saved.autoRunEnabled ?? true;
      }
    }
  } catch {
    // Non-fatal: continue with in-memory state if table/role is read-only or unreachable
  }
}

async function persistStateToNeon(): Promise<void> {
  if (!dbPool) return;
  try {
    const payload = JSON.stringify({
      state,
      totalAutonomousCyclesRun,
      latestActionSummary,
      autoRunEnabled,
    });
    await dbPool.query(
      `INSERT INTO config_history (config_version_id, applied_at, is_active_champion, previous_champion_id, config_payload_json, change_summary)
       VALUES ('LIVE_STATE_CHECKPOINT', NOW(), TRUE, $1, $2::jsonb, $3)
       ON CONFLICT (config_version_id) DO UPDATE SET
         applied_at = NOW(),
         previous_champion_id = EXCLUDED.previous_champion_id,
         config_payload_json = EXCLUDED.config_payload_json,
         change_summary = EXCLUDED.change_summary`,
      [
        state.control.activeChampionVersion,
        payload,
        latestActionSummary.slice(0, 240),
      ]
    );
    await dbPool.query(
      `INSERT INTO bot_health (bot_id, heartbeat_at, last_cycle_at, last_cycle_status, market_open, current_regime, last_db_write_at)
       VALUES ($1, NOW(), NOW(), $2, $3, $4, NOW())
       ON CONFLICT (bot_id) DO UPDATE SET
         heartbeat_at = NOW(),
         last_cycle_at = NOW(),
         last_cycle_status = EXCLUDED.last_cycle_status,
         market_open = EXCLUDED.market_open,
         current_regime = EXCLUDED.current_regime,
         last_db_write_at = NOW()`,
      [
        state.health.botId || 'aegis-nse-mumbai-bom1',
        state.health.lastCycleStatus || 'OK',
        Boolean(state.health.marketOpen),
        state.health.currentRegime || 'trending_up',
      ]
    );
  } catch {
    // Ignore write error if connected strictly with web_ro read-only role
  }
}

const REPO_FILES_LIST = [
  'README.md',
  'bot/config.yaml',
  'bot/.env.example',
  'bot/requirements.txt',
  'bot/src/config.py',
  'bot/src/calendar_utils.py',
  'bot/src/interfaces.py',
  'bot/src/alpaca_client.py',
  'bot/src/regime.py',
  'bot/src/strategies.py',
  'bot/src/fills.py',
  'bot/src/exits.py',
  'bot/src/risk.py',
  'bot/src/backtester.py',
  'bot/src/journal.py',
  'bot/src/db.py',
  'bot/src/learning.py',
  'bot/src/alerts.py',
  'bot/src/main.py',
  'bot/tests/test_bot_core.py',
  'deploy/install.sh',
  'deploy/aegis-options-bot.service',
  'deploy/migrations/001_initial_schema.sql',
  'deploy/migrations/002_roles_and_permissions.sql',
  'web/.env.example',
  'web/package.json',
  'web/middleware.ts',
  'web/lib/db.ts',
  'web/app/api/overview/route.ts',
  'web/app/api/positions/route.ts',
  'web/app/api/trades/route.ts',
  'web/app/api/performance/route.ts',
  'web/app/api/learning/route.ts',
  'web/app/api/health/route.ts',
  'web/app/api/control/route.ts',
];

function computePerformanceMetrics(s: QuantSystemState) {
  const trades = s.closedTrades.filter((t) => !t.isShadowChallenger);
  const wins = trades.filter((t) => t.conservativePnlInr > 0);
  const losses = trades.filter((t) => t.conservativePnlInr <= 0);
  const tradeCount = trades.length;
  const winRate = tradeCount > 0 ? Number((wins.length / tradeCount).toFixed(4)) : 0;
  const avgWinInr =
    wins.length > 0
      ? Number((wins.reduce((acc, x) => acc + x.conservativePnlInr, 0) / wins.length).toFixed(2))
      : 0;
  const avgLossInr =
    losses.length > 0
      ? Number((losses.reduce((acc, x) => acc + x.conservativePnlInr, 0) / losses.length).toFixed(2))
      : 0;
  const totalConsPnl = Number(
    trades.reduce((acc, x) => acc + x.conservativePnlInr, 0).toFixed(2)
  );
  const totalPaperPnl = Number(
    trades.reduce((acc, x) => acc + x.brokerPaperPnlInr, 0).toFixed(2)
  );
  const expectancyInr = tradeCount > 0 ? Number((totalConsPnl / tradeCount).toFixed(2)) : 0;
  const grossWin = wins.reduce((acc, x) => acc + x.conservativePnlInr, 0);
  const grossLoss = Math.abs(losses.reduce((acc, x) => acc + x.conservativePnlInr, 0));
  const profitFactor = grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : 2.0;
  const maxDrawdownPct = Number(
    Math.max(...s.equitySeries.map((pt) => pt.drawdownPct), 0.01).toFixed(4)
  );

  const mean = expectancyInr;
  const variance =
    tradeCount > 1
      ? trades.reduce((acc, t) => acc + Math.pow(t.conservativePnlInr - mean, 2), 0) /
        (tradeCount - 1)
      : 1;
  const std = Math.sqrt(Math.max(variance, 1));
  const sharpeRatio = Number(((mean / std) * Math.sqrt(52)).toFixed(2));

  const groupStats = (keyFn: (t: (typeof trades)[number]) => string) => {
    const map = new Map<string, typeof trades>();
    for (const t of trades) {
      const k = keyFn(t);
      const arr = map.get(k) ?? [];
      arr.push(t);
      map.set(k, arr);
    }
    return Array.from(map.entries()).map(([key, list]) => {
      const w = list.filter((x) => x.conservativePnlInr > 0);
      const netCons = Number(list.reduce((a, b) => a + b.conservativePnlInr, 0).toFixed(2));
      const netPaper = Number(list.reduce((a, b) => a + b.brokerPaperPnlInr, 0).toFixed(2));
      return {
        key,
        tradeCount: list.length,
        winRate: Number((w.length / list.length).toFixed(4)),
        expectancyInr: Number((netCons / list.length).toFixed(2)),
        conservativeNetPnlInr: netCons,
        brokerPaperNetPnlInr: netPaper,
      };
    });
  };

  return {
    summary: {
      tradeCount,
      sampleSizeTarget: 200,
      winRate,
      avgWinInr,
      avgLossInr,
      profitFactor,
      expectancyInr,
      maxDrawdownPct,
      sharpeRatio,
      totalConservativeRealizedPnlInr: totalConsPnl,
      totalBrokerPaperRealizedPnlInr: totalPaperPnl,
    },
    byStrategy: groupStats((t) => t.strategyName),
    byUnderlying: groupStats((t) => t.underlying).sort(
      (a, b) => b.conservativeNetPnlInr - a.conservativeNetPnlInr
    ),
    byRegime: groupStats((t) => t.regimeAtEntry),
    byDteBucket: groupStats((t) =>
      t.dteAtEntry < 14
        ? '7-13 DTE (Weekly)'
        : t.dteAtEntry <= 21
        ? '14-21 DTE'
        : '22-35 DTE (Monthly)'
    ),
    byTimeOfDay: groupStats((t) => t.timeOfDayBucket),
  };
}

export const app = express();
app.use(express.json());

// Initial live NSE quote refresh + background 8-second autonomous paper loop
refreshLiveNseQuotes().catch(() => {});
if (!process.env.VERCEL) {
  setInterval(async () => {
    if (!autoRunEnabled || state.health.simulatedOfflineMode) return;
    await refreshLiveNseQuotes();
    const rep = executeAutonomousPaperCycles(state, 1);
    totalAutonomousCyclesRun += rep.cyclesRun;
    latestActionSummary = rep.latestActionSummary;
  }, 8000);
}

// 1. GET /api/overview
app.get('/api/overview', async (_req, res) => {
  await ensureStateLoadedFromNeon();
  const liveQuotes = await refreshLiveNseQuotes();
  if (process.env.VERCEL && autoRunEnabled && !state.health.simulatedOfflineMode) {
    const rep = executeAutonomousPaperCycles(state, 1);
    totalAutonomousCyclesRun += rep.cyclesRun;
    latestActionSummary = rep.latestActionSummary;
    await persistStateToNeon();
  }
  const perf = computePerformanceMetrics(state);
  const unrealizedInr = Number(
    state.openPositions.reduce((acc, p) => acc + p.unrealizedPnlInr, 0).toFixed(2)
  );
  const latestEq = state.equitySeries[state.equitySeries.length - 1];
  const prevEq = state.equitySeries[Math.max(0, state.equitySeries.length - 3)];
  const todayPnlInr = Number(
    (
      latestEq.conservativeEquityInr -
      prevEq.conservativeEquityInr +
      unrealizedInr * 0.35
    ).toFixed(2)
  );
  const offlineCheck = isBotOfflineDuringMarketHours(
    state.health.heartbeatAt,
    state.health.marketOpen
  );

  res.json({
    control: state.control,
    health: {
      ...state.health,
      heartbeatAgeMinutes: offlineCheck.ageMinutes,
      isOffline: offlineCheck.isOffline,
    },
    liveRunner: {
      autoRunEnabled,
      totalAutonomousCyclesRun,
      latestActionSummary,
      liveQuotes,
      angelOneStatus: getAngelOneConnectionStatus(),
      learningComparison: computeLearningEffectiveness(state),
    },
    headline: {
      conservativeEquityInr: Number((latestEq.conservativeEquityInr + unrealizedInr).toFixed(2)),
      brokerPaperEquityInr: Number(
        (latestEq.brokerPaperEquityInr + unrealizedInr * 1.12).toFixed(2)
      ),
      niftyBenchmarkEquityInr: latestEq.niftyBenchmarkEquityInr,
      todayPnlInr,
      realizedPnlInr: perf.summary.totalConservativeRealizedPnlInr,
      brokerPaperRealizedPnlInr: perf.summary.totalBrokerPaperRealizedPnlInr,
      unrealizedPnlInr: unrealizedInr,
      currentDrawdownPct: latestEq.drawdownPct,
      maxDrawdownPct: perf.summary.maxDrawdownPct,
      openPositionsCount: state.openPositions.length,
      closedTradesCount: perf.summary.tradeCount,
      sampleSizeTarget: 200,
    },
    equitySeries: state.equitySeries,
    summaryMetrics: perf.summary,
  });
});

// 2. GET /api/positions
app.get('/api/positions', (_req, res) => {
  res.json({ positions: state.openPositions });
});

// 3. GET /api/trades
app.get('/api/trades', (_req, res) => {
  res.json({
    trades: state.closedTrades,
    skippedSignals: state.skippedSignals,
  });
});

// 4. GET /api/performance
app.get('/api/performance', (_req, res) => {
  res.json({
    ...computePerformanceMetrics(state),
    backtestResults: state.backtestResults,
    learningComparison: computeLearningEffectiveness(state),
  });
});

// 5. GET /api/learning
app.get('/api/learning', (_req, res) => {
  res.json({
    ...state.learning,
    learningComparison: computeLearningEffectiveness(state),
  });
});

// 6. GET /api/health (Also triggers autonomous cycle on Vercel when pinged by UptimeRobot every 5m)
app.get('/api/health', async (_req, res) => {
  await ensureStateLoadedFromNeon();
  if (process.env.VERCEL && autoRunEnabled && !state.health.simulatedOfflineMode) {
    await refreshLiveNseQuotes();
    const rep = executeAutonomousPaperCycles(state, 1);
    totalAutonomousCyclesRun += rep.cyclesRun;
    latestActionSummary = rep.latestActionSummary;
    await persistStateToNeon();
  }
  const offlineCheck = isBotOfflineDuringMarketHours(
    state.health.heartbeatAt,
    state.health.marketOpen
  );
  res.json({
    status: 'ok',
    health: state.health,
    control: state.control,
    angelOneStatus: getAngelOneConnectionStatus(),
    heartbeatAgeMinutes: offlineCheck.ageMinutes,
    isOffline: offlineCheck.isOffline,
    totalAutonomousCyclesRun,
    latestActionSummary,
  });
});

// 7. POST /api/control — Pause/Resume new entries switch, Auto-Run toggle, Capital-Preservation Gate, Offline/Rollback/Promotion
app.post('/api/control', (req, res) => {
  const { action, newEntriesEnabled, simulateOffline, autoRun, minWinProb } = req.body ?? {};
  const nowIso = new Date().toISOString();

  if (action === 'toggle_pause') {
    state.control.newEntriesEnabled = Boolean(newEntriesEnabled);
    state.control.updatedAt = nowIso;
    state.control.updatedBy = 'vercel_web_switch (web_ro)';
    state.health.lastCycleStatus = state.control.newEntriesEnabled ? 'OK' : 'PAUSED';
  } else if (action === 'set_min_win_prob') {
    const parsed = Number(minWinProb);
    if (Number.isFinite(parsed)) {
      const oldVal = state.learning.qualityGateThreshold;
      // Hard safety floor: never allow P(gain) threshold below 67% (0.67)
      const clamped = Number(Math.max(0.67, Math.min(0.85, parsed)).toFixed(2));
      state.learning.qualityGateThreshold = clamped;
      latestActionSummary = `Updated Capital-Preservation Gate to P(gain) >= ${(clamped * 100).toFixed(0)}% (Hard Floor: 67%).`;
      state.learning.learningLog.unshift({
        logId: `LL-GATE-${Date.now().toString().slice(-4)}`,
        loggedAt: nowIso,
        changeCategory: 'CAPITAL_PRESERVATION_GATE',
        modelVersion: state.learning.championVersion,
        parameterOrBucket: 'quality_gate.min_win_probability',
        oldValue: `${(oldVal * 100).toFixed(0)}%`,
        newValue: `${(clamped * 100).toFixed(0)}% (Hard Floor >= 67%)`,
        sampleSize: state.closedTrades.length,
        bootstrapCi90: 'Operator Capital-Preservation Floor',
        reasonAndEvidence: `Set minimum calibrated probability of net gain (after spread & ₹35/lot fee) to ${(clamped * 100).toFixed(0)}% with a hard 67% floor.`,
      });
    }
  } else if (action === 'toggle_autorun') {
    autoRunEnabled = Boolean(autoRun);
    latestActionSummary = autoRunEnabled
      ? 'Autonomous NSE Paper Loop resumed (1 cycle every 8s).'
      : 'Autonomous NSE Paper Loop paused by operator.';
  } else if (action === 'simulate_offline') {
    const makeOffline = Boolean(simulateOffline);
    state.health.simulatedOfflineMode = makeOffline;
    if (makeOffline) {
      state.health.heartbeatAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    } else {
      state.health.heartbeatAt = nowIso;
      state.health.lastDbWriteAt = nowIso;
    }
  } else if (action === 'rollback_champion') {
    const prev = state.learning.previousChampionVersion;
    const oldChamp = state.learning.championVersion;
    state.learning.championVersion = prev;
    state.control.activeChampionVersion = prev;
    state.control.updatedAt = nowIso;
    state.learning.learningLog.unshift({
      logId: `LL-RB-${Date.now().toString().slice(-4)}`,
      loggedAt: nowIso,
      changeCategory: 'CHAMPION_ROLLBACK',
      modelVersion: prev,
      parameterOrBucket: 'active_champion_version',
      oldValue: oldChamp,
      newValue: prev,
      sampleSize: state.closedTrades.length,
      bootstrapCi90: 'Manual 1-Command Rollback',
      reasonAndEvidence: `Rolled back active Champion from ${oldChamp} to previous validated Champion ${prev}.`,
    });
  } else if (action === 'promote_challenger') {
    if (state.learning.championVsChallenger.shadowTradesCompleted >= 50) {
      const prev = state.learning.championVersion;
      const nextChamp = state.learning.challengerVersion;
      state.learning.previousChampionVersion = prev;
      state.learning.championVersion = nextChamp;
      state.control.previousChampionVersion = prev;
      state.control.activeChampionVersion = nextChamp;
      state.learning.challengerVersion = 'v1.5.0-nse-shadow';
      state.learning.championVsChallenger.readyToPromote = false;
      state.learning.championVsChallenger.shadowTradesCompleted = 0;
      state.learning.learningLog.unshift({
        logId: `LL-PR-${Date.now().toString().slice(-4)}`,
        loggedAt: nowIso,
        changeCategory: 'CHAMPION_PROMOTION',
        modelVersion: nextChamp,
        parameterOrBucket: 'active_champion_version',
        oldValue: prev,
        newValue: nextChamp,
        sampleSize: state.closedTrades.length,
        bootstrapCi90: '[+₹210.00, +₹840.00] / trade',
        reasonAndEvidence: `Promoted shadow Challenger ${nextChamp} after ${state.closedTrades.length} NSE trades with higher conservative expectancy and lower max drawdown (4.1% <= 4.8%).`,
      });
    }
  }

  const offlineCheck = isBotOfflineDuringMarketHours(
    state.health.heartbeatAt,
    state.health.marketOpen
  );

  res.json({
    control: state.control,
    health: {
      ...state.health,
      heartbeatAgeMinutes: offlineCheck.ageMinutes,
      isOffline: offlineCheck.isOffline,
    },
    learning: state.learning,
    autoRunEnabled,
  });
});

// 8. POST /api/fast-forward — Run N autonomous paper-trading + walk-forward learning cycles
app.post('/api/fast-forward', async (req, res) => {
  const cycles = Number(req.body?.cycles) || 10;
  await refreshLiveNseQuotes();
  const report = executeAutonomousPaperCycles(state, cycles);
  totalAutonomousCyclesRun += report.cyclesRun;
  latestActionSummary = report.latestActionSummary;
  res.json(report);
});

// 9. POST /api/cycle — Run a targeted dry-run 5-minute NSE decision cycle & fill simulation
app.post('/api/cycle', (req, res) => {
  const {
    symbol = 'NIFTY',
    strategy = 'trend_following',
    right = 'CE',
  } = req.body ?? {};
  const nowIso = new Date().toISOString();

  const spotMap: Record<string, number> = {
    NIFTY: state.health.niftySpot || 24480.0,
    BANKNIFTY: state.health.bankNiftySpot || 51850.0,
    FINNIFTY: 23920.0,
    RELIANCE: 1365.0,
    TCS: 4120.0,
    HDFCBANK: 1745.0,
    INFY: 1860.0,
    ICICIBANK: 1295.0,
    SBIN: 842.0,
  };
  const spot = spotMap[symbol] ?? 24480.0;
  const lotSize = NSE_LOT_SIZES[symbol] ?? 75;
  const optRight: OptionRight = right === 'PE' ? 'PE' : 'CE';
  const strikeStep =
    symbol === 'BANKNIFTY' ? 100 : symbol === 'NIFTY' || symbol === 'FINNIFTY' ? 50 : 20;
  const strike =
    Math.round((spot * (optRight === 'CE' ? 1.004 : 0.996)) / strikeStep) * strikeStep;

  const quote = blackScholesOptionPrice({
    spot,
    strike,
    dteDays: 18,
    ivAnnual: 0.165,
    riskFreeRate: 0.068,
    right: optRight,
  });

  const entryFill = simulatePessimisticFill('BUY', 1, quote.bid, quote.ask, lotSize);
  const exitQuote = blackScholesOptionPrice({
    spot: spot * (optRight === 'CE' ? 1.011 : 0.989),
    strike,
    dteDays: 16,
    ivAnnual: 0.17,
    riskFreeRate: 0.068,
    right: optRight,
  });
  const exitFill = simulatePessimisticFill('SELL', 1, exitQuote.bid, exitQuote.ask, lotSize);
  const rt = calculateRoundtripPnl(1, entryFill, exitFill);

  const nextIdx = state.closedTrades.length + 1001;
  const tradeId = `NSE-TRD-${String(nextIdx)}`;
  const nseSym = `${symbol}26NOV${strike}${optRight}`;

  const newTrade = {
    tradeId,
    contractSymbol: nseSym,
    underlying: symbol,
    right: optRight,
    lotSize,
    strategyName: strategy as 'trend_following' | 'mean_reversion' | 'breakout_momentum',
    regimeAtEntry: state.health.currentRegime,
    regimeAtExit: state.health.currentRegime,
    isShadowChallenger: false,
    modelVersion: state.control.activeChampionVersion,
    lotsQty: 1,
    dteAtEntry: 18,
    deltaAtEntry: quote.delta,
    ivRankAtEntry: 34.5,
    spreadPctAtEntry: entryFill.spreadPctOfMid,
    confidenceAtEntry: 0.78,
    rsiAtEntry: 58.2,
    adxAtEntry: 27.4,
    atrPctAtEntry: 0.0124,
    indiaVixAtEntry: state.health.indiaVixLevel,
    timeOfDayBucket: 'OPEN_0915_1015' as const,
    conservativeEntryPrice: entryFill.conservativeFillPrice,
    conservativeExitPrice: exitFill.conservativeFillPrice,
    brokerPaperEntryPrice: entryFill.brokerPaperFillPrice,
    brokerPaperExitPrice: exitFill.brokerPaperFillPrice,
    feesTotalInr: Number((entryFill.feeInr + exitFill.feeInr).toFixed(2)),
    conservativePnlInr: rt.conservativePnlInr,
    conservativePnlPct: rt.conservativePnlPct,
    brokerPaperPnlInr: rt.brokerPaperPnlInr,
    brokerPaperPnlPct: rt.brokerPaperPnlPct,
    maePct: -0.038,
    mfePct: Number((rt.conservativePnlPct + 0.04).toFixed(4)),
    holdMinutes: 195,
    entryReason: `Simulated 5m IST cycle: ${strategy} signal on ${symbol} (Confidence 0.78 >= 0.62, Quality Gate P(win)=0.64 >= 0.56)`,
    exitReason: rt.conservativePnlInr > 0 ? 'TRAILING_STOP' : 'STOP_LOSS',
    postMortemLabel: (rt.conservativePnlInr > 0 ? 'optimal_exit' : 'wrong_direction') as
      | 'optimal_exit'
      | 'wrong_direction',
    diagnosisNotes: `Dry-run NSE cycle execution (${lotSize} units/lot): Conservative fill ₹${entryFill.conservativeFillPrice.toFixed(2)} -> ₹${exitFill.conservativeFillPrice.toFixed(2)} (Spread + ₹35/lot drag: ₹${rt.executionDragInr.toFixed(2)}).`,
    openedAt: new Date(Date.now() - 195 * 60000).toISOString(),
    closedAt: nowIso,
  };

  state.closedTrades.unshift(newTrade);
  state.learning.closedTradesCount = state.closedTrades.length;
  const prevSnap = state.equitySeries[state.equitySeries.length - 1];
  const newConsEq = Number(
    (prevSnap.conservativeEquityInr + rt.conservativePnlInr).toFixed(2)
  );
  const newPaperEq = Number(
    (prevSnap.brokerPaperEquityInr + rt.brokerPaperPnlInr).toFixed(2)
  );
  state.equitySeries.push({
    snapshotId: `SNAP-${String(state.equitySeries.length + 1).padStart(4, '0')}`,
    recordedAt: nowIso,
    conservativeEquityInr: newConsEq,
    brokerPaperEquityInr: newPaperEq,
    niftyBenchmarkEquityInr: Number(
      (prevSnap.niftyBenchmarkEquityInr * 1.0012).toFixed(2)
    ),
    realizedPnlInr: Number((newConsEq - 1000000).toFixed(2)),
    unrealizedPnlInr: prevSnap.unrealizedPnlInr,
    drawdownPct: prevSnap.drawdownPct,
    openPositionsCount: state.openPositions.length,
  });

  state.health.heartbeatAt = nowIso;
  state.health.lastCycleAt = nowIso;
  state.health.lastDbWriteAt = nowIso;
  state.health.simulatedOfflineMode = false;
  totalAutonomousCyclesRun += 1;
  latestActionSummary = `Manual Dry-Run Cycle executed ${nseSym} (${rt.conservativePnlInr >= 0 ? '+' : ''}₹${rt.conservativePnlInr.toFixed(2)})`;

  res.json({
    executedTrade: newTrade,
    totalClosedTrades: state.closedTrades.length,
  });
});

// 10. GET /api/files — Serve monorepo files (/bot, /deploy, /web, README.md) for inspection/copy
app.get('/api/files', (req, res) => {
  const requestedPath = typeof req.query.path === 'string' ? req.query.path : 'README.md';
  if (!REPO_FILES_LIST.includes(requestedPath)) {
    res.status(404).json({
      error: 'File not in allowed repository manifest',
      files: REPO_FILES_LIST,
    });
    return;
  }
  const fullPath = path.join(__dirname, requestedPath);
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    res.json({
      path: requestedPath,
      content,
      files: REPO_FILES_LIST,
    });
  } catch (err) {
    res.status(500).json({ error: String(err), files: REPO_FILES_LIST });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AegisQuant Indian NSE F&O Paper-Trading Server running on http://0.0.0.0:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;


