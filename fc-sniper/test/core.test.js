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
  const chem = c.parseRequirements([{ key: 'SAME_LEAGUE_COUNT', scope: 'GREATER', values: [5], count: -1 }, { key: 'CHEMISTRY_POINTS', scope: 'GREATER', values: [20] }]);
  assert.deepEqual(chem.unsupported, []);
  assert.equal(chem.constraints.chemMin, 20);
  assert.equal(chem.constraints.groups.league.sameMin, 5);
  assert.ok(chem.constraints.needsSearch);
  assert.deepEqual(c.parseRequirements([{ key: 'LEGEND_COUNT', scope: 'GREATER', values: [1] }]).unsupported, ['legend count']);
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
  // "Min. 3 players: Gold" is a count requirement
  const q = c.parseRequirements([{ key: 'PLAYER_QUALITY', scope: 'GREATER', values: [3], count: 3 }], 11);
  assert.deepEqual(q.unsupported, []);
  assert.deepEqual(q.constraints.idReqs, [{ type: 'quality', ids: [3], min: 3 }]);
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

// ---- market scanner ---------------------------------------------------------------

test('aggregateListings groups by card and counts bids', () => {
  const L = [
    { tradeId: 1, defId: 10, name: 'A', rating: 84, buyNowPrice: 5000, currentBid: 0 },
    { tradeId: 2, defId: 10, name: 'A', rating: 84, buyNowPrice: 4000, currentBid: 3000 },
    { tradeId: 3, defId: 10, name: 'A', rating: 84, buyNowPrice: 6000, currentBid: 0 },
    { tradeId: 3, defId: 10, name: 'A', rating: 84, buyNowPrice: 6000, currentBid: 0 }, // duplicate listing
    { tradeId: 4, defId: 11, name: 'B', rating: 85, buyNowPrice: 9000, currentBid: 0 },
  ];
  const r = c.aggregateListings(L);
  const a = r.find((x) => x.id === 10);
  assert.deepEqual([a.count, a.bids, a.minBin, a.medianBin], [3, 1, 4000, 5000]);
});

test('rankHot: demand and supply win, over-budget and thin cards drop out', () => {
  const cards = [
    { id: 1, name: 'Busy', count: 12, bids: 8, minBin: 9000, medianBin: 10000 },
    { id: 2, name: 'Quiet', count: 12, bids: 0, minBin: 9900, medianBin: 10000 },
    { id: 3, name: 'Thin', count: 2, bids: 2, minBin: 5000, medianBin: 6000 },
    { id: 4, name: 'Pricey', count: 15, bids: 10, minBin: 300000, medianBin: 320000 },
  ];
  const r = c.rankHot(cards, { budget: 100000, minListings: 3 });
  assert.deepEqual(r.map((x) => x.name), ['Busy', 'Quiet']);
  assert.ok(r[0].score > r[1].score);
});

test('snipeScore: tight markets score 0, wide ones get a suggested Snipe %', () => {
  const mk = (bins) => ({ id: 1, name: 'X', count: bins.length, minBin: bins[0], medianBin: bins[Math.floor(bins.length / 2)], bins });
  assert.equal(c.snipeScore(mk([10000, 10050, 10100, 10120, 10150, 10200])).score, 0);
  assert.equal(c.snipeScore(mk([9000, 10000, 10000])).score, 0); // fewer than 4 listings
  const w = c.snipeScore(mk([8000, 8500, 9000, 10000, 10000, 10100, 10200, 10300, 10400]));
  assert.ok(w.score > 0 && w.deep === 3);
  assert.ok(w.suggest >= 3 && w.suggest <= 12);
  assert.match(w.reason, /3 of 9 listings/);
  assert.equal(c.snipeScore(mk([8000, 8500, 9000, 10000, 10000]), { budget: 5000 }).score, 0);
  assert.equal(c.snipeScore(mk([1000, 9000, 10000, 10000])).suggest, 12); // clamped
});

// ---- meta lineups -----------------------------------------------------------------

test('readStats handles different Web App field shapes', () => {
  assert.deepEqual(c.readStats({ attributes: [95, 88, 80, 92, 40, 78], skillMoves: 5, weakFoot: 4 }),
    { stats: { pac: 95, sho: 88, pas: 80, dri: 92, def: 40, phy: 78 }, skillMoves: 5, weakFoot: 4 });
  assert.deepEqual(c.readStats({ _attributes: [{ value: 70 }, { value: 60 }, { value: 65 }, { value: 68 }, { value: 80 }, { value: 85 }] }).stats,
    { pac: 70, sho: 60, pas: 65, dri: 68, def: 80, phy: 85 });
  assert.equal(c.readStats({ rating: 80 }).stats, null);
  assert.equal(c.readStats({ weakFootAbilityTypeCode: 3 }).weakFoot, 3);
});

test('metaScore weights the stats that matter per position', () => {
  const fastST = { rating: 86, stats: { pac: 97, sho: 87, pas: 75, dri: 90, def: 35, phy: 76 }, skillMoves: 4, weakFoot: 4 };
  const slowST = { rating: 88, stats: { pac: 68, sho: 91, pas: 78, dri: 82, def: 40, phy: 85 }, skillMoves: 3, weakFoot: 3 };
  assert.ok(c.metaScore(fastST, 'ST') > c.metaScore(slowST, 'ST'), 'pacey striker is more meta');
  const cb = { rating: 85, stats: { pac: 82, sho: 40, pas: 65, dri: 66, def: 86, phy: 87 } };
  assert.ok(c.metaScore(cb, 'CB') > c.metaScore(cb, 'ST'));
  assert.equal(c.metaScore({ rating: 84 }, 'ST'), 84, 'falls back to rating');
  assert.equal(c.metaScore({ rating: 84, stats: cb.stats }, 'GK'), 84);
});

test('bestLineup by meta picks the pacey striker, by rating the higher-rated one', () => {
  let id = 0;
  const mk = (pos, rating, stats) => ({ id: ++id, rating, positions: [pos], leagueId: 13, nationId: 1, teamId: id, stats });
  const base = ['GK', 'RB', 'CB', 'CB', 'LB', 'CM', 'CM', 'CM', 'RW', 'LW'].map((p) => mk(p, 84));
  const fast = mk('ST', 86, { pac: 97, sho: 87, pas: 75, dri: 90, def: 35, phy: 76 });
  const slow = mk('ST', 88, { pac: 68, sho: 91, pas: 78, dri: 82, def: 40, phy: 85 });
  const slots = c.FORMATIONS.f433.slots;
  const byMeta = c.bestLineup([...base, fast, slow], slots, { by: 'meta' });
  const byRating = c.bestLineup([...base, fast, slow], slots, { by: 'rating' });
  assert.equal(byMeta.lineup[slots.indexOf('ST')].id, fast.id);
  assert.equal(byRating.lineup[slots.indexOf('ST')].id, slow.id);
  assert.ok(byMeta.meta > 0);
});

// ---- priority list ------------------------------------------------------------------

test('listSpendable: coins minus keep, capped by what is left of the limit', () => {
  assert.equal(c.listSpendable({ minCoins: 10000, spendLimit: 0 }, 215000), 205000);
  assert.equal(c.listSpendable({ minCoins: 0, spendLimit: 200000, listSpent: 150000 }, 215000), 50000);
  assert.equal(c.listSpendable({ minCoins: 0, spendLimit: 100000, listSpent: 120000 }, 215000), 0);
});

test('reserveOk keeps coins for players higher on the list', () => {
  const players = [{ id: 1, manualMax: 150000 }, { id: 2, manualMax: 60000 }, { id: 3, manualMax: 40000 }];
  const cfg = { reserveForHigher: true, maxBuy: 1000 };
  assert.equal(c.reserveOk(players, 2, 40000, 200000, cfg), true); // 160k left ≥ 150k
  assert.equal(c.reserveOk(players, 2, 60000, 200000, cfg), false); // 140k left < 150k
  assert.equal(c.reserveOk(players, 0, 150000, 150000, cfg), true); // top of the list
  assert.equal(c.reserveOk(players, 2, 60000, 200000, { ...cfg, reserveForHigher: false }), true);
});

test('afterListBuy counts spend and removes the player once bought', () => {
  const cfg = { buyOnce: true, listSpent: 1000, players: [{ id: 1 }, { id: 2 }] };
  assert.deepEqual(c.afterListBuy(cfg, 1, 50000), { listSpent: 51000, players: [{ id: 2 }] });
  assert.equal(c.afterListBuy({ ...cfg, buyOnce: false }, 1, 5).players.length, 2);
});

test('freeCoins: open bids come off the coins and the spend limit', () => {
  assert.equal(c.freeCoins({ mode: 'trade', minCoins: 10000 }, 100000, []), 90000);
  assert.equal(c.freeCoins({ mode: 'trade', minCoins: 10000 }, 100000, [{ amount: 30000 }, { amount: 20000 }]), 40000);
  // EA already took a debited bid off the balance — don't subtract it twice
  assert.equal(c.freeCoins({ mode: 'trade', minCoins: 10000 }, 70000, [{ amount: 30000, debited: true }]), 60000);
  // ...but it still counts against the spend limit (Buy mode only)
  assert.equal(c.freeCoins({ mode: 'buy', minCoins: 0, spendLimit: 100000, listSpent: 50000 }, 500000, [{ amount: 30000, debited: true }]), 20000);
  assert.equal(c.freeCoins({ mode: 'trade', minCoins: 0, spendLimit: 100000, listSpent: 50000 }, 500000, [{ amount: 30000 }]), 470000);
  assert.equal(c.freeCoins({ mode: 'buy', minCoins: 90000 }, 100000, [{ amount: 30000 }]), 0); // never negative
  assert.equal(c.freeCoins({ mode: 'buy', minCoins: 0, spendLimit: 0 }, 1000, undefined), 1000);
});

test('bidBlock: a bid obeys Keep coins, spend limit, buy limit, buy-once and the reserve', () => {
  const p1 = { id: 1, manualMax: 150000 };
  const p2 = { id: 2, manualMax: 60000 };
  const trade = { mode: 'trade', minCoins: 50000, maxBuys: 10, players: [p1, p2] };
  assert.equal(c.bidBlock(30000, p1, trade, 100000, [], 0), '');
  // Keep coins: 100k - 50k keep - 30k open bid = 20k free
  assert.equal(c.bidBlock(30000, p1, trade, 100000, [{ amount: 30000, player: p1 }], 0), 'coins');
  assert.equal(c.bidBlock(20000, p1, trade, 100000, [{ amount: 30000, player: p1 }], 0), ''); // Trade mode may hold several copies
  assert.equal(c.bidBlock(20000, p1, trade, 70000, [{ amount: 30000, player: p1, debited: true }], 0), '');
  assert.equal(c.bidBlock(20250, p1, trade, 70000, [{ amount: 30000, player: p1, debited: true }], 0), 'coins');
  // session buy limit: open bids count as buys that may still happen
  assert.equal(c.bidBlock(1000, p1, { ...trade, maxBuys: 2 }, 100000, [{ amount: 1000, player: p1 }], 1), 'buys');
  assert.equal(c.bidBlock(1000, p1, { ...trade, maxBuys: 2 }, 100000, [], 2), 'buys');
  assert.equal(c.bidBlock(1000, p1, { ...trade, maxBuys: 2 }, 100000, [], 1), '');

  const buy = { mode: 'buy', minCoins: 0, maxBuys: 10, buyOnce: true, spendLimit: 100000, listSpent: 60000, players: [p1, p2], maxBuy: 1000 };
  // spend limit: 40k left, 30k already bid
  assert.equal(c.bidBlock(10000, p2, buy, 900000, [{ amount: 30000, player: p1 }], 0), '');
  assert.equal(c.bidBlock(10250, p2, buy, 900000, [{ amount: 30000, player: p1 }], 0), 'coins');
  assert.equal(c.bidBlock(10250, p2, buy, 900000, [{ amount: 30000, player: p1, debited: true }], 0), 'coins');
  // buy each player once: an open bid on him, or already bought (off the list)
  assert.equal(c.bidBlock(1000, p1, buy, 900000, [{ amount: 1000, player: { id: 1 } }], 0), 'once');
  assert.equal(c.bidBlock(1000, { id: 3 }, buy, 900000, [], 0), 'once');
  assert.equal(c.bidBlock(1000, p1, { ...buy, buyOnce: false }, 900000, [{ amount: 1000, player: p1 }], 0), '');
  // a filter is never ticked off, and has no place in the reserve order
  assert.equal(c.bidBlock(1000, { id: 'f1', kind: 'filter' }, buy, 900000, [{ amount: 1000, player: { id: 'f1', kind: 'filter' } }], 0), '');
  // keep coins for higher players: p2 may only bid what leaves p1's 150k
  const res = { ...buy, spendLimit: 0, reserveForHigher: true };
  assert.equal(c.bidBlock(50000, p2, res, 200000, [], 0), '');
  assert.equal(c.bidBlock(50250, p2, res, 200000, [], 0), 'reserve');
  assert.equal(c.bidBlock(30000, p2, res, 200000, [{ amount: 30000, player: p1 }], 0), 'reserve'); // 170k free - 30k < 150k
  assert.equal(c.bidBlock(150000, p1, res, 200000, [], 0), ''); // top of the list
  assert.equal(c.bidBlock(1000, undefined, { mode: 'buy', maxBuys: 5, buyOnce: true, players: [] }, 5000, [], 0), ''); // no player (plain filter search)
});

test('rankUpgrades by meta finds stat upgrades and chemistry sidegrades', () => {
  const mk = (id, rating, leagueId, nationId, pos, stats) => ({ id, name: `P${id}`, rating, nationId, leagueId, teamId: id, positions: [pos], stats });
  // ST slot: 84 with poor pace; others share league 13
  const squad = Array.from({ length: 11 }, (_, i) => ({ position: i === 10 ? 'ST' : `X${i}`,
    player: i === 10 ? mk(11, 84, 99, 50, 'ST', { pac: 70, sho: 85, pas: 70, dri: 78, def: 40, phy: 80 }) : mk(i + 1, 84, 13, 1, `X${i}`) }));
  const pacey = { ...mk(100, 84, 99, 50, 'ST', { pac: 96, sho: 84, pas: 72, dri: 88, def: 35, phy: 75 }), price: 9000, source: 'market' };
  const sameLeague = { ...mk(101, 84, 13, 1, 'ST', { pac: 70, sho: 85, pas: 70, dri: 78, def: 40, phy: 80 }), price: 8000, source: 'market' };
  const r = c.rankUpgrades(squad, 10, [pacey, sameLeague], { budget: 20000, by: 'meta' });
  assert.ok(r.find((x) => x.id === 100), 'same rating but more meta = upgrade');
  assert.ok(r.find((x) => x.id === 101 && x.chemGain > 0), 'same level with more chemistry = sidegrade');
  assert.equal(c.rankUpgrades(squad, 10, [pacey, sameLeague], { budget: 20000 }).length, 1, 'by rating only the chem sidegrade counts');
});

test('baseId: every version of a player maps to the same base', () => {
  assert.equal(c.baseId(231747), 231747);
  assert.equal(c.baseId(50563395), 50563395 & 0xFFFFFF);
  assert.equal(c.baseId((3 << 24) + 231747), 231747);
  assert.equal(c.baseId(undefined), 0);
});

// ---- chemistry & group SBCs -------------------------------------------------------------

const F433 = ['GK', 'RB', 'CB', 'CB', 'LB', 'CM', 'CM', 'CM', 'RW', 'ST', 'LW'];
/** A club: for every position, cheap players spread over many leagues, plus a few from league 13. */
function chemClub() {
  let id = 0;
  const out = [];
  const add = (pos, rating, leagueId, nationId, extra = {}) => {
    const p = { id: ++id, rating, positions: [pos], leagueId, nationId, teamId: 1000 + id, rare: false, untradeable: true, ...extra };
    p.cost = c.playerCost(p);
    out.push(p);
  };
  for (const pos of new Set(F433)) {
    for (let i = 0; i < 4; i++) add(pos, 76 + i, 100 + out.length, 200 + out.length); // all different leagues/nations
    add(pos, 79, 13, 14); add(pos, 80, 13, 14); // two per position in league 13, nation 14
  }
  return out;
}

test('sbcCheck counts chemistry, groups and ids', () => {
  const lineup = F433.map((pos, i) => ({ id: i, rating: 80, positions: [pos], leagueId: 13, nationId: i, teamId: i, rare: i < 2 }));
  const k = c.parseRequirements([
    { key: 'CHEMISTRY_POINTS', scope: 'GREATER', values: [33] },
    { key: 'SAME_LEAGUE_COUNT', scope: 'GREATER', values: [11] },
    { key: 'NATION_COUNT', scope: 'GREATER', values: [5] },
    { key: 'LEAGUE_ID', scope: 'GREATER', values: [13], count: 5 },
  ]).constraints;
  const r = c.sbcCheck(lineup, F433, k);
  assert.equal(r.chem, 33);
  assert.ok(r.ok, JSON.stringify(r.issues));
  const out = lineup.slice(); out[9] = { ...out[9], positions: ['CB'] }; // striker out of position
  assert.ok(!c.sbcCheck(out, F433, k).ok);
});

test('solveSbcSearch meets a chemistry target by grouping a league', () => {
  const pool = chemClub();
  const k = c.parseRequirements([{ key: 'CHEMISTRY_POINTS', scope: 'GREATER', values: [20] }], 11).constraints;
  const sol = c.solveSbcSearch(pool, F433, k);
  assert.ok(sol, 'found a solution');
  const check = c.sbcCheck(sol.players, F433, k);
  assert.ok(check.ok && check.chem >= 20, JSON.stringify(check));
  assert.equal(new Set(sol.players.map((p) => p.id)).size, 11);
});

test('solveSbcSearch: max same league + min leagues + min from a league', () => {
  const pool = chemClub();
  const k = c.parseRequirements([
    { key: 'SAME_LEAGUE_COUNT', scope: 'LOWER', values: [3] },
    { key: 'LEAGUE_COUNT', scope: 'GREATER', values: [5] },
    { key: 'LEAGUE_ID', scope: 'GREATER', values: [13], count: 2 },
  ], 11).constraints;
  const sol = c.solveSbcSearch(pool, F433, k);
  assert.ok(sol, 'found a solution');
  const check = c.sbcCheck(sol.players, F433, k);
  assert.ok(check.ok, JSON.stringify(check.issues));
  assert.ok(sol.players.filter((p) => p.leagueId === 13).length >= 2);
});

test('solveSbcSearch: rating + chemistry together, and impossible returns null', () => {
  const pool = chemClub();
  const k = c.parseRequirements([{ key: 'TEAM_RATING', scope: 'GREATER', values: [79] }, { key: 'CHEMISTRY_POINTS', scope: 'GREATER', values: [15] }], 11).constraints;
  const sol = c.solveSbcSearch(pool, F433, k);
  assert.ok(sol && sol.rating >= 79 && sol.chem >= 15, sol && `${sol.rating}/${sol.chem}`);
  const impossible = c.parseRequirements([{ key: 'TEAM_RATING', scope: 'GREATER', values: [90] }], 11).constraints;
  assert.equal(c.solveSbcSearch(pool, F433, { ...impossible, needsSearch: true }), null);
});

test('solveSbcSearch prefers cheaper (club) over costly (market) when both work', () => {
  const pool = chemClub();
  // market copies: same players but expensive
  const market = pool.slice(0, 20).map((p) => ({ ...p, id: p.id + 5000, cost: p.cost * 10, market: true }));
  const k = c.parseRequirements([{ key: 'CHEMISTRY_POINTS', scope: 'GREATER', values: [10] }], 11).constraints;
  const sol = c.solveSbcSearch([...pool, ...market], F433, k);
  assert.ok(sol && sol.players.every((p) => !p.market));
});

test('SBC fill-ins: spend the fewest coins, use your own players first', () => {
  const W = c.COIN_WEIGHT;
  const mkt = (rating, price, i) => ({ id: `m${rating}-${i}`, rating, rare: false, market: true, price, cost: W * price + 2000 });
  // club: ten 84s; need 85 → buy a couple, never replace club players needlessly
  const club = clubPool([[84, 10]]);
  const market = [mkt(84, 900, 0), mkt(85, 1400, 0), mkt(85, 1400, 1), mkt(86, 2200, 0), mkt(86, 2200, 1), mkt(87, 3200, 0), mkt(88, 5000, 0), mkt(89, 9000, 0), mkt(89, 9000, 1)];
  const k = c.parseRequirements([{ key: 'TEAM_RATING', scope: 'GREATER', values: [85] }]).constraints;
  const sol = c.solveSbc([...club, ...market], k);
  assert.ok(sol && sol.rating >= 85);
  const buys = sol.players.filter((p) => p.market);
  assert.ok(buys.length >= 1 && buys.length <= 4, `${buys.length} buys`);
  assert.ok(!buys.some((p) => p.rating === 84), 'never buys a card your club already covers');
  // cheaper in coins wins: 87s at 3,200 beat 89s at 9,000 when both reach the target
  const total = buys.reduce((a, p) => a + p.price, 0);
  assert.ok(total <= 9000, `spent ${total}`);
});

test('marketLevel: quality from rating limits', () => {
  const lvl = (reqs) => c.marketLevel(c.parseRequirements(reqs).constraints);
  assert.equal(lvl([{ key: 'PLAYER_MAX_OVR', scope: 'GREATER', values: [64] }]), 'bronze'); // "each ≤ 64" (Break Away)
  assert.equal(lvl([{ key: 'PLAYER_MIN_OVR', values: [65] }, { key: 'PLAYER_MAX_OVR', values: [74] }]), 'silver'); // A Brace
  assert.equal(lvl([{ key: 'PLAYER_MIN_OVR', values: [75] }, { key: 'PLAYER_MAX_OVR', values: [84] }]), 'gold');
  assert.equal(lvl([{ key: 'TEAM_RATING', scope: 'GREATER', values: [84] }]), 'gold');
  assert.equal(lvl([{ key: 'PLAYER_QUALITY', scope: 'LOWER', values: [2], count: -1 }]), 'silver');
  assert.equal(lvl([]), null);
});

test('FC 27 Evolutions-style rule: key 40 + attribute 1 = OVR min', () => {
  const r = c.parseRequirements([{ key: 'ACADEMY_PLAYER_SLOTTING', scope: 'GREATER', values: [45], count: -1 }, { key: 'PLAYER_ATTRIBUTE', scope: 'GREATER', values: [1], count: -1 }], 20);
  assert.deepEqual(r.unsupported, []);
  assert.equal(r.constraints.minOvr, 45);
  assert.deepEqual(c.parseRequirements([{ key: 'ACADEMY_PLAYER_SLOTTING', values: [80] }, { key: 'PLAYER_ATTRIBUTE', values: [7] }]).unsupported, ['attribute 7 minimum']);
});

test('planPoints: spare cards first by value per point, then cheapest coins per point', () => {
  const club = [
    { id: 1, points: 280, cost: 1100 }, // 81: ~3.9 per point
    { id: 2, points: 20, cost: 200 }, // bronze: 10 per point
    { id: 3, points: 5500, cost: 30000 }, // 87: 5.5 per point
    { id: 4, points: 280, cost: 300, baseId: 1 }, // storage duplicate of #1 — only one copy counts
  ];
  const market = [{ id: 'm1', points: 900, price: 1500 }, { id: 'm2', points: 280, price: 1000 }, { id: 'm3', points: 900, price: 1600 }];
  const r = c.planPoints(1000, club, market);
  assert.equal(r.fromClub[0].id, 4, 'cheapest per point first');
  assert.ok(!r.fromClub.some((p) => p.id === 1), 'one copy per player');
  assert.ok(r.clubPoints + r.buyPoints >= 1000 && r.short === 0);
  const big = c.planPoints(30000, [], market);
  assert.equal(big.buys[0].id, 'm1', 'best coins per point first');
  assert.ok(big.short > 0, 'reports what is still missing');
  assert.equal(c.planPoints(0, club, market).cards, 0);
  assert.equal(c.planPoints(30000, Array.from({ length: 45 }, (_, i) => ({ id: i, points: 280, cost: 1000 })), []).handIns, 3);
});

// ---- multi-filter search -------------------------------------------------------------

test('pickTargets respects a rating range', () => {
  const L = [{ tradeId: 1, buyNowPrice: 900, rating: 83 }, { tradeId: 2, buyNowPrice: 800, rating: 85 }, { tradeId: 3, buyNowPrice: 700, rating: 87 }];
  assert.deepEqual(c.pickTargets(L, { maxBuy: 1000, minRating: 84, maxRating: 86 }, 5000).map((l) => l.tradeId), [2]);
});

test('filterSummary and sniperTargets', () => {
  assert.equal(c.filterSummary({ level: 'gold', rarity: '1', league: 13, minRating: 84, maxRating: 86, position: 'ST' }, { rarity: 'Rare' }), 'Gold · Rare · Premier League · 84–86 · ST');
  assert.equal(c.filterSummary({}), 'Any player');
  assert.equal(c.filterSummary({ minRating: 85 }), '85+');
  const cfg = { players: [{ id: 1 }], filters: [{ id: 'f1', on: true }, { id: 'f2', on: false }] };
  assert.deepEqual(c.sniperTargets(cfg).map((t) => t.id), [1, 'f1']);
});

// ---- hot-card sourcing -------------------------------------------------------------

test('priceBands: narrow, descending, valid prices, cover down to ~8%', () => {
  const b = c.priceBands(50000);
  assert.equal(b.length, 5);
  assert.equal(b[0][1], 50000);
  b.forEach(([lo, hi], i) => {
    assert.ok(lo < hi && c.roundPrice(lo) === lo && c.roundPrice(hi) === hi);
    assert.ok(hi / lo < 1.8, 'narrow');
    if (i) assert.ok(hi < b[i - 1][0], 'no overlap');
  });
  assert.ok(b[b.length - 1][0] <= 5000);
  assert.deepEqual(c.priceBands(800), []);
});

test('provenFlips: profitable sales from the last 14 days, best first', () => {
  const now = Date.now();
  const h = [
    { id: 1, name: 'A', price: 10000, soldFor: 12000, at: now - 7200e3, soldAt: now - 3600e3 },
    { id: 1, name: 'A', price: 10000, soldFor: 11500, at: now - 9000e3, soldAt: now - 5000e3 },
    { id: 2, name: 'B', price: 10000, soldFor: 10000, at: now - 3600e3, soldAt: now }, // loss after tax
    { id: 3, name: 'C', price: 5000, soldFor: 9000, at: now - 30 * 864e5, soldAt: now - 29 * 864e5 }, // too old
    { id: 4, name: 'D', price: 5000 }, // not sold
  ];
  const p = c.provenFlips(h, now);
  assert.deepEqual(p.map((x) => x.id), [1]);
  assert.equal(p[0].flips, 2);
  assert.equal(p[0].profit, 11400 - 10000 + 10925 - 10000);
  assert.equal(p[0].avgHours, 1.1);
});

test('flipValue: liquidity, demand and proven history count', () => {
  const plan = { profit: 1000 };
  assert.equal(c.flipValue({ plan: null }), 0);
  assert.ok(c.flipValue({ plan, listed: 10 }) > c.flipValue({ plan, listed: 2 }));
  assert.ok(c.flipValue({ plan, listed: 10, bids: 5, count: 10 }) > c.flipValue({ plan, listed: 10 }));
  assert.ok(c.flipValue({ plan, listed: 10, proven: {} }) > c.flipValue({ plan, listed: 10 }));
});

// ---- SBC players in the upgrade advisor ---------------------------------------------

test('priceLadder: cheapest per rating, never more than a higher rating', () => {
  const m = c.priceLadder([{ rating: 84, price: 2000 }, { rating: 84, price: 1500 }, { rating: 83, price: 1800 }, { rating: 85, price: 1200 }, { rating: 0, price: 5 }]);
  assert.deepEqual(m, { 83: 1200, 84: 1200, 85: 1200 });
});

test('sbcCostEstimate: cheapest cards per rating for each challenge', () => {
  const ladder = { 82: 600, 83: 800, 84: 1200, 85: 3000, 86: 6000, 87: 12000 };
  const k = (teamRating) => ({ ...c.parseRequirements([{ key: 'TEAM_RATING', scope: 'GREATER', values: [teamRating], count: -1 }]).constraints });
  const e = c.sbcCostEstimate([k(84), k(85)], ladder);
  assert.equal(e.solved, 2);
  assert.ok(e.cost >= 11 * 1200 && e.cost <= 11 * 1200 + 11 * 3000, String(e.cost));
  const one = c.sbcCostEstimate([k(84)], ladder).cost;
  assert.ok(one <= 11 * 1200, 'mixing ratings is never dearer than all 84s');
  assert.equal(c.sbcCostEstimate([k(95)], ladder).unknown, 1);
  assert.equal(c.sbcCostEstimate([k(84)], {}).unknown, 1);
});

test('withinReach / huntTargets: skip players your coins can never snipe', () => {
  assert.equal(c.withinReach(241000, 2917000), false);
  assert.equal(c.withinReach(241000, 677000), false);
  assert.equal(c.withinReach(176000, 193000), true);
  assert.equal(c.withinReach(5000, 0), true, 'unpriced players stay in');
  const cfg = { players: [{ id: 1, outOfReach: true }, { id: 2 }, { id: 3, outOfReach: true, manualMax: 100000 }], filters: [{ id: 'f', on: true }] };
  assert.deepEqual(c.huntTargets(cfg).map((p) => p.id), [2, 3, 'f']);
});

// ---- smart sniping ---------------------------------------------------------------------

const seeded = (seed = 1) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

test('smartLevels: even steps between min and max', () => {
  assert.deepEqual(c.smartLevels(4, 14), [4, 6, 8, 10, 12, 14]);
  assert.deepEqual(c.smartLevels(5, 10), [5, 7, 9, 10]);
  assert.deepEqual(c.smartLevels(12, 6), [12]);
});

test('betaSample: mean close to a/(a+b)', () => {
  const r = seeded(7);
  let sum = 0;
  for (let i = 0; i < 4000; i++) sum += c.betaSample(3, 7, r);
  assert.ok(Math.abs(sum / 4000 - 0.3) < 0.02, String(sum / 4000));
});

test('chooseDiscount: learns the discount that actually pays', () => {
  const levels = c.smartLevels(4, 14);
  // deep discounts never show anything; 6% gets regular lost races and buys
  const arms = { 4: { n: 40, hits: 2, misses: 6, near: 4 }, 6: { n: 60, hits: 3, misses: 8, near: 6 }, 8: { n: 60, near: 1 }, 10: { n: 80 }, 12: { n: 80 }, 14: { n: 80 } };
  const r = seeded(3);
  const counts = {};
  for (let i = 0; i < 500; i++) { const p = c.chooseDiscount(arms, levels, r).pct; counts[p] = (counts[p] || 0) + 1; }
  assert.ok((counts[6] || 0) + (counts[4] || 0) > 400, JSON.stringify(counts));
  assert.ok((counts[6] || 0) > (counts[4] || 0), 'saves more at the same rate');
  // with no data every arm gets explored
  const fresh = {};
  for (let i = 0; i < 600; i++) { const p = c.chooseDiscount({}, levels, r).pct; fresh[p] = 1; }
  assert.equal(Object.keys(fresh).length, levels.length);
});

test('chooseTarget: searches go where coins are saved, not to dead targets', () => {
  const levels = [6, 10];
  const dead = { key: 'a', avg: 196000, arms: { 6: { n: 300 }, 10: { n: 300 } } };
  const live = { key: 'b', avg: 20000, arms: { 6: { n: 100, hits: 4, misses: 10 }, 10: { n: 60, misses: 3 } } };
  const r = seeded(11);
  let b = 0;
  for (let i = 0; i < 300; i++) if (c.chooseTarget([dead, live], levels, r).target.key === 'b') b++;
  assert.ok(b > 200, String(b));
});

test('recordArm: one score per search, lost races weighted, near misses on their own counters', () => {
  let arms = c.recordArm({}, 6, { miss: 3, missWeight: 0.4, at: 1 }); // 3 lost listings in one search = one score
  assert.equal(arms[6].n, 1);
  assert.equal(arms[6].good, 0.4);
  arms = c.recordArm(arms, 6, { hit: 2, at: 2 });
  assert.equal(arms[6].good, 1.4, 'a buy scores 1 per search, however many listings');
  assert.ok(arms[6].good <= arms[6].n);
  arms = c.recordArm(arms, 8, { probe: true, probeArm: 6, nearArm: 6, at: 3 });
  assert.deepEqual([arms[8].n, arms[6].probes, arms[6].near, arms[6].n], [1, 1, 1, 2], 'near credit goes to the shallower arm without adding a search to it');
  assert.equal(c.bestArm(arms, [6, 8], 3).pct, 6);
});

test('armPrior: pessimistic and falling with depth', () => {
  const m = (d) => { const p = c.armPrior(d); return p.a / (p.a + p.b); };
  assert.ok(m(4) > 0.015 && m(4) < 0.025, String(m(4)));
  assert.ok(m(14) < m(4) / 3);
});

test('decayArm: halves every 7 days, keeps at least 30 searches', () => {
  const day = 864e5;
  const a = c.decayArm({ n: 400, good: 8, near: 2, probes: 40, last: 0.001 }, 0.001 + 7 * day);
  assert.ok(Math.abs(a.n - 200) < 1e-6 && Math.abs(a.good - 4) < 1e-6);
  const b = c.decayArm({ n: 40, good: 2, last: 1 }, 1 + 70 * day);
  assert.ok(Math.abs(b.n - 30) < 1e-6, 'floor of 30');
  assert.equal(c.decayArm({ n: 20, good: 1, last: 1 }, 1 + 70 * day).n, 20, 'small arms keep everything');
});

test('missWeight, deepestArmFor, priceShifted, upgradeArm', () => {
  assert.equal(c.missWeight({ n: 0, lost: 0 }), 0.4);
  assert.ok(Math.abs(c.missWeight({ n: 20, lost: 2 }) - 0.8 * 19 / 22) < 1e-9);
  assert.equal(c.missWeight({ n: 40, lost: 40 }), 0.2, 'a phone that always loses: floor');
  assert.equal(c.deepestArmFor(18900, 20000, [4, 6, 8]), 4, '5.5% under: only the 4% arm catches it');
  assert.equal(c.deepestArmFor(18000, 20000, [4, 6, 8, 10, 12]), 10);
  assert.equal(c.deepestArmFor(19800, 20000, [4, 6]), undefined);
  assert.equal(c.priceShifted(20000, 23500), true);
  assert.equal(c.priceShifted(20000, 22000), false);
  assert.deepEqual(c.upgradeArm({ n: 10, hits: 3, misses: 20 }).good, 10, 'old per-listing counts capped at n');
});

// ---- bid wars ------------------------------------------------------------------------

test('warCeiling: a little over your max, never over avg−3%, profitable price or Buy Now', () => {
  const cfg = { bidWarStretchPct: 8 };
  assert.equal(c.warCeiling({ maxBid: 10000, avg: 20000, buyNow: 30000, mode: 'buy' }, cfg), 10750);
  assert.equal(c.warCeiling({ maxBid: 19000, avg: 20000, buyNow: 30000, mode: 'buy' }, cfg), 19250, 'avg − 3%');
  assert.equal(c.warCeiling({ maxBid: 19000, avg: 0, buyNow: 15000, mode: 'buy' }, cfg), 14750, 'under Buy Now');
  assert.equal(c.warCeiling({ maxBid: 9000, avg: 12000, mode: 'trade', plan: { maxBuy: 9250 } }, cfg), 9250, 'profitable price');
  assert.equal(c.warCeiling({ maxBid: 9000, avg: 12000, mode: 'trade' }, cfg), 0, 'trade without a plan: no war');
});

test('warSteps counts valid bid steps up to the ceiling', () => {
  assert.equal(c.warSteps(10000, 10750), 3); // 10,250 · 10,500 · 10,750
  assert.equal(c.warSteps(10750, 10750), 0);
  assert.equal(c.warSteps(0, 200), 2); // 150 · 200
});

test("binVsWar follows the user's priority rule", () => {
  const cfg = { binIdealPct: 20, warKeepPct: 10 };
  assert.equal(c.binVsWar(15500, 17500, 20000, cfg), 'ideal', 'Buy Now 22.5% under always wins');
  assert.equal(c.binVsWar(17500, 17750, 20000, cfg), 'war', 'war still 11% under beats an ordinary Buy Now');
  assert.equal(c.binVsWar(17500, 18500, 20000, cfg), 'bin', 'war only 7.5% under: Buy Now wins');
  assert.equal(c.binVsWar(17500, 0, 20000, cfg), 'bin', 'war out of room');
  assert.equal(c.binVsWar(17500, 15000, 0, cfg), 'bin', 'no average: take the sure thing');
});

test('migrateConfig switches bidding on once (2.4.0)', () => {
  const a = c.migrateConfig({ bidSnipe: false });
  assert.equal(a.bidSnipe, true);
  assert.equal(c.migrateConfig({ ...a, bidSnipe: false }).bidSnipe, false, 'user can turn it off again');
});

test('tradeCap: per-card limit from a fixed amount and/or a % of free coins', () => {
  assert.equal(c.tradeCap({ minCoins: 0, tradeBudget: 0, tradeBudgetPct: 25 }, 200000), 50000);
  assert.equal(c.tradeCap({ minCoins: 100000, tradeBudget: 0, tradeBudgetPct: 25 }, 200000), 25000, 'only coins above Keep coins');
  assert.equal(c.tradeCap({ minCoins: 0, tradeBudget: 30000, tradeBudgetPct: 25 }, 200000), 30000, 'the lower of the two');
  assert.equal(c.tradeCap({ minCoins: 0, tradeBudget: 0, tradeBudgetPct: 0 }, 200000), 200000, 'no caps: all free coins');
  assert.equal(c.tradeCap({ minCoins: 300000, tradeBudgetPct: 25 }, 200000), 0);
});

test('migrateConfig 2.4.2: new trade defaults only replace old defaults', () => {
  const a = c.migrateConfig({ minProfitPct: 3, listDuration: 3600, maxBuys: 10 });
  assert.deepEqual([a.minProfitPct, a.listDuration, a.maxBuys], [4, 10800, 12]);
  const b = c.migrateConfig({ minProfitPct: 7, listDuration: 21600, maxBuys: 3 });
  assert.deepEqual([b.minProfitPct, b.listDuration, b.maxBuys], [7, 21600, 3], 'your own values stay');
});

test('robustPrice: median of the cheapest, ignores a lone dumped listing', () => {
  assert.equal(c.robustPrice([10000, 10200, 10300, 10500, 12000]), 10250); // median 10,300 → nearest valid price
  assert.equal(c.robustPrice([5000, 10200, 10300, 10500, 10600, 15000]), 10500, 'a 50% dump is ignored');
  assert.equal(c.robustPrice([10000, 30000, 30000, 30000, 30000]), 30000, 'one cheap outlier does not drag it');
  assert.equal(c.robustPrice([9000, 9500]), 9300); // 9,250 rounds to a valid 9,300
  assert.equal(c.robustPrice([]), 0);
});

test('searchBudget: how today\'s searches split between price checks and hunting', () => {
  const cfg = { searchesPerDay: 600, delayMin: 4000, delayMax: 8000, pauseEvery: 30, pauseMin: 45000, pauseMax: 120000, autoPrice: true, repriceMinutes: 30 };
  const b = c.searchBudget(cfg, 100, 5);
  assert.equal(b.left, 500);
  assert.ok(b.perHour > 300 && b.perHour < 500, String(b.perHour));
  assert.equal(b.pricingPerHour, 50);
  assert.equal(b.huntPerHour, b.perHour - 50);
  assert.equal(c.searchBudget({ ...cfg, autoPrice: false }, 0, 5).pricingPerHour, 0);
});

test('price history: hourly samples, 7-day window, trend only with enough data', () => {
  const h = 3600e3;
  let st = {};
  st = c.addPriceSample(st, '5', { name: 'X' }, 10000, 8, 0);
  st = c.addPriceSample(st, '5', { name: 'X' }, 10100, 8, 0.5 * h); // same hour → replaced
  assert.equal(st['5'].s.length, 1);
  for (let k = 1; k <= 5; k++) st = c.addPriceSample(st, '5', {}, 10000 + k * 500, 8, k * 8 * h);
  const t = c.priceTrend(st['5'].s, 40 * h);
  assert.equal(t.thin, false);
  assert.ok(t.pct > 5, String(t.pct));
  assert.match(c.trendText(t), /^↑ \+\d+% over/);
  assert.equal(c.priceTrend(st['5'].s.slice(0, 3), 0).thin, true, 'under 4 samples: no trend');
  const old = c.addPriceSample(st, '5', {}, 9000, 1, 9 * 24 * h);
  assert.ok(old['5'].s.every((x) => 9 * 24 * h - x[0] < 7 * 864e5), 'older than 7 days dropped');
  const big = {}; for (let k = 0; k < 400; k++) big[k] = { n: 'P', s: Array.from({ length: 20 }, (_, j) => [j, 1000, 5]) };
  assert.ok(JSON.stringify(c.prunePrices(big, 50000)).length <= 50000);
  assert.match(c.lookupUrl('Kylian Mbappé'), /^https:\/\/www\.google\.com\/search\?q=Kylian%20Mbapp%C3%A9%20FC%2027%20site%3Afut\.gg$/);
});

test('robustLow: cheapest real listing and the next one, ignoring a lone mistake', () => {
  assert.deepEqual(c.robustLow([190000, 189000, 192000]), { floor: 189000, second: 190000 });
  assert.deepEqual(c.robustLow([100000, 189000, 190000]), { floor: 189000, second: 190000 }, 'lone listing >30% under is dropped');
  assert.deepEqual(c.robustLow([5000]), { floor: 5000, second: 5000 });
  assert.deepEqual(c.robustLow([170000, 189000, 190000]), { floor: 189000, second: 190000 }, 'one listing 10% under a tight cluster is about to be sniped');
  assert.deepEqual(c.robustLow([180000, 189000, 199000]), { floor: 180000, second: 189000 }, 'a spread-out market keeps its cheapest');
  assert.deepEqual(c.robustLow([]), { floor: 0, second: 0 });
});

test('trendNudge: only falling prices with enough history snipe deeper, max 3 points', () => {
  assert.equal(c.trendNudge({ thin: true, pct: -10 }), 0);
  assert.equal(c.trendNudge({ thin: false, pct: 6 }), 0);
  assert.equal(c.trendNudge({ thin: false, pct: -4 }), 2);
  assert.equal(c.trendNudge({ thin: false, pct: -20 }), 3);
  assert.equal(c.trendNudge(null), 0);
});

test('snipeBase: buy from the cheapest, trade from resale (lower of market and 2nd cheapest)', () => {
  const m = { avg: 192000, floor: 189000, second: 190000, nudge: 0 };
  assert.equal(c.snipeBase(m, 'buy'), 189000);
  assert.equal(c.snipeBase(m, 'trade'), 190000);
  assert.equal(c.snipeBase({ ...m, second: 195000 }, 'trade'), 192000);
  assert.ok(c.snipeBase({ ...m, nudge: 2 }, 'trade') <= 190000 * 0.98);
  assert.equal(c.snipeBase({ avg: 20000 }, 'buy'), 20000, 'no floor (filters) → market price');
  assert.equal(c.snipeBase({ avg: 0, floor: 5000 }, 'buy'), 0);
  // 10% under the cheapest is never above 10% under the market price
  assert.ok(c.planMaxBuy(c.snipeBase(m, 'buy'), 10, 1e9).maxBuy <= c.planMaxBuy(m.avg, 10, 1e9).maxBuy);
});

test('recordGap/gapStats: probe data as % under the cheapest, last 40, 7 days', () => {
  let g = c.recordGap([], 180000, 190000, 1000);
  g = c.recordGap(g, 0, 190000, 2000);
  g = c.recordGap(g, 171000, 190000, 3000);
  assert.deepEqual(c.gapStats(g), { probes: 3, near: 2, avgPct: 7.7 });
  assert.equal(c.recordGap(g, 1, 1, 8 * 864e5).length, 1, 'old entries drop off');
  let many = [];
  for (let i = 0; i < 50; i++) many = c.recordGap(many, 0, 1, i);
  assert.equal(many.length, 40);
});

test('chooseDiscount: a dry spell (no buys, races or near misses) never pushes deeper', () => {
  const levels = c.smartLevels(10, 14);
  const arms = { 10: { n: 100 }, 12: { n: 100 }, 14: { n: 100 } };
  const r = seeded(5);
  const counts = {};
  for (let i = 0; i < 600; i++) { const p = c.chooseDiscount(arms, levels, r).pct; counts[p] = (counts[p] || 0) + 1; }
  assert.ok((counts[10] || 0) > (counts[14] || 0), JSON.stringify(counts));
});

test('migrateConfig 2.4.6: old default Snipe % 10 → 4, your own value kept, once', () => {
  assert.equal(c.migrateConfig({ discount: 10 }).discount, 4);
  assert.equal(c.migrateConfig({ discount: 7 }).discount, 7);
  assert.equal(c.migrateConfig({ discount: 10, snipe246: true }).discount, 10, 'set back to 10 after the move: kept');
  assert.equal(c.DEFAULT_CONFIG.discount, 4);
});

test('plan: floor, budget, verdict, summary', () => {
  assert.equal(c.planBudget(120000, 10), 12000);
  assert.equal(c.planBudget(120000, 80), 60000, 'never more than 50 %');
  assert.equal(c.planFloor(120000, 12000, 0), 108000);
  assert.equal(c.planFloor(120000, 12000, 115000), 115000, 'Keep coins wins when higher');
  assert.equal(c.planVerdict('40 min session limit — take a break', 0, 1), 'next');
  assert.equal(c.planVerdict('session search limit reached', 0, 1), 'next');
  assert.equal(c.planVerdict('session search limit reached', 5, 1), 'end', 'a safety lock always ends the plan');
  for (const r of ['EA verification (458) — solve it', 'logged out (401) — log in again', 'stopped by you', 'not enough coins', 'daily search cap reached', '']) assert.equal(c.planVerdict(r, 0, 1), 'end', r);
  const s = c.planSummary({ planBlocks: 3, planBlockMin: 60, planBreakMin: 30, planBudgetPct: 10, minCoins: 0, searchesPerDay: 600, planSbcs: [], planSbcMax: 3, planSbcCoins: 2000 }, 100000);
  assert.equal(s.totalMin, 240);
  assert.match(s.text, /3 × 60 min sniping, 30 min breaks · about 4 h · can spend up to 10,000 · never below 90,000/);
});

test('clampConfig: plan settings stay inside the safety caps', () => {
  const r = c.clampConfig({ ...c.DEFAULT_CONFIG, planBlockMin: 500, planBreakMin: 1, planBlocks: 40, planBudgetPct: 90 }).cfg;
  assert.deepEqual([r.planBlockMin, r.planBreakMin, r.planBlocks, r.planBudgetPct], [120, 20, 8, 50]);
});

test('panel markup: every data-r name is unique (a duplicate renders into the wrong box)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'fc-sniper.user.js'), 'utf8');
  const names = [...src.matchAll(/data-r="([a-z0-9-]+)"/g)].map((m) => m[1]);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dup, []);
});

test('live updates: search and auction lines say what came back and why', () => {
  assert.equal(c.shortTime(38), '38 s');
  assert.equal(c.shortTime(252), '4 min 12 s');
  assert.equal(c.shortTime(7500), '2 h 5 min');
  assert.equal(c.searchReport({ n: 12, name: 'Salma', max: 186000, listings: [] }), '🔍 12. Salma ≤ 186,000: nothing listed at or under 186,000');
  assert.equal(c.searchReport({ n: 13, name: 'Salma', max: 186000, searchMax: 194000, probe: true, cheapest: 194000, listings: [{ buyNowPrice: 193000 }] }),
    '🔍 13. Salma ≤ 186,000 (near-miss check up to 194,000): 1 listed · cheapest 193,000 (0.5% under the usual cheapest)');
  assert.match(c.searchReport({ n: 14, name: 'Salma', max: 186000, listings: [{ buyNowPrice: 180000 }, { buyNowPrice: 200000 }] }), /2 listed · cheapest 180,000 · 1 under your max — buying/);
  assert.equal(c.auctionReport({ n: 15, name: 'Salma', maxBid: 186000, windowSec: 30, listings: [{ expires: 252, currentBid: 160000 }, { expires: 900, startingBid: 150000 }] }),
    '🔨 15. Auctions Salma ≤ 186,000: 2 seen · soonest ends in 4 min 12 s (bid 160,000) — the bot bids in the last 30 s');
  assert.match(c.auctionReport({ n: 16, name: 'Salma', maxBid: 186000, windowSec: 30, listings: [{ expires: 12, currentBid: 170000, bidState: 'highest' }] }), /1 seen · you're highest on 1 · 1 ending within 30 s/);
  assert.equal(c.auctionReport({ n: 17, maxBid: 5000, windowSec: 30, listings: [] }), '🔨 17. Auctions filters ≤ 5,000: none found');
});

test('bidSkipReason: says why an auction is not bid on; matches bidAmount', () => {
  const max = 186000;
  const cases = [
    [{ expires: 252, currentBid: 160000 }, 'not ending yet'],
    [{ expires: 20, currentBid: 190000 }, 'next bid over your max'],
    [{ expires: 20, currentBid: 170000, bidState: 'highest' }, 'already highest'],
    [{ expires: 20, currentBid: 170000, buyNowPrice: 171000 }, 'Buy Now is cheaper'],
    [{ expires: 0 }, 'ended'],
    [{ expires: 20, currentBid: 170000 }, ''],
  ];
  for (const [l, why] of cases) {
    assert.equal(c.bidSkipReason(l, max, 45), why, JSON.stringify(l));
    assert.equal(!!c.bidAmount(l, max, 45), why === '', `bidAmount agrees for ${JSON.stringify(l)}`);
  }
});

test('bid window 2.4.8: old default 30 → 45 once, clamped 15–90', () => {
  assert.equal(c.migrateConfig({ bidWindow: 30 }).bidWindow, 45);
  assert.equal(c.migrateConfig({ bidWindow: 60 }).bidWindow, 60);
  assert.equal(c.DEFAULT_CONFIG.bidWindow, 45);
  assert.equal(c.clampConfig({ ...c.DEFAULT_CONFIG, bidWindow: 300 }).cfg.bidWindow, 90);
  assert.equal(c.clampConfig({ ...c.DEFAULT_CONFIG, bidWindow: 5 }).cfg.bidWindow, 15);
});

test('searchPlayers 2.4.10: a whole surname ranks above partial matches; up to 12 results', () => {
  const db = c.parsePlayerDb([
    ...Array.from({ length: 10 }, (_, i) => ({ id: 1000 + i, f: 'Tom', l: `Thompsonson${i}`, r: 90 - i })),
    { id: 269404, f: 'Gisele', l: 'Thompson', r: 78 },
  ]);
  assert.equal(c.searchPlayers(db, 'thompson')[0].id, 269404);
  assert.equal(c.searchPlayers(db, 'thomp').length, 11);
});

test('cardVersions: the different cards of one player from market listings', () => {
  const FS = 50331648 + 269404;
  const v = c.cardVersions([
    { defId: 269404, rating: 78, rareflag: 1, buyNowPrice: 1500 },
    { defId: FS, rating: 84, rareflag: 41, buyNowPrice: 49000 },
    { defId: FS, rating: 84, rareflag: 41, buyNowPrice: 48750 },
    { defId: 999, rating: 80, buyNowPrice: 100 }, // another player: ignored
  ], 269404);
  assert.deepEqual(v.map((x) => [x.defId, x.cheapest, x.count]), [[FS, 48750, 2], [269404, 1500, 1]]);
});

test('cardAdvice: plain suggestions from what the bot saw; never with too little data', () => {
  assert.equal(c.cardAdvice({ name: 'Salma', bin: 40, hits: 0, pct: 4 }), '');
  assert.match(c.cardAdvice({ name: 'Salma', bin: 120, hits: 2, pct: 4 }), /2 bought in 120 searches at 4% under — it's landing/);
  assert.match(c.cardAdvice({ name: 'Salma', bin: 300, hits: 0, pct: 4, probes: 30, near: 6, nearPct: 1.2 }), /listings come in around 1.2% under the cheapest — a Snipe % near 1/);
  assert.match(c.cardAdvice({ name: 'Salma', bin: 300, hits: 0, pct: 4, probes: 30, near: 0 }), /nothing came within 4% above your max in 30 checks — .*cheaper or less popular card/);
  assert.match(c.cardAdvice({ name: 'Salma', bin: 300, hits: 0, pct: 4, ends: [5, 6, 4], bidding: false }), /auctions end ~5% under the cheapest — turning on auction bidding may land one/);
  assert.match(c.cardAdvice({ name: 'Salma', bin: 300, hits: 0, pct: 4, ends: [2, 3, 1], bidding: true }), /auctions end ~2% under the cheapest, above your max too/);
});

test('sessionReport: one line', () => {
  assert.equal(c.sessionReport({ searches: 412, buys: 1, missed: 3, spent: 17000, listed: 1, profit: 900 }, { minutes: 38, near: 5, bestHour: 21 }),
    '📊 Session (38 min): 412 searches · 1 bought · 3 lost to faster buyers · 5 near misses · spent 17,000 · 1 listed · est. profit 900 · best hour so far: 21:00');
  assert.equal(c.sessionReport({ searches: 10, buys: 0, missed: 0, spent: 0, listed: 0, profit: 0 }), '📊 Session: 10 searches · 0 bought · 0 lost to faster buyers · spent 0');
});

test('profitSummary: tax math, unsold coins, periods, per-card ranking, old entries', () => {
  const now = new Date(2026, 5, 15, 15, 0).getTime();
  const H = 36e5;
  const h = [
    { id: 1, name: 'A', price: 10000, sell: 12000, soldFor: 12000, at: now - 4 * H, soldAt: now - 2 * H },
    { id: 1, name: 'A', price: 10000, sell: 12000, at: now - 3 * H }, // listed, unsold -> tied up
    { id: 2, name: 'B', price: 10000, sell: 10500, soldFor: 10000, at: now - 3 * 864e5, soldAt: now - 2 * 864e5 }, // loss
    { id: 3, name: 'C', price: 5000, sell: 8000, soldFor: 8000, at: now - 20 * 864e5, soldAt: now - 19 * 864e5 }, // old
    { id: 4, name: 'D', price: 3000, via: 'bid' }, // kept, not a flip
    { name: 'Legacy', price: 2000 }, // no id, no sale fields
    null,
  ];
  const s = c.profitSummary(h, now);
  assert.equal(s.today.bought, 2);
  assert.equal(s.today.spent, 20000);
  assert.equal(s.today.sold, 1);
  assert.equal(s.today.received, 11400);
  assert.equal(s.today.net, 1400);
  assert.equal(s.today.tiedUp, 10000);
  assert.equal(s.today.avgHours, 2);
  assert.equal(s.today.sellThrough, 50);
  assert.equal(s.week.sold, 2);
  assert.equal(s.week.net, 1400 + (9500 - 10000));
  assert.equal(s.all.sold, 3);
  assert.equal(s.all.received, 11400 + 9500 + 7600);
  assert.equal(s.all.net, 1400 - 500 + 2600);
  assert.equal(s.all.bought, 6);
  assert.equal(s.all.tiedUp, 10000);
  assert.equal(s.all.sellThrough, 75); // 3 of 4 listed
  assert.equal(s.days.length, 7);
  assert.equal(s.days[6].net, 1400);
  assert.equal(s.days[4].net, -500);
  assert.deepEqual(s.best.map((x) => x.id), [3, 1, 2]);
  assert.deepEqual(s.worst, []); // fewer than 6 cards: nothing left over for "worst"
  assert.equal(s.best[1].bought, 2);
  assert.equal(s.best[1].sold, 1);
});

test('profitSummary: best 5 / worst 3 split and empty history', () => {
  const now = Date.now();
  const h = [];
  for (let i = 1; i <= 9; i++) h.push({ id: i, name: `P${i}`, price: 10000, soldFor: 10000 + i * 1000, at: now - 1000, soldAt: now });
  const s = c.profitSummary(h, now);
  assert.deepEqual(s.best.map((x) => x.id), [9, 8, 7, 6, 5]);
  assert.deepEqual(s.worst.map((x) => x.id), [1, 2, 3]);
  const e = c.profitSummary(undefined, now);
  assert.equal(e.all.bought, 0);
  assert.equal(e.all.sellThrough, null);
  assert.deepEqual(e.best, []);
});

test('coinGoal: SBC cost + Keep coins + buffer, rounded up to 1,000', () => {
  assert.equal(c.coinGoal(120000, 0, 12), 135000);
  assert.equal(c.coinGoal(120000, 0, 0), 120000);
  assert.equal(c.coinGoal(20000, 5000, 12), 28000);
  assert.equal(c.coinGoal(120000, 0, undefined), 135000, 'default 12 %');
});

test('sbcLikely / sbcOrder: club-solvable (repeatable first), then buys, points, manual', () => {
  const p = (players, extra = {}) => ({ constraints: { players }, unsupported: [], ...extra });
  assert.equal(c.sbcLikely(p(11), 30), 'club');
  assert.equal(c.sbcLikely(p(11), 5), 'buys');
  assert.equal(c.sbcLikely(p(11, { points: true }), 50), 'points');
  assert.equal(c.sbcLikely(p(11, { unsupported: ['x'] }), 50), 'manual');
  const sets = [{ n: 'm', likely: 'manual' }, { n: 'b', likely: 'buys' }, { n: 'c', likely: 'club' }, { n: 'cr', likely: 'club', repeatable: true }, { n: 'u' }];
  assert.deepEqual(sets.sort(c.sbcOrder).map((x) => x.n), ['cr', 'c', 'b', 'm', 'u']);
});

test('setup check: version, keep coins, reach, bidding, searches left — each with a fix where it makes sense', () => {
  assert.equal(c.newerVersion('2.5.10', '2.5.9'), true);
  assert.equal(c.newerVersion('2.5.0', '2.5.0'), false);
  const cfg = { ...c.DEFAULT_CONFIG, minCoins: 0, bidSnipe: false, mode: 'buy' };
  const it = c.setupIssues(cfg, { coins: 241832, version: '2.4.8', latest: '2.5.0', targets: 1, reachable: 0, searchesLeft: 20 });
  const txt = it.map((x) => `${x.level}:${x.text}`).join(' | ');
  assert.match(txt, /warn:Running 2.4.8 — 2.5.0 is out/);
  assert.match(txt, /warn:Every player on your list costs more/);
  assert.match(txt, /warn:Keep coins is 0 — .* Keep 24,000 back\?/);
  assert.match(txt, /info:Auction bidding is off/);
  assert.match(txt, /warn:Only 20 searches left today/);
  assert.deepEqual(it.find((x) => /Keep coins/.test(x.text)).fix, { type: 'keep', value: 24000 });
  const ok = c.setupIssues({ ...cfg, minCoins: 5000, bidSnipe: true }, { coins: 50000, version: '2.5.0', latest: '2.5.0', targets: 2, reachable: 2, searchesLeft: 400 });
  assert.deepEqual(ok.map((x) => x.level), ['ok']);
});

test('adviceFix: the tap-to-apply action that goes with the advice', () => {
  assert.equal(c.adviceFix({ bin: 40 }), null);
  assert.equal(c.adviceFix({ bin: 200, hits: 1 }), null);
  const m = c.adviceFix({ name: 'Salma', id: 7, ref: 194000, bin: 300, hits: 0, pct: 4, probes: 30, near: 6, nearPct: 1.2 });
  assert.deepEqual([m.type, m.id, m.pct, m.value], ['max', 7, 1, 192000]);
  assert.equal(c.adviceFix({ name: 'S', bin: 300, hits: 0, pct: 4, ends: [5, 6, 4], bidding: false }).type, 'bid');
  assert.deepEqual(c.adviceFix({ name: 'S', id: 7, bin: 300, hits: 0, pct: 4, probes: 30, near: 0 }), { type: 'drop', id: 7, label: 'Remove S from the list' });
});
