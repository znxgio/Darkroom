const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../fc-sniper.user.js');

test('price steps follow EA bands', () => {
  assert.equal(c.priceStep(500), 50);
  assert.equal(c.priceStep(1000), 100);
  assert.equal(c.priceStep(12000), 250);
  assert.equal(c.priceStep(75000), 500);
  assert.equal(c.priceStep(250000), 1000);
});

test('roundPrice snaps to valid prices', () => {
  assert.equal(c.roundPrice(1234), 1200);
  assert.equal(c.roundPrice(1234, 'up'), 1300);
  assert.equal(c.roundPrice(10100), 10000);
  assert.equal(c.roundPrice(10, 'up'), 150);
  assert.equal(c.roundPrice(99999999), c.MAX_PRICE);
});

test('next/prev price cross band boundaries', () => {
  assert.equal(c.nextPrice(950), 1000);
  assert.equal(c.nextPrice(1000), 1100);
  assert.equal(c.prevPrice(1000), 950);
  assert.equal(c.prevPrice(10000), 9900);
  assert.equal(c.prevPrice(150), 150);
});

test('tax and profit', () => {
  assert.equal(c.afterTax(10000), 9500);
  assert.equal(c.profit(9000, 10000), 500);
});

test('breakEvenSell guarantees min profit', () => {
  for (const buy of [200, 950, 4300, 18750, 99000, 420000]) {
    const sell = c.breakEvenSell(buy, 300);
    assert.ok(c.profit(buy, sell) >= 300, `buy ${buy} sell ${sell}`);
    assert.equal(c.roundPrice(sell, 'nearest'), sell);
  }
});

test('cacheBustBid cycles and stays under max buy', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const b = c.cacheBustBid(i, 600);
    assert.ok(b < 600);
    seen.add(b);
  }
  assert.ok(seen.size > 3);
  assert.equal(c.cacheBustBid(0, 150), 0);
});

test('pickTargets filters by price, rating and coins', () => {
  const listings = [
    { tradeId: 1, buyNowPrice: 900, rating: 85 },
    { tradeId: 2, buyNowPrice: 700, rating: 83 },
    { tradeId: 3, buyNowPrice: 1200, rating: 86 },
    { tradeId: 4, buyNowPrice: 800, rating: 86 },
  ];
  const cfg = { maxBuy: 1000, minRating: 84, maxBuysPerSearch: 2 };
  assert.deepEqual(c.pickTargets(listings, cfg, 5000).map((l) => l.tradeId), [4, 1]);
  assert.deepEqual(c.pickTargets(listings, cfg, 850).map((l) => l.tradeId), [4]);
});

test('planSellPrice', () => {
  assert.equal(c.planSellPrice(1000, { autoList: false }), 0);
  assert.equal(c.planSellPrice(1000, { autoList: true, sellPrice: 1520 }), 1500);
  assert.ok(c.profit(1000, c.planSellPrice(1000, { autoList: true, minProfit: 200 })) >= 200);
});

test('classifyStatus', () => {
  assert.equal(c.classifyStatus(458), 'captcha');
  assert.equal(c.classifyStatus('521'), 'throttled');
  assert.equal(c.classifyStatus(470), 'coins');
  assert.equal(c.classifyStatus('470'), 'coins');
  assert.equal(c.classifyStatus(461), 'missed');
  assert.equal(c.classifyStatus(401), 'session');
});

test('jitter stays in range', () => {
  assert.equal(c.jitter(100, 200, () => 0), 100);
  assert.equal(c.jitter(100, 200, () => 1), 200);
  assert.equal(c.jitter(200, 100, () => 0.5), 150);
});

// ---- player name lookup -----------------------------------------------------

const DB_JSON = {
  LegendsPlayers: [{ id: 190042, f: 'Zinedine', l: 'Zidane', r: 96 }],
  Players: [
    { id: 231747, f: 'Kylian', l: 'Mbappé Lottin', c: 'Mbappé', r: 91 },
    { id: 209331, f: 'Mohamed', l: 'Salah', r: 89 },
    { id: 239085, f: 'Erling', l: 'Haaland', r: 91 },
    { id: 20801, f: 'Cristiano Ronaldo', l: 'dos Santos Aveiro', c: 'Cristiano Ronaldo', r: 86 },
    { id: 999001, f: 'Ronaldo', l: 'Nazário', c: 'Ronaldo', r: 94 },
    { id: 999002, f: 'Martin', l: 'Ødegaard', r: 89 },
    { id: 231747, f: 'Dup', l: 'Entry', r: 1 },
  ],
};

test('normalizeName strips accents and punctuation', () => {
  assert.equal(c.normalizeName('Mbappé'), 'mbappe');
  assert.equal(c.normalizeName('Ødegaard'), 'odegaard');
  assert.equal(c.normalizeName("N'Golo  Kanté"), 'n golo kante');
});

test('parsePlayerDb reads every list and dedupes ids', () => {
  const db = c.parsePlayerDb(DB_JSON);
  assert.equal(db.length, 7);
  const kyl = db.find((p) => p.id === 231747);
  assert.equal(kyl.name, 'Mbappé');
  assert.equal(kyl.rating, 91);
  assert.equal(db.find((p) => p.id === 209331).name, 'Mohamed Salah');
  assert.deepEqual(c.parsePlayerDb(null), []);
});

test('searchPlayers matches names without accents, by any name word', () => {
  const db = c.parsePlayerDb(DB_JSON);
  assert.equal(c.searchPlayers(db, 'mbappe')[0].id, 231747);
  assert.equal(c.searchPlayers(db, 'kylian')[0].id, 231747);
  assert.equal(c.searchPlayers(db, 'odeg')[0].id, 999002);
  assert.equal(c.searchPlayers(db, 'zidane')[0].id, 190042);
  assert.equal(c.searchPlayers(db, 'mo sal')[0].id, 209331);
  assert.deepEqual(c.searchPlayers(db, 'zzz'), []);
  assert.deepEqual(c.searchPlayers(db, '  '), []);
});

test('searchPlayers ranks exact common-name match first', () => {
  const db = c.parsePlayerDb(DB_JSON);
  const r = c.searchPlayers(db, 'ronaldo');
  assert.equal(r[0].id, 999001); // "Ronaldo" exact beats higher-scoring partials
  assert.equal(r[1].id, 20801);
  assert.equal(c.searchPlayers(db, 'm', 2).length, 2);
});

test('playerForIteration rotates through players', () => {
  const ps = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => c.playerForIteration(ps, i).id), [1, 2, 3, 1, 2]);
  assert.equal(c.playerForIteration([], 0), null);
});

test('migrateConfig converts old comma-separated IDs', () => {
  const m = c.migrateConfig({ defId: '123, 456', maxBuy: 5 });
  assert.deepEqual(m.players.map((p) => p.id), [123, 456]);
  assert.equal(m.defId, undefined);
  assert.deepEqual(c.migrateConfig({}).players, []);
});

// ---- safety -----------------------------------------------------------------

test('clampConfig enforces safety floors', () => {
  const { cfg, changed } = c.clampConfig({ ...c.DEFAULT_CONFIG, delayMin: 500, delayMax: 600, pauseEvery: 0, pauseMin: 1000, pauseMax: 10, searchesPerDay: 99999, sessionMinutes: 999 });
  assert.equal(cfg.delayMin, 3000);
  assert.equal(cfg.delayMax, 4500);
  assert.equal(cfg.pauseEvery, 60);
  assert.equal(cfg.pauseMin, 20000);
  assert.equal(cfg.pauseMax, 20000);
  assert.equal(cfg.searchesPerDay, 1500);
  assert.equal(cfg.sessionMinutes, 120);
  assert.ok(changed.includes('delayMin') && changed.includes('sessionMinutes'));
});

test('default config already satisfies the safety floors', () => {
  assert.deepEqual(c.clampConfig(c.DEFAULT_CONFIG).changed, []);
});

test('usage resets each day', () => {
  const t = new Date(2026, 10, 10, 23, 0).getTime();
  const u = c.usageFor({ day: c.dayKey(t), searches: 5, buys: 1 }, t);
  assert.equal(u.searches, 5);
  const next = c.usageFor(u, t + 2 * 3600e3);
  assert.deepEqual([next.searches, next.buys], [0, 0]);
  assert.deepEqual(c.usageFor(undefined, t).searches, 0);
});

test('canStart respects lockouts and daily limits', () => {
  const now = Date.now();
  const cfg = { searchesPerDay: 10, buysPerDay: 2 };
  assert.equal(c.canStart({}, cfg, now).ok, true);
  const locked = c.canStart({ lockUntil: now + 90 * 60e3, lockReason: 'EA verification' }, cfg, now);
  assert.equal(locked.ok, false);
  assert.match(locked.reason, /EA verification.*1 h 30 min/);
  assert.equal(c.canStart({ lockUntil: now - 1 }, cfg, now).ok, true);
  assert.equal(c.canStart({ usage: { day: c.dayKey(now), searches: 10, buys: 0 } }, cfg, now).ok, false);
  assert.equal(c.canStart({ usage: { day: c.dayKey(now), searches: 0, buys: 2 } }, cfg, now).ok, false);
});

test('lockouts: captcha 3h, market limit 24h, repeated errors 30min', () => {
  assert.equal(c.lockoutFor('captcha'), 3 * 3600e3);
  assert.equal(c.lockoutFor('throttled'), 24 * 3600e3);
  assert.equal(c.lockoutFor('errors'), 30 * 60e3);
  assert.equal(c.lockoutFor('missed'), 0);
  assert.equal(c.formatDuration(45 * 60e3), '45 min');
  assert.equal(c.formatDuration(3 * 3600e3), '3 h');
});
