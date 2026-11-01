import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePaperEndpoint,
  simulatePessimisticFill,
  calculateRoundtripPnl,
  evaluateContractFilters,
  evaluatePositionExit,
  evaluateRiskAndSize,
  isBotOfflineDuringMarketHours,
  classifyTradePostMortem,
  blackScholesOptionPrice,
  formatInr,
} from './engine';

test('hard paper-trading URL guard accepts only approved NSE/Alpaca paper endpoints', () => {
  assert.equal(validatePaperEndpoint('https://paper-sandbox.nseindia-sim.local'), true);
  assert.equal(validatePaperEndpoint('https://paper-api.alpaca.markets'), true);
  assert.equal(validatePaperEndpoint('https://api.kite.trade'), false);
  assert.equal(validatePaperEndpoint('https://live-api.nseindia.com'), false);
  assert.equal(validatePaperEndpoint(''), false);
});

test('pessimistic NSE fill simulator applies mid +/- 35% of spread plus ₹35/lot statutory & brokerage fee', () => {
  // NIFTY lotSize = 75, 2 lots = 150 units. Bid = ₹200, Ask = ₹208 -> Mid = ₹204, Spread = ₹8
  // Conservative BUY = 204 + 0.35 * 8 = ₹206.80/unit
  const buy = simulatePessimisticFill('BUY', 2, 200.0, 208.0, 75);
  assert.equal(buy.conservativeFillPrice, 206.8);
  assert.equal(buy.feeInr, 70);
  assert.equal(buy.conservativeTotalCashInr, -(206.8 * 150 + 70));

  // Conservative SELL at Bid=₹240, Ask=₹248 -> Mid=₹244 - 2.80 = ₹241.20/unit
  const sell = simulatePessimisticFill('SELL', 2, 240.0, 248.0, 75);
  assert.equal(sell.conservativeFillPrice, 241.2);
  const pnl = calculateRoundtripPnl(2, buy, sell);
  assert.equal(pnl.conservativePnlInr < pnl.brokerPaperPnlInr, true);
  assert.equal(pnl.executionDragInr > 0, true);

  // Zero bid is rejected
  assert.throws(() => simulatePessimisticFill('BUY', 1, 0, 5.0, 75));
});

test('NSE contract selection filters enforce DTE, delta, spread, OI, volume, and corporate results blackout', () => {
  const valid = evaluateContractFilters({
    contractSymbol: 'NIFTY26NOV24500CE',
    underlying: 'NIFTY',
    right: 'CE',
    strike: 24500,
    lotSize: 75,
    expirationDate: '2026-11-26',
    dte: 18,
    bid: 218.0,
    ask: 224.0,
    delta: 0.46,
    theta: -8.4,
    ivRankPct: 38,
    openInterest: 24500,
    volume: 9200,
    hasEarningsInWindow: false,
  });
  assert.equal(valid.passed, true);

  const earningsBlocked = evaluateContractFilters({
    contractSymbol: 'RELIANCE26NOV1360CE',
    underlying: 'RELIANCE',
    right: 'CE',
    strike: 1360,
    lotSize: 500,
    expirationDate: '2026-11-26',
    dte: 18,
    bid: 28.0,
    ask: 29.0,
    delta: 0.45,
    theta: -1.1,
    ivRankPct: 42,
    openInterest: 4200,
    volume: 1100,
    hasEarningsInWindow: true,
  });
  assert.equal(earningsBlocked.passed, false);
});

test('exit engine prioritizes DTE<=1, 15:15 IST flatten, stop loss -30%, take profit +50%, and trailing stop', () => {
  const forceClose = evaluatePositionExit({
    dte: 1,
    isIntradayFlagged: false,
    isPreCloseWindow: false,
    entryPrice: 200.0,
    currentMarkPrice: 215.0,
    peakMarkPrice: 220.0,
    tradingDaysHeld: 3,
    positionRight: 'CE',
  });
  assert.equal(forceClose.shouldExit, true);
  assert.equal(forceClose.exitReason, 'FORCE_CLOSE_DTE_1');

  const trailing = evaluatePositionExit({
    dte: 14,
    isIntradayFlagged: false,
    isPreCloseWindow: false,
    entryPrice: 200.0,
    currentMarkPrice: 232.0,
    peakMarkPrice: 280.0, // +40% MFE, pulled back 17.1% (>15% trail)
    tradingDaysHeld: 2,
    positionRight: 'CE',
  });
  assert.equal(trailing.shouldExit, true);
  assert.equal(trailing.exitReason, 'TRAILING_STOP');
});

test('NSE lot risk sizing caps per-trade risk at 1.5% of ₹10L equity and triggers 10% drawdown kill switch', () => {
  // ₹10,00,000 equity * 1.5% = ₹15,000 max risk per trade
  // NIFTY entry price ₹90 * 75 lotSize + ₹35 fee = ₹6,785 per lot -> floor(15000 / 6785) = 2 lots
  const ok = evaluateRiskAndSize({
    currentEquityInr: 1000000,
    peakEquityInr: 1000000,
    dailyStartEquityInr: 1000000,
    openPositionsCount: 2,
    openPositionsForUnderlying: 0,
    currentOpenPremiumInr: 45000,
    conservativeEntryPrice: 90,
    lotSize: 75,
    newEntriesEnabled: true,
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.lotsQty, 2);

  const ddKill = evaluateRiskAndSize({
    currentEquityInr: 895000,
    peakEquityInr: 1000000,
    dailyStartEquityInr: 910000,
    openPositionsCount: 1,
    openPositionsForUnderlying: 0,
    currentOpenPremiumInr: 15000,
    conservativeEntryPrice: 90,
    lotSize: 75,
    newEntriesEnabled: true,
  });
  assert.equal(ddKill.allowed, false);
  assert.equal(ddKill.drawdownKillSwitchTriggered, true);
});

test('offline detector flags heartbeat > 10 minutes during 09:15-15:30 IST market hours', () => {
  const now = Date.parse('2026-10-30T08:00:00Z');
  const staleHb = '2026-10-30T07:46:00Z'; // 14 minutes old
  const check = isBotOfflineDuringMarketHours(staleHb, true, now);
  assert.equal(check.isOffline, true);
  assert.equal(check.ageMinutes, 14);
});

test('post-mortem classifier, Black-Scholes NSE pricer, and INR formatter return valid outputs', () => {
  const label = classifyTradePostMortem({
    exitReason: 'STOP_LOSS',
    conservativePnlInr: -4200,
    conservativePnlPct: -0.31,
    brokerPaperPnlInr: -3800,
    mfePct: 0.05,
    spreadPctAtEntry: 0.032,
    signedUnderlyingMovePct: -0.003,
    ivChangePct: 0,
    postExit60mOptionReturnPct: 0.34,
    regimeAtEntry: 'trending_up',
    regimeAtExit: 'trending_up',
  });
  assert.equal(label, 'stopped_out_then_reversed');

  const bs = blackScholesOptionPrice({
    spot: 24480,
    strike: 24550,
    dteDays: 18,
    ivAnnual: 0.145,
    riskFreeRate: 0.068,
    right: 'CE',
  });
  assert.equal(bs.ask > bs.bid, true);
  assert.equal(bs.delta > 0.3 && bs.delta < 0.65, true);
  assert.equal(formatInr(1000000), '₹10,00,000.00');
});

test('autonomous NSE paper runner executes cycles, updates bandit posteriors, and computes learning lift', async () => {
  const { buildInitialQuantState } = await import('./seedStore');
  const {
    executeAutonomousPaperCycles,
    predictLearnedQualityGateProb,
    computeLearningEffectiveness,
  } = await import('./livePaperRunner');

  const state = buildInitialQuantState();
  assert.equal(state.learning.qualityGateThreshold, 0.68);
  const initialTrades = state.closedTrades.length;

  // High confidence + tight spread + strong ADX should score >= 68% and pass
  const strongGate = predictLearnedQualityGateProb(state, {
    confidence: 0.85,
    spreadPct: 0.015,
    adx14: 32,
    ivRankPct: 35,
    isMiddayIst: false,
    dte: 18,
  });
  const weakGate = predictLearnedQualityGateProb(state, {
    confidence: 0.55,
    spreadPct: 0.068,
    adx14: 14,
    ivRankPct: 78,
    isMiddayIst: true,
    dte: 9,
  });
  assert.equal(strongGate.prob >= 0.68, true);
  assert.equal(strongGate.passed, true);
  assert.equal(weakGate.prob < 0.67, true);
  assert.equal(weakGate.passed, false);

  // Even if threshold is artificially lowered, hard floor of 67% rejects sub-67% setups
  state.learning.qualityGateThreshold = 0.50;
  const borderlineGate = predictLearnedQualityGateProb(state, {
    confidence: 0.61,
    spreadPct: 0.042,
    adx14: 20,
    ivRankPct: 66,
    isMiddayIst: true,
    dte: 12,
  });
  assert.equal(borderlineGate.prob < 0.67, true);
  assert.equal(borderlineGate.passed, false);
  state.learning.qualityGateThreshold = 0.68;

  // Execute 15 autonomous NSE paper cycles
  const summary = executeAutonomousPaperCycles(state, 15);
  assert.equal(summary.cyclesRun, 15);
  assert.equal(state.closedTrades.length >= initialTrades, true);

  const learningComp = computeLearningEffectiveness(state);
  assert.equal(typeof learningComp.recentTradesExpectancyInr, 'number');
  assert.equal(learningComp.gateAvoidedLossesSavedInr > 0, true);
});

test('defined-risk vertical debit spreads cut max risk & theta decay, and 200+ trades auto-promotes GBDT ensemble', async () => {
  const { simulateVerticalDebitSpreadFill } = await import('./engine');
  const { buildInitialQuantState } = await import('./seedStore');
  const { executeAutonomousPaperCycles, predictLearnedQualityGateProb } = await import('./livePaperRunner');

  // 1. NIFTY Bull Call Spread: Buy 24500 CE (Bid 210, Ask 216) + Sell 24600 CE (Bid 84, Ask 88)
  const spread = simulateVerticalDebitSpreadFill({
    right: 'CE',
    lotsQty: 1,
    longBid: 210,
    longAsk: 216,
    shortBid: 84,
    shortAsk: 88,
    lotSize: 75,
  });
  assert.equal(spread.spreadType, 'BULL_CALL_SPREAD');
  assert.equal(spread.totalEntryFeeInr, 70); // 2 legs x ₹35/lot
  assert.equal(spread.thetaDecayReductionPct, 0.65);
  assert.equal(spread.maxRiskReductionPct > 0.35, true);

  // 2. Vertical spread receives positive probability boost vs unhedged single-leg in elevated IV
  const state = buildInitialQuantState();
  const singleEval = predictLearnedQualityGateProb(state, {
    confidence: 0.71,
    spreadPct: 0.025,
    adx14: 26,
    ivRankPct: 58,
    isMiddayIst: false,
    dte: 18,
    isVerticalSpread: false,
  });
  const spreadEval = predictLearnedQualityGateProb(state, {
    confidence: 0.71,
    spreadPct: 0.025,
    adx14: 26,
    ivRankPct: 58,
    isMiddayIst: false,
    dte: 18,
    isVerticalSpread: true,
  });
  assert.equal(spreadEval.prob > singleEval.prob, true);

  // 3. Fast-forward cycles past 200 closed trades and verify GBDT auto-promotion
  while (state.closedTrades.length < 205) {
    executeAutonomousPaperCycles(state, 100);
  }
  assert.equal(state.closedTrades.length >= 200, true);
  assert.equal(state.learning.championVersion, 'v2.0.0-nse-gbdt-ensemble');
  assert.equal(state.learning.modelType.includes('GBDT'), true);
  assert.equal(state.learning.walkForwardAuc >= 0.78, true);
});

test('Angel One NFO option parser, 5-minute OHLCV technical indicators, and IV/Greeks solver compute accurate outputs', async () => {
  const {
    computeTechnicalIndicatorsFromCandles,
    solveImpliedVolatilityAndGreeks,
  } = await import('./engine');
  const { parseAngelNfoOptionSymbol } = await import('./angelOneSmartApi');

  const parsedNifty = parseAngelNfoOptionSymbol('NIFTY', 'NIFTY01DEC2623050CE', '47526');
  assert.ok(parsedNifty);
  assert.equal(parsedNifty.expiryCode, '01DEC26');
  assert.equal(parsedNifty.strike, 23050);
  assert.equal(parsedNifty.right, 'CE');
  assert.equal(parsedNifty.symbolToken, '47526');

  const solved = solveImpliedVolatilityAndGreeks({
    marketPrice: 421.22,
    spot: 23053.1,
    strike: 23050,
    dteDays: 22,
    riskFreeRate: 0.068,
    right: 'CE',
  });
  assert.equal(solved.impliedVolAnnual > 0.08 && solved.impliedVolAnnual < 0.45, true);
  assert.equal(solved.delta > 0.4 && solved.delta < 0.7, true);
  assert.equal(solved.thetaPerDay < 0, true);
  assert.equal(solved.vegaPerPct > 0, true);

  const syntheticCandles = Array.from({ length: 30 }, (_, idx) => {
    const base = 23000 + idx * 4.5;
    return {
      timestamp: `2026-10-30T10:${String(idx).padStart(2, '0')}:00+05:30`,
      open: base - 2,
      high: base + 6,
      low: base - 5,
      close: base + 3,
      volume: 12000 + idx * 150,
    };
  });
  const ind = computeTechnicalIndicatorsFromCandles(syntheticCandles);
  assert.equal(ind.rsi14 > 50, true);
  assert.equal(ind.adx14 >= 16, true);
  assert.equal(ind.ema9 >= ind.ema21, true);
  assert.equal(ind.trendSignal, 'CE');
});

test('NSE IST market hours check and Option Expiration Payoff Curve compute accurate profiles', async () => {
  const { computeOptionPayoffCurve, isNseMarketHoursIst } = await import('./engine');

  // Wednesday 11:00 IST (05:30 UTC) -> Open
  const wedOpenUtc = new Date('2026-11-04T05:30:00Z');
  const openStatus = isNseMarketHoursIst(wedOpenUtc);
  assert.equal(openStatus.isOpen, true);

  // Saturday 11:00 IST -> Closed
  const satClosedUtc = new Date('2026-10-31T05:30:00Z');
  const closedStatus = isNseMarketHoursIst(satClosedUtc);
  assert.equal(closedStatus.isOpen, false);

  const payoff = computeOptionPayoffCurve(
    {
      positionId: 'POS-TEST-1',
      tradeId: 'TRD-TEST-1',
      contractSymbol: 'NIFTY23NOV2623000/23150CE_SPREAD',
      underlying: 'NIFTY',
      right: 'CE',
      strike: 23000,
      lotSize: 75,
      expirationDate: '2026-11-23',
      dte: 18,
      strategyName: 'trend_following',
      regimeAtEntry: 'trending_up',
      lotsQty: 1,
      conservativeEntryPrice: 54.0,
      brokerPaperEntryPrice: 53.2,
      currentMarkPrice: 68.5,
      peakMarkPrice: 71.0,
      troughMarkPrice: 52.0,
      unrealizedPnlInr: 1017.5,
      unrealizedPnlPct: 0.24,
      delta: 0.28,
      theta: -0.45,
      ivRankPct: 52.0,
      stopLossPrice: 37.8,
      takeProfitPrice: 81.0,
      trailingStopActivationPrice: 69.1,
      tradingDaysHeld: 2,
      isIntradayFlagged: false,
      openedAt: '2026-10-31T04:00:00Z',
      angelToken: '53925',
    },
    23055
  );

  assert.equal(payoff.isSpread, true);
  assert.equal(payoff.longStrike, 23000);
  assert.equal(payoff.shortStrike, 23150);
  assert.equal(payoff.points.length, 21);
  assert.equal(payoff.maxProfitInr > 0, true);
  assert.equal(payoff.maxLossInr < 0, true);
});

test('1-year real Angel One historical replay starts with ₹10,000 capital and scales position size from 1L to 5L dynamically with account funds', async () => {
  const { buildInitialQuantState } = await import('./seedStore');
  const {
    computeSmartFundAwarePositionSize,
    INITIAL_REAL_CAPITAL_INR,
    runRealOneYearHistoricalReplay,
  } = await import('./historicalReplay');

  assert.equal(INITIAL_REAL_CAPITAL_INR, 10000);

  // At ₹10,000 account equity, sizes 1 lot
  const sizeAt10k = computeSmartFundAwarePositionSize({
    currentEquityInr: 10000,
    openLockedCapitalInr: 0,
    rawSpreadMidPerUnit: 13.5,
    entryFeePerLotInr: 35,
    lotSize: 75,
    qualityGateProb: 0.72,
    banditRiskMultiplier: 0.9,
  });
  assert.equal(sizeAt10k.lotsQty, 1);

  // At ₹38,000 account equity with high conviction, scales dynamically to >= 3 lots
  const sizeAt38k = computeSmartFundAwarePositionSize({
    currentEquityInr: 38000,
    openLockedCapitalInr: 0,
    rawSpreadMidPerUnit: 13.5,
    entryFeePerLotInr: 35,
    lotSize: 75,
    qualityGateProb: 0.82,
    banditRiskMultiplier: 1.05,
  });
  assert.equal(sizeAt38k.lotsQty >= 3, true);

  // Run full 1-year real Angel One historical replay (17,140 real 1H candles)
  const state = buildInitialQuantState();
  const report = await runRealOneYearHistoricalReplay(
    state,
    '2025-11-01 09:15',
    '2026-10-30 15:30',
    10000,
    false
  );
  assert.equal(report.startingCapitalInr, 10000);
  assert.equal(report.totalFiveMinCandlesProcessed >= 17000, true);
  assert.equal(report.totalTradesClosed >= 200, true);
  assert.equal(report.winRatePct >= 65, true);
  assert.equal(report.minLotsTraded, 1);
  assert.equal(report.maxLotsTraded >= 3, true);
  assert.equal(report.endingConservativeEquityInr > 25000, true);
  assert.equal(state.learning.championVersion, 'v2.1.0-nse-gbdt-1y-real');
});
