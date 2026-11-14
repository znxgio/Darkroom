// End-to-end test for the session plan (2.4.7) against the shared mock Web App.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { installMock } = require('./mock-webapp');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'fc-sniper.user.js'), 'utf8');
const S = process.argv[2] || '/tmp';
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`);

async function page(b, setup) {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.route('http://fake.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><head><meta charset=utf-8></head><body></body></html>' }));
  await p.goto('http://fake.test/');
  await p.evaluate(installMock);
  await p.evaluate(setup);
  await p.addScriptTag({ content: SCRIPT });
  await p.waitForSelector('#fcs');
  return p;
}
const log = (p) => p.evaluate(() => [...document.querySelectorAll('#fcs [data-r=log] div')].reverse().map((d) => d.textContent.replace(/^\d\d:\d\d:\d\d\s*/, '')));
const base = {
  players: [{ id: 999999, name: 'Nobody', rating: 85, manualMax: 500 }], autoPrice: false, bidSnipe: false, bidOn240: true, snipe246: true, trade242: true, reprice244: true,
  maxSearches: 3, delayMin: 3000, delayMax: 4500, pauseEvery: 60, minCoins: 0, sessionMinutes: 40,
  planBlocks: 2, planBlockMin: 10, planBreakMin: 20, planBudgetPct: 10, planSbcMax: 2, planSbcCoins: 2000, planSbcs: [{ id: 1, name: '84+ Upgrade' }], planKeepAlive: true,
};

(async () => {
  const b = await chromium.launch();

  // 1) two blocks, one break with the ticked SBC, settings put back at the end
  const p = await page(b, new Function(`localStorage.setItem('fc-sniper:config', ${JSON.stringify(JSON.stringify(base))}); localStorage.setItem('fc-sniper:test-minute-ms', '100');`));
  await p.click('#fcs [data-r=plan-card] summary');
  const summary = await p.textContent('#fcs [data-r=plan-info]');
  check('plan summary before start (blocks, budget, floor)', /2 × 10 min sniping, 20 min breaks/.test(summary) && /can spend up to 12,000/.test(summary) && /never below 108,000/.test(summary), summary);
  await p.click('#fcs [data-a=plan-start]');
  await p.waitForFunction(() => [...document.querySelectorAll('#fcs [data-r=log] div')].some((d) => /Plan ended/.test(d.textContent)), null, { timeout: 300000 });
  const l1 = await log(p);
  const cfg1 = await p.evaluate(() => JSON.parse(localStorage.getItem('fc-sniper:config')));
  check('both blocks ran, each after a passed check', l1.filter((x) => /📋 Block \d of 2: .*check passed/.test(x)).length === 2, l1.filter((x) => /📋/.test(x)).join(' | ').slice(0, 400));
  check('ticked SBC done in the break', l1.some((x) => /📋 84\+ Upgrade done/.test(x)), l1.filter((x) => /84\+|SBC/.test(x)).join(' | ').slice(0, 300));
  check('plan ends normally', l1.some((x) => /Plan ended — all 2 blocks done/.test(x)), l1.filter((x) => /Plan ended/.test(x))[0]);
  check('plan button says Start again after the plan ended', (await p.textContent('#fcs [data-a=plan-start]')).trim() === 'Start plan', await p.textContent('#fcs [data-a=plan-start]'));
  check('Keep coins and session length put back after the plan', cfg1.minCoins === 0 && cfg1.sessionMinutes === 40, JSON.stringify({ minCoins: cfg1.minCoins, sessionMinutes: cfg1.sessionMinutes }));
  check('no page errors (plan)', !p.errors.length, p.errors.join('; '));
  await p.context().close();

  // 2) a captcha in block 1 ends the whole plan at once (and locks)
  const q = await page(b, new Function(`localStorage.setItem('fc-sniper:config', ${JSON.stringify(JSON.stringify({ ...base, maxSearches: 20 }))}); localStorage.setItem('fc-sniper:test-minute-ms', '100');
    const orig = services.Item.searchTransferMarket; let n = 0;
    services.Item.searchTransferMarket = function (c) { n++; if (n >= 4) return { observe(ctx, cb) { setTimeout(() => cb({ unobserve() {} }, { success: false, status: 458 }), 5); } }; return orig.call(this, c); };`));
  await q.click('#fcs [data-r=plan-card] summary');
  await q.click('#fcs [data-a=plan-start]');
  await q.waitForFunction(() => [...document.querySelectorAll('#fcs [data-r=log] div')].some((d) => /Plan ended/.test(d.textContent)), null, { timeout: 200000 });
  const l2 = await log(q);
  const saf = await q.evaluate(() => JSON.parse(localStorage.getItem('fc-sniper:safety') || '{}'));
  check('captcha ends the plan at once, no second block', l2.some((x) => /Plan ended — block 1 ended: EA verification/.test(x)) && !l2.some((x) => /📋 Block 2/.test(x)), l2.filter((x) => /📋|Stopped/.test(x)).join(' | ').slice(0, 300));
  check('captcha sets the safety lock', saf.lockUntil > Date.now(), JSON.stringify(saf).slice(0, 120));
  await q.context().close();

  // 3) a plan running when the page reloads is never resumed; settings are put back
  const st = { startedAt: Date.now() - 600e3, startCoins: 120000, budget: 12000, floor: 108000, block: 1, blocks: 3, sbcDone: {}, sbcFailed: [], ended: '', saved: { minCoins: 0, sessionMinutes: 40 } };
  const r = await page(b, new Function(`localStorage.setItem('fc-sniper:config', ${JSON.stringify(JSON.stringify({ ...base, minCoins: 108000, sessionMinutes: 10 }))}); localStorage.setItem('fc-sniper:plan', ${JSON.stringify(JSON.stringify(st))});`));
  await r.waitForTimeout(500);
  const l3 = await log(r);
  const cfg3 = await r.evaluate(() => JSON.parse(localStorage.getItem('fc-sniper:config')));
  check('interrupted plan not resumed after reload, settings put back', l3.some((x) => /Plan interrupted at block 1 of 3/.test(x)) && cfg3.minCoins === 0 && cfg3.sessionMinutes === 40 && !l3.some((x) => /Block 2/.test(x)), JSON.stringify({ log: l3.filter((x) => /📋/.test(x)), minCoins: cfg3.minCoins }));

  // 4) budget 0 % → floor = coins now → refuses to snipe
  const f = await page(b, new Function(`localStorage.setItem('fc-sniper:config', ${JSON.stringify(JSON.stringify({ ...base, planBudgetPct: 0 }))});`));
  await f.click('#fcs [data-r=plan-card] summary');
  await f.click('#fcs [data-a=plan-start]');
  await f.waitForFunction(() => [...document.querySelectorAll('#fcs [data-r=log] div')].some((d) => /Plan ended/.test(d.textContent)), null, { timeout: 60000 });
  const l4 = await log(f);
  check('no budget → plan ends at the coin floor before sniping', l4.some((x) => /Plan ended — coin floor reached/.test(x)) && !l4.some((x) => /📋 Block 1 of/.test(x)), l4.filter((x) => /📋/.test(x)).join(' | '));
  // 5) SBC ranker + coin goal (2.5.0)
  const g = await page(b, new Function(`localStorage.setItem('fc-sniper:config', ${JSON.stringify(JSON.stringify({ ...base, sbcBuyLimit: 100, sbcBuyMissing: true, hotAuto: false, minCoins: 119000 } // 1,000 free: the SBC is over both the limit and your coins))});`));
  await g.click('#fcs [data-tab=sbc]');
  await g.click('#fcs [data-a=sbc-rank]');
  await g.waitForFunction(() => [...document.querySelectorAll('#fcs [data-r=log] div')].some((d) => /SBCs ranked/.test(d.textContent)), null, { timeout: 200000 });
  const lg5 = await log(g);
  const firstSet = await g.$eval('#fcs [data-r=sbc] .li', (e) => e.textContent.replace(/\s+/g, ' '));
  check('SBC ranker: summary line and club-solvable SBCs first', lg5.some((x) => /🧩 SBCs ranked: [1-9]\d* likely from your club/.test(x)) && /from your club/.test(firstSet), `${lg5.filter((x) => /ranked/.test(x))[0]} | first: ${firstSet.slice(0, 80)}`);
  // an SBC that needs more buys than allowed → goal card → trade toward it
  const eliteI = await g.$$eval('#fcs [data-a=sbc-solve]', (bs) => bs.findIndex((x) => /Break Away/.test(x.closest('.li') ? x.closest('.li').textContent : '')));
  const btns = await g.$$('#fcs [data-a=sbc-solve]');
  if (eliteI >= 0) await btns[eliteI].click();
  await g.waitForFunction(() => !document.querySelector('#fcs [data-r=goal]').hidden, null, { timeout: 120000 }).catch(() => {});
  const goalTxt = await g.$eval('#fcs [data-r=goal]', (e) => (e.hidden ? '' : e.textContent.replace(/\s+/g, ' ')));
  check('coin goal offered when an SBC needs more than you can spend', /Not enough coins yet/.test(goalTxt) && /Trade toward [\d,]+/.test(goalTxt), goalTxt.slice(0, 160) || `eliteI=${eliteI}`);
  if (goalTxt) {
    await g.click('#fcs [data-a=goal-start]');
    await g.waitForTimeout(1500);
    const gc = await g.evaluate(() => JSON.parse(localStorage.getItem('fc-sniper:config')));
    check('trading toward the goal: Trade mode with the goal saved', gc.mode === 'trade' && gc.goal && gc.goal.coins >= 1000, JSON.stringify({ mode: gc.mode, goal: gc.goal }));
  }
  check('no page errors (SBC ranker/goal)', !g.errors.length, g.errors.join('; '));

  check('no page errors', !q.errors.length && !r.errors.length && !f.errors.length, [...q.errors, ...r.errors, ...f.errors].join('; '));

  await b.close();
  console.log('\n' + results.join('\n'));
  if (results.some((x) => x.startsWith('FAIL'))) process.exit(1);
})().catch((e) => { console.error(e); console.log('\n' + results.join('\n')); process.exit(1); });
