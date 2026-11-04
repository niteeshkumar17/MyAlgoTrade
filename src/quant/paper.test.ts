import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { filterScripMaster, generateAngelTotp } from './angelOneSmartApi.js';
import { hourlyBarEndMs, istToMs, parseAngelExpiry, parseAngelFeedTime } from './clock.js';
import { computeIndicators } from './indicators.js';
import type { MarketData } from './marketData.js';
import { aucScore, fitLogistic, predictExitDecision, predictProb, trainModelSnapshot, walkForward, type Sample } from './model.js';
import { buildSpreadPlan, evaluateSpreadExit, exitLevels, legCharges } from './options.js';
import { readJournal, runPaperCycle } from './paperEngine.js';
import { computeReadiness } from './readiness.js';
import { loadHistoricalCache, runOfflineResearch } from './research.js';
import { DEFAULT_ENGINE_CONFIG, evaluateEntryRisk } from './risk.js';
import { detectSignal } from './signals.js';
import { MemoryKvStore } from './store.js';
import type { Candle, LegQuote, NfoInstrument, SpotQuote, SpreadPlan } from './types.js';

function sessionBars(): Candle[] {
  const out: Candle[] = [];
  let cursor = istToMs('2026-09-01', 9, 15);
  const end = istToMs('2026-11-02', 9, 15);
  while (cursor <= end) {
    const p = new Date(cursor + 5.5 * 3600 * 1000);
    const wd = p.getUTCDay();
    const hour = p.getUTCHours();
    const minute = p.getUTCMinutes();
    if (wd >= 1 && wd <= 5 && minute === 15 && hour >= 9 && hour <= 15) {
      out.push({ time: new Date(cursor).toISOString(), open: 0, high: 0, low: 0, close: 0, volume: 1 });
    }
    cursor += 60 * 60 * 1000;
  }
  out.forEach((bar, i) => {
    const close = i < out.length - 10 ? 24000 + (i % 2 === 0 ? 20 : -20) : 24100 + (i - (out.length - 10)) * 90;
    bar.open = close - 10;
    bar.high = close + 5;
    bar.low = close - 15;
    bar.close = close;
  });
  return out;
}

describe('clock and charges', () => {
  it('parses Angel expiry and feed time in IST', () => {
    assert.equal(parseAngelExpiry('23NOV2026'), '2026-11-23');
    assert.equal(parseAngelExpiry('nope'), null);
    const feed = parseAngelFeedTime('02-Nov-2026 10:05:21');
    assert.equal(feed, istToMs('2026-11-02', 10, 5, 21));
    assert.equal(parseAngelFeedTime(''), null);
    const start = istToMs('2026-11-02', 15, 15);
    assert.equal(hourlyBarEndMs(start), istToMs('2026-11-02', 15, 30));
  });

  it('charges a buy and a sell from the statutory schedule', () => {
    assert.equal(legCharges('BUY', 100, 65), 26.49);
    assert.equal(legCharges('SELL', 100, 65), 36.04);
    assert.equal(legCharges('BUY', 100, 0), 0);
  });

  it('generates a 6-digit TOTP', () => {
    const code = generateAngelTotp('JBSWY3DPEHPK3PXP', 1_700_000_000_000);
    assert.match(code, /^\d{6}$/);
    assert.equal(code, generateAngelTotp('JBSWY3DPEHPK3PXP', 1_700_000_000_000));
  });
});

describe('spreads, risk and the model', () => {
  const now = istToMs('2026-11-02', 10, 30);
  const quote = (token: string, bid: number, ask: number): LegQuote => ({
    token, ltp: (bid + ask) / 2, bid, ask, hasDepth: true, feedTimeMs: now, volume: 1, oi: 1,
  });

  it('buys the widest affordable debit spread and refuses a book with no bid', () => {
    const chain = [24000, 24050, 24100].map((strike) => ({
      token: String(strike), symbol: `N${strike}CE`, strike, lotSize: 65,
    }));
    const quotes: Record<string, LegQuote> = {
      24000: quote('24000', 28, 30),
      24050: quote('24050', 10, 10.8),
      24100: quote('24100', 10, 10.8),
    };
    const built = buildSpreadPlan({
      underlying: 'NIFTY', right: 'CE', expiry: '2026-11-24', dte: 22, spot: 24000,
      chain, quotes, budgetPerTradeInr: 2000, nowMs: now, cfg: DEFAULT_ENGINE_CONFIG,
    });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(built.affordable, true);
    assert.equal(built.plan.short.strike, 24100);
    assert.equal(built.plan.entryDebit, 20);
    quotes['24000'] = { ...quotes['24000'], bid: 0 };
    const rejected = buildSpreadPlan({
      underlying: 'NIFTY', right: 'CE', expiry: '2026-11-24', dte: 22, spot: 24000,
      chain, quotes, budgetPerTradeInr: 2000, nowMs: now, cfg: DEFAULT_ENGINE_CONFIG,
    });
    assert.equal(rejected.ok, false);
  });

  it('exits at the take-profit and ratchets the floor up when peak profit reaches 17% or 29.5% of max gain', () => {
    const reason = evaluateSpreadExit({
      plan: { entryDebit: 20, width: 100 },
      liquidationValue: 70,
      sessionsHeld: 1,
      dte: 20,
      cfg: DEFAULT_ENGINE_CONFIG,
    });
    assert.equal(reason, 'TAKE_PROFIT');

    // RELIANCE 1300/1330 CE example: entry 11.20, width 30, maxGain 18.80
    const relPlan = { entryDebit: 11.2, width: 30 };
    // At Peak 14.40 (17.02% of maxGain), Stage 2 BREAKEVEN_LOCK ratchets floor above entryDebit (12.30 vs 3.14 initial)
    const stage2 = exitLevels(relPlan, DEFAULT_ENGINE_CONFIG, { peakValue: 14.4, sessionsHeld: 1 });
    assert.equal(stage2.stage, 'BREAKEVEN_LOCK');
    assert.ok(stage2.stop > relPlan.entryDebit);
    assert.equal(stage2.stop, 12.3);

    // At 29.5% of maxGain (Peak 16.75), Stage 3 PROFIT_TRAIL locks in ~14.91 (+19.7% of maxGain)
    const stage3 = exitLevels(relPlan, DEFAULT_ENGINE_CONFIG, { peakValue: 16.75, sessionsHeld: 1 });
    assert.equal(stage3.stage, 'PROFIT_TRAIL');
    assert.ok(stage3.stop >= 14.9);
    // If market reverses from 16.75 down to 14.80, it exits as TRAIL_STOP instead of falling to -72% (3.14)
    const trailExit = evaluateSpreadExit({
      plan: relPlan,
      liquidationValue: 14.8,
      peakValue: 16.75,
      sessionsHeld: 1,
      dte: 20,
      cfg: DEFAULT_ENGINE_CONFIG,
    });
    assert.equal(trailExit, 'TRAIL_STOP');

    // Runner Mode v3 & v3.1 verification on RELIANCE 1300/1330 CE (E=11.20, W=30.00, G=18.80, Lot=500):
    // 30% MFE (P=16.84): v3 floor=14.96 (+1880), v3.1 floor=15.71 (+2256, +376 more)
    const runner30 = exitLevels(relPlan, DEFAULT_ENGINE_CONFIG, { peakValue: 16.84, runnerArmed: true, sessionsHeld: 1 });
    assert.equal(runner30.stage, 'RUNNER_MODE');
    assert.equal(runner30.runnerFloorV3, 14.96);
    assert.equal(runner30.runnerFloorV31, 15.71);
    assert.equal(runner30.runnerCushionV3, 1.88);
    assert.equal(runner30.runnerCushionV31, 1.13);
    assert.equal(runner30.ceilingTarget, 25.3);

    // 35% MFE (P=17.78): v3 floor=15.59 (+2195), v3.1 floor=16.32 (+2560, +365 more)
    const runner35 = exitLevels(relPlan, DEFAULT_ENGINE_CONFIG, {
      peakValue: 17.78,
      runnerArmed: true,
      previousFloor: runner30.runnerFloorV3,
      previousFloorV31: runner30.runnerFloorV31,
      sessionsHeld: 1,
    });
    assert.equal(runner35.runnerFloorV3, 15.59);
    assert.equal(runner35.runnerFloorV31, 16.32);
    assert.equal(runner35.runnerCushionV3, 2.19);
    assert.equal(runner35.runnerCushionV31, 1.46);

    // 45% MFE (P=19.66): v3 floor=16.84 (+2820), v3.1 floor=17.40 (+3102, +282 more)
    const runner45 = exitLevels(relPlan, DEFAULT_ENGINE_CONFIG, {
      peakValue: 19.66,
      runnerArmed: true,
      previousFloor: runner35.runnerFloorV3,
      previousFloorV31: runner35.runnerFloorV31,
      sessionsHeld: 1,
    });
    assert.equal(runner45.runnerFloorV3, 16.84);
    assert.equal(runner45.runnerFloorV31, 17.4);

    // 60% MFE (P=22.48): v3 floor=18.72 (+3760), v3.1 floor=18.72 (+3760, converged!)
    const runner60 = exitLevels(relPlan, DEFAULT_ENGINE_CONFIG, {
      peakValue: 22.48,
      runnerArmed: true,
      previousFloor: runner45.runnerFloorV3,
      previousFloorV31: runner45.runnerFloorV31,
      sessionsHeld: 1,
    });
    assert.equal(runner60.runnerFloorV3, 18.72);
    assert.equal(runner60.runnerFloorV31, 18.72);

    const ceilingExit = evaluateSpreadExit({
      plan: relPlan,
      liquidationValue: 25.3,
      peakValue: 25.3,
      runnerArmed: true,
      previousFloor: runner60.stop,
      sessionsHeld: 1,
      dte: 15,
      cfg: DEFAULT_ENGINE_CONFIG,
    });
    assert.equal(ceilingExit, 'TAKE_PROFIT');

    // Self-Learning Exit Policy (ADAPTIVE_LEARNED):
    // 1. High runner probability -> learnedKeepFrac closer to 0.72, low runner probability -> 0.82
    const learnedTight = exitLevels(relPlan, DEFAULT_ENGINE_CONFIG, {
      peakValue: 16.84,
      runnerArmed: true,
      variant: 'ADAPTIVE_LEARNED',
      learnedKeepFrac: 0.82,
      sessionsHeld: 1,
    });
    assert.ok(learnedTight.runnerFloorLearned > runner30.runnerFloorV31);
    assert.equal(learnedTight.stop, learnedTight.runnerFloorLearned);

    // 2. Early stop tightening (-38% of debit instead of -72%) when learnedEarlyStopTightened=true after >=3 stagnant sessions
    const tightened = exitLevels(relPlan, DEFAULT_ENGINE_CONFIG, {
      peakValue: 11.4,
      sessionsHeld: 3,
      variant: 'ADAPTIVE_LEARNED',
      learnedEarlyStopTightened: true,
    });
    assert.equal(tightened.stop, 6.93); // 11.20 * (1 - 0.72 * 0.53) = 6.93 vs 3.14 (-72%)
    assert.equal(tightened.ratcheted, true);
  });

  it('rejects a fourth position and a lot that risks more than the per-trade limit', () => {
    const plan = { underlying: 'NIFTY', maxLossPerLot: 1500, entryDebit: 20, lotSize: 65, long: { ask: 30 }, short: { bid: 10 }, spotAtEntry: 24000 } as SpreadPlan;
    const open = [1, 2, 3].map((n) => ({ underlying: `X${n}`, maxLossInr: 100, marginBlockedInr: 100 }));
    const full = evaluateEntryRisk({
      cfg: DEFAULT_ENGINE_CONFIG, equity: 50_000, cash: 50_000, entriesEnabled: true,
      killSwitchActive: false, dailyHalt: false, openPositions: open, isIndex: true, plan,
    });
    assert.equal(full.allowed, false);
    const pricey = evaluateEntryRisk({
      cfg: DEFAULT_ENGINE_CONFIG, equity: 50_000, cash: 50_000, entriesEnabled: true,
      killSwitchActive: false, dailyHalt: false, openPositions: [], isIndex: true,
      plan: { ...plan, maxLossPerLot: 6500 },
    });
    assert.equal(pricey.allowed, false);
    if (pricey.allowed) return;
    assert.equal(pricey.code, 'PER_TRADE_RISK');
  });

  it('ranks a separable sample and does not train on labels that are still in the future', () => {
    const xs: Sample[] = [];
    for (let i = 0; i < 40; i++) {
      const y = i % 2 === 0 ? 1 : 0;
      xs.push({ id: `t${i}`, x: [y === 1 ? 2 : -2], y, r: y === 1 ? 1 : -1, entryMs: i, exitMs: i + 1, weight: 1, source: 'OFFLINE' });
    }
    const fit = fitLogistic(xs, 1);
    assert.ok(fit);
    if (!fit) return;
    assert.ok(predictProb(fit, [2]) > predictProb(fit, [-2]));
    assert.ok(aucScore([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]) === 1);
    assert.ok((aucScore([0.2, 0.2, 0.8], [0, 1, 1]) ?? 0) > 0.5);

    const boundary = 1_000;
    const base: Sample[] = [];
    for (let i = 0; i < 40; i++) {
      const y = i < 20 ? 0 : 1;
      base.push({ id: `b${i}`, x: [y], y: y as 0 | 1, r: y === 1 ? 0.2 : -0.2, entryMs: i * 10, exitMs: 500, weight: 1, source: 'OFFLINE' });
    }
    const test: Sample[] = [0, 1].map((y, i) => ({
      id: `test${i}`, x: [y], y: y as 0 | 1, r: 0, entryMs: boundary + 10 + i, exitMs: boundary + 20, weight: 1, source: 'OFFLINE' as const,
    }));
    const poison: Sample = { id: 'poison', x: [100], y: 0, r: -5, entryMs: 100, exitMs: boundary + 5, weight: 1, source: 'OFFLINE' };
    const clean = walkForward([...base, ...test], [boundary], { minTrain: 30, lambda: 0.1 });
    const dirty = walkForward([...base, ...test, poison], [boundary], { minTrain: 30, lambda: 0.1 });
    assert.deepEqual(clean.oos.map((o) => o.p), dirty.oos.map((o) => o.p));
    assert.equal(clean.oos.length, 2);
  });
});

describe('instrument master filter', () => {
  it('keeps a near strike and drops an expired or far strike', () => {
    const now = istToMs('2026-11-02', 10, 0);
    const row = (expiry: string, strike: string) => ({
      exch_seg: 'NFO', instrumenttype: 'OPTIDX', name: 'NIFTY', expiry, symbol: 'NIFTYTESTCE',
      strike, lotsize: '65', token: strike, tick_size: '5.000000',
    });
    const kept = filterScripMaster(
      [row('24NOV2026', '2400000'), row('24NOV2026', '1000000'), row('01NOV2026', '2400000'), { exch_seg: 'NSE', name: 'NIFTY' }],
      now,
      { NIFTY: 24000 }
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].strike, 24000);
    assert.equal(kept[0].lotSize, 65);
  });
});

describe('paper ledger', () => {
  it('opens one spread from a real quote and closes it at the stop without inventing a second trade', async () => {
    const bars = sessionBars();
    const rows = computeIndicators(bars);
    const signal = detectSignal(bars, rows, bars.length - 1, null);
    assert.ok(signal, 'synthetic hourly bars should produce a breakout on the last bar');
    assert.equal(signal?.direction, 'CE');

    const spot = bars[bars.length - 1].close;
    const atm = Math.round(spot / 50) * 50;
    const instruments: NfoInstrument[] = [];
    for (const right of ['CE', 'PE'] as const) {
      for (let k = -4; k <= 4; k++) {
        const strike = atm + k * 50;
        instruments.push({
          token: `NIFTY-${strike}-${right}`, symbol: `NIFTY${strike}${right}`, underlying: 'NIFTY',
          expiry: '2026-11-24', strike, right, lotSize: 65, tickSize: 0.05,
        });
      }
    }
    let mode: 'entry' | 'exit' = 'entry';
    let now = istToMs('2026-11-02', 10, 30);
    const market: MarketData = {
      status: () => ({ configured: true, authenticated: true, lastLoginAt: null, lastQuoteFetchAt: null, lastError: null }),
      async fetchSpots() {
        const q: SpotQuote = { symbol: 'NIFTY', ltp: spot, open: spot, high: spot, low: spot, prevClose: spot, changePct: 0, feedTimeMs: now };
        return { NIFTY: q };
      },
      async fetchCandles(symbol) {
        return symbol === 'NIFTY' ? bars : [];
      },
      async fetchOptionQuotes(tokens) {
        const out: Record<string, LegQuote> = {};
        for (const token of tokens) {
          const strike = Number(token.split('-')[1]);
          const isAtm = strike === atm;
          const bid = mode === 'entry' ? (isAtm ? 28 : 10) : isAtm ? 4 : 11;
          const ask = mode === 'entry' ? (isAtm ? 30 : 10.8) : isAtm ? 4.3 : 12;
          out[token] = { token, ltp: (bid + ask) / 2, bid, ask, hasDepth: true, feedTimeMs: now, volume: 1, oi: 1 };
        }
        return out;
      },
      async fetchInstruments() {
        return instruments;
      },
    };
    const store = new MemoryKvStore();
    const first = await runPaperCycle(store, market, { nowMs: now, force: true, train: false, history: { NIFTY: bars } });
    assert.equal(first.persisted, true);
    assert.match(first.summary, /Live cycle/);
    const skipped = await runPaperCycle(store, market, { nowMs: now + 1000, train: false, history: { NIFTY: bars } });
    assert.equal(skipped.ran, false);
    now = istToMs('2026-11-02', 10, 35);
    const repeat = await runPaperCycle(store, market, { nowMs: now, force: true, train: false, history: { NIFTY: bars } });
    assert.equal(repeat.ran, true);
    const openLedger = await store.get<import('./types.js').LedgerState>(`PAPER_V2:${first.ledgerId}:STATE`);
    assert.equal(openLedger?.data.counters.tradesOpened, 1);
    assert.equal(openLedger?.data.openPositions.length, 1);
    const entryCash = openLedger!.data.openPositions[0].entryCashOutInr;
    assert.ok(openLedger!.data.cash < 50_000);

    mode = 'exit';
    now = istToMs('2026-11-02', 10, 40);
    const closed = await runPaperCycle(store, market, { nowMs: now, force: true, train: false, history: { NIFTY: bars } });
    assert.equal(closed.persisted, true);
    const final = await store.get<import('./types.js').LedgerState>(`PAPER_V2:${first.ledgerId}:STATE`);
    assert.equal(final?.data.openPositions.length, 0);
    assert.equal(final?.data.counters.tradesClosed, 1);
    assert.equal(final?.data.counters.tradesOpened, 1);
    const journal = await readJournal(store, first.ledgerId!, 'trades');
    const trade = journal[0] as { netPnlInr: number; exitReason: string; entryCashOutInr: number; exitCashInInr: number };
    assert.equal(trade.exitReason, 'STOP_LOSS');
    assert.ok(Math.abs(trade.netPnlInr - (trade.exitCashInInr - trade.entryCashOutInr)) < 0.02);
    assert.ok(Math.abs(final!.data.cash - (50_000 + trade.netPnlInr)) < 0.05);
    assert.equal(trade.entryCashOutInr, entryCash);
    assert.ok(trade.netPnlInr < 0);
  });
});

describe('research and readiness', () => {
  it('does not call an empty ledger ready for real money', () => {
    const report = computeReadiness({ trades: [], ledgerCreatedAt: new Date().toISOString(), nowMs: Date.now(), maxDrawdownPct: 0, liveOosAuc: null });
    assert.equal(report.readyForRealMoney, false);
    assert.ok(report.checks.some((c) => c.id === 'sample' && !c.pass));
  });

  it('loads the real hourly cache and labels the research as model-priced with positive prior and ML gate lift', () => {
    const cache = loadHistoricalCache();
    assert.ok(cache && cache.NIFTY.length > 1000);
    const research = runOfflineResearch(cache!);
    const report = research.report;
    assert.equal(report.kind, 'MODEL_PRICED_BACKTEST');
    assert.ok(report.summary.n > 100);
    assert.equal(typeof report.oppositeDirectionBaseline.avgR, 'number');
    assert.ok((report.summary.avgR ?? 0) > 0, '1-year research prior should have positive average R');
    assert.ok(
      (report.summary.avgR ?? 0) > (report.oppositeDirectionBaseline.avgR ?? 0),
      '1-year research signals should beat opposite-direction baseline'
    );
    assert.ok(
      (report.walkForward.oos.acceptedAvgR ?? 0) > (report.walkForward.oos.avgR ?? 0),
      'walk-forward ML gate should lift out-of-sample average R'
    );
    assert.ok(
      report.portfolio.endingEquityInr > report.portfolio.startingCapitalInr,
      '1-year ML-gated portfolio replay should end above starting capital'
    );
    assert.ok(report.disclaimer.includes('Black-Scholes'));

    // Verify Challenger Registry ordering: LADDER_V2 < RUNNER_V3 < RUNNER_V3_1 < ADAPTIVE_LEARNED
    const reg = report.runnerValidation?.challengerRegistry;
    assert.ok(reg, 'runnerValidation.challengerRegistry should exist');
    const v2 = reg!.variants.find((v) => v.engine === 'LADDER_V2')!;
    const v3 = reg!.variants.find((v) => v.engine === 'RUNNER_V3')!;
    const v31 = reg!.variants.find((v) => v.engine === 'RUNNER_V3_1')!;
    const learned = reg!.variants.find((v) => v.engine === 'ADAPTIVE_LEARNED')!;
    assert.ok(v3.expectancyPerLotInr > v2.expectancyPerLotInr);
    assert.ok(v31.expectancyPerLotInr > v3.expectancyPerLotInr);
    assert.ok(learned.expectancyPerLotInr > v31.expectancyPerLotInr);
    assert.ok(learned.endingEquityInr >= v31.endingEquityInr);

    // Verify self-learning ExitPolicySnapshot trains cleanly and predicts live exit decisions
    const snap = trainModelSnapshot(research.samples, [], Date.now(), { oos: research.offlineOos });
    assert.ok(snap?.exitPolicy, 'trainModelSnapshot should produce exitPolicy');
    assert.equal(snap!.exitPolicy!.baseEngine, 'RUNNER_V3_1');
    assert.ok(snap!.exitPolicy!.oosLiftOverV31Inr > 0);
    const dec = predictExitDecision(snap!.exitPolicy, research.samples[0].x, { mfeFrac: 0.17, sessionsHeld: 1 });
    assert.ok(dec.runnerProb > 0 && dec.runnerProb < 1);
    assert.ok(dec.learnedKeepFrac >= 0.667 && dec.learnedKeepFrac <= 0.85);
  });

  it('never drops exit floor below previousFloor across BREAKEVEN_LOCK, PROFIT_TRAIL, or RUNNER_MODE', () => {
    const plan: SpreadPlan = {
      underlying: 'RELIANCE',
      right: 'CE',
      expiry: '2026-11-23',
      dte: 19,
      lotSize: 500,
      spotAtEntry: 1300,
      long: { token: '125997', symbol: 'RELIANCE23NOV261300CE', strike: 1300, bid: 23.5, ask: 23.75 },
      short: { token: '144175', symbol: 'RELIANCE23NOV261330CE', strike: 1330, bid: 12.55, ask: 12.75 },
      width: 30,
      entryDebit: 11.2,
      midDebit: 11.15,
      debitRatio: 0.3733,
      legSpreadPct: 0.01,
      entryChargesPerLot: 72.18,
      exitChargesWorstPerLot: 47.2,
      maxLossPerLot: 5719.38,
      maxGainPerLot: 9250,
    };
    const l1 = exitLevels(plan, DEFAULT_ENGINE_CONFIG, {
      peakValue: 15.65,
      sessionsHeld: 2,
      runnerArmed: false,
      variant: 'ADAPTIVE_LEARNED',
      learnedKeepFrac: 0.8,
    });
    assert.equal(l1.stop, 13.49);
    // Even if a stale instance passes a lower peakValue (14.40), passing previousFloorV31 = 13.49 must preserve 13.49
    const l2 = exitLevels(plan, DEFAULT_ENGINE_CONFIG, {
      peakValue: 14.4,
      sessionsHeld: 2,
      runnerArmed: false,
      previousFloor: 13.49,
      previousFloorV31: 13.49,
      variant: 'ADAPTIVE_LEARNED',
      learnedKeepFrac: 0.8,
    });
    assert.equal(l2.stop, 13.49);
  });
});

