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

const intervals = {H4: 4 * 60 * 60 * 1000, H1: 60 * 60 * 1000, M30: 30 * 60 * 1000, M15: 15 * 60 * 1000};
const now = Date.UTC(2026, 8, 21, 12, 0, 0);

function candles(count, timeframe, ageMs) {
  const interval = intervals[timeframe];
  const lastTs = now - ageMs;
  const rows = Array.from({length: count}, (_, index) => ({
    ts: lastTs - (count - index - 1) * interval,
    open: 10, high: 11, low: 9, close: 10, volume: 100
  }));
  rows._nexoraCandleIntervalMs = interval;
  rows._nexoraLatestClosedTs = lastTs;
  rows._nexoraFetchedAt = new Date(now).toISOString();
  return rows;
}

test('stale, partial and missing timeframe evidence is classified and explained per timeframe', () => {
  const timeframeEvidence = loadFunction('paperTimeframeEvidence', 'paperMtfSummary', {
    PAPER_MIN_CANDLES: 100,
    PAPER_TIMEFRAME_MAX_AGE_MS: {
      H4: 12 * 60 * 60 * 1000,
      H1: 3 * 60 * 60 * 1000,
      M30: 90 * 60 * 1000,
      M15: 45 * 60 * 1000
    },
    paperGranularityMs: timeframe => intervals[timeframe],
    paperIndicatorSnapshot: rows => rows.length < 100 ? null : ({
      sampleSize: rows.length,
      direction: 'SHORT',
      strengthPct: 80,
      change: -1,
      candleAt: rows[rows.length - 1].ts,
      support: 9,
      resistance: 11,
      atr: 1,
      atrPct: 1,
      volumeRatio: 1,
      indicators: {}
    })
  });
  const stale = timeframeEvidence(candles(120, 'H4', 13 * 60 * 60 * 1000), 'H4', now);
  const partial = timeframeEvidence(candles(99, 'M30', 30 * 60 * 1000), 'M30', now);
  const missing = timeframeEvidence([], 'M15', now);
  assert.equal(stale.status, 'STALE');
  assert.equal(stale.verdict, 'STALE');
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(missing.status, 'UNAVAILABLE');

  const timeframeReasons = loadFunction('paperTimeframeReasons', 'paperAlertScope');
  const reasons = timeframeReasons({
    mtfDirection: 'SHORT',
    mtf: {H4: stale, H1: {status: 'FULL', direction: 'SHORT'}, M30: partial, M15: missing}
  });
  assert.equal(reasons.find(item => item.timeframe === 'H4').reason, 'data stale');
  assert.equal(reasons.find(item => item.timeframe === 'M30').reason, 'data partial');
  assert.equal(reasons.find(item => item.timeframe === 'M15').reason, 'data unavailable');

  const requireMtf = loadFunction('paperLabRequireMtf', 'paperLabEvaluateMtf', {
    paperLabTimeframe: (pair, timeframe) => pair.mtf && pair.mtf[timeframe] && pair.mtf[timeframe].status === 'FULL'
      ? pair.mtf[timeframe] : null,
    paperLabReject: (strategyId, pair, codes, rejectReasons) => ({
      status: 'REJECTED', strategyId, sym: pair && pair.sym, codes, reasons: rejectReasons
    })
  });
  assert.equal(requireMtf({sym: 'BTC', mtfStatus: 'STALE', mtf: {}}).codes[0], 'MTF_STALE');
  assert.equal(requireMtf({sym: 'BTC', mtfStatus: 'PARTIAL', mtf: {}}).codes[0], 'MTF_INCOMPLETE');
  assert.equal(requireMtf({sym: 'BTC', mtfStatus: 'FULL', mtf: {H1: {}, M30: {}, M15: {}}}).codes[0], 'MTF_INCOMPLETE');
});

test('main scan rejects non-FULL MTF, locks overlapping scans, and idempotently skips the same cycle', () => {
  assert.match(source, /if \(pair\.mtfStatus !== 'FULL'\)\s*\{\s*paperReject\(rejected, pair,/);
  assert.match(source, /!cfg\.strategyEnabled\s*\|\|\s*!paperWithinTradingHours\(cfg\)\s*\|\|\s*paperBusy\) return;/);
  assert.match(source, /if \(paperState\.lastCycleKey === cycleKey\) return;/);
  assert.match(source, /if \(lab\.lastCycleKey === cycleKey\) return false;/);

  const scanStart = source.indexOf('async function runPaperScan(');
  const scanEnd = source.indexOf('\nasync function monitorPaperTrades(', scanStart + 1);
  assert.ok(scanStart >= 0 && scanEnd > scanStart);
  const scanBody = source.slice(scanStart, scanEnd);
  const enrichAt = scanBody.indexOf('await enrichPaperMtfBatch(mtfCandidates);');
  const gateAt = scanBody.indexOf('const entryGate = partitionSharedEntryGate(mtfCandidates);');
  const labAt = scanBody.indexOf('paperLabScan(ranked, cycleKey');
  assert.ok(enrichAt >= 0 && gateAt > enrichAt && labAt > gateAt,
    'both engines must consume the same post-MTF, entry-gated snapshot');
});
