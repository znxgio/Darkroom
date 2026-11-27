/* FUT-DB Ultimate Team card-data adapter.
 * Enriches known EA resource IDs with card identity, attributes, roles and PlayStyles.
 * This is card data, not competitive usage or pro-meta evidence.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DarkroomFutDb = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function finite(value) {
    const n = Number(value);
    return Number.isFinite(n) && value !== null && value !== '' ? n : null;
  }

  function normalizePlayer(raw, retrievedAt = new Date().toISOString()) {
    if (!raw || typeof raw !== 'object') return null;
    const resourceId = String(raw.resourceId ?? raw.id ?? '');
    if (!/^\\d{1,12}$/.test(resourceId)) return null;
    const attributes = {};
    const groups = [
      ['paceAttributes', 'pace'], ['shootingAttributes', 'shooting'],
      ['passingAttributes', 'passing'], ['dribblingAttributes', 'dribbling'],
      ['defendingAttributes', 'defending'], ['physicalityAttributes', 'physical'],
      ['goalkeeperAttributes', 'goalkeeping']
    ];
    for (const [source, target] of groups) {
      const row = raw[source];
      if (!row || typeof row !== 'object') continue;
      for (const [key, value] of Object.entries(row)) {
        const n = finite(value);
        if (n !== null) attributes[key] = n;
      }
    }
    const summary = {
      pace: finite(raw.pace), shooting: finite(raw.shooting), passing: finite(raw.passing),
      dribbling: finite(raw.dribbling), defending: finite(raw.defending),
      physical: finite(raw.physicality)
    };
    const result = {
      provider: 'fut-db',
      resourceId,
      playerId: finite(raw.id),
      name: String(raw.name || raw.commonName || [raw.firstName, raw.lastName].filter(Boolean).join(' ') || 'Unknown player'),
      rating: finite(raw.rating),
      position: String(raw.position || ''),
      positions: Array.isArray(raw.positionAlternatives) ? raw.positionAlternatives.filter(x => typeof x === 'string') : [],
      skillMoves: finite(raw.skillMoves),
      weakFoot: finite(raw.weakFoot),
      preferredFoot: raw.foot || null,
      playStyles: Array.isArray(raw.playStyles) ? raw.playStyles.filter(x => typeof x === 'string') : [],
      playStylesPlus: Array.isArray(raw.playStylesPlus) ? raw.playStylesPlus.filter(x => typeof x === 'string') : [],
      roles: Array.isArray(raw.roles) ? raw.roles.filter(x => typeof x === 'string') : [],
      rolesPlusPlus: Array.isArray(raw.rolesPlusPlus) ? raw.rolesPlusPlus.filter(x => typeof x === 'string') : [],
      summary: Object.fromEntries(Object.entries(summary).filter(([,v]) => v !== null)),
      attributes,
      retrievedAt,
      source: 'FUT-DB'
    };
    return result;
  }

  function createClient(options = {}) {
    let base;
    try { base = new URL(String(options.baseUrl || '')); } catch (_) { return null; }
    if (base.protocol !== 'https:' || base.username || base.password || base.hash) return null;
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (typeof fetchImpl !== 'function') return null;
    return Object.freeze({
      async getPlayerByResourceId(resourceId) {
        const id = String(resourceId ?? '');
        if (!/^\\d{1,12}$/.test(id)) return { ok: false, error: 'invalid-resource-id' };
        const url = new URL('/api/meta/futdb/players/resource/' + id, base);
        let response;
        try {
          response = await fetchImpl(url.toString(), { method: 'GET', credentials: 'omit',
            cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
        } catch (_) { return { ok: false, error: 'request-failed' }; }
        if (!response || !response.ok) return { ok: false, error: 'http-error',
          status: Number(response && response.status) || null };
        let payload;
        try { payload = await response.json(); } catch (_) { return { ok: false, error: 'invalid-json' }; }
        const player = normalizePlayer(payload && payload.player, payload && payload.retrievedAt);
        return player ? { ok: true, player } : { ok: false, error: 'invalid-player-data' };
      }
    });
  }

  return Object.freeze({ normalizePlayer, createClient });
});
