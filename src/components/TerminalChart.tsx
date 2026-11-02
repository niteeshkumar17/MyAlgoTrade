import React, { useEffect, useMemo, useState } from 'react';
import { formatInr, formatIst } from '../quant/format';
import type { TerminalCandleResponse, TerminalInterval } from '../quant/terminalCandles';
import type { Candidate, Candle, OptionRight, PaperPosition, SpotQuote } from '../quant/types';
import { UNDERLYINGS } from '../quant/types';

export interface TerminalTarget {
  kind: 'position' | 'candidate' | 'underlying';
  id: string;
  underlying: string;
  position?: PaperPosition;
  candidate?: Candidate;
}

export type LegViewMode = 'long' | 'short' | 'spread' | 'spot';

function computeEmaSeries(closes: number[], period: number): Array<number | null> {
  const k = 2 / (period + 1);
  const out: Array<number | null> = [];
  let ema: number | null = null;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    if (ema === null) {
      ema = c;
    } else {
      ema = c * k + ema * (1 - k);
    }
    out.push(i >= period - 1 ? ema : null);
  }
  return out;
}

function formatExpiryShort(expiry: string): string {
  const d = new Date(`${expiry}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return expiry;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${day} ${mon}`;
}

function formatVolumeCompact(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(Math.round(v));
}

function formatAxisTime(iso: string, interval: TerminalInterval): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const ist = new Date(ms + 5.5 * 3600_000);
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  if (hh === '09' && mm === '15') {
    const day = ist.getUTCDate();
    const mon = ist.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    return `${day} ${mon}`;
  }
  if (interval === '1h' && mm === '15' && hh === '10') {
    return `${ist.getUTCDate()}`;
  }
  return `${hh}:${mm}`;
}

export const TerminalChart: React.FC<{
  target: TerminalTarget;
  positions: PaperPosition[];
  candidates: Candidate[];
  spots: Record<string, SpotQuote>;
  takeProfitFrac: number;
  stopLossFrac: number;
  onSelectTarget: (t: TerminalTarget) => void;
  onBackToOverview?: () => void;
}> = ({
  target,
  positions,
  candidates,
  spots,
  takeProfitFrac,
  stopLossFrac,
  onSelectTarget,
  onBackToOverview,
}) => {
  const [interval, setIntervalState] = useState<TerminalInterval>('5m');
  const [legMode, setLegMode] = useState<LegViewMode>(() =>
    target.kind === 'underlying' ? 'spot' : 'long'
  );
  const [showIndicators, setShowIndicators] = useState(false);
  const [showLevels, setShowLevels] = useState(true);
  const [rangeZoom, setRangeZoom] = useState<'1d' | '5d' | '1m' | 'all'>('5d');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [data, setData] = useState<TerminalCandleResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [istClock, setIstClock] = useState('');

  useEffect(() => {
    if (target.kind === 'underlying') {
      setLegMode('spot');
    } else if (legMode === 'spot') {
      setLegMode('long');
    }
  }, [target.id, target.kind]);

  useEffect(() => {
    const updateClock = () => {
      const d = new Date(Date.now() + 5.5 * 3600_000);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      const ss = String(d.getUTCSeconds()).padStart(2, '0');
      setIstClock(`${hh}:${mm}:${ss} UTC+5:30`);
    };
    updateClock();
    const timer = setInterval(updateClock, 1000);
    return () => clearInterval(timer);
  }, []);

  const activePlan = target.position?.plan ?? target.candidate?.plan ?? null;
  const activeMark = target.position?.lastMark ?? target.candidate?.lastMark ?? null;

  useEffect(() => {
    let cancelled = false;
    const fetchCandles = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          underlying: target.underlying,
          interval,
        });

        if (activePlan && legMode !== 'spot') {
          params.set('exchange', 'NFO');
          params.set('expiry', activePlan.expiry);
          params.set('right', activePlan.right);
          if (legMode === 'long') {
            params.set('token', activePlan.long.token);
            params.set('strike', String(activePlan.long.strike));
            params.set('liveBid', String(activeMark?.longBid ?? activePlan.long.bid));
            params.set('liveAsk', String(activeMark?.longAsk ?? activePlan.long.ask));
          } else if (legMode === 'short') {
            params.set('token', activePlan.short.token);
            params.set('strike', String(activePlan.short.strike));
            params.set('liveBid', String(activeMark?.shortBid ?? activePlan.short.bid));
            params.set('liveAsk', String(activeMark?.shortAsk ?? activePlan.short.ask));
          } else if (legMode === 'spread') {
            params.set('token', activePlan.long.token);
            params.set('strike', String(activePlan.long.strike));
            params.set('shortToken', activePlan.short.token);
            params.set('shortStrike', String(activePlan.short.strike));
            params.set('liveBid', String(activeMark?.longBid ?? activePlan.long.bid));
            params.set('liveAsk', String(activeMark?.longAsk ?? activePlan.long.ask));
            params.set('shortBid', String(activeMark?.shortBid ?? activePlan.short.bid));
            params.set('shortAsk', String(activeMark?.shortAsk ?? activePlan.short.ask));
          }
        } else {
          params.set('exchange', 'NSE');
        }

        const res = await fetch(`/api/candles?${params.toString()}`);
        if (!res.ok) throw new Error('Failed to load candles');
        const payload = (await res.json()) as TerminalCandleResponse;
        if (!cancelled) {
          setData(payload);
          setHoverIdx(null);
        }
      } catch {
        // retain previous chart if transient error
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchCandles();
    return () => {
      cancelled = true;
    };
  }, [target.id, target.underlying, interval, legMode, activePlan, activeMark?.at]);

  const visibleCandles: Candle[] = useMemo(() => {
    const all = data?.candles ?? [];
    if (all.length === 0) return [];
    const counts = { '1d': 45, '5d': 85, '1m': 115, all: all.length };
    const take = counts[rangeZoom] ?? 85;
    return all.slice(-take);
  }, [data?.candles, rangeZoom]);

  const ema20 = useMemo(() => computeEmaSeries(visibleCandles.map((c) => c.close), 20), [visibleCandles]);
  const ema50 = useMemo(() => computeEmaSeries(visibleCandles.map((c) => c.close), 50), [visibleCandles]);

  const contractMeta = useMemo(() => {
    const rightWord = (r: OptionRight) => (r === 'CE' ? 'Call' : 'Put');
    const intervalTag = interval === '5m' ? '5' : interval === '15m' ? '15' : '1h';
    if (activePlan && legMode !== 'spot') {
      const exp = formatExpiryShort(activePlan.expiry);
      if (legMode === 'long') {
        return {
          searchLabel: `${activePlan.underlying} ${exp.toUpperCase()} ${activePlan.long.strike} ${activePlan.right}`,
          chartTitle: `${activePlan.underlying} ${exp} ${activePlan.long.strike} ${rightWord(activePlan.right)} · ${intervalTag} · NSE`,
          pillLabel: `${activePlan.underlying} ${exp} ${activePlan.long.strike} ${rightWord(activePlan.right)}`,
        };
      }
      if (legMode === 'short') {
        return {
          searchLabel: `${activePlan.underlying} ${exp.toUpperCase()} ${activePlan.short.strike} ${activePlan.right}`,
          chartTitle: `${activePlan.underlying} ${exp} ${activePlan.short.strike} ${rightWord(activePlan.right)} · ${intervalTag} · NSE`,
          pillLabel: `${activePlan.underlying} ${exp} ${activePlan.short.strike} ${rightWord(activePlan.right)}`,
        };
      }
      return {
        searchLabel: `${activePlan.underlying} ${exp.toUpperCase()} ${activePlan.long.strike}/${activePlan.short.strike} ${activePlan.right}`,
        chartTitle: `${activePlan.underlying} ${exp} ${activePlan.long.strike}/${activePlan.short.strike} ${rightWord(activePlan.right)} Spread · ${intervalTag} · NSE`,
        pillLabel: `Spread ${activePlan.long.strike}/${activePlan.short.strike} ${activePlan.right}`,
      };
    }
    return {
      searchLabel: `${target.underlying} SPOT INDEX`,
      chartTitle: `${target.underlying} · ${intervalTag} · NSE`,
      pillLabel: target.underlying,
    };
  }, [activePlan, legMode, interval, target.underlying]);

  const latestBar = visibleCandles[visibleCandles.length - 1];
  const firstBar = visibleCandles[0];
  const activeBar = hoverIdx !== null && visibleCandles[hoverIdx] ? visibleCandles[hoverIdx] : latestBar;
  const prevBar =
    hoverIdx !== null && hoverIdx > 0
      ? visibleCandles[hoverIdx - 1]
      : visibleCandles.length > 1
        ? firstBar
        : latestBar;

  const barChange = activeBar && prevBar ? activeBar.close - prevBar.open : 0;
  const barChangePct = activeBar && prevBar && prevBar.open > 0 ? (barChange / prevBar.open) * 100 : 0;
  const isBarUp = activeBar ? activeBar.close >= activeBar.open : true;

  const bidPrice = data?.quote.bid ?? activeBar?.close ?? 0;
  const askPrice = data?.quote.ask ?? activeBar?.close ?? 0;
  const spreadVal = Math.max(0, askPrice - bidPrice);

  const spreadLevels = useMemo(() => {
    if (!activePlan || legMode !== 'spread') return null;
    const entry = activePlan.entryDebit;
    const targetVal = entry + (activePlan.width - entry) * takeProfitFrac;
    const stopVal = entry * (1 - stopLossFrac);
    return { entry, targetVal, stopVal };
  }, [activePlan, legMode, takeProfitFrac, stopLossFrac]);

  // SVG Geometry
  const svgW = 1140;
  const svgH = 510;
  const pad = { l: 12, r: 96, t: 24, b: 32 };
  const plotW = svgW - pad.l - pad.r;
  const candlePlotH = 365;
  const volTop = pad.t + candlePlotH + 14;
  const volPlotH = svgH - volTop - pad.b;

  const { minPrice, maxPrice, maxVol } = useMemo(() => {
    if (visibleCandles.length === 0) return { minPrice: 0, maxPrice: 100, maxVol: 1000 };
    const lows = visibleCandles.map((c) => c.low);
    const highs = visibleCandles.map((c) => c.high);
    if (spreadLevels && showLevels) {
      lows.push(spreadLevels.stopVal);
      highs.push(spreadLevels.targetVal);
    }
    const rawMin = Math.min(...lows);
    const rawMax = Math.max(...highs);
    const padSpan = Math.max((rawMax - rawMin) * 0.08, 0.5);
    const vols = visibleCandles.map((c) => c.volume || 1);
    return {
      minPrice: Math.max(0, rawMin - padSpan),
      maxPrice: rawMax + padSpan,
      maxVol: Math.max(...vols, 1),
    };
  }, [visibleCandles, spreadLevels, showLevels]);

  const priceSpan = Math.max(maxPrice - minPrice, 0.01);
  const yPrice = (p: number) => pad.t + candlePlotH - ((p - minPrice) / priceSpan) * candlePlotH;
  const yVol = (v: number) => volTop + volPlotH - Math.min(1, v / maxVol) * volPlotH;
  const stepX = plotW / Math.max(visibleCandles.length, 1);
  const xCandle = (i: number) => pad.l + (i + 0.5) * stepX;
  const bodyW = Math.max(2.5, Math.min(11, stepX * 0.68));

  const yTicks = useMemo(() => {
    const count = 8;
    const out: number[] = [];
    for (let i = 0; i <= count; i++) {
      out.push(minPrice + (i / count) * priceSpan);
    }
    return out;
  }, [minPrice, priceSpan]);

  const xTickIndices = useMemo(() => {
    if (visibleCandles.length === 0) return [];
    const stride = Math.max(1, Math.floor(visibleCandles.length / 9));
    const out: number[] = [];
    for (let i = 0; i < visibleCandles.length; i += stride) {
      out.push(i);
    }
    return out;
  }, [visibleCandles.length]);

  const buildLinePath = (series: Array<number | null>) =>
    series
      .map((v, i) => (v === null ? null : `${i === 0 || series[i - 1] === null ? 'M' : 'L'}${xCandle(i).toFixed(1)},${yPrice(v).toFixed(1)}`))
      .filter(Boolean)
      .join(' ');

  return (
    <div className="space-y-4">
      {/* Terminal Top Control Bar (Groww Terminal Header Style) */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            {onBackToOverview ? (
              <button
                type="button"
                onClick={onBackToOverview}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                ← Explore
              </button>
            ) : null}

            {/* Contract Selector Dropdown */}
            <div className="relative flex items-center">
              <span className="pointer-events-none absolute left-2.5 text-xs text-slate-400">⌕</span>
              <select
                aria-label="Select contract or underlying for Terminal"
                value={`${target.kind}:${target.id}`}
                onChange={(e) => {
                  const [kind, id] = e.target.value.split(':');
                  if (kind === 'position') {
                    const p = positions.find((x) => x.id === id);
                    if (p) onSelectTarget({ kind: 'position', id: p.id, underlying: p.underlying, position: p });
                  } else if (kind === 'candidate') {
                    const c = candidates.find((x) => x.id === id);
                    if (c) onSelectTarget({ kind: 'candidate', id: c.id, underlying: c.underlying, candidate: c });
                  } else {
                    onSelectTarget({ kind: 'underlying', id, underlying: id });
                  }
                }}
                className="rounded-lg border border-slate-200 bg-white py-1.5 pr-7 pl-7 text-xs font-semibold text-slate-900 focus:border-[#00B386] focus:outline-none"
              >
                {positions.length > 0 ? (
                  <optgroup label="Open Paper Positions">
                    {positions.map((p) => (
                      <option key={p.id} value={`position:${p.id}`}>
                        {p.underlying} {formatExpiryShort(p.plan.expiry).toUpperCase()} {p.plan.long.strike} {p.direction} (Open Position)
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {candidates.length > 0 ? (
                  <optgroup label="Active Shadow Signals">
                    {candidates.map((c) => (
                      <option key={c.id} value={`candidate:${c.id}`}>
                        {c.underlying} {formatExpiryShort(c.plan.expiry).toUpperCase()} {c.plan.long.strike} {c.direction} ({c.takenByLedger ? 'In Ledger' : 'Shadow'})
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                <optgroup label="NSE F&O Underlyings">
                  {UNDERLYINGS.map((u) => (
                    <option key={u} value={`underlying:${u}`}>
                      {u} Spot Index / EQ
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>

            <span className="h-4 w-px bg-slate-200" />

            {/* Interval Selector */}
            <div className="flex items-center gap-1" role="group" aria-label="Candle timeframe">
              {(['5m', '15m', '1h'] as TerminalInterval[]).map((iv) => (
                <button
                  key={iv}
                  type="button"
                  onClick={() => setIntervalState(iv)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                    interval === iv
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {iv}
                </button>
              ))}
            </div>

            <span className="h-4 w-px bg-slate-200" />

            {/* Indicators toggle */}
            <button
              type="button"
              onClick={() => setShowIndicators((s) => !s)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
                showIndicators
                  ? 'bg-emerald-50 text-[#00B386] ring-1 ring-[#00B386]/30'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span className="font-serif italic">fx</span> Indicators
            </button>

            {/* Leg Mode Selector when viewing an Option Spread Position/Candidate */}
            {activePlan ? (
              <>
                <span className="h-4 w-px bg-slate-200" />
                <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Option leg view">
                  <button
                    type="button"
                    onClick={() => setLegMode('long')}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                      legMode === 'long'
                        ? 'bg-[#00B386]/15 font-semibold text-[#008F6B]'
                        : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    Buy Leg ({activePlan.long.strike} {activePlan.right})
                  </button>
                  <button
                    type="button"
                    onClick={() => setLegMode('short')}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                      legMode === 'short'
                        ? 'bg-[#EB5B3C]/15 font-semibold text-[#C84125]'
                        : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    Sell Leg ({activePlan.short.strike} {activePlan.right})
                  </button>
                  <button
                    type="button"
                    onClick={() => setLegMode('spread')}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                      legMode === 'spread'
                        ? 'bg-slate-900 font-semibold text-white'
                        : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    Net Spread ({activePlan.long.strike}/{activePlan.short.strike})
                  </button>
                  <button
                    type="button"
                    onClick={() => setLegMode('spot')}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                      legMode === 'spot'
                        ? 'bg-slate-200 font-semibold text-slate-900'
                        : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {activePlan.underlying} Spot
                  </button>
                </div>
              </>
            ) : null}
          </div>

          {/* Right Status Badge */}
          <div className="flex items-center gap-2 text-xs text-slate-500">
            {target.position ? (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2.5 py-1 font-medium text-slate-800">
                <span>Open {target.position.lots} Lot ({target.position.plan.lotSize} qty)</span>
                <span className="text-slate-300">·</span>
                <span
                  className={`font-mono font-semibold tabular-nums ${
                    target.position.unrealizedInr >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                  }`}
                >
                  {target.position.unrealizedInr >= 0 ? '+' : ''}
                  {formatInr(target.position.unrealizedInr)}
                </span>
              </span>
            ) : null}
            <span className="hidden sm:inline text-[11px] text-slate-400">
              {loading ? 'Syncing bars…' : data?.source === 'ANGEL_LIVE_NFO' || data?.source === 'ANGEL_LIVE_NSE' ? 'Angel One Live' : 'Angel One Feed'}
            </span>
          </div>
        </div>

        {/* Main Terminal Body: Left Drawing Rail + Center Chart Canvas */}
        <div className="flex min-h-[520px]">
          {/* Left Vertical Tool Rail (matching Groww/TradingView rail) */}
          <div className="hidden w-11 shrink-0 flex-col items-center gap-3 border-r border-slate-200 py-3 text-slate-500 sm:flex">
            <button
              type="button"
              title="Crosshair"
              onClick={() => setHoverIdx(null)}
              className="flex h-7 w-7 items-center justify-center rounded bg-slate-100 text-xs font-bold text-slate-800"
            >
              ┼
            </button>
            <button
              type="button"
              title="Toggle Entry / Target / Stop Lines"
              onClick={() => setShowLevels((s) => !s)}
              className={`flex h-7 w-7 items-center justify-center rounded text-xs ${
                showLevels ? 'bg-emerald-50 text-[#00B386]' : 'hover:bg-slate-100'
              }`}
            >
              ≡
            </button>
            <button
              type="button"
              title="Toggle EMA 20 / 50"
              onClick={() => setShowIndicators((s) => !s)}
              className={`flex h-7 w-7 items-center justify-center rounded text-xs ${
                showIndicators ? 'bg-blue-50 text-blue-600' : 'hover:bg-slate-100'
              }`}
            >
              ∿
            </button>
            <button
              type="button"
              title="Zoom In (1D)"
              onClick={() => setRangeZoom('1d')}
              className="flex h-7 w-7 items-center justify-center rounded text-xs hover:bg-slate-100"
            >
              ⊕
            </button>
            <button
              type="button"
              title="Reset Zoom (5D)"
              onClick={() => setRangeZoom('5d')}
              className="flex h-7 w-7 items-center justify-center rounded text-xs hover:bg-slate-100"
            >
              ⟲
            </button>
          </div>

          {/* Chart Canvas Wrapper */}
          <div className="relative flex-1 overflow-hidden bg-white">
            {/* Top-left Groww Overlay: Title + OHLC + SELL/BUY Boxes + Volume */}
            <div className="pointer-events-none absolute top-3 left-4 z-10 space-y-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 bg-white/90 pr-3 backdrop-blur-xs">
                <h2 className="text-sm font-semibold text-slate-900">{contractMeta.chartTitle}</h2>
                {activeBar ? (
                  <div className="flex flex-wrap items-center gap-x-2 text-xs font-mono tabular-nums">
                    <span>
                      <span className="text-slate-400">O</span>
                      <span className={isBarUp ? 'text-[#00B386]' : 'text-[#EB5B3C]'}>{activeBar.open.toFixed(2)}</span>
                    </span>
                    <span>
                      <span className="text-slate-400">H</span>
                      <span className={isBarUp ? 'text-[#00B386]' : 'text-[#EB5B3C]'}>{activeBar.high.toFixed(2)}</span>
                    </span>
                    <span>
                      <span className="text-slate-400">L</span>
                      <span className={isBarUp ? 'text-[#00B386]' : 'text-[#EB5B3C]'}>{activeBar.low.toFixed(2)}</span>
                    </span>
                    <span>
                      <span className="text-slate-400">C</span>
                      <span className={isBarUp ? 'text-[#00B386]' : 'text-[#EB5B3C]'}>{activeBar.close.toFixed(2)}</span>
                    </span>
                    <span className={barChange >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'}>
                      {barChange >= 0 ? '+' : ''}
                      {barChange.toFixed(2)} ({barChange >= 0 ? '+' : ''}
                      {barChangePct.toFixed(2)}%)
                    </span>
                  </div>
                ) : null}
              </div>

              {/* Signature Red SELL (Bid) and Green BUY (Ask) Boxes from Screenshot 2 */}
              <div className="pointer-events-auto flex items-center gap-2">
                <div className="flex flex-col items-center justify-center rounded bg-[#EB5B3C] px-2.5 py-1 text-white shadow-xs">
                  <span className="font-mono text-xs font-bold tabular-nums leading-tight">
                    {bidPrice.toFixed(2)}
                  </span>
                  <span className="text-[10px] font-semibold tracking-wider uppercase leading-tight opacity-95">
                    SELL
                  </span>
                </div>
                <span className="font-mono text-[11px] font-medium text-slate-500 tabular-nums">
                  {spreadVal.toFixed(2)}
                </span>
                <div className="flex flex-col items-center justify-center rounded bg-[#00B386] px-2.5 py-1 text-white shadow-xs">
                  <span className="font-mono text-xs font-bold tabular-nums leading-tight">
                    {askPrice.toFixed(2)}
                  </span>
                  <span className="text-[10px] font-semibold tracking-wider uppercase leading-tight opacity-95">
                    BUY
                  </span>
                </div>
              </div>

              {/* Volume Readout */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-500">Volume</span>
                <span className={`font-mono font-medium tabular-nums ${isBarUp ? 'text-[#00B386]' : 'text-[#EB5B3C]'}`}>
                  {formatVolumeCompact(activeBar?.volume ?? data?.quote.volume ?? 0)}
                </span>
                {showIndicators ? (
                  <span className="ml-2 inline-flex items-center gap-2 text-[11px]">
                    <span className="text-blue-600">● EMA 20</span>
                    <span className="text-amber-500">● EMA 50</span>
                  </span>
                ) : null}
              </div>
            </div>

            {/* Interactive SVG Candlestick + Volume Chart */}
            <svg
              viewBox={`0 0 ${svgW} ${svgH}`}
              className="block h-[510px] w-full select-none"
              onMouseLeave={() => setHoverIdx(null)}
            >
              {/* Horizontal Grid Lines & Right Price Axis Labels */}
              {yTicks.map((val, idx) => {
                const y = yPrice(val);
                return (
                  <g key={idx}>
                    <line
                      x1={pad.l}
                      x2={svgW - pad.r}
                      y1={y}
                      y2={y}
                      stroke="#F1F5F9"
                      strokeWidth={1}
                    />
                    <text
                      x={svgW - pad.r + 8}
                      y={y + 4}
                      className="fill-slate-500 font-mono text-[11px] tabular-nums"
                    >
                      {val.toFixed(2)}
                    </text>
                  </g>
                );
              })}

              {/* Vertical Time Grid Lines & Bottom Time Labels */}
              {xTickIndices.map((idx) => {
                const candle = visibleCandles[idx];
                if (!candle) return null;
                const x = xCandle(idx);
                return (
                  <g key={candle.time}>
                    <line
                      x1={x}
                      x2={x}
                      y1={pad.t}
                      y2={svgH - pad.b}
                      stroke="#F8FAFC"
                      strokeWidth={1}
                    />
                    <text
                      x={x}
                      y={svgH - 10}
                      textAnchor="middle"
                      className="fill-slate-500 font-mono text-[11px] tabular-nums"
                    >
                      {formatAxisTime(candle.time, interval)}
                    </text>
                  </g>
                );
              })}

              {/* Divider between Price and Volume pane */}
              <line
                x1={pad.l}
                x2={svgW - pad.r}
                y1={volTop - 6}
                y2={volTop - 6}
                stroke="#F1F5F9"
                strokeWidth={1}
              />

              {/* Right Axis Border */}
              <line
                x1={svgW - pad.r}
                x2={svgW - pad.r}
                y1={pad.t}
                y2={svgH - pad.b}
                stroke="#E2E8F0"
                strokeWidth={1}
              />

              {/* Entry / Target / Stop Reference Lines when viewing Net Spread */}
              {spreadLevels && showLevels ? (
                <g>
                  {[
                    { label: 'Target', price: spreadLevels.targetVal, color: '#00B386' },
                    { label: 'Entry Debit', price: spreadLevels.entry, color: '#64748B' },
                    { label: 'Stop Loss', price: spreadLevels.stopVal, color: '#EB5B3C' },
                  ].map((lvl) => {
                    const y = yPrice(lvl.price);
                    if (y < pad.t || y > pad.t + candlePlotH) return null;
                    return (
                      <g key={lvl.label}>
                        <line
                          x1={pad.l}
                          x2={svgW - pad.r}
                          y1={y}
                          y2={y}
                          stroke={lvl.color}
                          strokeWidth={1}
                          strokeDasharray="4 4"
                        />
                        <text
                          x={svgW - pad.r - 6}
                          y={y - 4}
                          textAnchor="end"
                          fill={lvl.color}
                          className="font-mono text-[10px] font-semibold"
                        >
                          {lvl.label} ₹{lvl.price.toFixed(2)}
                        </text>
                      </g>
                    );
                  })}
                </g>
              ) : null}

              {/* Volume Bars & Candlesticks */}
              {visibleCandles.map((c, i) => {
                const x = xCandle(i);
                const up = c.close >= c.open;
                const color = up ? '#00B386' : '#EB5B3C';
                const volColor = up ? 'rgba(0, 179, 134, 0.42)' : 'rgba(235, 91, 60, 0.42)';
                const yHi = yPrice(c.high);
                const yLo = yPrice(c.low);
                const yOpen = yPrice(c.open);
                const yClose = yPrice(c.close);
                const topBody = Math.min(yOpen, yClose);
                const bodyH = Math.max(1.8, Math.abs(yClose - yOpen));
                const vTop = yVol(c.volume || 0);
                const vH = Math.max(1, volTop + volPlotH - vTop);

                return (
                  <g key={c.time}>
                    {/* Volume bar */}
                    <rect
                      x={x - bodyW / 2}
                      y={vTop}
                      width={bodyW}
                      height={vH}
                      fill={volColor}
                    />
                    {/* High-Low Wick */}
                    <line
                      x1={x}
                      x2={x}
                      y1={yHi}
                      y2={yLo}
                      stroke={color}
                      strokeWidth={1.2}
                    />
                    {/* Open-Close Body */}
                    <rect
                      x={x - bodyW / 2}
                      y={topBody}
                      width={bodyW}
                      height={bodyH}
                      fill={color}
                      rx={0.5}
                    />
                    {/* Hover Hit Target */}
                    <rect
                      x={x - stepX / 2}
                      y={pad.t}
                      width={stepX}
                      height={svgH - pad.t - pad.b}
                      fill="transparent"
                      onMouseEnter={() => setHoverIdx(i)}
                    />
                  </g>
                );
              })}

              {/* EMA Overlays */}
              {showIndicators ? (
                <>
                  <path d={buildLinePath(ema20)} fill="none" stroke="#2563EB" strokeWidth={1.5} />
                  <path d={buildLinePath(ema50)} fill="none" stroke="#F59E0B" strokeWidth={1.5} />
                </>
              ) : null}

              {/* Crosshair Vertical Line on Hover */}
              {hoverIdx !== null && visibleCandles[hoverIdx] ? (
                <line
                  x1={xCandle(hoverIdx)}
                  x2={xCandle(hoverIdx)}
                  y1={pad.t}
                  y2={svgH - pad.b}
                  stroke="#94A3B8"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  pointerEvents="none"
                />
              ) : null}

              {/* Latest Price Dashed Line + Right-Axis Colored Price Tag (Exact Groww Terminal Style) */}
              {latestBar ? (
                <g pointerEvents="none">
                  <line
                    x1={pad.l}
                    x2={svgW - pad.r}
                    y1={yPrice(latestBar.close)}
                    y2={yPrice(latestBar.close)}
                    stroke={latestBar.close >= latestBar.open ? '#00B386' : '#EB5B3C'}
                    strokeWidth={1}
                    strokeDasharray="2 2"
                  />
                  {/* Contract Name Tag on Left of Axis */}
                  <rect
                    x={svgW - pad.r - 148}
                    y={yPrice(latestBar.close) - 10}
                    width={148}
                    height={20}
                    rx={3}
                    fill={latestBar.close >= latestBar.open ? '#00B386' : '#EB5B3C'}
                  />
                  <text
                    x={svgW - pad.r - 74}
                    y={yPrice(latestBar.close) + 4}
                    textAnchor="middle"
                    className="fill-white text-[10px] font-semibold"
                  >
                    {contractMeta.pillLabel}
                  </text>
                  {/* Price Tag on Right Axis */}
                  <rect
                    x={svgW - pad.r}
                    y={yPrice(latestBar.close) - 10}
                    width={64}
                    height={20}
                    rx={3}
                    fill={latestBar.close >= latestBar.open ? '#00B386' : '#EB5B3C'}
                  />
                  <text
                    x={svgW - pad.r + 32}
                    y={yPrice(latestBar.close) + 4}
                    textAnchor="middle"
                    className="fill-white font-mono text-[11px] font-bold tabular-nums"
                  >
                    {latestBar.close.toFixed(2)}
                  </text>

                  {/* Volume Tag on Right Axis */}
                  <rect
                    x={svgW - pad.r}
                    y={yVol(latestBar.volume || 0) - 9}
                    width={56}
                    height={18}
                    rx={3}
                    fill={latestBar.close >= latestBar.open ? '#00B386' : '#EB5B3C'}
                  />
                  <text
                    x={svgW - pad.r + 28}
                    y={yVol(latestBar.volume || 0) + 3}
                    textAnchor="middle"
                    className="fill-white font-mono text-[10px] font-semibold tabular-nums"
                  >
                    {formatVolumeCompact(latestBar.volume || 0)}
                  </text>
                </g>
              ) : null}
            </svg>

            {/* Bottom Timeframe & IST Clock Bar */}
            <div className="flex flex-wrap items-center justify-between border-t border-slate-200 bg-white px-4 py-2 text-xs text-slate-600">
              <div className="flex items-center gap-3">
                {(
                  [
                    { id: 'all', label: '1m' },
                    { id: '1m', label: '2w' },
                    { id: '5d', label: '5d' },
                    { id: '1d', label: '1d' },
                  ] as const
                ).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setRangeZoom(r.id)}
                    className={`rounded px-1.5 py-0.5 font-medium transition ${
                      rangeZoom === r.id ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-4 font-mono text-xs text-slate-600 tabular-nums">
                <span>{istClock}</span>
                <span className="text-slate-300">|</span>
                <span>%</span>
                <span>log</span>
                <span className="font-semibold text-[#00B386]">auto</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Active Position / Spread Breakdown Drawer Below Chart */}
      {activePlan ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-[#008F6B]">
                  {target.position ? 'OPEN PAPER POSITION' : 'TRACKED SHADOW CANDIDATE'}
                </span>
                <h3 className="text-sm font-semibold text-slate-900">
                  {activePlan.underlying} {formatExpiryShort(activePlan.expiry)} {activePlan.long.strike}/{activePlan.short.strike} {activePlan.right} Vertical Debit Spread
                </h3>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                {target.position ? target.position.entryReason : target.candidate?.reason} · Expiry {activePlan.expiry} ({activePlan.dte} DTE) · Lot Size {activePlan.lotSize}
              </p>
            </div>

            {target.position ? (
              <div className="text-right">
                <div className="text-[11px] uppercase tracking-wider text-slate-400">Net Unrealized P&L (at Bid/Ask)</div>
                <div
                  className={`font-mono text-lg font-bold tabular-nums ${
                    target.position.unrealizedInr >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                  }`}
                >
                  {target.position.unrealizedInr >= 0 ? '+' : ''}
                  {formatInr(target.position.unrealizedInr)}
                </div>
              </div>
            ) : null}
          </div>

          {/* Leg-by-Leg Order Book & Execution Details */}
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {/* Long Leg Card */}
            <button
              type="button"
              onClick={() => setLegMode('long')}
              className={`cursor-pointer rounded-lg border p-3 text-left transition ${
                legMode === 'long' ? 'border-[#00B386] bg-emerald-50/30' : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="rounded bg-[#00B386] px-1.5 py-0.5 text-[10px] font-bold text-white">BUY LEG (LONG)</span>
                <span className="font-mono text-xs text-slate-500">Token #{activePlan.long.token}</span>
              </div>
              <div className="mt-1.5 text-sm font-semibold text-slate-900">{activePlan.long.symbol}</div>
              <div className="mt-2 flex justify-between text-xs text-slate-600">
                <span>Entry Ask: <strong className="font-mono text-slate-900">₹{activePlan.long.ask.toFixed(2)}</strong></span>
                <span>Live Bid/Ask: <strong className="font-mono text-slate-900">₹{(activeMark?.longBid ?? activePlan.long.bid).toFixed(2)} / ₹{(activeMark?.longAsk ?? activePlan.long.ask).toFixed(2)}</strong></span>
              </div>
            </button>

            {/* Short Leg Card */}
            <button
              type="button"
              onClick={() => setLegMode('short')}
              className={`cursor-pointer rounded-lg border p-3 text-left transition ${
                legMode === 'short' ? 'border-[#EB5B3C] bg-rose-50/30' : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="rounded bg-[#EB5B3C] px-1.5 py-0.5 text-[10px] font-bold text-white">SELL LEG (SHORT HEDGE)</span>
                <span className="font-mono text-xs text-slate-500">Token #{activePlan.short.token}</span>
              </div>
              <div className="mt-1.5 text-sm font-semibold text-slate-900">{activePlan.short.symbol}</div>
              <div className="mt-2 flex justify-between text-xs text-slate-600">
                <span>Entry Bid: <strong className="font-mono text-slate-900">₹{activePlan.short.bid.toFixed(2)}</strong></span>
                <span>Live Bid/Ask: <strong className="font-mono text-slate-900">₹{(activeMark?.shortBid ?? activePlan.short.bid).toFixed(2)} / ₹{(activeMark?.shortAsk ?? activePlan.short.ask).toFixed(2)}</strong></span>
              </div>
            </button>

            {/* Net Spread Metrics */}
            <button
              type="button"
              onClick={() => setLegMode('spread')}
              className={`cursor-pointer rounded-lg border p-3 text-left transition ${
                legMode === 'spread' ? 'border-slate-900 bg-slate-50' : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-bold text-white">NET VERTICAL SPREAD</span>
                <span className="font-mono text-xs text-slate-500">Width {activePlan.width} pts</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-y-1 text-xs">
                <span className="text-slate-500">Entry Debit:</span>
                <span className="text-right font-mono font-semibold text-slate-900">₹{activePlan.entryDebit.toFixed(2)}</span>
                <span className="text-slate-500">Liquidation Mark:</span>
                <span className="text-right font-mono font-semibold text-slate-900">
                  ₹{(activeMark?.liquidationValue ?? activePlan.entryDebit).toFixed(2)}
                </span>
                <span className="text-slate-500">Target / Stop:</span>
                <span className="text-right font-mono text-slate-800">
                  <span className="text-[#00B386]">₹{(activePlan.entryDebit + (activePlan.width - activePlan.entryDebit) * takeProfitFrac).toFixed(2)}</span>
                  {' / '}
                  <span className="text-[#EB5B3C]">₹{(activePlan.entryDebit * (1 - stopLossFrac)).toFixed(2)}</span>
                </span>
                <span className="text-slate-500">Max Gain / Loss (1 Lot):</span>
                <span className="text-right font-mono text-slate-800">
                  +{formatInr(activePlan.maxGainPerLot)} / -{formatInr(activePlan.maxLossPerLot)}
                </span>
              </div>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
