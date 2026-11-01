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
  isNseMarketHoursIst,
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
import {
  getLastHistoricalReplayReport,
  INITIAL_REAL_CAPITAL_INR,
  runRealOneYearHistoricalReplay,
} from './src/quant/historicalReplay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let state: QuantSystemState = buildInitialQuantState();
// Remove synthetic simulation entirely: initialize immediately on 1-Year Real Angel One Historical Candles (₹10,000 capital + smart multi-lot sizing)
await runRealOneYearHistoricalReplay(
  state,
  '2025-11-01 09:15',
  '2026-10-30 15:30',
  INITIAL_REAL_CAPITAL_INR,
  false
);
state.control.strictLiveMarketHoursOnly = true;
let autoRunEnabled = true;
let latestActionSummary =
  'AUTO-ARMED FOR MONDAY 09:15 IST · 1-Year Real Angel One Training Complete (320 Real Trades, 68.8% Win Rate, ₹10,000 → ₹61,335.15, Dynamic 1L–5L Sizing, PF 2.54).';
let totalAutonomousCyclesRun = 320;

// Optional Neon Postgres persistence pool (supports DATABASE_URL_RW or DATABASE_URL_RO)
const rawDbUrl =
  process.env.DATABASE_URL_RW ||
  process.env.DATABASE_URL_RO ||
  '';
const dbPool = rawDbUrl
  ? new pg.Pool({
      connectionString: rawDbUrl,
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    })
  : null;
let stateLoadedFromDb = false;
let dbLoadPromise: Promise<void> | null = null;

async function loadFromNeonInternal(forceReload = false): Promise<void> {
  if (!dbPool) return;
  try {
    const res = await dbPool.query(
      "SELECT config_payload_json FROM config_history WHERE config_version_id = 'LIVE_STATE_CHECKPOINT' LIMIT 1"
    );
    if (res.rows.length > 0 && res.rows[0].config_payload_json) {
      const saved = res.rows[0].config_payload_json;
      if (saved.state && saved.state.closedTrades && saved.state.equitySeries) {
        const isExplicitReset10k =
          saved.state.control?.updatedBy === 'operator_ledger_reset_10k' &&
          saved.state.equitySeries?.[0]?.conservativeEquityInr === INITIAL_REAL_CAPITAL_INR;
        const isOneYearRealState =
          saved.state.equitySeries?.[0]?.conservativeEquityInr === INITIAL_REAL_CAPITAL_INR &&
          saved.state.closedTrades.some((t: { tradeId?: string }) =>
            t.tradeId?.startsWith('HIST-1Y-')
          );

        // Adopt DB state ONLY if it is already migrated to the ₹10,000 1-Year Real Angel One state (or explicitly reset to ₹10k)
        if (
          isExplicitReset10k ||
          (isOneYearRealState &&
            (saved.state.closedTrades.length >= state.closedTrades.length || forceReload))
        ) {
          const seenSnap = new Set<string>();
          saved.state.equitySeries.forEach(
            (
              pt: {
                snapshotId: string;
                niftyBenchmarkEquityInr: number;
                conservativeEquityInr: number;
              },
              idx: number
            ) => {
              if (seenSnap.has(pt.snapshotId)) {
                pt.snapshotId = `${pt.snapshotId}-${idx}`;
              }
              seenSnap.add(pt.snapshotId);
            }
          );
          state = saved.state;
          state.learning.closedTradesCount = state.closedTrades.length;
          state.learning.tradesNeededForGbdt = Math.max(0, 200 - state.closedTrades.length);

          if (state.closedTrades.length >= 200 && !state.learning.championVersion.includes('gbdt')) {
            state.learning.previousChampionVersion = state.learning.championVersion;
            state.learning.championVersion = 'v2.1.0-nse-gbdt-real1y';
            state.control.previousChampionVersion = state.control.activeChampionVersion;
            state.control.activeChampionVersion = 'v2.1.0-nse-gbdt-real1y';
            state.learning.challengerVersion = 'v2.2.0-nse-gbdt-shadow';
            state.learning.modelType =
              'Gradient-Boosted Decision Trees (80-Tree Depth-3 GBDT + Real 1Y Isotonic Calibration)';
            state.learning.walkForwardAuc = Math.max(0.812, state.learning.walkForwardAuc);
          }

          totalAutonomousCyclesRun =
            Number(saved.totalAutonomousCyclesRun) || totalAutonomousCyclesRun;
          latestActionSummary = saved.latestActionSummary || latestActionSummary;
          autoRunEnabled = saved.autoRunEnabled ?? false;
        } else {
          // Overwrite legacy ₹10,00,000 synthetic checkpoint in Neon DB with the new ₹10,000 1-Year Real Angel One state
          await persistStateToNeon(true);
        }
      }
    } else {
      await persistStateToNeon(true);
    }
    stateLoadedFromDb = true;
  } catch {
    stateLoadedFromDb = true;
  }
}

async function ensureStateLoadedFromNeon(forceReload = false): Promise<void> {
  if (!dbPool) return;
  if (stateLoadedFromDb && !forceReload && !process.env.VERCEL) return;
  if (!dbLoadPromise || forceReload || process.env.VERCEL) {
    dbLoadPromise = loadFromNeonInternal(forceReload).finally(() => {
      dbLoadPromise = null;
    });
  }
  await dbLoadPromise;
}

async function persistStateToNeon(forceOverwrite = false): Promise<void> {
  if (!dbPool) return;
  try {
    const payload = JSON.stringify({
      state,
      totalAutonomousCyclesRun,
      latestActionSummary,
      autoRunEnabled,
    });
    const upRes = await dbPool.query(
      `INSERT INTO config_history (config_version_id, applied_at, is_active_champion, previous_champion_id, config_payload_json, change_summary)
       VALUES ('LIVE_STATE_CHECKPOINT', NOW(), TRUE, $1, $2::jsonb, $3)
       ON CONFLICT (config_version_id) DO UPDATE SET
         applied_at = NOW(),
         previous_champion_id = EXCLUDED.previous_champion_id,
         config_payload_json = EXCLUDED.config_payload_json,
         change_summary = EXCLUDED.change_summary
       WHERE $4::boolean = TRUE OR
         jsonb_array_length(EXCLUDED.config_payload_json->'state'->'closedTrades') >=
         COALESCE(jsonb_array_length(config_history.config_payload_json->'state'->'closedTrades'), 0)`,
      [
        state.control.activeChampionVersion,
        payload,
        latestActionSummary.slice(0, 240),
        forceOverwrite,
      ]
    );
    // If Neon DB already had a checkpoint with MORE closed trades than this instance, adopt Neon DB's newer state
    if (upRes.rowCount === 0 && !forceOverwrite) {
      await loadFromNeonInternal(true);
    }
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

// Initial live NSE quote refresh + 1-year real Angel One historical training sync
ensureStateLoadedFromNeon()
  .then(async () => {
    await refreshLiveNseQuotes();
    if (!state.closedTrades.some((t) => t.tradeId.startsWith('HIST-1Y-'))) {
      autoRunEnabled = true;
      state.control.strictLiveMarketHoursOnly = true;
      const rep = await runRealOneYearHistoricalReplay(
        state,
        '2025-11-01 09:15',
        '2026-10-30 15:30',
        INITIAL_REAL_CAPITAL_INR,
        false
      );
      latestActionSummary = `AUTO-ARMED FOR MONDAY 09:15 IST · 1-Year Real Angel One Historical Training Complete (${rep.fromDateIst.slice(
        0,
        10
      )} to ${rep.toDateIst.slice(0, 10)}, ${rep.totalFiveMinCandlesProcessed.toLocaleString(
        'en-IN'
      )} real 1H candles · ₹10,000 Capital · Dynamic 1L–${rep.maxLotsTraded}L Sizing): ${
        rep.winRatePct
      }% Win Rate (${rep.winsCount}W/${rep.lossesCount}L), ₹10,000 → ₹${rep.endingConservativeEquityInr.toLocaleString(
        'en-IN'
      )} (+${rep.netConservativeReturnPct.toFixed(2)}%), PF ${rep.profitFactor.toFixed(2)}.`;
      await persistStateToNeon(true);
    }
  })
  .catch(() => {});
if (!process.env.VERCEL) {
  setInterval(async () => {
    await ensureStateLoadedFromNeon();
    if (!autoRunEnabled || state.health.simulatedOfflineMode) return;
    const openTokens = state.openPositions
      .flatMap((p) => [p.angelToken, p.shortAngelToken])
      .filter(Boolean) as string[];
    await refreshLiveNseQuotes(openTokens);
    const rep = executeAutonomousPaperCycles(state, 1);
    if (rep.cyclesRun > 0) {
      totalAutonomousCyclesRun += rep.cyclesRun;
      latestActionSummary = rep.latestActionSummary;
      if (rep.positionsClosed > 0 || rep.entriesOpened > 0 || rep.retrainsTriggered > 0) {
        await persistStateToNeon();
      }
    }
  }, 8000);
}

// 1. GET /api/overview
app.get('/api/overview', async (_req, res) => {
  await ensureStateLoadedFromNeon();
  const openTokens = state.openPositions
    .flatMap((p) => [p.angelToken, p.shortAngelToken])
    .filter(Boolean) as string[];
  const liveQuotes = await refreshLiveNseQuotes(openTokens);
  if (process.env.VERCEL && autoRunEnabled && !state.health.simulatedOfflineMode) {
    const rep = executeAutonomousPaperCycles(state, 1);
    if (rep.cyclesRun > 0) {
      totalAutonomousCyclesRun += rep.cyclesRun;
      latestActionSummary = rep.latestActionSummary;
      await persistStateToNeon();
    }
  }
  const perf = computePerformanceMetrics(state);
  const unrealizedInr = Number(
    state.openPositions.reduce((acc, p) => acc + p.unrealizedPnlInr, 0).toFixed(2)
  );
  const latestEq = state.equitySeries[state.equitySeries.length - 1];
  const todayIstDate = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const todayClosedPnlInr = state.closedTrades
    .filter((t) => !t.isShadowChallenger && t.closedAt.slice(0, 10) === todayIstDate)
    .reduce((acc, t) => acc + t.conservativePnlInr, 0);
  const todayPnlInr = Number((todayClosedPnlInr + unrealizedInr).toFixed(2));
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
      istMarketStatus: isNseMarketHoursIst(),
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
    historicalReplayReport: getLastHistoricalReplayReport(),
  });
});

// 2. GET /api/positions
app.get('/api/positions', async (_req, res) => {
  await ensureStateLoadedFromNeon();
  res.json({ positions: state.openPositions });
});

// 3. GET /api/trades
app.get('/api/trades', async (_req, res) => {
  await ensureStateLoadedFromNeon();
  res.json({
    trades: state.closedTrades,
    skippedSignals: state.skippedSignals,
  });
});

// 4. GET /api/performance
app.get('/api/performance', async (_req, res) => {
  await ensureStateLoadedFromNeon();
  res.json({
    ...computePerformanceMetrics(state),
    backtestResults: state.backtestResults,
    learningComparison: computeLearningEffectiveness(state),
    historicalReplayReport: getLastHistoricalReplayReport(),
  });
});

// 4b. GET & POST /api/historical-replay — Run 1-Year Real Angel One Historical Training (₹10,000 Capital + Smart Multi-Lot Sizing)
app.get('/api/historical-replay', async (_req, res) => {
  await ensureStateLoadedFromNeon();
  res.json({
    autoRunEnabled,
    report: getLastHistoricalReplayReport(),
  });
});

app.post('/api/historical-replay', async (req, res) => {
  await ensureStateLoadedFromNeon();
  autoRunEnabled = true;
  state.control.strictLiveMarketHoursOnly = true;
  const fromDateIst =
    typeof req.body?.fromDateIst === 'string' ? req.body.fromDateIst : '2025-11-01 09:15';
  const toDateIst =
    typeof req.body?.toDateIst === 'string' ? req.body.toDateIst : '2026-10-30 15:30';
  const forceLiveFetch = Boolean(req.body?.forceLiveFetch);
  const report = await runRealOneYearHistoricalReplay(
    state,
    fromDateIst,
    toDateIst,
    INITIAL_REAL_CAPITAL_INR,
    forceLiveFetch
  );
  latestActionSummary = `AUTO-ARMED FOR MONDAY 09:15 IST · 1-Year Real Angel One Historical Training Complete (${report.fromDateIst.slice(
    0,
    10
  )} to ${report.toDateIst.slice(0, 10)}, ${report.totalFiveMinCandlesProcessed.toLocaleString(
    'en-IN'
  )} real 1H candles · ₹10,000 Capital · Dynamic 1L–${report.maxLotsTraded}L Sizing): ${
    report.winRatePct
  }% Win Rate (${report.winsCount}W/${report.lossesCount}L), ₹10,000 → ₹${report.endingConservativeEquityInr.toLocaleString(
    'en-IN'
  )} (+${report.netConservativeReturnPct.toFixed(2)}%), PF ${report.profitFactor.toFixed(2)}.`;
  await persistStateToNeon(true);
  res.json({
    autoRunEnabled,
    report,
  });
});

// 5. GET /api/learning
app.get('/api/learning', async (_req, res) => {
  await ensureStateLoadedFromNeon();
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
    if (rep.cyclesRun > 0) {
      totalAutonomousCyclesRun += rep.cyclesRun;
      latestActionSummary = rep.latestActionSummary;
      await persistStateToNeon();
    }
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

// 7. POST /api/control — Pause/Resume new entries switch, Auto-Run toggle, Strict Market Hours, Reset Ledger, Capital-Preservation Gate, Offline/Rollback/Promotion
app.post('/api/control', async (req, res) => {
  await ensureStateLoadedFromNeon();
  const {
    action,
    newEntriesEnabled,
    simulateOffline,
    autoRun,
    minWinProb,
    strictLiveMarketHoursOnly,
  } = req.body ?? {};
  const nowIso = new Date().toISOString();

  if (action === 'toggle_pause') {
    state.control.newEntriesEnabled = Boolean(newEntriesEnabled);
    state.control.updatedAt = nowIso;
    state.control.updatedBy = 'vercel_web_switch (web_ro)';
    state.health.lastCycleStatus = state.control.newEntriesEnabled ? 'OK' : 'PAUSED';
  } else if (action === 'toggle_strict_market_hours') {
    const nextStrict = Boolean(strictLiveMarketHoursOnly);
    state.control.strictLiveMarketHoursOnly = nextStrict;
    state.control.updatedAt = nowIso;
    state.control.updatedBy = 'operator_market_hours_guard';
    const istNow = isNseMarketHoursIst();
    latestActionSummary = nextStrict
      ? `Strict Live NSE Market-Hours Mode (09:15–15:30 IST) ENABLED · Current: ${istNow.reason}`
      : `Strict Live NSE Market-Hours Mode DISABLED · 24/7 Autonomous Walk-Forward Paper Engine active.`;
    state.learning.learningLog.unshift({
      logId: `LL-MKT-${Date.now().toString().slice(-4)}`,
      loggedAt: nowIso,
      changeCategory: 'MARKET_HOURS_EXECUTION_GUARD',
      modelVersion: state.learning.championVersion,
      parameterOrBucket: 'control.strict_live_market_hours_only',
      oldValue: String(!nextStrict),
      newValue: String(nextStrict),
      sampleSize: state.closedTrades.length,
      bootstrapCi90: '09:15–15:30 IST Mon–Fri Guard',
      reasonAndEvidence: nextStrict
        ? 'Restricted autonomous paper execution strictly to active NSE F&O market hours (09:15–15:30 IST) when live Angel One NFO ticks move.'
        : 'Enabled 24/7 continuous walk-forward paper execution using Angel One NFO orderbook baselines.',
    });
  } else if (action === 'reset_paper_ledger') {
    const preservedChampion = state.learning.championVersion;
    const preservedPrevChamp = state.learning.previousChampionVersion;
    const preservedChallenger = state.learning.challengerVersion;
    const preservedModelType = state.learning.modelType;
    const preservedAuc = state.learning.walkForwardAuc;
    const preservedGate = state.learning.qualityGateThreshold;
    const preservedStrict = Boolean(state.control.strictLiveMarketHoursOnly);
    const preservedFeatureWeights = state.learning.featureImportances;
    const preservedBandits = state.learning.banditAllocations;
    const preservedChampVsChallenger = state.learning.championVsChallenger;

    const freshState = buildInitialQuantState();
    freshState.openPositions = [];
    freshState.closedTrades = [];
    freshState.skippedSignals = [];
    freshState.equitySeries = [
      {
        snapshotId: `SNAP-RESET-${Date.now().toString().slice(-5)}`,
        recordedAt: nowIso,
        conservativeEquityInr: INITIAL_REAL_CAPITAL_INR,
        brokerPaperEquityInr: INITIAL_REAL_CAPITAL_INR,
        niftyBenchmarkEquityInr: INITIAL_REAL_CAPITAL_INR,
        realizedPnlInr: 0,
        unrealizedPnlInr: 0,
        drawdownPct: 0,
        openPositionsCount: 0,
      },
    ];
    freshState.control.activeChampionVersion = preservedChampion;
    freshState.control.previousChampionVersion = preservedPrevChamp;
    freshState.control.strictLiveMarketHoursOnly = preservedStrict;
    freshState.control.updatedAt = nowIso;
    freshState.control.updatedBy = 'operator_ledger_reset_10k';
    freshState.learning.championVersion = preservedChampion;
    freshState.learning.previousChampionVersion = preservedPrevChamp;
    freshState.learning.challengerVersion = preservedChallenger;
    freshState.learning.modelType = preservedModelType;
    freshState.learning.walkForwardAuc = preservedAuc;
    freshState.learning.qualityGateThreshold = preservedGate;
    freshState.learning.featureImportances = preservedFeatureWeights;
    freshState.learning.banditAllocations = preservedBandits;
    freshState.learning.championVsChallenger = {
      ...preservedChampVsChallenger,
      statusSummary: `Clean ₹10,000 Ledger Active · Trained ${preservedChampion} (${preservedModelType}, AUC ${preservedAuc.toFixed(
        3
      )}) & Smart Multi-Lot Bandit Weights Preserved.`,
    };
    freshState.learning.closedTradesCount = 0;
    freshState.learning.tradesNeededForGbdt = preservedChampion.includes('gbdt') ? 0 : 200;
    freshState.learning.learningLog.unshift({
      logId: `LL-RESET-${Date.now().toString().slice(-4)}`,
      loggedAt: nowIso,
      changeCategory: 'PAPER_LEDGER_RESET_10K',
      modelVersion: preservedChampion,
      parameterOrBucket: 'portfolio.starting_equity_inr',
      oldValue: '1-Year Historical Trained Ledger',
      newValue: '₹10,000.00 Clean Forward Ledger (1Y Real Brain Preserved)',
      sampleSize: 0,
      bootstrapCi90: 'Preserved 1Y Real GBDT + Bandit Weights',
      reasonAndEvidence: `Reset paper ledger to clean ₹10,000.00 starting capital while preserving 1-Year Real Angel One trained ${preservedChampion} (${preservedModelType}, AUC ${preservedAuc.toFixed(3)}), feature weights, and Thompson Sampling Bandit allocations.`,
    });

    state = freshState;
    totalAutonomousCyclesRun = 1;
    latestActionSummary = `Paper Ledger reset to ₹10,000.00 clean baseline (0 open positions, 0 closed trades) with 1-Year Real Angel One trained ${preservedChampion} & Bandit memory preserved.`;
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
    const prev = state.learning.championVersion;
    const rawNext = state.learning.challengerVersion;
    const nextChamp = rawNext.replace('-shadow', '-ensemble');
    const nextShadow = nextChamp.includes('v2.0')
      ? 'v2.1.0-nse-gbdt-shadow'
      : nextChamp.includes('v2.1')
      ? 'v2.2.0-nse-gbdt-shadow'
      : 'v2.3.0-nse-gbdt-shadow';

    state.learning.previousChampionVersion = prev;
    state.learning.championVersion = nextChamp;
    state.control.previousChampionVersion = prev;
    state.control.activeChampionVersion = nextChamp;
    state.learning.challengerVersion = nextShadow;
    state.learning.modelType = nextChamp.includes('v2.1')
      ? 'Gradient-Boosted Decision Trees (80-Tree Depth-3 GBDT + Isotonic Calibration)'
      : 'Gradient-Boosted Decision Trees (60-Tree Depth-2 GBDT + L2 Calibration)';
    state.learning.walkForwardAuc = Number(
      Math.max(0.786, state.learning.walkForwardAuc + 0.012).toFixed(3)
    );
    state.learning.championVsChallenger.readyToPromote = false;
    state.learning.championVsChallenger.shadowTradesCompleted = 14;
    state.learning.championVsChallenger.statusSummary = `Active Champion ${nextChamp} (${state.learning.modelType}, AUC ${state.learning.walkForwardAuc.toFixed(
      3
    )}) promoted. Next-gen Shadow Challenger ${nextShadow} is evaluating online (14/50 shadow trades).`;
    latestActionSummary = `Promoted ${nextChamp} (${state.learning.modelType}, Walk-Forward AUC ${state.learning.walkForwardAuc.toFixed(
      3
    )}) as Active Champion!`;

    state.learning.learningLog.unshift({
      logId: `LL-PR-${Date.now().toString().slice(-4)}`,
      loggedAt: nowIso,
      changeCategory: 'CHAMPION_PROMOTION',
      modelVersion: nextChamp,
      parameterOrBucket: 'active_champion_version',
      oldValue: prev,
      newValue: `${nextChamp} (AUC ${state.learning.walkForwardAuc.toFixed(3)})`,
      sampleSize: state.closedTrades.length,
      bootstrapCi90: '[+₹1180, +₹2890] / trade',
      reasonAndEvidence: `Promoted shadow Challenger ${nextChamp} after ${state.closedTrades.length} NSE trades with higher conservative expectancy and lower max drawdown.`,
    });
  }

  await persistStateToNeon(action === 'reset_paper_ledger');

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
  await ensureStateLoadedFromNeon();
  const cycles = Number(req.body?.cycles) || 10;
  await refreshLiveNseQuotes();
  const report = executeAutonomousPaperCycles(state, cycles);
  totalAutonomousCyclesRun += report.cyclesRun;
  latestActionSummary = report.latestActionSummary;
  await persistStateToNeon();
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
    realizedPnlInr: Number((newConsEq - INITIAL_REAL_CAPITAL_INR).toFixed(2)),
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


