'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const paperNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;

function loadFunction(name, nextName, bindings = {}) {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\nfunction ' + nextName + '(', start + 1);
  assert.ok(start >= 0 && end > start, 'could not locate ' + name + ' source');
  return vm.runInNewContext('(' + source.slice(start, end).trim() + ')', bindings);
}

test('estimated execution costs charge configured fee, half spread and taker slippage', () => {
  const executionCost = loadFunction('paperLabExecutionCost', 'paperLabAccumulateCosts', {paperNumber});
  const trade = {
    entryActual: 100,
    executionCostModel: {makerFeeRate: 0.0002, takerFeeRate: 0.0006,
      takerSlippageBps: 5, fallbackSpreadBps: 10},
    quoteSnapshotAtOrder: {spreadBps: 10}
  };
  const maker = executionCost(trade, 100, 1000, 'MAKER');
  const taker = executionCost(trade, 100, 1000, 'TAKER');
  assert.equal(maker.feeUsd, 0.2);
  assert.equal(maker.totalUsd, 0.2);
  assert.equal(taker.feeUsd, 0.6);
  assert.equal(taker.spreadUsd, 0.5);
  assert.equal(taker.slippageUsd, 0.5);
  assert.equal(taker.totalUsd, 1.6);
});

test('partial-fill capacity uses quote-volume participation and never exceeds remaining notional', () => {
  const fillCapacity = loadFunction('paperLabFillCapacity', 'paperLabTimestampMs', {
    paperNumber, PAPER_LAB_FILL_PARTICIPATION_RATE: 0.01
  });
  const trade = {orderRemainingSize: 100, executionCostModel: {fillParticipationRate: 0.01}};
  assert.equal(fillCapacity(trade, 5000), 50);
  assert.equal(fillCapacity(trade, 50000), 100);
  assert.equal(fillCapacity(trade, 0), 0);
  assert.equal(fillCapacity(trade, -10), 0);
  assert.equal(fillCapacity({orderRemainingSize: 100}, 5000), 50);
});

test('entry fill ledger records maker cost, first-fill latency, candle latency and price drift', () => {
  const bookFill = loadFunction('paperLabBookEntryFill', 'paperLabFillCapacity', {
    paperNumber,
    paperLabTimestampMs: value => typeof value === 'number' ? value : Date.parse(value || '') || 0,
    paperLabAccumulateCosts: (trade, cost, phase) => {
      trade.costs.totalUsd += cost.totalUsd;
      if (phase === 'ENTRY') trade.costs.entryFeesUsd += cost.feeUsd;
    },
    paperAddTradeEvent: (trade, type, data) => trade.events.push({type, ...data})
  });
  const now = Date.now();
  const trade = {
    executionCostModel: {makerFeeRate: 0.0002, fillParticipationRate: 0.01},
    costs: {entryFeesUsd: 0, exitFeesUsd: 0, spreadUsd: 0, slippageUsd: 0, totalUsd: 0},
    signalCreatedAt: new Date(now - 10 * 60 * 1000).toISOString(), priceAtSignal: 100,
    orderRemainingSize: 50, orderRequestedSize: 50, filledSize: 0,
    fillEvents: [], events: []
  };
  bookFill(trade, 25, {ts: now - 60 * 1000, close: 102, quoteVolume: 2500});
  assert.equal(trade.costs.entryFeesUsd, 0.005);
  assert.equal(trade.fillStatus, 'PARTIALLY_FILLED');
  assert.equal(trade.fillEvents.length, 1);
  assert.equal(trade.fillEvents[0].sizeUsd, 25);
  assert.equal(trade.fillEvents[0].priceDriftFromSignalPct, 2);
  assert.ok(trade.entryDelayMs >= 9 * 60 * 1000);
  assert.ok(trade.entryCandleDelayMs >= 8 * 60 * 1000);
});

test('OI divergence uses contract units and rejects stale or missing baselines', () => {
  const oiChange = loadFunction('paperLabOiChange1h', 'paperLabLastClosedBarChangePct', {paperNumber});
  const now = Date.parse('2026-09-29T12:00:00.000Z');
  const pair = {sym: 'ETH', oiAvailable: true};
  const history = {ETH: [
    {ts: now - 60 * 60 * 1000, oiUnits: 100, oiUSD: 100000},
    {ts: now - 60 * 1000, oiUnits: 102, oiUSD: 120000}
  ]};
  assert.equal(oiChange(pair, now, history), 2);
  assert.equal(oiChange(pair, now, {ETH: [{ts: now - 60 * 1000, oiUSD: 120000}]}), null);
  assert.equal(oiChange(pair, now, {ETH: [
    {ts: now - 60 * 60 * 1000, oiUnits: 100},
    {ts: now - 20 * 60 * 1000, oiUnits: 102}
  ]}), null);
});

test('relative strength is ranked against BTC using labeled three-bar H1 momentum', () => {
  const snapshot = loadFunction('paperLabRelativeStrengthSnapshot', 'paperLabFundingPercentiles', {paperNumber});
  const pairs = [
    {sym: 'BTC', chg: 2, mtf: {H1: {status: 'FULL', change: 0.3}}},
    {sym: 'ETH', chg: 5, mtf: {H1: {status: 'FULL', change: 0.7}}},
    {sym: 'SOL', chg: -2, mtf: {H1: {status: 'FULL', change: -0.1}}},
    {sym: 'X', chg: 9, mtf: {H1: {status: 'STALE', change: 8}}}
  ];
  const ranks = snapshot(pairs);
  assert.equal(ranks.ETH.relative24hPct, 3);
  assert.equal(ranks.ETH.relative3hPct, 0.4);
  assert.equal(ranks.ETH.percentile, 100);
  assert.equal(ranks.SOL.percentile, 0);
  assert.equal(Object.hasOwn(ranks, 'X'), false);
});

test('breakout retest challenger requires a closed retest and enforces its four-candle window', () => {
  const retestSnapshot = loadFunction('paperBreakoutRetestSnapshot', 'paperIndicatorSnapshot', {
    paperNumber, paperMean: values => {
      const valid = values.filter(Number.isFinite);
      return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
    }
  });
  const start = Date.parse('2026-09-29T00:00:00Z');
  const rows = Array.from({length: 33}, (_, index) => ({
    ts: start + index * 15 * 60 * 1000, open: 99.5, high: 100, low: 99,
    close: 99.5, volume: 10
  }));
  rows[29] = {...rows[29], open: 99.8, high: 101.2, low: 99.5, close: 101, volume: 20};
  rows[30] = {...rows[30], open: 100.1, high: 100.6, low: 99.95, close: 100.4};
  rows[31] = {...rows[31], open: 100.2, high: 100.7, low: 100.05, close: 100.5};
  rows[32] = {...rows[32], open: 100.3, high: 100.8, low: 100.1, close: 100.6};
  const atr = Array(rows.length).fill(1);
  const withinFour = retestSnapshot(rows, atr, 4);
  const outsideTwo = retestSnapshot(rows, atr, 2);
  assert.equal(withinFour.valid, true);
  assert.equal(withinFour.direction, 'LONG');
  assert.equal(withinFour.level, 100);
  assert.equal(withinFour.maxRetestCandles, 4);
  assert.equal(outsideTwo.valid, false);
});

test('funding/OI one-hour price trigger uses one completed H1 candle, not three-hour momentum', () => {
  const closedBarChange = loadFunction('paperLabLastClosedBarChangePct', 'paperLabEvaluateRelativeStrength', {paperNumber});
  assert.equal(closedBarChange({change: 1.2, indicators: {open: 100, close: 99.7}}), -0.3);
  assert.equal(closedBarChange({indicators: {open: 0, close: 99.7}}), null);
});

test('net performance uses only cost-complete records and reports post-cost risk metrics', () => {
  const metrics = loadFunction('paperLabSimpleNetMetrics', 'paperLabConcentrationMetrics', {
    paperNumber, PAPER_LAB_STARTING_EQUITY: 200,
    paperLabClosedAtMs: trade => Date.parse(trade.closedAt || '') || 0
  });
  const result = metrics([
    {closedAt: '2026-09-27T12:00:00.000Z', netPnlAfterCosts: 4, rNetAfterCosts: 2, costStatus: 'ESTIMATED_COMPLETE'},
    {closedAt: '2026-09-28T12:00:00.000Z', netPnlAfterCosts: -2, rNetAfterCosts: -1, costStatus: 'ESTIMATED_COMPLETE'},
    {closedAt: '2026-09-29T12:00:00.000Z', pnl: 100, r: 5, costStatus: 'LEGACY_DATA_INCOMPLETE'}
  ], 200);
  assert.equal(result.closed, 2);
  assert.equal(result.netPnl, 2);
  assert.equal(result.netR, 1);
  assert.equal(result.expectancyR, 0.5);
  assert.equal(result.profitFactorAfterCosts, 2);
  assert.equal(result.maxDrawdownUsd, 2);
});

test('concentration reports top-symbol share of the costed trade sample and absolute PnL', () => {
  const concentration = loadFunction('paperLabConcentrationMetrics', 'paperLabTimingStats', {paperNumber});
  const result = concentration([
    {sym: 'BTC', netPnlAfterCosts: 2},
    {sym: 'BTC', netPnlAfterCosts: -3},
    {sym: 'ETH', netPnlAfterCosts: -1}
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    topSymbol: 'BTC', topSymbolNetPnl: -1, topSymbolClosedTrades: 2,
    topSymbolTradeSharePct: 66.7, topSymbolAbsPnlSharePct: 83.3
  });
});

test('Strategy Lab applies the same strategy, date, symbol, direction, timeframe and regime filters', () => {
  const normalise = loadFunction('paperLabNormaliseFilters', 'paperLabTradeMatchesFilters');
  const matches = loadFunction('paperLabTradeMatchesFilters', 'paperLabClosedAtMs', {
    paperTradeRegimeTag: () => 'TRENDING_BULL'
  });
  const filters = normalise({strategyId: 'RELATIVE_STRENGTH_V1', symbol: 'BTCUSDT', direction: 'long',
    timeframe: '15m', regime: 'trending-bull', from: '2026-09-01', to: '2026-09-30'});
  const trade = {strategyId: 'RELATIVE_STRENGTH_V1', sym: 'BTC', dir: 'LONG', timeframe: '15M',
    closedAt: '2026-09-29T12:00:00.000Z'};
  assert.equal(matches(trade, filters), true);
  assert.equal(matches({...trade, sym: 'ETH'}, filters), false);
  assert.equal(matches({...trade, closedAt: '2026-08-31T23:59:59.000Z'}, filters), false);
  assert.equal(matches({...trade, strategyId: 'MTF_ATR_V2'}, filters), false);
  assert.equal(matches({...trade, dir: 'SHORT'}, filters), false);
  assert.equal(matches({...trade, timeframe: '1H'}, filters), false);
  assert.equal(matches(trade, {...filters, regime: 'RANGING'}), false);
});

test('timing statistics use observed fill/TP1/close latency and ignore missing legacy timestamps', () => {
  const timingStats = loadFunction('paperLabTimingStats', 'paperLabLegacyHistory', {paperNumber});
  const result = timingStats([
    {filledSize: 1, entryDelayMs: 120000, timeToTp1Ms: 600000, exitDelayMs: 1800000, tp1Hit: true, status: 'CLOSED', closedAt: '2026-09-29T12:30:00Z'},
    {openedAt: '2026-09-29T12:00:00Z', entryDelayMs: 240000, timeToTp1Ms: null, exitDelayMs: 3600000, tp1Hit: false, status: 'CLOSED', closedAt: '2026-09-29T13:00:00Z'},
    {status: 'PENDING', entryDelayMs: null, timeToTp1Ms: null, exitDelayMs: null}
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    timeToFirstFill: {samples: 2, averageMs: 180000},
    timeToTp1: {samples: 1, averageMs: 600000},
    timeToClose: {samples: 2, averageMs: 2700000}
  });
});

test('legacy Strategy Lab history keeps recorded outcomes and PnL without claiming costs', () => {
  const legacyHistory = loadFunction('paperLabLegacyHistory', 'paperLabAccountSummary', {paperNumber});
  const result = legacyHistory([
    {outcome: 'WIN', pnl: 2.5},
    {outcome: 'LOSS', pnl: -1.25},
    {outcome: 'BREAKEVEN', pnl: 0},
    {outcome: 'CLOSED', pnl: 0.75}
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    closed: 4, wins: 1, losses: 1, breakeven: 1, unclassified: 1,
    winRatePct: 33.3, recordedPnl: 2, pnlBasis: 'AS_RECORDED_COSTS_UNKNOWN'
  });
});

test('legacy trade migration preserves recorded result and does not invent execution costs', () => {
  const tagLegacy = loadFunction('paperLabTagLegacyTrade', 'paperLabDefaultState', {
    paperLabLegacyMissingFields: trade => ['strategyConfigSnapshot', 'executionCostModel', 'completeCostLedger'],
    paperNumber
  });
  const closed = {id: 'old-1', status: 'CLOSED', pnl: -1.25, outcome: 'LOSS'};
  tagLegacy(closed);
  assert.equal(closed.pnl, -1.25);
  assert.equal(closed.outcome, 'LOSS');
  assert.equal(closed.dataCompleteness, 'LEGACY_DATA_INCOMPLETE');
  assert.equal(Object.hasOwn(closed, 'netPnlAfterCosts'), false);
  const pending = {id: 'old-2', status: 'PENDING', size: 50};
  tagLegacy(pending);
  assert.equal(pending.orderRequestedSize, 50);
  assert.equal(pending.orderRemainingSize, 50);
  assert.equal(pending.filledSize, 0);
  assert.equal(pending.remainingSize, 0);
});

test('Strategy Lab migration preserves the existing ledger and seeds only newly added strategies at $200', () => {
  const strategies = {
    MTF_ATR_V2: {label: 'MTF baseline', version: 'MTF_ATR_V2', enabled: true},
    RELATIVE_STRENGTH_V1: {label: 'Relative Strength', version: 'RELATIVE_STRENGTH_V1', enabled: true}
  };
  const defaultAccount = strategyId => ({strategyId, label: strategies[strategyId].label,
    version: strategies[strategyId].version, enabled: true, startingEquity: 200, equityPeak: 200,
    riskPct: 0.5, minRR: 2, maxActive: 20, pendingTtlMs: 7200000,
    activeTrades: [], closedTrades: [], monitoringSignals: [], signalCooldowns: {}, recentRejections: []});
  const normalize = loadFunction('paperLabNormaliseState', 'defaultPaperState', {
    PAPER_LAB_STRATEGIES: strategies,
    PAPER_LAB_STARTING_EQUITY: 200,
    PAPER_LAB_MAX_CLOSED_TRADES: 2000,
    PAPER_LAB_MODE: 'SHADOW',
    PAPER_TP1_CLOSE_PCT: 50,
    paperLabDefaultState: () => ({accounts: Object.fromEntries(Object.keys(strategies)
      .map(id => [id, defaultAccount(id)])), enabled: true, recentScans: [], overlapEvents: []}),
    paperLabTagLegacyTrade: trade => {trade.dataCompleteness = 'LEGACY_DATA_INCOMPLETE'; return trade;}
  });
  const historical = {id: 'old-mtf', status: 'CLOSED', pnl: 12.5, outcome: 'WIN'};
  const migrated = normalize({accounts: {MTF_ATR_V2: {startingEquity: 245, equityPeak: 270,
    activeTrades: [{id: 'open-old', status: 'OPEN'}], closedTrades: [historical]}}});
  assert.equal(migrated.accounts.MTF_ATR_V2.startingEquity, 245);
  assert.equal(migrated.accounts.MTF_ATR_V2.equityPeak, 270);
  assert.equal(migrated.accounts.MTF_ATR_V2.closedTrades[0].pnl, 12.5);
  assert.equal(migrated.accounts.MTF_ATR_V2.closedTrades[0].outcome, 'WIN');
  assert.equal(migrated.accounts.MTF_ATR_V2.closedTrades[0].dataCompleteness, 'LEGACY_DATA_INCOMPLETE');
  assert.equal(migrated.accounts.MTF_ATR_V2.activeTrades[0].id, 'open-old');
  assert.equal(migrated.accounts.RELATIVE_STRENGTH_V1.startingEquity, 200);
  assert.equal(migrated.accounts.RELATIVE_STRENGTH_V1.closedTrades.length, 0);
});

test('new signal analysis snapshot freezes strategy rules, quote and multi-timeframe indicators', () => {
  const buildSnapshot = loadFunction('paperBuildAnalysisSnapshot', 'paperEnsureAnalysis', {
    paperAnalysisHasPartialContext: () => true,
    paperAnalysisCaptured: () => true,
    paperTradeRegimeTag: () => 'TRENDING_BULL'
  });
  const trade = {
    sym: 'BTC', dir: 'LONG', strategyId: 'RELATIVE_STRENGTH_V1', strategyVersion: 'RELATIVE_STRENGTH_V1',
    strategyConfigSnapshot: {riskPct: 0.5, rules: {entry: 'test'}},
    signalCreatedAt: '2026-09-29T12:00:00.000Z', priceAtSignal: 100,
    chg: 2.5, fund: 0.0001, oi: 1.2, oiUnits: 1000, oiUSD: 100000,
    volume: 500000, volumeRatio: 1.8, dataQuality: 'FULL', source: 'Bitget Futures',
    quoteSnapshotAtOrder: {bid: 99.9, ask: 100.1, spreadBps: 20},
    executionCostModel: {version: 'TEST'}, costs: {totalUsd: 0}, fillStatus: 'PENDING', fillEvents: [],
    mtf: {H4: {direction: 'LONG', status: 'FULL', sampleSize: 100, indicators: {ema21: 98}},
      H1: {direction: 'LONG', status: 'FULL', sampleSize: 100, atr: 1.5, indicators: {rsi: 61}},
      M30: {direction: 'LONG', status: 'FULL', sampleSize: 100},
      M15: {direction: 'LONG', status: 'FULL', sampleSize: 100, indicators: {rsi: 58}}},
    entryLimit: 99.8, sl: 98, tp1: 103.4, tp2: 105.2,
    setupValidation: {rr: 2}, mtfAlignment: 4, confluencePct: 95
  };
  const snapshot = buildSnapshot(trade);
  assert.equal(snapshot.strategy.id, 'RELATIVE_STRENGTH_V1');
  assert.equal(snapshot.strategy.config.riskPct, 0.5);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.setup.quoteSnapshotAtOrder)), trade.quoteSnapshotAtOrder);
  assert.equal(snapshot.mtf.H4.sampleSize, 100);
  assert.equal(snapshot.mtf.H1.indicators.rsi, 61);
  assert.equal(snapshot.market.oiUnits, 1000);
  assert.equal(snapshot.execution.model.version, 'TEST');
});

test('timestamps accept legacy epoch and ISO forms without coercing ISO strings to zero', () => {
  const toMs = loadFunction('paperLabTimestampMs', 'paperLabCloseTrade');
  const expected = Date.parse('2026-09-29T12:00:00.000Z');
  assert.equal(toMs(expected), expected);
  assert.equal(toMs(String(expected)), expected);
  assert.equal(toMs('2026-09-29T12:00:00.000Z'), expected);
  assert.equal(toMs('invalid'), 0);
});

test('new limit fill candle cannot award favorable TP before the order sequence is knowable', () => {
  const processExitBar = loadFunction('paperLabProcessExitBar', 'monitorStrategyLabTrades', {
    paperNumber,
    paperLabTimestampMs: value => typeof value === 'number' ? value : Date.parse(value || '') || 0,
    paperTradeRemainingSize: trade => trade.remainingSize,
    paperTradePnl: (trade, price, size) => (price - trade.entryActual) / trade.entryActual * size,
    paperLabExecutionCost: () => ({totalUsd: 0}),
    paperLabCloseTrade: () => assert.fail('entry candle should not close at an optimistic target'),
    paperLabPartialClose: () => assert.fail('entry candle should defer favorable TP'),
    paperAddTradeEvent: () => {},
    paperSetRemainingSize: () => {},
    PAPER_LAB_FILL_PARTICIPATION_RATE: 0.01
  });
  const trade = {status: 'OPEN', dir: 'LONG', entryActual: 100, entryLimit: 100,
    remainingSize: 10, sl: 95, tp1: 105, tp2: 110, realizedPnl: 0,
    costStatus: 'LEGACY_DATA_INCOMPLETE'};
  const result = processExitBar({}, trade, {ts: Date.parse('2026-09-29T12:00:00Z'),
    open: 100, high: 106, low: 99, close: 104}, {entryCandle: true});
  assert.equal(result, 'KEEP');
  assert.equal(trade.status, 'OPEN');
});

test('same-candle stop and target ambiguity is resolved stop-first', () => {
  let closeReason = null;
  const processExitBar = loadFunction('paperLabProcessExitBar', 'monitorStrategyLabTrades', {
    paperNumber,
    paperLabTimestampMs: value => typeof value === 'number' ? value : Date.parse(value || '') || 0,
    paperTradeRemainingSize: trade => trade.remainingSize,
    paperTradePnl: () => 0,
    paperLabCloseTrade: (account, trade, price, outcome, reason) => {
      closeReason = reason;
      trade.status = 'CLOSED';
    },
    paperLabPartialClose: () => assert.fail('ambiguous candle must not be booked as TP1 first'),
    paperAddTradeEvent: () => {},
    paperSetRemainingSize: () => {}
  });
  const trade = {status: 'OPEN', dir: 'LONG', entryActual: 100, entryLimit: 100,
    remainingSize: 10, sl: 95, tp1: 105, tp2: 110, realizedPnl: 0};
  const result = processExitBar({}, trade, {ts: Date.now(), open: 100, high: 111, low: 94, close: 102});
  assert.equal(result, 'CLOSED');
  assert.equal(closeReason, 'Hit SL');
});

test('monitor turns a touched limit into a quote-volume-capped partial fill without losing its remainder', () => {
  const fillCapacity = loadFunction('paperLabFillCapacity', 'paperLabTimestampMs', {
    paperNumber, PAPER_LAB_FILL_PARTICIPATION_RATE: 0.01
  });
  const barAt = Date.now() - 30000;
  const ttlMs = 120 * 60 * 1000;
  const trade = {id: 'partial', sym: 'BTC', dir: 'LONG', status: 'PENDING', entryLimit: 100,
    createdAt: barAt - 1000, pendingTtlMs: ttlMs, orderRequestedSize: 100, orderRemainingSize: 100,
    filledSize: 0, remainingSize: 0, events: []};
  const account = {activeTrades: [trade], closedTrades: [], pendingTtlMs: ttlMs, equityPeak: 200, startingEquity: 200};
  const monitor = loadFunction('monitorStrategyLabTrades', 'paperLabNormaliseFilters', {
    paperState: {strategyLab: {enabled: true, accounts: {MTF_ATR_V2: account}}},
    paperLabIsActive: item => ['PENDING', 'PARTIALLY_FILLED', 'OPEN', 'TP1_PARTIAL'].includes(item.status),
    paperLabTimestampMs: value => typeof value === 'number' ? value : Date.parse(value || '') || 0,
    paperTradeRemainingSize: item => Number(item.remainingSize || 0),
    paperSetRemainingSize: (item, value) => {item.remainingSize = value;},
    paperLabFillCapacity: fillCapacity,
    paperLabBookEntryFill: (item, size) => {item.bookedFillSize = (item.bookedFillSize || 0) + size;},
    paperLabProcessExitBar: () => 'KEEP',
    paperNumber,
    paperAddTradeEvent: () => {},
    paperLabUpdatePeak: () => {},
    PAPER_LAB_MAX_CLOSED_TRADES: 2000
  });
  monitor(
    {BTC: 100}, {BTC: [{ts: barAt, open: 101, high: 102, low: 99, close: 100.5, quoteVolume: 5000}]}
  );
  assert.equal(trade.filledSize, 50);
  assert.equal(trade.bookedFillSize, 50);
  assert.equal(trade.orderRemainingSize, 50);
  assert.equal(trade.status, 'PARTIALLY_FILLED');
  assert.equal(account.activeTrades[0], trade);
});

test('untouched Strategy Lab limit is cancelled after its configured 120-minute TTL', () => {
  const ttlMs = 120 * 60 * 1000;
  const trade = {id: 'pending-expired', sym: 'BTC', status: 'PENDING', createdAt: Date.now() - ttlMs - 1000,
    pendingTtlMs: ttlMs, orderRemainingSize: 50, orderRequestedSize: 50, remainingSize: 0,
    fillStatus: 'PENDING', events: []};
  const account = {activeTrades: [trade], closedTrades: [], pendingTtlMs: ttlMs, equityPeak: 200, startingEquity: 200};
  const monitor = loadFunction('monitorStrategyLabTrades', 'paperLabNormaliseFilters', {
    paperState: {strategyLab: {enabled: true, accounts: {MTF_ATR_V2: account}}},
    paperLabIsActive: item => ['PENDING', 'OPEN', 'TP1_PARTIAL', 'PARTIALLY_FILLED'].includes(item.status),
    paperLabTimestampMs: value => typeof value === 'number' ? value : Date.parse(value || '') || 0,
    paperTradeRemainingSize: item => Number(item.remainingSize || 0),
    paperNumber,
    paperAddTradeEvent: (item, type, data) => item.events.push({type, ...data}),
    paperLabUpdatePeak: () => {},
    PAPER_LAB_MAX_CLOSED_TRADES: 2000
  });
  assert.equal(monitor({}, {}), true);
  assert.equal(account.activeTrades.length, 0);
  assert.equal(account.closedTrades[0].id, 'pending-expired');
  assert.equal(account.closedTrades[0].outcome, 'CANCELLED');
  assert.equal(account.closedTrades[0].fillStatus, 'EXPIRED_UNFILLED');
});

test('dashboard inline JavaScript parses after Strategy Lab UI changes', () => {
  const html = fs.readFileSync(path.join(__dirname, 'Nexora_V4_Clean.html'), 'utf8');
  assert.match(html, /legacy history is preserved as-recorded/);
  assert.match(html, /Entry \/ exit &amp; version rules/);
  assert.match(html, /no cost-complete sample/);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=|\btype\s*=\s*["']application\/json/i.test(match[1]) && match[2].trim());
  assert.ok(scripts.length > 0, 'dashboard should include inline scripts');
  scripts.forEach((match, index) => new vm.Script(match[2], {filename: 'dashboard-inline-' + index}));
});
