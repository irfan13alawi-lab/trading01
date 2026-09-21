'use strict';

const DEFAULT_UNIVERSE_LIMIT = 60;
const DEFAULT_MIN_QUOTE_VOLUME_USDT = 1_000_000;
const DEFAULT_MAX_TICKER_AGE_MS = 180_000;
const DEFAULT_MAX_FUTURE_SKEW_MS = 30_000;
const UNIVERSE_VERSION = 'LIQUID_TOP60_CRYPTO_V1';

const STABLE_BASES = new Set([
  'USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'DAI', 'USDE', 'USDS', 'USDP',
  'USDD', 'USD1', 'USD0', 'PYUSD', 'GUSD', 'LUSD', 'UST', 'USTC', 'EURC',
  'EURT', 'EURS', 'XAUT'
]);

const WRAPPED_OR_STAKED_BASES = new Set([
  'WBTC', 'WETH', 'WBNB', 'WMATIC', 'WFTM', 'WAVAX', 'WTRX', 'WSOL',
  'STETH', 'WSTETH', 'RETH', 'CBETH', 'WBETH', 'BETH', 'SFRXETH', 'ANKRETH',
  'METH', 'SWETH', 'OSETH', 'RSETH', 'SETH2', 'MSOL', 'JITOSOL', 'BSOL', 'JUPSOL'
]);

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeBaseSymbol(value) {
  let symbol = String(value == null ? '' : value).trim().toUpperCase();
  if (!symbol) return '';
  symbol = symbol
    .replace(/(?:_UMCBL|_DMCBL|_CMCBL)$/i, '')
    .replace(/:USDT$/i, '');
  const swap = symbol.match(/^([A-Z0-9]{2,15})-USDT-SWAP$/);
  if (swap) return swap[1];
  const delimited = symbol.match(/^([A-Z0-9]{2,15})[-_/]USDT(?:[-_/].*)?$/);
  if (delimited) return delimited[1];
  const compact = symbol.match(/^([A-Z0-9]{2,15})USDT$/);
  if (compact) return compact[1];
  if (/^[A-Z0-9]{2,15}$/.test(symbol)) return symbol;
  return '';
}

function isEligibleBaseSymbol(value) {
  const base = normalizeBaseSymbol(value);
  if (!base || !/^[A-Z0-9]{2,15}$/.test(base)) return false;
  if (STABLE_BASES.has(base) || WRAPPED_OR_STAKED_BASES.has(base)) return false;
  if (/(?:UP|DOWN|BULL|BEAR|[2-5][LS])$/.test(base)) return false;
  return true;
}

function isUsdtPerpetualTicker(row) {
  if (!row || typeof row !== 'object') return false;
  const raw = String(row.symbol || row.instId || '').trim().toUpperCase();
  const recognized = /^(?:[A-Z0-9]{2,15}USDT(?:_(?:UMCBL|DMCBL|CMCBL))?|[A-Z0-9]{2,15}-USDT-SWAP)$/.test(raw);
  if (!recognized) return false;
  const quote = String(row.quoteCoin || row.quoteAsset || row.settleCcy || '').toUpperCase();
  if (quote && quote !== 'USDT') return false;
  const symbolType = String(row.symbolType || row.contractType || row.ctType || '').toLowerCase();
  if (symbolType && !['perpetual', 'perpetual_swap', 'linear'].includes(symbolType)) return false;
  if (/(_DMCBL|_CMCBL)$/.test(raw)) return false;
  return true;
}

function parseTimestampMs(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function tickerTimestamp(row) {
  return parseTimestampMs(row && (row.ts || row.timestamp || row.closeTime || row.time || row.t));
}

function tickerPrice(row) {
  for (const key of ['lastPr', 'last', 'lastPrice', 'close', 'markPrice']) {
    const value = finitePositive(row && row[key]);
    if (value) return value;
  }
  return null;
}

function sharedEntryGateRejectionCodes(candidate) {
  const item = candidate && typeof candidate === 'object' ? candidate : {};
  const reasons = [];
  const funding = Number(item.fund);
  const change24h = Number(item.chg);
  const volume = Number(item.volume);
  const price = Number(item.price);
  // Keep these thresholds identical to the existing shared entry gate in
  // server.js. The gate is now evaluated after MTF so scan coverage is honest;
  // it still decides whether a candidate can reach either paper ledger.
  if (Number.isFinite(funding) && funding >= 0.005) reasons.push('FUNDING_ABOVE_LIMIT');
  if (!Number.isFinite(change24h) || Math.abs(change24h) > 3.5) reasons.push('EXTREME_24H_CHANGE');
  if (!Number.isFinite(volume) || volume <= 0) reasons.push('MISSING_VOLUME');
  if (!Number.isFinite(price) || price <= 0) reasons.push('INVALID_PRICE');
  return reasons;
}

function partitionSharedEntryGate(candidates) {
  const passed = [];
  const rejected = [];
  const rejectionCounts = Object.create(null);
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const codes = sharedEntryGateRejectionCodes(candidate);
    if (!codes.length) {
      passed.push(candidate);
      continue;
    }
    rejected.push({candidate, codes});
    for (const code of codes) rejectionCounts[code] = (rejectionCounts[code] || 0) + 1;
  }
  return {passed, rejected, rejectionCounts: {...rejectionCounts}};
}

function tickerQuoteVolume(row) {
  for (const key of ['quoteVolume', 'usdtVolume', 'quoteVolume24h', 'quoteTurnover24h', '_nexoraQuoteVolume']) {
    const value = finitePositive(row && row[key]);
    if (value) return value;
  }
  return null;
}

function activeSymbolSet(value) {
  if (value == null) return null;
  const out = new Set();
  if (value instanceof Set || Array.isArray(value)) {
    for (const item of value) {
      const base = normalizeBaseSymbol(typeof item === 'string' ? item : item && (item.symbol || item.instId));
      if (base) out.add(base);
    }
    return out;
  }
  if (value instanceof Map) {
    for (const [symbol, info] of value.entries()) {
      if (info && info.active === true) {
        const base = normalizeBaseSymbol(symbol);
        if (base) out.add(base);
      }
    }
    return out;
  }
  return null;
}

// Bitget marks RWA instruments with isRwa=YES. Only active contracts positively
// classified as non-RWA are allowed into the crypto universe; missing or
// unfamiliar metadata must never be interpreted as crypto.
function confirmedCryptoSymbolSet(value) {
  if (value == null) return null;
  const out = new Set();
  if (value instanceof Map) {
    for (const [symbol, info] of value.entries()) {
      if (info && info.active === true && String(info.isRwa || '').trim().toUpperCase() === 'NO') {
        const base = normalizeBaseSymbol(symbol);
        if (base) out.add(base);
      }
    }
    return out;
  }
  if (value instanceof Set || Array.isArray(value)) {
    for (const item of value) {
      const base = normalizeBaseSymbol(typeof item === 'string' ? item : item && (item.symbol || item.instId));
      if (base) out.add(base);
    }
    return out;
  }
  return null;
}

function selectLiquidUniverse(rows, options) {
  const cfg = options || {};
  const now = Number.isFinite(Number(cfg.now)) ? Number(cfg.now) : Date.now();
  const limit = Math.max(1, Math.min(DEFAULT_UNIVERSE_LIMIT,
    Math.floor(Number.isFinite(Number(cfg.limit)) ? Number(cfg.limit) : DEFAULT_UNIVERSE_LIMIT)));
  const minQuoteVolume = Math.max(0,
    Number.isFinite(Number(cfg.minQuoteVolumeUsdt)) ? Number(cfg.minQuoteVolumeUsdt) : DEFAULT_MIN_QUOTE_VOLUME_USDT);
  const maxAgeMs = Math.max(1,
    Number.isFinite(Number(cfg.maxTickerAgeMs)) ? Number(cfg.maxTickerAgeMs) : DEFAULT_MAX_TICKER_AGE_MS);
  const maxFutureSkewMs = Math.max(0,
    Number.isFinite(Number(cfg.maxFutureSkewMs)) ? Number(cfg.maxFutureSkewMs) : DEFAULT_MAX_FUTURE_SKEW_MS);
  const actives = activeSymbolSet(cfg.activeSymbols);
  const cryptoSymbols = confirmedCryptoSymbolSet(cfg.cryptoSymbols);
  const rejectionCounts = Object.create(null);
  const reject = reason => { rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1; };
  const unique = new Map();
  const input = Array.isArray(rows) ? rows : [];

  for (const row of input) {
    if (!isUsdtPerpetualTicker(row)) { reject('NOT_USDT_PERPETUAL'); continue; }
    const base = normalizeBaseSymbol(row.symbol || row.instId);
    if (!isEligibleBaseSymbol(base)) { reject('EXCLUDED_BASE_ASSET'); continue; }
    if (actives == null) { reject('ACTIVE_METADATA_UNAVAILABLE'); continue; }
    if (!actives.has(base)) { reject('CONTRACT_NOT_ACTIVE'); continue; }
    if (cryptoSymbols == null) { reject('CRYPTO_CLASSIFICATION_UNAVAILABLE'); continue; }
    if (!cryptoSymbols.has(base)) { reject('NOT_CONFIRMED_CRYPTO'); continue; }
    const price = tickerPrice(row);
    if (!price) { reject('INVALID_PRICE'); continue; }
    const quoteVolume = tickerQuoteVolume(row);
    if (!quoteVolume) { reject('QUOTE_VOLUME_UNAVAILABLE'); continue; }
    if (quoteVolume < minQuoteVolume) { reject('QUOTE_VOLUME_BELOW_MIN'); continue; }
    const timestamp = tickerTimestamp(row);
    if (!timestamp) { reject('TICKER_TIMESTAMP_UNAVAILABLE'); continue; }
    if (timestamp > now + maxFutureSkewMs) { reject('TICKER_TIMESTAMP_FUTURE'); continue; }
    if (now - timestamp > maxAgeMs) { reject('TICKER_STALE'); continue; }

    const candidate = {
      row,
      base,
      price,
      quoteVolume,
      timestamp
    };
    const previous = unique.get(base);
    if (previous) {
      reject('DUPLICATE_SYMBOL');
      if (candidate.timestamp > previous.timestamp ||
          (candidate.timestamp === previous.timestamp && candidate.quoteVolume > previous.quoteVolume)) {
        unique.set(base, candidate);
      }
    } else {
      unique.set(base, candidate);
    }
  }

  const eligible = [...unique.values()].sort((a, b) =>
    b.quoteVolume - a.quoteVolume || a.base.localeCompare(b.base));
  const chosen = eligible.slice(0, limit);
  const selectedRows = chosen.map(item => ({
    ...item.row,
    _nexoraBaseSymbol: item.base,
    _nexoraQuoteVolume: item.quoteVolume,
    _nexoraTickerAt: new Date(item.timestamp).toISOString(),
    _nexoraUniverseVersion: UNIVERSE_VERSION
  }));

  return {
    version: UNIVERSE_VERSION,
    assetScope: 'CRYPTO_ONLY_IS_RWA_NO',
    target: limit,
    minQuoteVolumeUsdt: minQuoteVolume,
    maxTickerAgeMs: maxAgeMs,
    rawTickerCount: input.length,
    cryptoMetadataCount: cryptoSymbols ? cryptoSymbols.size : 0,
    eligibleCount: eligible.length,
    selectedCount: selectedRows.length,
    selectedSymbols: chosen.map(item => item.base),
    selectedRows,
    rejectionCounts: {...rejectionCounts},
    freshAt: new Date(now).toISOString()
  };
}

module.exports = {
  DEFAULT_UNIVERSE_LIMIT,
  DEFAULT_MIN_QUOTE_VOLUME_USDT,
  DEFAULT_MAX_TICKER_AGE_MS,
  DEFAULT_MAX_FUTURE_SKEW_MS,
  UNIVERSE_VERSION,
  normalizeBaseSymbol,
  confirmedCryptoSymbolSet,
  isEligibleBaseSymbol,
  isUsdtPerpetualTicker,
  parseTimestampMs,
  tickerPrice,
  sharedEntryGateRejectionCodes,
  partitionSharedEntryGate,
  selectLiquidUniverse
};
