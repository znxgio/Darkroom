// ==UserScript==
// @name         FC Sniper
// @namespace    https://github.com/znxgio/darkroom
// @version      1.4.0
// @description  Sniper, pack opener, SBC solver and team upgrade advisor for the EA SPORTS FC Ultimate Team Web App, with built-in safety limits.
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
 *   3. Tasks: open your unopened packs and sort the items, solve SBCs from your
 *      cheapest fodder, and suggest upgrades for your squad's weakest spots.
 *   4. Safety: enforced minimum delays and rests, session and daily limits, and
 *      lockouts after a captcha or market limit (shared by every feature).
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

  // ---- Trading (resell) & bidding ------------------------------------------------

  /**
   * Resale plan for a card: list `undercut`% under the market average so it
   * sells, and only buy low enough to keep `minProfit` after EA's 5% tax.
   * Returns { sell, maxBuy, profit } or null when no profitable buy price exists.
   */
  function flipPlan(avg, opts = {}) {
    const minProfit = Math.max(0, opts.minProfit || 0);
    const undercut = Math.max(0, Math.min(50, opts.undercut ?? 3));
    if (!avg || avg < MIN_PRICE) return null;
    const sell = roundPrice(avg * (1 - undercut / 100), 'down');
    let maxBuy = roundPrice(Math.max(MIN_PRICE, afterTax(sell) - minProfit), 'down');
    while (maxBuy > MIN_PRICE && profit(maxBuy, sell) < minProfit) maxBuy = prevPrice(maxBuy);
    if (profit(maxBuy, sell) < Math.max(1, minProfit)) return null;
    return { sell, maxBuy, profit: profit(maxBuy, sell) };
  }

  /**
   * What to bid on an auction about to end, or 0 to skip it.
   * l: { expires (seconds left), currentBid, startingBid, buyNowPrice, bidState }
   */
  function bidAmount(l, maxBid, windowSec = 30) {
    if (!l || !(l.expires > 0) || l.expires > windowSec) return 0;
    if (l.bidState === 'highest') return 0;
    const next = l.currentBid > 0 ? nextPrice(l.currentBid) : Math.max(MIN_PRICE, l.startingBid || MIN_PRICE);
    if (next > maxBid) return 0;
    if (l.buyNowPrice && next >= l.buyNowPrice) return 0; // Buy Now is the better move
    return next;
  }

  /** Records sales from your transfer list. sold: [{ itemId, price }]. */
  function settleSales(history, sold, now) {
    const byId = new Map(sold.map((x) => [x.itemId, x.price]));
    let realized = 0;
    let matched = 0;
    const out = (history || []).map((e) => {
      if (!e.itemId || e.soldFor || !byId.has(e.itemId)) return e;
      const soldFor = byId.get(e.itemId);
      realized += afterTax(soldFor) - e.price;
      matched++;
      return { ...e, soldFor, soldAt: now };
    });
    return { history: out, realized, matched };
  }

  // ---- Market scanner: what's hot right now ---------------------------------------

  /**
   * Groups market listings by card. listings: [{ defId, name, rating, buyNowPrice, currentBid, tradeId }]
   * → [{ id, name, rating, count, bids, minBin, medianBin }]
   */
  function aggregateListings(listings) {
    const m = new Map();
    const seen = new Set();
    for (const l of listings) {
      if (!l || !l.defId || !l.buyNowPrice || seen.has(l.tradeId)) continue;
      seen.add(l.tradeId);
      if (!m.has(l.defId)) m.set(l.defId, { id: l.defId, name: l.name, rating: l.rating, bins: [], bids: 0 });
      const c = m.get(l.defId);
      c.bins.push(l.buyNowPrice);
      if (l.currentBid > 0) c.bids++;
    }
    return [...m.values()].map((c) => {
      const bins = c.bins.sort((a, b) => a - b);
      return { id: c.id, name: c.name, rating: c.rating, count: bins.length, bids: c.bids, minBin: bins[0], medianBin: bins[Math.floor(bins.length / 2)] };
    });
  }

  /**
   * How "hot" a card is right now: demand (listings with live bids), supply
   * (lots of copies listed = easy to buy and sell), and room to profit (gap
   * between the cheapest and the typical listing). Cards outside the budget score 0.
   */
  function hotScore(c, opts = {}) {
    const budget = opts.budget || Infinity;
    if (!c.count || c.minBin > budget || c.count < (opts.minListings || 3)) return 0;
    const demand = c.bids / c.count; // share of listings people are bidding on
    const supply = Math.min(1, c.count / 12);
    const gap = c.medianBin > 0 ? Math.max(0, (c.medianBin - c.minBin) / c.medianBin) : 0;
    return Math.round((demand * 50 + supply * 30 + Math.min(gap, 0.2) * 100) * 10) / 10;
  }

  function rankHot(cards, opts = {}) {
    return cards.map((c) => ({ ...c, score: hotScore(c, opts) })).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  }

  /** Trade settings for a card: Min profit, or Min profit % of the price, whichever is higher. */
  function tradeOpts(avg, cfg) {
    return { minProfit: Math.max(cfg.minProfit || 0, Math.round((avg || 0) * (cfg.minProfitPct || 0) / 100)), undercut: cfg.undercut };
  }

  // ---- Buy history & notifications --------------------------------------------

  /** Newest first, capped at `max` entries. */
  function addHistory(list, entry, max = 300) {
    return [entry, ...(list || [])].slice(0, max);
  }

  /**
   * Totals for today and all time. Entries: { at, price, sell, soldFor, soldAt }.
   * profit = expected from listings; realized = actual sales after tax.
   */
  function summarizeHistory(list, now) {
    const today = dayKey(now);
    const sum = (arr) => arr.reduce((t, e) => ({
      buys: t.buys + 1,
      spent: t.spent + e.price,
      profit: t.profit + (e.sell ? profit(e.price, e.sell) : 0),
      sold: t.sold + (e.soldFor ? 1 : 0),
      realized: t.realized + (e.soldFor ? afterTax(e.soldFor) - e.price : 0),
    }), { buys: 0, spent: 0, profit: 0, sold: 0, realized: 0 });
    const L = list || [];
    const todays = sum(L.filter((e) => dayKey(e.at) === today));
    const soldToday = L.filter((e) => e.soldAt && dayKey(e.soldAt) === today);
    todays.soldToday = soldToday.length;
    todays.realizedToday = soldToday.reduce((a, e) => a + afterTax(e.soldFor) - e.price, 0);
    return { today: todays, all: sum(L) };
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
      info: { title: d.title || 'FC Sniper', color: 0x5aa9ff, description: d.text || '' },
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

  // ---- Squads: rating & chemistry ------------------------------------------------

  /** EA squad rating: floor(round(sum + excess over the average) / 11). */
  function squadRating(ratings, size = 11) {
    const list = ratings.filter((r) => r > 0);
    if (!list.length) return 0;
    const sum = list.reduce((a, b) => a + b, 0);
    const avg = sum / size;
    const excess = list.reduce((a, r) => a + Math.max(0, r - avg), 0);
    return Math.floor(Math.round(sum + excess) / size);
  }

  const ICONS_LEAGUE = 2118;
  const CHEM_STEPS = { club: [2, 5, 8], nation: [2, 5, 8], league: [3, 5, 8] };
  const chemPoints = (count, steps) => steps.filter((s) => count >= s).length;

  /**
   * Chemistry (FC 24+ system): each in-position player earns club, nation and
   * league points from how many teammates share them, capped at 3. Icons
   * always have 3 and count double for their nation.
   * players: [{ nationId, leagueId, teamId, inPosition, icon }]
   */
  function squadChemistry(players) {
    const counts = { club: new Map(), nation: new Map(), league: new Map() };
    const bump = (m, k, n = 1) => { if (k) m.set(k, (m.get(k) || 0) + n); };
    for (const p of players) {
      if (!p || !p.inPosition) continue;
      const icon = p.icon || p.leagueId === ICONS_LEAGUE;
      bump(counts.nation, p.nationId, icon ? 2 : 1);
      if (!icon) { bump(counts.club, p.teamId); bump(counts.league, p.leagueId); }
    }
    const each = players.map((p) => {
      if (!p || !p.inPosition) return 0;
      if (p.icon || p.leagueId === ICONS_LEAGUE) return 3;
      return Math.min(3,
        chemPoints(counts.club.get(p.teamId) || 0, CHEM_STEPS.club)
        + chemPoints(counts.nation.get(p.nationId) || 0, CHEM_STEPS.nation)
        + chemPoints(counts.league.get(p.leagueId) || 0, CHEM_STEPS.league));
    });
    return { each, total: each.reduce((a, b) => a + b, 0) };
  }

  /** Most common value of `key` among players, e.g. the squad's main league. */
  function topValues(players, key, n = 2) {
    const m = new Map();
    players.forEach((p) => { if (p && p[key]) m.set(p[key], (m.get(p[key]) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v, count]) => ({ value: v, count }));
  }

  /**
   * Ranks possible upgrades for one squad slot.
   * squad: [{ position, player }] (11 slots); slotIndex: slot to replace;
   * candidates: [{ id, name, rating, nationId, leagueId, teamId, positions:[..], price, source }]
   * Returns candidates with { ratingAfter, chemAfter, ratingGain, chemGain, score }, best first.
   */
  function rankUpgrades(squad, slotIndex, candidates, opts = {}) {
    const inPos = (pl, pos) => !!pl && (pl.positions || []).includes(pos);
    const base = squad.map((s) => s.player);
    const baseRating = squadRating(base.map((p) => (p ? p.rating : 0)));
    const baseChem = squadChemistry(squad.map((s) => s.player && { ...s.player, inPosition: inPos(s.player, s.position) })).total;
    const taken = new Set(base.filter(Boolean).map((p) => p.id));
    const pos = squad[slotIndex].position;
    return candidates
      .filter((c) => !taken.has(c.id) && inPos(c, pos))
      .map((c) => {
        const after = squad.map((s, i) => (i === slotIndex ? c : s.player));
        const ratingAfter = squadRating(after.map((p) => (p ? p.rating : 0)));
        const chemAfter = squadChemistry(after.map((p, i) => p && { ...p, inPosition: inPos(p, squad[i].position) })).total;
        const ratingGain = ratingAfter - baseRating;
        const chemGain = chemAfter - baseChem;
        const playerGain = c.rating - ((squad[slotIndex].player && squad[slotIndex].player.rating) || 0);
        // Rating matters most, chemistry next; owned players are free.
        const price = c.source === 'club' ? 0 : (c.price || 0);
        const score = ratingGain * 10 + playerGain * 2 + chemGain * 3 - price / Math.max(1000, opts.budget || 100000) * 4;
        return { ...c, ratingAfter, chemAfter, ratingGain, chemGain, playerGain, score };
      })
      .filter((c) => c.playerGain > 0 && (opts.allowChemLoss || c.chemGain >= -(opts.maxChemLoss ?? 2)))
      .sort((a, b) => b.score - a.score);
  }

  // ---- Positions, formations & best lineup -------------------------------------------

  /** EA position ids → names. */
  const POS_NAMES = { 0: 'GK', 1: 'SW', 2: 'RWB', 3: 'RB', 4: 'RCB', 5: 'CB', 6: 'LCB', 7: 'LB', 8: 'LWB', 9: 'RDM', 10: 'CDM', 11: 'LDM', 12: 'RM', 13: 'RCM', 14: 'CM', 15: 'LCM', 16: 'LM', 17: 'RAM', 18: 'CAM', 19: 'LAM', 20: 'RF', 21: 'CF', 22: 'LF', 23: 'RW', 24: 'RS', 25: 'ST', 26: 'LS', 27: 'LW' };
  const POS_GENERAL = { SW: 'CB', RCB: 'CB', LCB: 'CB', RDM: 'CDM', LDM: 'CDM', RCM: 'CM', LCM: 'CM', RAM: 'CAM', LAM: 'CAM', RF: 'CF', LF: 'CF', RS: 'ST', LS: 'ST' };

  /** Position id or name → the general position players are listed with ("RCB" → "CB"). */
  function normPos(p) {
    const name = typeof p === 'number' ? POS_NAMES[p] : String(p || '').toUpperCase();
    return POS_GENERAL[name] || name;
  }

  /**
   * Popular competitive formations (built in, not live data). Slots are in EA's
   * order: keeper, defence right→left, midfield right→left, attack right→left.
   */
  const FORMATIONS = {
    f4231: { label: '4-2-3-1', slots: ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'CDM', 'RM', 'CAM', 'LM', 'ST'] },
    f4321: { label: '4-3-2-1', slots: ['GK', 'RB', 'CB', 'CB', 'LB', 'CM', 'CM', 'CM', 'CF', 'CF', 'ST'] },
    f41212a: { label: '4-1-2-1-2 (2)', slots: ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'CM', 'CM', 'CAM', 'ST', 'ST'] },
    f4312: { label: '4-3-1-2', slots: ['GK', 'RB', 'CB', 'CB', 'LB', 'CM', 'CM', 'CM', 'CAM', 'ST', 'ST'] },
    f433: { label: '4-3-3', slots: ['GK', 'RB', 'CB', 'CB', 'LB', 'CM', 'CM', 'CM', 'RW', 'ST', 'LW'] },
    f442: { label: '4-4-2', slots: ['GK', 'RB', 'CB', 'CB', 'LB', 'RM', 'CM', 'CM', 'LM', 'ST', 'ST'] },
    f4222: { label: '4-2-2-2', slots: ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'CDM', 'CAM', 'CAM', 'ST', 'ST'] },
    f5212: { label: '5-2-1-2', slots: ['GK', 'RWB', 'CB', 'CB', 'CB', 'LWB', 'CM', 'CM', 'CAM', 'ST', 'ST'] },
    f3421: { label: '3-4-2-1', slots: ['GK', 'CB', 'CB', 'CB', 'RM', 'CM', 'CM', 'LM', 'CF', 'CF', 'ST'] },
  };

  /** Squad rating with decimals (no rounding) — smooth enough to optimise against. */
  function squadRatingExact(ratings, size = 11) {
    const list = ratings.filter((r) => r > 0);
    if (!list.length) return 0;
    const sum = list.reduce((a, b) => a + b, 0);
    const avg = sum / size;
    return (sum + list.reduce((a, r) => a + Math.max(0, r - avg), 0)) / size;
  }

  /** Score of a lineup: rating matters most, chemistry next. */
  function lineupScore(lineup, slots, chemWeight = 0.6) {
    const ratings = lineup.map((p) => (p ? p.rating : 0));
    const chem = squadChemistry(lineup.map((p, i) => p && { ...p, inPosition: p.positions.includes(slots[i]) })).total;
    return { score: squadRatingExact(ratings) * 3 + chem * chemWeight, rating: squadRating(ratings), chem };
  }

  /**
   * Best XI from your players for a formation: fills each slot with an
   * in-position player, then keeps swapping while rating + chemistry improves.
   * players: [{ id, rating, positions: [general names], nationId, leagueId, teamId }]
   */
  function bestLineup(players, slots, opts = {}) {
    const pool = players.filter((p) => p && p.rating > 0);
    const fits = slots.map((pos) => pool.filter((p) => p.positions.includes(pos)).sort((a, b) => b.rating - a.rating).slice(0, opts.depth || 12));
    // Fill the scarcest positions first so a rare position isn't left empty.
    const order = slots.map((_, i) => i).sort((a, b) => fits[a].length - fits[b].length);
    const lineup = new Array(slots.length).fill(null);
    const used = new Set();
    for (const i of order) {
      const p = fits[i].find((x) => !used.has(x.id));
      if (p) { lineup[i] = p; used.add(p.id); }
    }
    let best = lineupScore(lineup, slots, opts.chemWeight);
    for (let round = 0; round < 6; round++) {
      let improved = false;
      for (let i = 0; i < slots.length; i++) {
        for (const cand of fits[i]) {
          if (lineup[i] && cand.id === lineup[i].id) continue;
          const j = lineup.findIndex((x) => x && x.id === cand.id);
          const next = lineup.slice();
          if (j >= 0) {
            // swap two players if both still fit
            if (!lineup[i] || !lineup[i].positions.includes(slots[j])) continue;
            next[j] = lineup[i];
          }
          next[i] = cand;
          const sc = lineupScore(next, slots, opts.chemWeight);
          if (sc.score > best.score + 1e-9) { lineup.splice(0, lineup.length, ...next); best = sc; improved = true; }
        }
      }
      if (!improved) break;
    }
    return { lineup, rating: best.rating, chem: best.chem, score: best.score, filled: lineup.filter(Boolean).length };
  }

  // ---- SBC solving ------------------------------------------------------------------

  /** Rough coin value of a player by rating — used to spend the cheapest players first. */
  function fodderValue(rating) {
    const table = { 75: 300, 76: 350, 77: 400, 78: 500, 79: 650, 80: 850, 81: 1100, 82: 1500, 83: 2500, 84: 4500, 85: 7500, 86: 12000, 87: 18000, 88: 26000, 89: 36000, 90: 50000 };
    if (rating < 75) return 100 + rating;
    return table[rating] || Math.round(50000 * 1.4 ** (rating - 90));
  }

  /**
   * How costly it is to give a club player away. Duplicates and SBC-storage
   * players are nearly free (you can't keep them), untradeables are cheaper
   * than tradeables, specials are expensive.
   */
  function playerCost(p) {
    let c = fodderValue(p.rating);
    if (p.duplicate || p.storage) c *= 0.2;
    else if (p.untradeable) c *= 0.6;
    if (p.special) c *= 4;
    return Math.max(1, Math.round(c));
  }

  const QUALITY = { bronze: 1, silver: 2, gold: 3 };
  const qualityOf = (rating) => (rating >= 75 ? 3 : rating >= 65 ? 2 : 1);

  /**
   * Turns EA requirements into solver constraints.
   * reqs: [{ key: 'TEAM_RATING', scope: 'GREATER'|'LOWER'|'EXACT', values: [..], count }]
   * Requirements the solver can't satisfy yet are listed in `unsupported`.
   */
  function parseRequirements(reqs, playersRequired = 11) {
    const c = { players: playersRequired, teamRating: 0, teamRatingMax: 99, minOvr: 0, maxOvr: 99, minQuality: 0, maxQuality: 9, rareMin: 0, chemMin: 0 };
    const unsupported = [];
    for (const r of reqs || []) {
      const v = Number((r.values || [])[0]);
      // count -1 means "every player"; so does a count that covers the whole squad ("11× Bronze")
      const all = !(r.count > 0) || r.count >= playersRequired;
      switch (r.key) {
        case 'TEAM_RATING':
          if (r.scope === 'LOWER') c.teamRatingMax = Math.min(c.teamRatingMax, v);
          else if (r.scope === 'EXACT') { c.teamRating = Math.max(c.teamRating, v); c.teamRatingMax = Math.min(c.teamRatingMax, v); }
          else c.teamRating = Math.max(c.teamRating, v);
          break;
        case 'PLAYER_COUNT':
        case 'SCOPE':
          break;
        case 'PLAYER_MIN_OVR': c.minOvr = Math.max(c.minOvr, v); break;
        case 'PLAYER_MAX_OVR': c.maxOvr = Math.min(c.maxOvr, v); break;
        case 'PLAYER_EXACT_OVR': c.minOvr = Math.max(c.minOvr, v); c.maxOvr = Math.min(c.maxOvr, v); break;
        case 'PLAYER_QUALITY':
        case 'PLAYER_LEVEL':
          if (!all) { unsupported.push('quality count'); break; }
          if (r.scope === 'GREATER') c.minQuality = Math.max(c.minQuality, v);
          else if (r.scope === 'LOWER') c.maxQuality = Math.min(c.maxQuality, v);
          else { c.minQuality = Math.max(c.minQuality, v); c.maxQuality = Math.min(c.maxQuality, v); }
          break;
        case 'PLAYER_RARITY_GROUP':
          if (r.scope === 'LOWER') unsupported.push('max rares'); else c.rareMin = Math.max(c.rareMin, all ? playersRequired : r.count);
          break;
        case 'CHEMISTRY_POINTS':
        case 'ALL_PLAYERS_CHEMISTRY_POINTS':
          if (v > 0) unsupported.push('chemistry');
          break;
        case 'PLAYER_TRADABILITY':
          break; // untradeables are allowed everywhere; tradeables only if you allow them
        default:
          unsupported.push(String(r.key || 'unknown').toLowerCase().replace(/_/g, ' '));
      }
    }
    return { constraints: c, unsupported: [...new Set(unsupported)] };
  }

  /**
   * Picks the cheapest set of club players that meets the constraints.
   * pool: [{ id, rating, rare, cost, ... }]. Returns { players, rating, cost } or null.
   */
  function solveSbc(pool, k) {
    const eligible = pool.filter((p) => p.rating >= k.minOvr && p.rating <= k.maxOvr
      && qualityOf(p.rating) >= (k.minQuality || 0) && qualityOf(p.rating) <= (k.maxQuality || 9));
    const n = k.players;
    if (eligible.length < n) return null;

    // Buckets of players by rating, cheapest first.
    const byRating = new Map();
    for (const p of eligible) {
      if (!byRating.has(p.rating)) byRating.set(p.rating, []);
      byRating.get(p.rating).push(p);
    }
    byRating.forEach((list) => list.sort((a, b) => a.cost - b.cost || (b.rare ? 1 : 0) - (a.rare ? 1 : 0)));

    /** Cheapest pick for a rating multiset that also meets the rare minimum. */
    const pick = (counts) => {
      const chosen = [];
      const spare = [];
      for (const [r, cnt] of counts) {
        const list = byRating.get(r);
        chosen.push(...list.slice(0, cnt));
        spare.push(...list.slice(cnt));
      }
      let rares = chosen.filter((p) => p.rare).length;
      if (rares < k.rareMin) {
        // Swap commons for rares of the same rating, cheapest extra cost first.
        const swaps = [];
        for (const c of chosen.filter((p) => !p.rare)) {
          const alt = spare.filter((s) => s.rare && s.rating === c.rating).sort((a, b) => a.cost - b.cost)[0];
          if (alt) swaps.push({ c, alt, extra: alt.cost - c.cost });
        }
        swaps.sort((a, b) => a.extra - b.extra);
        const used = new Set();
        for (const s of swaps) {
          if (rares >= k.rareMin) break;
          if (used.has(s.alt.id)) continue;
          used.add(s.alt.id);
          chosen[chosen.indexOf(s.c)] = s.alt;
          rares++;
        }
        if (rares < k.rareMin) return null;
      }
      return chosen;
    };

    const finish = (players) => {
      if (!players) return null;
      const rating = squadRating(players.map((p) => p.rating), Math.max(11, n));
      if (rating > (k.teamRatingMax ?? 99)) return null;
      return { players, rating, cost: players.reduce((a, p) => a + p.cost, 0) };
    };

    if (!k.teamRating) {
      const byCost = (x, y) => x.cost - y.cost;
      const rares = eligible.filter((p) => p.rare).sort(byCost);
      if (rares.length < k.rareMin) return null;
      const chosen = rares.slice(0, k.rareMin);
      const ids = new Set(chosen.map((p) => p.id));
      for (const p of eligible.slice().sort(byCost)) {
        if (chosen.length >= n) break;
        if (!ids.has(p.id)) chosen.push(p);
      }
      if (chosen.length !== n) return null;
      const ok = finish(chosen);
      if (ok || (k.teamRatingMax ?? 99) >= 99) return ok;
      // Over the rating ceiling: try the lowest-rated players instead.
      const low = rares.slice().sort((x, y) => x.rating - y.rating || x.cost - y.cost).slice(0, k.rareMin);
      const lowIds = new Set(low.map((p) => p.id));
      for (const p of eligible.slice().sort((x, y) => x.rating - y.rating || x.cost - y.cost)) {
        if (low.length >= n) break;
        if (!lowIds.has(p.id)) low.push(p);
      }
      return low.length === n ? finish(low) : null;
    }
    if (n !== 11) return null; // team rating with fewer than 11 players isn't modelled

    // Branch and bound over how many players of each rating to use.
    const ratings = [...byRating.keys()].filter((r) => r >= k.teamRating - 8 && r <= k.teamRating + 6).sort((a, b) => b - a);
    const prefix = (r, cnt) => byRating.get(r).slice(0, cnt).reduce((a, p) => a + p.cost, 0);
    let best = null;
    let bestCost = Infinity;
    const counts = new Map();
    const chosenRatings = [];
    let visits = 0;
    const dfs = (i, left, costSoFar) => {
      if (++visits > 400000) return;
      if (costSoFar >= bestCost) return;
      if (left === 0) {
        const rt = squadRating(chosenRatings);
        if (rt < k.teamRating || rt > (k.teamRatingMax ?? 99)) return;
        const players = pick(counts);
        if (!players) return;
        const cost = players.reduce((a, p) => a + p.cost, 0);
        if (cost < bestCost) { bestCost = cost; best = players; }
        return;
      }
      if (i >= ratings.length) return;
      // Even filling every remaining slot with this rating can't reach the target: stop.
      const optimistic = chosenRatings.concat(Array(left).fill(ratings[i]));
      if (squadRating(optimistic) < k.teamRating) return;
      const r = ratings[i];
      const max = Math.min(left, byRating.get(r).length);
      for (let cnt = max; cnt >= 0; cnt--) {
        if (cnt) { counts.set(r, cnt); for (let j = 0; j < cnt; j++) chosenRatings.push(r); } else counts.delete(r);
        dfs(i + 1, left - cnt, costSoFar + prefix(r, cnt));
        for (let j = 0; j < cnt; j++) chosenRatings.pop();
      }
      counts.delete(r);
    };
    dfs(0, n, 0);
    return finish(best);
  }

  // ---- Pack items --------------------------------------------------------------------

  /**
   * Where a new item should go.
   *   club      — new to your club
   *   storage   — untradeable duplicate player (SBC storage)
   *   transfer  — tradeable duplicate (to sell)
   *   quicksell — duplicate worth less than your quick-sell threshold
   *   keep      — leave it in unassigned (pile full, or nothing safe to do)
   */
  function sortItem(item, opts = {}) {
    const { storageFull = false, transferFull = false, quickSellBelow = 0 } = opts;
    if (!item.duplicate) return 'club';
    if (item.player && quickSellBelow > 0 && item.rating < quickSellBelow && !item.special) return 'quicksell';
    if (item.player && item.untradeable) return storageFull ? 'keep' : 'storage';
    if (!item.untradeable) return transferFull ? 'keep' : 'transfer';
    return 'keep';
  }

  // ---- Config defaults ---------------------------------------------------------------

  const DEFAULT_CONFIG = {
    // targets
    players: [], // [{ id, name, rating, avg, lowest, maxBuy, manualMax, checkedAt }]
    mode: 'buy', // buy | trade (buy under value and relist for profit) | alert (notify only)
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
    repriceMinutes: 15, // refresh a player's market price this often while running
    bidSnipe: false, // also bid on auctions about to end under your max
    bidWindow: 30, // seconds left on an auction before bidding
    maxActiveBids: 5,
    // trading (resell)
    undercut: 3, // list this % under the market average so it sells
    minProfitPct: 3, // and make at least this % of the sell price (as well as Min profit)
    hotLeagues: '13,53,19,31,16', // leagues to scan for hot cards (Premier League, LaLiga, Bundesliga, Serie A, Ligue 1)
    hotPick: 3, // how many hot cards to trade
    hotRareOnly: true,
    hotAuto: false, // pick hot cards automatically when trading starts
    tradeBudget: 0, // max coins per card for trading (0 = your coins minus Keep coins)
    upkeepMinutes: 5, // check the transfer list this often while trading
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
    // packs
    packSort: true, // sort items after each pack
    quickSellBelow: 0, // quick-sell duplicate players rated below this (0 = never)
    // SBC
    sbcUseTradeables: false, // let the solver use tradeable players
    sbcUseSpecials: false, // let the solver use special cards (TOTW, promos…)
    sbcMaxRating: 86, // never use players rated above this
    sbcProtectSquad: true, // never use players from your active squad
    sbcRepeat: 1, // times to repeat a repeatable SBC
    // upgrades
    upgradeBudget: 0, // 0 = your coins minus Keep coins
    upgradeMarket: true, // also search the market (uses searches)
  };

  const core = {
    EA_TAX, MIN_PRICE, MAX_PRICE, DEFAULT_CONFIG,
    priceStep, roundPrice, nextPrice, prevPrice, afterTax, profit, breakEvenSell,
    cacheBustBid, jitter, pickTargets, planSellPrice, classifyStatus,
    normalizeName, parsePlayerDb, searchPlayers, playerForIteration, migrateConfig,
    findMarketPrice, planMaxBuy, effectiveMaxBuy, flipPlan, tradeOpts, bidAmount, settleSales,
    aggregateListings, hotScore, rankHot,
    addHistory, summarizeHistory, isDiscordWebhook, discordPayload,
    squadRating, squadChemistry, topValues, rankUpgrades,
    POS_NAMES, normPos, FORMATIONS, squadRatingExact, lineupScore, bestLineup,
    fodderValue, playerCost, qualityOf, parseRequirements, solveSbc, sortItem,
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
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.4.0';
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

  // EA's SBC requirement types (read live from the Web App when it exposes them).
  const SBC_KEYS = {
    0: 'TEAM_STAR_RATING', 2: 'PLAYER_COUNT', 3: 'PLAYER_QUALITY', 4: 'SAME_NATION_COUNT', 5: 'SAME_LEAGUE_COUNT',
    6: 'SAME_CLUB_COUNT', 7: 'NATION_COUNT', 8: 'LEAGUE_COUNT', 9: 'CLUB_COUNT', 10: 'NATION_ID', 11: 'LEAGUE_ID',
    12: 'CLUB_ID', 13: 'SCOPE', 15: 'LEGEND_COUNT', 16: 'NUM_TROPHY_REQUIRED', 17: 'PLAYER_LEVEL', 18: 'PLAYER_RARITY',
    19: 'TEAM_RATING', 21: 'PLAYER_COUNT_COMBINED', 25: 'PLAYER_RARITY_GROUP', 26: 'PLAYER_MIN_OVR', 27: 'PLAYER_EXACT_OVR',
    28: 'PLAYER_MAX_OVR', 30: 'FIRST_OWNER_PLAYERS_COUNT', 33: 'PLAYER_TRADABILITY', 35: 'CHEMISTRY_POINTS', 36: 'ALL_PLAYERS_CHEMISTRY_POINTS',
  };
  /** { NAME: number } enum → { number: NAME }, or the fallback. */
  function invert(enumObj, fallback) {
    if (enumObj && typeof enumObj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(enumObj)) if (typeof v === 'number') out[v] = k;
      if (Object.keys(out).length) return out;
    }
    return fallback;
  }

  // ---- Web App adapter --------------------------------------------------------
  // Wraps the app's own services (the calls its UI makes) in promises.

  /** Resolve an EA observable; gives up after `ms` so a stuck call can't hang the bot. */
  function observe(observable, ms = 20000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ success: false, status: 'timeout' }), ms);
      observable.observe(w, (sender, response) => {
        clearTimeout(timer);
        if (typeof sender?.unobserve === 'function') sender.unobserve(w);
        const r = response || { success: false };
        // EA puts results in `response` for some calls (club, packs…) and in
        // `data` for others (market): read whichever is there, like the Web App does.
        resolve({
          ...r,
          data: r.success ? (r.response ?? r.data) : r.data,
          status: r.status ?? (r.error && r.error.code),
        });
      });
    });
  }

  const fut = {
    ready: () => !!(w.services && w.services.Item && w.services.User && w.UTSearchCriteriaDTO),
    coins() {
      try { return w.services.User.getUser().coins.amount; } catch { return 0; }
    },
    criteria(cfg, player, maxBuy, iteration, maxBid) {
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
      if (maxBid) c.maxBid = roundPrice(maxBid);
      // Changing a filter that doesn't matter makes EA send fresh results.
      if (iteration !== undefined) {
        if (maxBid) c.minBuy = roundPrice(cacheBustBid(iteration, 0) + 1000);
        else c.minBid = cacheBustBid(iteration, maxBuy);
      }
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
        currentBid: a.currentBid || 0,
        startingBid: a.startingBid || 0,
        bidState: a._bidState || a.bidState,
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
    // -- items, club, squad, packs, SBC --

    pileFull(pile) {
      try { return !!(w.repositories && w.repositories.Item.isPileFull(pile)); } catch { return false; }
    },
    /** Normalise a Web App item into the plain shape the pure logic uses. */
    toPlayer(item) {
      const sd = item._staticData || (typeof item.getStaticData === 'function' && item.getStaticData()) || {};
      const positions = [...new Set([item.preferredPosition, ...(item.possiblePositions || [])]
        .filter((p) => p !== undefined && p !== null).map(normPos))];
      const auction = item._auction || {};
      return {
        id: item.definitionId,
        defId: item.definitionId,
        name: sd.name || item.name || `#${item.definitionId}`,
        rating: item.rating || 0,
        nationId: item.nationId,
        leagueId: item.leagueId,
        teamId: item.teamId,
        positions,
        rare: (item.rareflag || 0) >= 1,
        special: (item.rareflag || 0) > 1,
        untradeable: !!item.untradeable,
        duplicate: typeof item.isDuplicate === 'function' ? !!item.isDuplicate() : false,
        storage: !!w.ItemPile && item.pile === w.ItemPile.STORAGE,
        loan: typeof item.isLimitedUse === 'function' ? !!item.isLimitedUse() : false,
        evo: !!item.academy,
        player: typeof item.isPlayer === 'function' ? !!item.isPlayer() : item.type === 'player',
        price: auction.buyNowPrice || 0,
        item,
      };
    },
    newCriteria() {
      const c = new w.UTSearchCriteriaDTO();
      c.type = (w.SearchType && w.SearchType.PLAYER) || 'player';
      if (w.SearchCategory) c.category = w.SearchCategory.ANY;
      return c;
    },
    /** Every player in your club (paged), plus SBC storage. */
    /** Search criteria the way the Web App's own club screen builds them. */
    clubCriteria() {
      try {
        if (w.UTBucketedItemSearchViewModel) {
          const c = new w.UTBucketedItemSearchViewModel().searchCriteria;
          if (c) return c;
        }
      } catch { /* fall back */ }
      return this.newCriteria();
    },
    async clubPlayers(onPage, { storage = true } = {}) {
      const out = [];
      try { w.services.Club.clubDao.resetStatsCache(); w.services.Club.getStats(); } catch { /* optional */ }
      const page = async (fn, criteria) => {
        const c = criteria;
        c.count = 90;
        c.offset = 0;
        for (let i = 0; i < 40; i++) {
          const res = await observe(fn(c));
          if (!res.success) return { ok: false, status: res.status ?? (res.error && (res.error.code || res.error.message)) };
          const d = res.data || {};
          if (i === 0) debugLog.push(`club page: keys ${Object.keys(d).join(',')} · items ${(d.items || []).length} · retrievedAll ${d.retrievedAll} · endOfList ${d.endOfList}`);
          out.push(...(d.items || []));
          if (onPage) onPage(out.length);
          if (d.retrievedAll || d.endOfList || !(d.items || []).length) return { ok: true };
          c.offset += c.count;
          await sleep(jitter(500, 900));
        }
        return { ok: true };
      };
      const club = await page((c) => w.services.Club.search(c), this.clubCriteria());
      if (!club.ok) return { ...club, what: 'club search' };
      if (storage && typeof w.services.Item.searchStorageItems === 'function') {
        const st = await page((c) => w.services.Item.searchStorageItems(c), this.newCriteria());
        if (!st.ok) ui.log(`SBC storage couldn't be read (${st.status}) — using club only`, 'warn');
      }
      return { ok: true, items: out };
    },
    async unassigned() {
      const res = await observe(w.services.Item.requestUnassignedItems());
      return res.success ? ((res.data && res.data.items) || []) : null;
    },
    async move(items, pile) {
      if (!items.length) return true;
      return !!(await observe(w.services.Item.move(items, pile))).success;
    },
    async quickSell(items) {
      if (!items.length) return true;
      return !!(await observe(w.services.Item.discard(items))).success;
    },
    unassignedCount() {
      try { return w.repositories.Item.numItemsInCache(w.ItemPile.PURCHASED) || 0; } catch { return 0; }
    },
    async myPacks() {
      const type = (w.PurchasePackType && w.PurchasePackType.ALL) ?? 0;
      const res = await observe(w.services.Store.getPacks(type, true, true));
      if (!res.success) return { ok: false, status: res.status, packs: [] };
      const packs = ((res.data && res.data.packs) || []).filter((p) => p.isMyPack);
      return { ok: true, packs };
    },
    packName(pack) {
      try { return w.services.Localization.localize(pack.packName); } catch { return pack.packName || `Pack ${pack.id}`; }
    },
    async openPack(pack) {
      const res = await observe(pack.open(), 30000);
      try { w.repositories.Item.setDirty(w.ItemPile.PURCHASED); } catch { /* ignore */ }
      return { ok: !!res.success, status: res.status };
    },
    async activeSquad() {
      const res = await observe(w.services.Squad.requestSquadById(w.services.Squad.getActiveSquadId()));
      return res.success ? res.data && res.data.squad : null;
    },
    async sbcSets() {
      const res = await observe(w.services.SBC.requestSets());
      if (!res.success) return { ok: false, status: res.status, sets: [] };
      const d = res.data || {};
      return { ok: true, sets: d.sets || (Array.isArray(d) ? d : []) };
    },
    async challenges(set) {
      const res = await observe(w.services.SBC.requestChallengesForSet(set));
      if (!res.success) return { ok: false, status: res.status, list: [] };
      const list = (res.data && res.data.challenges) || (typeof set.getChallenges === 'function' ? set.getChallenges() : []);
      return { ok: true, list };
    },
    async loadChallenge(ch) {
      const res = await observe(w.services.SBC.loadChallenge(ch));
      return { ok: !!res.success, status: res.status };
    },
    /** EA requirement objects → [{ key, scope, values, count }] with readable names. */
    requirements(ch) {
      const keyNames = invert(w.SBCEligibilityKey, SBC_KEYS);
      const scopeNames = invert(w.SBCEligibilityScope, { 0: 'GREATER', 1: 'LOWER', 2: 'EXACT' });
      const out = [];
      for (const r of ch.eligibilityRequirements || []) {
        const kv = (r.kvPairs && (r.kvPairs._collection || r.kvPairs)) || {};
        for (const [k, values] of Object.entries(kv)) {
          out.push({ key: keyNames[k] || `KEY_${k}`, scope: scopeNames[r.scope] || String(r.scope), values: [].concat(values), count: r.count });
        }
      }
      return out;
    },
    requiredPlayers(ch) {
      try { return ch.squad.getNumOfRequiredPlayers() || 11; } catch { return 11; }
    },
    /** Put players into the challenge squad's open slots and save it. */
    async fillChallenge(ch, items) {
      const squad = ch.squad;
      const slots = squad.getFieldPlayers();
      const open = slots.filter((s) => !(typeof s.isBrick === 'function' && s.isBrick())).map((s) => s.index);
      const arr = new Array(Math.max(11, ...slots.map((s) => s.index + 1))).fill(null);
      open.slice(0, items.length).forEach((idx, i) => { arr[idx] = items[i]; });
      squad.removeAllItems();
      squad.setPlayers(arr, true);
      const res = await observe(w.services.SBC.saveChallenge(ch));
      return { ok: !!res.success, status: res.status };
    },
    async createSquad(name, formation, items) {
      const res = await observe(w.services.Squad.create(name, formation, items));
      return { ok: !!res.success, status: res.status };
    },
    async submitChallenge(ch, set) {
      const chem = !!(w.services.Chemistry && typeof w.services.Chemistry.isFeatureEnabled === 'function' && w.services.Chemistry.isFeatureEnabled());
      const res = await observe(w.services.SBC.submitChallenge(ch, set, true, chem), 30000);
      return { ok: !!res.success, status: res.status, data: res.data };
    },

    // -- transfer list & watchlist --

    /** Where an item stands on the market: sold | expired | active | won | lost | none. */
    auctionState(item) {
      const a = (typeof item.getAuctionData === 'function' && item.getAuctionData()) || item._auction || {};
      const call = (fn) => (typeof a[fn] === 'function' ? !!a[fn]() : undefined);
      const trade = a._tradeState || a.tradeState;
      const bid = a._bidState || a.bidState;
      const sold = call('isSold') ?? (trade === 'closed' && a.currentBid > 0 && bid !== 'highest');
      const won = call('isWon') ?? (trade === 'closed' && bid === 'highest');
      const expired = call('isExpired') ?? trade === 'expired';
      const selling = call('isSelling') ?? trade === 'active';
      const state = won ? 'won' : sold ? 'sold' : expired ? 'expired' : selling ? 'active' : trade === 'closed' ? 'lost' : 'none';
      return { state, price: a.currentBid || a.buyNowPrice || 0, tradeId: a.tradeId };
    },
    async transferList() {
      const res = await observe(w.services.Item.requestTransferItems());
      return res.success ? ((res.data && res.data.items) || []) : null;
    },
    transferSpace() {
      try {
        const R = w.repositories.Item;
        const size = typeof R.getPileSize === 'function' ? R.getPileSize(w.ItemPile.TRANSFER) : 100;
        return Math.max(0, size - (R.numItemsInCache(w.ItemPile.TRANSFER) || 0));
      } catch { return 100; }
    },
    async clearSold() {
      const S = w.services.Item;
      if (typeof S.clearSoldItems === 'function') return !!(await observe(S.clearSoldItems())).success;
      try {
        if (w.UTTransferListViewController && w.UTTransferListViewController.prototype._clearSold) {
          w.UTTransferListViewController.prototype._clearSold();
          return true;
        }
      } catch { /* not available */ }
      return false;
    },
    async relistExpired() {
      const S = w.services.Item;
      if (typeof S.relistExpiredAuctions !== 'function') return false;
      return !!(await observe(S.relistExpiredAuctions())).success;
    },
    async watched() {
      const res = await observe(w.services.Item.requestWatchedItems());
      return res.success ? ((res.data && res.data.items) || []) : null;
    },
    async untarget(items) {
      if (!items.length || typeof w.services.Item.untarget !== 'function') return false;
      return !!(await observe(w.services.Item.untarget(items))).success;
    },
    async placeBid(listing, amount) {
      const res = await observe(w.services.Item.bid(listing.item, amount));
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
        const flip = this.cfg.mode === 'trade' && flipPlan(r.avg, tradeOpts(r.avg, this.cfg));
        if (this.cfg.mode === 'trade') {
          ui.log(`${player.name}: avg ${fmt(r.avg)} · ${flip ? `trade: buy ≤ ${fmt(flip.maxBuy)}, sell ${fmt(flip.sell)} (+${fmt(flip.profit)})` : 'no profitable trade at your min profit'}`, flip ? 'ok' : 'warn');
        } else {
          ui.log(`${player.name}: avg ${fmt(r.avg)} · lowest ${fmt(r.lowest)} · ${r.count} listed → max ${fmt(plan.maxBuy)}`
            + (plan.cappedByCoins ? ' (all your coins)' : ` (${this.cfg.discount}% under)`)
            + (player.manualMax ? ` — your manual ${fmt(player.manualMax)} is used instead` : ''), 'ok');
        }
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

    toggle() {
      if (jobs.current) return jobs.cancel();
      if (this.running) this.stop('stopped by you'); else this.start();
    },

    async start() {
      if (this.running || this.busy || jobs.current) return;
      ui.commit(); // pick up a field that was typed but not yet saved
      if (!fut.ready()) { ui.log('Web App not ready — log in and open Transfers first', 'err'); return; }
      const { cfg, changed } = clampConfig(this.cfg);
      if (changed.length) ui.log(`Raised to safe minimums: ${changed.join(', ')}`, 'warn');
      this.cfg = cfg; this.save(); ui.syncForm();
      const hasFilter = cfg.level !== 'any' || cfg.rarity || cfg.position || cfg.nation || cfg.league || cfg.club || cfg.minRating > 0;
      if (!cfg.players.length && !hasFilter) {
        ui.log('Add a player (or set a filter) first — otherwise it would buy any card under your max', 'warn');
        ui.toast('Add a player first — ▶ starts the sniper', 'alert');
        return;
      }
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
          ? cfg.players.map((p) => {
            const { maxBuy, plan } = this.planFor(p);
            return plan ? `${p.name} (buy ≤ ${fmt(maxBuy)} → sell ${fmt(plan.sell)})` : `${p.name} ≤ ${fmt(maxBuy)}`;
          }).join(', ')
          : `filters ≤ ${fmt(cfg.maxBuy)}`;
        ui.log(`${{ alert: 'Watching', trade: 'Trading' }[cfg.mode] || 'Sniping'} ${who}${cfg.bidSnipe && cfg.mode !== 'alert' ? ' · bidding on auctions ending soon' : ''}`, 'ok');
        await this.loop();
      } catch (e) {
        this.stop(`error: ${errText(e)}`);
      }
    },

    /** Max buy (and resale plan in Trade mode) for a player this search. */
    planFor(player) {
      const cfg = this.cfg;
      if (cfg.mode !== 'trade') return { maxBuy: effectiveMaxBuy(player, cfg), plan: null };
      const plan = player && flipPlan(player.avg, tradeOpts(player.avg, cfg));
      if (!plan) return { maxBuy: 0, plan: null };
      return { maxBuy: Math.min(plan.maxBuy, player.manualMax || Infinity), plan };
    },

    async loop() {
      const cfg = this.cfg;
      const startSearches = this.stats.searches;
      const startBuys = this.stats.buys;
      const alerted = new Set();
      const skipped = new Set();
      let errors = 0;
      let i = 0;
      let fullWarned = false;
      this.nextUpkeep = cfg.mode === 'trade' ? Date.now() : Date.now() + cfg.upkeepMinutes * 60e3;

      while (this.running) {
        let limit = '';
        if (this.stats.searches - startSearches >= cfg.maxSearches) limit = 'session search limit reached';
        else if (this.stats.buys - startBuys >= cfg.maxBuys) limit = 'session buy limit reached';
        else if (Date.now() >= this.session.endsAt) limit = `${cfg.sessionMinutes} min session limit — take a break`;
        if (limit) { await this.finishBids(); return this.stop(limit); }
        const gate = this.gate();
        if (!gate.ok) return this.stop(gate.reason);
        const spendable = fut.coins() - cfg.minCoins;
        if (cfg.mode !== 'alert' && spendable < MIN_PRICE) return this.stop('not enough coins');

        // Transfer list upkeep (Trade mode, or when bids are waiting to be collected).
        if ((cfg.mode === 'trade' || this.bids.size) && Date.now() >= this.nextUpkeep) {
          await this.upkeep();
          this.nextUpkeep = Date.now() + cfg.upkeepMinutes * 60e3;
          if (!this.running) return;
        }

        const player = playerForIteration(cfg.players, i);
        // Prices drift — refresh a player's average during long sessions.
        if (player && cfg.autoPrice && !player.manualMax && Date.now() - (player.checkedAt || 0) > cfg.repriceMinutes * 60e3) {
          const ok = await this.priceCheck([player]);
          this.save(); ui.renderPlayers(); ui.renderTrade();
          if (!this.running) return;
          if (!ok) return this.stop('price check stopped by EA — see log');
          await this.wait(jitter(cfg.delayMin, cfg.delayMax), 'waiting', 'Next search');
          continue;
        }

        const { maxBuy, plan } = this.planFor(player);
        if (!maxBuy) {
          if (player && !skipped.has(player.id)) {
            skipped.add(player.id);
            ui.log(`${player.name}: no profitable buy price yet (needs a price check, or Min profit is too high) — skipping`, 'warn');
          }
          i++;
          if (cfg.players.every((p) => skipped.has(p.id))) return this.stop('no player can be traded for profit — check prices / Min profit');
          continue;
        }
        const tradeFull = cfg.mode === 'trade' && fut.transferSpace() <= 0;
        if (tradeFull && !fullWarned) { fullWarned = true; ui.log('Transfer list full — waiting for sales before buying more', 'warn'); }
        if (!tradeFull) fullWarned = false;

        const bidTurn = cfg.bidSnipe && cfg.mode !== 'alert' && i % 2 === 1;
        this.setStatus('searching', `${bidTurn ? 'Auctions' : 'Searching'} ${player ? player.name : ''} ≤ ${fmt(maxBuy)}`.replace('  ', ' '));
        const res = await fut.search(bidTurn ? fut.criteria(cfg, player, 0, i, maxBuy) : fut.criteria(cfg, player, maxBuy, i));
        i++;
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
        } else if (bidTurn) {
          errors = 0;
          if (!tradeFull) await this.bidOn(res.listings, player, maxBuy, plan, spendable);
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
            } else if (!tradeFull) {
              await this.attempt(t, player, plan);
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

    // -- bidding: auctions about to end, under your max --

    /** Before stopping: wait for open bids to end (max ~1 min) and collect them. */
    async finishBids() {
      if (!this.bids.size || !this.running) return;
      const last = Math.max(...[...this.bids.values()].map((b) => b.endsAt));
      const waitMs = Math.min(70e3, Math.max(0, last - Date.now()) + 6000);
      ui.log(`Waiting for ${this.bids.size} open bid${this.bids.size === 1 ? '' : 's'} to end…`, 'muted');
      await this.wait(waitMs, 'waiting', 'Collecting bids');
      if (this.running) await this.upkeep(true);
    },

    bids: new Map(), // tradeId -> { name, amount, endsAt, player, plan }

    async bidOn(listings, player, maxBid, plan, spendable) {
      const cfg = this.cfg;
      const committed = [...this.bids.values()].reduce((a, b) => a + b.amount, 0);
      for (const l of listings.slice().sort((a, b) => (a.expires || 0) - (b.expires || 0))) {
        if (!this.running || this.bids.size >= cfg.maxActiveBids) break;
        if (this.bids.has(l.tradeId)) continue;
        const amount = bidAmount(l, maxBid, cfg.bidWindow);
        if (!amount || amount + committed > spendable) continue;
        const r = await fut.placeBid(l, amount);
        if (!r.ok) {
          const kind = classifyStatus(r.status);
          if (kind === 'captcha' || kind === 'throttled') return this.halt(kind, `blocked while bidding (${r.status})`);
          if (kind === 'coins') return;
          ui.log(`Bid on ${l.name} at ${fmt(amount)} failed (${r.status})`, 'muted');
          continue;
        }
        this.bids.set(l.tradeId, { name: l.name, amount, endsAt: Date.now() + (l.expires || 30) * 1000, player, plan });
        this.nextUpkeep = Math.min(this.nextUpkeep, Date.now() + ((l.expires || 30) + 8) * 1000);
        ui.log(`🔨 Bid ${fmt(amount)} on ${l.name} (${l.rating || '?'}) — ends in ${Math.round(l.expires)}s`, 'ok');
        await sleep(jitter(700, 1400));
      }
    },

    /** Buy history entry + optional relist after a Buy Now or a won auction. */
    async bought(item, info, player, plan, via) {
      const cfg = this.cfg;
      this.stats.buys++;
      this.stats.spent += info.price;
      this.countUsage('buys');
      ui.log(`✅ ${via === 'bid' ? 'Won' : 'Bought'} ${info.name} (${info.rating || '?'}) for ${fmt(info.price)}`, 'ok');
      ui.toast(`${via === 'bid' ? 'Won' : 'Bought'} ${info.name} for ${fmt(info.price)}`, 'ok');
      sounds.buy();
      const entry = { at: Date.now(), id: info.defId, itemId: item && item.id, name: info.name, rating: info.rating, price: info.price, sell: 0, via, mode: cfg.mode };
      const sell = plan ? plan.sell : planSellPrice(info.price, cfg, player);
      if (sell && item) {
        await sleep(jitter(800, 1600));
        const l = await fut.list(item, sell, cfg.listDuration);
        if (l.ok) {
          entry.sell = sell;
          this.stats.listed++;
          this.stats.profit += profit(info.price, sell);
          ui.log(`Listed for ${fmt(sell)} (≈ ${fmt(profit(info.price, sell))} profit after tax)`, 'ok');
        } else {
          ui.log(`Couldn't list (${l.status}) — it's in your unassigned items`, 'warn');
        }
      } else if (item && via === 'bid') {
        await fut.move([item], w.ItemPile.CLUB);
      }
      this.history = addHistory(this.history, entry);
      store.set(KEYS.history, this.history);
      ui.renderStats(); ui.renderHistory(); ui.renderTrade();
      notify.discord('buy', entry);
    },

    async attempt(t, player, plan) {
      const r = await fut.buy(t);
      if (!r.ok) {
        this.stats.missed++;
        const kind = classifyStatus(r.status);
        if (kind === 'captcha' || kind === 'throttled') return this.halt(kind, `blocked while buying (${r.status})`);
        if (kind === 'coins') return this.stop('not enough coins');
        ui.log(`Missed ${t.name} at ${fmt(t.buyNowPrice)} (${r.status})`, 'muted');
        return;
      }
      await this.bought(t.item, { name: t.name, rating: t.rating, defId: t.defId, price: t.buyNowPrice }, player, plan, 'buy');
    },

    // -- transfer list upkeep: record sales, clear sold, relist expired, collect won bids --

    async upkeep(manual) {
      this.setStatus('pricing', 'Checking transfer list…');
      const out = { sold: 0, realized: 0, relisted: 0, won: 0, lost: 0, active: 0 };
      const items = await fut.transferList();
      if (!items) { ui.log('Couldn’t read your transfer list', 'warn'); return out; }
      const sold = [];
      let expired = 0;
      for (const it of items) {
        const st = fut.auctionState(it);
        if (st.state === 'sold') sold.push({ itemId: it.id, price: st.price });
        else if (st.state === 'expired') expired++;
        else if (st.state === 'active') out.active++;
      }
      if (sold.length) {
        const r = settleSales(this.history, sold, Date.now());
        this.history = r.history;
        store.set(KEYS.history, this.history);
        out.sold = sold.length;
        out.realized = r.realized;
        const cleared = await fut.clearSold();
        ui.log(`💰 ${sold.length} sold${r.matched ? ` · profit ${fmt(r.realized)} after tax` : ''}${cleared ? ' · cleared' : ''}`, 'ok');
        if (r.matched) notify.discord('info', { title: `💰 Sold ${sold.length}`, text: `Profit ${fmt(r.realized)} after tax` });
        await sleep(jitter(800, 1500));
      }
      if (expired && (this.cfg.mode === 'trade' || this.cfg.autoRelist)) {
        if (await fut.relistExpired()) { out.relisted = expired; ui.log(`Relisted ${expired} expired item${expired === 1 ? '' : 's'}`, 'muted'); }
        await sleep(jitter(800, 1500));
      }
      // Auctions we bid on.
      const due = [...this.bids.entries()].filter(([, b]) => Date.now() >= b.endsAt);
      if (due.length || manual) {
        const watched = await fut.watched();
        if (watched) {
          const lost = [];
          for (const it of watched) {
            const st = fut.auctionState(it);
            const bid = this.bids.get(st.tradeId);
            if (st.state === 'won') {
              const p = fut.toPlayer(it);
              this.bids.delete(st.tradeId);
              out.won++;
              await this.bought(it, { name: p.name, rating: p.rating, defId: p.id, price: st.price || (bid && bid.amount) || 0 }, bid && bid.player, bid && bid.plan, 'bid');
            } else if (st.state === 'lost' || st.state === 'expired') {
              lost.push(it);
              this.bids.delete(st.tradeId);
            }
          }
          if (lost.length) { await fut.untarget(lost); out.lost = lost.length; ui.log(`Outbid on ${lost.length} auction${lost.length === 1 ? '' : 's'} — cleared`, 'muted'); }
        }
        // Forget bids long past their end that never showed up.
        for (const [id, b] of this.bids) if (Date.now() - b.endsAt > 10 * 60e3) this.bids.delete(id);
      }
      this.listedNow = out.active;
      ui.renderTrade(); ui.renderHistory();
      if (this.running) this.setStatus('waiting', 'Next search');
      return out;
    },

    async upkeepNow() {
      if (this.running) { this.nextUpkeep = 0; ui.log('Transfer list check queued', 'muted'); return; }
      await jobs.run('Checking transfer list', async () => {
        const r = await this.upkeep(true);
        ui.log(`Transfer list: ${r.active} listed · ${r.sold} sold · ${r.relisted} relisted${r.won || r.lost ? ` · ${r.won} won · ${r.lost} lost` : ''}`, 'ok');
      });
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

  // ---- Tasks (packs, SBCs, upgrades) -----------------------------------------------
  // One task at a time, never while sniping. Every EA call is paced and checked:
  // a captcha or market limit stops the task and sets the same safety lock.

  class Stopped extends Error {}
  const debugLog = []; // technical details for "Copy log"


  const jobs = {
    current: null,
    cancelled: false,

    async run(name, fn) {
      if (engine.running || engine.busy || this.current) { ui.log('Busy — wait for the current task to finish', 'warn'); return; }
      if (!fut.ready()) { ui.log('Web App not ready — log in first', 'err'); return; }
      engine.safety = store.get(KEYS.safety, {});
      const gate = engine.gate();
      if (!gate.ok && engine.safety.lockUntil > Date.now()) { ui.log(`Can't start — ${gate.reason}`, 'err'); return; }
      this.current = name;
      this.cancelled = false;
      ui.setJob(name);
      try {
        await fn();
      } catch (e) {
        if (!(e instanceof Stopped)) {
          ui.log(`${name} stopped: ${errText(e)}`, 'err');
          if (e && e.stack) debugLog.push(`${new Date().toISOString()} ${name}: ${e.stack.split('\n').slice(0, 3).join(' | ')}`);
        }
      } finally {
        this.current = null;
        ui.setJob(null);
        engine.setStatus('idle', 'Idle');
      }
    },

    cancel() {
      if (!this.current) return;
      this.cancelled = true;
      ui.log(`Stopping ${this.current}…`, 'warn');
    },

    /** Pause between actions; throws if the task was cancelled. */
    async pause(min = 1500, max = 3000) {
      const until = Date.now() + jitter(min, max);
      while (Date.now() < until) {
        if (this.cancelled) throw new Stopped();
        await sleep(200);
      }
      if (this.cancelled) throw new Stopped();
    },

    /** Stop the task (and lock) when EA pushes back. */
    check(res, what) {
      if (res && res.ok) return;
      const status = res ? res.status : 'error';
      const kind = classifyStatus(status);
      if (kind === 'captcha' || kind === 'throttled') {
        engine.lock(kind, `EA pushback during ${what} (${status})`);
        sounds.alarm();
        throw new Stopped();
      }
      if (kind === 'session') { ui.log(`Logged out (${status}) — log in again`, 'err'); throw new Stopped(); }
      throw new Error(`${what} failed (EA status ${status ?? 'unknown'})`);
    },
  };

  // ---- Pack opener ------------------------------------------------------------------

  const packs = {
    list: [],

    async refresh() {
      await jobs.run('Loading packs', async () => {
        engine.setStatus('pricing', 'Loading your packs…');
        const r = await fut.myPacks();
        jobs.check(r, 'loading packs');
        this.list = r.packs;
        ui.renderPacks();
        ui.log(r.packs.length ? `You have ${r.packs.length} unopened pack${r.packs.length === 1 ? '' : 's'}` : 'No unopened packs', 'muted');
      });
    },

    groups() {
      const m = new Map();
      for (const p of this.list) {
        const name = fut.packName(p);
        if (!m.has(name)) m.set(name, []);
        m.get(name).push(p);
      }
      return [...m.entries()].map(([name, list]) => ({ name, list }));
    },

    /** Sort what's in unassigned. Returns false if something had to stay there. */
    async sortUnassigned(summary) {
      const items = await fut.unassigned();
      if (!items) throw new Error('could not read unassigned items');
      if (!items.length) return true;
      const cfg = engine.cfg;
      const groups = { club: [], storage: [], transfer: [], quicksell: [], keep: [] };
      for (const item of items) {
        const p = fut.toPlayer(item);
        const dest = cfg.packSort ? sortItem(p, {
          storageFull: fut.pileFull(w.ItemPile.STORAGE),
          transferFull: fut.pileFull(w.ItemPile.TRANSFER),
          quickSellBelow: cfg.quickSellBelow,
        }) : 'keep';
        groups[dest].push(item);
        if (p.player) summary.players.push(p);
      }
      const piles = { club: w.ItemPile.CLUB, storage: w.ItemPile.STORAGE, transfer: w.ItemPile.TRANSFER };
      for (const dest of ['club', 'storage', 'transfer']) {
        if (!groups[dest].length) continue;
        const ok = await fut.move(groups[dest], piles[dest]);
        if (ok) summary[dest] += groups[dest].length; else summary.keep += groups[dest].length;
        await jobs.pause(900, 1600);
      }
      if (groups.quicksell.length) {
        const ok = await fut.quickSell(groups.quicksell);
        if (ok) summary.quicksell += groups.quicksell.length; else summary.keep += groups.quicksell.length;
        await jobs.pause(900, 1600);
      }
      summary.keep += groups.keep.length;
      return fut.unassignedCount() === 0 && !groups.keep.length;
    },

    async open(packList) {
      await jobs.run('Opening packs', async () => {
        const summary = { opened: 0, players: [], club: 0, storage: 0, transfer: 0, quicksell: 0, keep: 0 };
        try {
          if (fut.unassignedCount() > 0) {
            ui.log('Sorting your unassigned items first…', 'muted');
            if (!(await this.sortUnassigned(summary))) {
              ui.log('Unassigned still has items — EA won’t open packs until it’s empty. Sort them in the Web App.', 'warn');
              return;
            }
          }
          for (const pack of packList) {
            const name = fut.packName(pack);
            engine.setStatus('pricing', `Opening ${name} (${summary.opened + 1}/${packList.length})`);
            const r = await fut.openPack(pack);
            jobs.check(r, 'opening a pack');
            summary.opened++;
            this.list = this.list.filter((p) => p !== pack);
            ui.renderPacks();
            await jobs.pause(1500, 2500);
            const clean = await this.sortUnassigned(summary);
            const best = summary.players.slice(-12).sort((a, b) => b.rating - a.rating)[0];
            ui.log(`Opened ${name}${best ? ` — best: ${best.name} ${best.rating}` : ''}`, 'ok');
            if (best && (best.rating >= 86 || best.special)) { ui.toast(`🎉 ${best.name} ${best.rating}`, 'ok'); sounds.buy(); }
            if (!clean) { ui.log('Some items stayed in unassigned (pile full?) — stopping so EA allows the next pack', 'warn'); break; }
            await jobs.pause(2000, 3500);
          }
        } finally {
          if (summary.opened || summary.club || summary.storage || summary.transfer || summary.quicksell) this.report(summary);
        }
      });
    },

    report(s) {
      const top = s.players.slice().sort((a, b) => b.rating - a.rating).slice(0, 5)
        .map((p) => `${p.name} ${p.rating}${p.special ? '★' : ''}`).join(', ');
      ui.log(`Packs: ${s.opened} opened · ${s.club} to club · ${s.storage} to SBC storage · ${s.transfer} to transfer list · ${s.quicksell} quick-sold · ${s.keep} left in unassigned`, 'ok');
      if (top) ui.log(`Best pulls: ${top}`, 'ok');
      notify.discord('info', { title: `📦 Opened ${s.opened} pack${s.opened === 1 ? '' : 's'}`, text: top ? `Best: ${top}` : '' });
    },
  };

  // ---- SBC solver ---------------------------------------------------------------------

  const sbc = {
    sets: [],
    open: new Map(), // setId -> [{ challenge, reqs, parsed }]
    club: null, // cached club pool for this session
    plan: null, // { set, challenge, solution }

    async loadSets() {
      await jobs.run('Loading SBCs', async () => {
        engine.setStatus('pricing', 'Loading SBCs…');
        const r = await fut.sbcSets();
        jobs.check(r, 'loading SBCs');
        this.sets = r.sets.filter((s) => !(typeof s.isComplete === 'function' && s.isComplete()));
        ui.renderSbc();
        ui.log(`${this.sets.length} SBCs available`, 'muted');
      });
    },

    async loadChallenges(set) {
      await jobs.run('Loading SBC', async () => {
        engine.setStatus('pricing', `Loading ${set.name}…`);
        const r = await fut.challenges(set);
        jobs.check(r, 'loading challenges');
        const list = r.list.filter((ch) => !(typeof ch.isCompleted === 'function' && ch.isCompleted()) && ch.status !== 'COMPLETED');
        this.open.set(set.id, list.map((challenge) => {
          const reqs = fut.requirements(challenge);
          return { challenge, reqs, parsed: parseRequirements(reqs, fut.requiredPlayers(challenge)) };
        }));
        ui.renderSbc();
      });
    },

    raw: null, // club + storage players, read once per session
    guard: null, // { itemIds, defIds } of your whole active squad

    /**
     * Club + storage players the solver may use. Never: anyone in your active
     * squad (starters, subs and reserves), loans, evolution players, players
     * above your max rating, specials (unless allowed) or tradeables (unless allowed).
     */
    async pool(force) {
      if (!this.raw || force) {
        engine.setStatus('pricing', 'Reading your club…');
        const r = await fut.clubPlayers((n) => engine.setStatus('pricing', `Reading your club… ${n}`));
        jobs.check(r, 'reading your club');
        this.raw = r.items.map((item) => ({ ...fut.toPlayer(item), itemId: item.id }));
      }
      const cfg = engine.cfg;
      this.guard = { itemIds: new Set(), defIds: new Set() };
      if (cfg.sbcProtectSquad) {
        const squad = await fut.activeSquad();
        if (!squad) throw new Error("couldn't read your active squad, so nothing was used — try again, or turn off “Never use my active squad”");
        const slots = typeof squad.getPlayers === 'function' ? squad.getPlayers() : squad.getFieldPlayers();
        for (const s of slots) {
          const it = s && (s.item || s);
          if (it && it.definitionId) { this.guard.itemIds.add(it.id); this.guard.defIds.add(it.definitionId); }
        }
      }
      const why = { notPlayer: 0, loanOrEvo: 0, squad: 0, rating: 0, special: 0, tradeable: 0 };
      const usable = [];
      for (const p of this.raw) {
        if (!p.player) { why.notPlayer++; continue; }
        if (p.loan || p.evo) { why.loanOrEvo++; continue; }
        if (this.guard.itemIds.has(p.itemId) || this.guard.defIds.has(p.defId)) { why.squad++; continue; }
        if (p.rating > cfg.sbcMaxRating) { why.rating++; continue; }
        if (p.special && !cfg.sbcUseSpecials) { why.special++; continue; }
        if (!(p.untradeable || p.storage || cfg.sbcUseTradeables)) { why.tradeable++; continue; }
        usable.push({ ...p, id: p.itemId, cost: playerCost(p) });
      }
      const skipped = [
        why.squad && `${why.squad} in your squad`, why.tradeable && `${why.tradeable} tradeable`,
        why.rating && `${why.rating} above ${cfg.sbcMaxRating}`, why.special && `${why.special} specials`,
        why.loanOrEvo && `${why.loanOrEvo} loans/evolutions`, why.notPlayer && `${why.notPlayer} not players`,
      ].filter(Boolean).join(', ');
      ui.log(`Club: read ${this.raw.length} · usable for SBCs ${usable.length}${skipped ? ` · skipped ${skipped}` : ''}`, usable.length ? 'muted' : 'warn');
      if (!this.raw.length) ui.log('EA returned no club players — open Club → Players in the Web App once, then try again', 'warn');
      else if (!usable.length && why.tradeable) ui.log('All your usable fodder is tradeable — turn on “Use tradeable players” (SBC tab) if you’re OK using it', 'warn');
      debugLog.push(`club read ${this.raw.length}; sample ${this.raw.slice(0, 3).map((p) => `${p.name} r${p.rating} u${p.untradeable} pl${p.player} pos${JSON.stringify(p.positions)}`).join(' | ')}`);
      return usable;
    },

    /** The same rules, checked again on every player right before sending. */
    allowed(p) {
      const cfg = engine.cfg;
      if (this.guard && (this.guard.itemIds.has(p.itemId ?? p.id) || this.guard.defIds.has(p.defId ?? p.item?.definitionId))) return false;
      if (p.rating > cfg.sbcMaxRating) return false;
      if (p.special && !cfg.sbcUseSpecials) return false;
      if (!(p.untradeable || p.storage || cfg.sbcUseTradeables)) return false;
      return true;
    },

    async solve(set, entry) {
      await jobs.run('Solving SBC', async () => {
        const { challenge, parsed } = entry;
        if (parsed.unsupported.length) { ui.log(`Can't auto-solve yet: ${parsed.unsupported.join(', ')}`, 'warn'); return; }
        const pool = await this.pool();
        this.club = pool;
        engine.setStatus('pricing', 'Solving…');
        await sleep(30);
        const solution = solveSbc(pool, parsed.constraints);
        if (!solution) { ui.log(`No solution from your club for ${challenge.name || set.name}`, 'warn'); this.plan = null; ui.renderSbc(); return; }
        this.plan = { set, entry, solution };
        ui.log(`Solution: ${solution.players.length} players, rating ${solution.rating || '—'} — review it, then Submit`, 'ok');
        ui.renderSbc();
      });
    },

    async submit(fillOnly) {
      const plan = this.plan;
      if (!plan) return;
      await jobs.run(fillOnly ? 'Filling SBC' : 'Submitting SBC', async () => {
        const times = fillOnly ? 1 : Math.max(1, engine.cfg.sbcRepeat || 1);
        let current = plan;
        for (let n = 1; n <= times; n++) {
          const { set, entry, solution } = current;
          engine.setStatus('pricing', `${fillOnly ? 'Filling' : 'Submitting'} ${set.name}${times > 1 ? ` (${n}/${times})` : ''}`);
          const load = await fut.loadChallenge(entry.challenge);
          jobs.check(load, 'loading the challenge');
          await jobs.pause(800, 1500);
          const bad = solution.players.filter((p) => !this.allowed(p));
          if (bad.length) {
            ui.log(`Safety check blocked this squad: ${bad.map((p) => `${p.name} ${p.rating}`).join(', ')} — nothing was sent`, 'err');
            return;
          }
          const items = solution.players.map((p) => p.item);
          const fill = await fut.fillChallenge(entry.challenge, items);
          jobs.check(fill, 'filling the squad');
          if (fillOnly) { ui.log(`Squad filled and saved — open ${set.name} in the Web App to check and submit`, 'ok'); return; }
          await jobs.pause(1500, 2500);
          const sub = await fut.submitChallenge(entry.challenge, set);
          jobs.check(sub, 'submitting');
          const used = new Set(solution.players.map((p) => p.id));
          this.raw = (this.raw || []).filter((p) => !used.has(p.itemId));
          this.club = (await this.pool()).filter((p) => !used.has(p.id));
          ui.log(`✅ Submitted ${set.name}${entry.challenge.name && entry.challenge.name !== set.name ? ` — ${entry.challenge.name}` : ''}`, 'ok');
          ui.toast(`SBC done: ${set.name}`, 'ok');
          sounds.buy();
          notify.discord('info', { title: `🧩 SBC done: ${set.name}`, text: entry.challenge.name || '' });
          this.plan = null;
          if (n === times) break;
          // Repeatable: reload the set and solve the next one with the players left.
          await jobs.pause(2500, 4000);
          const again = await fut.challenges(set);
          jobs.check(again, 'reloading the SBC');
          const next = again.list.find((ch) => !(typeof ch.isCompleted === 'function' && ch.isCompleted()));
          if (!next) { ui.log('No more repeats available', 'muted'); break; }
          const reqs = fut.requirements(next);
          const parsed = parseRequirements(reqs, fut.requiredPlayers(next));
          const sol = !parsed.unsupported.length && solveSbc(this.club, parsed.constraints);
          if (sol && sol.players.some((p) => !this.allowed(p))) { ui.log('Safety check stopped the repeat', 'err'); break; }
          if (!sol) { ui.log('Out of suitable players for another repeat', 'muted'); break; }
          current = { set, entry: { challenge: next, reqs, parsed }, solution: sol };
        }
        ui.renderSbc();
      });
    },
  };

  // ---- Upgrade advisor -------------------------------------------------------------------

  const upgrades = {
    squad: null, // [{ position, player }]
    summary: null,
    results: [], // [{ slotIndex, position, current, options: [...] }]

    async analyse() {
      await jobs.run('Analysing your team', async () => {
        engine.setStatus('pricing', 'Reading your squad…');
        const squad = await fut.activeSquad();
        if (!squad) throw new Error('could not read your active squad');
        const slots = squad.getFieldPlayers().slice(0, 11).map((s) => ({
          position: s.position ? normPos(s.position.typeName ?? s.position.id) : '?',
          player: s.item && s.item.definitionId ? fut.toPlayer(s.item) : null,
        }));
        this.squad = slots;
        const inPos = (p, pos) => !!p && p.positions.includes(pos);
        const chem = squadChemistry(slots.map((s) => s.player && { ...s.player, inPosition: inPos(s.player, s.position) }));
        const players = slots.map((s) => s.player).filter(Boolean);
        this.summary = {
          rating: squadRating(slots.map((s) => (s.player ? s.player.rating : 0))),
          chem: chem.total,
          eachChem: chem.each,
          formation: (() => {
            const f = typeof squad.getFormation === 'function' && squad.getFormation();
            const id = f ? (f.name || f.typeName || '') : '';
            return (FORMATIONS[id] && FORMATIONS[id].label) || id.replace(/^f/, '');
          })(),
          leagues: topValues(players, 'leagueId', 2),
          nations: topValues(players, 'nationId', 2),
        };
        // Weakest first: lowest rating, then lowest chemistry.
        const order = slots.map((s, i) => ({ i, r: s.player ? s.player.rating : 0, c: chem.each[i] }))
          .sort((a, b) => a.r - b.r || a.c - b.c).map((x) => x.i);
        this.results = order.slice(0, 3).map((i) => ({ slotIndex: i, position: slots[i].position, current: slots[i].player, options: [] }));
        ui.renderUpgrades();

        // Candidates you already own.
        const owned = await fut.clubPlayers((n) => engine.setStatus('pricing', `Checking your club… ${n}`));
        jobs.check(owned, 'reading your club');
        const club = owned.items.map((item) => ({ ...fut.toPlayer(item), source: 'club' })).filter((p) => p.player && !p.loan);

        const budget = engine.cfg.upgradeBudget || Math.max(0, fut.coins() - engine.cfg.minCoins);
        for (const res of this.results) {
          let candidates = club.slice();
          if (engine.cfg.upgradeMarket && budget >= 1000) {
            candidates = candidates.concat(await this.market(res, budget));
          }
          res.options = rankUpgrades(slots, res.slotIndex, candidates, { budget }).filter((o) => o.source === 'club' || o.price <= budget).slice(0, 4);
          res.done = true;
          ui.renderUpgrades();
        }
        ui.log(`Team: rating ${this.summary.rating}, chemistry ${this.summary.chem}/33 — suggestions for your ${this.results.length} weakest spots`, 'ok');
      });
    },

    /** Market listings that fit the slot: same league / nation as your squad, within budget. */
    async market(res, budget) {
      const out = [];
      const s = this.summary;
      const searches = [
        { league: s.leagues[0] && s.leagues[0].value, min: Math.round(budget * 0.25) },
        { nation: s.nations[0] && s.nations[0].value, min: Math.round(budget * 0.25) },
        { league: s.leagues[0] && s.leagues[0].value, min: Math.round(budget * 0.05) },
      ].filter((q) => q.league || q.nation);
      for (const q of searches) {
        engine.setStatus('pricing', `Searching market for a ${res.position}…`);
        const c = fut.newCriteria();
        if (q.league) c.league = q.league;
        if (q.nation) c.nation = q.nation;
        c._position = res.position;
        c.maxBuy = roundPrice(budget);
        if (q.min >= 200) c.minBuy = roundPrice(q.min);
        const r = await fut.search(c);
        engine.countUsage('searches');
        jobs.check(r, 'market search');
        for (const l of r.listings) {
          const p = fut.toPlayer(l.item);
          if (p.player && l.buyNowPrice) out.push({ ...p, price: l.buyNowPrice, source: 'market' });
        }
        await jobs.pause(engine.cfg.delayMin, engine.cfg.delayMax);
      }
      // Cheapest listing per card.
      const best = new Map();
      for (const p of out) if (!best.has(p.id) || best.get(p.id).price > p.price) best.set(p.id, p);
      return [...best.values()];
    },

    // -- formation coach --
    formations: [], // [{ id, label, rating, chem, lineup, slots, current }]

    async compareFormations() {
      await jobs.run('Comparing formations', async () => {
        engine.setStatus('pricing', 'Reading your squad…');
        const squad = await fut.activeSquad();
        if (!squad) throw new Error('could not read your active squad');
        const fieldSlots = squad.getFieldPlayers().slice(0, 11);
        const curSlots = fieldSlots.map((s) => (s.position ? normPos(s.position.typeName ?? s.position.id) : '?'));
        const asPlayer = (item) => ({ ...fut.toPlayer(item), itemId: item.id, id: item.definitionId });
        const curPlayers = fieldSlots.map((s) => (s.item && s.item.definitionId ? asPlayer(s.item) : null));
        const fObj = typeof squad.getFormation === 'function' && squad.getFormation();
        const curFormation = (fObj && (fObj.name || fObj.typeName)) || '';
        const curLabel = (FORMATIONS[curFormation] && FORMATIONS[curFormation].label) || curFormation.replace(/^f/, '') || 'Current';
        const cur = lineupScore(curPlayers, curSlots);

        // Your players: whole active squad (starters, subs, reserves) + the club.
        const pool = new Map();
        const allSquad = typeof squad.getPlayers === 'function' ? squad.getPlayers() : fieldSlots;
        for (const s of allSquad) {
          const it = s && (s.item || s);
          if (it && it.definitionId) pool.set(it.id, asPlayer(it));
        }
        const owned = await fut.clubPlayers((n) => engine.setStatus('pricing', `Reading your club… ${n}`), { storage: false });
        if (owned.ok) owned.items.forEach((it) => { if (it && it.definitionId) pool.set(it.id, asPlayer(it)); });
        else ui.log(`Club couldn't be read (EA status ${owned.status}) — using your squad only`, 'warn');
        const club = [...pool.values()].filter((p) => p.player && !p.loan && p.positions.length);
        // one card per player (duplicates of the same card can't both play)
        const byCard = new Map();
        club.forEach((p) => { if (!byCard.has(p.id) || byCard.get(p.id).rating < p.rating) byCard.set(p.id, p); });
        const players = [...byCard.values()];

        const perPos = {};
        players.forEach((p) => p.positions.forEach((x) => { perPos[x] = (perPos[x] || 0) + 1; }));
        ui.log(`Read ${players.length} players · ${Object.entries(perPos).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`, 'muted');
        debugLog.push(`formations: squad slots ${curSlots.join(',')} · formation ${curFormation} · sample positions ${players.slice(0, 3).map((p) => `${p.name}:${JSON.stringify(p.positions)}`).join(' ')}`);

        engine.setStatus('pricing', 'Building the best XI for each formation…');
        await sleep(30);
        const curIds = new Set(curPlayers.filter(Boolean).map((p) => p.id));
        const describe = (lineup) => {
          const ins = lineup.filter((p) => p && !curIds.has(p.id));
          const ids = new Set(lineup.filter(Boolean).map((p) => p.id));
          const outs = curPlayers.filter((p) => p && !ids.has(p.id));
          return { ins, outs };
        };
        const list = [{ id: curFormation, label: `${curLabel} (yours now)`, rating: cur.rating, chem: cur.chem, score: cur.score, lineup: curPlayers, slots: curSlots, current: true, filled: curPlayers.filter(Boolean).length, ins: [], outs: [] }];
        // Best XI in the formation you already use.
        const same = bestLineup(players, curSlots);
        if (same.filled >= 11) list.push({ id: curFormation, label: `${curLabel} — best XI`, rating: same.rating, chem: same.chem, score: same.score, lineup: same.lineup, slots: curSlots, filled: same.filled, ...describe(same.lineup) });
        for (const [id, f] of Object.entries(FORMATIONS)) {
          if (id === curFormation) continue;
          const best = bestLineup(players, f.slots);
          const missing = f.slots.filter((_, i) => !best.lineup[i]);
          list.push({ id, label: f.label, rating: best.rating, chem: best.chem, score: best.score, lineup: best.lineup, slots: f.slots, filled: best.filled, missing, ...describe(best.lineup) });
        }
        list.sort((x, y) => (y.filled === 11) - (x.filled === 11) || y.score - x.score);
        this.formations = list;
        this.currentIds = curIds;
        ui.formOpen = list.findIndex((f) => !f.current && f.filled === 11);
        ui.renderFormations();
        const top = list.find((f) => f.filled === 11);
        if (!top || top.current) ui.log(`Your current lineup is already the best option (rating ${cur.rating}, chemistry ${cur.chem}/33)`, 'ok');
        else ui.log(`Best: ${top.label} — rating ${top.rating}, chemistry ${top.chem}/33 (now ${cur.rating} / ${cur.chem}) · ${top.ins.length} change${top.ins.length === 1 ? '' : 's'}`, 'ok');
      });
    },

    async createSquad(idx) {
      const f = this.formations[idx];
      if (!f || f.current || f.filled !== 11) return;
      await jobs.run('Creating squad', async () => {
        const name = `FC Sniper ${(FORMATIONS[f.id] && FORMATIONS[f.id].label) || f.id.replace(/^f/, '')}`.slice(0, 20);
        const items = f.lineup.map((p) => p && p.item);
        const r = await fut.createSquad(name, f.id, items);
        jobs.check(r, 'creating the squad');
        ui.log(`Created squad "${name}" — open Squads in the Web App to check it and set it active`, 'ok');
        ui.toast(`Squad created: ${name}`, 'ok');
      });
    },

    /** Send a suggestion to the sniper with its listed price as the max buy. */
    snipe(opt) {
      if (engine.running) return;
      const players = engine.cfg.players.filter((p) => p.id !== opt.id);
      players.push({ id: opt.id, name: opt.name, rating: opt.rating, manualMax: opt.price ? roundPrice(opt.price) : 0 });
      engine.cfg.players = players;
      engine.save();
      ui.renderPlayers();
      ui.showTab('snipe');
      ui.log(`Added ${opt.name} to snipe${opt.price ? ` at ≤ ${fmt(roundPrice(opt.price))}` : ''} — tap ▶ to start`, 'ok');
    },
  };

  // ---- Hot cards (market scanner) ---------------------------------------------------

  const hot = {
    list: [], // [{ id, name, rating, count, bids, score, avg, lowest, plan }]
    scannedAt: 0,

    budget() {
      const cfg = engine.cfg;
      return cfg.tradeBudget || Math.max(0, fut.coins() - cfg.minCoins);
    },

    /** Scan the live market, score cards, price-check the best and keep profitable ones. */
    async scan(autoAdd) {
      let added = false;
      await jobs.run('Finding hot cards', async () => {
        const cfg = engine.cfg;
        const budget = this.budget();
        if (budget < 1000) { ui.log('Not enough coins to trade', 'warn'); return; }
        const leagues = String(cfg.hotLeagues || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean);
        const bands = [0.4, 0.12, 0.03].map((f) => roundPrice(budget * f));
        const segments = (leagues.length ? leagues : [0]).flatMap((league, i) => [{ league, min: bands[i % bands.length] }, { league, min: bands[(i + 1) % bands.length] }]).slice(0, 10);
        const all = [];
        for (const [n, seg] of segments.entries()) {
          engine.setStatus('pricing', `Scanning the market… ${n + 1}/${segments.length}`);
          const c = fut.newCriteria();
          if (seg.league) c.league = seg.league;
          c.level = 'gold';
          if (cfg.hotRareOnly) c.rarities = [1];
          c.maxBuy = roundPrice(budget);
          if (seg.min >= 200) c.minBuy = seg.min;
          const r = await fut.search(c);
          engine.countUsage('searches');
          jobs.check(r, 'market scan');
          all.push(...r.listings);
          await jobs.pause(cfg.delayMin, cfg.delayMax);
        }
        const ranked = rankHot(aggregateListings(all), { budget, minListings: 3 });
        ui.log(`Scanned ${all.length} listings · ${ranked.length} cards with activity`, 'muted');
        const out = [];
        for (const card of ranked.slice(0, Math.max(3, (cfg.hotPick || 3) + 2))) {
          if (jobs.cancelled) break;
          engine.setStatus('pricing', `Pricing ${card.name}…`);
          const r = await findMarketPrice(engine.priceSearch(card), { defId: card.id });
          jobs.check(r, 'price check');
          if (r.count) {
            const plan = flipPlan(r.avg, tradeOpts(r.avg, cfg));
            out.push({ ...card, avg: r.avg, lowest: r.lowest, listed: r.count, plan });
          }
          await jobs.pause(cfg.delayMin, cfg.delayMax);
        }
        // Best first: has a profitable plan, then hotness × profit.
        out.sort((a, b) => (!!b.plan - !!a.plan) || (b.score * (b.plan ? b.plan.profit : 0)) - (a.score * (a.plan ? a.plan.profit : 0)));
        this.list = out;
        this.scannedAt = Date.now();
        ui.renderHot();
        const good = out.filter((x) => x.plan);
        ui.log(good.length ? `🔥 Hot: ${good.slice(0, 3).map((x) => `${x.name} ${x.rating} (+${fmt(x.plan.profit)})`).join(', ')}` : 'No hot card has a profitable flip right now — try a bigger budget or lower min profit', good.length ? 'ok' : 'warn');
        if (autoAdd && good.length) { this.addTop(); added = true; }
      });
      return added;
    },

    add(card) {
      if (!card || engine.running) return;
      const players = engine.cfg.players.filter((p) => p.id !== card.id);
      players.push({ id: card.id, name: card.name, rating: card.rating, avg: card.avg, lowest: card.lowest, checkedAt: Date.now(), hot: true });
      engine.cfg.players = players;
      engine.save();
      ui.renderPlayers(); ui.renderTrade(); ui.renderHot();
    },

    /** Replace earlier hot picks with the current top ones (your own players stay). */
    addTop() {
      const n = Math.max(1, engine.cfg.hotPick || 3);
      const picks = this.list.filter((x) => x.plan).slice(0, n);
      engine.cfg.players = engine.cfg.players.filter((p) => !p.hot);
      picks.forEach((c) => this.add(c));
      ui.log(`Trading hot cards: ${picks.map((c) => c.name).join(', ')}`, 'ok');
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
    ['snipe', 'Snipe'], ['trade', 'Trade'], ['squad', 'Squad'], ['packs', 'Packs'],
    ['sbc', 'SBC'], ['history', 'History'], ['log', 'Log'], ['settings', 'Settings'],
  ];
  const OLD_TABS = { upgrades: 'squad', filters: 'settings', sell: 'settings', safety: 'settings' };
  const DURATIONS = OPT([['3600', '1 hour'], ['10800', '3 hours'], ['21600', '6 hours'], ['43200', '12 hours'], ['86400', '1 day'], ['259200', '3 days']]);

  // [key, label, type, options/hint] — type 'sec' shows seconds but stores milliseconds
  const FIELDS = {
    snipe: [
      ['mode', 'Mode', 'seg', OPT([['buy', 'Buy'], ['trade', 'Trade'], ['alert', 'Alert']])],
      ['discount', 'Snipe % under avg', 'number'],
      ['minCoins', 'Keep coins', 'number'],
      ['maxBuys', 'Buys per session', 'number'],
      ['bidSnipe', 'Also bid on auctions ending soon', 'toggle'],
      ['bidWindow', 'Bid in the last (seconds)', 'number'],
    ],
    trade: [
      ['undercut', 'List % under market avg', 'number'],
      ['minProfit', 'Min profit per card (after tax)', 'number'],
      ['minProfitPct', 'Min profit % of sell price', 'number'],
      ['listDuration', 'List for', 'select', DURATIONS],
      ['upkeepMinutes', 'Check transfer list every (min)', 'number'],
      ['repriceMinutes', 'Refresh prices every (min)', 'number'],
      ['tradeBudget', 'Max coins per card (0 = my coins)', 'number'],
    ],
    hot: [
      ['hotAuto', 'Pick hot cards when I start trading', 'toggle'],
      ['hotPick', 'How many hot cards to trade', 'number'],
      ['hotRareOnly', 'Rare golds only', 'toggle'],
      ['hotLeagues', 'Leagues to scan (IDs)', 'text', '13,53,19,31,16'],
    ],
    squad: [
      ['upgradeBudget', 'Budget (0 = my coins)', 'number'],
      ['upgradeMarket', 'Also search the market', 'toggle'],
    ],
    packs: [
      ['packSort', 'Sort items after each pack', 'toggle'],
      ['quickSellBelow', 'Quick-sell duplicates rated below', 'number', '0 = never'],
    ],
    sbc: [
      ['sbcProtectSquad', 'Never use my active squad', 'toggle'],
      ['sbcUseTradeables', 'Use tradeable players', 'toggle'],
      ['sbcUseSpecials', 'Use special cards', 'toggle'],
      ['sbcMaxRating', 'Max player rating to use', 'number'],
      ['sbcRepeat', 'Repeat repeatable SBCs', 'number'],
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
      ['sellMode', 'After buying (Buy mode)', 'select', OPT([['off', 'Keep the card'], ['profit', 'List for min profit'], ['market', 'List at market avg'], ['fixed', 'List at my price']])],
      ['sellPrice', 'My sell price', 'number'],
      ['autoRelist', 'Relist expired & clear sold on start', 'toggle'],
    ],
    safety: [
      ['delayMin', 'Wait between searches, min (s)', 'sec'],
      ['delayMax', 'Wait between searches, max (s)', 'sec'],
      ['pauseEvery', 'Rest every N searches (≤ 60)', 'number'],
      ['pauseMin', 'Rest min (s)', 'sec'],
      ['pauseMax', 'Rest max (s)', 'sec'],
      ['sessionMinutes', 'Session length (min)', 'number'],
      ['maxSearches', 'Searches per session', 'number'],
      ['searchesPerDay', 'Searches per day', 'number'],
      ['buysPerDay', 'Buys per day', 'number'],
      ['maxActiveBids', 'Open bids at once', 'number'],
    ],
    notify: [
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
    const num = type === 'number' || type === 'sec';
    const shown = type === 'sec' ? Math.round((v || 0) / 100) / 10 : v;
    return `<label class="row${wide ? ' wide' : ''}"><span>${label}</span><input type="${num ? 'number' : 'text'}" inputmode="${type === 'sec' ? 'decimal' : num ? 'numeric' : 'text'}"
      data-k="${key}"${type === 'sec' ? ' data-unit="s" step="0.5"' : ''} value="${esc(shown)}" placeholder="${esc(extra || '')}" autocomplete="off"></label>`;
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
  #fcs button{font:inherit;color:inherit;border:0;background:none;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
  #fcs button:disabled{opacity:.45;cursor:default}
  #fcs input,#fcs select{font:inherit;color:var(--text);background:var(--card2);border:1px solid var(--line);border-radius:9px;padding:7px 9px;width:100%;min-width:0;outline:0}
  #fcs input:focus,#fcs select:focus{border-color:var(--green)}
  #fcs input:disabled,#fcs select:disabled{opacity:.55}

  #fcs .hd{display:flex;align-items:center;gap:10px;padding:12px 12px 10px 14px;cursor:move;touch-action:none;user-select:none}
  #fcs .brand{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
  #fcs .logo{flex:none;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:linear-gradient(135deg,#3ddc84,#1aa35a);color:var(--green-ink);font-weight:800;font-size:12px}
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

  #fcs .hd,#fcs .tabs{flex:none}
  #fcs .tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:2px 10px 10px;border-bottom:1px solid var(--line)}
  #fcs .tabs button{padding:7px 2px;color:var(--muted);font-weight:600;font-size:12px;border-radius:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #fcs .tabs button.on{color:var(--text);background:var(--card2);box-shadow:inset 0 -2px 0 var(--green)}
  #fcs .body{flex:1;min-height:0}
  #fcs .last{margin:6px 0 0;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #fcs .last:empty{display:none}
  #fcs .last.ok{color:var(--green)}#fcs .last.warn{color:var(--amber)}#fcs .last.err{color:var(--red)}#fcs .last.alert{color:#ffe08a}
  #fcs .btn.go-btn{background:var(--green);border-color:var(--green);color:var(--green-ink)}
  #fcs .log{max-height:none}
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
  #fcs .chip .nm{flex:1;min-width:0;font-weight:600;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.25}
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
  #fcs [hidden]{display:none!important}
  #fcs .list{display:flex;flex-direction:column}
  #fcs .li{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)}
  #fcs .li:last-child{border-bottom:0}
  #fcs .li .t{flex:1;min-width:0}
  #fcs .li .t b{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #fcs .li .t small{display:block;color:var(--dim);font-size:11.5px}
  #fcs .mini{padding:6px 10px;border-radius:8px;background:var(--card2);border:1px solid var(--line);font-weight:600;font-size:12px;white-space:nowrap}
  #fcs .mini.go2{background:var(--green);border-color:var(--green);color:var(--green-ink)}
  #fcs .tag{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:6px;margin-left:4px;background:var(--card2);color:var(--muted)}
  #fcs .tag.ok{color:var(--green);background:rgba(61,220,132,.1)}#fcs .tag.no{color:var(--amber);background:rgba(255,200,87,.1)}
  #fcs .sub{padding-left:10px;border-left:2px solid var(--line);margin:2px 0 8px}
  #fcs .kpi{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px}
  #fcs .kpi div{background:var(--card2);border-radius:9px;padding:7px 6px;text-align:center;color:var(--muted);font-size:11px}
  #fcs .kpi b{display:block;color:var(--text);font-size:16px}
  #fcs .up{font-weight:700;color:var(--green)}#fcs .down{font-weight:700;color:var(--red)}
  #fcs .plan{border-color:var(--green)}
  #fcs.mob .mini{padding:9px 12px;font-size:14px}#fcs.mob .li{padding:10px 0}

  #fcs-toast{position:fixed;left:50%;top:16px;transform:translate(-50%,-30px);opacity:0;visibility:hidden;z-index:2147483001;padding:10px 16px;border-radius:12px;
    font:600 14px -apple-system,system-ui,sans-serif;color:#05210f;background:#3ddc84;box-shadow:0 12px 30px rgba(0,0,0,.4);transition:transform .25s,opacity .25s,visibility .25s;pointer-events:none;max-width:90vw}
  #fcs-toast.show{transform:translate(-50%,0);opacity:1;visibility:visible}#fcs-toast.alert{background:#ffc857;color:#2b1d00}

  #fcs.mob{top:auto!important;left:0!important;right:0!important;bottom:0;width:auto;max-height:78vh;border-radius:20px 20px 0 0;border-bottom:0;
    font-size:15px;padding-bottom:env(safe-area-inset-bottom)}
  #fcs.mob .hd{cursor:default;padding:12px 12px 10px 16px}
  #fcs.mob .hd::before{content:"";position:absolute;left:50%;top:5px;width:36px;height:4px;margin-left:-18px;border-radius:9px;background:var(--line)}
  #fcs.mob .go{width:48px;height:40px}#fcs.mob .fold{width:40px;height:40px}
  #fcs.mob:not(.min){height:min(80vh,720px)}
  #fcs.mob .tabs button{padding:9px 2px;font-size:13.5px}
  #fcs.mob .last{font-size:13px}
  #fcs.mob input,#fcs.mob select{font-size:16px;padding:10px}
  #fcs.mob .row{padding:7px 0}#fcs.mob .seg button{padding:8px 4px;font-size:14px}
  #fcs.mob .btn{padding:13px}#fcs.mob .chip{padding:9px 6px 9px 12px}#fcs.mob .chip .rm{width:34px;height:34px}
  #fcs.mob .sugg button{padding:13px 12px}#fcs.mob .log{font-size:12px}
  /* collapsed on a phone: a small handle on the right edge, drag it up or down */
  #fcs.mob.min{left:auto!important;right:6px!important;top:var(--fcs-top,58%)!important;bottom:auto;width:auto;
    border:1px solid var(--line);border-radius:16px;padding-bottom:0;box-shadow:0 8px 24px rgba(0,0,0,.5)}
  #fcs.mob.min .hd{padding:6px;gap:6px;cursor:grab}
  #fcs.mob.min .hd::before,#fcs.mob.min .brand b,#fcs.mob.min .coins,#fcs.mob.min .pill{display:none}
  #fcs.mob.min .brand{flex:none}
  @media (max-width:375px){
    #fcs .brand b{display:none}
    #fcs .coins{font-size:12px}
    #fcs .pill{padding:2px 6px}
    #fcs.mob .tabs button{font-size:12.5px}
  }
  #fcs.mob.min .logo{width:32px;height:32px;flex:none}
  #fcs.mob.min .go{width:42px;height:36px}#fcs.mob.min .fold{width:30px;height:36px}`;

  const ui = {
    root: null,
    tab: (() => { const t = store.get(KEYS.ui, {}).tab || 'snipe'; return OLD_TABS[t] || t; })(),

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
              <p class="last" data-r="last"></p>
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
            <div class="card">${FIELDS.snipe.map(fieldHtml).join('')}
              <p class="note"><b>Buy</b> snipes cards under your max. <b>Trade</b> buys under value and relists for profit (see Trade). <b>Alert</b> only notifies you.</p></div>
            <div class="card"><h4>This session</h4>
              <div class="stats">
                <div><b data-s="searches">0</b>Searches</div><div><b data-s="buys">0</b>Bought</div><div><b data-s="missed">0</b>Missed</div>
                <div><b data-s="spent">0</b>Spent</div><div><b data-s="listed">0</b>Listed</div><div><b data-s="profit">0</b>Est. profit</div>
              </div>
            </div>
          </section>
          <section class="pane" data-pane="trade">
            <div class="card"><h4>🔥 Hot right now</h4><div data-r="hot"><p class="empty">Scans the live market for cards people are buying and bidding on, then keeps the ones you can flip for profit.</p></div>
              <button class="btn blue" data-a="hot-scan">Find hot cards</button>
              <p class="note">Based on what’s listed and being bid on in EA’s market right now (about 10 searches plus a price check per card). Trend sites like Futbin block bots, so this is live market data instead.</p></div>
            <div class="card"><h4>Resell bot</h4>
              <div class="kpi" data-r="tkpi"></div>
              <div data-r="tplans"></div>
              <button class="btn go-btn" data-a="trade-start">Start trading</button>
              <button class="btn" data-a="upkeep">Check transfer list now</button>
              <p class="note">For each player on the Snipe tab it lists a little under the market average so cards sell, and only buys low enough to keep your min profit after EA’s 5% tax. Every few minutes it records sales, clears sold items, relists expired ones, and pauses buying when your transfer list is full. Same safety limits as sniping.</p></div>
            <div class="card"><h4>Trade settings</h4>${FIELDS.trade.map(fieldHtml).join('')}</div>
            <div class="card"><h4>Hot card settings</h4>${FIELDS.hot.map(fieldHtml).join('')}
              <p class="note">League IDs: 13 Premier League, 53 LaLiga, 19 Bundesliga, 31 Serie A, 16 Ligue 1.</p></div>
          </section>
          <section class="pane" data-pane="squad">
            <div class="card"><h4>Your team</h4><div data-r="team"><p class="empty">Reads your active squad and finds the best upgrades for your weakest spots.</p></div>
              <button class="btn blue" data-a="analyse">Analyse my team</button></div>
            <div data-r="upg"></div>
            <div class="card"><h4>Formation coach</h4><div data-r="forms"><p class="empty">Compares your lineup with popular competitive formations, built from players you own.</p></div>
              <button class="btn blue" data-a="forms">Compare formations</button>
              <p class="note">Formations are a built-in list of popular competitive setups, not live pro data. “Create squad” makes a new squad, so your current one isn’t touched.</p></div>
            <div class="card">${FIELDS.squad.map(fieldHtml).join('')}
              <p class="note">Owned players are suggested first. Market suggestions match your squad’s main league or nation so you keep chemistry, and cost a few searches.</p></div>
          </section>
          <section class="pane" data-pane="packs">
            <div class="card"><h4>Unopened packs</h4><div data-r="packs"><p class="empty">Tap below to see your packs.</p></div>
              <button class="btn blue" data-a="packs-load">Load my packs</button></div>
            <div class="card">${FIELDS.packs.map(fieldHtml).join('')}
              <p class="note">New items go to your club, untradeable duplicates to SBC storage, tradeable duplicates to your transfer list. Specials are never quick-sold.</p></div>
          </section>
          <section class="pane" data-pane="sbc">
            <div class="card plan" data-r="plan" hidden></div>
            <div class="card"><h4>Squad Building Challenges</h4><div data-r="sbc"><p class="empty">Load SBCs to see which ones can be solved from your club.</p></div>
              <button class="btn blue" data-a="sbc-load">Load SBCs</button></div>
            <div class="card">${FIELDS.sbc.map(fieldHtml).join('')}
              <p class="note">Never uses your active squad (starters, subs, reserves), loans, evolutions, specials or tradeables unless you allow them, or anyone above your max rating — and checks every player again right before sending. Cheapest fodder first: SBC storage and duplicates, then untradeables. Chemistry and league/nation/club counts aren’t automatic yet.</p></div>
          </section>
          <section class="pane" data-pane="history">
            <div class="card"><h4>Totals</h4><div class="stats" data-r="totals"></div></div>
            <div class="card"><h4>Recent buys</h4><div class="hist" data-r="hist"></div>
              <button class="btn red" data-a="clear-history">Clear history</button></div>
          </section>
          <section class="pane" data-pane="log">
            <div class="card"><h4>Activity</h4><div class="log" data-r="log"></div>
              <button class="btn" data-a="copy-log">Copy log (to send for help)</button></div>
          </section>
          <section class="pane" data-pane="settings">
            <div class="card"><h4>Targets & filters</h4>${FIELDS.filters.map(fieldHtml).join('')}
              <p class="note">Players match every version of the card. Use Min rating to target one version.</p></div>
            <div class="card"><h4>After buying</h4>${FIELDS.sell.map(fieldHtml).join('')}
              <p class="note">Min profit and listing time are on the Trade tab. EA keeps 5% of every sale; profit shown is after tax.</p></div>
            <div class="card"><h4>Safety limits</h4>${FIELDS.safety.map(fieldHtml).join('')}
              <p class="note">Minimums are enforced. A captcha locks the bot for 3 h, a market limit for 24 h.</p>
              <p class="note" data-r="lock"></p></div>
            <div class="card"><h4>Notifications</h4>${FIELDS.notify.map(fieldHtml).join('')}
              <button class="btn" data-a="discord-test">Send test notification</button></div>
          </section>
        </div>`;
      document.body.appendChild(root);
      this.root = root;

      if (isMobile()) root.classList.add('mob', 'min');
      this.bind();
      this.mountPicker();
      this.showTab(this.tab);
      this.renderPlayers(); this.renderStats(); this.renderHistory(); this.renderStatus(); this.renderTrade();
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
          case 'analyse': return upgrades.analyse();
          case 'hot-scan': return hot.scan(false);
          case 'hot-add': return hot.add(hot.list[Number(btn.dataset.i)]);
          case 'hot-top': return hot.addTop();
          case 'trade-start':
            if (engine.running || jobs.current) return;
            this.commit();
            engine.cfg = { ...engine.cfg, mode: 'trade' };
            engine.save(); this.syncForm();
            if (engine.cfg.hotAuto) {
              return hot.scan(true).then((ok) => {
                if (ok || engine.cfg.players.length) engine.start();
                else this.log('No profitable hot cards found — nothing started', 'warn');
              });
            }
            if (!engine.cfg.players.length) { this.showTab('snipe'); this.log('Add the players you want to trade on the Snipe tab first', 'warn'); this.toast('Add players to trade first', 'alert'); return; }
            return engine.start();
          case 'upkeep': return engine.upkeepNow();
          case 'forms': return upgrades.compareFormations();
          case 'form-view': this.formOpen = this.formOpen === Number(btn.dataset.i) ? -1 : Number(btn.dataset.i); return this.renderFormations();
          case 'form-create': return upgrades.createSquad(Number(btn.dataset.i));
          case 'copy-log': return this.copyLog();
          case 'snipe-opt': {
            const r = upgrades.results[Number(btn.dataset.s)];
            return r && upgrades.snipe(r.options[Number(btn.dataset.o)]);
          }
          case 'packs-load': return packs.refresh();
          case 'pack-open': {
            const g = packs.groups()[Number(btn.dataset.g)];
            return g && packs.open(btn.dataset.n === 'all' ? g.list : g.list.slice(0, 1));
          }
          case 'pack-open-all': return packs.open(packs.list.slice());
          case 'sbc-load': return sbc.loadSets();
          case 'sbc-set': return sbc.loadChallenges(sbc.sets[Number(btn.dataset.i)]);
          case 'sbc-solve': {
            const set = sbc.sets[Number(btn.dataset.i)];
            return set && sbc.solve(set, sbc.open.get(set.id)[Number(btn.dataset.j)]);
          }
          case 'sbc-submit': return sbc.submit(false);
          case 'sbc-fill': return sbc.submit(true);
          case 'sbc-discard': sbc.plan = null; return this.renderSbc();
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

    /** Phone: move the collapsed handle up/down the right edge. */
    dragHandle(e) {
      e.preventDefault();
      const startTop = this.root.getBoundingClientRect().top;
      const sy = e.clientY;
      const h = this.root.offsetHeight;
      let top = startTop;
      const move = (ev) => {
        top = Math.min(w.innerHeight - h - 8, Math.max(8, startTop + ev.clientY - sy));
        this.root.style.setProperty('--fcs-top', `${top}px`);
      };
      const up = () => {
        removeEventListener('pointermove', move); removeEventListener('pointerup', up);
        store.set(KEYS.ui, { ...store.get(KEYS.ui, {}), handleTop: Math.round(top) });
      };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    },

    showTab(tab) {
      this.tab = tab;
      this.qa('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
      this.qa('[data-pane]').forEach((p) => p.classList.toggle('on', p.dataset.pane === tab));
      store.set(KEYS.ui, { ...store.get(KEYS.ui, {}), tab });
      if (tab === 'trade') this.renderTrade();
      if (tab === 'squad' && upgrades) this.renderUpgrades();
    },

    /** Read every field into the config and save it. */
    commit() {
      const cfg = { ...engine.cfg };
      this.qa('[data-k]').forEach((el) => {
        const k = el.dataset.k;
        if (el.classList.contains('seg')) cfg[k] = el.querySelector('.on')?.dataset.v ?? cfg[k];
        else if (el.type === 'checkbox') cfg[k] = el.checked;
        else if (el.dataset.unit === 's') cfg[k] = Math.round((Number(el.value) || 0) * 1000);
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
        else if (el.dataset.unit === 's') el.value = Math.round((v || 0) / 100) / 10;
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
      engine.save(); this.renderPlayers(); this.renderTrade();
      this.log(p.manualMax ? `${p.name}: max buy set to ${fmt(p.manualMax)}` : `${p.name}: back to automatic price`, 'muted');
    },

    renderPlayers() {
      const cfg = engine.cfg;
      this.q('[data-r=chips]').innerHTML = cfg.players.map((p) => {
        const max = effectiveMaxBuy(p, cfg);
        const sub = `${p.hot ? '🔥 ' : ''}${p.manualMax ? 'your max' : p.avg ? `avg ${fmt(p.avg)}` : p.checkedAt ? 'none listed' : 'not priced yet'}`;
        return `<div class="chip"><span class="ovr">${p.rating || ''}</span>
          <span class="nm">${esc(p.name)}<small>${sub}</small></span>
          <button class="mx${p.manualMax ? ' manual' : ''}" data-max="${p.id}">≤ ${fmt(max)}</button>
          <button class="rm" data-rm="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></div>`;
      }).join('');
    },

    setJob(name) {
      const go = this.q('[data-a=toggle]');
      const on = !!name || engine.running;
      go.classList.toggle('on', on);
      go.innerHTML = on ? ICON.stop : ICON.play;
      go.disabled = false;
      this.qa('[data-a=analyse], [data-a=packs-load], [data-a=pack-open], [data-a=pack-open-all], [data-a=sbc-load], [data-a=sbc-set], [data-a=sbc-solve], [data-a=sbc-submit], [data-a=sbc-fill], [data-a=price]')
        .forEach((b) => { b.disabled = !!name; });
      if (name) engine.setStatus('pricing', `${name}…`);
    },

    renderPacks() {
      const groups = packs.groups();
      const total = packs.list.length;
      this.q('[data-r=packs]').innerHTML = total ? `
        <div class="list">${groups.map((g, i) => `<div class="li"><span class="t"><b>${esc(g.name)}</b><small>${g.list.length} unopened</small></span>
          <button class="mini" data-a="pack-open" data-g="${i}" data-n="1">Open 1</button>
          ${g.list.length > 1 ? `<button class="mini" data-a="pack-open" data-g="${i}" data-n="all">All ${g.list.length}</button>` : ''}</div>`).join('')}</div>
        <button class="btn" data-a="pack-open-all" style="color:var(--green)">Open all ${total} pack${total === 1 ? '' : 's'}</button>`
        : '<p class="empty">No unopened packs</p>';
    },

    reqText(r) {
      const sym = { GREATER: '≥', LOWER: '≤', EXACT: '=' }[r.scope] || r.scope;
      const v = r.values.join(', ');
      const q = { 1: 'Bronze', 2: 'Silver', 3: 'Gold' };
      const per = r.count > 0 ? `${r.count}× ` : '';
      switch (r.key) {
        case 'TEAM_RATING': return `Team rating ${sym} ${v}`;
        case 'PLAYER_QUALITY': case 'PLAYER_LEVEL': return `${per}Quality ${sym} ${r.values.map((x) => q[x] || x).join('/')}`;
        case 'PLAYER_RARITY_GROUP': return `${per}Rare ${sym} ${r.count > 0 ? '' : 'all'}`.trim();
        case 'PLAYER_MIN_OVR': return `Each player ≥ ${v}`;
        case 'PLAYER_MAX_OVR': return `Each player ≤ ${v}`;
        case 'PLAYER_EXACT_OVR': return `Each player = ${v}`;
        case 'CHEMISTRY_POINTS': case 'ALL_PLAYERS_CHEMISTRY_POINTS': return `Chemistry ${sym} ${v}`;
        default: return `${per}${r.key.toLowerCase().replace(/_/g, ' ')} ${sym} ${v}`;
      }
    },

    renderSbc() {
      const box = this.q('[data-r=sbc]');
      box.innerHTML = sbc.sets.length ? `<div class="list">${sbc.sets.slice(0, 80).map((set, i) => {
        const loaded = sbc.open.get(set.id);
        const rep = set.repeatable || set.timesCompleted ? `<span class="tag">${set.timesCompleted || 0} done</span>` : '';
        const sub = loaded ? `<div class="sub">${loaded.length ? loaded.map((e, j) => {
          const ok = !e.parsed.unsupported.length;
          return `<div class="li"><span class="t"><b>${esc(e.challenge.name || set.name)}${ok ? '<span class="tag ok">auto</span>' : '<span class="tag no">manual</span>'}</b>
            <small>${esc(e.reqs.filter((r) => r.key !== 'SCOPE' && r.key !== 'PLAYER_COUNT').map((r) => this.reqText(r)).join(' · ') || `${fut.requiredPlayers(e.challenge)} players`)}${ok ? '' : ` — needs ${esc(e.parsed.unsupported.join(', '))}`}</small></span>
            ${ok ? `<button class="mini go2" data-a="sbc-solve" data-i="${i}" data-j="${j}">Solve</button>` : ''}</div>`;
        }).join('') : '<p class="empty">All done</p>'}</div>` : '';
        return `<div class="li"><span class="t"><b>${esc(set.name)}${rep}</b><small>${esc(set.description || '')}</small></span>
          ${loaded ? '' : `<button class="mini" data-a="sbc-set" data-i="${i}">View</button>`}</div>${sub}`;
      }).join('')}</div>` : '<p class="empty">Load SBCs to see which ones can be solved from your club.</p>';

      const plan = this.q('[data-r=plan]');
      const p = sbc.plan;
      plan.hidden = !p;
      if (!p) return;
      const tag = (x) => (x.storage ? '<span class="tag">storage</span>' : x.duplicate ? '<span class="tag">duplicate</span>' : x.untradeable ? '<span class="tag">untradeable</span>' : '<span class="tag no">tradeable</span>');
      plan.innerHTML = `<h4>Solution — ${esc(p.set.name)}</h4>
        <p class="note" style="margin:0 0 8px">✓ none from your squad (${sbc.guard ? sbc.guard.itemIds.size : 0} protected) · ✓ all ≤ ${engine.cfg.sbcMaxRating}${engine.cfg.sbcUseSpecials ? '' : ' · ✓ no specials'}${engine.cfg.sbcUseTradeables ? '' : ' · ✓ untradeables only'}</p>
        <div class="kpi"><div><b>${p.solution.players.length}</b>Players</div><div><b>${p.solution.rating || '—'}</b>Rating</div><div><b>${p.solution.players.filter((x) => x.rare).length}</b>Rares</div></div>
        <div class="list">${p.solution.players.slice().sort((a, b) => b.rating - a.rating).map((x) => `<div class="li"><span class="t"><b>${esc(x.name)}${tag(x)}</b></span><b>${x.rating}</b></div>`).join('')}</div>
        <button class="btn" data-a="sbc-submit" style="background:var(--green);color:var(--green-ink);border-color:var(--green)">Submit${engine.cfg.sbcRepeat > 1 ? ` (up to ${engine.cfg.sbcRepeat}×)` : ''}</button>
        <button class="btn" data-a="sbc-fill">Fill squad only (check it in the Web App)</button>
        <button class="btn red" data-a="sbc-discard">Discard</button>`;
    },

    renderHot() {
      const box = this.q('[data-r=hot]');
      if (!box || !hot.list.length) return;
      const mine = new Set(engine.cfg.players.map((p) => p.id));
      const ago = Math.round((Date.now() - hot.scannedAt) / 60e3);
      box.innerHTML = `<div class="list">${hot.list.map((c, i) => `<div class="li">
          <span class="t"><b>${esc(c.name)} ${c.rating || ''}${c.bids ? ` <span class="tag ok">${c.bids} bid${c.bids === 1 ? '' : 's'}</span>` : ''}</b>
          <small>${c.listed} listed · avg ${fmt(c.avg)}${c.plan ? ` · buy ≤ ${fmt(c.plan.maxBuy)} → sell ${fmt(c.plan.sell)} <span class="up">+${fmt(c.plan.profit)}</span>` : ' · <span class="down">no profit at your settings</span>'}</small></span>
          ${c.plan ? (mine.has(c.id) ? '<span class="tag ok">added</span>' : `<button class="mini" data-a="hot-add" data-i="${i}">Add</button>`) : ''}</div>`).join('')}</div>
        ${hot.list.some((c) => c.plan) ? `<button class="btn go-btn" data-a="hot-top">Trade the top ${Math.min(engine.cfg.hotPick || 3, hot.list.filter((c) => c.plan).length)}</button>` : ''}
        <p class="note">Scanned ${ago < 1 ? 'just now' : `${ago} min ago`}.</p>`;
    },

    renderTrade() {
      if (!this.root) return;
      const cfg = engine.cfg;
      const sum = summarizeHistory(engine.history, Date.now());
      const listed = engine.listedNow ?? '—';
      this.q('[data-r=tkpi]').innerHTML = `
        <div><b>${listed}</b>Listed now</div><div><b>${fmt(sum.today.soldToday)}</b>Sold today</div><div><b class="${sum.today.realizedToday >= 0 ? 'up' : 'down'}">${fmt(sum.today.realizedToday)}</b>Profit today</div>`;
      this.q('[data-r=tplans]').innerHTML = cfg.players.length ? `<div class="list">${cfg.players.map((p) => {
        const plan = flipPlan(p.avg, tradeOpts(p.avg, cfg));
        const buyAt = plan && Math.min(plan.maxBuy, p.manualMax || Infinity);
        const short = plan ? Math.max(0, roundPrice(buyAt) - (fut.coins() - cfg.minCoins)) : 0;
        const sub = !p.avg ? 'needs a price check (Check prices on the Snipe tab)'
          : !plan ? `avg ${fmt(p.avg)} — no profitable price at your min profit`
          : `avg ${fmt(p.avg)} · buy ≤ ${fmt(buyAt)} · sell ${fmt(plan.sell)}${short > 0 ? ` · <span class="down">you can only buy listings under ${fmt(fut.coins() - cfg.minCoins)}</span>` : ''}`;
        return `<div class="li"><span class="t"><b>${esc(p.name)}</b><small>${sub}</small></span>${plan ? `<b class="up">+${fmt(plan.profit)}</b>` : ''}</div>`;
      }).join('')}</div><p class="note">All-time realized profit: <b class="${sum.all.realized >= 0 ? 'up' : 'down'}">${fmt(sum.all.realized)}</b> from ${fmt(sum.all.sold)} sales.</p>`
        : '<p class="empty">Add players on the Snipe tab, check their prices, then start trading.</p>';
    },

    renderFormations() {
      const list = upgrades.formations;
      const names = (arr) => arr.map((p) => `${esc(p.name)} ${p.rating}`).join(', ');
      this.q('[data-r=forms]').innerHTML = list.length ? `<div class="list">${list.map((f, i) => {
        const full = f.filled === 11;
        const best = full && !f.current && list.findIndex((x) => x.filled === 11) === i;
        let sub;
        if (f.current) sub = `rating ${f.rating} · chemistry ${f.chem}/33`;
        else if (!full) sub = `can’t fill: no ${[...new Set(f.missing)].join(', ')} in your club`;
        else {
          const dR = f.rating - list.find((x) => x.current).rating;
          const dC = f.chem - list.find((x) => x.current).chem;
          sub = `rating ${f.rating} (${dR >= 0 ? '+' : ''}${dR}) · chemistry ${f.chem}/33 (${dC >= 0 ? '+' : ''}${dC}) · ${f.ins.length ? `${f.ins.length} change${f.ins.length === 1 ? '' : 's'}` : 'same players'}`;
        }
        const detail = this.formOpen === i ? `<div class="sub">
          ${!f.current && f.ins.length ? `<p class="note" style="margin:4px 0"><span class="up">In:</span> ${names(f.ins)}<br><span class="down">Out:</span> ${names(f.outs) || '—'}</p>` : ''}
          ${f.lineup.map((p, k) => `<div class="li"><span class="t"><b>${esc(f.slots[k])} · ${p ? esc(p.name) : '—'}</b>
          <small>${p ? `${p.rating}${!f.current && !(upgrades.currentIds || new Set()).has(p.id) ? ' · <span class="up">new in XI</span>' : ''}` : 'nobody fits'}</small></span></div>`).join('')}</div>` : '';
        return `<div class="li"><span class="t"><b>${best ? '⭐ ' : ''}${esc(f.label)}</b><small>${sub}</small></span>
          <button class="mini" data-a="form-view" data-i="${i}">${this.formOpen === i ? 'Hide' : 'View'}</button>
          ${!f.current && full ? `<button class="mini go2" data-a="form-create" data-i="${i}">Create squad</button>` : ''}</div>${detail}`;
      }).join('')}</div>`
        : '<p class="empty">Compares your lineup with popular competitive formations, built from players you own.</p>';
    },

    async copyLog() {
      const lines = this.qa('[data-r=log] div').map((d) => d.textContent).reverse();
      const text = [`FC Sniper ${VERSION} · ${navigator.userAgent}`, ...lines, '--- details ---', ...debugLog.slice(-20)].join('\n');
      try { await navigator.clipboard.writeText(text); this.toast('Log copied — paste it in the chat', 'ok'); } catch {
        w.prompt('Copy this log:', text);
      }
    },

    renderUpgrades() {
      const s = upgrades.summary;
      if (s) {
        this.q('[data-r=team]').innerHTML = `<div class="kpi"><div><b>${s.rating}</b>Rating</div><div><b>${s.chem}/33</b>Chemistry</div><div><b>${esc(s.formation || '—')}</b>Formation</div></div>`;
      }
      this.q('[data-r=upg]').innerHTML = upgrades.results.map((r, si) => `
        <div class="card"><h4>${esc(r.position)} — now ${r.current ? `${esc(r.current.name)} ${r.current.rating}` : 'empty'}</h4>
        ${r.options.length ? `<div class="list">${r.options.map((o, oi) => `<div class="li">
          <span class="t"><b>${esc(o.name)} ${o.rating}</b><small>${o.source === 'club' ? 'You own him' : `${fmt(o.price)} coins`} ·
            team <span class="${o.ratingGain > 0 ? 'up' : ''}">${o.ratingGain > 0 ? '+' : ''}${o.ratingGain}</span> ·
            chem <span class="${o.chemGain > 0 ? 'up' : o.chemGain < 0 ? 'down' : ''}">${o.chemGain > 0 ? '+' : ''}${o.chemGain}</span></small></span>
          ${o.source === 'club' ? '<span class="tag ok">owned</span>' : `<button class="mini go2" data-a="snipe-opt" data-s="${si}" data-o="${oi}">Snipe</button>`}</div>`).join('')}</div>`
          : `<p class="empty">${r.done ? 'No better option found within budget' : 'Looking…'}</p>`}</div>`).join('');
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
        <div><b>${fmt(sum.all.buys)}</b>All buys</div><div><b>${fmt(sum.all.sold)}</b>Sold</div><div><b>${fmt(sum.all.realized)}</b>Real profit</div>`;
      const list = engine.history.slice(0, 50);
      this.q('[data-r=hist]').innerHTML = list.length ? list.map((e) => `
        <div><span>${esc(e.name)}${e.rating ? ` · ${e.rating}` : ''}</span><span class="p">${fmt(e.price)}</span>
        <small>${new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small>
        <small class="p ${e.sell || e.soldFor ? 'g' : ''}">${e.soldFor ? `sold ${fmt(e.soldFor)} · +${fmt(afterTax(e.soldFor) - e.price)}` : e.sell ? `listed ${fmt(e.sell)} · +${fmt(profit(e.price, e.sell))}` : e.via === 'bid' ? 'won bid · kept' : 'kept'}</small></div>`).join('')
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
      this.qa('[data-a=trade-start], [data-a=hot-scan], [data-a=hot-top], [data-a=hot-add]').forEach((el) => { el.disabled = on; });
      const ts = this.q('[data-a=trade-start]');
      if (ts) ts.textContent = on ? (engine.cfg.mode === 'trade' ? 'Trading… (■ to stop)' : 'Sniping… (■ to stop)') : 'Start trading';
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
      while (box.childNodes.length > 300) box.lastChild.remove();
      const last = this.q('[data-r=last]');
      if (last) { last.textContent = msg; last.className = `last ${cls}`; }
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
      const saved = store.get(KEYS.ui, {}).handleTop;
      if (saved) this.root.style.setProperty('--fcs-top', `${saved}px`);
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        const cls = this.root.classList;
        if (cls.contains('mob') && cls.contains('min')) return this.dragHandle(e);
        if (cls.contains('mob')) return;
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
