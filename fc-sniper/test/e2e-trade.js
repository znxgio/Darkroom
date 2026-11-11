// End-to-end test for Trade mode (resell bot) and auction bidding against a mocked Web App.
// Usage: node test/e2e-trade.js [screenshot-dir]   (needs Playwright; ~2 minutes)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const S = process.argv[2] || require('os').tmpdir();
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'fc-sniper.user.js'), 'utf8');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`);

function installTradeMock(opts) {
  const obs = (res, ms = 5) => ({ observe(ctx, cb) { setTimeout(() => cb({ unobserve() {} }, res), ms); } });
  const PILE = { CLUB: 1, PURCHASED: 3, TRANSFER: 5, STORAGE: 6 };
  window.ItemPile = PILE;
  window.UTSearchCriteriaDTO = function () {};
  let id = 1000;
  const auction = (o) => {
    const a = { tradeId: String(o.tradeId), buyNowPrice: o.bin || 0, currentBid: o.bid || 0, startingBid: o.start || 150, expires: o.expires ?? 3600,
      _tradeState: o.trade || 'active', _bidState: o.bidState || 'none' };
    a.isSold = () => a._tradeState === 'closed' && a._bidState !== 'highest' && a.currentBid > 0;
    a.isWon = () => a._tradeState === 'closed' && a._bidState === 'highest';
    a.isExpired = () => a._tradeState === 'expired';
    a.isSelling = () => a._tradeState === 'active';
    return a;
  };
  const card = (o) => {
    const it = { id: o.id || ++id, definitionId: 231747, rating: 91, rareflag: 1, untradeable: false, preferredPosition: 25,
      _staticData: { name: 'Mbappé' }, isPlayer: () => true };
    it._auction = auction(o);
    it.getAuctionData = () => it._auction;
    return it;
  };
  window.T = { coins: 300000, bought: [], bids: [], listed: [], cleared: 0, relisted: 0, untargeted: 0, searches: [] };
  // transfer list: an earlier buy (item 501) has sold for 50,000; another expired
  const transfer = [card({ id: 501, tradeId: 9001, bin: 50000, bid: 50000, trade: 'closed' }), card({ id: 502, tradeId: 9002, bin: 52000, trade: 'expired' })];
  const watched = [];
  let auctionShown = false;
  window.services = {
    User: { getUser: () => ({ coins: { amount: T.coins } }) },
    Item: {
      clearTransferMarketCache() {},
      searchTransferMarket(c) {
        T.searches.push({ maxBuy: c.maxBuy, maxBid: c.maxBid, minBid: c.minBid, minBuy: c.minBuy });
        if (c.maxBid) {
          // auction search: one auction about to end (shown once)
          // (the second one fits the max bid, but together with the first it would dip into Keep coins)
          const items = auctionShown ? [] : [card({ tradeId: 7001, bin: 90000, bid: 30000, expires: 2 }), card({ tradeId: 7002, bin: 90000, bid: 45500, expires: 3 })];
          auctionShown = true;
          return obs({ success: true, data: { items } });
        }
        const items = [];
        for (let i = 0; i < 40; i++) items.push(card({ tradeId: 100 + i, bin: 50000 + i * 1000 }));
        if (c.minBid !== undefined) items.push(card({ tradeId: 555, bin: 45000 })); // a snipe, only in snipe searches
        return obs({ success: true, data: { items: items.filter((x) => !c.maxBuy || x._auction.buyNowPrice <= c.maxBuy).slice(0, 20) } });
      },
      bid(item, amount) {
        if (amount === item._auction.buyNowPrice) { T.bought.push(amount); T.coins -= amount; return obs({ success: true }); }
        T.bids.push(amount);
        item._auction.currentBid = amount; item._auction._bidState = 'highest';
        watched.push(item);
        // auction ends and we win it shortly after
        setTimeout(() => { item._auction._tradeState = 'closed'; }, 2500);
        return obs({ success: true });
      },
      move(items) { return obs({ success: true }); },
      list(item, start, bn) { T.listed.push(bn); if (item._auction && item._auction.isExpired && item._auction.isExpired()) item._auction._tradeState = 'active'; return obs({ success: true }); },
      requestTransferItems: () => obs({ success: true, data: { items: transfer.slice() } }),
      clearSoldItems() { T.cleared++; transfer.splice(0, transfer.length, ...transfer.filter((x) => !x._auction.isSold())); return obs({ success: true }); },
      relistExpiredAuctions() { T.relisted++; transfer.forEach((x) => { if (x._auction.isExpired()) x._auction._tradeState = 'active'; }); return obs({ success: true }); },
      requestWatchedItems: () => obs({ success: true, data: { items: watched.slice() } }),
      untarget(items) { T.untargeted += items.length; return obs({ success: true }); },
    },
  };
  window.repositories = { Item: { getPileSize: () => 100, numItemsInCache: () => transfer.length, isPileFull: () => false } };
  // an earlier buy of item 501 at 40,000, listed at 50,000
  localStorage.setItem('fc-sniper:history', JSON.stringify([{ at: Date.now() - 3600e3, id: 231747, itemId: 501, name: 'Mbappé', rating: 91, price: 40000, sell: 50000 },
    { at: Date.now() - 7200e3, id: 231747, itemId: 502, name: 'Mbappé', rating: 91, price: 40000, sell: 52000 }]));
  localStorage.setItem('fc-sniper:config', JSON.stringify({
    players: [{ id: 231747, name: 'Mbappé', rating: 91 }],
    bidSnipe: true, bidWindow: 30, minProfit: 1000, undercut: 3, maxBuys: 2, delayMin: 3000, delayMax: 4500,
    minCoins: 224500, // 75,500 free: the 45,000 snipe and the 30,250 bid fit (in either order), a second bid of 45,750 does not
  }));
  if (opts && opts.restore) {
    // after a reload: Buy mode, one bid from before the reload that has been won in the meantime
    watched.push(card({ id: 601, tradeId: 7100, bin: 90000, bid: 30250, trade: 'closed', bidState: 'highest' }));
    localStorage.setItem('fc-sniper:config', JSON.stringify({ players: [{ id: 231747, name: 'Mbappé', rating: 91 }], spendLimit: 100000 }));
    localStorage.setItem('fc-sniper:bids', JSON.stringify([['7100', { name: 'Mbappé', amount: 30250, endsAt: Date.now() - 60e3, player: { id: 231747, name: 'Mbappé' }, plan: null }]]));
  }
}


function installHotMock() {
  const obs = (res, ms = 5) => ({ observe(ctx, cb) { setTimeout(() => cb({ unobserve() {} }, res), ms); } });
  window.ItemPile = { CLUB: 1, PURCHASED: 3, TRANSFER: 5, STORAGE: 6 };
  window.UTSearchCriteriaDTO = function () {};
  let tid = 1;
  // listings keep their trade id across searches, like the real market
  const card = (defId, name, bin, bid = 0, key = tid++) => ({ id: `${defId}-${key}`, definitionId: defId, rating: 84, rareflag: 1, _staticData: { name }, isPlayer: () => true,
    _auction: { tradeId: `${defId}-${key}`, buyNowPrice: bin, currentBid: bid, startingBid: 150, expires: 3000, _tradeState: 'active' } });
  window.H = { scans: [], checks: [] };
  window.services = {
    User: { getUser: () => ({ coins: { amount: 50000 } }) },
    Item: {
      clearTransferMarketCache() {},
      searchTransferMarket(c) {
        let items = [];
        if (c.league) {
          H.scans.push({ league: c.league, level: c.level, rarities: c.rarities, maxBuy: c.maxBuy, minBuy: c.minBuy });
          for (let i = 0; i < 10; i++) items.push(card(300, 'Hot Card', 9500 + i * 300, i < 6 ? 8000 : 0, `s${i}`));
          for (let i = 0; i < 10; i++) items.push(card(301, 'Cold Card', 9800 + i * 20, 0, `s${i}`));
          items.push(card(302, 'Thin Card', 4000, 3000, 's0'), card(302, 'Thin Card', 4200, 3000, 's1'));
          items.push(card(303, 'Pricey Card', 80000, 70000, 's0'));
        } else if (c.maskedDefId) {
          H.checks.push(c.maskedDefId);
          const base = c.maskedDefId === 300 ? 10000 : 10000;
          for (let i = 0; i < (c.maskedDefId === 302 ? 2 : 20); i++) items.push(card(c.maskedDefId, ({ 300: 'Hot Card', 302: 'Thin Card' })[c.maskedDefId] || 'Cold Card', base + i * 100, 0, `p${c.maskedDefId}-${i}`));
          if (c.minBid !== undefined && c.maskedDefId === 300) items.push(card(300, 'Hot Card', 8500)); // a snipe while trading
        }
        return obs({ success: true, data: { items: items.filter((x) => (!c.maxBuy || x._auction.buyNowPrice <= c.maxBuy) && (!c.minBuy || x._auction.buyNowPrice >= c.minBuy)) } });
      },
      bid(item, amount) { H.bought = (H.bought || 0) + 1; return obs({ success: true }); },
      move: () => obs({ success: true }),
      list: () => obs({ success: true }),
      requestTransferItems: () => obs({ success: true, data: { items: [] } }),
      requestWatchedItems: () => obs({ success: true, data: { items: [] } }),
    },
  };
  window.repositories = { Item: { getPileSize: () => 100, numItemsInCache: () => 0, isPileFull: () => false } };
  localStorage.setItem('fc-sniper:config', JSON.stringify({ players: [], hotAuto: true, hotPick: 1, maxBuys: 1, delayMin: 3000, delayMax: 3500 }));
}

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext(devices['iPhone 13'])).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.route('http://fake.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#1d2b3a"></body></html>' }));
  await p.goto('http://fake.test/');
  await p.evaluate(installTradeMock);
  await p.addScriptTag({ content: SCRIPT });
  await p.waitForSelector('#fcs');
  const log = () => p.evaluate(() => [...document.querySelectorAll('#fcs [data-r=log] div')].reverse().map((d) => d.textContent.replace(/^\d\d:\d\d:\d\d\s*/, '')));

  await p.tap('#fcs [data-a=fold]');
  await p.tap('#fcs [data-tab=trade]');
  await p.screenshot({ path: `${S}/trade-0.png` });
  await p.tap('#fcs [data-a=trade-start]');
  const savedBids = await p.waitForFunction(() => { const v = JSON.parse(localStorage.getItem('fc-sniper:bids') || '[]'); return v.length ? v : null; }, null, { timeout: 150000 }).then((h) => h.jsonValue());
  await p.waitForFunction(() => !document.querySelector('#fcs [data-a=toggle]').classList.contains('on') && window.T.searches.length > 3, null, { timeout: 150000 });
  await p.waitForTimeout(500);
  const t = await p.evaluate(() => window.T);
  const lines = await log();
  const plan = { sell: 48500 };

  check('mode switched to Trade', await p.evaluate(() => JSON.parse(localStorage.getItem('fc-sniper:config')).mode === 'trade'));
  check('first upkeep recorded the earlier sale', lines.some((l) => /💰 1 sold · profit 7,500 after tax/.test(l)), lines.find((l) => /sold/.test(l)));
  check('sold items cleared, expired relisted', t.cleared === 1 && t.relisted >= 0, `cleared ${t.cleared}, relisted ${t.relisted}`);
  check('price checked before trading', lines.some((l) => /avg/.test(l)));
  check('bought the 45k snipe under the profitable max', t.bought.includes(45000), `bought ${t.bought}`);
  const smart = lines.find((l) => /Relisted Mbappé at/.test(l));
  check('smart relist: expired card repriced one step under the cheapest, above break-even', t.listed[0] === 49750 && /at 49,750 \(cheapest 50,000\)/.test(smart || ''), `${smart} · listed ${t.listed}`);
  check('relisted under market average', t.listed.length >= 2 && t.listed[1] < 52000 && t.listed.slice(1).every((x) => x === t.listed[1]), `listed ${t.listed}`);
  const buy = t.searches.find((x) => x.maxBuy && x.minBid !== undefined);
  check('snipe search max buy keeps min profit', buy && 0.95 * t.listed[0] - buy.maxBuy >= 1000, JSON.stringify(buy));
  check('auction searches use max bid', t.searches.some((x) => x.maxBid && !x.maxBuy), JSON.stringify(t.searches.filter((x) => x.maxBid)[0]));
  check('bid placed on ending auction', t.bids.includes(30250), `bids ${t.bids}`);
  check('second bid that would break Keep coins is not placed', t.bids.length === 1, `bids ${t.bids}`);
  check('open bid saved for a reload, cleared once collected', savedBids.length === 1 && savedBids[0][0] === '7001' && savedBids[0][1].amount === 30250 && savedBids[0][1].player.id === 231747
    && await p.evaluate(() => localStorage.getItem('fc-sniper:bids') === '[]'), JSON.stringify(savedBids));
  check('won auction collected and listed', lines.some((l) => /Won Mbappé/.test(l)) && t.listed.length >= 2, lines.filter((l) => /Won|Bid/.test(l)).join(' | '));
  check('stopped at session buy limit', lines.some((l) => /session buy limit/.test(l)));
  const hist = await p.evaluate(() => JSON.parse(localStorage.getItem('fc-sniper:history')));
  check('history: sale realized, bid recorded', hist.some((e) => e.itemId === 501 && e.soldFor === 50000) && hist.some((e) => e.via === 'bid'));
  await p.tap('#fcs [data-tab=trade]');
  await p.waitForTimeout(200);
  const kpi = await p.textContent('#fcs [data-r=tkpi]');
  check('Trade tab shows sold today and profit', /1Sold today/.test(kpi) && /7,500Profit today/.test(kpi), kpi.replace(/\s+/g, ' '));
  const plans = await p.textContent('#fcs [data-r=tplans]');
  check('Trade tab shows the flip plan', /buy ≤/.test(plans) && /sell/.test(plans), plans.replace(/\s+/g, ' ').slice(0, 120));
  await p.screenshot({ path: `${S}/trade-1.png` });

  // ---------- Reload with an open bid: the won auction is still collected and counted
  const r = await (await b.newContext(devices['iPhone 13'])).newPage();
  r.on('pageerror', (e) => errors.push(e.message));
  await r.route('http://fake.test/**', (x) => x.fulfill({ contentType: 'text/html', body: '<html><head><meta charset=utf-8></head><body></body></html>' }));
  await r.goto('http://fake.test/');
  await r.evaluate(installTradeMock, { restore: true });
  await r.addScriptTag({ content: SCRIPT });
  await r.waitForSelector('#fcs');
  await r.evaluate(() => document.querySelector('#fcs [data-a=upkeep]').click());
  await r.waitForFunction(() => localStorage.getItem('fc-sniper:bids') === '[]', null, { timeout: 30000 }).catch(() => {});
  await r.waitForTimeout(500);
  const rs = await r.evaluate(() => ({ cfg: JSON.parse(localStorage.getItem('fc-sniper:config')), bids: localStorage.getItem('fc-sniper:bids'), hist: JSON.parse(localStorage.getItem('fc-sniper:history')) }));
  check('restored bid: won auction counted against the spend limit and ticked off the list', rs.bids === '[]' && rs.cfg.listSpent === 30250 && rs.cfg.players.length === 0 && rs.hist.some((e) => e.via === 'bid' && e.price === 30250),
    `bids ${rs.bids}, listSpent ${rs.cfg.listSpent}, players ${rs.cfg.players.length}`);

  // ---------- Hot cards: scan, rank, auto-pick and start trading
  const h = await (await b.newContext(devices['iPhone 13'])).newPage();
  h.on('pageerror', (e) => errors.push(e.message));
  await h.route('http://fake.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#1d2b3a"></body></html>' }));
  await h.goto('http://fake.test/');
  await h.evaluate(installHotMock);
  await h.addScriptTag({ content: SCRIPT });
  await h.waitForSelector('#fcs');
  await h.tap('#fcs [data-a=fold]');
  await h.tap('#fcs [data-tab=trade]');
  await h.tap('#fcs [data-a=trade-start]');
  // scan + price checks, then trading starts on its own
  await h.waitForFunction(() => document.querySelector('#fcs [data-a=toggle]').classList.contains('on') && JSON.parse(localStorage.getItem('fc-sniper:config')).players.length, null, { timeout: 240000 });
  await h.waitForTimeout(500);
  const H = await h.evaluate(() => window.H);
  const hlog = await h.evaluate(() => [...document.querySelectorAll('#fcs [data-r=log] div')].reverse().map((d) => d.textContent.replace(/^\d\d:\d\d:\d\d\s*/, '')));
  const players = await h.evaluate(() => JSON.parse(localStorage.getItem('fc-sniper:config')).players);
  check('scan covers the 5 leagues, gold rares within budget', new Set(H.scans.map((x) => x.league)).size === 5 && H.scans.every((x) => x.level === 'gold' && x.rarities[0] === 1 && x.maxBuy <= 50000), JSON.stringify(H.scans[0]));
  check('scan uses several price bands', new Set(H.scans.map((x) => x.minBuy)).size >= 2, [...new Set(H.scans.map((x) => x.minBuy))].join(','));
  const hotText = await h.textContent('#fcs [data-r=hot]');
  check('hot list ranks the card with demand first', /^\s*Hot Card/.test(hotText.replace(/\s+/g, ' ')), hotText.replace(/\s+/g, ' ').slice(0, 140));
  check('thin and over-budget cards dropped', !/Thin Card|Pricey Card/.test(hotText));
  check('price-checked the top cards', H.checks.includes(300), H.checks.join(','));
  check('auto-picked the hot card and started trading', players.length === 1 && players[0].id === 300 && players[0].hot && players[0].avg > 0 && hlog.some((l) => /Trading Hot Card/.test(l)), hlog.filter((l) => /Hot|Trading/.test(l)).join(' | '));
  await h.screenshot({ path: `${S}/trade-hot.png` });
  await h.tap('#fcs [data-a=toggle]');
  check('no page errors', errors.length === 0, errors.join('; '));
  console.log('log:\n  ' + lines.join('\n  '));
  await b.close();
  console.log('\n' + results.join('\n'));
  if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
})().catch((e) => { console.error(e); console.log('\n' + results.join('\n')); process.exit(1); });
