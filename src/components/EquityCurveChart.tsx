import React, { useState } from 'react';
import { EquitySnapshotPoint, formatInr } from '../quant/engine';

interface EquityCurveChartProps {
  data: EquitySnapshotPoint[];
  formatTimestamp: (iso: string) => string;
}

export const EquityCurveChart: React.FC<EquityCurveChartProps> = ({ data, formatTimestamp }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [visibleCurves, setVisibleCurves] = useState({
    conservative: true,
    brokerPaper: true,
    nifty: true,
  });

  if (!data || data.length === 0) {
    return (
      <div className="h-72 flex items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        No equity snapshots recorded yet.
      </div>
    );
  }

  const width = 920;
  const height = 290;
  const padLeft = 86;
  const padRight = 24;
  const padTop = 20;
  const padBottom = 34;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const allValues: number[] = [];
  for (const d of data) {
    if (visibleCurves.conservative) allValues.push(d.conservativeEquityInr);
    if (visibleCurves.brokerPaper) allValues.push(d.brokerPaperEquityInr);
    if (visibleCurves.nifty) allValues.push(d.niftyBenchmarkEquityInr);
  }
  const rawMin = allValues.length > 0 ? Math.min(...allValues) : 9500;
  const rawMax = allValues.length > 0 ? Math.max(...allValues) : 12000;
  const pad = Math.max((rawMax - rawMin) * 0.08, 400);
  const minVal = Math.max(0, rawMin - pad);
  const maxVal = rawMax + pad;
  const valSpan = Math.max(maxVal - minVal, 800);

  const getX = (i: number) =>
    padLeft + (i / Math.max(data.length - 1, 1)) * plotW;
  const getY = (v: number) =>
    padTop + plotH - ((v - minVal) / valSpan) * plotH;

  const buildPath = (extractor: (pt: EquitySnapshotPoint) => number) =>
    data
      .map(
        (pt, idx) =>
          `${idx === 0 ? 'M' : 'L'}${getX(idx).toFixed(1)},${getY(extractor(pt)).toFixed(1)}`
      )
      .join(' ');

  const consPath = buildPath((d) => d.conservativeEquityInr);
  const paperPath = buildPath((d) => d.brokerPaperEquityInr);
  const niftyPath = buildPath((d) => d.niftyBenchmarkEquityInr);

  const activePoint = hoverIdx !== null ? data[hoverIdx] : data[data.length - 1];
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => minVal + t * valSpan);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setVisibleCurves((prev) => ({ ...prev, conservative: !prev.conservative }))
            }
            className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 ${
              visibleCurves.conservative
                ? 'bg-blue-600/10 border-blue-500 text-blue-700 dark:text-blue-300'
                : 'border-slate-200 dark:border-slate-800 text-slate-500'
            }`}
          >
            Conservative Sim (Headline: mid ± 35% spread + ₹35/lot fee)
          </button>
          <button
            type="button"
            onClick={() =>
              setVisibleCurves((prev) => ({ ...prev, brokerPaper: !prev.brokerPaper }))
            }
            className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 ${
              visibleCurves.brokerPaper
                ? 'bg-emerald-600/10 border-emerald-500 text-emerald-700 dark:text-emerald-300'
                : 'border-slate-200 dark:border-slate-800 text-slate-500'
            }`}
          >
            Paper Broker Fills (Optimistic Mid Fills)
          </button>
          <button
            type="button"
            onClick={() => setVisibleCurves((prev) => ({ ...prev, nifty: !prev.nifty }))}
            className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 ${
              visibleCurves.nifty
                ? 'bg-slate-500/10 border-slate-400 text-slate-700 dark:text-slate-300'
                : 'border-slate-200 dark:border-slate-800 text-slate-500'
            }`}
          >
            NIFTY 50 Buy-and-Hold Benchmark
          </button>
        </div>

        {activePoint && (
          <div className="flex flex-wrap items-center gap-3 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
            <span>{formatTimestamp(activePoint.recordedAt)}</span>
            <span aria-hidden="true">·</span>
            <span className="text-blue-600 dark:text-blue-400 font-semibold">
              Cons: {formatInr(activePoint.conservativeEquityInr)}
            </span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-600 dark:text-emerald-400">
              Paper: {formatInr(activePoint.brokerPaperEquityInr)}
            </span>
            <span aria-hidden="true">·</span>
            <span>NIFTY 50: {formatInr(activePoint.niftyBenchmarkEquityInr)}</span>
          </div>
        )}
      </div>

      <div className="relative w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-72 select-none"
          role="img"
          aria-label="Equity Curve comparing Conservative Simulation, Paper Broker, and NIFTY 50 Benchmark"
          onMouseLeave={() => setHoverIdx(null)}
        >
          {yTicks.map((val, idx) => {
            const y = getY(val);
            return (
              <g key={idx}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={width - padRight}
                  y2={y}
                  stroke="currentColor"
                  className="text-slate-200 dark:text-slate-800"
                  strokeDasharray="3 3"
                />
                <text
                  x={padLeft - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-slate-500 dark:fill-slate-400 text-[11px] font-mono"
                >
                  ₹{Math.round(val).toLocaleString('en-IN')}
                </text>
              </g>
            );
          })}

          {visibleCurves.nifty && (
            <path
              d={niftyPath}
              fill="none"
              stroke="#64748b"
              strokeWidth="1.75"
              strokeDasharray="4 4"
            />
          )}

          {visibleCurves.brokerPaper && (
            <path
              d={paperPath}
              fill="none"
              stroke="#10b981"
              strokeWidth="2"
              strokeOpacity="0.85"
            />
          )}

          {visibleCurves.conservative && (
            <path
              d={consPath}
              fill="none"
              stroke="#3b82f6"
              strokeWidth="2.75"
            />
          )}

          {hoverIdx !== null && (
            <line
              x1={getX(hoverIdx)}
              y1={padTop}
              x2={getX(hoverIdx)}
              y2={height - padBottom}
              stroke="#94a3b8"
              strokeWidth="1"
            />
          )}

          {data.map((pt, i) => {
            const bandW = plotW / data.length;
            return (
              <rect
                key={`${pt.snapshotId}-${i}`}
                x={getX(i) - bandW / 2}
                y={padTop}
                width={Math.max(bandW, 4)}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
};
