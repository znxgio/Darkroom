// ==UserScript==
// @name         FC Sniper
// @namespace    https://github.com/znxgio/darkroom
// @version      1.0.0
// @description  Transfer-market sniper for the EA SPORTS FC Ultimate Team Web App — price checks, auto max buy, alerts, auto-listing, history and built-in safety limits.
// @match        https://www.ea.com/*ultimate-team/web-app*
// @match        https://www.ea.com/ea-sports-fc/ultimate-team/web-app*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/znxgio/Darkroom/claude/ea-fc-sniping-bot-jdz6vq/fc-sniper/fc-sniper.user.js
// @updateURL    https://raw.githubusercontent.com/znxgio/Darkroom/claude/ea-fc-sniping-bot-jdz6vq/fc-sniper/fc-sniper.user.js
// ==/UserScript==

/*
 * FC Sniper
 * =========
 * Runs inside the official Web App and drives the app's own services
 * (`services.Item.*`), the same calls its UI makes for Search and Buy Now.
 *
 *   1. Price check: finds each player's market price from the cheapest listings
 *      and sets a max buy a chosen % under it (capped at your coins).
 *   2. Snipe loop: searches each player in turn with a cache-busting min bid,
 *      buys (or just alerts on) listings at or under the max, optionally
 *      relists them for profit, then waits a random delay.
 *   3. Safety: enforced minimum delays and rests, session and daily limits, and
 *      lockouts after a captcha or market limit.
 *
 * Layout: pure, unit-tested logic first (test/core.test.js), then the runtime
 * (Web App adapter, engine, UI). Using automation on the Web App breaks EA's
 * User Agreement and can get the account banned. Use it at your own risk.
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

  /**
   * Price to relist a bought card at. Returns 0 when selling is off.
   *   profit — the lowest price that still clears Min profit after tax
   *   market — the player's price-checked average (never below the profit floor)
   *   fixed  — your Sell price
   */
  function planSellPrice(buyPrice, cfg, player) {
    const floor = breakEvenSell(buyPrice, cfg.minProfit || 0);
    switch (cfg.sellMode) {
      case 'profit': return floor;
      case 'market': return player && player.avg ? Math.max(roundPrice(player.avg, 'nearest'), floor) : floor;
      case 'fixed': return cfg.sellPrice > 0 ? roundPrice(cfg.sellPrice, 'nearest') : floor;
      default: return 0;
    }
  }

  /** Max buy actually used for a player: your manual value, else the price check, else the default. */
  function effectiveMaxBuy(player, cfg) {
    return (player && (player.manualMax || player.maxBuy)) || cfg.maxBuy;
  }

  // ---- Buy history & notifications --------------------------------------------

  /** Newest first, capped at `max` entries. */
  function addHistory(list, entry, max = 300) {
    return [entry, ...(list || [])].slice(0, max);
  }

  /** Totals for today and all time. Entries: { at, price, sell }. */
  function summarizeHistory(list, now) {
    const today = dayKey(now);
    const sum = (arr) => arr.reduce((t, e) => ({
      buys: t.buys + 1,
      spent: t.spent + e.price,
      profit: t.profit + (e.sell ? profit(e.price, e.sell) : 0),
    }), { buys: 0, spent: 0, profit: 0 });
    return { today: sum((list || []).filter((e) => dayKey(e.at) === today)), all: sum(list || []) };
  }

  function isDiscordWebhook(url) {
    return /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(String(url || '').trim());
  }

  /** Discord webhook body for an event: buy | alert | stop | test. */
  function discordPayload(kind, d = {}) {
    const fmt = (n) => Number(n || 0).toLocaleString('en-US');
    const embed = {
      buy: { title: `✅ Bought ${d.name}`, color: 0x3ddc84,
        description: `**${fmt(d.price)}** coins${d.rating ? ` · ${d.rating} rated` : ''}${d.sell ? `\nListed at ${fmt(d.sell)} (≈ ${fmt(profit(d.price, d.sell))} profit)` : ''}` },
      alert: { title: `👀 ${d.name} listed under your max`, color: 0xffd166,
        description: `Buy Now **${fmt(d.price)}** (your max ${fmt(d.maxBuy)})` },
      stop: { title: '⏹ Sniper stopped', color: 0xff6b6b, description: d.reason || '' },
      test: { title: '🔔 FC Sniper connected', color: 0x5aa9ff, description: 'Notifications are working.' },
    }[kind] || { title: kind, description: '' };
    return { username: 'FC Sniper', embeds: [{ ...embed, timestamp: new Date(d.at || Date.now()).toISOString() }] };
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
    if (!out.sellMode) out.sellMode = out.autoList ? (out.sellPrice > 0 ? 'fixed' : 'profit') : 'off';
    delete out.autoList;
    delete out.type;
    return out;
  }

  // ---- Market price check ----------------------------------------------------

  /**
   * Finds the current market price of one card by searching the transfer
   * market and lowering the max-buy filter until nothing cheaper is listed.
   *
   * search(maxBuy) -> Promise<{ ok, status, listings: [{ tradeId, buyNowPrice, defId }] }>
   * Only listings whose defId === opts.defId count (the exact card, not its
   * special versions). Returns { ok, lowest, avg, count, steps } where avg is
   * the average of the `sample` cheapest Buy Now prices, rounded to a valid price.
   */
  async function findMarketPrice(search, opts) {
    const { defId, maxSteps = 6, sample = 5 } = opts;
    const seen = new Map();
    let maxBuy = 0;
    let steps = 0;
    while (steps < maxSteps) {
      const res = await search(maxBuy);
      steps++;
      if (!res.ok) return { ok: false, status: res.status, steps };
      const mine = res.listings.filter((l) => l.buyNowPrice > 0 && (!defId || l.defId === defId));
      mine.forEach((l) => seen.set(l.tradeId, l.buyNowPrice));
      if (!mine.length) break;
      const min = Math.min(...mine.map((l) => l.buyNowPrice));
      if (min <= MIN_PRICE) break;
      const next = prevPrice(min);
      if (maxBuy && next >= maxBuy) break;
      maxBuy = next;
    }
    let prices = [...seen.values()].sort((a, b) => a - b);
    if (!prices.length) return { ok: true, count: 0, lowest: 0, avg: 0, steps };
    // Stepping down skips listings just above the lowest one. If we haven't
    // seen enough near the bottom, take one more look at that price range.
    const band = roundPrice(prices[0] * 1.15, 'up');
    if (prices.filter((p) => p <= band).length < sample && steps < maxSteps + 1) {
      const res = await search(band);
      steps++;
      if (!res.ok) return { ok: false, status: res.status, steps };
      res.listings.filter((l) => l.buyNowPrice > 0 && (!defId || l.defId === defId))
        .forEach((l) => seen.set(l.tradeId, l.buyNowPrice));
      prices = [...seen.values()].sort((a, b) => a - b);
    }
    const cheapest = prices.slice(0, sample);
    const mean = cheapest.reduce((a, b) => a + b, 0) / cheapest.length;
    return { ok: true, count: prices.length, lowest: prices[0], avg: roundPrice(mean, 'nearest'), steps };
  }

  /**
   * Max buy for a player: `discountPct` under the market average, but never
   * more than the coins you can spend. Returns { maxBuy, cappedByCoins }.
   */
  function planMaxBuy(avg, discountPct, spendable) {
    if (!avg || spendable < MIN_PRICE) return { maxBuy: 0, cappedByCoins: false };
    const target = roundPrice(avg * (1 - Math.max(0, Math.min(90, discountPct || 0)) / 100), 'down');
    const cap = roundPrice(spendable, 'down');
    return target > cap ? { maxBuy: cap, cappedByCoins: true } : { maxBuy: target, cappedByCoins: false };
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
    // targets
    players: [], // [{ id, name, rating, avg, lowest, maxBuy, manualMax, checkedAt }]
    mode: 'buy', // buy | alert (notify only, never buys)
    // filters (used with or without players)
    level: 'any', // any | bronze | silver | gold
    rarity: '',
    position: '',
    nation: '',
    league: '',
    club: '',
    minRating: 0,
    // buying
    autoPrice: true, // price-check players and set their max buy automatically
    discount: 10, // % under the market average to snipe at
    maxBuy: 1000, // used when a player has no price
    maxBuysPerSearch: 1,
    minCoins: 0, // never spend below this balance
    // selling
    sellMode: 'off', // off | profit | market | fixed
    sellPrice: 0,
    minProfit: 200,
    listDuration: 3600,
    autoRelist: false, // relist expired + clear sold items when starting
    // safety (see SAFETY for the enforced floors)
    delayMin: 4000,
    delayMax: 8000,
    pauseEvery: 30,
    pauseMin: 45000,
    pauseMax: 120000,
    sessionMinutes: 40,
    maxSearches: 250, // per session
    maxBuys: 10, // per session
    searchesPerDay: 600,
    buysPerDay: 40,
    // notifications
    sound: true,
    discordWebhook: '',
  };

  const core = {
    EA_TAX, MIN_PRICE, MAX_PRICE, DEFAULT_CONFIG,
    priceStep, roundPrice, nextPrice, prevPrice, afterTax, profit, breakEvenSell,
    cacheBustBid, jitter, pickTargets, planSellPrice, classifyStatus,
    normalizeName, parsePlayerDb, searchPlayers, playerForIteration, migrateConfig,
    findMarketPrice, planMaxBuy, effectiveMaxBuy,
    addHistory, summarizeHistory, isDiscordWebhook, discordPayload,
    SAFETY, clampConfig, dayKey, usageFor, lockoutFor, formatDuration, canStart,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = core;
    return;
  }

  // ===========================================================================
  // Runtime — everything below talks to the Web App and the page
  // ===========================================================================

  const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errText = (e) => (e && e.message ? e.message : String(e));
  const fmt = (n) => Number(n || 0).toLocaleString();

  // ---- Storage ----------------------------------------------------------------

  const KEYS = { cfg: 'fc-sniper:config', safety: 'fc-sniper:safety', history: 'fc-sniper:history', ui: 'fc-sniper:ui' };
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
    },
  };
  const loadConfig = () => clampConfig(migrateConfig({ ...DEFAULT_CONFIG, ...store.get(KEYS.cfg, {}) })).cfg;

  // ---- Web App adapter --------------------------------------------------------
  // Wraps the app's own services (the calls its UI makes) in promises.

  /** Resolve an EA observable; gives up after `ms` so a stuck call can't hang the bot. */
  function observe(observable, ms = 20000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ success: false, status: 'timeout' }), ms);
      observable.observe(w, (sender, response) => {
        clearTimeout(timer);
        if (typeof sender?.unobserve === 'function') sender.unobserve(w);
        resolve(response || { success: false });
      });
    });
  }

  const fut = {
    ready: () => !!(w.services && w.services.Item && w.services.User && w.UTSearchCriteriaDTO),
    coins() {
      try { return w.services.User.getUser().coins.amount; } catch { return 0; }
    },
    criteria(cfg, player, maxBuy, iteration) {
      const c = new w.UTSearchCriteriaDTO();
      c.type = 'player';
      // maskedDefId matches every version of the player, like the Web App's own name search.
      if (player) c.maskedDefId = player.id;
      if (cfg.level && cfg.level !== 'any') c.level = cfg.level;
      if (cfg.rarity) c.rarities = [parseInt(cfg.rarity, 10)];
      if (cfg.position) c._position = cfg.position;
      if (cfg.nation) c.nation = parseInt(cfg.nation, 10);
      if (cfg.league) c.league = parseInt(cfg.league, 10);
      if (cfg.club) c.club = parseInt(cfg.club, 10);
      if (maxBuy) c.maxBuy = roundPrice(maxBuy);
      if (iteration !== undefined) c.minBid = cacheBustBid(iteration, maxBuy);
      return c;
    },
    async search(criteria) {
      if (typeof w.services.Item.clearTransferMarketCache === 'function') w.services.Item.clearTransferMarketCache();
      const res = await observe(w.services.Item.searchTransferMarket(criteria, 1));
      if (!res.success) return { ok: false, status: res.status, listings: [] };
      return { ok: true, listings: ((res.data && res.data.items) || []).map(fut.listing) };
    },
    listing(item) {
      const a = item._auction || (item.getAuctionData && item.getAuctionData()) || {};
      return {
        item,
        tradeId: a.tradeId,
        buyNowPrice: a.buyNowPrice,
        expires: a.expires,
        rating: item.rating,
        defId: item.definitionId,
        name: (item._staticData && item._staticData.name) || item.name || `#${item.definitionId}`,
      };
    },
    async buy(listing) {
      const res = await observe(w.services.Item.bid(listing.item, listing.buyNowPrice));
      return { ok: !!res.success, status: res.status };
    },
    async list(item, sellPrice, duration) {
      const moved = await observe(w.services.Item.move(item, w.ItemPile.TRANSFER));
      if (!moved.success) return { ok: false, status: moved.status };
      const res = await observe(w.services.Item.list(item, prevPrice(sellPrice), sellPrice, duration));
      return { ok: !!res.success, status: res.status };
    },
    /** Relist expired items and clear sold ones, if this Web App version supports it. */
    async tidyTransferList() {
      const S = w.services.Item;
      const out = { relisted: null, cleared: null };
      if (typeof S.relistExpiredAuctions === 'function') out.relisted = !!(await observe(S.relistExpiredAuctions())).success;
      if (typeof S.clearSoldItems === 'function') out.cleared = !!(await observe(S.clearSoldItems())).success;
      return out;
    },
  };

  // ---- Player database (the players.json the Web App uses for its name search) ---

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
        if (!url) throw new Error('Player list not found yet — open Transfers → Search in the Web App once');
        const res = await fetch(url, { credentials: 'omit' });
        if (!res.ok) throw new Error(`Player list download failed (${res.status})`);
        const list = parsePlayerDb(await res.json());
        if (!list.length) throw new Error('Player list was empty');
        this.list = list;
        return list;
      })().finally(() => { this.loading = null; });
      return this.loading;
    },
  };

  // ---- Device helpers: phone layout, wake lock, sound, vibration -------------------

  const isMobile = () => w.innerWidth <= 600
    || (w.matchMedia('(pointer:coarse)').matches && Math.min(w.screen.width, w.screen.height) <= 600);
  const vibrate = (pattern) => { try { w.navigator.vibrate && w.navigator.vibrate(pattern); } catch { /* unsupported */ } };

  // Phones pause pages when the screen locks, so keep it awake while running.
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

  let audioCtx;
  function tone(freq, ms) {
    if (!engine.cfg.sound) return;
    try {
      audioCtx = audioCtx || new (w.AudioContext || w.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = freq; g.gain.value = 0.08;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + ms / 1000);
    } catch { /* no audio */ }
  }
  const sounds = {
    buy() { tone(880, 120); setTimeout(() => tone(1320, 160), 140); vibrate([80, 40, 80]); },
    alert() { tone(660, 140); setTimeout(() => tone(990, 140), 160); vibrate([120, 60, 120]); },
    alarm() { [0, 300, 600].forEach((d) => setTimeout(() => tone(440, 220), d)); vibrate([400, 150, 400, 150, 400]); },
  };

  // ---- Notifications ------------------------------------------------------------

  const notify = {
    /** Best effort: some pages block outside requests, so failures are only logged. */
    async discord(kind, data) {
      const url = String(engine.cfg.discordWebhook || '').trim();
      if (!url) return false;
      if (!isDiscordWebhook(url)) { ui.log('Discord: that is not a webhook URL', 'warn'); return false; }
      const body = new FormData();
      body.append('payload_json', JSON.stringify(discordPayload(kind, data)));
      try {
        await fetch(url, { method: 'POST', mode: 'no-cors', body });
        return true;
      } catch (e) {
        ui.log(`Discord notification blocked (${errText(e)})`, 'warn');
        return false;
      }
    },
  };

  // ---- Engine -------------------------------------------------------------------

  const newStats = () => ({ searches: 0, buys: 0, missed: 0, spent: 0, listed: 0, profit: 0 });

  const engine = {
    cfg: loadConfig(),
    safety: store.get(KEYS.safety, {}),
    history: store.get(KEYS.history, []),
    stats: newStats(),
    running: false,
    busy: false, // price check outside a run
    status: { state: 'idle', text: 'Idle', until: 0 },
    session: { startedAt: 0, endsAt: 0 },

    save() { store.set(KEYS.cfg, this.cfg); },
    saveSafety() { store.set(KEYS.safety, this.safety); },

    setStatus(state, text, until = 0) {
      this.status = { state, text, until };
      ui.renderStatus();
    },

    countUsage(field) {
      const u = usageFor(this.safety.usage, Date.now());
      u[field]++;
      this.safety.usage = u;
      this.saveSafety();
    },

    /** Refuse to start for a while after EA pushback. */
    lock(kind, reason) {
      const ms = lockoutFor(kind);
      if (!ms) return;
      this.safety.lockUntil = Date.now() + ms;
      this.safety.lockReason = reason;
      this.saveSafety();
      ui.log(`Safety lock: won't start again for ${formatDuration(ms)}`, 'err');
      ui.renderStatus();
    },

    halt(kind, reason) {
      this.stop(reason);
      this.lock(kind, reason.split(' (')[0]);
      sounds.alarm();
    },

    stop(reason) {
      if (!this.running) return;
      this.running = false;
      keepAwake(false);
      this.setStatus('idle', 'Idle');
      ui.log(`Stopped — ${reason}`, 'warn');
      ui.setRunning(false);
      if (/limit|verification|blocked|errors|logged out|coins/i.test(reason)) notify.discord('stop', { reason });
    },

    /** Sleep that wakes early when stopped, and shows a countdown. */
    async wait(ms, state, text) {
      const until = Date.now() + ms;
      this.setStatus(state, text, until);
      while (this.running && Date.now() < until) await sleep(Math.min(250, until - Date.now()));
    },

    gate() {
      return canStart(this.safety, this.cfg, Date.now());
    },

    // -- price check --

    priceSearch(player) {
      let first = true;
      return async (maxBuy) => {
        if (!first) await sleep(jitter(this.cfg.delayMin, this.cfg.delayMax));
        first = false;
        const res = await fut.search(fut.criteria({}, player, maxBuy));
        this.countUsage('searches');
        return res;
      };
    },

    /** Price-check players and set their max buy. Returns false if EA pushed back. */
    async priceCheck(players) {
      for (const player of players) {
        const gate = this.gate();
        if (!gate.ok) { ui.log(`Price check skipped — ${gate.reason}`, 'err'); return false; }
        this.setStatus('pricing', `Checking ${player.name}…`);
        const r = await findMarketPrice(this.priceSearch(player), { defId: player.id });
        if (!r.ok) {
          const kind = classifyStatus(r.status);
          if (kind === 'captcha' || kind === 'throttled') { this.lock(kind, `EA pushback during price check (${r.status})`); sounds.alarm(); return false; }
          ui.log(`Price check failed for ${player.name} (${r.status})`, 'warn');
          continue;
        }
        player.checkedAt = Date.now();
        if (!r.count) {
          Object.assign(player, { avg: 0, lowest: 0, maxBuy: 0 });
          ui.log(`${player.name}: none listed right now — using default max ${fmt(this.cfg.maxBuy)}`, 'warn');
          continue;
        }
        const plan = planMaxBuy(r.avg, this.cfg.discount, fut.coins() - this.cfg.minCoins);
        Object.assign(player, { avg: r.avg, lowest: r.lowest, maxBuy: plan.maxBuy });
        ui.log(`${player.name}: avg ${fmt(r.avg)} · lowest ${fmt(r.lowest)} · ${r.count} listed → max ${fmt(plan.maxBuy)}`
          + (plan.cappedByCoins ? ' (all your coins)' : ` (${this.cfg.discount}% under)`)
          + (player.manualMax ? ` — your manual ${fmt(player.manualMax)} is used instead` : ''), 'ok');
      }
      return true;
    },

    async checkPricesNow() {
      if (this.running || this.busy) return;
      if (!fut.ready()) { ui.log('Web App not ready — log in first', 'err'); return; }
      if (!this.cfg.players.length) { ui.log('Add a player first', 'warn'); return; }
      this.busy = true; ui.setBusy(true);
      this.safety = store.get(KEYS.safety, {});
      try {
        await this.priceCheck(this.cfg.players);
      } catch (e) {
        ui.log(`Price check error: ${errText(e)}`, 'err');
      } finally {
        this.save();
        this.busy = false; ui.setBusy(false);
        this.setStatus('idle', 'Idle');
        ui.renderPlayers();
      }
    },

    // -- main loop --

    toggle() { if (this.running) this.stop('stopped by you'); else this.start(); },

    async start() {
      if (this.running || this.busy) return;
      ui.commit(); // pick up a field that was typed but not yet saved
      if (!fut.ready()) { ui.log('Web App not ready — log in and open Transfers first', 'err'); return; }
      const { cfg, changed } = clampConfig(this.cfg);
      if (changed.length) ui.log(`Raised to safe minimums: ${changed.join(', ')}`, 'warn');
      this.cfg = cfg; this.save(); ui.syncForm();
      this.safety = store.get(KEYS.safety, {});
      const gate = this.gate();
      if (!gate.ok) { ui.log(`Can't start — ${gate.reason}`, 'err'); ui.renderStatus(); return; }

      this.running = true;
      ui.setRunning(true);
      keepAwake(true);
      this.session = { startedAt: Date.now(), endsAt: Date.now() + cfg.sessionMinutes * 60e3 };

      try {
        if (cfg.autoRelist) await this.tidy();
        if (this.running && cfg.autoPrice && cfg.players.length) {
          const stale = cfg.players.filter((p) => !p.manualMax && (!p.checkedAt || Date.now() - p.checkedAt > 15 * 60e3));
          if (stale.length) {
            const ok = await this.priceCheck(stale);
            this.save(); ui.renderPlayers();
            if (!this.running) return;
            if (!ok) { this.stop('price check stopped by EA — see log'); return; }
            await this.wait(jitter(cfg.delayMin, cfg.delayMax), 'waiting', 'Starting');
          }
        }
        if (!this.running) return;
        const who = cfg.players.length
          ? cfg.players.map((p) => `${p.name} ≤ ${fmt(effectiveMaxBuy(p, cfg))}`).join(', ')
          : `filters ≤ ${fmt(cfg.maxBuy)}`;
        ui.log(`${cfg.mode === 'alert' ? 'Watching' : 'Sniping'} ${who}`, 'ok');
        await this.loop();
      } catch (e) {
        this.stop(`error: ${errText(e)}`);
      }
    },

    async loop() {
      const cfg = this.cfg;
      const startSearches = this.stats.searches;
      const startBuys = this.stats.buys;
      const alerted = new Set();
      let errors = 0;
      let i = 0;

      while (this.running) {
        if (this.stats.searches - startSearches >= cfg.maxSearches) return this.stop('session search limit reached');
        if (this.stats.buys - startBuys >= cfg.maxBuys) return this.stop('session buy limit reached');
        if (Date.now() >= this.session.endsAt) return this.stop(`${cfg.sessionMinutes} min session limit — take a break`);
        const gate = this.gate();
        if (!gate.ok) return this.stop(gate.reason);
        const spendable = fut.coins() - cfg.minCoins;
        if (cfg.mode === 'buy' && spendable < MIN_PRICE) return this.stop('not enough coins');

        const player = playerForIteration(cfg.players, i);
        const maxBuy = effectiveMaxBuy(player, cfg);
        this.setStatus('searching', player ? `Searching ${player.name} ≤ ${fmt(maxBuy)}` : `Searching ≤ ${fmt(maxBuy)}`);
        const res = await fut.search(fut.criteria(cfg, player, maxBuy, i++));
        this.stats.searches++;
        this.countUsage('searches');

        if (!res.ok) {
          const kind = classifyStatus(res.status);
          if (kind === 'captcha') return this.halt('captcha', `EA verification (${res.status}) — solve it in the Web App, then leave it for today`);
          if (kind === 'throttled') return this.halt('throttled', `transfer market limited (${res.status}) — stop for today`);
          if (kind === 'session') { sounds.alarm(); return this.stop(`logged out (${res.status}) — log in again`); }
          errors++;
          ui.log(`Search error ${res.status} (${errors}/${SAFETY.maxConsecutiveErrors})`, 'warn');
          if (errors >= SAFETY.maxConsecutiveErrors) return this.halt('errors', `${errors} errors in a row (${res.status})`);
        } else {
          errors = 0;
          const targets = pickTargets(res.listings, { ...cfg, maxBuy }, cfg.mode === 'alert' ? Infinity : spendable);
          for (const t of targets) {
            if (!this.running) break;
            if (cfg.mode === 'alert') {
              if (alerted.has(t.tradeId)) continue;
              alerted.add(t.tradeId);
              ui.log(`👀 ${t.name} (${t.rating || '?'}) listed at ${fmt(t.buyNowPrice)}`, 'alert');
              ui.toast(`${t.name} at ${fmt(t.buyNowPrice)}`, 'alert');
              sounds.alert();
              notify.discord('alert', { name: t.name, price: t.buyNowPrice, maxBuy });
            } else {
              await this.attempt(t, player);
            }
          }
        }
        ui.renderStats();
        if (!this.running) return;

        if (this.stats.searches % cfg.pauseEvery === 0) {
          const ms = jitter(cfg.pauseMin, cfg.pauseMax);
          ui.log(`Resting ${Math.round(ms / 1000)}s`, 'muted');
          await this.wait(ms, 'resting', 'Resting');
        } else {
          await this.wait(jitter(cfg.delayMin, cfg.delayMax), 'waiting', 'Next search');
        }
      }
    },

    async attempt(t, player) {
      const cfg = this.cfg;
      const r = await fut.buy(t);
      if (!r.ok) {
        this.stats.missed++;
        const kind = classifyStatus(r.status);
        if (kind === 'captcha' || kind === 'throttled') return this.halt(kind, `blocked while buying (${r.status})`);
        if (kind === 'coins') return this.stop('not enough coins');
        ui.log(`Missed ${t.name} at ${fmt(t.buyNowPrice)} (${r.status})`, 'muted');
        return;
      }
      this.stats.buys++;
      this.stats.spent += t.buyNowPrice;
      this.countUsage('buys');
      ui.log(`✅ Bought ${t.name} (${t.rating || '?'}) for ${fmt(t.buyNowPrice)}`, 'ok');
      ui.toast(`Bought ${t.name} for ${fmt(t.buyNowPrice)}`, 'ok');
      sounds.buy();

      const entry = { at: Date.now(), id: t.defId, name: t.name, rating: t.rating, price: t.buyNowPrice, sell: 0 };
      const sell = planSellPrice(t.buyNowPrice, cfg, player);
      if (sell) {
        await sleep(jitter(800, 1600));
        const l = await fut.list(t.item, sell, cfg.listDuration);
        if (l.ok) {
          entry.sell = sell;
          this.stats.listed++;
          this.stats.profit += profit(t.buyNowPrice, sell);
          ui.log(`Listed for ${fmt(sell)} (≈ ${fmt(profit(t.buyNowPrice, sell))} profit)`, 'ok');
        } else {
          ui.log(`Couldn't list (${l.status}) — it's in your unassigned items`, 'warn');
        }
      }
      this.history = addHistory(this.history, entry);
      store.set(KEYS.history, this.history);
      ui.renderStats(); ui.renderHistory();
      notify.discord('buy', entry);
    },

    async tidy() {
      this.setStatus('pricing', 'Tidying transfer list…');
      try {
        const r = await fut.tidyTransferList();
        if (r.relisted === null && r.cleared === null) ui.log('Auto relist isn’t supported by this Web App version', 'muted');
        else ui.log(`Transfer list: ${r.relisted ? 'relisted expired' : 'nothing to relist'}, ${r.cleared ? 'cleared sold' : 'nothing sold'}`, 'muted');
      } catch (e) {
        ui.log(`Couldn't tidy transfer list: ${errText(e)}`, 'warn');
      }
    },
  };

  // ---- UI -----------------------------------------------------------------------

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>',
    chevron: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    coin: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5" fill="none" stroke="#0b0f13" stroke-opacity=".35" stroke-width="1.6"/></svg>',
  };

  const OPT = (pairs) => pairs.map(([v, l]) => ({ v, l }));
  const POSITIONS = OPT([['', 'Any'], ...['GK', 'RB', 'RWB', 'CB', 'LB', 'LWB', 'CDM', 'CM', 'CAM', 'RM', 'LM', 'RW', 'LW', 'CF', 'ST'].map((p) => [p, p])]);

  // [key, label, type, options/hint]
  const TABS = [
    ['snipe', 'Snipe'],
    ['filters', 'Filters'],
    ['sell', 'Sell'],
    ['safety', 'Safety'],
    ['history', 'History'],
  ];
  const FIELDS = {
    snipe: [
      ['mode', 'Mode', 'seg', OPT([['buy', 'Buy'], ['alert', 'Alert only']])],
      ['discount', 'Snipe % under avg', 'number'],
      ['minCoins', 'Keep coins', 'number'],
      ['maxBuys', 'Buys per session', 'number'],
    ],
    filters: [
      ['autoPrice', 'Auto max buy from price', 'toggle'],
      ['maxBuy', 'Default max buy', 'number', 'Used when there’s no price'],
      ['minRating', 'Min rating', 'number'],
      ['level', 'Quality', 'select', OPT([['any', 'Any'], ['gold', 'Gold'], ['silver', 'Silver'], ['bronze', 'Bronze']])],
      ['rarity', 'Rarity ID', 'text', 'e.g. 1 = rare'],
      ['position', 'Position', 'select', POSITIONS],
      ['nation', 'Nation ID', 'text'],
      ['league', 'League ID', 'text'],
      ['club', 'Club ID', 'text'],
      ['maxBuysPerSearch', 'Buys per search', 'number'],
    ],
    sell: [
      ['sellMode', 'After buying', 'select', OPT([['off', 'Keep the card'], ['profit', 'List for min profit'], ['market', 'List at market avg'], ['fixed', 'List at my price']])],
      ['sellPrice', 'My sell price', 'number'],
      ['minProfit', 'Min profit (after tax)', 'number'],
      ['listDuration', 'List for', 'select', OPT([['3600', '1 hour'], ['10800', '3 hours'], ['21600', '6 hours'], ['43200', '12 hours'], ['86400', '1 day'], ['259200', '3 days']])],
      ['autoRelist', 'Relist expired & clear sold on start', 'toggle'],
    ],
    safety: [
      ['delayMin', 'Delay min (ms, ≥ 3000)', 'number'],
      ['delayMax', 'Delay max (ms)', 'number'],
      ['pauseEvery', 'Rest every N searches (≤ 60)', 'number'],
      ['pauseMin', 'Rest min (ms)', 'number'],
      ['pauseMax', 'Rest max (ms)', 'number'],
      ['sessionMinutes', 'Session length (min)', 'number'],
      ['maxSearches', 'Searches per session', 'number'],
      ['searchesPerDay', 'Searches per day', 'number'],
      ['buysPerDay', 'Buys per day', 'number'],
      ['sound', 'Sound & vibration', 'toggle'],
      ['discordWebhook', 'Discord webhook', 'text', 'https://discord.com/api/webhooks/…'],
    ],
  };

  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

  function fieldHtml([key, label, type, extra]) {
    const v = engine.cfg[key];
    if (type === 'toggle') {
      return `<label class="row tg"><span>${label}</span><input type="checkbox" data-k="${key}" ${v ? 'checked' : ''}><i></i></label>`;
    }
    if (type === 'seg') {
      return `<div class="row"><span>${label}</span><div class="seg" data-k="${key}">${extra.map((o) =>
        `<button type="button" data-v="${o.v}" class="${String(v) === o.v ? 'on' : ''}">${o.l}</button>`).join('')}</div></div>`;
    }
    if (type === 'select') {
      return `<label class="row"><span>${label}</span><select data-k="${key}">${extra.map((o) =>
        `<option value="${o.v}" ${String(v) === o.v ? 'selected' : ''}>${o.l}</option>`).join('')}</select></label>`;
    }
    const wide = key === 'discordWebhook';
    return `<label class="row${wide ? ' wide' : ''}"><span>${label}</span><input type="${type === 'number' ? 'number' : 'text'}" inputmode="${type === 'number' ? 'numeric' : 'text'}"
      data-k="${key}" value="${esc(v)}" placeholder="${esc(extra || '')}" autocomplete="off"></label>`;
  }

  const CSS = `
  #fcs{--bg:#0d1116;--card:#151b22;--card2:#1b232c;--line:#26303b;--text:#e9eef3;--muted:#8796a5;--dim:#5b6876;
    --green:#3ddc84;--green-ink:#05210f;--red:#ff6b6b;--amber:#ffc857;--blue:#5aa9ff;
    position:fixed;top:14px;right:14px;z-index:2147483000;width:360px;max-height:calc(100vh - 28px);display:flex;flex-direction:column;
    background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:16px;overflow:hidden;
    font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;
    box-shadow:0 18px 50px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.02) inset;-webkit-font-smoothing:antialiased}
  #fcs *{box-sizing:border-box}
  #fcs svg{width:16px;height:16px;fill:currentColor;display:block}
  #fcs button{font:inherit;color:inherit;border:0;background:none;cursor:pointer;-webkit-tap-highlight-color:transparent}
  #fcs button:disabled{opacity:.45;cursor:default}
  #fcs input,#fcs select{font:inherit;color:var(--text);background:var(--card2);border:1px solid var(--line);border-radius:9px;padding:7px 9px;width:100%;min-width:0;outline:0}
  #fcs input:focus,#fcs select:focus{border-color:var(--green)}
  #fcs input:disabled,#fcs select:disabled{opacity:.55}

  #fcs .hd{display:flex;align-items:center;gap:10px;padding:12px 12px 10px 14px;cursor:move;touch-action:none;user-select:none}
  #fcs .brand{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
  #fcs .logo{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:linear-gradient(135deg,#3ddc84,#1aa35a);color:var(--green-ink);font-weight:800;font-size:12px}
  #fcs .brand b{font-size:14px;letter-spacing:.2px}
  #fcs .pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--card2);color:var(--muted)}
  #fcs .pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
  #fcs .pill.searching,#fcs .pill.waiting{color:var(--green)}#fcs .pill.resting,#fcs .pill.pricing{color:var(--blue)}#fcs .pill.locked{color:var(--red)}
  #fcs .coins{display:flex;align-items:center;gap:4px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--amber)}
  #fcs .coins svg{width:14px;height:14px;color:var(--amber)}
  #fcs .go{display:grid;place-items:center;width:38px;height:32px;border-radius:10px;background:var(--green);color:var(--green-ink)}
  #fcs .go.on{background:var(--red);color:#2a0606}
  #fcs .fold{width:30px;height:32px;display:grid;place-items:center;color:var(--muted);border-radius:8px;transition:transform .2s}
  #fcs.min .fold{transform:rotate(180deg)}

  #fcs .tabs{display:flex;gap:2px;padding:0 10px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
  #fcs .tabs::-webkit-scrollbar{display:none}
  #fcs .tabs button{padding:9px 9px 10px;color:var(--muted);font-weight:600;border-bottom:2px solid transparent;white-space:nowrap}
  #fcs .tabs button.on{color:var(--text);border-bottom-color:var(--green)}
  #fcs .body{overflow:auto;padding:12px 14px 14px;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
  #fcs.min .tabs,#fcs.min .body{display:none}
  #fcs .pane{display:none}#fcs .pane.on{display:block}

  #fcs .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:10px}
  #fcs .card h4{margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--dim)}
  #fcs .row{display:grid;grid-template-columns:1fr 46%;align-items:center;gap:10px;padding:5px 0}
  #fcs .row>span{color:var(--muted)}
  #fcs .row.wide{grid-template-columns:1fr}
  #fcs .seg{display:flex;background:var(--card2);border:1px solid var(--line);border-radius:9px;padding:2px}
  #fcs .seg button{flex:1;padding:5px 4px;border-radius:7px;color:var(--muted);font-weight:600;font-size:12px}
  #fcs .seg button.on{background:var(--green);color:var(--green-ink)}
  #fcs .tg{cursor:pointer}#fcs .tg input{display:none}
  #fcs .tg i{justify-self:end;width:40px;height:24px;border-radius:999px;background:var(--card2);border:1px solid var(--line);position:relative;transition:.2s}
  #fcs .tg i::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--muted);transition:.2s}
  #fcs .tg input:checked+i{background:var(--green);border-color:var(--green)}
  #fcs .tg input:checked+i::after{left:18px;background:#fff}
  #fcs .note{color:var(--dim);font-size:12px;margin:4px 0 0}

  #fcs .status{display:flex;align-items:center;justify-content:space-between;gap:10px}
  #fcs .status b{font-size:14px}#fcs .status small{color:var(--muted);font-variant-numeric:tabular-nums}
  #fcs .bars{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:9px}
  #fcs .bar em{font-style:normal}
  #fcs .bar span{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:4px;font-variant-numeric:tabular-nums}
  #fcs .bar div{height:5px;border-radius:9px;background:var(--card2);overflow:hidden}
  #fcs .bar div i{display:block;height:100%;background:var(--green);border-radius:9px;transition:width .3s}
  #fcs .bar.hot div i{background:var(--amber)}#fcs .bar.full div i{background:var(--red)}

  #fcs .pqw{position:relative}
  #fcs .chips{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
  #fcs .chips:empty{display:none}
  #fcs .chip{display:flex;align-items:center;gap:8px;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:7px 6px 7px 10px}
  #fcs .chip .ovr{font-weight:800;color:var(--green);font-size:12px;min-width:22px}
  #fcs .chip .nm{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #fcs .chip .nm small{display:block;font-weight:400;color:var(--dim);font-size:11px}
  #fcs .chip .mx{font-weight:700;color:var(--amber);font-variant-numeric:tabular-nums;padding:4px 7px;border-radius:7px;background:rgba(255,200,87,.08)}
  #fcs .chip .mx.manual{color:var(--blue);background:rgba(90,169,255,.1)}
  #fcs .chip .rm{width:26px;height:26px;color:var(--dim);font-size:17px;border-radius:7px}
  #fcs .sugg{position:absolute;left:0;right:0;top:100%;z-index:3;margin-top:4px;background:var(--card2);border:1px solid var(--line);border-radius:10px;max-height:260px;overflow:auto;box-shadow:0 12px 30px rgba(0,0,0,.5)}
  #fcs .sugg:empty{display:none}
  #fcs .sugg button{display:flex;justify-content:space-between;align-items:center;width:100%;text-align:left;padding:9px 11px;border-bottom:1px solid var(--line)}
  #fcs .sugg button:last-child{border-bottom:0}
  #fcs .sugg button:hover,#fcs .sugg button:focus{background:var(--card)}
  #fcs .sugg small{color:var(--dim)}#fcs .sugg b{color:var(--green)}
  #fcs .sugg .msg{padding:10px 11px;color:var(--muted)}
  #fcs .btn{display:block;width:100%;padding:9px;border-radius:10px;background:var(--card2);border:1px solid var(--line);font-weight:600;margin-top:8px}
  #fcs .btn.blue{color:#9fd3ff}#fcs .btn.red{color:var(--red)}

  #fcs .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
  #fcs .stats div{background:var(--card2);border-radius:9px;padding:7px 6px;text-align:center;color:var(--muted);font-size:11px}
  #fcs .stats b{display:block;color:var(--text);font-size:15px;font-variant-numeric:tabular-nums}
  #fcs .log{max-height:150px;overflow:auto;font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
  #fcs .log div{padding:2px 0;color:var(--muted)}#fcs .log time{color:var(--dim);margin-right:6px}
  #fcs .log .ok{color:var(--green)}#fcs .log .warn{color:var(--amber)}#fcs .log .err{color:var(--red)}#fcs .log .alert{color:#ffe08a}#fcs .log .muted{color:var(--dim)}
  #fcs .hist{display:flex;flex-direction:column}
  #fcs .hist div{display:grid;grid-template-columns:1fr auto;gap:2px 8px;padding:7px 0;border-bottom:1px solid var(--line)}
  #fcs .hist div:last-child{border-bottom:0}
  #fcs .hist small{color:var(--dim)}#fcs .hist .p{text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
  #fcs .hist .g{color:var(--green)}
  #fcs .empty{color:var(--dim);text-align:center;padding:14px 0}

  #fcs-toast{position:fixed;left:50%;top:16px;transform:translate(-50%,-30px);opacity:0;visibility:hidden;z-index:2147483001;padding:10px 16px;border-radius:12px;
    font:600 14px -apple-system,system-ui,sans-serif;color:#05210f;background:#3ddc84;box-shadow:0 12px 30px rgba(0,0,0,.4);transition:transform .25s,opacity .25s,visibility .25s;pointer-events:none;max-width:90vw}
  #fcs-toast.show{transform:translate(-50%,0);opacity:1;visibility:visible}#fcs-toast.alert{background:#ffc857;color:#2b1d00}

  #fcs.mob{top:auto!important;left:0!important;right:0!important;bottom:0;width:auto;max-height:78vh;border-radius:20px 20px 0 0;border-bottom:0;
    font-size:15px;padding-bottom:env(safe-area-inset-bottom)}
  #fcs.mob .hd{cursor:default;padding:12px 12px 10px 16px}
  #fcs.mob .hd::before{content:"";position:absolute;left:50%;top:5px;width:36px;height:4px;margin-left:-18px;border-radius:9px;background:var(--line)}
  #fcs.mob .go{width:48px;height:40px}#fcs.mob .fold{width:40px;height:40px}
  #fcs.mob .tabs button{padding:11px 10px 12px;font-size:14px}
  #fcs.mob input,#fcs.mob select{font-size:16px;padding:10px}
  #fcs.mob .row{padding:7px 0}#fcs.mob .seg button{padding:8px 4px;font-size:14px}
  #fcs.mob .btn{padding:13px}#fcs.mob .chip{padding:9px 6px 9px 12px}#fcs.mob .chip .rm{width:34px;height:34px}
  #fcs.mob .sugg button{padding:13px 12px}#fcs.mob .log{font-size:12px}`;

  const ui = {
    root: null,
    tab: store.get(KEYS.ui, {}).tab || 'snipe',

    q(sel) { return this.root.querySelector(sel); },
    qa(sel) { return [...this.root.querySelectorAll(sel)]; },

    mount() {
      if (document.getElementById('fcs')) return;
      const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
      const toast = document.createElement('div'); toast.id = 'fcs-toast'; document.body.appendChild(toast);
      const root = document.createElement('div'); root.id = 'fcs';
      root.innerHTML = `
        <div class="hd">
          <div class="brand"><span class="logo">FC</span><b>Sniper</b><span class="pill" data-r="pill">Idle</span></div>
          <span class="coins" data-r="coins"></span>
          <button class="go" data-a="toggle" aria-label="Start">${ICON.play}</button>
          <button class="fold" data-a="fold" aria-label="Collapse">${ICON.chevron}</button>
        </div>
        <nav class="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}</nav>
        <div class="body">
          <section class="pane" data-pane="snipe">
            <div class="card">
              <div class="status"><b data-r="state">Idle</b><small data-r="clock"></small></div>
              <div class="bars">
                <div class="bar" data-r="bar-s"><span><em>Searches today</em><em data-r="use-s"></em></span><div><i></i></div></div>
                <div class="bar" data-r="bar-b"><span><em>Buys today</em><em data-r="use-b"></em></span><div><i></i></div></div>
              </div>
            </div>
            <div class="card picker">
              <h4>Players</h4>
              <div class="chips" data-r="chips"></div>
              <div class="pqw"><input data-r="pq" type="search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Add a player — name or ID">
              <div class="sugg" data-r="sugg"></div></div>
              <button class="btn blue" data-a="price">Check prices</button>
              <p class="note">Tap a price to set your own max buy.</p>
            </div>
            <div class="card">${FIELDS.snipe.map(fieldHtml).join('')}</div>
            <div class="card"><h4>This session</h4>
              <div class="stats">
                <div><b data-s="searches">0</b>Searches</div><div><b data-s="buys">0</b>Bought</div><div><b data-s="missed">0</b>Missed</div>
                <div><b data-s="spent">0</b>Spent</div><div><b data-s="listed">0</b>Listed</div><div><b data-s="profit">0</b>Est. profit</div>
              </div>
            </div>
            <div class="card"><h4>Activity</h4><div class="log" data-r="log"></div></div>
          </section>
          <section class="pane" data-pane="filters"><div class="card">${FIELDS.filters.map(fieldHtml).join('')}
            <p class="note">Players match every version of the card. Use Min rating to target one version.</p></div></section>
          <section class="pane" data-pane="sell"><div class="card">${FIELDS.sell.map(fieldHtml).join('')}
            <p class="note">EA keeps 5% of every sale. Profit shown is after tax.</p></div></section>
          <section class="pane" data-pane="safety">
            <div class="card"><h4>Limits</h4>${FIELDS.safety.slice(0, 9).map(fieldHtml).join('')}
              <p class="note">Minimums are enforced. A captcha locks the bot for 3 h, a market limit for 24 h.</p>
              <p class="note" data-r="lock"></p></div>
            <div class="card"><h4>Notifications</h4>${FIELDS.safety.slice(9).map(fieldHtml).join('')}
              <button class="btn" data-a="discord-test">Send test notification</button></div>
          </section>
          <section class="pane" data-pane="history">
            <div class="card"><h4>Totals</h4><div class="stats" data-r="totals"></div></div>
            <div class="card"><h4>Recent buys</h4><div class="hist" data-r="hist"></div>
              <button class="btn red" data-a="clear-history">Clear history</button></div>
          </section>
        </div>`;
      document.body.appendChild(root);
      this.root = root;

      if (isMobile()) root.classList.add('mob', 'min');
      this.bind();
      this.mountPicker();
      this.showTab(this.tab);
      this.renderPlayers(); this.renderStats(); this.renderHistory(); this.renderStatus();
      setInterval(() => this.tick(), 500);

      this.log(isMobile() ? 'Ready — tap ▶ to start' : 'Ready — Alt+S to start/stop', 'muted');
      const gate = engine.gate();
      if (!gate.ok) this.log(`Locked — ${gate.reason}`, 'err');
    },

    bind() {
      const root = this.root;
      root.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.tab) return this.showTab(btn.dataset.tab);
        if (btn.closest('.seg')) {
          if (engine.running) return;
          const seg = btn.closest('.seg');
          seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
          return this.commit();
        }
        switch (btn.dataset.a) {
          case 'toggle': return engine.toggle();
          case 'fold': return root.classList.toggle('min');
          case 'price': return engine.checkPricesNow();
          case 'discord-test':
            this.commit();
            if (!engine.cfg.discordWebhook) return this.log('Paste a Discord webhook URL first', 'warn');
            return notify.discord('test', {}).then((ok) => ok && this.log('Test notification sent — check Discord', 'ok'));
          case 'clear-history':
            if (!w.confirm('Clear your buy history?')) return;
            engine.history = []; store.set(KEYS.history, []); return this.renderHistory();
          default:
        }
      });
      root.addEventListener('change', (e) => { if (e.target.dataset.k) this.commit(); });
      document.addEventListener('keydown', (e) => {
        if (e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); engine.toggle(); }
      });
      document.addEventListener('visibilitychange', () => {
        if (!engine.running) return;
        if (document.visibilityState === 'visible') { keepAwake(true); this.log('Back on screen', 'muted'); }
        else this.log('Page in background — your phone may pause the bot', 'warn');
      });
      this.makeDraggable(this.q('.hd'));
    },

    showTab(tab) {
      this.tab = tab;
      this.qa('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
      this.qa('[data-pane]').forEach((p) => p.classList.toggle('on', p.dataset.pane === tab));
      store.set(KEYS.ui, { tab });
    },

    /** Read every field into the config and save it. */
    commit() {
      const cfg = { ...engine.cfg };
      this.qa('[data-k]').forEach((el) => {
        const k = el.dataset.k;
        if (el.classList.contains('seg')) cfg[k] = el.querySelector('.on')?.dataset.v ?? cfg[k];
        else if (el.type === 'checkbox') cfg[k] = el.checked;
        else if (typeof DEFAULT_CONFIG[k] === 'number') cfg[k] = Number(el.value) || 0;
        else cfg[k] = el.value.trim();
      });
      engine.cfg = cfg;
      engine.save();
      this.renderStatus();
    },

    /** Push config values back into the fields (after safety clamping). */
    syncForm() {
      this.qa('[data-k]').forEach((el) => {
        const v = engine.cfg[el.dataset.k];
        if (el.classList.contains('seg')) el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
        else if (el.type === 'checkbox') el.checked = !!v;
        else el.value = v ?? '';
      });
    },

    mountPicker() {
      const input = this.q('[data-r=pq]');
      const sugg = this.q('[data-r=sugg]');
      let results = [];
      let timer;

      const add = (p) => {
        input.value = ''; sugg.innerHTML = '';
        if (engine.cfg.players.some((x) => x.id === p.id)) return;
        const entry = { id: p.id, name: p.name, rating: p.rating };
        engine.cfg.players = [...engine.cfg.players, entry];
        engine.save();
        this.renderPlayers();
        this.log(`Added ${p.name}${p.rating ? ` (${p.rating})` : ''}`, 'muted');
        if (engine.cfg.autoPrice && !engine.running && fut.ready()) {
          engine.busy = true; this.setBusy(true);
          engine.priceCheck([entry]).catch((e) => this.log(`Price check error: ${errText(e)}`, 'err')).finally(() => {
            engine.save(); engine.busy = false; this.setBusy(false); engine.setStatus('idle', 'Idle'); this.renderPlayers();
          });
        }
      };

      const show = async () => {
        const q = input.value.trim();
        if (!q) { sugg.innerHTML = ''; return; }
        if (/^\d{3,}$/.test(q)) {
          const known = playerDb.list && playerDb.list.find((p) => p.id === Number(q));
          results = [known || { id: Number(q), name: `#${q}`, rating: 0 }];
        } else {
          if (!playerDb.list) sugg.innerHTML = '<div class="msg">Loading players…</div>';
          try { results = searchPlayers(await playerDb.load(), q); } catch (e) {
            results = [];
            sugg.innerHTML = `<div class="msg">${esc(errText(e))}. You can still type a player ID.</div>`;
            return;
          }
          if (input.value.trim() !== q) return;
        }
        sugg.innerHTML = results.length
          ? results.map((p, i) => `<button data-pick="${i}"><span>${esc(p.name)}${p.full && p.full !== p.name ? `<br><small>${esc(p.full)}</small>` : ''}</span><b>${p.rating || ''}</b></button>`).join('')
          : '<div class="msg">No players found</div>';
      };

      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(show, 160); });
      input.addEventListener('focus', () => { playerDb.load().catch(() => {}); });
      input.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape') { sugg.innerHTML = ''; return; }
        if (e.key !== 'Enter' || !input.value.trim()) return;
        e.preventDefault();
        clearTimeout(timer);
        await show(); // Enter may come before the suggestions have loaded
        if (results[0] && sugg.querySelector('[data-pick]')) add(results[0]);
      });
      this.root.addEventListener('click', (e) => {
        const pick = e.target.closest('[data-pick]');
        if (pick) return add(results[Number(pick.dataset.pick)]);
        const rm = e.target.closest('[data-rm]');
        if (rm && !engine.running) {
          engine.cfg.players = engine.cfg.players.filter((p) => p.id !== Number(rm.dataset.rm));
          engine.save(); this.renderPlayers();
          return;
        }
        const mx = e.target.closest('[data-max]');
        if (mx && !engine.running) this.editMax(Number(mx.dataset.max));
        if (!e.target.closest('.picker')) sugg.innerHTML = '';
      });
    },

    editMax(id) {
      const p = engine.cfg.players.find((x) => x.id === id);
      if (!p) return;
      const hint = p.avg ? ` Market avg is ${fmt(p.avg)}.` : '';
      const v = w.prompt(`Max buy for ${p.name}.${hint}\nLeave empty to use the automatic price.`, p.manualMax || '');
      if (v === null) return;
      const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
      p.manualMax = n >= MIN_PRICE ? roundPrice(n) : 0;
      engine.save(); this.renderPlayers();
      this.log(p.manualMax ? `${p.name}: max buy set to ${fmt(p.manualMax)}` : `${p.name}: back to automatic price`, 'muted');
    },

    renderPlayers() {
      const cfg = engine.cfg;
      this.q('[data-r=chips]').innerHTML = cfg.players.map((p) => {
        const max = effectiveMaxBuy(p, cfg);
        const sub = p.manualMax ? 'your max' : p.avg ? `avg ${fmt(p.avg)}` : p.checkedAt ? 'none listed' : 'not priced yet';
        return `<div class="chip"><span class="ovr">${p.rating || ''}</span>
          <span class="nm">${esc(p.name)}<small>${sub}</small></span>
          <button class="mx${p.manualMax ? ' manual' : ''}" data-max="${p.id}">≤ ${fmt(max)}</button>
          <button class="rm" data-rm="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></div>`;
      }).join('');
    },

    renderStats() {
      Object.entries(engine.stats).forEach(([k, v]) => {
        const el = this.q(`[data-s="${k}"]`);
        if (el) el.textContent = fmt(v);
      });
    },

    renderHistory() {
      const sum = summarizeHistory(engine.history, Date.now());
      this.q('[data-r=totals]').innerHTML = `
        <div><b>${fmt(sum.today.buys)}</b>Buys today</div><div><b>${fmt(sum.today.spent)}</b>Spent today</div><div><b>${fmt(sum.today.profit)}</b>Profit today</div>
        <div><b>${fmt(sum.all.buys)}</b>All buys</div><div><b>${fmt(sum.all.spent)}</b>All spent</div><div><b>${fmt(sum.all.profit)}</b>All profit</div>`;
      const list = engine.history.slice(0, 50);
      this.q('[data-r=hist]').innerHTML = list.length ? list.map((e) => `
        <div><span>${esc(e.name)}${e.rating ? ` · ${e.rating}` : ''}</span><span class="p">${fmt(e.price)}</span>
        <small>${new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small>
        <small class="p ${e.sell ? 'g' : ''}">${e.sell ? `listed ${fmt(e.sell)} · +${fmt(profit(e.price, e.sell))}` : 'kept'}</small></div>`).join('')
        : '<p class="empty">No buys yet</p>';
    },

    renderStatus() {
      if (!this.root) return;
      const gate = engine.gate();
      const locked = !engine.running && !engine.busy && !gate.ok && engine.safety.lockUntil > Date.now();
      const st = locked ? { state: 'locked', text: 'Locked' } : engine.status;
      const pill = this.q('[data-r=pill]');
      pill.className = `pill ${st.state}`;
      pill.textContent = { idle: 'Idle', searching: 'Live', waiting: 'Live', resting: 'Resting', pricing: 'Pricing', locked: 'Locked' }[st.state] || 'Idle';
      this.q('[data-r=state]').textContent = locked ? 'Safety lock' : st.text;
      this.q('[data-r=lock]').textContent = gate.ok ? '' : `Right now: ${gate.reason}.`;

      const u = usageFor(engine.safety.usage, Date.now());
      const bar = (key, used, max) => {
        const pct = Math.min(100, (used / Math.max(1, max)) * 100);
        const el = this.q(`[data-r=bar-${key}]`);
        el.className = `bar${pct >= 100 ? ' full' : pct >= 75 ? ' hot' : ''}`;
        el.querySelector('i').style.width = `${pct}%`;
        this.q(`[data-r=use-${key}]`).textContent = `${fmt(used)} / ${fmt(max)}`;
      };
      bar('s', u.searches, engine.cfg.searchesPerDay);
      bar('b', u.buys, engine.cfg.buysPerDay);
    },

    /** Twice a second: countdowns, coins, session timer. */
    tick() {
      this.ticks = (this.ticks || 0) + 1;
      if (this.ticks % 4 === 0) this.renderStatus(); // usage bars, lock expiry
      const c = fut.ready() ? fut.coins() : 0;
      this.q('[data-r=coins]').innerHTML = c ? `${ICON.coin}${fmt(c)}` : '';
      const st = engine.status;
      let clock = '';
      if (st.until > Date.now()) clock = `${Math.ceil((st.until - Date.now()) / 1000)}s`;
      if (engine.running) {
        const left = Math.max(0, engine.session.endsAt - Date.now());
        clock += `${clock ? ' · ' : ''}${Math.floor(left / 60e3)}:${String(Math.floor((left % 60e3) / 1000)).padStart(2, '0')} left`;
      }
      this.q('[data-r=clock]').textContent = clock;
    },

    setRunning(on) {
      const go = this.q('[data-a=toggle]');
      go.classList.toggle('on', on);
      go.innerHTML = on ? ICON.stop : ICON.play;
      go.setAttribute('aria-label', on ? 'Stop' : 'Start');
      this.tick();
      this.qa('[data-k] , [data-k] button, [data-r=pq], [data-a=price]').forEach((el) => { el.disabled = on; });
      this.renderStatus();
    },

    setBusy(on) {
      this.q('[data-a=toggle]').disabled = on;
      const pc = this.q('[data-a=price]');
      pc.disabled = on;
      pc.textContent = on ? 'Checking prices…' : 'Check prices';
    },

    log(msg, cls = '') {
      const box = this.root && this.q('[data-r=log]');
      if (!box) return;
      const line = document.createElement('div');
      line.className = cls;
      line.innerHTML = `<time>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time>`;
      line.append(document.createTextNode(msg));
      box.prepend(line);
      while (box.childNodes.length > 200) box.lastChild.remove();
    },

    toast(msg, kind = 'ok') {
      const t = document.getElementById('fcs-toast');
      if (!t) return;
      t.textContent = msg;
      t.className = `show ${kind}`;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { t.className = kind; }, 3500);
    },

    makeDraggable(handle) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button') || this.root.classList.contains('mob')) return;
        const r = this.root.getBoundingClientRect();
        const sx = e.clientX; const sy = e.clientY;
        const move = (ev) => {
          this.root.style.left = `${Math.max(0, r.left + ev.clientX - sx)}px`;
          this.root.style.top = `${Math.max(0, r.top + ev.clientY - sy)}px`;
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
