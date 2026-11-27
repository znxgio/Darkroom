'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/meta-api');

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { await run('http://127.0.0.1:' + address.port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('health route reports configuration without exposing credentials', async () => {
  await withServer({ keyConfigured: true }, async base => {
    const response = await fetch(base + '/health');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.configured, true);
    assert.equal(body.apiKeyExposedToClient, false);
  });
});

test('search route validates input and proxies only normalized provider data', async () => {
  let called;
  await withServer({ keyConfigured: true, upstream: async (path, query) => {
    called = { path, query };
    return { success: true, data: { cards: [{ ea_id: 123 }] } };
  } }, async base => {
    const bad = await fetch(base + '/api/meta/cards/search');
    assert.equal(bad.status, 400);
    const good = await fetch(base + '/api/meta/cards/search?q=Example&limit=5');
    const body = await good.json();
    assert.equal(good.status, 200);
    assert.equal(called.path, '/cards/search');
    assert.deepEqual(called.query, [['q', 'Example'], ['limit', '5']]);
    assert.equal(body.data.cards[0].ea_id, 123);
  });
});

test('price route restricts platform and validates numeric EA item IDs', async () => {
  let called = false;
  await withServer({ keyConfigured: true, upstream: async () => {
    called = true; return { success: true, data: { items: [] } };
  } }, async base => {
    assert.equal((await fetch(base + '/api/meta/prices?ea_ids=1x&platform=ps')).status, 400);
    assert.equal((await fetch(base + '/api/meta/prices?ea_ids=1&platform=unknown')).status, 400);
    const good = await fetch(base + '/api/meta/prices?ea_ids=123,456&platform=ps');
    assert.equal(good.status, 200);
    assert.equal(called, true);
  });
});

test('provider credentials are not required from the browser and missing server key fails closed', async () => {
  await withServer({ keyConfigured: false }, async base => {
    const response = await fetch(base + '/api/meta/cards/search?q=Example');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'provider-key-not-configured');
  });
});

test('unknown routes and non-GET methods are rejected', async () => {
  await withServer({ keyConfigured: true }, async base => {
    assert.equal((await fetch(base + '/not-a-route')).status, 404);
    assert.equal((await fetch(base + '/health', { method: 'POST' })).status, 405);
  });
});
