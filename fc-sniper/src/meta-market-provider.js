/* DataFluxor FUT market adapter.
 * Consumes only Darkroom's own server proxy; never holds provider credentials.
 * Market prices are valuation inputs, not competitive-meta evidence.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DarkroomMetaMarketProvider = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEFAULT_MAX_AGE_SECONDS = 15 * 60;

  function normalizePriceItem(item, now = Date.now(), maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS) {
    if (!item || typeof item !== 'object') return { ok: false, reason: 'invalid-item' };
    const eaId = String(item.ea_id ?? '');
    const price = Number(item.price);
    const observedAt = Date.parse(item.observed_at || item.checked_at || '');
    if (!/^\d{1,12}$/.test(eaId)) return { ok: false, reason: 'invalid-ea-id' };
    if (!Number.isFinite(price) || price < 0) return { ok: false, reason: 'invalid-price' };
    if (!Number.isFinite(observedAt)) return { ok: false, reason: 'missing-observation-time' };
    const ageSeconds = Math.max(0, (now - observedAt) / 1000);
    const stale = item.stale === true || ageSeconds > maxAgeSeconds;
    return { ok: true, quote: {
      eaId, playerId: item.player_id == null ? null : String(item.player_id),
      name: String(item.name || 'Unknown player'), rating: Number(item.rating) || null,
      position: String(item.position || ''), price, platform: String(item.platform || 'ps'),
      market: String(item.market || 'console'), exact: item.exact === true,
      observedAt: new Date(observedAt).toISOString(), ageSeconds: Number(ageSeconds.toFixed(1)),
      stale, availability: String(item.availability || 'unknown'),
      priceSource: String(item.price_source || item.source || 'unknown'),
      cardId: item.futbin_id == null ? null : String(item.futbin_id)
    }};
  }

  function normalizePriceResponse(payload, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const maxAgeSeconds = Number(options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS);
    if (!payload || payload.ok !== true || !payload.data || !Array.isArray(payload.data.items))
      return { status: 'unavailable', reason: 'invalid-market-response', quotes: [], unresolved: [] };
    const quotes = [], rejected = [];
    for (const item of payload.data.items) {
      const normalized = normalizePriceItem(item, now, maxAgeSeconds);
      if (normalized.ok) quotes.push(normalized.quote);
      else rejected.push({ eaId: String(item && item.ea_id || ''), reason: normalized.reason });
    }
    return { status: quotes.length ? (rejected.length ? 'partial' : 'ok') : 'empty',
      provider: 'datafluxor-fut-data', retrievedAt: payload.retrievedAt || null,
      quotes, unresolved: Array.isArray(payload.data.unresolved) ? payload.data.unresolved : [], rejected };
  }

  function parseBaseUrl(value) {
    let url;
    try { url = new URL(String(value || '')); } catch (_) { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    return url;
  }

  function createClient(options = {}) {
    const base = parseBaseUrl(options.baseUrl);
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!base || typeof fetchImpl !== 'function') return null;
    const request = async (path, params) => {
      const url = new URL(path, base.toString().replace(/\\/$/, '') + '/');
      for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
      let response;
      try {
        response = await fetchImpl(url.toString(), { method: 'GET', credentials: 'omit',
          cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
      } catch (_) { return { ok: false, error: 'request-failed' }; }
      if (!response || !response.ok) return { ok: false, error: 'http-error',
        status: Number(response && response.status) || null };
      try { return await response.json(); } catch (_) { return { ok: false, error: 'invalid-json' }; }
    };
    return Object.freeze({
      async searchCards(query, limit = 10) {
        const q = String(query || '').trim();
        if (!q || q.length > 80) return { ok: false, error: 'invalid-search-query' };
        return request('/api/meta/cards/search', { q, limit: Math.max(1, Math.min(20, Number(limit) || 10)) });
      },
      async getPrices(eaIds, platform = 'ps', now = Date.now()) {
        const ids = Array.from(new Set((Array.isArray(eaIds) ? eaIds : []).map(String)));
        if (!ids.length || ids.length > 500 || ids.some(id => !/^\\d{1,12}$/.test(id)))
          return { status: 'unavailable', reason: 'invalid-ea-ids', quotes: [], unresolved: [] };
        if (!['ps', 'xbox', 'pc'].includes(platform))
          return { status: 'unavailable', reason: 'invalid-platform', quotes: [], unresolved: [] };
        const payload = await request('/api/meta/prices', { ea_ids: ids.join(','), platform });
        return normalizePriceResponse(payload, { now });
      }
    });
  }

  function buildValueQuoteIndex(normalized) {
    const index = {};
    for (const quote of (normalized && normalized.quotes) || []) {
      if (!quote.stale && quote.price > 0) index[quote.eaId] = quote;
    }
    return index;
  }

  return Object.freeze({ DEFAULT_MAX_AGE_SECONDS, normalizePriceItem, normalizePriceResponse, parseBaseUrl, createClient, buildValueQuoteIndex });
});
