import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { EquityCurveChart } from './components/EquityCurveChart';
import { TerminalChart, type TerminalTarget } from './components/TerminalChart';
import { formatInr, formatIst, formatPct, formatSigned } from './quant/format';
import { exitLevels } from './quant/options';
import type { DashboardPayload } from './quant/report';
import type { RunnerValidationReport } from './quant/research';
import type { GroupStat } from './quant/stats';
import type { Candidate, ClosedTrade, PaperPosition, SpotQuote } from './quant/types';
import { UNDERLYINGS } from './quant/types';

interface ResearchView {
  disclaimer: string;
  summary: { n: number; winRate: number | null; avgR: number | null; rCi90: [number, number] | null };
  gatedSummary?: { n: number; winRate: number | null; avgR: number | null; rCi90: [number, number] | null };
  walkForward?: {
    oos: {
      n: number;
      auc: number | null;
      avgR: number | null;
      threshold: number | null;
      acceptedN: number;
      acceptedAvgR: number | null;
    };
  };
  oppositeDirectionBaseline: { n: number; avgR: number | null };
  runnerValidation?: RunnerValidationReport;
  portfolio: {
    startingCapitalInr: number;
    endingEquityInr: number;
    returnPct: number;
    maxDrawdownPct: number;
    taken: number;
    skipped: number;
  };
  rawPortfolio?: {
    startingCapitalInr: number;
    endingEquityInr: number;
    returnPct: number;
    maxDrawdownPct: number;
    taken: number;
    skipped: number;
  };
  byStrategy: GroupStat[];
}

type Tab = 'overview' | 'terminal' | 'book' | 'orders' | 'performance' | 'learning' | 'rules';
type StateResponse = DashboardPayload & { persistent?: boolean; ledger?: string | null };

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Explore' },
  { id: 'book', label: 'Positions' },
  { id: 'orders', label: 'Orders & Signals' },
  { id: 'performance', label: 'Performance' },
  { id: 'learning', label: 'Learning' },
  { id: 'rules', label: 'Rules & Controls' },
];

const SYMBOL_META: Record<
  string,
  { name: string; short: string; bg: string; fg: string; category: string }
> = {
  NIFTY: { name: 'NIFTY 50 Index', short: 'N50', bg: 'bg-blue-600', fg: 'text-white', category: 'NSE Index' },
  BANKNIFTY: { name: 'Nifty Bank Index', short: 'BNK', bg: 'bg-indigo-600', fg: 'text-white', category: 'NSE Index' },
  FINNIFTY: { name: 'Nifty Fin Service', short: 'FIN', bg: 'bg-teal-600', fg: 'text-white', category: 'NSE Index' },
  MIDCPNIFTY: { name: 'Nifty Midcap Select', short: 'MID', bg: 'bg-violet-600', fg: 'text-white', category: 'NSE Index' },
  RELIANCE: { name: 'Reliance Industries', short: 'RIL', bg: 'bg-amber-600', fg: 'text-white', category: 'Energy & Retail' },
  TCS: { name: 'Tata Consultancy', short: 'TCS', bg: 'bg-sky-600', fg: 'text-white', category: 'IT Services' },
  HDFCBANK: { name: 'HDFC Bank Ltd', short: 'HDFC', bg: 'bg-blue-800', fg: 'text-white', category: 'Private Bank' },
  INFY: { name: 'Infosys Limited', short: 'INFY', bg: 'bg-cyan-600', fg: 'text-white', category: 'IT Services' },
  ICICIBANK: { name: 'ICICI Bank Ltd', short: 'ICICI', bg: 'bg-orange-600', fg: 'text-white', category: 'Private Bank' },
  SBIN: { name: 'State Bank of India', short: 'SBI', bg: 'bg-blue-500', fg: 'text-white', category: 'PSU Bank' },
  BHARTIARTL: { name: 'Bharti Airtel Ltd', short: 'AIR', bg: 'bg-red-600', fg: 'text-white', category: 'Telecom' },
  ITC: { name: 'ITC Limited', short: 'ITC', bg: 'bg-emerald-700', fg: 'text-white', category: 'FMCG' },
  KOTAKBANK: { name: 'Kotak Mahindra Bank', short: 'KTK', bg: 'bg-rose-700', fg: 'text-white', category: 'Private Bank' },
  LT: { name: 'Larsen & Toubro', short: 'L&T', bg: 'bg-slate-700', fg: 'text-white', category: 'Infrastructure' },
  AXISBANK: { name: 'Axis Bank Ltd', short: 'AXIS', bg: 'bg-fuchsia-800', fg: 'text-white', category: 'Private Bank' },
  BAJFINANCE: { name: 'Bajaj Finance Ltd', short: 'BAJ', bg: 'bg-blue-700', fg: 'text-white', category: 'NBFC' },
  MARUTI: { name: 'Maruti Suzuki India', short: 'MSIL', bg: 'bg-indigo-700', fg: 'text-white', category: 'Automobiles' },
  ASIANPAINT: { name: 'Asian Paints Ltd', short: 'APNT', bg: 'bg-amber-500', fg: 'text-white', category: 'Consumer' },
  SUNPHARMA: { name: 'Sun Pharmaceutical', short: 'SUN', bg: 'bg-orange-500', fg: 'text-white', category: 'Pharma' },
  TITAN: { name: 'Titan Company Ltd', short: 'TITN', bg: 'bg-teal-700', fg: 'text-white', category: 'Consumer' },
  ULTRACEMCO: { name: 'UltraTech Cement', short: 'UTC', bg: 'bg-yellow-600', fg: 'text-white', category: 'Cement' },
  TATASTEEL: { name: 'Tata Steel Ltd', short: 'TATA', bg: 'bg-sky-800', fg: 'text-white', category: 'Metals' },
  NTPC: { name: 'NTPC Limited', short: 'NTPC', bg: 'bg-cyan-700', fg: 'text-white', category: 'Power' },
  'M&M': { name: 'Mahindra & Mahindra', short: 'M&M', bg: 'bg-red-700', fg: 'text-white', category: 'Automobiles' },
  POWERGRID: { name: 'Power Grid Corp', short: 'PWGR', bg: 'bg-emerald-600', fg: 'text-white', category: 'Power' },
  ADANIENT: { name: 'Adani Enterprises', short: 'ADAN', bg: 'bg-indigo-800', fg: 'text-white', category: 'Conglomerate' },
  BAJAJFINSV: { name: 'Bajaj Finserv Ltd', short: 'BFS', bg: 'bg-blue-600', fg: 'text-white', category: 'Financials' },
  WIPRO: { name: 'Wipro Limited', short: 'WIP', bg: 'bg-purple-700', fg: 'text-white', category: 'IT Services' },
  COALINDIA: { name: 'Coal India Ltd', short: 'COAL', bg: 'bg-stone-700', fg: 'text-white', category: 'Mining' },
  JSWSTEEL: { name: 'JSW Steel Ltd', short: 'JSW', bg: 'bg-blue-900', fg: 'text-white', category: 'Metals' },
  HINDALCO: { name: 'Hindalco Industries', short: 'HIND', bg: 'bg-amber-700', fg: 'text-white', category: 'Metals' },
  ONGC: { name: 'Oil & Natural Gas', short: 'ONGC', bg: 'bg-red-800', fg: 'text-white', category: 'Energy' },
  GRASIM: { name: 'Grasim Industries', short: 'GRAS', bg: 'bg-rose-600', fg: 'text-white', category: 'Materials' },
  TECHM: { name: 'Tech Mahindra Ltd', short: 'TECH', bg: 'bg-red-600', fg: 'text-white', category: 'IT Services' },
  HCLTECH: { name: 'HCL Technologies', short: 'HCL', bg: 'bg-sky-700', fg: 'text-white', category: 'IT Services' },
  INDIA_VIX: { name: 'India VIX Volatility', short: 'VIX', bg: 'bg-slate-700', fg: 'text-white', category: 'Volatility' },
};

function pnlColor(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return 'text-slate-600';
  return n > 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]';
}

function formatExpiryLabel(expiry: string): string {
  const d = new Date(`${expiry}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return expiry;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${day} ${mon}`;
}

function MiniSparkline({ positive, seed }: { positive: boolean; seed: string }) {
  const pts = useMemo(() => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 997;
    const base = [0.5, 0.42, 0.58, 0.47, 0.63, 0.54, 0.72, 0.68, positive ? 0.88 : 0.18];
    return base.map((v, idx) => {
      const jitter = (((h >> idx) & 3) - 1.5) * 0.06;
      const val = positive ? v + jitter : 1 - v + jitter;
      const x = (idx / (base.length - 1)) * 68 + 2;
      const y = 24 - Math.max(0.08, Math.min(0.92, val)) * 20;
      return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }, [positive, seed]);

  return (
    <svg viewBox="0 0 72 28" className="h-7 w-20 overflow-visible">
      <path
        d={pts}
        fill="none"
        stroke={positive ? '#00B386' : '#EB5B3C'}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ScoreTable({ title, rows, money }: { title: string; rows: GroupStat[]; money: string }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        <p className="mt-2 text-sm text-slate-400">No {title.toLowerCase()} recorded yet.</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-800">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-100 text-xs font-medium text-slate-400">
            <tr>
              <th className="pb-2 pr-3">Group</th>
              <th className="pb-2 pr-3 text-right">Trades</th>
              <th className="pb-2 pr-3 text-right">Win %</th>
              <th className="pb-2 pr-3 text-right">Avg R</th>
              <th className="pb-2 text-right">{money}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.key} className="hover:bg-slate-50/70">
                <td className="py-2.5 pr-3 font-medium text-slate-800">{row.key}</td>
                <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-slate-600">{row.n}</td>
                <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-slate-600">
                  {row.winRate === null ? '—' : formatPct(row.winRate * 100)}
                </td>
                <td className={`py-2.5 pr-3 text-right font-mono font-medium tabular-nums ${pnlColor(row.avgR)}`}>
                  {formatSigned(row.avgR, 3)}
                </td>
                <td className={`py-2.5 text-right font-mono font-medium tabular-nums ${pnlColor(row.netPnlInr)}`}>
                  {formatInr(row.netPnlInr)}
                </td>
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
  const [searchQuery, setSearchQuery] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [terminalTarget, setTerminalTarget] = useState<TerminalTarget | null>(null);

  const loadState = useCallback(async () => {
    try {
      const res = await fetch('/api/state?live=1');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'State request failed');
      setState(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load state');
    }
  }, []);

  const triggerManualSync = useCallback(async () => {
    setSyncing(true);
    try {
      await fetch('/api/tick');
      await loadState();
    } finally {
      setSyncing(false);
    }
  }, [loadState]);

  useEffect(() => {
    void loadState();
    const poll = setInterval(() => void loadState(), 3_000);
    const tick = setInterval(() => {
      void fetch('/api/tick').finally(() => void loadState());
    }, 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [loadState]);

  useEffect(() => {
    if (tab !== 'book' && tab !== 'orders' && tab !== 'performance') return;
    void fetch('/api/journal?kind=trades')
      .then((r) => r.json())
      .then((b) => setTrades(b.rows ?? []))
      .catch(() => setTrades([]));
    void fetch('/api/journal?kind=candidates')
      .then((r) => r.json())
      .then((b) => setCandidates(b.rows ?? []))
      .catch(() => setCandidates([]));
  }, [tab, state?.counters?.tradesClosed, state?.counters?.candidatesClosed]);

  useEffect(() => {
    if (tab !== 'performance' || research) return;
    void fetch('/api/research')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setResearch(b))
      .catch(() => setResearch(null));
  }, [tab, research]);

  const dash = state && state.ledgerId ? state : null;

  const activeTerminalTarget: TerminalTarget = useMemo(() => {
    if (terminalTarget) {
      if (terminalTarget.kind === 'position' && dash) {
        const updatedPos = dash.openPositions.find((p) => p.id === terminalTarget.id);
        if (updatedPos) return { ...terminalTarget, position: updatedPos };
      }
      if (terminalTarget.kind === 'candidate' && dash) {
        const updatedCand = dash.activeCandidates.find((c) => c.id === terminalTarget.id);
        if (updatedCand) return { ...terminalTarget, candidate: updatedCand };
      }
      return terminalTarget;
    }
    if (dash && dash.openPositions.length > 0) {
      const p = dash.openPositions[0];
      return { kind: 'position', id: p.id, underlying: p.underlying, position: p };
    }
    if (dash && dash.activeCandidates.length > 0) {
      const c = dash.activeCandidates[0];
      return { kind: 'candidate', id: c.id, underlying: c.underlying, candidate: c };
    }
    return { kind: 'underlying', id: 'NIFTY', underlying: 'NIFTY' };
  }, [terminalTarget, dash]);

  const openInTerminal = useCallback((target: TerminalTarget) => {
    setTerminalTarget(target);
    setTab('terminal');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  async function admin(action: string) {
    if (
      action === 'reset_ledger' &&
      !window.confirm('Start a new ₹50,000 ledger? The old one stays in the database but is no longer active.')
    )
      return;
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

  const spots = dash?.market?.spots ?? {};
  const tickerList = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'INDIA_VIX', 'RELIANCE', 'TCS', 'HDFCBANK'];

  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* Top Groww-Style Navigation Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          {/* Left Brand & Top Categories */}
          <div className="flex items-center gap-7">
            <button
              type="button"
              onClick={() => setTab('overview')}
              className="flex items-center gap-2.5 text-left focus:outline-none"
            >
              <div className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-gradient-to-tr from-[#00B386] to-[#3B82F6] shadow-xs">
                <svg viewBox="0 0 32 32" className="h-6 w-6 text-white">
                  <path
                    d="M4 22 L11 15 L17 19 L28 9"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div>
                <span className="text-lg font-bold tracking-tight text-slate-900">
                  {tab === 'terminal' ? 'Terminal' : 'AegisQuant'}
                </span>
                <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#008F6B]">
                  NSE Paper
                </span>
              </div>
            </button>

            <div className="hidden items-center gap-6 text-sm font-semibold md:flex">
              <button
                type="button"
                onClick={() => setTab('overview')}
                className={tab !== 'terminal' ? 'text-slate-900' : 'text-slate-400 hover:text-slate-700'}
              >
                Stocks &amp; F&amp;O
              </button>
              <button
                type="button"
                onClick={() => setTab('terminal')}
                className={tab === 'terminal' ? 'text-slate-900' : 'text-slate-400 hover:text-slate-700'}
              >
                Option Terminal
              </button>
              <button
                type="button"
                onClick={() => setTab('learning')}
                className={tab === 'learning' ? 'text-slate-900' : 'text-slate-400 hover:text-slate-700'}
              >
                ML Gate {dash?.model?.offlineOos.auc ? `(AUC ${dash.model.offlineOos.auc.toFixed(2)})` : ''}
              </button>
            </div>
          </div>

          {/* Center Search Input (Groww Search Style) */}
          <div className="relative hidden max-w-md flex-1 sm:block">
            <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-400">
              ⌕
            </span>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchQuery.trim()) {
                  const q = searchQuery.trim().toUpperCase();
                  const match = UNDERLYINGS.find((u) => u.includes(q));
                  if (match) {
                    openInTerminal({ kind: 'underlying', id: match, underlying: match });
                  }
                }
              }}
              placeholder="Search for Stocks, F&O, Indices (e.g. NIFTY, RELIANCE)..."
              className="w-full rounded-lg border border-slate-200 bg-slate-50/70 py-2 pr-14 pl-9 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[#00B386] focus:bg-white focus:outline-none"
            />
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-400">
              Enter ↵
            </span>
          </div>

          {/* Right Status & Sync Controls */}
          <div className="flex items-center gap-3">
            <div className="hidden text-right text-xs lg:block">
              <div className="flex items-center justify-end gap-1.5 font-medium text-slate-700">
                <span
                  className={`h-2 w-2 rounded-full ${
                    dash?.market?.live ? 'bg-[#00B386]' : 'bg-amber-400'
                  }`}
                />
                <span>{dash?.market?.live ? 'Live NSE Feed' : 'Off-Hours / Synced'}</span>
              </div>
              <div className="font-mono text-[11px] text-slate-400">
                {state?.persistent ? `Neon DB · ${dash?.ledgerId ?? ''}` : 'Memory Store'}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void triggerManualSync()}
              disabled={syncing}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              {syncing ? 'Syncing…' : '↻ Sync'}
            </button>
          </div>
        </div>

        {/* Second Row: Underline Sub-Navigation Tabs + Right-Aligned Terminal Button */}
        <div className="mx-auto flex max-w-7xl items-center justify-between border-t border-slate-100 px-4 sm:px-6">
          <nav className="no-scrollbar flex items-center gap-6 overflow-x-auto" aria-label="Main sections">
            {TABS.map((item) => {
              const active = tab === item.id;
              const badge =
                item.id === 'book' && dash?.openPositions.length
                  ? dash.openPositions.length
                  : item.id === 'orders' && dash?.activeCandidates.length
                    ? dash.activeCandidates.length
                    : null;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`relative flex items-center gap-1.5 py-3 text-sm font-semibold whitespace-nowrap transition ${
                    active ? 'text-slate-900' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <span>{item.label}</span>
                  {badge !== null ? (
                    <span className="rounded-full bg-[#00B386]/15 px-1.5 py-0.2 font-mono text-[11px] font-bold text-[#008F6B]">
                      {badge}
                    </span>
                  ) : null}
                  {active ? (
                    <span className="absolute right-0 bottom-0 left-0 h-[3px] rounded-t-full bg-slate-900" />
                  ) : null}
                </button>
              );
            })}
          </nav>

          {/* Exact Groww "Terminal" Button on the Right */}
          <button
            type="button"
            onClick={() => setTab(tab === 'terminal' ? 'overview' : 'terminal')}
            className={`my-1.5 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
              tab === 'terminal'
                ? 'border-[#00B386] bg-[#00B386] text-white'
                : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50'
            }`}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M4 2v12M2.5 5h3v5h-3zM11 2v12M9.5 6h3v6h-3z" />
            </svg>
            <span>Terminal</span>
          </button>
        </div>

        {/* Third Row: Horizontal Live NSE Index & F&O Ticker Strip */}
        <div className="border-t border-slate-100 bg-slate-50/50">
          <div className="no-scrollbar mx-auto flex max-w-7xl items-center gap-6 overflow-x-auto px-4 py-2 text-xs whitespace-nowrap sm:px-6">
            {tickerList.map((sym) => {
              const q = spots[sym];
              if (!q) return null;
              const diff = q.ltp - q.prevClose;
              const up = q.changePct >= 0;
              return (
                <button
                  key={sym}
                  type="button"
                  onClick={() => {
                    if (sym !== 'INDIA_VIX') {
                      openInTerminal({ kind: 'underlying', id: sym, underlying: sym });
                    }
                  }}
                  className="group flex items-center gap-2 text-left transition hover:opacity-80"
                >
                  <span className="font-semibold text-slate-800 group-hover:text-[#00B386]">
                    {sym === 'INDIA_VIX' ? 'INDIA VIX' : sym}
                  </span>
                  <span className="font-mono font-medium text-slate-900 tabular-nums">
                    {q.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <span className={`font-mono font-medium tabular-nums ${up ? 'text-[#00B386]' : 'text-[#EB5B3C]'}`}>
                    {diff >= 0 ? '+' : ''}
                    {diff.toFixed(2)} ({up ? '+' : ''}
                    {q.changePct.toFixed(2)}%)
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {error ? (
          <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-[#EB5B3C]">
            {error}
          </div>
        ) : null}

        {!state ? (
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="space-y-4 lg:col-span-8">
              <div className="h-44 animate-pulse rounded-xl bg-slate-100" />
              <div className="h-72 animate-pulse rounded-xl bg-slate-100" />
            </div>
            <div className="space-y-4 lg:col-span-4">
              <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
            </div>
          </div>
        ) : !dash ? (
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
            <h2 className="text-lg font-semibold text-slate-900">Initializing ₹50,000 Paper Ledger</h2>
            <p className="mt-1 text-sm text-slate-500">
              Click Sync to create the initial paper ledger from live Angel One market quotes.
            </p>
            <button
              type="button"
              onClick={() => void triggerManualSync()}
              className="mt-4 rounded-lg bg-[#00B386] px-4 py-2 text-sm font-semibold text-white hover:bg-[#009973]"
            >
              Initialize Live Ledger
            </button>
          </div>
        ) : tab === 'terminal' ? (
          <div className="space-y-4">
            {/* Quick Open Position & Signal Bar at top of Terminal */}
            {dash.openPositions.length > 0 || dash.activeCandidates.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Active Contracts:
                </span>
                {dash.openPositions.map((p) => {
                  const isSelected = activeTerminalTarget.kind === 'position' && activeTerminalTarget.id === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        openInTerminal({ kind: 'position', id: p.id, underlying: p.underlying, position: p })
                      }
                      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                        isSelected
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 bg-white text-slate-800 hover:border-slate-300'
                      }`}
                    >
                      <span className="h-2 w-2 rounded-full bg-[#00B386]" />
                      <span>
                        {p.underlying} {formatExpiryLabel(p.plan.expiry)} {p.plan.long.strike} {p.direction}
                      </span>
                      <span
                        className={`font-mono tabular-nums ${
                          isSelected
                            ? 'text-emerald-300'
                            : p.unrealizedInr >= 0
                              ? 'text-[#00B386]'
                              : 'text-[#EB5B3C]'
                        }`}
                      >
                        ({p.unrealizedInr >= 0 ? '+' : ''}
                        {formatInr(p.unrealizedInr)})
                      </span>
                    </button>
                  );
                })}
                {dash.activeCandidates
                  .filter((c) => !c.takenByLedger)
                  .map((c) => {
                    const isSelected = activeTerminalTarget.kind === 'candidate' && activeTerminalTarget.id === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          openInTerminal({ kind: 'candidate', id: c.id, underlying: c.underlying, candidate: c })
                        }
                        className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                          isSelected
                            ? 'border-slate-900 bg-slate-900 text-white'
                            : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                        }`}
                      >
                        <span>
                          Shadow: {c.underlying} {formatExpiryLabel(c.plan.expiry)} {c.plan.long.strike} {c.direction}
                        </span>
                      </button>
                    );
                  })}
              </div>
            ) : null}

            <TerminalChart
              target={activeTerminalTarget}
              positions={dash.openPositions}
              candidates={dash.activeCandidates}
              spots={spots}
              takeProfitFrac={dash.config.takeProfitFracOfMaxGain}
              stopLossFrac={dash.config.stopLossFracOfDebit}
              onSelectTarget={(t) => setTerminalTarget(t)}
              onBackToOverview={() => setTab('overview')}
            />
          </div>
        ) : tab === 'overview' ? (
          <Overview
            dash={dash}
            searchQuery={searchQuery}
            onOpenTerminal={openInTerminal}
            onSelectTab={setTab}
            onSync={triggerManualSync}
            syncing={syncing}
          />
        ) : tab === 'book' ? (
          <Book
            positions={dash.openPositions}
            trades={trades}
            dash={dash}
            onOpenTerminal={openInTerminal}
          />
        ) : tab === 'orders' ? (
          <OrdersAndSignals
            candidates={dash.activeCandidates}
            closedCandidates={candidates}
            decisionLog={dash.decisionLog}
            config={dash.config}
            onOpenTerminal={openInTerminal}
          />
        ) : tab === 'performance' ? (
          <Performance dash={dash} research={research} />
        ) : tab === 'learning' ? (
          <Learning dash={dash} />
        ) : (
          <Rules dash={dash} secret={secret} setSecret={setSecret} adminNote={adminNote} onAdmin={admin} />
        )}
      </main>
    </div>
  );
}

function Overview({
  dash,
  searchQuery,
  onOpenTerminal,
  onSelectTab,
  onSync,
  syncing,
}: {
  dash: DashboardPayload;
  searchQuery: string;
  onOpenTerminal: (t: TerminalTarget) => void;
  onSelectTab: (t: Tab) => void;
  onSync: () => Promise<void>;
  syncing: boolean;
}) {
  const [showAllCards, setShowAllCards] = useState(false);
  const [moverTab, setMoverTab] = useState<'gainers' | 'losers' | 'signals' | 'all'>('gainers');

  const spots = dash.market?.spots ?? {};
  const regimes = dash.market?.regimes ?? {};

  const underlyingCards = useMemo(() => {
    const q = searchQuery.trim().toUpperCase();
    const list = UNDERLYINGS.map((sym) => {
      const spot = spots[sym];
      const reg = regimes[sym];
      const openPos = dash.openPositions.find((p) => p.underlying === sym);
      const activeCand = dash.activeCandidates.find((c) => c.underlying === sym);
      return { sym, spot, reg, openPos, activeCand };
    }).filter((item) => !q || item.sym.includes(q) || SYMBOL_META[item.sym]?.name.toUpperCase().includes(q));
    return showAllCards || q ? list : list.slice(0, 4);
  }, [spots, regimes, dash.openPositions, dash.activeCandidates, showAllCards, searchQuery]);

  const moverRows = useMemo(() => {
    const all = UNDERLYINGS.map((sym) => ({
      sym,
      spot: spots[sym],
      reg: regimes[sym],
      openPos: dash.openPositions.find((p) => p.underlying === sym),
      cand: dash.activeCandidates.find((c) => c.underlying === sym),
    })).filter((r): r is typeof r & { spot: SpotQuote } => Boolean(r.spot));

    if (moverTab === 'gainers') {
      const pos = all.filter((r) => r.spot.changePct >= 0).sort((a, b) => b.spot.changePct - a.spot.changePct);
      return pos.length > 0 ? pos : [...all].sort((a, b) => b.spot.changePct - a.spot.changePct);
    }
    if (moverTab === 'losers') {
      const neg = all.filter((r) => r.spot.changePct < 0).sort((a, b) => a.spot.changePct - b.spot.changePct);
      return neg.length > 0 ? neg : [...all].sort((a, b) => a.spot.changePct - b.spot.changePct);
    }
    if (moverTab === 'signals') {
      const withSig = all.filter((r) => r.openPos || r.cand);
      return withSig.length > 0 ? withSig : all;
    }
    return all;
  }, [spots, regimes, dash.openPositions, dash.activeCandidates, moverTab]);

  const mtmEquity = dash.mtmEquityInr ?? dash.equity + (dash.estOpenChargesInr ?? 0);
  const totalReturnInr = mtmEquity - dash.startingCapitalInr;
  const totalReturnPct = (totalReturnInr / dash.startingCapitalInr) * 100;
  const passCount = dash.readiness.checks.filter((c) => c.pass).length;

  return (
    <div className="grid gap-8 lg:grid-cols-12">
      {/* LEFT 8 COLUMNS: Explore Markets, Top Movers & Signals, Equity Curve */}
      <div className="space-y-9 lg:col-span-8">
        {/* Section 1: Most Traded F&O Underlyings (Groww 4-Card Grid Style) */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold tracking-tight text-slate-900">
              Active F&amp;O Underlyings on NSE
            </h2>
            <span className="text-xs text-slate-400">
              Click any card to open option chart in Terminal
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
            {underlyingCards.map(({ sym, spot, openPos, activeCand }) => {
              const meta = SYMBOL_META[sym] ?? {
                name: sym,
                short: sym.slice(0, 3),
                bg: 'bg-slate-800',
                fg: 'text-white',
                category: 'NSE F&O',
              };
              const ltp = spot?.ltp ?? 0;
              const diff = spot ? spot.ltp - spot.prevClose : 0;
              const pct = spot?.changePct ?? 0;
              const up = pct >= 0;

              return (
                <button
                  key={sym}
                  type="button"
                  onClick={() => {
                    if (openPos) {
                      onOpenTerminal({ kind: 'position', id: openPos.id, underlying: sym, position: openPos });
                    } else if (activeCand) {
                      onOpenTerminal({ kind: 'candidate', id: activeCand.id, underlying: sym, candidate: activeCand });
                    } else {
                      onOpenTerminal({ kind: 'underlying', id: sym, underlying: sym });
                    }
                  }}
                  className="group flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-2xs transition hover:border-slate-300 hover:shadow-sm"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div
                        className={`flex h-10 w-10 items-center justify-center rounded-xl text-xs font-bold shadow-2xs ${meta.bg} ${meta.fg}`}
                      >
                        {meta.short}
                      </div>
                      {openPos ? (
                        <span className="rounded bg-[#00B386]/15 px-1.5 py-0.5 text-[10px] font-bold text-[#008F6B]">
                          OPEN {openPos.direction}
                        </span>
                      ) : activeCand ? (
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                          SIGNAL {activeCand.direction}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-3 line-clamp-1 text-sm font-semibold text-slate-800 group-hover:text-[#00B386]">
                      {meta.name}
                    </div>
                  </div>

                  <div className="mt-5">
                    <div className="font-mono text-base font-bold text-slate-900 tabular-nums">
                      ₹{ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <div
                      className={`mt-0.5 font-mono text-xs font-semibold tabular-nums ${
                        up ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                      }`}
                    >
                      {diff >= 0 ? '+' : ''}
                      {diff.toFixed(2)} ({up ? '+' : ''}
                      {pct.toFixed(2)}%)
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setShowAllCards((s) => !s)}
            className="mt-3.5 inline-flex items-center gap-1 text-xs font-semibold text-[#00B386] hover:underline"
          >
            <span>{showAllCards ? 'Show top 4 underlyings' : `See all ${UNDERLYINGS.length} F&O underlyings`}</span>
            <span>›</span>
          </button>
        </section>

        {/* Section 2: Top Movers & Live Signals Today (Groww Table Style) */}
        <section>
          <h2 className="mb-3.5 text-lg font-bold tracking-tight text-slate-900">
            Top movers &amp; signals today
          </h2>

          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter movers">
              {(
                [
                  { id: 'gainers', label: 'Gainers' },
                  { id: 'losers', label: 'Losers' },
                  { id: 'signals', label: `Active Signals (${dash.activeCandidates.length})` },
                  { id: 'all', label: 'All NSE F&O' },
                ] as const
              ).map((pill) => {
                const active = moverTab === pill.id;
                return (
                  <button
                    key={pill.id}
                    type="button"
                    onClick={() => setMoverTab(pill.id)}
                    className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${
                      active
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {pill.label}
                  </button>
                );
              })}
            </div>

            <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600">
              NSE F&amp;O Universe
            </span>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xs">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 bg-slate-50/60 text-xs font-medium text-slate-400">
                <tr>
                  <th className="py-3 pr-3 pl-4">Company / Underlying</th>
                  <th className="hidden py-3 pr-3 sm:table-cell">1D Trend</th>
                  <th className="py-3 pr-4 text-right">Market price (1D)</th>
                  <th className="py-3 pr-4 text-right">Regime &amp; Terminal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {moverRows.map(({ sym, spot, reg, openPos, cand }) => {
                  const meta = SYMBOL_META[sym] ?? {
                    name: sym,
                    short: sym.slice(0, 3),
                    bg: 'bg-slate-800',
                    fg: 'text-white',
                    category: 'NSE F&O',
                  };
                  const diff = spot.ltp - spot.prevClose;
                  const up = spot.changePct >= 0;

                  return (
                    <tr
                      key={sym}
                      onClick={() => {
                        if (openPos) {
                          onOpenTerminal({ kind: 'position', id: openPos.id, underlying: sym, position: openPos });
                        } else if (cand) {
                          onOpenTerminal({ kind: 'candidate', id: cand.id, underlying: sym, candidate: cand });
                        } else {
                          onOpenTerminal({ kind: 'underlying', id: sym, underlying: sym });
                        }
                      }}
                      className="cursor-pointer transition hover:bg-slate-50/90"
                    >
                      <td className="py-3.5 pr-3 pl-4">
                        <div className="flex items-center gap-3">
                          <div
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold ${meta.bg} ${meta.fg}`}
                          >
                            {meta.short}
                          </div>
                          <div>
                            <div className="font-semibold text-slate-900">{meta.name}</div>
                            <div className="text-xs text-slate-400">
                              {openPos
                                ? `Open: ${openPos.plan.long.strike}/${openPos.plan.short.strike} ${openPos.direction}`
                                : cand
                                  ? `Shadow: ${cand.plan.long.strike}/${cand.plan.short.strike} ${cand.direction}`
                                  : meta.category}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="hidden py-3.5 pr-3 sm:table-cell">
                        <MiniSparkline positive={up} seed={sym} />
                      </td>
                      <td className="py-3.5 pr-4 text-right font-mono tabular-nums">
                        <div className="font-semibold text-slate-900">
                          ₹{spot.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        <div className={`text-xs font-medium ${up ? 'text-[#00B386]' : 'text-[#EB5B3C]'}`}>
                          {diff >= 0 ? '+' : ''}
                          {diff.toFixed(2)} ({up ? '+' : ''}
                          {spot.changePct.toFixed(2)}%)
                        </div>
                      </td>
                      <td className="py-3.5 pr-4 text-right">
                        <div className="flex flex-col items-end gap-1">
                          {reg ? (
                            <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600">
                              {reg.regime.replace('_', ' ')} · RSI {Math.round(reg.rsi14)}
                            </span>
                          ) : null}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (openPos) {
                                onOpenTerminal({ kind: 'position', id: openPos.id, underlying: sym, position: openPos });
                              } else if (cand) {
                                onOpenTerminal({ kind: 'candidate', id: cand.id, underlying: sym, candidate: cand });
                              } else {
                                onOpenTerminal({ kind: 'underlying', id: sym, underlying: sym });
                              }
                            }}
                            className="text-xs font-semibold text-[#00B386] hover:underline"
                          >
                            Open Terminal →
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Section 3: Paper Equity Curve */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-slate-900">Paper Ledger Equity Curve</h2>
              <p className="text-xs text-slate-400">
                Marked to live Angel One option bid/ask liquidation value net of brokerage &amp; statutory charges
              </p>
            </div>
            <span className="font-mono text-xs text-slate-400">
              Started at {formatInr(dash.startingCapitalInr)}
            </span>
          </div>
          <EquityCurveChart data={dash.recentEquity} />
        </section>
      </div>

      {/* RIGHT 4 COLUMNS: Your Investments (with Open Positions) + Products & Tools */}
      <div className="space-y-7 lg:col-span-4">
        {/* Card 1: Your Investments & Open Positions (Matches Groww Right Column) */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold tracking-tight text-slate-900">Your investments</h2>
            <button
              type="button"
              onClick={() => onSelectTab('book')}
              className="text-xs font-semibold text-[#00B386] hover:underline"
            >
              All positions ›
            </button>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
            {/* Portfolio Equity & P&L Header */}
            <div className="flex items-baseline justify-between border-b border-slate-100 pb-4">
              <div>
                <div className="text-xs font-medium text-slate-400">Current Value (MTM)</div>
                <div className="mt-1 font-mono text-2xl font-bold text-slate-900 tabular-nums">
                  {formatInr(mtmEquity)}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                  Net after ₹{(dash.estOpenChargesInr ?? 0).toFixed(0)} charges: {formatInr(dash.equity)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-medium text-slate-400">Open MTM Returns</div>
                <div
                  className={`mt-1 font-mono text-sm font-bold tabular-nums ${
                    totalReturnInr >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                  }`}
                >
                  {totalReturnInr >= 0 ? '+' : ''}
                  {formatInr(totalReturnInr)} ({totalReturnPct >= 0 ? '+' : ''}
                  {totalReturnPct.toFixed(2)}%)
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 border-b border-slate-100 py-3 text-xs">
              <div>
                <span className="text-slate-400">Available Cash</span>
                <div className="mt-0.5 font-mono font-semibold text-slate-800 tabular-nums">
                  {formatInr(dash.cash)}
                </div>
              </div>
              <div className="text-right">
                <span className="text-slate-400">Open Market P&amp;L</span>
                <div className={`mt-0.5 font-mono font-semibold tabular-nums ${pnlColor(dash.unrealizedPnlInr)}`}>
                  {dash.unrealizedPnlInr >= 0 ? '+' : ''}
                  {formatInr(dash.unrealizedPnlInr)}
                </div>
              </div>
            </div>

            {/* Open Positions List inside Your Investments */}
            <div className="mt-4">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Open Positions ({dash.openPositions.length})
                </span>
                {dash.openPositions.length > 0 ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#00B386]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#00B386]" />
                    <span>Real-time 3s Mark</span>
                  </span>
                ) : null}
              </div>

              {dash.openPositions.length === 0 ? (
                <div className="rounded-xl bg-slate-50/70 p-5 text-center">
                  <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-[#00B386]">
                    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M3 14l4-4 4 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-slate-700">No open positions right now</p>
                  <p className="mt-1 text-xs text-slate-400">
                    New vertical debit spreads open automatically during NSE hours (09:30–15:00 IST) when a bar closes with a valid signal.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {dash.openPositions.map((p) => {
                    const mark = p.lastMark?.liquidationValue ?? p.plan.entryDebit;
                    const diffPts = mark - p.plan.entryDebit;
                    const diffPct = p.plan.entryDebit > 0 ? (diffPts / p.plan.entryDebit) * 100 : 0;
                    const up = p.unrealizedInr >= 0;
                    const longNow = p.lastMark?.longBid ?? p.plan.long.bid;
                    const shortNow = p.lastMark?.shortAsk ?? p.plan.short.ask;
                    const lvls = exitLevels(p.plan, dash.config, {
                      peakValue: Math.max(p.confirmedPeakValue ?? p.peakValue ?? mark, mark),
                      sessionsHeld: p.sessionsHeld,
                      runnerArmed: p.runnerArmed,
                      previousFloor: p.runnerFloor,
                      previousFloorV31: p.runnerFloorV31,
                      previousFloorLearned: p.runnerFloorLearned,
                      variant: p.exitRuleVersion ?? 'ADAPTIVE_LEARNED',
                      learnedKeepFrac: p.learnedKeepFrac,
                      learnedEarlyStopTightened: p.learnedEarlyStopTightened,
                    });
                    const stageLabel =
                      lvls.stage === 'RUNNER_MODE'
                        ? `RUNNER (${Math.round(lvls.keepFracActive * 100)}% KEEP)`
                        : lvls.stage === 'PROFIT_TRAIL'
                          ? 'PROFIT TRAIL LOCK'
                          : lvls.stage === 'BREAKEVEN_LOCK'
                            ? 'BREAKEVEN + COST LOCK'
                            : lvls.stage === 'TIME_DECAY'
                              ? p.learnedEarlyStopTightened
                                ? 'LEARNED EARLY STOP (-38%)'
                                : 'RATCHET FLOOR'
                              : 'INITIAL STOP';
                    return (
                      <div
                        key={p.id}
                        onClick={() =>
                          onOpenTerminal({ kind: 'position', id: p.id, underlying: p.underlying, position: p })
                        }
                        className="group cursor-pointer rounded-xl border border-slate-200 bg-slate-50/40 p-3.5 text-left transition hover:border-[#00B386] hover:bg-white hover:shadow-xs"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="rounded bg-[#00B386]/15 px-1.5 py-0.5 text-[10px] font-bold text-[#008F6B]">
                                {p.direction} DEBIT SPREAD
                              </span>
                              <span className="text-xs font-medium text-slate-400">
                                {p.lots} Lot ({p.lots * p.plan.lotSize} qty)
                              </span>
                            </div>
                            <div className="mt-1 text-sm font-bold text-slate-900 group-hover:text-[#00B386]">
                              {p.underlying} {formatExpiryLabel(p.plan.expiry)} {p.plan.long.strike}/{p.plan.short.strike} {p.direction}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              Opened {formatIst(p.openedAt)} · {p.strategy.replace('_', ' ')}
                            </div>
                          </div>

                          <div className="text-right font-mono tabular-nums">
                            <div className={`text-sm font-bold ${up ? 'text-[#00B386]' : 'text-[#EB5B3C]'}`}>
                              {up ? '+' : ''}
                              {formatInr(p.unrealizedInr)}
                            </div>
                            <div className={`text-[11px] font-medium ${up ? 'text-[#00B386]' : 'text-[#EB5B3C]'}`}>
                              {diffPts >= 0 ? '+' : ''}
                              {diffPts.toFixed(2)} pts ({diffPct >= 0 ? '+' : ''}
                              {diffPct.toFixed(2)}%)
                            </div>
                          </div>
                        </div>

                        {/* Individual Leg Breakdown inside Position Card */}
                        <div className="mt-2.5 space-y-1 rounded-lg border border-slate-200/80 bg-white px-2.5 py-2 font-mono text-[11px]">
                          <div className="flex items-center justify-between">
                            <span className="text-slate-700">
                              <span className="mr-1.5 rounded bg-emerald-50 px-1 py-0.5 text-[10px] font-bold text-[#008F6B]">
                                BUY
                              </span>
                              {p.plan.long.strike} {p.direction}
                            </span>
                            <span className="text-slate-600">
                              ₹{p.plan.long.ask.toFixed(2)} → <strong className="text-slate-900">₹{longNow.toFixed(2)}</strong>
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-slate-700">
                              <span className="mr-1.5 rounded bg-rose-50 px-1 py-0.5 text-[10px] font-bold text-[#EB5B3C]">
                                SELL
                              </span>
                              {p.plan.short.strike} {p.direction}
                            </span>
                            <span className="text-slate-600">
                              ₹{p.plan.short.bid.toFixed(2)} → <strong className="text-slate-900">₹{shortNow.toFixed(2)}</strong>
                            </span>
                          </div>
                        </div>

                        {/* Dynamic High-Water-Mark Exit Ratchet + Self-Learning Exit Policy Strip */}
                        <div className="mt-2 space-y-1 rounded-lg border border-slate-200/70 bg-slate-100/60 px-2.5 py-1.5 font-mono text-[10px]">
                          <div className="flex flex-wrap items-center justify-between gap-1">
                            <span className="text-slate-600">
                              Floor <strong className={lvls.stop > p.plan.entryDebit ? 'text-[#008F6B]' : 'text-amber-700'}>₹{lvls.stop.toFixed(2)}</strong>
                              {lvls.ratcheted ? (
                                <span className="ml-1 text-slate-400 line-through">₹{lvls.initialStop.toFixed(2)}</span>
                              ) : null}
                            </span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                                lvls.stop > p.plan.entryDebit
                                  ? 'bg-emerald-100 text-[#008F6B]'
                                  : lvls.ratcheted
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-slate-200 text-slate-600'
                              }`}
                            >
                              {stageLabel}
                            </span>
                            <span className="text-slate-600">
                              {lvls.runnerArmed ? 'Ceiling' : '30% Gate'} <strong className="text-[#008F6B]">₹{lvls.target.toFixed(2)}</strong>
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-1 border-t border-slate-200/60 pt-1 text-[9.5px] text-slate-500">
                            <span>
                              30% Gate (₹{lvls.fixed30Target.toFixed(2)}):{' '}
                              <strong className="text-slate-700">v2 ₹{lvls.fixed30Target.toFixed(2)}</strong> ·{' '}
                              <strong className="text-[#008F6B]">v3 ₹{lvls.runnerFloorAtArm.toFixed(2)}</strong> ·{' '}
                              <strong className="text-indigo-700">v3.1 ₹{lvls.runnerFloorAtArmV31.toFixed(2)}</strong> ·{' '}
                              <strong className="text-purple-700">Learned ₹{lvls.runnerFloorAtArmLearned.toFixed(2)}</strong>
                            </span>
                            <span>Ceiling ₹{lvls.ceilingTarget.toFixed(2)}</span>
                          </div>
                          {typeof p.learnedRunnerProb === 'number' ? (
                            <div className="flex flex-wrap items-center justify-between gap-1 border-t border-indigo-200/60 pt-1 text-[9.5px] text-indigo-900">
                              <span>
                                <strong>Self-Learning Exit (v3.1+):</strong> Runner ≥60% Prob{' '}
                                <strong>{(p.learnedRunnerProb * 100).toFixed(1)}%</strong> · Recovery Prob{' '}
                                <strong>{((p.learnedRecoveryProb ?? 0.5) * 100).toFixed(1)}%</strong> · Keep{' '}
                                <strong>{((p.learnedKeepFrac ?? 0.8) * 100).toFixed(1)}%</strong>
                              </span>
                            </div>
                          ) : null}
                        </div>

                        <div className="mt-2 flex items-center justify-between border-t border-slate-200/70 pt-2 text-xs">
                          <span className="font-mono text-[11px] text-slate-500">
                            Entry ₹{p.plan.entryDebit.toFixed(2)} → Now ₹{mark.toFixed(2)} (Confirmed P ₹{lvls.peakValue.toFixed(2)})
                          </span>
                          <span className="inline-flex items-center gap-1 font-semibold text-[#00B386]">
                            <span>Terminal</span>
                            <span>→</span>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Card 2: Products & Tools (Matches Groww Right Column "Products & Tools") */}
        <section>
          <h2 className="mb-3.5 text-lg font-bold tracking-tight text-slate-900">Products &amp; tools</h2>
          <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white shadow-2xs">
            <button
              type="button"
              onClick={() => {
                const firstPos = dash.openPositions[0];
                if (firstPos) {
                  onOpenTerminal({
                    kind: 'position',
                    id: firstPos.id,
                    underlying: firstPos.underlying,
                    position: firstPos,
                  });
                } else {
                  onOpenTerminal({ kind: 'underlying', id: 'NIFTY', underlying: 'NIFTY' });
                }
              }}
              className="flex w-full items-center justify-between px-4 py-3.5 text-left transition hover:bg-slate-50"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50 text-[#00B386]">
                  <svg viewBox="0 0 18 18" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M5 2v14M3.2 5.5h3.6v6H3.2zM13 2v14M11.2 6.5h3.6v6h-3.6z" />
                  </svg>
                </span>
                <div>
                  <div className="text-sm font-semibold text-slate-900">Option Chain Terminal</div>
                  <div className="text-xs text-slate-400">Live SELL/BUY bid-ask boxes &amp; 5m/1h candlesticks</div>
                </div>
              </div>
              <span className="rounded-md bg-emerald-50 px-2 py-1 font-mono text-xs font-semibold text-[#008F6B]">
                {dash.openPositions.length} open
              </span>
            </button>

            <button
              type="button"
              onClick={() => onSelectTab('orders')}
              className="flex w-full items-center justify-between px-4 py-3.5 text-left transition hover:bg-slate-50"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                  <svg viewBox="0 0 18 18" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M10 2L4 10h5l-1 6 6-8H9l1-6z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div>
                  <div className="text-sm font-semibold text-slate-900">Shadow Signal Tracker</div>
                  <div className="text-xs text-slate-400">Tracks all priced signals to train the model</div>
                </div>
              </div>
              <span className="rounded-md bg-blue-50 px-2 py-1 font-mono text-xs font-semibold text-blue-700">
                {dash.activeCandidates.length} active
              </span>
            </button>

            <button
              type="button"
              onClick={() => onSelectTab('learning')}
              className="flex w-full items-center justify-between px-4 py-3.5 text-left transition hover:bg-slate-50"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-50 text-purple-600">
                  <svg viewBox="0 0 18 18" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <circle cx="9" cy="9" r="6.5" />
                    <path d="M6 10.5l2-2.5 2 1.5 2.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div>
                  <div className="text-sm font-semibold text-slate-900">Walk-Forward ML Gate</div>
                  <div className="text-xs text-slate-400">
                    {dash.model ? `${dash.model.nOffline} offline + ${dash.model.nLive} live samples` : 'Ready to fit'}
                  </div>
                </div>
              </div>
              <span className="rounded-md bg-slate-100 px-2 py-1 font-mono text-xs font-semibold text-slate-700">
                AUC {dash.model?.offlineOos.auc ? dash.model.offlineOos.auc.toFixed(3) : '—'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => onSelectTab('rules')}
              className="flex w-full items-center justify-between px-4 py-3.5 text-left transition hover:bg-slate-50"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                  <svg viewBox="0 0 18 18" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M9 2L3.5 4.5v4.5c0 3.5 2.4 6.2 5.5 7 3.1-.8 5.5-3.5 5.5-7V4.5L9 2z" strokeLinejoin="round" />
                  </svg>
                </span>
                <div>
                  <div className="text-sm font-semibold text-slate-900">Real-Money Readiness</div>
                  <div className="text-xs text-slate-400">Go/no-go statistical verification checks</div>
                </div>
              </div>
              <span className="rounded-md bg-slate-100 px-2 py-1 font-mono text-xs font-semibold text-slate-700">
                {passCount} / {dash.readiness.checks.length} pass
              </span>
            </button>

            <div className="flex items-center justify-between px-4 py-3.5">
              <div>
                <div className="text-xs font-medium text-slate-500">Last Engine Cycle</div>
                <div className="font-mono text-xs text-slate-800">
                  {dash.lastCycle ? `${dash.lastCycle.status} · ${formatIst(dash.lastCycle.at)}` : 'Waiting'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void onSync()}
                disabled={syncing}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {syncing ? 'Running…' : 'Run Cycle'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Book({
  positions,
  trades,
  dash,
  onOpenTerminal,
}: {
  positions: PaperPosition[];
  trades: ClosedTrade[];
  dash: DashboardPayload;
  onOpenTerminal: (t: TerminalTarget) => void;
}) {
  const mtmEquity = dash.mtmEquityInr ?? dash.equity + (dash.estOpenChargesInr ?? 0);
  const estCharges = dash.estOpenChargesInr ?? 0;

  return (
    <div className="space-y-6">
      {/* Top Summary Strip */}
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-400">Current Equity (MTM)</div>
          <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">{formatInr(mtmEquity)}</div>
          <div className="mt-0.5 font-mono text-[11px] text-slate-400">
            After charges: {formatInr(dash.equity)}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-400">Open Market P&amp;L (MTM)</div>
          <div className={`mt-1 font-mono text-xl font-bold tabular-nums ${pnlColor(dash.unrealizedPnlInr)}`}>
            {dash.unrealizedPnlInr >= 0 ? '+' : ''}
            {formatInr(dash.unrealizedPnlInr)}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-slate-400">
            Est. 4-leg charges: ₹{estCharges.toFixed(2)}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-400">Realized P&amp;L</div>
          <div className={`mt-1 font-mono text-xl font-bold tabular-nums ${pnlColor(dash.realizedPnlInr)}`}>
            {dash.realizedPnlInr >= 0 ? '+' : ''}
            {formatInr(dash.realizedPnlInr)}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-slate-400">
            Closed trades: {dash.counters.tradesClosed}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-400">Available Cash</div>
          <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">{formatInr(dash.cash)}</div>
          <div className="mt-0.5 font-mono text-[11px] text-slate-400">
            Started with {formatInr(dash.startingCapitalInr)}
          </div>
        </div>
      </div>

      {/* Open Paper Positions Table */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-slate-900">Open Paper Positions ({positions.length})</h2>
            <p className="text-xs text-slate-400">
              Live Angel One Bid/Ask valuation every 3s · Shows both Net Spread and Individual Option Legs (Buy + Sell Hedge)
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-[#008F6B]">
            <span className="h-2 w-2 rounded-full bg-[#00B386]" />
            <span>Real-time L1 Bid/Ask</span>
          </span>
        </div>

        {positions.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">No open positions on the ledger right now.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 text-xs font-medium text-slate-400">
                <tr>
                  <th className="pb-3 pr-3">Opened</th>
                  <th className="pb-3 pr-3">Contract / Leg</th>
                  <th className="pb-3 pr-3">Strategy / Token</th>
                  <th className="pb-3 pr-3 text-right">Lots (Qty)</th>
                  <th className="pb-3 pr-3 text-right">Entry Price</th>
                  <th className="pb-3 pr-3 text-right">Now (Bid/Ask)</th>
                  <th className="pb-3 pr-3 text-right">Market P&amp;L (MTM)</th>
                  <th className="pb-3 pr-3 text-right">After Charges</th>
                  <th className="pb-3 text-right">Terminal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {positions.map((p) => {
                  const units = p.lots * p.plan.lotSize;
                  const nowSpread = p.lastMark ? p.lastMark.liquidationValue : p.plan.entryDebit;
                  const spreadDiff = nowSpread - p.plan.entryDebit;
                  const spreadPct = p.plan.entryDebit > 0 ? (spreadDiff / p.plan.entryDebit) * 100 : 0;

                  const longBid = p.lastMark?.longBid ?? p.plan.long.bid;
                  const longAsk = p.lastMark?.longAsk ?? p.plan.long.ask;
                  const longPnl = p.longLegPnlInr ?? Number(((longBid - p.plan.long.ask) * units).toFixed(2));

                  const shortBid = p.lastMark?.shortBid ?? p.plan.short.bid;
                  const shortAsk = p.lastMark?.shortAsk ?? p.plan.short.ask;
                  const shortPnl = p.shortLegPnlInr ?? Number(((p.plan.short.bid - shortAsk) * units).toFixed(2));

                  const netAfterCharges = p.netUnrealizedInr ?? p.unrealizedInr;
                  const charges = p.estChargesInr ?? 151.25;
                  const lvls = exitLevels(p.plan, dash.config, {
                    peakValue: Math.max(p.confirmedPeakValue ?? p.peakValue ?? nowSpread, nowSpread),
                    sessionsHeld: p.sessionsHeld,
                    runnerArmed: p.runnerArmed,
                    previousFloor: p.runnerFloor,
                    previousFloorV31: p.runnerFloorV31,
                    previousFloorLearned: p.runnerFloorLearned,
                    variant: p.exitRuleVersion ?? 'ADAPTIVE_LEARNED',
                    learnedKeepFrac: p.learnedKeepFrac,
                    learnedEarlyStopTightened: p.learnedEarlyStopTightened,
                  });

                  return (
                    <React.Fragment key={p.id}>
                      {/* Parent Spread Row */}
                      <tr
                        onClick={() =>
                          onOpenTerminal({ kind: 'position', id: p.id, underlying: p.underlying, position: p })
                        }
                        className="cursor-pointer bg-white transition hover:bg-slate-50"
                      >
                        <td className="py-3.5 pr-3 font-mono text-xs text-slate-500">{formatIst(p.openedAt)}</td>
                        <td className="py-3.5 pr-3">
                          <div className="font-bold text-slate-900">
                            {p.underlying} {formatExpiryLabel(p.plan.expiry)} {p.plan.long.strike}/{p.plan.short.strike} {p.direction}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            Floor <strong className={lvls.stop > p.plan.entryDebit ? 'text-[#008F6B]' : 'text-amber-700'}>₹{lvls.stop.toFixed(2)}</strong> ({lvls.stage.replace('_', ' ')}) · Peak ₹{lvls.peakValue.toFixed(2)} · Target ₹{lvls.target.toFixed(2)}
                            {typeof p.learnedRunnerProb === 'number' ? (
                              <span className="ml-1.5 text-indigo-700">
                                · P(Runner≥60%) {(p.learnedRunnerProb * 100).toFixed(0)}% · Keep {((p.learnedKeepFrac ?? 0.8) * 100).toFixed(0)}%
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="py-3.5 pr-3 text-xs text-slate-600">{p.strategy.replace('_', ' ')}</td>
                        <td className="py-3.5 pr-3 text-right font-mono tabular-nums text-slate-700">
                          {p.lots} ({units})
                        </td>
                        <td className="py-3.5 pr-3 text-right font-mono font-medium tabular-nums text-slate-800">
                          ₹{p.plan.entryDebit.toFixed(2)}
                        </td>
                        <td className="py-3.5 pr-3 text-right font-mono font-semibold tabular-nums text-slate-900">
                          <div>₹{nowSpread.toFixed(2)}</div>
                          <div className={`text-[11px] font-medium ${spreadDiff >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'}`}>
                            {spreadDiff >= 0 ? '+' : ''}
                            {spreadDiff.toFixed(2)} ({spreadPct >= 0 ? '+' : ''}
                            {spreadPct.toFixed(2)}%)
                          </div>
                        </td>
                        <td className={`py-3.5 pr-3 text-right font-mono font-bold tabular-nums ${pnlColor(p.unrealizedInr)}`}>
                          <div>
                            {p.unrealizedInr >= 0 ? '+' : ''}
                            {formatInr(p.unrealizedInr)}
                          </div>
                          <div className="text-[10px] font-normal text-slate-400">
                            (Now - Entry) × {units}
                          </div>
                        </td>
                        <td className="py-3.5 pr-3 text-right font-mono tabular-nums">
                          <div className={`text-xs font-semibold ${pnlColor(netAfterCharges)}`}>
                            {netAfterCharges >= 0 ? '+' : ''}
                            {formatInr(netAfterCharges)}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            Est. ₹{charges.toFixed(0)} charges
                          </div>
                        </td>
                        <td className="py-3.5 text-right">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenTerminal({ kind: 'position', id: p.id, underlying: p.underlying, position: p });
                            }}
                            className="rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-[#008F6B] hover:bg-emerald-100"
                          >
                            🕯 Chart
                          </button>
                        </td>
                      </tr>

                      {/* Sub-Row 1: BUY Leg (Long Option) */}
                      <tr
                        onClick={() =>
                          onOpenTerminal({ kind: 'position', id: p.id, underlying: p.underlying, position: p })
                        }
                        className="cursor-pointer bg-slate-50/50 text-xs transition hover:bg-slate-100/70"
                      >
                        <td className="py-2 pr-3 pl-4 font-mono text-[11px] text-slate-400">↳ Leg 1</td>
                        <td className="py-2 pr-3">
                          <span className="mr-2 rounded bg-[#00B386] px-1.5 py-0.5 text-[10px] font-bold text-white">
                            BUY
                          </span>
                          <span className="font-semibold text-slate-800">
                            {p.underlying} {formatExpiryLabel(p.plan.expiry)} {p.plan.long.strike} {p.direction}
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-[11px] text-slate-500">
                          {p.plan.long.symbol} (#{p.plan.long.token})
                        </td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums text-slate-600">
                          +{units}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums text-slate-700">
                          ₹{p.plan.long.ask.toFixed(2)} <span className="text-[10px] text-slate-400">(Ask)</span>
                        </td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums text-slate-800">
                          ₹{longBid.toFixed(2)} <span className="text-[10px] text-slate-400">/ ₹{longAsk.toFixed(2)}</span>
                        </td>
                        <td className={`py-2 pr-3 text-right font-mono font-semibold tabular-nums ${pnlColor(longPnl)}`}>
                          {longPnl >= 0 ? '+' : ''}
                          {formatInr(longPnl)}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono text-[11px] text-slate-400">Long Leg</td>
                        <td className="py-2 text-right" />
                      </tr>

                      {/* Sub-Row 2: SELL Leg (Short Hedge Option) */}
                      <tr
                        onClick={() =>
                          onOpenTerminal({ kind: 'position', id: p.id, underlying: p.underlying, position: p })
                        }
                        className="cursor-pointer bg-slate-50/50 text-xs transition hover:bg-slate-100/70"
                      >
                        <td className="py-2 pr-3 pl-4 font-mono text-[11px] text-slate-400">↳ Leg 2</td>
                        <td className="py-2 pr-3">
                          <span className="mr-2 rounded bg-[#EB5B3C] px-1.5 py-0.5 text-[10px] font-bold text-white">
                            SELL
                          </span>
                          <span className="font-semibold text-slate-800">
                            {p.underlying} {formatExpiryLabel(p.plan.expiry)} {p.plan.short.strike} {p.direction}
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-[11px] text-slate-500">
                          {p.plan.short.symbol} (#{p.plan.short.token})
                        </td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums text-slate-600">
                          -{units}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums text-slate-700">
                          ₹{p.plan.short.bid.toFixed(2)} <span className="text-[10px] text-slate-400">(Bid)</span>
                        </td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums text-slate-800">
                          ₹{shortAsk.toFixed(2)} <span className="text-[10px] text-slate-400">(Ask to close)</span>
                        </td>
                        <td className={`py-2 pr-3 text-right font-mono font-semibold tabular-nums ${pnlColor(shortPnl)}`}>
                          {shortPnl >= 0 ? '+' : ''}
                          {formatInr(shortPnl)}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono text-[11px] text-slate-400">Short Hedge</td>
                        <td className="py-2 text-right" />
                      </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Closed Paper Trades */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
        <h2 className="mb-3 text-base font-bold text-slate-900">Closed Paper Trades ({trades.length})</h2>
        {trades.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">
            No closed trades on this ledger yet. Open positions close when they hit take-profit, stop-loss, time-stop, or expiry risk rules.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 text-xs font-medium text-slate-400">
                <tr>
                  <th className="pb-2.5 pr-3">Closed</th>
                  <th className="pb-2.5 pr-3">Contract Setup</th>
                  <th className="pb-2.5 pr-3">Exit Reason</th>
                  <th className="pb-2.5 pr-3 text-right">Net P&amp;L</th>
                  <th className="pb-2.5 text-right">R Multiple</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {trades.slice(0, 50).map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50">
                    <td className="py-2.5 pr-3 font-mono text-xs text-slate-500">{formatIst(t.closedAt)}</td>
                    <td className="py-2.5 pr-3 font-medium text-slate-800">
                      {t.underlying} {t.longStrike}/{t.shortStrike} {t.direction} ({t.strategy})
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-slate-600">{t.exitReason}</td>
                    <td className={`py-2.5 pr-3 text-right font-mono font-semibold tabular-nums ${pnlColor(t.netPnlInr)}`}>
                      {formatInr(t.netPnlInr)}
                    </td>
                    <td className={`py-2.5 text-right font-mono font-semibold tabular-nums ${pnlColor(t.rMultiple)}`}>
                      {formatSigned(t.rMultiple, 2)}R
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function OrdersAndSignals({
  candidates,
  closedCandidates,
  decisionLog,
  config,
  onOpenTerminal,
}: {
  candidates: Candidate[];
  closedCandidates: Candidate[];
  decisionLog: Array<{ t: string; kind: string; message: string }>;
  config: DashboardPayload['config'];
  onOpenTerminal: (t: TerminalTarget) => void;
}) {
  const allRows = [...candidates, ...closedCandidates].slice(0, 40);
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
        <div className="mb-3">
          <h2 className="text-base font-bold text-slate-900">Tracked Signal Candidates ({allRows.length})</h2>
          <p className="text-xs text-slate-400">
            Every priced signal is followed to its exit on real order-book quotes, including signals skipped by portfolio risk limits. Closed candidates train the model.
          </p>
        </div>

        {allRows.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">No signal candidates yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 text-xs font-medium text-slate-400">
                <tr>
                  <th className="pb-2.5 pr-3">Time</th>
                  <th className="pb-2.5 pr-3">Spread Contract</th>
                  <th className="pb-2.5 pr-3">Strategy &amp; Reason</th>
                  <th className="pb-2.5 pr-3 text-right">Model P(Win)</th>
                  <th className="pb-2.5 pr-3">Ledger Status</th>
                  <th className="pb-2.5 pr-3 text-right">Outcome (1 Lot)</th>
                  <th className="pb-2.5 text-right">Terminal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {allRows.map((c) => {
                  const liveLiq = c.lastMark?.liquidationValue ?? c.plan.entryDebit;
                  const liveOneLotPnl = Math.round((liveLiq - c.plan.entryDebit) * c.plan.lotSize);
                  const lvls = exitLevels(c.plan, config, {
                    peakValue: Math.max(c.confirmedPeakValue ?? c.peakValue ?? liveLiq, liveLiq),
                    sessionsHeld: c.sessionsHeld,
                    runnerArmed: c.runnerArmed,
                    previousFloor: c.runnerFloor,
                    previousFloorV31: c.runnerFloorV31,
                    previousFloorLearned: c.runnerFloorLearned,
                    variant: c.exitRuleVersion ?? 'ADAPTIVE_LEARNED',
                    learnedKeepFrac: c.learnedKeepFrac,
                    learnedEarlyStopTightened: c.learnedEarlyStopTightened,
                  });
                  return (
                    <tr
                      key={c.id}
                      onClick={() => onOpenTerminal({ kind: 'candidate', id: c.id, underlying: c.underlying, candidate: c })}
                      className="cursor-pointer hover:bg-slate-50"
                    >
                      <td className="py-3 pr-3 font-mono text-xs text-slate-500">{formatIst(c.createdAt)}</td>
                      <td className="py-3 pr-3 font-semibold text-slate-900">
                        {c.underlying} {formatExpiryLabel(c.plan.expiry)} {c.plan.long.strike}/{c.plan.short.strike} {c.direction}
                      </td>
                      <td className="py-3 pr-3 text-xs text-slate-600">
                        <span className="font-medium text-slate-800">{c.strategy.replace('_', ' ')}</span> · {c.reason}
                      </td>
                      <td className="py-3 pr-3 text-right font-mono text-xs text-slate-700 tabular-nums">
                        {c.modelProb !== null ? formatPct(c.modelProb * 100, 1) : '—'}
                      </td>
                      <td className="py-3 pr-3">
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-semibold ${
                            c.takenByLedger
                              ? 'bg-emerald-50 text-[#008F6B]'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {c.takenByLedger ? 'Taken by Ledger' : c.skipReason || 'Shadow Only'}
                        </span>
                      </td>
                      <td className="py-3 pr-3 text-right font-mono tabular-nums">
                        {c.pnlPerLotInr !== undefined ? (
                          <div className={`font-semibold ${pnlColor(c.pnlPerLotInr)}`}>
                            {c.pnlPerLotInr >= 0 ? '+' : ''}
                            {formatInr(c.pnlPerLotInr)}
                            <div className="text-[10px] font-normal text-slate-400">Closed · Trained Model</div>
                          </div>
                        ) : (
                          <div>
                            <div className={`font-semibold ${pnlColor(liveOneLotPnl)}`}>
                              {liveOneLotPnl >= 0 ? '+' : ''}
                              {formatInr(liveOneLotPnl)}
                            </div>
                            <div className="text-[10px] text-slate-400">
                              ₹{c.plan.entryDebit.toFixed(2)} → ₹{liveLiq.toFixed(2)} · Floor ₹{lvls.stop.toFixed(2)}
                              {typeof c.learnedRunnerProb === 'number' ? (
                                <span className="ml-1 text-indigo-600">
                                  · Keep {((c.learnedKeepFrac ?? 0.8) * 100).toFixed(0)}%
                                </span>
                              ) : null}
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="py-3 text-right">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenTerminal({ kind: 'candidate', id: c.id, underlying: c.underlying, candidate: c });
                          }}
                          className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                        >
                          🕯 View
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <LogList title="Recent Engine Decisions" rows={decisionLog.slice(0, 20)} />
    </div>
  );
}

function Performance({ dash, research }: { dash: DashboardPayload; research: ResearchView | null }) {
  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <h2 className="text-lg font-bold text-slate-900">Live Paper Ledger Scorecards</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <ScoreTable title="By strategy" rows={dash.tradeScorecards.byStrategy} money="Net ₹" />
          <ScoreTable title="By underlying" rows={dash.tradeScorecards.byUnderlying} money="Net ₹" />
          <ScoreTable title="By regime" rows={dash.tradeScorecards.byRegime} money="Net ₹" />
          <ScoreTable title="By exit" rows={dash.tradeScorecards.byExit} money="Net ₹" />
        </div>
        <ScoreTable title="Shadow candidates by strategy (per lot)" rows={dash.candidateScorecards.byStrategy} money="₹/lot" />
      </section>

      <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
        <div>
          <h2 className="text-base font-bold text-slate-900">One-Year Research Prior (Real Hourly Spot + Model Option Marks)</h2>
          {!research ? (
            <p className="mt-2 text-sm text-slate-400">Loading 1-year research report…</p>
          ) : (
            <>
              <p className="mt-1 text-xs text-slate-500">{research.disclaimer}</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
                  <div className="text-xs text-slate-400">Model-priced trades</div>
                  <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">{research.summary.n}</div>
                  {research.summary.winRate !== null ? (
                    <div className="mt-0.5 text-xs font-medium text-[#008F6B]">
                      {formatPct(research.summary.winRate * 100)} winners
                    </div>
                  ) : null}
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
                  <div className="text-xs text-slate-400">Average R Multiple (Raw)</div>
                  <div className={`mt-1 font-mono text-xl font-bold tabular-nums ${pnlColor(research.summary.avgR)}`}>
                    {formatSigned(research.summary.avgR, 3)}
                  </div>
                  {research.summary.rCi90 ? (
                    <div className="mt-0.5 text-xs text-slate-500">
                      90% CI {research.summary.rCi90.map((x) => x.toFixed(3)).join(' to ')}
                    </div>
                  ) : null}
                </div>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
                  <div className="text-xs font-semibold text-[#008F6B]">Walk-Forward ML Gate (OOS)</div>
                  <div className="mt-1 font-mono text-xl font-bold text-[#008F6B] tabular-nums">
                    {formatSigned(research.walkForward?.oos.acceptedAvgR ?? research.gatedSummary?.avgR ?? null, 3)}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-600">
                    AUC {research.walkForward?.oos.auc ? research.walkForward.oos.auc.toFixed(3) : '—'} ·{' '}
                    {research.walkForward?.oos.acceptedN ?? research.gatedSummary?.n ?? 0} OOS accepted
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
                  <div className="text-xs text-slate-400">Opposite-Direction Baseline</div>
                  <div className={`mt-1 font-mono text-xl font-bold tabular-nums ${pnlColor(research.oppositeDirectionBaseline.avgR)}`}>
                    {formatSigned(research.oppositeDirectionBaseline.avgR, 3)}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">{research.oppositeDirectionBaseline.n} trades</div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 text-xs text-slate-600">
                <span>
                  A ₹{research.portfolio.startingCapitalInr.toLocaleString('en-IN')} walk-forward ML-gated replay ended at{' '}
                  <strong className="font-mono text-[#008F6B]">{formatInr(research.portfolio.endingEquityInr)}</strong> (
                  <strong className="font-mono text-[#008F6B]">{formatSigned(research.portfolio.returnPct, 1)}%</strong>), max drawdown{' '}
                  {formatPct(research.portfolio.maxDrawdownPct, 1)}.
                </span>
                {research.rawPortfolio ? (
                  <span className="font-mono text-[11px] text-slate-500">
                    Unfiltered raw baseline: {formatInr(research.rawPortfolio.endingEquityInr)} (
                    {formatSigned(research.rawPortfolio.returnPct, 1)}%)
                  </span>
                ) : null}
              </div>
              {research.runnerValidation ? (
                <div className="mt-4 space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-indigo-950">
                        Exit Engine Registry: LADDER_V2 vs. RUNNER_V3 vs. RUNNER_V3_1 (Winner) vs. ADAPTIVE_LEARNED (Self-Learning)
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-600">
                        {research.runnerValidation.mfeDistributionAt30.reached30Count} of{' '}
                        {research.runnerValidation.fixed30Summary.n} trades (
                        {(
                          (research.runnerValidation.mfeDistributionAt30.reached30Count /
                            Math.max(1, research.runnerValidation.fixed30Summary.n)) *
                          100
                        ).toFixed(1)}
                        %) reached ≥30% MFE.{' '}
                        {research.runnerValidation.mfeDistributionAt30.trendGatePassedCount} passed the 4-factor Trend
                        Gate. Active Engine: <strong>ADAPTIVE_LEARNED</strong> (built on winning <strong>RUNNER_V3_1</strong> taper + online Contextual Exit Policy).
                      </p>
                    </div>
                    <span className="rounded bg-indigo-100 px-2 py-0.5 font-mono text-[10px] font-semibold text-indigo-900">
                      ACTIVE: ADAPTIVE_LEARNED (RUNNER_V3_1 BASE)
                    </span>
                  </div>

                  {research.runnerValidation.challengerRegistry ? (
                    <>
                      <div className="overflow-x-auto rounded-lg border border-indigo-200/80 bg-white">
                        <table className="w-full text-left text-xs">
                          <thead className="border-b border-slate-200 bg-slate-50/80 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                            <tr>
                              <th className="px-3 py-2">Registered Engine</th>
                              <th className="px-3 py-2 text-right">Expectancy</th>
                              <th className="px-3 py-2 text-right">Avg R (90% CI)</th>
                              <th className="px-3 py-2 text-right">Capture Ratio</th>
                              <th className="px-3 py-2 text-right">Armed Runner Shake-Out</th>
                              <th className="px-3 py-2 text-right">Staller Protected (30–45%)</th>
                              <th className="px-3 py-2 text-right">Max DD</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                            {research.runnerValidation.challengerRegistry.variants.map((v) => (
                              <tr key={v.engine} className="hover:bg-slate-50/80">
                                <td className="px-3 py-2 font-sans">
                                  <div className="font-semibold text-slate-900">{v.label}</div>
                                  <div className="text-[10px] text-slate-500">{v.ruleSummary}</div>
                                </td>
                                <td className={`px-3 py-2 text-right font-bold ${pnlColor(v.expectancyPerLotInr)}`}>
                                  {formatInr(v.expectancyPerLotInr)}/lot
                                </td>
                                <td className="px-3 py-2 text-right text-slate-700">
                                  {formatSigned(v.avgR, 4)}
                                  {v.rCi90 ? (
                                    <div className="text-[9.5px] text-slate-400">
                                      [{v.rCi90[0].toFixed(3)}, {v.rCi90[1].toFixed(3)}]
                                    </div>
                                  ) : null}
                                </td>
                                <td className="px-3 py-2 text-right text-slate-700">
                                  {v.captureRatioMean.toFixed(1)}%
                                  {v.captureRatioCi90 ? (
                                    <div className="text-[9.5px] text-slate-400">
                                      [{v.captureRatioCi90[0].toFixed(1)}%, {v.captureRatioCi90[1].toFixed(1)}%]
                                    </div>
                                  ) : null}
                                </td>
                                <td className="px-3 py-2 text-right text-slate-700">
                                  {v.armedRunnerShakeOutCount}/{v.armedRunnerShakeOutTotal} (
                                  {v.armedRunnerShakeOutRatePct.toFixed(0)}%)
                                  <div className="text-[9.5px] text-slate-400">
                                    All ≥60%: {v.runnerShakeOutCount}/{v.runnerShakeOutTotal}
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right text-slate-700">
                                  {v.stallerProtectedCount}/{v.stallerTotal} ({v.stallerProtectedRatePct.toFixed(1)}%)
                                  <div className="text-[9.5px] text-[#008F6B]">
                                    Armed avg: {formatInr(v.stallerArmedMeanPnlInr)}
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right text-slate-700">{v.maxDrawdownPct.toFixed(1)}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="grid gap-2 sm:grid-cols-3">
                        {research.runnerValidation.challengerRegistry.pairedComparisons.map((p) => (
                          <div key={p.pair} className="rounded-lg border border-indigo-200/70 bg-white px-3 py-2">
                            <div className="text-[10.5px] font-semibold text-slate-700">{p.pair}</div>
                            <div className={`mt-0.5 font-mono text-xs font-bold ${pnlColor(p.meanDiffInr)}`}>
                              Δ {p.meanDiffInr >= 0 ? '+' : ''}
                              {formatInr(p.meanDiffInr)}/lot ({formatSigned(p.meanDiffR, 4)} R)
                            </div>
                            <div className="font-mono text-[10px] text-slate-500">
                              90% CI:{' '}
                              {p.diffInrCi90
                                ? `[${formatInr(p.diffInrCi90[0])}, ${formatInr(p.diffInrCi90[1])}]`
                                : '—'}
                            </div>
                            <div className="mt-0.5 font-mono text-[9.5px] text-slate-500">
                              t={p.tStat.toFixed(2)} · p={p.rawPValue.toFixed(3)} · Holm p_adj=
                              {p.holmAdjustedPValue.toFixed(3)}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="rounded-lg border border-indigo-200/70 bg-white px-3 py-2 text-[11px] text-slate-700">
                        <strong className="text-indigo-950">Shake-Out vs. Staller Protection Verdict:</strong>{' '}
                        {research.runnerValidation.challengerRegistry.shakeOutBreakeven.verdict}
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-4">
                <ScoreTable title="1-Year Research by Strategy" rows={research.byStrategy} money="₹/lot" />
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function Learning({ dash }: { dash: DashboardPayload }) {
  const model = dash.model;
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-slate-900">Walk-Forward Logistic Regression Gate</h2>
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-[#008F6B]">
            Fast Adaptation · Retrains Every Closed Trade (3.0× Live Weight)
          </span>
        </div>
        {model ? (
          <>
            <p className="mt-2 text-sm text-slate-700">{model.gate.reason}</p>
            <p className="mt-1 text-xs text-slate-400">
              Trained {formatIst(model.trainedAt)} on {model.nOffline} offline samples (weight {model.offlineWeight}) and{' '}
              {model.nLive} live samples (weight 3.0) · Version <span className="font-mono">{model.version}</span>
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
                <div className="text-xs text-slate-400">Offline Out-of-Sample AUC</div>
                <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
                  {model.offlineOos.auc === null ? '—' : model.offlineOos.auc.toFixed(3)}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{model.offlineOos.n} walk-forward predictions</div>
              </div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
                <div className="text-xs font-semibold text-[#008F6B]">Top-Half Gated Avg R (OOS)</div>
                <div className="mt-1 font-mono text-xl font-bold text-[#008F6B] tabular-nums">
                  {model.offlineOos.acceptedAvgR === null ? '—' : formatSigned(model.offlineOos.acceptedAvgR, 3)}
                </div>
                <div className="mt-0.5 text-xs text-slate-600">
                  vs {model.offlineOos.avgR === null ? '—' : formatSigned(model.offlineOos.avgR, 3)} unfiltered ({model.offlineOos.acceptedN} accepted)
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
                <div className="text-xs text-slate-400">Live Out-of-Sample AUC</div>
                <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
                  {model.liveOos.auc === null ? '—' : model.liveOos.auc.toFixed(3)}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{model.liveOos.n} live predictions (switches at 30)</div>
              </div>
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-slate-400">Model initializes on the first live cycle.</p>
        )}
      </section>

      {model?.exitPolicy ? (
        <section className="rounded-2xl border border-indigo-200 bg-white p-5 shadow-2xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Self-Learning Contextual Exit Policy (ADAPTIVE_LEARNED · Base: RUNNER_V3_1)
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {model.exitPolicy.summaryNote}
              </p>
            </div>
            <span className="rounded-full bg-indigo-50 px-3 py-1 font-mono text-xs font-semibold text-indigo-800">
              {model.exitPolicy.version} · Live Weight 10.0×
            </span>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-3.5">
              <div className="text-xs font-semibold text-indigo-900">OOS Expectancy (Adaptive Exit)</div>
              <div className="mt-1 font-mono text-xl font-bold text-[#008F6B] tabular-nums">
                {formatInr(model.exitPolicy.oosExpectancyInr)}/lot
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-slate-600">
                +{formatInr(model.exitPolicy.oosLiftOverLadderInr)} vs v2 · +{formatInr(model.exitPolicy.oosLiftOverV31Inr)} vs v3.1
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3.5">
              <div className="text-xs text-slate-500">Runner Continuation Head (≥60% MFE)</div>
              <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
                AUC {model.exitPolicy.runnerOosAuc === null ? '—' : model.exitPolicy.runnerOosAuc.toFixed(3)}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                Trained on {model.exitPolicy.nReached30} trades reaching ≥30% MFE
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3.5">
              <div className="text-xs text-slate-500">Early Stop Tightening Head</div>
              <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
                AUC {model.exitPolicy.recoveryOosAuc === null ? '—' : model.exitPolicy.recoveryOosAuc.toFixed(3)}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                Tightens stop from -72% → -38% on stagnant trades
              </div>
            </div>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3.5">
              <div className="text-xs font-semibold text-[#008F6B]">Stagnant Stop Losses Saved</div>
              <div className="mt-1 font-mono text-xl font-bold text-[#008F6B] tabular-nums">
                {model.exitPolicy.oosEarlyStopsSavedCount} trades
              </div>
              <div className="mt-0.5 text-[11px] text-slate-600">
                Cut early before full -72% debit stop
              </div>
            </div>
          </div>

          <div className="mt-4">
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
              Top Learned Drivers of ≥60% Runner Continuation vs. Early Stall
            </h3>
            <div className="grid gap-2 sm:grid-cols-3">
              {model.exitPolicy.topRunnerDrivers.map((d) => (
                <div
                  key={d.feature}
                  className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-slate-50/60 px-3 py-2 text-xs"
                >
                  <div>
                    <div className="font-semibold text-slate-800">{d.feature}</div>
                    <div className="text-[10px] text-slate-500">
                      {d.weight >= 0 ? 'Favors ≥60% Runner' : 'Favors Early Stall / Tight Trail'}
                    </div>
                  </div>
                  <span className={`font-mono font-bold ${pnlColor(d.weight)}`}>
                    {d.weight >= 0 ? '+' : ''}
                    {d.weight.toFixed(3)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {dash.openPositions.length > 0 || dash.activeCandidates.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
                Live Self-Learning Exit Policy Decisions (Open Ledger &amp; Shadow Candidates)
              </h3>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Contract</th>
                      <th className="px-3 py-2 text-right">MFE %</th>
                      <th className="px-3 py-2 text-right">P(Runner ≥60%)</th>
                      <th className="px-3 py-2 text-right">P(Recovery)</th>
                      <th className="px-3 py-2 text-right">Learned Keep %</th>
                      <th className="px-3 py-2">Adaptive Exit Policy Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                    {dash.openPositions.map((p) => {
                      const pPeak = Math.max(p.plan.entryDebit, p.confirmedPeakValue ?? p.peakValue ?? p.plan.entryDebit);
                      const pMfePct = ((pPeak - p.plan.entryDebit) / Math.max(0.01, p.plan.width - p.plan.entryDebit)) * 100;
                      return (
                        <tr key={p.id} className="bg-emerald-50/30">
                          <td className="px-3 py-2 font-sans font-semibold text-slate-900">
                            [LEDGER] {p.underlying} {p.plan.long.strike}/{p.plan.short.strike} {p.direction}
                          </td>
                          <td className="px-3 py-2 text-right text-slate-700">{pMfePct.toFixed(1)}%</td>
                          <td className="px-3 py-2 text-right font-semibold text-indigo-700">
                            {((p.learnedRunnerProb ?? 0.5) * 100).toFixed(1)}%
                          </td>
                          <td className="px-3 py-2 text-right text-slate-700">
                            {((p.learnedRecoveryProb ?? 0.5) * 100).toFixed(1)}%
                          </td>
                          <td className="px-3 py-2 text-right font-bold text-[#008F6B]">
                            {((p.learnedKeepFrac ?? 0.8) * 100).toFixed(1)}%
                          </td>
                          <td className="px-3 py-2 font-sans text-[11px] text-slate-700">
                            {p.learnedExitAction ?? 'RUNNER_V3_1 Taper + Adaptive Ratchet'}
                          </td>
                        </tr>
                      );
                    })}
                    {dash.activeCandidates
                      .filter((c) => !c.takenByLedger)
                      .map((c) => {
                        const cPeak = Math.max(c.plan.entryDebit, c.confirmedPeakValue ?? c.peakValue ?? c.plan.entryDebit);
                        const cMfePct = ((cPeak - c.plan.entryDebit) / Math.max(0.01, c.plan.width - c.plan.entryDebit)) * 100;
                        return (
                          <tr key={c.id} className="hover:bg-slate-50">
                            <td className="px-3 py-2 font-sans font-medium text-slate-800">
                              [SHADOW] {c.underlying} {c.plan.long.strike}/{c.plan.short.strike} {c.direction}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-700">{cMfePct.toFixed(1)}%</td>
                            <td className="px-3 py-2 text-right font-semibold text-indigo-700">
                              {((c.learnedRunnerProb ?? 0.5) * 100).toFixed(1)}%
                            </td>
                            <td className="px-3 py-2 text-right text-slate-700">
                              {((c.learnedRecoveryProb ?? 0.5) * 100).toFixed(1)}%
                            </td>
                            <td className="px-3 py-2 text-right font-bold text-[#008F6B]">
                              {((c.learnedKeepFrac ?? 0.8) * 100).toFixed(1)}%
                            </td>
                            <td className="px-3 py-2 font-sans text-[11px] text-slate-600">
                              {c.learnedExitAction ?? 'RUNNER_V3_1 Taper + Adaptive Ratchet'}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {model && model.calibration.length > 0 ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
          <h2 className="mb-3 text-base font-bold text-slate-900">Probability Calibration</h2>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 text-xs font-medium text-slate-400">
              <tr>
                <th className="pb-2">Predicted Win Prob</th>
                <th className="pb-2">Observed Win Rate</th>
                <th className="pb-2 text-right">Samples</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {model.calibration.map((b) => (
                <tr key={`${b.lo}-${b.hi}`}>
                  <td className="py-2.5 font-mono tabular-nums text-slate-800">{formatPct(b.avgPred * 100)}</td>
                  <td className="py-2.5 font-mono tabular-nums text-slate-800">{formatPct(b.winRate * 100)}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums text-slate-500">{b.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {model ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
          <h2 className="mb-3 text-base font-bold text-slate-900">Standardized Feature Weights</h2>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {model.featureNames.map((name, i) => (
              <li
                key={name}
                className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2"
              >
                <span className="text-slate-700">{name}</span>
                <span className={`font-mono font-semibold tabular-nums ${pnlColor(model.weights[i])}`}>
                  {model.weights[i]?.toFixed(3)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <LogList title="Learning & Retraining Log" rows={dash.learningLog} />
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
    <div className="space-y-6 text-sm leading-6 text-slate-600">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
        <h2 className="mb-2 text-base font-bold text-slate-900">Execution &amp; Dynamic Profit-Ratchet Exit Rules</h2>
        <p>
          Spot and option prices come directly from Angel One SmartAPI. Every vertical debit spread buys the long leg at the live ask and sells the short leg at the live bid, and reverses on exit. Brokerage is ₹20 per order plus STT, NSE exchange fees, stamp duty, and 18% GST.
        </p>
        <p className="mt-2">
          Instead of a rigid binary stop, exits use a <strong>Self-Learning Contextual Exit Policy (ADAPTIVE_LEARNED)</strong> built on top of the winning <strong>RUNNER_V3_1</strong> tapered ratchet and each spread&apos;s confirmed high-water mark (MFE as % of Max Gain):
          (1) Initial Stop at -{formatPct(cfg.stopLossFracOfDebit * 100, 0)} of debit (with online ML early stop tightening to -38% when a trade stagnates across ≥3 sessions with low recovery probability);
          (2) Risk-Halving Ratchet at 11% MFE (cuts max loss in half to -32%);
          (3) Break-Even + Brokerage/STT Cost-Recovery Floor at 16% MFE (locks in entry debit + 5%–10% of max gain);
          (4) High-Water-Mark Profit-Lock Trail at 22%–29.9% MFE (locks in +10% to +20% of max gain);
          (5) At ≥30% MFE, evaluates the 4-factor Trend Gate + online ML Runner Continuation Head: either banks 30% TAKE_PROFIT immediately when runner continuation probability is low, or arms Runner Mode with a learned keep fraction (66.7%–83% tapering to 66.7% at 60% MFE) up to a 75% ceiling.
        </p>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
        <h2 className="mb-3 text-base font-bold text-slate-900">Real-Money Readiness Checklist</h2>
        <ul className="space-y-2">
          {dash.readiness.checks.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/60 px-3.5 py-2.5"
            >
              <span className="font-medium text-slate-800">{c.label}</span>
              <span
                className={`font-mono text-xs font-semibold ${
                  c.pass ? 'text-[#00B386]' : 'text-slate-400'
                }`}
              >
                {c.pass ? 'PASS' : 'PENDING'} · {c.detail}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
        <h2 className="mb-2 text-base font-bold text-slate-900">Admin Ledger Controls</h2>
        <p className="mb-3 text-xs text-slate-400">
          Enter ADMIN_SECRET (or DASHBOARD_PASSCODE) to pause entries, force a model retrain, or reset the ₹50,000 ledger.
        </p>
        <input
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          type="password"
          placeholder="Admin secret"
          className="mb-3 w-full max-w-sm rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-900 focus:border-[#00B386] focus:bg-white focus:outline-none"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            onClick={() => onAdmin('pause')}
          >
            Pause entries
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            onClick={() => onAdmin('resume')}
          >
            Resume entries
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            onClick={() => onAdmin('retrain')}
          >
            Retrain next cycle
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            onClick={() => onAdmin('ack_kill_switch')}
          >
            Acknowledge kill switch
          </button>
          <button
            type="button"
            className="rounded-lg bg-[#EB5B3C] px-3.5 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            onClick={() => onAdmin('reset_ledger')}
          >
            Reset to ₹50,000
          </button>
        </div>
        {adminNote ? <p className="mt-2 text-xs font-medium text-slate-600">{adminNote}</p> : null}
      </section>
    </div>
  );
}

function LogList({ title, rows }: { title: string; rows: Array<{ t: string; kind: string; message: string }> }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
      <h2 className="mb-3 text-base font-bold text-slate-900">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">No entries yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-xs">
          {rows.map((row, i) => (
            <li key={`${row.t}-${i}`} className="flex flex-wrap items-baseline gap-3 py-2">
              <span className="w-28 shrink-0 font-mono text-slate-400">{formatIst(row.t)}</span>
              <span className="w-20 shrink-0 font-mono font-semibold text-slate-600">{row.kind}</span>
              <span className="flex-1 text-slate-700">{row.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
