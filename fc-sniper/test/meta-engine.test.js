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

test('pro and community evidence stay separate and blend pro-first', () => {
  const evidence = [
    { kind: 'pro', value: 95, source: 'tournament-data', sourceReliability: 1, sampleSize: 16, metric: 'selection', observedAt: new Date(NOW).toISOString() },
    { kind: 'community', value: 60, source: 'community-poll', sourceReliability: 1, sampleSize: 100, metric: 'usage', observedAt: new Date(NOW).toISOString() }
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
