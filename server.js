const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_UNIVERSE_LIMIT,
  DEFAULT_MIN_QUOTE_VOLUME_USDT,
  DEFAULT_MAX_TICKER_AGE_MS,
  UNIVERSE_VERSION,
  normalizeBaseSymbol,
  confirmedCryptoSymbolSet,
  isEligibleBaseSymbol,
  tickerPrice,
  partitionSharedEntryGate,
  selectLiquidUniverse
} = require('./scan-universe.cjs');
const {
  makeSignal: makePrebreakoutSignal,
  buildPaperSetup: buildPrebreakoutSetup,
  DEFAULTS: PREBREAKOUT_DEFAULTS
} = require('./prebreakout-scanner.cjs');

const PORT = Number(process.env.PORT || 18085);
const REQUEST_TIMEOUT_MS = 12000;
const PAPER_INTERVAL_MS = 15 * 60 * 1000;
const PAPER_SCAN_CHECK_MS = 15000;
const PAPER_SCAN_FAILURE_RETRY_MS = 60 * 1000;
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
const PAPER_MTF_CONCURRENCY = Math.max(1, Math.min(4,
  Number.isFinite(Number(process.env.PAPER_MTF_CONCURRENCY))
    ? Number(process.env.PAPER_MTF_CONCURRENCY) : 2));
// Keep the scanner universe and MTF cap in lockstep. The former env clamp
// stopped at 40, so an old PAPER_MTF_MAX_CANDIDATES=40 could silently undo
// the expanded scan. This trial build intentionally evaluates up to 60.
const PAPER_UNIVERSE_LIMIT = DEFAULT_UNIVERSE_LIMIT;
const PAPER_MTF_MAX_CANDIDATES = PAPER_UNIVERSE_LIMIT;
const PAPER_MIN_24H_QUOTE_VOLUME_USDT = Math.max(0,
  Math.min(1e12, Number.isFinite(Number(process.env.PAPER_MIN_24H_QUOTE_VOLUME_USDT))
    ? Number(process.env.PAPER_MIN_24H_QUOTE_VOLUME_USDT) : DEFAULT_MIN_QUOTE_VOLUME_USDT));
const PAPER_TICKER_MAX_AGE_MS = Math.max(30_000,
  Math.min(15 * 60 * 1000, Number.isFinite(Number(process.env.PAPER_TICKER_MAX_AGE_MS))
    ? Number(process.env.PAPER_TICKER_MAX_AGE_MS) : DEFAULT_MAX_TICKER_AGE_MS));
const PAPER_UPSTREAM_MAX_RETRY_WAIT_MS = 8000;
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
// Expose a verifiable build marker in health/status responses so the browser
// cannot be mistaken for an older cached HTML or VPS process.
const PAPER_BUILD_ID = String(process.env.PAPER_BUILD_ID || 'v5.3.5-crypto-only-top60-2026-09-21');
// Schema 10 adds an explicit equity reconciliation and immutable trade-analysis
// snapshot. Older records remain readable; stored context is labelled PARTIAL
// when it is usable, while missing indicators are never invented.
const PAPER_SCHEMA_VERSION = 12;
// P4 AI is intentionally not enabled by a loose environment flag.  The
// current build exposes the evidence gate and rule-based summaries only;
// an AI provider must be integrated and verified before this becomes true.
const PAPER_P4_AI_IMPLEMENTED = false;
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
// Research Collection is a separate paper cohort. It is used only while the
// strict trial is paused by its 2.5% drawdown guard, so the clean trial
// statistics remain comparable while the one-week data collection continues.
const PAPER_RESEARCH_STRATEGY_VERSION = 'RESEARCH_COLLECTION';
const PAPER_RESEARCH_COHORT_ID = String(process.env.PAPER_RESEARCH_COHORT_ID ||
  ('research-' + new Date().toISOString().slice(0, 10)));
const PAPER_RESEARCH_ENABLED = String(process.env.PAPER_RESEARCH_ENABLED || 'true').toLowerCase() !== 'false';
const PAPER_RESEARCH_PER_SCAN = Math.max(1, Math.min(3,
  Number.isFinite(Number(process.env.PAPER_RESEARCH_PER_SCAN))
    ? Number(process.env.PAPER_RESEARCH_PER_SCAN) : 3));
const PAPER_RESEARCH_RISK_PCT = Math.max(0.1, Math.min(1,
  Number.isFinite(Number(process.env.PAPER_RESEARCH_RISK_PCT))
    ? Number(process.env.PAPER_RESEARCH_RISK_PCT) : 0.25));
const PAPER_RESEARCH_MAX_ACTIVE = Math.max(3, Math.min(100,
  Number.isFinite(Number(process.env.PAPER_RESEARCH_MAX_ACTIVE))
    ? Number(process.env.PAPER_RESEARCH_MAX_ACTIVE) : PAPER_MAX_ACTIVE));
const PAPER_RESEARCH_WARNING_DD_PCT = 10;
const PAPER_RESEARCH_HARD_DD_PCT = 50;
const PAPER_STRATEGY_KEYS = ['MTF_ATR_V2', 'PRE_UPGRADE', 'LEGACY'];
// Strategy Lab is an independent shadow-paper experiment.  It consumes the
// same live Bitget/Binance/OKX market observations as the main bot, but it has
// separate virtual ledgers and never calls an exchange order endpoint.
const PAPER_LAB_MODE = 'SHADOW';
const PAPER_LAB_STARTING_EQUITY = 200;
const PAPER_LAB_PER_SCAN = 1;
const PAPER_LAB_MAX_ACTIVE = 20;
const PAPER_LAB_PENDING_TTL_MS = 120 * 60 * 1000;
const PAPER_LAB_MAX_CLOSED_TRADES = 2000;
const PAPER_LAB_STRATEGIES = {
  MTF_ATR_V2: {
    label: 'MTF + ATR', version: 'MTF_ATR_V2', enabled: true, riskPct: 0.5,
    minRR: 2, maxActive: PAPER_LAB_MAX_ACTIVE, pendingTtlMs: PAPER_LAB_PENDING_TTL_MS,
    trailing: {enabled: true, afterTp1: true, atrMult: 1.5}
  },
  SR_REJECTION_V1: {
    label: 'Support / Resistance', version: 'SR_REJECTION_V1', enabled: true, riskPct: 0.5,
    minRR: 2, maxActive: PAPER_LAB_MAX_ACTIVE, pendingTtlMs: PAPER_LAB_PENDING_TTL_MS,
    trailing: {enabled: false, afterTp1: false, atrMult: 0}
  },
  BREAKOUT_RETEST_V1: {
    label: 'Breakout + Retest', version: 'BREAKOUT_RETEST_V1', enabled: true, riskPct: 0.5,
    minRR: 2, maxActive: PAPER_LAB_MAX_ACTIVE, pendingTtlMs: 60 * 60 * 1000,
    trailing: {enabled: true, afterTp1: true, atrMult: 1}
  },
  SMC_LIQUIDITY_V1: {
    label: 'SMC + Liquidity', version: 'SMC_LIQUIDITY_V1', enabled: true, riskPct: 0.5,
    minRR: 2, maxActive: PAPER_LAB_MAX_ACTIVE, pendingTtlMs: PAPER_LAB_PENDING_TTL_MS,
    trailing: {enabled: true, afterTp1: true, atrMult: 1.5}
  },
  RANGE_MEAN_REVERSION_V1: {
    label: 'Range Mean Reversion', version: 'RANGE_MEAN_REVERSION_V1', enabled: true, riskPct: 0.5,
    minRR: 2, maxActive: PAPER_LAB_MAX_ACTIVE, pendingTtlMs: PAPER_LAB_PENDING_TTL_MS,
    trailing: {enabled: false, afterTp1: false, atrMult: 0}
  },
  PREBREAKOUT_RESEARCH_V1: {
    label: 'Pre-Breakout Research', version: 'PREBREAKOUT_RESEARCH_V1', enabled: true, riskPct: 0.5,
    minRR: 2, maxActive: PAPER_LAB_MAX_ACTIVE, pendingTtlMs: 60 * 60 * 1000,
    trailing: {enabled: true, afterTp1: true, atrMult: 1},
    execution: 'BREAKOUT_CONFIRMED_PAPER_LIMIT'
  }
};
const PAPER_DEFAULT_STRATEGY_SETTINGS = {
  MTF_ATR_V2: {enabled: true, maxActive: PAPER_MAX_ACTIVE, riskPct: PAPER_RISK_PCT, minRR: PAPER_MIN_RR, slPct: 0, tp1R: 2, tp2R: 3},
  PRE_UPGRADE: {enabled: false, maxActive: 10, riskPct: PAPER_RISK_PCT, minRR: PAPER_MIN_RR, slPct: 3, tp1R: 2, tp2R: 3},
  LEGACY: {enabled: false, maxActive: 0, riskPct: PAPER_RISK_PCT, minRR: PAPER_MIN_RR, slPct: 3, tp1R: 2, tp2R: 3}
};
// Keep enough server history for a normal one-week paper trial. The status
// endpoint remains lightweight; /paper/history serves the full retained set.
const PAPER_MAX_CLOSED_TRADES = 5000;
const PAPER_MAX_RECENT_SCANS = 1000;
const PAPER_MAX_MONITORING_SIGNALS = 200;
const PAPER_STARTING_EQUITY = Number(process.env.PAPER_STARTING_EQUITY || 285);
const PAPER_TIMEFRAME_MAX_AGE_MS = {
  H4: 12 * 60 * 60 * 1000,
  H1: 3 * 60 * 60 * 1000,
  M30: 90 * 60 * 1000,
  M15: 45 * 60 * 1000
};
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const TELEGRAM_ALERTS_ENABLED = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
const TELEGRAM_SCAN_SUMMARY = String(process.env.TELEGRAM_SCAN_SUMMARY || '').toLowerCase() === 'true';
const TELEGRAM_COMMANDS_ENABLED = TELEGRAM_ALERTS_ENABLED &&
  String(process.env.TELEGRAM_COMMANDS_ENABLED || 'true').toLowerCase() !== 'false';
const TELEGRAM_POLL_INTERVAL_MS = 8000;
const TELEGRAM_COMMAND_MAX_CHARS = 3500;
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
    lastPath: null, lastError: null, requestCount: 0, paths: {},
    lastSuccessfulPath: null, fallbackActive: false, primaryError: null
  };
});

const telegramState = {
  sent: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  commandsReceived: 0,
  commandsReplied: 0,
  lastCommandAt: null,
  lastCommand: null,
  lastPollAt: null,
  lastPollSuccessAt: null,
  lastPollErrorAt: null,
  lastPollError: null
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
  rejectionCounts: {},
  rateLimitResponses: 0,
  lastRateLimitAt: null,
  lastRetryAfterMs: null,
  lastScanDurationMs: null,
  lastScanOverruns: 0,
  nextScanRetryAt: null,
  lastUniverseScan: null
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
    item.lastSuccessfulPath = result.path || item.lastPath;
    item.fallbackActive = false;
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
    const isFreshLive = item.status === 'LIVE' && ageSec != null && ageSec <= 60;
    const hasFallback = Boolean(item.fallbackActive && item.lastOkAt);
    const displayStatus = ageSec != null && ageSec > 300
      ? 'STALE'
      : ageSec != null && ageSec > 60 ? 'DELAYED'
      : isFreshLive ? 'LIVE'
        : hasFallback ? 'FALLBACK_LIVE' : item.status;
    return [name, {
      ...item,
      ageSec,
      displayStatus: (item.status === 'RATE_LIMITED' && item.lastOkAt && ageSec != null && ageSec <= 60)
        ? 'DELAYED' : displayStatus
    }];
  }));
}

// These providers are not part of the order decision, but their health must be
// observable.  A quiet UNKNOWN badge is misleading when the dashboard claims
// that backup dominance, macro, or exchange feeds are available.  Probe only
// lightweight public endpoints every five minutes and never let a probe block
// the paper loop.
const SOURCE_HEALTH_PROBE_MS = 5 * 60 * 1000;
let sourceHealthProbeBusy = false;
async function probeExternalSources() {
  if (sourceHealthProbeBusy) return;
  sourceHealthProbeBusy = true;
  const probes = [
    ['/coingecko', '/api/v3/global'],
    ['/coinpaprika', '/v1/global'],
    ['/okx', '/api/v5/public/time'],
    // Keep the health probe on the same feed the dashboard consumes.  The
    // old /calendar.json path can return a different response (or 404), which
    // made the source look unhealthy even while the actual calendar endpoint
    // was working.
    ['/macro', '/ff_calendar_thisweek.json']
  ];
  try {
    for (const [prefix, pathname] of probes) {
      const startedAt = Date.now();
      try {
        const result = await requestUpstream(APIS[prefix] + pathname);
        markSourceHealth(prefix, {...result, latencyMs: Date.now() - startedAt, path: pathname});
      } catch (error) {
        markSourceError(prefix, error, pathname);
      }
    }
    // CryptoCompare's public news endpoint is commonly 401 without an API
    // key, so health must probe both the primary and the RSS fallback.  This
    // keeps the badge current even when nobody has the News tab open.
    await probeCryptoCompareHealth();
  } finally {
    sourceHealthProbeBusy = false;
  }
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
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const ANTHROPIC_API_KEY = String(process.env.ANTHROPIC_API_KEY || '').trim();
const NEWS_IMPACT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NEWS_ARTICLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const newsArticleCache = new Map();
const newsImpactCache = new Map();

async function probeCryptoCompareHealth() {
  const primaryPath = '/data/v2/news/';
  const fallbackPath = '/arc/outboundfeeds/rss/';
  let primaryError = null;
  try {
    const startedAt = Date.now();
    const primary = await requestUpstream(CRYPTOCOMPARE_NEWS_URL + '&limit=1');
    primary.latencyMs = Date.now() - startedAt;
    primary.path = primaryPath;
    markSourceHealth('/cryptocompare', primary);
    if (primary.status >= 200 && primary.status < 300) {
      return;
    }
    primaryError = 'CryptoCompare primary HTTP ' + primary.status;
  } catch (error) {
    primaryError = error.message || 'CryptoCompare primary unavailable';
    markSourceError('/cryptocompare', error, primaryPath);
  }
  try {
    const startedAt = Date.now();
    const fallback = await requestUpstream(NEWS_RSS_URL);
    fallback.latencyMs = Date.now() - startedAt;
    fallback.path = fallbackPath;
    markSourceHealth('/cryptocompare', fallback);
    const health = sourceHealth.cryptocompare;
    if (fallback.status >= 200 && fallback.status < 300 && health) {
      health.fallbackActive = true;
      health.primaryError = primaryError;
      health.lastError = primaryError;
      health.lastSuccessfulPath = fallbackPath;
    }
  } catch (error) {
    markSourceError('/cryptocompare', error, fallbackPath);
  }
}

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

function newsArticleId(row) {
  return String(row && (row.ID || row.id || row.URL || row.url || row.GUID || row.guid || row.TITLE || row.title || '') || '').trim();
}

function rememberNewsArticles(rows) {
  if (!Array.isArray(rows)) return;
  const expiresAt = Date.now() + NEWS_ARTICLE_CACHE_TTL_MS;
  rows.forEach(row => {
    const id = newsArticleId(row);
    if (id) newsArticleCache.set(id, {row, expiresAt});
  });
  for (const [id, item] of newsArticleCache) {
    if (!item || item.expiresAt <= Date.now()) newsArticleCache.delete(id);
  }
}

function newsArticleText(row) {
  return String(row && (row.TITLE || row.title || row.headline || '') || '').trim();
}

function newsArticleSentiment(row) {
  const explicit = String(row && (row.sentiment || row.SENTIMENT || '') || '').toUpperCase();
  if (explicit.includes('NEG') || explicit.includes('BEAR')) return 'NEGATIVE';
  if (explicit.includes('POS') || explicit.includes('BULL')) return 'POSITIVE';
  const title = newsArticleText(row).toLowerCase();
  if (/hack|exploit|lawsuit|ban|fraud|scam|liquidat|crash|reject|sue|fail|sanction|down|outflow|sell-off/.test(title)) return 'NEGATIVE';
  if (/surge|rally|approval|approved|adoption|inflow|partnership|launch|upgrade|buy|bullish|breakout|record high|etf/.test(title)) return 'POSITIVE';
  return 'NEUTRAL';
}

function newsAffectedCoins(row) {
  const text = (newsArticleText(row) + ' ' + String(row && (row.CATEGORY_DATA || row.categories || row.CATEGORIES || row.TAGS || row.CURRENCIES || row.currencies || '') || '')).toUpperCase();
  const known = ['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','LINK','AVAX','DOT','ARB','OP','INJ','SUI','PEPE','FET','WIF','LTC','SHIB','TRX','MATIC','ATOM','UNI'];
  return known.filter(sym => new RegExp('\\b' + sym + '\\b').test(text) ||
    (sym === 'BTC' && /BITCOIN/.test(text)) || (sym === 'ETH' && /ETHEREUM/.test(text))).slice(0, 8);
}

function fallbackNewsImpact(row) {
  const title = newsArticleText(row);
  const lower = title.toLowerCase();
  const negativeKeywords = ['reject','fail','hack','ban','crash','sanction','sue','fraud','down','exploit','scam','bankrupt','lawsuit','liquidation','liquidated','outflow','sell-off'];
  const positiveKeywords = ['approve','etf','partnership','adoption','launch','upgrade','buy','bullish','approval','approved','institution','surge','rally','inflow','breakout','record high'];
  const matchKeywords = keywords => keywords.filter(keyword => lower.includes(keyword));
  const negativeMatches = matchKeywords(negativeKeywords);
  const positiveMatches = matchKeywords(positiveKeywords);
  const negativeScore = negativeMatches.length;
  const positiveScore = positiveMatches.length;
  const direction = negativeScore > positiveScore ? 'TURUN' : positiveScore > negativeScore ? 'NAIK' : 'NETRAL';
  const totalMatches = negativeScore + positiveScore;
  const majorMagnitude = /senate|sec|fed|billion|government|blackrock|etf/.test(lower);
  const magnitude = majorMagnitude ? 'BESAR' : totalMatches >= 2 ? 'SEDANG' : 'KECIL';
  const confidence = Math.max(40, Math.min(85, 40 + totalMatches * 8));
  const timeframe = majorMagnitude || totalMatches >= 2 ? 'pendek (1-4j)' : 'menengah (4-24j)';
  const affected = newsAffectedCoins(row);
  const coinText = affected.length ? affected.join(', ') : 'pasar crypto terkait';
  const reasoning = direction === 'TURUN'
    ? 'Judul mengandung ' + negativeMatches.join(', ') + '; tekanan jual berpotensi meningkat pada ' + coinText + '. Ini adalah estimasi rule-based, bukan sinyal trading.'
    : direction === 'NAIK'
      ? 'Judul mengandung ' + positiveMatches.join(', ') + '; minat beli berpotensi meningkat pada ' + coinText + '. Ini adalah estimasi rule-based, bukan sinyal trading.'
      : 'Tidak ada katalis arah yang cukup jelas dari judul; dampak harga kemungkinan netral atau terbatas.';
  return {direction, magnitude, confidence, timeframe, reasoning, affected_coins: affected.length ? affected : ['BTC'], risk_note: null};
}

function parseImpactJson(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    try { return match ? JSON.parse(match[0]) : null; } catch (_) { return null; }
  }
}

function normaliseImpactAnalysis(value, fallback) {
  const base = fallback || fallbackNewsImpact({TITLE: ''});
  const raw = value && typeof value === 'object' ? value : {};
  const directions = {UP: 'NAIK', DOWN: 'TURUN', BULLISH: 'NAIK', BEARISH: 'TURUN', NEUTRAL: 'NETRAL'};
  const magnitudes = {HIGH: 'BESAR', MEDIUM: 'SEDANG', LOW: 'KECIL'};
  const directionKey = String(raw.direction || '').trim().toUpperCase();
  const magnitudeKey = String(raw.magnitude || '').trim().toUpperCase();
  const direction = ['NAIK','TURUN','NETRAL'].includes(directionKey) ? directionKey : (directions[directionKey] || base.direction);
  const magnitude = ['BESAR','SEDANG','KECIL'].includes(magnitudeKey) ? magnitudeKey : (magnitudes[magnitudeKey] || base.magnitude);
  const timeframeText = String(raw.timeframe || '').trim().toLowerCase();
  const timeframe = /pendek|short|1.?4/.test(timeframeText) ? 'pendek (1-4j)' : /panjang|long|1.?7/.test(timeframeText)
    ? 'panjang (1-7h)' : /menengah|medium|4.?24/.test(timeframeText) ? 'menengah (4-24j)' : base.timeframe;
  const confidenceValue = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(100, Math.round(confidenceValue))) : base.confidence;
  const coins = Array.isArray(raw.affected_coins) ? raw.affected_coins : base.affected_coins;
  const affected_coins = [...new Set(coins.map(item => String(item || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(item => /^[A-Z0-9]{2,12}$/.test(item)))].slice(0, 8);
  return {
    direction, magnitude, confidence, timeframe,
    reasoning: String(raw.reasoning || base.reasoning).trim().slice(0, 500),
    affected_coins: affected_coins.length ? affected_coins : ['BTC'],
    risk_note: raw.risk_note == null ? null : String(raw.risk_note).trim().slice(0, 300) || null
  };
}

function impactPrompt(row) {
  const title = newsArticleText(row);
  const sentiment = newsArticleSentiment(row);
  const currencies = newsAffectedCoins(row).join(', ') || 'unknown';
  return 'Analisis dampak berita crypto ini secara singkat dan konservatif.\n' +
    'Judul: ' + title + '\nSentimen heuristik: ' + sentiment + '\nCoin terkait: ' + currencies + '\n\n' +
    'Balas JSON valid saja dengan shape: {"direction":"NAIK|TURUN|NETRAL","magnitude":"BESAR|SEDANG|KECIL","confidence":0,"timeframe":"pendek (1-4j)|menengah (4-24j)|panjang (1-7h)","reasoning":"1-2 kalimat bahasa Indonesia","affected_coins":["BTC"],"risk_note":null}. Jangan memberi rekomendasi finansial.';
}

async function requestNewsImpactAi(row) {
  const prompt = impactPrompt(row);
  if (OPENAI_API_KEY) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchFn('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: {'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json'},
        body: JSON.stringify({model: 'gpt-4o-mini', temperature: 0.1, response_format: {type: 'json_object'}, messages: [
          {role: 'system', content: 'Kamu analis berita crypto. Ikuti format JSON pengguna secara ketat.'},
          {role: 'user', content: prompt}
        ]}), signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) throw new Error('OpenAI HTTP ' + response.status);
      const payload = JSON.parse(body);
      const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
      const parsed = parseImpactJson(content);
      if (!parsed) throw new Error('OpenAI returned invalid JSON');
      return {analysis: parsed, provider: 'OpenAI gpt-4o-mini'};
    } finally { clearTimeout(timer); }
  }
  if (ANTHROPIC_API_KEY) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: {'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'},
        body: JSON.stringify({model: 'claude-3-5-haiku-latest', max_tokens: 400, temperature: 0.1,
          system: 'Kamu analis berita crypto. Balas JSON valid saja.', messages: [{role: 'user', content: prompt}]}), signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) throw new Error('Anthropic HTTP ' + response.status);
      const payload = JSON.parse(body);
      const content = payload && Array.isArray(payload.content) && payload.content[0] && payload.content[0].text;
      const parsed = parseImpactJson(content);
      if (!parsed) throw new Error('Anthropic returned invalid JSON');
      return {analysis: parsed, provider: 'Anthropic Claude Haiku'};
    } finally { clearTimeout(timer); }
  }
  return null;
}

async function analyzeNewsImpact(row) {
  const id = newsArticleId(row);
  const cached = newsImpactCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return {...cached.value, cached: true};
  const fallback = fallbackNewsImpact(row);
  let value = {analysis: fallback, provider: 'Rule-based fallback'};
  try {
    const ai = await requestNewsImpactAi(row);
    if (ai) value = {analysis: normaliseImpactAnalysis(ai.analysis, fallback), provider: ai.provider};
  } catch (error) {
    value = {analysis: fallback, provider: 'Rule-based fallback', fallbackReason: error.message || 'AI unavailable'};
  }
  value.analysis = normaliseImpactAnalysis(value.analysis, fallback);
  const result = {news_id: id, analysis: value.analysis, provider: value.provider, generatedAt: new Date().toISOString()};
  newsImpactCache.set(id, {value: result, expiresAt: Date.now() + NEWS_IMPACT_CACHE_TTL_MS});
  return result;
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
    if (parsed) {
      rememberNewsArticles(parsed.Data);
      body = JSON.stringify(parsed);
    }
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
      const fallbackRows = parseNewsRss(fallback.body).slice(0, limit);
      rememberNewsArticles(fallbackRows);
      body = JSON.stringify({Type: 100, Message: 'News list successfully returned', Provider: 'CoinDesk RSS fallback', Data: fallbackRows});
      // CryptoCompare's public news endpoint commonly returns 401 without an
      // API key.  The RSS feed is the working provider; expose that fact
      // instead of showing a generic delayed/error badge while the News tab is
      // actually healthy.
      const health = sourceHealth.cryptocompare;
      if (health) {
        health.fallbackActive = true;
        health.primaryError = primary && primary.status >= 400
          ? 'CryptoCompare primary HTTP ' + primary.status : (primaryError && primaryError.message) || null;
        health.lastError = health.primaryError;
        health.lastSuccessfulPath = '/arc/outboundfeeds/rss/';
      }
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
      let retryDelay = null;
      if (response.status === 429) {
        paperRuntime.rateLimitResponses += 1;
        paperRuntime.lastRateLimitAt = new Date().toISOString();
        const retryAfter = response.headers.get('retry-after');
        const seconds = Number(retryAfter);
        const retryAt = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
        const requestedWait = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
          : Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : null;
        if (requestedWait != null) {
          paperRuntime.lastRetryAfterMs = Math.round(requestedWait);
          // If the upstream asks us to wait longer than the scan can safely
          // tolerate, return the 429 to the caller instead of retrying early.
          if (requestedWait <= PAPER_UPSTREAM_MAX_RETRY_WAIT_MS) {
            retryDelay = Math.max(250, requestedWait);
          }
        } else {
          retryDelay = Math.min(2000, 500 * Math.pow(2, attempt));
        }
      } else if (response.status >= 500) {
        retryDelay = Math.min(2000, 350 * Math.pow(2, attempt));
      }
      if (!retryable || attempt === 2 || retryDelay == null) {
        return {
          status: response.status,
          body,
          contentType: response.headers.get('content-type') || 'application/json'
        };
      }
      await sleep(retryDelay);
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

function telegramTrim(text) {
  const value = String(text || '');
  return value.length <= TELEGRAM_COMMAND_MAX_CHARS
    ? value : value.slice(0, TELEGRAM_COMMAND_MAX_CHARS - 24) + '\n…pesan dipotong';
}

function telegramFormatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta', hour12: false,
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  }) + ' WIB';
}

function telegramFormatNumber(value, digits) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  if (Math.abs(number) >= 1000) return number.toFixed(2);
  if (Math.abs(number) >= 1) return number.toFixed(digits == null ? 4 : digits)
    .replace(/0+$/, '').replace(/\.$/, '');
  return number.toPrecision(8).replace(/0+$/, '').replace(/\.$/, '');
}

function telegramCommandHelp() {
  return 'NEXORA PAPER BOT\n' +
    '/status — status bot, mode, guard, dan scan terakhir\n' +
    '/positions — posisi PENDING/OPEN/TP1\n' +
    '/summary — ringkasan hasil hari ini\n' +
    '/stats — statistik Strict dan Research\n' +
    '/scan — hasil scan dan penolakan terakhir\n' +
    '/health — kesehatan VPS dan scheduler\n' +
    '/help — bantuan perintah';
}

function telegramCommandStatus() {
  const status = paperStatus({details: false, stats: false});
  const scan = status.lastScanSummary || {};
  const research = status.research || {};
  const daily = status.dailySummary || {};
  const summary = status.summary || {};
  return telegramTrim(
    'NEXORA PAPER STATUS\n' +
    'Bot: ' + (status.running ? 'ON' : 'OFFLINE') +
      ' | Scan: ' + status.interval + '\n' +
    'Mode: ' + status.mode + '\n' +
    'Entry strict: ' + status.entryState + '\n' +
    'Guard: ' + (status.guardMessage || '-') + '\n' +
    'DD strict: ' + Number(status.drawdownPct || 0).toFixed(2) + '% / ' +
      Number(status.maxDrawdownPct || 0).toFixed(2) + '%\n' +
    'Research: ' + (research.entryState || '-') +
      ' | DD ' + Number(research.drawdownPct || 0).toFixed(2) + '% / ' +
      Number(research.hardDrawdownPct || 0).toFixed(2) + '%\n' +
    'Equity strict: $' + Number(status.equity || 0).toFixed(2) +
      ' | Research: $' + Number(research.equity || 0).toFixed(2) + '\n' +
    'Aktif: ' + Number(summary.open || 0) + ' open, ' +
      Number(summary.partial || 0) + ' partial, ' + Number(summary.pending || 0) + ' pending\n' +
    'Scan terakhir: ' + Number(scan.placed || 0) + ' dibuat, ' +
      Number(scan.rejected || 0) + ' ditolak\n' +
    'Next scan: ' + telegramFormatTime(status.nextScanAt) + '\n' +
    'Hari ini: ' + Number(daily.trades || 0) + ' trade | ' +
      Number(daily.wins || 0) + '/' + Number(daily.losses || 0) + ' W/L | ' +
      Number(daily.netR || 0).toFixed(2) + 'R'
  );
}

function telegramCommandSummary() {
  const status = paperStatus({details: false, stats: true});
  const daily = status.dailySummary || {};
  const research = status.research || {};
  return telegramTrim(
    'NEXORA DAILY SUMMARY ' + (daily.date || new Date().toISOString().slice(0, 10)) + '\n' +
    'Trades: ' + Number(daily.trades || 0) +
      ' | Win/Loss: ' + Number(daily.wins || 0) + '/' + Number(daily.losses || 0) +
      ' | Net: ' + Number(daily.netR || 0).toFixed(2) + 'R\n' +
    'PnL hari ini: $' + Number(daily.pnl || 0).toFixed(2) +
      ' | Daily guard: ' + (daily.guard ? 'ON' : 'OK') + '\n' +
    'Equity Strict: $' + Number(status.equity || 0).toFixed(2) +
      ' | Research: $' + Number(research.equity || 0).toFixed(2) + '\n' +
    'Strict DD: ' + Number(status.drawdownPct || 0).toFixed(2) + '% / ' +
      Number(status.maxDrawdownPct || 0).toFixed(2) + '%\n' +
    'Research DD: ' + Number(research.drawdownPct || 0).toFixed(2) + '% / ' +
      Number(research.hardDrawdownPct || 0).toFixed(2) + '%'
  );
}

function telegramStatsRow(label, stats, sample) {
  const metrics = stats || {};
  const count = sample || {};
  return label + ': ' + Number(count.closed || 0) + ' closed | ' +
    Number(count.wins || 0) + '/' + Number(count.losses || 0) + ' W/L | WR ' +
    Number(metrics.winRate || 0).toFixed(1) + '% | Net ' +
    Number(metrics.netR || 0).toFixed(2) + 'R | PF ' +
    (metrics.profitFactor == null ? '-' : Number(metrics.profitFactor).toFixed(2)) +
    ' | DD ' + Number(metrics.maxDrawdownPct || 0).toFixed(2) + '%';
}

function telegramCommandStats() {
  const status = paperStatus({details: false, stats: true});
  return telegramTrim(
    'NEXORA PAPER STATS\n' +
    'Strict Trial (' + (status.cohortId || '-') + ')\n' +
    telegramStatsRow('Hasil', status.trialStats, status.trialStatsSample) + '\n' +
    'Research Collection (' + ((status.research && status.research.cohortId) || '-') + ')\n' +
    telegramStatsRow('Hasil', status.researchStats, status.researchStatsSample) + '\n' +
    'Total historis: ' + Number(status.statsSample && status.statsSample.closed || 0) +
      ' closed | Net ' + Number(status.stats && status.stats.netR || 0).toFixed(2) + 'R'
  );
}

function telegramCommandScan() {
  const status = paperStatus({details: true, stats: false});
  const scan = Array.isArray(status.recentScans) ? status.recentScans[0] : null;
  if (!scan) return 'NEXORA LAST SCAN\nBelum ada hasil scan.';
  const placed = Array.isArray(scan.placed) ? scan.placed : [];
  const rejected = Array.isArray(scan.rejected) ? scan.rejected : [];
  const lines = [
    'NEXORA LAST SCAN',
    'Waktu: ' + telegramFormatTime(scan.at),
    'Cycle: ' + (scan.cycleKey || '-'),
    'Mode: ' + ((scan.capacity && scan.capacity.mode) || scan.mode || '-'),
    'Kandidat: ' + Number(scan.candidates || 0) +
      ' | Dibuat: ' + placed.length + ' | Ditolak: ' + rejected.length
  ];
  if (placed.length) {
    lines.push('', 'ORDER DIBUAT:');
    placed.slice(0, 3).forEach(trade => lines.push(
      trade.sym + ' ' + trade.dir + ' PENDING @ ' + telegramFormatNumber(trade.entryLimit) +
        ' | SL ' + telegramFormatNumber(trade.sl) +
        ' | TP1 ' + telegramFormatNumber(trade.tp1)
    ));
  }
  if (rejected.length) {
    lines.push('', 'PENOLAKAN PER TIMEFRAME:');
    rejected.slice(0, 8).forEach(item => {
      const timeframe = Array.isArray(item.timeframeReasons)
        ? item.timeframeReasons.map(row => row.timeframe + ':' + row.reason).join(' · ')
        : 'detail timeframe tidak tersedia';
      lines.push((item.sym || '-') + ' — ' +
        (Array.isArray(item.codes) && item.codes.length ? item.codes.join('/') : 'REJECTED') +
        '\n' + timeframe);
    });
    if (rejected.length > 8) lines.push('…dan ' + (rejected.length - 8) + ' penolakan lain');
  }
  return telegramTrim(lines.join('\n'));
}

function telegramCommandHealth() {
  const status = paperStatus({details: false, stats: false});
  const runtime = status.runtime || {};
  const commands = telegramState;
  const scanAge = status.lastScanAt ? Math.max(0, Math.round((Date.now() - Date.parse(status.lastScanAt)) / 60000)) : null;
  return telegramTrim(
    'NEXORA VPS HEALTH\n' +
    'Bot: ' + (status.running ? 'ONLINE' : 'OFFLINE') +
      ' | Mode: ' + status.mode + '\n' +
    'Scheduler: setiap ' + status.interval +
      ' | Next: ' + telegramFormatTime(status.nextScanAt) + '\n' +
    'Last scan: ' + telegramFormatTime(status.lastScanAt) +
      (scanAge == null ? '' : ' (' + scanAge + ' menit lalu)') + '\n' +
    'Last monitor: ' + telegramFormatTime(status.lastMonitorAt) + '\n' +
    'Scan sukses/gagal: ' + Number(runtime.scansSucceeded || 0) + '/' +
      Number(runtime.scansFailed || 0) +
      ' | Monitor: ' + Number(runtime.monitorsSucceeded || 0) + '/' +
      Number(runtime.monitorsFailed || 0) + '\n' +
    'Telegram command listener: ' + (TELEGRAM_COMMANDS_ENABLED ? 'ON' : 'OFF') +
      ' | Poll: ' + telegramFormatTime(commands.lastPollSuccessAt) + '\n' +
    'Error terakhir: ' + (status.lastError || commands.lastPollError || 'tidak ada')
  );
}

function telegramCommandPositions() {
  const status = paperStatus({details: true, stats: false});
  const trades = Array.isArray(status.activeTrades) ? status.activeTrades : [];
  if (!trades.length) return 'NEXORA ACTIVE POSITIONS\nTidak ada posisi aktif atau pending.';
  const lines = ['NEXORA ACTIVE POSITIONS (' + trades.length + ')'];
  trades.slice(0, 30).forEach((trade, index) => {
    const bucket = trade.researchCollection ? 'RESEARCH' : 'STRICT';
    lines.push(
      '', (index + 1) + '. ' + trade.id + ' · ' + bucket,
      trade.sym + ' ' + trade.dir + ' · ' + trade.status,
      'Entry: ' + telegramFormatNumber(trade.entryActual || trade.entryLimit) +
        ' | Now: ' + telegramFormatNumber(trade.currentPrice),
      'SL: ' + telegramFormatNumber(trade.sl) +
        ' | TP1: ' + telegramFormatNumber(trade.tp1) +
        ' | TP2: ' + telegramFormatNumber(trade.tp2),
      'PnL: $' + Number(trade.unrealPnl || 0).toFixed(2) +
        ' | RR: ' + (trade.rr == null ? '-' : trade.rr)
    );
  });
  if (trades.length > 30) lines.push('', '…dan ' + (trades.length - 30) + ' posisi lainnya');
  return telegramTrim(lines.join('\n'));
}

function telegramCommandFromText(text) {
  const match = String(text || '').trim().match(/^\/([a-z0-9_]+)(?:@[^\s]+)?(?:\s|$)/i);
  return match ? match[1].toLowerCase() : null;
}

async function telegramApiRequest(pathname, params) {
  if (!TELEGRAM_ALERTS_ENABLED) return [];
  const query = new URLSearchParams(params || {}).toString();
  const target = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + pathname +
    (query ? '?' + query : '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchFn(target, {
      method: 'GET', headers: {'User-Agent': 'NexoraPaperBot/1.0'}, signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) throw new Error('Telegram HTTP ' + response.status);
    let payload;
    try { payload = JSON.parse(body); } catch (_) { payload = null; }
    if (!payload || payload.ok !== true) {
      throw new Error(payload && payload.description || 'Telegram response invalid');
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

async function handleTelegramCommand(message, command) {
  const replies = {
    start: telegramCommandHelp,
    help: telegramCommandHelp,
    status: telegramCommandStatus,
    positions: telegramCommandPositions,
    summary: telegramCommandSummary,
    stats: telegramCommandStats,
    scan: telegramCommandScan,
    health: telegramCommandHealth
  };
  const createReply = replies[command];
  if (!createReply) return false;
  const sent = await sendTelegramMessage(createReply());
  if (sent) telegramState.commandsReplied += 1;
  return sent;
}

let telegramPollBusy = false;

async function pollTelegramCommands() {
  if (!TELEGRAM_COMMANDS_ENABLED || telegramPollBusy) return;
  telegramPollBusy = true;
  telegramState.lastPollAt = new Date().toISOString();
  let changed = false;
  try {
    const offset = Number.isFinite(Number(paperState.telegramUpdateOffset))
      ? Math.max(0, Math.floor(Number(paperState.telegramUpdateOffset))) : 0;
    const updates = await telegramApiRequest('/getUpdates', {
      offset: String(offset), limit: '100', timeout: '0'
    });
    telegramState.lastPollSuccessAt = new Date().toISOString();
    telegramState.lastPollError = null;
    for (const update of Array.isArray(updates) ? updates : []) {
      const updateId = Number(update && update.update_id);
      if (!Number.isFinite(updateId)) continue;
      paperState.telegramUpdateOffset = Math.max(
        Number(paperState.telegramUpdateOffset || 0), updateId + 1
      );
      changed = true;
      const message = update.message || update.edited_message;
      if (!message || !message.chat || String(message.chat.id) !== TELEGRAM_CHAT_ID) continue;
      const command = telegramCommandFromText(message.text);
      if (!command) continue;
      telegramState.commandsReceived += 1;
      telegramState.lastCommandAt = new Date().toISOString();
      telegramState.lastCommand = command;
      await handleTelegramCommand(message, command);
    }
    if (changed) savePaperState();
  } catch (error) {
    telegramState.lastPollErrorAt = new Date().toISOString();
    telegramState.lastPollError = error.message;
    console.error('[telegram] command polling failed:', error.message);
  } finally {
    telegramPollBusy = false;
  }
}

function startTelegramCommandBot() {
  if (!TELEGRAM_COMMANDS_ENABLED) return;
  console.log('[telegram] command listener ON: /start /status /positions /help');
  setTimeout(() => void pollTelegramCommands(), 2500);
  setInterval(() => void pollTelegramCommands(), TELEGRAM_POLL_INTERVAL_MS);
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
    reasons: [...new Set((Array.isArray(reasons) ? reasons : []).filter(Boolean))],
    timeframeReasons: paperTimeframeReasons(pair)
  });
}

function paperTimeframeReasons(pair) {
  const names = ['H4', 'H1', 'M30', 'M15'];
  const direction = pair && pair.mtfDirection && pair.mtfDirection !== 'NEUTRAL'
    ? pair.mtfDirection : null;
  const mtf = pair && pair.mtf && typeof pair.mtf === 'object' ? pair.mtf : {};
  return names.map(timeframe => {
    const item = mtf[timeframe] || {};
    const itemDirection = item.direction || 'UNAVAILABLE';
    const status = item.status || 'UNAVAILABLE';
    let reason = 'data tidak tersedia';
    if (status !== 'FULL') reason = 'data ' + status.toLowerCase();
    else if (itemDirection === 'NEUTRAL') reason = 'netral';
    else if (direction && itemDirection !== direction) reason = 'berlawanan dengan ' + direction;
    else if (timeframe === 'M15') reason = 'trigger searah';
    else if (timeframe === 'M30') reason = 'konfirmasi searah';
    else reason = 'searah';
    return {
      timeframe, direction: itemDirection, status,
      sampleSize: Number(item.sampleSize || 0),
      reason
    };
  });
}

function paperAlertScope(trade) {
  if (trade && (trade.researchCollection === true ||
      trade.strategyVersion === PAPER_RESEARCH_STRATEGY_VERSION ||
      trade.mode === PAPER_RESEARCH_STRATEGY_VERSION ||
      trade.signalMode === PAPER_RESEARCH_STRATEGY_VERSION)) return 'RESEARCH';
  if (trade && (trade.strategyVersion === PAPER_STRATEGY_VERSION ||
      trade.executionModel === 'LIMIT_STRICT' || trade.executionClass === 'STRICT')) return 'STRICT';
  return 'LEGACY';
}

function paperScanAlert(cycleKey, placed) {
  const scopes = [...new Set((placed || []).map(paperAlertScope))];
  const scope = scopes.length === 1 ? scopes[0] : scopes.length ? 'MIXED' : 'STRICT';
  return 'NEXORA PAPER SCAN [' + scope + '] ' + cycleKey + '\n' +
    (placed.length ? placed.map(trade =>
      '[' + paperAlertScope(trade) + '] ' + trade.sym + ' ' + trade.dir + ' PENDING @ ' + trade.entryLimit +
      ' | SL ' + trade.sl + ' | TP1 ' + trade.tp1
    ).join('\n') : 'Tidak ada setup baru');
}

function paperFillAlert(trade) {
  return 'NEXORA PAPER LIMIT FILLED [' + paperAlertScope(trade) + ']\n' +
    trade.sym + ' ' + trade.dir + ' @ ' + trade.entryActual +
    '\nSL ' + trade.sl + ' | TP1 ' + trade.tp1;
}

function paperCloseAlert(trade) {
  return 'NEXORA PAPER ' + (trade.outcome || 'CLOSED') + ' [' + paperAlertScope(trade) + ']\n' +
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
  return 'NEXORA PAPER TP1 PARTIAL [' + paperAlertScope(trade) + ']\n' +
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
function paperNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function paperAnalysisCaptured(trade) {
  if (!trade) return false;
  const mtf = trade.mtf && typeof trade.mtf === 'object' ? trade.mtf : {};
  const tfNames = ['H4', 'H1', 'M30', 'M15'];
  const hasTfSnapshot = tfNames.every(tf => mtf[tf] &&
    (mtf[tf].lastClosedCandleAt || (trade.candleAtByTf && trade.candleAtByTf[tf])));
  // Re-evaluate the raw fields instead of trusting a stale status written by
  // an older build.  This lets an upgraded process recognise older records
  // that already contain a complete entry snapshot.
  return !!(trade.analysisSnapshot && trade.analysisSnapshot.captureLevel === 'FULL') || (
    !!trade.signalCreatedAt && hasTfSnapshot &&
    trade.setupValidation && typeof trade.setupValidation === 'object' &&
    trade.indicators && typeof trade.indicators === 'object' &&
    trade.dataQuality === 'FULL'
  );
}

function paperAnalysisHasPartialContext(trade) {
  if (!trade) return false;
  const indicators = trade.indicators && typeof trade.indicators === 'object' ? trade.indicators : {};
  const mtf = trade.mtf && typeof trade.mtf === 'object' ? trade.mtf : {};
  const hasMtf = ['H4', 'H1', 'M30', 'M15'].some(tf => mtf[tf] && typeof mtf[tf] === 'object');
  const hasMarketContext = trade.fund != null || trade.oi != null || trade.volumeRatio != null ||
    trade.regime || trade.marketRegime || trade.dataQuality || trade.dataAt;
  const hasIndicatorContext = Object.keys(indicators).length > 0;
  const hasStoredSnapshot = trade.analysisSnapshot && typeof trade.analysisSnapshot === 'object';
  const hasSetupContext = trade.setupValidation && typeof trade.setupValidation === 'object' ||
    trade.signalScores && typeof trade.signalScores === 'object' || trade.entryLimit != null;
  // Direction and signal time are valid historical facts from the order
  // record. They are enough for a partial audit row, but never enough for
  // full factor inference or P4/AI eligibility.
  return !!(trade.signalCreatedAt || trade.createdAt) && !!trade.dir &&
    (hasMtf || hasMarketContext || hasIndicatorContext || hasSetupContext || hasStoredSnapshot);
}

function paperAnalysisGate(capturedCount) {
  const fullSnapshots = Math.max(0, Number(capturedCount) || 0);
  const minimumForInference = 30;
  const p4GatePassed = fullSnapshots >= minimumForInference;
  const p4AiEnabled = PAPER_P4_AI_IMPLEMENTED &&
    String(process.env.PAPER_TRADE_AI_ENABLED || '').toLowerCase() === 'true';
  return {
    fullSnapshots, minimumForInference, p4GatePassed, p4AiEnabled,
    p4Ready: p4GatePassed && p4AiEnabled,
    p4Reason: p4GatePassed
      ? (p4AiEnabled ? 'P4_AI_READY' : 'P4_AI_IMPLEMENTATION_PENDING')
      : 'WAITING_FOR_30_FULL_SNAPSHOTS'
  };
}

function paperExitClassification(trade) {
  const reason = String(trade && trade.closeReason || '').toLowerCase();
  const tp1Hit = !!(trade && trade.tp1Hit);
  if (reason.includes('tp2')) return 'FULL_TP2';
  if (reason.includes('sl') && tp1Hit) return 'PROTECTED_AFTER_TP1';
  if (reason.includes('sl')) return 'DIRECT_SL_LOSS';
  if (reason.includes('expir')) return 'PENDING_EXPIRED';
  if (trade && trade.outcome === 'WIN') return 'OTHER_WIN';
  if (trade && trade.outcome === 'LOSS') return 'OTHER_LOSS';
  return 'OTHER_CLOSE';
}

function paperTradeAnalysisTags(trade) {
  const tags = {exit: [], setup: [], market: []};
  if (!trade) return tags;
  const closeReason = String(trade.closeReason || '').toLowerCase();
  if (closeReason.includes('tp2')) tags.exit.push('HIT_TP2');
  else if (closeReason.includes('tp1')) tags.exit.push('HIT_TP1');
  else if (closeReason.includes('sl') && trade.tp1Hit) tags.exit.push('SL_AFTER_TP1');
  else if (closeReason.includes('sl')) tags.exit.push('HIT_SL');
  else if (closeReason.includes('expir')) tags.exit.push('EXPIRED');
  else if (trade.outcome === 'CANCELLED') tags.exit.push('CANCELLED');
  else if (trade.status === 'CLOSED') tags.exit.push('CLOSED_OTHER');

  const confluence = paperNumber(trade.confluencePct);
  const alignment = paperNumber(trade.mtfAlignment);
  const rr = paperNumber(trade.setupValidation && trade.setupValidation.rr || trade.rr);
  if (alignment >= 3) tags.setup.push('MTF_ALIGNED');
  if (alignment >= 4) tags.setup.push('MTF_FULL_ALIGNMENT');
  if (confluence >= 80) tags.setup.push('HIGH_CONFLUENCE');
  else if (confluence && confluence < 70) tags.setup.push('LOW_CONFLUENCE');
  if (rr >= 2) tags.setup.push('GOOD_RR');
  else if (rr > 0) tags.setup.push('LOW_RR');
  if (trade.dataQuality === 'FULL') tags.setup.push('DATA_FULL');
  else tags.setup.push('DATA_PARTIAL');

  const summary = trade.mtfSummary || {};
  if (summary.higherAligned && summary.confirmAligned && summary.triggerAligned) tags.market.push('MTF_TREND_ALIGNED');
  if (summary.higherOpposed || summary.confirmOpposed) tags.market.push('HIGHER_TF_CONFLICT');
  if (trade.fund < 0) tags.market.push('FUNDING_NEGATIVE');
  else if (trade.fund > 0) tags.market.push('FUNDING_POSITIVE');
  if (trade.oi > 0) tags.market.push('OI_RISING');
  else if (trade.oi < 0) tags.market.push('OI_FALLING');
  const volumeRatio = paperNumber(trade.volumeRatio);
  if (volumeRatio >= 1.5) tags.market.push('HIGH_VOLUME');
  else if (volumeRatio > 0 && volumeRatio < 1) tags.market.push('LOW_VOLUME');
  const indicators = trade.indicators || {};
  if (indicators.candlePattern && indicators.candlePattern !== 'NONE') tags.market.push('CANDLE_' + String(indicators.candlePattern).toUpperCase());
  const regime = paperTradeRegimeTag(trade);
  if (regime) tags.market.push(regime);
  if (trade.outcome === 'WIN') tags.setup.push('GOOD_TRADE_WIN');
  else if (trade.outcome === 'LOSS' && tags.exit.includes('HIT_SL')) tags.setup.push('GOOD_TRADE_LOSS_REVIEW');
  return tags;
}

function paperTradeRegimeTag(trade) {
  const explicit = String(trade && (trade.regime || trade.marketRegime) || '').trim().toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (['TRENDING_BULL', 'TRENDING_BEAR', 'RANGING', 'HIGH_VOLATILITY', 'LOW_VOLUME'].includes(explicit)) return explicit;
  const mtf = trade && trade.mtf && typeof trade.mtf === 'object' ? trade.mtf : {};
  const h4 = String(mtf.H4 && mtf.H4.direction || '').toUpperCase();
  const h1 = String(mtf.H1 && mtf.H1.direction || '').toUpperCase();
  if (h4 === 'LONG' && h1 === 'LONG') return 'TRENDING_BULL';
  if (h4 === 'SHORT' && h1 === 'SHORT') return 'TRENDING_BEAR';
  const volumeRatio = paperNumber(trade && trade.volumeRatio);
  if (volumeRatio > 0 && volumeRatio < 0.75) return 'LOW_VOLUME';
  const atrPct = paperNumber(trade && trade.atrPct);
  if (atrPct >= 4) return 'HIGH_VOLATILITY';
  return 'RANGING';
}

function paperBuildAnalysisSnapshot(trade) {
  if (!trade || !paperAnalysisHasPartialContext(trade)) return null;
  const mtf = trade.mtf && typeof trade.mtf === 'object' ? trade.mtf : {};
  return {
    schemaVersion: 1,
    captureLevel: paperAnalysisCaptured(trade) ? 'FULL' : 'PARTIAL',
    capturedAt: trade.signalCreatedAt || trade.createdAt || null,
    symbol: trade.sym || null, direction: trade.dir || null,
    timeframe: trade.timeframe || trade.tf || '15M',
    market: {
      change24h: trade.chg == null ? null : trade.chg,
      funding: trade.fund == null ? null : trade.fund,
      fundingAvailable: trade.fundingAvailable == null ? null : !!trade.fundingAvailable,
      oiDeltaPct: trade.oi == null ? null : trade.oi,
      oiAvailable: trade.oiAvailable == null ? null : !!trade.oiAvailable,
      volume: trade.volume == null ? null : trade.volume,
      volumeRatio: trade.volumeRatio == null ? null : trade.volumeRatio,
      volumeAvailable: trade.volumeAvailable == null ? null : !!trade.volumeAvailable,
      regime: paperTradeRegimeTag(trade), dataQuality: trade.dataQuality || null,
      dataQualityReason: trade.dataQualityReason || null, source: trade.source || null,
      dataAt: trade.dataAt || null
    },
    indicators: trade.indicators || null,
    mtf: Object.fromEntries(['H4', 'H1', 'M30', 'M15'].map(tf => [tf, mtf[tf] ? {
      direction: mtf[tf].direction || null, status: mtf[tf].status || null,
      strengthPct: mtf[tf].strengthPct == null ? null : mtf[tf].strengthPct,
      candleAt: mtf[tf].lastClosedCandleAt || mtf[tf].candleAt || null
    } : null])),
    setup: {
      entryLimit: trade.entryLimit == null ? null : trade.entryLimit,
      sl: trade.sl == null ? null : trade.sl,
      tp1: trade.tp1 == null ? null : trade.tp1,
      tp2: trade.tp2 == null ? null : trade.tp2,
      rr: trade.setupValidation && trade.setupValidation.rr != null ? trade.setupValidation.rr : null,
      confluencePct: trade.confluencePct == null ? null : trade.confluencePct,
      mtfAlignment: trade.mtfAlignment == null ? null : trade.mtfAlignment,
      signalScore: trade.signalScores && trade.signalScores.total != null ? trade.signalScores.total : null,
      atr: trade.atr == null ? null : trade.atr,
      support: trade.support == null ? null : trade.support,
      resistance: trade.resistance == null ? null : trade.resistance
    }
  };
}

function paperEnsureAnalysis(trade) {
  if (!trade) return trade;
  const captured = paperAnalysisCaptured(trade);
  const partial = !captured && paperAnalysisHasPartialContext(trade);
  trade.analysisStatus = captured ? 'CAPTURED' : partial ? 'PARTIAL' : 'DATA_NOT_CAPTURED';
  if ((captured || partial) && !trade.analysisSnapshot) {
    trade.analysisSnapshot = paperBuildAnalysisSnapshot(trade);
  }
  trade.analysisTags = paperTradeAnalysisTags(trade);
  if (trade.closedAt || trade.status === 'CLOSED') {
    trade.analysisExit = {
      closedAt: trade.closedAt || null, exitPrice: trade.exitPrice == null ? null : trade.exitPrice,
      closeReason: trade.closeReason || null, outcome: trade.outcome || null,
      tp1Hit: !!trade.tp1Hit, mfePnl: paperNumber(trade.mfePnl), maePnl: paperNumber(trade.maePnl)
    };
    if (captured && !trade.analysisSummary) {
      const exit = trade.analysisTags.exit.join(', ') || 'CLOSED_OTHER';
      const setup = trade.analysisTags.setup.filter(tag => !/^GOOD_TRADE_/.test(tag)).slice(0, 3).join(', ') || 'SETUP_REVIEW';
      const market = trade.analysisTags.market.slice(0, 3).join(', ') || 'MARKET_CONTEXT_UNKNOWN';
      const snapshot = trade.analysisSnapshot || {};
      const marketData = snapshot.market || {};
      const indicators = snapshot.indicators || {};
      const mtf = snapshot.mtf || {};
      const alignment = snapshot.setup && snapshot.setup.mtfAlignment != null
        ? snapshot.setup.mtfAlignment + '/4' : 'unknown';
      const rsi = indicators.rsi == null ? 'n/a' : Number(indicators.rsi).toFixed(1);
      const funding = marketData.funding == null ? 'n/a' : Number(marketData.funding).toFixed(6);
      const volume = marketData.volumeRatio == null ? 'n/a' : Number(marketData.volumeRatio).toFixed(2) + 'x';
      const regime = marketData.regime || paperTradeRegimeTag(trade) || 'UNKNOWN';
      const mtfDirections = ['H4', 'H1', 'M30', 'M15'].map(tf => mtf[tf] && mtf[tf].direction).filter(Boolean).join('/');
      const verdict = trade.outcome === 'WIN' ? 'GOOD_TRADE_WIN'
        : trade.outcome === 'LOSS' && trade.analysisTags.setup.includes('MTF_ALIGNED')
          ? 'GOOD_TRADE_LOSS_REVIEW' : 'SETUP_NEEDS_REVIEW';
      trade.analysisSummary = trade.sym + ' ' + (trade.dir || '') + ' ' + (trade.outcome || 'CLOSED') +
        ' · ' + verdict + ' · Exit: ' + exit + ' · Regime: ' + regime +
        ' · MTF: ' + alignment + (mtfDirections ? ' (' + mtfDirections + ')' : '') +
        ' · RSI: ' + rsi + ' · Funding: ' + funding + ' · Volume: ' + volume +
        ' · Setup: ' + setup + ' · Market: ' + market;
    } else if (partial && !trade.analysisSummary) {
      trade.analysisSummary = trade.sym + ' ' + (trade.dir || '') + ' ' + (trade.outcome || 'CLOSED') +
        ' · PARTIAL_CONTEXT · Exit: ' + (trade.closeReason || 'CLOSED_OTHER') +
        ' · Snapshot entry tidak lengkap; hanya konteks yang tersimpan yang ditampilkan.';
    }
  }
  return trade;
}

function paperNormaliseWatchlistAlert(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const sym = String(raw.sym || raw.symbol || '').toUpperCase()
    .replace(/USDT$/, '').replace(/[^A-Z0-9]/g, '');
  if (!sym || !isEligibleBaseSymbol(sym)) return null;
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
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed < 100000000000 ? parsed * 1000 : parsed;
  }
  const iso = Date.parse(String(value || ''));
  return Number.isFinite(iso) && iso > 0 ? iso : 0;
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
  paperEnsureAnalysis(next);
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

function paperLabDefaultAccount(strategyId) {
  const definition = PAPER_LAB_STRATEGIES[strategyId];
  return {
    strategyId,
    label: definition.label,
    version: definition.version,
    enabled: definition.enabled,
    startingEquity: PAPER_LAB_STARTING_EQUITY,
    equityPeak: PAPER_LAB_STARTING_EQUITY,
    riskPct: definition.riskPct,
    minRR: definition.minRR,
    maxActive: definition.maxActive,
    pendingTtlMs: definition.pendingTtlMs,
    maxPerSymbol: 1,
    tp1ClosePct: PAPER_TP1_CLOSE_PCT,
    warningDrawdownPct: 10,
    emergencyDrawdownPct: 50,
    activeTrades: [],
    closedTrades: [],
    monitoringSignals: [],
    signalCooldowns: {},
    recentRejections: [],
    lastScanAt: null,
    lastPlacedAt: null,
    lastError: null
  };
}

function paperLabDefaultState() {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: PAPER_LAB_MODE,
    startingEquity: PAPER_LAB_STARTING_EQUITY,
    nextId: 0,
    lastScanAt: null,
    lastCycleKey: null,
    lastError: null,
    recentScans: [],
    overlapEvents: [],
    accounts: Object.fromEntries(Object.keys(PAPER_LAB_STRATEGIES)
      .map(strategyId => [strategyId, paperLabDefaultAccount(strategyId)]))
  };
}

function paperLabNormaliseState(input) {
  const fresh = paperLabDefaultState();
  const raw = input && typeof input === 'object' ? input : {};
  const accounts = {};
  Object.keys(PAPER_LAB_STRATEGIES).forEach(strategyId => {
    const fallback = fresh.accounts[strategyId];
    const source = raw.accounts && raw.accounts[strategyId] && typeof raw.accounts[strategyId] === 'object'
      ? raw.accounts[strategyId] : {};
    const startingEquity = Number(source.startingEquity);
    const equityPeak = Number(source.equityPeak);
    accounts[strategyId] = {
      ...fallback,
      ...source,
      strategyId,
      label: PAPER_LAB_STRATEGIES[strategyId].label,
      version: PAPER_LAB_STRATEGIES[strategyId].version,
      enabled: source.enabled == null ? fallback.enabled : source.enabled !== false,
      startingEquity: Number.isFinite(startingEquity) && startingEquity > 0
        ? startingEquity : fallback.startingEquity,
      equityPeak: Number.isFinite(equityPeak) && equityPeak > 0
        ? Math.max(equityPeak, startingEquity || fallback.startingEquity) : fallback.equityPeak,
      riskPct: Number.isFinite(Number(source.riskPct))
        ? Math.max(0.1, Math.min(2, Number(source.riskPct))) : fallback.riskPct,
      minRR: Number.isFinite(Number(source.minRR))
        ? Math.max(1.5, Math.min(5, Number(source.minRR))) : fallback.minRR,
      maxActive: Number.isFinite(Number(source.maxActive))
        ? Math.max(1, Math.min(100, Math.round(Number(source.maxActive)))) : fallback.maxActive,
      pendingTtlMs: Number.isFinite(Number(source.pendingTtlMs))
        ? Math.max(15 * 60 * 1000, Math.min(24 * 60 * 60 * 1000, Number(source.pendingTtlMs))) : fallback.pendingTtlMs,
      maxPerSymbol: 1,
      tp1ClosePct: PAPER_TP1_CLOSE_PCT,
      warningDrawdownPct: 10,
      emergencyDrawdownPct: 50,
      activeTrades: Array.isArray(source.activeTrades) ? source.activeTrades : [],
      closedTrades: Array.isArray(source.closedTrades) ? source.closedTrades.slice(0, PAPER_LAB_MAX_CLOSED_TRADES) : [],
      monitoringSignals: Array.isArray(source.monitoringSignals) ? source.monitoringSignals.slice(0, 100) : [],
      signalCooldowns: source.signalCooldowns && typeof source.signalCooldowns === 'object' ? source.signalCooldowns : {},
      recentRejections: Array.isArray(source.recentRejections) ? source.recentRejections.slice(0, 50) : []
    };
  });
  return {
    ...fresh,
    ...raw,
    schemaVersion: 1,
    mode: PAPER_LAB_MODE,
    startingEquity: PAPER_LAB_STARTING_EQUITY,
    nextId: Number.isFinite(Number(raw.nextId)) && Number(raw.nextId) >= 0 ? Math.floor(Number(raw.nextId)) : 0,
    recentScans: Array.isArray(raw.recentScans) ? raw.recentScans.slice(0, 200) : [],
    overlapEvents: Array.isArray(raw.overlapEvents) ? raw.overlapEvents.slice(0, 100) : [],
    accounts
  };
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
    researchEnabled: PAPER_RESEARCH_ENABLED,
    researchStrategyVersion: PAPER_RESEARCH_STRATEGY_VERSION,
    researchCohortId: PAPER_RESEARCH_COHORT_ID,
    researchStartingEquity: PAPER_STARTING_EQUITY,
    researchEquityPeak: PAPER_STARTING_EQUITY,
    startedAt: new Date().toISOString(),
    lastScanAt: null,
    lastCycleKey: null,
    lastMonitorAt: null,
    lastPriceAt: null,
    lastError: null,
    lastBlockReason: null,
    lastSavedAt: null,
    nextId: 0,
    telegramUpdateOffset: 0,
    oiSnapshot: {},
    oiHistory: {},
    activeTrades: [],
    closedTrades: [],
    invalidatedTrades: [],
    recentScans: [],
    monitoringSignals: [],
    watchlistQueue: [],
    watchlistAlerts: [],
    strategyLab: paperLabDefaultState(),
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
      monitoringSignals: Array.isArray(parsed.monitoringSignals) ? parsed.monitoringSignals.slice(0, PAPER_MAX_MONITORING_SIGNALS) : [],
      watchlistQueue: Array.isArray(parsed.watchlistQueue) ? parsed.watchlistQueue.map(item => {
        const sym = String(item && typeof item === 'object' ? item.sym : item || '')
          .toUpperCase().replace(/USDT$/, '').replace(/[^A-Z0-9]/g, '');
        return sym && isEligibleBaseSymbol(sym) ? {
          sym, requestedAt: item && item.requestedAt || null
        } : null;
      }).filter(Boolean).slice(0, 5) : [],
      watchlistAlerts: Array.isArray(parsed.watchlistAlerts) ? parsed.watchlistAlerts
        .map(paperNormaliseWatchlistAlert).filter(Boolean).slice(0, 5) : [],
      strategyLab: paperLabNormaliseState(parsed.strategyLab),
      alertState: {...defaultPaperState().alertState, ...(parsed.alertState || {})},
      telegramUpdateOffset: Number.isFinite(Number(parsed.telegramUpdateOffset)) &&
        Number(parsed.telegramUpdateOffset) >= 0
        ? Math.floor(Number(parsed.telegramUpdateOffset)) : 0,
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
    const researchStartingEquity = Number(state.researchStartingEquity);
    const normalizedResearchStartingEquity = Number.isFinite(researchStartingEquity) && researchStartingEquity > 0
      ? researchStartingEquity : normalizedStartingEquity;
    const previousResearchEquityPeak = Number(state.researchEquityPeak);
    state.researchEnabled = PAPER_RESEARCH_ENABLED && state.researchEnabled !== false;
    state.researchStrategyVersion = PAPER_RESEARCH_STRATEGY_VERSION;
    state.researchCohortId = state.researchCohortId || PAPER_RESEARCH_COHORT_ID;
    state.researchStartingEquity = normalizedResearchStartingEquity;
    state.researchEquityPeak = Math.max(
      Number.isFinite(previousResearchEquityPeak) && previousResearchEquityPeak > 0 ? previousResearchEquityPeak : 0,
      normalizedResearchStartingEquity
    );
    if (!Number.isFinite(previousEquityPeak) || previousEquityPeak <= 0) state._needsSave = true;
    if (!Number.isFinite(previousResearchEquityPeak) || previousResearchEquityPeak <= 0) state._needsSave = true;
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

function paperAdxSnapshot(rows, period) {
  const length = Number(period || 14);
  if (!Array.isArray(rows) || rows.length < length * 2 + 1) return null;
  const tr = [];
  const plus = [];
  const minus = [];
  for (let index = 1; index < rows.length; index++) {
    const current = rows[index];
    const previous = rows[index - 1];
    tr.push(Math.max(current.high - current.low,
      Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
    const up = current.high - previous.high;
    const down = previous.low - current.low;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  }
  const dx = [];
  for (let index = length - 1; index < tr.length; index++) {
    const trSum = paperMean(tr.slice(index - length + 1, index + 1)) * length;
    if (!(trSum > 0)) continue;
    const plusDi = paperMean(plus.slice(index - length + 1, index + 1)) * length / trSum * 100;
    const minusDi = paperMean(minus.slice(index - length + 1, index + 1)) * length / trSum * 100;
    const denominator = plusDi + minusDi;
    dx.push({adx: denominator > 0 ? Math.abs(plusDi - minusDi) / denominator * 100 : 0,
      plusDi, minusDi});
  }
  const recent = dx.slice(-length);
  if (!recent.length) return null;
  const last = recent[recent.length - 1];
  return {
    adx: Number(paperMean(recent.map(item => item.adx)).toFixed(1)),
    plusDi: Number(last.plusDi.toFixed(1)),
    minusDi: Number(last.minusDi.toFixed(1))
  };
}

function paperBollingerSnapshot(closes, index, period, multiplier) {
  const length = Number(period || 20);
  const end = Number(index);
  if (!Array.isArray(closes) || end < length - 1) return null;
  const window = closes.slice(end - length + 1, end + 1);
  const middle = paperMean(window);
  const variance = paperMean(window.map(value => Math.pow(value - middle, 2)));
  const deviation = Math.sqrt(Math.max(0, variance)) * Number(multiplier || 2);
  return {middle, upper: middle + deviation, lower: middle - deviation};
}

function paperLabStructureSnapshot(rows, atr) {
  if (!Array.isArray(rows) || rows.length < 25) return {
    rangeHigh20: null, rangeLow20: null, bos: 'NEUTRAL', sweep: 'NONE',
    fvg: {direction: 'NONE', low: null, high: null, gap: 0, valid: false},
    orderBlock: {direction: 'NONE', low: null, high: null, valid: false}
  };
  const lastIndex = rows.length - 1;
  const previous20 = rows.slice(Math.max(0, lastIndex - 20), lastIndex);
  const last = rows[lastIndex];
  const rangeHigh20 = Math.max(...previous20.map(row => row.high));
  const rangeLow20 = Math.min(...previous20.map(row => row.low));
  const body = Math.abs(last.close - last.open);
  const range = Math.max(last.high - last.low, 1e-12);
  const impulse = body / range >= 0.6 && range >= Math.max(paperNumber(atr), 1e-12);
  const bos = last.close > rangeHigh20 ? 'LONG' : last.close < rangeLow20 ? 'SHORT' : 'NEUTRAL';
  const sweep = last.low < rangeLow20 && last.close > rangeLow20 ? 'LONG'
    : last.high > rangeHigh20 && last.close < rangeHigh20 ? 'SHORT' : 'NONE';
  const threeBack = rows[lastIndex - 2];
  const fvgGap = threeBack && last.low > threeBack.high ? last.low - threeBack.high
    : threeBack && last.high < threeBack.low ? threeBack.low - last.high : 0;
  const fvgDirection = threeBack && last.low > threeBack.high ? 'LONG'
    : threeBack && last.high < threeBack.low ? 'SHORT' : 'NONE';
  const fvgValid = !!fvgDirection && fvgGap >= Math.max(paperNumber(atr) * 0.1, 1e-12) && impulse;
  let orderBlock = {direction: 'NONE', low: null, high: null, valid: false};
  if (impulse) {
    for (let index = lastIndex - 1; index >= Math.max(0, lastIndex - 3); index--) {
      const candidate = rows[index];
      const opposite = last.close > last.open ? candidate.close < candidate.open
        : candidate.close > candidate.open;
      if (opposite) {
        orderBlock = {
          direction: last.close > last.open ? 'LONG' : 'SHORT',
          low: candidate.low, high: candidate.high, valid: true
        };
        break;
      }
    }
  }
  return {
    rangeHigh20, rangeLow20, bos, sweep,
    fvg: {
      direction: fvgDirection, low: fvgDirection === 'LONG' ? threeBack.high : last.high,
      high: fvgDirection === 'LONG' ? last.low : threeBack ? threeBack.low : null,
      gap: fvgGap, valid: fvgValid
    },
    orderBlock
  };
}

// A pre-breakout order is allowed only after a closed-candle breakout has
// been followed by a closed-candle retest that holds the broken level. This
// keeps the research strategy from buying the first wick outside the range.
function paperBreakoutRetestSnapshot(rows, atrSeries) {
  if (!Array.isArray(rows) || rows.length < 30) {
    return {valid: false, direction: null, retestConfirmed: false, reason: 'INSUFFICIENT_CANDLES'};
  }
  const lastIndex = rows.length - 1;
  let candidate = null;
  const firstBreakoutIndex = Math.max(20, lastIndex - 6);
  for (let index = firstBreakoutIndex; index < lastIndex; index++) {
    const row = rows[index];
    const previous = rows.slice(index - 20, index);
    if (previous.length < 20) continue;
    const high = Math.max(...previous.map(item => item.high));
    const low = Math.min(...previous.map(item => item.low));
    const atr = Math.max(paperNumber(atrSeries && atrSeries[index]), row.close * 0.0025);
    const bodyPct = Math.abs(row.close - row.open) / Math.max(row.high - row.low, 1e-12);
    const avgVolume = paperMean(previous.map(item => item.volume));
    const volumeRatio = avgVolume > 0 ? row.volume / avgVolume : null;
    const longBreak = row.close >= high + atr * 0.2 && bodyPct >= 0.5 && volumeRatio != null && volumeRatio >= 1.5;
    const shortBreak = row.close <= low - atr * 0.2 && bodyPct >= 0.5 && volumeRatio != null && volumeRatio >= 1.5;
    if (longBreak || shortBreak) {
      candidate = {
        direction: longBreak ? 'LONG' : 'SHORT',
        level: longBreak ? high : low,
        breakoutAt: Number.isFinite(row.ts) ? new Date(row.ts).toISOString() : null,
        breakoutIndex: index,
        breakoutAtr: atr,
        distanceAtr: Math.abs(row.close - (longBreak ? high : low)) / atr,
        volumeRatio
      };
    }
  }
  if (!candidate) return {valid: false, direction: null, retestConfirmed: false, reason: 'NO_VALID_BREAKOUT'};
  let retestAt = null;
  let invalidated = false;
  for (let index = candidate.breakoutIndex + 1; index <= lastIndex; index++) {
    const row = rows[index];
    const buffer = candidate.breakoutAtr * 0.1;
    const tolerance = candidate.breakoutAtr * 0.25;
    if (candidate.direction === 'LONG') {
      if (row.close < candidate.level - buffer) invalidated = true;
      if (!invalidated && row.low <= candidate.level + tolerance && row.close >= candidate.level) {
        retestAt = Number.isFinite(row.ts) ? new Date(row.ts).toISOString() : null;
      }
    } else {
      if (row.close > candidate.level + buffer) invalidated = true;
      if (!invalidated && row.high >= candidate.level - tolerance && row.close <= candidate.level) {
        retestAt = Number.isFinite(row.ts) ? new Date(row.ts).toISOString() : null;
      }
    }
  }
  const latest = rows[lastIndex];
  const stillHolding = candidate.direction === 'LONG'
    ? latest.close >= candidate.level
    : latest.close <= candidate.level;
  return {
    valid: !!retestAt && !invalidated && stillHolding,
    direction: candidate.direction,
    level: candidate.level,
    breakoutAt: candidate.breakoutAt,
    retestAt,
    retestConfirmed: !!retestAt && !invalidated && stillHolding,
    distanceAtr: candidate.distanceAtr,
    volumeRatio: candidate.volumeRatio,
    invalidated
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
  const previousCandle = rows[Math.max(0, lastIndex - 1)];
  const previous = rows.slice(Math.max(0, lastIndex - 20), lastIndex);
  const support = previous.length ? Math.min(...previous.map(row => row.low)) : last.low;
  const resistance = previous.length ? Math.max(...previous.map(row => row.high)) : last.high;
  const swings = paperSwingLevels(rows);
  const averageVolume = paperMean(previous.map(row => row.volume));
  const volumeRatio = averageVolume > 0 ? last.volume / averageVolume : null;
  const adx = paperAdxSnapshot(rows, 14);
  const bollinger = paperBollingerSnapshot(closes, lastIndex, 20, 2);
  const previousBollinger = paperBollingerSnapshot(closes, Math.max(0, lastIndex - 1), 20, 2);
  const structure = paperLabStructureSnapshot(rows, atrSeries[lastIndex] || 0);
  const breakoutRetest = paperBreakoutRetestSnapshot(rows, atrSeries);
  const body = Math.abs(last.close - last.open);
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
      adx: adx ? adx.adx : null,
      plusDi: adx ? adx.plusDi : null,
      minusDi: adx ? adx.minusDi : null,
      bbMiddle: bollinger ? paperRoundPrice(bollinger.middle) : null,
      bbUpper: bollinger ? paperRoundPrice(bollinger.upper) : null,
      bbLower: bollinger ? paperRoundPrice(bollinger.lower) : null,
      previousBbUpper: previousBollinger ? paperRoundPrice(previousBollinger.upper) : null,
      previousBbLower: previousBollinger ? paperRoundPrice(previousBollinger.lower) : null,
      previousClose: previousCandle ? previousCandle.close : null,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      bodyPct: Number((body / Math.max(last.high - last.low, 1e-12) * 100).toFixed(1)),
      rangeHigh20: structure.rangeHigh20 ? paperRoundPrice(structure.rangeHigh20) : null,
      rangeLow20: structure.rangeLow20 ? paperRoundPrice(structure.rangeLow20) : null,
      bos: structure.bos,
      liquiditySweep: structure.sweep,
      fvg: structure.fvg,
      orderBlock: structure.orderBlock,
      breakoutRetest,
      supertrend,
      candlePattern: candlePattern.name,
      candleDirection: candlePattern.direction
    },
    candlePattern
  };
}

function paperTickerSymbol(row) {
  return normalizeBaseSymbol(row && (row.symbol || row.instId || row.sym));
}

function buildPaperPairs(payload) {
  const rows = Array.isArray(payload && payload.data) ? payload.data : [];
  const dataAt = payload && payload._nexoraFetchedAt || new Date().toISOString();
  const pairs = {};
  rows.forEach(row => {
    const sym = paperTickerSymbol(row);
    if (!sym || !isEligibleBaseSymbol(sym)) return;
    const price = tickerPrice(row);
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
      volume: paperNumber(row._nexoraQuoteVolume || row.quoteVolume || row.usdtVolume || row.quoteVolume24h),
      fund, oi, oiUSD: oiAvailable && oiUsd > 0 ? oiUsd : null, oiReady,
      fundingAvailable: paperFieldPresent(row.fundingRate) || paperFieldPresent(row.fundingRate24h),
      oiAvailable,
      volumeAvailable: paperFieldPresent(row.quoteVolume) || paperFieldPresent(row.usdtVolume) ||
        paperFieldPresent(row.quoteVolume24h) || paperFieldPresent(row._nexoraQuoteVolume),
      universeVersion: row._nexoraUniverseVersion || UNIVERSE_VERSION,
      tickerAt: row._nexoraTickerAt || null,
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
  const sizingRiskPct = Number.isFinite(Number(setupOptions.riskPct))
    ? Math.max(0.1, Math.min(2, Number(setupOptions.riskPct))) : cfg.riskPct;
  const riskDollar = Math.max(0, sizingEquity * sizingRiskPct / 100);
  const contracts = stopDistance > 0 ? riskDollar / stopDistance : 0;
  return {
    dir,
    entry, sl, tp1, tp2,
    structureSupport: support || null,
    structureResistance: resistance || null,
    atr: Number(atr.toFixed(8)),
    contracts: Number(contracts.toFixed(6)),
    size: Number((contracts * entry).toFixed(2)),
    riskPct: Number(sizingRiskPct.toFixed(2)),
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

function paperLabIsActive(trade) {
  return trade && (trade.status === 'PENDING' || trade.status === 'OPEN' || trade.status === 'TP1_PARTIAL');
}

function paperLabAccountEquity(account) {
  if (!account) return PAPER_LAB_STARTING_EQUITY;
  const realized = (account.closedTrades || []).reduce((sum, trade) => sum + paperNumber(trade.pnl), 0);
  const unrealized = (account.activeTrades || [])
    .filter(trade => trade.status === 'OPEN' || trade.status === 'TP1_PARTIAL')
    .reduce((sum, trade) => sum + paperNumber(trade.realizedPnl) + paperNumber(trade.unrealPnl), 0);
  return paperNumber(account.startingEquity || PAPER_LAB_STARTING_EQUITY) + realized + unrealized;
}

function paperLabUpdatePeak(account) {
  if (!account) return false;
  const equity = paperLabAccountEquity(account);
  const starting = paperNumber(account.startingEquity || PAPER_LAB_STARTING_EQUITY);
  const peak = Math.max(paperNumber(account.equityPeak), starting);
  if (equity > peak) {
    account.equityPeak = Number(equity.toFixed(2));
    return true;
  }
  if (account.equityPeak !== peak) account.equityPeak = Number(peak.toFixed(2));
  return false;
}

function paperLabDrawdownPct(account) {
  const peak = Math.max(paperNumber(account && account.equityPeak),
    paperNumber(account && account.startingEquity) || PAPER_LAB_STARTING_EQUITY);
  const equity = paperLabAccountEquity(account);
  return peak > 0 ? Math.max(0, (peak - equity) / peak * 100) : 0;
}

function paperLabAccountActive(account) {
  return account && Array.isArray(account.activeTrades)
    ? account.activeTrades.filter(paperLabIsActive) : [];
}

function paperLabTimeframe(pair, timeframe) {
  return pair && pair.mtf && pair.mtf[timeframe] && pair.mtf[timeframe].status === 'FULL'
    ? pair.mtf[timeframe] : null;
}

function paperLabReject(strategyId, pair, codes, reasons) {
  return {
    strategyId, sym: pair && pair.sym || null,
    status: 'REJECTED', codes: Array.isArray(codes) ? codes : [],
    reasons: Array.isArray(reasons) ? reasons : [],
    at: new Date().toISOString()
  };
}

function paperLabCreateSetup(pair, account, dir, levels, metadata) {
  const price = paperNumber(pair && pair.price);
  const entryRaw = paperNumber(levels && levels.entry);
  const slRaw = paperNumber(levels && levels.sl);
  const tp1Raw = paperNumber(levels && levels.tp1);
  const tp2Raw = paperNumber(levels && levels.tp2);
  const round = value => paperRoundPriceForPair(value, pair);
  const entry = round(entryRaw);
  const sl = round(slRaw);
  const tp1 = round(tp1Raw);
  const tp2 = round(tp2Raw);
  const stopDistance = Math.abs(entry - sl);
  const riskDollar = paperLabAccountEquity(account) * Number(account.riskPct || 0.5) / 100;
  const contracts = stopDistance > 0 ? riskDollar / stopDistance : 0;
  const setup = {
    dir, entry, sl, tp1, tp2,
    structureSupport: levels && levels.structureSupport || null,
    structureResistance: levels && levels.structureResistance || null,
    atr: Number(paperNumber(levels && levels.atr).toFixed(8)),
    contracts: Number(contracts.toFixed(8)),
    size: Number((contracts * entry).toFixed(2)),
    riskPct: Number(Number(account.riskPct || 0.5).toFixed(2)),
    riskDollar: Number(riskDollar.toFixed(2)),
    strategyId: account.strategyId,
    strategyVersion: account.version,
    nativeExit: true,
    exitModel: metadata && metadata.exitModel || account.strategyId,
    trailing: metadata && metadata.trailing || PAPER_LAB_STRATEGIES[account.strategyId].trailing,
    signalReason: metadata && metadata.signalReason || null,
    entryModel: metadata && metadata.entryModel || account.strategyId,
    strategyEvidence: metadata && metadata.strategyEvidence || [],
    signalState: metadata && metadata.signalState || null,
    preScore: metadata && metadata.preScore != null ? metadata.preScore : null,
    confirmationScore: metadata && metadata.confirmationScore != null ? metadata.confirmationScore : null
  };
  const validation = validatePaperSetup(pair, setup);
  if (validation.rr < Number(account.minRR || 2)) {
    validation.ok = false;
    validation.reasons.push('RR ' + validation.rr + ' di bawah minimum ' + account.minRR);
    validation.reasonCodes.push('RR_TOO_LOW');
  }
  return {setup, validation};
}

function paperLabRequireMtf(pair) {
  if (!pair || pair.mtfStatus !== 'FULL') {
    return paperLabReject(null, pair, [pair && pair.mtfStatus === 'STALE' ? 'MTF_STALE' : 'MTF_INCOMPLETE'],
      ['Data H4/H1/M30/M15 belum lengkap atau stale']);
  }
  const missing = ['H4', 'H1', 'M30', 'M15'].filter(tf => !paperLabTimeframe(pair, tf));
  return missing.length ? paperLabReject(null, pair, ['MTF_INCOMPLETE'],
    ['Timeframe tidak tersedia: ' + missing.join(', ')]) : null;
}

function paperLabEvaluateMtf(pair, account) {
  const base = paperLabRequireMtf(pair);
  if (base) return {...base, strategyId: account.strategyId};
  const gate = paperMtfGate(pair, PAPER_MIN_CONFLUENCE);
  if (!gate.ok) return paperLabReject(account.strategyId, pair, gate.codes, gate.reasons);
  if (!pair.signalScores || Number(pair.signalScores.total || 0) < PAPER_MIN_SIGNAL_SCORE) {
    return paperLabReject(account.strategyId, pair, ['SIGNAL_SCORE_LOW'],
      ['Signal score ' + Number(pair.signalScores && pair.signalScores.total || 0) + '/' + PAPER_MIN_SIGNAL_SCORE]);
  }
  const setupResult = paperLabCreateSetup(pair, account, pair.mtfDirection,
    paperSetup(pair, {equity: paperLabAccountEquity(account), riskPct: account.riskPct}), {
      exitModel: 'ATR_STRUCTURE', entryModel: 'EMA21_THEN_STRUCTURE',
      trailing: PAPER_LAB_STRATEGIES.MTF_ATR_V2.trailing,
      signalReason: 'H4/H1 bias · M30 confirm · M15 trigger',
      strategyEvidence: ['MTF ' + pair.mtfAlignment + '/4', 'Confluence ' + pair.confluencePct + '%']
    });
  return setupResult.validation.ok ? {ok: true, setup: setupResult.setup, validation: setupResult.validation,
    reason: 'MTF alignment ' + pair.mtfAlignment + '/4'}
    : paperLabReject(account.strategyId, pair, setupResult.validation.reasonCodes, setupResult.validation.reasons);
}

function paperLabNearestLevels(pair, price) {
  const supports = ['H4', 'H1', 'M30', 'M15'].map(tf => paperNumber(pair.mtf[tf] && pair.mtf[tf].support))
    .filter(value => value > 0 && value < price);
  const resistances = ['H4', 'H1', 'M30', 'M15'].map(tf => paperNumber(pair.mtf[tf] && pair.mtf[tf].resistance))
    .filter(value => value > price);
  return {
    support: supports.length ? Math.max(...supports) : null,
    resistance: resistances.length ? Math.min(...resistances) : null,
    supports, resistances
  };
}

function paperLabEvaluateSr(pair, account) {
  const base = paperLabRequireMtf(pair);
  if (base) return {...base, strategyId: account.strategyId};
  const price = paperNumber(pair.price);
  const m15 = paperLabTimeframe(pair, 'M15');
  const h1 = paperLabTimeframe(pair, 'H1');
  const h4 = paperLabTimeframe(pair, 'H4');
  const i = m15.indicators || {};
  const atr = Math.max(paperNumber(m15.atr), price * 0.0025);
  const levels = paperLabNearestLevels(pair, price);
  const supportTouches = ['H1', 'H4', 'M30', 'M15'].filter(tf => {
    const item = pair.mtf[tf]; const value = paperNumber(item && item.support);
    return value > 0 && Math.abs(value - (levels.support || value)) <= atr * 0.5;
  }).length;
  const resistanceTouches = ['H1', 'H4', 'M30', 'M15'].filter(tf => {
    const item = pair.mtf[tf]; const value = paperNumber(item && item.resistance);
    return value > 0 && Math.abs(value - (levels.resistance || value)) <= atr * 0.5;
  }).length;
  const bullishReject = levels.support && supportTouches >= 2 && i.candleDirection === 'LONG' &&
    ['HAMMER', 'BULLISH_ENGULFING', 'BULLISH_CLOSE'].includes(i.candlePattern) &&
    h1.direction !== 'SHORT' && h4.direction !== 'SHORT';
  const bearishReject = levels.resistance && resistanceTouches >= 2 && i.candleDirection === 'SHORT' &&
    ['SHOOTING_STAR', 'BEARISH_ENGULFING', 'BEARISH_CLOSE'].includes(i.candlePattern) &&
    h4.direction !== 'LONG';
  const dir = bullishReject ? 'LONG' : bearishReject ? 'SHORT' : null;
  if (!dir) return paperLabReject(account.strategyId, pair, ['SR_REJECTION_NOT_CONFIRMED'],
    ['Zona H1/H4 belum memiliki 2 reaksi + candle rejection yang valid']);
  const zone = dir === 'LONG' ? levels.support : levels.resistance;
  const entry = dir === 'LONG' ? zone + atr * 0.05 : zone - atr * 0.05;
  const sl = dir === 'LONG' ? zone - atr * 0.3 : zone + atr * 0.3;
  const target = dir === 'LONG' ? levels.resistance : levels.support;
  if (!target || (dir === 'LONG' ? target <= entry : target >= entry)) {
    return paperLabReject(account.strategyId, pair, ['SR_TARGET_MISSING'], ['Level lawan untuk TP belum tersedia']);
  }
  const risk = Math.abs(entry - sl);
  const tp1 = target;
  const tp2 = dir === 'LONG'
    ? Math.max(tp1 + risk, tp1 + atr * 0.5) : Math.min(tp1 - risk, tp1 - atr * 0.5);
  const setupResult = paperLabCreateSetup(pair, account, dir,
    {entry, sl, tp1, tp2, atr, structureSupport: dir === 'LONG' ? zone : null,
      structureResistance: dir === 'SHORT' ? zone : null}, {
      exitModel: 'SR_ZONE', entryModel: 'SR_RETEST_REJECTION',
      signalReason: 'Zona ' + (dir === 'LONG' ? 'support' : 'resistance') + ' dengan ' +
        (dir === 'LONG' ? supportTouches : resistanceTouches) + ' reaksi',
      strategyEvidence: ['zone ±0.5 ATR', 'rejection ' + i.candlePattern]
    });
  return setupResult.validation.ok ? {ok: true, setup: setupResult.setup, validation: setupResult.validation,
    reason: 'SR rejection ' + dir} : paperLabReject(account.strategyId, pair,
    setupResult.validation.reasonCodes, setupResult.validation.reasons);
}

function paperLabEvaluateBreakout(pair, account) {
  const base = paperLabRequireMtf(pair);
  if (base) return {...base, strategyId: account.strategyId};
  const m15 = paperLabTimeframe(pair, 'M15');
  const h1 = paperLabTimeframe(pair, 'H1');
  const i = m15.indicators || {};
  const price = paperNumber(pair.price);
  const atr = Math.max(paperNumber(m15.atr), price * 0.0025);
  const volumeRatio = paperNumber(m15.volumeRatio || pair.volumeRatio);
  const bodyPct = paperNumber(i.bodyPct) / 100;
  const longBreak = i.rangeHigh20 > 0 && i.close >= i.rangeHigh20 + atr * 0.2 &&
    volumeRatio >= 1.5 && bodyPct >= 0.5 && h1.direction !== 'SHORT';
  const shortBreak = i.rangeLow20 > 0 && i.close <= i.rangeLow20 - atr * 0.2 &&
    volumeRatio >= 1.5 && bodyPct >= 0.5 && h1.direction !== 'LONG';
  const dir = longBreak ? 'LONG' : shortBreak ? 'SHORT' : null;
  if (!dir) return paperLabReject(account.strategyId, pair, ['BREAKOUT_NOT_VALID'],
    ['Close belum menembus range 20 candle dengan ≥0.2 ATR, volume ≥1.5x, dan body ≥50%']);
  const level = dir === 'LONG' ? i.rangeHigh20 : i.rangeLow20;
  const entry = level;
  const sl = dir === 'LONG' ? level - atr * 0.8 : level + atr * 0.8;
  const risk = Math.abs(entry - sl);
  const tp1 = dir === 'LONG' ? entry + risk * 2 : entry - risk * 2;
  const tp2 = dir === 'LONG' ? entry + risk * 3 : entry - risk * 3;
  const setupResult = paperLabCreateSetup(pair, account, dir,
    {entry, sl, tp1, tp2, atr, structureSupport: dir === 'LONG' ? level : null,
      structureResistance: dir === 'SHORT' ? level : null}, {
      exitModel: 'BREAKOUT_ATR', entryModel: '20C_RANGE_RETEST',
      signalReason: 'breakout close + retest ≤4 candle',
      strategyEvidence: ['range20', 'volume ' + volumeRatio.toFixed(2) + 'x', 'body ' + (bodyPct * 100).toFixed(0) + '%']
    });
  return setupResult.validation.ok ? {ok: true, setup: setupResult.setup, validation: setupResult.validation,
    reason: 'Breakout ' + dir} : paperLabReject(account.strategyId, pair,
    setupResult.validation.reasonCodes, setupResult.validation.reasons);
}

function paperLabEvaluateSmc(pair, account) {
  const base = paperLabRequireMtf(pair);
  if (base) return {...base, strategyId: account.strategyId};
  const m15 = paperLabTimeframe(pair, 'M15');
  const m30 = paperLabTimeframe(pair, 'M30');
  const h1 = paperLabTimeframe(pair, 'H1');
  const price = paperNumber(pair.price);
  const m15i = m15.indicators || {};
  const m30i = m30.indicators || {};
  const atr = Math.max(paperNumber(m15.atr), price * 0.0025);
  const longStructure = m30i.bos === 'LONG' || h1.direction === 'LONG';
  const shortStructure = m30i.bos === 'SHORT' || h1.direction === 'SHORT';
  const longZone = m15i.orderBlock && m15i.orderBlock.direction === 'LONG' && m15i.orderBlock.valid
    ? m15i.orderBlock : m15i.fvg && m15i.fvg.direction === 'LONG' && m15i.fvg.valid ? m15i.fvg : null;
  const shortZone = m15i.orderBlock && m15i.orderBlock.direction === 'SHORT' && m15i.orderBlock.valid
    ? m15i.orderBlock : m15i.fvg && m15i.fvg.direction === 'SHORT' && m15i.fvg.valid ? m15i.fvg : null;
  const sweptLong = m15i.liquiditySweep === 'LONG';
  const sweptShort = m15i.liquiditySweep === 'SHORT';
  const dir = sweptLong && longStructure && longZone ? 'LONG'
    : sweptShort && shortStructure && shortZone ? 'SHORT' : null;
  if (!dir) return paperLabReject(account.strategyId, pair, ['SMC_STRUCTURE_NOT_CONFIRMED'],
    ['Sweep + BOS H1/M30 + OB/FVG valid belum lengkap']);
  const zone = dir === 'LONG' ? longZone : shortZone;
  const midpoint = (paperNumber(zone.low) + paperNumber(zone.high)) / 2;
  const entry = midpoint;
  const sl = dir === 'LONG' ? paperNumber(zone.low) - atr * 0.2 : paperNumber(zone.high) + atr * 0.2;
  const levels = paperLabNearestLevels(pair, price);
  const risk = Math.abs(entry - sl);
  const tp1 = dir === 'LONG'
    ? (levels.resistance > entry ? levels.resistance : entry + risk * 2)
    : (levels.support > 0 && levels.support < entry ? levels.support : entry - risk * 2);
  const tp2 = dir === 'LONG' ? Math.max(tp1, entry + risk * 3) : Math.min(tp1, entry - risk * 3);
  const setupResult = paperLabCreateSetup(pair, account, dir,
    {entry, sl, tp1, tp2, atr, structureSupport: dir === 'LONG' ? zone.low : null,
      structureResistance: dir === 'SHORT' ? zone.high : null}, {
      exitModel: 'SMC_LIQUIDITY', entryModel: 'SWEEP_BOS_OB_FVG_RETEST',
      signalReason: 'liquidity sweep + BOS + ' + (zone.gap ? 'FVG' : 'order block'),
      strategyEvidence: ['sweep ' + m15i.liquiditySweep, 'BOS ' + m30i.bos, 'zone valid 20 candles']
    });
  return setupResult.validation.ok ? {ok: true, setup: setupResult.setup, validation: setupResult.validation,
    reason: 'SMC ' + dir} : paperLabReject(account.strategyId, pair,
    setupResult.validation.reasonCodes, setupResult.validation.reasons);
}

function paperLabEvaluateRange(pair, account) {
  const base = paperLabRequireMtf(pair);
  if (base) return {...base, strategyId: account.strategyId};
  const m15 = paperLabTimeframe(pair, 'M15');
  const h1 = paperLabTimeframe(pair, 'H1');
  const h4 = paperLabTimeframe(pair, 'H4');
  const i = m15.indicators || {};
  const h1i = h1.indicators || {};
  const price = paperNumber(pair.price);
  const atr = Math.max(paperNumber(m15.atr), price * 0.0025);
  const adx = paperNumber(h1i.adx);
  const volumeRatio = paperNumber(m15.volumeRatio || pair.volumeRatio);
  const invalidBreakout = [h1i, h4.indicators || {}].some(item =>
    ['LONG', 'SHORT'].includes(item.bos)) || volumeRatio > 2;
  const longReentry = i.bbLower > 0 && i.previousClose < i.previousBbLower && i.close > i.bbLower &&
    paperNumber(i.rsi) <= 35 && i.candleDirection === 'LONG';
  const shortReentry = i.bbUpper > 0 && i.previousClose > i.previousBbUpper && i.close < i.bbUpper &&
    paperNumber(i.rsi) >= 65 && i.candleDirection === 'SHORT';
  const dir = adx < 18 && !invalidBreakout && (longReentry || shortReentry)
    ? longReentry ? 'LONG' : 'SHORT' : null;
  if (!dir) return paperLabReject(account.strategyId, pair, ['RANGE_FILTER_NOT_VALID'],
    ['ADX H1 harus <18, tidak ada BOS, volume spike, dan harus ada BB/RSI re-entry']);
  const entry = dir === 'LONG' ? i.bbLower : i.bbUpper;
  const sl = dir === 'LONG' ? entry - atr * 0.8 : entry + atr * 0.8;
  const tp1 = i.bbMiddle;
  const risk = Math.abs(entry - sl);
  const tp2 = dir === 'LONG' ? entry + risk * 3 : entry - risk * 3;
  const setupResult = paperLabCreateSetup(pair, account, dir,
    {entry, sl, tp1, tp2, atr, structureSupport: dir === 'LONG' ? i.bbLower : null,
      structureResistance: dir === 'SHORT' ? i.bbUpper : null}, {
      exitModel: 'BOLLINGER_RANGE', entryModel: 'BB_REENTRY_RSI',
      signalReason: 'ADX ' + adx.toFixed(1) + ' + Bollinger re-entry + RSI extreme',
      strategyEvidence: ['ADX H1 <18', 'RSI ' + paperNumber(i.rsi).toFixed(1), 'volume ' + volumeRatio.toFixed(2) + 'x']
    });
  return setupResult.validation.ok ? {ok: true, setup: setupResult.setup, validation: setupResult.validation,
    reason: 'Range mean reversion ' + dir} : paperLabReject(account.strategyId, pair,
    setupResult.validation.reasonCodes, setupResult.validation.reasons);
}

function paperLabEvaluatePrebreakout(pair, account) {
  const signal = makePrebreakoutSignal(pair, PREBREAKOUT_DEFAULTS);
  const reject = (codes, reasons) => {
    const result = paperLabReject(account.strategyId, pair, codes, reasons);
    result.signal = signal;
    return result;
  };
  if (signal.status !== 'BREAKOUT_CONFIRMED') {
    return reject(['PREBREAKOUT_' + signal.status], [
      signal.status + ' · pre-score ' + signal.preScore + '/100 · confirmation ' + signal.confirmationScore + '/100'
    ]);
  }
  if (!pair || pair.mtfStatus !== 'FULL' || pair.dataQuality === 'STALE' || pair.dataQuality === 'REJECTED') {
    return reject(['PREBREAKOUT_DATA_NOT_FULL'], ['Breakout terkonfirmasi tetapi kualitas MTF/data belum FULL']);
  }
  const levels = buildPrebreakoutSetup(signal);
  if (!levels) return reject(['PREBREAKOUT_SETUP_INVALID'], ['Level breakout atau ATR tidak valid']);
  const setupResult = paperLabCreateSetup(pair, account, signal.direction, levels, {
    exitModel: 'PREBREAKOUT_ATR', entryModel: 'BREAKOUT_RETEST_LIMIT',
    trailing: PAPER_LAB_STRATEGIES.PREBREAKOUT_RESEARCH_V1.trailing,
    signalReason: 'BREAKOUT_CONFIRMED · pre-score ' + signal.preScore + '/100 · confirmation ' + signal.confirmationScore + '/100',
    signalState: signal.status, preScore: signal.preScore, confirmationScore: signal.confirmationScore,
    strategyEvidence: signal.evidence.concat([
      'retest ' + (signal.breakout.retestConfirmed ? 'confirmed' : 'not confirmed'),
      'invalidation: ' + signal.invalidation
    ])
  });
  if (!setupResult.validation.ok) {
    const result = paperLabReject(account.strategyId, pair, setupResult.validation.reasonCodes,
      setupResult.validation.reasons);
    result.signal = signal;
    return result;
  }
  return {ok: true, setup: setupResult.setup, validation: setupResult.validation,
    signal, reason: 'Pre-breakout confirmed ' + signal.direction};
}

function paperLabEvaluateCandidate(pair, strategyId, account) {
  if (!pair || !account || !account.enabled) {
    return paperLabReject(strategyId, pair, ['STRATEGY_DISABLED'], ['Strategi disabled']);
  }
  switch (strategyId) {
    case 'MTF_ATR_V2': return paperLabEvaluateMtf(pair, account);
    case 'SR_REJECTION_V1': return paperLabEvaluateSr(pair, account);
    case 'BREAKOUT_RETEST_V1': return paperLabEvaluateBreakout(pair, account);
    case 'SMC_LIQUIDITY_V1': return paperLabEvaluateSmc(pair, account);
    case 'RANGE_MEAN_REVERSION_V1': return paperLabEvaluateRange(pair, account);
    case 'PREBREAKOUT_RESEARCH_V1': return paperLabEvaluatePrebreakout(pair, account);
    default: return paperLabReject(strategyId, pair, ['STRATEGY_UNKNOWN'], ['Strategi tidak dikenal']);
  }
}

function paperLabCreateTrade(pair, account, result, cycleKey) {
  const setup = result.setup;
  const strategyId = account.strategyId;
  const id = 'LAB-' + String(++paperState.strategyLab.nextId).padStart(6, '0');
  const candidate = paperCandidateView(pair);
  const trade = {
    id, sym: pair.sym, dir: setup.dir, status: 'PENDING',
    entryLimit: setup.entry, entryActual: null, currentPrice: pair.price,
    sl: setup.sl, tp1: setup.tp1, tp2: setup.tp2,
    size: setup.size, originalSize: setup.size, remainingSize: setup.size,
    contracts: setup.contracts, originalContracts: setup.contracts, remainingContracts: setup.contracts,
    riskPct: setup.riskPct, riskDollar: setup.riskDollar, riskDollarAtEntry: setup.riskDollar,
    tp1ClosePct: account.tp1ClosePct, tp1Hit: false, tp1HitAt: null, slAfterTp1: null,
    realizedPnlTp1: 0, realizedPnl: 0, realizedPnlFinal: 0, unrealPnl: 0, mfePnl: 0, maePnl: 0,
    createdAt: Date.now(), openedAt: null, closedAt: null, cycleKey,
    strategyId, strategyVersion: account.version, cohortId: 'lab-' + strategyId,
    universeVersion: pair.universeVersion || UNIVERSE_VERSION,
    mode: PAPER_LAB_MODE, signalMode: 'NATIVE', timeframe: '15M', tf: '15M',
    dataQuality: pair.dataQuality || 'PARTIAL', dataAt: pair.dataAt, source: pair.source,
    chg: pair.chg, fund: pair.fund, oi: pair.oi, volume: pair.volume,
    volumeRatio: pair.volumeRatio, fundingAvailable: !!pair.fundingAvailable,
    oiAvailable: !!pair.oiAvailable, volumeAvailable: !!pair.volumeAvailable,
    mtf: pair.mtf, mtfDirection: pair.mtfDirection, mtfAlignment: pair.mtfAlignment,
    mtfSummary: pair.mtfSummary, confluencePct: pair.confluencePct,
    indicators: pair.mtf && pair.mtf.M15 ? pair.mtf.M15.indicators : null,
    signalScores: pair.signalScores || null, score: pair.sc || null, tier: pair.tier || null,
    signalCreatedAt: new Date().toISOString(),
    candleAtByTf: Object.fromEntries(['H4', 'H1', 'M30', 'M15'].map(tf =>
      [tf, pair.mtf && pair.mtf[tf] ? pair.mtf[tf].lastClosedCandleAt || pair.mtf[tf].candleAt : null])),
    entryModel: setup.entryModel, exitModel: setup.exitModel, nativeExit: true,
    trailing: setup.trailing, strategyEvidence: setup.strategyEvidence || [],
    signalState: setup.signalState || null, preScore: setup.preScore, confirmationScore: setup.confirmationScore,
    signalReason: setup.signalReason || result.reason, setupValidation: result.validation,
    pendingTtlMs: account.pendingTtlMs, executionModel: 'SHADOW_LIMIT_1M',
    fillMethod: null, fillCandleAt: null, lastProcessedCandleAt: null,
    closeStage: null, closeReason: null, outcome: null, exitPrice: null, r: 0, pnl: 0,
    events: [{type: 'ORDER_PLACED', at: new Date().toISOString(), price: setup.entry,
      candleAt: null, reason: result.reason, size: setup.size}]
  };
  paperEnsureAnalysis(trade);
  trade.analysisStatus = 'CAPTURED';
  trade.analysisTags = {
    exit: [],
    setup: [strategyId, 'NATIVE_EXIT', 'RR_' + result.validation.rr],
    market: [pair.mtfDirection ? 'MTF_' + pair.mtfDirection : 'MTF_NEUTRAL']
  };
  return trade;
}

function paperLabRecordSignal(account, signal) {
  if (!account || !signal || !signal.sym ||
      !['WATCH', 'PRE_BREAKOUT', 'BREAKOUT_CONFIRMED', 'EXTENDED_OR_RISKY'].includes(signal.status)) return false;
  const key = [signal.sym, signal.status, signal.direction || 'NEUTRAL'].join(':');
  const now = Date.parse(signal.signalAt) || Date.now();
  const previous = Number(account.signalCooldowns && account.signalCooldowns[key] || 0);
  if (previous > 0 && now - previous < 60 * 60 * 1000) return false;
  account.signalCooldowns = account.signalCooldowns || {};
  account.signalCooldowns[key] = now;
  const snapshot = {
    ...signal,
    strategyId: account.strategyId,
    strategyVersion: account.version,
    cohortId: 'lab-' + account.strategyId,
    mode: PAPER_LAB_MODE,
    execution: PAPER_LAB_STRATEGIES[account.strategyId].execution || 'PAPER_LIMIT',
    recordedAt: new Date(now).toISOString()
  };
  account.monitoringSignals = [snapshot].concat(account.monitoringSignals || [])
    .slice(0, PAPER_MAX_MONITORING_SIGNALS);
  return true;
}

function paperLabScan(ranked, cycleKey, reason, options) {
  const lab = paperState.strategyLab;
  if (!lab || lab.enabled === false) return false;
  const selectedIds = options && Array.isArray(options.strategyIds)
    ? new Set(options.strategyIds) : null;
  const updateLabCycle = !(options && options.updateLabCycle === false);
  if (updateLabCycle) {
    if (lab.lastCycleKey === cycleKey) return false;
  }
  const placedByStrategy = {};
  const rejectedByStrategy = {};
  const signalCountsByStrategy = {};
  const usedSymbols = {};
  let changed = false;
  Object.keys(PAPER_LAB_STRATEGIES).filter(strategyId => !selectedIds || selectedIds.has(strategyId)).forEach(strategyId => {
    const account = lab.accounts[strategyId];
    if (!account || !account.enabled) return;
    paperLabUpdatePeak(account);
    const dd = paperLabDrawdownPct(account);
    const active = paperLabAccountActive(account);
    const rejections = [];
    if (dd >= account.emergencyDrawdownPct) {
      account.lastError = 'EMERGENCY_DD_REACHED';
      rejectedByStrategy[strategyId] = [{codes: ['EMERGENCY_DD_REACHED'], reasons: ['DD ' + dd.toFixed(2) + '% >= 50%']}];
      return;
    }
    if (active.length >= account.maxActive) {
      rejectedByStrategy[strategyId] = [{codes: ['MAX_ACTIVE_REACHED'], reasons: ['max active ' + account.maxActive]}];
      return;
    }
    const activeSymbols = new Set(active.map(trade => trade.sym));
    for (const pair of ranked) {
      if (activeSymbols.has(pair.sym)) continue;
      const result = paperLabEvaluateCandidate(pair, strategyId, account);
      if (result.signal && paperLabRecordSignal(account, result.signal)) {
        signalCountsByStrategy[strategyId] = (signalCountsByStrategy[strategyId] || 0) + 1;
        changed = true;
      }
      if (!result.ok) {
        rejections.push({sym: pair.sym, codes: result.codes, reasons: result.reasons});
        continue;
      }
      const expectedLoss = Number(result.validation.expectedLoss || result.setup.riskDollar || 0);
      const riskBudget = paperLabAccountEquity(account) * 0.4;
      const activeRisk = active.reduce((sum, trade) => sum + paperTradeRiskDollar(trade), 0);
      if (activeRisk + expectedLoss > riskBudget * 1.05) {
        rejections.push({sym: pair.sym, codes: ['RISK_BUDGET_REACHED'], reasons: ['risk budget lab 40% tercapai']});
        continue;
      }
      const trade = paperLabCreateTrade(pair, account, result, cycleKey);
      account.activeTrades.push(trade);
      account.lastScanAt = new Date().toISOString();
      account.lastPlacedAt = account.lastScanAt;
      placedByStrategy[strategyId] = paperTradeView(trade);
      (usedSymbols[pair.sym] || (usedSymbols[pair.sym] = [])).push(strategyId);
      changed = true;
      break;
    }
    account.recentRejections = rejections.slice(0, 50);
    rejectedByStrategy[strategyId] = rejections.slice(0, 8);
  });
  const overlaps = Object.entries(usedSymbols)
    .filter(([, strategies]) => strategies.length > 1)
    .map(([sym, strategies]) => ({sym, strategies, cycleKey, at: new Date().toISOString()}));
  if (overlaps.length) lab.overlapEvents = overlaps.concat(lab.overlapEvents || []).slice(0, 100);
  lab.lastScanAt = new Date().toISOString();
  if (updateLabCycle) lab.lastCycleKey = cycleKey;
  lab.lastError = null;
  lab.recentScans = [{cycleKey, at: lab.lastScanAt, reason: reason || '15M close',
    placed: placedByStrategy, rejected: rejectedByStrategy,
    signalCounts: signalCountsByStrategy, candidates: ranked.length, overlaps,
    universeVersion: ranked[0] && ranked[0].universeVersion || UNIVERSE_VERSION}]
    .concat(lab.recentScans || []).slice(0, 200);
  return changed;
}

function paperLabCloseTrade(account, trade, exitPrice, outcome, reason) {
  const size = paperTradeRemainingSize(trade);
  const pnlPart = paperTradePnl(trade, exitPrice, size);
  const totalPnl = paperNumber(trade.realizedPnl) + pnlPart;
  const initialRisk = paperTradeInitialRiskDollar(trade);
  const r = initialRisk > 0 ? totalPnl / initialRisk : 0;
  trade.status = 'CLOSED'; trade.exitPrice = exitPrice; trade.closedAt = new Date().toISOString();
  trade.realizedPnlFinal = Number(pnlPart.toFixed(2)); trade.realizedPnl = Number(totalPnl.toFixed(2));
  paperSetRemainingSize(trade, 0); trade.unrealPnl = 0;
  trade.outcome = outcome; trade.closeReason = reason; trade.r = Number(r.toFixed(2));
  trade.pnl = Number(totalPnl.toFixed(2));
  trade.closeStage = String(reason).toLowerCase().includes('tp2') ? 'CLOSED_TP2'
    : trade.tp1Hit ? 'CLOSED_AFTER_TP1' : 'CLOSED_DIRECT';
  trade.lastEvent = 'CLOSED';
  paperAddTradeEvent(trade, 'CLOSED', {price: exitPrice, reason});
  trade.analysisTags = trade.analysisTags || {exit: [], setup: [], market: []};
  trade.analysisTags.exit = [String(reason).toUpperCase().replace(/[^A-Z0-9]+/g, '_')];
  trade.analysisTags.setup = trade.analysisTags.setup || [];
  trade.analysisTags.market = trade.analysisTags.market || [];
  account.closedTrades.unshift({...trade});
  account.closedTrades = account.closedTrades.slice(0, PAPER_LAB_MAX_CLOSED_TRADES);
}

function paperLabPartialClose(account, trade, price) {
  const currentSize = paperTradeRemainingSize(trade);
  const closePct = Number(account.tp1ClosePct || PAPER_TP1_CLOSE_PCT);
  const closeSize = currentSize * closePct / 100;
  const pnlPart = paperTradePnl(trade, price, closeSize);
  trade.realizedPnlTp1 = paperNumber(trade.realizedPnlTp1) + pnlPart;
  trade.realizedPnl = paperNumber(trade.realizedPnl) + pnlPart;
  trade.tp1Hit = true; trade.tp1HitAt = new Date().toISOString();
  trade.slAfterTp1 = trade.entryActual || trade.entryLimit;
  paperSetRemainingSize(trade, currentSize - closeSize);
  trade.status = 'TP1_PARTIAL'; trade.lastEvent = 'TP1_PARTIAL';
  paperAddTradeEvent(trade, 'TP1_PARTIAL', {price, reason: 'TP1 ' + closePct + '%'});
}

function monitorStrategyLabTrades(prices, barsBySymbol) {
  const lab = paperState.strategyLab;
  if (!lab || lab.enabled === false) return false;
  let changed = false;
  Object.values(lab.accounts || {}).forEach(account => {
    const retained = [];
    const now = Date.now();
    (account.activeTrades || []).forEach(trade => {
      const price = paperNumber(prices[trade.sym]);
      const bars = barsBySymbol[trade.sym] || [];
      const latest = bars.length ? bars[bars.length - 1] : null;
      trade.currentPrice = price || (latest && latest.close) || trade.currentPrice;
      const unprocessed = bars.filter(bar => !trade.lastProcessedCandleAt ||
        new Date(bar.ts).toISOString() > trade.lastProcessedCandleAt);
      if (trade.status === 'PENDING') {
        if (now - trade.createdAt >= Number(trade.pendingTtlMs || account.pendingTtlMs)) {
          trade.status = 'CANCELLED'; trade.closedAt = new Date().toISOString();
          trade.closeReason = 'Pending expired after ' + Math.round(Number(trade.pendingTtlMs || account.pendingTtlMs) / 60000) + ' minutes';
          trade.outcome = 'CANCELLED'; trade.pnl = 0; trade.r = 0;
          trade.lastEvent = 'PENDING_EXPIRED'; paperAddTradeEvent(trade, 'PENDING_EXPIRED', {price: trade.currentPrice, reason: trade.closeReason});
          account.closedTrades.unshift({...trade}); changed = true; return;
        }
        for (const bar of unprocessed) {
          trade.lastProcessedCandleAt = new Date(bar.ts).toISOString();
          const filled = trade.dir === 'LONG' ? bar.low <= trade.entryLimit : bar.high >= trade.entryLimit;
          if (filled) {
            trade.status = 'OPEN'; trade.entryActual = trade.entryLimit; trade.openedAt = new Date().toISOString();
            trade.fillMethod = '1M_HIGH_LOW'; trade.fillCandleAt = trade.lastProcessedCandleAt;
            trade.lastEvent = 'LIMIT_FILLED'; paperAddTradeEvent(trade, 'LIMIT_FILLED', {price: trade.entryActual, candleAt: trade.fillCandleAt});
            changed = true; break;
          }
        }
        retained.push(trade); return;
      }
      if (!paperLabIsActive(trade)) { retained.push(trade); return; }
      const entry = paperNumber(trade.entryActual || trade.entryLimit);
      const size = paperTradeRemainingSize(trade);
      if (entry > 0 && trade.currentPrice > 0 && size > 0) {
        trade.unrealPnl = paperTradePnl(trade, trade.currentPrice, size);
        const mark = paperNumber(trade.realizedPnl) + trade.unrealPnl;
        trade.mfePnl = Math.max(paperNumber(trade.mfePnl), mark);
        trade.maePnl = Math.min(paperNumber(trade.maePnl), mark);
      }
      let keep = true;
      for (const bar of unprocessed) {
        if (!paperLabIsActive(trade)) break;
        trade.lastProcessedCandleAt = new Date(bar.ts).toISOString();
        const signalAtr = Math.max(paperNumber(trade.atr), entry * 0.0025);
        if (trade.status === 'TP1_PARTIAL' && trade.trailing && trade.trailing.enabled) {
          const trail = trade.dir === 'LONG' ? bar.close - signalAtr * Number(trade.trailing.atrMult || 1)
            : bar.close + signalAtr * Number(trade.trailing.atrMult || 1);
          const currentStop = paperNumber(trade.slAfterTp1 || trade.sl);
          trade.slAfterTp1 = trade.dir === 'LONG' ? Math.max(currentStop, trail) : Math.min(currentStop || trail, trail);
        }
        const stop = trade.status === 'TP1_PARTIAL' ? (trade.slAfterTp1 || trade.sl) : trade.sl;
        const target = trade.status === 'TP1_PARTIAL' ? trade.tp2 : trade.tp1;
        const sizeNow = paperTradeRemainingSize(trade);
        const stopHit = trade.dir === 'LONG' ? bar.low <= stop : bar.high >= stop;
        const targetHit = trade.dir === 'LONG' ? bar.high >= target : bar.low <= target;
        if (stopHit) {
          const stopPnl = paperTradePnl(trade, stop, sizeNow);
          const projected = paperTradeInitialRiskDollar(trade) > 0
            ? (paperNumber(trade.realizedPnl) + stopPnl) / paperTradeInitialRiskDollar(trade) : 0;
          paperLabCloseTrade(account, trade, stop, projected > 0.05 ? 'WIN' : projected < -0.05 ? 'LOSS' : 'BREAKEVEN',
            trade.tp1Hit ? 'Hit SL after TP1' : 'Hit SL');
          changed = true; keep = false; break;
        }
        if (targetHit && trade.status === 'OPEN') {
          paperLabPartialClose(account, trade, trade.tp1); changed = true; break;
        }
        if (targetHit && trade.status === 'TP1_PARTIAL') {
          paperLabCloseTrade(account, trade, trade.tp2, 'WIN', 'Hit TP2'); changed = true; keep = false; break;
        }
      }
      if (keep) retained.push(trade);
    });
    account.activeTrades = retained;
    paperLabUpdatePeak(account);
  });
  return changed;
}

function paperLabAccountSummary(account) {
  const all = [...(account.closedTrades || [])];
  const closed = all.filter(trade => trade.outcome !== 'CANCELLED');
  const wins = closed.filter(trade => trade.outcome === 'WIN');
  const losses = closed.filter(trade => trade.outcome === 'LOSS');
  const pnl = all.reduce((sum, trade) => sum + paperNumber(trade.pnl), 0);
  const netR = closed.reduce((sum, trade) => sum + paperNumber(trade.r), 0);
  const grossProfit = wins.reduce((sum, trade) => sum + Math.max(0, paperNumber(trade.r)), 0);
  const grossLoss = losses.reduce((sum, trade) => sum + Math.min(0, paperNumber(trade.r)), 0);
  let cumulative = 0; let peak = 0; let maxDrawdownR = 0;
  closed.slice().reverse().forEach(trade => {
    cumulative += paperNumber(trade.r); peak = Math.max(peak, cumulative); maxDrawdownR = Math.max(maxDrawdownR, peak - cumulative);
  });
  const equity = paperLabAccountEquity(account);
  const starting = paperNumber(account.startingEquity || PAPER_LAB_STARTING_EQUITY);
  return {
    strategyId: account.strategyId, label: account.label, version: account.version, enabled: account.enabled,
    mode: PAPER_LAB_MODE, startingEquity: Number(starting.toFixed(2)), equity: Number(equity.toFixed(2)),
    pnl: Number(pnl.toFixed(2)), returnPct: Number(((equity - starting) / starting * 100).toFixed(2)),
    equityPeak: Number(paperNumber(account.equityPeak).toFixed(2)), drawdownPct: Number(paperLabDrawdownPct(account).toFixed(2)),
    active: paperLabAccountActive(account).length, pending: paperLabAccountActive(account).filter(t => t.status === 'PENDING').length,
    open: paperLabAccountActive(account).filter(t => t.status === 'OPEN' || t.status === 'TP1_PARTIAL').length,
    closed: closed.length, wins: wins.length, losses: losses.length,
    winRate: closed.length ? Number((wins.length / closed.length * 100).toFixed(1)) : 0,
    netR: Number(netR.toFixed(2)), expectancyR: closed.length ? Number((netR / closed.length).toFixed(3)) : 0,
    profitFactor: grossLoss < 0 ? Number((grossProfit / Math.abs(grossLoss)).toFixed(2)) : null,
    maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
    execution: PAPER_LAB_STRATEGIES[account.strategyId].execution || 'PAPER_LIMIT',
    signalCount: Array.isArray(account.monitoringSignals) ? account.monitoringSignals.length : 0,
    lastSignalAt: account.monitoringSignals && account.monitoringSignals[0]
      ? account.monitoringSignals[0].recordedAt || account.monitoringSignals[0].signalAt : null,
    status: paperLabDrawdownPct(account) >= account.emergencyDrawdownPct ? 'EMERGENCY_STOP'
      : paperLabDrawdownPct(account) >= account.warningDrawdownPct ? 'RISK_WARNING' : 'ACTIVE',
    lastScanAt: account.lastScanAt, lastPlacedAt: account.lastPlacedAt, lastError: account.lastError
  };
}

function paperStrategyLabSummary(includeTrades, options) {
  const includeHistory = !options || options.history !== false;
  const lab = paperState.strategyLab || paperLabDefaultState();
  const accounts = Object.values(lab.accounts || {}).map(paperLabAccountSummary);
  const activeTrades = Object.values(lab.accounts || {}).flatMap(account =>
    (account.activeTrades || []).filter(paperLabIsActive).map(trade => includeTrades ? paperTradeView(trade) : {
      id: trade.id, sym: trade.sym, dir: trade.dir, status: trade.status,
      strategyId: trade.strategyId, entryLimit: trade.entryLimit, sl: trade.sl,
      tp1: trade.tp1, tp2: trade.tp2, currentPrice: trade.currentPrice,
      universeVersion: trade.universeVersion || 'LEGACY'
    }));
  return {
    ok: true, mode: PAPER_LAB_MODE, enabled: lab.enabled !== false,
    asOf: new Date().toISOString(), startingEquity: PAPER_LAB_STARTING_EQUITY,
    strategyCount: accounts.length, totalEquity: Number(accounts.reduce((sum, item) => sum + item.equity, 0).toFixed(2)),
    totalPnl: Number(accounts.reduce((sum, item) => sum + item.pnl, 0).toFixed(2)),
    totalOrders: accounts.reduce((sum, item) => sum + item.closed + item.active, 0),
    totalClosed: accounts.reduce((sum, item) => sum + item.closed, 0),
    accounts, activeTrades,
    ...(includeHistory ? {
      recentScans: lab.recentScans.slice(0, 20),
      overlapEvents: lab.overlapEvents.slice(0, 50)
    } : {}),
    lastScanAt: lab.lastScanAt, lastCycleKey: lab.lastCycleKey,
    lastError: lab.lastError,
    definition: {
      data: 'live futures ticker + 1m/15m/30m/1h/4h candles',
      execution: 'shadow paper limit; no live broker order',
      perStrategyStartingEquity: PAPER_LAB_STARTING_EQUITY,
      perScan: PAPER_LAB_PER_SCAN, minRR: 2,
      strategies: Object.fromEntries(Object.entries(PAPER_LAB_STRATEGIES).map(([id, definition]) => [id, {
        label: definition.label, entry: id === 'MTF_ATR_V2' ? 'H4/H1/M30/M15 gate + EMA21/structure pullback'
          : id === 'SR_REJECTION_V1' ? 'H1/H4 zone + 2 reactions + rejection candle'
            : id === 'BREAKOUT_RETEST_V1' ? '20-candle close breakout + volume + retest'
              : id === 'SMC_LIQUIDITY_V1' ? 'sweep + BOS + deterministic OB/FVG retest'
                : id === 'RANGE_MEAN_REVERSION_V1' ? 'ADX<18 + Bollinger re-entry + RSI extreme'
                  : 'WATCH/PRE_BREAKOUT → confirmed close + volume + retest',
        exit: definition.trailing.enabled ? 'TP1 2R, TP2 3R, break-even + ATR trail' : 'native structure/band targets with TP1 50%'
      }]))
    }
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

function paperIsResearchTrade(trade) {
  return trade && paperTradeStrategyVersion(trade) === PAPER_RESEARCH_STRATEGY_VERSION &&
    String(trade.cohortId || paperState.researchCohortId) === String(paperState.researchCohortId);
}

function paperResearchEnabled() {
  return PAPER_RESEARCH_ENABLED && paperState.researchEnabled !== false;
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

function paperResearchActiveCount() {
  return paperState.activeTrades.filter(t => paperIsActive(t) && paperIsResearchTrade(t)).length;
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

function paperResearchRealizedPnl() {
  return paperState.closedTrades
    .filter(trade => paperIsResearchTrade(trade))
    .reduce((sum, trade) => sum + paperNumber(trade.pnl), 0);
}

function paperResearchUnrealizedPnl() {
  return paperState.activeTrades
    .filter(trade => paperIsResearchTrade(trade) &&
      (trade.status === 'OPEN' || trade.status === 'TP1_PARTIAL'))
    .reduce((sum, trade) => sum + paperNumber(trade.unrealPnl), 0);
}

function paperResearchEquity() {
  return paperNumber(paperState.researchStartingEquity || paperState.startingEquity || PAPER_STARTING_EQUITY) +
    paperResearchRealizedPnl() + paperResearchUnrealizedPnl();
}

function paperResearchEquityPeak() {
  return Math.max(
    paperNumber(paperState.researchEquityPeak),
    paperNumber(paperState.researchStartingEquity || paperState.startingEquity || PAPER_STARTING_EQUITY)
  );
}

function paperUpdateResearchEquityPeak() {
  const current = paperResearchEquity();
  const peak = paperResearchEquityPeak();
  if (current > peak) {
    paperState.researchEquityPeak = Number(current.toFixed(2));
    return true;
  }
  if (paperState.researchEquityPeak !== peak) paperState.researchEquityPeak = Number(peak.toFixed(2));
  return false;
}

function paperResearchDrawdownPct() {
  const peak = paperResearchEquityPeak();
  const current = paperResearchEquity();
  return peak > 0 ? Math.max(0, (peak - current) / peak * 100) : 0;
}

function paperResearchDailyLossR() {
  const today = new Date().toISOString().slice(0, 10);
  return paperState.closedTrades
    .filter(trade => paperIsResearchTrade(trade) && String(trade.closedAt || '').slice(0, 10) === today)
    .reduce((sum, trade) => sum + paperNumber(trade.r), 0);
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

function paperResearchActiveRiskDollar() {
  return paperState.activeTrades
    .filter(trade => paperIsActive(trade) && paperIsResearchTrade(trade))
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
  paperEnsureAnalysis(trade);
  const entryForRr = paperNumber(trade.entryActual || trade.entryLimit);
  const stopForRr = paperNumber(trade.sl);
  const tp1ForRr = paperNumber(trade.tp1);
  const recordedRr = trade.setupValidation && Number(trade.setupValidation.rr);
  const rr = Number.isFinite(recordedRr) && recordedRr > 0
    ? Number(recordedRr.toFixed(2))
    : entryForRr > 0 && Math.abs(entryForRr - stopForRr) > 0
      ? Number((Math.abs(entryForRr - tp1ForRr) / Math.abs(entryForRr - stopForRr)).toFixed(2)) : null;
  const tp1ClosePct = trade.tp1ClosePct || PAPER_TP1_CLOSE_PCT;
  return {
    id: trade.id, sym: trade.sym, dir: trade.dir, status: trade.status,
    entryLimit: trade.entryLimit, entryActual: trade.entryActual || null,
    currentPrice: trade.currentPrice, sl: trade.sl, tp1: trade.tp1, tp2: trade.tp2,
    size: paperTradeOriginalSize(trade), remainingSize: paperTradeRemainingSize(trade),
    contracts: paperTradeOriginalContracts(trade),
    remainingContracts: paperTradeRemainingContracts(trade),
    score: trade.score, tier: trade.tier,
    chg: trade.chg == null ? null : trade.chg,
    fund: trade.fund, fundingAvailable: trade.fundingAvailable == null ? null : !!trade.fundingAvailable,
    oi: trade.oi, oiAvailable: trade.oiAvailable == null ? null : !!trade.oiAvailable,
    volumeAvailable: trade.volumeAvailable == null ? null : !!trade.volumeAvailable,
    volume: trade.volume || 0,
    volumeRatio: trade.volumeRatio == null ? null : trade.volumeRatio, mtf: trade.mtf || null,
    createdAt: trade.createdAt,
    openedAt: trade.openedAt || null, cycleKey: trade.cycleKey,
    unrealPnl: Number((trade.unrealPnl || 0).toFixed(2)),
    mfePnl: Number((trade.mfePnl || 0).toFixed(2)),
    maePnl: Number((trade.maePnl || 0).toFixed(2)),
    riskPct: trade.riskPct || null,
    riskDollar: Number(paperTradeRiskDollar(trade).toFixed(2)),
    riskDollarAtEntry: Number(paperTradeInitialRiskDollar(trade).toFixed(2)),
    rr,
    tp1ClosePct,
    tp1RemainingPct: trade.tp1Hit ? Number(Math.max(0, 100 - tp1ClosePct).toFixed(1)) : 100,
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
    universeVersion: trade.universeVersion || 'LEGACY',
    researchCollection: paperIsResearchTrade(trade),
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
    analysisStatus: trade.analysisStatus || 'DATA_NOT_CAPTURED',
    analysisSnapshot: trade.analysisSnapshot || null,
    analysisExit: trade.analysisExit || null,
    analysisTags: trade.analysisTags || {exit: [], setup: [], market: []},
    analysisSummary: trade.analysisSummary || null,
    signalState: trade.signalState || null,
    preScore: trade.preScore == null ? null : trade.preScore,
    confirmationScore: trade.confirmationScore == null ? null : trade.confirmationScore,
    entryModel: trade.entryModel || null,
    exitModel: trade.exitModel || null,
    strategyEvidence: Array.isArray(trade.strategyEvidence) ? trade.strategyEvidence : [],
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
  const higherOpposed = direction !== 'NEUTRAL' && higher.some(item =>
    item.direction !== 'NEUTRAL' && item.direction !== direction);
  const higherAnchorAligned = direction !== 'NEUTRAL' && higher.some(item =>
    item.direction === direction);
  const confirmAligned = direction !== 'NEUTRAL' && mtf.M30 &&
    mtf.M30.status === 'FULL' && mtf.M30.direction === direction;
  const confirmOpposed = direction !== 'NEUTRAL' && mtf.M30 &&
    mtf.M30.status === 'FULL' && mtf.M30.direction !== 'NEUTRAL' &&
    mtf.M30.direction !== direction;
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
    higherAligned, higherAnchorAligned, higherOpposed,
    confirmAligned, confirmOpposed, triggerAligned,
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

function paperMtfGate(pair, minConfluence) {
  const summary = pair && pair.mtfSummary ? pair.mtfSummary : {};
  const mtf = pair && pair.mtf && typeof pair.mtf === 'object' ? pair.mtf : {};
  const direction = pair && pair.mtfDirection && pair.mtfDirection !== 'NEUTRAL'
    ? pair.mtfDirection : null;
  const higherAnchorAligned = summary.higherAnchorAligned != null
    ? summary.higherAnchorAligned : summary.higherAligned;
  const higherOpposed = summary.higherOpposed === true ||
    (direction && ['H4', 'H1'].some(tf => {
      const item = mtf[tf];
      return item && item.status === 'FULL' && item.direction !== 'NEUTRAL' && item.direction !== direction;
    }));
  const confirmOpposed = summary.confirmOpposed === true ||
    (direction && mtf.M30 && mtf.M30.status === 'FULL' &&
      mtf.M30.direction !== 'NEUTRAL' && mtf.M30.direction !== direction);
  const triggerAligned = summary.triggerAligned === true ||
    (direction && mtf.M15 && mtf.M15.status === 'FULL' && mtf.M15.direction === direction);
  const codes = [];
  const reasons = [];
  if (higherOpposed) {
    codes.push('HIGHER_TF_CONFLICT');
    reasons.push('H4/H1 tidak boleh berlawanan dengan arah ' + (direction || 'setup'));
  } else if (!higherAnchorAligned) {
    codes.push('HIGHER_TF_CONFLICT');
    reasons.push('minimal satu anchor H4/H1 harus searah');
  }
  if (confirmOpposed) {
    codes.push('M30_CONFIRM_CONFLICT');
    reasons.push('30M berlawanan; 30M netral masih diperbolehkan');
  }
  if (!triggerAligned) {
    codes.push('M15_TRIGGER_CONFLICT');
    reasons.push('trigger 15M belum searah');
  }
  if ((pair.mtfAlignment || 0) < PAPER_MTF_MIN_ALIGNMENT ||
      (pair.confluencePct || 0) < Number(minConfluence || PAPER_MIN_CONFLUENCE)) {
    codes.push('CONFLUENCE_LOW');
    reasons.push('konfluensi ' + (pair.confluencePct || 0) + '% atau alignment ' +
      (pair.mtfAlignment || 0) + '/4 belum memenuhi syarat');
  }
  return {ok: codes.length === 0, codes, reasons};
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
  paperEnsureAnalysis(trade);
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
  const instruments = await fetchPaperInstruments();
  const activeSymbols = [...instruments.entries()]
    .filter(([, info]) => info && info.active === true)
    .map(([symbol]) => symbol);
  if (!activeSymbols.length) throw new Error('Bitget active USDT perpetual metadata unavailable');
  const cryptoSymbols = confirmedCryptoSymbolSet(instruments);
  if (!cryptoSymbols || !cryptoSymbols.size) throw new Error('Bitget crypto classification unavailable; refusing non-verified assets');
  payload._nexoraFetchedAt = new Date().toISOString();
  payload._nexoraSource = 'Bitget Futures';
  payload._nexoraActiveSymbols = activeSymbols;
  payload._nexoraCryptoSymbols = [...cryptoSymbols];
  return payload;
}

const paperFallbackContractCache = {
  binance: {loadedAt: 0, symbols: new Set()},
  okx: {loadedAt: 0, instruments: new Map()}
};

async function fetchPaperCryptoSymbols() {
  const instruments = await fetchPaperInstruments();
  const symbols = confirmedCryptoSymbolSet(instruments);
  if (!symbols || !symbols.size) {
    throw new Error('Bitget crypto classification unavailable; refusing fallback assets without positive crypto metadata');
  }
  return symbols;
}

async function fetchPaperBinanceActiveSymbols() {
  const cacheItem = paperFallbackContractCache.binance;
  if (cacheItem.symbols.size && Date.now() - cacheItem.loadedAt < 30 * 60 * 1000) {
    return new Set(cacheItem.symbols);
  }
  const pathName = '/fapi/v1/exchangeInfo';
  const startedAt = Date.now();
  const result = await requestUpstream(APIS['/binance'] + pathName);
  markSourceHealth('/binance', {...result, latencyMs: Date.now() - startedAt, path: pathName});
  if (result.status < 200 || result.status >= 300) throw new Error('Binance exchangeInfo HTTP ' + result.status);
  const payload = JSON.parse(result.body);
  if (!payload || !Array.isArray(payload.symbols)) throw new Error('Binance exchangeInfo response invalid');
  const symbols = new Set(payload.symbols.filter(item => item &&
    String(item.quoteAsset || '').toUpperCase() === 'USDT' &&
    String(item.contractType || '').toUpperCase() === 'PERPETUAL' &&
    String(item.status || '').toUpperCase() === 'TRADING'
  ).map(item => normalizeBaseSymbol(item.symbol)).filter(isEligibleBaseSymbol));
  if (!symbols.size) throw new Error('Binance has no active USDT perpetual metadata');
  cacheItem.symbols = symbols;
  cacheItem.loadedAt = Date.now();
  return new Set(symbols);
}

async function fetchPaperOkxActiveInstruments() {
  const cacheItem = paperFallbackContractCache.okx;
  if (cacheItem.instruments.size && Date.now() - cacheItem.loadedAt < 30 * 60 * 1000) {
    return new Map(cacheItem.instruments);
  }
  const pathName = '/api/v5/public/instruments?instType=SWAP';
  const startedAt = Date.now();
  const result = await requestUpstream(APIS['/okx'] + pathName);
  markSourceHealth('/okx', {...result, latencyMs: Date.now() - startedAt, path: pathName});
  if (result.status < 200 || result.status >= 300) throw new Error('OKX instruments HTTP ' + result.status);
  const payload = JSON.parse(result.body);
  if (!payload || payload.code !== '0' || !Array.isArray(payload.data)) {
    throw new Error((payload && payload.msg) || 'OKX instruments response invalid');
  }
  const instruments = new Map();
  payload.data.forEach(item => {
    const id = String(item && item.instId || '').toUpperCase();
    const base = normalizeBaseSymbol(id);
    if (!item || !isEligibleBaseSymbol(base) || !/^[A-Z0-9]{2,15}-USDT-SWAP$/.test(id) ||
        String(item.state || '').toLowerCase() !== 'live' ||
        String(item.settleCcy || '').toUpperCase() !== 'USDT') return;
    instruments.set(id, {
      base,
      baseCcy: String(item.baseCcy || base).toUpperCase(),
      settleCcy: String(item.settleCcy || '').toUpperCase(),
      ctVal: paperNumber(item.ctVal),
      ctValCcy: String(item.ctValCcy || '').toUpperCase()
    });
  });
  if (!instruments.size) throw new Error('OKX has no active USDT-settled linear perpetual metadata');
  cacheItem.instruments = instruments;
  cacheItem.loadedAt = Date.now();
  return new Map(instruments);
}

function okxQuoteVolumeUsdt(row, instrument, price) {
  const contractVolume = paperNumber(row && row.vol24h);
  const contractValue = paperNumber(instrument && instrument.ctVal);
  const valueCurrency = String(instrument && instrument.ctValCcy || '').toUpperCase();
  if (!(contractVolume > 0) || !(contractValue > 0)) return null;
  const tradedValue = contractVolume * contractValue;
  if (valueCurrency === 'USDT') return tradedValue;
  if (valueCurrency === String(instrument.baseCcy || '').toUpperCase()) return tradedValue * price;
  return null;
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
  const activeSymbols = await fetchPaperBinanceActiveSymbols();
  const cryptoSymbols = await fetchPaperCryptoSymbols();
  const data = rows.filter(row => activeSymbols.has(normalizeBaseSymbol(row.symbol)))
    .map(row => ({
      symbol: String(row.symbol).toUpperCase(), lastPr: row.lastPrice,
      priceChangePercent: row.priceChangePercent, quoteVolume: row.quoteVolume,
      high24h: row.highPrice, low24h: row.lowPrice, ts: row.closeTime,
      quoteCoin: 'USDT', contractType: 'PERPETUAL'
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
  if (!data.length) throw new Error('Binance tickers returned no active USDT perpetual symbols');
  return {
    code: '00000', msg: 'success', data,
    _nexoraFetchedAt: new Date().toISOString(),
    _nexoraSource: 'Binance Futures fallback',
    _nexoraActiveSymbols: [...activeSymbols],
    _nexoraCryptoSymbols: [...cryptoSymbols]
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
  const instruments = await fetchPaperOkxActiveInstruments();
  const cryptoSymbols = await fetchPaperCryptoSymbols();
  const data = payload.data.filter(row => instruments.has(String(row.instId || '').toUpperCase()))
    .map(row => {
      const last = Number(row.last), open = Number(row.open24h);
      const instrument = instruments.get(String(row.instId || '').toUpperCase());
      return {
        symbol: String(row.instId).toUpperCase(),
        lastPr: row.last,
        priceChangePercent: open > 0 ? ((last - open) / open * 100) : 0,
        quoteVolume: okxQuoteVolumeUsdt(row, instrument, last),
        high24h: row.high24h, low24h: row.low24h, ts: row.ts,
        quoteCoin: 'USDT', contractType: 'PERPETUAL'
      };
    });
  if (!data.length) throw new Error('OKX tickers returned no active USDT perpetual symbols');
  return {
    code: '00000', msg: 'success', data,
    _nexoraFetchedAt: new Date().toISOString(),
    _nexoraSource: 'OKX Swap fallback',
    _nexoraActiveSymbols: [...new Set([...instruments.values()].map(item => item.base))],
    _nexoraCryptoSymbols: [...cryptoSymbols]
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
  if (paperInstrumentCache.items.size && Date.now() - paperInstrumentCache.loadedAt < 15 * 60 * 1000) {
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
      quoteCoin: String(item.quoteCoin || '').toUpperCase(),
      symbolType: String(item.symbolType || '').toLowerCase(),
      symbolStatus: String(item.symbolStatus || '').toLowerCase(),
      isRwa: String(item.isRwa || '').trim().toUpperCase(),
      active: String(item.quoteCoin || '').toUpperCase() === 'USDT' &&
        String(item.symbolType || '').toLowerCase() === 'perpetual' &&
        String(item.symbolStatus || '').toLowerCase() === 'normal',
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
  paperUpdateResearchEquityPeak();
  const drawdownGuard = paperDrawdownPct() >= PAPER_MAX_DRAWDOWN_PCT;
  const researchDrawdownPct = paperResearchDrawdownPct();
  const researchHardStop = researchDrawdownPct >= PAPER_RESEARCH_HARD_DD_PCT;
  if (!paperState.enabled || paperState.paused || paperState.killSwitch || !cfg.strategyEnabled ||
      !paperWithinTradingHours(cfg) || paperBusy) return;
  if (paperRuntime.nextScanRetryAt && Date.now() < Date.parse(paperRuntime.nextScanRetryAt)) return;
  const cycleKey = requestedCycleKey || paperCycleKey(Date.now());
  if (paperState.lastCycleKey === cycleKey) return;
  const scanStartedMs = Date.now();
  const rateLimitCountAtStart = paperRuntime.rateLimitResponses;
  let universeTelemetry = null;
  paperBusy = true;
  paperRuntime.scanAttempts += 1;
  paperRuntime.lastScanStartedAt = new Date().toISOString();
  try {
    const priorityRequested = Array.isArray(paperState.watchlistQueue) ? paperState.watchlistQueue.slice() : [];
    const prioritySet = new Set(priorityRequested.map(item => item.sym));
    const payload = await fetchPaperTickers();
    const universe = selectLiquidUniverse(payload && payload.data, {
      now: Date.now(),
      limit: PAPER_UNIVERSE_LIMIT,
      minQuoteVolumeUsdt: PAPER_MIN_24H_QUOTE_VOLUME_USDT,
      maxTickerAgeMs: PAPER_TICKER_MAX_AGE_MS,
      activeSymbols: payload && payload._nexoraActiveSymbols,
      cryptoSymbols: payload && payload._nexoraCryptoSymbols
    });
    universeTelemetry = {
      version: universe.version,
      assetScope: universe.assetScope,
      target: PAPER_UNIVERSE_LIMIT,
      minQuoteVolumeUsdt: PAPER_MIN_24H_QUOTE_VOLUME_USDT,
      maxTickerAgeMs: PAPER_TICKER_MAX_AGE_MS,
      rawTickerCount: universe.rawTickerCount,
      eligibleCount: universe.eligibleCount,
      selectedCount: universe.selectedCount,
      selectedSymbols: universe.selectedSymbols,
      concurrency: PAPER_MTF_CONCURRENCY,
      source: payload && payload._nexoraSource || 'UNKNOWN',
      fetchedAt: payload && payload._nexoraFetchedAt || null,
      activeMetadataCount: Array.isArray(payload && payload._nexoraActiveSymbols)
        ? payload._nexoraActiveSymbols.length : 0,
      cryptoMetadataCount: Array.isArray(payload && payload._nexoraCryptoSymbols)
        ? payload._nexoraCryptoSymbols.length : 0,
      rejectionCounts: universe.rejectionCounts,
      contextCandidates: 0,
      mtfCandidates: 0,
      mtfEvaluated: 0,
      mtfFull: 0,
      mtfStale: 0,
      mtfPartial: 0,
      mtfUnavailable: 0,
      filteredBeforeMtf: 0,
      entryGateEligibleCount: 0,
      entryGateRejectedCount: 0,
      entryGateRejectionCounts: {},
      entryGateRejectedSymbols: [],
      durationMs: 0,
      rateLimitResponses: 0,
      overrun: false
    };
    paperRuntime.lastUniverseScan = {...universeTelemetry};
    if (!universe.selectedCount) {
      throw new Error('No valid liquid crypto USDT perpetual tickers: ' +
        JSON.stringify(universe.rejectionCounts));
    }
    const instruments = await fetchPaperInstruments().catch(error => {
      console.error('[paper] contract precision unavailable:', error.message);
      return new Map();
    });
    const selectedPayload = {
      ...payload,
      data: universe.selectedRows,
      _nexoraUniverseVersion: universe.version
    };
    let ranked = applyPaperInstrumentMetadata(buildPaperPairs(selectedPayload), instruments);
    universeTelemetry.contextCandidates = ranked.length;
    universeTelemetry.filteredBeforeMtf = Math.max(0, universe.selectedCount - ranked.length);
    ranked.forEach(pair => { pair.watchlistPriority = prioritySet.has(pair.sym); });
    ranked.sort((a, b) => Number(b.watchlistPriority) - Number(a.watchlistPriority) || b.rank - a.rank);
    // Evaluate every selected, validated universe member up to the configured
    // 60-symbol cap. Shared strategy-entry gates are applied only after MTF so
    // the scan reports its real coverage without weakening order eligibility.
    const mtfCandidates = ranked.slice(0, PAPER_MTF_MAX_CANDIDATES);
    universeTelemetry.mtfCandidates = mtfCandidates.length;
    universeTelemetry.mtfEvaluated = mtfCandidates.length;
    await enrichPaperMtfBatch(mtfCandidates);
    mtfCandidates.forEach(pair => {
      if (pair.mtfStatus === 'FULL') universeTelemetry.mtfFull += 1;
      else if (pair.mtfStatus === 'STALE') universeTelemetry.mtfStale += 1;
      else if (pair.mtfStatus === 'PARTIAL') universeTelemetry.mtfPartial += 1;
      else universeTelemetry.mtfUnavailable += 1;
    });
    // Pre-breakout research must see the complete validated 60-coin MTF
    // universe. The shared entry gate is reserved for the existing order
    // strategies because a pre-breakout candidate is often valuable before
    // it becomes a conventional trend entry.
    try {
      paperLabScan(mtfCandidates, cycleKey, reason || '15M close', {
        strategyIds: ['PREBREAKOUT_RESEARCH_V1'], updateLabCycle: false
      });
    } catch (labError) {
      paperState.strategyLab.lastError = labError.message;
      console.error('[paper] pre-breakout lab scan failed:', labError.message);
    }
    const entryGate = partitionSharedEntryGate(mtfCandidates);
    universeTelemetry.entryGateEligibleCount = entryGate.passed.length;
    universeTelemetry.entryGateRejectedCount = entryGate.rejected.length;
    universeTelemetry.entryGateRejectionCounts = entryGate.rejectionCounts;
    universeTelemetry.entryGateRejectedSymbols = entryGate.rejected.map(item => ({
      sym: item.candidate.sym,
      codes: item.codes
    }));
    paperRuntime.lastUniverseScan = {...universeTelemetry};
    ranked = entryGate.passed.sort((a, b) => Number(b.watchlistPriority) - Number(a.watchlistPriority) || b.rank - a.rank);
    // Strategy Lab evaluates the same enriched live-market snapshot.  Its
    // ledgers are independent from strict/research and failures are isolated
    // so a single experimental rule cannot stop the main paper bot.
    try {
      paperLabScan(ranked, cycleKey, reason || '15M close', {
        strategyIds: Object.keys(PAPER_LAB_STRATEGIES)
          .filter(strategyId => strategyId !== 'PREBREAKOUT_RESEARCH_V1')
      });
    } catch (labError) {
      paperState.strategyLab.lastError = labError.message;
      console.error('[paper] strategy lab scan failed:', labError.message);
    }
    const activeSymbols = new Map();
    paperState.activeTrades
      .filter(t => paperIsActive(t))
      .forEach(t => activeSymbols.set(t.sym, (activeSymbols.get(t.sym) || 0) + 1));
    const equity = paperEquity();
    const activeRisk = paperActiveRiskDollar();
    const riskBudget = equity * PAPER_MAX_ACTIVE_RISK_PCT / 100;
    const perTradeRisk = equity * cfg.riskPct / 100;
    const dailyLossR = paperDailyLossR();
    const dailyGuard = dailyLossR <= -cfg.maxDailyLossR;
    const researchMode = paperResearchEnabled() && drawdownGuard && !dailyGuard && !researchHardStop;
    const researchEquity = paperResearchEquity();
    const researchActiveRisk = paperResearchActiveRiskDollar();
    const researchRiskBudget = researchEquity * PAPER_MAX_ACTIVE_RISK_PCT / 100;
    const researchPerTradeRisk = researchEquity * PAPER_RESEARCH_RISK_PCT / 100;
    const researchRiskSlots = researchPerTradeRisk > 0
      ? Math.floor(Math.max(0, researchRiskBudget - researchActiveRisk) / researchPerTradeRisk)
      : 0;
    const researchCapacity = Math.min(
      dailyGuard || researchHardStop ? 0 : Math.max(0, PAPER_RESEARCH_MAX_ACTIVE - paperResearchActiveCount()),
      researchRiskSlots);
    const riskSlots = perTradeRisk > 0
      ? Math.floor(Math.max(0, riskBudget - activeRisk) / perTradeRisk)
      : 0;
    const capacity = Math.min(
      dailyGuard ? 0 : Math.max(0, cfg.maxActive - paperActiveCount()), riskSlots);
    // Strict Trial pauses at 2.5% DD. Research Collection can continue from
    // its own equity ledger until the explicit 50% emergency stop, while all
    // MTF, RR, data-quality, symbol, direction and capacity checks remain.
    const monitoringGuard = dailyGuard || (drawdownGuard && !researchMode) || researchHardStop;
    const directionRisk = {LONG: 0, SHORT: 0};
    const directionCount = {LONG: 0, SHORT: 0};
    paperState.activeTrades
      .filter(t => paperIsActive(t) && (researchMode ? paperIsResearchTrade(t) : paperIsTrialTrade(t)) && directionRisk[t.dir] != null)
      .forEach(t => {
        directionRisk[t.dir] += paperTradeRiskDollar(t);
        directionCount[t.dir] += 1;
      });
    const correlatedActiveCount = paperState.activeTrades
      .filter(t => paperIsActive(t) && (researchMode ? paperIsResearchTrade(t) : paperIsTrialTrade(t))).length;
    const selected = [];
    const researchSelected = [];
    const monitoringEligible = [];
    const rejected = [];
    const targetCount = researchMode ? Math.min(PAPER_RESEARCH_PER_SCAN, researchCapacity)
      : monitoringGuard ? cfg.perScan : Math.min(cfg.perScan, capacity);
    for (const pair of ranked) {
      const acceptedCount = monitoringGuard ? monitoringEligible.length
        : researchMode ? researchSelected.length : selected.length;
      if (acceptedCount >= targetCount) break;
      if (!paperSymbolAllowed(pair.sym, cfg)) {
        paperReject(rejected, pair, ['SYMBOL_FILTERED'], ['symbol whitelist/blacklist filter']);
        continue;
      }
      if (!monitoringGuard && (activeSymbols.get(pair.sym) || 0) >= cfg.maxPerSymbol) continue;
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
      const mtfGate = paperMtfGate(pair, cfg.minConfluence);
      if (!mtfGate.ok) {
        paperReject(rejected, pair, mtfGate.codes, mtfGate.reasons);
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
      const setup = paperSetup(pair, researchMode
        ? {equity: researchEquity, riskPct: PAPER_RESEARCH_RISK_PCT} : undefined);
      const setupValidation = validatePaperSetup(pair, setup);
      if (!setupValidation.ok) {
        paperReject(rejected, pair, setupValidation.reasonCodes, setupValidation.reasons);
        continue;
      }
      if (monitoringGuard) {
        monitoringEligible.push({pair, setup, setupValidation});
        continue;
      }
      const placementEquity = researchMode ? researchEquity : equity;
      const directionBudget = placementEquity * PAPER_MAX_DIRECTION_RISK_PCT / 100;
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
      const profileSelectedCount = researchMode ? researchSelected.length : selected.length;
      if (correlatedActiveCount + profileSelectedCount >= PAPER_MAX_HIGH_CORR_POSITIONS) {
        paperReject(rejected, pair, ['CORRELATED_EXPOSURE_FULL'], [
          'exposure crypto berkorelasi tinggi sudah mencapai ' + PAPER_MAX_HIGH_CORR_POSITIONS
        ]);
        continue;
      }
      (researchMode ? researchSelected : selected).push({pair, setup, setupValidation});
      activeSymbols.set(pair.sym, (activeSymbols.get(pair.sym) || 0) + 1);
      directionRisk[setup.dir] += setupValidation.expectedLoss;
      directionCount[setup.dir] += 1;
    }
    const monitoringSignals = monitoringEligible.map(item => {
      const candidate = paperCandidateView(item.pair);
      return {
        ...candidate,
        status: 'MONITORING_ONLY',
        dir: item.setup.dir,
        entryLimit: item.setup.entry,
        sl: item.setup.sl,
        tp1: item.setup.tp1,
        tp2: item.setup.tp2,
        rr: item.setupValidation.rr,
        expectedLoss: item.setupValidation.expectedLoss,
        signalCreatedAt: new Date().toISOString(),
        cycleKey,
         guardReason: researchHardStop ? 'RESEARCH_HARD_DD_REACHED'
           : drawdownGuard ? 'MAX_DRAWDOWN_REACHED' : 'DAILY_DRAWDOWN_GUARD'
       };
     });
    const selectedForPlacement = researchMode ? researchSelected : selected;
    const placed = selectedForPlacement.map(item => {
      const pair = item.pair;
      const setup = item.setup;
      const profile = researchMode ? {
        mode: PAPER_RESEARCH_STRATEGY_VERSION,
        signalMode: PAPER_RESEARCH_STRATEGY_VERSION,
        strategyVersion: PAPER_RESEARCH_STRATEGY_VERSION,
        cohortId: paperState.researchCohortId
      } : {
        mode: PAPER_SIGNAL_MODE,
        signalMode: PAPER_SIGNAL_MODE,
        strategyVersion: PAPER_STRATEGY_VERSION,
        cohortId: paperState.cohortId
      };
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
        universeVersion: pair.universeVersion || UNIVERSE_VERSION,
        tickerAt: pair.tickerAt || null,
        score: pair.sc, tier: pair.tier, chg: pair.chg, fund: pair.fund, oi: pair.oi,
        fundingAvailable: !!pair.fundingAvailable, oiAvailable: !!pair.oiAvailable,
        volumeAvailable: !!pair.volumeAvailable, volume: pair.volume, volumeRatio: pair.volumeRatio, mtf: pair.mtf,
         timeframe: '15M', tf: '15M', mode: profile.mode,
         signalMode: profile.signalMode, dataQuality: pair.dataQuality,
         strategyVersion: profile.strategyVersion, cohortId: profile.cohortId,
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
        reason: (researchMode ? 'Research VPS: 15M scan | ' : 'Auto VPS: 15M scan | ') + candidate.evidence.join('; ')
       };
      // Persist the entry snapshot immediately.  If the process restarts
      // before the order is filled/closed, the research record still keeps
      // the exact market context used to approve the setup.
      paperEnsureAnalysis(trade);
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
    paperRuntime.nextScanRetryAt = null;
    paperRuntime.scansSucceeded += 1;
    paperRuntime.lastScanCompletedAt = paperState.lastScanAt;
    paperRuntime.lastScanError = null;
    const strictActiveCount = paperActiveCount();
    const researchActiveCount = paperResearchActiveCount();
    const hasMtfEligible = ranked.some(pair => pair.mtfStatus === 'FULL' &&
      pair.mtfDirection !== 'NEUTRAL' && paperMtfGate(pair, cfg.minConfluence).ok &&
      pair.signalScores && pair.signalScores.total >= cfg.minSignalScore &&
      pair.dataQuality === 'FULL');
    const profileCapacity = researchMode ? researchCapacity : capacity;
    const profileActiveCount = researchMode ? researchActiveCount : strictActiveCount;
    const profileMaxActive = researchMode ? PAPER_RESEARCH_MAX_ACTIVE : cfg.maxActive;
    const profileActiveRisk = researchMode ? researchActiveRisk : activeRisk;
    const profileRiskBudget = researchMode ? researchRiskBudget : riskBudget;
    const profilePerScan = researchMode ? PAPER_RESEARCH_PER_SCAN : cfg.perScan;
    const blockReason = researchHardStop ? 'RESEARCH_HARD_DD_REACHED'
      : drawdownGuard ? 'MAX_DRAWDOWN_REACHED' : dailyGuard ? 'DAILY_DRAWDOWN_GUARD' : !profileCapacity
      ? (profileActiveCount >= profileMaxActive ? 'MAX_ACTIVE_REACHED'
        : profileActiveRisk >= profileRiskBudget ? 'RISK_BUDGET_REACHED' : 'NO_CAPACITY')
      : (!placed.length ? (hasMtfEligible ? 'NO_VALID_UNALLOCATED_SETUP' : 'NO_VALID_MTF_SETUP') :
        placed.length < profilePerScan ? 'PARTIAL_CAPACITY' : null);
    paperState.lastBlockReason = blockReason;
    universeTelemetry.durationMs = Math.max(0, Date.now() - scanStartedMs);
    universeTelemetry.rateLimitResponses = Math.max(0,
      paperRuntime.rateLimitResponses - rateLimitCountAtStart);
    universeTelemetry.overrun = universeTelemetry.durationMs >= PAPER_INTERVAL_MS;
    paperRuntime.lastScanDurationMs = universeTelemetry.durationMs;
    if (universeTelemetry.overrun) {
      paperRuntime.lastScanOverruns += 1;
      console.error('[paper] scan exceeded 15M interval', universeTelemetry.durationMs + 'ms');
    }
    paperRuntime.lastUniverseScan = {...universeTelemetry};
    if (monitoringSignals.length) {
      paperState.monitoringSignals = monitoringSignals
        .concat(Array.isArray(paperState.monitoringSignals) ? paperState.monitoringSignals : [])
        .slice(0, PAPER_MAX_MONITORING_SIGNALS);
    }
    paperState.recentScans.unshift({
      cycleKey, at: paperState.lastScanAt, reason: reason || '15M close',
      universe: universeTelemetry,
      durationMs: universeTelemetry.durationMs,
      watchlistPriority: ranked.filter(pair => pair.watchlistPriority).map(pair => pair.sym),
      candidates: ranked.length,
      selected: researchMode ? placed : monitoringGuard ? monitoringSignals : ranked.slice(0, 10).map(paperCandidateView),
      placed,
      strictPlaced: researchMode ? [] : placed,
      researchPlaced: researchMode ? placed : [],
      monitoringOnly: monitoringSignals,
      rejected: rejected.slice(0, 20),
      capacity: {
        mode: researchMode ? PAPER_RESEARCH_STRATEGY_VERSION : PAPER_STRATEGY_VERSION,
        requested: profilePerScan, placed: placed.length,
        availableSlots: Math.max(0, cfg.maxActive - strictActiveCount),
        availableRisk: Number(Math.max(0, riskBudget - activeRisk).toFixed(2)),
        researchAvailableSlots: Math.max(0, PAPER_RESEARCH_MAX_ACTIVE - researchActiveCount),
        researchAvailableRisk: Number(Math.max(0, researchRiskBudget - researchActiveRisk).toFixed(2)),
        dailyLossR: Number(dailyLossR.toFixed(2)),
        researchDrawdownPct: Number(researchDrawdownPct.toFixed(2)),
        blockReason
      }
    });
    paperState.recentScans = paperState.recentScans.slice(0, PAPER_MAX_RECENT_SCANS);
    savePaperState();
    console.log('[paper] scan complete', cycleKey, 'mode', researchMode ? 'research' : 'strict',
      'placed', placed.length, monitoringGuard ? '(monitoring only: ' + monitoringSignals.length + ')' : '');
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
    paperRuntime.nextScanRetryAt = new Date(Date.now() + PAPER_SCAN_FAILURE_RETRY_MS).toISOString();
    if (universeTelemetry) {
      universeTelemetry.rateLimitResponses = Math.max(0,
        paperRuntime.rateLimitResponses - rateLimitCountAtStart);
      universeTelemetry.durationMs = Math.max(0, Date.now() - scanStartedMs);
      universeTelemetry.overrun = universeTelemetry.durationMs >= PAPER_INTERVAL_MS;
      universeTelemetry.error = error.message;
      paperRuntime.lastUniverseScan = {...universeTelemetry, status: 'FAILED'};
    }
    paperState.lastError = error.message;
    savePaperState();
    console.error('[paper] scan failed:', error.message);
    sendRateLimitedAlert(
      'paper-scan:' + error.message,
      'NEXORA PAPER SCAN ERROR\n' + error.message + '\nCycle retry tetap aktif.',
      15 * 60 * 1000
    );
  } finally {
    paperRuntime.lastScanDurationMs = Math.max(0, Date.now() - scanStartedMs);
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
  const labActive = Object.values((paperState.strategyLab && paperState.strategyLab.accounts) || {})
    .some(account => paperLabAccountActive(account).length > 0);
  if (!paperState.enabled || paperBusy || (!paperState.activeTrades.length && !labActive && !hasWatchlistAlerts)) return;
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
    const labSymbols = Object.values((paperState.strategyLab && paperState.strategyLab.accounts) || {})
      .flatMap(account => paperLabAccountActive(account).map(trade => trade.sym));
    const barsBySymbol = await fetchPaperMonitorBars([...paperState.activeTrades.map(trade => trade.sym), ...labSymbols]);
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
    const labChanged = monitorStrategyLabTrades(prices, barsBySymbol);
    changed = changed || labChanged;
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
  const sym = isEligibleBaseSymbol(rawSymbol) ? rawSymbol : 'BTC';
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
      timeframeReasons: paperTimeframeReasons(pair),
      eligible: false, rejectionCodes: []};
    if (active) { scan.rejectionCodes.push('ACTIVE_POSITION'); recordRejection('ACTIVE_POSITION'); scans.push(scan); continue; }
    const reject = code => { scan.rejectionCodes.push(code); recordRejection(code); };
    if (pair.mtfStatus !== 'FULL') reject(pair.mtfStatus === 'STALE' ? 'MTF_STALE' : 'MTF_PARTIAL');
    else if (pair.mtfDirection === 'NEUTRAL') reject('MTF_NEUTRAL');
    else {
      const mtfGate = paperMtfGate(pair, PAPER_MIN_CONFLUENCE);
      mtfGate.codes.forEach(reject);
    }
    if (!scan.rejectionCodes.length && (!pair.signalScores || pair.signalScores.total < PAPER_MIN_SIGNAL_SCORE)) reject('SIGNAL_SCORE_LOW');
    if (!scan.rejectionCodes.length && pair.dataQuality !== 'FULL') reject('DATA_REJECTED');
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

function paperStatus(options) {
  const includeDetails = !options || options.details !== false;
  const includeStats = !options || options.stats !== false;
  const includeLabHistory = !options || options.labHistory !== false;
  const cfg = paperSettings();
  const activeRaw = paperState.activeTrades.filter(paperIsActive);
  const active = includeDetails ? activeRaw.map(paperTradeView) : null;
  const open = activeRaw.filter(t => t.status === 'OPEN').length;
  const partial = activeRaw.filter(t => t.status === 'TP1_PARTIAL').length;
  const pending = activeRaw.filter(t => t.status === 'PENDING').length;
  const closed = paperState.closedTrades;
  const closedFilled = closed.filter(t => t.outcome !== 'CANCELLED');
  const cancelled = closed.filter(t => t.outcome === 'CANCELLED');
  const wins = closedFilled.filter(t => t.outcome === 'WIN').length;
  const losses = closedFilled.filter(t => t.outcome === 'LOSS').length;
  const netR = closedFilled.reduce((sum, t) => sum + paperNumber(t.r), 0);
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
  const researchActiveCount = paperResearchActiveCount();
  const researchEquity = paperResearchEquity();
  const researchRealizedPnl = paperResearchRealizedPnl();
  const researchUnrealizedPnl = paperResearchUnrealizedPnl();
  const researchActiveRisk = paperResearchActiveRiskDollar();
  const legacyActiveCount = paperLegacyActiveCount();
  const preUpgradeActiveCount = paperPreUpgradeActiveCount();
  const activeRisk = paperActiveRiskDollar();
  const legacyActiveRisk = paperState.activeTrades
    .filter(trade => paperIsActive(trade) && paperTradeStrategyVersion(trade) === 'LEGACY')
    .reduce((sum, trade) => sum + paperTradeRiskDollar(trade), 0);
  const preUpgradeActiveRisk = paperState.activeTrades
    .filter(trade => paperIsActive(trade) && paperIsPreUpgradeTrade(trade))
    .reduce((sum, trade) => sum + paperTradeRiskDollar(trade), 0);
  const startingEquity = paperNumber(paperState.startingEquity || PAPER_STARTING_EQUITY);
  const singleLedgerEquity = startingEquity + totalRealizedPnl + totalUnrealizedPnl;
  const legacyImpactRealized = totalRealizedPnl - realizedPnl - researchRealizedPnl;
  const legacyImpactUnrealized = totalUnrealizedPnl - unrealizedPnl - researchUnrealizedPnl;
  const cohortTotalEquity = equity + researchEquity + legacyImpactRealized + legacyImpactUnrealized;
  const analysisClosed = closedFilled;
  analysisClosed.forEach(paperEnsureAnalysis);
  const analysisCaptured = analysisClosed.filter(paperAnalysisCaptured).length;
  const analysisPartial = analysisClosed.filter(trade => !paperAnalysisCaptured(trade) && paperAnalysisHasPartialContext(trade)).length;
  const analysisGate = paperAnalysisGate(analysisCaptured);
  const trialDirectionCounts = paperState.activeTrades
    .filter(trade => paperIsActive(trade) && paperIsTrialTrade(trade))
    .reduce((counts, trade) => {
      if (counts[trade.dir] != null) counts[trade.dir] += 1;
      return counts;
    }, {LONG: 0, SHORT: 0});
  const riskBudget = equity * PAPER_MAX_ACTIVE_RISK_PCT / 100;
  const availableSlots = Math.max(0, cfg.maxActive - strictActiveCount);
  const availableRisk = Math.max(0, riskBudget - activeRisk);
  const riskHeadroomPct = riskBudget > 0 ? Math.max(0, availableRisk / riskBudget * 100) : 0;
  const activeExposureNotional = activeRaw
    .filter(trade => trade.status === 'OPEN' || trade.status === 'TP1_PARTIAL')
    .reduce((sum, trade) => sum + paperTradeRemainingSize(trade) *
      paperNumber(trade.currentPrice || trade.entryActual || trade.entryLimit), 0);
  const exposureRatio = equity > 0 ? activeExposureNotional / equity : 0;
  const riskWarning = {
    triggered: riskHeadroomPct <= 20 || exposureRatio >= 3,
    riskHeadroomPct: Number(riskHeadroomPct.toFixed(1)),
    exposureNotional: Number(activeExposureNotional.toFixed(2)),
    exposureRatio: Number(exposureRatio.toFixed(2)),
    reasons: [
      ...(riskHeadroomPct <= 20 ? ['RISK_HEADROOM_LOW'] : []),
      ...(exposureRatio >= 3 ? ['EXPOSURE_OVER_3X_EQUITY'] : [])
    ]
  };
  const stats = includeStats ? paperStats() : null;
  // Keep the compact cohort sample on /paper/summary even when the full
  // statistics payload is disabled.  Otherwise the header displays "--" as
  // soon as strict positions reach zero, despite historical trades existing.
  const trialStats = paperStats({
    strategyVersion: PAPER_STRATEGY_VERSION,
    cohortId: paperState.cohortId
  });
  const researchStats = paperStats({
    strategyVersion: PAPER_RESEARCH_STRATEGY_VERSION,
    cohortId: paperState.researchCohortId
  });
  const dailyLossR = paperDailyLossR();
  const researchDailyLossR = paperResearchDailyLossR();
  paperUpdateEquityPeak();
  paperUpdateResearchEquityPeak();
  const equityPeak = paperEquityPeak();
  const researchEquityPeak = paperResearchEquityPeak();
  const drawdownPct = paperDrawdownPct();
  const researchDrawdownPct = paperResearchDrawdownPct();
  const drawdownGuard = drawdownPct >= PAPER_MAX_DRAWDOWN_PCT;
  const researchDrawdownWarning = researchDrawdownPct >= PAPER_RESEARCH_WARNING_DD_PCT;
  const researchHardStop = researchDrawdownPct >= PAPER_RESEARCH_HARD_DD_PCT;
  const winRateAlerts = paperWinRateAlertView();
  const dailyGuard = dailyLossR <= -cfg.maxDailyLossR;
  const researchActive = paperResearchEnabled() && paperStarted && !paperState.paused &&
    !paperState.killSwitch && cfg.strategyEnabled && paperWithinTradingHours(cfg) &&
    drawdownGuard && !dailyGuard && !researchHardStop;
  const researchEntryState = !paperStarted || paperState.killSwitch ? 'OFFLINE'
    : researchHardStop ? 'HARD_STOP' : researchActive ? 'ACTIVE'
      : paperState.paused || dailyGuard ? 'PAUSED' : 'STANDBY';
  const persistedBlockReason = paperState.lastBlockReason;
  const blockReason = paperState.killSwitch ? 'KILL_SWITCH' : paperState.paused ? 'PAUSED' :
    !cfg.strategyEnabled ? 'STRATEGY_DISABLED' : !paperWithinTradingHours(cfg) ? 'OUTSIDE_TRADING_HOURS' :
    drawdownGuard ? 'MAX_DRAWDOWN_REACHED' : dailyGuard ? 'DAILY_DRAWDOWN_GUARD' :
    persistedBlockReason === 'MAX_DRAWDOWN_REACHED' ? null : persistedBlockReason ||
    (availableSlots <= 0 ? 'MAX_ACTIVE_REACHED' : availableRisk < equity * cfg.riskPct / 100
      ? 'RISK_BUDGET_REACHED' : null);
  const dailyPnlDate = new Date().toISOString().slice(0, 10);
  const dailyRealizedPnl = closed.filter(trade => paperIsTrialTrade(trade) &&
    trade.outcome !== 'CANCELLED' && String(trade.closedAt || '').slice(0, 10) === dailyPnlDate)
    .reduce((sum, trade) => sum + paperNumber(trade.pnl), 0);
  const entryPaused = paperState.paused || paperState.killSwitch || drawdownGuard || dailyGuard ||
    !cfg.strategyEnabled || !paperWithinTradingHours(cfg);
  const entryState = !paperStarted || paperState.killSwitch ? 'OFFLINE'
    : entryPaused ? 'ENTRY_PAUSED' : 'ENTRY_ACTIVE';
  const guardMessage = drawdownGuard
    ? (researchActive
      ? 'Strict Trial paused at DD ' + Number(drawdownPct.toFixed(2)) + '%; Research Collection is active with separate equity and 0.25% risk. Emergency stop: 50% DD.'
      : 'Current DD ' + Number(drawdownPct.toFixed(2)) + '% is above the ' + Number(PAPER_MAX_DRAWDOWN_PCT.toFixed(2)) + '% limit; new entries are paused while existing positions remain monitored.')
    : dailyGuard ? 'Daily loss guard is active; new entries are paused while existing positions remain monitored.'
    : entryState === 'ENTRY_ACTIVE' ? 'New paper entries are allowed.' : 'Paper service is not accepting new entries.';
  const lastScan = Array.isArray(paperState.recentScans) ? paperState.recentScans[0] : null;
  const lastUniverse = lastScan && lastScan.universe || paperRuntime.lastUniverseScan || null;
  const universeSummary = lastUniverse ? {
    status: lastUniverse.status || 'OK',
    version: lastUniverse.version || UNIVERSE_VERSION,
    assetScope: lastUniverse.assetScope || 'CRYPTO_ONLY_IS_RWA_NO',
    target: Number(lastUniverse.target || PAPER_UNIVERSE_LIMIT),
    rawTickerCount: Number(lastUniverse.rawTickerCount || 0),
    eligibleCount: Number(lastUniverse.eligibleCount || 0),
    selectedCount: Number(lastUniverse.selectedCount || 0),
    cryptoMetadataCount: Number(lastUniverse.cryptoMetadataCount || 0),
    concurrency: Number(lastUniverse.concurrency || PAPER_MTF_CONCURRENCY),
    contextCandidates: Number(lastUniverse.contextCandidates || 0),
    filteredBeforeMtf: Number(lastUniverse.filteredBeforeMtf || 0),
    mtfCandidates: Number(lastUniverse.mtfCandidates || 0),
    mtfEvaluated: Number(lastUniverse.mtfEvaluated || 0),
    mtfFull: Number(lastUniverse.mtfFull || 0),
    mtfStale: Number(lastUniverse.mtfStale || 0),
    mtfPartial: Number(lastUniverse.mtfPartial || 0),
    mtfUnavailable: Number(lastUniverse.mtfUnavailable || 0),
    entryGateEligibleCount: Number(lastUniverse.entryGateEligibleCount || 0),
    entryGateRejectedCount: Number(lastUniverse.entryGateRejectedCount || 0),
    entryGateRejectionCounts: lastUniverse.entryGateRejectionCounts || {},
    entryGateRejectedSymbols: Array.isArray(lastUniverse.entryGateRejectedSymbols)
      ? lastUniverse.entryGateRejectedSymbols.slice(0, PAPER_UNIVERSE_LIMIT) : [],
    source: lastUniverse.source || null,
    fetchedAt: lastUniverse.fetchedAt || null,
    durationMs: Number(lastUniverse.durationMs || 0),
    rateLimitResponses: Number(lastUniverse.rateLimitResponses || 0),
    overrun: !!lastUniverse.overrun,
    error: lastUniverse.error || null,
    rejectionCounts: lastUniverse.rejectionCounts || {}
  } : null;
  return {
    ok: true, service: 'nexora-paper-bot', buildId: PAPER_BUILD_ID, enabled: paperState.enabled,
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
    entryState,
    mode: researchActive ? PAPER_RESEARCH_STRATEGY_VERSION : entryState === 'ENTRY_ACTIVE' ? 'STRICT_TRIAL' : 'MONITORING_ONLY',
    monitoringOnly: (drawdownGuard && !researchActive) || dailyGuard || researchHardStop,
    guardMessage,
    resumeThresholdPct: PAPER_MAX_DRAWDOWN_PCT,
    research: {
      enabled: paperResearchEnabled(), mode: PAPER_RESEARCH_STRATEGY_VERSION,
      strategyVersion: PAPER_RESEARCH_STRATEGY_VERSION, cohortId: paperState.researchCohortId,
      entryState: researchEntryState, active: researchActive,
      perScan: PAPER_RESEARCH_PER_SCAN, riskPct: PAPER_RESEARCH_RISK_PCT,
      maxActive: PAPER_RESEARCH_MAX_ACTIVE, warningDrawdownPct: PAPER_RESEARCH_WARNING_DD_PCT,
      hardDrawdownPct: PAPER_RESEARCH_HARD_DD_PCT,
      startingEquity: Number(paperNumber(paperState.researchStartingEquity).toFixed(2)),
      equityPeak: Number(researchEquityPeak.toFixed(2)),
      drawdownPct: Number(researchDrawdownPct.toFixed(2)),
      drawdownWarning: researchDrawdownWarning, hardStop: researchHardStop,
      activeCount: researchActiveCount,
      availableSlots: Math.max(0, PAPER_RESEARCH_MAX_ACTIVE - researchActiveCount),
      realizedPnl: Number(researchRealizedPnl.toFixed(2)),
      unrealizedPnl: Number(researchUnrealizedPnl.toFixed(2)),
      equity: Number(researchEquity.toFixed(2)),
      activeRisk: Number(researchActiveRisk.toFixed(2)),
      riskBudget: Number((researchEquity * PAPER_MAX_ACTIVE_RISK_PCT / 100).toFixed(2)),
      dailyLossR: Number(researchDailyLossR.toFixed(2)),
      stats: researchStats ? researchStats.metrics : null,
      statsSample: researchStats ? researchStats.sample : null
    },
    strategyLab: paperStrategyLabSummary(includeDetails, {history: includeLabHistory}),
    monitoringSignalCount: Array.isArray(paperState.monitoringSignals) ? paperState.monitoringSignals.length : 0,
    lastScanSummary: lastScan ? {
      cycleKey: lastScan.cycleKey || null, at: lastScan.at || null,
      reason: lastScan.reason || null, candidates: Number(lastScan.candidates || 0),
      placed: Array.isArray(lastScan.placed) ? lastScan.placed.length : 0,
      mode: lastScan.capacity && lastScan.capacity.mode || PAPER_STRATEGY_VERSION,
      strictPlaced: Array.isArray(lastScan.strictPlaced) ? lastScan.strictPlaced.length : 0,
      researchPlaced: Array.isArray(lastScan.researchPlaced) ? lastScan.researchPlaced.length : 0,
      rejected: Array.isArray(lastScan.rejected) ? lastScan.rejected.length : 0,
      monitoringOnly: Array.isArray(lastScan.monitoringOnly) ? lastScan.monitoringOnly.length : 0,
      blockReason: lastScan.capacity && lastScan.capacity.blockReason || null,
      universe: universeSummary
    } : null,
    equityPeak: Number(equityPeak.toFixed(2)),
    drawdownPct: Number(drawdownPct.toFixed(2)),
    drawdownGuard,
    drawdown: {
      current_pct: Number(drawdownPct.toFixed(2)),
      limit_pct: Number(PAPER_MAX_DRAWDOWN_PCT.toFixed(2)),
      is_breached: drawdownGuard,
      trades_paused: drawdownGuard
    },
    maxDirectionRiskPct: PAPER_MAX_DIRECTION_RISK_PCT,
    maxPerDirection: PAPER_MAX_PER_DIRECTION,
    maxHighCorrelationPositions: PAPER_MAX_HIGH_CORR_POSITIONS,
    mtfCandidates: PAPER_MTF_MAX_CANDIDATES,
    settings: cfg,
    freshnessMaxAgeSec: Object.fromEntries(Object.entries(PAPER_TIMEFRAME_MAX_AGE_MS)
      .map(([tf, ms]) => [tf, Math.round(ms / 1000)])),
    strictActiveCount, trialActiveCount: strictActiveCount,
    researchActiveCount, researchAvailableSlots: Math.max(0, PAPER_RESEARCH_MAX_ACTIVE - researchActiveCount),
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
    totalEquity: Number(cohortTotalEquity.toFixed(2)),
    equityLedger: {
      definition: 'strict + research cohort ledgers + legacy/pre-upgrade PnL impact',
      strict: {
        starting: Number(startingEquity.toFixed(2)),
        realizedPnl: Number(realizedPnl.toFixed(2)),
        unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
        equity: Number(equity.toFixed(2))
      },
      research: {
        starting: Number(paperNumber(paperState.researchStartingEquity || startingEquity).toFixed(2)),
        realizedPnl: Number(researchRealizedPnl.toFixed(2)),
        unrealizedPnl: Number(researchUnrealizedPnl.toFixed(2)),
        equity: Number(researchEquity.toFixed(2))
      },
      legacyImpact: {
        realizedPnl: Number(legacyImpactRealized.toFixed(2)),
        unrealizedPnl: Number(legacyImpactUnrealized.toFixed(2))
      },
      combinedEquity: Number(cohortTotalEquity.toFixed(2)),
      singleLedgerEquity: Number(singleLedgerEquity.toFixed(2))
    },
    analysisCoverage: {
      closedFilled: analysisClosed.length, captured: analysisCaptured,
      partial: analysisPartial,
      notCaptured: Math.max(0, analysisClosed.length - analysisCaptured - analysisPartial),
      captureRate: analysisClosed.length ? Number((analysisCaptured / analysisClosed.length * 100).toFixed(1)) : 0,
      contextCoverageRate: analysisClosed.length ? Number(((analysisCaptured + analysisPartial) / analysisClosed.length * 100).toFixed(1)) : 0,
      ...analysisGate,
      aiEligible: analysisGate.p4Ready,
      p4GatePassed: analysisGate.p4GatePassed,
      p4AiEnabled: analysisGate.p4AiEnabled,
      p4Ready: analysisGate.p4Ready,
      p4Reason: analysisGate.p4Reason
    },
    riskPct: cfg.riskPct,
    maxActiveRiskPct: PAPER_MAX_ACTIVE_RISK_PCT,
    activeRisk: Number(activeRisk.toFixed(2)),
    legacyActiveRisk: Number(Math.max(0, legacyActiveRisk).toFixed(2)),
    preUpgradeActiveRisk: Number(Math.max(0, preUpgradeActiveRisk).toFixed(2)),
    riskBudget: Number(riskBudget.toFixed(2)),
    availableRisk: Number(availableRisk.toFixed(2)),
    riskHeadroomPct: Number(riskHeadroomPct.toFixed(1)),
    activeExposureNotional: Number(activeExposureNotional.toFixed(2)),
    exposureRatio: Number(exposureRatio.toFixed(2)),
    riskWarning,
    winRateAlerts,
    dailyLossR: Number(dailyLossR.toFixed(2)),
    researchDailyLossR: Number(researchDailyLossR.toFixed(2)),
    dailyPnlDate,
    dailyRealizedPnl: Number(dailyRealizedPnl.toFixed(2)),
    dailySummary: paperDailySummaryView(dailyPnlDate),
    dailyGuard,
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
    lastError: paperState.lastError,
    ...(includeDetails ? {
      activeTrades: active,
      watchlistQueue: (paperState.watchlistQueue || []).slice(),
      watchlistAlerts: (paperState.watchlistAlerts || []).slice(),
      recentScans: paperState.recentScans.slice(0, 20),
      monitoringSignals: (paperState.monitoringSignals || []).slice(0, PAPER_MAX_MONITORING_SIGNALS),
      closedTrades: closed.slice(0, 100),
      invalidatedTrades: paperState.invalidatedTrades.slice(0, 100)
    } : {}),
    ...(includeStats ? {
      stats: stats.metrics,
      statsSample: stats.sample,
      trialStats: trialStats.metrics,
      trialStatsSample: trialStats.sample,
      researchStats: researchStats.metrics,
      researchStatsSample: researchStats.sample
    } : {
      trialStats: trialStats.metrics,
      trialStatsSample: trialStats.sample,
      researchStats: researchStats.metrics,
      researchStatsSample: researchStats.sample
    }),
    runtime: {
      startedAt: paperRuntime.startedAt,
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
      open, partial, pending, orders: closed.length,
      closed: closedFilled.length, closedFilled: closedFilled.length,
      pendingExpired: cancelled.filter(t => String(t.closeReason || '').toLowerCase().includes('expired')).length,
      cancelled: cancelled.length, wins, losses,
      invalidated: paperState.invalidatedTrades.length,
      netR: Number(netR.toFixed(2)),
      equity: Number(equity.toFixed(2))
    }
  };
}

function paperDiagnostics() {
  const cfg = paperSettings();
  const status = paperStatus({details: false, stats: false, labHistory: false});
  return {
    ok: true,
    service: 'nexora-paper-bot', buildId: PAPER_BUILD_ID,
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
      universe: {
        version: UNIVERSE_VERSION, assetScope: 'CRYPTO_ONLY_IS_RWA_NO',
        classificationSource: 'Bitget contract isRwa=NO; fail closed on unknown',
        target: PAPER_UNIVERSE_LIMIT,
        minQuoteVolumeUsdt: PAPER_MIN_24H_QUOTE_VOLUME_USDT,
        maxTickerAgeMs: PAPER_TICKER_MAX_AGE_MS,
        mtfCandidates: PAPER_MTF_MAX_CANDIDATES,
        mtfConcurrency: PAPER_MTF_CONCURRENCY,
        scanIntervalMs: PAPER_INTERVAL_MS
      },
      research: {
        enabled: paperResearchEnabled(), perScan: PAPER_RESEARCH_PER_SCAN,
        riskPct: PAPER_RESEARCH_RISK_PCT, maxActive: PAPER_RESEARCH_MAX_ACTIVE,
        warningDrawdownPct: PAPER_RESEARCH_WARNING_DD_PCT,
        hardDrawdownPct: PAPER_RESEARCH_HARD_DD_PCT
      },
      monitorGranularity: '1m'
    },
    runtime: {
      ...paperRuntime,
      lastUniverseScan: paperRuntime.lastUniverseScan ? {...paperRuntime.lastUniverseScan} : null,
      rejectionCounts: {...paperRuntime.rejectionCounts}
    },
    lastScanSummary: status.lastScanSummary,
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
      drawdownGuard: status.drawdownGuard, maxDrawdownPct: status.maxDrawdownPct,
      mode: status.mode, research: status.research
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
  paperEnsureAnalysis(trade);
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
    fundingSign: String(get('fundingSign') || get('funding') || '').trim().toUpperCase(),
    volumeBucket: String(get('volumeBucket') || get('volume') || '').trim().toUpperCase(),
    marketTag: String(get('marketTag') || get('regime') || '').trim().toUpperCase(),
    strategyVersion: String(get('strategyVersion') || get('strategy') || '').trim(),
    universeVersion: String(get('universeVersion') || get('universe') || '').trim(),
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
  if (filters.fundingSign) {
    const funding = paperNumber(trade.fund);
    const actual = funding < 0 ? 'NEGATIVE' : funding > 0 ? 'POSITIVE' : 'ZERO_OR_UNKNOWN';
    if (actual !== filters.fundingSign) return false;
  }
  if (filters.volumeBucket) {
    const ratio = paperNumber(trade.volumeRatio);
    const actual = ratio >= 2 ? 'GE2X' : ratio >= 1.5 ? '1_5_1_99X' : ratio >= 1 ? '1_1_49X' : ratio > 0 ? 'LT1X' : 'UNKNOWN';
    if (actual !== filters.volumeBucket) return false;
  }
  if (filters.marketTag) {
    paperEnsureAnalysis(trade);
    if (!trade.analysisTags || !Array.isArray(trade.analysisTags.market) ||
        !trade.analysisTags.market.includes(filters.marketTag)) return false;
  }
  if (filters.strategyVersion && String(trade.strategyVersion || paperTradeStrategyVersion(trade)) !== filters.strategyVersion) return false;
  if (filters.universeVersion && String(trade.universeVersion || 'LEGACY') !== filters.universeVersion) return false;
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

function paperAnalysisValue(trade, field, fallback) {
  const snapshot = trade && trade.analysisSnapshot && typeof trade.analysisSnapshot === 'object'
    ? trade.analysisSnapshot : {};
  const market = snapshot.market && typeof snapshot.market === 'object' ? snapshot.market : {};
  const indicators = snapshot.indicators && typeof snapshot.indicators === 'object' ? snapshot.indicators : {};
  const setup = snapshot.setup && typeof snapshot.setup === 'object' ? snapshot.setup : {};
  const direct = trade && trade[field];
  if (direct != null && direct !== '') return direct;
  if (field === 'rsi') return indicators.rsi != null ? indicators.rsi : fallback;
  if (field === 'atrPct') return trade && trade.atrPct != null ? trade.atrPct : (indicators.atrPct != null ? indicators.atrPct : fallback);
  if (field === 'mtfAlignment') return setup.mtfAlignment != null ? setup.mtfAlignment : fallback;
  if (field === 'confluencePct') return setup.confluencePct != null ? setup.confluencePct : fallback;
  if (field === 'volumeRatio') return market.volumeRatio != null ? market.volumeRatio : fallback;
  if (field === 'fund') return market.funding != null ? market.funding : fallback;
  if (field === 'oi') return market.oiDeltaPct != null ? market.oiDeltaPct : fallback;
  if (field === 'regime') return market.regime || fallback;
  return fallback;
}

function paperAnalysisBucket(value, buckets) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'UNKNOWN';
  for (const bucket of buckets) {
    if (bucket.test(number)) return bucket.label;
  }
  return 'UNKNOWN';
}

function paperFactorStats(trades, keyFn, minimumSample) {
  const groups = {};
  const minSample = Number.isFinite(Number(minimumSample)) ? Number(minimumSample) : 5;
  trades.forEach(trade => {
    const raw = keyFn(trade);
    const keys = Array.isArray(raw) ? raw : [raw];
    [...new Set(keys.map(value => String(value == null || value === '' ? 'UNKNOWN' : value)))].forEach(key => {
      if (!groups[key]) {
        groups[key] = {
          key, trades: 0, wins: 0, losses: 0, breakeven: 0,
          netR: 0, pnl: 0, mfePnl: 0, maePnl: 0, durationMs: 0,
          fullSnapshots: 0, partialSnapshots: 0
        };
      }
      const group = groups[key];
      group.trades += 1;
      if (trade.outcome === 'WIN' || paperNumber(trade.r) > 0) group.wins += 1;
      else if (trade.outcome === 'LOSS' || paperNumber(trade.r) < 0) group.losses += 1;
      else group.breakeven += 1;
      group.netR += paperNumber(trade.r);
      group.pnl += paperNumber(trade.pnl);
      group.mfePnl += paperNumber(trade.mfePnl);
      group.maePnl += paperNumber(trade.maePnl);
      const start = Date.parse(trade.openedAt || '');
      const end = Date.parse(trade.closedAt || '');
      if (start && end) group.durationMs += Math.max(0, end - start);
      if (paperAnalysisCaptured(trade)) group.fullSnapshots += 1;
      else if (paperAnalysisHasPartialContext(trade)) group.partialSnapshots += 1;
    });
  });
  return Object.values(groups).map(group => ({
    ...group,
    netR: Number(group.netR.toFixed(3)),
    pnl: Number(group.pnl.toFixed(2)),
    averageR: group.trades ? Number((group.netR / group.trades).toFixed(3)) : 0,
    averagePnl: group.trades ? Number((group.pnl / group.trades).toFixed(2)) : 0,
    averageMfePnl: group.trades ? Number((group.mfePnl / group.trades).toFixed(2)) : 0,
    averageMaePnl: group.trades ? Number((group.maePnl / group.trades).toFixed(2)) : 0,
    averageDurationMs: group.durationMs ? Math.round(group.durationMs / group.trades) : 0,
    winRate: group.trades ? Number((group.wins / group.trades * 100).toFixed(1)) : 0,
    sampleSufficient: group.trades >= minSample,
    sampleForInference: group.trades >= 30
  })).sort((a, b) => b.netR - a.netR || b.trades - a.trades);
}

function paperClosedTradeAnalysis(query) {
  const filters = paperHistoryFilters(query);
  const limitValue = typeof query.get === 'function' ? query.get('limit') : query.limit;
  const limit = Math.max(25, Math.min(250, Number(limitValue || 100)));
  const all = paperState.closedTrades.slice(0, PAPER_MAX_CLOSED_TRADES)
    .filter(trade => paperHistoryMatches(trade, filters));
  all.forEach(paperEnsureAnalysis);
  const closed = all.filter(trade => trade.outcome !== 'CANCELLED');
  const chronological = closed.slice().sort((a, b) => {
    const at = Date.parse(a.closedAt || '') || Number(a.createdAt) || 0;
    const bt = Date.parse(b.closedAt || '') || Number(b.createdAt) || 0;
    return at - bt;
  });
  let currentWinStreak = 0, currentLossStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
  let runWin = 0, runLoss = 0;
  chronological.forEach(trade => {
    const win = trade.outcome === 'WIN' || paperNumber(trade.r) > 0;
    const loss = trade.outcome === 'LOSS' || paperNumber(trade.r) < 0;
    if (win) { runWin += 1; runLoss = 0; maxWinStreak = Math.max(maxWinStreak, runWin); }
    else if (loss) { runLoss += 1; runWin = 0; maxLossStreak = Math.max(maxLossStreak, runLoss); }
    else { runWin = 0; runLoss = 0; }
  });
  currentWinStreak = runWin;
  currentLossStreak = runLoss;
  const wins = closed.filter(trade => trade.outcome === 'WIN' || paperNumber(trade.r) > 0);
  const losses = closed.filter(trade => trade.outcome === 'LOSS' || paperNumber(trade.r) < 0);
  const fullSnapshots = closed.filter(paperAnalysisCaptured).length;
  const partialSnapshots = closed.filter(trade => !paperAnalysisCaptured(trade) && paperAnalysisHasPartialContext(trade)).length;
  const notCaptured = Math.max(0, closed.length - fullSnapshots - partialSnapshots);
  const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const grossProfit = wins.reduce((sum, trade) => sum + Math.max(0, paperNumber(trade.r)), 0);
  const grossLoss = losses.reduce((sum, trade) => sum + Math.min(0, paperNumber(trade.r)), 0);
  const averageWinR = avg(wins.map(trade => paperNumber(trade.r)));
  const averageLossR = avg(losses.map(trade => paperNumber(trade.r)));
  const detailRows = chronological.slice(-limit).reverse().map(trade => ({
    id: trade.id, closedAt: trade.closedAt || null, symbol: trade.sym || null,
    direction: trade.dir || null, outcome: trade.outcome || null,
    strategyVersion: trade.strategyVersion || paperTradeStrategyVersion(trade),
    universeVersion: trade.universeVersion || 'LEGACY',
    cohortId: trade.cohortId || null, timeframe: trade.timeframe || trade.tf || '15M',
    entryLimit: trade.entryLimit == null ? null : trade.entryLimit,
    entryActual: trade.entryActual == null ? null : trade.entryActual,
    exitPrice: trade.exitPrice == null ? null : trade.exitPrice,
    sl: trade.sl == null ? null : trade.sl, tp1: trade.tp1 == null ? null : trade.tp1,
    tp2: trade.tp2 == null ? null : trade.tp2, rr: trade.setupValidation && trade.setupValidation.rr != null
      ? trade.setupValidation.rr : paperAnalysisValue(trade, 'rr', null),
    r: paperNumber(trade.r), pnl: paperNumber(trade.pnl), closeReason: trade.closeReason || null,
    tp1Hit: !!trade.tp1Hit, mfePnl: paperNumber(trade.mfePnl), maePnl: paperNumber(trade.maePnl),
    timeToFillMs: trade.openedAt ? Math.max(0, (Date.parse(trade.openedAt) || 0) - (Number(trade.createdAt) || 0)) : 0,
    durationMs: trade.openedAt && trade.closedAt ? Math.max(0, (Date.parse(trade.closedAt) || 0) - (Date.parse(trade.openedAt) || 0)) : 0,
    analysisStatus: trade.analysisStatus || 'DATA_NOT_CAPTURED',
    snapshot: trade.analysisSnapshot || null, analysisExit: trade.analysisExit || null,
    tags: trade.analysisTags || {exit: [], setup: [], market: []},
    summary: trade.analysisSummary || null
  }));
  const factor = (keyFn, minimumSample) => paperFactorStats(closed, keyFn, minimumSample || 5);
  const mtfBucket = trade => {
    const value = paperAnalysisValue(trade, 'mtfAlignment', null);
    return value == null ? 'UNKNOWN' : Number(value) + '/4';
  };
  const confluenceBucket = trade => paperAnalysisBucket(paperAnalysisValue(trade, 'confluencePct', null), [
    {label: '<60%', test: value => value < 60}, {label: '60-69%', test: value => value < 70},
    {label: '70-79%', test: value => value < 80}, {label: '80-89%', test: value => value < 90},
    {label: '90-100%', test: value => value <= 100}
  ]);
  const rsiBucket = trade => paperAnalysisBucket(paperAnalysisValue(trade, 'rsi', null), [
    {label: '<30 oversold', test: value => value < 30}, {label: '30-44', test: value => value < 45},
    {label: '45-55 neutral', test: value => value <= 55}, {label: '56-69', test: value => value < 70},
    {label: '>=70 overbought', test: value => value >= 70}
  ]);
  const atrBucket = trade => paperAnalysisBucket(paperAnalysisValue(trade, 'atrPct', null), [
    {label: '<1% low', test: value => value < 1}, {label: '1-1.99%', test: value => value < 2},
    {label: '2-3.99%', test: value => value < 4}, {label: '>=4% high', test: value => value >= 4}
  ]);
  const volumeBucket = trade => paperAnalysisBucket(paperAnalysisValue(trade, 'volumeRatio', null), [
    {label: '<1x', test: value => value < 1}, {label: '1-1.49x', test: value => value < 1.5},
    {label: '1.5-1.99x', test: value => value < 2}, {label: '>=2x', test: value => value >= 2}
  ]);
  const fundingBucket = trade => {
    const value = Number(paperAnalysisValue(trade, 'fund', null));
    return !Number.isFinite(value) || value === 0 ? 'ZERO_OR_UNKNOWN' : value < 0 ? 'NEGATIVE' : 'POSITIVE';
  };
  const oiBucket = trade => {
    const value = Number(paperAnalysisValue(trade, 'oi', null));
    return !Number.isFinite(value) || value === 0 ? 'FLAT_OR_UNKNOWN' : value < 0 ? 'FALLING' : 'RISING';
  };
  const byDay = factor(trade => {
    const at = Date.parse(trade.closedAt || '') || Number(trade.createdAt) || 0;
    return at ? new Date(at).toISOString().slice(0, 10) : 'UNKNOWN';
  }, 1);
  return {
    ok: true, buildId: PAPER_BUILD_ID, asOf: new Date().toISOString(),
    filters: {...filters, symbol: filters.symbol || 'all', direction: filters.direction || 'all',
      timeframe: filters.timeframe || 'all', outcome: filters.outcome || 'all',
      fundingSign: filters.fundingSign || 'all', volumeBucket: filters.volumeBucket || 'all',
      marketTag: filters.marketTag || 'all', strategyVersion: filters.strategyVersion || 'all',
      universeVersion: filters.universeVersion || 'all',
      cohortId: filters.cohortId || 'all'},
    population: {orders: all.length, closed: closed.length, cancelled: all.length - closed.length,
      wins: wins.length, losses: losses.length, breakeven: Math.max(0, closed.length - wins.length - losses.length)},
    snapshotCoverage: {full: fullSnapshots, partial: partialSnapshots, notCaptured,
      fullRate: closed.length ? Number((fullSnapshots / closed.length * 100).toFixed(1)) : 0,
      contextRate: closed.length ? Number(((fullSnapshots + partialSnapshots) / closed.length * 100).toFixed(1)) : 0,
      inferenceMinimum: 30, inferenceReady: fullSnapshots >= 30,
      note: notCaptured ? 'Trade lama tanpa snapshot lengkap tidak dipakai untuk inferensi faktor.'
        : partialSnapshots ? 'Sebagian trade hanya memiliki konteks parsial.' : 'Semua closed trade memiliki snapshot lengkap.'},
    performance: {winRate: closed.length ? Number((wins.length / closed.length * 100).toFixed(1)) : 0,
      netR: Number(closed.reduce((sum, trade) => sum + paperNumber(trade.r), 0).toFixed(3)),
      pnl: Number(closed.reduce((sum, trade) => sum + paperNumber(trade.pnl), 0).toFixed(2)),
      grossProfitR: Number(grossProfit.toFixed(3)), grossLossR: Number(grossLoss.toFixed(3)),
      profitFactor: grossLoss < 0 ? Number((grossProfit / Math.abs(grossLoss)).toFixed(2)) : null,
      averageWinR: Number(averageWinR.toFixed(3)), averageLossR: Number(averageLossR.toFixed(3)),
      expectancyR: closed.length ? Number((closed.reduce((sum, trade) => sum + paperNumber(trade.r), 0) / closed.length).toFixed(3)) : 0,
      averageMfePnl: Number(avg(closed.map(trade => paperNumber(trade.mfePnl))).toFixed(2)),
      averageMaePnl: Number(avg(closed.map(trade => paperNumber(trade.maePnl))).toFixed(2)),
      tp1Hits: closed.filter(trade => trade.tp1Hit).length,
      tp2Hits: closed.filter(trade => String(trade.closeReason || '').toLowerCase().includes('tp2')).length,
      directSlLosses: closed.filter(trade => paperExitClassification(trade) === 'DIRECT_SL_LOSS').length,
      protectedAfterTp1: closed.filter(trade => paperExitClassification(trade) === 'PROTECTED_AFTER_TP1').length},
    streaks: {currentWins: currentWinStreak, currentLosses: currentLossStreak, maxWins: maxWinStreak, maxLosses: maxLossStreak},
    factors: {
      mtfAlignment: factor(mtfBucket), confluence: factor(confluenceBucket), rsi: factor(rsiBucket),
      atr: factor(atrBucket), volume: factor(volumeBucket), funding: factor(fundingBucket), oi: factor(oiBucket),
      regime: factor(trade => paperTradeRegimeTag(trade) || 'UNKNOWN'), direction: factor(trade => trade.dir || 'UNKNOWN'),
      symbol: factor(trade => trade.sym || 'UNKNOWN'), timeframe: factor(trade => trade.timeframe || trade.tf || 'UNKNOWN'),
      strategy: factor(trade => trade.strategyVersion || paperTradeStrategyVersion(trade)),
      exit: factor(trade => paperExitClassification(trade)), setupTags: paperTagGroupStats(closed, 'setup'),
      marketTags: paperTagGroupStats(closed, 'market'), byDay
    },
    insightPolicy: {minimumExploratorySample: 5, minimumForStrategyChange: 30,
      statement: 'Factor results are descriptive associations, not causal proof. Jangan ubah strategi dari satu bucket kecil.'},
    tradeRows: detailRows
  };
}

function paperTagGroupStats(trades, category) {
  const tagged = [];
  trades.forEach(trade => {
    paperEnsureAnalysis(trade);
    const tags = trade.analysisTags && Array.isArray(trade.analysisTags[category])
      ? trade.analysisTags[category] : ['UNKNOWN'];
    [...new Set(tags.length ? tags : ['UNKNOWN'])].forEach(tag => tagged.push({...trade, analysisTag: tag}));
  });
  return paperGroupStats(tagged, row => row.analysisTag);
}

function paperStats(query) {
  const filters = paperHistoryFilters(query);
  const all = paperState.closedTrades.slice(0, PAPER_MAX_CLOSED_TRADES)
    .filter(trade => paperHistoryMatches(trade, filters));
  all.forEach(paperEnsureAnalysis);
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
  const researchScope = filters.strategyVersion === PAPER_RESEARCH_STRATEGY_VERSION ||
    filters.cohortId === String(paperState.researchCohortId || '');
  const startingEquity = paperNumber(researchScope
    ? (paperState.researchStartingEquity || paperState.startingEquity || PAPER_STARTING_EQUITY)
    : (paperState.startingEquity || PAPER_STARTING_EQUITY));
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
  const captured = closed.filter(paperAnalysisCaptured).length;
  const partial = closed.filter(trade => !paperAnalysisCaptured(trade) && paperAnalysisHasPartialContext(trade)).length;
  const notCaptured = Math.max(0, closed.length - captured - partial);
  const analysisGate = paperAnalysisGate(captured);
  const exitClassification = {};
  closed.forEach(trade => {
    const key = paperExitClassification(trade);
    exitClassification[key] = (exitClassification[key] || 0) + 1;
  });
  return {
    ok: true, buildId: PAPER_BUILD_ID,
    asOf: new Date().toISOString(),
    filters: {...filters, symbol: filters.symbol || 'all', direction: filters.direction || 'all', timeframe: filters.timeframe || 'all', outcome: filters.outcome || 'all', fundingSign: filters.fundingSign || 'all', volumeBucket: filters.volumeBucket || 'all', marketTag: filters.marketTag || 'all'},
    sample: {
      orders: all.length, closed: closed.length, filled: filled.length,
      pendingExpired: expired.length, cancelled: cancelled.length,
      wins: wins.length, losses: losses.length,
      breakeven: closed.filter(trade => paperNumber(trade.r) === 0).length,
      analysisCaptured: captured, analysisPartial: partial, analysisNotCaptured: notCaptured,
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
      fullTp2Wins: exitClassification.FULL_TP2 || 0,
      protectedAfterTp1: exitClassification.PROTECTED_AFTER_TP1 || 0,
      directSlLosses: exitClassification.DIRECT_SL_LOSS || 0,
      exitClassification,
      pendingExpiredRate: all.length ? Number((expired.length / all.length * 100).toFixed(1)) : 0
    },
    analysisCoverage: {
      totalClosed: closed.length, captured, partial, notCaptured,
      captureRate: closed.length ? Number((captured / closed.length * 100).toFixed(1)) : 0,
      contextCoverageRate: closed.length ? Number(((captured + partial) / closed.length * 100).toFixed(1)) : 0,
      ...analysisGate,
      aiEligible: analysisGate.p4Ready,
      p4GatePassed: analysisGate.p4GatePassed,
      p4AiEnabled: analysisGate.p4AiEnabled,
      p4Ready: analysisGate.p4Ready,
      p4Reason: analysisGate.p4Reason,
      note: notCaptured
        ? 'Sebagian trade lama hanya memiliki konteks parsial; indikator yang tidak tersimpan tidak diisi ulang dengan data perkiraan.'
        : partial ? 'Semua trade memiliki konteks entry, tetapi sebagian belum lengkap untuk inferensi faktor.'
          : 'Semua trade memiliki snapshot entry lengkap.'
    },
    bySymbol: paperGroupStats(closed, trade => trade.sym),
    byDirection: paperGroupStats(closed, trade => trade.dir),
    byTimeframe: paperGroupStats(closed, trade => trade.timeframe || trade.tf),
    byMode: paperGroupStats(closed, trade => trade.signalMode || trade.mode),
    byStrategyVersion: paperGroupStats(closed, trade => trade.strategyVersion || paperTradeStrategyVersion(trade)),
    byUniverseVersion: paperGroupStats(closed, trade => trade.universeVersion || 'LEGACY'),
    byCohort: paperGroupStats(closed, trade => trade.cohortId),
    byCandlePattern: paperGroupStats(closed, trade => trade.candlePattern),
    byConfluence: paperGroupStats(closed, trade => {
      const value = paperNumber(trade.confluencePct);
      return value >= 80 ? '80-100' : value >= 60 ? '60-79' : value ? '<60' : 'UNKNOWN';
    }),
    byFunding: paperGroupStats(closed, trade => {
      const value = paperNumber(trade.fund);
      return value <= -0.001 ? '<=-0.10%' : value <= -0.0005 ? '-0.10%..-0.05%'
        : value < 0 ? '-0.05%..0%' : value === 0 ? '0%' : value <= 0.0005 ? '0%..0.05%'
          : value <= 0.001 ? '0.05%..0.10%' : '>0.10%';
    }),
    byFundingSign: paperGroupStats(closed, trade => {
      const value = paperNumber(trade.fund);
      return value < 0 ? 'NEGATIVE' : value > 0 ? 'POSITIVE' : 'ZERO_OR_UNKNOWN';
    }),
    byOISign: paperGroupStats(closed, trade => {
      const value = paperNumber(trade.oi);
      return value > 0 ? 'RISING' : value < 0 ? 'FALLING' : 'FLAT_OR_UNKNOWN';
    }),
    byVolumeRatio: paperGroupStats(closed, trade => {
      const value = paperNumber(trade.volumeRatio);
      return value >= 2 ? '>=2x' : value >= 1.5 ? '1.5-1.99x' : value >= 1 ? '1-1.49x' : value > 0 ? '<1x' : 'UNKNOWN';
    }),
    byScore: paperGroupStats(closed, trade => {
      const score = paperNumber(trade.score);
      return score >= 8 ? '8-12' : score >= 6.5 ? '6.5-7.9' : '<6.5';
    }),
    byExitTag: paperTagGroupStats(closed, 'exit'),
    bySetupTag: paperTagGroupStats(closed, 'setup'),
    byMarketTag: paperTagGroupStats(closed, 'market'),
    closeReasons: paperGroupStats(closed, trade => trade.closeReason || 'UNKNOWN')
  };
}

function paperHistory(query) {
  const filters = paperHistoryFilters(query);
  const get = key => query && typeof query.get === 'function' ? query.get(key) : query && query[key];
  const all = paperState.closedTrades.slice(0, PAPER_MAX_CLOSED_TRADES);
  const filtered = all.filter(trade => paperHistoryMatches(trade, filters));
  const rawLimit = get('limit');
  const parsedLimit = rawLimit == null || rawLimit === '' ? PAPER_MAX_CLOSED_TRADES : Math.floor(Number(rawLimit));
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(PAPER_MAX_CLOSED_TRADES, parsedLimit)) : PAPER_MAX_CLOSED_TRADES;
  const rawOffset = get('offset');
  const parsedOffset = rawOffset == null || rawOffset === '' ? 0 : Math.floor(Number(rawOffset));
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;
  const closedTrades = filtered.slice(offset, offset + limit);
  return {
    ok: true,
    activeTrades: paperState.activeTrades.filter(paperIsActive).map(paperTradeView),
    closedTrades,
    invalidatedTrades: paperState.invalidatedTrades.slice(0, 100),
    monitoringSignals: (paperState.monitoringSignals || []).slice(0, PAPER_MAX_MONITORING_SIGNALS),
    filters: {symbol: filters.symbol || 'all', timeframe: filters.timeframe || 'all',
      outcome: filters.outcome || 'all', fundingSign: filters.fundingSign || 'all',
      volumeBucket: filters.volumeBucket || 'all', marketTag: filters.marketTag || 'all',
      strategyVersion: filters.strategyVersion || 'all',
      universeVersion: filters.universeVersion || 'all',
      cohortId: filters.cohortId || 'all', direction: filters.direction || 'all', from: filters.from, to: filters.to},
    total: filtered.length,
    pagination: {limit, offset, returned: closedTrades.length, hasMore: offset + closedTrades.length < filtered.length}
  };
}

function paperWinRateAlertView() {
  const now = Date.now();
  const strictClosed = paperState.closedTrades
    .filter(trade => paperIsTrialTrade(trade) && trade.outcome !== 'CANCELLED')
    .slice()
    .sort((a, b) => (paperTimestamp(a.closedAt) || Number(a.createdAt) || 0) -
      (paperTimestamp(b.closedAt) || Number(b.createdAt) || 0));
  const windowView = (windowMs, thresholdPct, minimumTrades) => {
    const rows = strictClosed.filter(trade => {
      const at = paperTimestamp(trade.closedAt) || Number(trade.createdAt) || 0;
      return at >= now - windowMs;
    });
    const wins = rows.filter(trade => trade.outcome === 'WIN').length;
    const losses = rows.filter(trade => trade.outcome === 'LOSS').length;
    const winRate = rows.length ? Number((wins / rows.length * 100).toFixed(1)) : null;
    return {
      trades: rows.length, wins, losses, winRate,
      thresholdPct, minimumTrades,
      triggered: rows.length >= minimumTrades && winRate < thresholdPct
    };
  };
  let consecutiveLosses = 0;
  for (let index = strictClosed.length - 1; index >= 0; index -= 1) {
    if (strictClosed[index].outcome !== 'LOSS') break;
    consecutiveLosses += 1;
  }
  const daily = windowView(24 * 60 * 60 * 1000, 40, 5);
  const weekly = windowView(7 * 24 * 60 * 60 * 1000, 45, 10);
  const messages = [];
  if (daily.triggered) messages.push('daily win rate ' + daily.winRate.toFixed(1) + '% < 40%');
  if (weekly.triggered) messages.push('weekly win rate ' + weekly.winRate.toFixed(1) + '% < 45%');
  if (consecutiveLosses >= 4) messages.push(consecutiveLosses + ' strict losses berturut-turut');
  return {
    cohort: paperState.cohortId,
    daily, weekly, consecutiveLosses,
    consecutiveLossTriggered: consecutiveLosses >= 4,
    triggered: messages.length > 0,
    messages
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
    'strategyVersion', 'universeVersion', 'cohortId', 'timeframe', 'mode', 'entryLimit', 'entryActual',
    'exitPrice', 'sl', 'tp1', 'tp2', 'score', 'confluencePct', 'r', 'pnl',
    'closeReason', 'createdAt', 'openedAt', 'dataQuality', 'source',
    'analysisStatus', 'analysisSummary', 'exitTags', 'setupTags', 'marketTags'];
  const lines = [headers.map(paperCsvCell).join(',')];
  rows.forEach(trade => {
    lines.push([
      trade.closedAt, trade.id, trade.sym, trade.dir, trade.status, trade.outcome,
      trade.strategyVersion || paperTradeStrategyVersion(trade), trade.universeVersion || 'LEGACY', trade.cohortId,
      trade.timeframe || trade.tf, trade.signalMode || trade.mode,
      trade.entryLimit, trade.entryActual, trade.exitPrice, trade.sl, trade.tp1,
      trade.tp2, trade.score, trade.confluencePct, trade.r, trade.pnl,
      trade.closeReason, trade.createdAt, trade.openedAt, trade.dataQuality, trade.source
      , trade.analysisStatus || 'DATA_NOT_CAPTURED',
      trade.analysisSummary || '',
      trade.analysisTags && Array.isArray(trade.analysisTags.exit) ? trade.analysisTags.exit.join('|') : '',
      trade.analysisTags && Array.isArray(trade.analysisTags.setup) ? trade.analysisTags.setup.join('|') : '',
      trade.analysisTags && Array.isArray(trade.analysisTags.market) ? trade.analysisTags.market.join('|') : ''
    ].map(paperCsvCell).join(','));
  });
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

function startPaperBot() {
  if (process.env.PAPER_BOT_ENABLED === 'false') return;
  paperStarted = true;
  paperRuntime.startedAt = new Date().toISOString();
  console.log('[paper] VPS Paper Bot ON: scan every 15M, top 3, pending expiry 120m');
  void probeExternalSources();
  setInterval(() => void probeExternalSources(), SOURCE_HEALTH_PROBE_MS);
  startTelegramCommandBot();
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
      buildId: PAPER_BUILD_ID,
      port: PORT,
      paperBot: paperStarted,
      paperBotEnabled: paperState.enabled,
       paperStrategyVersion: PAPER_STRATEGY_VERSION,
       strategyVersion: PAPER_STRATEGY_VERSION,
       schemaVersion: PAPER_SCHEMA_VERSION,
       researchCollection: {
         enabled: paperResearchEnabled(), strategyVersion: PAPER_RESEARCH_STRATEGY_VERSION,
         hardDrawdownPct: PAPER_RESEARCH_HARD_DD_PCT
       },
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
    send(res, 200, JSON.stringify(paperStatus({details: false, stats: false, labHistory: false})));
    return;
  }
  if (requestUrl.pathname === '/paper/details') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    send(res, 200, JSON.stringify(paperStatus()));
    return;
  }
  if (requestUrl.pathname === '/paper/summary') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    send(res, 200, JSON.stringify(paperStatus({details: false, stats: false, labHistory: false})));
    return;
  }
  if (requestUrl.pathname === '/api/status') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    const status = paperStatus();
    send(res, 200, JSON.stringify({ok: true, drawdown: status.drawdown, paper: status}));
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
      commands: {
        enabled: TELEGRAM_COMMANDS_ENABLED,
        received: telegramState.commandsReceived,
        replied: telegramState.commandsReplied,
        lastCommandAt: telegramState.lastCommandAt,
        lastCommand: telegramState.lastCommand,
        lastPollAt: telegramState.lastPollAt,
        lastPollSuccessAt: telegramState.lastPollSuccessAt,
        lastPollError: telegramState.lastPollError
      },
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
    if (!/^[A-Z0-9]{2,15}$/.test(symbol) || !isEligibleBaseSymbol(symbol)) {
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
  if (requestUrl.pathname === '/paper/analysis') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    try {
      send(res, 200, JSON.stringify(paperClosedTradeAnalysis(requestUrl.searchParams)));
    } catch (error) {
      console.error('[paper] closed trade analysis failed:', error.message);
      send(res, 500, JSON.stringify({ok: false, error: error.message || 'Closed trade analysis failed'}));
    }
    return;
  }
  if (requestUrl.pathname === '/paper/strategy-lab') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    const includeTrades = requestUrl.searchParams.get('details') !== 'false';
    const includeHistory = includeTrades || requestUrl.searchParams.get('history') === 'true';
    try {
      send(res, 200, JSON.stringify(paperStrategyLabSummary(includeTrades, {history: includeHistory})));
    } catch (error) {
      send(res, 500, JSON.stringify({ok: false, error: error.message || 'Strategy Lab unavailable'}));
    }
    return;
  }

  const newsAnalyzeMatch = requestUrl.pathname.match(/^\/api\/news\/([^/]+)\/analyze$/);
  if (newsAnalyzeMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({error: 'Method not allowed'}));
      return;
    }
    const newsId = decodeURIComponent(newsAnalyzeMatch[1]);
    const cachedArticle = newsArticleCache.get(newsId);
    if (!cachedArticle || cachedArticle.expiresAt <= Date.now()) {
      send(res, 404, JSON.stringify({ok: false, error: 'News article expired or not loaded; refresh News first'}));
      return;
    }
    try {
      send(res, 200, JSON.stringify(await analyzeNewsImpact(cachedArticle.row)));
    } catch (error) {
      send(res, 502, JSON.stringify({ok: false, error: 'News impact analysis unavailable', detail: error.message || 'unknown error'}));
    }
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
