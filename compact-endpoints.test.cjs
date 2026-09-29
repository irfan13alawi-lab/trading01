'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function loadFunction(name, nextName, bindings) {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\nfunction ' + nextName + '(', start + 1);
  assert.ok(start >= 0 && end > start, 'could not locate ' + name + ' source');
  return vm.runInNewContext('(' + source.slice(start, end).trim() + ')', bindings || {});
}

test('compact paper summary omits Strategy Lab scan history while detailed view retains it', () => {
  const lab = {
    enabled: true,
    accounts: {MTF_ATR_V2: {activeTrades: [{id: 'lab-1', status: 'OPEN', universeVersion: 'LIQUID_TOP60_V1'}]}},
    recentScans: Array.from({length: 20}, (_, index) => ({cycleKey: String(index), detail: 'x'.repeat(1000)})),
    overlapEvents: Array.from({length: 10}, (_, index) => ({id: index})),
    lastScanAt: '2026-09-21T12:00:00.000Z',
    lastCycleKey: '2026-09-21T12:00Z',
    lastError: null
  };
  const summary = loadFunction('paperStrategyLabSummary', 'paperIsActive', {
    paperState: {strategyLab: lab},
    paperLabDefaultState: () => lab,
    paperLabAccountSummary: account => ({strategyId: 'MTF_ATR_V2', equity: 200, pnl: 0,
      closed: 0, active: 1, fillStats: {orders: 1}}),
    paperLabIsActive: trade => trade.status === 'OPEN',
    paperLabNormaliseFilters: () => ({strategyId: '', symbol: '', direction: '', timeframe: '', regime: '', from: '', to: ''}),
    paperLabTradeMatchesFilters: () => true,
    paperTradeView: trade => ({id: trade.id, universeVersion: trade.universeVersion}),
    PAPER_LAB_MODE: 'SHADOW',
    PAPER_LAB_STARTING_EQUITY: 200,
    PAPER_LAB_PER_SCAN: 3,
    PAPER_LAB_STRATEGIES: {MTF_ATR_V2: {label: 'MTF + ATR', version: 'MTF_ATR_V2',
      rules: {entry: 'Rule ' + 'x'.repeat(250)}, trailing: {enabled: true}}},
    PAPER_LAB_COST_MODEL_VERSION: 'TEST_COST_MODEL',
    PAPER_LAB_MAKER_FEE_RATE: 0.0002,
    PAPER_LAB_TAKER_FEE_RATE: 0.0006,
    PAPER_LAB_TAKER_SLIPPAGE_BPS: 5,
    PAPER_LAB_FALLBACK_SPREAD_BPS: 10,
    PAPER_LAB_FILL_PARTICIPATION_RATE: 0.01,
    PAPER_LAB_MIN_EVALUATION_TRADES: 100
  });

  const compact = summary(false, {history: false});
  const detailed = summary(false);
  const compactProjection = summary(false, {history: false, compact: true});
  assert.equal(Object.hasOwn(compact, 'recentScans'), false);
  assert.equal(Object.hasOwn(compact, 'overlapEvents'), false);
  assert.equal(detailed.recentScans.length, 20);
  assert.equal(detailed.overlapEvents.length, 10);
  assert.equal(compact.activeTrades[0].universeVersion, 'LIQUID_TOP60_V1');
  assert.ok(JSON.stringify(compact).length < JSON.stringify(detailed).length / 5);
  assert.equal(Object.hasOwn(compactProjection.accounts[0], 'rules'), false);
  assert.equal(Object.hasOwn(compactProjection.definition.strategies.MTF_ATR_V2, 'rules'), false);
  assert.match(source, /paperStatus\(\{details: false, stats: false, labHistory: false\}\)/);
});

test('paper history honors limit and offset while reporting total retained matches', () => {
  const rows = [{id: 'one'}, {id: 'two'}, {id: 'three'}];
  const history = loadFunction('paperHistory', 'paperWinRateAlertView', {
    paperHistoryFilters: () => ({}),
    paperState: {closedTrades: rows, activeTrades: [], invalidatedTrades: [], monitoringSignals: []},
    PAPER_MAX_CLOSED_TRADES: 100,
    PAPER_MAX_MONITORING_SIGNALS: 10,
    paperHistoryMatches: () => true,
    paperIsActive: () => false,
    paperTradeView: trade => trade
  });

  const page = history(new URLSearchParams('limit=1&offset=1'));
  assert.deepEqual(page.closedTrades.map(trade => trade.id), ['two']);
  assert.equal(page.total, 3);
  assert.equal(JSON.stringify(page.pagination), JSON.stringify({limit: 1, offset: 1, returned: 1, hasMore: true}));

  const defaultPage = history(new URLSearchParams());
  assert.deepEqual(defaultPage.closedTrades.map(trade => trade.id), ['one', 'two', 'three']);
  assert.equal(defaultPage.pagination.hasMore, false);
});

test('active trade view exposes stored universe version and labels old trades', () => {
  const tradeView = loadFunction('paperTradeView', 'paperCandidateView', {
    paperEnsureAnalysis: () => {},
    paperNumber: value => Number.isFinite(Number(value)) ? Number(value) : 0,
    PAPER_TP1_CLOSE_PCT: 50,
    paperTradeOriginalSize: () => 1,
    paperTradeRemainingSize: () => 1,
    paperTradeOriginalContracts: () => 1,
    paperTradeRemainingContracts: () => 1,
    paperTradeRiskDollar: () => 0.5,
    paperTradeInitialRiskDollar: () => 0.5,
    paperTradeStrategyVersion: trade => trade.strategyVersion || 'LEGACY',
    paperIsResearchTrade: () => false,
    paperExecutionModel: () => 'LIMIT_OHLC',
    isStrictPaperTrade: () => false
  });
  const view = tradeView({
    id: 'new-order', sym: 'BTC', dir: 'LONG', status: 'PENDING', entryLimit: 100,
    sl: 90, tp1: 120, universeVersion: 'LIQUID_TOP60_V1', strategyVersion: 'RESEARCH_COLLECTION',
    signalSnapshotVersion: 1, priceAtSignal: 101, oiUnits: 250, oiUSD: 25000,
    entryDelayMs: 120000, entryCandleDelayMs: 60000, exitCandleAt: '2026-09-29T12:10:00.000Z',
    exitDelayMs: 3600000, exitCandleDelayMs: 3000000, tp1CandleAt: '2026-09-29T12:05:00.000Z',
    timeToTp1Ms: 600000, tp1CandleDelayMs: 300000
  });
  const oldView = tradeView({id: 'legacy-order', sym: 'ETH', dir: 'SHORT', status: 'OPEN'});
  assert.equal(view.universeVersion, 'LIQUID_TOP60_V1');
  assert.equal(view.signalSnapshotVersion, 1);
  assert.equal(view.priceAtSignal, 101);
  assert.equal(view.oiUnits, 250);
  assert.equal(view.oiUSD, 25000);
  assert.equal(view.entryDelayMs, 120000);
  assert.equal(view.entryCandleDelayMs, 60000);
  assert.equal(view.exitDelayMs, 3600000);
  assert.equal(view.exitCandleDelayMs, 3000000);
  assert.equal(view.timeToTp1Ms, 600000);
  assert.equal(view.tp1CandleDelayMs, 300000);
  assert.equal(oldView.universeVersion, 'LEGACY');
});
