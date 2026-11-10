// ==UserScript==
// @name         FC Sniper
// @namespace    https://github.com/znxgio/darkroom
// @version      0.4.0
// @description  Transfer-market sniper / autobuyer for the EA SPORTS FC Ultimate Team Web App.
// @match        https://www.ea.com/*ultimate-team/web-app*
// @match        https://www.ea.com/ea-sports-fc/ultimate-team/web-app*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/znxgio/Darkroom/claude/ea-fc-sniping-bot-jdz6vq/fc-sniper/fc-sniper.user.js
// @updateURL    https://raw.githubusercontent.com/znxgio/Darkroom/claude/ea-fc-sniping-bot-jdz6vq/fc-sniper/fc-sniper.user.js
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

  // ---- Player name lookup ---------------------------------------------------

  /** Lowercase, strip accents and punctuation: "Mbappé" -> "mbappe". */
  function normalizeName(str) {
    return String(str || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/ß/g, 'ss').replace(/ı/g, 'i')
      .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Parses EA's players database (the players.json the Web App downloads).
   * Entries look like { id, f: first, l: last, c: common name, r: rating }.
   */
  function parsePlayerDb(json) {
    const lists = [];
    if (Array.isArray(json)) lists.push(json);
    else if (json && typeof json === 'object') {
      Object.values(json).forEach((v) => { if (Array.isArray(v)) lists.push(v); });
    }
    const byId = new Map();
    for (const list of lists) {
      for (const e of list) {
        const id = Number(e && (e.id ?? e.assetId ?? e.definitionId));
        if (!id || byId.has(id)) continue;
        const first = e.f ?? e.firstName ?? '';
        const last = e.l ?? e.lastName ?? '';
        const common = e.c ?? e.commonName ?? '';
        const full = `${first} ${last}`.trim();
        const name = String(common || full || `#${id}`).trim();
        byId.set(id, {
          id, name, full, rating: Number(e.r ?? e.rating) || 0,
          key: normalizeName(`${name} ${full}`),
          nameKey: normalizeName(name),
        });
      }
    }
    return [...byId.values()];
  }

  /**
   * Finds players matching `query`. Every query word must start a word of the
   * player's common or full name. Best matches first, then by rating.
   */
  function searchPlayers(db, query, limit = 8) {
    const q = normalizeName(query);
    if (!q) return [];
    const tokens = q.split(' ');
    const scored = [];
    for (const p of db) {
      const words = p.key.split(' ');
      if (!tokens.every((t) => words.some((wd) => wd.startsWith(t)))) continue;
      let score = 0;
      if (p.nameKey === q) score = 3;
      else if (p.nameKey.startsWith(q)) score = 2;
      else if (p.key.includes(q)) score = 1;
      scored.push([score, p]);
    }
    scored.sort((a, b) => b[0] - a[0] || b[1].rating - a[1].rating || a[1].name.localeCompare(b[1].name));
    return scored.slice(0, limit).map(([, p]) => p);
  }

  /** Players are searched in rotation, one per search request. */
  function playerForIteration(players, iteration) {
    if (!players || !players.length) return null;
    return players[iteration % players.length];
  }

  /** Upgrade old configs that stored comma-separated IDs in `defId`. */
  function migrateConfig(cfg) {
    const out = { ...cfg };
    if (!Array.isArray(out.players)) out.players = [];
    if (out.defId && !out.players.length) {
      out.players = String(out.defId).split(',').map((s) => parseInt(s, 10)).filter(Boolean)
        .map((id) => ({ id, name: `#${id}`, rating: 0 }));
    }
    delete out.defId;
    return out;
  }

  // ---- Safety limits ---------------------------------------------------------
  // These keep the bot's request rate and session length closer to a normal
  // player's, and back off hard when EA pushes back. They lower ban risk;
  // they do not make the bot invisible to EA.

  const SAFETY = {
    minDelay: 3000, // never search faster than every 3 s
    minSpread: 1500, // delay range must be at least this wide
    maxPauseEvery: 60, // must rest at least every 60 searches
    minPause: 20000, // rests last at least 20 s
    maxSearchesPerDay: 1500,
    maxSessionMinutes: 120,
    maxConsecutiveErrors: 3,
    lockMs: { captcha: 3 * 3600e3, throttled: 24 * 3600e3, errors: 30 * 60e3 },
  };

  /** Enforce the safety floors on a config. Returns { cfg, changed: [keys] }. */
  function clampConfig(input) {
    const cfg = { ...input };
    const changed = [];
    const set = (k, v) => { if (cfg[k] !== v) { cfg[k] = v; changed.push(k); } };
    const num = (k) => Number(cfg[k]) || 0;
    set('delayMin', Math.max(SAFETY.minDelay, num('delayMin')));
    set('delayMax', Math.max(cfg.delayMin + SAFETY.minSpread, num('delayMax')));
    set('pauseEvery', Math.min(SAFETY.maxPauseEvery, Math.max(1, num('pauseEvery') || SAFETY.maxPauseEvery)));
    set('pauseMin', Math.max(SAFETY.minPause, num('pauseMin')));
    set('pauseMax', Math.max(cfg.pauseMin, num('pauseMax')));
    set('searchesPerDay', Math.min(SAFETY.maxSearchesPerDay, Math.max(1, num('searchesPerDay') || SAFETY.maxSearchesPerDay)));
    set('buysPerDay', Math.max(1, num('buysPerDay') || 1));
    set('sessionMinutes', Math.min(SAFETY.maxSessionMinutes, Math.max(1, num('sessionMinutes') || SAFETY.maxSessionMinutes)));
    set('maxSearches', Math.max(1, num('maxSearches') || 1));
    return { cfg, changed };
  }

  /** Local calendar day, e.g. "2026-11-10". */
  function dayKey(now) {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Today's usage counters (resets at local midnight). */
  function usageFor(usage, now) {
    const day = dayKey(now);
    return usage && usage.day === day ? { ...usage } : { day, searches: 0, buys: 0 };
  }

  /** How long to refuse to start after a problem of this kind. */
  function lockoutFor(kind) {
    return SAFETY.lockMs[kind] || 0;
  }

  function formatDuration(ms) {
    const m = Math.ceil(ms / 60e3);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  }

  /** Whether a run may start now. state = { usage, lockUntil, lockReason }. */
  function canStart(state, cfg, now) {
    if (state && state.lockUntil > now) {
      return { ok: false, reason: `cooling down after ${state.lockReason || 'a warning'} — ${formatDuration(state.lockUntil - now)} left` };
    }
    const u = usageFor(state && state.usage, now);
    if (u.searches >= cfg.searchesPerDay) return { ok: false, reason: `daily search limit reached (${u.searches}/${cfg.searchesPerDay}) — resets at midnight` };
    if (u.buys >= cfg.buysPerDay) return { ok: false, reason: `daily buy limit reached (${u.buys}/${cfg.buysPerDay}) — resets at midnight` };
    return { ok: true };
  }

  const DEFAULT_CONFIG = {
    // search filters
    type: 'player',
    players: [], // [{ id, name, rating }] — searched in rotation
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
    // pacing / safety (see SAFETY for the enforced floors)
    delayMin: 4000,
    delayMax: 8000,
    pauseEvery: 30, // searches
    pauseMin: 45000,
    pauseMax: 120000,
    maxSearches: 250, // per session
    maxBuys: 10, // per session
    sessionMinutes: 40,
    searchesPerDay: 600,
    buysPerDay: 40,
    minCoins: 0, // keep at least this many coins
    sound: true,
  };

  const core = {
    EA_TAX, MIN_PRICE, MAX_PRICE, DEFAULT_CONFIG,
    priceStep, roundPrice, nextPrice, prevPrice, afterTax, profit, breakEvenSell,
    cacheBustBid, jitter, pickTargets, planSellPrice, classifyStatus,
    normalizeName, parsePlayerDb, searchPlayers, playerForIteration, migrateConfig,
    SAFETY, clampConfig, dayKey, usageFor, lockoutFor, formatDuration, canStart,
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
      // maskedDefId matches every version of the player (base, TOTW, specials…),
      // same as picking a name in the Web App's own search. Use Min rating /
      // Rarity to narrow it to one card.
      const player = playerForIteration(cfg.players, iteration);
      if (player) c.maskedDefId = player.id;
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
  // Player database — the same players.json the Web App uses for its name search
  // ---------------------------------------------------------------------------

  const playerDb = {
    list: null,
    loading: null,
    findUrl() {
      const urls = (w.performance?.getEntriesByType?.('resource') || []).map((e) => e.name);
      const direct = urls.find((u) => /\/players(_meta)?\.json(\?|$)/.test(u));
      if (direct) return direct;
      for (const u of urls) {
        const m = u.match(/^(.*\/web-app\/content\/[^/]+\/\d{4}\/)/);
        if (m) return `${m[1]}fut/items/web/players.json`;
      }
      return null;
    },
    load() {
      if (this.list) return Promise.resolve(this.list);
      if (this.loading) return this.loading;
      this.loading = (async () => {
        const url = this.findUrl();
        if (!url) throw new Error('player list not found yet. Open Transfers → Search in the Web App once, then try again');
        const res = await fetch(url, { credentials: 'omit' });
        if (!res.ok) throw new Error(`player list download failed (${res.status})`);
        const list = parsePlayerDb(await res.json());
        if (!list.length) throw new Error('player list was empty');
        this.list = list;
        return list;
      })().finally(() => { this.loading = null; });
      return this.loading;
    },
  };

  // ---------------------------------------------------------------------------
  // Config persistence
  // ---------------------------------------------------------------------------

  const STORE_KEY = 'fc-sniper:config';
  function loadConfig() {
    try { return migrateConfig({ ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }); } catch { return { ...DEFAULT_CONFIG, players: [] }; }
  }
  function saveConfig(cfg) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
  }

  const SAFETY_KEY = 'fc-sniper:safety';
  function loadSafety() {
    try { return JSON.parse(localStorage.getItem(SAFETY_KEY) || '{}'); } catch { return {}; }
  }
  function saveSafety(state) {
    try { localStorage.setItem(SAFETY_KEY, JSON.stringify(state)); } catch { /* ignore */ }
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

    safety: loadSafety(),

    countUsage(field) {
      const u = usageFor(this.safety.usage, Date.now());
      u[field]++;
      this.safety.usage = u;
      saveSafety(this.safety);
      return u;
    },

    lock(kind, reason) {
      const ms = lockoutFor(kind);
      if (!ms) return;
      this.safety.lockUntil = Date.now() + ms;
      this.safety.lockReason = reason;
      saveSafety(this.safety);
      ui.log(`Safety lock: won't start again for ${formatDuration(ms)}`, 'err');
    },

    /** Stop because EA pushed back, and refuse to restart for a while. */
    halt(kind, reason) {
      this.stop(reason);
      this.lock(kind, reason.split(' (')[0]);
      alarm();
    },

    stop(reason) {
      if (!this.running) return;
      this.running = false;
      keepAwake(false);
      ui.log(`Stopped: ${reason}`, 'warn');
      ui.setRunning(false);
    },

    async start() {
      if (this.running) return;
      if (!fut.ready()) { ui.log('Web App not ready — log in and open the Transfers tab first.', 'err'); return; }
      const { cfg: safeCfg, changed } = clampConfig(ui.readForm());
      if (changed.length) {
        ui.writeForm(safeCfg);
        ui.log(`Raised to safe minimums: ${changed.join(', ')}`, 'warn');
      }
      this.cfg = safeCfg;
      saveConfig(this.cfg);
      this.safety = loadSafety();
      const gate = canStart(this.safety, this.cfg, Date.now());
      if (!gate.ok) { ui.log(`Can't start: ${gate.reason}`, 'err'); return; }
      const today = usageFor(this.safety.usage, Date.now());
      this.running = true;
      ui.setRunning(true);
      keepAwake(true);
      const who = this.cfg.players.length ? this.cfg.players.map((p) => p.name).join(', ') : 'any player matching filters';
      ui.log(`Started — ${who}, max buy ${this.cfg.maxBuy.toLocaleString()} coins`);
      ui.log(`Today: ${today.searches}/${this.cfg.searchesPerDay} searches, ${today.buys}/${this.cfg.buysPerDay} buys. Session ends after ${this.cfg.sessionMinutes} min.`, 'muted');
      const sessionStart = Date.now();
      const sessionSearches = this.stats.searches;
      const sessionBuys = this.stats.buys;
      let errors = 0;
      let i = 0;
      try {
        while (this.running) {
          const cfg = this.cfg;
          if (this.stats.searches - sessionSearches >= cfg.maxSearches) { this.stop('session search limit reached'); break; }
          if (this.stats.buys - sessionBuys >= cfg.maxBuys) { this.stop('session buy limit reached'); break; }
          if (Date.now() - sessionStart >= cfg.sessionMinutes * 60e3) { this.stop(`${cfg.sessionMinutes} min session limit — take a break`); break; }
          const gate = canStart(this.safety, cfg, Date.now());
          if (!gate.ok) { this.stop(gate.reason); break; }
          const available = fut.coins() - cfg.minCoins;
          if (available < MIN_PRICE) { this.stop('not enough coins'); break; }

          const res = await fut.search(fut.buildCriteria(cfg, i++));
          this.stats.searches++;
          this.countUsage('searches');
          if (!res.ok) {
            const kind = classifyStatus(res.status);
            if (kind === 'captcha') { this.halt('captcha', `EA verification (${res.status}) — solve it in the Web App, then leave it alone`); break; }
            if (kind === 'throttled') { this.halt('throttled', `transfer market limited (${res.status}) — stop for today`); break; }
            if (kind === 'session') { this.stop(`logged out (${res.status}) — log in again`); alarm(); break; }
            errors++;
            ui.log(`Search error ${res.status} (${errors}/${SAFETY.maxConsecutiveErrors})`, 'warn');
            if (errors >= SAFETY.maxConsecutiveErrors) { this.halt('errors', `${errors} errors in a row (${res.status})`); break; }
          } else {
            errors = 0;
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
        if (kind === 'captcha' || kind === 'throttled') { this.halt(kind, `blocked while buying (${r.status})`); return; }
        if (kind === 'coins') { this.stop('not enough coins'); return; }
        ui.log(`Missed ${t.name} @ ${t.buyNowPrice.toLocaleString()} (${r.status})`, 'muted');
        return;
      }
      this.stats.buys++;
      this.countUsage('buys');
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

  // Phone = touch screen whose short side is phone-sized, or a narrow window.
  // (Uses screen size, not CSS width, because pages without a viewport tag
  // lay out at ~980px on phones.)
  const isMobile = () => w.innerWidth <= 600
    || (w.matchMedia('(pointer:coarse)').matches && Math.min(w.screen.width, w.screen.height) <= 600);
  const vibrate = (pattern) => { try { w.navigator.vibrate && w.navigator.vibrate(pattern); } catch { /* unsupported */ } };

  // Keep the phone screen on while running — mobile browsers pause timers
  // (and so the bot) as soon as the screen locks or the tab goes to background.
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && w.navigator.wakeLock) {
        wakeLock = await w.navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release(); wakeLock = null;
      }
    } catch { /* not supported or denied */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (!engine.running) return;
    if (document.visibilityState === 'visible') { keepAwake(true); ui.log('Back in foreground'); }
    else ui.log('Tab in background — the browser may pause the bot', 'warn');
  });

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
  function beep() { tone(880, 120); setTimeout(() => tone(1320, 160), 140); vibrate([80, 40, 80]); }
  function alarm() { [0, 300, 600].forEach((d) => setTimeout(() => tone(440, 220), d)); vibrate([400, 150, 400, 150, 400]); }

  // ---------------------------------------------------------------------------
  // UI panel
  // ---------------------------------------------------------------------------

  const FIELDS = [
    ['Search', [
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
      ['maxBuys', 'Buys / session', 'number'],
      ['minCoins', 'Keep coins', 'number'],
    ]],
    ['Sell', [
      ['autoList', 'Auto-list', 'checkbox'],
      ['sellPrice', 'Sell price (0=auto)', 'number'],
      ['minProfit', 'Min profit', 'number'],
      ['listDuration', 'Duration (s)', 'select', ['3600', '10800', '21600', '43200', '86400', '259200']],
    ]],
    ['Safety', [
      ['delayMin', 'Delay min (ms, ≥3000)', 'number'],
      ['delayMax', 'Delay max (ms)', 'number'],
      ['pauseEvery', 'Rest every N (≤60)', 'number'],
      ['pauseMin', 'Rest min (ms)', 'number'],
      ['pauseMax', 'Rest max (ms)', 'number'],
      ['sessionMinutes', 'Session length (min)', 'number'],
      ['maxSearches', 'Searches / session', 'number'],
      ['searchesPerDay', 'Searches / day', 'number'],
      ['buysPerDay', 'Buys / day', 'number'],
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
  #fcs header button{flex:0;padding:2px 8px;background:none}
  #fcs header{touch-action:none}
  #fcs .pp{position:relative;margin:4px 0 8px}
  #fcs .chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px}
  #fcs .chip{display:inline-flex;align-items:center;gap:4px;background:#1f3a2b;color:#bff5d4;border-radius:999px;padding:3px 4px 3px 9px}
  #fcs .chip b{font-weight:700;color:#3ddc84}#fcs .chip button{flex:0;padding:0 6px;background:none;color:inherit;font-size:14px;line-height:1}
  #fcs .sugg{position:absolute;left:0;right:0;top:100%;z-index:2;background:#1a2027;border:1px solid #2f3842;border-radius:6px;margin-top:2px;max-height:240px;overflow:auto}
  #fcs .sugg:empty{display:none}
  #fcs .sugg button{display:flex;width:100%;justify-content:space-between;background:none;border-radius:0;padding:7px 8px;font-weight:400;text-align:left}
  #fcs .sugg button:hover,#fcs .sugg button:focus{background:#2a323b}#fcs .sugg small{color:#6c7783}
  #fcs .sugg .note{padding:7px 8px;color:#9fb3c8}
  #fcs header button.qt{background:#3ddc84;color:#06210f;padding:3px 10px}#fcs header button.qt.on{background:#ff6b6b;color:#2a0606}

    #fcs.mob{top:auto!important;left:0!important;right:0!important;bottom:0;width:auto;max-height:70vh;border-radius:14px 14px 0 0;
      font-size:14px;padding-bottom:env(safe-area-inset-bottom)}
    #fcs.mob header{cursor:default;padding:10px 12px}#fcs.mob header b{font-size:15px}
    #fcs.mob header button{padding:8px 14px;font-size:16px}#fcs.mob header button.qt{padding:8px 16px}
    #fcs.mob .body{padding:8px 12px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
    #fcs.mob summary{padding:10px 0;font-size:15px}
    #fcs.mob label{grid-template-columns:1fr 46%;margin:7px 0}
    #fcs.mob input,#fcs.mob select{font-size:16px;padding:9px 8px}
    #fcs.mob input[type=checkbox]{width:22px;height:22px}
    #fcs.mob .stats span{font-size:16px}
    #fcs.mob .log{height:120px;font-size:12px}
    #fcs.mob .chip{padding:5px 4px 5px 11px;font-size:14px}#fcs.mob .chip button{padding:2px 8px;font-size:18px}
    #fcs.mob .sugg button{padding:12px 10px;font-size:15px}
    #fcs.mob .foot{padding:10px 12px}#fcs.mob button{padding:13px;font-size:15px}`;

  const ui = {
    root: null,
    mount() {
      if (document.getElementById('fcs')) return;
      const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
      const root = document.createElement('div'); root.id = 'fcs';
      const cfg = engine.cfg;
      const sections = FIELDS.map(([title, fields], idx) => `
        <details ${idx < 2 ? 'open' : ''}><summary>${title}</summary>
        ${idx === 0 ? `<div class="pp"><div class="chips"></div>
          <input class="pq" type="search" autocomplete="off" placeholder="Add player — type a name or ID"><div class="sugg"></div></div>` : ''}
        ${fields.map(([key, label, type, extra]) => {
          const v = cfg[key];
          if (type === 'select') return `<label>${label}<select data-k="${key}">${extra.map((o) => `<option ${String(v) === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
          if (type === 'checkbox') return `<label>${label}<input type="checkbox" data-k="${key}" ${v ? 'checked' : ''}></label>`;
          return `<label>${label}<input type="${type}" data-k="${key}" value="${v ?? ''}" placeholder="${extra || ''}"></label>`;
        }).join('')}</details>`).join('');
      root.innerHTML = `
        <header><i class="dot"></i><b>FC Sniper</b><span class="coins"></span><button class="qt" data-a="start">▶</button><button data-a="min">–</button></header>
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
      this.mountPlayerPicker();
      setInterval(() => { const c = fut.coins(); root.querySelector('.coins').textContent = c ? `${c.toLocaleString()} 🪙` : ''; }, 2000);
      document.addEventListener('keydown', (e) => {
        if (e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); engine.running ? engine.stop('stopped by user') : engine.start(); }
      });
      if (isMobile()) root.classList.add('mob', 'min');
      this.log(isMobile() ? 'Ready. Tap ▶ to start, – to expand.' : 'Ready. Alt+S to start/stop.');
      const gate = canStart(engine.safety, clampConfig(engine.cfg).cfg, Date.now());
      if (!gate.ok) this.log(`Locked: ${gate.reason}`, 'err');
    },
    mountPlayerPicker() {
      const input = this.root.querySelector('.pq');
      const sugg = this.root.querySelector('.sugg');
      const chips = this.root.querySelector('.chips');
      const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
      let results = [];
      let timer;

      const renderChips = () => {
        chips.innerHTML = engine.cfg.players.map((p, i) =>
          `<span class="chip">${esc(p.name)}${p.rating ? ` <b>${p.rating}</b>` : ''}<button data-rm="${i}" aria-label="Remove">×</button></span>`).join('');
      };
      const add = (p) => {
        if (!engine.cfg.players.some((x) => x.id === p.id)) {
          engine.cfg.players = [...engine.cfg.players, { id: p.id, name: p.name, rating: p.rating }];
          saveConfig(this.readForm());
          this.log(`Added ${p.name}${p.rating ? ` (${p.rating})` : ''} — id ${p.id}`);
        }
        input.value = ''; sugg.innerHTML = ''; renderChips();
      };
      const show = async () => {
        const q = input.value.trim();
        if (!q) { sugg.innerHTML = ''; return; }
        if (/^\d{3,}$/.test(q)) {
          const known = playerDb.list && playerDb.list.find((p) => p.id === Number(q));
          results = [known || { id: Number(q), name: `#${q}`, rating: 0 }];
        } else {
          if (!playerDb.list) sugg.innerHTML = '<div class="note">Loading player list…</div>';
          try { results = searchPlayers(await playerDb.load(), q); } catch (e) {
            sugg.innerHTML = `<div class="note">${esc(e.message)}. You can still type a player ID.</div>`; return;
          }
          if (input.value.trim() !== q) return; // user kept typing
        }
        sugg.innerHTML = results.length
          ? results.map((p, i) => `<button data-pick="${i}"><span>${esc(p.name)}${p.full && p.full !== p.name ? ` <small>${esc(p.full)}</small>` : ''}</span><b>${p.rating || ''}</b></button>`).join('')
          : '<div class="note">No players found</div>';
      };

      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(show, 180); });
      input.addEventListener('focus', () => { playerDb.load().catch(() => {}); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && results[0] && sugg.innerHTML) { e.preventDefault(); add(results[0]); }
        if (e.key === 'Escape') sugg.innerHTML = '';
      });
      this.root.addEventListener('click', (e) => {
        const pick = e.target.closest('[data-pick]');
        if (pick) add(results[Number(pick.dataset.pick)]);
        const rm = e.target.closest('[data-rm]');
        if (rm && !engine.running) {
          engine.cfg.players = engine.cfg.players.filter((_, i) => i !== Number(rm.dataset.rm));
          saveConfig(this.readForm()); renderChips();
        }
        if (!e.target.closest('.pp')) sugg.innerHTML = '';
      });
      renderChips();
    },
    readForm() {
      const cfg = { ...engine.cfg, players: [...(engine.cfg.players || [])] };
      this.root.querySelectorAll('[data-k]').forEach((el) => {
        const k = el.dataset.k;
        if (el.type === 'checkbox') cfg[k] = el.checked;
        else if (typeof DEFAULT_CONFIG[k] === 'number') cfg[k] = Number(el.value) || 0;
        else cfg[k] = el.value.trim();
      });
      return cfg;
    },
    writeForm(cfg) {
      this.root.querySelectorAll('[data-k]').forEach((el) => {
        const v = cfg[el.dataset.k];
        if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
      });
    },
    setRunning(on) {
      this.root.querySelector('.dot').classList.toggle('on', on);
      const [quick, main] = this.root.querySelectorAll('[data-a=start]');
      quick.textContent = on ? '■' : '▶';
      quick.classList.toggle('on', on);
      main.textContent = on ? 'Stop' : 'Start';
      main.className = on ? 'stop' : 'go';
      this.root.querySelectorAll('[data-k], .pq').forEach((el) => { el.disabled = on; });
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
        if (e.target.closest('button') || isMobile()) return;
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
