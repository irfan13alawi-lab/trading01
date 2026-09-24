'use strict';

// Pure, paper-only pre-breakout signal engine. It deliberately returns a
// signal snapshot even when no order is allowed so the research cohort can
// measure WATCH/PRE_BREAKOUT quality without rewriting historical trades.

const DEFAULTS = {
  configVersion: 'PREBREAKOUT_RESEARCH_V1',
  watchScore: 55,
  preBreakoutScore: 70,
  confirmationScore: 70,
  max24hChangePct: 12,
  crowdedFundingAbs: 0.005,
  minVolumeRatio: 1.2,
  breakoutVolumeRatio: 1.5,
  minBreakoutDistanceAtr: 0.2,
  maxExtensionAtr: 2.5
};

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 4) {
  const number = finite(value);
  return number == null ? null : Number(number.toFixed(digits));
}

function timeframe(pair, name) {
  return pair && pair.mtf && pair.mtf[name] && pair.mtf[name].status === 'FULL'
    ? pair.mtf[name] : null;
}

function valueFrom(...values) {
  for (const value of values) {
    const number = finite(value);
    if (number != null) return number;
  }
  return null;
}

function directionFromContext(h4, h1, relativeStrength) {
  const directions = [h4 && h4.direction, h1 && h1.direction]
    .filter(value => value === 'LONG' || value === 'SHORT');
  if (directions.length && directions.every(value => value === directions[0])) return directions[0];
  if (relativeStrength != null && relativeStrength > 0) return 'LONG';
  if (relativeStrength != null && relativeStrength < 0) return 'SHORT';
  return directions[0] || 'NEUTRAL';
}

function addFeature(features, name, points, weight, value, available, evidenceText, riskText, evidence, risks) {
  features.push({name, points, weight, value: value == null ? null : round(value, 4), available});
  if (available && points > 0 && evidenceText) evidence.push(evidenceText);
  if (!available && riskText) risks.push(riskText);
}

function scoreFeatures(features) {
  const available = features.filter(item => item.available);
  const weight = available.reduce((sum, item) => sum + item.weight, 0);
  const points = available.reduce((sum, item) => sum + item.points, 0);
  return {
    score: weight > 0 ? Math.round(clamp(points / weight * 100, 0, 100)) : 0,
    coveragePct: Math.round(weight / features.reduce((sum, item) => sum + item.weight, 0) * 100),
    available: available.map(item => item.name),
    missing: features.filter(item => !item.available).map(item => item.name)
  };
}

function makeSignal(pair, options) {
  const cfg = {...DEFAULTS, ...(options || {})};
  const price = finite(pair && pair.price);
  const m15 = timeframe(pair, 'M15');
  const h1 = timeframe(pair, 'H1');
  const h4 = timeframe(pair, 'H4');
  const i = m15 && m15.indicators ? m15.indicators : {};
  const atr = valueFrom(m15 && m15.atr, i.atr);
  const rangeHigh = finite(i.rangeHigh20);
  const rangeLow = finite(i.rangeLow20);
  const rangeWidthPct = price && rangeHigh != null && rangeLow != null
    ? (rangeHigh - rangeLow) / price * 100 : null;
  const atrPct = price && atr != null ? atr / price * 100 : null;
  const volumeRatio = valueFrom(m15 && m15.volumeRatio, pair && pair.volumeRatio);
  const funding = finite(pair && pair.fund);
  const oiDelta = finite(pair && pair.oi);
  const relativeStrength = finite(pair && pair.relativeStrengthPct);
  const dataFresh = pair && ['FULL', 'PARTIAL'].includes(pair.dataQuality) &&
    ['FULL'].every(() => m15 && h1 && h4);
  const evidence = [];
  const risks = [];
  const features = [];

  const compressionAvailable = rangeWidthPct != null && atrPct != null && atrPct > 0;
  const compressionRatio = compressionAvailable ? rangeWidthPct / atrPct : null;
  const compressionPoints = compressionRatio == null ? 0
    : compressionRatio <= 8 ? 20 : compressionRatio <= 12 ? 12 : 0;
  addFeature(features, 'compression', compressionPoints, 20, compressionRatio, compressionAvailable,
    compressionPoints > 0 ? 'range 20 candle relatif terkompresi (' + round(compressionRatio, 1) + ' ATR)' : null,
    'range compression belum tersedia', evidence, risks);

  const support = finite(m15 && m15.support);
  const resistance = finite(m15 && m15.resistance);
  const supportDistance = price && support ? Math.abs(price - support) / Math.max(atr || 1e-12, 1e-12) : null;
  const resistanceDistance = price && resistance ? Math.abs(resistance - price) / Math.max(atr || 1e-12, 1e-12) : null;
  const nearSupport = supportDistance != null && supportDistance <= 1.25;
  const nearResistance = resistanceDistance != null && resistanceDistance <= 1.25;
  const supportPoints = nearSupport ? 15 : 0;
  addFeature(features, 'support_absorption', supportPoints, 15, supportDistance, support != null && atr != null,
    nearSupport ? 'harga dekat support (' + round(supportDistance, 2) + ' ATR)' : null,
    'support atau ATR belum tersedia', evidence, risks);

  const rsPoints = relativeStrength == null ? 0 : relativeStrength >= 2 ? 15 : relativeStrength > 0 ? 9 : 0;
  addFeature(features, 'relative_strength', rsPoints, 15, relativeStrength, relativeStrength != null,
    relativeStrength > 0 ? 'relative strength vs BTC +' + round(relativeStrength, 2) + '%' : null,
    'relative strength vs BTC belum tersedia', evidence, risks);

  const volumePoints = volumeRatio == null ? 0 : volumeRatio >= 2 ? 15 : volumeRatio >= cfg.minVolumeRatio ? 10 : volumeRatio >= 1 ? 5 : 0;
  addFeature(features, 'volume_flow', volumePoints, 15, volumeRatio, volumeRatio != null,
    volumeRatio >= cfg.minVolumeRatio ? 'volume ' + round(volumeRatio, 2) + 'x median' : null,
    'volume ratio belum tersedia', evidence, risks);

  const derivativesAvailable = pair && pair.fundingAvailable && pair.oiAvailable && pair.oiReady && funding != null && oiDelta != null;
  const derivativesHealthy = derivativesAvailable && Math.abs(funding) < cfg.crowdedFundingAbs && oiDelta >= -5 && oiDelta <= 5;
  const derivativesPoints = derivativesHealthy ? 15 : derivativesAvailable && Math.abs(funding) < cfg.crowdedFundingAbs * 1.5 ? 8 : 0;
  addFeature(features, 'derivatives', derivativesPoints, 15, derivativesAvailable ? oiDelta : null, derivativesAvailable,
    derivativesHealthy ? 'funding dan OI belum crowded' : null,
    'funding/OI belum memiliki data lengkap', evidence, risks);

  // News/catalyst is intentionally unavailable until a provenance-linked
  // event is attached to the pair. Never award points for missing news.
  addFeature(features, 'verified_catalyst', 0, 15, null, false, null,
    'katalis terverifikasi belum tersedia', evidence, risks);

  const roomToSupply = resistanceDistance != null && atr != null && resistanceDistance >= 1.5;
  addFeature(features, 'room_to_supply', roomToSupply ? 5 : 0, 5, resistanceDistance, resistanceDistance != null,
    roomToSupply ? 'ruang menuju supply masih cukup' : null,
    'supply/resistance belum tersedia', evidence, risks);

  const preScore = scoreFeatures(features);
  const breakout = i.breakoutRetest && typeof i.breakoutRetest === 'object' ? i.breakoutRetest : {};
  const breakoutDirection = breakout.direction === 'LONG' || breakout.direction === 'SHORT'
    ? breakout.direction : null;
  const contextDirection = directionFromContext(h4, h1, relativeStrength);
  const direction = breakoutDirection || (nearResistance && contextDirection === 'LONG' ? 'LONG'
    : nearSupport && contextDirection === 'SHORT' ? 'SHORT' : contextDirection);
  const breakoutValid = breakout.valid === true && breakoutDirection &&
    (breakout.volumeRatio == null || breakout.volumeRatio >= cfg.breakoutVolumeRatio) &&
    (breakout.distanceAtr == null || breakout.distanceAtr >= cfg.minBreakoutDistanceAtr);
  const confirmationParts = [
    {name: 'close_outside_resistance', points: breakoutValid ? 30 : 0, available: breakoutDirection != null},
    {name: 'volume_expansion', points: breakout.volumeRatio >= cfg.breakoutVolumeRatio ? 20 : 0, available: breakout.volumeRatio != null},
    {name: 'retest_holds', points: breakout.retestConfirmed === true ? 20 : 0, available: breakout.retestConfirmed != null},
    {name: 'order_flow', points: volumeRatio != null ? (volumeRatio >= cfg.breakoutVolumeRatio ? 15 : 0) : 0, available: volumeRatio != null},
    {name: 'market_context', points: direction !== 'NEUTRAL' && contextDirection === direction ? 10 : 0, available: contextDirection !== 'NEUTRAL'},
    {name: 'data_quality', points: pair && pair.dataQuality === 'FULL' ? 5 : 0, available: !!pair && pair.dataQuality != null}
  ];
  const confirmation = scoreFeatures(confirmationParts.map(item => ({...item, weight: item.name === 'close_outside_resistance' ? 30 : item.name === 'volume_expansion' ? 20 : item.name === 'retest_holds' ? 20 : item.name === 'order_flow' ? 15 : item.name === 'market_context' ? 10 : 5})));
  const extended = (Math.abs(finite(pair && pair.chg) || 0) >= cfg.max24hChangePct) ||
    (funding != null && Math.abs(funding) >= cfg.crowdedFundingAbs) ||
    (breakout.distanceAtr != null && breakout.distanceAtr >= cfg.maxExtensionAtr);
  const state = extended ? 'EXTENDED_OR_RISKY'
    : breakoutValid && confirmation.score >= cfg.confirmationScore ? 'BREAKOUT_CONFIRMED'
      : preScore.score >= cfg.preBreakoutScore ? 'PRE_BREAKOUT'
        : preScore.score >= cfg.watchScore ? 'WATCH' : 'QUIET';
  if (extended) risks.push('harga/funding sudah extended atau crowded');
  if (breakoutDirection && !breakout.retestConfirmed) risks.push('breakout belum memiliki retest yang berhasil');
  if (confirmation.missing.length) risks.push('bukti konfirmasi belum lengkap: ' + confirmation.missing.join(', '));
  if (!dataFresh) risks.push('kualitas data belum FULL');
  const invalidation = breakoutDirection === 'LONG' && rangeHigh != null
    ? 'close kembali di bawah resistance ' + round(rangeHigh)
    : breakoutDirection === 'SHORT' && rangeLow != null
      ? 'close kembali di atas support ' + round(rangeLow)
      : 'close kembali masuk ke range 20 candle';
  return {
    configVersion: cfg.configVersion,
    sym: pair && pair.sym || null,
    status: state,
    direction: direction === 'LONG' || direction === 'SHORT' ? direction : 'NEUTRAL',
    price: round(price),
    preScore: preScore.score,
    confirmationScore: confirmation.score,
    featureCoveragePct: preScore.coveragePct,
    confirmationCoveragePct: confirmation.coveragePct,
    evidence: evidence.slice(0, 5),
    risks: risks.slice(0, 3),
    invalidation,
    support: round(support),
    resistance: round(resistance),
    atr: round(atr),
    volumeRatio: round(volumeRatio, 2),
    funding: round(funding, 8),
    oiDeltaPct: round(oiDelta, 2),
    relativeStrengthPct: round(relativeStrength, 2),
    dataQuality: pair && pair.dataQuality || 'UNAVAILABLE',
    dataAt: pair && pair.dataAt || null,
    source: pair && pair.source || null,
    universeVersion: pair && pair.universeVersion || null,
    breakout: {
      valid: !!breakoutValid,
      direction: breakoutDirection,
      level: round(breakout.level),
      breakoutAt: breakout.breakoutAt || null,
      retestAt: breakout.retestAt || null,
      retestConfirmed: breakout.retestConfirmed === true,
      distanceAtr: round(breakout.distanceAtr, 2)
    },
    features,
    signalAt: new Date().toISOString()
  };
}

function buildPaperSetup(signal) {
  if (!signal || signal.status !== 'BREAKOUT_CONFIRMED' || !signal.direction || !signal.atr || !signal.breakout.level) return null;
  const entry = signal.breakout.level;
  const risk = signal.atr * 0.8;
  const sl = signal.direction === 'LONG' ? entry - risk : entry + risk;
  return {
    dir: signal.direction,
    entry,
    sl,
    tp1: signal.direction === 'LONG' ? entry + risk * 2 : entry - risk * 2,
    tp2: signal.direction === 'LONG' ? entry + risk * 3 : entry - risk * 3,
    atr: signal.atr,
    structureSupport: signal.direction === 'LONG' ? entry : null,
    structureResistance: signal.direction === 'SHORT' ? entry : null
  };
}

module.exports = {makeSignal, buildPaperSetup, DEFAULTS};
