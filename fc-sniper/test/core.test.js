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

test('planSellPrice modes', () => {
  assert.equal(c.planSellPrice(1000, { sellMode: 'off' }), 0);
  assert.equal(c.planSellPrice(1000, {}), 0);
  assert.equal(c.planSellPrice(1000, { sellMode: 'fixed', sellPrice: 1520 }), 1500);
  assert.ok(c.profit(1000, c.planSellPrice(1000, { sellMode: 'profit', minProfit: 200 })) >= 200);
  // market: list at the player's avg, but never below the profit floor
  assert.equal(c.planSellPrice(40000, { sellMode: 'market', minProfit: 0 }, { avg: 52000 }), 52000);
  const floor = c.breakEvenSell(50000, 1000);
  assert.equal(c.planSellPrice(50000, { sellMode: 'market', minProfit: 1000 }, { avg: 51000 }), floor);
  assert.equal(c.planSellPrice(50000, { sellMode: 'market', minProfit: 1000 }, null), floor);
});

test('effectiveMaxBuy prefers manual, then price check, then default', () => {
  const cfg = { maxBuy: 1000 };
  assert.equal(c.effectiveMaxBuy({ manualMax: 40000, maxBuy: 46750 }, cfg), 40000);
  assert.equal(c.effectiveMaxBuy({ maxBuy: 46750 }, cfg), 46750);
  assert.equal(c.effectiveMaxBuy({}, cfg), 1000);
  assert.equal(c.effectiveMaxBuy(null, cfg), 1000);
});

test('migrateConfig converts old selling options', () => {
  assert.equal(c.migrateConfig({ autoList: true, sellPrice: 5000 }).sellMode, 'fixed');
  assert.equal(c.migrateConfig({ autoList: true, sellPrice: 0 }).sellMode, 'profit');
  assert.equal(c.migrateConfig({ autoList: false }).sellMode, 'off');
  assert.equal(c.migrateConfig({ sellMode: 'market', autoList: true }).sellMode, 'market');
  assert.equal('autoList' in c.migrateConfig({ autoList: true }), false);
});

test('history: newest first, capped, with totals', () => {
  const now = new Date(2026, 10, 10, 18, 0).getTime();
  let h = [];
  h = c.addHistory(h, { at: now - 48 * 3600e3, price: 10000, sell: 12000 });
  h = c.addHistory(h, { at: now - 3600e3, price: 40000, sell: 0 });
  h = c.addHistory(h, { at: now, price: 1000, sell: 1500 });
  assert.equal(h[0].price, 1000);
  const sum = c.summarizeHistory(h, now);
  assert.equal(sum.today.buys, 2);
  assert.equal(sum.today.spent, 41000);
  assert.equal(sum.today.profit, 425);
  assert.equal(sum.all.buys, 3);
  assert.equal(sum.all.profit, 425 + 1400);
  assert.equal(c.addHistory(Array(300).fill({}), { at: 1 }).length, 300);
});

test('discord helpers', () => {
  assert.ok(c.isDiscordWebhook('https://discord.com/api/webhooks/123456/abc-DEF_9'));
  assert.ok(c.isDiscordWebhook(' https://discordapp.com/api/webhooks/1/x '));
  assert.ok(!c.isDiscordWebhook('https://evil.example/api/webhooks/1/x'));
  assert.ok(!c.isDiscordWebhook(''));
  const buy = c.discordPayload('buy', { name: 'Mbappé', price: 26000, sell: 30000, rating: 91, at: 0 });
  assert.match(buy.embeds[0].title, /Mbappé/);
  assert.match(buy.embeds[0].description, /26,000.*\n.*30,000/s);
  assert.equal(c.discordPayload('stop', { reason: 'x' }).embeds[0].description, 'x');
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

// ---- price check ------------------------------------------------------------

/** Fake market: returns listings with buyNowPrice <= maxBuy, at most `page` per search. */
function fakeMarket(listings, { page = 20, failAt = 0, status = 458 } = {}) {
  const calls = [];
  const search = async (maxBuy) => {
    calls.push(maxBuy);
    if (failAt && calls.length === failAt) return { ok: false, status, listings: [] };
    const hits = listings.filter((l) => !maxBuy || l.buyNowPrice <= maxBuy);
    // the market returns results by expiry, not price — shuffle deterministically
    const shuffled = hits.slice().sort((a, b) => (a.tradeId * 7919) % 101 - (b.tradeId * 7919) % 101);
    return { ok: true, listings: shuffled.slice(0, page) };
  };
  return { search, calls };
}

test('findMarketPrice walks down to the cheapest listings', async () => {
  const listings = [];
  for (let i = 0; i < 60; i++) listings.push({ tradeId: i, defId: 231747, buyNowPrice: 50000 + i * 1000 });
  listings.push({ tradeId: 900, defId: 999999, buyNowPrice: 20000 }); // another version of the player
  const m = fakeMarket(listings);
  const r = await c.findMarketPrice(m.search, { defId: 231747 });
  assert.equal(r.ok, true);
  assert.equal(r.lowest, 50000);
  assert.equal(r.avg, 52000); // mean of 50k..54k
  assert.ok(r.steps <= 7);
  assert.equal(m.calls[0], 0); // first search has no price cap
});

test('findMarketPrice handles no listings and EA errors', async () => {
  const empty = await c.findMarketPrice(fakeMarket([]).search, { defId: 1 });
  assert.deepEqual([empty.ok, empty.count, empty.avg], [true, 0, 0]);
  const listings = Array.from({ length: 40 }, (_, i) => ({ tradeId: i, defId: 1, buyNowPrice: 10000 + i * 500 }));
  const failed = await c.findMarketPrice(fakeMarket(listings, { failAt: 2 }).search, { defId: 1 });
  assert.deepEqual([failed.ok, failed.status], [false, 458]);
});

test('findMarketPrice stops at the maximum number of searches', async () => {
  const listings = Array.from({ length: 300 }, (_, i) => ({ tradeId: i, defId: 1, buyNowPrice: 2000 + i * 100 }));
  const m = fakeMarket(listings);
  const r = await c.findMarketPrice(m.search, { defId: 1, maxSteps: 3 });
  assert.ok(m.calls.length <= 4);
  assert.ok(r.ok && r.lowest > 0);
});

test('planMaxBuy: discount under avg, capped by coins', () => {
  assert.deepEqual(c.planMaxBuy(52000, 10, 1e6), { maxBuy: 46750, cappedByCoins: false });
  assert.deepEqual(c.planMaxBuy(52000, 10, 30000), { maxBuy: 30000, cappedByCoins: true });
  assert.deepEqual(c.planMaxBuy(52000, 10, 31234), { maxBuy: 31000, cappedByCoins: true });
  assert.deepEqual(c.planMaxBuy(52000, 10, 100), { maxBuy: 0, cappedByCoins: false });
  assert.deepEqual(c.planMaxBuy(0, 10, 1e6), { maxBuy: 0, cappedByCoins: false });
  assert.equal(c.planMaxBuy(1000, 0, 1e6).maxBuy, 1000);
});

// ---- squads -----------------------------------------------------------------

test('squadRating matches EA formula', () => {
  assert.equal(c.squadRating(Array(11).fill(83)), 83);
  // ten 82s + one 92 — the high card pulls the rating up via excess
  assert.equal(c.squadRating([...Array(10).fill(82), 92]), 83);
  assert.equal(c.squadRating([...Array(10).fill(82), 83]), 82);
  assert.equal(c.squadRating([84, 84, 84, 83, 83, 83, 83, 82, 82, 82, 82]), 83);
  assert.equal(c.squadRating([]), 0);
});

test('squadChemistry: league/nation/club thresholds, out of position, icons', () => {
  const p = (nationId, leagueId, teamId, extra = {}) => ({ nationId, leagueId, teamId, inPosition: true, ...extra });
  // 11 players same league, nation, club → all 3 chem
  assert.equal(c.squadChemistry(Array(11).fill(0).map(() => p(1, 13, 10))).total, 33);
  // all different → 0
  assert.equal(c.squadChemistry(Array(11).fill(0).map((_, i) => p(i + 1, i + 100, i + 200))).total, 0);
  // 3 from one league → 1 each (league needs 3), 2 from a nation → +1
  const r = c.squadChemistry([p(1, 13, 1), p(1, 13, 2), p(2, 13, 3), p(3, 14, 4)]);
  assert.deepEqual(r.each, [2, 2, 1, 0]);
  // out of position gets 0 and doesn't count for others
  const r2 = c.squadChemistry([p(1, 13, 1), p(1, 13, 2), p(1, 13, 3, { inPosition: false })]);
  assert.deepEqual(r2.each, [1, 1, 0]);
  // icon: 3 chem and counts double for nation
  const r3 = c.squadChemistry([p(5, 2118, 0), p(5, 13, 1)]);
  assert.deepEqual(r3.each, [3, 1]);
});

test('topValues', () => {
  assert.deepEqual(c.topValues([{ l: 1 }, { l: 2 }, { l: 1 }, null], 'l', 1), [{ value: 1, count: 2 }]);
});

test('rankUpgrades prefers rating gain that keeps chemistry', () => {
  // different nations and clubs, so league is the only chemistry link
  const mk = (id, rating, leagueId, pos) => ({ id, name: `P${id}`, rating, nationId: id, leagueId, teamId: id, positions: [pos] });
  const squad = Array.from({ length: 11 }, (_, i) => ({ position: i === 10 ? 'ST' : `X${i}`, player: mk(i + 1, i === 10 ? 75 : 85, 13, i === 10 ? 'ST' : `X${i}`) }));
  const cands = [
    { ...mk(100, 86, 13, 'ST'), price: 20000, source: 'market' }, // same league
    { ...mk(101, 87, 99, 'ST'), price: 25000, source: 'market' }, // other league, loses chem
    { ...mk(102, 80, 13, 'ST'), price: 0, source: 'club' }, // owned
    { ...mk(103, 90, 13, 'CB'), price: 1000, source: 'market' }, // wrong position
    { ...mk(1, 85, 13, 'ST'), price: 0, source: 'club' }, // already in squad
  ];
  const r = c.rankUpgrades(squad, 10, cands, { budget: 50000 });
  assert.equal(r[0].id, 100); // +1 rating and keeps the league link
  const other = r.find((x) => x.id === 101);
  assert.ok(!other || other.chemGain < 0, 'other-league striker costs chemistry');
  assert.ok(r.every((x) => x.id !== 103 && x.id !== 1));
  assert.ok(r[0].ratingGain >= 1);
});

// ---- SBC ------------------------------------------------------------------------

const clubPool = (spec) => {
  let id = 1;
  const out = [];
  for (const [rating, n, extra = {}] of spec) for (let i = 0; i < n; i++) {
    const p = { id: id++, rating, rare: false, untradeable: true, ...extra };
    p.cost = c.playerCost(p);
    out.push(p);
  }
  return out;
};

test('parseRequirements', () => {
  const r = c.parseRequirements([
    { key: 'TEAM_RATING', scope: 'GREATER', values: [84], count: -1 },
    { key: 'PLAYER_QUALITY', scope: 'GREATER', values: [3], count: -1 },
    { key: 'PLAYER_RARITY_GROUP', scope: 'GREATER', values: [4], count: 2 },
    { key: 'CHEMISTRY_POINTS', scope: 'GREATER', values: [0], count: -1 },
  ]);
  assert.deepEqual(r.unsupported, []);
  assert.equal(r.constraints.teamRating, 84);
  assert.equal(r.constraints.minQuality, 3);
  assert.equal(r.constraints.rareMin, 2);
  const bad = c.parseRequirements([{ key: 'SAME_LEAGUE_COUNT', scope: 'GREATER', values: [3], count: 5 }, { key: 'CHEMISTRY_POINTS', scope: 'GREATER', values: [20] }]);
  assert.deepEqual(bad.unsupported, ['same league count', 'chemistry']);
});

test('solveSbc reaches team rating with the cheapest mix', () => {
  const pool = clubPool([[86, 2], [85, 3], [84, 6], [83, 10], [82, 10], [81, 5], [75, 20]]);
  const k = c.parseRequirements([{ key: 'TEAM_RATING', scope: 'GREATER', values: [84], count: -1 }]).constraints;
  const sol = c.solveSbc(pool, k);
  assert.ok(sol);
  assert.equal(sol.players.length, 11);
  assert.ok(sol.rating >= 84, `rating ${sol.rating}`);
  assert.equal(new Set(sol.players.map((p) => p.id)).size, 11);
  // cheaper than just using eleven 84s or better
  const naive = pool.filter((p) => p.rating >= 84).sort((a, b) => a.rating - b.rating).slice(0, 11).reduce((a, p) => a + p.cost, 0);
  assert.ok(sol.cost <= naive);
});

test('solveSbc prefers duplicates/storage, respects rare minimum and quality', () => {
  const pool = clubPool([[83, 11, { untradeable: false }], [83, 11, { storage: true }], [76, 4, { rare: true }], [70, 20]]);
  const sol = c.solveSbc(pool, c.parseRequirements([{ key: 'TEAM_RATING', scope: 'GREATER', values: [83] }]).constraints);
  assert.ok(sol.players.every((p) => p.storage), 'uses storage players first');

  const gold = c.parseRequirements([{ key: 'PLAYER_QUALITY', scope: 'GREATER', values: [3], count: -1 }, { key: 'PLAYER_RARITY_GROUP', scope: 'GREATER', values: [4], count: 3 }], 5).constraints;
  const s2 = c.solveSbc(pool, gold);
  assert.equal(s2.players.length, 5);
  assert.ok(s2.players.every((p) => p.rating >= 75));
  assert.ok(s2.players.filter((p) => p.rare).length >= 3);
});

test('solveSbc returns null when impossible', () => {
  const pool = clubPool([[80, 15]]);
  assert.equal(c.solveSbc(pool, c.parseRequirements([{ key: 'TEAM_RATING', scope: 'GREATER', values: [84] }]).constraints), null);
  assert.equal(c.solveSbc(clubPool([[84, 5]]), c.parseRequirements([]).constraints), null);
});

test('solveSbc is fast on a big club', () => {
  const spec = [];
  for (let r = 70; r <= 90; r++) spec.push([r, 25]);
  const pool = clubPool(spec);
  const t = Date.now();
  const sol = c.solveSbc(pool, c.parseRequirements([{ key: 'TEAM_RATING', scope: 'GREATER', values: [86] }]).constraints);
  assert.ok(sol && sol.rating >= 86);
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t}ms`);
});

// ---- pack sorting ---------------------------------------------------------------

test('sortItem', () => {
  assert.equal(c.sortItem({ duplicate: false }), 'club');
  assert.equal(c.sortItem({ duplicate: true, player: true, untradeable: true }), 'storage');
  assert.equal(c.sortItem({ duplicate: true, player: true, untradeable: true }, { storageFull: true }), 'keep');
  assert.equal(c.sortItem({ duplicate: true, player: true, untradeable: false }), 'transfer');
  assert.equal(c.sortItem({ duplicate: true, player: true, untradeable: true, rating: 70 }, { quickSellBelow: 75 }), 'quicksell');
  assert.equal(c.sortItem({ duplicate: true, player: true, untradeable: true, rating: 70, special: true }, { quickSellBelow: 75 }), 'storage');
  assert.equal(c.sortItem({ duplicate: true, player: false, untradeable: true }), 'keep');
});

// ---- positions & lineups ----------------------------------------------------------

test('normPos maps EA ids and side positions', () => {
  assert.equal(c.normPos(25), 'ST');
  assert.equal(c.normPos(4), 'CB');
  assert.equal(c.normPos('LCM'), 'CM');
  assert.equal(c.normPos('rs'), 'ST');
  assert.equal(c.normPos(27), 'LW');
  assert.equal(c.normPos('RWB'), 'RWB');
});

test('every formation has 11 slots with a keeper first', () => {
  for (const [id, f] of Object.entries(c.FORMATIONS)) {
    assert.equal(f.slots.length, 11, id);
    assert.equal(f.slots[0], 'GK', id);
  }
});

test('bestLineup fills every slot in position and uses chemistry', () => {
  let id = 0;
  const mk = (pos, rating, leagueId = 13, nationId = 1) => ({ id: ++id, rating, positions: [pos], leagueId, nationId, teamId: id });
  const players = [
    mk('GK', 84), mk('RB', 83), mk('CB', 85), mk('CB', 84), mk('CB', 80), mk('LB', 82),
    mk('CDM', 84), mk('CDM', 83), mk('CM', 86), mk('CM', 85), mk('CM', 82), mk('CAM', 87),
    mk('RM', 81), mk('LM', 80), mk('ST', 88), mk('ST', 85), mk('RW', 84), mk('LW', 83),
    mk('ST', 89, 53, 9), // better striker, but other league & nation
  ];
  const f = c.FORMATIONS.f4231;
  const r = c.bestLineup(players, f.slots);
  assert.equal(r.filled, 11);
  r.lineup.forEach((p, i) => assert.ok(p.positions.includes(f.slots[i]), `slot ${f.slots[i]}`));
  assert.equal(new Set(r.lineup.map((p) => p.id)).size, 11);
  assert.ok(r.chem >= 25, `chem ${r.chem}`);
  // 4-1-2-1-2 needs two strikers → both used
  const r2 = c.bestLineup(players, c.FORMATIONS.f41212a.slots);
  assert.equal(r2.lineup.filter((p) => p.positions.includes('ST')).length, 2);
});

test('bestLineup leaves a slot empty when nobody fits', () => {
  const r = c.bestLineup([{ id: 1, rating: 80, positions: ['GK'] }], c.FORMATIONS.f442.slots);
  assert.equal(r.filled, 1);
});

test('quality count covering the squad counts as every player; max team rating', () => {
  // as seen in FC 27 "Room To Grow": 11× Quality ≥ Bronze, Team rating ≤ 64
  const r = c.parseRequirements([
    { key: 'PLAYER_QUALITY', scope: 'GREATER', values: [1], count: 11 },
    { key: 'TEAM_RATING', scope: 'LOWER', values: [64], count: -1 },
  ], 11);
  assert.deepEqual(r.unsupported, []);
  assert.equal(r.constraints.minQuality, 1);
  assert.equal(r.constraints.teamRatingMax, 64);
  const pool = clubPool([[60, 6], [63, 6], [70, 6], [80, 6]]);
  const sol = c.solveSbc(pool, r.constraints);
  assert.ok(sol && sol.rating <= 64, `rating ${sol && sol.rating}`);
  // partial quality counts are still manual
  assert.deepEqual(c.parseRequirements([{ key: 'PLAYER_QUALITY', scope: 'GREATER', values: [3], count: 3 }], 11).unsupported, ['quality count']);
});

test('min and max team rating together', () => {
  const k = c.parseRequirements([
    { key: 'TEAM_RATING', scope: 'GREATER', values: [80], count: -1 },
    { key: 'TEAM_RATING', scope: 'LOWER', values: [81], count: -1 },
  ], 11).constraints;
  const sol = c.solveSbc(clubPool([[75, 10], [78, 10], [80, 10], [83, 10], [86, 5]]), k);
  assert.ok(sol && sol.rating >= 80 && sol.rating <= 81, `rating ${sol && sol.rating}`);
  assert.equal(c.solveSbc(clubPool([[86, 15]]), k), null);
});

// ---- trading & bidding --------------------------------------------------------------

test('flipPlan: undercut sell, buy low enough for min profit after tax', () => {
  const p = c.flipPlan(52000, { minProfit: 1000, undercut: 3 });
  assert.equal(p.sell, 50000); // 52000 × 0.97 = 50,440 → rounded down (500 steps above 50k)
  assert.ok(c.profit(p.maxBuy, p.sell) >= 1000);
  assert.ok(c.profit(c.nextPrice(p.maxBuy), p.sell) < 1000, 'max buy is the highest profitable price');
  assert.equal(c.flipPlan(0, {}), null);
  assert.equal(c.flipPlan(300, { minProfit: 5000 }), null); // impossible
  const cheap = c.flipPlan(1000, { minProfit: 50, undercut: 0 });
  assert.ok(cheap && cheap.maxBuy <= 900 && c.profit(cheap.maxBuy, 1000) >= 50);
});

test('bidAmount: only near the end, under max, never above Buy Now', () => {
  assert.equal(c.bidAmount({ expires: 20, currentBid: 0, startingBid: 200, buyNowPrice: 1000 }, 500), 200);
  assert.equal(c.bidAmount({ expires: 20, currentBid: 450, startingBid: 200, buyNowPrice: 1000 }, 500), 500);
  assert.equal(c.bidAmount({ expires: 20, currentBid: 500, startingBid: 200, buyNowPrice: 1000 }, 500), 0); // next 550 > max
  assert.equal(c.bidAmount({ expires: 120, currentBid: 0, startingBid: 200 }, 500, 30), 0); // too early
  assert.equal(c.bidAmount({ expires: 10, currentBid: 0, startingBid: 200, bidState: 'highest' }, 500), 0); // already winning
  assert.equal(c.bidAmount({ expires: 10, currentBid: 950, startingBid: 200, buyNowPrice: 1000 }, 5000), 0); // next bid = Buy Now → buy instead
  assert.equal(c.bidAmount({ expires: 10, currentBid: 9900, startingBid: 200, buyNowPrice: 50000 }, 20000), 10000);
});

test('settleSales records realized profit once', () => {
  const now = Date.now();
  const h = [{ at: now, itemId: 1, price: 40000, sell: 50000 }, { at: now, itemId: 2, price: 1000 }];
  const r = c.settleSales(h, [{ itemId: 1, price: 50000 }, { itemId: 99, price: 5 }], now);
  assert.equal(r.matched, 1);
  assert.equal(r.realized, 47500 - 40000);
  assert.equal(r.history[0].soldFor, 50000);
  const again = c.settleSales(r.history, [{ itemId: 1, price: 50000 }], now);
  assert.equal(again.matched, 0, 'not counted twice');
  const sum = c.summarizeHistory(r.history, now);
  assert.equal(sum.today.soldToday, 1);
  assert.equal(sum.today.realizedToday, 7500);
  assert.equal(sum.all.realized, 7500);
});

test('tradeOpts: min profit is the larger of coins and % of price', () => {
  assert.equal(c.tradeOpts(1800000, { minProfit: 200, minProfitPct: 3, undercut: 3 }).minProfit, 54000);
  assert.equal(c.tradeOpts(5000, { minProfit: 200, minProfitPct: 3, undercut: 3 }).minProfit, 200);
  const p = c.flipPlan(1868000, c.tradeOpts(1868000, { minProfit: 200, minProfitPct: 3, undercut: 3 }));
  assert.ok(p && p.profit >= 0.03 * 1868000 * 0.95, `profit ${p && p.profit}`);
});
