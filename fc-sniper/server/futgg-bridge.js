'use strict';

// Local Mac companion for Darkroom. It only serves a user-supplied, authorized
// snapshot file; it does not scrape FUT.GG, read browser cookies, or access EA.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.DARKROOM_BRIDGE_PORT || 8765);
const SNAPSHOT_FILE = process.env.DARKROOM_META_SNAPSHOT_FILE
  ? path.resolve(process.env.DARKROOM_META_SNAPSHOT_FILE) : '';
const AUTHORIZED_SOURCES = String(process.env.DARKROOM_AUTHORIZED_META_SOURCES || '')
  .split(',').map(value => value.trim()).filter(value => ['futgg-pro', 'futgg-community'].includes(value));
const ALLOWED_ORIGINS = new Set([
  'https://www.ea.com',
  'https://ea.com'
]);

function validateSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== 1)
    return { ok: false, reason: 'unsupported-schema' };
  if (!raw.game || !raw.patch || !raw.platform || !Number.isFinite(Date.parse(raw.generatedAt || '')))
    return { ok: false, reason: 'missing-context-or-timestamp' };
  if (!Array.isArray(raw.tacticsSnapshots) || !Array.isArray(raw.playerSnapshots))
    return { ok: false, reason: 'invalid-snapshot-collections' };
  if (raw.tacticsSnapshots.length > 500 || raw.playerSnapshots.length > 1000)
    return { ok: false, reason: 'snapshot-too-large' };
  return { ok: true };
}

function readSnapshot() {
  if (!SNAPSHOT_FILE) return { ok: false, reason: 'no-authorized-snapshot-configured' };
  let stat;
  try { stat = fs.statSync(SNAPSHOT_FILE); } catch (_) {
    return { ok: false, reason: 'snapshot-file-not-found' };
  }
  if (!stat.isFile() || stat.size > 1024 * 1024)
    return { ok: false, reason: 'snapshot-file-invalid-or-over-1mb' };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); } catch (_) {
    return { ok: false, reason: 'snapshot-file-is-not-valid-json' };
  }
  const checked = validateSnapshot(raw);
  if (!checked.ok) return checked;
  const age = Date.now() - Date.parse(raw.generatedAt);
  if (age < -300000 || age > 72 * 3600000) return { ok: false, reason: 'snapshot-stale-or-future' };
  return { ok: true, snapshot: raw };
}

function send(res, status, body, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Vary': 'Origin'
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    if (String(res.req && res.req.headers && res.req.headers['access-control-request-private-network']) === 'true')
      headers['Access-Control-Allow-Private-Network'] = 'true';
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== HOST + ':' + PORT && host !== 'localhost:' + PORT) {
    send(res, 421, { ok: false, reason: 'invalid-host' }); return;
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    send(res, 403, { ok: false, reason: 'origin-not-allowed' }); return;
  }
  if (req.method === 'OPTIONS') { send(res, 204, {}, origin); return; }
  const url = new URL(req.url, 'http://' + HOST);
  if (req.method === 'GET' && url.pathname === '/health') {
    const snapshot = readSnapshot();
    send(res, 200, { ok: true, service: 'darkroom-mac-bridge', automaticImport: snapshot.ok,
      status: snapshot.ok ? 'snapshot-ready' : 'manual-fallback-required', reason: snapshot.reason || null,
      authorizedSources: AUTHORIZED_SOURCES }, origin);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/meta/snapshot') {
    const result = readSnapshot();
    if (!result.ok) { send(res, 404, { ok: false, reason: result.reason, manualFallback: true }, origin); return; }
    send(res, 200, result.snapshot, origin); return;
  }
  send(res, 404, { ok: false, reason: 'not-found' }, origin);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    process.stdout.write('Darkroom Mac bridge listening at http://' + HOST + ':' + PORT + '\n');
    process.stdout.write(SNAPSHOT_FILE
      ? 'Authorized snapshot file: ' + SNAPSHOT_FILE + '\n'
      : 'No authorized FUT.GG export/feed configured; automatic import will fall back to manual.\n');
  });
}
module.exports = { server, validateSnapshot, readSnapshot, HOST, PORT };
