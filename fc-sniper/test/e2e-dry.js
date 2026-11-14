// End-to-end test for the affordability gate and dry-spell auction turns (2.4.9) against a mocked Web App.
// Usage: node test/e2e-dry.js   (needs Playwright; ~3 minutes)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'fc-sniper.user.js'), 'utf8');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installDryMock(opts) {
  const obs = (res, ms = 5) => ({ observe(ctx, cb) { setTimeout(() => cb({ unobserve() {} }, res), ms); } });
  window.ItemPile = { CLUB: 1, PURCHASED: 3, TRANSFER: 5, STORAGE: 6 };
  window.UTSearchCriteriaDTO = function () {};
  window.D = { coins: opts.coins, searched: [], bids: [], bought: [], t0: Date.now() };
  const names = {};
  opts.players.forEach((p) => { names[p.id] = p.name; });
  let tid = 1;
  const watched = [];
  const card = (defId, o) => {
    const key = o.key || tid++;
    const it = { id: `${defId}-${key}`, definitionId: defId, rating: 88, rareflag: 1, untradeable: false, isPlayer: () => true, _staticData: { name: names[defId] },
      _auction: { tradeId: `${defId}-${key}`, buyNowPrice: o.bin, currentBid: o.bid || 0, startingBid: o.start || 150, expires: o.expires ?? 3000, _tradeState: 'active', _bidState: 'none' } };
    const a = it._auction;
    a.isSold = () => a._tradeState === 'closed' && a._bidState !== 'highest' && a.currentBid > 0;
    a.isWon = () => a._tradeState === 'closed' && a._bidState === 'highest';
    a.isExpired = () => a._tradeState === 'expired';
    a.isSelling = () => a._tradeState === 'active';
    it.getAuctionData = () => a;
    return it;
  };
  const doBid = (item, amount) => {
    if (amount === item._auction.buyNowPrice) { D.bought.push({ id: item.definitionId, price: amount }); D.coins -= amount; return obs({ success: true }); }
    D.bids.push({ id: item.definitionId, amount, at: Date.now() - D.t0, searchesBefore: D.searched.length });
    item._auction.currentBid = amount; item._auction._bidState = 'highest'; D.coins -= amount;
    watched.push(item);
    return obs({ success: true });
  };
  const served = {}; // auctions already shown once (opts.auctionOnce: { [defId]: { bin, bid, expires } })
  window.services = {
    User: { getUser: () => ({ coins: { amount: D.coins } }) },
    Item: {
      clearTransferMarketCache() {},
      searchTransferMarket(c) {
        const id = c.maskedDefId;
        D.searched.push({ id, auction: !!(c.maxBid > 0), maxBuy: c.maxBuy, maxBid: c.maxBid, at: Date.now() - D.t0 });
        const items = [];
        if (c.maxBid > 0) {
          const a = opts.auctionOnce && opts.auctionOnce[id];
          if (opts.wrongVersion && !served['w' + id]) { served['w' + id] = true; items.push(card(id + 50331648, { bin: 90000, bid: 1000, expires: 20, key: 'wv' })); }
          if (a && !served[id]) { served[id] = true; items.push(card(id, { bin: a.bin, bid: a.bid, expires: a.expires, key: 'a1' })); }
          else items.push(card(id, { bin: opts.lowest[id] + 5000, bid: opts.lowest[id] - 4000, expires: 3000 })); // ends in ~50 min: outside the bid window
        } else {
          for (let i = 0; i < 5; i++) items.push(card(id, { bin: opts.lowest[id] + i * 500 }));
        }
        return obs({ success: true, data: { items: items.filter((x) => c.maxBid > 0 || !c.maxBuy || x._auction.buyNowPrice <= c.maxBuy) } });
      },
      bid: doBid,
      placeBid: doBid,
      move: () => obs({ success: true }),
      list: () => obs({ success: true }),
      requestTransferItems: () => obs({ success: true, data: { items: [] } }),
      requestWatchedItems: () => obs({ success: true, data: { items: watched.slice() } }),
      untarget: () => obs({ success: true }),
      clearSoldItems: () => obs({ success: true }),
      relistExpiredAuctions: () => obs({ success: true }),
    },
  };
  window.repositories = { Item: { getPileSize: () => 100, numItemsInCache: () => 0, isPileFull: () => false } };
  const now = Date.now();
  localStorage.setItem('fc-sniper:config', JSON.stringify({
    players: opts.players.map((p) => (p.none ? { id: p.id, name: p.name, rating: 88, avg: 0, lowest: 0, maxBuy: 0, checkedAt: now }
      : { id: p.id, name: p.name, rating: 88, manualMax: p.manualMax, lowest: p.lowest, avg: Math.round(p.lowest * 1.05), floor: p.lowest, checkedAt: now })),
    autoPrice: false, bidSnipe: !!opts.bidSnipe, bidWindow: opts.bidWindow || 30, minCoins: 0, spendLimit: 0, buyOnce: false,
    dryTurns: opts.dryTurns, dryAuctionSearches: opts.dryAuctionSearches, maxSearches: opts.maxSearches || 0, pauseEvery: 60, delayMin: 3000, delayMax: 3500,
    snipe246: true, bid248: true, bidOn240: true, trade242: true, reprice244: true,
  }));
}

async function run(b, opts) {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.route('http://fake.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><head><meta charset=utf-8></head><body></body></html>' }));
  await p.goto('http://fake.test/');
  const lowest = {};
  opts.players.forEach((x) => { lowest[x.id] = x.lowest; });
  const { during, ...mockOpts } = opts; void during; // functions can't be sent into the page
  await p.evaluate(installDryMock, { ...mockOpts, lowest });
  await p.addScriptTag({ content: SCRIPT });
  await p.waitForSelector('#fcs');
  await p.click('#fcs [data-a=toggle]');
  const logLines = () => p.evaluate(() => [...document.querySelectorAll('#fcs [data-r=log] div')].reverse().map((d) => d.textContent.replace(/^\d\d:\d\d:\d\d\s*/, '')));
  const stopped = () => p.evaluate(() => !document.querySelector('#fcs [data-a=toggle]').classList.contains('on'));
  const extra = opts.during ? await opts.during({ p, logLines, stopped }) : undefined;
  if (opts.during) { // the scenario decides when to stop: click the toggle if it is still running
    if (!(await stopped())) await p.click('#fcs [data-a=toggle]');
    await sleep(500);
  } else {
    await p.waitForFunction(() => !document.querySelector('#fcs [data-a=toggle]').classList.contains('on'), null, { timeout: opts.timeout || 120000 });
  }
  const out = { D: await p.evaluate(() => window.D), log: await logLines(), extra, errors };
  await p.context().close();
  return out;
}

(async () => {
  const b = await chromium.launch();

  // 1 + 4) dry spell: 4 Buy Now searches with nothing -> 3 auction searches -> back to Buy Now; verdict line at 25 searches
  const dry = await run(b, { coins: 300000, bidSnipe: true, dryTurns: 4, dryAuctionSearches: 3, maxSearches: 26, timeout: 400000,
    players: [{ id: 2, name: 'Dry Target', lowest: 18000, manualMax: 16000 }] });
  const startI = dry.log.findIndex((l) => /^🔁 Dry Target: 4 Buy Now searches with nothing — the next 3 searches for Dry Target are auctions only \(late bids\)/.test(l));
  const backI = dry.log.findIndex((l, i) => i > startI && /^🔁 Dry Target: back to Buy Now/.test(l));
  check('dry spell announced after 4 Buy Now searches', startI >= 0, dry.log.filter((l) => /🔁/.test(l)).join(' | '));
  check('"back to Buy Now" announced afterwards', startI >= 0 && backI > startI, dry.log.filter((l) => /🔁/.test(l)).join(' | '));
  const seqStr = dry.D.searched.filter((x) => x.id === 2).map((x) => (x.auction ? 'A' : 'B')).join('');
  // with bidding on, Buy Now and auction turns alternate (BABA…); the dry spell shows as 3 auctions in a row after the 4th Buy Now
  const firstRun = seqStr.indexOf('AAA');
  check('>= 3 consecutive auction searches for the dry player (after >= 4 Buy Now)', firstRun >= 0 && (seqStr.slice(0, firstRun).match(/B/g) || []).length >= 4, seqStr);
  check('a Buy Now search follows the auction turns', /A{3}B/.test(seqStr), seqStr);
  check('nothing bought or bid during the dry spell', dry.D.bought.length === 0 && dry.D.bids.length === 0, JSON.stringify({ bought: dry.D.bought, bids: dry.D.bids }));
  check('verdict line shows Buy Now count and max per player', dry.log.some((l) => /🔎 Still sniping — .* · .*: Buy Now 0\/\d+ at ≤ 16,000/.test(l)), dry.log.filter((l) => /🔎/.test(l)).join(' | '));

  // 2) gate stop: 50,000 coins can't pay 60% of a 194,000 listing, nothing to wait for -> stop without searching
  const stop = await run(b, { coins: 50000, bidSnipe: false, dryTurns: 40, dryAuctionSearches: 60, timeout: 60000,
    players: [{ id: 3, name: 'Pricey Target', lowest: 194000, manualMax: 186000 }] });
  check('gate: stops when no target is affordable and no bids are open', stop.log.some((l) => /Stopped — can't afford any target \(free /.test(l)), stop.log.slice(-3).join(' | '));
  check('gate: at most 1 market search before stopping', stop.D.searched.length <= 1, String(stop.D.searched.length));

  // 3) gate with an open bid: wait (💤) without Buy Now searches instead of stopping
  const gate = await run(b, { coins: 100000, bidSnipe: true, bidWindow: 45, dryTurns: 0, dryAuctionSearches: 60, maxSearches: 40,
    players: [{ id: 4, name: 'Target A', lowest: 90000, manualMax: 85000 }, { id: 5, name: 'Target B', lowest: 70000, manualMax: 66000 }],
    auctionOnce: { 4: { bin: 95000, bid: 60000, expires: 40 } },
    async during({ p }) {
      // a bid is only placed in its last 45 s, so the bot watches it right away; while it's open and nothing else is affordable,
      // it must not Buy-Now-search or stop "can't afford"
      const t0 = Date.now();
      let bidAt = 0;
      while (Date.now() - t0 < 90000 && !bidAt) {
        bidAt = await p.evaluate(() => (window.D.bids.length ? Date.now() - window.D.t0 : 0));
        if (!bidAt) await sleep(500);
      }
      if (!bidAt) return { bid: false };
      await sleep(20000);
      const after = await p.evaluate((t) => window.D.searched.filter((x) => x.at > t + 500), bidAt);
      return { bid: true, buyNowAfter: after.filter((x) => !x.auction).length, afterAll: after.length };
    } });
  const g = gate.extra || {};
  check('gate: the bot bids on the auction for A', gate.D.bids.some((x) => x.id === 4 && x.amount >= 60000 && x.amount < 62000), JSON.stringify(gate.D.bids));
  check('gate: no Buy Now searches while the bid is open and nothing else is affordable', g.bid && g.buyNowAfter === 0, `buyNow=${g.buyNowAfter} all=${g.afterAll}`);
  check('gate: does not stop while a bid is open', !gate.log.some((l) => /Stopped — can't afford any target/.test(l)), gate.log.filter((l) => /Stopped/.test(l)).join(' | '));

  // 4) review fix: an auction for another version of the player (same base id) is never bid on
  const wv = await run(b, { coins: 300000, bidSnipe: true, bidWindow: 45, dryTurns: 0, dryAuctionSearches: 60, maxSearches: 4, wrongVersion: true,
    players: [{ id: 6, name: 'Exact Target', lowest: 18000, manualMax: 16000 }] });
  check('never bids on another version of the card', wv.D.bids.length === 0 && wv.D.searched.some((x) => x.auction), JSON.stringify(wv.D.bids));

  // 5) review fix: one card with nothing listed + one unaffordable card → stops with a reason (no frozen tab)
  const fz = await run(b, { coins: 50000, bidSnipe: false, dryTurns: 0, dryAuctionSearches: 60, maxSearches: 20, timeout: 60000,
    players: [{ id: 7, name: 'None Listed', none: true }, { id: 8, name: 'Pricey Target', lowest: 194000, manualMax: 186000 }] });
  check('no frozen loop: stops when nothing can be bought (none listed + unaffordable)', fz.log.some((l) => /Stopped — (no player or filter can be bought right now|no player or filter can be traded for profit|can't afford any target)/.test(l)), fz.log.slice(-3).join(' | '));

  check('no page errors', !dry.errors.length && !stop.errors.length && !gate.errors.length && !wv.errors.length && !fz.errors.length, [...dry.errors, ...stop.errors, ...gate.errors, ...wv.errors, ...fz.errors].join('; '));
  await b.close();
  console.log(results.join('\n'));
  if (results.some((x) => x.startsWith('FAIL'))) process.exit(1);
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1); });
