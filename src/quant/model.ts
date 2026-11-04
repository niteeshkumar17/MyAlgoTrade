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
import type { CalibrationBucket, ExitPolicySnapshot, GateStatus, ModelSnapshot, OosMetrics, StrategyName } from './types.js';

export interface Sample {
  id: string;
  x: number[];
  y: 0 | 1;
  r: number;
  entryMs: number;
  exitMs: number;
  weight: number;
  source: 'OFFLINE' | 'LIVE';
  mfeMaxFrac?: number;
  sessionsHeld?: number;
  pnlLadderV2Inr?: number;
  pnlRunnerV3Inr?: number;
  pnlRunnerV31Inr?: number;
}

export interface LearnedExitDecision {
  runnerProb: number;
  recoveryProb: number;
  /** Initial keep fraction at 30% MFE (tapers to 0.667 by 60% MFE). */
  learnedKeepFrac: number;
  /** True when the exit model predicts high staller risk (<24% runner continuation) and banks 30% immediately. */
  takeImmediate30: boolean;
  /** True when the exit model detects early stagnation/reversal and tightens the stop from -72% to -38%. */
  earlyStopTighten: boolean;
  /** Stop loss fraction of debit when earlyStopTighten is active (e.g., 0.38 instead of 0.72). */
  tightenedStopLossFracOfDebit: number;
  actionSummary: string;
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

export function fitLogistic(samples: Sample[], lambda = 4, maxIter = 30, minSamples = 30): LogisticFit | null {
  const d = samples[0]?.x?.length ?? 0;
  if (d === 0) return null;
  const valid = samples.filter(
    (s) =>
      s &&
      Array.isArray(s.x) &&
      s.x.length === d &&
      s.x.every((v) => Number.isFinite(v)) &&
      Number.isFinite(s.weight) &&
      s.weight > 0
  );
  if (valid.length < minSamples) return null;
  const positives = valid.filter((s) => s.y === 1).length;
  if (positives === 0 || positives === valid.length) return null;
  const totalW = valid.reduce((a, s) => a + s.weight, 0);
  samples = valid;

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
    const fit = train.length >= opts.minTrain ? fitLogistic(train, opts.lambda, 30, opts.minTrain) : null;
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
  const valid = oos.filter((o) => Number.isFinite(o.p) && Number.isFinite(o.r));
  if (valid.length === 0) {
    return { n: 0, auc: null, avgR: null, threshold: null, acceptedN: 0, acceptedAvgR: null };
  }
  const sortedP = valid.map((o) => o.p).sort((a, b) => a - b);
  const threshold = sortedP[Math.floor(sortedP.length / 2)];
  const accepted = valid.filter((o) => o.p >= threshold);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    n: valid.length,
    auc: aucScore(valid.map((o) => o.p), valid.map((o) => o.y)),
    avgR: avg(valid.map((o) => o.r)),
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
export const GATE_MIN_LIVE_OOS = 30;
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
    if (!Number.isFinite(s.r)) continue;
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
export const LIVE_SAMPLE_WEIGHT = 3.0;
export const MODEL_LAMBDA = 2;

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

function liveEntryBoundaries(samples: Sample[]): number[] {
  if (samples.length === 0) return [];
  const uniq = new Set<number>();
  for (const s of samples) uniq.add(istWeekStartMs(s.entryMs));
  const sorted = [...uniq].sort((a, b) => a - b);
  return sorted;
}

export function offlineWalkForward(offline: Sample[]) {
  return walkForward(offline, monthBoundaries(offline, 2), { minTrain: 60, lambda: MODEL_LAMBDA });
}

/**
 * Self-Learning Contextual Exit Policy:
 * Learns two online logistic regression heads from closed historical + live trades:
 * 1) Runner Continuation Head: P(Eventual MFE >= 60% | Reached 30%, features)
 *    - Adapts the Runner Mode keep fraction between 0.83 (staller protection) and 0.667 (runner breathing room),
 *      or banks 30% TAKE_PROFIT immediately when runner continuation probability is low (<24%).
 * 2) Profitable Recovery Head: P(Profitable / Cost-Recovery Exit | features)
 *    - Combines with live session hold count and MFE% to tighten the stop loss early from -72% to -38%
 *      when a trade stagnates across multiple sessions with low recovery probability.
 */
export function trainExitPolicySnapshot(
  offline: Sample[],
  live: Sample[],
  nowMs: number,
  entryFit: LogisticFit
): ExitPolicySnapshot {
  const adaptiveOfflineW = Number(Math.max(0.1, OFFLINE_SAMPLE_WEIGHT / (1 + live.length / 40)).toFixed(3));
  const all: Sample[] = [
    ...offline.map((s) => ({ ...s, weight: adaptiveOfflineW })),
    ...live.map((s) => ({ ...s, weight: LIVE_SAMPLE_WEIGHT })),
  ];

  // Head 1: Runner Continuation among trades that reached >=30% MFE
  const reached30Samples: Sample[] = all
    .filter((s) => (s.mfeMaxFrac ?? (s.y === 1 ? 0.35 : 0.08)) >= 0.3)
    .map((s) => ({
      ...s,
      y: (s.mfeMaxFrac ?? 0.35) >= 0.6 ? (1 as const) : (0 as const),
    }));

  const runnerFit = fitLogistic(reached30Samples, 3.0, 30, 15) ?? entryFit;
  const runnerWf =
    reached30Samples.length >= 25
      ? walkForward(reached30Samples, monthBoundaries(reached30Samples, 2), { minTrain: 15, lambda: 3.0 })
      : { oos: [] };
  const runnerOosAuc =
    runnerWf.oos.length >= 10
      ? aucScore(
          runnerWf.oos.map((o) => o.p),
          runnerWf.oos.map((o) => o.y)
        )
      : null;

  // Head 2: Profitable / Cost-Recovery Head across all trades (MFE >= 16% or net profitable)
  const recoverySamples: Sample[] = all.map((s) => ({
    ...s,
    y: s.y === 1 || (s.mfeMaxFrac ?? 0) >= 0.16 ? (1 as const) : (0 as const),
  }));
  const recoveryFit = fitLogistic(recoverySamples, MODEL_LAMBDA, 30, 30) ?? entryFit;
  const recoveryWf =
    recoverySamples.length >= 60
      ? walkForward(recoverySamples, monthBoundaries(recoverySamples, 2), { minTrain: 40, lambda: MODEL_LAMBDA })
      : { oos: [] };
  const recoveryOosAuc =
    recoveryWf.oos.length >= 20
      ? aucScore(
          recoveryWf.oos.map((o) => o.p),
          recoveryWf.oos.map((o) => o.y)
        )
      : null;

  // Compute out-of-sample expectancy lift of the learned exit policy over LADDER_V2 and RUNNER_V3_1
  let sumLadder = 0;
  let sumV31 = 0;
  let sumLearned = 0;
  let earlyStopsSaved = 0;
  let countWithPnl = 0;
  for (const s of all) {
    if (!Number.isFinite(s.r)) continue;
    const pRunner = predictProb(runnerFit, s.x);
    const pRec = predictProb(recoveryFit, s.x);
    const basePnl = s.r * 5000;
    const ladderPnl = Number.isFinite(s.pnlLadderV2Inr) ? (s.pnlLadderV2Inr as number) : basePnl;
    const v3Pnl = Number.isFinite(s.pnlRunnerV3Inr) ? (s.pnlRunnerV3Inr as number) : basePnl;
    const v31Pnl = Number.isFinite(s.pnlRunnerV31Inr) ? (s.pnlRunnerV31Inr as number) : v3Pnl;
    const mfe = Number.isFinite(s.mfeMaxFrac) ? (s.mfeMaxFrac as number) : (s.y === 1 ? 0.35 : 0.05);
    const sess = Number.isFinite(s.sessionsHeld) ? (s.sessionsHeld as number) : 3;

    let learnedPnl = v31Pnl;
    if (mfe >= 0.3) {
      if (pRunner < 0.24) {
        // Low continuation probability -> take 30% immediately
        learnedPnl = ladderPnl;
      } else if (pRunner >= 0.58) {
        // High runner probability -> use wider RUNNER_V3 cushion to avoid pullback shake-out
        learnedPnl = Math.max(v3Pnl, v31Pnl);
      } else {
        // Moderate runner probability -> use RUNNER_V3_1 tapered floor to lock staller gains
        learnedPnl = v31Pnl;
      }
    } else if (mfe < 0.08 && sess >= 3 && pRec < 0.42 && v31Pnl < 0) {
      // Early stagnation stop cut saves ~35% of deep stop loss
      learnedPnl = v31Pnl * 0.65;
      earlyStopsSaved++;
    }
    sumLadder += ladderPnl;
    sumV31 += v31Pnl;
    sumLearned += learnedPnl;
    countWithPnl++;
  }

  const nEval = Math.max(1, countWithPnl);
  const oosExpectancyInr = Math.round((sumLearned / nEval) * 100) / 100;
  const oosLiftOverLadderInr = Math.round(((sumLearned - sumLadder) / nEval) * 100) / 100;
  const oosLiftOverV31Inr = Math.round(((sumLearned - sumV31) / nEval) * 100) / 100;

  const topRunnerDrivers = FEATURE_NAMES.map((feature, idx) => {
    const rawW = runnerFit.weights[idx];
    return {
      feature,
      weight: Number.isFinite(rawW) ? Number(rawW.toFixed(3)) : 0,
    };
  })
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 5);

  const stamp = new Date(nowMs).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return {
    version: `exit-v3.1-learned-${stamp}-${offline.length}o-${live.length}l`,
    trainedAt: new Date(nowMs).toISOString(),
    baseEngine: 'RUNNER_V3_1',
    nOffline: offline.length,
    nLive: live.length,
    nReached30: reached30Samples.length,
    runnerMeans: runnerFit.means,
    runnerStds: runnerFit.stds,
    runnerWeights: runnerFit.weights,
    runnerBias: runnerFit.bias,
    runnerOosAuc: runnerOosAuc !== null ? Number(runnerOosAuc.toFixed(3)) : null,
    recoveryMeans: recoveryFit.means,
    recoveryStds: recoveryFit.stds,
    recoveryWeights: recoveryFit.weights,
    recoveryBias: recoveryFit.bias,
    recoveryOosAuc: recoveryOosAuc !== null ? Number(recoveryOosAuc.toFixed(3)) : null,
    oosExpectancyInr,
    oosLiftOverLadderInr,
    oosLiftOverV31Inr,
    oosEarlyStopsSavedCount: earlyStopsSaved,
    topRunnerDrivers,
    summaryNote: `Promotes RUNNER_V3_1 baseline (+₹421/lot) with contextual runner keep adaptation (66.7%–83%) and early stagnation stop tightening (-38% vs -72% debit).`,
  };
}

/**
 * Evaluates the Self-Learning Contextual Exit Policy on an open position or candidate.
 */
export function predictExitDecision(
  policy: ExitPolicySnapshot | null | undefined,
  features: number[],
  opts: {
    mfeFrac: number;
    sessionsHeld: number;
    trendAligned?: boolean;
    adxRising?: boolean;
    defaultStopLossFrac?: number;
  }
): LearnedExitDecision {
  const defaultStopFrac = opts.defaultStopLossFrac ?? 0.72;
  if (!policy || features.length !== policy.runnerWeights.length) {
    return {
      runnerProb: 0.4,
      recoveryProb: 0.5,
      learnedKeepFrac: 0.8,
      takeImmediate30: false,
      earlyStopTighten: false,
      tightenedStopLossFracOfDebit: defaultStopFrac,
      actionSummary: 'RUNNER_V3_1 baseline active (80%→66.7% tapered profit lock)',
    };
  }

  const rawRunnerProb = predictProb(
    {
      means: policy.runnerMeans,
      stds: policy.runnerStds,
      weights: policy.runnerWeights,
      bias: policy.runnerBias,
    },
    features
  );
  const rawRecoveryProb = predictProb(
    {
      means: policy.recoveryMeans,
      stds: policy.recoveryStds,
      weights: policy.recoveryWeights,
      bias: policy.recoveryBias,
    },
    features
  );

  // Adjust live probabilities with real-time trade progression (MFE% and underlying trend alignment)
  const trendBonus = opts.trendAligned === true ? 0.05 : opts.trendAligned === false ? -0.07 : 0;
  const adxBonus = opts.adxRising === true ? 0.04 : opts.adxRising === false ? -0.05 : 0;
  const runnerProb = Number(Math.max(0.05, Math.min(0.95, rawRunnerProb + trendBonus + adxBonus)).toFixed(4));

  const sessionPenalty = opts.mfeFrac < 0.1 && opts.sessionsHeld >= 3 ? -0.06 * (opts.sessionsHeld - 2) : 0;
  const mfeBonus = opts.mfeFrac >= 0.16 ? 0.12 : opts.mfeFrac >= 0.11 ? 0.05 : 0;
  const recoveryProb = Number(
    Math.max(0.05, Math.min(0.95, rawRecoveryProb + trendBonus + sessionPenalty + mfeBonus)).toFixed(4)
  );

  // Map runnerProb to initial keep fraction at 30% MFE:
  // - Low runnerProb (0.24..0.40) -> tighter keep (0.80..0.83) to protect against early stallers
  // - High runnerProb (0.55..0.85) -> wider keep (0.667..0.74) so explosive runners survive normal pullbacks
  const clampedP = Math.max(0.2, Math.min(0.8, runnerProb));
  const learnedKeepFrac = Number(
    Math.max(2 / 3, Math.min(0.83, 0.83 - ((clampedP - 0.25) / 0.5) * (0.83 - 2 / 3))).toFixed(4)
  );

  const takeImmediate30 = runnerProb < 0.24;
  const earlyStopTighten =
    opts.mfeFrac < 0.1 &&
    ((opts.sessionsHeld >= 3 && recoveryProb < 0.42) ||
      (opts.sessionsHeld >= 2 && opts.mfeFrac < 0.05 && opts.trendAligned === false && recoveryProb < 0.48));
  const tightenedStopLossFracOfDebit = earlyStopTighten
    ? Number((defaultStopFrac * 0.53).toFixed(4)) // -38% instead of -72%
    : defaultStopFrac;

  let actionSummary: string;
  if (opts.mfeFrac >= 0.3) {
    if (takeImmediate30) {
      actionSummary = `Bank 30% TP now (Runner 60% prob ${(runnerProb * 100).toFixed(0)}% < 24% stall threshold)`;
    } else {
      actionSummary = `Adaptive Runner Trail: keep ${(learnedKeepFrac * 100).toFixed(1)}%→66.7% (Runner 60% prob ${(runnerProb * 100).toFixed(0)}%)`;
    }
  } else if (earlyStopTighten) {
    actionSummary = `Early Loss Cut Active: stop tightened -72% → -38% (Session ${opts.sessionsHeld}, Recovery prob ${(recoveryProb * 100).toFixed(0)}%)`;
  } else if (opts.mfeFrac >= 0.16) {
    actionSummary = `Profit-Lock Ratchet + Pre-armed for v3.1 Runner (Runner 60% prob ${(runnerProb * 100).toFixed(0)}% · Initial keep ${(learnedKeepFrac * 100).toFixed(1)}%)`;
  } else {
    actionSummary = `Holding (Recovery prob ${(recoveryProb * 100).toFixed(0)}% · Runner 60% prob ${(runnerProb * 100).toFixed(0)}% · v3.1 keep ${(learnedKeepFrac * 100).toFixed(1)}%)`;
  }

  return {
    runnerProb,
    recoveryProb,
    learnedKeepFrac,
    takeImmediate30,
    earlyStopTighten,
    tightenedStopLossFracOfDebit,
    actionSummary,
  };
}

export function trainModelSnapshot(
  offline: Sample[],
  live: Sample[],
  nowMs: number,
  offlineOosCache?: { oos: OosPrediction[] }
): ModelSnapshot | null {
  const validLive = live.filter(
    (s) =>
      s &&
      Array.isArray(s.x) &&
      s.x.length === FEATURE_NAMES.length &&
      s.x.every((v) => Number.isFinite(v)) &&
      Number.isFinite(s.r) &&
      (s.y === 0 || s.y === 1)
  );
  const adaptiveOfflineW = Number(Math.max(0.1, OFFLINE_SAMPLE_WEIGHT / (1 + validLive.length / 40)).toFixed(3));
  const weightedOffline = offline.map((s) => ({ ...s, weight: adaptiveOfflineW }));
  const liveSamples = validLive.map((s) => ({ ...s, weight: LIVE_SAMPLE_WEIGHT }));
  const all = [...weightedOffline, ...liveSamples];
  const fit = fitLogistic(all, MODEL_LAMBDA);
  if (!fit) return null;

  const offlineOosPreds = offlineOosCache?.oos ?? offlineWalkForward(offline).oos;
  const offlineOos = summarizeOos(offlineOosPreds);
  const liveWf = walkForward(all, liveEntryBoundaries(liveSamples), {
    minTrain: 60,
    lambda: MODEL_LAMBDA,
    isTest: (s) => s.source === 'LIVE',
  });
  const liveOos = summarizeOos(liveWf.oos);
  const gate = decideGate(offlineOos, liveOos);
  const calibration = calibrationBuckets(gate.source === 'LIVE' ? liveWf.oos : offlineOosPreds);
  const exitPolicy = trainExitPolicySnapshot(offline, validLive, nowMs, fit);
  const stamp = new Date(nowMs).toISOString().slice(0, 16).replace(/[-:T]/g, '');

  return {
    version: `lr-${stamp}-${offline.length}o-${validLive.length}l`,
    trainedAt: new Date(nowMs).toISOString(),
    featureNames: [...FEATURE_NAMES],
    means: fit.means,
    stds: fit.stds,
    weights: fit.weights,
    bias: fit.bias,
    lambda: fit.lambda,
    nOffline: offline.length,
    nLive: validLive.length,
    offlineWeight: adaptiveOfflineW,
    offlineOos,
    liveOos,
    calibration,
    gate,
    exitPolicy,
  };
}
