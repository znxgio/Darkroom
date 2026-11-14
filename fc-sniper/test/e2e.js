// End-to-end test: runs the userscript in Chromium against a mocked Web App.
// Usage: npm run e2e [screenshot-dir]   (needs Playwright; takes ~2 minutes)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const S = process.argv[2] || require('os').tmpdir();
const SCRIPT = fs.readFileSync(require('path').join(__dirname, '..', 'fc-sniper.user.js'), 'utf8');
const DB = { Players: [
  { id: 231747, f: 'Kylian', l: 'Mbappé Lottin', c: 'Mbappé', r: 91 },
  { id: 239085, f: 'Erling', l: 'Haaland', r: 91 } ] };
const DB_PATH = '/ea-sports-fc/ultimate-team/web-app/content/G/2027/fut/items/web/players.json';
const results = [];
const check = (name, ok, info = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`); };

async function page(b, mobile) {
  const ctx = await b.newContext(mobile ? devices['iPhone 13'] : { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('dialog', (d) => d.type() === 'prompt' ? d.accept(p.nextPrompt || '') : d.accept());
  p.discord = [];
  await p.route('https://discord.com/**', (r) => { p.discord.push(r.request().postData()); r.fulfill({ status: 204 }); });
  await p.route('http://fake.test/**', (r) => r.request().url().endsWith('players.json')
    ? r.fulfill({ contentType: 'application/json', body: JSON.stringify(DB) })
    : r.fulfill({ contentType: 'text/html', body: `<html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#2b3a4a;font-family:system-ui"><div style="color:#fff;padding:20px;font-size:20px">EA SPORTS FC — Ultimate Team Web App (mock)</div><script>fetch('${DB_PATH}')</script></body></html>` }));
  await p.goto('http://fake.test/ea-sports-fc/ultimate-team/web-app/');
  await p.evaluate(() => {
    const obs = (res) => ({ observe(ctx, cb) { setTimeout(() => cb({ unobserve() {} }, res), 5); } });
    const market = [];
    for (let i = 0; i < 60; i++) market.push({ id: i, def: 231747, bin: 50000 + i * 1000 });
    for (let i = 0; i < 30; i++) market.push({ id: 100 + i, def: 239085, bin: 80000 + i * 1000 });
    [202, 239, 271, 303].forEach((id, i) => market.push({ id, def: 50331648 + 231747, bin: 120000 + i * 1000, rf: 3, r: 95 })); // a special Mbappé card (ids that land on page 1)
    window.T = { coins: 1000000, calls: [], bought: [], listed: [], snipe: false, failNext: 0, tidy: 0 };
    window.UTSearchCriteriaDTO = function () {}; window.ItemPile = { TRANSFER: 5 };
    window.services = { User: { getUser: () => ({ coins: { amount: T.coins } }) }, Item: {
      searchTransferMarket(c) {
        T.calls.push({ def: c.maskedDefId, max: c.maxBuy || 0 });
        if (T.failNext) { const s = T.failNext; T.failNext = 0; return obs({ success: false, status: s }); }
        let hits = market.slice();
        if (T.snipe) hits.push({ id: 777, def: 231747, bin: 26000 });
        hits = hits.filter((m) => (!c.maskedDefId || (m.def & 0xFFFFFF) === c.maskedDefId) && (!c.maxBuy || m.bin <= c.maxBuy)); // EA: base id matches every version
        const items = hits.sort((a, b) => (a.id * 7919) % 101 - (b.id * 7919) % 101).slice(0, 20)
          .map((m) => ({ definitionId: m.def, rating: m.r || 91, rareflag: m.rf ?? 1, _staticData: { name: m.def === 231747 ? 'Mbappé' : 'Haaland' }, _auction: { tradeId: m.id, buyNowPrice: m.bin } }));
        return obs({ success: true, data: { items } });
      },
      bid(item, price) { T.bought.push(price); T.coins -= price; return obs({ success: true }); },
      move() { return obs({ success: true }); },
      list(item, s, bn) { T.listed.push(bn); return obs({ success: true }); },
      relistExpiredAuctions() { T.tidy++; return obs({ success: true }); },
      clearSoldItems() { T.tidy++; return obs({ success: true }); } } };
  });
  await p.addScriptTag({ content: SCRIPT });
  await p.waitForSelector('#fcs');
  return p;
}
const log = (p) => p.evaluate(() => [...document.querySelectorAll('#fcs [data-r=log] div')].reverse().map((d) => d.textContent.replace(/^\d\d:\d\d:\d\d\s*/, '')));
const idle = (p) => p.waitForFunction(() => !document.querySelector('#fcs [data-a=toggle]').classList.contains('on') && !document.querySelector('#fcs [data-a=toggle]').disabled, null, { timeout: 90000 });

(async () => {
  const b = await chromium.launch();

  // ---------- desktop: full flow
  const p = await page(b, false);
  await p.fill('#fcs [data-r=pq]', 'mbappe');
  await p.click('#fcs .sugg [data-pick]');
  // 2.4.10: the market shows two Mbappé cards — pick the base (Rare) one
  await p.waitForSelector('#fcs .sugg [data-ver]', { timeout: 30000 });
  const vers = await p.$$eval('#fcs .sugg .vcard', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  check('card versions shown after a name pick (special + base)', vers.length === 2 && /95/.test(vers[0]) && /Special/.test(vers[0]) && /91/.test(vers[1]) && /Rare/.test(vers[1]), JSON.stringify(vers));
  await p.click('#fcs .sugg .vcard:nth-child(2)');
  await p.waitForFunction(() => /avg/.test(document.querySelector('#fcs .chip small')?.textContent || ''), null, { timeout: 60000 });
  await idle(p);
  check('name search + auto price check', (await p.textContent('#fcs .chip .mx')).includes('48,000'), await p.textContent('#fcs .chip'));
  await p.fill('#fcs [data-r=pq]', 'haal');
  await p.press('#fcs [data-r=pq]', 'Enter');
  await p.waitForFunction(() => document.querySelectorAll('#fcs .chip').length === 2 && /avg/.test(document.querySelectorAll('#fcs .chip small')[1].textContent), null, { timeout: 60000 });
  await idle(p);
  // manual max for Haaland
  p.nextPrompt = '70,000';
  await p.click('#fcs .chip:nth-child(2) .mx');
  check('manual max buy via tap', (await p.textContent('#fcs .chip:nth-child(2) .mx')).includes('70,000'));
  // selling: market avg + relist, discord webhook
  await p.click('#fcs [data-tab=settings]');
  await p.selectOption('#fcs [data-k=sellMode]', 'market');
  await p.click('#fcs [data-k=autoRelist] + i');
  await p.click('#fcs [data-tab=settings]');
  await p.fill('#fcs [data-k=discordWebhook]', 'https://discord.com/api/webhooks/1/abc');
  await p.click('#fcs [data-a=discord-test]');
  await p.waitForTimeout(300);
  check('discord test notification', p.discord.length === 1 && p.discord[0].includes('FC Sniper connected'));
  await p.screenshot({ path: `${S}/v1-desktop-safety.png` });
  await p.click('#fcs [data-tab=snipe]');
  await p.fill('#fcs [data-k=maxBuys]', '1');
  await p.click('#fcs [data-k=smartSnipe] + i'); // classic fixed-discount path (smart sniping has its own test)
  await p.evaluate(() => { T.snipe = true; T.calls.length = 0; });
  await p.click('#fcs [data-a=toggle]');
  await idle(p);
  const t = await p.evaluate(() => T);
  check('relist/clear on start', t.tidy === 2);
  check('bought the 26k snipe', t.bought.join() === '26000', `bought ${t.bought}`);
  check('listed at market avg', t.listed.join() === '52000', `listed ${t.listed}`);
  check('searched with per-player max', t.calls[0] && t.calls[0].max === 48000, JSON.stringify(t.calls));
  check('discord buy notification', p.discord.some((d) => d.includes('Bought Mbappé')));
  await p.screenshot({ path: `${S}/v1-desktop-snipe.png` });
  await p.click('#fcs [data-tab=history]');
  check('history recorded', (await p.textContent('#fcs [data-r=hist]')).includes('listed 52,000'), (await p.textContent('#fcs [data-r=hist]')).trim().slice(0, 80));
  check('profit card renders', (await p.textContent('#fcs [data-r=profit]')).includes('💰 Profit'));
  await p.screenshot({ path: `${S}/v1-desktop-history.png` });
  console.log('desktop log:\n  ' + (await log(p)).join('\n  '));

  // alert mode: should not buy
  await p.click('#fcs [data-tab=snipe]');
  // keep Mbappé on the list for the alert run (Buy each player once ticked him off)
  await p.fill('#fcs [data-r=pq]', 'mbappe');
  await p.press('#fcs [data-r=pq]', 'Enter');
  await p.waitForSelector('#fcs .sugg .vcard', { timeout: 30000 }); // pick the base card
  await p.click('#fcs .sugg .vcard:nth-child(2)');
  await p.waitForTimeout(400);
  await p.waitForFunction(() => !document.querySelector('#fcs [data-a=price]').disabled, null, { timeout: 60000 });
  await p.click('#fcs .seg [data-v=alert]');
  await p.click('#fcs [data-tab=settings]');
  await p.fill('#fcs [data-k=maxSearches]', '2');
  await p.click('#fcs [data-tab=snipe]');
  await p.evaluate(() => { T.bought.length = 0; });
  await p.click('#fcs [data-a=toggle]');
  await idle(p);
  const t2 = await p.evaluate(() => T);
  const lg = await log(p);
  check('alert mode notifies without buying', t2.bought.length === 0 && lg.some((l) => l.includes('👀 Mbappé')), lg.slice(-4).join(' | '));
  check('alert stopped at session search limit (raised to safe min if needed)', lg.some((l) => /session search limit/.test(l)));

  // captcha lock
  await p.click('#fcs .seg [data-v=buy]');
  await p.evaluate(() => { T.failNext = 458; });
  await p.click('#fcs [data-tab=settings]');
  await p.fill('#fcs [data-k=maxSearches]', '50');
  await p.click('#fcs [data-tab=snipe]');
  await p.click('#fcs [data-a=toggle]');
  await idle(p);
  const lg2 = await log(p);
  check('captcha → stop + 3h lock', lg2.some((l) => /3 h/.test(l)) && (await p.textContent('#fcs [data-r=pill]')) === 'Locked');
  check('no page errors (desktop)', p.errors.length === 0, p.errors.join('; '));

  // ---------- mobile look
  const m = await page(b, true);
  await m.screenshot({ path: `${S}/v1-mobile-min.png` });
  // collapsed handle (2.5.0): real touch input — drag from anywhere (▶ included), a small wobble is a tap that's
  // swallowed when it turns into a drag, and the handle stays on screen
  const cdp = await m.context().newCDPSession(m);
  const touch = async (pts) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1] }] });
    for (const [x, y] of pts.slice(1)) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); await m.waitForTimeout(16); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await m.waitForTimeout(250);
  };
  const center = (sel) => m.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel);
  const startLog = () => log(m).then((l) => l.filter((x) => /Add a player or turn on a search filter first/.test(x)).length);
  const n0 = await startLog();
  const [gx, gy] = await center('#fcs [data-a=toggle]');
  await touch([[gx, gy], [gx - 3, gy - 4], [gx - 6, gy - 8]]); // ~10 px wobble that started on ▶
  const wob = { started: (await startLog()) > n0, min: await m.evaluate(() => document.querySelector('#fcs').classList.contains('min')) };
  check('a 10 px drag that starts on ▶ does not press ▶', !wob.started && wob.min, JSON.stringify(wob));
  const [hx, hy] = await center('#fcs [data-a=toggle]');
  await touch([[hx, hy], [hx - 20, hy - 20], [hx - 120, hy - 60], [40, hy - 80]]); // a real drag from ▶ to the left
  const side = await m.evaluate(() => {
    const box = document.querySelector('#fcs').getBoundingClientRect();
    return { lft: document.querySelector('#fcs').classList.contains('lft'), left: Math.round(box.left), saved: JSON.parse(localStorage.getItem('fc-sniper:ui') || '{}').handleLeft };
  });
  check('phone handle drags from ▶ and snaps to the left edge, remembered', side.lft && side.left < 20 && side.saved === true && (await startLog()) === n0, JSON.stringify(side));
  // a saved position below the screen (rotation / Safari toolbar) is pulled back on screen
  const kept = await m.evaluate(async () => {
    localStorage.setItem('fc-sniper:ui', JSON.stringify({ ...JSON.parse(localStorage.getItem('fc-sniper:ui') || '{}'), handleTop: 5000 }));
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 50));
    const b = document.querySelector('#fcs').getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), vh: window.innerHeight };
  });
  check('handle stays on screen when its saved spot is off screen', kept.bottom <= kept.vh && kept.top >= 0, JSON.stringify(kept));
  await m.tap('#fcs [data-a=fold]');
  await m.fill('#fcs [data-r=pq]', 'mbap');
  await m.waitForSelector('#fcs .sugg [data-pick]');
  await m.screenshot({ path: `${S}/v1-mobile-search.png` });
  await m.tap('#fcs .sugg [data-pick]');
  await m.waitForSelector('#fcs .sugg .vcard', { timeout: 30000 });
  await m.screenshot({ path: `${S}/v1-mobile-versions.png` });
  await m.tap('#fcs .sugg .vcard:nth-child(1)');
  await m.waitForFunction(() => /Special/.test(document.querySelector('#fcs .chip')?.textContent || ''), null, { timeout: 30000 });
  check('special card added with its own id (only that card is hunted)', await m.evaluate(() => JSON.parse(localStorage.getItem('fc-sniper:config')).players.some((x) => x.id === 50331648 + 231747)));
  await m.waitForFunction(() => /avg/.test(document.querySelector('#fcs .chip small')?.textContent || ''), null, { timeout: 60000 });
  await m.waitForTimeout(400);
  await m.screenshot({ path: `${S}/v1-mobile-snipe.png` });
  await m.tap('#fcs [data-tab=settings]');
  await m.screenshot({ path: `${S}/v1-mobile-sell.png` });
  await m.evaluate(() => { for (let i = 0; i < 3; i++) document.querySelector('#fcs [data-r=log]')?.insertAdjacentHTML('afterbegin', `<div>${'x'.repeat(400)}</div>`); });
  await m.tap('#fcs [data-tab=log]');
  const wide = await m.evaluate(() => { const bd = document.querySelector('#fcs .body'); return { body: bd.scrollWidth - bd.clientWidth, page: document.documentElement.scrollWidth - innerWidth }; });
  check('phone panel never scrolls sideways (long log line)', wide.body <= 0 && wide.page <= 0, JSON.stringify(wide));
  check('no page errors (mobile)', m.errors.length === 0, m.errors.join('; '));

  await b.close();
  console.log('\n' + results.join('\n'));
})().catch((e) => { console.error(e); console.log('\n' + results.join('\n')); process.exit(1); }).then(() => { if (results.some((r) => r.startsWith('FAIL'))) process.exit(1); });
