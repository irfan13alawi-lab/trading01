const express = require('express');
const cors = require('cors');

// Node 18+ provides fetch. The fallback keeps compatibility with the
// existing VPS setup, which already has node-fetch installed.
const fetchFn = globalThis.fetch || require('node-fetch');

const app = express();
const PORT = Number(process.env.PORT || 18085);
const REQUEST_TIMEOUT_MS = 12000;

const APIS = {
  '/bitget': 'https://api.bitget.com',
  '/bingx': 'https://open-api.bingx.com',
  '/gate': 'https://api.gateio.ws',
  '/altme': 'https://api.alternative.me',
  '/coingecko': 'https://api.coingecko.com',
  '/coinpaprika': 'https://api.coinpaprika.com'
};

const cache = new Map();

app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.get('/healthz', (_req, res) => {
  res.json({ok: true, service: 'nexora-proxy', port: PORT, time: new Date().toISOString()});
});

function queryPart(req) {
  const idx = req.originalUrl.indexOf('?');
  return idx >= 0 ? req.originalUrl.slice(idx) : '';
}

function cacheTtl(prefix, path) {
  if (prefix === '/coingecko') return path.includes('/ohlc') || path.includes('/market_chart') ? 300000 : 30000;
  if (path.includes('/candles')) return 60000;
  if (path.includes('/tickers')) return 5000;
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

for (const [prefix, base] of Object.entries(APIS)) {
  app.use(prefix, async (req, res) => {
    const target = base + req.path + queryPart(req);
    const key = req.originalUrl;
    const ttl = cacheTtl(prefix, req.path);
    const now = Date.now();
    const hit = cache.get(key);

    if (hit && hit.expiresAt > now) {
      res.status(hit.status).set('Content-Type', hit.contentType).send(hit.body);
      return;
    }

    try {
      const result = await requestUpstream(target);
      if (result.status >= 200 && result.status < 300) {
        cache.set(key, {...result, expiresAt: Date.now() + ttl});
      }
      res.status(result.status).set('Content-Type', result.contentType).send(result.body);
    } catch (error) {
      console.error('[proxy]', prefix, req.path, error.message);
      res.status(502).json({error: 'Upstream unavailable', detail: error.message});
    }
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Nexora proxy listening on HTTP :${PORT}`);
});
