'use strict';

// Local Mac companion for Darkroom. It serves a private-use FUT.GG snapshot
// assembled from rendered site pages. It never reuses browser credentials or
// accesses EA, and it is not a public feed or redistribution service.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.DARKROOM_BRIDGE_PORT || 8765);
const DEFAULT_SNAPSHOT_FILE = path.join(os.homedir(), '.darkroom', 'futgg-meta-snapshot.json');
const SNAPSHOT_FILE = process.env.DARKROOM_META_SNAPSHOT_FILE
  ? path.resolve(process.env.DARKROOM_META_SNAPSHOT_FILE) : DEFAULT_SNAPSHOT_FILE;
const PERSONAL_SYNC_ENABLED = process.env.DARKROOM_FUTGG_PERSONAL_SYNC !== '0' &&
  !process.env.DARKROOM_META_SNAPSHOT_FILE;
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
  if (raw.personalUseOnly === true && raw.redistributionAllowed !== false)
    return { ok: false, reason: 'invalid-personal-use-policy' };
  if (raw.authorizedSources != null && (!Array.isArray(raw.authorizedSources) ||
      raw.authorizedSources.some(source => !['futgg-pro', 'futgg-community'].includes(source))))
    return { ok: false, reason: 'invalid-authorized-source-list' };
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
      authorizedSources: snapshot.ok && Array.isArray(snapshot.snapshot.authorizedSources)
        ? snapshot.snapshot.authorizedSources : AUTHORIZED_SOURCES,
      usePolicy: snapshot.ok && snapshot.snapshot.personalUseOnly ? 'personal-only' : null }, origin);
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
    process.stdout.write('Private FUT.GG snapshot file: ' + SNAPSHOT_FILE + '\n');
    if (PERSONAL_SYNC_ENABLED) {
      const sync = async () => {
        try {
          const { syncToFile } = require('./futgg-personal-sync');
          const result = await syncToFile({ filePath: SNAPSHOT_FILE,
            onPage: (url, count) => process.stdout.write('Read rendered FUT.GG page (' + count + ' rows): ' + url + '\n') });
          process.stdout.write('Personal snapshot refreshed locally at ' + result.snapshot.generatedAt + '\n');
        } catch (error) {
          process.stderr.write('FUT.GG personal sync unavailable; keeping manual fallback (' +
            String(error && error.message || error) + ').\n');
        }
      };
      sync();
      const refresh = setInterval(sync, 6 * 60 * 60 * 1000);
      if (typeof refresh.unref === 'function') refresh.unref();
    } else {
      process.stdout.write('Automatic FUT.GG refresh is disabled for this bridge instance.\n');
    }
  });
}
module.exports = { server, validateSnapshot, readSnapshot, HOST, PORT, DEFAULT_SNAPSHOT_FILE };
