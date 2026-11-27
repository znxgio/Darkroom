/* Darkroom Live Meta Feed — transport adapter for an authorized Darkroom feed.
 * The userscript never holds third-party provider credentials. A separately hosted
 * feed service must aggregate only licensed/authorized source snapshots.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DarkroomMetaLiveFeed = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SCHEMA_VERSION = 1;
  const DEFAULTS = Object.freeze({ maxEnvelopeAgeHours: 72, timeoutMs: 10000 });

  function parseEndpoint(value) {
    let url;
    try { url = new URL(String(value || '')); } catch (_) { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    return url;
  }

  function validateEnvelope(raw, now, maxAgeHours) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== SCHEMA_VERSION)
      return { ok: false, reason: 'unsupported-feed-schema' };
    if (!raw.game || !raw.patch || !raw.platform) return { ok: false, reason: 'missing-feed-context' };
    const generatedAt = Date.parse(raw.generatedAt || '');
    if (!Number.isFinite(generatedAt)) return { ok: false, reason: 'invalid-feed-timestamp' };
    const ageHours = (now - generatedAt) / 3600000;
    if (ageHours < -5 / 60000) return { ok: false, reason: 'future-feed' };
    if (ageHours > maxAgeHours) return { ok: false, reason: 'stale-feed' };
    if (!Array.isArray(raw.tacticsSnapshots) || !Array.isArray(raw.playerSnapshots))
      return { ok: false, reason: 'invalid-feed-collections' };
    return { ok: true, generatedAt: new Date(generatedAt).toISOString(),
      game: String(raw.game), patch: String(raw.patch), platform: String(raw.platform) };
  }

  async function load(options = {}) {
    const endpoint = parseEndpoint(options.endpoint);
    const empty = { tactics: null, playerEvidence: [], sourceStatuses: [] };
    if (!endpoint) return { status: 'unavailable', reason: 'invalid-or-non-https-endpoint', ...empty };
    const engine = options.engine;
    if (!engine || typeof engine.normalizeTacticsSnapshot !== 'function' ||
        typeof engine.normalizeProviderSnapshot !== 'function' || typeof engine.rankTactics !== 'function')
      return { status: 'unavailable', reason: 'meta-engine-unavailable', ...empty };
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (typeof fetchImpl !== 'function') return { status: 'unavailable', reason: 'fetch-unavailable', ...empty };

    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const maxAgeHours = Number(options.maxEnvelopeAgeHours ?? DEFAULTS.maxEnvelopeAgeHours);
    const timeoutMs = Number(options.timeoutMs ?? DEFAULTS.timeoutMs);
    if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return { status: 'unavailable', reason: 'invalid-feed-policy', ...empty };

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(endpoint.toString(), {
        method: 'GET', headers: { Accept: 'application/json' },
        credentials: 'omit', cache: 'no-store', redirect: 'error',
        ...(controller ? { signal: controller.signal } : {})
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      return { status: 'unavailable',
        reason: error && error.name === 'AbortError' ? 'feed-timeout' : 'feed-request-failed',
        detail: String(error && error.message || error), ...empty };
    }
    if (timer) clearTimeout(timer);
    if (!response || !response.ok) return { status: 'unavailable', reason: 'feed-http-error',
      httpStatus: Number(response && response.status) || null, ...empty };

    let raw;
    try { raw = await response.json(); } catch (_) {
      return { status: 'unavailable', reason: 'invalid-feed-json', ...empty };
    }
    const envelope = validateEnvelope(raw, now, maxAgeHours);
    if (!envelope.ok) return { status: envelope.reason === 'stale-feed' ? 'stale' : 'rejected',
      reason: envelope.reason, ...empty };

    const registry = options.sourceRegistry || {};
    const sourceStatuses = [], tacticsRows = [], playerEvidence = [], rejected = [];
    for (const snapshot of raw.tacticsSnapshots) {
      const normalized = engine.normalizeTacticsSnapshot(snapshot, registry, now,
        { maxSnapshotAgeDays: options.maxSnapshotAgeDays });
      sourceStatuses.push({ id: String(snapshot && snapshot.sourceId || 'unknown'), family: 'tactics',
        status: normalized.status, accepted: normalized.observations.length,
        rejected: normalized.rejected.length, generatedAt: normalized.generatedAt || null });
      tacticsRows.push(...normalized.observations);
      rejected.push(...normalized.rejected.map(item => ({ ...item, sourceId: snapshot && snapshot.sourceId || null })));
    }
    for (const snapshot of raw.playerSnapshots) {
      const normalized = engine.normalizeProviderSnapshot(snapshot, registry, now,
        { maxSnapshotAgeDays: options.maxSnapshotAgeDays });
      sourceStatuses.push({ id: String(snapshot && snapshot.sourceId || 'unknown'), family: 'player-evidence',
        status: normalized.status, accepted: normalized.evidence.length,
        rejected: normalized.rejected.length, generatedAt: normalized.generatedAt || null });
      playerEvidence.push(...normalized.evidence);
      rejected.push(...normalized.rejected.map(item => ({ ...item, sourceId: snapshot && snapshot.sourceId || null })));
    }
    const tactics = engine.rankTactics(tacticsRows, {
      now, game: envelope.game, patch: envelope.patch, platform: envelope.platform
    });
    const acceptedCount = tacticsRows.length + playerEvidence.length;
    return {
      status: acceptedCount ? (rejected.length ? 'partial' : 'ok') : 'empty',
      context: { game: envelope.game, patch: envelope.patch, platform: envelope.platform },
      generatedAt: envelope.generatedAt, tactics, playerEvidence, sourceStatuses, rejected
    };
  }
  return Object.freeze({ SCHEMA_VERSION, DEFAULTS, parseEndpoint, validateEnvelope, load });
});
