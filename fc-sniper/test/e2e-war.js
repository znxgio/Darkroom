// End-to-end test for bid wars: a rival keeps outbidding and every late bid extends the timer.
// Usage: node test/e2e-war.js [screenshot-dir]   (needs Playwright; ~3 minutes)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'fc-sniper.user.js'), 'utf8');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`);

function installWarMock(opts) {
  const obs = (res, ms = 5) => ({ observe(ctx, cb) { setTimeout(() => cb({ unobserve() {} }, res), ms); } });
  window.ItemPile = { CLUB: 1, PURCHASED: 3, TRANSFER: 5, STORAGE: 6 };
  window.UTSearchCriteriaDTO = function () {};
  window.W = { coins: 300000, ourBids: [], rivalBids: [], watchedCalls: 0 };
  const step = (p) => (p < 1000 ? 50 : p < 10000 ? 100 : p < 50000 ? 250 : 500);
  // one auction: Buy Now 15,000, current bid 10,000, ends in 20 s
  const a = { tradeId: 'T1', buyNowPrice: 15000, currentBid: 10000, startingBid: 150, endAt: Date.now() + 20000, _tradeState: 'active', _bidState: 'none' };
  Object.defineProperty(a, 'expires', { get: () => Math.max(0, Math.round((a.endAt - Date.now()) / 1000)) });
  const tick = () => { if (a._tradeState === 'active' && Date.now() >= a.endAt) a._tradeState = 'closed'; };
  a.isWon = () => (tick(), a._tradeState === 'closed' && a._bidState === 'highest');
  a.isSold = () => false;
  a.isExpired = () => false;
  a.isSelling = () => (tick(), a._tradeState === 'active');
  const item = { id: 77, definitionId: 500, rating: 88, rareflag: 1, _staticData: { name: 'War Target' }, isPlayer: () => true, _auction: a, getAuctionData: () => a };
  let shown = false;
  window.services = {
    User: { getUser: () => ({ coins: { amount: W.coins } }) },
    Item: {
      clearTransferMarketCache() {},
      searchTransferMarket(c) {
        const items = c.maxBid && !shown && a._tradeState === 'active' ? [item] : [];
        if (items.length) shown = true;
        return obs({ success: true, data: { items } });
      },
      bid(it, amount) {
        if (amount < a.currentBid + step(a.currentBid)) return obs({ success: false, status: 470 });
        W.ourBids.push(amount); W.coins -= amount;
        if (W.held) W.coins += W.held; // EA refunds the previous bid
        W.held = amount;
        a.currentBid = amount; a._bidState = 'highest';
        if (a.expires < 30) a.endAt = Date.now() + 30000; // a late bid extends the timer
        return obs({ success: true });
      },
      // the rival answers between our checks, up to its max
      requestWatchedItems() {
        W.watchedCalls++;
        tick();
        if (a._tradeState === 'active' && a._bidState === 'highest' && a.currentBid + step(a.currentBid) <= opts.rivalMax) {
          a.currentBid += step(a.currentBid); a._bidState = 'outbid'; W.rivalBids.push(a.currentBid);
          if (W.held) { W.coins += W.held; W.held = 0; }
          if (a.expires < 30) a.endAt = Date.now() + 30000;
        }
        return obs({ success: true, data: { items: [item] } });
      },
      requestTransferItems: () => obs({ success: true, data: { items: [] } }),
      untarget: () => obs({ success: true }),
      move: () => obs({ success: true }),
      list: () => obs({ success: true }),
    },
  };
  window.repositories = { Item: { getPileSize: () => 100, numItemsInCache: () => 0, isPileFull: () => false } };
  localStorage.setItem('fc-sniper:config', JSON.stringify({
    players: [{ id: 500, name: 'War Target', rating: 88, manualMax: 10250, avg: 12000 }],
    autoPrice: false, bidSnipe: true, bidOn240: true, bidWindow: 30, maxBuys: 1, sessionMinutes: 10, maxSearches: 200, delayMin: 3000, delayMax: 3500,
  }));
}

async function run(b, rivalMax) {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.route('http://fake.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><head><meta charset=utf-8></head><body></body></html>' }));
  await p.goto('http://fake.test/');
  await p.evaluate(installWarMock, { rivalMax });
  await p.addScriptTag({ content: SCRIPT });
  await p.waitForSelector('#fcs');
  await p.click('#fcs [data-a=toggle]');
  // wait until the war is decided (won, or let go and the auction ended)
  await p.waitForFunction(() => {
    const t = [...document.querySelectorAll('#fcs [data-r=log] div')].map((d) => d.textContent).join('\n');
    return /Won War Target|Letting War Target go/.test(t);
  }, null, { timeout: 240000 });
  await p.waitForTimeout(1500);
  const out = {
    W: await p.evaluate(() => window.W),
    log: await p.evaluate(() => [...document.querySelectorAll('#fcs [data-r=log] div')].reverse().map((d) => d.textContent.replace(/^\d\d:\d\d:\d\d\s*/, ''))),
    errors,
  };
  await p.click('#fcs [data-a=toggle]').catch(() => {});
  await p.context().close();
  return out;
}

(async () => {
  const b = await chromium.launch();
  // A) rival gives up at 10,500 — our war limit is 11,000 (10,250 max + 8%, under 12,000 avg − 3%) → we win at 10,750
  const A = await run(b, 10500);
  const counters = A.log.filter((l) => /⚔️ Counter-bid/.test(l));
  check('war: counter-bids when outbid in the last seconds', counters.length >= 1 && /Counter-bid 10,750 on War Target \(1\/5, limit 11,000\)/.test(counters[0]), counters.join(' | '));
  check('war: won the auction above the normal max, inside the war limit', A.log.some((l) => /Won War Target \(88\) for 10,750/.test(l)) && Math.max(...A.W.ourBids) === 10750, `our bids ${A.W.ourBids} · rival ${A.W.rivalBids}`);
  check('war: never bids over the limit or at Buy Now', A.W.ourBids.every((x) => x <= 11000));
  // B) rival goes to 20,000 → we stop at the limit and let it go
  const B = await run(b, 20000);
  check('war: lets go at the war limit', B.log.some((l) => /🏳️ Letting War Target go at 11,000 — next bid 11,250 is over the war limit 11,000/.test(l)) && Math.max(...B.W.ourBids) === 10750, B.log.filter((l) => /🏳️|⚔️/.test(l)).join(' | '));
  check('war: checks share the normal pacing (≥ 3 s apart)', B.W.watchedCalls <= 40, `${B.W.watchedCalls} watchlist checks`);
  check('no page errors', !A.errors.length && !B.errors.length, [...A.errors, ...B.errors].join('; '));
  await b.close();
  console.log(results.join('\n'));
  if (results.some((x) => x.startsWith('FAIL'))) process.exit(1);
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1); });
