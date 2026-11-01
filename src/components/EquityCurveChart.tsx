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
  const height = 300;
  const padLeft = 78;
  const padRight = 20;
  const padTop = 18;
  const padBottom = 30;
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

  const getX = (i: number) => padLeft + (i / Math.max(data.length - 1, 1)) * plotW;
  const getY = (v: number) => padTop + plotH - ((v - minVal) / valSpan) * plotH;

  const buildPath = (extractor: (pt: EquitySnapshotPoint) => number) =>
    data
      .map(
        (pt, idx) =>
          `${idx === 0 ? 'M' : 'L'}${getX(idx).toFixed(1)},${getY(extractor(pt)).toFixed(1)}`
      )
      .join(' ');

  const consPath = buildPath((d) => d.conservativeEquityInr);
  const consAreaPath = `${consPath} L${getX(data.length - 1).toFixed(1)},${(padTop + plotH).toFixed(1)} L${padLeft.toFixed(1)},${(padTop + plotH).toFixed(1)} Z`;
  const paperPath = buildPath((d) => d.brokerPaperEquityInr);
  const niftyPath = buildPath((d) => d.niftyBenchmarkEquityInr);

  const activePoint = hoverIdx !== null ? data[hoverIdx] : data[data.length - 1];
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => minVal + t * valSpan);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800/80">
          <button
            type="button"
            onClick={() =>
              setVisibleCurves((prev) => ({ ...prev, conservative: !prev.conservative }))
            }
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              visibleCurves.conservative
                ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            Net Equity (After Slippage &amp; Fees)
          </button>
          <button
            type="button"
            onClick={() =>
              setVisibleCurves((prev) => ({ ...prev, brokerPaper: !prev.brokerPaper }))
            }
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              visibleCurves.brokerPaper
                ? 'bg-white dark:bg-slate-900 text-emerald-600 dark:text-emerald-400 shadow-xs'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            Gross Paper Fills
          </button>
          <button
            type="button"
            onClick={() => setVisibleCurves((prev) => ({ ...prev, nifty: !prev.nifty }))}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              visibleCurves.nifty
                ? 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 shadow-xs'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            NIFTY 50 Benchmark
          </button>
        </div>

        {activePoint && (
          <div className="flex flex-wrap items-center gap-2.5 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            <span>{formatTimestamp(activePoint.recordedAt)}</span>
            <span aria-hidden="true">·</span>
            <span className="text-blue-600 dark:text-blue-400 font-semibold">
              Net: {formatInr(activePoint.conservativeEquityInr)}
            </span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-600 dark:text-emerald-400">
              Gross: {formatInr(activePoint.brokerPaperEquityInr)}
            </span>
            <span aria-hidden="true">·</span>
            <span>NIFTY: {formatInr(activePoint.niftyBenchmarkEquityInr)}</span>
          </div>
        )}
      </div>

      <div className="relative w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-72 select-none"
          role="img"
          aria-label="Equity Curve comparing Net Conservative Equity, Gross Paper Fills, and NIFTY 50 Benchmark"
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id="netEquityFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
            </linearGradient>
          </defs>

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
                  className="text-slate-200/80 dark:text-slate-800/80"
                  strokeDasharray="3 3"
                />
                <text
                  x={padLeft - 10}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-slate-400 dark:fill-slate-500 text-[11px] font-mono tabular-nums"
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
              strokeWidth="1.5"
              strokeDasharray="4 4"
            />
          )}

          {visibleCurves.brokerPaper && (
            <path
              d={paperPath}
              fill="none"
              stroke="#10b981"
              strokeWidth="1.75"
              strokeOpacity="0.75"
            />
          )}

          {visibleCurves.conservative && (
            <>
              <path d={consAreaPath} fill="url(#netEquityFill)" />
              <path d={consPath} fill="none" stroke="#3b82f6" strokeWidth="2.5" />
            </>
          )}

          {hoverIdx !== null && (
            <line
              x1={getX(hoverIdx)}
              y1={padTop}
              x2={getX(hoverIdx)}
              y2={height - padBottom}
              stroke="#94a3b8"
              strokeWidth="1"
              strokeDasharray="2 2"
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
