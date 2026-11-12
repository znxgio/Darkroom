// End-to-end test for the priority list (spend limit, buy once, keep coins for higher players).
// Usage: node test/e2e-list.js   (needs Playwright; ~1 minute)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'fc-sniper.user.js'), 'utf8');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`);

function installListMock(opts) {
  const obs = (res, ms = 5) => ({ observe(ctx, cb) { setTimeout(() => cb({ unobserve() {} }, res), ms); } });
  window.ItemPile = { CLUB: 1, PURCHASED: 3, TRANSFER: 5, STORAGE: 6 };
  window.UTSearchCriteriaDTO = function () {};
  window.L = { coins: 300000, bought: [], searched: [] };
  const names = { 1: 'Top Target', 2: 'Second Target' };
  let tid = 1;
  window.services = {
    User: { getUser: () => ({ coins: { amount: L.coins } }) },
    Item: {
      clearTransferMarketCache() {},
      searchTransferMarket(c) {
        L.searched.push({ id: c.maskedDefId, max: c.maxBuy, bid: c.maxBid });
        let price = opts.prices[c.maskedDefId];
        // a cheap copy that appears in snipe searches (they set a min bid to refresh results)
        if (opts.snipe && opts.snipe[c.maskedDefId] && c.minBid !== undefined && c.maxBuy >= opts.snipe[c.maskedDefId]) price = opts.snipe[c.maskedDefId];
        const items = price && (!c.maxBuy || price <= c.maxBuy) ? [{ id: tid, definitionId: c.maskedDefId, rating: 88, _staticData: { name: names[c.maskedDefId] },
          _auction: { tradeId: tid++, buyNowPrice: price } }] : [];
        return obs({ success: true, data: { items } });
      },
      bid(item, price) {
        L.bids = (L.bids || 0) + 1;
        if (opts.failEvery && L.bids % opts.failEvery !== 0) return obs({ success: false, status: 461 }); // someone was faster
        L.bought.push({ id: item.definitionId, price }); L.coins -= price; return obs({ success: true }); },
      move: () => obs({ success: true }),
      list: () => obs({ success: true }),
    },
  };
  localStorage.setItem('fc-sniper:config', JSON.stringify({
    players: opts.players || [{ id: 1, name: 'Top Target', rating: 88, manualMax: 50000 }, { id: 2, name: 'Second Target', rating: 85, manualMax: 20000 }],
    bidOn240: true, bidSnipe: false, discount: 10, snipe246: true, spendLimit: opts.spendLimit ?? 60000, buyOnce: true, reserveForHigher: opts.reserve, autoPrice: !!opts.autoPrice, ...(opts.extra || {}), maxSearches: opts.maxSearches || 20, delayMin: 3000, delayMax: 3500,
  }));
}

async function run(b, opts) {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.route('http://fake.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><head><meta charset=utf-8></head><body></body></html>' }));
  await p.goto('http://fake.test/');
  await p.evaluate(installListMock, opts);
  await p.addScriptTag({ content: SCRIPT });
  await p.waitForSelector('#fcs');
  if (opts.screenshot) await p.screenshot({ path: opts.screenshot });
  await p.click('#fcs [data-a=toggle]');
  await p.waitForFunction(() => !document.querySelector('#fcs [data-a=toggle]').classList.contains('on') && window.L.searched.length > 0, null, { timeout: opts.timeout || 120000 });
  const out = {
    L: await p.evaluate(() => window.L),
    cfg: await p.evaluate(() => JSON.parse(localStorage.getItem('fc-sniper:config'))),
    log: await p.evaluate(() => [...document.querySelectorAll('#fcs [data-r=log] div')].reverse().map((d) => d.textContent.replace(/^\d\d:\d\d:\d\d\s*/, ''))),
    spend: await p.textContent('#fcs [data-r=spend]'),
    learn: await p.evaluate(() => JSON.parse(localStorage.getItem('fc-sniper:learn') || 'null')),
    learnText: await p.textContent('#fcs [data-r=learn]'),
    errors,
  };
  await p.context().close();
  return out;
}

(async () => {
  const b = await chromium.launch();
  // 1) both appear under their max: buy both in one session, tick off, stop when the list is done
  const a = await run(b, { prices: { 1: 40000, 2: 18000 }, reserve: false, screenshot: process.argv[2] && `${process.argv[2]}/list.png` });
  check('hunts both players at once', new Set(a.L.searched.map((x) => x.id)).size === 2);
  check('bought both', a.L.bought.map((x) => x.price).sort().join() === '18000,40000', JSON.stringify(a.L.bought));
  check('players ticked off the list', a.cfg.players.length === 0);
  check('spend counted', a.cfg.listSpent === 58000, String(a.cfg.listSpent));
  check('stopped: list complete', a.log.some((l) => /priority list complete/.test(l)), a.log.slice(-2).join(' | '));
  check('spend status shown', /58,000/.test(a.spend) && /60,000/.test(a.spend), a.spend.replace(/\s+/g, ' '));
  // 2) keep coins for the higher player: #2 at 18k would leave 42k < #1's 50k max → skip
  const r = await run(b, { prices: { 2: 18000 }, reserve: true, maxSearches: 4 });
  check('keeps coins for higher players', r.L.bought.length === 0 && r.log.some((l) => /keeping coins for players higher/.test(l)), r.log.filter((l) => /Skipped|Bought/.test(l)).join(' | '));
  // 3) a 2.9M player with 300k coins is skipped; the affordable one is hunted, with a "still sniping" summary
  const o = await run(b, { prices: { 1: 2900000, 2: 18000 }, reserve: false, autoPrice: true, spendLimit: 0, maxSearches: 26, players: [{ id: 1, name: 'Top Target', rating: 91 }, { id: 2, name: 'Second Target', rating: 87 }], extra: { smartProbeEvery: 3 }, timeout: 400000 });
  check('out-of-reach player flagged', o.log.some((l) => /⏭️ Top Target: out of reach/.test(l)), o.log.filter((l) => /Top Target/.test(l)).join(' | '));
  check('out-of-reach player never sniped (searches go to the affordable one)', !o.L.searched.some((x) => x.id === 1 && x.max && x.max < 1e6) && o.L.searched.filter((x) => x.id === 2).length >= 20, JSON.stringify(o.L.searched.slice(-3)));
  check('"still sniping" summary every 25 searches', o.log.some((l) => /🔎 Still sniping — 25 searches \(Second Target 25\) · 0 listings under your max · Second Target 16,000 vs cheapest 18,000 \(11% under\)/.test(l)), o.log.filter((l) => /🔎/.test(l)).join(' | '));
  const om = o.learn && o.learn.targets && o.learn.targets['p:2'];
  check('default: max measured from the cheapest listing, said in the log', o.log.some((l) => /Second Target: cheapest 18,000 · market 18,000 · \d+ listed · trend: not enough history yet → max 16,000 \(10% under the cheapest\)/.test(l)), o.log.filter((l) => /Second Target: /.test(l))[0]);
  check('default: learner only picks targets (searches recorded at your Snipe %, no deeper levels)', om && Object.keys(om.arms).join() === '10' && Array.isArray(om.gaps) && om.gaps.length >= 1, om && JSON.stringify({ arms: Object.keys(om.arms), gaps: (om.gaps || []).length }));
  // 3b) bidding with 2 players: each player gets auction searches too (2.4.7 alternated globally, so one never did)
  // prices above both maxes: nothing bought, so both players reach their auction turns
  const tw = await run(b, { prices: { 1: 60000, 2: 30000 }, reserve: false, maxSearches: 8, extra: { bidSnipe: true, buyOnce: false } });
  const auc = (id) => tw.L.searched.filter((x) => x.id === id && x.bid > 0).length;
  check('both players get auction searches', auc(1) >= 1 && auc(2) >= 1, JSON.stringify(tw.L.searched.map((x) => `${x.id}${x.bid ? 'A' : 'B'}`)));
  check('live updates: a line per search and per auction search', tw.log.filter((l) => /^🔍 \d+\./.test(l)).length >= 2 && tw.log.some((l) => /^🔨 \d+\. Auctions/.test(l)), tw.log.filter((l) => /^🔍|^🔨/.test(l)).slice(0, 4).join(' | '));
  // 4) smart sniping: copies at 17,000 (5.6% under 18,000) — only the 4% arm can buy; most buys are lost races
  const sm = await run(b, { prices: { 2: 18000 }, snipe: { 2: 17000 }, failEvery: 3, reserve: false, autoPrice: true, spendLimit: 0, maxSearches: 40, timeout: 500000,
    players: [{ id: 2, name: 'Second Target', rating: 87 }], extra: { buyOnce: false, maxBuys: 2, smartProbeEvery: 2, discount: 4, smartPrice: true } }); // learner never goes closer than Snipe % under avg
  const mem = sm.learn && sm.learn.targets && sm.learn.targets['p:2'];
  const a4 = mem && mem.arms[4];
  check('smart sniping tries several discounts', mem && Object.keys(mem.arms).length >= 3, mem && JSON.stringify(mem.arms));
  check('lost races and buys recorded at the discount that hits', a4 && a4.misses >= 1 && a4.hits >= 1 && sm.L.bought.every((x) => x.price === 17000), JSON.stringify(a4));
  check('near misses spotted just above the max (never bought above it)', Object.values(mem.arms).some((x) => x.near > 0) && sm.L.bought.every((x) => x.price <= 17250), JSON.stringify(mem.arms));
  check('missed buys say someone was faster, with your speed', sm.log.some((l) => /Missed Second Target at 17,000 \(461\) — someone was faster · you: \d+ ms to react \+ \d+ ms to EA/.test(l)), sm.log.filter((l) => /Missed/.test(l))[0]);
  check('Learning card shows the best discount', /Second Target best 4% under/.test(sm.learnText.replace(/\s+/g, ' ')), sm.learnText.replace(/\s+/g, ' ').slice(0, 200));
  check('never buys above the learned max', sm.L.bought.length >= 1 && sm.L.bought.every((x) => x.price <= 17250), JSON.stringify(sm.L.bought));
  check('no page errors', !a.errors.length && !r.errors.length && !o.errors.length && !sm.errors.length, [...a.errors, ...r.errors, ...o.errors, ...sm.errors].join('; '));
  await b.close();
  console.log(results.join('\n'));
  if (results.some((x) => x.startsWith('FAIL'))) process.exit(1);
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1); });
