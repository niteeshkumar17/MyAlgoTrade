import {
  ClosedOptionTrade,
  EquitySnapshotPoint,
  MarketRegime,
  NSE_LOT_SIZES,
  OpenOptionPosition,
  OptionRight,
  PostMortemLabel,
  SkippedSignalCounterfactual,
  StrategyName,
  classifyTradePostMortem,
  simulatePessimisticFill,
} from './engine';

export interface StrategyBacktestRow {
  strategyName: StrategyName;
  tradeCount: number;
  winRate: number;
  expectancyInr: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
}

export interface LearningLogEntry {
  logId: string;
  loggedAt: string;
  changeCategory: string;
  modelVersion: string;
  parameterOrBucket: string;
  oldValue: string;
  newValue: string;
  sampleSize: number;
  bootstrapCi90: string;
  reasonAndEvidence: string;
}

export interface QuantSystemState {
  control: {
    id: number;
    newEntriesEnabled: boolean;
    killSwitchActive: boolean;
    dailyLossHaltActive: boolean;
    activeChampionVersion: string;
    previousChampionVersion: string;
    updatedAt: string;
    updatedBy: string;
  };
  health: {
    botId: string;
    heartbeatAt: string;
    lastCycleAt: string;
    lastDbWriteAt: string;
    lastCycleStatus: 'OK' | 'PAUSED' | 'HALTED';
    marketOpen: boolean;
    currentRegime: MarketRegime;
    indiaVixLevel: number;
    niftySpot: number;
    bankNiftySpot: number;
    sqliteOutboxPending: number;
    reconciliationMismatches: number;
    staleQuotesRejected: number;
    memoryRssMb: number;
    simulatedOfflineMode: boolean;
  };
  openPositions: OpenOptionPosition[];
  closedTrades: ClosedOptionTrade[];
  skippedSignals: SkippedSignalCounterfactual[];
  equitySeries: EquitySnapshotPoint[];
  backtestResults: StrategyBacktestRow[];
  learning: {
    championVersion: string;
    previousChampionVersion: string;
    challengerVersion: string;
    modelType: string;
    walkForwardAuc: number;
    qualityGateThreshold: number;
    closedTradesCount: number;
    tradesNeededForGbdt: number;
    championVsChallenger: {
      championExpectancyInr: number;
      challengerExpectancyInr: number;
      championMaxDrawdownPct: number;
      challengerMaxDrawdownPct: number;
      shadowTradesCompleted: number;
      minShadowTradesRequired: number;
      readyToPromote: boolean;
      statusSummary: string;
    };
    featureImportances: Array<{
      feature: string;
      weight: number;
      description: string;
    }>;
    banditAllocations: Array<{
      bucketKey: string;
      wins: number;
      losses: number;
      totalTrades: number;
      allocationWeight: number;
      riskBudgetMultiplier: number;
      status: string;
    }>;
    learningLog: LearningLogEntry[];
  };
}

function seededRand(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function buildInitialQuantState(): QuantSystemState {
  const rng = seededRand(20261104);
  const underlyings = [
    'NIFTY',
    'BANKNIFTY',
    'FINNIFTY',
    'RELIANCE',
    'TCS',
    'HDFCBANK',
    'INFY',
    'ICICIBANK',
    'SBIN',
  ];
  const strategies: StrategyName[] = ['trend_following', 'mean_reversion', 'breakout_momentum'];
  const timeBuckets: ('OPEN_0915_1015' | 'MIDDAY_1015_1330' | 'AFTERNOON_1330_1530')[] = [
    'OPEN_0915_1015',
    'MIDDAY_1015_1330',
    'AFTERNOON_1330_1530',
  ];

  const basePremiums: Record<string, number> = {
    NIFTY: 145,
    BANKNIFTY: 340,
    FINNIFTY: 135,
    RELIANCE: 22,
    TCS: 58,
    HDFCBANK: 24,
    INFY: 28,
    ICICIBANK: 19,
    SBIN: 16,
  };

  const baseStrikes: Record<string, number> = {
    NIFTY: 24500,
    BANKNIFTY: 51800,
    FINNIFTY: 23900,
    RELIANCE: 1360,
    TCS: 4100,
    HDFCBANK: 1740,
    INFY: 1860,
    ICICIBANK: 1290,
    SBIN: 840,
  };

  const closedTrades: ClosedOptionTrade[] = [];
  let runningConsEquity = 1000000.0; // ₹10,00,000 (₹10 Lakhs starting paper equity)
  let runningPaperEquity = 1000000.0;
  let runningNiftyEquity = 1000000.0;
  let peakConsEquity = 1000000.0;

  const equitySeries: EquitySnapshotPoint[] = [];
  const startMs = Date.now() - 56 * 24 * 3600 * 1000;

  for (let i = 0; i < 64; i++) {
    const u = underlyings[i % underlyings.length];
    const lotSize = NSE_LOT_SIZES[u] ?? 75;
    const strat = strategies[(i + Math.floor(rng() * 3)) % strategies.length];
    const regimeAtEntry: MarketRegime =
      strat === 'mean_reversion'
        ? 'range'
        : strat === 'trend_following'
        ? rng() > 0.35
          ? 'trending_up'
          : 'trending_down'
        : rng() > 0.4
        ? 'trending_up'
        : 'high_volatility';

    const right: OptionRight =
      regimeAtEntry === 'trending_down' ? 'PE' : rng() > 0.32 ? 'CE' : 'PE';
    const dte = 7 + Math.floor(rng() * 21);
    const delta = Number(((right === 'CE' ? 1 : -1) * (0.38 + rng() * 0.14)).toFixed(2));
    const ivRank = Number((22 + rng() * 48).toFixed(1));
    const basePrem = basePremiums[u] ?? 120;
    const entryMid = Number((basePrem * (0.85 + rng() * 0.35)).toFixed(2));
    const spreadPct = Number((0.022 + rng() * 0.036).toFixed(4));
    const halfSpread = Number(((entryMid * spreadPct) / 2).toFixed(2));
    const entryBid = Number(Math.max(0.5, entryMid - halfSpread).toFixed(2));
    const entryAsk = Number((entryMid + halfSpread).toFixed(2));
    const lotsQty = 1;

    const entryFill = simulatePessimisticFill('BUY', lotsQty, entryBid, entryAsk, lotSize);

    // First 30 trades = uniform warmup prior (~52% win rate); trade 30+ = 68% Capital-Preservation Gate + Breakeven Lock (~76% win rate)
    const isWin = rng() < (i < 30 ? 0.52 : 0.76);
    const rawMovePct = isWin
      ? (i < 30 ? 0.14 : 0.22) + rng() * 0.34
      : -(0.10 + rng() * 0.14);
    const exitMid = Number(Math.max(1.0, entryMid * (1 + rawMovePct)).toFixed(2));
    const exitHalfSpread = Number(((exitMid * spreadPct) / 2).toFixed(2));
    const exitBid = Number(Math.max(0.5, exitMid - exitHalfSpread).toFixed(2));
    const exitAsk = Number((exitMid + exitHalfSpread).toFixed(2));

    const exitFill = simulatePessimisticFill('SELL', lotsQty, exitBid, exitAsk, lotSize);

    const consPnlInr = Number(
      (exitFill.conservativeTotalCashInr - Math.abs(entryFill.conservativeTotalCashInr)).toFixed(2)
    );
    const consPnlPct = Number(
      (consPnlInr / Math.abs(entryFill.conservativeTotalCashInr)).toFixed(4)
    );
    const paperPnlInr = Number(
      (exitFill.brokerPaperTotalCashInr - Math.abs(entryFill.brokerPaperTotalCashInr)).toFixed(2)
    );
    const paperPnlPct = Number(
      (paperPnlInr / Math.abs(entryFill.brokerPaperTotalCashInr)).toFixed(4)
    );

    const mfePct = Number(
      Math.max(consPnlPct + 0.05, isWin ? consPnlPct + rng() * 0.14 : rng() * 0.28).toFixed(4)
    );
    const maePct = Number(
      Math.min(consPnlPct - 0.03, isWin ? -(rng() * 0.11) : consPnlPct - rng() * 0.06).toFixed(4)
    );

    let exitReason = 'TAKE_PROFIT';
    if (consPnlPct <= -0.28) exitReason = 'STOP_LOSS';
    else if (consPnlPct >= 0.42) exitReason = 'TAKE_PROFIT';
    else if (mfePct >= 0.3 && consPnlPct > 0.1) exitReason = 'TRAILING_STOP';
    else if (!isWin && rng() > 0.5) exitReason = 'TIME_STOP_DAYS';
    else if (!isWin) exitReason = 'SIGNAL_REVERSAL';

    const regimeAtExit: MarketRegime =
      !isWin && rng() > 0.72 ? 'high_volatility' : regimeAtEntry;

    const postMortemLabel: PostMortemLabel = classifyTradePostMortem({
      exitReason,
      conservativePnlInr: consPnlInr,
      conservativePnlPct: consPnlPct,
      brokerPaperPnlInr: paperPnlInr,
      mfePct,
      spreadPctAtEntry: spreadPct,
      signedUnderlyingMovePct: isWin ? 0.011 : rng() > 0.7 ? 0.004 : -0.009,
      ivChangePct: !isWin && rng() > 0.65 ? -0.06 : 0.01,
      postExit60mOptionReturnPct:
        exitReason === 'STOP_LOSS' && rng() > 0.65 ? 0.31 : -0.04,
      regimeAtEntry,
      regimeAtExit,
    });

    const openedMs = startMs + i * 20.5 * 3600 * 1000;
    const holdMinutes = 75 + Math.floor(rng() * 720);
    const closedMs = openedMs + holdMinutes * 60 * 1000;

    runningConsEquity = Number((runningConsEquity + consPnlInr).toFixed(2));
    runningPaperEquity = Number((runningPaperEquity + paperPnlInr).toFixed(2));
    runningNiftyEquity = Number(
      (runningNiftyEquity * (1 + (rng() - 0.465) * 0.0052)).toFixed(2)
    );
    peakConsEquity = Math.max(peakConsEquity, runningConsEquity);
    const ddPct = Number(((peakConsEquity - runningConsEquity) / peakConsEquity).toFixed(4));

    const strikeStep = u === 'BANKNIFTY' ? 100 : u === 'NIFTY' || u === 'FINNIFTY' ? 50 : 20;
    const strike = (baseStrikes[u] ?? 24000) + ((i % 5) - 2) * strikeStep;
    const contractSymbol = `${u}26NOV${strike}${right}`;

    const diagnosisMap: Record<PostMortemLabel, string> = {
      optimal_exit:
        'Clean execution inside target delta band; exit captured directional expansion with tight NSE bid-ask spread.',
      wrong_direction:
        'Underlying failed to follow through on 5m trigger; directional thesis invalidated before target.',
      theta_or_iv_crush:
        'Underlying moved mildly in favor, but INDIA VIX contraction (-6.2%) + theta decay outweighed delta gains.',
      stopped_out_then_reversed:
        'Hit -30% premium stop on intraday wick, then contract rallied +31% within 60m after exit.',
      winner_given_back:
        'Position reached +28% MFE during IST morning session but retraced during midday chop before trailing stop.',
      bad_fill_wide_spread:
        'Paper mid fill showed profit, but conservative fill (mid ± 35% spread + ₹35/lot charges) flipped net P&L negative.',
      wrong_regime:
        'Entered during trending regime, but NIFTY 50 shifted into high-volatility intraday whipsaw prior to exit.',
    };

    const entryReasonMap: Record<StrategyName, string> = {
      trend_following: `EMA20 > EMA50 aligned + Spot > VWAP + ADX(14)=${(24 + rng() * 10).toFixed(1)} in ${regimeAtEntry}`,
      mean_reversion: `RSI(14)=${(right === 'CE' ? 27.4 : 73.2).toFixed(1)} extreme + Bollinger re-entry inside low-ADX range`,
      breakout_momentum: `20-bar range breakout + Volume ${(1.6 + rng() * 0.8).toFixed(2)}x avg + ATR expansion`,
    };

    closedTrades.push({
      tradeId: `NSE-TRD-${String(1001 + i)}`,
      contractSymbol,
      underlying: u,
      right,
      lotSize,
      strategyName: strat,
      regimeAtEntry,
      regimeAtExit,
      isShadowChallenger: false,
      modelVersion: i < 42 ? 'v1.2.0-nse-walkforward' : 'v1.3.0-nse-walkforward',
      lotsQty,
      dteAtEntry: dte,
      deltaAtEntry: delta,
      ivRankAtEntry: ivRank,
      spreadPctAtEntry: spreadPct,
      confidenceAtEntry: Number((0.64 + rng() * 0.24).toFixed(2)),
      rsiAtEntry: Number((32 + rng() * 38).toFixed(1)),
      adxAtEntry: Number((18 + rng() * 18).toFixed(1)),
      atrPctAtEntry: Number((0.011 + rng() * 0.012).toFixed(4)),
      indiaVixAtEntry: Number((12.8 + rng() * 4.8).toFixed(2)),
      timeOfDayBucket: timeBuckets[i % timeBuckets.length],
      conservativeEntryPrice: entryFill.conservativeFillPrice,
      conservativeExitPrice: exitFill.conservativeFillPrice,
      brokerPaperEntryPrice: entryFill.brokerPaperFillPrice,
      brokerPaperExitPrice: exitFill.brokerPaperFillPrice,
      feesTotalInr: Number((entryFill.feeInr + exitFill.feeInr).toFixed(2)),
      conservativePnlInr: consPnlInr,
      conservativePnlPct: consPnlPct,
      brokerPaperPnlInr: paperPnlInr,
      brokerPaperPnlPct: paperPnlPct,
      maePct,
      mfePct,
      holdMinutes,
      entryReason: entryReasonMap[strat],
      exitReason,
      postMortemLabel,
      diagnosisNotes: diagnosisMap[postMortemLabel],
      openedAt: new Date(openedMs).toISOString(),
      closedAt: new Date(closedMs).toISOString(),
    });

    equitySeries.push({
      snapshotId: `SNAP-${String(i + 1).padStart(4, '0')}`,
      recordedAt: new Date(closedMs).toISOString(),
      conservativeEquityInr: runningConsEquity,
      brokerPaperEquityInr: runningPaperEquity,
      niftyBenchmarkEquityInr: runningNiftyEquity,
      realizedPnlInr: Number((runningConsEquity - 1000000).toFixed(2)),
      unrealizedPnlInr: Number(((rng() - 0.35) * 3200).toFixed(2)),
      drawdownPct: ddPct,
      openPositionsCount: 2 + (i % 3),
    });
  }

  const openPositions: OpenOptionPosition[] = [
    {
      positionId: 'POS-NSE-901',
      tradeId: 'NSE-TRD-2001',
      contractSymbol: 'NIFTY26NOV24500CE',
      underlying: 'NIFTY',
      right: 'CE',
      strike: 24500,
      lotSize: 75,
      expirationDate: '2026-11-26',
      dte: 18,
      strategyName: 'trend_following',
      regimeAtEntry: 'trending_up',
      lotsQty: 1,
      conservativeEntryPrice: 148.4,
      brokerPaperEntryPrice: 146.5,
      currentMarkPrice: 171.2,
      peakMarkPrice: 176.8,
      troughMarkPrice: 141.0,
      unrealizedPnlInr: 1675.0,
      unrealizedPnlPct: 0.1536,
      delta: 0.49,
      theta: -4.2,
      ivRankPct: 34.5,
      stopLossPrice: 103.9,
      takeProfitPrice: 222.6,
      trailingStopActivationPrice: 192.9,
      tradingDaysHeld: 2,
      isIntradayFlagged: false,
      openedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    },
    {
      positionId: 'POS-NSE-902',
      tradeId: 'NSE-TRD-2002',
      contractSymbol: 'BANKNIFTY26NOV52000CE',
      underlying: 'BANKNIFTY',
      right: 'CE',
      strike: 52000,
      lotSize: 30,
      expirationDate: '2026-11-25',
      dte: 17,
      strategyName: 'breakout_momentum',
      regimeAtEntry: 'trending_up',
      lotsQty: 1,
      conservativeEntryPrice: 345.2,
      brokerPaperEntryPrice: 341.0,
      currentMarkPrice: 398.5,
      peakMarkPrice: 406.0,
      troughMarkPrice: 332.0,
      unrealizedPnlInr: 1564.0,
      unrealizedPnlPct: 0.1544,
      delta: 0.47,
      theta: -9.8,
      ivRankPct: 41.2,
      stopLossPrice: 241.6,
      takeProfitPrice: 517.8,
      trailingStopActivationPrice: 448.8,
      tradingDaysHeld: 1,
      isIntradayFlagged: false,
      openedAt: new Date(Date.now() - 22 * 3600 * 1000).toISOString(),
    },
    {
      positionId: 'POS-NSE-903',
      tradeId: 'NSE-TRD-2003',
      contractSymbol: 'FINNIFTY26NOV23900PE',
      underlying: 'FINNIFTY',
      right: 'PE',
      strike: 23900,
      lotSize: 65,
      expirationDate: '2026-11-24',
      dte: 16,
      strategyName: 'mean_reversion',
      regimeAtEntry: 'range',
      lotsQty: 1,
      conservativeEntryPrice: 132.6,
      brokerPaperEntryPrice: 131.0,
      currentMarkPrice: 124.8,
      peakMarkPrice: 139.5,
      troughMarkPrice: 121.0,
      unrealizedPnlInr: -542.0,
      unrealizedPnlPct: -0.0588,
      delta: -0.42,
      theta: -3.6,
      ivRankPct: 29.8,
      stopLossPrice: 92.8,
      takeProfitPrice: 198.9,
      trailingStopActivationPrice: 172.4,
      tradingDaysHeld: 3,
      isIntradayFlagged: false,
      openedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
    },
    {
      positionId: 'POS-NSE-904',
      tradeId: 'NSE-TRD-2004',
      contractSymbol: 'RELIANCE26NOV1360CE',
      underlying: 'RELIANCE',
      right: 'CE',
      strike: 1360,
      lotSize: 500,
      expirationDate: '2026-11-26',
      dte: 18,
      strategyName: 'trend_following',
      regimeAtEntry: 'trending_up',
      lotsQty: 1,
      conservativeEntryPrice: 22.85,
      brokerPaperEntryPrice: 22.5,
      currentMarkPrice: 25.4,
      peakMarkPrice: 26.1,
      troughMarkPrice: 21.9,
      unrealizedPnlInr: 1240.0,
      unrealizedPnlPct: 0.1116,
      delta: 0.46,
      theta: -0.65,
      ivRankPct: 37.0,
      stopLossPrice: 16.0,
      takeProfitPrice: 34.3,
      trailingStopActivationPrice: 29.7,
      tradingDaysHeld: 1,
      isIntradayFlagged: true,
      openedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    },
  ];

  const skippedSignals: SkippedSignalCounterfactual[] = [
    {
      signalId: 'SIG-SKIP-401',
      generatedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      underlying: 'TCS',
      strategyName: 'breakout_momentum',
      direction: 'CE',
      regime: 'trending_up',
      confidence: 0.67,
      qualityGateProb: 0.64,
      skipReason:
        'Capital-Preservation Gate P(gain)=64.0% < 68.0% threshold (Hard Floor 67% — wide afternoon spread + IVR 79%)',
      counterfactualContract: 'TCS26NOV4150CE',
      counterfactualEntryPrice: 61.5,
      counterfactualExitPrice: 49.2,
      counterfactualPnlPct: -0.2,
    },
    {
      signalId: 'SIG-SKIP-402',
      generatedAt: new Date(Date.now() - 9 * 3600 * 1000).toISOString(),
      underlying: 'INFY',
      strategyName: 'trend_following',
      direction: 'CE',
      regime: 'trending_up',
      confidence: 0.74,
      qualityGateProb: 0.66,
      skipReason:
        'Capital-Preservation Gate P(gain)=66.0% < 68.0% threshold + Q2 corporate results inside holding window',
      counterfactualContract: 'INFY26NOV1880CE',
      counterfactualEntryPrice: 29.4,
      counterfactualExitPrice: 20.1,
      counterfactualPnlPct: -0.3163,
    },
    {
      signalId: 'SIG-SKIP-403',
      generatedAt: new Date(Date.now() - 26 * 3600 * 1000).toISOString(),
      underlying: 'HDFCBANK',
      strategyName: 'mean_reversion',
      direction: 'PE',
      regime: 'range',
      confidence: 0.65,
      qualityGateProb: 0.61,
      skipReason: 'Capital-Preservation Gate P(gain)=61.0% < 68.0% threshold (Midday IST theta drag)',
      counterfactualContract: 'HDFCBANK26NOV1740PE',
      counterfactualEntryPrice: 24.8,
      counterfactualExitPrice: 21.4,
      counterfactualPnlPct: -0.1371,
    },
    {
      signalId: 'SIG-SKIP-404',
      generatedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      underlying: 'SBIN',
      strategyName: 'breakout_momentum',
      direction: 'CE',
      regime: 'high_volatility',
      confidence: 0.71,
      qualityGateProb: 0.65,
      skipReason: 'Capital-Preservation Gate P(gain)=65.0% < 68.0% threshold + bid-ask spread 9.2% > 8.0% limit',
      counterfactualContract: 'SBIN26NOV850CE',
      counterfactualEntryPrice: 16.9,
      counterfactualExitPrice: 13.4,
      counterfactualPnlPct: -0.2071,
    },
  ];

  const backtestResults: StrategyBacktestRow[] = [
    {
      strategyName: 'trend_following',
      tradeCount: 142,
      winRate: 0.578,
      expectancyInr: 725.4,
      profitFactor: 1.54,
      maxDrawdownPct: 0.052,
      sharpeRatio: 1.78,
    },
    {
      strategyName: 'breakout_momentum',
      tradeCount: 118,
      winRate: 0.534,
      expectancyInr: 582.1,
      profitFactor: 1.41,
      maxDrawdownPct: 0.068,
      sharpeRatio: 1.52,
    },
    {
      strategyName: 'mean_reversion',
      tradeCount: 94,
      winRate: 0.553,
      expectancyInr: 412.8,
      profitFactor: 1.33,
      maxDrawdownPct: 0.044,
      sharpeRatio: 1.44,
    },
  ];

  const nowIso = new Date().toISOString();

  return {
    control: {
      id: 1,
      newEntriesEnabled: true,
      killSwitchActive: false,
      dailyLossHaltActive: false,
      activeChampionVersion: 'v1.3.0-nse-walkforward',
      previousChampionVersion: 'v1.2.0-nse-walkforward',
      updatedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      updatedBy: 'bot_rw (Oracle VM systemd)',
    },
    health: {
      botId: 'oci-ap-mumbai-1-arm-bot-01',
      heartbeatAt: new Date(Date.now() - 42 * 1000).toISOString(),
      lastCycleAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      lastDbWriteAt: new Date(Date.now() - 42 * 1000).toISOString(),
      lastCycleStatus: 'OK',
      marketOpen: true,
      currentRegime: 'trending_up',
      indiaVixLevel: 14.25,
      niftySpot: 24482.6,
      bankNiftySpot: 51845.2,
      sqliteOutboxPending: 0,
      reconciliationMismatches: 0,
      staleQuotesRejected: 2,
      memoryRssMb: 214.6,
      simulatedOfflineMode: false,
    },
    openPositions,
    closedTrades: closedTrades.reverse(),
    skippedSignals,
    equitySeries,
    backtestResults,
    learning: {
      championVersion: 'v1.3.0-nse-walkforward',
      previousChampionVersion: 'v1.2.0-nse-walkforward',
      challengerVersion: 'v2.0.0-nse-gbdt-ensemble',
      modelType: 'L2 Logistic Regression (Calibrated)',
      walkForwardAuc: 0.724,
      qualityGateThreshold: 0.68,
      closedTradesCount: 64,
      tradesNeededForGbdt: 136,
      championVsChallenger: {
        championExpectancyInr: 485.0,
        challengerExpectancyInr: 640.0,
        championMaxDrawdownPct: 0.048,
        challengerMaxDrawdownPct: 0.041,
        shadowTradesCompleted: 54,
        minShadowTradesRequired: 50,
        readyToPromote: true,
        statusSummary:
          'Shadow Challenger v1.4.0-nse-shadow has completed 54/50 shadow NSE trades with higher conservative expectancy (+₹640.00 vs +₹485.00/trade) and lower max drawdown (4.1% vs 4.8%). Eligible for promotion.',
      },
      featureImportances: [
        {
          feature: 'signal_confidence',
          weight: 1.42,
          description: 'Composite indicator alignment score (EMA20/50 + VWAP + ADX)',
        },
        {
          feature: 'spread_pct_of_mid',
          weight: -1.38,
          description: 'Penalizes wide NSE option bid-ask spreads (> 4.5% of mid)',
        },
        {
          feature: 'adx_14_trend_strength',
          weight: 0.89,
          description: 'Favors strong directional trend regimes on NIFTY & BANKNIFTY',
        },
        {
          feature: 'iv_rank_pct_over_70',
          weight: -1.12,
          description: 'Avoids buying expensive premium susceptible to INDIA VIX crush',
        },
        {
          feature: 'midday_1015_1330_ist',
          weight: -0.74,
          description: 'Penalizes low-volume IST midday chop entries (10:15–13:30 IST)',
        },
        {
          feature: 'dte_14_to_28_bucket',
          weight: 0.66,
          description: 'Favors NSE monthly/bi-weekly contracts with lower gamma/theta decay',
        },
      ],
      banditAllocations: [
        {
          bucketKey: 'trend_following × trending_up × NIFTY (Lot 75)',
          wins: 21,
          losses: 11,
          totalTrades: 32,
          allocationWeight: 0.285,
          riskBudgetMultiplier: 1.0,
          status: 'Active Adaptation (>= 30 trades)',
        },
        {
          bucketKey: 'breakout_momentum × trending_up × BANKNIFTY (Lot 30)',
          wins: 19,
          losses: 12,
          totalTrades: 31,
          allocationWeight: 0.245,
          riskBudgetMultiplier: 0.96,
          status: 'Active Adaptation (>= 30 trades)',
        },
        {
          bucketKey: 'mean_reversion × range × FINNIFTY (Lot 65)',
          wins: 10,
          losses: 8,
          totalTrades: 18,
          allocationWeight: 0.165,
          riskBudgetMultiplier: 0.85,
          status: 'Warmup Prior (18/30 trades)',
        },
        {
          bucketKey: 'trend_following × trending_down × HDFCBANK (Lot 550)',
          wins: 9,
          losses: 6,
          totalTrades: 15,
          allocationWeight: 0.155,
          riskBudgetMultiplier: 0.85,
          status: 'Warmup Prior (15/30 trades)',
        },
        {
          bucketKey: 'breakout_momentum × high_volatility × RELIANCE (Lot 500)',
          wins: 5,
          losses: 11,
          totalTrades: 16,
          allocationWeight: 0.05,
          riskBudgetMultiplier: 0.55,
          status: 'Clamped at 5.0% Exploration Floor',
        },
        {
          bucketKey: 'trend_following × trending_up × TCS (Lot 175)',
          wins: 8,
          losses: 6,
          totalTrades: 14,
          allocationWeight: 0.1,
          riskBudgetMultiplier: 0.8,
          status: 'Warmup Prior (14/30 trades)',
        },
      ],
      learningLog: [
        {
          logId: 'LL-2026-104',
          loggedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
          changeCategory: 'CAPITAL_PRESERVATION_GATE',
          modelVersion: 'v1.3.0-nse-walkforward',
          parameterOrBucket: 'quality_gate.min_win_probability',
          oldValue: '0.67 (67% Hard Floor)',
          newValue: '0.68 (68% Recommended 2.1:1 Odds)',
          sampleSize: 64,
          bootstrapCi90: '[+₹490.00, +₹1,380.00] / trade',
          reasonAndEvidence:
            'Capital-Preservation Policy: Locked hard floor at P(gain) >= 67% and set active threshold to 68.0% (2.1:1 odds) + Breakeven-Lock stop (+2.5% floor once MFE >= +18%) to eliminate borderline spread/theta losses.',
        },
        {
          logId: 'LL-2026-103',
          loggedAt: new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString(),
          changeCategory: 'BANDIT_POSTERIOR_UPDATE',
          modelVersion: 'v1.3.0-nse-walkforward',
          parameterOrBucket: 'trend_following × trending_up × NIFTY',
          oldValue: '0.240 weight',
          newValue: '0.285 weight',
          sampleSize: 32,
          bootstrapCi90: '[54.2%, 76.8%] win rate',
          reasonAndEvidence:
            'Bucket crossed 30-trade threshold with 65.6% conservative win rate; Thompson Sampling increased risk multiplier to 1.00x cap.',
        },
        {
          logId: 'LL-2026-102',
          loggedAt: new Date(Date.now() - 16 * 24 * 3600 * 1000).toISOString(),
          changeCategory: 'COUNTERFACTUAL_RETRAIN',
          modelVersion: 'v1.2.0-nse-walkforward',
          parameterOrBucket: 'contracts.max_spread_pct_of_mid',
          oldValue: '0.080',
          newValue: '0.074 (-7.5%)',
          sampleSize: 52,
          bootstrapCi90: '[+₹110.00, +₹440.00] / trade',
          reasonAndEvidence:
            'Counterfactual log confirmed 78% of skipped wide-spread stock option signals (>7.4% spread) would have lost money after ₹35/lot charges.',
        },
      ],
    },
  };
}
