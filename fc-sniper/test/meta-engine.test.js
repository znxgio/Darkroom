const test = require('node:test');
const assert = require('node:assert/strict');
const meta = require('../src/meta-engine');

const NOW = Date.parse('2026-11-26T12:00:00Z');
const player = {
  id: 1001, name: 'Example ST', overall: 90,
  attributes: { pace: 94, shooting: 91, passing: 78, dribbling: 89, physical: 84, finishing: 93, acceleration: 95 },
  playStyles: [{ name: 'Finesse Shot', plus: true }, 'Quick Step', 'Rapid']
};

test('legacy Darkroom player objects adapt without inventing live evidence', () => {
  const adapted = meta.adaptPlayer({ id: 7, name: 'Legacy card', rating: 90,
    stats: { pac: 91, sho: 88, pas: 75, dri: 89, def: 42, phy: 80 },
    playStyles: [{ name: 'Finesse Shot', plus: true }] });
  assert.equal(adapted.overall, 90);
  assert.equal(adapted.attributes.pace, 91);
  assert.equal(adapted.attributes.shooting, 88);
  assert.equal(adapted.playStyles[0].plus, true);
  const result = meta.evaluate(adapted, 'ST', [], { now: NOW });
  assert.equal(result.proMetaScore, null);
  assert.ok(result.warnings.some(x => /No current pro\/community/.test(x)));
});

test('position groups normalize common positions', () => {
  assert.equal(meta.roleGroup('ST'), 'ST');
  assert.equal(meta.roleGroup('LW'), 'W');
  assert.equal(meta.roleGroup('RWB'), 'FB');
  assert.equal(meta.roleGroup('GK'), 'GK');
  assert.equal(meta.roleGroup('UNKNOWN'), null);
});

test('attribute score uses only available role attributes and reports coverage', () => {
  const result = meta.scoreAttributes(player, 'ST');
  assert.equal(result.method, 'position-attributes');
  assert.ok(result.score > 85 && result.score <= 100);
  assert.ok(result.coverage > 0.5);
  assert.equal(meta.scoreAttributes({ overall: 88 }, 'ST').method, 'overall-fallback');
  assert.equal(meta.scoreAttributes({}, 'ST').score, null);
});

test('PlayStyle priors are role-specific and capped', () => {
  const result = meta.playStyleBonus(player, 'ST');
  assert.ok(result.bonus > 0);
  assert.ok(result.hits.some(x => x.name === 'finesse shot' && x.plus));
  assert.ok(result.bonus <= meta.DEFAULTS.maxPlayStyleBonus);
  assert.equal(meta.playStyleBonus(player, 'CB').bonus, 0);
});

test('evidence validation rejects malformed and unsupported entries', () => {
  assert.equal(meta.normalizeEvidence({ kind: 'unknown', value: 99, observedAt: new Date(NOW).toISOString(), sourceReliability: 1 }), null);
  assert.equal(meta.normalizeEvidence({ kind: 'pro', value: 101, observedAt: new Date(NOW).toISOString(), sourceReliability: 1 }), null);
  assert.equal(meta.normalizeEvidence({ kind: 'pro', value: 80, observedAt: 'not a date', sourceReliability: 1 }), null);
});

test('evidence normalization is idempotent for numeric timestamps', () => {
  const first = meta.normalizeEvidence({ kind: 'pro', value: 80, sourceReliability: 1,
    observedAt: new Date(NOW).toISOString() });
  const second = meta.normalizeEvidence(first);
  assert.equal(second.observedAt, NOW);
});

test('pro and community evidence stay separate and blend pro-first', () => {
  const evidence = [
    { kind: 'pro', value: 95, source: 'tournament-data', sourceReliability: 1, sampleSize: 16, metric: 'meta-index', observedAt: new Date(NOW).toISOString() },
    { kind: 'community', value: 60, source: 'community-poll', sourceReliability: 1, sampleSize: 100, metric: 'meta-index', observedAt: new Date(NOW).toISOString() }
  ];
  const result = meta.evaluate(player, 'ST', evidence, { now: NOW });
  assert.equal(result.proMetaScore, 95);
  assert.equal(result.communityMetaScore, 60);
  assert.ok(result.score > 75 && result.score < 95);
  assert.equal(result.breakdown.proWeight, .7);
  assert.equal(result.status, 'scored');
});

test('old evidence decays and evidence freshness is exposed', () => {
  const old = [{ kind: 'pro', value: 100, source: 'old-event', sourceReliability: 1, sampleSize: 20,
    observedAt: new Date(NOW - 180 * 86400000).toISOString() }];
  const recent = [{ kind: 'pro', value: 70, source: 'new-event', sourceReliability: 1, sampleSize: 20,
    observedAt: new Date(NOW).toISOString() }];
  const a = meta.summarizeEvidence(old, NOW, meta.DEFAULTS).pro;
  const b = meta.summarizeEvidence(recent, NOW, meta.DEFAULTS).pro;
  assert.ok(a.evidenceWeight < b.evidenceWeight);
  assert.ok(a.score === 100);
});

test('confidence rises with evidence and independent sources', () => {
  const sparse = meta.evaluate(player, 'ST', [], { now: NOW });
  const rich = meta.evaluate(player, 'ST', Array.from({ length: 12 }, (_, i) => ({
    kind: 'pro', value: 90, source: 'source-' + i, sourceReliability: 1,
    sampleSize: 20, observedAt: new Date(NOW).toISOString()
  })), { now: NOW });
  assert.ok(rich.confidence > sparse.confidence);
  assert.ok(sparse.warnings.some(x => /No current pro\/community/.test(x)));
});

test('missing evidence never gets mislabeled as a live meta score', () => {
  const result = meta.evaluate(player, 'ST', [], { now: NOW });
  assert.equal(result.proMetaScore, null);
  assert.equal(result.communityMetaScore, null);
  assert.ok(result.warnings.length);
});

test('value comparison identifies cheaper near-equivalent players', () => {
  const result = meta.compareValue({ score: 92, price: 300000 }, { score: 94, price: 850000 });
  assert.equal(result.savings, 550000);
  assert.equal(result.scoreGap, -2);
  assert.equal(result.similarPerformance, true);
  assert.equal(meta.compareValue({ score: 90 }, { score: 92, price: 100 }).comparable, false);
});

test('snapshot has versioned schema and source health', () => {
  const result = meta.snapshotMeta({ game: 'FC 27', sourceStatuses: [{ id: 'pro-feed', status: 'ok' }],
    players: [{ playerId: 1, position: 'ST', score: 90, confidence: 80 }] });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.players[0].score, 90);
  assert.equal(result.sourceStatuses[0].status, 'ok');
});


test('provider snapshots use local registry reliability and preserve game context', () => {
  const snapshot = meta.normalizeProviderSnapshot({
    sourceId: 'pro-feed', game: 'FC 27', patch: '1.3', platform: 'PS5',
    generatedAt: new Date(NOW).toISOString(),
    evidence: [{ playerId: 1001, position: 'ST', kind: 'pro', metric: 'player-usage',
      value: 88, sampleSize: 12, sourceReliability: 0.01, observedAt: new Date(NOW).toISOString() }]
  }, { 'pro-feed': { kind: 'pro', reliability: 0.9, allowedMetrics: ['player-usage'] } }, NOW);
  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.evidence[0].sourceReliability, 0.9);
  assert.equal(snapshot.evidence[0].patch, '1.3');
  assert.equal(snapshot.evidence[0].platform, 'PS5');
});

test('provider snapshots reject unregistered, future, stale, and duplicate data', () => {
  const base = { sourceId: 'community-feed', game: 'FC 27', patch: '1.3', platform: 'all',
    generatedAt: new Date(NOW).toISOString(), evidence: [{ playerId: 5, position: 'ST',
      kind: 'community', metric: 'player-usage', value: 70, sampleSize: 50,
      observedAt: new Date(NOW).toISOString() }] };
  const registry = { 'community-feed': { kind: 'community', reliability: 0.6, allowedMetrics: ['player-usage'] } };
  assert.equal(meta.normalizeProviderSnapshot(base, {}, NOW).rejected[0].reason, 'unregistered-source');
  assert.equal(meta.normalizeProviderSnapshot({ ...base, generatedAt: new Date(NOW + 3600000).toISOString() }, registry, NOW).rejected[0].reason, 'future-snapshot');
  assert.equal(meta.normalizeProviderSnapshot({ ...base, generatedAt: new Date(NOW - 60 * 86400000).toISOString() }, registry, NOW).status, 'stale');
  const dup = { ...base, evidence: [...base.evidence, ...base.evidence] };
  const normalized = meta.normalizeProviderSnapshot(dup, registry, NOW);
  assert.equal(normalized.evidence.length, 1);
  assert.equal(normalized.rejected[0].reason, 'duplicate-observation');
});


test('evaluation refuses to blend evidence across patches without explicit context', () => {
  const mixedPatch = [
    { kind: 'pro', value: 90, source: 'pro', sourceReliability: 1, sampleSize: 10, metric: 'meta-index', game: 'FC 27', patch: '1.2', platform: 'PS5', observedAt: new Date(NOW).toISOString() },
    { kind: 'community', value: 80, source: 'community', sourceReliability: 1, sampleSize: 10, metric: 'meta-index', game: 'FC 27', patch: '1.3', platform: 'PS5', observedAt: new Date(NOW).toISOString() }
  ];
  const blocked = meta.evaluate(player, 'ST', mixedPatch, { now: NOW });
  assert.equal(blocked.proMetaScore, null);
  assert.ok(blocked.warnings.some(x => /Mixed patch evidence/.test(x)));
  const selected = meta.evaluate(player, 'ST', mixedPatch, { now: NOW, game: 'FC 27', patch: '1.3', platform: 'PS5', metric: 'meta-index' });
  assert.equal(selected.proMetaScore, null);
  assert.equal(selected.communityMetaScore, 80);
});

test('provider snapshot validation rejects missing sample size and unsupported positions', () => {
  const base = { sourceId: 'pro-feed', game: 'FC 27', patch: '1.3', platform: 'PS5',
    generatedAt: new Date(NOW).toISOString(), evidence: [
      { playerId: 1, position: 'ST', kind: 'pro', metric: 'player-usage', value: 90, observedAt: new Date(NOW).toISOString() },
      { playerId: 2, position: '???', kind: 'pro', metric: 'player-usage', value: 90, sampleSize: 10, observedAt: new Date(NOW).toISOString() }
    ] };
  const normalized = meta.normalizeProviderSnapshot(base, { 'pro-feed': { kind: 'pro', reliability: 0.8, allowedMetrics: ['player-usage'] } }, NOW);
  assert.equal(normalized.evidence.length, 0);
  assert.equal(normalized.rejected.length, 2);
});


test('evaluation refuses to blend different evidence metrics', () => {
  const evidence = [
    { kind: 'pro', value: 90, source: 'pro', sourceReliability: 1, sampleSize: 10, metric: 'player-usage', observedAt: new Date(NOW).toISOString() },
    { kind: 'community', value: 80, source: 'community', sourceReliability: 1, sampleSize: 10, metric: 'community-poll', observedAt: new Date(NOW).toISOString() }
  ];
  const result = meta.evaluate(player, 'ST', evidence, { now: NOW });
  assert.equal(result.proMetaScore, null);
  assert.ok(result.warnings.some(x => /Mixed metric evidence/.test(x)));
});


test('tactics finder ranks formations pro-first and keeps role usage distinct', () => {
  const observations = [
    { dimension: 'formation', key: '4-3-1-2', kind: 'pro', usageShare: 60, sampleSize: 30, source: 'pro-tracker', sourceReliability: 1, game: 'FC 27', patch: '1.3', platform: 'all', observedAt: new Date(NOW).toISOString(), tacticCode: 'CODE4312' },
    { dimension: 'formation', key: '4-3-1-2', kind: 'community', usageShare: 30, sampleSize: 300, source: 'community-tracker', sourceReliability: 1, game: 'FC 27', patch: '1.3', platform: 'all', observedAt: new Date(NOW).toISOString() },
    { dimension: 'formation', key: '4-2-1-3', kind: 'pro', usageShare: 40, sampleSize: 30, source: 'pro-tracker', sourceReliability: 1, game: 'FC 27', patch: '1.3', platform: 'all', observedAt: new Date(NOW).toISOString() },
    { dimension: 'formation', key: '4-2-1-3', kind: 'community', usageShare: 50, sampleSize: 300, source: 'community-tracker', sourceReliability: 1, game: 'FC 27', patch: '1.3', platform: 'all', observedAt: new Date(NOW).toISOString() },
    { dimension: 'role', key: 'Shadow Striker', position: 'CAM', focus: 'Attack', formation: '4-3-1-2', kind: 'pro', usageShare: 65, sampleSize: 30, source: 'pro-tracker', sourceReliability: 1, game: 'FC 27', patch: '1.3', platform: 'all', observedAt: new Date(NOW).toISOString() }
  ];
  const result = meta.rankTactics(observations, { now: NOW, game: 'FC 27', patch: '1.3', platform: 'all' });
  assert.equal(result.status, 'ok');
  assert.equal(result.formations[0].key, '4-3-1-2');
  assert.equal(result.formations[0].proUsageShare, 60);
  assert.equal(result.formations[0].communityUsageShare, 30);
  assert.equal(result.formations[0].metaUsageShare, 51);
  assert.equal(result.formations[0].tacticCode, 'CODE4312');
  assert.equal(result.roles[0].position, 'CAM');
  assert.equal(result.roles[0].key, 'Shadow Striker');
});

test('tactics finder requires explicit context when patches conflict and rejects stale/future rows', () => {
  const base = { dimension: 'formation', key: '4-3-1-2', kind: 'pro', usageShare: 50,
    sampleSize: 20, source: 'pro', sourceReliability: 1, game: 'FC 27', platform: 'PS5' };
  const rows = [
    { ...base, patch: '1.2', observedAt: new Date(NOW).toISOString() },
    { ...base, patch: '1.3', observedAt: new Date(NOW).toISOString() },
    { ...base, patch: '1.3', observedAt: new Date(NOW - 200 * 86400000).toISOString() },
    { ...base, patch: '1.3', observedAt: new Date(NOW + 3600000).toISOString() }
  ];
  const mixed = meta.rankTactics(rows, { now: NOW });
  assert.equal(mixed.status, 'context-required');
  assert.ok(mixed.warnings.some(x => /Mixed patch/.test(x)));
  const scoped = meta.rankTactics(rows, { now: NOW, game: 'FC 27', patch: '1.3', platform: 'PS5' });
  assert.equal(scoped.formations.length, 1);
  assert.ok(scoped.rejected.some(x => x.reason === 'stale-tactics-observation'));
  assert.ok(scoped.rejected.some(x => x.reason === 'future-tactics-observation'));
});
