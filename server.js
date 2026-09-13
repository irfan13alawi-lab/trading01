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
const PAPER_MAX_ACTIVE = 30;
const PAPER_STARTING_EQUITY = Number(process.env.PAPER_STARTING_EQUITY || 285);
const PAPER_STATE_FILE = process.env.PAPER_STATE_FILE ||
  path.join(__dirname, 'paper-bot-state.json');
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
    enabled: true,
    startingEquity: PAPER_STARTING_EQUITY,
    startedAt: new Date().toISOString(),
    lastScanAt: null,
    lastCycleKey: null,
    lastMonitorAt: null,
    lastPriceAt: null,
    lastError: null,
    nextId: 0,
    oiSnapshot: {},
    activeTrades: [],
    closedTrades: [],
    invalidatedTrades: [],
    recentScans: []
  };
}

function loadPaperState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PAPER_STATE_FILE, 'utf8'));
    const state = {
      ...defaultPaperState(),
      ...parsed,
      oiSnapshot: parsed.oiSnapshot || {},
      activeTrades: Array.isArray(parsed.activeTrades) ? parsed.activeTrades : [],
      closedTrades: Array.isArray(parsed.closedTrades) ? parsed.closedTrades : [],
      invalidatedTrades: Array.isArray(parsed.invalidatedTrades) ? parsed.invalidatedTrades : [],
      recentScans: Array.isArray(parsed.recentScans) ? parsed.recentScans : []
    };
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
    // stop side reversed for SHORT and LONG orders.
    state.activeTrades.forEach(trade => {
      const entry = paperNumber(trade.entryLimit);
      if (!entry || !trade.dir) return;
      trade.sl = paperRoundPrice(entry * (trade.dir === 'LONG' ? 0.97 : 1.03));
      trade.tp1 = paperRoundPrice(entry * (trade.dir === 'LONG' ? 1.06 : 0.94));
      trade.tp2 = paperRoundPrice(entry * (trade.dir === 'LONG' ? 1.10 : 0.90));
    });
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
    fs.writeFileSync(tempFile, JSON.stringify(paperState, null, 2));
    fs.renameSync(tempFile, PAPER_STATE_FILE);
  } catch (error) {
    console.error('[paper] state save failed:', error.message);
  }
}

function paperScore(changePct, funding, oiDeltaPct, hasOi) {
  const fundingScore = funding <= -0.010 ? 2.5
    : funding < 0 ? 2.2
    : funding < 0.002 ? 2.0
    : funding < 0.004 ? 1.5
    : funding < 0.006 ? 1.2
    : funding < 0.008 ? 0.8
    : funding < 0.010 ? 0.4 : 0;
  const priceScore = changePct >= -2 && changePct <= 0 ? 2.5
    : changePct > 0 && changePct <= 1 ? 2.0
    : changePct > 1 && changePct <= 3 ? 1.5
    : changePct > 3 && changePct <= 5 ? 1.0
    : changePct > 5 && changePct <= 8 ? 0.5 : 0;
  let oiScore = oiDeltaPct > 2 ? 2.0
    : oiDeltaPct > 0 ? 1.5
    : oiDeltaPct >= -1 ? 0.5 : 0;
  if (hasOi && oiDeltaPct > 1) oiScore = Math.min(2.0, oiScore + 0.3);
  return Math.min(12, Number((fundingScore + priceScore + oiScore + 3).toFixed(1)));
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
      sym, price, chg, fund, oi, oiUSD: oiUsd, sc,
      tier: paperTier(sc), sig: paperSignal(chg, oi, fund)
    };
    if (pair.tier === 'C' || pair.fund >= 0.005 ||
        Math.abs(pair.chg) > 3.5 || pair.sc < 7) return;
    let rank = pair.sc * 0.4;
    const fundingBonus = pair.fund < -0.010 ? 3
      : pair.fund < 0 ? 2
      : pair.fund < 0.002 ? 1 : 0;
    rank += fundingBonus * 0.3;
    rank += (pair.sig === 'BUY' ? 2 : pair.sig === 'PUMP' ? 1.5 : 0) * 0.2;
    rank += (pair.tier === 'A' ? 2 : pair.tier === 'B' ? 1 : 0) * 0.1;
    if (Math.abs(pair.chg) <= 2) rank += 0.5;
    if (pair.oi > 0) rank += 0.3;
    pair.rank = Number(rank.toFixed(3));
    pairs[sym] = pair;
  });
  return Object.keys(pairs).map(sym => pairs[sym]).sort((a, b) => b.rank - a.rank);
}

function paperSetup(pair) {
  const dir = pair.chg < 0 ? 'SHORT' : 'LONG';
  const entry = pair.price * (dir === 'LONG' ? 0.997 : 1.003);
  const sl = entry * (dir === 'LONG' ? 0.97 : 1.03);
  const tp1 = entry * (dir === 'LONG' ? 1.06 : 0.94);
  const tp2 = entry * (dir === 'LONG' ? 1.10 : 0.90);
  const riskDollar = paperEquity() * 0.02;
  const stopDistance = Math.abs(entry - sl);
  const contracts = stopDistance > 0 ? riskDollar / stopDistance : 0;
  return {
    dir,
    entry: paperRoundPrice(entry),
    sl: paperRoundPrice(sl),
    tp1: paperRoundPrice(tp1),
    tp2: paperRoundPrice(tp2),
    contracts: Number(contracts.toFixed(6)),
    size: Number((contracts * entry).toFixed(2))
  };
}

function paperActiveCount() {
  return paperState.activeTrades.filter(t =>
    t.status === 'PENDING' || t.status === 'OPEN').length;
}

function paperRealizedPnl() {
  return paperState.closedTrades.reduce((sum, trade) =>
    sum + paperNumber(trade.pnl), 0);
}

function paperUnrealizedPnl() {
  return paperState.activeTrades
    .filter(trade => trade.status === 'OPEN')
    .reduce((sum, trade) => sum + paperNumber(trade.unrealPnl), 0);
}

function paperEquity() {
  return paperNumber(paperState.startingEquity || PAPER_STARTING_EQUITY) +
    paperRealizedPnl() + paperUnrealizedPnl();
}

function paperTradeView(trade) {
  return {
    id: trade.id, sym: trade.sym, dir: trade.dir, status: trade.status,
    entryLimit: trade.entryLimit, entryActual: trade.entryActual || null,
    currentPrice: trade.currentPrice, sl: trade.sl, tp1: trade.tp1, tp2: trade.tp2,
    size: trade.size, contracts: trade.contracts, score: trade.score, tier: trade.tier,
    fund: trade.fund, oi: trade.oi, createdAt: trade.createdAt,
    openedAt: trade.openedAt || null, cycleKey: trade.cycleKey,
    unrealPnl: Number((trade.unrealPnl || 0).toFixed(2)), reason: trade.reason
  };
}

function paperCandidateView(pair) {
  return {
    sym: pair.sym, price: pair.price, chg: pair.chg, fund: pair.fund,
    oi: pair.oi, score: pair.sc, tier: pair.tier, sig: pair.sig, rank: pair.rank
  };
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
  paperState.closedTrades = paperState.closedTrades.slice(0, 200);
  console.log('[paper] closed', trade.sym, outcome, reason);
}

async function fetchPaperTickers() {
  const target = APIS['/bitget'] +
    '/api/v2/mix/market/tickers?productType=USDT-FUTURES';
  const result = await requestUpstream(target);
  if (result.status < 200 || result.status >= 300) {
    throw new Error('Bitget tickers HTTP ' + result.status);
  }
  let payload;
  try {
    payload = JSON.parse(result.body);
  } catch (_) {
    throw new Error('Bitget tickers returned invalid JSON');
  }
  if (!payload || payload.code !== '00000' || !Array.isArray(payload.data)) {
    throw new Error((payload && payload.msg) || 'Bitget tickers response invalid');
  }
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
    const activeSymbols = new Set(paperState.activeTrades
      .filter(t => t.status === 'PENDING' || t.status === 'OPEN')
      .map(t => t.sym));
    const capacity = Math.max(0, PAPER_MAX_ACTIVE - paperActiveCount());
    const selected = [];
    for (const pair of ranked) {
      if (selected.length >= Math.min(PAPER_PER_SCAN, capacity)) break;
      if (activeSymbols.has(pair.sym)) continue;
      selected.push(pair);
      activeSymbols.add(pair.sym);
    }
    const placed = selected.map(pair => {
      const setup = paperSetup(pair);
      const id = 'VPS-' + String(++paperState.nextId).padStart(6, '0');
      const trade = {
        id, sym: pair.sym, dir: setup.dir, entryLimit: setup.entry,
        currentPrice: pair.price, sl: setup.sl, tp1: setup.tp1, tp2: setup.tp2,
        size: setup.size, contracts: setup.contracts, status: 'PENDING',
        createdAt: Date.now(), openedAt: null, cycleKey,
        score: pair.sc, tier: pair.tier, fund: pair.fund, oi: pair.oi,
        unrealPnl: 0, reason: 'Auto VPS: 15M scan'
      };
      paperState.activeTrades.push(trade);
      console.log('[paper] placed', id, pair.sym, setup.dir, '@', setup.entry);
      return paperTradeView(trade);
    });
    paperState.lastCycleKey = cycleKey;
    paperState.lastScanAt = new Date().toISOString();
    paperState.lastError = null;
    paperState.recentScans.unshift({
      cycleKey, at: paperState.lastScanAt, reason: reason || '15M close',
      candidates: ranked.length,
      selected: ranked.slice(0, 10).map(paperCandidateView),
      placed
    });
    paperState.recentScans = paperState.recentScans.slice(0, 100);
    savePaperState();
    console.log('[paper] scan complete', cycleKey, 'placed', placed.length);
  } catch (error) {
    paperState.lastError = error.message;
    savePaperState();
    console.error('[paper] scan failed:', error.message);
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
          paperState.closedTrades = paperState.closedTrades.slice(0, 200);
          changed = true;
        } else {
          const filled = trade.dir === 'LONG'
            ? price <= trade.entryLimit * 1.005
            : price >= trade.entryLimit * 0.995;
          if (filled) {
            trade.status = 'OPEN';
            trade.entryActual = price;
            trade.openedAt = new Date().toISOString();
            changed = true;
          }
          retained.push(trade);
        }
        return;
      }
      if (trade.status !== 'OPEN') return;
      const entry = trade.entryActual || trade.entryLimit;
      trade.unrealPnl = ((price - entry) / entry) * trade.size *
        (trade.dir === 'LONG' ? 1 : -1);
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
  const realizedPnl = paperRealizedPnl();
  const unrealizedPnl = paperUnrealizedPnl();
  const equity = paperEquity();
  return {
    ok: true, service: 'nexora-paper-bot', enabled: paperState.enabled,
    running: paperStarted, interval: '15M', perScan: PAPER_PER_SCAN,
    pendingTtlMinutes: PAPER_PENDING_TTL_MS / 60000, maxConcurrent: PAPER_MAX_ACTIVE,
    startingEquity: paperNumber(paperState.startingEquity || PAPER_STARTING_EQUITY),
    realizedPnl: Number(realizedPnl.toFixed(2)),
    unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
    equity: Number(equity.toFixed(2)),
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

function startPaperBot() {
  if (process.env.PAPER_BOT_ENABLED === 'false') return;
  paperStarted = true;
  console.log('[paper] VPS Paper Bot ON: scan every 15M, top 3, pending expiry 120m');
  setTimeout(() => runPaperScan('startup', paperCycleKey(Date.now())), 5000);
  setInterval(() => {
    const now = new Date();
    if (now.getUTCMinutes() % 15 === 0 && now.getUTCSeconds() < 30) {
      runPaperScan('15M close', paperCycleKey(now.getTime()));
    }
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
      time: new Date().toISOString()
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
    send(res, hit.status, hit.body, hit.contentType);
    return;
  }

  try {
    const result = await requestUpstream(target);
    if (result.status >= 200 && result.status < 300) {
      cache.set(key, {...result, expiresAt: Date.now() + cacheTtl(prefix, requestUrl.pathname)});
    }
    send(res, result.status, result.body, result.contentType);
  } catch (error) {
    console.error('[proxy]', prefix, upstreamPath, error.message);
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
