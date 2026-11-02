import React, { useCallback, useEffect, useState } from 'react';
import { EquityCurveChart } from './components/EquityCurveChart';
import { formatInr, formatIst, formatPct, formatSigned } from './quant/format';
import type { DashboardPayload } from './quant/report';
import type { GroupStat } from './quant/stats';
import type { Candidate, ClosedTrade, PaperPosition } from './quant/types';

interface ResearchView {
  disclaimer: string;
  summary: { n: number; winRate: number | null; avgR: number | null; rCi90: [number, number] | null };
  oppositeDirectionBaseline: { n: number; avgR: number | null };
  portfolio: {
    startingCapitalInr: number;
    endingEquityInr: number;
    returnPct: number;
    maxDrawdownPct: number;
    taken: number;
    skipped: number;
  };
  byStrategy: GroupStat[];
}

type Tab = 'overview' | 'book' | 'performance' | 'learning' | 'rules';
type StateResponse = DashboardPayload & { persistent?: boolean; ledger?: string | null };

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'book', label: 'Positions & trades' },
  { id: 'performance', label: 'Performance' },
  { id: 'learning', label: 'Learning' },
  { id: 'rules', label: 'How it works' },
];

function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return 'text-slate-300';
  return n > 0 ? 'text-emerald-400' : 'text-rose-400';
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

function ScoreTable({ title, rows, money }: { title: string; rows: GroupStat[]; money: string }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">No {title.toLowerCase()} yet.</p>;
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-slate-300">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-2 pr-3">Group</th>
              <th className="py-2 pr-3">N</th>
              <th className="py-2 pr-3">Win</th>
              <th className="py-2 pr-3">Avg R</th>
              <th className="py-2">{money}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-slate-800">
                <td className="py-2 pr-3">{row.key}</td>
                <td className="py-2 pr-3 tabular-nums">{row.n}</td>
                <td className="py-2 pr-3 tabular-nums">{row.winRate === null ? '—' : formatPct(row.winRate * 100)}</td>
                <td className={`py-2 pr-3 tabular-nums ${pnlClass(row.avgR)}`}>{formatSigned(row.avgR, 3)}</td>
                <td className={`py-2 tabular-nums ${pnlClass(row.netPnlInr)}`}>{formatInr(row.netPnlInr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [state, setState] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trades, setTrades] = useState<ClosedTrade[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [research, setResearch] = useState<ResearchView | null>(null);
  const [secret, setSecret] = useState(() => localStorage.getItem('paper-admin-secret') ?? '');
  const [adminNote, setAdminNote] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'State request failed');
      setState(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load state');
    }
  }, []);

  useEffect(() => {
    void loadState();
    const poll = setInterval(() => void loadState(), 15_000);
    const tick = setInterval(() => {
      void fetch('/api/tick').finally(() => void loadState());
    }, 60_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [loadState]);

  useEffect(() => {
    if (tab !== 'book' && tab !== 'performance') return;
    void fetch('/api/journal?kind=trades')
      .then((r) => r.json())
      .then((b) => setTrades(b.rows ?? []))
      .catch(() => setTrades([]));
    void fetch('/api/journal?kind=candidates')
      .then((r) => r.json())
      .then((b) => setCandidates(b.rows ?? []))
      .catch(() => setCandidates([]));
  }, [tab, state?.counters.tradesClosed, state?.counters.candidatesClosed]);

  useEffect(() => {
    if (tab !== 'performance' || research) return;
    void fetch('/api/research')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setResearch(b))
      .catch(() => setResearch(null));
  }, [tab, research]);

  async function admin(action: string) {
    if (action === 'reset_ledger' && !window.confirm('Start a new ₹50,000 ledger? The old one stays in the database but is no longer active.')) return;
    localStorage.setItem('paper-admin-secret', secret);
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
      body: JSON.stringify({ action }),
    });
    const body = await res.json();
    setAdminNote(res.ok ? `Saved (${body.ledgerId ?? 'ok'})` : body.error || 'Rejected');
    await loadState();
  }

  const dash = state && state.ledgerId ? state : null;

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-4 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-sky-400">Paper training only</p>
          <h1 className="text-2xl font-semibold">NSE debit-spread paper ledger</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Fills use the live bid and ask. No broker order is sent from this site. Real money is a later decision, and only after the checklist passes.
          </p>
        </div>
        <div className="text-right text-xs text-slate-500">
          <div>{dash ? formatIst(dash.generatedAt) : '—'}</div>
          <div>{state?.persistent ? 'Saved in Postgres' : 'Not connected to a database'}</div>
        </div>
      </header>

      <div className="mb-4 rounded-xl border border-amber-700/40 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
        The previous ledger mixed in fabricated trades. This one starts at {formatInr(dash?.startingCapitalInr ?? 50_000)} and records only what the live order book can support.
        {dash && !dash.control.entriesEnabled ? ' New entries are paused.' : ''}
        {dash?.killSwitch.active ? ` Kill switch: ${dash.killSwitch.reason}` : ''}
        {dash?.dailyHalt ? ' Daily loss limit is active until the next session.' : ''}
      </div>
      {error ? <p className="mb-4 text-sm text-rose-400">{error}</p> : null}

      <nav className="mb-5 flex flex-wrap gap-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`rounded-full px-3 py-1.5 text-sm ${tab === item.id ? 'bg-sky-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {!dash ? (
        <p className="text-sm text-slate-400">No ledger yet. The first visit to /api/tick creates a ₹50,000 paper ledger.</p>
      ) : tab === 'overview' ? (
        <Overview dash={dash} />
      ) : tab === 'book' ? (
        <Book positions={dash.openPositions} candidates={dash.activeCandidates} closedCandidates={candidates} trades={trades} />
      ) : tab === 'performance' ? (
        <Performance dash={dash} research={research} />
      ) : tab === 'learning' ? (
        <Learning dash={dash} />
      ) : (
        <Rules dash={dash} secret={secret} setSecret={setSecret} adminNote={adminNote} onAdmin={admin} />
      )}
    </div>
  );
}

function Overview({ dash }: { dash: DashboardPayload }) {
  const spots = dash.market?.spots ?? {};
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Equity at bid/ask" value={formatInr(dash.equity)} sub={`Cash ${formatInr(dash.cash)}`} />
        <Stat label="Today" value={formatInr(dash.dayPnlInr)} sub={`Realized ${formatInr(dash.realizedPnlInr)}`} />
        <Stat label="Max drawdown" value={formatPct(dash.maxDrawdownPct, 2)} sub={`Peak ${formatInr(dash.peakEquity)}`} />
        <Stat label="Open / closed" value={`${dash.openPositions.length} / ${dash.counters.tradesClosed}`} sub={`${dash.counters.candidatesCreated} candidates tracked`} />
      </div>
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <EquityCurveChart data={dash.recentEquity} />
      </section>
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 p-4">
          <h2 className="mb-2 text-sm font-medium">Market</h2>
          <p className="text-sm text-slate-300">{dash.market ? (dash.market.live ? 'Live feed' : 'Not live') : dash.lastCycle ? 'No live quote this cycle' : 'No cycle yet'} — {dash.market?.liveReason ?? dash.lastCycle?.summary ?? 'waiting'}</p>
          <p className="mt-1 text-xs text-slate-500">Last cycle: {dash.lastCycle ? `${dash.lastCycle.status} · ${dash.lastCycle.summary}` : 'none'}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            {Object.values(spots).map((q) => (
              <div key={q.symbol} className="flex justify-between rounded-lg bg-slate-950 px-2 py-1">
                <span>{q.symbol}</span>
                <span className="tabular-nums">{q.ltp.toLocaleString('en-IN')}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 p-4">
          <h2 className="mb-2 text-sm font-medium">Real-money checklist</h2>
          <ul className="space-y-1 text-sm">
            {dash.readiness.checks.map((c) => (
              <li key={c.id} className="flex justify-between gap-3">
                <span className={c.pass ? 'text-emerald-400' : 'text-slate-400'}>{c.pass ? 'Pass' : 'Not yet'} · {c.label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">{dash.readiness.note}</p>
        </div>
      </section>
      <LogList title="Recent decisions" rows={dash.decisionLog.slice(0, 12)} />
    </div>
  );
}

function Book({
  positions,
  candidates,
  closedCandidates,
  trades,
}: {
  positions: PaperPosition[];
  candidates: Candidate[];
  closedCandidates: Candidate[];
  trades: ClosedTrade[];
}) {
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-medium">Open paper positions</h2>
        {positions.length === 0 ? <p className="text-sm text-slate-500">None.</p> : (
          <div className="overflow-x-auto text-sm">
            <table className="w-full text-left">
              <thead className="text-xs uppercase text-slate-500"><tr><th>Opened</th><th>Contract</th><th>Lots</th><th>Debit</th><th>Now</th><th>Unrealized</th></tr></thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id} className="border-t border-slate-800">
                    <td className="py-2 pr-3">{formatIst(p.openedAt)}</td>
                    <td className="py-2 pr-3">{p.underlying} {p.direction} {p.plan.long.strike}/{p.plan.short.strike}</td>
                    <td className="py-2 pr-3">{p.lots}</td>
                    <td className="py-2 pr-3 tabular-nums">{p.plan.entryDebit.toFixed(2)}</td>
                    <td className="py-2 pr-3 tabular-nums">{p.lastMark ? p.lastMark.liquidationValue.toFixed(2) : '—'}</td>
                    <td className={`py-2 tabular-nums ${pnlClass(p.unrealizedInr)}`}>{formatInr(p.unrealizedInr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section>
        <h2 className="mb-2 text-sm font-medium">Closed paper trades</h2>
        <TradeTable trades={trades} />
      </section>
      <section>
        <h2 className="mb-2 text-sm font-medium">Candidates being tracked</h2>
        <p className="mb-2 text-xs text-slate-500">Every priced signal is followed to its exit, including the ones the ledger skipped. Those outcomes train the model.</p>
        <CandidateTable rows={[...candidates, ...closedCandidates].slice(0, 40)} />
      </section>
    </div>
  );
}

function TradeTable({ trades }: { trades: ClosedTrade[] }) {
  if (trades.length === 0) return <p className="text-sm text-slate-500">No closed trades on this ledger.</p>;
  return (
    <div className="overflow-x-auto text-sm">
      <table className="w-full text-left">
        <thead className="text-xs uppercase text-slate-500"><tr><th>Closed</th><th>Setup</th><th>Exit</th><th>Net</th><th>R</th></tr></thead>
        <tbody>
          {trades.slice(0, 50).map((t) => (
            <tr key={t.id} className="border-t border-slate-800">
              <td className="py-2 pr-3">{formatIst(t.closedAt)}</td>
              <td className="py-2 pr-3">{t.underlying} {t.strategy} {t.direction}</td>
              <td className="py-2 pr-3">{t.exitReason}</td>
              <td className={`py-2 pr-3 tabular-nums ${pnlClass(t.netPnlInr)}`}>{formatInr(t.netPnlInr)}</td>
              <td className={`py-2 tabular-nums ${pnlClass(t.rMultiple)}`}>{formatSigned(t.rMultiple, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CandidateTable({ rows }: { rows: Candidate[] }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">None yet.</p>;
  return (
    <div className="overflow-x-auto text-sm">
      <table className="w-full text-left">
        <thead className="text-xs uppercase text-slate-500"><tr><th>When</th><th>Signal</th><th>Ledger</th><th>₹/lot</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="border-t border-slate-800">
              <td className="py-2 pr-3">{formatIst(c.createdAt)}</td>
              <td className="py-2 pr-3">{c.underlying} {c.strategy} {c.direction}</td>
              <td className="py-2 pr-3">{c.takenByLedger ? 'Taken' : c.skipReason || 'Skipped'}</td>
              <td className={`py-2 tabular-nums ${pnlClass(c.pnlPerLotInr)}`}>{c.pnlPerLotInr === undefined ? 'Open' : formatInr(c.pnlPerLotInr)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Performance({ dash, research }: { dash: DashboardPayload; research: ResearchView | null }) {
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-sm font-medium">This paper ledger</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <ScoreTable title="By strategy" rows={dash.tradeScorecards.byStrategy} money="Net ₹" />
          <ScoreTable title="By underlying" rows={dash.tradeScorecards.byUnderlying} money="Net ₹" />
          <ScoreTable title="By regime" rows={dash.tradeScorecards.byRegime} money="Net ₹" />
          <ScoreTable title="By exit" rows={dash.tradeScorecards.byExit} money="Net ₹" />
        </div>
        <h3 className="text-sm font-medium text-slate-300">Shadow candidates, per lot</h3>
        <ScoreTable title="Candidate strategies" rows={dash.candidateScorecards.byStrategy} money="₹/lot" />
      </section>
      <section className="space-y-3 rounded-xl border border-slate-800 p-4">
        <h2 className="text-sm font-medium">One-year research on real hourly prices</h2>
        {!research ? <p className="text-sm text-slate-500">Research report is not loaded.</p> : (
          <>
            <p className="text-sm text-amber-100/90">{research.disclaimer}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Model-priced trades" value={String(research.summary.n)} sub={research.summary.winRate === null ? undefined : `${formatPct(research.summary.winRate * 100)} winners`} />
              <Stat label="Average R" value={formatSigned(research.summary.avgR, 3)} sub={research.summary.rCi90 ? `90% CI ${research.summary.rCi90.map((x) => x.toFixed(3)).join(' to ')}` : undefined} />
              <Stat label="Same signals, opposite direction" value={formatSigned(research.oppositeDirectionBaseline.avgR, 3)} sub={`${research.oppositeDirectionBaseline.n} trades`} />
            </div>
            <p className="text-sm text-slate-400">
              A ₹{research.portfolio.startingCapitalInr.toLocaleString('en-IN')} replay of these model-priced trades ended at {formatInr(research.portfolio.endingEquityInr)} ({formatSigned(research.portfolio.returnPct, 1)}%), max drawdown {formatPct(research.portfolio.maxDrawdownPct, 1)}. It took {research.portfolio.taken} trades and skipped {research.portfolio.skipped}.
            </p>
            <ScoreTable title="Research by strategy" rows={research.byStrategy} money="₹/lot" />
          </>
        )}
      </section>
    </div>
  );
}

function Learning({ dash }: { dash: DashboardPayload }) {
  const model = dash.model;
  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-800 p-4">
        <h2 className="text-sm font-medium">Gate</h2>
        {model ? (
          <>
            <p className="mt-2 text-sm text-slate-200">{model.gate.reason}</p>
            <p className="mt-2 text-xs text-slate-500">
              Trained {formatIst(model.trainedAt)} on {model.nOffline} offline samples (weight {model.offlineWeight}) and {model.nLive} live samples. Version {model.version}.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Stat label="Offline out-of-sample AUC" value={model.offlineOos.auc === null ? '—' : model.offlineOos.auc.toFixed(3)} sub={`${model.offlineOos.n} predictions`} />
              <Stat label="Live out-of-sample AUC" value={model.liveOos.auc === null ? '—' : model.liveOos.auc.toFixed(3)} sub={`${model.liveOos.n} predictions`} />
            </div>
          </>
        ) : <p className="mt-2 text-sm text-slate-500">The model has not been fit yet. The next live cycle fits it from the one-year research sample.</p>}
        {dash.suspendedStrategies.length > 0 ? (
          <p className="mt-3 text-sm text-rose-300">Suspended after live losses: {dash.suspendedStrategies.join(', ')}</p>
        ) : <p className="mt-3 text-sm text-slate-500">No strategy is suspended. Suspension needs 40 live samples and a negative 90% upper bound on average R.</p>}
      </section>
      {model && model.calibration.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-medium">Calibration</h2>
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500"><tr><th>Predicted</th><th>Actual win rate</th><th>N</th></tr></thead>
            <tbody>
              {model.calibration.map((b) => (
                <tr key={`${b.lo}-${b.hi}`} className="border-t border-slate-800">
                  <td className="py-2">{formatPct(b.avgPred * 100)}</td>
                  <td className="py-2">{formatPct(b.winRate * 100)}</td>
                  <td className="py-2">{b.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {model ? (
        <section>
          <h2 className="mb-2 text-sm font-medium">Feature weights</h2>
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {model.featureNames.map((name, i) => (
              <li key={name} className="flex justify-between rounded bg-slate-900 px-2 py-1">
                <span>{name}</span>
                <span className="tabular-nums">{model.weights[i]?.toFixed(3)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <LogList title="Learning log" rows={dash.learningLog} />
      <section className="rounded-xl border border-slate-800 p-4 text-sm text-slate-400">
        <h2 className="mb-2 font-medium text-slate-200">Data health</h2>
        <p>Angel One configured: {dash.angel?.configured ? 'yes' : 'no'}. Last quote {formatIst(dash.angel?.lastQuoteFetchAt)}. Instruments as of {dash.instrumentsAsOf ?? '—'}. Quote errors {dash.counters.dataErrors}. Stale marks {dash.counters.staleMarks}.</p>
        {dash.angel?.lastError ? <p className="mt-1 text-rose-300">{dash.angel.lastError}</p> : null}
      </section>
    </div>
  );
}

function Rules({
  dash,
  secret,
  setSecret,
  adminNote,
  onAdmin,
}: {
  dash: DashboardPayload;
  secret: string;
  setSecret: (v: string) => void;
  adminNote: string | null;
  onAdmin: (action: string) => void;
}) {
  const cfg = dash.config;
  return (
    <div className="space-y-5 text-sm leading-6 text-slate-300">
      <section className="rounded-xl border border-slate-800 p-4">
        <h2 className="mb-2 font-medium text-slate-100">What is real</h2>
        <p>Spot and option prices come from Angel One. A debit spread is bought at the ask and sold at the bid, and the reverse on the way out. Brokerage is ₹20 per order plus STT, exchange fees, stamp duty and GST. If the book has no bid or no ask, the trade is not priced and is not invented.</p>
        <p className="mt-2">Signals use completed hourly bars: a Donchian breakout, a trend pullback to the 20-bar average, or a return inside the Bollinger band while the market is ranging. One signal per bar. New entries only from 09:30 to 15:00 IST, with 7 to 35 days to expiry.</p>
        <p className="mt-2">Exits: take profit at {formatPct(cfg.takeProfitFracOfMaxGain * 100, 0)} of the maximum gain, stop at {formatPct(cfg.stopLossFracOfDebit * 100, 0)} of the debit, leave after {cfg.maxHoldSessions} sessions, or when {cfg.exitAtDte} days remain.</p>
      </section>
      <section className="rounded-xl border border-slate-800 p-4">
        <h2 className="mb-2 font-medium text-slate-100">Risk limits on the ₹{dash.startingCapitalInr.toLocaleString('en-IN')} ledger</h2>
        <p>{formatPct(cfg.riskPerTradePct * 100, 0)} of equity at risk per trade, at most {cfg.maxOpenPositions} positions, {formatPct(cfg.maxOpenRiskPct * 100, 0)} open risk, one position per underlying, a {formatPct(cfg.dailyLossHaltPct * 100, 0)} daily halt and a {formatPct(cfg.drawdownKillPct * 100, 0)} drawdown kill switch.</p>
      </section>
      <section className="rounded-xl border border-slate-800 p-4">
        <h2 className="mb-2 font-medium text-slate-100">Before any real money</h2>
        <p>Passing the checklist is required and it is not sufficient. Retail algo orders in India need a broker-registered strategy and a static IP approved with the exchange. This Vercel deployment does not have a static IP, so live orders cannot be added here. That would be a separate process on a VM, after this paper ledger has earned it. This site will keep paper-trading either way.</p>
        <ul className="mt-3 space-y-1">
          {dash.readiness.checks.map((c) => (
            <li key={c.id}>{c.pass ? 'Pass' : 'Not yet'} — {c.label}. {c.detail}</li>
          ))}
        </ul>
      </section>
      <section className="rounded-xl border border-slate-800 p-4">
        <h2 className="mb-2 font-medium text-slate-100">Controls</h2>
        <p className="mb-2 text-slate-400">The secret is ADMIN_SECRET, or DASHBOARD_PASSCODE if that is the one set on the server. It stays in this browser only.</p>
        <input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" placeholder="Admin secret" className="mb-3 w-full max-w-sm rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" />
        <div className="flex flex-wrap gap-2">
          <button type="button" className="rounded-lg bg-slate-800 px-3 py-1.5" onClick={() => onAdmin('pause')}>Pause entries</button>
          <button type="button" className="rounded-lg bg-slate-800 px-3 py-1.5" onClick={() => onAdmin('resume')}>Resume entries</button>
          <button type="button" className="rounded-lg bg-slate-800 px-3 py-1.5" onClick={() => onAdmin('retrain')}>Retrain next cycle</button>
          <button type="button" className="rounded-lg bg-slate-800 px-3 py-1.5" onClick={() => onAdmin('ack_kill_switch')}>Acknowledge kill switch</button>
          <button type="button" className="rounded-lg bg-rose-900 px-3 py-1.5" onClick={() => onAdmin('reset_ledger')}>Reset to ₹50,000</button>
        </div>
        {adminNote ? <p className="mt-2 text-slate-400">{adminNote}</p> : null}
      </section>
    </div>
  );
}

function LogList({ title, rows }: { title: string; rows: Array<{ t: string; kind: string; message: string }> }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">{title}</h2>
      {rows.length === 0 ? <p className="text-sm text-slate-500">Empty.</p> : (
        <ul className="space-y-1 text-sm">
          {rows.map((row, i) => (
            <li key={`${row.t}-${i}`} className="flex gap-3">
              <span className="w-28 shrink-0 text-slate-500">{formatIst(row.t)}</span>
              <span className="w-16 shrink-0 text-slate-500">{row.kind}</span>
              <span>{row.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
