'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBaseSymbol,
  isEligibleBaseSymbol,
  sharedEntryGateRejectionCodes,
  partitionSharedEntryGate,
  selectLiquidUniverse
} = require('./scan-universe.cjs');

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const ACTIVE = new Set();

function ticker(base, volume, overrides) {
  ACTIVE.add(base);
  return {
    symbol: base + 'USDT',
    lastPr: '10',
    quoteVolume: String(volume),
    ts: String(NOW),
    ...(overrides || {})
  };
}

function select(rows, options) {
  return selectLiquidUniverse(rows, {
    now: NOW,
    activeSymbols: ACTIVE,
    minQuoteVolumeUsdt: 1_000_000,
    ...(options || {})
  });
}

test('normalizes Bitget, compact and OKX perpetual symbols', () => {
  assert.equal(normalizeBaseSymbol('BTCUSDT'), 'BTC');
  assert.equal(normalizeBaseSymbol('BTCUSDT_UMCBL'), 'BTC');
  assert.equal(normalizeBaseSymbol('BTC-USDT-SWAP'), 'BTC');
  assert.equal(normalizeBaseSymbol('BTC'), 'BTC');
});

test('selects no more than 60, ordered by validated quote volume', () => {
  const rows = Array.from({length: 80}, (_, i) => ticker('TKN' + String(i).padStart(3, '0'), (i + 1) * 1_000_000));
  const result = select(rows);
  assert.equal(result.rawTickerCount, 80);
  assert.equal(result.eligibleCount, 80);
  assert.equal(result.selectedCount, 60);
  assert.equal(result.selectedSymbols[0], 'TKN079');
  assert.equal(result.selectedSymbols.at(-1), 'TKN020');
  assert.ok(result.selectedRows.every(row => row._nexoraUniverseVersion === 'LIQUID_TOP60_V1'));
});

test('uses all eligible symbols when fewer than 60 are available', () => {
  const result = select([ticker('BTC', 9_000_000), ticker('ETH', 8_000_000)]);
  assert.equal(result.selectedCount, 2);
  assert.deepEqual(result.selectedSymbols, ['BTC', 'ETH']);
});

test('deduplicates symbols and keeps the fresher valid ticker', () => {
  const rows = [
    ticker('BTC', 9_000_000, {ts: String(NOW - 60_000)}),
    ticker('BTC', 8_000_000, {ts: String(NOW)})
  ];
  const result = select(rows);
  assert.equal(result.eligibleCount, 1);
  assert.equal(result.selectedCount, 1);
  assert.equal(result.selectedRows[0].quoteVolume, '8000000');
  assert.equal(result.rejectionCounts.DUPLICATE_SYMBOL, 1);
});

test('rejects invalid prices, missing/low volume and non-USDT tickers', () => {
  const rows = [
    ticker('BAD', 5_000_000, {lastPr: '0'}),
    ticker('NOVOL', 5_000_000, {quoteVolume: ''}),
    ticker('LOW', 999_999),
    {symbol: 'BTCUSDC', lastPr: '10', quoteVolume: '9000000', ts: String(NOW)}
  ];
  const result = select(rows);
  assert.equal(result.selectedCount, 0);
  assert.equal(result.rejectionCounts.INVALID_PRICE, 1);
  assert.equal(result.rejectionCounts.QUOTE_VOLUME_UNAVAILABLE, 1);
  assert.equal(result.rejectionCounts.QUOTE_VOLUME_BELOW_MIN, 1);
  assert.equal(result.rejectionCounts.NOT_USDT_PERPETUAL, 1);
});

test('rejects stable, wrapped/staked and leveraged base tokens', () => {
  for (const base of ['USDC', 'WBTC', 'WSTETH', 'BTCUP', 'ETHDOWN', 'SOL3L', 'XRP2S']) ACTIVE.add(base);
  const rows = ['USDC', 'WBTC', 'WSTETH', 'BTCUP', 'ETHDOWN', 'SOL3L', 'XRP2S']
    .map(base => ({symbol: base + 'USDT', lastPr: '10', quoteVolume: '9000000', ts: String(NOW)}));
  const result = select(rows);
  assert.equal(result.selectedCount, 0);
  assert.equal(result.rejectionCounts.EXCLUDED_BASE_ASSET, rows.length);
  assert.equal(isEligibleBaseSymbol('BTC'), true);
  assert.equal(isEligibleBaseSymbol('BTCUP'), false);
});

test('rejects stale, missing and implausibly future timestamps', () => {
  const rows = [
    ticker('STALE', 5_000_000, {ts: String(NOW - 181_000)}),
    ticker('MISSING', 5_000_000, {ts: ''}),
    ticker('FUTURE', 5_000_000, {ts: String(NOW + 60_000)})
  ];
  const result = select(rows);
  assert.equal(result.selectedCount, 0);
  assert.equal(result.rejectionCounts.TICKER_STALE, 1);
  assert.equal(result.rejectionCounts.TICKER_TIMESTAMP_UNAVAILABLE, 1);
  assert.equal(result.rejectionCounts.TICKER_TIMESTAMP_FUTURE, 1);
});

test('requires active-contract metadata and honors the active set', () => {
  const row = {symbol: 'BTCUSDT', lastPr: '10', quoteVolume: '5000000', ts: String(NOW)};
  const noMetadata = selectLiquidUniverse([row], {now: NOW, minQuoteVolumeUsdt: 1_000_000});
  assert.equal(noMetadata.selectedCount, 0);
  assert.equal(noMetadata.rejectionCounts.ACTIVE_METADATA_UNAVAILABLE, 1);
  const inactive = selectLiquidUniverse([row], {now: NOW, activeSymbols: new Set(['ETH']), minQuoteVolumeUsdt: 1_000_000});
  assert.equal(inactive.selectedCount, 0);
  assert.equal(inactive.rejectionCounts.CONTRACT_NOT_ACTIVE, 1);
});

test('rejects non-perpetual contract metadata even with a USDT-like symbol', () => {
  const row = ticker('BTC', 5_000_000, {contractType: 'CURRENT_QUARTER'});
  const result = select([row]);
  assert.equal(result.selectedCount, 0);
  assert.equal(result.rejectionCounts.NOT_USDT_PERPETUAL, 1);
});

test('keeps all 60 selected tickers available for MTF while classifying the unchanged entry gate', () => {
  const candidates = Array.from({length: 60}, (_, i) => ({
    sym: 'TKN' + String(i).padStart(2, '0'),
    price: 10,
    volume: 2_000_000,
    fund: 0.0001,
    chg: 1
  }));
  candidates[0].fund = 0.005;
  candidates[1].chg = 3.6;
  candidates[2].volume = 0;
  candidates[3].price = 0;
  candidates[4].fund = 0.006;
  candidates[4].chg = -4;

  // Selection does not silently remove strategy-gated tickers. The caller can
  // submit the selected set for MTF first, then partition it for paper entry.
  const selected = select(candidates.map((candidate, i) => ticker(candidate.sym, 2_000_000, {
    lastPr: String(candidate.price || 10),
    fundingRate: String(candidate.fund),
    change24h: String(candidate.chg / 100)
  })));
  assert.equal(selected.selectedCount, 60);
  assert.equal(candidates.length, 60);

  const partition = partitionSharedEntryGate(candidates);
  assert.equal(partition.passed.length, 55);
  assert.equal(partition.rejected.length, 5);
  assert.equal(partition.rejectionCounts.FUNDING_ABOVE_LIMIT, 2);
  assert.equal(partition.rejectionCounts.EXTREME_24H_CHANGE, 2);
  assert.equal(partition.rejectionCounts.MISSING_VOLUME, 1);
  assert.equal(partition.rejectionCounts.INVALID_PRICE, 1);
  assert.deepEqual(sharedEntryGateRejectionCodes({price: 1, volume: 1, fund: 0, chg: 0}), []);
});


