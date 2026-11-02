import React, { useState } from 'react';
import { formatInr, formatIst } from '../quant/format';
import type { EquityPoint } from '../quant/types';

export const EquityCurveChart: React.FC<{ data: EquityPoint[] }> = ({ data }) => {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length === 0) {
    return <div className="flex h-64 items-center justify-center text-sm text-slate-500">No equity points yet. The first one is written when a live cycle runs.</div>;
  }
  const width = 920;
  const height = 280;
  const pad = { l: 72, r: 16, t: 16, b: 28 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const values = data.flatMap((d) => [d.equity, d.equityMid, d.benchmark].filter((v): v is number => v !== null && Number.isFinite(v)));
  const min = Math.min(...values);
  const max = Math.max(...values);
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
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((t) => {
          const v = min + t * span;
          return (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} className="stroke-slate-800" />
              <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="fill-slate-500 text-[11px]">
                {formatInr(v)}
              </text>
            </g>
          );
        })}
        <path d={path((d) => d.benchmark)} className="fill-none stroke-slate-500" strokeDasharray="4 4" />
        <path d={path((d) => d.equityMid)} className="fill-none stroke-amber-300/70" />
        <path d={path((d) => d.equity)} className="fill-none stroke-sky-400" strokeWidth={2} />
        {data.map((d, i) => (
          <rect key={d.t} x={x(i) - plotW / data.length / 2} y={pad.t} width={Math.max(plotW / data.length, 2)} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        <span className="text-sky-400">Liquidation equity {formatInr(point.equity)}</span>
        <span className="text-amber-300">Mid equity {formatInr(point.equityMid)}</span>
        <span>NIFTY benchmark {formatInr(point.benchmark)}</span>
        <span>{formatIst(point.t)}</span>
      </div>
    </div>
  );
};
