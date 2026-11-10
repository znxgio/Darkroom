// ==UserScript==
// @name         FC Sniper
// @namespace    https://github.com/znxgio/darkroom
// @version      0.1.0
// @description  Transfer-market sniper / autobuyer for the EA SPORTS FC Ultimate Team Web App.
// @match        https://www.ea.com/*ultimate-team/web-app*
// @match        https://www.ea.com/ea-sports-fc/ultimate-team/web-app*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * The script runs inside the official Web App page and drives the app's own
 * services object (`services.Item.*`) — the same calls the UI makes when you
 * press "Search" and "Buy Now". Every loop it:
 *   1. nudges the min-bid filter so EA returns fresh (uncached) results,
 *   2. searches the market with your filters,
 *   3. buys any listing whose Buy Now price is <= your max buy price,
 *   4. optionally lists the bought item on your transfer list for profit,
 *   5. waits a randomised delay, and repeats until a stop condition is hit.
 *
 * It stops on its own if EA returns a captcha / soft-ban style error, when you
 * run out of coins, or when your buy/search limits are reached.
 *
 * Using automation on the Web App breaks EA's User Agreement and can get the
 * account transfer-market banned. Use it at your own risk.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Pure logic (no Web App dependencies — unit-tested in test/core.test.js)
  // ---------------------------------------------------------------------------

  const EA_TAX = 0.05;
  const MIN_PRICE = 150;
  const MAX_PRICE = 15000000;

  /** Price step EA enforces for a given price band. */
  function priceStep(price) {
    if (price < 1000) return 50;
    if (price < 10000) return 100;
    if (price < 50000) return 250;
    if (price < 100000) return 500;
    return 1000;
  }

  /** Round a price to the nearest value EA accepts (rounding down by default). */
  function roundPrice(price, mode = 'down') {
    price = Math.max(MIN_PRICE, Math.min(MAX_PRICE, Math.floor(price)));
    const step = priceStep(price);
    const r = mode === 'up' ? Math.ceil(price / step) * step
      : mode === 'nearest' ? Math.round(price / step) * step
        : Math.floor(price / step) * step;
    return Math.max(MIN_PRICE, Math.min(MAX_PRICE, r));
  }

  /** Next valid price above `price`. */
  function nextPrice(price) {
    return roundPrice(roundPrice(price) + priceStep(roundPrice(price)), 'down');
  }

  /** Next valid price below `price`. */
  function prevPrice(price) {
    const p = roundPrice(price);
    if (p <= MIN_PRICE) return MIN_PRICE;
    // stepping down across a band boundary uses the lower band's step
    return roundPrice(p - priceStep(p - 1), 'down');
  }

  /** Coins you actually receive after EA's 5% tax. */
  function afterTax(price) {
    return Math.floor(price * (1 - EA_TAX));
  }

  /** Profit from buying at `buy` and selling at `sell`. */
  function profit(buy, sell) {
    return afterTax(sell) - buy;
  }

  /** Lowest sell price that still makes at least `minProfit` coins. */
  function breakEvenSell(buy, minProfit = 0) {
    let p = roundPrice((buy + minProfit) / (1 - EA_TAX), 'up');
    while (profit(buy, p) < minProfit && p < MAX_PRICE) p = nextPrice(p);
    return p;
  }

  /**
   * Cycles the min-bid filter through small values. EA caches identical
   * searches, so changing an irrelevant filter every request forces fresh data.
   */
  function cacheBustBid(iteration, maxBuy) {
    const ladder = [];
    for (let p = MIN_PRICE; p < 1000 && ladder.length < 18; p = nextPrice(p)) ladder.push(p);
    const usable = ladder.filter((p) => !maxBuy || p < maxBuy);
    if (!usable.length) return 0;
    return usable[iteration % usable.length];
  }

  /** Random integer delay in [min, max] ms. */
  function jitter(minMs, maxMs, rand = Math.random) {
    const lo = Math.min(minMs, maxMs);
    const hi = Math.max(minMs, maxMs);
    return Math.round(lo + rand() * (hi - lo));
  }

  /**
   * Picks which listings to buy from a search result.
   * `listings` items: { tradeId, buyNowPrice, expires, rating, defId }
   */
  function pickTargets(listings, cfg, coins) {
    return listings
      .filter((l) => l.buyNowPrice > 0 && l.buyNowPrice <= cfg.maxBuy)
      .filter((l) => !cfg.minRating || (l.rating || 0) >= cfg.minRating)
      .filter((l) => l.buyNowPrice <= coins)
      .sort((a, b) => a.buyNowPrice - b.buyNowPrice)
      .slice(0, Math.max(1, cfg.maxBuysPerSearch || 1));
  }

  /** Sell price to list at, based on config. Returns 0 when auto-list is off. */
  function planSellPrice(buyPrice, cfg) {
    if (!cfg.autoList) return 0;
    if (cfg.sellPrice > 0) return roundPrice(cfg.sellPrice, 'nearest');
    return breakEvenSell(buyPrice, cfg.minProfit || 0);
  }

  /** Classify a Web App error status into an action for the loop. */
  function classifyStatus(status) {
    status = Number(status);
    switch (status) {
      case 458: // captcha / verification required
      case 459:
        return 'captcha';
      case 429: // too many requests
      case 426:
      case 512:
      case 521: // temporary market lockout (soft ban)
        return 'throttled';
      case 401:
      case 403:
        return 'session';
      case 461: // you are already the highest bidder / item no longer available
      case 478:
      case 470: // not enough coins
        return status === 470 ? 'coins' : 'missed';
      default:
        return 'missed';
    }
  }

  const DEFAULT_CONFIG = {
    // search filters
    type: 'player',
    defId: '', // player definition id(s), comma separated (from futbin / futwiz URL)
    level: 'any', // any | bronze | silver | gold
    rarity: '', // rarity id, e.g. 1 = rare
    position: '',
    nation: '',
    league: '',
    club: '',
    // buying
    maxBuy: 1000,
    minRating: 0,
    maxBuysPerSearch: 1,
    // selling
    autoList: false,
    sellPrice: 0, // 0 = auto (break-even + minProfit)
    minProfit: 200,
    listDuration: 3600,
    // pacing / safety
    delayMin: 3500,
    delayMax: 6500,
    pauseEvery: 40, // searches
    pauseMin: 30000,
    pauseMax: 75000,
    maxSearches: 400,
    maxBuys: 10,
    minCoins: 0, // keep at least this many coins
    sound: true,
  };

  const core = {
    EA_TAX, MIN_PRICE, MAX_PRICE, DEFAULT_CONFIG,
    priceStep, roundPrice, nextPrice, prevPrice, afterTax, profit, breakEvenSell,
    cacheBustBid, jitter, pickTargets, planSellPrice, classifyStatus,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = core;
    return;
  }

  // ---------------------------------------------------------------------------
  // Web App adapter — wraps the app's internal services in promises
  // ---------------------------------------------------------------------------

  const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  function observe(observable) {
    return new Promise((resolve) => {
      observable.observe(w, (sender, response) => {
        if (typeof sender?.unobserve === 'function') sender.unobserve(w);
        resolve(response);
      });
    });
  }

  const LEVELS = { any: undefined, bronze: 'bronze', silver: 'silver', gold: 'gold' };

  const fut = {
    ready() {
      return !!(w.services && w.services.Item && w.UTSearchCriteriaDTO && w.services.User);
    },
    coins() {
      try { return w.services.User.getUser().coins.amount; } catch { return 0; }
    },
    buildCriteria(cfg, iteration) {
      const c = new w.UTSearchCriteriaDTO();
      c.type = cfg.type || 'player';
      const ids = String(cfg.defId || '').split(',').map((s) => parseInt(s, 10)).filter(Boolean);
      if (ids.length === 1) c.maskedDefId = ids[0];
      if (ids.length) c.defId = ids;
      if (LEVELS[cfg.level]) c.level = LEVELS[cfg.level];
      if (cfg.rarity) c.rarities = [parseInt(cfg.rarity, 10)];
      if (cfg.position) c._position = cfg.position;
      if (cfg.nation) c.nation = parseInt(cfg.nation, 10);
      if (cfg.league) c.league = parseInt(cfg.league, 10);
      if (cfg.club) c.club = parseInt(cfg.club, 10);
      c.maxBuy = roundPrice(cfg.maxBuy);
      c.minBid = cacheBustBid(iteration, cfg.maxBuy);
      return c;
    },
    async search(criteria) {
      if (typeof w.services.Item.clearTransferMarketCache === 'function') {
        w.services.Item.clearTransferMarketCache();
      }
      const res = await observe(w.services.Item.searchTransferMarket(criteria, 1));
      if (!res.success) return { ok: false, status: res.status, items: [] };
      return { ok: true, items: res.data.items || [] };
    },
    toListing(item) {
      const a = item._auction || (item.getAuctionData && item.getAuctionData()) || {};
      return {
        item,
        tradeId: a.tradeId,
        buyNowPrice: a.buyNowPrice,
        expires: a.expires,
        rating: item.rating,
        defId: item.definitionId,
        name: item._staticData ? item._staticData.name : (item.name || `#${item.definitionId}`),
      };
    },
    async buy(listing) {
      const res = await observe(w.services.Item.bid(listing.item, listing.buyNowPrice));
      return { ok: !!res.success, status: res.status };
    },
    async list(item, sellPrice, duration) {
      const start = prevPrice(sellPrice);
      const moved = await observe(w.services.Item.move(item, w.ItemPile.TRANSFER));
      if (!moved.success) return { ok: false, status: moved.status };
      const res = await observe(w.services.Item.list(item, start, sellPrice, duration));
      return { ok: !!res.success, status: res.status };
    },
  };

  // ---------------------------------------------------------------------------
  // Config persistence
  // ---------------------------------------------------------------------------

  const STORE_KEY = 'fc-sniper:config';
  function loadConfig() {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; } catch { return { ...DEFAULT_CONFIG }; }
  }
  function saveConfig(cfg) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Sniping engine
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const engine = {
    running: false,
    stats: { searches: 0, buys: 0, missed: 0, spent: 0, listed: 0, expectedProfit: 0 },
    cfg: loadConfig(),

    reset() {
      this.stats = { searches: 0, buys: 0, missed: 0, spent: 0, listed: 0, expectedProfit: 0 };
      ui.renderStats();
    },

    stop(reason) {
      if (!this.running) return;
      this.running = false;
      ui.log(`Stopped: ${reason}`, 'warn');
      ui.setRunning(false);
    },

    async start() {
      if (this.running) return;
      if (!fut.ready()) { ui.log('Web App not ready — log in and open the Transfers tab first.', 'err'); return; }
      this.cfg = ui.readForm();
      saveConfig(this.cfg);
      this.running = true;
      ui.setRunning(true);
      ui.log(`Started — max buy ${this.cfg.maxBuy.toLocaleString()} coins`);
      let i = 0;
      try {
        while (this.running) {
          const cfg = this.cfg;
          if (this.stats.searches >= cfg.maxSearches) { this.stop('search limit reached'); break; }
          if (this.stats.buys >= cfg.maxBuys) { this.stop('buy limit reached'); break; }
          const available = fut.coins() - cfg.minCoins;
          if (available < MIN_PRICE) { this.stop('not enough coins'); break; }

          const res = await fut.search(fut.buildCriteria(cfg, i++));
          this.stats.searches++;
          if (!res.ok) {
            const kind = classifyStatus(res.status);
            if (kind === 'captcha') { this.stop(`EA verification required (${res.status}) — solve it in the Web App`); alarm(); break; }
            if (kind === 'throttled' || kind === 'session') { this.stop(`market blocked / session issue (${res.status}) — take a break`); alarm(); break; }
            ui.log(`Search error ${res.status}`, 'warn');
          } else {
            const listings = res.items.map(fut.toListing);
            const targets = pickTargets(listings, cfg, available);
            for (const t of targets) {
              if (!this.running) break;
              await this.attempt(t, cfg);
            }
          }
          ui.renderStats();

          if (!this.running) break;
          if (cfg.pauseEvery > 0 && this.stats.searches % cfg.pauseEvery === 0) {
            const p = jitter(cfg.pauseMin, cfg.pauseMax);
            ui.log(`Resting ${(p / 1000).toFixed(0)}s`);
            await sleep(p);
          } else {
            await sleep(jitter(cfg.delayMin, cfg.delayMax));
          }
        }
      } catch (e) {
        this.stop(`error: ${e && e.message ? e.message : e}`);
      }
    },

    async attempt(t, cfg) {
      const r = await fut.buy(t);
      if (!r.ok) {
        const kind = classifyStatus(r.status);
        this.stats.missed++;
        if (kind === 'captcha' || kind === 'throttled') { this.stop(`blocked while buying (${r.status})`); alarm(); return; }
        if (kind === 'coins') { this.stop('not enough coins'); return; }
        ui.log(`Missed ${t.name} @ ${t.buyNowPrice.toLocaleString()} (${r.status})`, 'muted');
        return;
      }
      this.stats.buys++;
      this.stats.spent += t.buyNowPrice;
      ui.log(`BOUGHT ${t.name} (${t.rating || '?'}) @ ${t.buyNowPrice.toLocaleString()}`, 'ok');
      if (cfg.sound) beep();

      const sell = planSellPrice(t.buyNowPrice, cfg);
      if (sell) {
        await sleep(jitter(800, 1600));
        const l = await fut.list(t.item, sell, cfg.listDuration);
        if (l.ok) {
          this.stats.listed++;
          this.stats.expectedProfit += profit(t.buyNowPrice, sell);
          ui.log(`Listed @ ${sell.toLocaleString()} (profit ≈ ${profit(t.buyNowPrice, sell).toLocaleString()})`, 'ok');
        } else {
          ui.log(`Could not list (${l.status}) — item is in your unassigned pile`, 'warn');
        }
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Sounds
  // ---------------------------------------------------------------------------

  let audioCtx;
  function tone(freq, ms) {
    try {
      audioCtx = audioCtx || new (w.AudioContext || w.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = freq; g.gain.value = 0.08;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + ms / 1000);
    } catch { /* no audio */ }
  }
  function beep() { tone(880, 120); setTimeout(() => tone(1320, 160), 140); }
  function alarm() { [0, 300, 600].forEach((d) => setTimeout(() => tone(440, 220), d)); }

  // ---------------------------------------------------------------------------
  // UI panel
  // ---------------------------------------------------------------------------

  const FIELDS = [
    ['Search', [
      ['defId', 'Player ID(s)', 'text', 'Definition ID, comma separated'],
      ['level', 'Quality', 'select', ['any', 'bronze', 'silver', 'gold']],
      ['rarity', 'Rarity ID', 'text', '1 = rare, 3 = TOTW…'],
      ['position', 'Position', 'text', 'e.g. ST'],
      ['nation', 'Nation ID', 'text'],
      ['league', 'League ID', 'text'],
      ['club', 'Club ID', 'text'],
      ['minRating', 'Min rating', 'number'],
    ]],
    ['Buy', [
      ['maxBuy', 'Max buy now', 'number'],
      ['maxBuysPerSearch', 'Buys / search', 'number'],
      ['maxBuys', 'Stop after buys', 'number'],
      ['minCoins', 'Keep coins', 'number'],
    ]],
    ['Sell', [
      ['autoList', 'Auto-list', 'checkbox'],
      ['sellPrice', 'Sell price (0=auto)', 'number'],
      ['minProfit', 'Min profit', 'number'],
      ['listDuration', 'Duration (s)', 'select', ['3600', '10800', '21600', '43200', '86400', '259200']],
    ]],
    ['Pacing', [
      ['delayMin', 'Delay min (ms)', 'number'],
      ['delayMax', 'Delay max (ms)', 'number'],
      ['pauseEvery', 'Rest every N', 'number'],
      ['pauseMin', 'Rest min (ms)', 'number'],
      ['pauseMax', 'Rest max (ms)', 'number'],
      ['maxSearches', 'Stop after searches', 'number'],
      ['sound', 'Sound', 'checkbox'],
    ]],
  ];

  const CSS = `
  #fcs{position:fixed;top:12px;right:12px;z-index:99999;width:320px;max-height:calc(100vh - 24px);display:flex;flex-direction:column;
    background:#101418;color:#e8edf2;border:1px solid #2a323b;border-radius:10px;font:12px/1.35 system-ui,sans-serif;box-shadow:0 8px 30px #0008}
  #fcs header{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #2a323b;cursor:move}
  #fcs header b{flex:1;font-size:13px}#fcs .dot{width:8px;height:8px;border-radius:50%;background:#56606b}#fcs .dot.on{background:#3ddc84;box-shadow:0 0 6px #3ddc84}
  #fcs .body{overflow:auto;padding:8px 10px}#fcs.min .body,#fcs.min .foot{display:none}
  #fcs details{margin-bottom:6px}#fcs summary{cursor:pointer;font-weight:600;color:#9fb3c8;padding:3px 0}
  #fcs label{display:grid;grid-template-columns:1fr 130px;align-items:center;gap:6px;margin:3px 0}
  #fcs input,#fcs select{background:#1a2027;color:inherit;border:1px solid #2f3842;border-radius:5px;padding:4px 6px;font:inherit;width:100%}
  #fcs input[type=checkbox]{width:auto;justify-self:start}
  #fcs .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:6px 0}
  #fcs .stats div{background:#1a2027;border-radius:6px;padding:5px;text-align:center}#fcs .stats span{display:block;font-size:14px;font-weight:700}
  #fcs .log{height:140px;overflow:auto;background:#0a0d10;border-radius:6px;padding:6px;font-family:ui-monospace,monospace;font-size:11px}
  #fcs .ok{color:#3ddc84}#fcs .warn{color:#ffb84d}#fcs .err{color:#ff6b6b}#fcs .muted{color:#6c7783}
  #fcs .foot{display:flex;gap:6px;padding:8px 10px;border-top:1px solid #2a323b}
  #fcs button{flex:1;border:0;border-radius:6px;padding:7px;font:600 12px system-ui;cursor:pointer;background:#2a323b;color:#e8edf2}
  #fcs button.go{background:#3ddc84;color:#06210f}#fcs button.stop{background:#ff6b6b;color:#2a0606}
  #fcs header button{flex:0;padding:2px 8px;background:none}`;

  const ui = {
    root: null,
    mount() {
      if (document.getElementById('fcs')) return;
      const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
      const root = document.createElement('div'); root.id = 'fcs';
      const cfg = engine.cfg;
      const sections = FIELDS.map(([title, fields], idx) => `
        <details ${idx < 2 ? 'open' : ''}><summary>${title}</summary>
        ${fields.map(([key, label, type, extra]) => {
          const v = cfg[key];
          if (type === 'select') return `<label>${label}<select data-k="${key}">${extra.map((o) => `<option ${String(v) === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
          if (type === 'checkbox') return `<label>${label}<input type="checkbox" data-k="${key}" ${v ? 'checked' : ''}></label>`;
          return `<label>${label}<input type="${type}" data-k="${key}" value="${v ?? ''}" placeholder="${extra || ''}"></label>`;
        }).join('')}</details>`).join('');
      root.innerHTML = `
        <header><i class="dot"></i><b>FC Sniper</b><span class="coins"></span><button data-a="min">–</button></header>
        <div class="body">${sections}
          <div class="stats">
            <div>Searches<span data-s="searches">0</span></div><div>Bought<span data-s="buys">0</span></div><div>Missed<span data-s="missed">0</span></div>
            <div>Spent<span data-s="spent">0</span></div><div>Listed<span data-s="listed">0</span></div><div>Est. profit<span data-s="expectedProfit">0</span></div>
          </div>
          <div class="log"></div>
        </div>
        <div class="foot"><button class="go" data-a="start">Start</button><button data-a="reset">Reset</button></div>`;
      document.body.appendChild(root);
      this.root = root;

      root.addEventListener('click', (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (a === 'start') engine.running ? engine.stop('stopped by user') : engine.start();
        if (a === 'reset') engine.reset();
        if (a === 'min') root.classList.toggle('min');
      });
      root.addEventListener('change', () => { if (!engine.running) saveConfig(this.readForm()); });
      this.makeDraggable(root.querySelector('header'));
      setInterval(() => { const c = fut.coins(); root.querySelector('.coins').textContent = c ? `${c.toLocaleString()} 🪙` : ''; }, 2000);
      document.addEventListener('keydown', (e) => {
        if (e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); engine.running ? engine.stop('stopped by user') : engine.start(); }
      });
      this.log('Ready. Alt+S to start/stop.');
    },
    readForm() {
      const cfg = { ...engine.cfg };
      this.root.querySelectorAll('[data-k]').forEach((el) => {
        const k = el.dataset.k;
        if (el.type === 'checkbox') cfg[k] = el.checked;
        else if (typeof DEFAULT_CONFIG[k] === 'number') cfg[k] = Number(el.value) || 0;
        else cfg[k] = el.value.trim();
      });
      return cfg;
    },
    setRunning(on) {
      this.root.querySelector('.dot').classList.toggle('on', on);
      const b = this.root.querySelector('[data-a=start]');
      b.textContent = on ? 'Stop' : 'Start';
      b.className = on ? 'stop' : 'go';
      this.root.querySelectorAll('[data-k]').forEach((el) => { el.disabled = on; });
    },
    renderStats() {
      Object.entries(engine.stats).forEach(([k, v]) => {
        const el = this.root.querySelector(`[data-s="${k}"]`);
        if (el) el.textContent = v.toLocaleString();
      });
    },
    log(msg, cls = '') {
      const box = this.root && this.root.querySelector('.log');
      if (!box) return;
      const line = document.createElement('div');
      line.className = cls;
      line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
      box.prepend(line);
      while (box.childNodes.length > 200) box.lastChild.remove();
    },
    makeDraggable(handle) {
      let sx, sy, ox, oy;
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        const r = this.root.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        const move = (ev) => {
          this.root.style.left = `${ox + ev.clientX - sx}px`;
          this.root.style.top = `${oy + ev.clientY - sy}px`;
          this.root.style.right = 'auto';
        };
        const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
        addEventListener('pointermove', move); addEventListener('pointerup', up);
      });
    },
  };

  // Wait for the Web App to finish booting, then mount the panel.
  const boot = setInterval(() => {
    if (document.body && fut.ready()) { clearInterval(boot); ui.mount(); }
  }, 1000);
})();
