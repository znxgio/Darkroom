// End-to-end test for search filters (multi-filter search, snipe by rating), the profit
// calculator and the orange theme. Usage: node test/e2e-filters.js [screenshot-dir]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const S = process.argv[2] || require('os').tmpdir();
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'fc-sniper.user.js'), 'utf8');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`);

function installMock() {
  const obs = (res, ms = 5) => ({ observe(ctx, cb) { setTimeout(() => cb({ unobserve() {} }, res), ms); } });
  window.ItemPile = { CLUB: 1, PURCHASED: 3, TRANSFER: 5, STORAGE: 6 };
  window.UTSearchCriteriaDTO = function () {};
  window.F = { coins: 100000, searches: [], bought: [] };
  let tid = 1;
  const card = (rating, price, league = 13) => ({ id: tid, definitionId: 7000 + rating, rating, leagueId: league, _staticData: { name: `Gold ${rating}` },
    _auction: { tradeId: tid++, buyNowPrice: price } });
  window.services = {
    User: { getUser: () => ({ coins: { amount: F.coins } }) },
    Item: {
      clearTransferMarketCache() {},
      searchTransferMarket(c) {
        F.searches.push({ level: c.level, rarities: c.rarities, league: c.league, pos: c._position, maxBuy: c.maxBuy, masked: c.maskedDefId });
        const items = [card(83, 2000), card(85, 6000), card(87, 9000)].filter((x) => !c.maxBuy || x._auction.buyNowPrice <= c.maxBuy);
        return obs({ success: true, data: { items } });
      },
      bid(item, price) { F.bought.push({ r: item.rating, price }); F.coins -= price; return obs({ success: true }); },
      move: () => obs({ success: true }),
      list: () => obs({ success: true }),
    },
  };
  localStorage.setItem('fc-sniper:config', JSON.stringify({ players: [], autoPrice: false, maxBuys: 1, delayMin: 3000, delayMax: 3500 }));
}

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  let restoreText = null; let promptBackup = null;
  p.on('dialog', (d) => {
    if (d.type() === 'prompt' && d.defaultValue()) { promptBackup = d.defaultValue(); return d.accept(); }
    if (d.type() === 'prompt' && restoreText) return d.accept(restoreText);
    return d.accept();
  });
  await p.route('http://fake.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><head><meta charset=utf-8></head><body style="background:#1d2b3a"></body></html>' }));
  await p.goto('http://fake.test/');
  await p.evaluate(installMock);
  await p.addScriptTag({ content: SCRIPT });
  await p.waitForSelector('#fcs');
  const log = () => p.evaluate(() => [...document.querySelectorAll('#fcs [data-r=log] div')].reverse().map((d) => d.textContent.replace(/^\d\d:\d\d:\d\d\s*/, '')));

  // Build a filter through the editor
  await p.click('#fcs [data-a=filter-new]');
  await p.selectOption('#fcs [data-ff=level]', 'gold');
  await p.selectOption('#fcs [data-ff=rarity]', '1');
  await p.selectOption('#fcs [data-ff=league]', '13');
  await p.selectOption('#fcs [data-ff=position]', 'ST');
  await p.fill('#fcs [data-ff=minRating]', '84');
  await p.fill('#fcs [data-ff=maxRating]', '86');
  await p.fill('#fcs [data-ff=manualMax]', '10000');
  await p.click('#fcs [data-a=filter-save]');
  const row = await p.textContent('#fcs [data-r=filters]');
  check('filter saved with readable summary', /Gold · Rare · Premier League · 84–86 · ST/.test(row) && /10,000/.test(row), row.replace(/\s+/g, ' '));
  // a second filter, switched off → must not be searched
  await p.click('#fcs [data-a=filter-new]');
  await p.selectOption('#fcs [data-ff=league]', '53');
  await p.fill('#fcs [data-ff=manualMax]', '5000');
  await p.click('#fcs [data-a=filter-save]');
  await p.click('#fcs [data-fon="1"]');
  await p.screenshot({ path: `${S}/filters.png` });

  await p.click('#fcs [data-a=toggle]');
  await p.waitForFunction(() => !document.querySelector('#fcs [data-a=toggle]').classList.contains('on') && window.F.searches.length > 0, null, { timeout: 120000 });
  const f = await p.evaluate(() => window.F);
  const sx = f.searches[0];
  check('filter search uses its quality, rarity, league, position and max', sx.level === 'gold' && sx.rarities[0] === 1 && sx.league === 13 && sx.pos === 'ST' && sx.maxBuy === 10000 && !sx.masked, JSON.stringify(sx));
  check('switched-off filter is not searched', !f.searches.some((x) => x.league === 53));
  check('snipe by rating: only the 85 is bought (not 83 or 87)', f.bought.length === 1 && f.bought[0].r === 85, JSON.stringify(f.bought));
  check('filter stays after a buy (not ticked off)', /Gold · Rare/.test(await p.textContent('#fcs [data-r=filters]')));

  // Profit calculator
  await p.click('#fcs [data-tab=trade]');
  await p.fill('#fcs [data-r=pc-buy]', '45000');
  await p.fill('#fcs [data-r=pc-sell]', '50000');
  const pc = await p.textContent('#fcs [data-r=pc-out]');
  check('profit calculator after tax', /You get 47,500 after tax/.test(pc) && /\+2,500 profit/.test(pc) && /break-even: sell for 47,500/.test(pc), pc);

  // Orange theme
  await p.click('#fcs [data-tab=settings]');
  await p.selectOption('#fcs [data-k=theme]', 'orange');
  check('orange theme applies', await p.evaluate(() => document.getElementById('fcs').classList.contains('orange')));
  await p.click('#fcs [data-tab=snipe]');
  await p.screenshot({ path: `${S}/filters-orange.png` });
  // Backup → change settings → restore → reload keeps the log
  await p.click('#fcs [data-tab=settings]');
  await p.click('#fcs [data-a=backup]');
  await p.waitForTimeout(500);
  let backup = promptBackup;
  if (!backup) backup = await p.evaluate(() => navigator.clipboard.readText().catch(() => null));
  let bj = null; try { bj = JSON.parse(backup); } catch { /* checked below */ }
  check('backup holds config, history and log', bj && bj.app === 'fc-sniper' && bj.config.filters.length === 2 && bj.config.theme === 'orange' && Array.isArray(bj.log) && bj.log.length > 3, backup && backup.slice(0, 80));
  await p.selectOption('#fcs [data-k=theme]', 'green');
  await p.evaluate(() => { const c = JSON.parse(localStorage.getItem('fc-sniper:config')); c.filters = []; localStorage.setItem('fc-sniper:config', JSON.stringify(c)); });
  restoreText = backup;
  await p.click('#fcs [data-a=restore]');
  await p.waitForTimeout(300);
  const rc = await p.evaluate(() => JSON.parse(localStorage.getItem('fc-sniper:config')));
  check('restore brings back filters and theme', rc.filters.length === 2 && rc.theme === 'orange' && (await log()).some((l) => /Backup from .* restored/.test(l)), `${rc.filters.length} filters, ${rc.theme}`);
  const before = (await log()).length;
  await p.reload();
  await p.evaluate(installMock);
  await p.evaluate(() => { /* keep the restored config, not the mock's */ });
  await p.addScriptTag({ content: SCRIPT });
  await p.waitForSelector('#fcs');
  const after = await log();
  check('log survives a reload', after.some((l) => /Backup from .* restored/.test(l)) && after.length >= before, `${before} → ${after.length} lines`);
  await p.click('#fcs [data-a=log-clear]').catch(() => {});
  check('no page errors', !errors.length, errors.join('; '));
  console.log('log:\n  ' + (await log()).join('\n  '));
  await b.close();
  console.log('\n' + results.join('\n'));
  if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
})().catch((e) => { console.error(e); console.log('\n' + results.join('\n')); process.exit(1); });
