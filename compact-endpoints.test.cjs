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
    paperLabAccountSummary: () => ({}),
    paperLabIsActive: trade => trade.status === 'OPEN',
    paperTradeView: trade => ({id: trade.id, universeVersion: trade.universeVersion}),
    PAPER_LAB_MODE: 'SHADOW',
    PAPER_LAB_STARTING_EQUITY: 200,
    PAPER_LAB_PER_SCAN: 3,
    PAPER_LAB_STRATEGIES: {}
  });

  const compact = summary(false, {history: false});
  const detailed = summary(false);
  assert.equal(Object.hasOwn(compact, 'recentScans'), false);
  assert.equal(Object.hasOwn(compact, 'overlapEvents'), false);
  assert.equal(detailed.recentScans.length, 20);
  assert.equal(detailed.overlapEvents.length, 10);
  assert.equal(compact.activeTrades[0].universeVersion, 'LIQUID_TOP60_V1');
  assert.ok(JSON.stringify(compact).length < JSON.stringify(detailed).length / 5);
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
    sl: 90, tp1: 120, universeVersion: 'LIQUID_TOP60_V1', strategyVersion: 'RESEARCH_COLLECTION'
  });
  const oldView = tradeView({id: 'legacy-order', sym: 'ETH', dir: 'SHORT', status: 'OPEN'});
  assert.equal(view.universeVersion, 'LIQUID_TOP60_V1');
  assert.equal(oldView.universeVersion, 'LEGACY');
});
