/**
 * Trade-quality model: L2-regularised logistic regression (Newton's method) predicting whether a
 * candidate spread closes with a profit after costs, evaluated strictly walk-forward.
 *
 * A fold only trains on samples whose exit happened before the fold starts, so no label from the
 * test period (or still unknown at that time) leaks into training.
 */

import { istMonthStartMs, istWeekStartMs } from './clock.js';
import { FEATURE_NAMES } from './signals.js';
import { meanCi90 } from './stats.js';
import type { CalibrationBucket, GateStatus, ModelSnapshot, OosMetrics, StrategyName } from './types.js';

export interface Sample {
  id: string;
  x: number[];
  y: 0 | 1;
  r: number;
  entryMs: number;
  exitMs: number;
  weight: number;
  source: 'OFFLINE' | 'LIVE';
}

export interface LogisticFit {
  means: number[];
  stds: number[];
  weights: number[];
  bias: number;
  lambda: number;
  n: number;
}

export interface OosPrediction {
  id: string;
  p: number;
  y: 0 | 1;
  r: number;
  source: 'OFFLINE' | 'LIVE';
}

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

export function fitLogistic(samples: Sample[], lambda = 4, maxIter = 30): LogisticFit | null {
  if (samples.length < 30) return null;
  const positives = samples.filter((s) => s.y === 1).length;
  if (positives === 0 || positives === samples.length) return null;
  const d = samples[0].x.length;
  const totalW = samples.reduce((a, s) => a + s.weight, 0);

  const means = new Array<number>(d).fill(0);
  for (const s of samples) for (let j = 0; j < d; j++) means[j] += (s.weight * s.x[j]) / totalW;
  const stds = new Array<number>(d).fill(0);
  for (const s of samples) for (let j = 0; j < d; j++) stds[j] += (s.weight * (s.x[j] - means[j]) ** 2) / totalW;
  for (let j = 0; j < d; j++) stds[j] = Math.sqrt(stds[j]);

  const z = samples.map((s) => [1, ...s.x.map((v, j) => (stds[j] > 1e-9 ? (v - means[j]) / stds[j] : 0))]);
  const baseRate = samples.reduce((a, s) => a + s.weight * s.y, 0) / totalW;
  const theta = new Array<number>(d + 1).fill(0);
  theta[0] = Math.log(baseRate / (1 - baseRate));

  for (let iter = 0; iter < maxIter; iter++) {
    const grad = new Array<number>(d + 1).fill(0);
    const hess = Array.from({ length: d + 1 }, () => new Array<number>(d + 1).fill(0));
    for (let i = 0; i < samples.length; i++) {
      const zi = z[i];
      let dot = 0;
      for (let j = 0; j <= d; j++) dot += theta[j] * zi[j];
      const p = sigmoid(dot);
      const w = samples[i].weight;
      const g = w * (p - samples[i].y);
      const h = w * p * (1 - p);
      for (let j = 0; j <= d; j++) {
        grad[j] += g * zi[j];
        const hz = h * zi[j];
        for (let k = j; k <= d; k++) hess[j][k] += hz * zi[k];
      }
    }
    for (let j = 0; j <= d; j++) for (let k = 0; k < j; k++) hess[j][k] = hess[k][j];
    for (let j = 1; j <= d; j++) {
      grad[j] += lambda * theta[j];
      hess[j][j] += lambda;
    }
    hess[0][0] += 1e-6;
    const step = solveLinear(hess, grad);
    if (!step) break;
    let maxStep = 0;
    for (let j = 0; j <= d; j++) {
      theta[j] -= step[j];
      maxStep = Math.max(maxStep, Math.abs(step[j]));
    }
    if (maxStep < 1e-7) break;
  }
  return { means, stds, weights: theta.slice(1), bias: theta[0], lambda, n: samples.length };
}

export function predictProb(
  fit: Pick<LogisticFit, 'means' | 'stds' | 'weights' | 'bias'>,
  x: number[]
): number {
  let dot = fit.bias;
  for (let j = 0; j < fit.weights.length; j++) {
    const zj = fit.stds[j] > 1e-9 ? (x[j] - fit.means[j]) / fit.stds[j] : 0;
    dot += fit.weights[j] * zj;
  }
  return sigmoid(dot);
}

/** Area under the ROC curve via the Mann-Whitney statistic with average ranks for ties. */
export function aucScore(preds: number[], labels: number[]): number | null {
  const pos = labels.filter((y) => y === 1).length;
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) return null;
  const order = preds.map((p, i) => ({ p, y: labels[i] })).sort((a, b) => a.p - b.p);
  let rankSumPos = 0;
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].p === order[i].p) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (order[k].y === 1) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

export interface FoldResult {
  start: string;
  nTrain: number;
  nTest: number;
  auc: number | null;
}

export function walkForward(
  samples: Sample[],
  boundaries: number[],
  opts: { minTrain: number; lambda: number; isTest?: (s: Sample) => boolean }
): { oos: OosPrediction[]; folds: FoldResult[] } {
  const oos: OosPrediction[] = [];
  const folds: FoldResult[] = [];
  for (let k = 0; k < boundaries.length; k++) {
    const start = boundaries[k];
    const end = boundaries[k + 1] ?? Infinity;
    const test = samples.filter(
      (s) => s.entryMs >= start && s.entryMs < end && (opts.isTest ? opts.isTest(s) : true)
    );
    if (test.length === 0) continue;
    const train = samples.filter((s) => s.exitMs < start);
    const fit = train.length >= opts.minTrain ? fitLogistic(train, opts.lambda) : null;
    if (!fit) {
      folds.push({ start: new Date(start).toISOString(), nTrain: train.length, nTest: test.length, auc: null });
      continue;
    }
    const preds = test.map((s) => predictProb(fit, s.x));
    test.forEach((s, i) => oos.push({ id: s.id, p: preds[i], y: s.y, r: s.r, source: s.source }));
    folds.push({
      start: new Date(start).toISOString(),
      nTrain: train.length,
      nTest: test.length,
      auc: aucScore(preds, test.map((s) => s.y)),
    });
  }
  return { oos, folds };
}

export function summarizeOos(oos: OosPrediction[]): OosMetrics {
  if (oos.length === 0) {
    return { n: 0, auc: null, avgR: null, threshold: null, acceptedN: 0, acceptedAvgR: null };
  }
  const sortedP = oos.map((o) => o.p).sort((a, b) => a - b);
  const threshold = sortedP[Math.floor(sortedP.length / 2)];
  const accepted = oos.filter((o) => o.p >= threshold);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    n: oos.length,
    auc: aucScore(oos.map((o) => o.p), oos.map((o) => o.y)),
    avgR: avg(oos.map((o) => o.r)),
    threshold,
    acceptedN: accepted.length,
    acceptedAvgR: avg(accepted.map((o) => o.r)),
  };
}

export function calibrationBuckets(oos: OosPrediction[], buckets = 5): CalibrationBucket[] {
  if (oos.length < buckets * 5) return [];
  const sorted = [...oos].sort((a, b) => a.p - b.p);
  const out: CalibrationBucket[] = [];
  for (let b = 0; b < buckets; b++) {
    const slice = sorted.slice(
      Math.floor((b * sorted.length) / buckets),
      Math.floor(((b + 1) * sorted.length) / buckets)
    );
    if (slice.length === 0) continue;
    out.push({
      lo: slice[0].p,
      hi: slice[slice.length - 1].p,
      n: slice.length,
      avgPred: slice.reduce((a, o) => a + o.p, 0) / slice.length,
      winRate: slice.filter((o) => o.y === 1).length / slice.length,
    });
  }
  return out;
}

export const GATE_MIN_AUC = 0.55;
export const GATE_MIN_LIVE_OOS = 100;
export const GATE_MIN_OFFLINE_OOS = 150;

/**
 * The gate only filters entries once out-of-sample evidence shows the model ranks trades better than
 * chance and its top half earned more than average. Live evidence replaces offline evidence once
 * there are enough live out-of-sample predictions.
 */
export function decideGate(offline: OosMetrics, live: OosMetrics): GateStatus {
  const useLive = live.n >= GATE_MIN_LIVE_OOS;
  const m = useLive ? live : offline;
  const source: GateStatus['source'] = useLive ? 'LIVE' : offline.n > 0 ? 'OFFLINE' : 'NONE';
  const minN = useLive ? GATE_MIN_LIVE_OOS : GATE_MIN_OFFLINE_OOS;
  const label = useLive ? 'live' : 'offline (model-priced)';
  if (m.n < minN) {
    return {
      active: false,
      threshold: null,
      source,
      reason: `Observing: only ${m.n} ${label} out-of-sample predictions (needs ${minN}). Every signal that passes risk limits is taken.`,
    };
  }
  if (m.auc === null || m.auc < GATE_MIN_AUC) {
    return {
      active: false,
      threshold: null,
      source,
      reason: `Observing: ${label} out-of-sample AUC ${m.auc === null ? 'n/a' : m.auc.toFixed(3)} is below ${GATE_MIN_AUC}, so the model cannot yet rank trades better than chance.`,
    };
  }
  if (m.acceptedAvgR === null || m.avgR === null || m.acceptedAvgR <= m.avgR) {
    return {
      active: false,
      threshold: null,
      source,
      reason: `Observing: the model's top-half picks did not earn more than average out of sample (${label}).`,
    };
  }
  return {
    active: true,
    threshold: m.threshold,
    source,
    reason: `Active: ${label} out-of-sample AUC ${m.auc.toFixed(3)} on ${m.n} predictions; top-half picks averaged ${m.acceptedAvgR.toFixed(3)}R vs ${m.avgR.toFixed(3)}R overall.`,
  };
}

/** Suspend a strategy once live trades show a negative mean R even at the top of a 90% interval. */
export function suspendedStrategies(
  samples: Array<{ strategy: StrategyName; r: number }>,
  minSamples = 40
): StrategyName[] {
  const grouped = new Map<StrategyName, number[]>();
  for (const s of samples) {
    const arr = grouped.get(s.strategy);
    if (arr) arr.push(s.r);
    else grouped.set(s.strategy, [s.r]);
  }
  const out: StrategyName[] = [];
  for (const [strategy, rs] of grouped) {
    if (rs.length < minSamples) continue;
    const ci = meanCi90(rs);
    if (ci && ci[1] < 0) out.push(strategy);
  }
  return out;
}

export const OFFLINE_SAMPLE_WEIGHT = 0.3;
export const MODEL_LAMBDA = 4;

function monthBoundaries(samples: Sample[], skipMonths: number): number[] {
  if (samples.length === 0) return [];
  const first = Math.min(...samples.map((s) => s.entryMs));
  const last = Math.max(...samples.map((s) => s.entryMs));
  const out: number[] = [];
  let cursor = istMonthStartMs(first);
  for (let i = 0; cursor <= last; i++) {
    if (i >= skipMonths) out.push(cursor);
    cursor = istMonthStartMs(cursor + 32 * 86_400_000);
  }
  return out;
}

function weekBoundaries(samples: Sample[], skipWeeks: number): number[] {
  if (samples.length === 0) return [];
  const first = Math.min(...samples.map((s) => s.entryMs));
  const last = Math.max(...samples.map((s) => s.entryMs));
  const out: number[] = [];
  let cursor = istWeekStartMs(first);
  for (let i = 0; cursor <= last; i++) {
    if (i >= skipWeeks) out.push(cursor);
    cursor += 7 * 86_400_000;
  }
  return out;
}

export function offlineWalkForward(offline: Sample[]) {
  return walkForward(offline, monthBoundaries(offline, 2), { minTrain: 100, lambda: MODEL_LAMBDA });
}

export function trainModelSnapshot(
  offline: Sample[],
  live: Sample[],
  nowMs: number,
  offlineOosCache?: { oos: OosPrediction[] }
): ModelSnapshot | null {
  const weightedOffline = offline.map((s) => ({ ...s, weight: OFFLINE_SAMPLE_WEIGHT }));
  const liveSamples = live.map((s) => ({ ...s, weight: 1 }));
  const all = [...weightedOffline, ...liveSamples];
  const fit = fitLogistic(all, MODEL_LAMBDA);
  if (!fit) return null;

  const offlineOosPreds = offlineOosCache?.oos ?? offlineWalkForward(offline).oos;
  const offlineOos = summarizeOos(offlineOosPreds);
  const liveWf = walkForward(all, weekBoundaries(liveSamples, 1), {
    minTrain: 100,
    lambda: MODEL_LAMBDA,
    isTest: (s) => s.source === 'LIVE',
  });
  const liveOos = summarizeOos(liveWf.oos);
  const gate = decideGate(offlineOos, liveOos);
  const calibration = calibrationBuckets(gate.source === 'LIVE' ? liveWf.oos : offlineOosPreds);
  const stamp = new Date(nowMs).toISOString().slice(0, 16).replace(/[-:T]/g, '');

  return {
    version: `lr-${stamp}-${offline.length}o-${live.length}l`,
    trainedAt: new Date(nowMs).toISOString(),
    featureNames: [...FEATURE_NAMES],
    means: fit.means,
    stds: fit.stds,
    weights: fit.weights,
    bias: fit.bias,
    lambda: fit.lambda,
    nOffline: offline.length,
    nLive: live.length,
    offlineWeight: OFFLINE_SAMPLE_WEIGHT,
    offlineOos,
    liveOos,
    calibration,
    gate,
  };
}
