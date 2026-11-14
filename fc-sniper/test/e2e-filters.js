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

  // Status strip on every tab, locked state + why-toast, no layout jump when the bot starts
  await p.click('#fcs [data-tab=settings]');
  const stripTxt = await p.textContent('#fcs [data-r=strip]');
  check('status strip shows Idle and usage on a non-Snipe tab', /Idle/.test(stripTxt) && /searches \d+\/\d+ · buys \d+/.test(stripTxt), stripTxt);
  const stripH = await p.evaluate(() => document.querySelector('#fcs [data-r=strip]').getBoundingClientRect().height);
  check('status strip is at most 26px tall', stripH > 0 && stripH <= 26, String(stripH));
  await p.click('#fcs [data-tab=snipe]');
  check('not locked while idle', !(await p.evaluate(() => document.getElementById('fcs').classList.contains('locked'))));
  const tabY = () => p.evaluate(() => document.querySelector('#fcs [data-tab=trade]').getBoundingClientRect().top);
  const y0 = await tabY();
  await p.click('#fcs [data-a=toggle]');
  await p.waitForFunction(() => document.getElementById('fcs').classList.contains('locked'), null, { timeout: 10000 });
  check('tab buttons do not move when the bot starts (job bar overlays)', Math.abs((await tabY()) - y0) < 0.5, `${y0} → ${await tabY()}`);
  check('status strip shows live state while running', !/^Idle/.test(await p.textContent('#fcs [data-r=s-state]')) || /next search|\d+ s/.test(await p.textContent('#fcs [data-r=strip]')), await p.textContent('#fcs [data-r=strip]'));
  await p.click('#fcs [data-tab=snipe]');
  const tgState = () => p.evaluate(() => document.querySelector('#fcs [data-pane=snipe] label.row.tg input').checked);
  const tg0 = await tgState();
  await p.click('#fcs [data-pane=snipe] label.row.tg span', { force: true });
  const toastTxt = await p.textContent('#fcs-toast');
  check('tapping a locked toggle shows the why-toast', /Stop the bot \(■\) to change this/.test(toastTxt) && await p.evaluate(() => document.getElementById('fcs-toast').classList.contains('show')), toastTxt);
  check('locked toggle left the setting unchanged', (await tgState()) === tg0);
  await p.click('#fcs [data-a=toggle]');
  await p.waitForFunction(() => !document.getElementById('fcs').classList.contains('locked'), null, { timeout: 10000 });

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
  // Gallery probe: read-only, finds a gallery service and logs its shape
  await p.evaluate(() => {
    const obs = (res) => ({ observe(ctx, cb) { setTimeout(() => cb({ unobserve() {} }, res), 5); } });
    window.F.galleryCalls = 0;
    services.Gallery = { requestGallerySets() { F.galleryCalls++; return obs({ success: true, response: { sets: [{ id: 1, name: 'Arsenal', slots: 20 }] } }); }, gradeSet(a, b) { F.galleryGraded = true; } };
    window.UTGallerySetEntity = function () {};
  });
  await p.click('#fcs [data-tab=log]');
  await p.evaluate(() => { const d = document.querySelector('#fcs [data-pane=log] details'); if (d) d.open = true; }); // Diagnostics fold
  await p.click('#fcs [data-a=gallery-probe]');
  await p.waitForFunction(() => [...document.querySelectorAll('#fcs [data-r=log] div')].some((d) => /Gallery/.test(d.textContent) && /details saved/.test(d.textContent)), null, { timeout: 30000 });
  let copied = null;
  const prev = restoreText; restoreText = null;
  p.removeAllListeners('dialog');
  p.on('dialog', (d) => { copied = d.defaultValue(); d.accept(); });
  await p.click('#fcs [data-a=copy-log]');
  await p.waitForTimeout(500);
  if (!copied) copied = await p.evaluate(() => { const t = document.querySelector('#fcs [data-r=copytext]'); return t && !t.closest('[hidden]') ? t.value : ''; });
  if (!copied) copied = await p.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  const G = await p.evaluate(() => ({ calls: F.galleryCalls, graded: !!F.galleryGraded }));
  check('gallery probe finds the service, its methods, globals and data shape', /gallery-like services: .*Gallery/.test(copied) && /requestGallerySets\(0\)/.test(copied) && /UTGallerySetEntity/.test(copied) && /keys sets/.test(copied), (copied || '').split('\n').filter((l) => /gallery probe/.test(l)).slice(0, 3).join(' | ').slice(0, 300));
  check('gallery probe is read-only (one read request, no grading)', G.calls === 1 && !G.graded, JSON.stringify(G));
  void prev;
  // Search recorder: read-only, notes the Web App's own searches, ignores the bot's, then puts the function back
  const recBefore = await p.evaluate(() => { window.F.origSearch = services.Item.searchTransferMarket; return F.searches.length; });
  await p.click('#fcs [data-a=record-search]');
  await p.evaluate(() => {
    const c = new UTSearchCriteriaDTO(); c.type = 'player'; c.level = 'gold'; c.rarities = [1]; c.league = 13; c.maxBuy = 7400;
    for (let i = 0; i < 3; i++) services.Item.searchTransferMarket(c, i + 1);
  });
  await p.waitForFunction(() => [...document.querySelectorAll('#fcs [data-r=log] div')].some((d) => /Recorded 3 Web App search/.test(d.textContent)), null, { timeout: 10000 });
  copied = null;
  await p.click('#fcs [data-a=copy-log]');
  await p.waitForTimeout(500);
  if (!copied) copied = await p.evaluate(() => { const t = document.querySelector('#fcs [data-r=copytext]'); return t && !t.closest('[hidden]') ? t.value : ''; });
  if (!copied) copied = await p.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  const R = await p.evaluate((n) => ({ restored: services.Item.searchTransferMarket === F.origSearch, passed: F.searches.length - n }), recBefore);
  check('search recorder logs the Web App search fields', /web app search: page 1: .*"rarities":\[1\]/.test(copied || '') && /"level":"gold"/.test(copied || ''), (copied || '').split('\n').filter((l) => /web app search/.test(l)).join(' | ').slice(0, 300));
  check('search recorder passes searches through and restores the original', R.restored && R.passed === 3, JSON.stringify(R));
  check('no page errors', !errors.length, errors.join('; '));
  console.log('log:\n  ' + (await log()).join('\n  '));
  await b.close();
  console.log('\n' + results.join('\n'));
  if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
})().catch((e) => { console.error(e); console.log('\n' + results.join('\n')); process.exit(1); });
