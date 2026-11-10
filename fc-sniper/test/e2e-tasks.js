// End-to-end test for packs, SBCs and team upgrades against a mocked Web App.
// Usage: node test/e2e-tasks.js [screenshot-dir]   (needs Playwright; ~3 minutes)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const S = process.argv[2] || require('os').tmpdir();
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'fc-sniper.user.js'), 'utf8');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`);

/** A fake Web App with a club, an active squad, packs and one SBC. Runs in the page. */
function installMock() {
  const obs = (res, ms = 5) => ({ observe(ctx, cb) { setTimeout(() => cb({ unobserve() {} }, res), ms); } });
  const PILE = { CLUB: 1, PURCHASED: 3, TRANSFER: 5, STORAGE: 6 };
  window.ItemPile = PILE;
  window.UTSearchCriteriaDTO = function () { this.offset = 0; this.count = 21; };
  let nextId = 1;
  const owned = new Set(); // definitionIds you own (for duplicates)
  const mk = (defId, rating, o = {}) => {
    const it = {
      id: nextId++, definitionId: defId, rating, rareflag: o.rare ? 1 : (o.special ? 3 : 0), untradeable: o.untradeable !== false,
      pile: o.pile || PILE.CLUB, nationId: o.nation || 18, leagueId: o.league || 13, teamId: o.team || defId,
      preferredPosition: o.pos || 'CM', possiblePositions: o.alt || [], _staticData: { name: o.name || `Player ${defId}` },
      _auction: o.price ? { tradeId: nextId, buyNowPrice: o.price } : undefined,
      isPlayer() { return o.player !== false; }, isLimitedUse() { return false; },
      isDuplicate() { return o.dup !== undefined ? o.dup : owned.has(defId) && this.pile !== PILE.CLUB; },
    };
    return it;
  };
  // --- club: fodder 75..86 untradeable, a few tradeables
  const club = [];
  const add = (r, n, o = {}) => { for (let i = 0; i < n; i++) { const it = mk(5000 + club.length, r, { ...o, name: `Fodder ${r}-${i}` }); club.push(it); owned.add(it.definitionId); } };
  add(86, 1); add(85, 4); add(84, 12); add(83, 8, { rare: true }); add(82, 8); add(81, 5); add(78, 6); add(75, 10);
  add(87, 4, { untradeable: false });
  const storage = [mk(9001, 83, { pile: PILE.STORAGE, name: 'Stored 83 A' }), mk(9002, 83, { pile: PILE.STORAGE, name: 'Stored 83 B' })];
  // --- active squad: 4-3-1-2, ST slot weak (75), all Premier League (13), mixed nations
  const posList = ['GK', 'RB', 'CB', 'CB', 'LB', 'CM', 'CM', 'CM', 'CAM', 'ST', 'ST'];
  const squadItems = posList.map((pos, i) => mk(100 + i, i === 10 ? 75 : 85, { pos, nation: 10 + (i % 4), league: 13, name: i === 10 ? 'Weak Striker' : `Starter ${pos}${i}` }));
  squadItems.forEach((it) => { owned.add(it.definitionId); club.push(it); });
  club.push(mk(700, 80, { pos: 25, league: 13, name: 'Bench Striker 80' })); // EA sends position ids
  // a bench covering every position, so formations can be built (numeric ids like the real app)
  const ids = { GK: 0, RB: 3, CB: 5, LB: 7, RWB: 2, LWB: 8, CDM: 10, CM: 14, CAM: 18, RM: 12, LM: 16, RW: 23, LW: 27, CF: 21, ST: 25 };
  ['GK', 'RB', 'CB', 'CB', 'CB', 'LB', 'RWB', 'LWB', 'CDM', 'CDM', 'CM', 'CAM', 'CAM', 'RM', 'LM', 'RW', 'LW', 'CF', 'CF', 'ST', 'ST']
    .forEach((pos, i) => club.push(mk(600 + i, 83 + (i % 4), { pos: ids[pos], league: 13, nation: 10 + (i % 4), name: `Bench ${pos} ${i}` })));
  window.T = { piles: { club: [], storage: [], transfer: [], discarded: [] }, unassigned: [], submitted: [], searches: [], opened: 0 };
  const squad = {
    getFieldPlayers: () => squadItems.map((item, index) => ({ index, item, position: { typeName: posList[index] } })),
    getFormation: () => ({ name: '4-3-1-2' }),
  };
  // --- packs
  const packContents = [
    () => [mk(9100, 88, { name: 'Walkout Hero', special: true, untradeable: false }), mk(5001, 85, { dup: true, untradeable: true }), mk(9101, 72, { name: 'New Silver' })],
    () => [mk(5002, 84, { dup: true, untradeable: false }), mk(5003, 68, { dup: true, untradeable: true })],
    () => [mk(9102, 79, { name: 'New Gold' })],
  ];
  const pack = (i, name) => ({ id: 30 + (i > 0 ? 1 : 0), packName: name, isMyPack: true, open() { T.opened++; T.unassigned.push(...packContents[i]()); return obs({ success: true }); } });
  const myPacks = [pack(0, 'Gold Pack'), pack(1, 'Gold Pack'), pack(2, 'Rare Players Pack')];
  // --- SBC
  const sbcSquad = {
    players: [],
    getNumOfRequiredPlayers: () => 11,
    getFieldPlayers: () => Array.from({ length: 11 }, (_, index) => ({ index, isBrick: () => false })),
    removeAllItems() { this.players = []; },
    setPlayers(arr) { this.players = arr.filter(Boolean); },
  };
  let done = 0;
  const challenge = () => ({ id: 77, name: '84-rated squad', squad: sbcSquad, isCompleted: () => false,
    eligibilityRequirements: [{ scope: 0, count: -1, kvPairs: { _collection: { 19: [84] } } }, { scope: 0, count: 2, kvPairs: { _collection: { 25: [4] } } }] });
  const chemChallenge = { id: 78, name: 'League & Nation', squad: sbcSquad, isCompleted: () => false,
    eligibilityRequirements: [{ scope: 0, count: 3, kvPairs: { _collection: { 5: [3] } } }, { scope: 0, count: -1, kvPairs: { _collection: { 35: [20] } } }] };
  const sets = [{ id: 1, name: '84+ Upgrade', description: 'Repeatable', isComplete: () => false, repeatable: true, timesCompleted: 0 },
    { id: 2, name: 'Hybrid Leagues', description: 'Chemistry', isComplete: () => false }];

  window.services = {
    User: { getUser: () => ({ coins: { amount: 120000 } }) },
    Localization: { localize: (x) => x },
    Item: {
      clearTransferMarketCache() {},
      searchTransferMarket(c) {
        T.searches.push({ league: c.league, nation: c.nation, pos: c._position, max: c.maxBuy, min: c.minBuy });
        const items = c._position === 'ST' ? [
          mk(800, 86, { pos: 'ST', league: 13, nation: 10, name: 'Same League ST 86', price: 45000 }),
          mk(801, 88, { pos: 'ST', league: 53, nation: 99, name: 'Other League ST 88', price: 60000 }),
          mk(802, 90, { pos: 'ST', league: 13, name: 'Too Pricey ST 90', price: 500000 }),
        ].filter((i) => !c.maxBuy || i._auction.buyNowPrice <= c.maxBuy) : [];
        return obs({ success: true, data: { items } });
      },
      searchStorageItems: () => obs({ success: true, data: { items: storage, endOfList: true } }),
      requestUnassignedItems: () => obs({ success: true, data: { items: T.unassigned.slice() } }),
      move(items, pile) {
        const key = { 1: 'club', 5: 'transfer', 6: 'storage' }[pile];
        items.forEach((it) => { T.unassigned = T.unassigned.filter((u) => u !== it); it.pile = pile; T.piles[key].push(it.rating); });
        return obs({ success: true });
      },
      discard(items) { items.forEach((it) => { T.unassigned = T.unassigned.filter((u) => u !== it); T.piles.discarded.push(it.rating); }); return obs({ success: true }); },
    },
    Club: {
      search(c) { const page = club.slice(c.offset, c.offset + c.count); return obs({ success: true, data: { items: page, retrievedAll: c.offset + c.count >= club.length } }); },
    },
    Store: { getPacks: () => obs({ success: true, data: { packs: myPacks.slice(T.opened) } }) },
    Squad: { getActiveSquadId: () => 1, requestSquadById: () => obs({ success: true, data: { squad } }),
      create(name, formation, items) { T.created = { name, formation, n: items.filter(Boolean).length, ratings: items.map((i) => i && i.rating) }; return obs({ success: true }); } },
    SBC: {
      requestSets: () => obs({ success: true, data: { sets } }),
      requestChallengesForSet: (set) => obs({ success: true, data: { challenges: set.id === 1 ? (done < 2 ? [challenge()] : []) : [chemChallenge] } }),
      loadChallenge: () => obs({ success: true }),
      saveChallenge: () => obs({ success: true }),
      submitChallenge(ch) {
        T.submitted.push(ch.squad.players.map((p) => ({ id: p.id, def: p.definitionId, r: p.rating, rare: p.rareflag, pile: p.pile, untradeable: p.untradeable })));
        done++;
        return obs({ success: true });
      },
    },
    Chemistry: { isFeatureEnabled: () => true },
  };
  window.repositories = { Item: { numItemsInCache: () => T.unassigned.length, isPileFull: () => false, setDirty() {} } };
}

async function page(b, mobile) {
  const ctx = await b.newContext(mobile ? devices['iPhone 13'] : { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  await p.route('http://fake.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#1d2b3a;color:#fff;font-family:system-ui"><div style="padding:20px">Web App (mock)</div></body></html>' }));
  await p.goto('http://fake.test/');
  await p.evaluate(installMock);
  await p.addScriptTag({ content: SCRIPT });
  await p.waitForSelector('#fcs');
  return p;
}
const log = (p) => p.evaluate(() => [...document.querySelectorAll('#fcs [data-r=log] div')].reverse().map((d) => d.textContent.replace(/^\d\d:\d\d:\d\d\s*/, '')));
const idle = (p, ms = 150000) => p.waitForFunction(() => !document.querySelector('#fcs [data-a=toggle]').classList.contains('on') && document.querySelector('#fcs [data-r=pill]').textContent === 'Idle', null, { timeout: ms });

(async () => {
  const b = await chromium.launch();
  const p = await page(b, false);

  // Start guard: no players, no filters
  await p.click('#fcs [data-a=toggle]');
  await p.waitForTimeout(300);
  check('refuses to start with no player or filter', (await log(p)).some((l) => /Add a player/.test(l)) && !(await p.evaluate(() => document.querySelector('#fcs [data-a=toggle]').classList.contains('on'))));

  // ---- Packs
  await p.click('#fcs [data-tab=packs]');
  await p.fill('#fcs [data-k=quickSellBelow]', '70');
  await p.press('#fcs [data-k=quickSellBelow]', 'Tab');
  await p.click('#fcs [data-a=packs-load]');
  await p.waitForSelector('#fcs [data-a=pack-open-all]');
  const groups = await p.$$eval('#fcs [data-r=packs] .li b', (els) => els.map((e) => e.textContent));
  check('lists unopened packs grouped', groups.join() === 'Gold Pack,Rare Players Pack', groups.join());
  await p.screenshot({ path: `${S}/t-packs.png` });
  await p.click('#fcs [data-a=pack-open-all]');
  await idle(p);
  const piles = await p.evaluate(() => T.piles);
  check('opened all packs', (await p.evaluate(() => T.opened)) === 3);
  check('new items → club', piles.club.sort().join() === '72,79,88', piles.club.join());
  check('untradeable dup → SBC storage', piles.storage.join() === '85', piles.storage.join());
  check('tradeable dup → transfer list', piles.transfer.join() === '84', piles.transfer.join());
  check('low dup quick-sold', piles.discarded.join() === '68', piles.discarded.join());
  const lg = await log(p);
  check('pack summary + best pull', lg.some((l) => /Best pulls: Walkout Hero 88★/.test(l)), lg.slice(-3).join(' | '));

  // ---- SBC
  await p.click('#fcs [data-tab=sbc]');
  await p.fill('#fcs [data-k=sbcRepeat]', '2');
  await p.press('#fcs [data-k=sbcRepeat]', 'Tab');
  await p.click('#fcs [data-a=sbc-load]');
  await p.waitForSelector('#fcs [data-a=sbc-set]');
  await p.click('#fcs [data-a=sbc-set][data-i="1"]');
  await p.waitForFunction(() => /needs/.test(document.querySelector('#fcs [data-r=sbc]').textContent));
  check('chemistry/league SBC marked manual', /needs same league count, chemistry/.test(await p.textContent('#fcs [data-r=sbc]')));
  await idle(p);
  await p.click('#fcs [data-a=sbc-set][data-i="0"]');
  await p.waitForSelector('#fcs [data-a=sbc-solve]');
  const reqText = await p.textContent('#fcs [data-r=sbc]');
  check('requirements shown readable', /Team rating ≥ 84/.test(reqText) && /2× Rare/.test(reqText), reqText.slice(0, 160));
  await idle(p);
  await p.click('#fcs [data-a=sbc-solve]');
  await p.waitForSelector('#fcs [data-a=sbc-submit]', { timeout: 60000 });
  await idle(p);
  await p.screenshot({ path: `${S}/t-sbc-plan.png` });
  await p.click('#fcs [data-a=sbc-submit]');
  await idle(p);
  const sub = await p.evaluate(() => T.submitted);
  const rating = (rs) => { const sum = rs.reduce((a, x) => a + x, 0); const avg = sum / 11; const ex = rs.reduce((a, x) => a + Math.max(0, x - avg), 0); return Math.floor(Math.round(sum + ex) / 11); };
  check('submitted twice (repeat)', sub.length === 2, `${sub.length} submissions`);
  check('each submission rates ≥ 84', sub.every((s) => s.length === 11 && rating(s.map((x) => x.r)) >= 84), sub.map((s) => rating(s.map((x) => x.r))).join(','));
  check('≥ 2 rares each', sub.every((s) => s.filter((x) => x.rare >= 1).length >= 2));
  check('no player used twice', new Set(sub.flat().map((x) => x.id)).size === sub.flat().length);
  check('never uses tradeables', sub.flat().every((x) => x.untradeable) && !sub.flat().some((x) => x.r === 87));
  check('storage players used first', sub[0].filter((x) => x.pile === 6).length === 2, `${sub[0].filter((x) => x.pile === 6).length} storage`);
  check('active squad protected', !sub.flat().some((x) => x.def >= 100 && x.def <= 110));

  // ---- Upgrades
  await p.click('#fcs [data-tab=upgrades]');
  await p.click('#fcs [data-a=analyse]');
  await idle(p, 200000);
  await p.screenshot({ path: `${S}/t-upgrades.png` });
  const team = await p.textContent('#fcs [data-r=team]');
  check('team rating + chemistry shown', /Rating/.test(team) && /\/33/.test(team), team.trim().slice(0, 60));
  const firstSlot = await p.textContent('#fcs [data-r=upg] .card');
  check('weakest slot is the 75 striker', /ST — now Weak Striker 75/.test(firstSlot), firstSlot.slice(0, 60));
  const order = await p.$$eval('#fcs [data-r=upg] .card:first-child .li b', (els) => els.map((e) => e.textContent));
  check('owned equal upgrade ranks above buying one', order[0].startsWith('Bench ST'), order.join(' | '));
  check('best market suggestion keeps chemistry', order.find((o) => !o.startsWith('Bench')).startsWith('Same League ST 86'), order.join(' | '));
  check('owned bench striker suggested', order.some((o) => o.startsWith('Bench Striker 80')), order.join(' | '));
  check('over-budget card excluded', !order.some((o) => /Too Pricey/.test(o)));
  const srch = await p.evaluate(() => T.searches.filter((x) => x.pos === 'ST'));
  check('market searched by league/nation within budget', srch.length >= 2 && srch.every((x) => x.max <= 120000) && srch.some((x) => x.league === 13), JSON.stringify(srch[0]));
  await p.click('#fcs [data-r=upg] .card:first-child [data-a=snipe-opt]');
  const chips = await p.textContent('#fcs [data-r=chips]');
  check('Snipe adds player with listed price as max', /Same League ST 86/.test(chips) && /45,000/.test(chips), chips.replace(/\s+/g, ' ').trim());
  // ---- Formation coach
  await p.click('#fcs [data-tab=upgrades]');
  await p.click('#fcs [data-a=forms]');
  await idle(p, 120000);
  const forms = await p.$$eval('#fcs [data-r=forms] .li b', (els) => els.map((e) => e.textContent));
  check('formations compared', forms.length >= 4 && forms.some((f) => /yours now/.test(f)), forms.join(' | '));
  await p.click('#fcs [data-a=form-view]');
  const xi = await p.$$eval('#fcs [data-r=forms] .sub .li b', (els) => els.map((e) => e.textContent));
  check('lineup view lists 11 slots', xi.length === 11, xi.slice(0, 3).join(' | '));
  await p.click('#fcs [data-a=form-create]');
  await idle(p);
  const created = await p.evaluate(() => T.created);
  check('creates a new squad with 11 players', created && created.n === 11 && /^f\d/.test(created.formation), JSON.stringify(created));
  await p.screenshot({ path: `${S}/t-forms.png` });

  // copy log works (falls back to prompt if clipboard is blocked)
  await p.click('#fcs [data-tab=snipe]');
  p.once('dialog', (d) => d.accept());
  await p.click('#fcs [data-a=copy-log]');

  check('no page errors (desktop)', p.errors.length === 0, p.errors.join('; '));

  // ---- phone screenshots
  const m = await page(b, true);
  await m.tap('#fcs [data-a=fold]');
  await m.tap('#fcs [data-tab=packs]');
  await m.tap('#fcs [data-a=packs-load]');
  await m.waitForSelector('#fcs [data-a=pack-open-all]');
  await m.waitForTimeout(300);
  await m.screenshot({ path: `${S}/t-m-packs.png` });
  await m.tap('#fcs [data-tab=sbc]');
  await m.tap('#fcs [data-a=sbc-load]');
  await m.waitForSelector('#fcs [data-a=sbc-set]');
  await m.waitForTimeout(300);
  await m.tap('#fcs [data-a=sbc-set][data-i="0"]');
  await m.waitForSelector('#fcs [data-a=sbc-solve]');
  await m.waitForTimeout(2500);
  await m.tap('#fcs [data-a=sbc-solve]');
  await m.waitForSelector('#fcs [data-a=sbc-submit]', { timeout: 60000 });
  await m.waitForTimeout(500);
  await m.screenshot({ path: `${S}/t-m-sbc.png` });
  check('no page errors (mobile)', m.errors.length === 0, m.errors.join('; '));

  console.log('desktop log:\n  ' + (await log(p)).join('\n  '));
  await b.close();
  console.log('\n' + results.join('\n'));
  if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
})().catch((e) => { console.error(e); console.log('\n' + results.join('\n')); process.exit(1); });
