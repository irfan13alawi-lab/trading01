const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 18085);
const REQUEST_TIMEOUT_MS = 12000;
const PAPER_INTERVAL_MS = 15 * 60 * 1000;
const PAPER_SCAN_CHECK_MS = 15000;
const PAPER_MONITOR_MS = 30000;
const PAPER_PENDING_TTL_MS = 120 * 60 * 1000;
const PAPER_PER_SCAN = 3;
const PAPER_MAX_ACTIVE = Math.max(3, Math.min(100,
  Number.isFinite(Number(process.env.PAPER_MAX_ACTIVE))
    ? Number(process.env.PAPER_MAX_ACTIVE) : 30));
const PAPER_MAX_PER_SYMBOL = Math.max(1, Math.min(3,
  Number.isFinite(Number(process.env.PAPER_MAX_PER_SYMBOL))
    ? Number(process.env.PAPER_MAX_PER_SYMBOL) : 1));
const PAPER_MIN_ENTRY_OFFSET_PCT = Math.max(0.05, Math.min(2,
  Number.isFinite(Number(process.env.PAPER_MIN_ENTRY_OFFSET_PCT))
    ? Number(process.env.PAPER_MIN_ENTRY_OFFSET_PCT) : 0.1));
const PAPER_MIN_RR = Math.max(1.5, Math.min(5,
  Number.isFinite(Number(process.env.PAPER_MIN_RR))
    ? Number(process.env.PAPER_MIN_RR) : 2));
const PAPER_SCHEMA_VERSION = 2;
// Keep the one-week paper sample from becoming a highly leveraged simulation:
// each new order risks 0.5% of current equity and all active orders together
// may reserve at most 15%. Existing legacy trades keep their recorded sizing.
const PAPER_RISK_PCT = Math.max(0.1, Math.min(2,
  Number.isFinite(Number(process.env.PAPER_RISK_PCT))
    ? Number(process.env.PAPER_RISK_PCT) : 0.5));
const PAPER_MAX_ACTIVE_RISK_PCT = Math.max(5, Math.min(50,
  Number.isFinite(Number(process.env.PAPER_MAX_ACTIVE_RISK_PCT))
    ? Number(process.env.PAPER_MAX_ACTIVE_RISK_PCT) : 15));
// Keep enough server history for a normal one-week paper trial. The status
// endpoint remains lightweight; /paper/history serves the full retained set.
const PAPER_MAX_CLOSED_TRADES = 5000;
const PAPER_MAX_RECENT_SCANS = 1000;
const PAPER_STARTING_EQUITY = Number(process.env.PAPER_STARTING_EQUITY || 285);
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const TELEGRAM_ALERTS_ENABLED = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
const PAPER_STATE_FILE = process.env.PAPER_STATE_FILE ||
  path.join(__dirname, 'paper-bot-state.json');
const PAPER_STATE_BACKUP_FILE = PAPER_STATE_FILE + '.bak';
let fetchFn = globalThis.fetch;
try {
  // The VPS already uses node-fetch; prefer it when present because some
  // networks replace upstream TLS certificates for Node's native fetch.
  fetchFn = require('node-fetch');
} catch (_) {}
if (!fetchFn) throw new Error('Node 18+ or node-fetch is required');

const APIS = {
  '/bitget': 'https://api.bitget.com',
  '/bingx': 'https://open-api.bingx.com',
  '/gate': 'https://api.gateio.ws',
  '/altme': 'https://api.alternative.me',
  '/coingecko': 'https://api.coingecko.com',
  '/coinpaprika': 'https://api.coinpaprika.com'
};

const sourceHealth = {};
Object.keys(APIS).forEach(prefix => {
  sourceHealth[prefix.slice(1)] = {
    status: 'UNKNOWN', lastAttemptAt: null, lastOkAt: null,
    lastErrorAt: null, lastLatencyMs: null, lastHttpStatus: null,
    lastPath: null, lastError: null
  };
});

const telegramState = {
  sent: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null
};
const alertCooldowns = new Map();

const cache = new Map();
const prefixes = Object.keys(APIS).sort((a, b) => b.length - a.length);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function send(res, status, body, contentType) {
  res.writeHead(status, {...corsHeaders(), 'Content-Type': contentType || 'application/json'});
  res.end(body);
}

function markSourceHealth(prefix, result) {
  const item = sourceHealth[prefix.slice(1)];
  if (!item) return;
  const now = new Date().toISOString();
  item.lastAttemptAt = now;
  item.lastLatencyMs = result.latencyMs;
  item.lastHttpStatus = result.status;
  item.lastPath = result.path || null;
  if (result.status >= 200 && result.status < 300) {
    item.status = 'LIVE';
    item.lastOkAt = now;
    item.lastError = null;
  } else {
    item.status = 'ERROR';
    item.lastErrorAt = now;
    item.lastError = 'HTTP ' + result.status;
  }
}

function markSourceError(prefix, error, pathName) {
  const item = sourceHealth[prefix.slice(1)];
  if (!item) return;
  const now = new Date().toISOString();
  item.status = 'ERROR';
  item.lastAttemptAt = now;
  item.lastErrorAt = now;
  item.lastPath = pathName || null;
  item.lastError = error.message;
}

function sourceHealthView() {
  const now = Date.now();
  return Object.fromEntries(Object.entries(sourceHealth).map(([name, item]) => {
    const lastOkMs = item.lastOkAt ? Date.parse(item.lastOkAt) : NaN;
    const ageSec = Number.isFinite(lastOkMs)
      ? Math.max(0, Math.round((now - lastOkMs) / 1000)) : null;
    return [name, {
      ...item,
      ageSec,
      displayStatus: item.status === 'LIVE' && ageSec != null && ageSec > 180
        ? 'DELAYED' : item.status
    }];
  }));
}

function cacheTtl(prefix, pathname) {
  if (prefix === '/coingecko') {
    return pathname.includes('/ohlc') || pathname.includes('/market_chart') ? 300000 : 30000;
  }
  if (pathname.includes('/candles')) return 60000;
  if (pathname.includes('/tickers')) return 5000;
  return 5000;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestUpstream(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchFn(url, {
        method: 'GET',
        headers: {'User-Agent': 'NexoraProxy/1.0', 'Accept': 'application/json'},
        signal: controller.signal
      });
      const body = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) {
        return {
          status: response.status,
          body,
          contentType: response.headers.get('content-type') || 'application/json'
        };
      }
      await sleep(350 * (attempt + 1));
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(350 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Upstream request failed');
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_ALERTS_ENABLED || !text) return false;
  telegramState.lastAttemptAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const target = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
  try {
    const response = await fetchFn(target, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'User-Agent': 'NexoraPaperBot/1.0'},
      body: JSON.stringify({chat_id: TELEGRAM_CHAT_ID, text}),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) throw new Error('Telegram HTTP ' + response.status);
    let payload;
    try { payload = JSON.parse(body); } catch (_) { payload = null; }
    if (!payload || payload.ok !== true) throw new Error('Telegram response invalid');
    telegramState.sent += 1;
    telegramState.lastSuccessAt = new Date().toISOString();
    telegramState.lastError = null;
    return true;
  } catch (error) {
    telegramState.lastErrorAt = new Date().toISOString();
    telegramState.lastError = error.message;
    console.error('[paper] Telegram alert failed:', error.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sendRateLimitedAlert(key, text, cooldownMs) {
  const now = Date.now();
  const last = alertCooldowns.get(key) || 0;
  if (now - last < cooldownMs) return;
  alertCooldowns.set(key, now);
  void sendTelegramMessage(text);
}

function paperScanAlert(cycleKey, placed) {
  return 'NEXORA PAPER SCAN ' + cycleKey + '\n' +
    (placed.length ? placed.map(trade =>
      trade.sym + ' ' + trade.dir + ' PENDING @ ' + trade.entryLimit +
      ' | SL ' + trade.sl + ' | TP1 ' + trade.tp1
    ).join('\n') : 'Tidak ada setup baru');
}

function paperFillAlert(trade) {
  return 'NEXORA PAPER LIMIT FILLED\n' +
    trade.sym + ' ' + trade.dir + ' @ ' + trade.entryActual +
    '\nSL ' + trade.sl + ' | TP1 ' + trade.tp1;
}

function paperCloseAlert(trade) {
  return 'NEXORA PAPER ' + (trade.outcome || 'CLOSED') + '\n' +
    trade.sym + ' ' + trade.dir + ' exit @ ' + trade.exitPrice +
    '\nR: ' + trade.r + ' | PnL: $' + trade.pnl +
    '\n' + (trade.closeReason || '');
}

function paperCapacityAlert(status) {
  return 'NEXORA PAPER BOT GUARD\n' +
    'Order baru ditahan: ' + (status.blockReason || 'capacity/risk guard') + '\n' +
    'Strict active: ' + status.strictActiveCount + '/' + status.maxConcurrent +
    ' | Legacy active: ' + status.legacyActiveCount + '\n' +
    'Risk: $' + status.activeRisk + ' / $' + status.riskBudget;
}

// ---------------------------------------------------------------------------
// VPS PAPER BOT
// This is simulation only: it never calls an exchange order endpoint.
// The state is persisted so the one-week observation continues after the
// browser is closed and survives a normal Node/systemd restart.
// ---------------------------------------------------------------------------
const PAPER_SYMBOLS = [
  'BTC','ETH','SOL','BNB','XRP','ADA','DOT','AVAX','LINK','NEAR',
  'ATOM','DOGE','UNI','AAVE','APT','ARB','OP','INJ','TIA','SUI',
  'SEI','PEPE','WIF','FET','RNDR','WLD','PENDLE','ENA','STX','CRV',
  'LDO','TAO','GRT','FLOKI','BONK','SHIB','TRX','MATIC','LTC','SNX'
];

function paperNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function paperExecutionModel(trade) {
  return trade && trade.executionModel === 'LIMIT_STRICT'
    ? 'LIMIT_STRICT' : 'LEGACY_TOLERANCE';
}

function isStrictPaperTrade(trade) {
  return paperExecutionModel(trade) === 'LIMIT_STRICT';
}

function normalisePaperTrade(trade) {
  const next = {...trade};
  next.executionModel = paperExecutionModel(next);
  next.executionClass = isStrictPaperTrade(next) ? 'STRICT' : 'LEGACY';
  next.timeframe = next.timeframe || next.tf || '15M';
  next.tf = next.tf || next.timeframe;
  if (!Array.isArray(next.signalReasons)) next.signalReasons = [];
  return next;
}

function paperCycleKey(timestamp) {
  const d = new Date(timestamp);
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0') + 'T' +
    String(d.getUTCHours()).padStart(2, '0') + ':' +
    String(Math.floor(d.getUTCMinutes() / 15) * 15).padStart(2, '0') + 'Z';
}

function paperNextQuarter(timestamp) {
  return Math.ceil((timestamp + 1) / PAPER_INTERVAL_MS) * PAPER_INTERVAL_MS;
}

function paperRoundPrice(value) {
  const absolute = Math.abs(value);
  const decimals = absolute >= 1000 ? 3
    : absolute >= 1 ? 4
    : absolute >= 0.01 ? 5
    : absolute >= 0.0001 ? 7 : 10;
  return Number(value.toFixed(decimals));
}

function defaultPaperState() {
  return {
    schemaVersion: PAPER_SCHEMA_VERSION,
    enabled: true,
    startingEquity: PAPER_STARTING_EQUITY,
    startedAt: new Date().toISOString(),
    lastScanAt: null,
    lastCycleKey: null,
    lastMonitorAt: null,
    lastPriceAt: null,
    lastError: null,
    lastBlockReason: null,
    lastSavedAt: null,
    nextId: 0,
    oiSnapshot: {},
    activeTrades: [],
    closedTrades: [],
    invalidatedTrades: [],
    recentScans: []
  };
}

let paperRecoveredFromBackup = false;

function loadPaperState() {
  let parsed;
  let usedBackup = false;
  try {
    parsed = JSON.parse(fs.readFileSync(PAPER_STATE_FILE, 'utf8'));
  } catch (_) {
    try {
      parsed = JSON.parse(fs.readFileSync(PAPER_STATE_BACKUP_FILE, 'utf8'));
      usedBackup = true;
      paperRecoveredFromBackup = true;
      console.error('[paper] main state unreadable; recovered from backup');
    } catch (_) {
      return defaultPaperState();
    }
  }
  try {
    const state = {
      ...defaultPaperState(),
      ...parsed,
      oiSnapshot: parsed.oiSnapshot || {},
      activeTrades: Array.isArray(parsed.activeTrades) ? parsed.activeTrades.map(normalisePaperTrade) : [],
      closedTrades: Array.isArray(parsed.closedTrades) ? parsed.closedTrades.map(normalisePaperTrade) : [],
      invalidatedTrades: Array.isArray(parsed.invalidatedTrades) ? parsed.invalidatedTrades : [],
      recentScans: Array.isArray(parsed.recentScans) ? parsed.recentScans : [],
      schemaVersion: PAPER_SCHEMA_VERSION
    };
    if (usedBackup) state._needsSave = true;
    // Exclude historical trades from the first worker version. Their stop
    // side was reversed, so counting them would corrupt the one-week trial.
    const invalidatedIds = new Set(state.invalidatedTrades.map(trade => trade.id));
    const invalid = state.closedTrades.filter(trade => {
      const entry = paperNumber(trade.entryLimit);
      const sl = paperNumber(trade.sl);
      if (!entry || !sl || !trade.dir) return false;
      return trade.dir === 'SHORT' ? sl <= entry : sl >= entry;
    });
    if (invalid.length) {
      const newlyInvalid = invalid.filter(trade => !invalidatedIds.has(trade.id));
      state.invalidatedTrades = newlyInvalid.concat(state.invalidatedTrades).slice(0, 100);
      state.closedTrades = state.closedTrades.filter(trade => invalid.indexOf(trade) < 0);
      state._needsSave = true;
    }
    // Repair paper orders created by the first worker version, which had the
    // stop side reversed for SHORT and LONG orders. Also repair tiny-price
    // pending limits that were rounded to the wrong side of the market by the
    // old decimal rules (notably SHIB-like symbols).
    let repairedActive = false;
    state.activeTrades.forEach(trade => {
      const entry = paperNumber(trade.entryLimit);
      if (!entry || !trade.dir) return;
      let limitEntry = entry;
      const referencePrice = paperNumber(trade.currentPrice);
      if (trade.status === 'PENDING' && referencePrice > 0) {
        const wrongSide = trade.dir === 'LONG'
          ? limitEntry >= referencePrice
          : limitEntry <= referencePrice;
        if (wrongSide) {
          limitEntry = paperRoundPrice(referencePrice *
            (trade.dir === 'LONG' ? 0.997 : 1.003));
          if (limitEntry !== trade.entryLimit) {
            trade.entryLimit = limitEntry;
            repairedActive = true;
          }
        }
      }
      const bracketEntry = trade.status === 'OPEN' && paperNumber(trade.entryActual) > 0
        ? paperRoundPrice(trade.entryActual) : limitEntry;
      if (trade.status === 'OPEN' && bracketEntry !== trade.entryActual) {
        trade.entryActual = bracketEntry;
        repairedActive = true;
      }
      const sl = paperRoundPrice(bracketEntry * (trade.dir === 'LONG' ? 0.97 : 1.03));
      const tp1 = paperRoundPrice(bracketEntry * (trade.dir === 'LONG' ? 1.06 : 0.94));
      const tp2 = paperRoundPrice(bracketEntry * (trade.dir === 'LONG' ? 1.10 : 0.90));
      if (trade.sl !== sl || trade.tp1 !== tp1 || trade.tp2 !== tp2) {
        trade.sl = sl;
        trade.tp1 = tp1;
        trade.tp2 = tp2;
        repairedActive = true;
      }
    });
    if (repairedActive) state._needsSave = true;
    return state;
  } catch (_) {
    return defaultPaperState();
  }
}

let paperState = loadPaperState();
let paperBusy = false;
let paperStarted = false;
if (paperState._needsSave) {
  delete paperState._needsSave;
  savePaperState();
}

function savePaperState() {
  const tempFile = PAPER_STATE_FILE + '.tmp';
  try {
    const nextState = {
      ...paperState,
      schemaVersion: PAPER_SCHEMA_VERSION,
      lastSavedAt: new Date().toISOString()
    };
    fs.writeFileSync(tempFile, JSON.stringify(nextState, null, 2));
    if (fs.existsSync(PAPER_STATE_FILE) && !paperRecoveredFromBackup) {
      try { fs.copyFileSync(PAPER_STATE_FILE, PAPER_STATE_BACKUP_FILE); } catch (_) {}
    }
    fs.renameSync(tempFile, PAPER_STATE_FILE);
    paperState.lastSavedAt = nextState.lastSavedAt;
    paperRecoveredFromBackup = false;
  } catch (error) {
    console.error('[paper] state save failed:', error.message);
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
  }
}

function paperScoreDetails(changePct, funding, oiDeltaPct, hasOi, volumeRatio) {
  // Small positive funding is neutral, not strong confirmation. This keeps
  // the rank from giving almost every mildly red coin the same score.
  const fundingScore = funding <= -0.0005 ? 2.5
    : funding < 0 ? 1.8
    : funding <= 0.0005 ? 1.0
    : funding < 0.002 ? 0.7
    : funding < 0.004 ? 0.4
    : funding < 0.006 ? 0.2 : 0;
  const priceScore = changePct >= -2 && changePct < -1 ? 2.5
    : changePct >= -1 && changePct <= 0 ? 2.0
    : changePct > 0 && changePct <= 1 ? 1.5
    : changePct > 1 && changePct <= 3 ? 1.2
    : changePct > 3 && changePct <= 5 ? 0.8
    : changePct > 5 && changePct <= 8 ? 0.4 : 0;
  let oiScore = oiDeltaPct > 2 ? 2.0
    : oiDeltaPct > 0 ? 1.5
    : oiDeltaPct >= -1 ? 0.5 : 0;
  if (hasOi && oiDeltaPct > 1) oiScore = Math.min(2.0, oiScore + 0.3);
  const volumeScore = Number.isFinite(volumeRatio)
    ? (volumeRatio >= 2 ? 1.0 : volumeRatio >= 1.5 ? 0.7 : volumeRatio >= 1 ? 0.3 : 0)
    : 0;
  return {
    base: 3,
    funding: fundingScore,
    price: priceScore,
    oi: oiScore,
    volume: volumeScore,
    total: Math.min(12, Number((fundingScore + priceScore + oiScore + volumeScore + 3).toFixed(1)))
  };
}

function paperScore(changePct, funding, oiDeltaPct, hasOi, volumeRatio) {
  return paperScoreDetails(changePct, funding, oiDeltaPct, hasOi, volumeRatio).total;
}

function paperTier(score) {
  return score >= 8 ? 'A' : score >= 6.5 ? 'B' : 'C';
}

function paperSignal(changePct, oiDeltaPct, funding) {
  if (changePct > 5 && oiDeltaPct > 0) return 'PUMP';
  if (changePct > 1.5 && oiDeltaPct > 0 && funding < 0.01) return 'BUY';
  if (changePct < -3 && oiDeltaPct < 0) return 'SELL';
  return 'NEU';
}

function paperTickerSymbol(row) {
  return String(row.symbol || '').replace(/[_-]?USDT$/i, '').toUpperCase();
}

function buildPaperPairs(payload) {
  const rows = Array.isArray(payload && payload.data) ? payload.data : [];
  const dataAt = payload && payload._nexoraFetchedAt || new Date().toISOString();
  const pairs = {};
  rows.forEach(row => {
    const sym = paperTickerSymbol(row);
    if (!sym || PAPER_SYMBOLS.indexOf(sym) < 0) return;
    const price = paperNumber(row.lastPr || row.last || row.close || row.markPrice);
    if (!price) return;
    const chg = row.change24h != null
      ? paperNumber(row.change24h) * 100
      : paperNumber(row.priceChangePercent);
    const fund = paperNumber(row.fundingRate || row.fundingRate24h);
    const oiUnits = paperNumber(row.holdingAmount || row.openInterest);
    const oiUsd = oiUnits * price;
    const previousOi = paperNumber(paperState.oiSnapshot[sym]);
    const oi = previousOi > 0 ? ((oiUsd - previousOi) / previousOi) * 100 : 0;
    paperState.oiSnapshot[sym] = oiUsd;
    const sc = paperScore(chg, fund, oi, previousOi > 0);
    const pair = {
      sym, price, chg,
      volume: paperNumber(row.quoteVolume || row.usdtVolume || row.quoteVolume24h),
      fund, oi, oiUSD: oiUsd, oiReady: previousOi > 0, sc: 0,
      tier: 'C', sig: paperSignal(chg, oi, fund), dataQuality: previousOi > 0 ? 'FULL' : 'PARTIAL',
      dataAt, source: 'Bitget Futures'
    };
    pairs[sym] = pair;
  });
  const volumes = Object.values(pairs).map(pair => pair.volume).filter(value => value > 0).sort((a, b) => a - b);
  const medianVolume = volumes.length ? volumes[Math.floor(volumes.length / 2)] : 0;
  return Object.values(pairs).map(pair => {
    pair.volumeRatio = medianVolume > 0 && pair.volume > 0
      ? Number((pair.volume / medianVolume).toFixed(2)) : null;
    pair.scoreBreakdown = paperScoreDetails(pair.chg, pair.fund, pair.oi, pair.oiReady, pair.volumeRatio);
    pair.sc = pair.scoreBreakdown.total;
    pair.tier = paperTier(pair.sc);
    if (pair.tier === 'C' || pair.fund >= 0.005 ||
        Math.abs(pair.chg) > 3.5 || pair.sc < 7 || pair.volume <= 0 || pair.price <= 0) return null;
    let rank = pair.sc * 0.4;
    const fundingBonus = pair.fund <= -0.0005 ? 3
      : pair.fund < 0 ? 2
      : pair.fund <= 0.0005 ? 1 : 0;
    rank += fundingBonus * 0.3;
    rank += (pair.sig === 'BUY' ? 2 : pair.sig === 'PUMP' ? 1.5 : 0) * 0.2;
    rank += (pair.tier === 'A' ? 2 : pair.tier === 'B' ? 1 : 0) * 0.1;
    if (Math.abs(pair.chg) <= 2) rank += 0.5;
    if (pair.oi > 0) rank += 0.3;
    if (pair.volumeRatio != null) {
      rank += (pair.volumeRatio >= 2 ? 0.4
        : pair.volumeRatio >= 1.5 ? 0.25
        : pair.volumeRatio >= 1 ? 0.1 : 0);
    }
    pair.rank = Number(rank.toFixed(3));
    return pair;
  }).filter(Boolean).sort((a, b) => b.rank - a.rank);
}

function paperSetup(pair) {
  const dir = pair.chg < 0 ? 'SHORT' : 'LONG';
  const entry = paperRoundPrice(pair.price * (dir === 'LONG' ? 0.997 : 1.003));
  const sl = paperRoundPrice(entry * (dir === 'LONG' ? 0.97 : 1.03));
  const tp1 = paperRoundPrice(entry * (dir === 'LONG' ? 1.06 : 0.94));
  const tp2 = paperRoundPrice(entry * (dir === 'LONG' ? 1.10 : 0.90));
  const riskDollar = Math.max(0, paperEquity() * PAPER_RISK_PCT / 100);
  const stopDistance = Math.abs(entry - sl);
  const contracts = stopDistance > 0 ? riskDollar / stopDistance : 0;
  return {
    dir,
    entry, sl, tp1, tp2,
    contracts: Number(contracts.toFixed(6)),
    size: Number((contracts * entry).toFixed(2)),
    riskPct: PAPER_RISK_PCT,
    riskDollar: Number(riskDollar.toFixed(2))
  };
}

function validatePaperSetup(pair, setup) {
  const reasons = [];
  const price = paperNumber(pair && pair.price);
  const entry = paperNumber(setup && setup.entry);
  const sl = paperNumber(setup && setup.sl);
  const tp1 = paperNumber(setup && setup.tp1);
  const tp2 = paperNumber(setup && setup.tp2);
  if (!price || !entry || !sl || !tp1 || !tp2) reasons.push('harga setup tidak valid');
  if (setup.dir === 'LONG') {
    if (!(entry < price)) reasons.push('LONG limit harus di bawah harga sekarang');
    if (!(sl < entry && tp1 > entry && tp2 > tp1)) reasons.push('urutan LONG entry/SL/TP tidak valid');
  } else if (setup.dir === 'SHORT') {
    if (!(entry > price)) reasons.push('SHORT limit harus di atas harga sekarang');
    if (!(sl > entry && tp1 < entry && tp2 < tp1)) reasons.push('urutan SHORT entry/SL/TP tidak valid');
  } else {
    reasons.push('arah trade tidak dikenal');
  }
  const entryOffsetPct = price > 0 ? Math.abs(entry - price) / price * 100 : 0;
  const stopPct = entry > 0 ? Math.abs(entry - sl) / entry * 100 : 0;
  const rewardPct = entry > 0 ? Math.abs(entry - tp1) / entry * 100 : 0;
  const rr = stopPct > 0 ? rewardPct / stopPct : 0;
  if (entryOffsetPct < PAPER_MIN_ENTRY_OFFSET_PCT) reasons.push('entry terlalu dekat dengan harga sekarang');
  if (stopPct <= 0.25) reasons.push('jarak SL terlalu kecil');
  if (rr < PAPER_MIN_RR) reasons.push('risk/reward di bawah batas minimum');
  if (!Number.isFinite(setup.contracts) || setup.contracts <= 0 || !Number.isFinite(setup.size) || setup.size <= 0) {
    reasons.push('ukuran posisi tidak valid');
  }
  return {
    ok: reasons.length === 0,
    reasons,
    entryOffsetPct: Number(entryOffsetPct.toFixed(3)),
    stopPct: Number(stopPct.toFixed(3)),
    rewardPct: Number(rewardPct.toFixed(3)),
    rr: Number(rr.toFixed(2))
  };
}

function paperActiveCount(includeLegacy) {
  return paperState.activeTrades.filter(t =>
    (t.status === 'PENDING' || t.status === 'OPEN') &&
    (includeLegacy || isStrictPaperTrade(t))).length;
}

function paperLegacyActiveCount() {
  return paperState.activeTrades.filter(t =>
    (t.status === 'PENDING' || t.status === 'OPEN') && !isStrictPaperTrade(t)).length;
}

function paperRealizedPnl(includeLegacy) {
  return paperState.closedTrades
    .filter(trade => includeLegacy || isStrictPaperTrade(trade))
    .reduce((sum, trade) => sum + paperNumber(trade.pnl), 0);
}

function paperUnrealizedPnl(includeLegacy) {
  return paperState.activeTrades
    .filter(trade => trade.status === 'OPEN' && (includeLegacy || isStrictPaperTrade(trade)))
    .reduce((sum, trade) => sum + paperNumber(trade.unrealPnl), 0);
}

function paperEquity(includeLegacy) {
  return paperNumber(paperState.startingEquity || PAPER_STARTING_EQUITY) +
    paperRealizedPnl(includeLegacy) + paperUnrealizedPnl(includeLegacy);
}

function paperTradeRiskDollar(trade) {
  const entry = paperNumber(trade.entryActual || trade.entryLimit);
  const stop = paperNumber(trade.sl);
  const size = Math.abs(paperNumber(trade.size));
  if (!entry || !stop || !size) return 0;
  return Math.abs(entry - stop) / entry * size;
}

function paperActiveRiskDollar(includeLegacy) {
  return paperState.activeTrades
    .filter(trade => (trade.status === 'PENDING' || trade.status === 'OPEN') &&
      (includeLegacy || isStrictPaperTrade(trade)))
    .reduce((sum, trade) => sum + paperTradeRiskDollar(trade), 0);
}

function paperTradeView(trade) {
  return {
    id: trade.id, sym: trade.sym, dir: trade.dir, status: trade.status,
    entryLimit: trade.entryLimit, entryActual: trade.entryActual || null,
    currentPrice: trade.currentPrice, sl: trade.sl, tp1: trade.tp1, tp2: trade.tp2,
    size: trade.size, contracts: trade.contracts, score: trade.score, tier: trade.tier,
    fund: trade.fund, oi: trade.oi, volume: trade.volume || 0, mtf: trade.mtf || null,
    createdAt: trade.createdAt,
    openedAt: trade.openedAt || null, cycleKey: trade.cycleKey,
    unrealPnl: Number((trade.unrealPnl || 0).toFixed(2)),
    mfePnl: Number((trade.mfePnl || 0).toFixed(2)),
    maePnl: Number((trade.maePnl || 0).toFixed(2)),
    riskPct: trade.riskPct || null,
    riskDollar: Number(paperTradeRiskDollar(trade).toFixed(2)),
    executionModel: paperExecutionModel(trade),
    executionClass: isStrictPaperTrade(trade) ? 'STRICT' : 'LEGACY',
    timeframe: trade.timeframe || trade.tf || '15M',
    tf: trade.tf || trade.timeframe || '15M',
    dataAt: trade.dataAt || null,
    source: trade.source || 'Bitget Futures',
    dataQuality: trade.dataQuality || null,
    signalReasons: Array.isArray(trade.signalReasons) ? trade.signalReasons : [],
    scoreBreakdown: trade.scoreBreakdown || null,
    setupValidation: trade.setupValidation || null,
    reason: trade.reason
  };
}

function paperCandidateView(pair) {
  const reasons = [];
  if (pair.chg < 0) reasons.push('24H turun -> kandidat SHORT pullback');
  else if (pair.chg > 0) reasons.push('24H naik -> kandidat LONG pullback');
  if (pair.fund < 0) reasons.push('funding negatif');
  if (pair.oi > 0) reasons.push('OI meningkat ' + pair.oi.toFixed(2) + '%');
  if (pair.oiUSD > 0 && !pair.oiReady) reasons.push('OI baseline tersimpan; delta menunggu scan berikutnya');
  if (Math.abs(pair.chg) <= 2) reasons.push('pergerakan belum terlalu extended');
  if (pair.volumeRatio >= 1.5) reasons.push('volume ' + pair.volumeRatio.toFixed(2) + 'x median');
  if (pair.volumeRatio != null && pair.volumeRatio < 1) reasons.push('volume di bawah median');
  if (!pair.oiReady) reasons.push('OI belum punya baseline pembanding');
  if (pair.mtf) {
    ['H4', 'H1', 'M15'].forEach(tf => {
      const item = pair.mtf[tf];
      if (item && item.direction !== 'NEUTRAL') reasons.push(tf + ' ' + item.direction);
    });
  }
  return {
    sym: pair.sym, price: pair.price, chg: pair.chg, volume: pair.volume,
    volumeRatio: pair.volumeRatio, oiReady: !!pair.oiReady,
    fund: pair.fund, oi: pair.oi, score: pair.sc, tier: pair.tier,
    sig: pair.sig, rank: pair.rank, direction: pair.chg < 0 ? 'SHORT' : 'LONG',
    dataAt: pair.dataAt || null, source: pair.source || 'Bitget Futures',
    mtf: pair.mtf || null, dataQuality: pair.dataQuality || 'PARTIAL',
    scoreBreakdown: pair.scoreBreakdown || null, mtfAvailable: pair.mtfAvailable || 0,
    mtfStatus: pair.mtfStatus || 'UNAVAILABLE',
    evidence: reasons
  };
}

async function fetchPaperCandles(sym, granularity) {
  const target = APIS['/bitget'] +
    '/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=' +
    encodeURIComponent(sym + 'USDT') + '&granularity=' +
    encodeURIComponent(granularity) + '&limit=3';
  const startedAt = Date.now();
  let result;
  try {
    result = await requestUpstream(target);
    markSourceHealth('/bitget', {
      ...result, latencyMs: Date.now() - startedAt,
      path: '/api/v2/mix/market/candles'
    });
  } catch (error) {
    markSourceError('/bitget', error, '/api/v2/mix/market/candles');
    throw error;
  }
  if (result.status < 200 || result.status >= 300) throw new Error('Bitget candles HTTP ' + result.status);
  let payload;
  try {
    payload = JSON.parse(result.body);
  } catch (_) {
    const error = new Error('Bitget candles returned invalid JSON');
    markSourceError('/bitget', error, '/api/v2/mix/market/candles');
    throw error;
  }
  if (!payload || payload.code !== '00000' || !Array.isArray(payload.data)) {
    const error = new Error((payload && payload.msg) || 'Bitget candles response invalid');
    markSourceError('/bitget', error, '/api/v2/mix/market/candles');
    throw error;
  }
  return payload.data.map(row => ({
    ts: Number(row[0]), open: Number(row[1]), close: Number(row[4])
  })).filter(row => row.open > 0 && row.close > 0).sort((a, b) => a.ts - b.ts);
}

function paperCandleEvidence(rows) {
  if (!rows || !rows.length) return null;
  const last = rows[rows.length - 1];
  const change = (last.close - last.open) / last.open * 100;
  return {
    change: Number(change.toFixed(3)),
    direction: change > 0.05 ? 'LONG' : change < -0.05 ? 'SHORT' : 'NEUTRAL',
    candleAt: Number.isFinite(last.ts) ? new Date(last.ts).toISOString() : null,
    candles: rows.length
  };
}

async function enrichPaperMtf(pair) {
  // One failed timeframe must not erase the other valid timeframes.
  const rows = await Promise.all([
    fetchPaperCandles(pair.sym, '4H').catch(() => []),
    fetchPaperCandles(pair.sym, '1H').catch(() => []),
    fetchPaperCandles(pair.sym, '15m').catch(() => [])
  ]);
  pair.mtf = {
    H4: paperCandleEvidence(rows[0]),
    H1: paperCandleEvidence(rows[1]),
    M15: paperCandleEvidence(rows[2])
  };
  pair.mtfAvailable = Object.values(pair.mtf).filter(Boolean).length;
  pair.mtfStatus = pair.mtfAvailable === 3 ? 'FULL' : pair.mtfAvailable ? 'PARTIAL' : 'UNAVAILABLE';
  return pair;
}

function closePaperTrade(trade, exitPrice, outcome, reason) {
  const entry = trade.entryActual || trade.entryLimit;
  const stopDistance = Math.abs(entry - trade.sl);
  const r = stopDistance > 0
    ? (trade.dir === 'LONG' ? exitPrice - entry : entry - exitPrice) / stopDistance : 0;
  const pnl = ((exitPrice - entry) / entry) * trade.size *
    (trade.dir === 'LONG' ? 1 : -1);
  trade.status = 'CLOSED';
  trade.exitPrice = exitPrice;
  trade.closedAt = new Date().toISOString();
  trade.outcome = outcome;
  trade.closeReason = reason;
  trade.r = Number(r.toFixed(2));
  trade.pnl = Number(pnl.toFixed(2));
  paperState.closedTrades.unshift({
    ...paperTradeView(trade), exitPrice, closedAt: trade.closedAt,
    outcome, closeReason: reason, r: trade.r, pnl: trade.pnl
  });
  paperState.closedTrades = paperState.closedTrades.slice(0, PAPER_MAX_CLOSED_TRADES);
  console.log('[paper] closed', trade.sym, outcome, reason);
  void sendTelegramMessage(paperCloseAlert(trade));
}

async function fetchPaperTickers() {
  const target = APIS['/bitget'] +
    '/api/v2/mix/market/tickers?productType=USDT-FUTURES';
  const startedAt = Date.now();
  let result;
  try {
    result = await requestUpstream(target);
    markSourceHealth('/bitget', {
      ...result, latencyMs: Date.now() - startedAt,
      path: '/api/v2/mix/market/tickers'
    });
  } catch (error) {
    markSourceError('/bitget', error, '/api/v2/mix/market/tickers');
    throw error;
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error('Bitget tickers HTTP ' + result.status);
  }
  let payload;
  try {
    payload = JSON.parse(result.body);
  } catch (_) {
    const error = new Error('Bitget tickers returned invalid JSON');
    markSourceError('/bitget', error, '/api/v2/mix/market/tickers');
    throw error;
  }
  if (!payload || payload.code !== '00000' || !Array.isArray(payload.data)) {
    const error = new Error((payload && payload.msg) || 'Bitget tickers response invalid');
    markSourceError('/bitget', error, '/api/v2/mix/market/tickers');
    throw error;
  }
  payload._nexoraFetchedAt = new Date().toISOString();
  return payload;
}

async function runPaperScan(reason, requestedCycleKey) {
  if (!paperState.enabled || paperBusy) return;
  const cycleKey = requestedCycleKey || paperCycleKey(Date.now());
  if (paperState.lastCycleKey === cycleKey) return;
  paperBusy = true;
  try {
    const payload = await fetchPaperTickers();
    const ranked = buildPaperPairs(payload);
    const activeSymbols = new Map();
    paperState.activeTrades
      .filter(t => t.status === 'PENDING' || t.status === 'OPEN')
      .forEach(t => activeSymbols.set(t.sym, (activeSymbols.get(t.sym) || 0) + 1));
    const equity = paperEquity();
    const activeRisk = paperActiveRiskDollar();
    const riskBudget = equity * PAPER_MAX_ACTIVE_RISK_PCT / 100;
    const perTradeRisk = equity * PAPER_RISK_PCT / 100;
    const riskSlots = perTradeRisk > 0
      ? Math.floor(Math.max(0, riskBudget - activeRisk) / perTradeRisk)
      : 0;
    const capacity = Math.min(
      Math.max(0, PAPER_MAX_ACTIVE - paperActiveCount()), riskSlots);
    const selected = [];
    const rejected = [];
    const targetCount = Math.min(PAPER_PER_SCAN, capacity);
    for (const pair of ranked) {
      if (selected.length >= targetCount) break;
      if ((activeSymbols.get(pair.sym) || 0) >= PAPER_MAX_PER_SYMBOL) continue;
      const setup = paperSetup(pair);
      const setupValidation = validatePaperSetup(pair, setup);
      if (!setupValidation.ok) {
        rejected.push({sym: pair.sym, reasons: setupValidation.reasons});
        continue;
      }
      selected.push({pair, setup, setupValidation});
      activeSymbols.set(pair.sym, (activeSymbols.get(pair.sym) || 0) + 1);
    }
    await Promise.all(selected.map(item => enrichPaperMtf(item.pair)));
    const placed = selected.map(item => {
      const pair = item.pair;
      const setup = item.setup;
      const id = 'VPS-' + String(++paperState.nextId).padStart(6, '0');
      const candidate = paperCandidateView(pair);
      const trade = {
        id, sym: pair.sym, dir: setup.dir, entryLimit: setup.entry,
        currentPrice: pair.price, sl: setup.sl, tp1: setup.tp1, tp2: setup.tp2,
        size: setup.size, contracts: setup.contracts, status: 'PENDING',
        riskPct: setup.riskPct, riskDollar: setup.riskDollar,
        createdAt: Date.now(), openedAt: null, cycleKey,
        score: pair.sc, tier: pair.tier, fund: pair.fund, oi: pair.oi,
        volume: pair.volume, mtf: pair.mtf,
        timeframe: '15M', tf: '15M', dataQuality: pair.dataQuality,
        dataAt: pair.dataAt, source: pair.source,
        signalReasons: candidate.evidence, scoreBreakdown: candidate.scoreBreakdown,
        setupValidation: item.setupValidation,
        unrealPnl: 0, mfePnl: 0, maePnl: 0,
        executionModel: 'LIMIT_STRICT',
        executionClass: 'STRICT', legacy: false,
        reason: 'Auto VPS: 15M scan | ' + candidate.evidence.join('; ')
      };
      paperState.activeTrades.push(trade);
      console.log('[paper] placed', id, pair.sym, setup.dir, '@', setup.entry);
      return paperTradeView(trade);
    });
    paperState.lastCycleKey = cycleKey;
    paperState.lastScanAt = new Date().toISOString();
    paperState.lastError = null;
    const strictActiveCount = paperActiveCount();
    const blockReason = !capacity
      ? (paperActiveCount() >= PAPER_MAX_ACTIVE ? 'MAX_ACTIVE_REACHED'
        : activeRisk >= riskBudget ? 'RISK_BUDGET_REACHED' : 'NO_CAPACITY')
      : (!placed.length ? 'NO_VALID_UNALLOCATED_SETUP' :
        placed.length < PAPER_PER_SCAN ? 'PARTIAL_CAPACITY' : null);
    paperState.lastBlockReason = blockReason;
    paperState.recentScans.unshift({
      cycleKey, at: paperState.lastScanAt, reason: reason || '15M close',
      candidates: ranked.length,
      selected: ranked.slice(0, 10).map(paperCandidateView),
      placed,
      rejected: rejected.slice(0, 20),
      capacity: {
        requested: PAPER_PER_SCAN, placed: placed.length,
        availableSlots: Math.max(0, PAPER_MAX_ACTIVE - strictActiveCount),
        availableRisk: Number(Math.max(0, riskBudget - activeRisk).toFixed(2)),
        blockReason
      }
    });
    paperState.recentScans = paperState.recentScans.slice(0, PAPER_MAX_RECENT_SCANS);
    savePaperState();
    console.log('[paper] scan complete', cycleKey, 'placed', placed.length);
    if (placed.length) void sendTelegramMessage(paperScanAlert(cycleKey, placed));
    if (blockReason && !placed.length) void sendTelegramMessage(paperCapacityAlert(paperStatus()));
  } catch (error) {
    paperState.lastError = error.message;
    savePaperState();
    console.error('[paper] scan failed:', error.message);
    sendRateLimitedAlert(
      'paper-scan:' + error.message,
      'NEXORA PAPER SCAN ERROR\n' + error.message + '\nCycle retry tetap aktif.',
      15 * 60 * 1000
    );
  } finally {
    paperBusy = false;
  }
}

async function monitorPaperTrades() {
  if (!paperState.enabled || paperBusy || !paperState.activeTrades.length) return;
  paperBusy = true;
  let changed = false;
  try {
    const payload = await fetchPaperTickers();
    const prices = {};
    (Array.isArray(payload.data) ? payload.data : []).forEach(row => {
      const sym = paperTickerSymbol(row);
      const price = paperNumber(row.lastPr || row.last || row.close || row.markPrice);
      if (sym && price) prices[sym] = price;
    });
    const now = Date.now();
    const retained = [];
    paperState.activeTrades.forEach(trade => {
      const price = prices[trade.sym];
      if (!price) {
        retained.push(trade);
        return;
      }
      trade.currentPrice = price;
      if (trade.status === 'PENDING') {
        if (now - trade.createdAt >= PAPER_PENDING_TTL_MS) {
          trade.status = 'CANCELLED';
          trade.closedAt = new Date().toISOString();
          trade.closeReason = 'Pending expired after 120 minutes';
          paperState.closedTrades.unshift({
            ...paperTradeView(trade), closedAt: trade.closedAt,
            closeReason: trade.closeReason, outcome: 'CANCELLED', pnl: 0, r: 0
          });
          paperState.closedTrades = paperState.closedTrades.slice(0, PAPER_MAX_CLOSED_TRADES);
          changed = true;
          void sendTelegramMessage(paperCloseAlert({
            ...paperTradeView(trade), exitPrice: trade.currentPrice,
            outcome: 'CANCELLED', r: 0, pnl: 0, closeReason: trade.closeReason
          }));
        } else {
          // Strict limit semantics: a buy limit fills only at or below its
          // entry; a sell limit fills only at or above its entry. The old
          // 0.5% tolerance made every new order fill immediately because the
          // entry offset itself is only 0.3%.
          const filled = trade.dir === 'LONG'
            ? price <= trade.entryLimit
            : price >= trade.entryLimit;
          if (filled) {
            trade.status = 'OPEN';
            trade.entryActual = price;
            trade.openedAt = new Date().toISOString();
            changed = true;
            void sendTelegramMessage(paperFillAlert(trade));
          }
          retained.push(trade);
        }
        return;
      }
      if (trade.status !== 'OPEN') return;
      const entry = trade.entryActual || trade.entryLimit;
      trade.unrealPnl = ((price - entry) / entry) * trade.size *
        (trade.dir === 'LONG' ? 1 : -1);
      trade.mfePnl = Math.max(paperNumber(trade.mfePnl), trade.unrealPnl);
      trade.maePnl = Math.min(paperNumber(trade.maePnl), trade.unrealPnl);
      if (trade.dir === 'LONG' && price <= trade.sl) {
        closePaperTrade(trade, price, 'LOSS', 'Hit SL');
        changed = true;
      } else if (trade.dir === 'LONG' && price >= trade.tp1) {
        closePaperTrade(trade, price, 'WIN', 'Hit TP1');
        changed = true;
      } else if (trade.dir === 'SHORT' && price >= trade.sl) {
        closePaperTrade(trade, price, 'LOSS', 'Hit SL');
        changed = true;
      } else if (trade.dir === 'SHORT' && price <= trade.tp1) {
        closePaperTrade(trade, price, 'WIN', 'Hit TP1');
        changed = true;
      } else {
        retained.push(trade);
      }
    });
    paperState.activeTrades = retained;
    paperState.lastMonitorAt = new Date().toISOString();
    paperState.lastPriceAt = paperState.lastMonitorAt;
    paperState.lastError = null;
    if (changed || paperState.activeTrades.length) savePaperState();
  } catch (error) {
    paperState.lastError = error.message;
    savePaperState();
    console.error('[paper] monitor failed:', error.message);
    sendRateLimitedAlert(
      'paper-monitor:' + error.message,
      'NEXORA PAPER MONITOR ERROR\n' + error.message,
      15 * 60 * 1000
    );
  } finally {
    paperBusy = false;
  }
}

function paperStatus() {
  const active = paperState.activeTrades.map(paperTradeView);
  const open = active.filter(t => t.status === 'OPEN').length;
  const pending = active.filter(t => t.status === 'PENDING').length;
  const closed = paperState.closedTrades;
  const wins = closed.filter(t => t.outcome === 'WIN').length;
  const losses = closed.filter(t => t.outcome === 'LOSS').length;
  const netR = closed.reduce((sum, t) => sum + paperNumber(t.r), 0);
  // The new bot's risk and sizing must not be changed by the first worker's
  // legacy trades. Those trades remain visible and auditable below, but the
  // default equity/risk figures are strict-bot-only.
  const realizedPnl = paperRealizedPnl();
  const unrealizedPnl = paperUnrealizedPnl();
  const totalRealizedPnl = paperRealizedPnl(true);
  const totalUnrealizedPnl = paperUnrealizedPnl(true);
  const equity = paperEquity();
  const strictActiveCount = paperActiveCount();
  const legacyActiveCount = paperLegacyActiveCount();
  const activeRisk = paperActiveRiskDollar();
  const legacyActiveRisk = paperActiveRiskDollar(true) - activeRisk;
  const riskBudget = equity * PAPER_MAX_ACTIVE_RISK_PCT / 100;
  const availableSlots = Math.max(0, PAPER_MAX_ACTIVE - strictActiveCount);
  const availableRisk = Math.max(0, riskBudget - activeRisk);
  const blockReason = paperState.lastBlockReason ||
    (availableSlots <= 0 ? 'MAX_ACTIVE_REACHED' : availableRisk < equity * PAPER_RISK_PCT / 100
      ? 'RISK_BUDGET_REACHED' : null);
  return {
    ok: true, service: 'nexora-paper-bot', enabled: paperState.enabled,
    running: paperStarted, interval: '15M', perScan: PAPER_PER_SCAN,
    pendingTtlMinutes: PAPER_PENDING_TTL_MS / 60000, maxConcurrent: PAPER_MAX_ACTIVE,
    maxPerSymbol: PAPER_MAX_PER_SYMBOL,
    strictActiveCount, legacyActiveCount, availableSlots,
    startingEquity: paperNumber(paperState.startingEquity || PAPER_STARTING_EQUITY),
    realizedPnl: Number(realizedPnl.toFixed(2)),
    unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
    equity: Number(equity.toFixed(2)),
    legacyRealizedPnl: Number((totalRealizedPnl - realizedPnl).toFixed(2)),
    legacyUnrealizedPnl: Number((totalUnrealizedPnl - unrealizedPnl).toFixed(2)),
    totalEquity: Number((paperNumber(paperState.startingEquity || PAPER_STARTING_EQUITY) +
      totalRealizedPnl + totalUnrealizedPnl).toFixed(2)),
    riskPct: PAPER_RISK_PCT,
    maxActiveRiskPct: PAPER_MAX_ACTIVE_RISK_PCT,
    activeRisk: Number(activeRisk.toFixed(2)),
    legacyActiveRisk: Number(Math.max(0, legacyActiveRisk).toFixed(2)),
    riskBudget: Number(riskBudget.toFixed(2)),
    availableRisk: Number(availableRisk.toFixed(2)),
    blockReason,
    alerts: {
      telegram: TELEGRAM_ALERTS_ENABLED,
      sent: telegramState.sent,
      lastAttemptAt: telegramState.lastAttemptAt,
      lastSuccessAt: telegramState.lastSuccessAt,
      lastError: telegramState.lastError
    },
    state: {
      schemaVersion: PAPER_SCHEMA_VERSION,
      savedAt: paperState.lastSavedAt,
      backupFile: path.basename(PAPER_STATE_BACKUP_FILE)
    },
    lastScanAt: paperState.lastScanAt, lastCycleKey: paperState.lastCycleKey,
    nextScanAt: new Date(paperNextQuarter(Date.now())).toISOString(),
    lastMonitorAt: paperState.lastMonitorAt, lastPriceAt: paperState.lastPriceAt,
    lastError: paperState.lastError, activeTrades: active,
    recentScans: paperState.recentScans.slice(0, 20),
    closedTrades: closed.slice(0, 100),
    invalidatedTrades: paperState.invalidatedTrades.slice(0, 100),
    summary: {
      open, pending, closed: closed.length, wins, losses,
      invalidated: paperState.invalidatedTrades.length,
      netR: Number(netR.toFixed(2)),
      equity: Number(equity.toFixed(2))
    }
  };
}

function paperHistory(query) {
  const params = query || new URLSearchParams();
  const symbol = String(params.get('symbol') || params.get('sym') || '').trim().toUpperCase();
  const timeframe = String(params.get('timeframe') || params.get('tf') || '').trim().toUpperCase();
  const outcome = String(params.get('outcome') || '').trim().toUpperCase();
  const from = String(params.get('from') || '').trim();
  const to = String(params.get('to') || '').trim();
  const all = paperState.closedTrades.slice(0, PAPER_MAX_CLOSED_TRADES);
  const closedTrades = all.filter(trade => {
    if (symbol && String(trade.sym || '').toUpperCase() !== symbol) return false;
    if (timeframe && String(trade.timeframe || trade.tf || '').toUpperCase() !== timeframe) return false;
    if (outcome && String(trade.outcome || '').toUpperCase() !== outcome) return false;
    const date = String(trade.closedAt || trade.createdAt || '').slice(0, 10);
    if (from && (!date || date < from)) return false;
    if (to && (!date || date > to)) return false;
    return true;
  });
  return {
    ok: true,
    closedTrades,
    invalidatedTrades: paperState.invalidatedTrades.slice(0, 100),
    filters: {symbol: symbol || 'all', timeframe: timeframe || 'all', outcome: outcome || 'all', from, to},
    total: closedTrades.length
  };
}

function startPaperBot() {
  if (process.env.PAPER_BOT_ENABLED === 'false') return;
  paperStarted = true;
  console.log('[paper] VPS Paper Bot ON: scan every 15M, top 3, pending expiry 120m');
  void sendTelegramMessage('NEXORA PAPER BOT ON\nScan 15M · top 3 · limit strict\nLegacy trades tidak memakai budget bot baru');
  setTimeout(() => runPaperScan('startup', paperCycleKey(Date.now())), 5000);
  setInterval(() => {
    // Do not depend on a 30-second wall-clock window: a busy event loop or a
    // temporary upstream retry must not silently skip a quarter-hour scan.
    const cycleKey = paperCycleKey(Date.now());
    if (paperState.lastCycleKey !== cycleKey) runPaperScan('15M close', cycleKey);
  }, PAPER_SCAN_CHECK_MS);
  setInterval(monitorPaperTrades, PAPER_MONITOR_MS);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  if (requestUrl.pathname === '/healthz') {
    send(res, 200, JSON.stringify({
      ok: true,
      service: 'nexora-proxy',
      port: PORT,
      paperBot: paperStarted,
      time: new Date().toISOString(),
      sources: sourceHealthView()
    }));
    return;
  }
  if (requestUrl.pathname === '/paper/status') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    send(res, 200, JSON.stringify(paperStatus()));
    return;
  }
  if (requestUrl.pathname === '/paper/alerts/status') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    send(res, 200, JSON.stringify({
      ok: true,
      enabled: TELEGRAM_ALERTS_ENABLED,
      sent: telegramState.sent,
      lastAttemptAt: telegramState.lastAttemptAt,
      lastSuccessAt: telegramState.lastSuccessAt,
      lastError: telegramState.lastError
    }));
    return;
  }
  if (requestUrl.pathname === '/paper/history') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    send(res, 200, JSON.stringify(paperHistory(requestUrl.searchParams)));
    return;
  }

  const prefix = prefixes.find(item =>
    requestUrl.pathname === item || requestUrl.pathname.startsWith(item + '/')
  );
  if (!prefix) {
    send(res, 404, JSON.stringify({error: 'Route not found'}));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, JSON.stringify({error: 'Method not allowed'}));
    return;
  }

  const upstreamPath = requestUrl.pathname.slice(prefix.length) || '/';
  const target = APIS[prefix] + upstreamPath + requestUrl.search;
  const key = prefix + requestUrl.pathname + requestUrl.search;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    // A cache hit is not a new upstream observation. Keep the source health
    // timestamp tied to the last real upstream response so old data is never
    // presented as freshly fetched.
    send(res, hit.status, hit.body, hit.contentType);
    return;
  }

  try {
    const startedAt = Date.now();
    const result = await requestUpstream(target);
    result.latencyMs = Date.now() - startedAt;
    result.path = upstreamPath;
    markSourceHealth(prefix, result);
    if (result.status >= 400) {
      sendRateLimitedAlert(
        'api:' + prefix + ':' + result.status,
        'NEXORA API ERROR\n' + prefix + upstreamPath + '\nHTTP ' + result.status,
        10 * 60 * 1000
      );
    }
    if (result.status >= 200 && result.status < 300) {
      cache.set(key, {...result, expiresAt: Date.now() + cacheTtl(prefix, requestUrl.pathname)});
    }
    send(res, result.status, result.body, result.contentType);
  } catch (error) {
    markSourceError(prefix, error, upstreamPath);
    console.error('[proxy]', prefix, upstreamPath, error.message);
    sendRateLimitedAlert(
      'api:' + prefix + ':network',
      'NEXORA API ERROR\n' + prefix + upstreamPath + '\n' + error.message,
      10 * 60 * 1000
    );
    send(res, 502, JSON.stringify({error: 'Upstream unavailable', detail: error.message}));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Nexora proxy listening on HTTP :' + PORT);
  startPaperBot();
});

process.on('SIGTERM', () => {
  savePaperState();
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  savePaperState();
  server.close(() => process.exit(0));
});
