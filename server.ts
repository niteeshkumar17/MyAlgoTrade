import dotenv from 'dotenv';
dotenv.config({ override: true });

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAngelSessionStore, type SharedAngelSession } from './src/quant/angelOneSmartApi.js';
import { angelMarketData } from './src/quant/marketData.js';
import {
  mutateLedger,
  readActiveLedger,
  readJournal,
  refreshLiveState,
  resetPaperLedger,
  runPaperCycle,
} from './src/quant/paperEngine.js';
import { buildDashboard } from './src/quant/report.js';
import { getOfflineResearch } from './src/quant/research.js';
import { createStore, databaseConfigured, KEY_ANGEL_SESSION } from './src/quant/store.js';
import { loadTerminalCandles, type TerminalInterval } from './src/quant/terminalCandles.js';
import type { OptionRight } from './src/quant/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '32kb' }));

const store = createStore();
registerAngelSessionStore({
  async get() {
    const row = await store.get<SharedAngelSession>(KEY_ANGEL_SESSION);
    return row ? row.data : null;
  },
  async set(session) {
    const existing = await store.get<SharedAngelSession>(KEY_ANGEL_SESSION);
    const saved = await store.put(KEY_ANGEL_SESSION, session, existing ? existing.rev : null);
    if (!saved.ok) {
      const retry = await store.get<SharedAngelSession>(KEY_ANGEL_SESSION);
      await store.put(KEY_ANGEL_SESSION, session, retry ? retry.rev : null);
    }
  },
});
const market = angelMarketData();

function adminSecret(): string {
  return (process.env.ADMIN_SECRET || process.env.DASHBOARD_PASSCODE || '').trim();
}

function authorized(req: express.Request): boolean {
  const secret = adminSecret();
  return Boolean(secret) && req.header('x-admin-secret') === secret;
}

app.get('/api/paper/ledger', async (_req, res) => {
  try {
    const state = await readActiveLedger(store);
    if (!state) {
      res.status(404).json({ error: 'No active ledger found' });
      return;
    }
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Could not read ledger' });
  }
});

app.get('/api/state', async (req, res) => {
  try {
    const useLive = req.query.live !== '0';
    const state = useLive ? await refreshLiveState(store, market) : await readActiveLedger(store);
    if (!state) {
      res.json({ ledger: null, persistent: databaseConfigured(), generatedAt: new Date().toISOString() });
      return;
    }
    res.json({ ...buildDashboard(state), persistent: databaseConfigured(), ledger: state.ledgerId });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Could not read the ledger' });
  }
});

app.get('/api/journal', async (req, res) => {
  try {
    const state = await readActiveLedger(store);
    if (!state) {
      res.json({ rows: [] });
      return;
    }
    const kind = req.query.kind === 'candidates' ? 'candidates' : 'trades';
    const month = typeof req.query.month === 'string' ? req.query.month : undefined;
    const rows = await readJournal(store, state.ledgerId, kind, month);
    res.json({ ledgerId: state.ledgerId, kind, rows });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Could not read the journal' });
  }
});

app.get('/api/research', (_req, res) => {
  try {
    const research = getOfflineResearch();
    if (!research) {
      res.status(404).json({ error: 'The one-year hourly cache is not available on this server.' });
      return;
    }
    res.json(research.report);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Research failed' });
  }
});

app.get('/api/candles', async (req, res) => {
  try {
    const underlying = typeof req.query.underlying === 'string' ? req.query.underlying : 'NIFTY';
    const rawInterval = typeof req.query.interval === 'string' ? req.query.interval : '1m';
    const interval: TerminalInterval =
      rawInterval === '1m' || rawInterval === '5m' || rawInterval === '15m' || rawInterval === '1h'
        ? rawInterval
        : '1m';
    const exchange = req.query.exchange === 'NFO' ? 'NFO' : 'NSE';
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    const strike = req.query.strike ? Number(req.query.strike) : undefined;
    const right: OptionRight | undefined = req.query.right === 'PE' ? 'PE' : req.query.right === 'CE' ? 'CE' : undefined;
    const expiry = typeof req.query.expiry === 'string' ? req.query.expiry : undefined;
    const shortToken = typeof req.query.shortToken === 'string' ? req.query.shortToken : undefined;
    const shortStrike = req.query.shortStrike ? Number(req.query.shortStrike) : undefined;
    const liveBid = req.query.liveBid ? Number(req.query.liveBid) : undefined;
    const liveAsk = req.query.liveAsk ? Number(req.query.liveAsk) : undefined;
    const shortBid = req.query.shortBid ? Number(req.query.shortBid) : undefined;
    const shortAsk = req.query.shortAsk ? Number(req.query.shortAsk) : undefined;

    const payload = await loadTerminalCandles({
      underlying,
      interval,
      exchange,
      token,
      strike,
      right,
      expiry,
      shortToken,
      shortStrike,
      liveBid,
      liveAsk,
      shortBid,
      shortAsk,
    });
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Candle fetch failed' });
  }
});

app.get('/api/tick', async (req, res) => {
  try {
    const force = req.query.eod === '1';
    const cycle = await runPaperCycle(store, market, { force });
    res.json({ ok: true, persistent: databaseConfigured(), cycle });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Cycle failed' });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    const cycle = await runPaperCycle(store, market, {});
    const state = await readActiveLedger(store);
    res.json({
      ok: true,
      persistent: databaseConfigured(),
      ledgerId: state?.ledgerId ?? null,
      equity: state?.lastEquity ?? null,
      lastCycle: state?.lastCycle ?? null,
      cycle,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Health check failed' });
  }
});

app.post('/api/admin', async (req, res) => {
  if (!adminSecret()) {
    res.status(503).json({ error: 'Set ADMIN_SECRET (or DASHBOARD_PASSCODE) before changing the ledger.' });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ error: 'Admin secret was missing or wrong.' });
    return;
  }
  const action = String(req.body?.action ?? '');
  const now = new Date().toISOString();
  try {
    if (action === 'reset_ledger') {
      const result = await resetPaperLedger(store, Date.now());
      if (!result.ok) {
        res.status(409).json({ error: result.error });
        return;
      }
      res.json({ ok: true, ledgerId: result.state.ledgerId, equity: result.state.lastEquity });
      return;
    }
    const result = await mutateLedger(store, Date.now(), (state) => {
      if (action === 'pause') {
        state.control = { entriesEnabled: false, updatedAt: now, updatedBy: 'admin' };
        state.decisionLog.unshift({ t: now, kind: 'ADMIN', message: 'New entries paused. Open positions are still managed.' });
      } else if (action === 'resume') {
        state.control = { entriesEnabled: true, updatedAt: now, updatedBy: 'admin' };
        state.decisionLog.unshift({ t: now, kind: 'ADMIN', message: 'New entries resumed.' });
      } else if (action === 'ack_kill_switch') {
        state.killSwitch = { active: false, reason: null, at: null };
        state.peakEquity = state.lastEquity;
        state.control = { entriesEnabled: true, updatedAt: now, updatedBy: 'admin' };
        state.decisionLog.unshift({
          t: now,
          kind: 'ADMIN',
          message: 'Drawdown kill switch acknowledged. The peak was reset to current equity.',
        });
      } else if (action === 'retrain') {
        state.liveLabelsAtLastTrain = -1_000_000;
        state.learningLog.unshift({ t: now, kind: 'MODEL', message: 'Retrain requested. It runs on the next cycle.' });
      } else {
        throw new Error('Unknown action');
      }
    });
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json({ ok: true, ledgerId: result.state.ledgerId });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Admin action failed' });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Paper-training server on http://0.0.0.0:${port}`);
  });
}

if (!process.env.VERCEL) startServer();

export default app;
