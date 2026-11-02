import React, { useState } from 'react';
import { formatInr, formatIst } from '../quant/format';
import type { EquityPoint } from '../quant/types';

export const EquityCurveChart: React.FC<{ data: EquityPoint[] }> = ({ data }) => {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-slate-200 text-sm text-slate-400">
        No equity points yet. The first point is recorded when a live cycle runs.
      </div>
    );
  }
  const width = 760;
  const height = 210;
  const pad = { l: 68, r: 16, t: 16, b: 26 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const values = data.flatMap((d) =>
    [d.equity, d.equityMid, d.benchmark].filter((v): v is number => v !== null && Number.isFinite(v))
  );
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padVal = Math.max((rawMax - rawMin) * 0.15, 100);
  const min = rawMin - padVal;
  const max = rawMax + padVal;
  const span = Math.max(max - min, 1);
  const x = (i: number) => pad.l + (i / Math.max(data.length - 1, 1)) * plotW;
  const y = (v: number) => pad.t + plotH - ((v - min) / span) * plotH;
  const path = (pick: (d: EquityPoint) => number | null) =>
    data
      .map((d, i) => {
        const v = pick(d);
        return v === null ? null : `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(' ');
  const point = data[hover ?? data.length - 1];
  const areaPath =
    data.length > 1
      ? `${path((d) => d.equity)} L${x(data.length - 1).toFixed(1)},${(pad.t + plotH).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + plotH).toFixed(1)} Z`
      : '';

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="growwEquityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00B386" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#00B386" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((t) => {
          const v = min + t * span;
          return (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} stroke="#F1F5F9" strokeWidth={1} />
              <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="fill-slate-400 font-mono text-[11px] tabular-nums">
                {formatInr(v)}
              </text>
            </g>
          );
        })}
        {areaPath ? <path d={areaPath} fill="url(#growwEquityFill)" /> : null}
        <path d={path((d) => d.benchmark)} className="fill-none stroke-slate-300" strokeDasharray="4 4" strokeWidth={1.5} />
        <path d={path((d) => d.equityMid)} className="fill-none stroke-amber-400/80" strokeWidth={1.5} />
        <path d={path((d) => d.equity)} className="fill-none stroke-[#00B386]" strokeWidth={2.2} />
        {data.length === 1 ? (
          <circle cx={x(0)} cy={y(data[0].equity)} r={4.5} fill="#00B386" />
        ) : null}
        {data.map((d, i) => (
          <rect
            key={d.t}
            x={x(i) - plotW / Math.max(data.length, 1) / 2}
            y={pad.t}
            width={Math.max(plotW / Math.max(data.length, 1), 6)}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2 text-xs text-slate-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1.5 font-medium text-slate-800">
            <span className="h-2 w-2 rounded-full bg-[#00B386]" />
            Liquidation Equity: <strong className="font-mono tabular-nums">{formatInr(point.equity)}</strong>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            Mid Mark: <span className="font-mono tabular-nums">{formatInr(point.equityMid)}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-slate-300" />
            NIFTY Benchmark: <span className="font-mono tabular-nums">{formatInr(point.benchmark)}</span>
          </span>
        </div>
        <span className="font-mono text-[11px] text-slate-400">{formatIst(point.t)}</span>
      </div>
    </div>
  );
};
