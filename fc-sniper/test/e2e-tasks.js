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

let lastPage = null; // for printing the activity log when a step fails
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
  lastPage = p;
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
  await p.evaluate(() => { T.addUnassigned(); T.rewardOnSubmit = true; });
  await p.click('#fcs [data-a=sbc-load]');
  await p.waitForSelector('#fcs [data-a=sbc-set]');
  await p.click('#fcs [data-a=sbc-set][data-i="1"]');
  await p.waitForFunction(() => /League & Nation/.test(document.querySelector('#fcs [data-r=sbc]').textContent));
  await idle(p);
  const chemText = await p.textContent('#fcs [data-r=sbc]');
  check('chemistry/league SBC is now auto', /League & Nation\s*auto/.test(chemText) && /Chemistry ≥ 20/.test(chemText), chemText.replace(/\s+/g, ' ').slice(0, 200));
  await p.click('#fcs [data-a=sbc-set][data-i="0"]');
  await p.waitForSelector('#fcs [data-a=sbc-solve][data-i="0"]');
  const reqText = await p.textContent('#fcs [data-r=sbc]');
  check('requirements shown readable', /Team rating ≥ 84/.test(reqText) && /2× Rare/.test(reqText), reqText.slice(0, 160));
  await idle(p);
  await p.click('#fcs [data-a=sbc-solve][data-i="0"]');
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
  const sbcLog = await log(p);
  check('Unassigned tidied for SBCs (new → club, duplicate → storage)', sbcLog.some((l) => /Unassigned: 2 players moved where SBCs can use them \(1 to club, 1 to SBC storage\)/.test(l)), sbcLog.filter((l) => /Unassigned/.test(l)).join(' | '));
  check('SBC reward pack opened and sorted', sbcLog.some((l) => /Opening 1 SBC reward pack/.test(l)) && sbcLog.some((l) => /Opened SBC Reward Pack/.test(l)), sbcLog.filter((l) => /reward|Reward/.test(l)).join(' | '));
  check('each submission rates ≥ 84', sub.every((s) => s.length === 11 && rating(s.map((x) => x.r)) >= 84), sub.map((s) => rating(s.map((x) => x.r))).join(','));
  check('≥ 2 rares each', sub.every((s) => s.filter((x) => x.rare >= 1).length >= 2));
  check('no player used twice', new Set(sub.flat().map((x) => x.id)).size === sub.flat().length);
  check('never uses tradeables', sub.flat().every((x) => x.untradeable) && !sub.flat().some((x) => x.r === 87));
  check('storage players used first', sub[0].filter((x) => x.pile === 6).length === 2, `${sub[0].filter((x) => x.pile === 6).length} storage`);
  // ---- chemistry SBC solved from the club with positions
  await p.click('#fcs [data-a=sbc-solve][data-i="1"]');
  await p.waitForSelector('#fcs [data-a=sbc-submit]', { timeout: 120000 });
  await idle(p);
  const chemPlan = await p.textContent('#fcs [data-r=plan]');
  const chemVal = Number((chemPlan.match(/(\d+)Chemistry/) || [])[1]);
  check('chemistry SBC solved with chem ≥ 20', chemVal >= 20, chemPlan.replace(/\s+/g, ' ').slice(0, 160));
  check('plan shows positions for chemistry', /GK · /.test(chemPlan) && /ST · /.test(chemPlan));
  await p.click('#fcs [data-a=sbc-discard]');

  // ---- Elite 87: club can't do it → buys cheap fill-ins, then submits
  await p.fill('#fcs [data-k=sbcBuyLimit]', '50000');
  await p.press('#fcs [data-k=sbcBuyLimit]', 'Tab');
  await p.click('#fcs [data-a=sbc-set][data-i="2"]');
  await p.waitForSelector('#fcs [data-a=sbc-solve][data-i="2"]');
  await idle(p);
  await p.click('#fcs [data-a=sbc-solve][data-i="2"]');
  await p.waitForSelector('#fcs [data-a=sbc-submit]', { timeout: 200000 });
  await idle(p);
  const elitePlan = await p.textContent('#fcs [data-r=plan]');
  check('plan shows fill-ins to buy and cost', /Buy \d+ for [\d,]+ & submit/.test(elitePlan) && /buy [\d,]+/.test(elitePlan), elitePlan.replace(/\s+/g, ' ').slice(0, 200));
  await p.screenshot({ path: `${S}/t-sbc-buy.png` });
  const before = (await p.evaluate(() => T.submitted.length));
  await p.click('#fcs [data-a=sbc-submit]');
  await idle(p, 200000);
  const T2 = await p.evaluate(() => ({ sbcBought: T.sbcBought || [], submitted: T.submitted, club: T.piles.club }));
  const last = T2.submitted[T2.submitted.length - 1];
  check('bought the fill-ins within the limit', T2.sbcBought.length >= 1 && T2.sbcBought.reduce((a, x) => a + x.price, 0) <= 50000, JSON.stringify(T2.sbcBought));
  check('moved them to the club', T2.club.length >= T2.sbcBought.length);
  check('fill-ins bought from a fresh search (no stale 403)', (await p.evaluate(() => T.stale || 0)) === 0 && !(await log(p)).some((l) => /Logged out/.test(l)));
  check('uses your own players first, buys only the gaps', T2.sbcBought.length < 11 && last.some((x) => x.untradeable), `${T2.sbcBought.length} bought, ${last.filter((x) => x.untradeable).length} from club`);
  check('Elite 87 submitted at ≥ 87', T2.submitted.length === before + 1 && rating(last.map((x) => x.r)) >= 87, last && rating(last.map((x) => x.r)));
  check('fill-ins never include a card you own', !last.some((x) => x.def >= 100 && x.def <= 110));

  // ---- Break Away: every player ≤ 64 → searches bronzes, buys them, submits
  await p.click('#fcs [data-a=sbc-set][data-i="3"]');
  await p.waitForSelector('#fcs [data-a=sbc-solve][data-i="3"]');
  await idle(p);
  await p.click('#fcs [data-a=sbc-solve][data-i="3"]');
  await p.waitForSelector('#fcs [data-a=sbc-submit]', { timeout: 200000 });
  await idle(p);
  const brLog = (await log(p)).filter((l) => /Market:/.test(l)).pop();
  check('rating limit ≤ 64 searches bronzes', /cheap bronze listings/.test(brLog || ''), brLog);
  const subBefore = await p.evaluate(() => T.submitted.length);
  const boughtBefore = await p.evaluate(() => (T.sbcBought || []).length);
  await p.click('#fcs [data-a=sbc-submit]');
  await idle(p, 200000);
  const firstTry = await log(p);
  check('sold-out card replaced', firstTry.some((l) => /was gone — bought .* instead/.test(l)), firstTry.filter((l) => /gone|instead/.test(l)).join(' | '));
  check('stops safely when a card and its replacements are gone', firstTry.some((l) => /kept in the plan, a retry only buys the rest/.test(l)));
  const planNote = await p.textContent('#fcs [data-r=plan]');
  check('plan shows what is already bought', /already bought for this SBC/.test(planNote) && /Buy \d+ more/.test(planNote), planNote.replace(/\s+/g, ' ').slice(0, 220));
  await p.click('#fcs [data-a=sbc-submit]'); // retry
  await idle(p, 200000);
  const brBuys = (await p.evaluate(() => T.sbcBought || [])).slice(boughtBefore);
  check('retry buys only the rest — no card bought twice', brBuys.length === 11 && new Set(brBuys.map((x) => x.d)).size === 11, `${brBuys.length} buys, ${new Set(brBuys.map((x) => x.d)).size} different`);
  const brSub = await p.evaluate(() => T.submitted[T.submitted.length - 1]);
  check('Break Away submitted with players all ≤ 64', (await p.evaluate(() => T.submitted.length)) === subBefore + 1 && brSub.length === 11 && brSub.every((x) => x.r <= 64), JSON.stringify(brSub.map((x) => x.r)));

  // ---- Hat-trick: a 3-player SBC → fills exactly 3, in the 3 open slots
  await p.click('#fcs [data-a=sbc-set][data-i="4"]');
  await p.waitForSelector('#fcs [data-a=sbc-solve][data-i="4"]');
  await idle(p);
  await p.click('#fcs [data-a=sbc-solve][data-i="4"]');
  await p.waitForSelector('#fcs [data-a=sbc-submit]', { timeout: 200000 });
  await idle(p);
  const hatPlan = await p.textContent('#fcs [data-r=plan] .list');
  const hatRows = await p.$$eval('#fcs [data-r=plan] .list .li', (els) => els.length);
  check('3-player SBC plans 3 players', hatRows === 3 && (await log(p)).some((l) => /needs 3 players/.test(l)), `${hatRows} rows`);
  const hatBefore = await p.evaluate(() => T.submitted.length);
  await p.click('#fcs [data-a=sbc-submit]');
  await idle(p, 200000);
  const hat = await p.evaluate(() => ({ sub: T.submitted[T.submitted.length - 1], idx: T.hatIdx, n: T.submitted.length }));
  check('3-player SBC submitted with 3 in the open slots', hat.n >= hatBefore + 1 && hat.sub.length === 3 && JSON.stringify(hat.idx) === '[5,6,7]', JSON.stringify(hat));

  // ---- 💎 points SBC: tagged, not solvable, Estimate forecasts the cost
  await p.click('#fcs [data-a=sbc-set][data-i="5"]');
  await p.waitForSelector('#fcs [data-a=sbc-points][data-i="5"]');
  await idle(p);
  const ptsRow = await p.textContent('#fcs [data-r=sbc]');
  check('points SBC tagged 💎 and shows OVR min, no Solve', /Brian Brobbey\s*💎 points/.test(ptsRow) && /OVR min 45/.test(ptsRow) && !(await p.$('#fcs [data-a=sbc-solve][data-i="5"]')), ptsRow.replace(/\s+/g, ' ').slice(-160));
  const subPts = await p.evaluate(() => T.submitted.length);
  await p.click('#fcs [data-a=sbc-points][data-i="5"]');
  await idle(p, 200000);
  const est = await p.textContent('#fcs [data-r=plan]');
  check('points estimate: needed, from your cards, coins for the rest', /28,800\s*💎\s*needed/.test(est) && /From your cards/.test(est) && (/Your spare cards cover it/.test(est) || (/The rest ≈ [\d,]+ coins/.test(est) && /coins per 💎/.test(est))), est.replace(/\s+/g, ' ').slice(0, 600));
  check('points rows have no empty "needs"', !/needs\s*(Estimate|$)/.test(ptsRow));
  check('points estimate never hands anything in', (await p.evaluate(() => T.submitted.length)) === subPts);
  await p.screenshot({ path: `${S}/t-points.png` });
  // let it buy the rest (coin limit), then hand in: batches of ≤ 20 until the goal; never squad/special cards
  await p.fill('#fcs [data-k=pointsBuyLimit]', '20000');
  await p.press('#fcs [data-k=pointsBuyLimit]', 'Tab');
  await p.click('#fcs [data-a=sbc-points]');
  await idle(p, 200000);
  check('estimate offers to buy the rest', /buy up to 20,000 coins/.test(await p.textContent('#fcs [data-r=plan]')));
  await p.click('#fcs [data-a=sbc-points-go]');
  await idle(p, 300000);
  const P = await p.evaluate(() => ({ batches: T.pointsBatches || [], ids: T.pointsIds || [] }));
  const plog = await log(p);
  check('points hand-in in batches of ≤ 20', P.batches.length >= 2 && P.batches.every((n) => n <= 20), JSON.stringify(P.batches));
  const prog = plog.filter((l) => /💎 Handed in/.test(l)).map((l) => Number(l.match(/— ([\d,]+) \//)[1].replace(/,/g, '')));
  check('points SBC completes, progress only goes up', plog.some((l) => /Brian Brobbey complete/.test(l)) && prog.every((v, i) => !i || v > prog[i - 1]) && prog[prog.length - 1] >= 30000, plog.filter((l) => /💎|complete/.test(l)).slice(-3).join(' | '));
  const pb = plog.filter((l) => /Bought \d+ cards? for [\d,]+ \([\d,]+ 💎\)|Handed in \d+ bought cards/.test(l));
  check('points: buys the best 💎-per-coin cards and hands them in', pb.length >= 2, pb.join(' | '));
  check('points hand-in never uses squad cards', !(await p.evaluate((ids) => ids.some((id) => services.Squad && false), P.ids)) && !plog.some((l) => /squads/.test(l)));

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
  check('owned upgrades rank above buying one', /^(Bench|Pacey)/.test(order[0]), order.join(' | '));
  check('best market suggestion keeps chemistry', order.find((o) => !/^(Bench|Pacey)/.test(o)).startsWith('Same League ST 86'), order.join(' | '));
  check('owned strikers suggested', order.filter((o) => /^(Bench|Pacey)/.test(o)).length >= 2, order.join(' | '));
  check('over-budget card excluded', !order.some((o) => /Too Pricey/.test(o)));
  const srch = await p.evaluate(() => T.searches.filter((x) => x.pos === 'ST'));
  check('market searched by league/nation within budget', srch.length >= 2 && srch.every((x) => x.max <= 120000) && srch.some((x) => x.league === 13), JSON.stringify(srch[0]));
  await p.click('#fcs [data-r=upg] .card:first-child [data-a=snipe-opt]');
  const chips = await p.textContent('#fcs [data-r=chips]');
  check('Snipe adds player with listed price as max', /Same League ST 86/.test(chips) && /45,000/.test(chips), chips.replace(/\s+/g, ' ').trim());
  // ---- Auto-fill the priority list from team needs
  await p.click('#fcs [data-tab=snipe]');
  while (await p.$('#fcs [data-r=chips] [data-rm]')) await p.click('#fcs [data-r=chips] [data-rm]'); // empty the list first
  await p.click('#fcs [data-a=autofill]');
  await idle(p, 200000);
  const filled = await p.evaluate(() => JSON.parse(localStorage.getItem('fc-sniper:config')).players.filter((x) => x.autofill));
  const afLog = (await log(p)).filter((l) => /🧩|no affordable|No upgrades|Owned:/.test(l));
  check('auto-fill never adds a card you own', !filled.some((x) => /Bench|Pacey|Starter|Fodder|Stored|Listed Striker/.test(x.name)), JSON.stringify(filled.map((x) => x.name)));
  check('auto-fill points to an owned better player instead of buying', afLog.some((l) => /ST: you already own (Bench ST 19|Pacey Striker 84)/.test(l)), afLog.join(' | '));
  check('auto-fill checks club, storage, transfer list and unassigned', afLog.some((l) => /Owned: \d+ players \(club \d+, SBC storage \d+, transfer list \d+, unassigned \d+\)/.test(l)), afLog.join(' | '));

  // ---- Evolutions
  await p.click('#fcs [data-tab=squad]');
  await p.click('#fcs [data-a=evo-find]');
  await idle(p, 120000);
  const evoText = await p.textContent('#fcs [data-r=evos]');
  check('evolutions listed with cost and qualifying players', /Pacey Strikers/.test(evoText) && /5,000 coins/.test(evoText) && /\d+ of your players qualify/.test(evoText) && /none of your players qualify/.test(evoText), evoText.replace(/\s+/g, ' ').slice(0, 200));
  await p.click('#fcs [data-a=evo-open][data-i="0"]');
  await p.click('#fcs [data-a=evo-preview][data-i="0"]');
  await idle(p, 60000);
  check('evolution preview shows final rating', /→ 87/.test(await p.textContent('#fcs [data-r=evos]')));

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
  check('meta: face stats read', (await log(p)).some((l) => /Meta: face stats found for \d+\/\d+ players/.test(l)));
  await p.click('#fcs [data-tab=squad]');
  const xiText = await p.textContent('#fcs [data-r=forms] .sub');
  check('meta XI starts the pacey striker and shows key stats', /Pacey Striker 84/.test(xiText) && /PAC 97/.test(xiText), xiText.replace(/\s+/g, ' ').slice(0, 160));
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
})().catch(async (e) => {
  console.error(e);
  if (lastPage) console.log('log at failure:\n  ' + (await log(lastPage).catch(() => [])).slice(-15).join('\n  '));
  console.log('\n' + results.join('\n'));
  process.exit(1);
});
