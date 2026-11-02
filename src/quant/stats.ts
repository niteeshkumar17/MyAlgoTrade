/** Small, dependency-free statistics helpers used by the engine, the research report and the API. */

export function mean(xs: number[]): number | null {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Normal-approximation 90% confidence interval for the mean; null below 10 observations. */
export function meanCi90(xs: number[]): [number, number] | null {
  if (xs.length < 10) return null;
  const m = mean(xs)!;
  const half = (1.645 * stdev(xs)!) / Math.sqrt(xs.length);
  return [m - half, m + half];
}

export function profitFactor(pnls: number[]): number | null {
  const gains = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = -pnls.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  if (losses === 0) return null;
  return gains / losses;
}

export function maxDrawdownPct(equity: number[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    if (peak > 0) dd = Math.max(dd, (peak - e) / peak);
  }
  return dd;
}

export interface GroupStat {
  key: string;
  n: number;
  winRate: number | null;
  avgR: number | null;
  totalR: number;
  netPnlInr: number;
  expectancyInr: number | null;
  profitFactor: number | null;
}

export function groupStats<T>(
  items: T[],
  keyFn: (t: T) => string,
  pnlFn: (t: T) => number,
  rFn: (t: T) => number
): GroupStat[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = keyFn(it);
    const arr = groups.get(k);
    if (arr) arr.push(it);
    else groups.set(k, [it]);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const pnls = list.map(pnlFn);
      const rs = list.map(rFn);
      return {
        key,
        n: list.length,
        winRate: list.length ? pnls.filter((p) => p > 0).length / list.length : null,
        avgR: mean(rs),
        totalR: rs.reduce((a, b) => a + b, 0),
        netPnlInr: pnls.reduce((a, b) => a + b, 0),
        expectancyInr: mean(pnls),
        profitFactor: profitFactor(pnls),
      };
    })
    .sort((a, b) => b.n - a.n);
}

/** Beta(1+wins, 1+losses) posterior mean and an approximate 90% credible interval for a win rate. */
export function betaWinRate(wins: number, losses: number) {
  const a = 1 + wins;
  const b = 1 + losses;
  const m = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  return { mean: m, lo: Math.max(0, m - 1.645 * sd), hi: Math.min(1, m + 1.645 * sd) };
}
