'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('../server/futgg-bridge');

test('accepts only versioned snapshot envelopes with context and collections', () => {
  const good = { schemaVersion: 1, game: 'FC 27', patch: '1.0', platform: 'console',
    generatedAt: new Date().toISOString(), tacticsSnapshots: [], playerSnapshots: [] };
  assert.deepEqual(bridge.validateSnapshot(good), { ok: true });
  assert.equal(bridge.validateSnapshot({ ...good, schemaVersion: 2 }).reason, 'unsupported-schema');
  assert.equal(bridge.validateSnapshot({ ...good, tacticsSnapshots: {} }).reason, 'invalid-snapshot-collections');
});

test('rejects oversized snapshot collections', () => {
  const good = { schemaVersion: 1, game: 'FC 27', patch: '1.0', platform: 'console',
    generatedAt: new Date().toISOString(), tacticsSnapshots: Array(501).fill({}), playerSnapshots: [] };
  assert.equal(bridge.validateSnapshot(good).reason, 'snapshot-too-large');
});
