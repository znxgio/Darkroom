const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/meta-engine');
const feed = require('../src/meta-live-feed');
const NOW = Date.parse('2026-11-27T12:00:00Z');
const registry = {
  'licensed-pro': { kind: 'pro', reliability: 0.9, allowedDimensions: ['formation', 'role'], allowedMetrics: ['pro-player-usage'], maxAgeDays: 7 },
  'licensed-community': { kind: 'community', reliability: 0.7, allowedDimensions: ['formation'], allowedMetrics: ['community-player-usage'], maxAgeDays: 7 }
};
const envelope = () => ({
  schemaVersion: 1, game: 'FC 27', patch: '1.3', platform: 'PS5',
  generatedAt: new Date(NOW).toISOString(),
  tacticsSnapshots: [
    { sourceId: 'licensed-pro', game: 'FC 27', patch: '1.3', platform: 'PS5',
      generatedAt: new Date(NOW).toISOString(),
      tactics: [{ dimension: 'formation', key: '4-3-1-2', usageShare: 60, sampleSize: 40, observedAt: new Date(NOW).toISOString() }] },
    { sourceId: 'licensed-community', game: 'FC 27', patch: '1.3', platform: 'PS5',
      generatedAt: new Date(NOW).toISOString(),
      tactics: [{ dimension: 'formation', key: '4-3-1-2', usageShare: 30, sampleSize: 400, observedAt: new Date(NOW).toISOString() }] }
  ],
  playerSnapshots: [{ sourceId: 'licensed-pro', game: 'FC 27', patch: '1.3', platform: 'PS5',
    generatedAt: new Date(NOW).toISOString(),
    evidence: [{ playerId: '1001', position: 'ST', kind: 'pro', metric: 'pro-player-usage',
      value: 88, sampleSize: 20, observedAt: new Date(NOW).toISOString() }] }]
});

test('only accepts HTTPS feed endpoints without embedded credentials', () => {
  assert.equal(feed.parseEndpoint('https://meta.example/api/v1/snapshot').hostname, 'meta.example');
  assert.equal(feed.parseEndpoint('http://meta.example/snapshot'), null);
  assert.equal(feed.parseEndpoint('https://user:secret@meta.example/snapshot'), null);
  assert.equal(feed.parseEndpoint('https://meta.example/snapshot#token'), null);
});
test('feed envelope validates schema, context, and freshness', () => {
  assert.equal(feed.validateEnvelope(envelope(), NOW, 72).ok, true);
  assert.equal(feed.validateEnvelope({ ...envelope(), schemaVersion: 2 }, NOW, 72).reason, 'unsupported-feed-schema');
  assert.equal(feed.validateEnvelope({ ...envelope(), patch: '' }, NOW, 72).reason, 'missing-feed-context');
  assert.equal(feed.validateEnvelope({ ...envelope(), generatedAt: new Date(NOW - 96 * 3600000).toISOString() }, NOW, 72).reason, 'stale-feed');
});
test('live feed normalizes licensed snapshots and ranks pro/community separately', async () => {
  const result = await feed.load({
    endpoint: 'https://meta.example/api/v1/snapshot', engine, sourceRegistry: registry, now: NOW,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://meta.example/api/v1/snapshot');
      assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
      return { ok: true, status: 200, json: async () => envelope() };
    }
  });
  assert.equal(result.status, 'ok'); assert.equal(result.tactics.status, 'ok');
  assert.equal(result.tactics.formations[0].proUsageShare, 60);
  assert.equal(result.tactics.formations[0].communityUsageShare, 30);
  assert.equal(result.playerEvidence.length, 1);
  assert.equal(result.playerEvidence[0].sourceReliability, 0.9);
});
test('manual snapshots use the same validators and retain source provenance', () => {
  const raw = envelope();
  raw.playerSnapshots[0].sourceUrl = 'https://source.example/research/players';
  const result = feed.parseSnapshot(raw, { engine, sourceRegistry: registry, now: NOW });
  assert.equal(result.status, 'ok');
  assert.equal(result.context.patch, '1.3');
  assert.equal(result.playerEvidence[0].url, 'https://source.example/research/players');
});
test('manual snapshots report envelope validation failures', () => {
  const result = feed.parseSnapshot({ schemaVersion: 2 }, { engine, sourceRegistry: registry, now: NOW });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'unsupported-feed-schema');
});
test('feed never trusts provider reliability sent in payload', async () => {
  const raw = envelope(); raw.playerSnapshots[0].evidence[0].sourceReliability = 0.01;
  const result = await feed.load({ endpoint: 'https://meta.example/snapshot', engine, sourceRegistry: registry, now: NOW,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => raw }) });
  assert.equal(result.playerEvidence[0].sourceReliability, 0.9);
});
test('feed reports partial snapshots and preserves rejection reasons', async () => {
  const raw = envelope(); raw.tacticsSnapshots.push({ sourceId: 'unlicensed', game: 'FC 27', patch: '1.3',
    platform: 'PS5', generatedAt: new Date(NOW).toISOString(), tactics: [] });
  const result = await feed.load({ endpoint: 'https://meta.example/snapshot', engine, sourceRegistry: registry, now: NOW,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => raw }) });
  assert.equal(result.status, 'partial');
  assert.ok(result.rejected.some(item => item.reason === 'unregistered-source'));
});
test('feed returns explicit states for network, HTTP, and malformed JSON errors', async () => {
  const base = { endpoint: 'https://meta.example/snapshot', engine, sourceRegistry: registry };
  assert.equal((await feed.load({ ...base, fetchImpl: async () => { throw new Error('offline'); } })).reason, 'feed-request-failed');
  assert.equal((await feed.load({ ...base, fetchImpl: async () => ({ ok: false, status: 503 }) })).reason, 'feed-http-error');
  assert.equal((await feed.load({ ...base, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) })).reason, 'invalid-feed-json');
});
test('invalid endpoint is rejected before any network request', async () => {
  let called = false;
  const result = await feed.load({ endpoint: 'http://not-secure.example/feed', engine,
    fetchImpl: async () => { called = true; } });
  assert.equal(result.reason, 'invalid-or-non-https-endpoint'); assert.equal(called, false);
});
