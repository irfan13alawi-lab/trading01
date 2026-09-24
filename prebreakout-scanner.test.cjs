const test = require('node:test');
const assert = require('node:assert/strict');
const {makeSignal, buildPaperSetup} = require('./prebreakout-scanner.cjs');

function full(direction, indicators = {}) {
  return {status: 'FULL', direction, indicators};
}

test('confirmed pre-breakout creates a paper setup only after retest', () => {
  const pair = {
    sym: 'TEST', price: 110, chg: 1, dataQuality: 'FULL',
    fund: 0.0001, fundingAvailable: true, oi: 2, oiAvailable: true, oiReady: true,
    volumeRatio: 2,
    mtf: {
      H4: full('LONG'), H1: full('LONG'), M30: full('LONG'),
      M15: full('LONG', {
        atr: 2, support: 90, resistance: 100, volumeRatio: 2,
        rangeHigh20: 100, rangeLow20: 90,
        breakoutRetest: {
          valid: true, direction: 'LONG', level: 100, retestConfirmed: true,
          distanceAtr: 1, volumeRatio: 2,
          breakoutAt: '2026-09-25T00:00:00.000Z',
          retestAt: '2026-09-25T00:15:00.000Z'
        }
      })
    }
  };
  const signal = makeSignal(pair);
  assert.equal(signal.status, 'BREAKOUT_CONFIRMED');
  assert.equal(signal.direction, 'LONG');
  assert.ok(signal.confirmationScore >= 70);
  const setup = buildPaperSetup(signal);
  assert.equal(setup.dir, 'LONG');
  assert.ok(setup.tp2 > setup.tp1 && setup.tp1 > setup.entry);
});

test('pre-breakout does not confirm without a successful retest', () => {
  const pair = {
    sym: 'TEST', price: 101, chg: 1, dataQuality: 'FULL',
    fund: 0.0001, fundingAvailable: true, oi: 2, oiAvailable: true, oiReady: true,
    volumeRatio: 2,
    mtf: {
      H4: full('LONG'), H1: full('LONG'), M30: full('LONG'),
      M15: full('LONG', {
        atr: 2, support: 90, resistance: 100, volumeRatio: 2,
        rangeHigh20: 100, rangeLow20: 90,
        breakoutRetest: {valid: false, direction: 'LONG', level: 100, retestConfirmed: false, distanceAtr: 1, volumeRatio: 2}
      })
    }
  };
  const signal = makeSignal(pair);
  assert.notEqual(signal.status, 'BREAKOUT_CONFIRMED');
  assert.equal(buildPaperSetup(signal), null);
});
