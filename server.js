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
// The VPS bot uses the same intraday structure as the CryptoEx-style view:
// 4H/1H define the bias, 30M confirms the structure, and 15M is the trigger.
// Keep the candle request bounded so a 15-minute scan cannot overwhelm the
// upstream exchange API while still providing enough history for indicators.
const PAPER_CANDLE_LIMIT = Math.max(80, Math.min(250,
  Number.isFinite(Number(process.env.PAPER_CANDLE_LIMIT))
    ? Number(process.env.PAPER_CANDLE_LIMIT) : 120));
const PAPER_MTF_MIN_ALIGNMENT = Math.max(3, Math.min(4,
  Number.isFinite(Number(process.env.PAPER_MTF_MIN_ALIGNMENT))
    ? Number(process.env.PAPER_MTF_MIN_ALIGNMENT) : 3));
const PAPER_MIN_CONFLUENCE = Math.max(50, Math.min(95,
  Number.isFinite(Number(process.env.PAPER_MIN_CONFLUENCE))
    ? Number(process.env.PAPER_MIN_CONFLUENCE) : 60));
const PAPER_SIGNAL_MODE = String(process.env.PAPER_SIGNAL_MODE || 'WEIGHTED').toUpperCase() === 'CLASSIC'
  ? 'CLASSIC' : 'WEIGHTED';
const PAPER_MTF_CONCURRENCY = Math.max(2, Math.min(12,
  Number.isFinite(Number(process.env.PAPER_MTF_CONCURRENCY))
    ? Number(process.env.PAPER_MTF_CONCURRENCY) : 6));
const PAPER_MTF_MAX_CANDIDATES = Math.max(8, Math.min(40,
  Number.isFinite(Number(process.env.PAPER_MTF_MAX_CANDIDATES))
    ? Number(process.env.PAPER_MTF_MAX_CANDIDATES) : 24));
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
const PAPER_TIMEFRAME_MAX_AGE_MS = {
  H4: 12 * 60 * 60 * 1000,
  H1: 3 * 60 * 60 * 1000,
  M30: 90 * 60 * 1000,
  M15: 45 * 60 * 1000
};
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const TELEGRAM_ALERTS_ENABLED = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
const TELEGRAM_SCAN_SUMMARY = String(process.env.TELEGRAM_SCAN_SUMMARY || '').toLowerCase() === 'true';
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

function paperFieldPresent(value) {
  return value !== undefined && value !== null && value !== '' &&
    Number.isFinite(Number(value));
}

function paperTimestamp(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed < 100000000000 ? parsed * 1000 : parsed;
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
  next.signalMode = next.signalMode || (isStrictPaperTrade(next) ? 'WEIGHTED' : 'LEGACY');
  next.mode = next.mode || next.signalMode;
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

function paperClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function paperMean(values) {
  const valid = values.filter(value => Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function paperEmaSeries(values, period) {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  let ema = values[0];
  return values.map((value, index) => {
    ema = index === 0 ? value : (value * alpha) + (ema * (1 - alpha));
    return ema;
  });
}

function paperRsiSeries(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index++) {
    const delta = values[index] - values[index - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] = averageLoss === 0 ? 100 : 100 - (100 / (1 + averageGain / averageLoss));
  for (let index = period + 1; index < values.length; index++) {
    const delta = values[index] - values[index - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    averageGain = ((averageGain * (period - 1)) + gain) / period;
    averageLoss = ((averageLoss * (period - 1)) + loss) / period;
    result[index] = averageLoss === 0 ? 100 : 100 - (100 / (1 + averageGain / averageLoss));
  }
  return result;
}

function paperStochRsiSeries(rsi, period, smooth) {
  const raw = Array(rsi.length).fill(null);
  const k = Array(rsi.length).fill(null);
  const d = Array(rsi.length).fill(null);
  for (let index = period - 1; index < rsi.length; index++) {
    const window = rsi.slice(index - period + 1, index + 1).filter(value => value != null);
    if (window.length < period) continue;
    const low = Math.min(...window);
    const high = Math.max(...window);
    raw[index] = high === low ? 50 : ((rsi[index] - low) / (high - low)) * 100;
    const kWindow = raw.slice(Math.max(0, index - smooth + 1), index + 1)
      .filter(value => value != null);
    if (kWindow.length === smooth) k[index] = paperMean(kWindow);
    const dWindow = k.slice(Math.max(0, index - smooth + 1), index + 1)
      .filter(value => value != null);
    if (dWindow.length === smooth) d[index] = paperMean(dWindow);
  }
  return {k, d};
}

function paperCandlePattern(rows) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return {name: 'NONE', direction: 'NEUTRAL'};
  }
  const current = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  const currentBody = Math.abs(current.close - current.open);
  const previousBody = Math.abs(previous.close - previous.open);
  const currentRange = Math.max(current.high - current.low, 0.0000000001);
  const currentUpper = current.high - Math.max(current.open, current.close);
  const currentLower = Math.min(current.open, current.close) - current.low;
  const currentBull = current.close > current.open;
  const currentBear = current.close < current.open;
  const previousBull = previous.close > previous.open;
  const previousBear = previous.close < previous.open;
  if (previousBear && currentBull && current.open <= previous.close && current.close >= previous.open) {
    return {name: 'BULLISH_ENGULFING', direction: 'LONG'};
  }
  if (previousBull && currentBear && current.open >= previous.close && current.close <= previous.open) {
    return {name: 'BEARISH_ENGULFING', direction: 'SHORT'};
  }
  if (currentLower >= currentBody * 2 && currentUpper <= currentBody &&
      current.close >= current.low + currentRange * 0.55) {
    return {name: 'HAMMER', direction: 'LONG'};
  }
  if (currentUpper >= currentBody * 2 && currentLower <= currentBody &&
      current.close <= current.low + currentRange * 0.45) {
    return {name: 'SHOOTING_STAR', direction: 'SHORT'};
  }
  if (currentBody <= currentRange * 0.1) return {name: 'DOJI', direction: 'NEUTRAL'};
  if (currentBull) return {name: 'BULLISH_CLOSE', direction: 'LONG'};
  if (currentBear) return {name: 'BEARISH_CLOSE', direction: 'SHORT'};
  return {name: 'NONE', direction: 'NEUTRAL'};
}

function paperAtrSeries(rows, period) {
  const trueRanges = rows.map((row, index) => {
    if (index === 0) return row.high - row.low;
    const previousClose = rows[index - 1].close;
    return Math.max(row.high - row.low,
      Math.abs(row.high - previousClose), Math.abs(row.low - previousClose));
  });
  const result = Array(rows.length).fill(null);
  if (trueRanges.length < period) return result;
  let atr = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = atr;
  for (let index = period; index < trueRanges.length; index++) {
    atr = ((atr * (period - 1)) + trueRanges[index]) / period;
    result[index] = atr;
  }
  return result;
}

function paperSupertrend(rows, atrSeries, period, factor) {
  let finalUpper = null;
  let finalLower = null;
  let direction = 1;
  for (let index = 0; index < rows.length; index++) {
    const atr = atrSeries[index];
    if (!Number.isFinite(atr)) continue;
    const midpoint = (rows[index].high + rows[index].low) / 2;
    const basicUpper = midpoint + factor * atr;
    const basicLower = midpoint - factor * atr;
    if (finalUpper == null) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      continue;
    }
    const previousClose = rows[index - 1].close;
    finalUpper = basicUpper < finalUpper || previousClose > finalUpper
      ? basicUpper : finalUpper;
    finalLower = basicLower > finalLower || previousClose < finalLower
      ? basicLower : finalLower;
    if (direction === 1 && rows[index].close < finalLower) direction = -1;
    else if (direction === -1 && rows[index].close > finalUpper) direction = 1;
  }
  return finalUpper == null ? null : direction === 1 ? 'LONG' : 'SHORT';
}

function paperIndicatorSnapshot(rows) {
  if (!Array.isArray(rows) || rows.length < 60) return null;
  const closes = rows.map(row => row.close);
  const ema9 = paperEmaSeries(closes, 9);
  const ema21 = paperEmaSeries(closes, 21);
  const ema50 = paperEmaSeries(closes, 50);
  const rsi = paperRsiSeries(closes, 14);
  const stochRsi = paperStochRsiSeries(rsi, 14, 3);
  const ema12 = paperEmaSeries(closes, 12);
  const ema26 = paperEmaSeries(closes, 26);
  const macdSeries = closes.map((_, index) => ema12[index] - ema26[index]);
  const macdSignal = paperEmaSeries(macdSeries, 9);
  const atrSeries = paperAtrSeries(rows, 14);
  const supertrend = paperSupertrend(rows, atrSeries, 10, 3);
  const candlePattern = paperCandlePattern(rows);
  const lastIndex = rows.length - 1;
  const last = rows[lastIndex];
  const previous = rows.slice(Math.max(0, lastIndex - 20), lastIndex);
  const support = previous.length ? Math.min(...previous.map(row => row.low)) : last.low;
  const resistance = previous.length ? Math.max(...previous.map(row => row.high)) : last.high;
  const averageVolume = paperMean(previous.map(row => row.volume));
  const volumeRatio = averageVolume > 0 ? last.volume / averageVolume : null;
  const longVotes = [
    ema9[lastIndex] > ema21[lastIndex] && ema21[lastIndex] > ema50[lastIndex],
    last.close > ema21[lastIndex],
    macdSeries[lastIndex] > macdSignal[lastIndex],
    rsi[lastIndex] != null && rsi[lastIndex] >= 50 && rsi[lastIndex] <= 75,
    supertrend === 'LONG',
    stochRsi.k[lastIndex] != null && stochRsi.d[lastIndex] != null &&
      stochRsi.k[lastIndex] >= stochRsi.d[lastIndex] && stochRsi.k[lastIndex] <= 80,
    candlePattern.direction === 'LONG'
  ].filter(Boolean).length;
  const shortVotes = [
    ema9[lastIndex] < ema21[lastIndex] && ema21[lastIndex] < ema50[lastIndex],
    last.close < ema21[lastIndex],
    macdSeries[lastIndex] < macdSignal[lastIndex],
    rsi[lastIndex] != null && rsi[lastIndex] >= 25 && rsi[lastIndex] < 50,
    supertrend === 'SHORT',
    stochRsi.k[lastIndex] != null && stochRsi.d[lastIndex] != null &&
      stochRsi.k[lastIndex] <= stochRsi.d[lastIndex] && stochRsi.k[lastIndex] >= 20,
    candlePattern.direction === 'SHORT'
  ].filter(Boolean).length;
  const direction = longVotes >= 3 && longVotes > shortVotes ? 'LONG'
    : shortVotes >= 3 && shortVotes > longVotes ? 'SHORT' : 'NEUTRAL';
  const strengthPct = Math.round(Math.max(longVotes, shortVotes) / 7 * 100);
  return {
    direction,
    strengthPct,
    change: Number(((last.close - rows[Math.max(0, lastIndex - 3)].close) /
      rows[Math.max(0, lastIndex - 3)].close * 100).toFixed(3)),
    candleAt: Number.isFinite(last.ts) ? new Date(last.ts).toISOString() : null,
    sampleSize: rows.length,
    support: paperRoundPrice(support),
    resistance: paperRoundPrice(resistance),
    atr: paperRoundPrice(atrSeries[lastIndex] || 0),
    atrPct: Number(((atrSeries[lastIndex] || 0) / last.close * 100).toFixed(3)),
    volumeRatio: volumeRatio == null ? null : Number(volumeRatio.toFixed(2)),
    indicators: {
      ema9: paperRoundPrice(ema9[lastIndex]),
      ema21: paperRoundPrice(ema21[lastIndex]),
      ema50: paperRoundPrice(ema50[lastIndex]),
      rsi: rsi[lastIndex] == null ? null : Number(rsi[lastIndex].toFixed(1)),
      stochRsiK: stochRsi.k[lastIndex] == null ? null : Number(stochRsi.k[lastIndex].toFixed(1)),
      stochRsiD: stochRsi.d[lastIndex] == null ? null : Number(stochRsi.d[lastIndex].toFixed(1)),
      macd: Number(macdSeries[lastIndex].toFixed(6)),
      macdSignal: Number(macdSignal[lastIndex].toFixed(6)),
      supertrend,
      candlePattern: candlePattern.name,
      candleDirection: candlePattern.direction
    },
    candlePattern
  };
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
      fund, oi, oiUSD: oiUsd, oiReady: previousOi > 0,
      fundingAvailable: paperFieldPresent(row.fundingRate) || paperFieldPresent(row.fundingRate24h),
      oiAvailable: paperFieldPresent(row.holdingAmount) || paperFieldPresent(row.openInterest),
      volumeAvailable: paperFieldPresent(row.quoteVolume) || paperFieldPresent(row.usdtVolume) ||
        paperFieldPresent(row.quoteVolume24h),
      sc: 0,
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
    pair.contextScoreBreakdown = paperScoreDetails(pair.chg, pair.fund, pair.oi, pair.oiReady, pair.volumeRatio);
    pair.scoreBreakdown = pair.contextScoreBreakdown;
    pair.sc = pair.contextScoreBreakdown.total;
    pair.tier = paperTier(pair.sc);
    // Do not discard a candidate before MTF analysis. A weak 24H move can
    // still be a valid pullback when the four intraday timeframes agree.
    if (pair.fund >= 0.005 || Math.abs(pair.chg) > 3.5 ||
        pair.volume <= 0 || pair.price <= 0) return null;
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
  const dir = pair.mtfDirection || (pair.chg < 0 ? 'SHORT' : 'LONG');
  const m15 = pair.mtf && pair.mtf.M15;
  const m30 = pair.mtf && pair.mtf.M30;
  const h1 = pair.mtf && pair.mtf.H1;
  const snapshot = m15 || h1 || null;
  const indicators = snapshot && snapshot.indicators || {};
  const price = pair.price;
  const atr = Math.max(
    paperNumber(snapshot && snapshot.atr),
    price * Math.max(0.0025, paperNumber(snapshot && snapshot.atrPct) / 100),
    price * 0.005
  );
  const minimumOffset = Math.max(price * 0.001, atr * 0.25);
  const supports = [m15, m30, h1].map(item => paperNumber(item && item.support))
    .filter(level => level > 0 && level < price);
  const resistances = [m15, m30, h1].map(item => paperNumber(item && item.resistance))
    .filter(level => level > price);
  const support = supports.length ? Math.max(...supports) : 0;
  const resistance = resistances.length ? Math.min(...resistances) : 0;
  const ema21 = paperNumber(indicators.ema21);
  const pullbackLevel = dir === 'LONG'
    ? [support, ema21].filter(level => level > 0 && level < price).sort((a, b) => b - a)[0]
    : [resistance, ema21].filter(level => level > price).sort((a, b) => a - b)[0];
  const entryBase = dir === 'LONG' ? price - minimumOffset : price + minimumOffset;
  const entry = paperRoundPrice(dir === 'LONG'
    ? (pullbackLevel && pullbackLevel <= entryBase ? pullbackLevel : entryBase)
    : (pullbackLevel && pullbackLevel >= entryBase ? pullbackLevel : entryBase));
  const structureStopDistance = dir === 'LONG' && support > 0
    ? entry - (support - atr * 0.15)
    : dir === 'SHORT' && resistance > 0
      ? (resistance + atr * 0.15) - entry : 0;
  const stopDistance = Math.min(price * 0.06,
    Math.max(atr * 1.5, structureStopDistance, price * 0.005));
  const sl = paperRoundPrice(dir === 'LONG' ? entry - stopDistance : entry + stopDistance);
  const riskDistance = Math.abs(entry - sl);
  const tp1Level = dir === 'LONG'
    ? (resistance > entry ? resistance : 0)
    : (support > 0 && support < entry ? support : 0);
  const minimumTp1 = dir === 'LONG' ? entry + riskDistance * 2 : entry - riskDistance * 2;
  const tp1 = paperRoundPrice(dir === 'LONG'
    ? Math.max(minimumTp1, tp1Level || 0)
    : Math.min(minimumTp1, tp1Level || Number.POSITIVE_INFINITY));
  const nextTarget = dir === 'LONG'
    ? resistances.filter(level => level > tp1).sort((a, b) => a - b)[0]
    : supports.filter(level => level < tp1).sort((a, b) => b - a)[0];
  const tp2 = paperRoundPrice(dir === 'LONG'
    ? Math.max(entry + riskDistance * 3, tp1 * 1.01, nextTarget || 0)
    : Math.min(entry - riskDistance * 3, tp1 * 0.99, nextTarget || Number.POSITIVE_INFINITY));
  const riskDollar = Math.max(0, paperEquity() * PAPER_RISK_PCT / 100);
  const contracts = stopDistance > 0 ? riskDollar / stopDistance : 0;
  return {
    dir,
    entry, sl, tp1, tp2,
    structureSupport: support || null,
    structureResistance: resistance || null,
    atr: Number(atr.toFixed(8)),
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
    mode: trade.mode || trade.signalMode || null,
    signalMode: trade.signalMode || trade.mode || null,
    executionModel: paperExecutionModel(trade),
    executionClass: isStrictPaperTrade(trade) ? 'STRICT' : 'LEGACY',
    timeframe: trade.timeframe || trade.tf || '15M',
    tf: trade.tf || trade.timeframe || '15M',
    dataAt: trade.dataAt || null,
    source: trade.source || 'Bitget Futures',
    dataQuality: trade.dataQuality || null,
    dataQualityReason: trade.dataQualityReason || null,
    confluencePct: trade.confluencePct == null ? null : trade.confluencePct,
    mtfDirection: trade.mtfDirection || null,
    mtfAlignment: trade.mtfAlignment || 0,
    mtfSummary: trade.mtfSummary || null,
    indicators: trade.indicators || null,
    candlePattern: trade.candlePattern || null,
    signalScores: trade.signalScores || null,
    support: trade.support || null,
    resistance: trade.resistance || null,
    structureSupport: trade.structureSupport || null,
    structureResistance: trade.structureResistance || null,
    atr: trade.atr || null,
    signalReasons: Array.isArray(trade.signalReasons) ? trade.signalReasons : [],
    scoreBreakdown: trade.scoreBreakdown || null,
    setupValidation: trade.setupValidation || null,
    reason: trade.reason
  };
}

function paperCandidateView(pair) {
  const reasons = [];
  if (pair.mtfDirection === 'SHORT') reasons.push('MTF bearish -> kandidat SHORT pullback');
  else if (pair.mtfDirection === 'LONG') reasons.push('MTF bullish -> kandidat LONG pullback');
  else if (pair.chg < 0) reasons.push('24H turun -> konteks bearish');
  else if (pair.chg > 0) reasons.push('24H naik -> konteks bullish');
  if (pair.fund < 0) reasons.push('funding negatif');
  if (pair.oi > 0) reasons.push('OI meningkat ' + pair.oi.toFixed(2) + '%');
  if (pair.oiUSD > 0 && !pair.oiReady) reasons.push('OI baseline tersimpan; delta menunggu scan berikutnya');
  if (Math.abs(pair.chg) <= 2) reasons.push('pergerakan belum terlalu extended');
  if (pair.volumeRatio >= 1.5) reasons.push('volume ' + pair.volumeRatio.toFixed(2) + 'x median');
  if (pair.volumeRatio != null && pair.volumeRatio < 1) reasons.push('volume di bawah median');
  if (!pair.oiReady) reasons.push('OI belum punya baseline pembanding');
  if (pair.mtf) {
    ['H4', 'H1', 'M30', 'M15'].forEach(tf => {
      const item = pair.mtf[tf];
      if (item && item.direction !== 'NEUTRAL') {
        reasons.push(tf + ' ' + item.direction + (item.strengthPct ? ' (' + item.strengthPct + '%)' : ''));
      } else if (item && item.status !== 'FULL') {
        reasons.push(tf + ' data tidak lengkap');
      }
    });
  }
  if (pair.confluencePct != null) reasons.push('confluence ' + pair.confluencePct + '%');
  if (pair.mtfStatus && pair.mtfStatus !== 'FULL') reasons.push('MTF ' + pair.mtfStatus);
  if (pair.mtf && pair.mtf.M15 && pair.mtf.M15.indicators) {
    const m15 = pair.mtf.M15.indicators;
    if (m15.rsi != null) reasons.push('RSI 15M ' + m15.rsi);
    if (m15.stochRsiK != null && m15.stochRsiD != null) {
      reasons.push('Stoch RSI K/D ' + m15.stochRsiK + '/' + m15.stochRsiD);
    }
    if (m15.supertrend) reasons.push('Supertrend 15M ' + m15.supertrend);
    if (m15.candlePattern && m15.candlePattern !== 'NONE') {
      reasons.push('candle ' + m15.candlePattern);
    }
  }
  return {
    sym: pair.sym, price: pair.price, chg: pair.chg, volume: pair.volume,
    volumeRatio: pair.volumeRatio, oiReady: !!pair.oiReady,
    fundingAvailable: !!pair.fundingAvailable, oiAvailable: !!pair.oiAvailable,
    volumeAvailable: !!pair.volumeAvailable,
    fund: pair.fund, oi: pair.oi, score: pair.sc, tier: pair.tier,
    sig: pair.sig, rank: pair.rank, direction: pair.mtfDirection || 'NEUTRAL',
    signalMode: pair.signalMode || PAPER_SIGNAL_MODE,
    signalScores: pair.signalScores || null,
    dataAt: pair.dataAt || null, source: pair.source || 'Bitget Futures',
    mtf: pair.mtf || null, dataQuality: pair.dataQuality || 'PARTIAL',
    scoreBreakdown: pair.scoreBreakdown || null, mtfAvailable: pair.mtfAvailable || 0,
    mtfStatus: pair.mtfStatus || 'UNAVAILABLE', mtfDirection: pair.mtfDirection || 'NEUTRAL',
    mtfAlignment: pair.mtfAlignment || 0, confluencePct: pair.confluencePct || 0,
    mtfSummary: pair.mtfSummary || null, support: pair.support || null,
    resistance: pair.resistance || null, atr: pair.atr || null,
    dataQualityReason: pair.dataQualityReason || null,
    evidence: reasons
  };
}

async function fetchPaperCandles(sym, granularity) {
  const target = APIS['/bitget'] +
    '/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=' +
    encodeURIComponent(sym + 'USDT') + '&granularity=' +
    encodeURIComponent(granularity) + '&limit=' + PAPER_CANDLE_LIMIT;
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
  const rows = payload.data.map(row => ({
    ts: paperTimestamp(row[0]), open: Number(row[1]), high: Number(row[2]),
    low: Number(row[3]), close: Number(row[4]),
    volume: Number(row[6] || row[5] || 0)
  })).filter(row => row.open > 0 && row.high > 0 && row.low > 0 && row.close > 0)
    .sort((a, b) => a.ts - b.ts);
  rows._nexoraFetchedAt = new Date().toISOString();
  return rows;
}

function paperTimeframeEvidence(rows, timeframe) {
  const indicators = paperIndicatorSnapshot(rows);
  if (!indicators) {
    return {
      timeframe, direction: 'NEUTRAL', verdict: 'NO_DATA',
      status: Array.isArray(rows) && rows.length ? 'PARTIAL' : 'UNAVAILABLE',
      sampleSize: Array.isArray(rows) ? rows.length : 0, indicators: null,
      fetchedAt: rows && rows._nexoraFetchedAt || null
    };
  }
  const last = rows[rows.length - 1];
  const ageMs = last && last.ts ? Math.max(0, Date.now() - last.ts) : null;
  const maxAgeMs = PAPER_TIMEFRAME_MAX_AGE_MS[timeframe] || 60 * 60 * 1000;
  const stale = ageMs != null && ageMs > maxAgeMs;
  return {
    timeframe, direction: indicators.direction,
    verdict: stale ? 'STALE' : indicators.direction === 'NEUTRAL' ? 'WAIT' : 'CONFIRM',
    status: stale ? 'STALE' : 'FULL', sampleSize: indicators.sampleSize,
    strengthPct: indicators.strengthPct, change: indicators.change,
    candleAt: indicators.candleAt, support: indicators.support,
    resistance: indicators.resistance, atr: indicators.atr, atrPct: indicators.atrPct,
    volumeRatio: indicators.volumeRatio, indicators: indicators.indicators,
    fetchedAt: rows._nexoraFetchedAt || null,
    ageSec: ageMs == null ? null : Math.round(ageMs / 1000),
    maxAgeSec: Math.round(maxAgeMs / 1000),
    freshness: stale ? 'STALE' : 'FRESH'
  };
}

function paperMtfSummary(mtf) {
  const names = ['H4', 'H1', 'M30', 'M15'];
  const available = names.map(name => mtf[name]).filter(item => item && item.status === 'FULL');
  const staleCount = names.filter(name => mtf[name] && mtf[name].status === 'STALE').length;
  const partialCount = names.filter(name => mtf[name] && mtf[name].status === 'PARTIAL').length;
  const longCount = available.filter(item => item.direction === 'LONG').length;
  const shortCount = available.filter(item => item.direction === 'SHORT').length;
  const alignmentCount = Math.max(longCount, shortCount);
  const direction = alignmentCount >= PAPER_MTF_MIN_ALIGNMENT && longCount !== shortCount
    ? (longCount > shortCount ? 'LONG' : 'SHORT') : 'NEUTRAL';
  const alignmentPct = available.length ? alignmentCount / names.length * 100 : 0;
  const higher = [mtf.H4, mtf.H1].filter(item => item && item.status === 'FULL');
  const higherAligned = direction !== 'NEUTRAL' && higher.length === 2 &&
    higher.every(item => item.direction === direction);
  const triggerAligned = direction !== 'NEUTRAL' && mtf.M15 && mtf.M15.direction === direction;
  const averageStrength = available.length
    ? paperMean(available.map(item => item.strengthPct || 0)) : 0;
  const confluencePct = Math.round(paperClamp(
    PAPER_SIGNAL_MODE === 'CLASSIC'
      ? alignmentPct * 0.8 + averageStrength * 0.2
      : alignmentPct * 0.7 + (triggerAligned ? 10 : 0) + (higherAligned ? 8 : 0) +
        averageStrength * 0.1, 0, 100));
  return {
    direction, available: available.length, alignmentCount,
    longCount, shortCount, confluencePct,
    higherAligned, triggerAligned,
    staleCount, partialCount,
    mode: PAPER_SIGNAL_MODE,
    status: available.length === names.length ? 'FULL' : staleCount ? 'STALE'
      : available.length ? 'PARTIAL' : 'UNAVAILABLE'
  };
}

function paperSignalScores(pair, summary) {
  const trigger = pair.mtf && pair.mtf.M15;
  const trend = Math.round(paperClamp(summary.alignmentCount * 5 +
    (summary.higherAligned ? 10 : 0), 0, 30));
  const momentum = Math.round(paperClamp(
    ((trigger && trigger.strengthPct) || 0) * 0.25, 0, 25));
  const fundingAligned = pair.mtfDirection === 'LONG' ? pair.fund <= 0
    : pair.mtfDirection === 'SHORT' ? pair.fund >= 0 : false;
  const derivatives = Math.round(paperClamp(
    (pair.fundingAvailable ? (fundingAligned ? 15 : 8) : 0) +
      (pair.oiAvailable ? (pair.oi > 0 ? 5 : 2) : 0), 0, 20));
  const volume = Math.round(paperClamp((pair.volumeRatio || 0) / 2 * 15, 0, 15));
  const risk = pair.dataQuality === 'FULL' ? 8 : 0;
  return {
    trend, momentum, derivatives, volume, risk,
    total: trend + momentum + derivatives + volume + risk,
    max: {trend: 30, momentum: 25, derivatives: 20, volume: 15, risk: 10, total: 100}
  };
}

function applyPaperMtf(pair) {
  const summary = paperMtfSummary(pair.mtf || {});
  pair.mtfAvailable = summary.available;
  pair.mtfStatus = summary.status;
  pair.mtfDirection = summary.direction;
  pair.mtfAlignment = summary.alignmentCount;
  pair.confluencePct = summary.confluencePct;
  pair.mtfSummary = summary;
  pair.signalMode = PAPER_SIGNAL_MODE;
  const qualityReasons = [];
  if (summary.status !== 'FULL') qualityReasons.push('MTF ' + summary.status);
  if (!pair.oiAvailable) qualityReasons.push('OI tidak tersedia');
  else if (!pair.oiReady) qualityReasons.push('menunggu baseline OI');
  if (!pair.fundingAvailable) qualityReasons.push('funding tidak tersedia');
  if (!pair.volumeAvailable || pair.volume <= 0) qualityReasons.push('volume tidak tersedia');
  pair.dataQuality = summary.status === 'FULL' && pair.oiReady && pair.oiAvailable &&
    pair.fundingAvailable && pair.volumeAvailable && pair.volume > 0
    ? 'FULL' : summary.status === 'STALE' ? 'STALE'
      : summary.status === 'UNAVAILABLE' ? 'REJECTED' : 'PARTIAL';
  pair.dataQualityReason = qualityReasons.join('; ') || null;
  pair.signalScores = paperSignalScores(pair, summary);
  const context = pair.contextScoreBreakdown || paperScoreDetails(
    pair.chg, pair.fund, pair.oi, pair.oiReady, pair.volumeRatio);
  const mtfScore = summary.confluencePct / 100 * 12;
  const total = Number((context.total * 0.45 + mtfScore * 0.55).toFixed(1));
  pair.scoreBreakdown = {
    ...context,
    mtf: Number(mtfScore.toFixed(1)),
    confluencePct: summary.confluencePct,
    mtfAlignment: summary.alignmentCount,
    signalScores: pair.signalScores,
    dataQuality: pair.dataQuality,
    total: Math.min(12, total)
  };
  pair.sc = pair.scoreBreakdown.total;
  pair.tier = paperTier(pair.sc);
  pair.rank = Number((pair.sc * 0.5 + summary.confluencePct * 0.05 +
    (pair.dataQuality === 'FULL' ? 0.5 : 0)).toFixed(3));
  return pair;
}

async function enrichPaperMtf(pair) {
  // Fetch a symbol's timeframes in sequence. The batch worker pool below keeps
  // the overall request rate bounded while retaining useful parallelism across
  // symbols.
  const rowsByTimeframe = [];
  for (const granularity of ['4H', '1H', '30m', '15m']) {
    rowsByTimeframe.push(await fetchPaperCandles(pair.sym, granularity).catch(() => []));
  }
  pair.mtf = {
    H4: paperTimeframeEvidence(rowsByTimeframe[0], 'H4'),
    H1: paperTimeframeEvidence(rowsByTimeframe[1], 'H1'),
    M30: paperTimeframeEvidence(rowsByTimeframe[2], 'M30'),
    M15: paperTimeframeEvidence(rowsByTimeframe[3], 'M15')
  };
  const trigger = pair.mtf.M15;
  pair.support = trigger.support || null;
  pair.resistance = trigger.resistance || null;
  pair.atr = trigger.atr || null;
  pair.atrPct = trigger.atrPct || null;
  return applyPaperMtf(pair);
}

async function enrichPaperMtfBatch(pairs) {
  // Limit the number of symbols processed concurrently so a scan cannot open
  // an unbounded burst against Bitget.
  let cursor = 0;
  const workers = Array.from({length: Math.min(PAPER_MTF_CONCURRENCY, pairs.length)}, async () => {
    while (cursor < pairs.length) {
      const pair = pairs[cursor++];
      await enrichPaperMtf(pair);
    }
  });
  await Promise.all(workers);
  return pairs;
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
    let ranked = buildPaperPairs(payload);
    // MTF is part of eligibility, not a post-selection decoration. Enrich the
    // strongest market-context candidates before choosing the three orders.
    const mtfCandidates = ranked.slice(0, PAPER_MTF_MAX_CANDIDATES);
    await enrichPaperMtfBatch(mtfCandidates);
    ranked = mtfCandidates.sort((a, b) => b.rank - a.rank);
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
      if (pair.mtfStatus !== 'FULL') {
        rejected.push({sym: pair.sym, reasons: ['MTF data ' + (pair.mtfStatus || 'UNAVAILABLE')]});
        continue;
      }
      if (pair.mtfDirection === 'NEUTRAL') {
        rejected.push({sym: pair.sym, reasons: ['MTF tidak memiliki arah dominan']});
        continue;
      }
      if (!pair.mtfSummary || !pair.mtfSummary.higherAligned || !pair.mtfSummary.triggerAligned) {
        rejected.push({sym: pair.sym, reasons: ['timeframe besar atau trigger 15M berlawanan']});
        continue;
      }
      if ((pair.mtfAlignment || 0) < PAPER_MTF_MIN_ALIGNMENT ||
          (pair.confluencePct || 0) < PAPER_MIN_CONFLUENCE) {
        rejected.push({sym: pair.sym, reasons: [
          'konfluensi MTF ' + (pair.confluencePct || 0) + '% di bawah ' + PAPER_MIN_CONFLUENCE + '%'
        ]});
        continue;
      }
      if (pair.dataQuality !== 'FULL') {
        rejected.push({sym: pair.sym, reasons: ['data quality ' + pair.dataQuality]});
        continue;
      }
      const setup = paperSetup(pair);
      const setupValidation = validatePaperSetup(pair, setup);
      if (!setupValidation.ok) {
        rejected.push({sym: pair.sym, reasons: setupValidation.reasons});
        continue;
      }
      selected.push({pair, setup, setupValidation});
      activeSymbols.set(pair.sym, (activeSymbols.get(pair.sym) || 0) + 1);
    }
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
        timeframe: '15M', tf: '15M', mode: PAPER_SIGNAL_MODE,
        signalMode: PAPER_SIGNAL_MODE, dataQuality: pair.dataQuality,
        dataAt: pair.dataAt, source: pair.source,
        confluencePct: pair.confluencePct, mtfDirection: pair.mtfDirection,
        mtfAlignment: pair.mtfAlignment, mtfSummary: pair.mtfSummary,
        dataQualityReason: pair.dataQualityReason || null,
        indicators: pair.mtf && pair.mtf.M15 ? pair.mtf.M15.indicators : null,
        candlePattern: pair.mtf && pair.mtf.M15 ? pair.mtf.M15.indicators && pair.mtf.M15.indicators.candlePattern : null,
        signalScores: pair.signalScores || null,
        support: pair.support, resistance: pair.resistance, structureSupport: setup.structureSupport,
        structureResistance: setup.structureResistance, atr: setup.atr || pair.atr,
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
    const hasMtfEligible = ranked.some(pair => pair.mtfStatus === 'FULL' &&
      pair.mtfDirection !== 'NEUTRAL' && pair.mtfAlignment >= PAPER_MTF_MIN_ALIGNMENT &&
      pair.confluencePct >= PAPER_MIN_CONFLUENCE && pair.dataQuality === 'FULL' &&
      pair.mtfSummary && pair.mtfSummary.higherAligned && pair.mtfSummary.triggerAligned);
    const blockReason = !capacity
      ? (paperActiveCount() >= PAPER_MAX_ACTIVE ? 'MAX_ACTIVE_REACHED'
        : activeRisk >= riskBudget ? 'RISK_BUDGET_REACHED' : 'NO_CAPACITY')
      : (!placed.length ? (hasMtfEligible ? 'NO_VALID_UNALLOCATED_SETUP' : 'NO_VALID_MTF_SETUP') :
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
    // Order-bearing scans are always reported. Empty-scan summaries are an
    // explicit opt-in because they create a recurring message every 15 minutes.
    if (placed.length || TELEGRAM_SCAN_SUMMARY) {
      void sendTelegramMessage(paperScanAlert(cycleKey, placed));
    }
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
  const stats = paperStats();
  const blockReason = paperState.lastBlockReason ||
    (availableSlots <= 0 ? 'MAX_ACTIVE_REACHED' : availableRisk < equity * PAPER_RISK_PCT / 100
      ? 'RISK_BUDGET_REACHED' : null);
  return {
    ok: true, service: 'nexora-paper-bot', enabled: paperState.enabled,
    running: paperStarted, interval: '15M', perScan: PAPER_PER_SCAN,
    pendingTtlMinutes: PAPER_PENDING_TTL_MS / 60000, maxConcurrent: PAPER_MAX_ACTIVE,
    maxPerSymbol: PAPER_MAX_PER_SYMBOL,
    candleLimit: PAPER_CANDLE_LIMIT, mtfMinAlignment: PAPER_MTF_MIN_ALIGNMENT,
    minConfluence: PAPER_MIN_CONFLUENCE, signalMode: PAPER_SIGNAL_MODE,
    mtfCandidates: PAPER_MTF_MAX_CANDIDATES,
    freshnessMaxAgeSec: Object.fromEntries(Object.entries(PAPER_TIMEFRAME_MAX_AGE_MS)
      .map(([tf, ms]) => [tf, Math.round(ms / 1000)])),
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
      scanSummary: TELEGRAM_SCAN_SUMMARY,
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
    stats: stats.metrics,
    statsSample: stats.sample,
    summary: {
      open, pending, closed: closed.length, wins, losses,
      invalidated: paperState.invalidatedTrades.length,
      netR: Number(netR.toFixed(2)),
      equity: Number(equity.toFixed(2))
    }
  };
}

function paperHistoryFilters(query) {
  const params = query || new URLSearchParams();
  return {
    symbol: String(params.get('symbol') || params.get('sym') || '').trim().toUpperCase(),
    timeframe: String(params.get('timeframe') || params.get('tf') || '').trim().toUpperCase(),
    outcome: String(params.get('outcome') || '').trim().toUpperCase(),
    from: String(params.get('from') || '').trim(),
    to: String(params.get('to') || '').trim()
  };
}

function paperHistoryMatches(trade, filters) {
  if (filters.symbol && String(trade.sym || '').toUpperCase() !== filters.symbol) return false;
  if (filters.timeframe && String(trade.timeframe || trade.tf || '').toUpperCase() !== filters.timeframe) return false;
  if (filters.outcome && String(trade.outcome || '').toUpperCase() !== filters.outcome) return false;
  const rawDate = trade.closedAt || trade.createdAt || '';
  const date = typeof rawDate === 'number' || /^\d+$/.test(String(rawDate))
    ? new Date(Number(rawDate)).toISOString().slice(0, 10)
    : String(rawDate).slice(0, 10);
  if (filters.from && (!date || date < filters.from)) return false;
  if (filters.to && (!date || date > filters.to)) return false;
  return true;
}

function paperGroupStats(trades, keyFn) {
  const groups = {};
  trades.forEach(trade => {
    const key = keyFn(trade) || 'UNKNOWN';
    if (!groups[key]) groups[key] = {key, trades: 0, wins: 0, losses: 0, netR: 0, pnl: 0};
    const group = groups[key];
    group.trades += 1;
    if (trade.outcome === 'WIN') group.wins += 1;
    if (trade.outcome === 'LOSS') group.losses += 1;
    group.netR += paperNumber(trade.r);
    group.pnl += paperNumber(trade.pnl);
  });
  return Object.values(groups).map(group => ({
    ...group,
    netR: Number(group.netR.toFixed(2)),
    pnl: Number(group.pnl.toFixed(2)),
    winRate: group.trades ? Number((group.wins / group.trades * 100).toFixed(1)) : 0
  })).sort((a, b) => b.netR - a.netR);
}

function paperStats(query) {
  const filters = paperHistoryFilters(query);
  const all = paperState.closedTrades.slice(0, PAPER_MAX_CLOSED_TRADES)
    .filter(trade => paperHistoryMatches(trade, filters));
  const cancelled = all.filter(trade => trade.outcome === 'CANCELLED');
  const expired = cancelled.filter(trade => String(trade.closeReason || '').toLowerCase().includes('expired'));
  const closed = all.filter(trade => trade.outcome !== 'CANCELLED');
  const chronological = closed.slice().sort((a, b) => {
    const at = Date.parse(a.closedAt || '') || Number(a.createdAt) || 0;
    const bt = Date.parse(b.closedAt || '') || Number(b.createdAt) || 0;
    return at - bt;
  });
  const wins = closed.filter(trade => paperNumber(trade.r) > 0);
  const losses = closed.filter(trade => paperNumber(trade.r) < 0);
  const grossProfitR = wins.reduce((sum, trade) => sum + paperNumber(trade.r), 0);
  const grossLossR = losses.reduce((sum, trade) => sum + paperNumber(trade.r), 0);
  const netR = closed.reduce((sum, trade) => sum + paperNumber(trade.r), 0);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  chronological.forEach(trade => {
    cumulative += paperNumber(trade.r);
    peak = Math.max(peak, cumulative);
    maxDrawdownR = Math.max(maxDrawdownR, peak - cumulative);
  });
  const filled = closed.filter(trade => trade.openedAt);
  const fillTimes = filled.map(trade => Math.max(0,
    (Date.parse(trade.openedAt) || 0) - (Number(trade.createdAt) || Date.parse(trade.createdAt) || 0)))
    .filter(value => value > 0);
  const durations = closed.map(trade => {
    const start = Date.parse(trade.openedAt || '');
    const end = Date.parse(trade.closedAt || '');
    return start && end ? Math.max(0, end - start) : 0;
  }).filter(value => value > 0);
  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const profitFactor = grossLossR < 0 ? grossProfitR / Math.abs(grossLossR) : null;
  return {
    ok: true,
    asOf: new Date().toISOString(),
    filters: {...filters, symbol: filters.symbol || 'all', timeframe: filters.timeframe || 'all', outcome: filters.outcome || 'all'},
    sample: {
      orders: all.length, closed: closed.length, filled: filled.length,
      pendingExpired: expired.length, cancelled: cancelled.length,
      wins: wins.length, losses: losses.length,
      breakeven: closed.filter(trade => paperNumber(trade.r) === 0).length
    },
    metrics: {
      winRate: closed.length ? Number((wins.length / closed.length * 100).toFixed(1)) : 0,
      netR: Number(netR.toFixed(2)),
      expectancyR: closed.length ? Number((netR / closed.length).toFixed(3)) : 0,
      profitFactor: profitFactor == null ? null : Number(profitFactor.toFixed(2)),
      maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
      grossProfitR: Number(grossProfitR.toFixed(2)),
      grossLossR: Number(grossLossR.toFixed(2)),
      pnl: Number(closed.reduce((sum, trade) => sum + paperNumber(trade.pnl), 0).toFixed(2)),
      fillRate: all.length ? Number((filled.length / all.length * 100).toFixed(1)) : 0,
      averageTimeToFillMs: Math.round(average(fillTimes)),
      averageDurationMs: Math.round(average(durations)),
      averageMfePnl: Number(average(closed.map(trade => paperNumber(trade.mfePnl))).toFixed(2)),
      averageMaePnl: Number(average(closed.map(trade => paperNumber(trade.maePnl))).toFixed(2))
    },
    bySymbol: paperGroupStats(closed, trade => trade.sym),
    byDirection: paperGroupStats(closed, trade => trade.dir),
    byTimeframe: paperGroupStats(closed, trade => trade.timeframe || trade.tf),
    byMode: paperGroupStats(closed, trade => trade.signalMode || trade.mode),
    byScore: paperGroupStats(closed, trade => {
      const score = paperNumber(trade.score);
      return score >= 8 ? '8-12' : score >= 6.5 ? '6.5-7.9' : '<6.5';
    }),
    closeReasons: paperGroupStats(closed, trade => trade.closeReason || 'UNKNOWN')
  };
}

function paperHistory(query) {
  const filters = paperHistoryFilters(query);
  const all = paperState.closedTrades.slice(0, PAPER_MAX_CLOSED_TRADES);
  const closedTrades = all.filter(trade => paperHistoryMatches(trade, filters));
  return {
    ok: true,
    closedTrades,
    invalidatedTrades: paperState.invalidatedTrades.slice(0, 100),
    filters: {symbol: filters.symbol || 'all', timeframe: filters.timeframe || 'all',
      outcome: filters.outcome || 'all', from: filters.from, to: filters.to},
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
      scanSummary: TELEGRAM_SCAN_SUMMARY,
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
  if (requestUrl.pathname === '/paper/stats') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    send(res, 200, JSON.stringify(paperStats(requestUrl.searchParams)));
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
