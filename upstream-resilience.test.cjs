'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(port, child, timeoutMs) {
  const expiresAt = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < expiresAt) {
    if (child.exitCode != null) throw new Error('smoke server exited with code ' + child.exitCode);
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/healthz', {
        signal: AbortSignal.timeout(250)
      });
      if (response.ok) return response.json();
      lastError = new Error('health HTTP ' + response.status);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('smoke server health timeout');
}

async function stopChild(child) {
  const waitForExit = timeoutMs => new Promise(resolve => {
    if (child.exitCode != null || child.signalCode != null) return resolve(true);
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
  if (child.exitCode != null || child.signalCode != null) return;
  const graceful = waitForExit(1500);
  child.kill('SIGTERM');
  if (!(await graceful)) {
    const forced = waitForExit(1500);
    child.kill('SIGKILL');
    if (!(await forced)) {
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
}

test('upstream 429, 5xx, abort timeout and Retry-After stay bounded without taking down the server',
  {timeout: 15000}, async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nexora-retry-smoke-'));
    const stateFile = path.join(stateDir, 'paper-state.json');
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(path.resolve(stateDir).startsWith(tempRoot));
    assert.ok(path.basename(stateDir).startsWith('nexora-retry-smoke-'));
    await fs.promises.copyFile(path.join(__dirname, 'server.js'), path.join(stateDir, 'server.js'));
    await fs.promises.copyFile(path.join(__dirname, 'scan-universe.cjs'), path.join(stateDir, 'scan-universe.cjs'));
    const port = await reservePort();
    const childSource = String.raw`
      const Module = require('node:module');
      const originalLoad = Module._load;
      const requestCounts = new Map();
      const jsonResponse = (status, value, headers) => new Response(JSON.stringify(value), {
        status, headers: {'content-type': 'application/json', ...(headers || {})}
      });
      const fakeFetch = async (target, options) => {
        const scenario = new URL(String(target)).searchParams.get('case');
        const count = (requestCounts.get(scenario) || 0) + 1;
        requestCounts.set(scenario, count);
        process.stderr.write('[mock] ' + scenario + ' ' + count + '\n');
        if (scenario === 'mixed') {
          if (count === 1) return jsonResponse(429, {scenario, count}, {'retry-after': '0'});
          if (count === 2) return jsonResponse(503, {scenario, count});
          return jsonResponse(200, {scenario, count});
        }
        if (scenario === 'abort' && count === 1) {
          return new Promise((resolve, reject) => {
            const fail = () => {
              const error = new Error('simulated upstream timeout');
              error.name = 'AbortError';
              reject(error);
            };
            if (options.signal.aborted) fail();
            else options.signal.addEventListener('abort', fail, {once: true});
          });
        }
        if (scenario === 'long-retry-after') {
          return jsonResponse(429, {scenario, count}, {'retry-after': '30'});
        }
        if (scenario === 'exhaust-5xx') return jsonResponse(503, {scenario, count});
        return jsonResponse(200, {scenario, count});
      };
      const nativeSetTimeout = global.setTimeout;
      global.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback,
        delay === 12000 ? 20 : delay, ...args);
      Module._load = function(request, parent, isMain) {
        if (request === 'node-fetch') return fakeFetch;
        return originalLoad.call(this, request, parent, isMain);
      };
      require('./server.js');
    `;
    const child = spawn(process.execPath, ['-e', childSource], {
      cwd: stateDir,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        PORT: String(port),
        PAPER_BOT_ENABLED: 'false',
        PAPER_STATE_FILE: stateFile,
        PAPER_FALLBACK_ENABLED: 'false'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let childOutput = '';
    child.stdout.on('data', chunk => { childOutput += chunk.toString(); });
    child.stderr.on('data', chunk => { childOutput += chunk.toString(); });
    const request = url => fetch(url, {signal: AbortSignal.timeout(4000)});

    try {
      const health = await waitForHealth(port, child, 5000);
      assert.equal(health.ok, true);
      assert.equal(health.paperBot, false);

      const mixed = await request('http://127.0.0.1:' + port + '/bitget/test?case=mixed');
      assert.equal(mixed.status, 200);
      assert.deepEqual(await mixed.json(), {scenario: 'mixed', count: 3});

      const aborted = await request('http://127.0.0.1:' + port + '/bitget/test?case=abort');
      assert.equal(aborted.status, 200);
      assert.deepEqual(await aborted.json(), {scenario: 'abort', count: 2});

      const longRetryAfter = await request('http://127.0.0.1:' + port + '/bitget/test?case=long-retry-after');
      assert.equal(longRetryAfter.status, 429);
      assert.deepEqual(await longRetryAfter.json(), {scenario: 'long-retry-after', count: 1});

      const exhausted = await request('http://127.0.0.1:' + port + '/bitget/test?case=exhaust-5xx');
      assert.equal(exhausted.status, 503);
      assert.deepEqual(await exhausted.json(), {scenario: 'exhaust-5xx', count: 3});

      const recovered = await request('http://127.0.0.1:' + port + '/healthz');
      assert.equal(recovered.status, 200);
      assert.equal((await recovered.json()).ok, true);
      assert.equal(child.exitCode, null);
    } catch (error) {
      throw new Error(error.message + '\nSmoke child output:\n' + childOutput);
    } finally {
      await stopChild(child);
      for (const suffix of ['', '.bak', '.bak2', '.tmp']) {
        try { await fs.promises.unlink(stateFile + suffix); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await fs.promises.rm(stateDir, {recursive: true, force: true});
    }
  });
