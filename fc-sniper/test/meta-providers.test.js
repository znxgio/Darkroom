'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../src/meta-providers');

test('provider registry describes separate pro and community FUT.GG sources', () => {
  const pro = providers.getProvider('futgg-pro');
  const community = providers.getProvider('futgg-community');
  assert.equal(pro.kind, 'pro');
  assert.equal(community.kind, 'community');
  assert.ok(pro.capabilities.includes('formation-usage'));
  assert.ok(community.capabilities.includes('role-usage'));
});

test('candidate providers do not enable ingestion by default', () => {
  assert.deepEqual(providers.buildEvidenceRegistry(), {});
  const ea = providers.getProvider('ea-community-api');
  assert.equal(ea.status, 'not-available-to-darkroom');
  assert.equal(ea.publicApiSpec, false);
  assert.equal(ea.partnerRetentionDays, 28);
});

test('authorized source registry only emits that source kind and allowed metrics', () => {
  const registry = providers.buildEvidenceRegistry(['futgg-pro']);
  assert.ok(Object.keys(registry).length > 0);
  assert.ok(Object.values(registry).every(row => row.kind === 'pro'));
  assert.ok(Object.values(registry).every(row => row.allowedMetrics.length === 1));
  assert.deepEqual(providers.buildEvidenceRegistry(['futbin-market']), {});
});

test('tactics registry keeps pro and community separate and stays disabled by default', () => {
  assert.deepEqual(providers.buildTacticsRegistry(), {});
  const registry = providers.buildTacticsRegistry(['futgg-pro', 'futgg-community']);
  assert.equal(registry['futgg-pro'].kind, 'pro');
  assert.equal(registry['futgg-community'].kind, 'community');
  assert.ok(registry['futgg-pro'].allowedDimensions.includes('formation'));
  assert.equal(registry['futbin-market'], undefined);
  const combined = providers.buildFeedRegistry(['futgg-pro', 'futgg-community']);
  assert.equal(combined['futgg-pro'].kind, 'pro');
  assert.equal(combined['futgg-pro:pro-formation-usage'].kind, 'pro');
});

test('unknown providers return null', () => {
  assert.equal(providers.getProvider('made-up-provider'), null);
});

test('DataFluxor is a market source and cannot enter meta evidence registries', () => {
  const provider = providers.getProvider('datafluxor-fut-market');
  assert.equal(provider.category, 'market-data');
  assert.equal(provider.automatedIngestion, true);
  assert.deepEqual(provider.evidenceMetrics, []);
  assert.deepEqual(providers.buildEvidenceRegistry(['datafluxor-fut-market']), {});
  assert.equal(providers.buildTacticsRegistry(['datafluxor-fut-market'])['datafluxor-fut-market'], undefined);
});

test('FUTSettings remains a human research reference until an authorized feed exists', () => {
  const provider = providers.getProvider('futsettings-pro');
  assert.equal(provider.kind, 'pro');
  assert.equal(provider.automatedIngestion, false);
  assert.equal(provider.status, 'human-research-only');
  assert.deepEqual(providers.buildTacticsRegistry(), {});
});
