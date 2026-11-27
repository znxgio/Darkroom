'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const market = require('../src/meta-market-provider');

const NOW = Date.parse('2026-11-26T12:00:00Z');

test('normalizes fresh market prices with exact card identity and provenance', () => {
  const result = market.normalizePriceResponse({ ok: true, retrievedAt: new Date(NOW).toISOString(),
    data: { items: [{ ea_id: 1234, player_id: 88, futbin_id: 991, name: 'Example', rating: 90,
      position: 'ST', price: 125000, platform: 'ps', market: 'console', exact: true,
      observed_at: new Date(NOW - 60_000).toISOString(), stale: false, price_source: 'card' }] } }, { now: NOW });
  assert.equal(result.status, 'ok');
  assert.equal(result.quotes[0].eaId, '1234');
  assert.equal(result.quotes[0].price, 125000);
  assert.equal(result.quotes[0].exact, true);
  assert.equal(result.quotes[0].stale, false);
  assert.equal(result.quotes[0].priceSource, 'card');
});

test('marks old prices stale even when upstream flag is false', () => {
  const result = market.normalizePriceItem({ ea_id: 2, price: 100, observed_at: new Date(NOW - 3600_000).toISOString(), stale: false }, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.quote.stale, true);
});

test('rejects malformed ids, prices, and timestamps', () => {
  assert.equal(market.normalizePriceItem({ ea_id: '1x', price: 1, observed_at: new Date(NOW).toISOString() }, NOW).reason, 'invalid-ea-id');
  assert.equal(market.normalizePriceItem({ ea_id: 1, price: -1, observed_at: new Date(NOW).toISOString() }, NOW).reason, 'invalid-price');
  assert.equal(market.normalizePriceItem({ ea_id: 1, price: 1 }, NOW).reason, 'missing-observation-time');
});

test('does not expose stale or zero prices to the value comparison index', () => {
  const normalized = market.normalizePriceResponse({ ok: true, data: { items: [
    { ea_id: 1, price: 100, observed_at: new Date(NOW - 60_000).toISOString() },
    { ea_id: 2, price: 200, observed_at: new Date(NOW - 3600_000).toISOString() },
    { ea_id: 3, price: 0, observed_at: new Date(NOW - 60_000).toISOString() }
  ] } }, { now: NOW });
  const index = market.buildValueQuoteIndex(normalized);
  assert.deepEqual(Object.keys(index), ['1']);
});

test('invalid provider envelope fails closed', () => {
  assert.equal(market.normalizePriceResponse({ success: true, data: { items: [] } }).status, 'unavailable');
});
