'use strict';

const fs = require('node:fs/promises');

// Darkroom server-side market-data proxy.
// Run with DATAFLUXOR_API_KEY set. Never put this key in the userscript/browser.
const http = require('node:http');

const HOST = 'datafluxor.com';
const BASE = 'https://datafluxor.com/api/v1/fut';
const PORT = Number(process.env.PORT || 8787);
const API_KEY = String(process.env.DATAFLUXOR_API_KEY || '').trim();
const META_SNAPSHOT_FILE = String(process.env.DARKROOM_META_SNAPSHOT_FILE || '').trim();
const ALLOWED_ORIGIN = String(process.env.DARKROOM_ALLOWED_ORIGIN || '').trim();
const RATE_LIMIT = Number(process.env.DARKROOM_RATE_LIMIT_PER_MINUTE || 60);
const WINDOW_MS = 60_000;
const TIMEOUT_MS = 8_000;
const buckets = new Map();

function send(res, status, payload, origin) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(origin && ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN
      ? { 'access-control-allow-origin': ALLOWED_ORIGIN, 'vary': 'Origin' } : {})
  });
  res.end(body);
}

function limited(key, now = Date.now()) {
  const old = buckets.get(key);
  if (!old || now - old.start >= WINDOW_MS) {
    buckets.set(key, { start: now, count: 1 });
    return false;
  }
  old.count += 1;
  return old.count > RATE_LIMIT;
}

function parseRequestUrl(req) {
  try { return new URL(req.url, 'http://darkroom.local'); } catch (_) { return null; }
}

async function upstream(path, query) {
  if (!API_KEY) {
    const error = new Error('DATAFLUXOR_API_KEY is not configured');
    error.statusCode = 503;
    throw error;
  }
  const url = new URL(BASE + path);
  for (const [key, value] of query) url.searchParams.set(key, value);
  if (url.hostname !== HOST || url.protocol !== 'https:') throw new Error('Invalid upstream URL');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-API-Key': API_KEY, Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error('Market data provider returned HTTP ' + response.status);
      error.statusCode = response.status === 429 ? 429 : 502;
      error.retryAfter = response.headers.get('retry-after');
      throw error;
    }
    if (!data || data.success !== true || !data.data || typeof data.data !== 'object') {
      const error = new Error('Market data provider returned an invalid response');
      error.statusCode = 502;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function createServer(options = {}) {
  const fetchUpstream = options.upstream || upstream;
  const snapshotFile = options.snapshotFile ?? META_SNAPSHOT_FILE;
  const keyConfigured = options.keyConfigured ?? !!API_KEY;
  return http.createServer(async (req, res) => {
    const url = parseRequestUrl(req);
    const origin = req.headers.origin || '';
    if (!url) return send(res, 400, { ok: false, error: 'bad-request' }, origin);
    if (req.method === 'OPTIONS') {
      if (!ALLOWED_ORIGIN || origin !== ALLOWED_ORIGIN)
        return send(res, 403, { ok: false, error: 'origin-not-allowed' });
      res.writeHead(204, {
        'access-control-allow-origin': ALLOWED_ORIGIN,
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        vary: 'Origin'
      });
      return res.end();
    }
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method-not-allowed' }, origin);
    if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN)
      return send(res, 403, { ok: false, error: 'origin-not-allowed' });
    const client = String(req.socket.remoteAddress || 'unknown');
    if (limited(client)) return send(res, 429, { ok: false, error: 'darkroom-rate-limit' }, origin);

    if (url.pathname === '/health') {
      return send(res, 200, { ok: true, provider: 'datafluxor-fut-data',
        configured: keyConfigured, apiKeyExposedToClient: false }, origin);
    }
    if (url.pathname === '/api/meta/snapshot') {
      if (!snapshotFile) return send(res, 404, { ok: false, error: 'meta-snapshot-not-configured' }, origin);
      try {
        const stat = await fs.stat(snapshotFile);
        if (!stat.isFile() || stat.size > 1_000_000)
          return send(res, 413, { ok: false, error: 'meta-snapshot-too-large-or-invalid' }, origin);
        const raw = await fs.readFile(snapshotFile, 'utf8');
        const snapshot = JSON.parse(raw);
        if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.tacticsSnapshots) ||
            !Array.isArray(snapshot.playerSnapshots))
          return send(res, 502, { ok: false, error: 'meta-snapshot-invalid' }, origin);
        return send(res, 200, snapshot, origin);
      } catch (error) {
        return send(res, error.code === 'ENOENT' ? 404 : 502,
          { ok: false, error: error.code === 'ENOENT' ? 'meta-snapshot-not-found' : 'meta-snapshot-unavailable' }, origin);
      }
    }
    if (!keyConfigured) return send(res, 503, { ok: false, error: 'provider-key-not-configured' }, origin);

    try {
      let result;
      if (url.pathname === '/api/meta/cards/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q || q.length > 80) return send(res, 400, { ok: false, error: 'invalid-search-query' }, origin);
        const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit') || 10) || 10));
        result = await fetchUpstream('/cards/search', [['q', q], ['limit', String(limit)]]);
      } else if (url.pathname === '/api/meta/prices') {
        const ids = (url.searchParams.get('ea_ids') || '').split(',').map(x => x.trim()).filter(Boolean);
        if (!ids.length || ids.length > 500 || ids.some(id => !/^\d{1,12}$/.test(id)))
          return send(res, 400, { ok: false, error: 'invalid-ea-ids' }, origin);
        const platform = url.searchParams.get('platform') || 'ps';
        if (!['ps', 'xbox', 'pc'].includes(platform))
          return send(res, 400, { ok: false, error: 'invalid-platform' }, origin);
        result = await fetchUpstream('/prices', [['ea_ids', ids.join(',')], ['platform', platform]]);
      } else {
        return send(res, 404, { ok: false, error: 'not-found' }, origin);
      }
      return send(res, 200, { ok: true, provider: 'datafluxor-fut-data',
        retrievedAt: new Date().toISOString(), data: result.data }, origin);
    } catch (error) {
      const status = Number(error.statusCode) || (error.name === 'AbortError' ? 504 : 502);
      return send(res, status, { ok: false, error: status === 503 ? 'provider-unavailable' :
        status === 429 ? 'provider-rate-limit' : 'provider-request-failed',
        retryAfter: error.retryAfter || null }, origin);
    }
  });
}

if (require.main === module) {
  if (!API_KEY) process.stderr.write('Warning: DATAFLUXOR_API_KEY is not configured; provider routes will return 503.\n');
  createServer().listen(PORT, '0.0.0.0', () => {
    process.stdout.write('Darkroom meta API listening on port ' + PORT + '\n');
  });
}

module.exports = { createServer, limited, upstream, HOST, BASE };
