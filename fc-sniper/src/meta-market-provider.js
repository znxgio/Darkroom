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

  function buildValueQuoteIndex(normalized) {
    const index = {};
    for (const quote of (normalized && normalized.quotes) || []) {
      if (!quote.stale && quote.price > 0) index[quote.eaId] = quote;
    }
    return index;
  }

  return Object.freeze({ DEFAULT_MAX_AGE_SECONDS, normalizePriceItem, normalizePriceResponse, buildValueQuoteIndex });
});
