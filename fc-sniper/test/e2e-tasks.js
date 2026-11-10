// End-to-end test for packs, SBCs and team upgrades against a mocked Web App.
// Usage: node test/e2e-tasks.js [screenshot-dir]   (needs Playwright; ~3 minutes)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const S = process.argv[2] || require('os').tmpdir();
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'fc-sniper.user.js'), 'utf8');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`);

const { installMock } = require('./mock-webapp');

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
  const note = await p.textContent('#fcs [data-r=plan] .note');
  check('solution shows safety summary', /13 protected/.test(note) && /no specials/.test(note) && /≤ 86/.test(note), note);
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
  check('active squad protected (starters)', !sub.flat().some((x) => x.def >= 100 && x.def <= 110));
  check('subs and reserves protected', !sub.flat().some((x) => x.def === 650 || x.def === 651));
  check('special cards not used', !sub.flat().some((x) => x.def >= 660 && x.def < 670));

  // ---- Upgrades
  await p.click('#fcs [data-tab=squad]');
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
  await p.click('#fcs [data-tab=squad]');
  await p.click('#fcs [data-a=forms]');
  await idle(p, 120000);
  const forms = await p.$$eval('#fcs [data-r=forms] > .list > .li b', (els) => els.map((e) => e.textContent));
  check('formations compared incl. best XI in current formation', forms.length >= 5 && forms.some((f) => /yours now/.test(f)) && forms.some((f) => /best XI/.test(f)), forms.join(' | '));
  const detail = await p.textContent('#fcs [data-r=forms] .sub');
  check('best option opens with In/Out changes', /In:/.test(detail) && /Out:/.test(detail), detail.replace(/\s+/g, ' ').slice(0, 120));
  const xi = await p.$$eval('#fcs [data-r=forms] .sub .li b', (els) => els.map((e) => e.textContent));
  check('lineup lists 11 slots', xi.length === 11, xi.slice(0, 3).join(' | '));
  const summary = await p.$$eval('#fcs [data-r=forms] > .list > .li small', (els) => els.map((e) => e.textContent));
  check('rows show rating/chem change and number of changes', summary.some((t) => /\(\+\d+\)/.test(t) && /change/.test(t)), summary.slice(0, 3).join(' | '));
  await p.click('#fcs [data-a=form-create]');
  await idle(p);
  const created = await p.evaluate(() => T.created);
  check('creates a new squad with 11 players', created && created.n === 11 && /^f\d/.test(created.formation), JSON.stringify(created));
  const flog = (await log(p)).filter((l) => /^Read \d+ players/.test(l));
  check('logs players read per position', flog.length === 1, flog[0]);
  await p.screenshot({ path: `${S}/t-forms.png` });

  // SBC pool diagnostics
  check('SBC log explains skipped players', (await log(p)).some((l) => /Club: read \d+ · usable for SBCs \d+ · skipped .*in your squad/.test(l)));

  // copy log works (falls back to prompt if clipboard is blocked)
  await p.click('#fcs [data-tab=log]');
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
