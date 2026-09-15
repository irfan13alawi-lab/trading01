const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 18085);
const REQUEST_TIMEOUT_MS = 12000;
const PAPER_INTERVAL_MS = 15 * 60 * 1000;
const PAPER_SCAN_CHECK_MS = 15000;
const PAPER_MONITOR_MS = 30000;
const PAPER_MONITOR_CANDLE_LIMIT = 10;
const PAPER_PENDING_TTL_MS = 120 * 60 * 1000;
const PAPER_PER_SCAN = 3;
// The VPS bot uses the same intraday structure as the CryptoEx-style view:
// 4H/1H define the bias, 30M confirms the structure, and 15M is the trigger.
// Keep the candle request bounded so a 15-minute scan cannot overwhelm the
// upstream exchange API while still providing enough history for indicators.
const PAPER_CANDLE_LIMIT = Math.max(80, Math.min(250,
  Number.isFinite(Number(process.env.PAPER_CANDLE_LIMIT))
    ? Number(process.env.PAPER_CANDLE_LIMIT) : 120));
const PAPER_MIN_CANDLES = Math.max(100, Math.min(PAPER_CANDLE_LIMIT,
  Number.isFinite(Number(process.env.PAPER_MIN_CANDLES))
    ? Number(process.env.PAPER_MIN_CANDLES) : 100));
const PAPER_MTF_MIN_ALIGNMENT = Math.max(3, Math.min(4,
  Number.isFinite(Number(process.env.PAPER_MTF_MIN_ALIGNMENT))
    ? Number(process.env.PAPER_MTF_MIN_ALIGNMENT) : 3));
const PAPER_MIN_CONFLUENCE = Math.max(50, Math.min(95,
  Number.isFinite(Number(process.env.PAPER_MIN_CONFLUENCE))
    ? Number(process.env.PAPER_MIN_CONFLUENCE) : 60));
const PAPER_MIN_SIGNAL_SCORE = Math.max(50, Math.min(95,
  Number.isFinite(Number(process.env.PAPER_MIN_SIGNAL_SCORE))
    ? Number(process.env.PAPER_MIN_SIGNAL_SCORE) : 70));
const PAPER_SIGNAL_MODE = String(process.env.PAPER_SIGNAL_MODE || 'WEIGHTED').toUpperCase() === 'CLASSIC'
  ? 'CLASSIC' : 'WEIGHTED';
const PAPER_MTF_CONCURRENCY = Math.max(2, Math.min(12,
  Number.isFinite(Number(process.env.PAPER_MTF_CONCURRENCY))
    ? Number(process.env.PAPER_MTF_CONCURRENCY) : 6));
const PAPER_MTF_MAX_CANDIDATES = Math.max(8, Math.min(40,
  Number.isFinite(Number(process.env.PAPER_MTF_MAX_CANDIDATES))
    ? Number(process.env.PAPER_MTF_MAX_CANDIDATES) : 40));
const PAPER_MAX_ACTIVE = Math.max(3, Math.min(100,
  Number.isFinite(Number(process.env.PAPER_MAX_ACTIVE))
    ? Number(process.env.PAPER_MAX_ACTIVE) : 80));
const PAPER_MAX_PER_SYMBOL = Math.max(1, Math.min(3,
  Number.isFinite(Number(process.env.PAPER_MAX_PER_SYMBOL))
    ? Number(process.env.PAPER_MAX_PER_SYMBOL) : 1));
const PAPER_MIN_ENTRY_OFFSET_PCT = Math.max(0.05, Math.min(2,
  Number.isFinite(Number(process.env.PAPER_MIN_ENTRY_OFFSET_PCT))
    ? Number(process.env.PAPER_MIN_ENTRY_OFFSET_PCT) : 0.1));
const PAPER_MIN_RR = Math.max(1.5, Math.min(5,
  Number.isFinite(Number(process.env.PAPER_MIN_RR))
    ? Number(process.env.PAPER_MIN_RR) : 2));
const PAPER_SCHEMA_VERSION = 7;
// This is still paper-only sizing. The trial can keep up to 80 active records
// so a one-week sample is not starved by pending orders; live exchange keys
// are not used by this service. Existing legacy trades keep their sizing.
const PAPER_RISK_PCT = Math.max(0.1, Math.min(2,
  Number.isFinite(Number(process.env.PAPER_RISK_PCT))
    ? Number(process.env.PAPER_RISK_PCT) : 0.5));
const PAPER_MAX_ACTIVE_RISK_PCT = Math.max(5, Math.min(50,
  Number.isFinite(Number(process.env.PAPER_MAX_ACTIVE_RISK_PCT))
    ? Number(process.env.PAPER_MAX_ACTIVE_RISK_PCT) : 40));
const PAPER_MAX_DIRECTION_RISK_PCT = Math.max(2, Math.min(30,
  Number.isFinite(Number(process.env.PAPER_MAX_DIRECTION_RISK_PCT))
    ? Number(process.env.PAPER_MAX_DIRECTION_RISK_PCT) : 20));
const PAPER_MAX_PER_DIRECTION = Math.max(1, Math.min(80,
  Number.isFinite(Number(process.env.PAPER_MAX_PER_DIRECTION))
    ? Number(process.env.PAPER_MAX_PER_DIRECTION) : 40));
const PAPER_MAX_HIGH_CORR_POSITIONS = Math.max(2, Math.min(80,
  Number.isFinite(Number(process.env.PAPER_MAX_HIGH_CORR_POSITIONS))
    ? Number(process.env.PAPER_MAX_HIGH_CORR_POSITIONS) : 80));
const PAPER_MAX_DAILY_LOSS_R = Math.max(1, Math.min(20,
  Number.isFinite(Number(process.env.PAPER_MAX_DAILY_LOSS_R))
    ? Number(process.env.PAPER_MAX_DAILY_LOSS_R) : 3));
// Automatic entry guard based on the strict trial equity peak. Existing
// paper positions continue to be monitored; only new entries are blocked.
const PAPER_MAX_DRAWDOWN_PCT = Math.max(0.5, Math.min(50,
  Number.isFinite(Number(process.env.PAPER_MAX_DRAWDOWN_PCT))
    ? Number(process.env.PAPER_MAX_DRAWDOWN_PCT) : 2.5));
const PAPER_TP1_CLOSE_PCT = Math.max(10, Math.min(90,
  Number.isFinite(Number(process.env.PAPER_TP1_CLOSE_PCT))
    ? Number(process.env.PAPER_TP1_CLOSE_PCT) : 50));
const PAPER_STRATEGY_VERSION = String(process.env.PAPER_STRATEGY_VERSION || 'MTF_ATR_V2');
const PAPER_DEFAULT_COHORT_ID = String(process.env.PAPER_COHORT_ID ||
  ('trial-' + new Date().toISOString().slice(0, 10)));
const PAPER_STRATEGY_KEYS = ['MTF_ATR_V2', 'PRE_UPGRADE', 'LEGACY'];
const PAPER_DEFAULT_STRATEGY_SETTINGS = {
  MTF_ATR_V2: {enabled: true, maxActive: PAPER_MAX_ACTIVE, riskPct: PAPER_RISK_PCT, minRR: PAPER_MIN_RR, slPct: 0, tp1R: 2, tp2R: 3},
  PRE_UPGRADE: {enabled: false, maxActive: 10, riskPct: PAPER_RISK_PCT, minRR: PAPER_MIN_RR, slPct: 3, tp1R: 2, tp2R: 3},
  LEGACY: {enabled: false, maxActive: 0, riskPct: PAPER_RISK_PCT, minRR: PAPER_MIN_RR, slPct: 3, tp1R: 2, tp2R: 3}
};
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
const PAPER_FALLBACK_ENABLED = String(process.env.PAPER_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false';
const PAPER_WATCHLIST_ALERTS_ENABLED = String(process.env.PAPER_WATCHLIST_ALERTS || '').toLowerCase() === 'true';
// This service is paper-only, but the operational endpoints can still pause
// the bot or create/close paper records. A token is mandatory before any
// state-changing endpoint is enabled; never leave the dashboard controls
// unauthenticated when the VPS is reachable from the public internet.
const PAPER_ADMIN_TOKEN = String(process.env.PAPER_ADMIN_TOKEN || '').trim();
const DISCORD_WEBHOOK_URL = String(process.env.DISCORD_WEBHOOK_URL || '').trim();
// Daily summaries are available as a VPS scheduler, but remain opt-in so a
// deployment never starts recurring outbound notifications unexpectedly.
const PAPER_DAILY_SUMMARY_SCHEDULER = String(process.env.PAPER_DAILY_SUMMARY_SCHEDULER || '').toLowerCase() === 'true';
const PAPER_STATE_FILE = process.env.PAPER_STATE_FILE ||
  path.join(__dirname, 'paper-bot-state.json');
const PAPER_STATE_BACKUP_FILE = PAPER_STATE_FILE + '.bak';
const PAPER_STATE_BACKUP_2_FILE = PAPER_STATE_FILE + '.bak2';
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
  '/cryptocompare': 'https://www.coindesk.com',
  '/coinpaprika': 'https://api.coinpaprika.com',
  '/binance': 'https://fapi.binance.com',
  '/okx': 'https://www.okx.com',
  '/macro': 'https://nfs.faireconomy.media'
};

const sourceHealth = {};
Object.keys(APIS).forEach(prefix => {
  sourceHealth[prefix.slice(1)] = {
    status: 'UNKNOWN', lastAttemptAt: null, lastOkAt: null,
    lastErrorAt: null, lastLatencyMs: null, lastHttpStatus: null,
    lastPath: null, lastError: null, requestCount: 0, paths: {}
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

// Runtime counters are intentionally kept in memory. They describe the
// current service process; trade history and cohort results remain durable in
// paper-bot-state.json.
const paperRuntime = {
  startedAt: null,
  scanAttempts: 0,
  scansSucceeded: 0,
  scansFailed: 0,
  lastScanStartedAt: null,
  lastScanCompletedAt: null,
  lastScanErrorAt: null,
  lastScanError: null,
  monitorAttempts: 0,
  monitorsSucceeded: 0,
  monitorsFailed: 0,
  lastMonitorAt: null,
  lastMonitorErrorAt: null,
  lastMonitorError: null,
  rejectionCounts: {}
};

const cache = new Map();
const prefixes = Object.keys(APIS).sort((a, b) => b.length - a.length);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
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
  item.requestCount += 1;
  if (result.path) {
    const pathItem = item.paths[result.path] || {
      requestCount: 0, lastAttemptAt: null, lastOkAt: null,
      lastErrorAt: null, lastLatencyMs: null, lastHttpStatus: null, lastError: null
    };
    pathItem.requestCount += 1;
    pathItem.lastAttemptAt = now;
    pathItem.lastLatencyMs = result.latencyMs;
    pathItem.lastHttpStatus = result.status;
    if (result.status >= 200 && result.status < 300) {
      pathItem.lastOkAt = now;
      pathItem.lastError = null;
    } else {
      pathItem.lastErrorAt = now;
      pathItem.lastError = result.status === 429 ? 'HTTP 429 (rate limited)' : 'HTTP ' + result.status;
    }
    item.paths[result.path] = pathItem;
  }
  if (result.status >= 200 && result.status < 300) {
    item.status = 'LIVE';
    item.lastOkAt = now;
    item.lastError = null;
  } else {
    item.status = result.status === 429 ? 'RATE_LIMITED' : 'ERROR';
    item.lastErrorAt = now;
    item.lastError = result.status === 429 ? 'HTTP 429 (rate limited)' : 'HTTP ' + result.status;
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
  item.requestCount += 1;
  if (pathName) {
    const pathItem = item.paths[pathName] || {
      requestCount: 0, lastAttemptAt: null, lastOkAt: null,
      lastErrorAt: null, lastLatencyMs: null, lastHttpStatus: null, lastError: null
    };
    pathItem.requestCount += 1;
    pathItem.lastAttemptAt = now;
    pathItem.lastErrorAt = now;
    pathItem.lastError = error.message;
    item.paths[pathName] = pathItem;
  }
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
      displayStatus: (item.status === 'LIVE' && ageSec != null && ageSec > 180) ||
        (item.status === 'RATE_LIMITED' && item.lastOkAt)
        ? 'DELAYED' : item.status
    }];
  }));
}

function cacheTtl(prefix, pathname) {
  if (prefix === '/cryptocompare') return pathname.includes('/news/') ? 1800000 : 120000;
  if (prefix === '/coingecko') {
    return pathname.includes('/ohlc') || pathname.includes('/market_chart') ? 300000 : 30000;
  }
  if (pathname.includes('/candles')) return 60000;
  if (pathname.includes('/tickers')) return 5000;
  return 5000;
}

const CRYPTOCOMPARE_API_KEY = String(process.env.CRYPTOCOMPARE_API_KEY || '').trim();
const CRYPTOCOMPARE_NEWS_URL = 'https://min-api.cryptocompare.com/data/v2/news/?lang=EN' +
  (CRYPTOCOMPARE_API_KEY ? '&api_key=' + encodeURIComponent(CRYPTOCOMPARE_API_KEY) : '');
const NEWS_RSS_URL = 'https://www.coindesk.com/arc/outboundfeeds/rss/';

function decodeNewsXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .trim();
}

function newsXmlTag(block, name) {
  const expression = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i');
  const match = String(block || '').match(expression);
  return match ? decodeNewsXml(match[1]) : '';
}

function parseNewsRss(xml) {
  const items = [];
  const itemPattern = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemPattern.exec(String(xml || ''))) && items.length < 100) {
    const block = match[1];
    const title = newsXmlTag(block, 'title');
    const link = newsXmlTag(block, 'link') || newsXmlTag(block, 'guid');
    const pubDate = newsXmlTag(block, 'pubDate') || newsXmlTag(block, 'dc:date');
    const creator = newsXmlTag(block, 'dc:creator');
    const categories = [...block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
      .map(row => decodeNewsXml(row[1])).filter(Boolean).join(',');
    if (!title || !link) continue;
    const published = Date.parse(pubDate);
    items.push({
      ID: link, TITLE: title, URL: link,
      PUBLISHED_ON: Number.isFinite(published) ? Math.floor(published / 1000) : 0,
      SOURCE_DATA: {NAME: creator || 'CoinDesk'}, CATEGORY_DATA: categories
    });
  }
  return items;
}

function parseCryptoCompareNews(body, limit) {
  try {
    const payload = JSON.parse(String(body || ''));
    if (!payload || payload.Response === 'Error' || !Array.isArray(payload.Data)) return null;
    return {...payload, Data: payload.Data.slice(0, limit)};
  } catch (_) {
    return null;
  }
}

async function serveNewsFeed(requestUrl, res) {
  const key = '/cryptocompare' + requestUrl.pathname + requestUrl.search;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    send(res, hit.status, hit.body, hit.contentType);
    return;
  }
  const limitValue = Number(requestUrl.searchParams.get('limit') || 50);
  const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(50, Math.floor(limitValue))) : 50;
  let primaryError = null;
  let primary = null;
  let body = null;
  try {
    const startedAt = Date.now();
    primary = await requestUpstream(CRYPTOCOMPARE_NEWS_URL + '&limit=' + limit);
    primary.latencyMs = Date.now() - startedAt;
    primary.path = '/data/v2/news/';
    const parsed = primary.status >= 200 && primary.status < 300
      ? parseCryptoCompareNews(primary.body, limit) : null;
    if (parsed) body = JSON.stringify(parsed);
    markSourceHealth('/cryptocompare', primary);
    if (!parsed && primary.status >= 200 && primary.status < 300) {
      markSourceError('/cryptocompare', new Error('CryptoCompare response invalid'), primary.path);
    }
  } catch (error) {
    primaryError = error;
    markSourceError('/cryptocompare', error, '/data/v2/news/');
  }
  if (!body) {
    try {
      const startedAt = Date.now();
      const fallback = await requestUpstream(NEWS_RSS_URL);
      fallback.latencyMs = Date.now() - startedAt;
      fallback.path = '/arc/outboundfeeds/rss/';
      markSourceHealth('/cryptocompare', fallback);
      if (fallback.status < 200 || fallback.status >= 300) {
        send(res, fallback.status, JSON.stringify({error: 'News provider HTTP ' + fallback.status}));
        return;
      }
      body = JSON.stringify({Type: 100, Message: 'News list successfully returned', Provider: 'CoinDesk RSS fallback', Data: parseNewsRss(fallback.body).slice(0, limit)});
    } catch (error) {
      markSourceError('/cryptocompare', error, '/arc/outboundfeeds/rss/');
      send(res, 502, JSON.stringify({error: 'News provider unavailable', detail: error.message || (primaryError && primaryError.message) || 'unknown error'}));
      return;
    }
  }
  try {
    const cached = {status: 200, body, contentType: 'application/json', expiresAt: Date.now() + 1800000};
    cache.set(key, cached);
    send(res, cached.status, cached.body, cached.contentType);
  } catch (error) {
    send(res, 502, JSON.stringify({error: 'News provider unavailable', detail: error.message}));
  }
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

const discordState = {
  sent: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null
};

async function sendDiscordMessage(text) {
  if (!DISCORD_WEBHOOK_URL || !text) return false;
  discordState.lastAttemptAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchFn(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'User-Agent': 'NexoraPaperBot/1.0'},
      body: JSON.stringify({content: text.slice(0, 1900)}),
      signal: controller.signal
    });
    if (!response.ok) throw new Error('Discord HTTP ' + response.status);
    discordState.sent += 1;
    discordState.lastSuccessAt = new Date().toISOString();
    discordState.lastError = null;
    return true;
  } catch (error) {
    discordState.lastErrorAt = new Date().toISOString();
    discordState.lastError = error.message;
    console.error('[paper] Discord alert failed:', error.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function sendConfiguredAlert(text) {
  const results = await Promise.all([
    sendTelegramMessage(text),
    sendDiscordMessage(text)
  ]);
  return results.some(Boolean);
}

function sendRateLimitedAlert(key, text, cooldownMs) {
  const now = Date.now();
  const last = alertCooldowns.get(key) || 0;
  if (now - last < cooldownMs) return;
  alertCooldowns.set(key, now);
  void sendConfiguredAlert(text);
}

function paperRecordRejections(codes) {
  (Array.isArray(codes) ? codes : []).forEach(code => {
    if (!code) return;
    paperRuntime.rejectionCounts[code] = (paperRuntime.rejectionCounts[code] || 0) + 1;
  });
}

function paperReject(rejected, pair, codes, reasons) {
  const normalizedCodes = [...new Set((Array.isArray(codes) ? codes : []).filter(Boolean))];
  paperRecordRejections(normalizedCodes);
  rejected.push({
    sym: pair && pair.sym,
    codes: normalizedCodes,
    reasons: [...new Set((Array.isArray(reasons) ? reasons : []).filter(Boolean))]
  });
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

function paperPartialAlert(trade) {
  return 'NEXORA PAPER TP1 PARTIAL\n' +
    trade.sym + ' ' + trade.dir + ' @ ' + trade.tp1 +
    '\nClosed ' + trade.tp1ClosePct + '% | remaining ' + trade.remainingSize +
    '\nSL moved to breakeven';
}

function paperDailySummaryAlert(dateKey) {
  const summary = paperDailySummaryView(dateKey);
  return 'NEXORA PAPER DAILY SUMMARY ' + dateKey + '\n' +
    'Trades: ' + summary.trades + ' | Win/Loss: ' + summary.wins + '/' + summary.losses +
    '\nNet: ' + summary.netR.toFixed(2) + 'R | PnL: $' + summary.pnl.toFixed(2) +
    '\nEquity: $' + paperEquity().toFixed(2) + ' | Daily guard: ' +
    (paperDailyLossR() <= -paperSettings().maxDailyLossR ? 'ON' : 'OK');
}

function paperDailySummaryView(dateKey) {
  const key = dateKey || new Date().toISOString().slice(0, 10);
  const dayTrades = paperState.closedTrades.filter(trade =>
    paperIsTrialTrade(trade) && String(trade.closedAt || '').slice(0, 10) === key &&
    trade.outcome !== 'CANCELLED');
  const wins = dayTrades.filter(trade => paperNumber(trade.r) > 0).length;
  const losses = dayTrades.filter(trade => paperNumber(trade.r) < 0).length;
  const breakeven = dayTrades.filter(trade => paperNumber(trade.r) === 0).length;
  const netR = dayTrades.reduce((sum, trade) => sum + paperNumber(trade.r), 0);
  const pnl = dayTrades.reduce((sum, trade) => sum + paperNumber(trade.pnl), 0);
  return {
    date: key, trades: dayTrades.length, wins, losses, breakeven,
    netR: Number(netR.toFixed(2)), pnl: Number(pnl.toFixed(2)),
    equity: Number(paperEquity().toFixed(2)),
    dailyLossR: Number(paperDailyLossR().toFixed(2)),
    guard: paperDailyLossR() <= -paperSettings().maxDailyLossR
  };
}

function paperRiskGuardAlert(status, reason) {
  return 'NEXORA PAPER RISK GUARD\n' + reason +
    '\nActive risk: $' + Number(status.activeRisk || 0).toFixed(2) +
    ' / $' + Number(status.riskBudget || 0).toFixed(2) +
    '\nDaily R: ' + Number(status.dailyLossR || 0).toFixed(2) +
    ' / limit -' + Number(status.maxDailyLossR || 0).toFixed(2) + 'R' +
    '\nNew entries are being held until the guard clears.';
}

function maybeSendPaperOperationalAlerts() {
  const today = new Date().toISOString().slice(0, 10);
  const alertState = paperState.alertState || (paperState.alertState = {});
  const alertsConfigured = TELEGRAM_ALERTS_ENABLED || Boolean(DISCORD_WEBHOOK_URL);
  if (alertsConfigured && alertState.lastDailySummaryDate !== today) {
    alertState.lastDailySummaryDate = today;
    savePaperState();
    sendRateLimitedAlert('paper-daily-summary:' + today, paperDailySummaryAlert(today), 24 * 60 * 60 * 1000);
  }
  const status = paperStatus();
  const riskRatio = status.riskBudget > 0 ? status.activeRisk / status.riskBudget : 0;
  const reason = status.dailyGuard ? 'Daily loss limit reached: new entries paused.'
    : riskRatio >= 0.85 ? 'Active risk is at ' + Math.round(riskRatio * 100) + '% of the budget.' : null;
  if (reason) {
    const now = Date.now();
    const lastAt = Date.parse(alertState.lastRiskGuardAt || '') || 0;
    if (now - lastAt >= 30 * 60 * 1000) {
      alertState.lastRiskGuardAt = new Date(now).toISOString();
      savePaperState();
      sendRateLimitedAlert('paper-risk-guard:' + (status.dailyGuard ? 'daily' : 'risk'),
        paperRiskGuardAlert(status, reason), 30 * 60 * 1000);
    }
  }
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

function paperNormaliseWatchlistAlert(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const sym = String(raw.sym || raw.symbol || '').toUpperCase()
    .replace(/USDT$/, '').replace(/[^A-Z0-9]/g, '');
  if (!sym || !PAPER_SYMBOLS.includes(sym)) return null;
  const dir = ['LONG', 'SHORT'].includes(String(raw.dir || raw.direction || '').toUpperCase())
    ? String(raw.dir || raw.direction).toUpperCase() : null;
  const range = String(raw.entryRange || raw.entry || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [];
  const rawLow = Number(raw.entryLow);
  const rawHigh = Number(raw.entryHigh);
  const entryLow = Number.isFinite(rawLow) && rawLow > 0 ? rawLow : Number(range[0] || 0);
  const entryHigh = Number.isFinite(rawHigh) && rawHigh > 0 ? rawHigh : Number(range[1] || entryLow || 0);
  const alertPctRaw = Number(raw.alertPct);
  const alertPct = Number.isFinite(alertPctRaw) ? Math.max(0.1, Math.min(10, alertPctRaw)) : 3;
  return {
    sym, dir, entryLow: entryLow > 0 ? entryLow : null,
    entryHigh: entryHigh > 0 ? Math.max(entryLow || entryHigh, entryHigh) : null,
    alertPct: Number(alertPct.toFixed(2)),
    requestedAt: raw.requestedAt || new Date().toISOString(),
    lastAlertAt: raw.lastAlertAt || null
  };
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

function isUpgradedPaperTrade(trade) {
  return isStrictPaperTrade(trade) && trade &&
    String(trade.strategyVersion || '') === PAPER_STRATEGY_VERSION &&
    !!trade.cohortId && !!trade.signalCreatedAt &&
    trade.candleAtByTf && typeof trade.candleAtByTf === 'object' &&
    trade.signalScores && typeof trade.signalScores === 'object' &&
    trade.setupValidation && typeof trade.setupValidation === 'object' &&
    trade.dataQuality === 'FULL';
}

function paperTradeStrategyVersion(trade) {
  if (trade && trade.strategyVersion) return String(trade.strategyVersion);
  if (isUpgradedPaperTrade(trade)) return PAPER_STRATEGY_VERSION;
  return isStrictPaperTrade(trade) ? 'PRE_UPGRADE' : 'LEGACY';
}

function normalisePaperTrade(trade) {
  const next = {...trade};
  next.executionModel = paperExecutionModel(next);
  next.executionClass = isStrictPaperTrade(next) ? 'STRICT' : 'LEGACY';
  next.strategyVersion = paperTradeStrategyVersion(next);
  if (isStrictPaperTrade(next) && !isUpgradedPaperTrade(next)) {
    // Older LIMIT_STRICT records predate the explainable MTF signal schema.
    // Keep them visible and active, but never mix them into the new strategy
    // cohort's mode statistics.
    next.signalMode = 'PRE_UPGRADE';
  } else {
    next.signalMode = next.signalMode || (isStrictPaperTrade(next) ? 'WEIGHTED' : 'LEGACY');
  }
  next.cohortId = next.cohortId ||
    (next.strategyVersion === PAPER_STRATEGY_VERSION ? PAPER_DEFAULT_COHORT_ID : next.strategyVersion.toLowerCase());
  next.signalCreatedAt = next.signalCreatedAt ||
    (next.createdAt ? new Date(next.createdAt).toISOString() : null);
  next.mode = next.signalMode || next.mode;
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

function paperRoundPriceForPair(value, pair) {
  const number = paperNumber(value);
  const tickSize = paperNumber(pair && pair.tickSize);
  if (!number || !tickSize) return paperRoundPrice(number);
  const rounded = Math.round(number / tickSize) * tickSize;
  const pricePlace = Number(pair && pair.pricePlace);
  if (Number.isInteger(pricePlace) && pricePlace >= 0 && pricePlace <= 12) {
    return Number(rounded.toFixed(pricePlace));
  }
  let decimals = 0;
  for (; decimals < 12; decimals++) {
    const scaled = tickSize * Math.pow(10, decimals);
    if (Math.abs(scaled - Math.round(scaled)) < 1e-8) break;
  }
  return Number(rounded.toFixed(Math.min(12, decimals)));
}

function paperStrategySettingsDefaults() {
  return Object.fromEntries(PAPER_STRATEGY_KEYS.map(key => [key, {...PAPER_DEFAULT_STRATEGY_SETTINGS[key]}]));
}

function paperNormaliseStrategySettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const defaults = paperStrategySettingsDefaults();
  const clamp = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  return Object.fromEntries(PAPER_STRATEGY_KEYS.map(key => {
    const raw = source[key] && typeof source[key] === 'object' ? source[key] : {};
    const fallback = defaults[key];
    return [key, {
      enabled: raw.enabled == null ? fallback.enabled : (raw.enabled === true || raw.enabled === 'true'),
      maxActive: Math.round(clamp(raw.maxActive, fallback.maxActive, 0, 100)),
      riskPct: Number(clamp(raw.riskPct, fallback.riskPct, 0.1, 2).toFixed(2)),
      minRR: Number(clamp(raw.minRR, fallback.minRR, 1.5, 5).toFixed(2)),
      slPct: Number(clamp(raw.slPct, fallback.slPct, 0, 10).toFixed(2)),
      tp1R: Number(clamp(raw.tp1R, fallback.tp1R, 0.5, 10).toFixed(2)),
      tp2R: Number(clamp(raw.tp2R, fallback.tp2R, 0.5, 15).toFixed(2))
    }];
  }));
}

function defaultPaperState() {
  return {
    schemaVersion: PAPER_SCHEMA_VERSION,
    enabled: true,
    paused: false,
    killSwitch: false,
    settings: {
      perScan: PAPER_PER_SCAN,
      maxActive: PAPER_MAX_ACTIVE,
      maxPerSymbol: PAPER_MAX_PER_SYMBOL,
      riskPct: PAPER_RISK_PCT,
      maxDailyLossR: PAPER_MAX_DAILY_LOSS_R,
      minConfluence: PAPER_MIN_CONFLUENCE,
      minSignalScore: PAPER_MIN_SIGNAL_SCORE,
      minRR: PAPER_MIN_RR,
      tp1ClosePct: PAPER_TP1_CLOSE_PCT,
      strategyEnabled: true,
      strategySettings: paperStrategySettingsDefaults(),
      tradingHoursEnabled: false,
      tradingStartUtc: '00:00',
      tradingEndUtc: '23:59',
      whitelist: [],
      blacklist: []
    },
    startingEquity: PAPER_STARTING_EQUITY,
    equityPeak: PAPER_STARTING_EQUITY,
    strategyVersion: PAPER_STRATEGY_VERSION,
    cohortId: PAPER_DEFAULT_COHORT_ID,
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
    oiHistory: {},
    activeTrades: [],
    closedTrades: [],
    invalidatedTrades: [],
    recentScans: [],
    watchlistQueue: [],
    watchlistAlerts: [],
    alertState: {
      lastDailySummaryDate: null,
      lastRiskGuardAt: null
    }
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
    const previousSchemaVersion = Number(parsed.schemaVersion || 0);
    const freshState = defaultPaperState();
    const parsedSettings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
    const migratedStrategySettings = paperNormaliseStrategySettings(parsedSettings.strategySettings);
    // Preserve settings written by schema <=5 when introducing per-strategy
    // configuration. The active MTF worker remains exactly as configured.
    if (!parsedSettings.strategySettings) {
      const legacyNumber = (name, fallback, min, max) => {
        const value = Number(parsedSettings[name]);
        return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
      };
      migratedStrategySettings.MTF_ATR_V2 = {
        ...migratedStrategySettings.MTF_ATR_V2,
        enabled: parsedSettings.strategyEnabled !== false,
        maxActive: Math.round(legacyNumber('maxActive', PAPER_MAX_ACTIVE, 0, 100)),
        riskPct: Number(legacyNumber('riskPct', PAPER_RISK_PCT, 0.1, 2).toFixed(2)),
        minRR: Number(legacyNumber('minRR', PAPER_MIN_RR, 1.5, 5).toFixed(2))
      };
    }
    const state = {
      ...freshState,
      ...parsed,
      settings: {
        ...freshState.settings,
        ...parsedSettings,
        strategySettings: migratedStrategySettings
      },
      oiSnapshot: parsed.oiSnapshot || {},
      oiHistory: Object.fromEntries(Object.entries(parsed.oiHistory || {}).map(([symbol, rows]) => [
        symbol,
        (Array.isArray(rows) ? rows : []).filter(row => row && Number.isFinite(Number(row.ts)) &&
          Number(row.ts) > 0 && Number.isFinite(Number(row.oiUSD)) && Number(row.oiUSD) > 0)
          .slice(-672)
      ])),
      activeTrades: Array.isArray(parsed.activeTrades) ? parsed.activeTrades.map(normalisePaperTrade) : [],
      closedTrades: Array.isArray(parsed.closedTrades) ? parsed.closedTrades.map(normalisePaperTrade) : [],
      invalidatedTrades: Array.isArray(parsed.invalidatedTrades) ? parsed.invalidatedTrades : [],
      recentScans: Array.isArray(parsed.recentScans) ? parsed.recentScans : [],
      watchlistQueue: Array.isArray(parsed.watchlistQueue) ? parsed.watchlistQueue.map(item => {
        const sym = String(item && typeof item === 'object' ? item.sym : item || '')
          .toUpperCase().replace(/USDT$/, '').replace(/[^A-Z0-9]/g, '');
        return sym && PAPER_SYMBOLS.includes(sym) ? {
          sym, requestedAt: item && item.requestedAt || null
        } : null;
      }).filter(Boolean).slice(0, 5) : [],
      watchlistAlerts: Array.isArray(parsed.watchlistAlerts) ? parsed.watchlistAlerts
        .map(paperNormaliseWatchlistAlert).filter(Boolean).slice(0, 5) : [],
      alertState: {...defaultPaperState().alertState, ...(parsed.alertState || {})},
      schemaVersion: PAPER_SCHEMA_VERSION
    };
    const startingEquity = Number(state.startingEquity);
    const normalizedStartingEquity = Number.isFinite(startingEquity) && startingEquity > 0
      ? startingEquity : PAPER_STARTING_EQUITY;
    const previousEquityPeak = Number(state.equityPeak);
    state.startingEquity = normalizedStartingEquity;
    state.equityPeak = Math.max(
      Number.isFinite(previousEquityPeak) && previousEquityPeak > 0 ? previousEquityPeak : 0,
      normalizedStartingEquity
    );
    if (!Number.isFinite(previousEquityPeak) || previousEquityPeak <= 0) state._needsSave = true;
    state.strategyVersion = state.strategyVersion || PAPER_STRATEGY_VERSION;
    state.cohortId = state.cohortId || PAPER_DEFAULT_COHORT_ID;
    if (previousSchemaVersion < PAPER_SCHEMA_VERSION) state._needsSave = true;
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
      // The fixed 3%/6%/10% bracket below is only a compatibility repair for
      // pre-upgrade orders. New trades use ATR/structure levels and must keep
      // those levels across every service restart.
      if (isUpgradedPaperTrade(trade)) return;
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
      const existingBracketValid = trade.dir === 'LONG'
        ? trade.sl < bracketEntry && trade.tp1 > bracketEntry && trade.tp2 > trade.tp1
        : trade.sl > bracketEntry && trade.tp1 < bracketEntry && trade.tp2 < trade.tp1;
      // A migration must not rewrite a live pre-upgrade order's bracket. Only
      // repair records that are actually missing or have an impossible level
      // ordering; otherwise the historical position remains auditable as-is.
      if (existingBracketValid) return;
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
let paperReplayBusy = false;
let paperStarted = false;
if (paperState._needsSave) {
  delete paperState._needsSave;
  savePaperState();
}

function paperSettingNumber(name, fallback, min, max) {
  const raw = paperState && paperState.settings ? Number(paperState.settings[name]) : NaN;
  return Number.isFinite(raw) ? Math.max(min, Math.min(max, raw)) : fallback;
}

function paperSettings() {
  const raw = paperState && paperState.settings || {};
  const list = value => Array.isArray(value)
    ? [...new Set(value.map(item => String(item || '').trim().toUpperCase()).filter(Boolean))].slice(0, 200)
    : [];
  const strategySettings = paperNormaliseStrategySettings(raw.strategySettings);
  const activeStrategyKey = PAPER_STRATEGY_KEYS.includes(PAPER_STRATEGY_VERSION)
    ? PAPER_STRATEGY_VERSION : 'MTF_ATR_V2';
  const activeStrategy = strategySettings[activeStrategyKey] || strategySettings.MTF_ATR_V2;
  return {
    perScan: Math.round(paperSettingNumber('perScan', PAPER_PER_SCAN, 1, 5)),
    maxActive: Math.round(activeStrategy.maxActive),
    maxPerSymbol: Math.round(paperSettingNumber('maxPerSymbol', PAPER_MAX_PER_SYMBOL, 1, 3)),
    riskPct: activeStrategy.riskPct,
    maxDailyLossR: paperSettingNumber('maxDailyLossR', PAPER_MAX_DAILY_LOSS_R, 1, 20),
    minConfluence: paperSettingNumber('minConfluence', PAPER_MIN_CONFLUENCE, 50, 95),
    minSignalScore: paperSettingNumber('minSignalScore', PAPER_MIN_SIGNAL_SCORE, 50, 95),
    minRR: activeStrategy.minRR,
    tp1ClosePct: paperSettingNumber('tp1ClosePct', PAPER_TP1_CLOSE_PCT, 10, 90),
    strategyEnabled: raw.strategyEnabled !== false && activeStrategy.enabled,
    activeStrategy: activeStrategyKey,
    strategySettings,
    tradingHoursEnabled: raw.tradingHoursEnabled === true,
    tradingStartUtc: /^([01]\\d|2[0-3]):[0-5]\\d$/.test(String(raw.tradingStartUtc || '')) ? String(raw.tradingStartUtc) : '00:00',
    tradingEndUtc: /^([01]\\d|2[0-3]):[0-5]\\d$/.test(String(raw.tradingEndUtc || '')) ? String(raw.tradingEndUtc) : '23:59',
    whitelist: list(raw.whitelist),
    blacklist: list(raw.blacklist)
  };
}

function paperWithinTradingHours(settings, timestamp) {
  if (!settings.tradingHoursEnabled) return true;
  const now = new Date(timestamp || Date.now());
  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  const parse = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = parse(settings.tradingStartUtc);
  const end = parse(settings.tradingEndUtc);
  return start <= end ? current >= start && current <= end : current >= start || current <= end;
}

function paperSymbolAllowed(sym, settings) {
  const symbol = String(sym || '').toUpperCase();
  if (settings.blacklist.includes(symbol)) return false;
  return !settings.whitelist.length || settings.whitelist.includes(symbol);
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
      try {
        if (fs.existsSync(PAPER_STATE_BACKUP_FILE)) {
          fs.copyFileSync(PAPER_STATE_BACKUP_FILE, PAPER_STATE_BACKUP_2_FILE);
        }
        fs.copyFileSync(PAPER_STATE_FILE, PAPER_STATE_BACKUP_FILE);
      } catch (_) {}
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

function paperSwingLevels(rows) {
  const source = Array.isArray(rows) ? rows.slice(-80) : [];
  const supports = [];
  const resistances = [];
  for (let index = 2; index < source.length - 2; index++) {
    const row = source[index];
    const lows = source.slice(index - 2, index + 3).map(item => item.low);
    const highs = source.slice(index - 2, index + 3).map(item => item.high);
    if (row.low === Math.min(...lows)) supports.push(row.low);
    if (row.high === Math.max(...highs)) resistances.push(row.high);
  }
  const lastClose = source.length ? source[source.length - 1].close : 0;
  const below = supports.filter(level => level < lastClose);
  const above = resistances.filter(level => level > lastClose);
  return {
    support: below.length ? Math.max(...below) : null,
    resistance: above.length ? Math.min(...above) : null,
    supports: supports.slice(-8),
    resistances: resistances.slice(-8)
  };
}

function paperIndicatorSnapshot(rows) {
  if (!Array.isArray(rows) || rows.length < PAPER_MIN_CANDLES) return null;
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
  const swings = paperSwingLevels(rows);
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
    support: paperRoundPrice(swings.support || support),
    resistance: paperRoundPrice(swings.resistance || resistance),
    swingSupport: swings.support ? paperRoundPrice(swings.support) : null,
    swingResistance: swings.resistance ? paperRoundPrice(swings.resistance) : null,
    pivotSupports: swings.supports.map(paperRoundPrice),
    pivotResistances: swings.resistances.map(paperRoundPrice),
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
    const oiAvailable = paperFieldPresent(row.holdingAmount) || paperFieldPresent(row.openInterest);
    const previousOi = paperNumber(paperState.oiSnapshot[sym]);
    const oiReady = oiAvailable && oiUsd > 0 && previousOi > 0;
    const oi = oiReady ? ((oiUsd - previousOi) / previousOi) * 100 : 0;
    if (oiAvailable && oiUsd > 0) {
      paperState.oiSnapshot[sym] = oiUsd;
      const history = paperState.oiHistory[sym] || (paperState.oiHistory[sym] = []);
      const ts = Date.parse(dataAt) || Date.now();
      const sample = {ts, oiUSD: oiUsd, source: payload && payload._nexoraSource || 'Futures ticker'};
      const last = history[history.length - 1];
      if (last && Number(last.ts) === ts) history[history.length - 1] = sample;
      else if (!last || Number(last.ts) < ts) history.push(sample);
      paperState.oiHistory[sym] = history.slice(-672);
    }
    const sc = paperScore(chg, fund, oi, oiReady);
    const pair = {
      sym, price, chg,
      volume: paperNumber(row.quoteVolume || row.usdtVolume || row.quoteVolume24h),
      fund, oi, oiUSD: oiAvailable && oiUsd > 0 ? oiUsd : null, oiReady,
      fundingAvailable: paperFieldPresent(row.fundingRate) || paperFieldPresent(row.fundingRate24h),
      oiAvailable,
      volumeAvailable: paperFieldPresent(row.quoteVolume) || paperFieldPresent(row.usdtVolume) ||
        paperFieldPresent(row.quoteVolume24h),
      sc: 0,
      tier: 'C', sig: paperSignal(chg, oi, fund), dataQuality: oiReady ? 'FULL' : 'PARTIAL',
      dataAt, source: payload && payload._nexoraSource || 'Bitget Futures'
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

function paperSetup(pair, options) {
  const setupOptions = options || {};
  const cfg = paperSettings();
  const roundPrice = value => paperRoundPriceForPair(value, pair);
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
  const entry = roundPrice(dir === 'LONG'
    ? (pullbackLevel && pullbackLevel <= entryBase ? pullbackLevel : entryBase)
    : (pullbackLevel && pullbackLevel >= entryBase ? pullbackLevel : entryBase));
  const structureStopDistance = dir === 'LONG' && support > 0
    ? entry - (support - atr * 0.15)
    : dir === 'SHORT' && resistance > 0
      ? (resistance + atr * 0.15) - entry : 0;
  const stopDistance = Math.min(price * 0.06,
    Math.max(atr * 1.5, structureStopDistance, price * 0.005));
  const sl = roundPrice(dir === 'LONG' ? entry - stopDistance : entry + stopDistance);
  const riskDistance = Math.abs(entry - sl);
  const tp1Level = dir === 'LONG'
    ? (resistance > entry ? resistance : 0)
    : (support > 0 && support < entry ? support : 0);
  const minimumTp1 = dir === 'LONG' ? entry + riskDistance * 2 : entry - riskDistance * 2;
  const tp1 = roundPrice(dir === 'LONG'
    ? Math.max(minimumTp1, tp1Level || 0)
    : Math.min(minimumTp1, tp1Level || Number.POSITIVE_INFINITY));
  const nextTarget = dir === 'LONG'
    ? resistances.filter(level => level > tp1).sort((a, b) => a - b)[0]
    : supports.filter(level => level < tp1).sort((a, b) => b - a)[0];
  const tp2 = roundPrice(dir === 'LONG'
    ? Math.max(entry + riskDistance * 3, tp1 * 1.01, nextTarget || 0)
    : Math.min(entry - riskDistance * 3, tp1 * 0.99, nextTarget || Number.POSITIVE_INFINITY));
  const sizingEquity = Number.isFinite(Number(setupOptions.equity))
    ? Number(setupOptions.equity) : paperEquity();
  const riskDollar = Math.max(0, sizingEquity * cfg.riskPct / 100);
  const contracts = stopDistance > 0 ? riskDollar / stopDistance : 0;
  return {
    dir,
    entry, sl, tp1, tp2,
    structureSupport: support || null,
    structureResistance: resistance || null,
    atr: Number(atr.toFixed(8)),
    contracts: Number(contracts.toFixed(6)),
    size: Number((contracts * entry).toFixed(2)),
    riskPct: cfg.riskPct,
    riskDollar: Number(riskDollar.toFixed(2))
  };
}

function validatePaperSetup(pair, setup) {
  const cfg = paperSettings();
  const reasons = [];
  const reasonCodes = [];
  const price = paperNumber(pair && pair.price);
  const entry = paperNumber(setup && setup.entry);
  const sl = paperNumber(setup && setup.sl);
  const tp1 = paperNumber(setup && setup.tp1);
  const tp2 = paperNumber(setup && setup.tp2);
  if (!price || !entry || !sl || !tp1 || !tp2) {
    reasons.push('harga setup tidak valid'); reasonCodes.push('INVALID_SETUP');
  }
  if (setup.dir === 'LONG') {
    if (!(entry < price)) {
      reasons.push('LONG limit harus di bawah harga sekarang'); reasonCodes.push('ENTRY_SIDE_INVALID');
    }
    if (!(sl < entry && tp1 > entry && tp2 > tp1)) {
      reasons.push('urutan LONG entry/SL/TP tidak valid'); reasonCodes.push('LEVEL_ORDER_INVALID');
    }
  } else if (setup.dir === 'SHORT') {
    if (!(entry > price)) {
      reasons.push('SHORT limit harus di atas harga sekarang'); reasonCodes.push('ENTRY_SIDE_INVALID');
    }
    if (!(sl > entry && tp1 < entry && tp2 < tp1)) {
      reasons.push('urutan SHORT entry/SL/TP tidak valid'); reasonCodes.push('LEVEL_ORDER_INVALID');
    }
  } else {
    reasons.push('arah trade tidak dikenal'); reasonCodes.push('DIRECTION_INVALID');
  }
  const entryOffsetPct = price > 0 ? Math.abs(entry - price) / price * 100 : 0;
  const stopPct = entry > 0 ? Math.abs(entry - sl) / entry * 100 : 0;
  const rewardPct = entry > 0 ? Math.abs(entry - tp1) / entry * 100 : 0;
  const rr = stopPct > 0 ? rewardPct / stopPct : 0;
  if (entryOffsetPct < PAPER_MIN_ENTRY_OFFSET_PCT) {
    reasons.push('entry terlalu dekat dengan harga sekarang'); reasonCodes.push('ENTRY_TOO_CLOSE');
  }
  if (stopPct <= 0.25) {
    reasons.push('jarak SL terlalu kecil'); reasonCodes.push('STOP_TOO_CLOSE');
  }
  if (rr < cfg.minRR) {
    reasons.push('risk/reward di bawah batas minimum'); reasonCodes.push('RR_TOO_LOW');
  }
  const expectedLoss = entry > 0 ? Math.abs(entry - sl) / entry * Math.abs(setup.size || 0) : 0;
  const riskDollar = paperNumber(setup.riskDollar);
  if (!riskDollar || expectedLoss > riskDollar * 1.05) {
    reasons.push('expected loss melebihi risk budget'); reasonCodes.push('RISK_SIZE_INVALID');
  }
  if (!Number.isFinite(setup.contracts) || setup.contracts <= 0 || !Number.isFinite(setup.size) || setup.size <= 0) {
    reasons.push('ukuran posisi tidak valid'); reasonCodes.push('SIZE_INVALID');
  }
  const minTradeNum = paperNumber(pair && pair.minTradeNum);
  if (minTradeNum > 0 && Number(setup.contracts) < minTradeNum) {
    reasons.push('ukuran di bawah minimum kontrak Bitget'); reasonCodes.push('SIZE_BELOW_EXCHANGE_MIN');
  }
  return {
    ok: reasons.length === 0,
    reasons, reasonCodes,
    entryOffsetPct: Number(entryOffsetPct.toFixed(3)),
    stopPct: Number(stopPct.toFixed(3)),
    rewardPct: Number(rewardPct.toFixed(3)),
    rr: Number(rr.toFixed(2)),
    expectedLoss: Number(expectedLoss.toFixed(2)),
    riskDollar: Number(riskDollar.toFixed(2))
  };
}

function paperIsActive(trade) {
  return trade && (trade.status === 'PENDING' || trade.status === 'OPEN' ||
    trade.status === 'TP1_PARTIAL');
}

function paperIsTrialTrade(trade) {
  return trade && paperTradeStrategyVersion(trade) === PAPER_STRATEGY_VERSION &&
    String(trade.cohortId || PAPER_DEFAULT_COHORT_ID) === String(paperState.cohortId);
}

function paperIsPreUpgradeTrade(trade) {
  return paperTradeStrategyVersion(trade) === 'PRE_UPGRADE';
}

function paperActiveCount(includeLegacy) {
  return paperState.activeTrades.filter(t => paperIsActive(t) &&
    (includeLegacy || paperIsTrialTrade(t))).length;
}

function paperLegacyActiveCount() {
  return paperState.activeTrades.filter(t => paperIsActive(t) &&
    paperTradeStrategyVersion(t) === 'LEGACY').length;
}

function paperPreUpgradeActiveCount() {
  return paperState.activeTrades.filter(t => paperIsActive(t) && paperIsPreUpgradeTrade(t)).length;
}

function paperRealizedPnl(includeLegacy) {
  return paperState.closedTrades
    .filter(trade => includeLegacy || paperIsTrialTrade(trade))
    .reduce((sum, trade) => sum + paperNumber(trade.pnl), 0);
}

function paperUnrealizedPnl(includeLegacy) {
  return paperState.activeTrades
    .filter(trade => (trade.status === 'OPEN' || trade.status === 'TP1_PARTIAL') &&
      (includeLegacy || paperIsTrialTrade(trade)))
    .reduce((sum, trade) => sum + paperNumber(trade.unrealPnl), 0);
}

function paperEquity(includeLegacy) {
  return paperNumber(paperState.startingEquity || PAPER_STARTING_EQUITY) +
    paperRealizedPnl(includeLegacy) + paperUnrealizedPnl(includeLegacy);
}

function paperEquityPeak() {
  return Math.max(
    paperNumber(paperState.equityPeak),
    paperNumber(paperState.startingEquity || PAPER_STARTING_EQUITY)
  );
}

function paperUpdateEquityPeak() {
  const current = paperEquity();
  const peak = paperEquityPeak();
  if (current > peak) {
    paperState.equityPeak = Number(current.toFixed(2));
    return true;
  }
  if (paperState.equityPeak !== peak) paperState.equityPeak = Number(peak.toFixed(2));
  return false;
}

function paperDrawdownPct() {
  const peak = paperEquityPeak();
  const current = paperEquity();
  return peak > 0 ? Math.max(0, (peak - current) / peak * 100) : 0;
}

function paperTradeRiskDollar(trade) {
  const entry = paperNumber(trade.entryActual || trade.entryLimit);
  const stop = paperNumber(trade.status === 'TP1_PARTIAL'
    ? (trade.slAfterTp1 || trade.sl) : trade.sl);
  const size = Math.abs(paperNumber(trade.remainingSize != null
    ? trade.remainingSize : trade.size));
  if (!entry || !stop || !size) return 0;
  return Math.abs(entry - stop) / entry * size;
}

function paperActiveRiskDollar(includeLegacy) {
  return paperState.activeTrades
    .filter(trade => paperIsActive(trade) && (includeLegacy || paperIsTrialTrade(trade)))
    .reduce((sum, trade) => sum + paperTradeRiskDollar(trade), 0);
}

function paperTradeOriginalSize(trade) {
  return Math.abs(paperNumber(trade.originalSize != null ? trade.originalSize : trade.size));
}

function paperTradeRemainingSize(trade) {
  return Math.abs(paperNumber(trade.remainingSize != null
    ? trade.remainingSize : trade.status === 'CLOSED' ? 0 : trade.size));
}

function paperTradeOriginalContracts(trade) {
  return Math.abs(paperNumber(trade.originalContracts != null ? trade.originalContracts : trade.contracts));
}

function paperTradeRemainingContracts(trade) {
  return Math.abs(paperNumber(trade.remainingContracts != null
    ? trade.remainingContracts : trade.status === 'CLOSED' ? 0 : trade.contracts));
}

function paperTradeInitialRiskDollar(trade) {
  const recorded = paperNumber(trade.riskDollarAtEntry || trade.riskDollar);
  if (recorded > 0) return recorded;
  const entry = paperNumber(trade.entryActual || trade.entryLimit);
  const stop = paperNumber(trade.sl);
  const size = paperTradeOriginalSize(trade);
  return entry > 0 && stop > 0 && size > 0 ? Math.abs(entry - stop) / entry * size : 0;
}

function paperTradePnl(trade, exitPrice, size) {
  const entry = paperNumber(trade.entryActual || trade.entryLimit);
  if (!entry || !exitPrice || !size) return 0;
  return ((exitPrice - entry) / entry) * size * (trade.dir === 'LONG' ? 1 : -1);
}

function paperAddTradeEvent(trade, type, details) {
  if (!trade) return;
  if (!Array.isArray(trade.events)) trade.events = [];
  trade.events.unshift({
    type, at: new Date().toISOString(),
    price: details && details.price != null ? details.price : null,
    candleAt: details && details.candleAt || null,
    reason: details && details.reason || null,
    size: details && details.size != null ? details.size : null
  });
  trade.events = trade.events.slice(0, 50);
}

function paperSetRemainingSize(trade, size) {
  const originalSize = paperTradeOriginalSize(trade);
  const originalContracts = paperTradeOriginalContracts(trade);
  const ratio = originalSize > 0 ? Math.max(0, size / originalSize) : 0;
  trade.remainingSize = Number(Math.max(0, size).toFixed(8));
  trade.remainingContracts = Number((originalContracts * ratio).toFixed(8));
}

function paperDailyLossR() {
  const today = new Date().toISOString().slice(0, 10);
  return paperState.closedTrades
    .filter(trade => paperIsTrialTrade(trade) && String(trade.closedAt || '').slice(0, 10) === today)
    .reduce((sum, trade) => sum + paperNumber(trade.r), 0);
}

function paperTradeView(trade) {
  return {
    id: trade.id, sym: trade.sym, dir: trade.dir, status: trade.status,
    entryLimit: trade.entryLimit, entryActual: trade.entryActual || null,
    currentPrice: trade.currentPrice, sl: trade.sl, tp1: trade.tp1, tp2: trade.tp2,
    size: paperTradeOriginalSize(trade), remainingSize: paperTradeRemainingSize(trade),
    contracts: paperTradeOriginalContracts(trade),
    remainingContracts: paperTradeRemainingContracts(trade),
    score: trade.score, tier: trade.tier,
    fund: trade.fund, oi: trade.oi, volume: trade.volume || 0,
    volumeRatio: trade.volumeRatio == null ? null : trade.volumeRatio, mtf: trade.mtf || null,
    createdAt: trade.createdAt,
    openedAt: trade.openedAt || null, cycleKey: trade.cycleKey,
    unrealPnl: Number((trade.unrealPnl || 0).toFixed(2)),
    mfePnl: Number((trade.mfePnl || 0).toFixed(2)),
    maePnl: Number((trade.maePnl || 0).toFixed(2)),
    riskPct: trade.riskPct || null,
    riskDollar: Number(paperTradeRiskDollar(trade).toFixed(2)),
    riskDollarAtEntry: Number(paperTradeInitialRiskDollar(trade).toFixed(2)),
    tp1ClosePct: trade.tp1ClosePct || PAPER_TP1_CLOSE_PCT,
    tp1Hit: !!trade.tp1Hit,
    tp1HitAt: trade.tp1HitAt || null,
    slAfterTp1: trade.slAfterTp1 || null,
    realizedPnlTp1: Number((trade.realizedPnlTp1 || 0).toFixed(2)),
    realizedPnl: Number((trade.realizedPnl || 0).toFixed(2)),
    realizedPnlFinal: Number((trade.realizedPnlFinal || 0).toFixed(2)),
    expectedLossAtSl: Number((trade.expectedLossAtSl || paperTradeInitialRiskDollar(trade)).toFixed(2)),
    fillMethod: trade.fillMethod || null,
    closeStage: trade.closeStage || null,
    lastEvent: trade.lastEvent || null,
    lastProcessedCandleAt: trade.lastProcessedCandleAt || null,
    events: Array.isArray(trade.events) ? trade.events.slice(0, 50) : [],
    strategyVersion: trade.strategyVersion || paperTradeStrategyVersion(trade),
    cohortId: trade.cohortId || null,
    signalCreatedAt: trade.signalCreatedAt || null,
    candleAtByTf: trade.candleAtByTf || null,
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
    tickSize: trade.tickSize || null, pricePlace: trade.pricePlace || null,
    signalReasons: Array.isArray(trade.signalReasons) ? trade.signalReasons : [],
    scoreBreakdown: trade.scoreBreakdown || null,
    setupValidation: trade.setupValidation || null,
    reason: trade.reason
  };
}

function paperCandidateView(pair) {
  const reasons = [];
  if (pair.watchlistPriority) reasons.push('Watchlist priority requested; MTF and risk checks still required');
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
    watchlistPriority: !!pair.watchlistPriority,
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
    tickSize: pair.tickSize || null, pricePlace: pair.pricePlace || null,
    dataQualityReason: pair.dataQualityReason || null,
    evidence: reasons
  };
}

function paperGranularityMs(granularity) {
  const key = String(granularity || '').toLowerCase();
  return ({'1m': 60 * 1000, '3m': 3 * 60 * 1000, '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000, 'm15': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000, 'm30': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000, 'h1': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000, 'h4': 4 * 60 * 60 * 1000})[key] || 15 * 60 * 1000;
}

function paperBinanceInterval(granularity) {
  return ({'1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1h': '1h', '4h': '4h', '1H': '1h', '4H': '4h'})[String(granularity || '')] || '15m';
}

function paperOkxBar(granularity) {
  return ({'1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1h': '1H', '4h': '4H', '1H': '1H', '4H': '4H'})[String(granularity || '')] || '15m';
}

function paperFallbackSymbol(sym) {
  return String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '') + 'USDT';
}

function paperRowsWithMetadata(rows, fetchedAt, intervalMs, source) {
  const clean = rows.filter(row => row && row.ts > 0 && row.open > 0 && row.high > 0 &&
    row.low > 0 && row.close > 0).sort((a, b) => a.ts - b.ts);
  const now = Date.now();
  const closedRows = clean.filter(row => row.ts + intervalMs <= now);
  closedRows._nexoraFetchedAt = fetchedAt || new Date().toISOString();
  closedRows._nexoraCandleIntervalMs = intervalMs;
  closedRows._nexoraLatestRawTs = clean.length ? clean[clean.length - 1].ts : null;
  closedRows._nexoraLatestClosedTs = closedRows.length ? closedRows[closedRows.length - 1].ts : null;
  closedRows._nexoraSource = source;
  return closedRows;
}

async function fetchPaperCandlesFromBitget(sym, granularity, requestedLimit) {
  const limit = Math.max(3, Math.min(250,
    Number.isFinite(Number(requestedLimit)) ? Number(requestedLimit) : PAPER_CANDLE_LIMIT + 1));
  const target = APIS['/bitget'] +
    '/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=' +
    encodeURIComponent(sym + 'USDT') + '&granularity=' +
    encodeURIComponent(granularity) + '&limit=' + limit;
  const startedAt = Date.now();
  let result;
  try {
    result = await requestUpstream(target);
    markSourceHealth('/bitget', {
      ...result, latencyMs: Date.now() - startedAt,
      path: '/api/v2/mix/market/candles?granularity=' + granularity
    });
  } catch (error) {
    markSourceError('/bitget', error, '/api/v2/mix/market/candles?granularity=' + granularity);
    throw error;
  }
  if (result.status < 200 || result.status >= 300) throw new Error('Bitget candles HTTP ' + result.status);
  let payload;
  try {
    payload = JSON.parse(result.body);
  } catch (_) {
    const error = new Error('Bitget candles returned invalid JSON');
    markSourceError('/bitget', error, '/api/v2/mix/market/candles?granularity=' + granularity);
    throw error;
  }
  if (!payload || payload.code !== '00000' || !Array.isArray(payload.data)) {
    const error = new Error((payload && payload.msg) || 'Bitget candles response invalid');
    markSourceError('/bitget', error, '/api/v2/mix/market/candles?granularity=' + granularity);
    throw error;
  }
  const rows = payload.data.map(row => ({
    ts: paperTimestamp(row[0]), open: Number(row[1]), high: Number(row[2]),
    low: Number(row[3]), close: Number(row[4]),
    volume: Number(row[6] || row[5] || 0)
  })).filter(row => row.open > 0 && row.high > 0 && row.low > 0 && row.close > 0)
    .sort((a, b) => a.ts - b.ts);
  const intervalMs = paperGranularityMs(granularity);
  return paperRowsWithMetadata(rows, new Date().toISOString(), intervalMs, 'Bitget Futures');
}

async function fetchPaperCandlesFromBinance(sym, granularity, requestedLimit) {
  const limit = Math.max(3, Math.min(1500,
    Number.isFinite(Number(requestedLimit)) ? Number(requestedLimit) : PAPER_CANDLE_LIMIT + 1));
  const interval = paperBinanceInterval(granularity);
  const pathName = '/fapi/v1/klines?interval=' + interval;
  const target = APIS['/binance'] + '/fapi/v1/klines?symbol=' +
    encodeURIComponent(paperFallbackSymbol(sym)) + '&interval=' + interval + '&limit=' + limit;
  const startedAt = Date.now();
  let result;
  try {
    result = await requestUpstream(target);
    markSourceHealth('/binance', {...result, latencyMs: Date.now() - startedAt, path: pathName});
  } catch (error) {
    markSourceError('/binance', error, pathName);
    throw error;
  }
  if (result.status < 200 || result.status >= 300) throw new Error('Binance candles HTTP ' + result.status);
  let payload;
  try { payload = JSON.parse(result.body); }
  catch (_) { throw new Error('Binance candles returned invalid JSON'); }
  if (!Array.isArray(payload)) throw new Error((payload && payload.msg) || 'Binance candles response invalid');
  return paperRowsWithMetadata(payload.map(row => ({
    ts: paperTimestamp(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), volume: Number(row[5] || 0)
  })), new Date().toISOString(), paperGranularityMs(granularity), 'Binance Futures fallback');
}

async function fetchPaperCandlesFromOkx(sym, granularity, requestedLimit) {
  const limit = Math.max(3, Math.min(300, Number.isFinite(Number(requestedLimit)) ? Number(requestedLimit) : PAPER_CANDLE_LIMIT + 1));
  const bar = paperOkxBar(granularity);
  const pathName = '/api/v5/market/candles?bar=' + bar;
  const target = APIS['/okx'] + '/api/v5/market/candles?instId=' +
    encodeURIComponent(String(sym).toUpperCase() + '-USDT-SWAP') + '&bar=' + bar + '&limit=' + limit;
  const startedAt = Date.now();
  let result;
  try {
    result = await requestUpstream(target);
    markSourceHealth('/okx', {...result, latencyMs: Date.now() - startedAt, path: pathName});
  } catch (error) {
    markSourceError('/okx', error, pathName);
    throw error;
  }
  if (result.status < 200 || result.status >= 300) throw new Error('OKX candles HTTP ' + result.status);
  let payload;
  try { payload = JSON.parse(result.body); }
  catch (_) { throw new Error('OKX candles returned invalid JSON'); }
  if (!payload || payload.code !== '0' || !Array.isArray(payload.data)) {
    throw new Error((payload && payload.msg) || 'OKX candles response invalid');
  }
  return paperRowsWithMetadata(payload.data.map(row => ({
    ts: paperTimestamp(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), volume: Number(row[7] || row[6] || row[5] || 0)
  })), new Date().toISOString(), paperGranularityMs(granularity), 'OKX Swap fallback');
}

async function fetchPaperCandles(sym, granularity, requestedLimit) {
  let bitgetError;
  try {
    return await fetchPaperCandlesFromBitget(sym, granularity, requestedLimit);
  } catch (error) {
    bitgetError = error;
  }
  if (!PAPER_FALLBACK_ENABLED) throw bitgetError || new Error('Bitget candles unavailable');
  const fallbackErrors = [];
  for (const fallback of [fetchPaperCandlesFromBinance, fetchPaperCandlesFromOkx]) {
    try { return await fallback(sym, granularity, requestedLimit); }
    catch (error) { fallbackErrors.push(error.message); }
  }
  throw new Error('Bitget candles unavailable; Binance/OKX fallback failed: ' + fallbackErrors.join(' | '));
}

// Historical candles for the replay endpoint. Bitget returns the newest page
// first and limits one response, so page backwards with endTime. Only fully
// closed candles are retained; the live bot and replay therefore share the
// same no-lookahead rule.
async function fetchPaperCandleHistoryFromBitget(sym, granularity, requestedLimit) {
  const wanted = Math.max(100, Math.min(25000,
    Number.isFinite(Number(requestedLimit)) ? Number(requestedLimit) : 1000));
  const intervalMs = paperGranularityMs(granularity);
  const rowsByTs = new Map();
  let endTime = Date.now();
  let pages = 0;
  while (rowsByTs.size < wanted && pages < 40) {
    const pageLimit = Math.min(1000, wanted - rowsByTs.size);
    const target = APIS['/bitget'] +
      '/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=' +
      encodeURIComponent(sym + 'USDT') + '&granularity=' +
      encodeURIComponent(granularity) + '&limit=' + pageLimit +
      '&endTime=' + Math.max(0, Math.floor(endTime));
    const startedAt = Date.now();
    let result;
    try {
      result = await requestUpstream(target);
      markSourceHealth('/bitget', {
        ...result, latencyMs: Date.now() - startedAt,
        path: '/api/v2/mix/market/candles?granularity=' + granularity
      });
    } catch (error) {
      markSourceError('/bitget', error, '/api/v2/mix/market/candles?granularity=' + granularity);
      throw error;
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error('Bitget historical candles HTTP ' + result.status);
    }
    let payload;
    try { payload = JSON.parse(result.body); }
    catch (_) { throw new Error('Bitget historical candles returned invalid JSON'); }
    if (!payload || payload.code !== '00000' || !Array.isArray(payload.data)) {
      throw new Error((payload && payload.msg) || 'Bitget historical candles response invalid');
    }
    const pageRows = payload.data.map(row => ({
      ts: paperTimestamp(row[0]), open: Number(row[1]), high: Number(row[2]),
      low: Number(row[3]), close: Number(row[4]), volume: Number(row[6] || row[5] || 0)
    })).filter(row => row.ts > 0 && row.open > 0 && row.high > 0 && row.low > 0 && row.close > 0)
      .sort((a, b) => a.ts - b.ts);
    if (!pageRows.length) break;
    const now = Date.now();
    pageRows.forEach(row => {
      if (row.ts + intervalMs <= now) rowsByTs.set(row.ts, row);
    });
    const oldest = pageRows[0].ts;
    if (!oldest || oldest >= endTime) break;
    endTime = oldest - 1;
    pages += 1;
    if (pageRows.length < pageLimit) break;
  }
  const rows = [...rowsByTs.values()].sort((a, b) => a.ts - b.ts).slice(-wanted);
  rows._nexoraFetchedAt = new Date().toISOString();
  rows._nexoraCandleIntervalMs = intervalMs;
  rows._nexoraLatestRawTs = rows.length ? rows[rows.length - 1].ts : null;
  rows._nexoraLatestClosedTs = rows.length ? rows[rows.length - 1].ts : null;
  rows._nexoraSource = 'Bitget Futures';
  return rows;
}

async function fetchPaperCandleHistoryFromBinance(sym, granularity, requestedLimit) {
  const wanted = Math.max(100, Math.min(25000,
    Number.isFinite(Number(requestedLimit)) ? Number(requestedLimit) : 1000));
  const interval = paperBinanceInterval(granularity);
  const intervalMs = paperGranularityMs(granularity);
  const rowsByTs = new Map();
  let endTime = Date.now();
  let pages = 0;
  while (rowsByTs.size < wanted && pages < 40) {
    const limit = Math.min(1500, wanted - rowsByTs.size);
    const pathName = '/fapi/v1/klines?interval=' + interval;
    const target = APIS['/binance'] + '/fapi/v1/klines?symbol=' +
      encodeURIComponent(paperFallbackSymbol(sym)) + '&interval=' + interval +
      '&limit=' + limit + '&endTime=' + Math.max(0, Math.floor(endTime));
    const startedAt = Date.now();
    let result;
    try {
      result = await requestUpstream(target);
      markSourceHealth('/binance', {...result, latencyMs: Date.now() - startedAt, path: pathName});
    } catch (error) {
      markSourceError('/binance', error, pathName);
      throw error;
    }
    if (result.status < 200 || result.status >= 300) throw new Error('Binance historical candles HTTP ' + result.status);
    let payload;
    try { payload = JSON.parse(result.body); }
    catch (_) { throw new Error('Binance historical candles returned invalid JSON'); }
    if (!Array.isArray(payload)) throw new Error((payload && payload.msg) || 'Binance historical candles response invalid');
    const pageRows = payload.map(row => ({
      ts: paperTimestamp(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
      close: Number(row[4]), volume: Number(row[5] || 0)
    })).filter(row => row.ts > 0 && row.open > 0 && row.high > 0 && row.low > 0 && row.close > 0)
      .sort((a, b) => a.ts - b.ts);
    if (!pageRows.length) break;
    pageRows.forEach(row => { if (row.ts + intervalMs <= Date.now()) rowsByTs.set(row.ts, row); });
    const oldest = pageRows[0].ts;
    if (!oldest || oldest >= endTime) break;
    endTime = oldest - 1;
    pages += 1;
    if (pageRows.length < limit) break;
  }
  return paperRowsWithMetadata([...rowsByTs.values()].sort((a, b) => a.ts - b.ts).slice(-wanted),
    new Date().toISOString(), intervalMs, 'Binance Futures fallback');
}

async function fetchPaperCandleHistory(sym, granularity, requestedLimit) {
  let bitgetError;
  try {
    return await fetchPaperCandleHistoryFromBitget(sym, granularity, requestedLimit);
  } catch (error) {
    bitgetError = error;
  }
  if (!PAPER_FALLBACK_ENABLED) throw bitgetError || new Error('Bitget historical candles unavailable');
  try {
    return await fetchPaperCandleHistoryFromBinance(sym, granularity, requestedLimit);
  } catch (binanceError) {
    const wanted = Math.min(300, Math.max(100,
      Number.isFinite(Number(requestedLimit)) ? Number(requestedLimit) : 300));
    try {
      return await fetchPaperCandlesFromOkx(sym, granularity, wanted);
    } catch (okxError) {
      throw new Error('Bitget historical candles unavailable; Binance/OKX fallback failed: ' +
        [binanceError.message, okxError.message].join(' | '));
    }
  }
}

async function fetchPaperMonitorBar(sym) {
  const rows = await fetchPaperCandles(sym, '1m', PAPER_MONITOR_CANDLE_LIMIT);
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows.filter(bar => bar && bar.ts && bar.high > 0 && bar.low > 0)
    .map(bar => ({
      ...bar,
      fetchedAt: rows._nexoraFetchedAt || new Date().toISOString(),
      intervalMs: rows._nexoraCandleIntervalMs || paperGranularityMs('1m')
    }));
}

async function fetchPaperMonitorBars(symbols) {
  const unique = [...new Set(symbols.filter(Boolean))];
  const bars = {};
  let cursor = 0;
  const workers = Array.from({length: Math.min(PAPER_MTF_CONCURRENCY, unique.length)}, async () => {
    while (cursor < unique.length) {
      const sym = unique[cursor++];
      try {
        const symbolBars = await fetchPaperMonitorBar(sym);
        if (symbolBars.length) bars[sym] = symbolBars;
      } catch (error) {
        console.error('[paper] monitor candle failed', sym, error.message);
      }
    }
  });
  await Promise.all(workers);
  return bars;
}

function paperTimeframeEvidence(rows, timeframe, referenceNow) {
  const observedAt = Number.isFinite(Number(referenceNow)) ? Number(referenceNow) : Date.now();
  const indicators = paperIndicatorSnapshot(rows);
  if (!indicators) {
    return {
      timeframe, direction: 'NEUTRAL', verdict: 'NO_DATA',
      status: Array.isArray(rows) && rows.length ? 'PARTIAL' : 'UNAVAILABLE',
      sampleSize: Array.isArray(rows) ? rows.length : 0, indicators: null,
      lastClosedCandleAt: rows && rows._nexoraLatestClosedTs
        ? new Date(rows._nexoraLatestClosedTs).toISOString() : null,
      isClosed: false,
      fetchedAt: rows && rows._nexoraFetchedAt || null
    };
  }
  const last = rows[rows.length - 1];
  const intervalMs = rows._nexoraCandleIntervalMs || paperGranularityMs(timeframe);
  const isClosed = !!last && last.ts > 0 && last.ts + intervalMs <= observedAt;
  const ageMs = last && last.ts ? Math.max(0, observedAt - last.ts) : null;
  const maxAgeMs = PAPER_TIMEFRAME_MAX_AGE_MS[timeframe] || 60 * 60 * 1000;
  const stale = ageMs != null && ageMs > maxAgeMs;
  const complete = indicators.sampleSize >= PAPER_MIN_CANDLES && isClosed;
  return {
    timeframe, direction: indicators.direction,
    verdict: stale ? 'STALE' : !complete ? 'PARTIAL'
      : indicators.direction === 'NEUTRAL' ? 'WAIT' : 'CONFIRM',
    status: stale ? 'STALE' : complete ? 'FULL' : 'PARTIAL', sampleSize: indicators.sampleSize,
    strengthPct: indicators.strengthPct, change: indicators.change,
    candleAt: indicators.candleAt, support: indicators.support,
    resistance: indicators.resistance, atr: indicators.atr, atrPct: indicators.atrPct,
    volumeRatio: indicators.volumeRatio, indicators: indicators.indicators,
    lastClosedCandleAt: last && last.ts ? new Date(last.ts).toISOString() : null,
    isClosed,
    fetchedAt: rows._nexoraFetchedAt || null,
    ageSec: ageMs == null ? null : Math.round(ageMs / 1000),
    maxAgeSec: Math.round(maxAgeMs / 1000),
    freshness: stale ? 'STALE' : 'FRESH'
  };
}

function paperMtfSummary(mtf, referenceNow) {
  const observedAt = Number.isFinite(Number(referenceNow)) ? Number(referenceNow) : Date.now();
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
  const confirmAligned = direction !== 'NEUTRAL' && mtf.M30 &&
    mtf.M30.status === 'FULL' && mtf.M30.direction === direction;
  const triggerAligned = direction !== 'NEUTRAL' && mtf.M15 && mtf.M15.direction === direction;
  const timestampsValid = names.every(name => {
    const item = mtf[name];
    const stamp = item && Date.parse(item.lastClosedCandleAt || item.candleAt || '');
    return item && item.status === 'FULL' && item.isClosed === true &&
      Number.isFinite(stamp) && stamp <= observedAt;
  });
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
    higherAligned, confirmAligned, triggerAligned,
    timestampsValid,
    staleCount, partialCount,
    mode: PAPER_SIGNAL_MODE,
    status: available.length === names.length ? 'FULL' : staleCount ? 'STALE'
      : available.length ? 'PARTIAL' : 'UNAVAILABLE'
  };
}

function paperSignalScores(pair, summary) {
  const trigger = pair.mtf && pair.mtf.M15;
  const trend = Math.round(paperClamp(summary.alignmentCount * 5 +
    (summary.higherAligned ? 10 : 0) + (summary.confirmAligned ? 5 : 0), 0, 30));
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

function applyPaperMtf(pair, referenceNow) {
  const summary = paperMtfSummary(pair.mtf || {}, referenceNow);
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
  if (!summary.timestampsValid) qualityReasons.push('timestamp candle MTF tidak valid');
  pair.dataQuality = summary.status === 'FULL' && summary.timestampsValid && pair.oiReady && pair.oiAvailable &&
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
  const closeSize = paperTradeRemainingSize(trade);
  const pnlPart = paperTradePnl(trade, exitPrice, closeSize);
  const totalPnl = paperNumber(trade.realizedPnl) + pnlPart;
  const initialRisk = paperTradeInitialRiskDollar(trade);
  const r = initialRisk > 0 ? totalPnl / initialRisk : 0;
  trade.status = 'CLOSED';
  trade.closeStage = String(reason || '').toLowerCase().includes('tp2') ? 'CLOSED_TP2'
    : trade.tp1Hit ? 'CLOSED_AFTER_TP1' : 'CLOSED_DIRECT';
  trade.exitPrice = exitPrice;
  trade.closedAt = new Date().toISOString();
  trade.realizedPnl = totalPnl;
  trade.realizedPnlFinal = Number(pnlPart.toFixed(2));
  paperSetRemainingSize(trade, 0);
  trade.unrealPnl = 0;
  trade.outcome = outcome || (r > 0 ? 'WIN' : r < 0 ? 'LOSS' : 'BREAKEVEN');
  trade.closeReason = reason;
  trade.r = Number(r.toFixed(2));
  trade.pnl = Number(totalPnl.toFixed(2));
  paperAddTradeEvent(trade, 'CLOSED', {price: exitPrice, reason, size: closeSize});
  paperState.closedTrades.unshift({
    ...paperTradeView(trade), exitPrice, closedAt: trade.closedAt,
    outcome: trade.outcome, closeReason: reason, r: trade.r, pnl: trade.pnl
  });
  paperState.closedTrades = paperState.closedTrades.slice(0, PAPER_MAX_CLOSED_TRADES);
  console.log('[paper] closed', trade.sym, outcome, reason);
  void sendConfiguredAlert(paperCloseAlert(trade));
}

function partialClosePaperTrade(trade, exitPrice) {
  if (trade.tp1Hit) return false;
  const currentSize = paperTradeRemainingSize(trade);
  if (!currentSize) return false;
  const closePct = Math.max(10, Math.min(90, paperNumber(trade.tp1ClosePct || paperSettings().tp1ClosePct)));
  const closeSize = currentSize * closePct / 100;
  const pnlPart = paperTradePnl(trade, exitPrice, closeSize);
  trade.realizedPnlTp1 = paperNumber(trade.realizedPnlTp1) + pnlPart;
  trade.realizedPnl = paperNumber(trade.realizedPnl) + pnlPart;
  trade.tp1ClosePct = closePct;
  trade.tp1Hit = true;
  trade.tp1HitAt = new Date().toISOString();
  trade.slAfterTp1 = paperNumber(trade.entryActual || trade.entryLimit);
  paperSetRemainingSize(trade, currentSize - closeSize);
  trade.status = 'TP1_PARTIAL';
  trade.unrealPnl = 0;
  trade.lastEvent = 'TP1_PARTIAL';
  paperAddTradeEvent(trade, 'TP1_PARTIAL', {price: exitPrice, size: closeSize});
  console.log('[paper] TP1 partial', trade.sym, closePct + '%', '@', exitPrice);
  void sendConfiguredAlert(paperPartialAlert(paperTradeView(trade)));
  return true;
}

async function fetchPaperTickersFromBitget() {
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
  payload._nexoraSource = 'Bitget Futures';
  return payload;
}

async function fetchPaperTickersFromBinance() {
  const pathName = '/fapi/v1/ticker/24hr';
  const target = APIS['/binance'] + pathName;
  const startedAt = Date.now();
  let result;
  try {
    result = await requestUpstream(target);
    markSourceHealth('/binance', {...result, latencyMs: Date.now() - startedAt, path: pathName});
  } catch (error) {
    markSourceError('/binance', error, pathName);
    throw error;
  }
  if (result.status < 200 || result.status >= 300) throw new Error('Binance tickers HTTP ' + result.status);
  let rows;
  try { rows = JSON.parse(result.body); }
  catch (_) { throw new Error('Binance tickers returned invalid JSON'); }
  if (!Array.isArray(rows)) throw new Error((rows && rows.msg) || 'Binance tickers response invalid');
  const symbols = new Set(PAPER_SYMBOLS.map(sym => sym + 'USDT'));
  const data = rows.filter(row => symbols.has(String(row.symbol || '').toUpperCase()))
    .map(row => ({
      symbol: String(row.symbol).toUpperCase(), lastPr: row.lastPrice,
      priceChangePercent: row.priceChangePercent, quoteVolume: row.quoteVolume,
      high24h: row.highPrice, low24h: row.lowPrice
    }));
  // Binance exposes the current funding snapshot in one public response. It
  // is useful context during fallback, while OI remains unavailable and
  // therefore still blocks strict paper entries until Bitget recovers.
  try {
    const fundingPath = '/fapi/v1/premiumIndex';
    const fundingStartedAt = Date.now();
    const fundingResult = await requestUpstream(APIS['/binance'] + fundingPath);
    markSourceHealth('/binance', {...fundingResult, latencyMs: Date.now() - fundingStartedAt, path: fundingPath});
    const fundingRows = JSON.parse(fundingResult.body);
    const bySymbol = new Map((Array.isArray(fundingRows) ? fundingRows : []).map(row => [String(row.symbol || '').toUpperCase(), row.lastFundingRate]));
    data.forEach(row => { if (bySymbol.has(row.symbol)) row.fundingRate = bySymbol.get(row.symbol); });
  } catch (_) {}
  if (!data.length) throw new Error('Binance tickers returned no Nexora symbols');
  return {
    code: '00000', msg: 'success', data,
    _nexoraFetchedAt: new Date().toISOString(),
    _nexoraSource: 'Binance Futures fallback'
  };
}

async function fetchPaperTickersFromOkx() {
  const pathName = '/api/v5/market/tickers?instType=SWAP';
  const target = APIS['/okx'] + '/api/v5/market/tickers?instType=SWAP';
  const startedAt = Date.now();
  let result;
  try {
    result = await requestUpstream(target);
    markSourceHealth('/okx', {...result, latencyMs: Date.now() - startedAt, path: pathName});
  } catch (error) {
    markSourceError('/okx', error, pathName);
    throw error;
  }
  if (result.status < 200 || result.status >= 300) throw new Error('OKX tickers HTTP ' + result.status);
  let payload;
  try { payload = JSON.parse(result.body); }
  catch (_) { throw new Error('OKX tickers returned invalid JSON'); }
  if (!payload || payload.code !== '0' || !Array.isArray(payload.data)) {
    throw new Error((payload && payload.msg) || 'OKX tickers response invalid');
  }
  const symbols = new Set(PAPER_SYMBOLS.map(sym => sym + '-USDT-SWAP'));
  const data = payload.data.filter(row => symbols.has(String(row.instId || '').toUpperCase()))
    .map(row => {
      const last = Number(row.last), open = Number(row.open24h);
      return {
        symbol: String(row.instId).toUpperCase().replace('-USDT-SWAP', 'USDT'),
        lastPr: row.last,
        priceChangePercent: open > 0 ? ((last - open) / open * 100) : 0,
        quoteVolume: row.volCcy24h || row.vol24h,
        high24h: row.high24h, low24h: row.low24h
      };
    });
  if (!data.length) throw new Error('OKX tickers returned no Nexora symbols');
  return {
    code: '00000', msg: 'success', data,
    _nexoraFetchedAt: new Date().toISOString(),
    _nexoraSource: 'OKX Swap fallback'
  };
}

async function fetchPaperTickers() {
  try {
    return await fetchPaperTickersFromBitget();
  } catch (bitgetError) {
    if (!PAPER_FALLBACK_ENABLED) throw bitgetError;
    const errors = [];
    for (const fallback of [fetchPaperTickersFromBinance, fetchPaperTickersFromOkx]) {
      try { return await fallback(); }
      catch (error) { errors.push(error.message); }
    }
    throw new Error('Bitget tickers unavailable; Binance/OKX fallback failed: ' + errors.join(' | '));
  }
}

const paperInstrumentCache = {loadedAt: 0, items: new Map()};

async function fetchPaperInstruments() {
  if (paperInstrumentCache.items.size && Date.now() - paperInstrumentCache.loadedAt < 6 * 60 * 60 * 1000) {
    return paperInstrumentCache.items;
  }
  const target = APIS['/bitget'] +
    '/api/v2/mix/market/contracts?productType=USDT-FUTURES';
  const startedAt = Date.now();
  let result;
  try {
    result = await requestUpstream(target);
    markSourceHealth('/bitget', {
      ...result, latencyMs: Date.now() - startedAt,
      path: '/api/v2/mix/market/contracts'
    });
  } catch (error) {
    markSourceError('/bitget', error, '/api/v2/mix/market/contracts');
    throw error;
  }
  if (result.status < 200 || result.status >= 300) throw new Error('Bitget contracts HTTP ' + result.status);
  const payload = JSON.parse(result.body);
  if (!payload || payload.code !== '00000' || !Array.isArray(payload.data)) {
    throw new Error((payload && payload.msg) || 'Bitget contracts response invalid');
  }
  const next = new Map();
  payload.data.forEach(item => {
    const sym = paperTickerSymbol(item);
    if (!sym) return;
    const pricePlace = paperFieldPresent(item.pricePlace) ? Number(item.pricePlace) : null;
    const priceEndStep = paperNumber(item.priceEndStep) || 1;
    // Bitget's priceEndStep is a count of final price units, not a quote-price
    // tick by itself. The true increment is priceEndStep * 10^(-pricePlace).
    const tickSize = Number.isInteger(pricePlace) && pricePlace >= 0 && pricePlace <= 12
      ? priceEndStep * Math.pow(10, -pricePlace) : null;
    next.set(sym, {
      tickSize: tickSize > 0 ? tickSize : null,
      pricePlace,
      sizePlace: paperFieldPresent(item.sizePlace) ? Number(item.sizePlace) : null,
      minTradeNum: paperNumber(item.minTradeNum || item.minTradeUSDT)
    });
  });
  paperInstrumentCache.items = next;
  paperInstrumentCache.loadedAt = Date.now();
  return next;
}

function applyPaperInstrumentMetadata(pairs, instruments) {
  if (!instruments || typeof instruments.get !== 'function') return pairs;
  pairs.forEach(pair => {
    const info = instruments.get(pair.sym);
    if (info) {
      pair.tickSize = info.tickSize;
      pair.pricePlace = info.pricePlace;
      pair.sizePlace = info.sizePlace;
      pair.minTradeNum = info.minTradeNum;
    }
  });
  return pairs;
}

async function runPaperScan(reason, requestedCycleKey) {
  const cfg = paperSettings();
  paperUpdateEquityPeak();
  const drawdownGuard = paperDrawdownPct() >= PAPER_MAX_DRAWDOWN_PCT;
  if (!paperState.enabled || paperState.paused || paperState.killSwitch || !cfg.strategyEnabled ||
      !paperWithinTradingHours(cfg) || paperBusy) return;
  if (drawdownGuard) {
    paperState.lastBlockReason = 'MAX_DRAWDOWN_REACHED';
    savePaperState();
    return;
  }
  const cycleKey = requestedCycleKey || paperCycleKey(Date.now());
  if (paperState.lastCycleKey === cycleKey) return;
  paperBusy = true;
  paperRuntime.scanAttempts += 1;
  paperRuntime.lastScanStartedAt = new Date().toISOString();
  try {
    const priorityRequested = Array.isArray(paperState.watchlistQueue) ? paperState.watchlistQueue.slice() : [];
    const prioritySet = new Set(priorityRequested.map(item => item.sym));
    const payload = await fetchPaperTickers();
    const instruments = await fetchPaperInstruments().catch(error => {
      console.error('[paper] contract precision unavailable:', error.message);
      return new Map();
    });
    let ranked = applyPaperInstrumentMetadata(buildPaperPairs(payload), instruments);
    ranked.forEach(pair => { pair.watchlistPriority = prioritySet.has(pair.sym); });
    ranked.sort((a, b) => Number(b.watchlistPriority) - Number(a.watchlistPriority) || b.rank - a.rank);
    // MTF is part of eligibility, not a post-selection decoration. Enrich the
    // strongest market-context candidates before choosing the three orders.
    const mtfCandidates = ranked.slice(0, PAPER_MTF_MAX_CANDIDATES);
    await enrichPaperMtfBatch(mtfCandidates);
    ranked = mtfCandidates.sort((a, b) => Number(b.watchlistPriority) - Number(a.watchlistPriority) || b.rank - a.rank);
    const activeSymbols = new Map();
    paperState.activeTrades
      .filter(t => paperIsActive(t) && paperIsTrialTrade(t))
      .forEach(t => activeSymbols.set(t.sym, (activeSymbols.get(t.sym) || 0) + 1));
    const equity = paperEquity();
    const activeRisk = paperActiveRiskDollar();
    const riskBudget = equity * PAPER_MAX_ACTIVE_RISK_PCT / 100;
    const perTradeRisk = equity * cfg.riskPct / 100;
    const dailyLossR = paperDailyLossR();
    const dailyGuard = dailyLossR <= -cfg.maxDailyLossR;
    const riskSlots = perTradeRisk > 0
      ? Math.floor(Math.max(0, riskBudget - activeRisk) / perTradeRisk)
      : 0;
    const capacity = Math.min(
      dailyGuard ? 0 : Math.max(0, cfg.maxActive - paperActiveCount()), riskSlots);
    const directionRisk = {LONG: 0, SHORT: 0};
    const directionCount = {LONG: 0, SHORT: 0};
    paperState.activeTrades
      .filter(t => paperIsActive(t) && paperIsTrialTrade(t) && directionRisk[t.dir] != null)
      .forEach(t => {
        directionRisk[t.dir] += paperTradeRiskDollar(t);
        directionCount[t.dir] += 1;
      });
    const correlatedActiveCount = paperState.activeTrades
      .filter(t => paperIsActive(t) && paperIsTrialTrade(t)).length;
    const selected = [];
    const rejected = [];
    const targetCount = Math.min(cfg.perScan, capacity);
    for (const pair of ranked) {
      if (selected.length >= targetCount) break;
      if (!paperSymbolAllowed(pair.sym, cfg)) {
        paperReject(rejected, pair, ['SYMBOL_FILTERED'], ['symbol whitelist/blacklist filter']);
        continue;
      }
      if ((activeSymbols.get(pair.sym) || 0) >= cfg.maxPerSymbol) continue;
      if (pair.mtfStatus !== 'FULL') {
        paperReject(rejected, pair,
          [pair.mtfStatus === 'STALE' ? 'MTF_STALE' : pair.mtfStatus === 'PARTIAL' ? 'MTF_PARTIAL' : 'MTF_UNAVAILABLE'],
          ['MTF data ' + (pair.mtfStatus || 'UNAVAILABLE')]);
        continue;
      }
      if (pair.mtfDirection === 'NEUTRAL') {
        const m15Neutral = pair.mtf && pair.mtf.M15 && pair.mtf.M15.direction === 'NEUTRAL';
        paperReject(rejected, pair, [m15Neutral ? 'M15_NEUTRAL' : 'MTF_NEUTRAL'],
          [m15Neutral ? 'trigger 15M netral' : 'MTF tidak memiliki arah dominan']);
        continue;
      }
      if (!pair.mtfSummary || !pair.mtfSummary.higherAligned ||
          !pair.mtfSummary.confirmAligned || !pair.mtfSummary.triggerAligned) {
        const conflictCodes = [];
        const conflictReasons = [];
        if (!pair.mtfSummary || !pair.mtfSummary.higherAligned) {
          conflictCodes.push('HIGHER_TF_CONFLICT');
          conflictReasons.push('H4/H1 tidak searah');
        }
        if (!pair.mtfSummary || !pair.mtfSummary.confirmAligned) {
          conflictCodes.push('M30_CONFIRM_CONFLICT');
          conflictReasons.push('30M tidak mengonfirmasi');
        }
        if (!pair.mtfSummary || !pair.mtfSummary.triggerAligned) {
          conflictCodes.push('M15_TRIGGER_CONFLICT');
          conflictReasons.push('trigger 15M tidak searah');
        }
        paperReject(rejected, pair, conflictCodes, conflictReasons);
        continue;
      }
      if ((pair.mtfAlignment || 0) < PAPER_MTF_MIN_ALIGNMENT ||
          (pair.confluencePct || 0) < cfg.minConfluence) {
        paperReject(rejected, pair, ['CONFLUENCE_LOW'], [
          'konfluensi MTF ' + (pair.confluencePct || 0) + '% di bawah ' + cfg.minConfluence + '%'
        ]);
        continue;
      }
      if (!pair.signalScores || (pair.signalScores.total || 0) < cfg.minSignalScore) {
        paperReject(rejected, pair, ['SIGNAL_SCORE_LOW'], [
          'signal score ' + ((pair.signalScores && pair.signalScores.total) || 0) + '/' + cfg.minSignalScore
        ]);
        continue;
      }
      if (pair.dataQuality !== 'FULL') {
        paperReject(rejected, pair, ['DATA_REJECTED'], ['data quality ' + pair.dataQuality]);
        continue;
      }
      const setup = paperSetup(pair);
      const setupValidation = validatePaperSetup(pair, setup);
      if (!setupValidation.ok) {
        paperReject(rejected, pair, setupValidation.reasonCodes, setupValidation.reasons);
        continue;
      }
      const directionBudget = equity * PAPER_MAX_DIRECTION_RISK_PCT / 100;
      if (directionRisk[setup.dir] + setupValidation.expectedLoss > directionBudget * 1.05) {
        paperReject(rejected, pair, ['DIRECTION_RISK_FULL'], [
          'risk ' + setup.dir + ' melewati budget ' + PAPER_MAX_DIRECTION_RISK_PCT + '%'
        ]);
        continue;
      }
      if (directionCount[setup.dir] >= PAPER_MAX_PER_DIRECTION) {
        paperReject(rejected, pair, ['DIRECTION_COUNT_FULL'], [
          'jumlah posisi ' + setup.dir + ' sudah mencapai ' + PAPER_MAX_PER_DIRECTION
        ]);
        continue;
      }
      if (correlatedActiveCount + selected.length >= PAPER_MAX_HIGH_CORR_POSITIONS) {
        paperReject(rejected, pair, ['CORRELATED_EXPOSURE_FULL'], [
          'exposure crypto berkorelasi tinggi sudah mencapai ' + PAPER_MAX_HIGH_CORR_POSITIONS
        ]);
        continue;
      }
      selected.push({pair, setup, setupValidation});
      activeSymbols.set(pair.sym, (activeSymbols.get(pair.sym) || 0) + 1);
      directionRisk[setup.dir] += setupValidation.expectedLoss;
      directionCount[setup.dir] += 1;
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
        originalSize: setup.size, remainingSize: setup.size,
        originalContracts: setup.contracts, remainingContracts: setup.contracts,
        riskPct: setup.riskPct, riskDollar: setup.riskDollar,
        riskDollarAtEntry: setup.riskDollar, tp1ClosePct: cfg.tp1ClosePct,
        tp1Hit: false, tp1HitAt: null, slAfterTp1: null,
        realizedPnlTp1: 0, realizedPnl: 0, realizedPnlFinal: 0,
        fillMethod: null, lastProcessedCandleAt: null,
        createdAt: Date.now(), openedAt: null, cycleKey,
        score: pair.sc, tier: pair.tier, fund: pair.fund, oi: pair.oi,
        volume: pair.volume, volumeRatio: pair.volumeRatio, mtf: pair.mtf,
        timeframe: '15M', tf: '15M', mode: PAPER_SIGNAL_MODE,
        signalMode: PAPER_SIGNAL_MODE, dataQuality: pair.dataQuality,
        strategyVersion: PAPER_STRATEGY_VERSION, cohortId: paperState.cohortId,
        signalCreatedAt: new Date().toISOString(),
        candleAtByTf: Object.fromEntries(['H4', 'H1', 'M30', 'M15'].map(tf =>
          [tf, pair.mtf && pair.mtf[tf] ? pair.mtf[tf].lastClosedCandleAt || pair.mtf[tf].candleAt : null])),
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
        tickSize: pair.tickSize || null, pricePlace: pair.pricePlace || null,
        expectedLossAtSl: item.setupValidation.expectedLoss,
        unrealPnl: 0, mfePnl: 0, maePnl: 0,
        executionModel: 'LIMIT_STRICT',
        executionClass: 'STRICT', legacy: false,
        reason: 'Auto VPS: 15M scan | ' + candidate.evidence.join('; ')
      };
      paperAddTradeEvent(trade, 'ORDER_PLACED', {price: setup.entry, reason: cycleKey, size: setup.size});
      paperState.activeTrades.push(trade);
      console.log('[paper] placed', id, pair.sym, setup.dir, '@', setup.entry);
      return paperTradeView(trade);
    });
    const evaluatedPriority = new Set(ranked.filter(pair => pair.watchlistPriority).map(pair => pair.sym));
    paperState.watchlistQueue = (paperState.watchlistQueue || []).filter(item => !evaluatedPriority.has(item.sym));
    paperState.lastCycleKey = cycleKey;
    paperState.lastScanAt = new Date().toISOString();
    paperState.lastError = null;
    paperRuntime.scansSucceeded += 1;
    paperRuntime.lastScanCompletedAt = paperState.lastScanAt;
    paperRuntime.lastScanError = null;
    const strictActiveCount = paperActiveCount();
    const hasMtfEligible = ranked.some(pair => pair.mtfStatus === 'FULL' &&
      pair.mtfDirection !== 'NEUTRAL' && pair.mtfAlignment >= PAPER_MTF_MIN_ALIGNMENT &&
      pair.confluencePct >= cfg.minConfluence &&
      pair.signalScores && pair.signalScores.total >= cfg.minSignalScore &&
      pair.dataQuality === 'FULL' &&
      pair.mtfSummary && pair.mtfSummary.higherAligned &&
      pair.mtfSummary.confirmAligned && pair.mtfSummary.triggerAligned);
    const blockReason = dailyGuard ? 'DAILY_DRAWDOWN_GUARD' : !capacity
      ? (paperActiveCount() >= cfg.maxActive ? 'MAX_ACTIVE_REACHED'
        : activeRisk >= riskBudget ? 'RISK_BUDGET_REACHED' : 'NO_CAPACITY')
      : (!placed.length ? (hasMtfEligible ? 'NO_VALID_UNALLOCATED_SETUP' : 'NO_VALID_MTF_SETUP') :
        placed.length < cfg.perScan ? 'PARTIAL_CAPACITY' : null);
    paperState.lastBlockReason = blockReason;
    paperState.recentScans.unshift({
      cycleKey, at: paperState.lastScanAt, reason: reason || '15M close',
      watchlistPriority: ranked.filter(pair => pair.watchlistPriority).map(pair => pair.sym),
      candidates: ranked.length,
      selected: ranked.slice(0, 10).map(paperCandidateView),
      placed,
      rejected: rejected.slice(0, 20),
      capacity: {
        requested: cfg.perScan, placed: placed.length,
        availableSlots: Math.max(0, cfg.maxActive - strictActiveCount),
        availableRisk: Number(Math.max(0, riskBudget - activeRisk).toFixed(2)),
        dailyLossR: Number(dailyLossR.toFixed(2)),
        blockReason
      }
    });
    paperState.recentScans = paperState.recentScans.slice(0, PAPER_MAX_RECENT_SCANS);
    savePaperState();
    console.log('[paper] scan complete', cycleKey, 'placed', placed.length);
    // Order-bearing scans are always reported. Empty-scan summaries are an
    // explicit opt-in because they create a recurring message every 15 minutes.
    if (placed.length || TELEGRAM_SCAN_SUMMARY) {
      void sendConfiguredAlert(paperScanAlert(cycleKey, placed));
    }
    if (blockReason && !placed.length) {
      sendRateLimitedAlert(
        'paper-guard:' + blockReason,
        paperCapacityAlert(paperStatus()),
        60 * 60 * 1000
      );
    }
  } catch (error) {
    paperRuntime.scansFailed += 1;
    paperRuntime.lastScanErrorAt = new Date().toISOString();
    paperRuntime.lastScanError = error.message;
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

function monitorPaperWatchlistAlerts(prices) {
  if (!PAPER_WATCHLIST_ALERTS_ENABLED ||
      !(TELEGRAM_ALERTS_ENABLED || Boolean(DISCORD_WEBHOOK_URL))) return false;
  const now = Date.now();
  let changed = false;
  (paperState.watchlistAlerts || []).forEach(item => {
    const price = paperNumber(prices[item.sym]);
    const low = paperNumber(item.entryLow);
    const high = paperNumber(item.entryHigh || item.entryLow);
    if (!price || !low || !high) return;
    const inZone = price >= Math.min(low, high) && price <= Math.max(low, high);
    const reference = price < low ? low : price > high ? high : price;
    const distancePct = reference > 0 ? Math.abs(price - reference) / reference * 100 : 99;
    if (!inZone && distancePct > Number(item.alertPct || 3)) return;
    const lastAlert = Date.parse(item.lastAlertAt || '') || 0;
    if (now - lastAlert < 15 * 60 * 1000) return;
    item.lastAlertAt = new Date(now).toISOString();
    changed = true;
    sendRateLimitedAlert('paper-watchlist:' + item.sym,
      'NEXORA WATCHLIST NEAR ENTRY\n' + item.sym + (item.dir ? ' ' + item.dir : '') +
      '\nPrice: ' + price + ' | Zone: ' + low + '-' + high +
      '\nDistance: ' + (inZone ? 'inside zone' : distancePct.toFixed(2) + '%') +
      '\nMTF/risk checks tetap wajib sebelum paper order.', 15 * 60 * 1000);
  });
  return changed;
}

async function monitorPaperTrades() {
  const hasWatchlistAlerts = PAPER_WATCHLIST_ALERTS_ENABLED &&
    Array.isArray(paperState.watchlistAlerts) && paperState.watchlistAlerts.length > 0;
  if (!paperState.enabled || paperBusy || (!paperState.activeTrades.length && !hasWatchlistAlerts)) return;
  paperBusy = true;
  let changed = false;
  paperRuntime.monitorAttempts += 1;
  try {
    const payload = await fetchPaperTickers();
    const prices = {};
    (Array.isArray(payload.data) ? payload.data : []).forEach(row => {
      const sym = paperTickerSymbol(row);
      const price = paperNumber(row.lastPr || row.last || row.close || row.markPrice);
      if (sym && price) prices[sym] = price;
    });
    const watchlistChanged = monitorPaperWatchlistAlerts(prices);
    const barsBySymbol = await fetchPaperMonitorBars(paperState.activeTrades.map(trade => trade.sym));
    const now = Date.now();
    const retained = [];
    paperState.activeTrades.forEach(trade => {
      const price = prices[trade.sym];
      const bars = barsBySymbol[trade.sym] || [];
      const unprocessedBars = bars.filter(bar => {
        const candleKey = new Date(bar.ts).toISOString();
        return !trade.lastProcessedCandleAt || candleKey > trade.lastProcessedCandleAt;
      });
      const latestBar = bars.length ? bars[bars.length - 1] : null;
      if (!price && !latestBar) {
        retained.push(trade);
        return;
      }
      trade.currentPrice = price || latestBar.close;
      if (trade.status === 'PENDING') {
        if (now - trade.createdAt >= PAPER_PENDING_TTL_MS) {
          trade.status = 'CANCELLED';
          trade.closedAt = new Date().toISOString();
          trade.closeReason = 'Pending expired after 120 minutes';
          trade.lastEvent = 'PENDING_EXPIRED';
          paperAddTradeEvent(trade, 'PENDING_EXPIRED', {price: trade.currentPrice, reason: trade.closeReason});
          paperState.closedTrades.unshift({
            ...paperTradeView(trade), closedAt: trade.closedAt,
            closeReason: trade.closeReason, outcome: 'CANCELLED', pnl: 0, r: 0
          });
          paperState.closedTrades = paperState.closedTrades.slice(0, PAPER_MAX_CLOSED_TRADES);
          changed = true;
          void sendConfiguredAlert(paperCloseAlert({
            ...paperTradeView(trade), exitPrice: trade.currentPrice,
            outcome: 'CANCELLED', r: 0, pnl: 0, closeReason: trade.closeReason
          }));
        } else {
          // A limit order is filled only when the completed 1m candle's range
          // crosses the limit. The ticker last price is deliberately not used
          // as a fill signal, because it can jump over an entry between polls.
          for (const bar of unprocessedBars) {
            const candleKey = new Date(bar.ts).toISOString();
            trade.lastProcessedCandleAt = candleKey;
            const filled = trade.dir === 'LONG'
              ? bar.low <= trade.entryLimit
              : bar.high >= trade.entryLimit;
            if (filled) {
              trade.status = 'OPEN';
              trade.entryActual = trade.entryLimit;
              trade.openedAt = new Date().toISOString();
              trade.fillMethod = '1M_HIGH_LOW';
              trade.fillCandleAt = candleKey;
              trade.lastEvent = 'LIMIT_FILLED';
              paperAddTradeEvent(trade, 'LIMIT_FILLED', {price: trade.entryActual, candleAt: candleKey});
              changed = true;
              void sendConfiguredAlert(paperFillAlert(trade));
              break;
            }
          }
          retained.push(trade);
        }
        return;
      }
      if (trade.status !== 'OPEN' && trade.status !== 'TP1_PARTIAL') {
        retained.push(trade);
        return;
      }
      const entry = trade.entryActual || trade.entryLimit;
      const remainingSize = paperTradeRemainingSize(trade);
      if (entry > 0 && price > 0 && remainingSize > 0) {
        trade.unrealPnl = paperTradePnl(trade, price, remainingSize);
        const markedPnl = paperNumber(trade.realizedPnl) + trade.unrealPnl;
        trade.mfePnl = Math.max(paperNumber(trade.mfePnl), markedPnl);
        trade.maePnl = Math.min(paperNumber(trade.maePnl), markedPnl);
      }
      if (!unprocessedBars.length) {
        retained.push(trade);
        return;
      }
      let keepTrade = true;
      for (const bar of unprocessedBars) {
        if (trade.status !== 'OPEN' && trade.status !== 'TP1_PARTIAL') break;
        const candleKey = new Date(bar.ts).toISOString();
        trade.lastProcessedCandleAt = candleKey;
        const stop = trade.status === 'TP1_PARTIAL'
          ? (trade.slAfterTp1 || trade.sl) : trade.sl;
        const target = trade.status === 'TP1_PARTIAL' ? trade.tp2 : trade.tp1;
        const sizeNow = paperTradeRemainingSize(trade);
        const stopHit = trade.dir === 'LONG' ? bar.low <= stop : bar.high >= stop;
        const targetHit = trade.dir === 'LONG' ? bar.high >= target : bar.low <= target;
        // When both levels occur inside one 1m candle, assume the stop
        // happened first. This is conservative and avoids manufacturing wins
        // from OHLC data that has no intrabar path.
        if (stopHit) {
          const stopPnl = paperTradePnl(trade, stop, sizeNow);
          const initialRisk = paperTradeInitialRiskDollar(trade);
          const projectedR = initialRisk > 0
            ? (paperNumber(trade.realizedPnl) + stopPnl) / initialRisk : 0;
          const outcome = projectedR > 0.05 ? 'WIN' : projectedR < -0.05 ? 'LOSS' : 'BREAKEVEN';
          closePaperTrade(trade, stop, outcome,
            trade.tp1Hit ? 'Hit SL after TP1' : 'Hit SL');
          changed = true;
          keepTrade = false;
          break;
        }
        if (targetHit && trade.status === 'OPEN') {
          partialClosePaperTrade(trade, trade.tp1);
          changed = true;
          // Do not let one candle hit TP1 and TP2. The next completed candle
          // must confirm the continuation after the partial exit.
          break;
        }
        if (targetHit && trade.status === 'TP1_PARTIAL') {
          closePaperTrade(trade, trade.tp2, 'WIN', 'Hit TP2');
          changed = true;
          keepTrade = false;
          break;
        }
      }
      if (keepTrade) retained.push(trade);
    });
    paperState.activeTrades = retained;
    paperState.lastMonitorAt = new Date().toISOString();
    paperState.lastPriceAt = paperState.lastMonitorAt;
    paperState.lastError = null;
    const equityPeakChanged = paperUpdateEquityPeak();
    paperRuntime.monitorsSucceeded += 1;
    paperRuntime.lastMonitorAt = paperState.lastMonitorAt;
    paperRuntime.lastMonitorError = null;
    if (changed || watchlistChanged || equityPeakChanged || paperState.activeTrades.length || paperState._needsSave) savePaperState();
  } catch (error) {
    paperRuntime.monitorsFailed += 1;
    paperRuntime.lastMonitorErrorAt = new Date().toISOString();
    paperRuntime.lastMonitorError = error.message;
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

function paperReplayParam(query, name) {
  return query && typeof query.get === 'function' ? query.get(name) : query && query[name];
}

function paperReplaySlice(rows, asOf, intervalMs) {
  const source = Array.isArray(rows) ? rows : [];
  const sliced = source.filter(row => row && row.ts + intervalMs <= asOf);
  sliced._nexoraFetchedAt = source._nexoraFetchedAt || new Date(asOf).toISOString();
  sliced._nexoraCandleIntervalMs = intervalMs;
  sliced._nexoraLatestRawTs = sliced.length ? sliced[sliced.length - 1].ts : null;
  sliced._nexoraLatestClosedTs = sliced._nexoraLatestRawTs;
  return sliced;
}

function paperReplayMetrics(trades) {
  const all = Array.isArray(trades) ? trades : [];
  const cancelled = all.filter(trade => trade.outcome === 'CANCELLED');
  const closed = all.filter(trade => trade.outcome !== 'CANCELLED');
  const wins = closed.filter(trade => paperNumber(trade.r) > 0);
  const losses = closed.filter(trade => paperNumber(trade.r) < 0);
  const netR = closed.reduce((sum, trade) => sum + paperNumber(trade.r), 0);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  closed.slice().sort((a, b) => (a.closedAt || '').localeCompare(b.closedAt || ''))
    .forEach(trade => {
      cumulative += paperNumber(trade.r);
      peak = Math.max(peak, cumulative);
      maxDrawdownR = Math.max(maxDrawdownR, peak - cumulative);
    });
  const filled = closed.filter(trade => trade.openedAt);
  const tp1Hits = closed.filter(trade => trade.tp1Hit).length;
  const tp2Hits = closed.filter(trade => String(trade.closeReason || '').toLowerCase().includes('tp2')).length;
  const stopLosses = closed.filter(trade => String(trade.closeReason || '').toLowerCase().includes('sl')).length;
  const grossProfitR = wins.reduce((sum, trade) => sum + paperNumber(trade.r), 0);
  const grossLossR = losses.reduce((sum, trade) => sum + paperNumber(trade.r), 0);
  const rValues = closed.map(trade => paperNumber(trade.r)).sort((a, b) => a - b);
  const median = rValues.length ? (rValues.length % 2
    ? rValues[(rValues.length - 1) / 2]
    : (rValues[rValues.length / 2 - 1] + rValues[rValues.length / 2]) / 2) : 0;
  const average = values => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const medianValue = values => {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const fillTimes = filled.map(trade => Math.max(0,
    (Date.parse(trade.openedAt) || 0) - (Number(trade.createdAt) || 0))).filter(Boolean);
  const durations = closed.map(trade => Math.max(0,
    (Date.parse(trade.closedAt) || 0) - (Date.parse(trade.openedAt) || 0))).filter(Boolean);
  return {
    sample: {
      orders: all.length, closed: closed.length, filled: filled.length,
      pendingExpired: cancelled.length, cancelled: cancelled.length,
      wins: wins.length, losses: losses.length,
      breakeven: closed.filter(trade => paperNumber(trade.r) === 0).length
    },
    metrics: {
      winRate: closed.length ? Number((wins.length / closed.length * 100).toFixed(1)) : 0,
      netR: Number(netR.toFixed(2)), averageR: closed.length ? Number((netR / closed.length).toFixed(3)) : 0,
      medianR: Number(median.toFixed(3)), expectancyR: closed.length ? Number((netR / closed.length).toFixed(3)) : 0,
      profitFactor: grossLossR < 0 ? Number((grossProfitR / Math.abs(grossLossR)).toFixed(2)) : null,
      maxDrawdownR: Number(maxDrawdownR.toFixed(2)), grossProfitR: Number(grossProfitR.toFixed(2)),
      grossLossR: Number(grossLossR.toFixed(2)), pnl: Number(closed.reduce((sum, trade) => sum + paperNumber(trade.pnl), 0).toFixed(2)),
      fillRate: all.length ? Number((filled.length / all.length * 100).toFixed(1)) : 0,
      averageTimeToFillMs: Math.round(average(fillTimes)), medianTimeToFillMs: Math.round(medianValue(fillTimes)),
      averageDurationMs: Math.round(average(durations)),
      averageMfePnl: Number(average(closed.map(trade => paperNumber(trade.mfePnl))).toFixed(2)),
      averageMaePnl: Number(average(closed.map(trade => paperNumber(trade.maePnl))).toFixed(2)),
      tp1Hits, tp2Hits, stopLosses,
      tp1HitRate: closed.length ? Number((tp1Hits / closed.length * 100).toFixed(1)) : 0,
      tp2HitRate: closed.length ? Number((tp2Hits / closed.length * 100).toFixed(1)) : 0,
      slHitRate: closed.length ? Number((stopLosses / closed.length * 100).toFixed(1)) : 0,
      pendingExpiredRate: all.length ? Number((cancelled.length / all.length * 100).toFixed(1)) : 0
    }
  };
}

async function paperReplay(query) {
  const rawSymbol = String(paperReplayParam(query, 'symbol') || 'BTC').toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const sym = PAPER_SYMBOLS.includes(rawSymbol) ? rawSymbol : 'BTC';
  const requestedDays = Number(paperReplayParam(query, 'days'));
  const days = Math.max(1, Math.min(7, Number.isFinite(requestedDays) ? requestedDays : 3));
  const endAt = Date.now();
  const startAt = endAt - days * 24 * 60 * 60 * 1000;
  const tfSpecs = [
    ['H4', '4H', 4 * 60 * 60 * 1000], ['H1', '1H', 60 * 60 * 1000],
    ['M30', '30m', 30 * 60 * 1000], ['M15', '15m', 15 * 60 * 1000]
  ];
  const limits = {
    H4: Math.ceil(days * 6) + PAPER_MIN_CANDLES + 10,
    H1: Math.ceil(days * 24) + PAPER_MIN_CANDLES + 10,
    M30: Math.ceil(days * 48) + PAPER_MIN_CANDLES + 10,
    M15: Math.ceil(days * 96) + PAPER_MIN_CANDLES * 16 + 10,
    M1: Math.ceil(days * 1440) + 10
  };
  const histories = {};
  for (const [name, granularity] of tfSpecs) {
    histories[name] = await fetchPaperCandleHistory(sym, granularity, limits[name]);
  }
  histories.M1 = await fetchPaperCandleHistory(sym, '1m', limits.M1);
  const instruments = await fetchPaperInstruments().catch(() => new Map());
  const pairInstrument = instruments && instruments.get ? instruments.get(sym) : null;
  const m15Rows = histories.M15;
  const minuteRows = histories.M1;
  const trades = [];
  const scans = [];
  const rejectionCounts = {};
  let active = null;
  let minuteCursor = 0;
  let equity = Number(PAPER_STARTING_EQUITY);
  let placed = 0;
  let eligibleSignals = 0;

  const event = (trade, type, at, price, reason) => {
    if (!Array.isArray(trade.events)) trade.events = [];
    trade.events.unshift({type, at: new Date(at).toISOString(), price: price == null ? null : price,
      candleAt: new Date(at).toISOString(), reason: reason || null});
    trade.events = trade.events.slice(0, 20);
    trade.lastEvent = type;
  };
  const replayTradeView = trade => ({
    ...paperTradeView(trade),
    exitPrice: trade.exitPrice == null ? null : trade.exitPrice,
    closedAt: trade.closedAt || null,
    outcome: trade.outcome || null,
    closeReason: trade.closeReason || null,
    r: trade.r == null ? null : trade.r,
    pnl: trade.pnl == null ? null : trade.pnl
  });
  const closeReplayTrade = (trade, exitPrice, outcome, reason, at) => {
    const closeSize = paperTradeRemainingSize(trade);
    const pnlPart = paperTradePnl(trade, exitPrice, closeSize);
    const totalPnl = paperNumber(trade.realizedPnl) + pnlPart;
    const initialRisk = paperTradeInitialRiskDollar(trade);
    const r = initialRisk > 0 ? totalPnl / initialRisk : 0;
    trade.status = 'CLOSED'; trade.closeStage = String(reason).toLowerCase().includes('tp2')
      ? 'CLOSED_TP2' : trade.tp1Hit ? 'CLOSED_AFTER_TP1' : 'CLOSED_DIRECT';
    trade.exitPrice = exitPrice; trade.closedAt = new Date(at).toISOString();
    trade.realizedPnl = totalPnl; trade.realizedPnlFinal = Number(pnlPart.toFixed(2));
    paperSetRemainingSize(trade, 0); trade.unrealPnl = 0;
    trade.outcome = outcome; trade.closeReason = reason; trade.r = Number(r.toFixed(2));
    trade.pnl = Number(totalPnl.toFixed(2)); event(trade, 'CLOSED', at, exitPrice, reason);
    trades.push(replayTradeView(trade)); equity += totalPnl; active = null;
  };
  const partialReplayTrade = (trade, exitPrice, at) => {
    const currentSize = paperTradeRemainingSize(trade);
    const closePct = PAPER_TP1_CLOSE_PCT;
    const closeSize = currentSize * closePct / 100;
    const pnlPart = paperTradePnl(trade, exitPrice, closeSize);
    trade.realizedPnlTp1 = paperNumber(trade.realizedPnlTp1) + pnlPart;
    trade.realizedPnl = paperNumber(trade.realizedPnl) + pnlPart;
    trade.tp1Hit = true; trade.tp1HitAt = new Date(at).toISOString();
    trade.slAfterTp1 = trade.entryActual || trade.entryLimit;
    paperSetRemainingSize(trade, currentSize - closeSize);
    trade.status = 'TP1_PARTIAL'; event(trade, 'TP1_PARTIAL', at, exitPrice, 'TP1 ' + closePct + '%');
  };
  const processMinuteBarsUntil = until => {
    while (minuteCursor < minuteRows.length && minuteRows[minuteCursor].ts + 60000 <= until) {
      const bar = minuteRows[minuteCursor++];
      if (!active) continue;
      const candleAt = bar.ts + 60000;
      if (active.status === 'PENDING') {
        if (candleAt >= active.createdAt + PAPER_PENDING_TTL_MS) {
          active.status = 'CANCELLED'; active.closedAt = new Date(candleAt).toISOString();
          active.closeReason = 'Pending expired after 120 minutes'; active.outcome = 'CANCELLED';
          event(active, 'PENDING_EXPIRED', candleAt, active.entryLimit, active.closeReason);
          trades.push(replayTradeView(active)); active = null; continue;
        }
        const filled = active.dir === 'LONG' ? bar.low <= active.entryLimit : bar.high >= active.entryLimit;
        if (filled) {
          active.status = 'OPEN'; active.entryActual = active.entryLimit;
          active.openedAt = new Date(candleAt).toISOString(); active.fillMethod = '1M_HIGH_LOW';
          active.fillCandleAt = new Date(bar.ts).toISOString(); event(active, 'LIMIT_FILLED', candleAt, active.entryActual);
        }
        continue;
      }
      const entry = active.entryActual || active.entryLimit;
      const size = paperTradeRemainingSize(active);
      active.currentPrice = bar.close; active.unrealPnl = paperTradePnl(active, bar.close, size);
      const marked = paperNumber(active.realizedPnl) + active.unrealPnl;
      active.mfePnl = Math.max(paperNumber(active.mfePnl), marked);
      active.maePnl = Math.min(paperNumber(active.maePnl), marked);
      const stop = active.status === 'TP1_PARTIAL' ? active.slAfterTp1 : active.sl;
      const target = active.status === 'TP1_PARTIAL' ? active.tp2 : active.tp1;
      const stopHit = active.dir === 'LONG' ? bar.low <= stop : bar.high >= stop;
      const targetHit = active.dir === 'LONG' ? bar.high >= target : bar.low <= target;
      if (stopHit) {
        const projected = paperTradePnl(active, stop, size);
        const projectedR = paperTradeInitialRiskDollar(active) > 0
          ? (paperNumber(active.realizedPnl) + projected) / paperTradeInitialRiskDollar(active) : 0;
        closeReplayTrade(active, stop, projectedR > 0.05 ? 'WIN' : projectedR < -0.05 ? 'LOSS' : 'BREAKEVEN',
          active.tp1Hit ? 'Hit SL after TP1' : 'Hit SL', candleAt);
      } else if (targetHit && active.status === 'OPEN') {
        partialReplayTrade(active, active.tp1, candleAt);
      } else if (targetHit && active.status === 'TP1_PARTIAL') {
        closeReplayTrade(active, active.tp2, 'WIN', 'Hit TP2', candleAt);
      }
    }
  };

  const recordRejection = code => { rejectionCounts[code] = (rejectionCounts[code] || 0) + 1; };
  const scanRows = m15Rows.filter(row => row.ts + 15 * 60 * 1000 >= startAt && row.ts + 15 * 60 * 1000 <= endAt);
  for (const triggerRow of scanRows) {
    const asOf = triggerRow.ts + 15 * 60 * 1000;
    processMinuteBarsUntil(asOf);
    const snapshotRows = {};
    for (const [name, _, intervalMs] of tfSpecs) {
      snapshotRows[name] = paperReplaySlice(histories[name], asOf, intervalMs);
    }
    const lastM15 = snapshotRows.M15[snapshotRows.M15.length - 1];
    if (!lastM15 || Object.values(snapshotRows).some(rows => rows.length < PAPER_MIN_CANDLES)) continue;
    const lookback = snapshotRows.M15.slice(-97, -1);
    const previousClose = lookback.length ? lookback[0].close : lastM15.close;
    const chg = previousClose ? (lastM15.close - previousClose) / previousClose * 100 : 0;
    const pair = {
      sym, price: lastM15.close, chg, volume: lastM15.volume, fund: 0, oi: 0, oiUSD: 1,
      oiReady: true, fundingAvailable: true, oiAvailable: true,
      volumeAvailable: lastM15.volume > 0, volumeRatio: 1, sig: paperSignal(chg, 0, 0),
      contextScoreBreakdown: paperScoreDetails(chg, 0, 0, true, 1),
      mtf: {
        H4: paperTimeframeEvidence(snapshotRows.H4, 'H4', asOf),
        H1: paperTimeframeEvidence(snapshotRows.H1, 'H1', asOf),
        M30: paperTimeframeEvidence(snapshotRows.M30, 'M30', asOf),
        M15: paperTimeframeEvidence(snapshotRows.M15, 'M15', asOf)
      }
    };
    if (pairInstrument) {
      pair.tickSize = pairInstrument.tickSize; pair.pricePlace = pairInstrument.pricePlace;
      pair.sizePlace = pairInstrument.sizePlace; pair.minTradeNum = pairInstrument.minTradeNum;
    }
    applyPaperMtf(pair, asOf);
    const scan = {at: new Date(asOf).toISOString(), cycleKey: paperCycleKey(asOf - 1), sym,
      price: pair.price, direction: pair.mtfDirection, mtfAlignment: pair.mtfAlignment,
      confluencePct: pair.confluencePct, signalScore: pair.signalScores && pair.signalScores.total,
      eligible: false, rejectionCodes: []};
    if (active) { scan.rejectionCodes.push('ACTIVE_POSITION'); recordRejection('ACTIVE_POSITION'); scans.push(scan); continue; }
    const reject = code => { scan.rejectionCodes.push(code); recordRejection(code); };
    if (pair.mtfStatus !== 'FULL') reject(pair.mtfStatus === 'STALE' ? 'MTF_STALE' : 'MTF_PARTIAL');
    else if (pair.mtfDirection === 'NEUTRAL') reject('MTF_NEUTRAL');
    else if (!pair.mtfSummary.higherAligned) reject('HIGHER_TF_CONFLICT');
    else if (!pair.mtfSummary.confirmAligned) reject('M30_CONFIRM_CONFLICT');
    else if (!pair.mtfSummary.triggerAligned) reject('M15_TRIGGER_CONFLICT');
    else if (pair.mtfAlignment < PAPER_MTF_MIN_ALIGNMENT || pair.confluencePct < PAPER_MIN_CONFLUENCE) reject('CONFLUENCE_LOW');
    else if (!pair.signalScores || pair.signalScores.total < PAPER_MIN_SIGNAL_SCORE) reject('SIGNAL_SCORE_LOW');
    else if (pair.dataQuality !== 'FULL') reject('DATA_REJECTED');
    if (scan.rejectionCodes.length) { scans.push(scan); continue; }
    const setup = paperSetup(pair, {equity});
    const validation = validatePaperSetup(pair, setup);
    if (!validation.ok) { validation.reasonCodes.forEach(reject); scans.push(scan); continue; }
    eligibleSignals += 1; scan.eligible = true; scan.setupValidation = validation;
    const id = 'REPLAY-' + String(placed + 1).padStart(5, '0');
    active = {
      id, sym, dir: setup.dir, entryLimit: setup.entry, entryActual: null, currentPrice: pair.price,
      sl: setup.sl, tp1: setup.tp1, tp2: setup.tp2, size: setup.size, originalSize: setup.size,
      remainingSize: setup.size, contracts: setup.contracts, originalContracts: setup.contracts,
      remainingContracts: setup.contracts, riskPct: setup.riskPct, riskDollar: setup.riskDollar,
      riskDollarAtEntry: setup.riskDollar, expectedLossAtSl: validation.expectedLoss,
      tp1ClosePct: PAPER_TP1_CLOSE_PCT, tp1Hit: false, realizedPnlTp1: 0, realizedPnl: 0,
      unrealPnl: 0, mfePnl: 0, maePnl: 0, status: 'PENDING', createdAt: asOf,
      openedAt: null, cycleKey: scan.cycleKey, score: pair.sc, tier: pair.tier, fund: pair.fund,
      oi: pair.oi, volume: pair.volume, volumeRatio: pair.volumeRatio, mtf: pair.mtf,
      timeframe: '15M', tf: '15M', mode: 'REPLAY', signalMode: PAPER_SIGNAL_MODE,
      dataQuality: pair.dataQuality, strategyVersion: PAPER_STRATEGY_VERSION,
      cohortId: 'replay-' + new Date(startAt).toISOString().slice(0, 10), signalCreatedAt: new Date(asOf).toISOString(),
      candleAtByTf: Object.fromEntries(tfSpecs.map(([name]) => [name, pair.mtf[name].lastClosedCandleAt])),
      dataAt: new Date(asOf).toISOString(), source: 'Bitget Futures historical replay',
      confluencePct: pair.confluencePct, mtfDirection: pair.mtfDirection, mtfAlignment: pair.mtfAlignment,
      mtfSummary: pair.mtfSummary, indicators: pair.mtf.M15.indicators,
      candlePattern: pair.mtf.M15.indicators && pair.mtf.M15.indicators.candlePattern,
      signalScores: pair.signalScores, support: pair.support, resistance: pair.resistance,
      structureSupport: setup.structureSupport, structureResistance: setup.structureResistance,
      atr: setup.atr, tickSize: pair.tickSize, pricePlace: pair.pricePlace,
      signalReasons: paperCandidateView(pair).evidence, scoreBreakdown: pair.scoreBreakdown,
      setupValidation: validation, executionModel: 'LIMIT_STRICT', executionClass: 'STRICT', events: []
    };
    event(active, 'ORDER_PLACED', asOf, setup.entry, 'historical replay'); placed += 1; scans.push(scan);
  }
  processMinuteBarsUntil(endAt);
  const openAtEnd = active ? paperTradeView(active) : null;
  const calculated = paperReplayMetrics(trades);
  return {
    ok: true, strategyVersion: PAPER_STRATEGY_VERSION, executionModel: 'LIMIT_STRICT',
    sameTechnicalLogic: true, derivativesMode: 'NEUTRAL_REPLAY',
    source: ((histories.M15 && histories.M15._nexoraSource) || 'Bitget Futures') + ' historical candles', symbol: sym, days,
    from: new Date(startAt).toISOString(), to: new Date(endAt).toISOString(),
    candles: Object.fromEntries(Object.entries(histories).map(([name, rows]) => [name, rows.length])),
    summary: {scans: scans.length, eligibleSignals, placed,
      closed: trades.filter(t => t.outcome !== 'CANCELLED').length,
      openAtEnd: openAtEnd ? 1 : 0, expired: trades.filter(t => t.outcome === 'CANCELLED').length},
    rejectionCounts, sample: calculated.sample, metrics: calculated.metrics,
    equityCurve: trades.filter(t => t.outcome !== 'CANCELLED').map(t => ({at: t.closedAt, r: t.r, pnl: t.pnl})),
    scans: scans.slice(-500), trades: trades.slice(-500), openTrade: openAtEnd,
    note: 'Replay memakai MTF + ATR/structure + limit OHLC 1m + TP1 partial + expiry yang sama. Funding/OI historis dinetralkan karena endpoint historisnya tidak konsisten; hasil ini bukan jaminan profit.'
  };
}

function paperStatus() {
  const cfg = paperSettings();
  const active = paperState.activeTrades.map(paperTradeView);
  const open = active.filter(t => t.status === 'OPEN').length;
  const partial = active.filter(t => t.status === 'TP1_PARTIAL').length;
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
  const preUpgradeRealizedPnl = paperState.closedTrades
    .filter(trade => paperIsPreUpgradeTrade(trade))
    .reduce((sum, trade) => sum + paperNumber(trade.pnl), 0);
  const legacyRealizedPnl = paperState.closedTrades
    .filter(trade => paperTradeStrategyVersion(trade) === 'LEGACY')
    .reduce((sum, trade) => sum + paperNumber(trade.pnl), 0);
  const equity = paperEquity();
  const strictActiveCount = paperActiveCount();
  const legacyActiveCount = paperLegacyActiveCount();
  const preUpgradeActiveCount = paperPreUpgradeActiveCount();
  const activeRisk = paperActiveRiskDollar();
  const legacyActiveRisk = paperState.activeTrades
    .filter(trade => paperIsActive(trade) && paperTradeStrategyVersion(trade) === 'LEGACY')
    .reduce((sum, trade) => sum + paperTradeRiskDollar(trade), 0);
  const preUpgradeActiveRisk = paperState.activeTrades
    .filter(trade => paperIsActive(trade) && paperIsPreUpgradeTrade(trade))
    .reduce((sum, trade) => sum + paperTradeRiskDollar(trade), 0);
  const trialDirectionCounts = paperState.activeTrades
    .filter(trade => paperIsActive(trade) && paperIsTrialTrade(trade))
    .reduce((counts, trade) => {
      if (counts[trade.dir] != null) counts[trade.dir] += 1;
      return counts;
    }, {LONG: 0, SHORT: 0});
  const riskBudget = equity * PAPER_MAX_ACTIVE_RISK_PCT / 100;
  const availableSlots = Math.max(0, cfg.maxActive - strictActiveCount);
  const availableRisk = Math.max(0, riskBudget - activeRisk);
  const stats = paperStats();
  const trialStats = paperStats({
    strategyVersion: PAPER_STRATEGY_VERSION,
    cohortId: paperState.cohortId
  });
  const dailyLossR = paperDailyLossR();
  paperUpdateEquityPeak();
  const equityPeak = paperEquityPeak();
  const drawdownPct = paperDrawdownPct();
  const drawdownGuard = drawdownPct >= PAPER_MAX_DRAWDOWN_PCT;
  const persistedBlockReason = paperState.lastBlockReason;
  const blockReason = paperState.killSwitch ? 'KILL_SWITCH' : paperState.paused ? 'PAUSED' :
    !cfg.strategyEnabled ? 'STRATEGY_DISABLED' : !paperWithinTradingHours(cfg) ? 'OUTSIDE_TRADING_HOURS' :
    drawdownGuard ? 'MAX_DRAWDOWN_REACHED' :
    persistedBlockReason === 'MAX_DRAWDOWN_REACHED' ? null : persistedBlockReason ||
    (availableSlots <= 0 ? 'MAX_ACTIVE_REACHED' : availableRisk < equity * cfg.riskPct / 100
      ? 'RISK_BUDGET_REACHED' : null);
  const dailyPnlDate = new Date().toISOString().slice(0, 10);
  const dailyRealizedPnl = closed.filter(trade => paperIsTrialTrade(trade) &&
    trade.outcome !== 'CANCELLED' && String(trade.closedAt || '').slice(0, 10) === dailyPnlDate)
    .reduce((sum, trade) => sum + paperNumber(trade.pnl), 0);
  return {
    ok: true, service: 'nexora-paper-bot', enabled: paperState.enabled,
    running: paperStarted, paused: !!paperState.paused, killSwitch: !!paperState.killSwitch,
    interval: '15M', perScan: cfg.perScan,
    pendingTtlMinutes: PAPER_PENDING_TTL_MS / 60000, maxConcurrent: cfg.maxActive,
    maxPerSymbol: cfg.maxPerSymbol,
    candleLimit: PAPER_CANDLE_LIMIT, mtfMinAlignment: PAPER_MTF_MIN_ALIGNMENT,
    minConfluence: cfg.minConfluence, signalMode: PAPER_SIGNAL_MODE,
    minSignalScore: cfg.minSignalScore,
    strategyVersion: PAPER_STRATEGY_VERSION, cohortId: paperState.cohortId,
    minCandles: PAPER_MIN_CANDLES, monitorGranularity: '1m',
    fallbacks: {enabled: PAPER_FALLBACK_ENABLED, order: ['Bitget', 'Binance Futures', 'OKX Swap']},
    tp1ClosePct: cfg.tp1ClosePct, maxDailyLossR: cfg.maxDailyLossR,
    maxDrawdownPct: PAPER_MAX_DRAWDOWN_PCT,
    equityPeak: Number(equityPeak.toFixed(2)),
    drawdownPct: Number(drawdownPct.toFixed(2)),
    drawdownGuard,
    maxDirectionRiskPct: PAPER_MAX_DIRECTION_RISK_PCT,
    maxPerDirection: PAPER_MAX_PER_DIRECTION,
    maxHighCorrelationPositions: PAPER_MAX_HIGH_CORR_POSITIONS,
    mtfCandidates: PAPER_MTF_MAX_CANDIDATES,
    settings: cfg,
    freshnessMaxAgeSec: Object.fromEntries(Object.entries(PAPER_TIMEFRAME_MAX_AGE_MS)
      .map(([tf, ms]) => [tf, Math.round(ms / 1000)])),
    strictActiveCount, trialActiveCount: strictActiveCount,
    legacyActiveCount, preUpgradeActiveCount, availableSlots,
    trialDirectionCounts,
    startingEquity: paperNumber(paperState.startingEquity || PAPER_STARTING_EQUITY),
    realizedPnl: Number(realizedPnl.toFixed(2)),
    unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
    equity: Number(equity.toFixed(2)),
    totalRealizedPnl: Number(totalRealizedPnl.toFixed(2)),
    totalUnrealizedPnl: Number(totalUnrealizedPnl.toFixed(2)),
    legacyRealizedPnl: Number(legacyRealizedPnl.toFixed(2)),
    preUpgradeRealizedPnl: Number(preUpgradeRealizedPnl.toFixed(2)),
    legacyUnrealizedPnl: Number((totalUnrealizedPnl - unrealizedPnl).toFixed(2)),
    totalEquity: Number((paperNumber(paperState.startingEquity || PAPER_STARTING_EQUITY) +
      totalRealizedPnl + totalUnrealizedPnl).toFixed(2)),
    riskPct: cfg.riskPct,
    maxActiveRiskPct: PAPER_MAX_ACTIVE_RISK_PCT,
    activeRisk: Number(activeRisk.toFixed(2)),
    legacyActiveRisk: Number(Math.max(0, legacyActiveRisk).toFixed(2)),
    preUpgradeActiveRisk: Number(Math.max(0, preUpgradeActiveRisk).toFixed(2)),
    riskBudget: Number(riskBudget.toFixed(2)),
    availableRisk: Number(availableRisk.toFixed(2)),
    dailyLossR: Number(dailyLossR.toFixed(2)),
    dailyPnlDate,
    dailyRealizedPnl: Number(dailyRealizedPnl.toFixed(2)),
    dailySummary: paperDailySummaryView(dailyPnlDate),
    dailyGuard: dailyLossR <= -cfg.maxDailyLossR,
    blockReason,
    alerts: {
      telegram: TELEGRAM_ALERTS_ENABLED,
      scanSummary: TELEGRAM_SCAN_SUMMARY,
      sent: telegramState.sent,
      lastAttemptAt: telegramState.lastAttemptAt,
      lastSuccessAt: telegramState.lastSuccessAt,
      lastError: telegramState.lastError,
      discord: Boolean(DISCORD_WEBHOOK_URL),
      dailySummary: PAPER_DAILY_SUMMARY_SCHEDULER ? 'scheduler opt-in; requires Telegram or Discord configuration' : 'dashboard-only until scheduler is explicitly enabled',
      riskGuard: 'guard notifications are emitted for configured alert channels',
      watchlistNearEntry: PAPER_WATCHLIST_ALERTS_ENABLED &&
        (TELEGRAM_ALERTS_ENABLED || Boolean(DISCORD_WEBHOOK_URL))
    },
    state: {
      schemaVersion: PAPER_SCHEMA_VERSION,
      savedAt: paperState.lastSavedAt,
      backupFile: path.basename(PAPER_STATE_BACKUP_FILE),
      backupRotatedFile: path.basename(PAPER_STATE_BACKUP_2_FILE)
    },
    lastScanAt: paperState.lastScanAt, lastCycleKey: paperState.lastCycleKey,
    nextScanAt: new Date(paperNextQuarter(Date.now())).toISOString(),
    lastMonitorAt: paperState.lastMonitorAt, lastPriceAt: paperState.lastPriceAt,
    lastError: paperState.lastError, activeTrades: active,
    watchlistQueue: (paperState.watchlistQueue || []).slice(),
    watchlistAlerts: (paperState.watchlistAlerts || []).slice(),
    recentScans: paperState.recentScans.slice(0, 20),
    closedTrades: closed.slice(0, 100),
    invalidatedTrades: paperState.invalidatedTrades.slice(0, 100),
    stats: stats.metrics,
    statsSample: stats.sample,
    trialStats: trialStats.metrics,
    trialStatsSample: trialStats.sample,
    runtime: {
      lastScanSuccessAt: paperRuntime.lastScanCompletedAt,
      lastMonitorSuccessAt: paperRuntime.lastMonitorAt,
      scanAttempts: paperRuntime.scanAttempts,
      scansSucceeded: paperRuntime.scansSucceeded,
      scansFailed: paperRuntime.scansFailed,
      monitorAttempts: paperRuntime.monitorAttempts,
      monitorsSucceeded: paperRuntime.monitorsSucceeded,
      monitorsFailed: paperRuntime.monitorsFailed
    },
    summary: {
      open, partial, pending, closed: closed.length, wins, losses,
      invalidated: paperState.invalidatedTrades.length,
      netR: Number(netR.toFixed(2)),
      equity: Number(equity.toFixed(2))
    }
  };
}

function paperDiagnostics() {
  const cfg = paperSettings();
  const status = paperStatus();
  return {
    ok: true,
    service: 'nexora-paper-bot',
    strategyVersion: PAPER_STRATEGY_VERSION,
    cohortId: paperState.cohortId,
    state: status.state,
    lastScanAt: status.lastScanAt,
    nextScanAt: status.nextScanAt,
    lastMonitorAt: status.lastMonitorAt,
    config: {
      interval: '15M', perScan: cfg.perScan, pendingTtlMinutes: PAPER_PENDING_TTL_MS / 60000,
      minCandles: PAPER_MIN_CANDLES, candleLimit: PAPER_CANDLE_LIMIT,
      mtfMinAlignment: PAPER_MTF_MIN_ALIGNMENT, minConfluence: cfg.minConfluence,
      minSignalScore: cfg.minSignalScore,
      minRR: cfg.minRR, riskPct: cfg.riskPct,
      maxActiveRiskPct: PAPER_MAX_ACTIVE_RISK_PCT,
      maxDirectionRiskPct: PAPER_MAX_DIRECTION_RISK_PCT,
      maxPerDirection: PAPER_MAX_PER_DIRECTION,
      maxHighCorrelationPositions: PAPER_MAX_HIGH_CORR_POSITIONS,
      maxDailyLossR: cfg.maxDailyLossR, tp1ClosePct: cfg.tp1ClosePct,
      maxDrawdownPct: PAPER_MAX_DRAWDOWN_PCT,
      monitorGranularity: '1m'
    },
    runtime: {
      ...paperRuntime,
      rejectionCounts: {...paperRuntime.rejectionCounts}
    },
    sources: sourceHealthView(),
    bot: {
      enabled: paperState.enabled, running: paperStarted, paused: !!paperState.paused,
      killSwitch: !!paperState.killSwitch, settings: cfg,
      lastScanAt: status.lastScanAt, lastMonitorAt: status.lastMonitorAt,
      nextScanAt: status.nextScanAt,
      lastPriceAt: status.lastPriceAt, lastError: status.lastError,
      blockReason: status.blockReason, trialActiveCount: status.trialActiveCount,
      preUpgradeActiveCount: status.preUpgradeActiveCount,
      trialDirectionCounts: status.trialDirectionCounts,
      dailyLossR: status.dailyLossR, dailyGuard: status.dailyGuard,
      equityPeak: status.equityPeak, drawdownPct: status.drawdownPct,
      drawdownGuard: status.drawdownGuard, maxDrawdownPct: status.maxDrawdownPct
    }
  };
}

function paperAdminAuthorized(req, requestUrl) {
  if (!PAPER_ADMIN_TOKEN) return false;
  const header = String(req.headers.authorization || '');
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  // Do not accept tokens in query strings: URLs are commonly retained in
  // browser history, proxy logs, and referrer headers.
  return bearer === PAPER_ADMIN_TOKEN;
}

function requirePaperAdmin(req, requestUrl, res) {
  if (!PAPER_ADMIN_TOKEN) {
    paperControlError(res, 503, 'Admin controls disabled: set PAPER_ADMIN_TOKEN in /etc/nexora/nexora.env');
    return false;
  }
  if (!paperAdminAuthorized(req, requestUrl)) {
    res.writeHead(401, {...corsHeaders(), 'WWW-Authenticate': 'Bearer', 'Content-Type': 'application/json'});
    res.end(JSON.stringify({ok: false, error: 'Admin authorization required'}));
    return false;
  }
  return true;
}

function readJsonBody(req, maxBytes) {
  const limit = maxBytes || 64 * 1024;
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (_) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function paperControlError(res, status, message) {
  send(res, status, JSON.stringify({ok: false, error: message}));
}

function paperFindTrade(id) {
  const target = String(id || '').trim();
  return paperState.activeTrades.find(trade => String(trade.id) === target) || null;
}

function cancelPaperTrade(trade, reason) {
  if (!trade || !paperIsActive(trade)) return false;
  const at = new Date().toISOString();
  const closeReason = reason || 'Cancelled from dashboard';
  trade.status = 'CANCELLED';
  trade.closedAt = at;
  trade.exitPrice = paperNumber(trade.currentPrice || trade.entryLimit) || trade.entryLimit;
  trade.outcome = 'CANCELLED';
  trade.closeReason = closeReason;
  trade.r = 0;
  trade.pnl = Number((trade.realizedPnl || 0).toFixed(2));
  trade.unrealPnl = 0;
  paperSetRemainingSize(trade, 0);
  paperAddTradeEvent(trade, 'CANCELLED', {price: trade.exitPrice, reason: closeReason});
  paperState.closedTrades.unshift({...paperTradeView(trade), exitPrice: trade.exitPrice,
    closedAt: at, outcome: 'CANCELLED', closeReason, r: 0, pnl: trade.pnl});
  paperState.closedTrades = paperState.closedTrades.slice(0, PAPER_MAX_CLOSED_TRADES);
  void sendConfiguredAlert(paperCloseAlert({...paperTradeView(trade), exitPrice: trade.exitPrice,
    outcome: 'CANCELLED', r: 0, pnl: trade.pnl, closeReason}));
  return true;
}

async function closePaperTradeFromDashboard(trade, reason) {
  if (!trade || !paperIsActive(trade)) return false;
  if (trade.status === 'PENDING') return cancelPaperTrade(trade, reason || 'Pending cancelled from dashboard');
  let price = paperNumber(trade.currentPrice || trade.entryActual || trade.entryLimit);
  try {
    const payload = await fetchPaperTickers();
    const row = Array.isArray(payload.data) ? payload.data.find(item => paperTickerSymbol(item) === trade.sym) : null;
    price = paperNumber(row && (row.lastPr || row.last || row.close || row.markPrice)) || price;
  } catch (_) {}
  if (!price) return false;
  closePaperTrade(trade, price, undefined, reason || 'Closed from dashboard');
  return true;
}

function updatePaperSettings(input) {
  const current = paperSettings();
  const body = input && typeof input === 'object' ? input : {};
  const next = {...current};
  const numeric = ['perScan', 'maxActive', 'maxPerSymbol', 'riskPct', 'maxDailyLossR',
    'minConfluence', 'minSignalScore', 'minRR', 'tp1ClosePct'];
  numeric.forEach(name => {
    if (body[name] != null && Number.isFinite(Number(body[name]))) next[name] = Number(body[name]);
  });
  ['strategyEnabled', 'tradingHoursEnabled'].forEach(name => {
    if (body[name] != null) next[name] = body[name] === true || body[name] === 'true';
  });
  ['tradingStartUtc', 'tradingEndUtc'].forEach(name => {
    if (body[name] != null) next[name] = String(body[name]);
  });
  ['whitelist', 'blacklist'].forEach(name => {
    if (Array.isArray(body[name])) next[name] = [...new Set(body[name].map(value =>
      String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean))].slice(0, 200);
  });
  next.perScan = Math.max(1, Math.min(10, Math.round(Number(next.perScan) || PAPER_PER_SCAN)));
  next.maxActive = Math.max(3, Math.min(100, Math.round(Number(next.maxActive) || PAPER_MAX_ACTIVE)));
  next.maxPerSymbol = Math.max(1, Math.min(3, Math.round(Number(next.maxPerSymbol) || PAPER_MAX_PER_SYMBOL)));
  next.riskPct = Math.max(0.1, Math.min(2, Number(next.riskPct) || PAPER_RISK_PCT));
  next.maxDailyLossR = Math.max(0.5, Math.min(20, Number(next.maxDailyLossR) || PAPER_MAX_DAILY_LOSS_R));
  next.minConfluence = Math.max(50, Math.min(95, Number(next.minConfluence) || PAPER_MIN_CONFLUENCE));
  next.minSignalScore = Math.max(50, Math.min(95, Number(next.minSignalScore) || PAPER_MIN_SIGNAL_SCORE));
  next.minRR = Math.max(1.5, Math.min(5, Number(next.minRR) || PAPER_MIN_RR));
  next.tp1ClosePct = Math.max(10, Math.min(90, Number(next.tp1ClosePct) || PAPER_TP1_CLOSE_PCT));
  const activeStrategyKey = PAPER_STRATEGY_KEYS.includes(PAPER_STRATEGY_VERSION)
    ? PAPER_STRATEGY_VERSION : 'MTF_ATR_V2';
  const existingStrategies = paperNormaliseStrategySettings(current.strategySettings);
  if (body.strategySettings && typeof body.strategySettings === 'object') {
    const mergedStrategies = {...existingStrategies};
    PAPER_STRATEGY_KEYS.forEach(key => {
      if (body.strategySettings[key] && typeof body.strategySettings[key] === 'object') {
        mergedStrategies[key] = {...mergedStrategies[key], ...body.strategySettings[key]};
      }
    });
    next.strategySettings = paperNormaliseStrategySettings(mergedStrategies);
    const active = next.strategySettings[activeStrategyKey];
    next.maxActive = active.maxActive;
    next.riskPct = active.riskPct;
    next.minRR = active.minRR;
    next.strategyEnabled = active.enabled;
  } else {
    const active = {...existingStrategies[activeStrategyKey]};
    active.enabled = next.strategyEnabled;
    active.maxActive = next.maxActive;
    active.riskPct = next.riskPct;
    active.minRR = next.minRR;
    next.strategySettings = paperNormaliseStrategySettings({
      ...existingStrategies, [activeStrategyKey]: active
    });
  }
  paperState.settings = next;
  paperState.settingsUpdatedAt = new Date().toISOString();
  savePaperState();
  return paperSettings();
}

function manualPaperTrade(input) {
  const body = input && typeof input === 'object' ? input : {};
  const sym = String(body.sym || body.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const dir = String(body.dir || body.direction || '').toUpperCase();
  const entry = paperNumber(body.entry || body.entryLimit);
  const sl = paperNumber(body.sl);
  const tp1 = paperNumber(body.tp1);
  const tp2 = paperNumber(body.tp2);
  if (!sym || !['LONG', 'SHORT'].includes(dir) || !entry || !sl || !tp1 || !tp2) {
    throw new Error('Manual trade butuh symbol, direction, entry, SL, TP1, dan TP2');
  }
  if (!paperSymbolAllowed(sym, paperSettings())) throw new Error('Symbol diblokir oleh whitelist/blacklist');
  const currentPrice = paperNumber(body.currentPrice || entry);
  const equity = paperEquity();
  const cfg = paperSettings();
  const riskDollar = Math.max(0, equity * cfg.riskPct / 100);
  const size = paperNumber(body.size) || (Math.abs(entry - sl) > 0
    ? riskDollar / (Math.abs(entry - sl) / entry) : 0);
  const contracts = paperNumber(body.contracts) || (entry > 0 ? size / entry : 0);
  const pair = {price: currentPrice, minTradeNum: 0};
  const validation = validatePaperSetup(pair, {dir, entry, sl, tp1, tp2, size, contracts, riskDollar});
  if (!validation.ok) throw new Error(validation.reasons.join('; '));
  const id = 'MAN-' + String(++paperState.nextId).padStart(6, '0');
  const trade = {
    id, sym, dir, entryLimit: entry, entryActual: null, currentPrice,
    sl, tp1, tp2, size, contracts, originalSize: size, remainingSize: size,
    originalContracts: contracts, remainingContracts: contracts, status: 'PENDING',
    riskPct: cfg.riskPct, riskDollar, riskDollarAtEntry: riskDollar,
    tp1ClosePct: cfg.tp1ClosePct, tp1Hit: false, realizedPnlTp1: 0,
    realizedPnl: 0, realizedPnlFinal: 0, createdAt: Date.now(), openedAt: null,
    cycleKey: 'manual-' + paperCycleKey(Date.now()), score: null, tier: 'MANUAL',
    fund: null, oi: null, volume: 0, timeframe: '15M', tf: '15M',
    mode: 'MANUAL', signalMode: 'MANUAL', strategyVersion: 'MANUAL',
    cohortId: 'manual-' + new Date().toISOString().slice(0, 10),
    signalCreatedAt: new Date().toISOString(), dataAt: new Date().toISOString(),
    source: 'Nexora Operations manual paper', dataQuality: 'MANUAL',
    reason: String(body.reason || 'Manual paper limit'), signalReasons: [],
    setupValidation: validation, executionModel: 'LIMIT_STRICT', executionClass: 'STRICT',
    events: []
  };
  paperAddTradeEvent(trade, 'ORDER_PLACED', {price: entry, reason: trade.reason, size});
  paperState.activeTrades.push(trade);
  savePaperState();
  return paperTradeView(trade);
}

function paperHistoryFilters(query) {
  const params = query || new URLSearchParams();
  const get = name => typeof params.get === 'function' ? params.get(name) : params[name];
  return {
    symbol: String(get('symbol') || get('sym') || '').trim().toUpperCase(),
    direction: String(get('direction') || get('dir') || '').trim().toUpperCase(),
    timeframe: String(get('timeframe') || get('tf') || '').trim().toUpperCase(),
    outcome: String(get('outcome') || '').trim().toUpperCase(),
    strategyVersion: String(get('strategyVersion') || get('strategy') || '').trim(),
    cohortId: String(get('cohortId') || get('cohort') || '').trim(),
    from: String(get('from') || '').trim(),
    to: String(get('to') || '').trim()
  };
}

function paperHistoryMatches(trade, filters) {
  if (filters.symbol && String(trade.sym || '').toUpperCase() !== filters.symbol) return false;
  if (filters.direction && String(trade.dir || '').toUpperCase() !== filters.direction) return false;
  if (filters.timeframe && String(trade.timeframe || trade.tf || '').toUpperCase() !== filters.timeframe) return false;
  if (filters.outcome && String(trade.outcome || '').toUpperCase() !== filters.outcome) return false;
  if (filters.strategyVersion && String(trade.strategyVersion || paperTradeStrategyVersion(trade)) !== filters.strategyVersion) return false;
  if (filters.cohortId && String(trade.cohortId || '') !== filters.cohortId) return false;
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
  const startingEquity = paperNumber(paperState.startingEquity || PAPER_STARTING_EQUITY);
  let realizedEquity = startingEquity;
  let equityPeak = startingEquity;
  let maxDrawdownPnl = 0;
  let maxDrawdownPct = 0;
  const dailyPnl = new Map();
  chronological.forEach(trade => {
    cumulative += paperNumber(trade.r);
    peak = Math.max(peak, cumulative);
    maxDrawdownR = Math.max(maxDrawdownR, peak - cumulative);
    realizedEquity += paperNumber(trade.pnl);
    equityPeak = Math.max(equityPeak, realizedEquity);
    const drawdown = Math.max(0, equityPeak - realizedEquity);
    maxDrawdownPnl = Math.max(maxDrawdownPnl, drawdown);
    if (equityPeak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, drawdown / equityPeak * 100);
    const closedAt = Date.parse(trade.closedAt || '');
    if (closedAt) {
      const day = new Date(closedAt).toISOString().slice(0, 10);
      dailyPnl.set(day, (dailyPnl.get(day) || 0) + paperNumber(trade.pnl));
    }
  });
  const dailyDates = [...dailyPnl.keys()].sort();
  let dailySharpe = null;
  let dailySharpeDays = 0;
  if (dailyDates.length) {
    const firstDay = Date.parse(dailyDates[0] + 'T00:00:00Z');
    const lastDay = Date.parse(dailyDates[dailyDates.length - 1] + 'T00:00:00Z');
    const dayCount = Math.floor((lastDay - firstDay) / 86400000) + 1;
    if (dayCount >= 1 && dayCount <= 3650) {
      const returns = [];
      let priorPnl = 0;
      for (let offset = 0; offset < dayCount; offset++) {
        const day = new Date(firstDay + offset * 86400000).toISOString().slice(0, 10);
        const dayPnl = dailyPnl.get(day) || 0;
        const baseEquity = startingEquity + priorPnl;
        if (baseEquity > 0) returns.push(dayPnl / baseEquity);
        priorPnl += dayPnl;
      }
      dailySharpeDays = returns.length;
      if (returns.length >= 30) {
        const meanReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
        const variance = returns.reduce((sum, value) => sum + Math.pow(value - meanReturn, 2), 0) / (returns.length - 1);
        if (variance > 0) dailySharpe = meanReturn / Math.sqrt(variance) * Math.sqrt(365);
      }
    }
  }
  const filled = closed.filter(trade => trade.openedAt);
  const rValues = closed.map(trade => paperNumber(trade.r));
  const fillTimes = filled.map(trade => Math.max(0,
    (Date.parse(trade.openedAt) || 0) - (Number(trade.createdAt) || Date.parse(trade.createdAt) || 0)))
    .filter(value => value > 0);
  const durations = closed.map(trade => {
    const start = Date.parse(trade.openedAt || '');
    const end = Date.parse(trade.closedAt || '');
    return start && end ? Math.max(0, end - start) : 0;
  }).filter(value => value > 0);
  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const median = values => {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const profitFactor = grossLossR < 0 ? grossProfitR / Math.abs(grossLossR) : null;
  return {
    ok: true,
    asOf: new Date().toISOString(),
    filters: {...filters, symbol: filters.symbol || 'all', direction: filters.direction || 'all', timeframe: filters.timeframe || 'all', outcome: filters.outcome || 'all'},
    sample: {
      orders: all.length, closed: closed.length, filled: filled.length,
      pendingExpired: expired.length, cancelled: cancelled.length,
      wins: wins.length, losses: losses.length,
      breakeven: closed.filter(trade => paperNumber(trade.r) === 0).length,
      strategyVersion: filters.strategyVersion || 'all',
      cohortId: filters.cohortId || 'all', direction: filters.direction || 'all'
    },
    metrics: {
      winRate: closed.length ? Number((wins.length / closed.length * 100).toFixed(1)) : 0,
      netR: Number(netR.toFixed(2)),
      averageR: closed.length ? Number((netR / closed.length).toFixed(3)) : 0,
      medianR: Number(median(rValues).toFixed(3)),
      expectancyR: closed.length ? Number((netR / closed.length).toFixed(3)) : 0,
      profitFactor: profitFactor == null ? null : Number(profitFactor.toFixed(2)),
      maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
      maxDrawdownPnl: Number(maxDrawdownPnl.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      realizedDailySharpe: dailySharpe == null ? null : Number(dailySharpe.toFixed(2)),
      realizedDailySharpeDays: dailySharpeDays,
      grossProfitR: Number(grossProfitR.toFixed(2)),
      grossLossR: Number(grossLossR.toFixed(2)),
      pnl: Number(closed.reduce((sum, trade) => sum + paperNumber(trade.pnl), 0).toFixed(2)),
      fillRate: all.length ? Number((filled.length / all.length * 100).toFixed(1)) : 0,
      averageTimeToFillMs: Math.round(average(fillTimes)),
      medianTimeToFillMs: Math.round(median(fillTimes)),
      averageDurationMs: Math.round(average(durations)),
      averageMfePnl: Number(average(closed.map(trade => paperNumber(trade.mfePnl))).toFixed(2)),
      averageMaePnl: Number(average(closed.map(trade => paperNumber(trade.maePnl))).toFixed(2)),
      tp1Hits: closed.filter(trade => trade.tp1Hit).length,
      tp2Hits: closed.filter(trade => String(trade.closeReason || '').toLowerCase().includes('tp2')).length,
      stopLosses: closed.filter(trade => String(trade.closeReason || '').toLowerCase().includes('sl')).length,
      tp1HitRate: closed.length ? Number((closed.filter(trade => trade.tp1Hit).length / closed.length * 100).toFixed(1)) : 0,
      tp2HitRate: closed.length ? Number((closed.filter(trade => String(trade.closeReason || '').toLowerCase().includes('tp2')).length / closed.length * 100).toFixed(1)) : 0,
      slHitRate: closed.length ? Number((closed.filter(trade => String(trade.closeReason || '').toLowerCase().includes('sl')).length / closed.length * 100).toFixed(1)) : 0,
      pendingExpiredRate: all.length ? Number((expired.length / all.length * 100).toFixed(1)) : 0
    },
    bySymbol: paperGroupStats(closed, trade => trade.sym),
    byDirection: paperGroupStats(closed, trade => trade.dir),
    byTimeframe: paperGroupStats(closed, trade => trade.timeframe || trade.tf),
    byMode: paperGroupStats(closed, trade => trade.signalMode || trade.mode),
    byStrategyVersion: paperGroupStats(closed, trade => trade.strategyVersion || paperTradeStrategyVersion(trade)),
    byCohort: paperGroupStats(closed, trade => trade.cohortId),
    byCandlePattern: paperGroupStats(closed, trade => trade.candlePattern),
    byConfluence: paperGroupStats(closed, trade => {
      const value = paperNumber(trade.confluencePct);
      return value >= 80 ? '80-100' : value >= 60 ? '60-79' : value ? '<60' : 'UNKNOWN';
    }),
    byFunding: paperGroupStats(closed, trade => {
      const value = paperNumber(trade.fund);
      return value <= -0.0005 ? '<=-0.05%' : value <= 0.0005 ? '-0.05%..0.05%' : '>0.05%';
    }),
    byVolumeRatio: paperGroupStats(closed, trade => {
      const value = paperNumber(trade.volumeRatio);
      return value >= 2 ? '>=2x' : value >= 1.5 ? '1.5-1.99x' : value >= 1 ? '1-1.49x' : value > 0 ? '<1x' : 'UNKNOWN';
    }),
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
      outcome: filters.outcome || 'all', strategyVersion: filters.strategyVersion || 'all',
      cohortId: filters.cohortId || 'all', direction: filters.direction || 'all', from: filters.from, to: filters.to},
    total: closedTrades.length
  };
}

function paperCsvCell(value) {
  return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
}

function paperExportCsv(query) {
  const filters = paperHistoryFilters(query);
  const rows = paperState.closedTrades.slice(0, PAPER_MAX_CLOSED_TRADES)
    .filter(trade => paperHistoryMatches(trade, filters));
  const headers = ['closedAt', 'id', 'symbol', 'direction', 'status', 'outcome',
    'strategyVersion', 'cohortId', 'timeframe', 'mode', 'entryLimit', 'entryActual',
    'exitPrice', 'sl', 'tp1', 'tp2', 'score', 'confluencePct', 'r', 'pnl',
    'closeReason', 'createdAt', 'openedAt', 'dataQuality', 'source'];
  const lines = [headers.map(paperCsvCell).join(',')];
  rows.forEach(trade => {
    lines.push([
      trade.closedAt, trade.id, trade.sym, trade.dir, trade.status, trade.outcome,
      trade.strategyVersion || paperTradeStrategyVersion(trade), trade.cohortId,
      trade.timeframe || trade.tf, trade.signalMode || trade.mode,
      trade.entryLimit, trade.entryActual, trade.exitPrice, trade.sl, trade.tp1,
      trade.tp2, trade.score, trade.confluencePct, trade.r, trade.pnl,
      trade.closeReason, trade.createdAt, trade.openedAt, trade.dataQuality, trade.source
    ].map(paperCsvCell).join(','));
  });
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

function startPaperBot() {
  if (process.env.PAPER_BOT_ENABLED === 'false') return;
  paperStarted = true;
  paperRuntime.startedAt = new Date().toISOString();
  console.log('[paper] VPS Paper Bot ON: scan every 15M, top 3, pending expiry 120m');
  void sendConfiguredAlert('NEXORA PAPER BOT ON\nScan 15M · top 3 · limit strict\nLegacy trades tidak memakai budget bot baru');
  if (PAPER_DAILY_SUMMARY_SCHEDULER) {
    console.log('[paper] Daily alert scheduler opt-in:', TELEGRAM_ALERTS_ENABLED || Boolean(DISCORD_WEBHOOK_URL) ? 'configured' : 'no alert channel configured');
    setTimeout(maybeSendPaperOperationalAlerts, 15000);
    setInterval(maybeSendPaperOperationalAlerts, 60 * 1000);
  }
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
      paperBotEnabled: paperState.enabled,
      paperStrategyVersion: PAPER_STRATEGY_VERSION,
      strategyVersion: PAPER_STRATEGY_VERSION,
      schemaVersion: PAPER_SCHEMA_VERSION,
      time: new Date().toISOString(),
      fallbacks: {enabled: PAPER_FALLBACK_ENABLED, order: ['Bitget', 'Binance Futures', 'OKX Swap']},
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
  if (requestUrl.pathname === '/paper/settings') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    send(res, 200, JSON.stringify({ok: true, settings: paperSettings(), updatedAt: paperState.settingsUpdatedAt || null}));
    return;
  }
  if (requestUrl.pathname === '/paper/admin/status') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    send(res, 200, JSON.stringify({
      ok: true,
      configured: Boolean(PAPER_ADMIN_TOKEN),
      controlsEnabled: Boolean(PAPER_ADMIN_TOKEN),
      auth: 'Authorization: Bearer <PAPER_ADMIN_TOKEN>',
      actions: ['pause', 'kill-switch', 'settings', 'watchlist-priority', 'manual-entry', 'close', 'cancel', 'close-all'],
      alerts: {
        telegram: TELEGRAM_ALERTS_ENABLED,
        discord: Boolean(DISCORD_WEBHOOK_URL),
        watchlistNearEntry: PAPER_WATCHLIST_ALERTS_ENABLED &&
          (TELEGRAM_ALERTS_ENABLED || Boolean(DISCORD_WEBHOOK_URL))
      }
    }));
    return;
  }
  if (requestUrl.pathname === '/paper/admin/pause' ||
      requestUrl.pathname === '/paper/admin/kill-switch' ||
      requestUrl.pathname === '/paper/admin/settings' ||
      requestUrl.pathname === '/paper/admin/watchlist' ||
      requestUrl.pathname === '/paper/admin/manual' ||
      requestUrl.pathname === '/paper/admin/close-all' ||
      /^\/paper\/admin\/trades\/[^/]+\/(close|cancel)$/.test(requestUrl.pathname)) {
    if (req.method !== 'POST') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    if (!requirePaperAdmin(req, requestUrl, res)) return;
    if (paperBusy) {
      paperControlError(res, 409, 'Paper engine sedang memproses scan/monitor; coba lagi sebentar');
      return;
    }
    try {
      const body = await readJsonBody(req);
      if (requestUrl.pathname === '/paper/admin/pause') {
        paperState.paused = body.paused == null ? true : (body.paused === true || body.paused === 'true');
        paperState.settingsUpdatedAt = new Date().toISOString();
        savePaperState();
        send(res, 200, JSON.stringify({ok: true, action: 'pause', paused: paperState.paused, status: paperStatus()}));
        return;
      }
      if (requestUrl.pathname === '/paper/admin/kill-switch') {
        paperState.killSwitch = body.enabled == null ? true : (body.enabled === true || body.enabled === 'true');
        paperState.settingsUpdatedAt = new Date().toISOString();
        savePaperState();
        const label = paperState.killSwitch ? 'ON' : 'OFF';
        void sendConfiguredAlert('NEXORA PAPER KILL-SWITCH ' + label);
        send(res, 200, JSON.stringify({ok: true, action: 'kill-switch', killSwitch: paperState.killSwitch, status: paperStatus()}));
        return;
      }
      if (requestUrl.pathname === '/paper/admin/settings') {
        const settings = updatePaperSettings(body.settings || body.config || body);
        send(res, 200, JSON.stringify({ok: true, action: 'settings', settings, status: paperStatus()}));
        return;
      }
      if (requestUrl.pathname === '/paper/admin/watchlist') {
        const rawItems = Array.isArray(body.items) ? body.items
          : (Array.isArray(body.symbols) ? body.symbols.map(sym => ({sym})) : [{sym: body.sym || body.symbol}]);
        const alertItems = rawItems.map(item => paperNormaliseWatchlistAlert(
          typeof item === 'object' ? item : {sym: item})).filter(Boolean);
        const symbols = [...new Set(alertItems.map(item => item.sym))];
        if (!symbols.length || symbols.length > 5) {
          paperControlError(res, 400, 'Kirim 1–5 symbol watchlist yang valid');
          return;
        }
        const queued = new Set((paperState.watchlistQueue || []).map(item => item.sym));
        symbols.forEach(sym => queued.add(sym));
        if (queued.size > 5) {
          paperControlError(res, 400, 'Antrean Watchlist maksimal 5 symbol; jalankan scan berikutnya dulu');
          return;
        }
        const oldQueue = paperState.watchlistQueue || [];
        paperState.watchlistQueue = [...queued].map(sym => {
          const existing = oldQueue.find(item => item.sym === sym);
          return existing || {sym, requestedAt: new Date().toISOString()};
        });
        const oldAlerts = paperState.watchlistAlerts || [];
        alertItems.forEach(item => {
          const existing = oldAlerts.find(row => row.sym === item.sym);
          paperState.watchlistAlerts = (paperState.watchlistAlerts || []).filter(row => row.sym !== item.sym);
          paperState.watchlistAlerts.push({...item, lastAlertAt: existing && existing.lastAlertAt || item.lastAlertAt || null});
        });
        paperState.watchlistAlerts = paperState.watchlistAlerts.slice(-5);
        paperState.settingsUpdatedAt = new Date().toISOString();
        savePaperState();
        send(res, 200, JSON.stringify({ok: true, action: 'watchlist-queued', queued: paperState.watchlistQueue,
          watchlistAlerts: paperState.watchlistAlerts, status: paperStatus()}));
        return;
      }
      if (requestUrl.pathname === '/paper/admin/manual') {
        const trade = manualPaperTrade(body);
        send(res, 201, JSON.stringify({ok: true, action: 'manual-entry', trade, status: paperStatus()}));
        return;
      }
      if (requestUrl.pathname === '/paper/admin/close-all') {
        if (String(body.confirm || '') !== 'CLOSE_ALL') {
          paperControlError(res, 400, 'Double confirmation required: confirm=CLOSE_ALL');
          return;
        }
        const scope = String(body.scope || 'strict').toLowerCase() === 'all' ? 'all' : 'strict';
        const targets = paperState.activeTrades.filter(trade => paperIsActive(trade) &&
          (scope === 'all' || paperIsTrialTrade(trade)));
        for (const trade of targets) {
          await closePaperTradeFromDashboard(trade, 'Close All from dashboard (' + scope + ')');
        }
        paperState.activeTrades = paperState.activeTrades.filter(paperIsActive);
        savePaperState();
        void sendConfiguredAlert('NEXORA PAPER CLOSE ALL\nScope: ' + scope + '\nTrades: ' + targets.length);
        send(res, 200, JSON.stringify({ok: true, action: 'close-all', scope, closed: targets.length, status: paperStatus()}));
        return;
      }
      const tradeMatch = requestUrl.pathname.match(/^\/paper\/admin\/trades\/([^/]+)\/(close|cancel)$/);
      if (tradeMatch) {
        const id = decodeURIComponent(tradeMatch[1]);
        const action = tradeMatch[2];
        const trade = paperFindTrade(id);
        if (!trade || !paperIsActive(trade)) {
          paperControlError(res, 404, 'Trade aktif tidak ditemukan');
          return;
        }
        if (action === 'cancel' && trade.status !== 'PENDING') {
          paperControlError(res, 400, 'Hanya order PENDING yang bisa dibatalkan');
          return;
        }
        if (action === 'cancel') cancelPaperTrade(trade, 'Pending cancelled from dashboard');
        else await closePaperTradeFromDashboard(trade, 'Closed from dashboard');
        paperState.activeTrades = paperState.activeTrades.filter(paperIsActive);
        savePaperState();
        send(res, 200, JSON.stringify({ok: true, action, trade: paperTradeView(trade), status: paperStatus()}));
        return;
      }
    } catch (error) {
      console.error('[paper] admin action failed:', error.message);
      paperControlError(res, 400, error.message);
    }
    return;
  }
  if (requestUrl.pathname === '/paper/diagnostics') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    send(res, 200, JSON.stringify(paperDiagnostics()));
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
      lastError: telegramState.lastError,
      discord: {
        enabled: Boolean(DISCORD_WEBHOOK_URL),
        sent: discordState.sent,
        lastAttemptAt: discordState.lastAttemptAt,
        lastSuccessAt: discordState.lastSuccessAt,
        lastError: discordState.lastError
      },
      adminControls: Boolean(PAPER_ADMIN_TOKEN)
    }));
    return;
  }
  if (requestUrl.pathname === '/paper/replay') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    if (paperReplayBusy) {
      send(res, 409, JSON.stringify({ok: false, error: 'A replay is already running'}));
      return;
    }
    paperReplayBusy = true;
    try {
      send(res, 200, JSON.stringify(await paperReplay(requestUrl.searchParams)));
    } catch (error) {
      console.error('[paper] replay failed:', error.message);
      send(res, 502, JSON.stringify({ok: false, error: error.message}));
    } finally {
      paperReplayBusy = false;
    }
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
  if (requestUrl.pathname === '/paper/oi-history') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    const symbol = String(requestUrl.searchParams.get('symbol') || '').toUpperCase();
    const hours = Number(requestUrl.searchParams.get('hours') || 24);
    if (!/^[A-Z0-9]{2,15}$/.test(symbol) || !PAPER_SYMBOLS.includes(symbol)) {
      send(res, 400, JSON.stringify({ok: false, error: 'Unsupported futures symbol'}));
      return;
    }
    if (hours !== 24 && hours !== 168) {
      send(res, 400, JSON.stringify({ok: false, error: 'hours must be 24 or 168'}));
      return;
    }
    const from = Date.now() - hours * 60 * 60 * 1000;
    const samples = (paperState.oiHistory[symbol] || []).filter(row => Number(row.ts) >= from);
    const first = samples[0] && Number(samples[0].oiUSD);
    const last = samples[samples.length - 1] && Number(samples[samples.length - 1].oiUSD);
    send(res, 200, JSON.stringify({
      ok: true,
      symbol,
      hours,
      interval: '15M scan observations (only when upstream supplies OI)',
      source: 'VPS persisted futures ticker observations',
      samples,
      deltaPct: samples.length >= 2 && first > 0 ? Number(((last - first) / first * 100).toFixed(4)) : null,
      from: samples.length ? samples[0].ts : null,
      to: samples.length ? samples[samples.length - 1].ts : null
    }));
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

  // The current CoinDesk Data API requires an API key. Keep the News tab
  // functional without inventing credentials by adapting CoinDesk's public
  // RSS feed into the same small payload shape used by CryptoCompare.
  if (requestUrl.pathname === '/cryptocompare/news/v1/article/list') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    await serveNewsFeed(requestUrl, res);
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
