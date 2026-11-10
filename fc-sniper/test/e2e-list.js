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
        L.searched.push({ id: c.maskedDefId, max: c.maxBuy });
        const price = opts.prices[c.maskedDefId];
        const items = price && price <= c.maxBuy ? [{ id: tid, definitionId: c.maskedDefId, rating: 88, _staticData: { name: names[c.maskedDefId] },
          _auction: { tradeId: tid++, buyNowPrice: price } }] : [];
        return obs({ success: true, data: { items } });
      },
      bid(item, price) { L.bought.push({ id: item.definitionId, price }); L.coins -= price; return obs({ success: true }); },
      move: () => obs({ success: true }),
      list: () => obs({ success: true }),
    },
  };
  localStorage.setItem('fc-sniper:config', JSON.stringify({
    players: [{ id: 1, name: 'Top Target', rating: 88, manualMax: 50000 }, { id: 2, name: 'Second Target', rating: 85, manualMax: 20000 }],
    spendLimit: 60000, buyOnce: true, reserveForHigher: opts.reserve, autoPrice: false, maxSearches: opts.maxSearches || 20, delayMin: 3000, delayMax: 3500,
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
  await p.waitForFunction(() => !document.querySelector('#fcs [data-a=toggle]').classList.contains('on') && window.L.searched.length > 0, null, { timeout: 120000 });
  const out = {
    L: await p.evaluate(() => window.L),
    cfg: await p.evaluate(() => JSON.parse(localStorage.getItem('fc-sniper:config'))),
    log: await p.evaluate(() => [...document.querySelectorAll('#fcs [data-r=log] div')].reverse().map((d) => d.textContent.replace(/^\d\d:\d\d:\d\d\s*/, ''))),
    spend: await p.textContent('#fcs [data-r=spend]'),
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
  check('no page errors', !a.errors.length && !r.errors.length, [...a.errors, ...r.errors].join('; '));
  await b.close();
  console.log(results.join('\n'));
  if (results.some((x) => x.startsWith('FAIL'))) process.exit(1);
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1); });
