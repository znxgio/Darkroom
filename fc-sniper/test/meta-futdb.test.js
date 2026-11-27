'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const futdb = require('../src/meta-futdb');
const { createServer } = require('../server/meta-api');

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try { await run(base); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('normalizes FUT-DB EA card data without fabricating missing attributes', () => {
  const player = futdb.normalizePlayer({
    id: 99, resourceId: 231747, name: 'Example Striker', rating: 91, position: 'ST',
    pace: 95, shooting: 90, passing: 80, dribbling: 92, defending: 40, physicality: 85,
    skillMoves: 5, weakFoot: 4, playStyles: ['Quick Step'], playStylesPlus: ['Finesse Shot'],
    roles: ['Advanced Forward'], paceAttributes: { acceleration: 96, sprintSpeed: 94 },
    shootingAttributes: { finishing: 93 }
  }, '2026-11-26T12:00:00.000Z');
  assert.equal(player.resourceId, '231747');
  assert.equal(player.summary.pace, 95);
  assert.equal(player.attributes.acceleration, 96);
  assert.equal(player.attributes.finishing, 93);
  assert.deepEqual(player.playStylesPlus, ['Finesse Shot']);
  assert.equal(player.attributes.strength, undefined);
  assert.equal(futdb.normalizePlayer({ resourceId: 'not-an-id' }), null);
});

test('browser adapter calls only the Darkroom proxy and validates EA resource IDs', async () => {
  let request;
  const client = futdb.createClient({ baseUrl: 'https://meta.darkroom.example',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, json: async () => ({ ok: true, provider: 'fut-db',
        retrievedAt: '2026-11-26T12:00:00.000Z',
        player: { resourceId: 231747, name: 'Example', rating: 91 } }) };
    } });
  assert.equal((await client.getPlayerByResourceId('bad')).error, 'invalid-resource-id');
  const result = await client.getPlayerByResourceId('231747');
  assert.equal(result.ok, true);
  assert.equal(result.player.resourceId, '231747');
  assert.equal(request.url, 'https://meta.darkroom.example/api/meta/futdb/players/resource/231747');
  assert.equal(request.init.credentials, 'omit');
});

test('FUT-DB server route proxies exact EA resource IDs without exposing its token', async () => {
  let requested;
  await withServer({ keyConfigured: false, futdbKeyConfigured: true,
    futdbUpstream: async path => { requested = path; return { player: { resourceId: 231747, name: 'Example' } }; }
  }, async base => {
    const bad = await fetch(base + '/api/meta/futdb/players/resource/abc');
    assert.equal(bad.status, 400);
    const response = await fetch(base + '/api/meta/futdb/players/resource/231747');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(requested, '/api/players/res/231747');
    assert.equal(body.provider, 'fut-db');
    assert.equal(body.player.resourceId, 231747);
    assert.equal(JSON.stringify(body).includes('X-AUTH-TOKEN'), false);
  });
});

test('FUT-DB endpoint fails closed when server key is absent', async () => {
  await withServer({ keyConfigured: false, futdbKeyConfigured: false }, async base => {
    const response = await fetch(base + '/api/meta/futdb/players/resource/231747');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'futdb-key-not-configured');
  });
});
