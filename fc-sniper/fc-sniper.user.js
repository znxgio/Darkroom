// ==UserScript==
// @name         FC Sniper
// @namespace    https://github.com/znxgio/darkroom
// @version      2.5.0
// @description  Sniper, pack opener, SBC solver and team upgrade advisor for the EA SPORTS FC Ultimate Team Web App, with built-in safety limits.
// @match        https://www.ea.com/*ultimate-team/web-app*
// @match        https://www.ea.com/ea-sports-fc/ultimate-team/web-app*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/znxgio/Darkroom/claude/ea-fc-sniping-bot-jdz6vq/fc-sniper/fc-sniper.user.js
// @updateURL    https://raw.githubusercontent.com/znxgio/Darkroom/claude/ea-fc-sniping-bot-jdz6vq/fc-sniper/fc-sniper.user.js
// ==/UserScript==

/*
 * Table of contents (search for the banner name; the file is one IIFE)
 *
 * Pure logic (unit-tested, exported as `core`)
 *   Priority list ............ ordering of targets
 *   Trading (resell) & bidding  flip plans, bid pricing, trade options
 *   Bid wars ................. bid-war caps and Buy Now vs war choice
 *   Market scanner ........... what's hot right now
 *   Buy history & notifications  purchase log, reports, Discord payloads
 *   Player name lookup ....... name search helpers
 *   Smart sniping ............ learns which discount and target pay off
 *   Market price check ....... findMarketPrice, robust (median) price
 *   Price history ............ cards the bot actually sees, trends
 *   Session plan ............. blocks, budget, floor
 *   Safety limits ............ delays, rests, session/daily caps, lockouts
 *   Squads: rating & chemistry
 *   Positions, formations & best lineup
 *   SBC solving .............. requirement parsing and fodder selection
 *   Points SBCs, Pack items
 *   Config defaults .......... DEFAULT_CONFIG, clamping, migration
 * Runtime (talks to the Web App and the page)
 *   Storage .................. saved settings and data
 *   Web App adapter .......... wraps services.Item.* and friends
 *   Player database .......... players.json name search
 *   Device helpers ........... phone layout, wake lock, sound, vibration
 *   Notifications, Engine .... the snipe loop and its state
 *   Tasks .................... Pack opener, SBC solver, Upgrade advisor
 *   Evolutions helper, Hot cards, Session plan (runtime side)
 *   UI ....................... panels, logs, setup checks
 */

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
      .filter((l) => !cfg.maxRating || (l.rating || 0) <= cfg.maxRating)
      .filter((l) => l.buyNowPrice <= coins)
      .sort((a, b) => a.buyNowPrice - b.buyNowPrice)
      .slice(0, Math.max(1, cfg.maxBuysPerSearch || 1));
  }

  /**
   * Price to relist a bought card at. Returns 0 when selling is off.
   *   profit — the lowest price that still clears Min profit after tax
   *   market — the player's price-checked market price (median of the 5 cheapest) (never below the profit floor)
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
    if (player && player.manualMax) return player.manualMax;
    if (player && player.maxBuy) return player.maxBuy;
    // Price-checked but nothing was listed: don't fall back to the default max (a rare card could be bought far over value).
    if (player && player.checkedAt && !player.avg) return 0;
    return cfg.maxBuy;
  }

  // ---- Priority list ----------------------------------------------------------------

  /** Coins the sniper may spend now: your coins minus Keep coins, capped by what's left of the spend limit. */
  function listSpendable(cfg, coins) {
    const own = coins - (cfg.minCoins || 0);
    const left = cfg.spendLimit > 0 ? cfg.spendLimit - (cfg.listSpent || 0) : Infinity;
    return Math.max(0, Math.min(own, left));
  }

  /**
   * "Keep coins for players higher on the list": buying player #idx at `price`
   * must leave enough for every unbought player above them.
   */
  function reserveOk(players, idx, price, spendable, cfg) {
    if (!cfg.reserveForHigher || idx <= 0) return true;
    const need = Math.max(0, ...players.slice(0, idx).map((p) => effectiveMaxBuy(p, cfg)));
    return spendable - price >= need;
  }

  /** After a list buy: count the spend and (Buy each once) drop the player. */
  function afterListBuy(cfg, playerId, price) {
    return {
      listSpent: (cfg.listSpent || 0) + price,
      players: cfg.buyOnce ? cfg.players.filter((p) => p.id !== playerId) : cfg.players,
    };
  }

  // ---- Trading (resell) & bidding ------------------------------------------------

  /**
   * Resale plan for a card: list `undercut`% under the market price so it
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
  /**
   * Plain advice for one card from what the bot saw (2.5.0). It only suggests — your settings never change by themselves.
   * o: { name, bin (Buy Now searches), hits, pct (your max, % under the cheapest), probes, near, nearPct (avg % under the cheapest
   *      of listings just above your max), ends (auction prices near the end, % under the cheapest), bidding }
   */
  function cardAdvice(o) {
    if (!o || (o.bin || 0) < 60) return '';
    const head = `💡 ${o.name}: ${o.hits || 0} bought in ${o.bin} searches at ${o.pct}% under`;
    if (o.hits > 0) return `${head} — it's landing; keep going`;
    const tips = [];
    if (o.near >= 3 && o.nearPct !== null && o.nearPct !== undefined && o.nearPct < o.pct - 0.5) {
      tips.push(`listings come in around ${Math.max(0, o.nearPct)}% under the cheapest — a Snipe % near ${Math.max(1, Math.round(o.nearPct))} would catch some (smaller saving each)`);
    } else if ((o.probes || 0) >= 10 && !o.near) {
      tips.push(`nothing came within 4% above your max in ${o.probes} checks — mistakes this deep are rare on this card; a cheaper or less popular card snipes better`);
    }
    const e = o.ends || [];
    if (e.length >= 3) {
      const avg = Math.round(e.reduce((a, x) => a + x, 0) / e.length * 10) / 10;
      if (avg >= o.pct) tips.push(`auctions end ~${avg}% under the cheapest${o.bidding ? '' : ' — turning on auction bidding may land one'}`);
      else tips.push(`auctions end ~${avg}% under the cheapest, above your max too`);
    }
    if (!tips.length) tips.push('no buys yet — give it more searches, or try a cheaper card');
    return `${head} · ${tips.join(' · ')}`;
  }

  /** Compare versions like "2.5.0" < "2.5.10". */
  function newerVersion(latest, current) {
    const a = String(latest || '').split('.').map(Number); const b = String(current || '').split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
    return false;
  }

  /**
   * Setup check (2.5.0): what looks off, each with an optional one-tap fix.
   * ctx: { coins, version, latest, targets, reachable, searchesLeft } → [{ level: 'ok'|'warn'|'info', text, fix? }]
   */
  function setupIssues(cfg, ctx) {
    const out = [];
    const n = (x) => Math.round(x || 0).toLocaleString('en-US');
    if (ctx.latest && newerVersion(ctx.latest, ctx.version)) out.push({ level: 'warn', text: `Running ${ctx.version} — ${ctx.latest} is out. Open the install link to update.`, fix: { type: 'update' } });
    else if (ctx.latest) out.push({ level: 'ok', text: `Running ${ctx.version} (latest)` });
    else out.push({ level: 'info', text: `Running ${ctx.version} (couldn't check for updates from here)` });
    if (!ctx.targets) out.push({ level: 'warn', text: 'No players or filters to snipe yet — add one on the Snipe tab' });
    else if (!ctx.reachable) out.push({ level: 'warn', text: 'Every player on your list costs more than your coins can reach — add cheaper cards or use 🎯 Snipe-friendly cards (Trade tab)' });
    if (!(cfg.minCoins > 0) && ctx.coins >= 20000) {
      const keep = Math.round(ctx.coins * 0.1 / 1000) * 1000;
      out.push({ level: 'warn', text: `Keep coins is 0 — the bot may spend everything. Keep ${n(keep)} back?`, fix: { type: 'keep', value: keep } });
    }
    if (!cfg.bidSnipe && cfg.mode !== 'alert') out.push({ level: 'info', text: 'Auction bidding is off — turning it on adds late bids and dry-spell auction turns', fix: { type: 'bid' } });
    if (ctx.searchesLeft !== undefined && ctx.searchesLeft < 50) out.push({ level: 'warn', text: `Only ${n(ctx.searchesLeft)} searches left today (raise Searches per day in Settings, up to 1,500)` });
    return out;
  }

  /**
   * The one-tap fix that goes with cardAdvice (2.5.0) — the user taps it, nothing changes by itself.
   * Same input as cardAdvice plus { ref (the cheapest), id } → { type: 'max', id, value, label } | { type: 'bid' } | { type: 'drop', id } | null
   */
  function adviceFix(o) {
    if (!o || (o.bin || 0) < 60 || o.hits > 0) return null;
    if (o.near >= 3 && o.nearPct !== null && o.nearPct !== undefined && o.nearPct < o.pct - 0.5 && o.ref > 0) {
      const pct = Math.max(1, Math.round(o.nearPct));
      return { type: 'max', id: o.id, pct, value: roundPrice(o.ref * (1 - pct / 100), 'down'), label: `Set ${o.name}'s max to ${pct}% under` };
    }
    const e = o.ends || [];
    if (e.length >= 3 && !o.bidding && e.reduce((a, x) => a + x, 0) / e.length >= o.pct) return { type: 'bid', label: 'Turn on auction bidding' };
    if ((o.probes || 0) >= 10 && !o.near) return { type: 'drop', id: o.id, label: `Remove ${o.name} from the list` };
    return null;
  }

  /**
   * SBC ranker (2.5.0): how likely a challenge is to come from your club, from the players that fit its rating/quality
   * rules (a quick check — the solver still has the final word). Returns 'club' | 'buys' | 'points' | 'manual'.
   */
  function sbcLikely(parsed, fitting) {
    if (!parsed) return 'manual';
    if (parsed.points) return 'points';
    if ((parsed.unsupported || []).length) return 'manual';
    return fitting >= (parsed.constraints.players || 11) ? 'club' : 'buys';
  }

  /** Order for the SBC list: likely from your club first (repeatables first), then needs buys, points, manual. */
  function sbcOrder(a, b) {
    const w = { club: 0, buys: 1, points: 2, manual: 3 };
    const ra = a.likely ? w[a.likely] : 4; const rb = b.likely ? w[b.likely] : 4;
    return ra - rb || (!!b.repeatable - !!a.repeatable) || 0;
  }

  /**
   * Coin goal for an SBC you can't afford yet (2.5.0): the buys + Keep coins, plus a buffer so it can be done again,
   * rounded up to 1,000. 120,000 with 12% → 135,000 (rounded up).
   */
  function coinGoal(cost, minCoins, bufferPct) {
    const buf = Math.min(100, Math.max(0, bufferPct ?? 12));
    return Math.ceil(((cost || 0) + (minCoins || 0)) * (1 + buf / 100) / 1000 - 1e-9) * 1000; // (no float overshoot)
  }

  /** One-line summary when a session ends. s: engine.stats; o: { minutes, near, bestHour } */
  function sessionReport(s, o = {}) {
    const n = (x) => Math.round(x || 0).toLocaleString('en-US');
    return `📊 Session${o.minutes ? ` (${o.minutes} min)` : ''}: ${n(s.searches)} searches · ${n(s.buys)} bought · ${n(s.missed)} lost to faster buyers`
      + `${o.near ? ` · ${n(o.near)} near misses` : ''} · spent ${n(s.spent)}${s.listed ? ` · ${n(s.listed)} listed · est. profit ${n(s.profit)}` : ''}`
      + `${o.bestHour !== undefined && o.bestHour !== null ? ` · best hour so far: ${o.bestHour}:00` : ''}`;
  }

  /** Why bidAmount() won't bid on an auction ('' = it would). */
  function bidSkipReason(l, maxBid, windowSec = 30) {
    if (!l || !(l.expires > 0)) return 'ended';
    if (l.expires > windowSec) return 'not ending yet';
    if (l.bidState === 'highest') return 'already highest';
    const next = l.currentBid > 0 ? nextPrice(l.currentBid) : Math.max(MIN_PRICE, l.startingBid || MIN_PRICE);
    if (next > maxBid) return 'next bid over your max';
    if (l.buyNowPrice && next >= l.buyNowPrice) return 'Buy Now is cheaper';
    return '';
  }

  function bidAmount(l, maxBid, windowSec = 30) {
    if (!l || !(l.expires > 0) || l.expires > windowSec) return 0;
    if (l.bidState === 'highest') return 0;
    const next = l.currentBid > 0 ? nextPrice(l.currentBid) : Math.max(MIN_PRICE, l.startingBid || MIN_PRICE);
    if (next > maxBid) return 0;
    if (l.buyNowPrice && next >= l.buyNowPrice) return 0; // Buy Now is the better move
    return next;
  }

  /** "4 min 12 s", "38 s", "2 h 5 min" */
  function shortTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    if (sec < 60) return `${sec} s`;
    if (sec < 3600) return `${Math.floor(sec / 60)} min${sec % 60 ? ` ${sec % 60} s` : ''}`;
    return `${Math.floor(sec / 3600)} h${Math.floor(sec % 3600 / 60) ? ` ${Math.floor(sec % 3600 / 60)} min` : ''}`;
  }

  /**
   * Live update after a Buy Now search (2.4.8): what came back and how close it was.
   * o: { n, name, max, searchMax, probe, listings: [{ buyNowPrice }], cheapest (price-checked) }
   */
  const num = (n) => Math.round(n || 0).toLocaleString('en-US');

  function searchReport(o) {
    const prices = (o.listings || []).map((l) => l.buyNowPrice).filter((x) => x > 0).sort((a, b) => a - b);
    const under = prices.filter((x) => x <= o.max).length;
    const head = `🔍 ${o.n}. ${o.name || 'filters'} ≤ ${num(o.max)}${o.probe ? ` (near-miss check up to ${num(o.searchMax)})` : ''}`;
    if (!prices.length) return `${head}: nothing listed at or under ${num(o.searchMax || o.max)}`;
    const gap = o.cheapest > 0 ? ` (${Math.round((1 - prices[0] / o.cheapest) * 1000) / 10}% under the usual cheapest)` : '';
    return `${head}: ${prices.length} listed · cheapest ${num(prices[0])}${gap}${under ? ` · ${under} under your max — buying` : ''}`;
  }

  /**
   * Live update after an auction search: how many auctions, which end soon, and why it does or doesn't bid.
   * o: { n, name, maxBid, windowSec, listings: [{ expires, currentBid, startingBid, buyNowPrice, bidState }] }
   */
  function auctionReport(o) {
    const ls = (o.listings || []).filter((l) => l.expires > 0).sort((a, b) => a.expires - b.expires);
    const head = `🔨 ${o.n}. Auctions ${o.name || 'filters'} ≤ ${num(o.maxBid)}`;
    if (!ls.length) return `${head}: none found`;
    const bidOf = (l) => (l.currentBid > 0 ? l.currentBid : l.startingBid || 0);
    const inWin = ls.filter((l) => l.expires <= o.windowSec);
    const mine = ls.filter((l) => l.bidState === 'highest').length;
    const soon = ls[0];
    const why = inWin.length
      ? `${inWin.length} ending within ${o.windowSec} s — bidding where the next bid fits your max`
      : `soonest ends in ${shortTime(soon.expires)} (bid ${num(bidOf(soon))}) — the bot bids in the last ${o.windowSec} s`;
    return `${head}: ${ls.length} seen${mine ? ` · you're highest on ${mine}` : ''} · ${why}`;
  }

  // ---- Bid wars ------------------------------------------------------------------------

  /**
   * Highest price a bid war may go to: a little above your normal max
   * (`bidWarStretchPct`), but never above the market price − 3% (Buy mode)
   * or the price that still leaves your min profit after tax (Trade mode),
   * and always under the card's Buy Now. 0 = no room.
   * w: { maxBid, avg, buyNow, mode, plan }
   */
  function warCeiling(w, cfg) {
    const stretch = 1 + Math.max(0, Math.min(25, cfg.bidWarStretchPct ?? 8)) / 100;
    let cap = roundPrice((w.maxBid || 0) * stretch, 'down');
    if (w.avg > 0) cap = Math.min(cap, roundPrice(w.avg * 0.97, 'down'));
    if (w.mode === 'trade') cap = w.plan && w.plan.maxBuy ? Math.min(cap, w.plan.maxBuy) : 0;
    if (w.buyNow > 0) cap = Math.min(cap, prevPrice(w.buyNow));
    return cap >= MIN_PRICE ? cap : 0;
  }

  /** How many bid steps are left between the current bid and the ceiling. */
  function warSteps(currentBid, ceiling) {
    let n = 0;
    for (let p = currentBid > 0 ? nextPrice(currentBid) : MIN_PRICE; p <= ceiling && n < 100; p = nextPrice(p)) n++;
    return n;
  }

  /**
   * Buy Now vs a bid war on the same player (the user's rule):
   *   'ideal' — Buy Now is extremely good (≥ binIdealPct under avg): buy it, even next to the war
   *   'war'   — the war's next bid is still ≥ warKeepPct under avg: keep fighting, skip the Buy Now
   *   'bin'   — otherwise Buy Now wins and the war is dropped
   */
  function binVsWar(binPrice, warNext, avg, cfg) {
    if (!(avg > 0)) return 'bin';
    const under = (p) => (avg - p) / avg * 100;
    if (under(binPrice) >= (cfg.binIdealPct ?? 20)) return 'ideal';
    if (warNext > 0 && under(warNext) >= (cfg.warKeepPct ?? 10)) return 'war';
    return 'bin';
  }

  /**
   * Coins free to spend while auction bids are open: coins minus Keep coins and
   * open bids, capped (Buy mode) by what's left of the spend limit.
   * bids: [{ amount, debited }] — debited = EA already took the coins off your balance.
   */
  function freeCoins(cfg, coins, bids) {
    const open = bids || [];
    const all = open.reduce((a, b) => a + b.amount, 0);
    const pending = open.reduce((a, b) => a + (b.debited ? 0 : b.amount), 0);
    const own = coins - pending - (cfg.minCoins || 0);
    const left = cfg.mode === 'buy' && cfg.spendLimit > 0 ? cfg.spendLimit - (cfg.listSpent || 0) - all : Infinity;
    return Math.max(0, Math.min(own, left));
  }

  /**
   * May we bid `amount` on `player`? Every open bid counts as a buy that may
   * still happen. Returns '' when allowed, else why not:
   *   buys (session limit) | once (Buy each player once) | coins (Keep coins / spend limit) | reserve (coins kept for higher players).
   * bids: open bids [{ amount, debited, player }]; sessionBuys: buys so far this session.
   */
  function bidBlock(amount, player, cfg, coins, bids, sessionBuys) {
    const open = bids || [];
    if (sessionBuys + open.length >= cfg.maxBuys) return 'buys';
    const listed = cfg.mode === 'buy' && player && player.kind !== 'filter';
    if (listed && cfg.buyOnce && (!(cfg.players || []).some((p) => p.id === player.id) || open.some((b) => b.player && b.player.id === player.id))) return 'once';
    const free = freeCoins(cfg, coins, open);
    if (amount > free) return 'coins';
    if (listed && !reserveOk(cfg.players || [], (cfg.players || []).findIndex((p) => p.id === player.id), amount, free, cfg)) return 'reserve';
    return '';
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
      return { id: c.id, name: c.name, rating: c.rating, count: bins.length, bids: c.bids, minBin: bins[0], medianBin: bins[Math.floor(bins.length / 2)], bins };
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

  /**
   * How friendly a card is to a bot that searches every few seconds: wide gaps between
   * the cheapest and the typical listing mean people misprice it; a tight market
   * (everything within ~2%) is eaten by faster bots. c: aggregateListings entry (with bins).
   * -> { score 0-100, spread, deep, suggest (Snipe %, 3-12), reason }
   */
  function snipeScore(c, opts = {}) {
    const none = { score: 0, spread: 0, deep: 0, suggest: 0, reason: '' };
    const budget = opts.budget || Infinity;
    if (!c || c.count < (opts.minListings || 4) || !(c.medianBin > 0) || c.minBin > budget) return none;
    const spread = (c.medianBin - c.minBin) / c.medianBin;
    if (spread < 0.02) return { ...none, spread };
    const bins = c.bins || [c.minBin];
    const deep = bins.filter((b) => b <= c.medianBin * 0.95).length;
    const score = Math.min(100, Math.round(Math.min(spread, 0.2) * 300 + Math.min(deep, 5) * 8));
    const suggest = Math.max(3, Math.min(12, Math.round((spread * 100) / 2)));
    return { score, spread, deep, suggest, reason: `${deep} of ${c.count} listings ≥ 5% under the usual price` };
  }

  /**
   * Narrow price bands for a market sweep, from the budget down to ~8% of it.
   * Narrow bands make copies of the same card show up together (EA returns
   * only ~20 listings a page, so a wide band shows 20 different cards once).
   */
  function priceBands(budget, n = 5, floorPct = 0.08) {
    const top = roundPrice(budget, 'down');
    if (top < 1000) return [];
    const ratio = Math.pow(1 / floorPct, 1 / n);
    const out = [];
    let hi = top;
    for (let i = 0; i < n; i++) {
      const lo = roundPrice(hi / ratio, 'down');
      if (lo < 400 || lo >= hi) break;
      out.push([lo, hi]);
      hi = prevPrice(lo);
    }
    return out;
  }

  /**
   * Cards you've already flipped for a profit (from your buy history, last
   * `days` days): the most reliable source of trades. Best total profit first.
   */
  function provenFlips(history, now, days = 14) {
    const m = new Map();
    for (const e of history || []) {
      if (!e || !e.soldFor || !e.id || now - (e.soldAt || e.at || 0) > days * 864e5) continue;
      const pr = afterTax(e.soldFor) - e.price;
      const c = m.get(e.id) || { id: e.id, name: e.name, rating: e.rating, flips: 0, wins: 0, profit: 0, hours: 0, timed: 0 };
      c.flips++; c.profit += pr; if (pr > 0) c.wins++;
      if (e.soldAt && e.at) { c.hours += (e.soldAt - e.at) / 36e5; c.timed++; }
      m.set(e.id, c);
    }
    return [...m.values()].filter((c) => c.wins > 0 && c.profit > 0)
      .map((c) => ({ id: c.id, name: c.name, rating: c.rating, flips: c.flips, wins: c.wins, profit: c.profit, avgHours: c.timed ? Math.round(c.hours / c.timed * 10) / 10 : null }))
      .sort((a, b) => b.profit - a.profit);
  }

  /**
   * Final ranking of price-checked cards: profit per flip, weighted by how
   * liquid the card is (copies listed) and how much demand it showed (live bids),
   * with a bonus for cards you've flipped before. c: { plan, listed, bids, count, proven }.
   */
  function flipValue(c) {
    if (!c.plan) return 0;
    const liquid = Math.min(1, (c.listed || 0) / 8);
    const demand = c.count ? Math.min(1, (c.bids || 0) / c.count) : 0;
    return Math.round(c.plan.profit * (0.3 + 0.7 * liquid) * (1 + demand) * (c.proven ? 1.5 : 1));
  }

  /**
   * Cheapest price seen per rating, made consistent: a rating never costs more
   * than a higher one. listings: [{ rating, price }] → { [rating]: price }.
   */
  function priceLadder(listings) {
    const m = {};
    for (const l of listings || []) if (l && l.rating && l.price > 0 && (!m[l.rating] || l.price < m[l.rating])) m[l.rating] = l.price;
    const rs = Object.keys(m).map(Number).sort((a, b) => b - a);
    let min = Infinity;
    for (const r of rs) { min = Math.min(min, m[r]); m[r] = min; }
    return m;
  }

  /**
   * Rough coin cost of an SBC bought from the market: each challenge solved
   * with cheapest-per-rating cards. challenges: parsed constraints.
   * Returns { cost, solved, unknown }.
   */
  function sbcCostEstimate(challenges, ladder) {
    const pool = [];
    for (const [r, price] of Object.entries(ladder || {})) for (let i = 0; i < 11; i++) pool.push({ id: `${r}-${i}`, rating: Number(r), rare: true, cost: price });
    let cost = 0; let solved = 0; let unknown = 0;
    for (const k of challenges || []) {
      const sol = pool.length ? solveSbc(pool, { minOvr: 0, maxOvr: 99, minQuality: 0, maxQuality: 9, rareMin: 0, teamRating: 0, ...k }) : null;
      if (sol) { cost += sol.cost; solved++; } else unknown++;
    }
    return { cost, solved, unknown };
  }

  /** Most coins Trade mode may put into one card: Max coins per card and/or a % of your coins above Keep coins. */
  function tradeCap(cfg, coins) {
    const free = Math.max(0, coins - (cfg.minCoins || 0));
    let cap = cfg.tradeBudget > 0 ? cfg.tradeBudget : Infinity;
    if (cfg.tradeBudgetPct > 0) cap = Math.min(cap, free * Math.min(100, cfg.tradeBudgetPct) / 100);
    return Math.min(cap, free);
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
  function searchPlayers(db, query, limit = 12) {
    const q = normalizeName(query);
    if (!q) return [];
    const tokens = q.split(' ');
    const scored = [];
    for (const p of db) {
      const words = p.key.split(' ');
      if (!tokens.every((t) => words.some((wd) => wd.startsWith(t)))) continue;
      let score = 0;
      if (p.nameKey === q) score = 4;
      else if (p.nameKey.startsWith(q)) score = 3;
      else if (tokens.every((t) => words.includes(t))) score = 2; // a whole surname/first name, e.g. "thompson" for Gisele Thompson
      else if (p.key.includes(q)) score = 1;
      scored.push([score, p]);
    }
    scored.sort((a, b) => b[0] - a[0] || b[1].rating - a[1].rating || a[1].name.localeCompare(b[1].name));
    return scored.slice(0, limit).map(([, p]) => p);
  }

  /**
   * The different cards (versions) of one player seen in market listings, cheapest first per card.
   * listings: [{ defId, rating, rareflag, name, buyNowPrice }] → [{ defId, rating, rareflag, name, cheapest, count, base }]
   */
  function cardVersions(listings, wantBase) {
    const by = new Map();
    for (const l of listings || []) {
      if (!l.defId || (wantBase && (l.defId & 0xFFFFFF) !== wantBase && l.defId !== wantBase)) continue;
      const v = by.get(l.defId) || { defId: l.defId, rating: l.rating || 0, rareflag: l.rareflag || 0, name: l.name, cheapest: 0, count: 0, base: l.defId === wantBase };
      v.count++;
      if (l.buyNowPrice > 0 && (!v.cheapest || l.buyNowPrice < v.cheapest)) v.cheapest = l.buyNowPrice;
      by.set(l.defId, v);
    }
    return [...by.values()].sort((a, b) => b.rating - a.rating || a.cheapest - b.cheapest);
  }

  /** Common leagues by EA id (names shown when the Web App can't name them). */
  const LEAGUES = { 13: 'Premier League', 53: 'LALIGA', 19: 'Bundesliga', 31: 'Serie A', 16: 'Ligue 1', 10: 'Eredivisie', 308: 'Liga Portugal', 14: 'Championship', 68: 'Süper Lig', 4: '1A Pro League', 39: 'MLS', 350: 'Saudi Pro League', 2118: 'Icons' };

  /** One-line description of a search filter, e.g. "Gold · Rare · Premier League · 84–86 · ST". */
  function filterSummary(f, names = {}) {
    const parts = [];
    if (f.level && f.level !== 'any') parts.push(f.level[0].toUpperCase() + f.level.slice(1));
    if (f.rarity !== '' && f.rarity !== undefined && f.rarity !== null) parts.push(names.rarity || `rarity ${f.rarity}`);
    if (f.league) parts.push(names.league || LEAGUES[f.league] || `league ${f.league}`);
    if (f.nation) parts.push(names.nation || `nation ${f.nation}`);
    if (f.club) parts.push(names.club || `club ${f.club}`);
    if (f.minRating || f.maxRating) parts.push(f.minRating && f.maxRating ? (f.minRating === f.maxRating ? `${f.minRating}` : `${f.minRating}–${f.maxRating}`) : f.minRating ? `${f.minRating}+` : `≤ ${f.maxRating}`);
    if (f.position) parts.push(f.position);
    return parts.join(' · ') || 'Any player';
  }

  /** What the sniper hunts each round: your priority list, then every active search filter. */
  function sniperTargets(cfg) {
    return [...(cfg.players || []), ...(cfg.filters || []).filter((f) => f.on)];
  }

  /**
   * Is a snipe at `maxBuy` realistic? Not when your coins cap it far under the
   * cheapest listing (e.g. 241k for a 2.9M card): nobody lists that low, and the
   * searches are better spent on players you can buy.
   */
  function withinReach(maxBuy, lowest, pct = 0.6) {
    return !lowest || maxBuy >= lowest * pct;
  }

  // ---- Smart sniping: learns which discount and which target pay off ----------------

  /** Discount levels (% under the market price) the learner can pick from. */
  function smartLevels(minPct = 4, maxPct = 14) {
    const lo = Math.max(1, Math.min(30, Math.round(minPct)));
    const hi = Math.max(lo, Math.min(40, Math.round(maxPct)));
    const out = [];
    for (let d = lo; d <= hi; d += 2) out.push(d);
    if (out[out.length - 1] !== hi) out.push(hi);
    return out;
  }

  /** Gamma(k, 1) sample (Marsaglia–Tsang), for Beta sampling. rand() in [0, 1). */
  function gammaSample(k, rand = Math.random) {
    if (k < 1) return gammaSample(k + 1, rand) * Math.pow(rand() || 1e-12, 1 / k);
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (let i = 0; i < 100; i++) {
      let x; let v;
      do {
        // Box–Muller normal
        x = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = rand() || 1e-12;
      if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
    }
    return k;
  }
  function betaSample(a, b, rand = Math.random) {
    const x = gammaSample(a, rand);
    const y = gammaSample(b, rand);
    return x / (x + y || 1);
  }

  // Learner design (debate 2026-11-12, observer's closing view): one 0..1 score per search,
  // a pessimistic prior that falls with depth, near misses on their own counters, lazy decay.
  const LEARN_HALF_LIFE_DAYS = 7;
  const LEARN_MIN_N = 30;

  /** Prior for an arm: Beta(0.5, 25·d/4) — ~2% chance per search at 4% under avg, less for deeper discounts. */
  function armPrior(d) {
    return { a: 0.5, b: 25 * Math.max(1, d) / 4 };
  }

  /**
   * Old evidence fades: counts halve every 7 days since the arm was last
   * updated, but never below ~30 searches' worth (hits are rare; don't throw
   * all evidence away). Pure: returns a decayed copy.
   */
  function decayArm(arm, now) {
    const a = { n: 0, good: 0, near: 0, probes: 0, ...(arm || {}) };
    if (!a.last || !now || now <= a.last || !a.n) return a;
    let f = Math.pow(0.5, (now - a.last) / 864e5 / LEARN_HALF_LIFE_DAYS);
    if (a.n * f < LEARN_MIN_N) f = Math.min(1, LEARN_MIN_N / a.n);
    return { ...a, n: a.n * f, good: a.good * f, near: a.near * f, probes: a.probes * f };
  }

  /** Arms saved by older versions counted per listing; turn them into per-search scores. */
  function upgradeArm(arm) {
    if (!arm || arm.good !== undefined) return arm;
    const n = arm.n || 0;
    return { ...arm, good: Math.min(n, (arm.hits || 0) + 0.8 * (arm.misses || 0)), near: 0, probes: 0 };
  }

  /** Small bonus from near misses (listings just above this arm's price), from their own counters. */
  function nearBonus(a) {
    return 0.35 * ((a.near || 0) + 0.1) / ((a.probes || 0) + 5) / 100;
  }

  /** Posterior mean chance of a good search on an arm (for display and tests). */
  function armRate(arm, d, now) {
    const a = decayArm(upgradeArm(arm), now);
    const pr = armPrior(d);
    return (pr.a + a.good) / (pr.a + pr.b + a.n) + nearBonus(a);
  }

  /**
   * Pick a discount for a target by Thompson sampling: sample each arm's
   * chance of a good search, times how much it saves (the discount).
   * Returns { pct, ev }.
   */
  function chooseDiscount(arms, levels, rand = Math.random, now = 0) {
    let best = null;
    for (const d of levels) {
      const a = decayArm(upgradeArm((arms && arms[d]) || {}), now);
      const pr = armPrior(d);
      const good = Math.min(a.good, a.n);
      const p = betaSample(pr.a + good, pr.b + a.n - good, rand) + nearBonus(a);
      // With no buy, lost race or near miss yet, a deeper discount saves nothing: score it at the
      // shallowest level, so dry spells don't push the learner deeper (2.4.6 debate finding).
      const ev = p * (good > 0 || (a.near || 0) > 0 ? d : levels[0]);
      if (!best || ev > best.ev) best = { pct: d, ev };
    }
    return best;
  }

  /**
   * Which target to search next: the best sampled coins saved per search,
   * weighted by the square root of the price (so cheap targets still get
   * searches); 1 search in 10 rotates across all targets to keep exploring.
   * target: { key, avg, arms }.
   */
  function chooseTarget(targets, levels, rand = Math.random, now = 0) {
    if (targets.length > 1 && rand() < 0.1) {
      const t = targets[Math.floor(rand() * targets.length) % targets.length];
      return { target: t, pct: chooseDiscount(t.arms, levels, rand, now).pct, value: 0, rotated: true };
    }
    let best = null;
    for (const t of targets) {
      const pick = chooseDiscount(t.arms, levels, rand, now);
      const value = pick.ev / 100 * Math.sqrt(Math.max(1000, t.avg || 0));
      if (!best || value > best.value) best = { target: t, pct: pick.pct, value };
    }
    return best;
  }

  /**
   * Probe data (2.4.6): each near-miss check stores how far under the cheapest the closest
   * listing above your max was (null = nothing within 4% above it). Last 40, 7 days.
   * Returns the new list of [time, pctUnderCheapest|null].
   */
  function recordGap(gaps, nearPrice, ref, now) {
    const pct = nearPrice > 0 && ref > 0 ? Math.round((1 - nearPrice / ref) * 1000) / 10 : null;
    return [...(gaps || []), [now, pct]].filter((g) => now - g[0] < 7 * 864e5).slice(-40);
  }

  /** Summary of probe data: { probes, near, avgPct } (avgPct = mean % under the cheapest of the near misses). */
  function gapStats(gaps) {
    const g = gaps || [];
    const near = g.filter((x) => x[1] !== null && x[1] !== undefined);
    return { probes: g.length, near: near.length, avgPct: near.length ? Math.round(near.reduce((a, x) => a + x[1], 0) / near.length * 10) / 10 : null };
  }

  /** How much a lost race counts: 0.8 × your race-win rate (from the speed totals), never under 0.25 of that. */
  function missWeight(speed) {
    const n = (speed && speed.n) || 0;
    const wins = n - ((speed && speed.lost) || 0);
    return 0.8 * Math.max(0.25, (wins + 1) / (n + 2));
  }

  /**
   * Records one search on an arm (decaying it first).
   * outcome: { hit, miss } listing counts → one score per search: 1 for a buy,
   * missWeight for a lost race, 0 otherwise. Probe searches also count near
   * misses: `nearArm` (the deepest arm whose price would have caught the
   * listing) gets near+1, `probeArm` gets probes+1.
   */
  function recordArm(arms, pct, outcome = {}) {
    const now = outcome.at || 0;
    const out = { ...(arms || {}) };
    const touch = (d) => { const a = { hits: 0, misses: 0, ...decayArm(upgradeArm(out[d]), now) }; a.last = now; out[d] = a; return a; };
    const a = touch(pct);
    a.n++;
    const score = outcome.hit ? 1 : outcome.miss ? (outcome.missWeight ?? 0.8) : 0;
    a.good += score;
    a.hits += outcome.hit ? 1 : 0;
    a.misses += !outcome.hit && outcome.miss ? 1 : 0;
    if (outcome.probeArm !== undefined) touch(outcome.probeArm).probes++;
    if (outcome.nearArm !== undefined) touch(outcome.nearArm).near++;
    return out;
  }

  /** The deepest level whose price (avg × (1 − d%)) would have caught a listing at `price`. */
  function deepestArmFor(price, avg, levels) {
    if (!(avg > 0) || !(price > 0)) return undefined;
    const under = (avg - price) / avg * 100;
    const ok = levels.filter((d) => d <= under);
    return ok.length ? ok[ok.length - 1] : undefined;
  }

  /** Halve a target's evidence when its market price moved more than 15% since it was learned. */
  function priceShifted(refAvg, avg) {
    return refAvg > 0 && avg > 0 && Math.abs(avg - refAvg) / refAvg > 0.15;
  }

  /** The arm with the best expected saving (same model as the sampler, for display). */
  function bestArm(arms, levels, now = 0) {
    let best = null;
    for (const d of levels) {
      const raw = arms && arms[d];
      if (!raw || !raw.n) continue;
      const score = armRate(raw, d, now) * d;
      if (!best || score > best.score) best = { pct: d, score, ...upgradeArm(raw) };
    }
    return best;
  }

  /** Players and filters the sniper hunts: out-of-reach players are left out. */
  function huntTargets(cfg) {
    const list = sniperTargets(cfg).filter((p) => !p.outOfReach || p.manualMax);
    // trading toward an SBC coin goal flips hot cards only — never the players on your own list
    return cfg.goal && cfg.mode === 'trade' ? list.filter((p) => p.hot) : list;
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
    // 2.4.2: new trade defaults (debate) — only where you still had the old default
    if (!out.trade242) {
      if (out.minProfitPct === 3) out.minProfitPct = 4;
      if (out.listDuration === 3600 || out.listDuration === '3600') out.listDuration = 10800;
      if (out.maxBuys === 10) out.maxBuys = 12;
      out.trade242 = true;
    }
    // 2.4.4: price checks every 30 min (sooner when the market drops) — only if you had the old default
    if (!out.reprice244) { if (out.repriceMinutes === 15) out.repriceMinutes = 30; out.reprice244 = true; }
    // 2.4.6: the user picked 4% under the cheapest (was 10% under the market) — only if you had the old default
    if (!out.snipe246) { if (out.discount === 10 || out.discount === '10') out.discount = 4; out.snipe246 = true; }
    // 2.4.8: bid window 30 → 45 s (debate) — only if you had the old default
    if (!out.bid248) { if (out.bidWindow === 30 || out.bidWindow === '30') out.bidWindow = 45; out.bid248 = true; }
    // 2.4.0: the user asked for auction bidding to be switched on (once; they can turn it off again)
    if (!out.bidOn240) { out.bidSnipe = true; out.bidOn240 = true; }
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
   * the median of the `sample` cheapest Buy Now prices (see robustPrice), rounded to a valid price.
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
    return { ok: true, count: prices.length, lowest: prices[0], avg: robustPrice(prices, sample), ...robustLow(prices), steps };
  }

  // ---- Price history (cards the bot actually sees) ---------------------------------

  /**
   * Adds one price sample for a card. Samples within the same hour replace
   * each other; samples older than 7 days drop off. Pure: returns a new store.
   * store: { [id]: { n: name, r: rating, s: [[t, lowest, listed]] } }
   */
  function addPriceSample(store, id, meta, lowest, listed, now) {
    if (!id || !(lowest > 0)) return store || {};
    const out = { ...(store || {}) };
    const c = out[id] ? { ...out[id], s: out[id].s.slice() } : { n: meta.name, r: meta.rating, s: [] };
    if (meta.name) c.n = meta.name;
    const last = c.s[c.s.length - 1];
    if (last && now - last[0] < 3600e3) c.s[c.s.length - 1] = [now, lowest, listed || 0];
    else c.s.push([now, lowest, listed || 0]);
    c.s = c.s.filter((x) => now - x[0] < 7 * 864e5).slice(-60);
    out[id] = c;
    return out;
  }

  /** Keeps the price store under ~`maxBytes` (drops cards not seen for the longest). */
  function prunePrices(store, maxBytes = 400000) {
    let ids = Object.keys(store || {});
    let size = JSON.stringify(store || {}).length;
    if (size <= maxBytes) return store;
    ids.sort((a, b) => (store[a].s.at(-1)?.[0] || 0) - (store[b].s.at(-1)?.[0] || 0));
    const out = { ...store };
    while (size > maxBytes && ids.length) { const k = ids.shift(); size -= JSON.stringify(out[k]).length + k.length + 4; delete out[k]; }
    return out;
  }

  /**
   * Price trend from a card's samples: only with ≥ 4 samples over ≥ 24 h,
   * otherwise "not enough data". Returns { n, thin, pct, spanH, spark }.
   */
  function priceTrend(samples, now) {
    const s = (samples || []).filter((x) => x && x[1] > 0);
    const n = s.length;
    if (!n) return { n: 0, thin: true };
    const spanH = (s[n - 1][0] - s[0][0]) / 36e5;
    const vals = s.map((x) => x[1]);
    const lo = Math.min(...vals); const hi = Math.max(...vals);
    const bars = '▁▂▃▄▅▆▇█';
    const spark = vals.slice(-12).map((v) => bars[hi > lo ? Math.round((v - lo) / (hi - lo) * 7) : 3]).join('');
    if (n < 4 || spanH < 24) return { n, thin: true, spanH, spark };
    const first = vals.slice(0, Math.ceil(n / 3)).reduce((a, b) => a + b, 0) / Math.ceil(n / 3);
    const lastN = vals.slice(-Math.ceil(n / 3)).reduce((a, b) => a + b, 0) / Math.ceil(n / 3);
    return { n, thin: false, spanH, spark, pct: Math.round((lastN - first) / first * 100) };
  }

  /** "↑ 6% · 3 d · ▂▃▅▇" or "new — not enough data yet". */
  function trendText(t) {
    if (!t || !t.n) return '';
    if (t.thin) return `seen ${t.n}× — not enough data for a trend yet`;
    const arrow = t.pct >= 3 ? '↑' : t.pct <= -3 ? '↓' : '→';
    return `${arrow} ${t.pct > 0 ? '+' : ''}${t.pct}% over ${t.spanH >= 48 ? `${Math.round(t.spanH / 24)} d` : `${Math.round(t.spanH)} h`} · ${t.spark} · seen ${t.n}×`;
  }

  /** A web search for the card on FUT.GG (opened by the user in Safari; the bot never reads the site). */
  function lookupUrl(name) {
    return `https://www.google.com/search?q=${encodeURIComponent(`${name} FC 27 site:fut.gg`)}`;
  }

  /**
   * Where today's searches go: price checks cost ~5 searches per target every
   * `repriceMinutes`; the rest hunt. Returns { left, perHour, pricingPerHour, huntPerHour, pricingShare }.
   */
  function searchBudget(cfg, usedToday, targets) {
    const left = Math.max(0, (cfg.searchesPerDay || 0) - (usedToday || 0));
    const avgDelay = ((cfg.delayMin || 3000) + (cfg.delayMax || 4500)) / 2 / 1000 + 0.5;
    const restPer = (cfg.pauseEvery > 0 ? ((cfg.pauseMin || 0) + (cfg.pauseMax || 0)) / 2 / 1000 / cfg.pauseEvery : 0);
    const perHour = Math.round(3600 / (avgDelay + restPer));
    const pricingPerHour = cfg.autoPrice ? Math.round((targets || 0) * 5 * 60 / Math.max(5, cfg.repriceMinutes || 30)) : 0;
    const huntPerHour = Math.max(0, perHour - pricingPerHour);
    return { left, perHour, pricingPerHour, huntPerHour, pricingShare: perHour ? pricingPerHour / perHour : 0 };
  }

  /**
   * The market price from the cheapest listings: the median of the `sample`
   * cheapest (one dumped or overpriced listing can't drag it), ignoring a
   * lone lowest listing more than 30% under the next one (a mistake, not the market).
   */
  function robustPrice(prices, sample = 5) {
    let p = (prices || []).filter((x) => x > 0).sort((a, b) => a - b);
    if (p.length >= 3 && p[0] < p[1] * 0.7) p = p.slice(1);
    const cheapest = p.slice(0, sample);
    if (!cheapest.length) return 0;
    const m = Math.floor(cheapest.length / 2);
    const med = cheapest.length % 2 ? cheapest[m] : (cheapest[m - 1] + cheapest[m]) / 2;
    return roundPrice(med, 'nearest');
  }

  /**
   * Max buy for a player: `discountPct` under the market price, but never
   * more than the coins you can spend. Returns { maxBuy, cappedByCoins }.
   */
  // ---- Session plan (2.4.7, debate) ------------------------------------------------

  /** Coins never go below this during a plan: the higher of Keep coins and (coins at start − budget). */
  function planFloor(startCoins, budget, minCoins) {
    return Math.max(minCoins || 0, (startCoins || 0) - Math.max(0, budget || 0));
  }

  /** Budget in coins from a % of your coins at the start. */
  function planBudget(startCoins, pct) {
    return Math.max(0, Math.round((startCoins || 0) * Math.min(50, Math.max(0, pct || 0)) / 100));
  }

  /** How a sniper block ended: 'next' (a normal block end) or 'end' (anything else ends the whole plan). */
  function planVerdict(reason, lockedUntil, now) {
    if (lockedUntil > now) return 'end';
    return /min session limit|session search limit|session buy limit/i.test(reason || '') ? 'next' : 'end';
  }

  /** One-line summary shown before a plan starts. */
  function planSummary(cfg, coins) {
    const blocks = Math.max(1, cfg.planBlocks || 1);
    const totalMin = blocks * (cfg.planBlockMin || 0) + (blocks - 1) * (cfg.planBreakMin || 0);
    const budget = planBudget(coins, cfg.planBudgetPct);
    const floor = planFloor(coins, budget, cfg.minCoins);
    const sbcs = (cfg.planSbcs || []).length;
    return { blocks, totalMin, budget, floor, text: `${blocks} × ${cfg.planBlockMin} min sniping, ${cfg.planBreakMin} min breaks · about ${formatDuration(totalMin * 60e3)} · can spend up to ${budget.toLocaleString('en-US')} · never below ${floor.toLocaleString('en-US')} · up to ${cfg.searchesPerDay} searches today${sbcs ? ` · ${sbcs} SBC${sbcs === 1 ? '' : 's'} in the breaks (≤ ${cfg.planSbcMax} each break, ≤ ${(cfg.planSbcCoins || 0).toLocaleString('en-US')} coins each)` : ''}` };
  }

  /**
   * The cheapest real listing (a lone listing >30% under the next one is a mistake that's
   * about to be sniped, not the market) and the one after it. Returns { floor, second }.
   */
  function robustLow(prices) {
    let p = (prices || []).filter((x) => x > 0).sort((a, b) => a - b);
    if (p.length >= 3 && p[0] < p[1] * 0.7) p = p.slice(1);
    // one listing well under a tight cluster is about to be sniped: measure from the cluster
    else if (p.length >= 3 && p[0] < p[1] * 0.92 && p[2] <= p[1] * 1.03) p = p.slice(1);
    return { floor: p[0] || 0, second: p[1] || p[0] || 0 };
  }

  /** A falling price (≥ 24 h of history) snipes deeper: half the drop, at most 3 points. Rising prices change nothing. */
  function trendNudge(trend) {
    return trend && !trend.thin && trend.pct < 0 ? Math.min(3, Math.round(-trend.pct / 2)) : 0;
  }

  /**
   * What a snipe is measured from (2.4.6, debate): Buy mode — the cheapest real listing;
   * Trade mode — what it resells for: the lower of the market price and the 2nd-cheapest
   * listing, lowered by the trend nudge. m: { avg, floor, second, nudge }.
   */
  function snipeBase(m, mode) {
    if (!m || !(m.avg > 0)) return 0;
    if (mode === 'trade') {
      const r = Math.min(m.avg, m.second > 0 ? m.second : m.avg);
      return roundPrice(r * (1 - (m.nudge || 0) / 100), 'down');
    }
    return m.floor > 0 ? m.floor : m.avg;
  }

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
    if (cfg.bidWindow !== undefined) set('bidWindow', Math.min(90, Math.max(15, num('bidWindow') || 45)));
    if (cfg.planBlockMin !== undefined) {
      set('planBlocks', Math.min(8, Math.max(1, Math.round(num('planBlocks')) || 1)));
      set('planBlockMin', Math.min(SAFETY.maxSessionMinutes, Math.max(10, num('planBlockMin') || 60)));
      set('planBreakMin', Math.min(240, Math.max(20, num('planBreakMin') || 20)));
      set('planBudgetPct', Math.min(50, Math.max(0, num('planBudgetPct'))));
      set('planSbcMax', Math.min(10, Math.max(0, Math.round(num('planSbcMax')))));
      set('planSbcCoins', Math.min(50000, Math.max(0, num('planSbcCoins'))));
    }
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
        const cur = squad[slotIndex].player;
        // By meta: how much better the player is in this position by the stats that matter there.
        const playerGain = opts.by === 'meta'
          ? Math.round((metaScore(c, pos) - metaScore(cur, pos)) * 10) / 10
          : c.rating - ((cur && cur.rating) || 0);
        // Better player matters most, then team rating, then chemistry; owned players are free.
        const price = c.source === 'club' ? 0 : (c.price || 0);
        const score = ratingGain * 10 + playerGain * 3 + chemGain * 3 - price / Math.max(1000, opts.budget || 100000) * 4;
        return { ...c, ratingAfter, chemAfter, ratingGain, chemGain, playerGain, score, why: upgradeWhy(cur, c, pos, chemGain) };
      })
      // An upgrade is a better player, or the same level with more chemistry.
      .filter((c) => (c.playerGain > 0 || (c.chemGain > 0 && c.playerGain >= 0 && c.ratingGain >= 0))
        && (opts.allowChemLoss || c.chemGain >= -(opts.maxChemLoss ?? 2)))
      .sort((a, b) => b.score - a.score);
  }

  // ---- Positions, formations & best lineup -------------------------------------------

  /**
   * Evolutions your own cards can use right now (2.5.0): `matches` are [{ evo, player, group: 'xi'|'bench' }] where every
   * pairing already passed EA's own meetsRequirements check. Starting XI first; subs/reserves only to fill up to `max`.
   */
  function evoPicks(matches, max = 6) {
    const xi = matches.filter((m) => m.group === 'xi');
    const bench = matches.filter((m) => m.group !== 'xi');
    const byGain = (a, b) => (b.player.rating || 0) - (a.player.rating || 0);
    const out = xi.sort(byGain).slice(0, max);
    return out.length >= Math.min(3, max) ? out : out.concat(bench.sort(byGain).slice(0, max - out.length));
  }

  /**
   * Why a candidate is better (or not) than the current player in a position: meta PlayStyles gained, the biggest
   * changes in the stats that matter there, chemistry. Returns short phrases, most important first.
   */
  function upgradeWhy(cur, cand, pos, chemGain = 0) {
    const out = [];
    const have = new Set(metaPlayStyles(cur, pos).map((x) => x.name + (x.plus ? '+' : '')));
    const gained = metaPlayStyles(cand, pos).filter((x) => !have.has(x.name + (x.plus ? '+' : ''))).sort((a, b) => b.value - a.value);
    if (gained.length) out.push(`meta PlayStyles: ${gained.slice(0, 3).map((x) => x.name + (x.plus ? '+' : '')).join(', ')}`);
    const w = META_WEIGHTS[pos];
    if (w && cur && cur.stats && cand && cand.stats) {
      const keys = ['pac', 'sho', 'pas', 'dri', 'def', 'phy'];
      const label = { pac: 'pace', sho: 'shooting', pas: 'passing', dri: 'dribbling', def: 'defending', phy: 'physical' };
      const diffs = keys.map((k, i) => ({ k, d: (cand.stats[k] || 0) - (cur.stats[k] || 0), w: w[i] })).filter((x) => x.w >= 0.1 && Math.abs(x.d) >= 3)
        .sort((a, b) => Math.abs(b.d) * b.w - Math.abs(a.d) * a.w).slice(0, 2);
      for (const x of diffs) out.push(`${x.d > 0 ? '+' : ''}${x.d} ${label[x.k]}`);
    }
    if (chemGain) out.push(`chem ${chemGain > 0 ? '+' : ''}${chemGain}`);
    return out;
  }

  /** The base player behind any version of a card (specials add a prefix above 24 bits). */
  function baseId(defId) {
    const n = Number(defId) || 0;
    return n > 0xFFFFFF ? n & 0xFFFFFF : n;
  }

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
    // New in FC 27; EA's slot order isn't confirmed for it, so the coach compares it but doesn't create the squad.
    f4213: { label: '4-2-1-3', slots: ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'CDM', 'CAM', 'RW', 'ST', 'LW'], noCreate: true },
  };

  /**
   * Meta notes: what public FC 27 guides call meta, with source and date.
   * Curated by hand and shipped with script updates — the bot never reads these sites itself.
   * Sources disagree; the coach shows both and never claims a winner.
   */
  const META_NOTES = {
    asOf: '2026-10-21',
    formations: {
      f41212a: { tag: 'Called “the most meta”', tactic: 'Short Passing build-up · defensive line ~60', source: 'Liquid FC (ex-Team Gullit), 21 Oct 2026' },
      f4213: { tag: 'Called the meta at launch', tactic: 'Counter build-up · defensive line 55 (CDMs 45)', source: 'Dexerto launch guide' },
    },
    note: 'Guides disagree on #1 (others name 4-2-3-1 Wide or 4-4-2). Tactics are starting points — set them in game.',
  };

  /**
   * Which face stats matter for each position — a stat-based take on "meta"
   * (pace and dribbling up front, defending and physical at the back).
   * Weights per position: [PAC, SHO, PAS, DRI, DEF, PHY].
   */
  // FC 27 meta (2.5.0, researched 2026-11-14 from RealSport101 25 Sep / 16 Oct, FIFPlay, Dexerto, games.gg 6 Nov, fut.gg 29 Jul).
  // Face-stat weights [PAC, SHO, PAS, DRI, DEF, PHY] are priors from what guides say matters per position (no source gives
  // numbers). FC 27 made raw stats matter more than PlayStyles, so PlayStyle bonuses are kept modest.
  const META_GROUP = { ST: 'ST', CF: 'ST', RW: 'WING', LW: 'WING', RM: 'WING', LM: 'WING', CAM: 'CAM', CM: 'CM', CDM: 'CDM',
    RB: 'FB', LB: 'FB', RWB: 'FB', LWB: 'FB', CB: 'CB', GK: 'GK' };
  const META_GROUP_WEIGHTS = {
    ST: [0.25, 0.40, 0.05, 0.15, 0, 0.15], WING: [0.30, 0.20, 0.10, 0.30, 0, 0.10], CAM: [0.12, 0.20, 0.28, 0.28, 0, 0.12],
    CM: [0.10, 0.08, 0.32, 0.25, 0.12, 0.13], CDM: [0.08, 0.02, 0.25, 0.15, 0.30, 0.20], FB: [0.30, 0, 0.12, 0.13, 0.30, 0.15],
    CB: [0.20, 0, 0.05, 0.05, 0.40, 0.30],
  };
  const META_WEIGHTS = Object.fromEntries(Object.entries(META_GROUP).filter(([, g]) => META_GROUP_WEIGHTS[g]).map(([pos, g]) => [pos, META_GROUP_WEIGHTS[g]]));
  /** Meta PlayStyles per position group: [name, weight 0–1, PS+ especially wanted]. */
  const META_PS = {
    ST: [['Finesse Shot', 0.9, true], ['Low Driven Shot', 0.8, true], ['Quick Step', 0.6], ['Rapid', 0.6], ['First Touch', 0.5], ['Precision Header', 0.4], ['Power Shot', 0.3], ['Technical', 0.3]],
    WING: [['Finesse Shot', 0.8, true], ['Rapid', 0.8, true], ['Technical', 0.6], ['Quick Step', 0.6], ['First Touch', 0.5], ['Incisive Pass', 0.4], ['Low Driven Shot', 0.4], ['Whipped Pass', 0.4], ['Trickster', 0.3]],
    CAM: [['Finesse Shot', 0.8, true], ['Technical', 0.8, true], ['Incisive Pass', 0.7, true], ['First Touch', 0.5], ['Tiki Taka', 0.5], ['Low Driven Shot', 0.4], ['Quick Step', 0.4]],
    CM: [['Incisive Pass', 0.9, true], ['Pinged Pass', 0.8, true], ['Tiki Taka', 0.5], ['Technical', 0.5], ['Relentless', 0.5], ['Intercept', 0.4], ['Press Proven', 0.4], ['Long Ball Pass', 0.3]],
    CDM: [['Intercept', 0.9, true], ['Pinged Pass', 0.8, true], ['Anticipate', 0.6], ['Bruiser', 0.5], ['Press Proven', 0.4], ['Tiki Taka', 0.4], ['Incisive Pass', 0.4], ['Long Ball Pass', 0.4]],
    FB: [['Quick Step', 0.9, true], ['Bruiser', 0.7, true], ['Intercept', 0.6], ['Relentless', 0.5], ['Jockey', 0.5], ['Whipped Pass', 0.5], ['Anticipate', 0.4], ['Rapid', 0.4]],
    CB: [['Bruiser', 0.9, true], ['Intercept', 0.9, true], ['Anticipate', 0.6], ['Aerial Fortress', 0.5], ['Quick Step', 0.5], ['Jockey', 0.5], ['Block', 0.4]],
    GK: [['Far Reach', 0.9, true], ['Footwork', 0.8, true], ['Deflector', 0.5], ['Rush Out', 0.5], ['Cross Claimer', 0.3]],
  };

  /**
   * "Pros run this" (2.5.0): players that pros and top guides use per position group, from dated public sources
   * (research notes in docs/claude-notes.md). Names are matched loosely; refresh when the meta moves.
   */
  const PRO_PICKS = {
    asOf: '2026-11-14 (fut.gg most-used-by-pros page; u7buy 21 Oct; Red Bull 27 Oct; LWOS 11 Nov — GK/CB/FB lists thin, single listicles)',
    groups: {
      ST: ['Mbappé', 'Dembélé', 'Dumornay', 'Adeyemi', 'Chawinga', 'Raphinha', 'Shaw', 'Brobbey'],
      WING: ['Mbappé', 'Dembélé', 'Lamine Yamal', 'Diomande', 'Adeyemi', 'Claudia Pina', 'Barcola', 'Paralluelo'],
      CAM: ['Alexia Putellas', 'Aitana Bonmatí', 'Dumornay', 'Vicky López', 'Kika Nazareth', 'Bruno Fernandes', 'Lavelle', 'Wirtz'],
      CM: ['Karchaoui', 'Pedri', 'Stanway', 'Mariona', 'Xavi Espart', 'Valverde', 'Vitinha', 'Frenkie de Jong'],
      CDM: ['Stanway', 'Patri Guijarro', 'Karchaoui', 'Xavi Espart', 'Pedri', 'João Neves', 'Elliot Anderson'],
      FB: ['Xavi Espart', 'Ona Batlle', 'Selma Bacha', 'Carreras', 'Timber'],
      CB: ['Lacroix', 'Pacho', 'Upamecano', 'Roger Ibañez', 'Carreras', 'Eric García', 'Tomori', 'Khusanov'],
      GK: ['Joan García', 'Courtois', 'Emiliano Martínez', 'Kobel', 'Raya', 'Donnarumma'],
    },
  };

  /** Is this player on the pro-picks list for the position? */
  function proPick(p, pos) {
    const list = (PRO_PICKS.groups[META_GROUP[pos] || pos] || []);
    if (!p || !p.name || !list.length) return false;
    const norm = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s*\(.*\)$/, '').trim();
    const n = norm(p.name);
    return list.some((x) => { const k = norm(x); return n === k || n.endsWith(` ${k}`) || k.endsWith(` ${n}`); });
  }

  /**
   * Detailed attributes that matter per position group (weights sum to 1; priors from guides). Used only when the card
   * carries detailed stats (p.attrs, keys like acceleration/sprintSpeed…); otherwise face stats are used.
   */
  const DETAIL_W = {
    ST: { finishing: 0.2, acceleration: 0.14, sprintSpeed: 0.1, composure: 0.1, positioning: 0.1, strength: 0.08, agility: 0.08, shotPower: 0.08, ballControl: 0.06, reactions: 0.06 },
    WING: { acceleration: 0.16, sprintSpeed: 0.12, agility: 0.12, dribbling: 0.14, ballControl: 0.1, finishing: 0.1, composure: 0.08, crossing: 0.06, shortPassing: 0.06, balance: 0.06 },
    CAM: { shortPassing: 0.14, vision: 0.14, ballControl: 0.12, dribbling: 0.12, agility: 0.1, composure: 0.1, finishing: 0.08, longShots: 0.08, acceleration: 0.06, reactions: 0.06 },
    CM: { shortPassing: 0.16, longPassing: 0.12, vision: 0.12, ballControl: 0.1, composure: 0.1, stamina: 0.1, interceptions: 0.08, agility: 0.08, reactions: 0.07, strength: 0.07 },
    CDM: { interceptions: 0.16, defensiveAwareness: 0.14, standingTackle: 0.14, strength: 0.1, stamina: 0.1, shortPassing: 0.1, composure: 0.08, aggression: 0.06, longPassing: 0.06, reactions: 0.06 },
    FB: { acceleration: 0.14, sprintSpeed: 0.14, stamina: 0.12, interceptions: 0.1, standingTackle: 0.12, defensiveAwareness: 0.1, crossing: 0.08, strength: 0.06, agility: 0.06, shortPassing: 0.08 },
    CB: { defensiveAwareness: 0.16, standingTackle: 0.15, interceptions: 0.13, strength: 0.12, jumping: 0.08, headingAccuracy: 0.08, sprintSpeed: 0.1, acceleration: 0.06, composure: 0.06, aggression: 0.06 },
  };

  /**
   * Why one player scores what he does in a position (2.5.0): the parts of the meta score, for the compare view.
   * Returns { total, parts: [{ label, value }] }.
   */
  function scoreParts(p, pos) {
    if (!p) return { total: 0, parts: [] };
    const g = META_GROUP[pos] || pos;
    const parts = [];
    const dw = DETAIL_W[g];
    if (dw && p.attrs && Object.keys(dw).some((k) => p.attrs[k] > 0)) {
      parts.push({ label: 'key detailed stats', value: Math.round(Object.entries(dw).reduce((a, [k, w]) => a + (p.attrs[k] || 0) * w, 0) * 0.7 * 10) / 10 });
    } else if (META_WEIGHTS[pos] && p.stats) {
      const st = p.stats; const w = META_WEIGHTS[pos];
      parts.push({ label: 'face stats for the position', value: Math.round([st.pac, st.sho, st.pas, st.dri, st.def, st.phy].reduce((a, x, i) => a + (x || 0) * w[i], 0) * 0.7 * 10) / 10 });
    } else parts.push({ label: 'rating', value: Math.round((p.rating || 0) * 0.7 * 10) / 10 });
    parts.push({ label: 'overall', value: Math.round((p.rating || 0) * 0.3 * 10) / 10 });
    const ps = Math.min(4, metaPlayStyles(p, pos).reduce((a, x) => a + x.value, 0) * 1.2);
    if (ps) parts.push({ label: 'meta PlayStyles', value: Math.round(ps * 10) / 10 });
    if (ATTACKING.has(pos) && (p.skillMoves >= 4 || p.weakFoot >= 4)) parts.push({ label: 'skill moves / weak foot', value: (p.skillMoves >= 4 ? 1 : 0) + (p.weakFoot >= 4 ? 1 : 0) });
    if (proPick(p, pos)) parts.push({ label: 'pros run this', value: 2 });
    return { total: Math.round(parts.reduce((a, x) => a + x.value, 0) * 10) / 10, parts };
  }

  /**
   * Side-by-side rows for two players in one position (2.5.0). Returns { rows: [{ label, a, b, better: 'a'|'b'|'' }], a, b, winner }.
   */
  function comparePlayers(a, b, pos) {
    const rows = [];
    const row = (label, x, y, higher = true) => {
      const better = x === y || x === undefined || y === undefined || x === '' || y === '' ? '' : (higher ? (x > y ? 'a' : 'b') : (x < y ? 'a' : 'b'));
      rows.push({ label, a: x ?? '—', b: y ?? '—', better });
    };
    row('Rating', a.rating, b.rating);
    const keys = [['pac', 'Pace'], ['sho', 'Shooting'], ['pas', 'Passing'], ['dri', 'Dribbling'], ['def', 'Defending'], ['phy', 'Physical']];
    if (a.stats && b.stats) keys.forEach(([k, l]) => row(l, a.stats[k], b.stats[k]));
    const dw = DETAIL_W[META_GROUP[pos] || pos];
    if (dw && a.attrs && b.attrs) Object.keys(dw).forEach((k) => row(k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), a.attrs[k], b.attrs[k]));
    const ps = (p) => metaPlayStyles(p, pos).map((x) => x.name + (x.plus ? '+' : '')).join(', ') || '—';
    rows.push({ label: 'Meta PlayStyles', a: ps(a), b: ps(b), better: metaPlayStyles(a, pos).length === metaPlayStyles(b, pos).length ? '' : metaPlayStyles(a, pos).length > metaPlayStyles(b, pos).length ? 'a' : 'b' });
    if (a.accelerate || b.accelerate) rows.push({ label: 'AcceleRATE', a: a.accelerate || '—', b: b.accelerate || '—', better: '' });
    row('Skill moves', a.skillMoves || undefined, b.skillMoves || undefined);
    row('Weak foot', a.weakFoot || undefined, b.weakFoot || undefined);
    rows.push({ label: 'Pros run this', a: proPick(a, pos) ? 'yes' : '—', b: proPick(b, pos) ? 'yes' : '—', better: proPick(a, pos) === proPick(b, pos) ? '' : proPick(a, pos) ? 'a' : 'b' });
    const sa = scoreParts(a, pos); const sb = scoreParts(b, pos);
    row('Meta score', sa.total, sb.total);
    return { rows, a: sa, b: sb, winner: Math.abs(sa.total - sb.total) < 0.5 ? '' : sa.total > sb.total ? 'a' : 'b' };
  }

  /** The meta PlayStyles a player has for a position: [{ name, plus, value }] (value already weighted). */
  function metaPlayStyles(p, pos) {
    const list = META_PS[META_GROUP[pos] || pos];
    if (!list || !p || !(p.playStyles || []).length) return [];
    const norm = (x) => String(x || '').toLowerCase().replace(/\+$/, '').replace(/[^a-z]/g, '');
    const out = [];
    for (const [name, w, plusWanted] of list) {
      const hit = p.playStyles.find((x) => norm(x.name) === norm(name));
      if (hit) out.push({ name, plus: !!hit.plus, value: w * (hit.plus ? (plusWanted ? 2.2 : 1.6) : 1) });
    }
    return out;
  }
  const ATTACKING = new Set(['ST', 'CF', 'RW', 'LW', 'RM', 'LM', 'CAM']);

  /**
   * How good a player is in a position by the stats that matter there, on a
   * rating-like scale. Falls back to the card rating when stats aren't known.
   * p: { rating, stats: { pac, sho, pas, dri, def, phy }, skillMoves, weakFoot }
   */
  function metaScore(p, pos) {
    if (!p) return 0;
    const w = META_WEIGHTS[pos];
    const st = p.stats;
    if (!w || !st) return p.rating || 0;
    const v = [st.pac, st.sho, st.pas, st.dri, st.def, st.phy];
    let score = v.reduce((a, x, i) => a + (x || 0) * w[i], 0);
    if (ATTACKING.has(pos)) {
      if (p.skillMoves >= 4) score += 1;
      if (p.weakFoot >= 4) score += 1;
    } else if (pos === 'CM' && p.weakFoot >= 4) score += 0.5;
    // meta PlayStyles (2.5.0): a modest bonus — FC 27 rewards raw stats more than PlayStyles; at most +4
    const ps = Math.min(4, metaPlayStyles(p, pos).reduce((a, x) => a + x.value, 0) * 1.2);
    const pro = proPick(p, pos) ? 2 : 0; // "pros run this" (curated, dated list)
    // keep the card's overall in the picture so a 70-rated speedster doesn't win on pace alone
    return Math.round((score * 0.7 + (p.rating || 0) * 0.3 + ps + pro) * 10) / 10;
  }

  /**
   * Face stats, skill moves and weak foot from a Web App item, whatever the
   * field names are in this version. Returns { stats|null, skillMoves, weakFoot }.
   */
  function readStats(item) {
    const raw = item.attributes ?? item._attributes ?? item.attributeArray ?? (item._staticData && item._staticData.attributes);
    let stats = null;
    if (Array.isArray(raw) && raw.length >= 6) {
      const v = raw.slice(0, 6).map((a) => (typeof a === 'number' ? a : Number(a && (a.value ?? a.val ?? a.rating)) || 0));
      if (v.some((x) => x > 0)) stats = { pac: v[0], sho: v[1], pas: v[2], dri: v[3], def: v[4], phy: v[5] };
    }
    const num = (...xs) => { for (const x of xs) if (x !== undefined && x !== null && !Number.isNaN(Number(x))) return Number(x); return 0; };
    const ps = readPlayStyles(item);
    return {
      stats,
      skillMoves: num(item.skillMoves, item._skillMoves, item.skillmoves),
      weakFoot: num(item.weakFoot, item._weakFoot, item.weakFootAbilityTypeCode, item.weakfoot),
      playStyles: ps.styles, // [{ id, name, plus }] — best guess at EA's field names until the probe confirms them
      accelerate: ps.accelerate,
    };
  }

  /**
   * PlayStyles / PlayStyles+ and AcceleRATE from a Web App item, trying the field names EA has used (2.5.0, best guess —
   * the read-only "card fields" probe on the Squad tab records the real ones). Returns { styles, accelerate }.
   */
  function readPlayStyles(item) {
    const sd = (item && item._staticData) || {};
    const call = (o, f) => { try { return o && typeof o[f] === 'function' ? o[f]() : undefined; } catch { return undefined; } };
    const pick = (...xs) => xs.find((x) => Array.isArray(x) && x.length);
    const plain = pick(item && item.playStyles, item && item._playStyles, item && item.playstyles, call(item, 'getPlayStyles'), sd.playStyles, sd.playstyles, item && item.traits, sd.traits) || [];
    const plus = pick(item && item.playStylesPlus, item && item._playStylesPlus, item && item.iconTraits, call(item, 'getPlayStylesPlus'), sd.playStylesPlus, sd.iconTraits) || [];
    const norm = (x, isPlus) => {
      if (x === null || x === undefined) return null;
      if (typeof x === 'object') return { id: x.id ?? x.value ?? x.type ?? null, name: String(x.name ?? x.label ?? x.id ?? ''), plus: isPlus || !!(x.plus || x.isPlus || x.level === 2) };
      return { id: x, name: String(x), plus: isPlus };
    };
    const styles = [...plain.map((x) => norm(x, false)), ...plus.map((x) => norm(x, true))].filter(Boolean);
    const acc = item && (item.accelerateType ?? item._accelerateType ?? item.accelerate ?? sd.accelerateType ?? call(item, 'getAccelerateType'));
    return { styles, accelerate: acc === undefined || acc === null ? '' : String(acc) };
  }

  /** Read-only: the field names on a card that look like PlayStyles, roles or AcceleRATE (for the card-fields probe). */
  function cardFieldsProbe(item) {
    if (!item) return 'no card';
    const rx = /play|style|trait|role|accel|chem|icon|attr|stat|sprint|agil|stamina|strength|compos|finish|vision|tackl|intercept|bio/i;
    const own = Object.keys(item).filter((k) => rx.test(k)).map((k) => `${k}=${JSON.stringify(item[k]).slice(0, 80)}`);
    const sd = item._staticData ? Object.keys(item._staticData).filter((k) => rx.test(k)).map((k) => `sd.${k}=${JSON.stringify(item._staticData[k]).slice(0, 80)}`) : [];
    const fns = [];
    for (let o = Object.getPrototypeOf(item), d = 0; o && o !== Object.prototype && d < 4; o = Object.getPrototypeOf(o), d++) {
      for (const k of Object.getOwnPropertyNames(o)) if (rx.test(k) && typeof item[k] === 'function') fns.push(`${k}()`);
    }
    return [...own, ...sd, ...new Set(fns)].join(' · ').slice(0, 900) || 'nothing that looks like PlayStyles';
  }

  /** Squad rating with decimals (no rounding) — smooth enough to optimise against. */
  function squadRatingExact(ratings, size = 11) {
    const list = ratings.filter((r) => r > 0);
    if (!list.length) return 0;
    const sum = list.reduce((a, b) => a + b, 0);
    const avg = sum / size;
    return (sum + list.reduce((a, r) => a + Math.max(0, r - avg), 0)) / size;
  }

  /**
   * Score of a lineup. By 'meta': the position-weighted stats of each player;
   * by 'rating': the squad rating. Chemistry counts in both.
   */
  function lineupScore(lineup, slots, opts = {}) {
    const chemWeight = opts.chemWeight ?? 0.6;
    const ratings = lineup.map((p) => (p ? p.rating : 0));
    const chem = squadChemistry(lineup.map((p, i) => p && { ...p, inPosition: p.positions.includes(slots[i]) })).total;
    const metas = lineup.map((p, i) => metaScore(p, slots[i]));
    const meta = metas.reduce((a, b) => a + b, 0) / slots.length;
    const base = opts.by === 'meta' ? meta : squadRatingExact(ratings);
    return { score: base * 3 + chem * chemWeight, rating: squadRating(ratings), chem, meta: Math.round(meta * 10) / 10 };
  }

  /**
   * Best XI from your players for a formation: fills each slot with an
   * in-position player, then keeps swapping while rating + chemistry improves.
   * players: [{ id, rating, positions: [general names], nationId, leagueId, teamId }]
   */
  function bestLineup(players, slots, opts = {}) {
    const pool = players.filter((p) => p && p.rating > 0);
    const value = (p, pos) => (opts.by === 'meta' ? metaScore(p, pos) : p.rating);
    const fits = slots.map((pos) => pool.filter((p) => p.positions.includes(pos)).sort((a, b) => value(b, pos) - value(a, pos)).slice(0, opts.depth || 12));
    // Fill the scarcest positions first so a rare position isn't left empty.
    const order = slots.map((_, i) => i).sort((a, b) => fits[a].length - fits[b].length);
    const lineup = new Array(slots.length).fill(null);
    const used = new Set();
    for (const i of order) {
      const p = fits[i].find((x) => !used.has(x.id));
      if (p) { lineup[i] = p; used.add(p.id); }
    }
    let best = lineupScore(lineup, slots, opts);
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
          const sc = lineupScore(next, slots, opts);
          if (sc.score > best.score + 1e-9) { lineup.splice(0, lineup.length, ...next); best = sc; improved = true; }
        }
      }
      if (!improved) break;
    }
    return { lineup, rating: best.rating, chem: best.chem, meta: best.meta, score: best.score, filled: lineup.filter(Boolean).length };
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

  /** Solver cost of one coin spent on a market fill-in, relative to your own fodder's value. */
  const COIN_WEIGHT = 50;

  const QUALITY = { bronze: 1, silver: 2, gold: 3 };
  const qualityOf = (rating) => (rating >= 75 ? 3 : rating >= 65 ? 2 : 1);

  /**
   * Turns EA requirements into solver constraints.
   * reqs: [{ key: 'TEAM_RATING', scope: 'GREATER'|'LOWER'|'EXACT', values: [..], count }]
   * Requirements the solver can't satisfy yet are listed in `unsupported`.
   */
  function parseRequirements(reqs, playersRequired = 11) {
    const c = {
      players: playersRequired, teamRating: 0, teamRatingMax: 99, minOvr: 0, maxOvr: 99, minQuality: 0, maxQuality: 9,
      rareMin: 0, chemMin: 0, chemEachMin: 0,
      groups: { league: {}, nation: {}, club: {} }, // { sameMin, sameMax, distinctMin, distinctMax }
      idReqs: [], // [{ type: league|nation|club|rarity|quality, ids, min, max }]
      needsSearch: false,
    };
    const unsupported = [];
    // FC 27 reuses the Evolutions rule format: ACADEMY_PLAYER_SLOTTING (a minimum)
    // paired with PLAYER_ATTRIBUTE (which attribute; 1 = overall) — e.g. "OVR Min: 45".
    const attr = (reqs || []).find((r) => r.key === 'PLAYER_ATTRIBUTE');
    const GROUP = { SAME_LEAGUE_COUNT: 'league', SAME_NATION_COUNT: 'nation', SAME_CLUB_COUNT: 'club', LEAGUE_COUNT: 'league', NATION_COUNT: 'nation', CLUB_COUNT: 'club' };
    const IDS = { LEAGUE_ID: 'league', NATION_ID: 'nation', CLUB_ID: 'club', PLAYER_RARITY: 'rarity' };
    for (const r of reqs || []) {
      const vals = (r.values || []).map(Number);
      const v = vals[0];
      // count -1 means "every player"; so does a count that covers the whole squad ("11× Bronze")
      const all = !(r.count > 0) || r.count >= playersRequired;
      const lo = r.scope === 'LOWER';
      const ex = r.scope === 'EXACT';
      switch (r.key) {
        case 'TEAM_RATING':
          if (lo) c.teamRatingMax = Math.min(c.teamRatingMax, v);
          else if (ex) { c.teamRating = Math.max(c.teamRating, v); c.teamRatingMax = Math.min(c.teamRatingMax, v); }
          else c.teamRating = Math.max(c.teamRating, v);
          break;
        case 'ACADEMY_PLAYER_SLOTTING':
          if (!attr || Number(attr.values[0]) === 1) c.minOvr = Math.max(c.minOvr, v);
          else unsupported.push(`attribute ${attr.values[0]} minimum`);
          break;
        case 'PLAYER_ATTRIBUTE':
        case 'PLAYER_COUNT':
        case 'SCOPE':
        case 'PLAYER_TRADABILITY': // untradeables are allowed everywhere; tradeables only if you allow them
          break;
        case 'PLAYER_MIN_OVR': c.minOvr = Math.max(c.minOvr, v); break;
        case 'PLAYER_MAX_OVR': c.maxOvr = Math.min(c.maxOvr, v); break;
        case 'PLAYER_EXACT_OVR': c.minOvr = Math.max(c.minOvr, v); c.maxOvr = Math.min(c.maxOvr, v); break;
        case 'PLAYER_QUALITY':
        case 'PLAYER_LEVEL':
          if (!all) {
            if (lo) { unsupported.push('quality count'); break; }
            c.idReqs.push({ type: 'quality', ids: [v], min: r.count }); // "Min. 3 players: Gold"
            break;
          }
          if (r.scope === 'GREATER') c.minQuality = Math.max(c.minQuality, v);
          else if (lo) c.maxQuality = Math.min(c.maxQuality, v);
          else { c.minQuality = Math.max(c.minQuality, v); c.maxQuality = Math.min(c.maxQuality, v); }
          break;
        case 'PLAYER_RARITY_GROUP':
          if (lo) unsupported.push('max rares'); else c.rareMin = Math.max(c.rareMin, all ? playersRequired : r.count);
          break;
        case 'CHEMISTRY_POINTS':
          if (lo) unsupported.push('max chemistry'); else c.chemMin = Math.max(c.chemMin, v || 0);
          break;
        case 'ALL_PLAYERS_CHEMISTRY_POINTS':
          if (lo) unsupported.push('max chemistry'); else c.chemEachMin = Math.max(c.chemEachMin, v || 0);
          break;
        case 'SAME_LEAGUE_COUNT':
        case 'SAME_NATION_COUNT':
        case 'SAME_CLUB_COUNT': {
          const g = c.groups[GROUP[r.key]];
          if (lo) g.sameMax = Math.min(g.sameMax ?? 99, v);
          else { g.sameMin = Math.max(g.sameMin || 0, v); if (ex) g.sameMax = v; }
          break;
        }
        case 'LEAGUE_COUNT':
        case 'NATION_COUNT':
        case 'CLUB_COUNT': {
          const g = c.groups[GROUP[r.key]];
          if (lo) g.distinctMax = Math.min(g.distinctMax ?? 99, v);
          else { g.distinctMin = Math.max(g.distinctMin || 0, v); if (ex) g.distinctMax = v; }
          break;
        }
        case 'LEAGUE_ID':
        case 'NATION_ID':
        case 'CLUB_ID':
        case 'PLAYER_RARITY': {
          const n = all ? playersRequired : r.count;
          c.idReqs.push(lo ? { type: IDS[r.key], ids: vals, max: n } : { type: IDS[r.key], ids: vals, min: n });
          break;
        }
        default:
          unsupported.push(String(r.key || 'unknown').toLowerCase().replace(/_/g, ' '));
      }
    }
    const g = c.groups;
    c.needsSearch = !!(c.chemMin || c.chemEachMin || c.idReqs.length
      || ['league', 'nation', 'club'].some((t) => Object.keys(g[t]).length));
    return { constraints: c, unsupported: [...new Set(unsupported)] };
  }

  const GROUP_KEY = { league: 'leagueId', nation: 'nationId', club: 'teamId' };

  /**
   * Which card quality to look for on the market for an SBC — from its quality
   * rules or its rating limits ("each ≤ 64" means bronze, "65–74" silver).
   */
  function marketLevel(k) {
    const maxQ = Math.min(k.maxQuality ?? 9, k.maxOvr < 99 ? qualityOf(k.maxOvr) : 9);
    const minQ = Math.max(k.minQuality || 0, k.minOvr > 0 ? qualityOf(k.minOvr) : 0, k.teamRating >= 75 ? 3 : 0);
    if (minQ >= 3) return 'gold';
    if (maxQ === 1) return 'bronze';
    if (maxQ === 2) return 'silver';
    if (minQ === 2) return 'silver';
    return null;
  }

  /** Does a player count toward an id requirement? */
  function matchesReq(p, r) {
    if (r.type === 'quality') return qualityOf(p.rating) >= r.ids[0];
    if (r.type === 'rarity') return r.ids.includes(p.rareflag ?? (p.rare ? 1 : 0));
    return r.ids.includes(p[GROUP_KEY[r.type]]);
  }

  /**
   * Checks a squad against SBC constraints. lineup[i] plays slots[i] (a position).
   * Returns { ok, violation (how far off, 0 = ok), rating, chem, issues: [[name, amount]] }.
   */
  function sbcCheck(lineup, slots, k) {
    const players = lineup.filter(Boolean);
    const issues = [];
    const miss = (name, amount) => { if (amount > 0) issues.push([name, amount]); };
    miss('players', k.players - players.length);
    const rating = k.players === 11 ? squadRating(lineup.map((p) => (p ? p.rating : 0))) : 0;
    if (k.teamRating) miss('team rating', (k.teamRating - rating) * 3);
    if ((k.teamRatingMax ?? 99) < 99) miss('max team rating', (rating - k.teamRatingMax) * 3);
    const chem = squadChemistry(lineup.map((p, i) => p && { ...p, inPosition: (p.positions || []).includes(slots[i]) }));
    if (k.chemMin) miss('chemistry', k.chemMin - chem.total);
    if (k.chemEachMin) miss('chemistry per player', chem.each.reduce((a, x, i) => a + (lineup[i] ? Math.max(0, k.chemEachMin - x) : 0), 0));
    miss('rares', (k.rareMin || 0) - players.filter((p) => p.rare).length);
    for (const t of ['league', 'nation', 'club']) {
      const g = (k.groups || {})[t] || {};
      if (!Object.keys(g).length) continue;
      const m = new Map();
      players.forEach((p) => m.set(p[GROUP_KEY[t]], (m.get(p[GROUP_KEY[t]]) || 0) + 1));
      const largest = Math.max(0, ...m.values());
      if (g.sameMin) miss(`same ${t}`, g.sameMin - largest);
      if (g.sameMax !== undefined) miss(`max same ${t}`, [...m.values()].reduce((a, x) => a + Math.max(0, x - g.sameMax), 0));
      if (g.distinctMin) miss(`${t}s`, g.distinctMin - m.size);
      if (g.distinctMax !== undefined) miss(`max ${t}s`, m.size - g.distinctMax);
    }
    for (const r of k.idReqs || []) {
      const n = players.filter((p) => matchesReq(p, r)).length;
      if (r.min) miss(`${r.type} ${r.ids.join('/')}`, r.min - n);
      if (r.max !== undefined) miss(`max ${r.type} ${r.ids.join('/')}`, n - r.max);
    }
    const violation = issues.reduce((a, [, x]) => a + x, 0);
    return { ok: violation === 0, violation, rating, chem: chem.total, issues };
  }

  /**
   * Cheapest squad meeting every constraint, positions and chemistry included.
   * Starts from several seeds (one per main league/nation/club in the pool,
   * plus the cheapest rating mix) and improves by swapping players until
   * nothing better is found. pool: [{ id, rating, rare, cost, positions, leagueId, nationId, teamId }]
   * slots: positions of the SBC squad. Returns { players, rating, chem, cost } or null.
   */
  function solveSbcSearch(pool, slots, k, opts = {}) {
    const ok = (p) => p.rating >= k.minOvr && p.rating <= k.maxOvr
      && qualityOf(p.rating) >= (k.minQuality || 0) && qualityOf(p.rating) <= (k.maxQuality || 9);
    const eligible = pool.filter(ok);
    const n = slots.length;
    if (eligible.length < n) return null;
    const byCost = (a, b) => a.cost - b.cost;
    const cheap = eligible.slice().sort(byCost);
    const fits = slots.map((pos) => eligible.filter((p) => (p.positions || []).includes(pos)).sort(byCost));
    const high = eligible.slice().sort((a, b) => b.rating - a.rating || a.cost - b.cost);
    const score = (lineup) => {
      const e = sbcCheck(lineup, slots, k);
      return { f: e.violation * 1e6 + lineup.reduce((a, p) => a + (p ? p.cost : 1e6), 0), e };
    };
    const order = slots.map((_, i) => i).sort((a, b) => fits[a].length - fits[b].length);
    const fill = (prefer) => {
      const lineup = new Array(n).fill(null);
      const used = new Set();
      for (const i of order) {
        const pick = (prefer && fits[i].find((p) => !used.has(p.id) && prefer(p)))
          || fits[i].find((p) => !used.has(p.id)) || cheap.find((p) => !used.has(p.id));
        if (pick) { lineup[i] = pick; used.add(pick.id); }
      }
      return lineup;
    };
    // Seeds: cheapest; each main league / nation / club; plus required ids.
    const seeds = [fill(null)];
    for (const t of ['league', 'nation', 'club']) {
      const counts = new Map();
      eligible.forEach((p) => counts.set(p[GROUP_KEY[t]], (counts.get(p[GROUP_KEY[t]]) || 0) + 1));
      [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, t === 'league' ? 5 : 3)
        .forEach(([id]) => seeds.push(fill((p) => p[GROUP_KEY[t]] === id)));
    }
    for (const r of k.idReqs || []) if (r.min) seeds.push(fill((p) => matchesReq(p, r)));
    if (k.teamRating && n === 11) {
      const r = solveSbc(eligible, { ...k, rareMin: k.rareMin || 0 });
      if (r) { const ids = new Set(r.players.map((p) => p.id)); seeds.push(fill((p) => ids.has(p.id))); }
    }
    let best = null;
    const deadline = Date.now() + (opts.timeMs || 2500);
    for (const seed of seeds) {
      const lineup = seed.slice();
      let cur = score(lineup);
      for (let round = 0; round < 60 && Date.now() < deadline; round++) {
        let improved = false;
        for (let i = 0; i < n; i++) {
          const pool2 = new Set([...fits[i].slice(0, 30), ...cheap.slice(0, 30), ...high.slice(0, 20)]);
          for (const c of pool2) {
            const j = lineup.findIndex((x) => x && x.id === c.id);
            if (j === i) continue;
            const next = lineup.slice();
            if (j >= 0) next[j] = lineup[i];
            next[i] = c;
            const sc = score(next);
            if (sc.f < cur.f) { lineup.splice(0, n, ...next); cur = sc; improved = true; }
          }
        }
        if (!improved) break;
      }
      if (cur.e.ok && (!best || cur.f < best.f)) best = { ...cur, lineup: lineup.slice() };
    }
    if (!best) return null;
    return { players: best.lineup, rating: best.e.rating, chem: best.e.chem, cost: best.lineup.reduce((a, p) => a + p.cost, 0) };
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

  // ---- 💎 Points SBCs -------------------------------------------------------------------

  /**
   * How to reach a points goal: your spare cards first (least value given away
   * per point), then market buys (fewest coins per point). One copy per player.
   * club: [{ id, points, cost }]; market: [{ id, points, price }].
   * Returns { fromClub, clubPoints, buys, buyPoints, buyCoins, short, cards, handIns }.
   */
  function planPoints(need, club, market, opts = {}) {
    const perHandIn = opts.perHandIn || 20;
    const used = new Set();
    let got = 0;
    const take = (list, ratio) => {
      const out = [];
      let pts = 0;
      for (const p of list.filter((x) => x.points > 0).sort((a, b) => ratio(a) - ratio(b))) {
        if (got + pts >= need) break;
        const key = p.baseId ?? p.id;
        if (used.has(key)) continue;
        used.add(key);
        out.push(p);
        pts += p.points;
      }
      got += pts;
      return { out, pts };
    };
    const c = take(club || [], (p) => p.cost / p.points);
    const m = take(market || [], (p) => p.price / p.points);
    const cards = c.out.length + m.out.length;
    return {
      fromClub: c.out, clubPoints: c.pts,
      buys: m.out, buyPoints: m.pts, buyCoins: m.out.reduce((a, p) => a + p.price, 0),
      short: Math.max(0, need - got), cards, handIns: Math.ceil(cards / perHandIn),
    };
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
    discount: 4, // % under the cheapest listing to snipe at (2.4.6: 4 — inside the tax band, where fast flip bots can't profit)
    maxBuy: 1000, // used when a player has no price
    maxBuysPerSearch: 1,
    smartSnipe: true, // learn the best discount and target from hits, lost races and near misses
    smartMinPct: 4, // smart sniping never goes closer than this % under the market price
    smartMaxPct: 14, // … nor deeper than this
    smartPrice: false, // 2.4.6: let the learner set the discount too (off: it only picks which card to search)
    smartProbeEvery: 10, // 1 in N searches looks a bit above your max to spot near misses (never buys above it)
    minCoins: 0, // never spend below this balance
    filters: [], // saved search filters: [{ id, kind: 'filter', name, on, level, rarity, position, league, nation, club, minRating, maxRating, manualMax, maxBuy, avg }]
    theme: 'green', // accent colour: green | orange
    spendLimit: 0, // priority list: total coins to spend (0 = all but Keep coins)
    listSpent: 0, // spent on the list so far (reset from the Snipe tab)
    buyOnce: true, // take a player off the list once bought
    reserveForHigher: false, // don't buy lower players if it leaves too little for higher ones
    repriceMinutes: 30, // refresh a player's market price this often while running (sooner when the market drops)
    bidSnipe: false, // also bid on auctions about to end under your max
    bidWindow: 45, // seconds left on an auction before bidding (2.4.8: 45 — searches are 4–8 s apart, so 30 gave each auction about one look)
    dryTurns: 40, // 2.4.9: after this many Buy Now searches with nothing on a player, try auctions only for a while (0 = off; needs bidding on)
    dryAuctionSearches: 60, // … for this many of that player's searches
    liveLog: true, // 2.4.8: one line per search — what came back and why it did or didn't buy/bid
    maxActiveBids: 5,
    bidWars: 1, // bid wars at once (1–3): counter-bid when outbid in the last seconds
    bidWarStretchPct: 8, // in a war, go up to this % above your normal max (still under avg − 3% / profitable price / Buy Now)
    bidWarMaxCounters: 5, // give up after this many counter-bids without winning
    bidWarPoolPct: 25, // wars may hold at most this % of your spendable coins
    bidWarMinSteps: 2, // only start a war with at least this many bid steps of room left
    binIdealPct: 20, // a Buy Now this far under avg always wins (even next to a war)
    warKeepPct: 10, // a war whose next bid is this far under avg beats an ordinary Buy Now
    // trading (resell)
    undercut: 3, // list this % under the market price so it sells
    minProfitPct: 4, // and make at least this % of the market price (as well as Min profit)
    hotSearches: 14, // market searches per hot-card scan (plus price checks)
    hotLeagues: '13,53,19,31,16', // leagues to scan for hot cards (Premier League, LaLiga, Bundesliga, Serie A, Ligue 1)
    hotPick: 3, // how many hot cards to trade
    hotRareOnly: true,
    hotAuto: false, // pick hot cards automatically when trading starts
    tradeBudget: 0, // max coins per card for trading (0 = no fixed amount)
    tradeBudgetPct: 25, // … and never more than this % of your coins above Keep coins on one card
    upkeepMinutes: 5, // check the transfer list this often while trading
    smartRelist: true, // reprice expired cards to today's market (not below what you paid + Min profit)
    cutLossAfter: 3, // after this many failed relists, allow break-even (0 = never)
    // selling
    sellMode: 'off', // off | profit | market | fixed
    sellPrice: 0,
    minProfit: 200,
    listDuration: 10800, // 3 h: cards stay listed while you're away between sessions
    autoRelist: false, // relist expired + clear sold items when starting
    // safety (see SAFETY for the enforced floors)
    delayMin: 4000,
    delayMax: 8000,
    pauseEvery: 30,
    pauseMin: 45000,
    pauseMax: 120000,
    sessionMinutes: 40,
    maxSearches: 250, // per session
    maxBuys: 12, // per session
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
    // Session plan (2.4.7): sniping blocks with real breaks, cheap repeatable SBCs in the breaks
    planBlocks: 3,
    planBlockMin: 60, // ≤ 120 (the session cap)
    planBreakMin: 30, // ≥ 20, no market activity
    planBudgetPct: 10, // the plan may spend at most this % of your coins at the start
    planSbcs: [], // [{ id, name }] in order — only these, never others
    planSbcMax: 3, // completions per break
    planSbcCoins: 2000, // max coins of buys per SBC
    planKeepAlive: true,
    upgradeEvos: true, // 2.5.0: "Find upgrades" also lists evolutions your squad's cards can start now
    goalBufferPct: 12, // 2.5.0: an SBC coin goal aims this % above what it needs, so it can be done again
    goal: null, // { coins, label } while trading toward an SBC // one light request every ~10 min in breaks so EA doesn't log you out
    sbcBuyMissing: true, // buy cheap fill-ins from the market when your club can't complete an SBC
    sbcUseUnassigned: true, // move Unassigned players to club / SBC storage first so SBCs can use them
    sbcBuyLimit: 20000, // max coins of fill-ins per SBC
    pointsBuyLimit: 0, // 💎 points SBCs: max coins to spend buying cards after your spare ones (0 = never buy)
    sbcOpenRewards: true, // open SBC reward packs right after submitting
    // upgrades
    upgradeBudget: 0, // 0 = your coins minus Keep coins
    upgradeMarket: true, // also search the market (uses searches)
    upgradeSbc: true, // also suggest players you can get from SBCs (with a rough coin cost)
    lineupBy: 'meta', // formation coach: 'meta' (position-weighted stats) or 'rating'
  };

  /**
   * Read-only profit dashboard numbers from the buy history (no market calls).
   * Bought counts by buy time (at), sold counts by sale time (soldAt). Net =
   * received after the 5% tax minus what you paid, on sold cards only. "Tied up"
   * = coins paid for cards you listed (have a sell price) that haven't sold yet;
   * cards you kept (no listing) aren't flips and aren't counted. Old entries
   * without soldFor/soldAt/id are tolerated.
   * -> { today, week, all (each { bought, spent, sold, received, net, tiedUp, sellThrough, avgHours }),
   *      days: [{ key, net, sold }] (7, oldest first), cards: [...], best: top 5, worst: bottom 3 }
   */
  function profitSummary(history, now) {
    const L = (history || []).filter((e) => e && Number(e.price) > 0);
    const t = new Date(now);
    const cut = { today: new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime(), week: new Date(t.getFullYear(), t.getMonth(), t.getDate() - 6).getTime(), all: -Infinity };
    const isSold = (e) => Number(e.soldFor) > 0;
    const sale = (e) => e.soldAt || e.at || 0;
    const period = (from) => {
      const bought = L.filter((e) => (e.at || 0) >= from);
      const sold = L.filter((e) => isSold(e) && sale(e) >= from);
      const timed = sold.filter((e) => e.soldAt && e.at && e.soldAt >= e.at);
      const received = sold.reduce((a, e) => a + afterTax(e.soldFor), 0);
      const paidSold = sold.reduce((a, e) => a + e.price, 0);
      const listedBought = bought.filter((e) => e.sell > 0);
      return {
        bought: bought.length,
        spent: bought.reduce((a, e) => a + e.price, 0),
        sold: sold.length,
        received,
        net: received - paidSold,
        tiedUp: bought.filter((e) => !isSold(e) && e.sell > 0).reduce((a, e) => a + e.price, 0),
        sellThrough: listedBought.length ? Math.round(listedBought.filter(isSold).length / listedBought.length * 100) : null,
        avgHours: timed.length ? Math.round(timed.reduce((a, e) => a + (e.soldAt - e.at), 0) / timed.length / 36e5 * 10) / 10 : null,
      };
    };
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const key = dayKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i).getTime());
      const s = L.filter((e) => isSold(e) && dayKey(sale(e)) === key);
      days.push({ key, net: s.reduce((a, e) => a + afterTax(e.soldFor) - e.price, 0), sold: s.length });
    }
    const m = new Map();
    for (const e of L) {
      const k = e.id != null ? e.id : e.name;
      if (k == null) continue;
      const c = m.get(k) || { id: k, name: e.name || String(k), rating: e.rating, bought: 0, sold: 0, net: 0, days: 0, timed: 0 };
      c.bought++;
      if (isSold(e)) {
        c.sold++; c.net += afterTax(e.soldFor) - e.price;
        if (e.soldAt && e.at && e.soldAt >= e.at) { c.days += (e.soldAt - e.at) / 864e5; c.timed++; }
      }
      m.set(k, c);
    }
    const cards = [...m.values()].filter((c) => c.sold > 0)
      .map((c) => ({ id: c.id, name: c.name, rating: c.rating, bought: c.bought, sold: c.sold, net: c.net, avgDays: c.timed ? Math.round(c.days / c.timed * 10) / 10 : null }))
      .sort((a, b) => b.net - a.net);
    const best = cards.slice(0, 5);
    const worst = cards.slice(best.length).slice(-3).reverse();
    return { today: period(cut.today), week: period(cut.week), all: period(cut.all), days, cards, best, worst };
  }

  const core = {
    EA_TAX, MIN_PRICE, MAX_PRICE, DEFAULT_CONFIG,
    priceStep, roundPrice, nextPrice, prevPrice, afterTax, profit, breakEvenSell,
    cacheBustBid, jitter, pickTargets, planSellPrice, classifyStatus,
    normalizeName, parsePlayerDb, searchPlayers, cardVersions, playerForIteration, migrateConfig, filterSummary, sniperTargets, LEAGUES,
    findMarketPrice, robustPrice, searchBudget, addPriceSample, prunePrices, priceTrend, trendText, lookupUrl, planMaxBuy, effectiveMaxBuy, withinReach, huntTargets,
    newerVersion, setupIssues, adviceFix, sbcLikely, sbcOrder, coinGoal, cardAdvice, sessionReport, bidSkipReason, proPick, scoreParts, comparePlayers, evoPicks, metaPlayStyles, upgradeWhy, readPlayStyles, cardFieldsProbe, shortTime, searchReport, auctionReport, planFloor, planBudget, planVerdict, planSummary, robustLow, trendNudge, snipeBase, recordGap, gapStats, smartLevels, gammaSample, betaSample, armPrior, decayArm, upgradeArm, armRate, chooseDiscount, chooseTarget, missWeight, recordArm, deepestArmFor, priceShifted, bestArm, flipPlan, tradeOpts, tradeCap, bidAmount, freeCoins, bidBlock, warCeiling, warSteps, binVsWar, settleSales,
    listSpendable, reserveOk, afterListBuy,
    aggregateListings, hotScore, rankHot, snipeScore, priceBands, provenFlips, flipValue, priceLadder, sbcCostEstimate,
    addHistory, summarizeHistory, profitSummary, isDiscordWebhook, discordPayload,
    squadRating, squadChemistry, topValues, rankUpgrades,
    POS_NAMES, normPos, baseId, FORMATIONS, META_NOTES, squadRatingExact, lineupScore, bestLineup, metaScore, readStats,
    fodderValue, playerCost, qualityOf, COIN_WEIGHT, parseRequirements, solveSbc, sortItem, sbcCheck, solveSbcSearch, matchesReq, marketLevel, planPoints,
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
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '2.5.0';
  const errText = (e) => (e && e.message ? e.message : String(e));
  const fmt = (n) => Number(n || 0).toLocaleString();

  // ---- Storage ----------------------------------------------------------------

  const KEYS = { cfg: 'fc-sniper:config', safety: 'fc-sniper:safety', history: 'fc-sniper:history', ui: 'fc-sniper:ui', log: 'fc-sniper:log', learn: 'fc-sniper:learn', debug: 'fc-sniper:debug', prices: 'fc-sniper:prices', bids: 'fc-sniper:bids', plan: 'fc-sniper:plan', team: 'fc-sniper:team' };
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
    28: 'PLAYER_MAX_OVR', 30: 'FIRST_OWNER_PLAYERS_COUNT', 33: 'PLAYER_TRADABILITY', 35: 'CHEMISTRY_POINTS', 36: 'ALL_PLAYERS_CHEMISTRY_POINTS', 40: 'ACADEMY_PLAYER_SLOTTING', 41: 'PLAYER_ATTRIBUTE',
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
      // A search filter carries its own settings; a player is searched by id
      // (maskedDefId matches every version of the player, like the Web App's name search).
      const isFilter = player && player.kind === 'filter';
      const src = isFilter ? player : cfg;
      // EA searches by the base player id (every version); the exact card is picked from the results (2.4.10)
      if (player && !isFilter) c.maskedDefId = baseId(player.id);
      // a special card shares its base id with the cheap common card: search only its rating so page 1 isn't all common copies
      if (player && !isFilter && player.id > 0xFFFFFF && player.rating > 0) { c.ovrMin = player.rating; c.ovrMax = player.rating; }
      if (src.level && src.level !== 'any') c.level = src.level;
      if (src.rarity !== '' && src.rarity !== undefined && src.rarity !== null && !Number.isNaN(parseInt(src.rarity, 10))) c.rarities = [parseInt(src.rarity, 10)];
      if (src.position) { c._position = src.position; if (isFilter) c.position = src.position; }
      if (src.nation) c.nation = parseInt(src.nation, 10);
      if (src.league) c.league = parseInt(src.league, 10);
      if (src.club) c.club = parseInt(src.club, 10);
      if (maxBuy) c.maxBuy = roundPrice(maxBuy);
      if (maxBid) c.maxBid = roundPrice(maxBid);
      // Changing a filter that doesn't matter makes EA send fresh results.
      if (iteration !== undefined) {
        if (maxBid) c.minBuy = roundPrice(cacheBustBid(iteration, 0) + 1000);
        else c.minBid = cacheBustBid(iteration, maxBuy);
      }
      return c;
    },
    async search(criteria, page = 1) {
      if (typeof w.services.Item.clearTransferMarketCache === 'function') w.services.Item.clearTransferMarketCache();
      if (jobs.current) await jobs.gate('search');
      fut.ownSearch = (fut.ownSearch || 0) + 1;
      let res;
      try { res = await observe(w.services.Item.searchTransferMarket(criteria, page)); } finally { fut.ownSearch--; }
      jobs.lastMarketAt = Date.now();
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
        rareflag: item.rareflag || 0,
        defId: item.definitionId,
        name: (item._staticData && item._staticData.name) || item.name || `#${item.definitionId}`,
      };
    },
    async buy(listing) {
      if (jobs.current) await jobs.gate('buy');
      const res = await observe(w.services.Item.bid(listing.item, listing.buyNowPrice));
      jobs.lastMarketAt = Date.now();
      return { ok: !!res.success, status: res.status };
    },
    async list(item, sellPrice, duration) {
      if (jobs.current) await jobs.gate('list');
      jobs.lastMarketAt = Date.now();
      const moved = await observe(w.services.Item.move(item, w.ItemPile.TRANSFER));
      if (!moved.success) return { ok: false, status: moved.status };
      const res = await observe(w.services.Item.list(item, prevPrice(sellPrice), sellPrice, duration));
      return { ok: !!res.success, status: res.status };
    },
    // -- evolutions (EA calls them "Academy") --
    academyCriteria(categoryId) {
      const c = w.UTAcademySlotSearchCriteriaDTO ? new w.UTAcademySlotSearchCriteriaDTO() : {};
      if (w.AcademySlotState) c._slotStatus = w.AcademySlotState.NOT_STARTED;
      if (categoryId !== undefined) c.categoryId = categoryId;
      return c;
    },
    /** All evolutions you haven't started: the hub, plus each category. */
    async evolutions() {
      const A = w.services.Academy;
      if (!A) return { ok: false, status: 'no Academy service', slots: [] };
      const out = new Map();
      const hub = await observe(A.requestAcademyHub(this.academyCriteria()));
      if (!hub.success) return { ok: false, status: hub.status, slots: [] };
      ((hub.data && hub.data.slots) || []).forEach((sl) => out.set(sl.id, sl));
      let cats = [];
      try { cats = (A.getCategories() || []).map((c) => c.id); } catch { /* none */ }
      for (const id of cats.slice(0, 12)) {
        await sleep(jitter(900, 1600));
        const r = await observe(A.requestSlotsByCategory(this.academyCriteria(id)));
        if (r.success) ((r.data && r.data.slots) || []).forEach((sl) => out.set(sl.id, sl));
      }
      return { ok: true, slots: [...out.values()] };
    },
    evoName(sl) {
      const raw = sl.name || sl.title || sl.slotName || '';
      try { const t = raw && w.services.Localization.localize(raw); if (t && t !== raw) return t; } catch { /* ignore */ }
      return raw || `Evolution ${sl.id}`;
    },
    evoCost(sl) {
      const c = sl.prices && (sl.prices._collection || sl.prices);
      const coins = c && c.COINS && (c.COINS.amount ?? c.COINS);
      const points = c && c.POINTS && (c.POINTS.amount ?? c.POINTS);
      return coins ? `${fmt(coins)} coins` : points ? `${fmt(points)} FC Points` : 'Free';
    },
    /** Final card after an evolution (one request). */
    async evoPreview(sl, item) {
      const res = await observe(w.services.Academy.getSlotPreview(sl.id, item.id));
      const lv = res.success && res.data && res.data.updatedSlot && res.data.updatedSlot.levels;
      const p = lv && lv.length && lv[lv.length - 1].boostedPlayer;
      return p ? { rating: p.rating, positions: p.preferredPosition } : null;
    },

    /** Rarities by name, read from the Web App's own search screen (fallback: rare/common). */
    rarityOptions() {
      try {
        const dp = w.factories && w.factories.DataProvider;
        if (dp && typeof dp.getItemRarityDP === 'function') {
          const list = dp.getItemRarityDP({ itemSubTypes: [w.ItemSubType && w.ItemSubType.PLAYER], itemTypes: [w.ItemType && w.ItemType.PLAYER], quality: w.SearchLevel && w.SearchLevel.ANY, tradableOnly: false }) || [];
          const out = list.map((e) => ({ v: String(e.value ?? e.id), l: String(e.label ?? e.value) })).filter((o) => o.v !== '' && o.v !== 'undefined' && o.v !== '-1');
          if (out.length) return out;
        }
      } catch { /* fall back */ }
      return [{ v: '1', l: 'Rare' }, { v: '0', l: 'Common' }];
    },
    leagueName(id) {
      try { const n = w.UTLocalizationUtil.leagueIdToName(Number(id), w.services.Localization); if (n && !/^\d+$/.test(n)) return n; } catch { /* ignore */ }
      return LEAGUES[id] || `League ${id}`;
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
        rareflag: item.rareflag || 0,
        points: Number(item.sbsScore) || 0, // 💎 value in points SBCs
        rare: (item.rareflag || 0) >= 1,
        special: (item.rareflag || 0) > 1,
        untradeable: !!item.untradeable,
        duplicate: typeof item.isDuplicate === 'function' ? !!item.isDuplicate() : false,
        storage: !!w.ItemPile && item.pile === w.ItemPile.STORAGE,
        loan: typeof item.isLimitedUse === 'function' ? !!item.isLimitedUse() : false,
        evo: !!item.academy,
        player: typeof item.isPlayer === 'function' ? !!item.isPlayer() : item.type === 'player',
        ...readStats(item),
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
    /** Player cards an SBC set gives as its reward (empty for pack/coin rewards). */
    sbcRewardPlayers(set) {
      let raw = [];
      try { raw = [].concat(set.awards || [], typeof set.getAwards === 'function' ? (set.getAwards() || []) : []); } catch { /* ignore */ }
      const seen = new Set();
      return raw.map((a) => a && (a.item || a)).filter((it) => {
        if (!it || !it.definitionId || seen.has(it.definitionId)) return false;
        seen.add(it.definitionId);
        return typeof it.isPlayer === 'function' ? it.isPlayer() : (it.type === 'player' || !!it.rating);
      });
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
    // -- 💎 points ("one-click") challenges: the Web App starts them, then submits item ids --
    async startPointsChallenge(ch) {
      if (typeof ch.hasNotStarted === 'function' && !ch.hasNotStarted()) return { ok: true };
      const res = await observe(w.services.SBC.initiateOneClickChallenge(ch));
      return { ok: !!res.success, status: res.status };
    },
    /** Hand in items; EA answers with the new points total (409 = a card is in one of your squads). */
    async submitPoints(ch, set, itemIds) {
      const res = await observe(w.services.SBC.submitOneClickChallenge(ch, set, itemIds), 30000);
      return { ok: !!res.success, status: res.status, data: res.data || {} };
    },

    /** Is this squad slot blocked (a "brick")? EA exposes it as a method or a flag. */
    isBrick(slot) {
      if (!slot) return true;
      if (typeof slot.isBrick === 'function') return !!slot.isBrick();
      return !!(slot.isBrick || slot.brick || slot._brick || slot.isLocked === true);
    },
    /**
     * The SBC squad's open slots, in fill order, trimmed to the number of
     * players the challenge needs: [{ index, position }].
     */
    challengeOpen(ch) {
      try {
        const slots = ch.squad.getFieldPlayers();
        let open = slots.filter((s) => !this.isBrick(s));
        const need = this.requiredPlayers(ch);
        if (open.length > need) open = open.slice(0, need);
        debugLog.push(`sbc ${ch.name || ch.id}: ${slots.length} slots, ${open.length} open, needs ${need}; slot keys ${Object.keys(slots[0] || {}).slice(0, 20).join(',')}`);
        return open.map((s) => ({ index: s.index, position: s.position ? normPos(s.position.typeName ?? s.position.id) : '?' }));
      } catch { return Array.from({ length: this.requiredPlayers(ch) }, (_, index) => ({ index, position: '?' })); }
    },
    /** Positions of the SBC squad's open slots, in the order they're filled. */
    challengeSlots(ch) {
      return this.challengeOpen(ch).map((x) => x.position);
    },
    /** Players the challenge needs: EA's own count, else its "number of players" rule, else 11. */
    /**
     * Where does EA keep the 💎 points of points-SBCs? Lists fields and methods
     * that mention points / progress / goal on the challenge, its set and a
     * club item, with their values where cheap to read. Goes to Copy log.
     */
    pointsProbe(ch, set, item) {
      const rx = /point|progress|goal|target|value|exchange|score|total/i;
      const dump = (label, obj) => {
        if (!obj) return `${label}: none`;
        const out = [];
        const seen = new Set();
        for (let o = obj, depth = 0; o && depth < 3; o = Object.getPrototypeOf(o), depth++) {
          for (const k of Object.getOwnPropertyNames(o)) {
            if (seen.has(k) || !rx.test(k)) continue;
            seen.add(k);
            let v;
            try {
              const d = Object.getOwnPropertyDescriptor(o, k);
              if (d && typeof d.value === 'function') {
                v = d.value.length === 0 ? (() => { try { const r = obj[k](); return typeof r === 'object' ? JSON.stringify(r).slice(0, 80) : r; } catch { return 'fn!'; } })() : `fn(${d.value.length})`;
              } else v = obj[k];
              if (v && typeof v === 'object') v = JSON.stringify(v).slice(0, 80);
            } catch { v = '?'; }
            out.push(`${k}=${v}`);
          }
        }
        return `${label}: ${out.join(', ').slice(0, 600) || 'nothing matching'}`;
      };
      return [dump('challenge', ch), dump('set', set), dump('item', item)].join(' || ');
    },

    /**
     * Read-only look for the FC 27 Gallery inside the Web App: services,
     * globals, repositories and menu text that mention it, their methods
     * (with a short source preview) and, at most twice, a read-only request
     * so we can see the data's shape. Changes nothing. Returns lines for Copy log.
     */
    /**
     * Read-only: note how the Web App's OWN transfer-market searches are built (the user searches by hand),
     * so filters like Rare can be copied exactly. Nothing is changed; the original function is put back
     * after `n` searches or `ms`. Calls `done(lines)` at the end.
     */
    recordSearches(n, ms, done) {
      const svc = w.services && w.services.Item;
      if (!svc || typeof svc.searchTransferMarket !== 'function') return false;
      if (fut.recording) return true;
      const orig = svc.searchTransferMarket;
      const lines = [];
      const fields = (c) => {
        const o = {};
        for (const k of Object.keys(c || {})) {
          const v = c[k];
          if (typeof v === 'function' || v === undefined || v === null || v === '') continue;
          if (Array.isArray(v) && !v.length) continue;
          o[k] = v;
        }
        return o;
      };
      let timer;
      const finish = () => {
        if (!fut.recording) return;
        clearTimeout(timer);
        if (svc.searchTransferMarket === wrapped) svc.searchTransferMarket = orig;
        fut.recording = false;
        done(lines);
      };
      const wrapped = function (criteria, page) {
        if (!fut.ownSearch) {
          try {
            let s = JSON.stringify(fields(criteria), (k, x) => (typeof x === 'function' ? undefined : x));
            if (s.length > 600) s = s.slice(0, 600) + '…';
            lines.push(`page ${page}: ${s}`);
            if (lines.length === 1) {
              const proto = Object.getPrototypeOf(criteria || {});
              lines.push(`criteria methods: ${proto ? Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor').slice(0, 40).join(',') : 'none'}`);
            }
          } catch (e) { lines.push(`could not read: ${e.message}`); }
          if (lines.filter((l) => l.startsWith('page')).length >= n) setTimeout(finish, 0);
        }
        return orig.apply(this, arguments);
      };
      svc.searchTransferMarket = wrapped;
      fut.recording = true;
      timer = setTimeout(finish, ms);
      return true;
    },
    async galleryProbe() {
      const rx = /galler|showcase|eventtoken|collection|album|sticker|(?<!up)grade|gtag|token ?store/i;
      const lines = [];
      const short = (v, n = 300) => { try { return (typeof v === 'string' ? v : JSON.stringify(v, (k, x) => (typeof x === 'function' ? 'fn' : x))).replace(/\s+/g, ' ').slice(0, n); } catch { return String(v).slice(0, n); } };
      const methods = (obj) => {
        const out = []; const seen = new Set();
        for (let o = obj, d = 0; o && o !== Object.prototype && d < 4; o = Object.getPrototypeOf(o), d++) {
          for (const k of Object.getOwnPropertyNames(o)) {
            if (seen.has(k) || k === 'constructor') continue;
            seen.add(k);
            try { const desc = Object.getOwnPropertyDescriptor(o, k); if (desc && typeof desc.value === 'function') out.push({ k, n: desc.value.length, src: String(desc.value) }); } catch { /* ignore */ }
          }
        }
        return out;
      };
      const S = w.services || {};
      const svcNames = Object.keys(S);
      lines.push(`services (${svcNames.length}): ${svcNames.join(',')}`.slice(0, 900));
      const hits = svcNames.filter((k) => rx.test(k));
      // FC 27 names the Gallery "Showcase" inside the Web App (tokens: EventToken)
      for (const k of ['Showcase', 'EventToken']) if (S[k] && !hits.includes(k)) hits.unshift(k);
      // services whose methods mention the gallery
      for (const k of svcNames) {
        if (hits.includes(k)) continue;
        try { if (methods(S[k]).some((m) => rx.test(m.k))) hits.push(k); } catch { /* ignore */ }
      }
      lines.push(`gallery-like services: ${hits.join(',') || 'none'}`);
      const requests = [];
      for (const k of hits.slice(0, 6)) {
        const ms = methods(S[k]);
        lines.push(`services.${k} methods: ${ms.map((m) => `${m.k}(${m.n})`).join(', ')}`.slice(0, 1200));
        for (const m of ms.slice(0, 25)) lines.push(`  ${k}.${m.k}(${m.n}): ${short(m.src, 260)}`);
        // read-only requests only (never claim/submit/grade/add/buy…)
        const reads = ms.filter((m) => m.n === 0 && /^(request|get|fetch|load)/i.test(m.k) && !/claim|submit|grade|purchase|buy|open|redeem|place|delete|remove|save|update/i.test(m.k));
        reads.slice(0, 3).forEach((m) => requests.push([k, m.k]));
      }
      const globals = Object.getOwnPropertyNames(w).filter((g) => rx.test(g) && !/^HTML/.test(g));
      lines.push(`globals: ${globals.join(',') || 'none'}`.slice(0, 1200));
      for (const g of globals.filter((x) => w[x] && typeof w[x] === 'object' && !Array.isArray(w[x])).slice(0, 8)) {
        lines.push(`  ${g} = ${short(w[g], 250)}`);
      }
      try {
        const repo = w.repositories || {};
        const rk = Object.keys(repo).filter((k) => rx.test(k) || methods(repo[k]).some((m) => rx.test(m.k)));
        lines.push(`repositories: ${Object.keys(repo).join(',')} · gallery-like: ${rk.join(',') || 'none'}`.slice(0, 700));
      } catch { /* ignore */ }
      const navText = [...document.querySelectorAll('button, a, .ut-tab-bar-item, h1, h2')].filter((e) => !e.closest('#fcs')).map((e) => (e.textContent || '').trim()).filter((t) => t && t.length < 40 && /galler|collection/i.test(t));
      lines.push(`menu text: ${[...new Set(navText)].join(' | ') || 'none'}`);
      // a read-only look at the data (like opening the Gallery page), at most 4 requests
      for (const [k, m] of requests.slice(0, 4)) {
        try {
          const res = await observe(S[k][m](), 15000);
          const d = res.data;
          lines.push(`${k}.${m}() → success ${!!res.success} status ${res.status ?? ''} keys ${d && typeof d === 'object' ? Object.keys(d).join(',') : typeof d} · ${short(d, 600)}`);
        } catch (e) { lines.push(`${k}.${m}() threw ${errText(e)}`); }
        await sleep(jitter(1500, 2500));
      }
      // repositories for those services (cached data, no request)
      try {
        for (const k of ['Showcase', 'EventToken']) {
          const rp = w.repositories && w.repositories[k];
          if (rp) lines.push(`repositories.${k}: ${methods(rp).map((m) => `${m.k}(${m.n})`).join(', ')} · ${short(rp, 400)}`.slice(0, 900));
        }
      } catch { /* ignore */ }
      return { lines, found: hits.length > 0 || globals.length > 0 };
    },

    /** EA's raw requirement data, for Copy log: numbers, names, values, scope, count and any text fields. */
    rawRequirements(ch) {
      const keyNames = invert(w.SBCEligibilityKey, SBC_KEYS);
      try {
        return JSON.stringify((ch.eligibilityRequirements || []).map((r) => {
          const kv = (r.kvPairs && (r.kvPairs._collection || r.kvPairs)) || {};
          const text = {};
          for (const [k, v] of Object.entries(r)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') text[k] = v;
          let label = '';
          try { label = typeof r.getText === 'function' ? r.getText() : typeof r.getDescription === 'function' ? r.getDescription() : ''; } catch { /* none */ }
          return { ...text, label, kv: Object.fromEntries(Object.entries(kv).map(([k, v]) => [`${k}:${keyNames[k] || '?'}`, v])) };
        })).slice(0, 900);
      } catch (e) { return `unreadable (${errText(e)})`; }
    },
    requiredPlayers(ch) {
      try {
        const n = ch.squad && ch.squad.getNumOfRequiredPlayers();
        if (n > 0) return n;
      } catch { /* not loaded yet */ }
      const fromRule = this.requirements(ch).find((r) => r.key === 'PLAYER_COUNT');
      const v = fromRule && Number(fromRule.values[0]);
      return v > 0 && v <= 11 ? v : 11;
    },
    /** Put players into the challenge squad's open slots and save it. */
    async fillChallenge(ch, items) {
      const squad = ch.squad;
      const slots = squad.getFieldPlayers();
      const open = this.challengeOpen(ch).map((x) => x.index);
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
      if (typeof w.services.Item.requestTransferItems !== 'function') return null;
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
    /** List an item that's already on the transfer list (expired) at a new price. */
    async relistItem(item, sellPrice, duration) {
      const res = await observe(w.services.Item.list(item, prevPrice(sellPrice), sellPrice, duration));
      return { ok: !!res.success, status: res.status };
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
      if (jobs.current) await jobs.gate('bid');
      jobs.lastMarketAt = Date.now();
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
    /** Player picture the Web App already uses (same EA content server as players.json); '' if not known yet. */
    portrait(id) {
      if (!this.pBase) {
        const urls = (w.performance?.getEntriesByType?.('resource') || []).map((e) => e.name);
        const u = urls.find((x) => /\/portraits\/[^/?]+\.png/.test(x));
        if (u) this.pBase = u.replace(/[^/]+\.png(\?.*)?$/, '');
        else {
          const m = urls.map((x) => x.match(/^(.*\/web-app\/content\/[^/]+\/\d{4}\/)/)).find(Boolean);
          if (m) this.pBase = `${m[1]}fut/items/images/mobile/portraits/`;
        }
      }
      return this.pBase ? `${this.pBase}${id}.png` : '';
    },
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

  /**
   * Smart sniping memory (saved on this phone): per target, how each discount
   * did — searches, buys, lost races, near misses — and good signs by hour.
   */
  /** Price history of cards the bot has priced or scanned (no extra searches). */
  const prices = {
    data: store.get(KEYS.prices, {}),
    add(id, meta, lowest, listed) {
      this.data = prunePrices(addPriceSample(this.data, String(id), meta, lowest, listed, Date.now()));
      try { localStorage.setItem(KEYS.prices, JSON.stringify(this.data)); } catch {
        this.data = prunePrices(this.data, 150000); // storage full: keep less
        store.set(KEYS.prices, this.data);
        ui.log('Price history trimmed — phone storage is nearly full', 'warn');
      }
    },
    trend(id) { const c = this.data[String(id)]; return c ? priceTrend(c.s, Date.now()) : { n: 0, thin: true }; },
  };

  const learn = {
    data: store.get(KEYS.learn, { targets: {}, hours: {}, speed: { n: 0, ms: 0, lost: 0 } }),
    save() { store.set(KEYS.learn, this.data); },
    key(p) { return `${p.kind === 'filter' ? 'f' : 'p'}:${p.id}`; },
    // never closer than your own "Snipe % under avg" (cfg.discount)
    // 2.4.6: unless "Let it set the discount" is on, the learner only picks which card to search (one level = your Snipe %).
    levels(cfg) { const d = cfg.discount || 0; return cfg.smartPrice ? smartLevels(Math.max(cfg.smartMinPct, d), Math.max(cfg.smartMaxPct, d)) : [Math.max(1, d)]; },
    /** Targets the learner may price: priced, no manual max, Buy or Trade mode. */
    usable(p, cfg) { return !!p && cfg.smartSnipe && cfg.mode !== 'alert' && p.avg > 0 && !p.manualMax; },
    arms(p) { const t = this.data.targets[this.key(p)]; return (t && t.arms) || {}; },
    /** Next target + discount. Learnable targets compete by expected coins saved; others take turns. */
    pick(targets, cfg, i) {
      const smart = targets.filter((p) => this.usable(p, cfg));
      const plain = targets.filter((p) => !this.usable(p, cfg));
      if (!smart.length) return { player: playerForIteration(targets, i) };
      // plain targets keep their share of the searches
      if (plain.length && i % targets.length < plain.length) return { player: plain[i % plain.length] };
      const best = chooseTarget(smart.map((p) => ({ p, avg: p.avg, arms: this.arms(p) })), this.levels(cfg), Math.random, Date.now());
      return { player: best.target.p, pct: best.pct };
    },
    record(p, pct, outcome, cfg) {
      const k = this.key(p);
      const t = this.data.targets[k] || { name: p.name, arms: {} };
      t.name = p.name;
      // the card's price moved a lot (promo, crash): old evidence counts half
      if (priceShifted(t.refAvg, p.avg)) {
        for (const d of Object.keys(t.arms)) { const a = upgradeArm(t.arms[d]); t.arms[d] = { ...a, n: a.n / 2, good: a.good / 2, near: (a.near || 0) / 2, probes: (a.probes || 0) / 2 }; }
        t.refAvg = p.avg;
      }
      if (!t.refAvg) t.refAvg = p.avg;
      const levels = this.levels(cfg);
      const o = { ...outcome, at: Date.now(), missWeight: missWeight(this.data.speed) };
      if (outcome.probe) {
        const shallower = levels.filter((d) => d < pct);
        if (shallower.length) o.probeArm = shallower[shallower.length - 1];
        if (outcome.nearPrice) o.nearArm = deepestArmFor(outcome.nearPrice, p.avg, levels);
      }
      t.arms = recordArm(t.arms, pct, o);
      if (outcome.probe) t.gaps = recordGap(t.gaps, outcome.nearPrice, p.floor || p.avg, Date.now());
      this.data.targets[k] = t;
      const h = new Date().getHours();
      const hb = this.data.hours[h] || { n: 0, good: 0 };
      hb.n++; hb.good += outcome.hit ? 1 : outcome.miss ? 0.8 : outcome.nearPrice ? 0.35 : 0;
      this.data.hours[h] = hb;
      this.save();
    },
    speed(ms, lost) {
      const sp = this.data.speed || { n: 0, ms: 0, lost: 0 };
      sp.n++; sp.ms += ms; if (lost) sp.lost++;
      this.data.speed = sp;
      this.save();
    },
    reset() { this.data = { targets: {}, hours: {}, speed: { n: 0, ms: 0, lost: 0 } }; this.save(); },
  };

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
      this.lastStop = reason;
      this.running = false;
      keepAwake(false);
      this.setStatus('idle', 'Idle');
      ui.log(`Stopped — ${reason}`, 'warn');
      ui.setRunning(false);
      if (/limit|verification|blocked|errors|logged out|coins/i.test(reason)) notify.discord('stop', { reason });
      // 2.5.0: a short report of the session, with advice per card
      try {
        if (this.stats && this.stats.searches > 0) {
          const lines = this.report();
          lines.forEach((l, i) => ui.log(l, i ? 'muted' : 'ok'));
          notify.discord('info', { title: '📊 Session report', text: lines.join('\n').replace(/[📊💡] /g, '') });
        }
      } catch (e) { debugLog.push(`report: ${errText(e)}`); }
    },

    /** Session summary + one advice line per card with enough data. */
    report() {
      const cfg = this.cfg;
      const minutes = this.session ? Math.round((Date.now() - this.session.startedAt) / 60e3) : 0;
      const hrs = Object.entries(learn.data.hours || {}).filter(([, h]) => h.n >= 10).map(([h, x]) => [Number(h), x.good / x.n]).sort((a, b) => b[1] - a[1]);
      const lines = [sessionReport(this.stats, { minutes, near: this.nearCount || 0, bestHour: hrs.length && hrs[0][1] > 0 ? hrs[0][0] : null })];
      return lines.concat(this.advice());
    },

    /** Advice lines for the cards hunted this session (only with ≥ 60 Buy Now searches). */
    advice() {
      const cfg = this.cfg;
      const out = [];
      const fixes = [];
      for (const p of sniperTargets(cfg).filter((x) => x.kind !== 'filter')) {
        const ps = this.pstats && this.pstats.get(`${p.kind || 'p'}:${p.id}`);
        const ref = p.floor || p.lowest;
        if (!ps || !ref) continue;
        const g = gapStats((learn.data.targets[learn.key(p)] || {}).gaps);
        const o = { name: p.name, id: p.id, ref, bin: ps.bin, hits: ps.hits, pct: Math.max(0, Math.round((1 - effectiveMaxBuy(p, cfg) / ref) * 100)),
          probes: g.probes, near: g.near, nearPct: g.avgPct, ends: ps.ends, bidding: !!cfg.bidSnipe };
        const line = cardAdvice(o);
        if (line) { out.push(line); fixes.push({ text: line, fix: adviceFix(o) }); }
      }
      this.lastAdvice = fixes; // shown with Apply buttons in the setup card
      ui.renderSetup();
      return out;
    },

    /** Sleep that wakes early when stopped, and shows a countdown. */
    async wait(ms, state, text) {
      const until = Date.now() + ms;
      this.setStatus(state, text, until);
      const id = this.runId;
      while (this.running && id === this.runId && Date.now() < until) await sleep(Math.min(250, until - Date.now()));
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

    /** Search function for pricing a whole filter (e.g. "84–86 Premier League golds"). */
    filterSearch(f) {
      let first = true;
      return async (maxBuy) => {
        if (!first) await sleep(jitter(this.cfg.delayMin, this.cfg.delayMax));
        first = false;
        const res = await fut.search(fut.criteria({}, f, maxBuy));
        this.countUsage('searches');
        if (res.ok) res.listings = res.listings.filter((l) => (!f.minRating || l.rating >= f.minRating) && (!f.maxRating || l.rating <= f.maxRating));
        return res;
      };
    },

    /** Price-check players and set their max buy. Returns false if EA pushed back. */
    async priceCheck(players) {
      for (const player of players) {
        const gate = this.gate();
        if (!gate.ok) { ui.log(`Price check skipped — ${gate.reason}`, 'err'); return false; }
        this.setStatus('pricing', `Checking ${player.name}…`);
        const isFilter = player.kind === 'filter';
        const r = await findMarketPrice(isFilter ? this.filterSearch(player) : this.priceSearch(player), { defId: isFilter ? undefined : player.id });
        if (!r.ok) {
          const kind = classifyStatus(r.status);
          if (kind === 'captcha' || kind === 'throttled') { this.lock(kind, `EA pushback during price check (${r.status})`); sounds.alarm(); return false; }
          ui.log(`Price check failed for ${player.name} (${r.status})`, 'warn');
          continue;
        }
        player.checkedAt = Date.now();
        if (!r.count) {
          Object.assign(player, { avg: 0, lowest: 0, maxBuy: 0 });
          ui.log(`${player.name}: none listed right now — skipped until the next price check finds a price`, 'warn');
          continue;
        }
        let nudge = 0;
        let trendNote = '';
        if (!isFilter) {
          prices.add(player.id, { name: player.name, rating: player.rating }, r.floor || r.lowest, r.count);
          const tr = prices.trend(player.id);
          nudge = trendNudge(tr);
          trendNote = tr && !tr.thin ? ` · trend ${tr.pct > 0 ? '+' : ''}${tr.pct}%${nudge ? ` (falling → max ${nudge}% lower)` : ''}` : ' · trend: not enough history yet';
        }
        // Filters cover many different cards: they keep the market price; players use the cheapest real listing.
        const m = isFilter ? { avg: r.avg } : { avg: r.avg, floor: r.floor, second: r.second, nudge };
        const base = snipeBase(m, 'buy');
        const pct = (this.cfg.discount || 0) + nudge;
        const plan = planMaxBuy(base, pct, fut.coins() - this.cfg.minCoins);
        const reach = this.cfg.mode === 'trade' || isFilter || withinReach(plan.maxBuy, r.lowest);
        Object.assign(player, { avg: r.avg, lowest: r.lowest, listed: r.count, floor: m.floor || 0, second: m.second || 0, nudge, maxBuy: plan.maxBuy, outOfReach: !reach });
        const resale = this.cfg.mode === 'trade' ? snipeBase(m, 'trade') : 0;
        const flip = this.cfg.mode === 'trade' && r.count >= 3 && flipPlan(resale, tradeOpts(r.avg, this.cfg));
        if (this.cfg.mode === 'trade') {
          ui.log(`${player.name}: market ${fmt(r.avg)} · 2nd cheapest ${fmt(m.second || r.lowest)}${trendNote} → resale ${fmt(resale)} · ${flip ? `buy ≤ ${fmt(flip.maxBuy)}, sell ${fmt(flip.sell)} (+${fmt(flip.profit)} after tax)` : 'no profitable trade at your min profit'}`, flip ? 'ok' : 'warn');
        } else {
          ui.log(`${player.name}: ${isFilter ? `market ${fmt(r.avg)}` : `cheapest ${fmt(base)} · market ${fmt(r.avg)}`} · ${r.count} listed${trendNote} → max ${fmt(plan.maxBuy)}`
            + (plan.cappedByCoins ? ' (all your coins)' : ` (${pct}% under the ${isFilter ? 'market' : 'cheapest'})`)
            + (player.manualMax ? ` — your manual ${fmt(player.manualMax)} is used instead` : ''), 'ok');
          if (!reach && !player.manualMax) ui.log(`⏭️ ${player.name}: out of reach — your max is ${Math.round(plan.maxBuy / r.lowest * 100)}% of the cheapest listing, so it's skipped while sniping (set a manual max to hunt this player anyway)`, 'warn');
        }
      }
      return true;
    },

    async checkPricesNow() {
      if (this.running || this.busy) return;
      if (!fut.ready()) { ui.log('Web App not ready — log in first', 'err'); return; }
      if (!sniperTargets(this.cfg).length) { ui.log('Add a player or turn on a filter first', 'warn'); return; }
      this.busy = true; ui.setBusy(true);
      this.safety = store.get(KEYS.safety, {});
      try {
        await this.priceCheck(sniperTargets(this.cfg));
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
      if (plan.active) { plan.cancel(); if (jobs.current) jobs.cancel(); else if (this.running) this.stop('stopped by you'); return; }
      if (jobs.current) return jobs.cancel();
      if (this.running) this.stop('stopped by you'); else this.start();
    },

    async start() {
      if (this.running || this.busy || jobs.current) return;
      if (Date.now() - (jobs.freedAt || 0) < 35000) { ui.log('A stuck task was just freed — wait a few seconds before starting', 'warn'); return; }
      ui.commit(); // pick up a field that was typed but not yet saved
      if (!fut.ready()) { ui.log('Web App not ready — log in and open Transfers first', 'err'); return; }
      const { cfg, changed } = clampConfig(this.cfg);
      if (changed.length) ui.log(`Raised to safe minimums: ${changed.join(', ')}`, 'warn');
      this.cfg = cfg; this.save(); ui.syncForm();
      const hasFilter = cfg.level !== 'any' || cfg.rarity || cfg.position || cfg.nation || cfg.league || cfg.club || cfg.minRating > 0;
      if (!sniperTargets(cfg).length && !hasFilter) {
        ui.log('Add a player or turn on a search filter first — otherwise it would buy any card under your max', 'warn');
        ui.toast('Add a player first — ▶ starts the sniper', 'alert');
        return;
      }
      this.safety = store.get(KEYS.safety, {});
      const gate = this.gate();
      if (!gate.ok) { ui.log(`Can't start — ${gate.reason}`, 'err'); ui.renderStatus(); return; }

      this.running = true;
      this.runId = (this.runId || 0) + 1;
      ui.setRunning(true);
      keepAwake(true);
      this.session = { startedAt: Date.now(), endsAt: Date.now() + cfg.sessionMinutes * 60e3 };

      try {
        if (cfg.autoRelist) await this.tidy();
        if (this.running && cfg.autoPrice && sniperTargets(cfg).length) {
          const stale = sniperTargets(cfg).filter((p) => !p.manualMax && (!p.checkedAt || Date.now() - p.checkedAt > 15 * 60e3));
          if (stale.length) {
            const ok = await this.priceCheck(stale);
            this.save(); ui.renderPlayers();
            if (!this.running) return;
            if (!ok) { this.stop('price check stopped by EA — see log'); return; }
            await this.wait(jitter(cfg.delayMin, cfg.delayMax), 'waiting', 'Starting');
          }
        }
        if (!this.running) return;
        if (sniperTargets(cfg).length && !huntTargets(cfg).length && !hasFilter) {
          this.stop('every player on your list costs far more than your coins — add players you can afford, or set a manual max');
          return;
        }
        const who = huntTargets(cfg).length
          ? huntTargets(cfg).map((p) => {
            const { maxBuy, plan } = this.planFor(p);
            return plan ? `${p.name} (buy ≤ ${fmt(maxBuy)} → sell ${fmt(plan.sell)})` : `${p.name} ≤ ${fmt(maxBuy)}`;
          }).join(', ')
          : `filters ≤ ${fmt(cfg.maxBuy)}`;
        ui.log(`${{ alert: 'Watching', trade: 'Trading' }[cfg.mode] || 'Sniping'} ${who}${cfg.bidSnipe && cfg.mode !== 'alert' ? ' · bidding on auctions ending soon' : ''}`, 'ok');
        await this.loop(this.runId);
      } catch (e) {
        this.stop(`error: ${errText(e)}`);
      }
    },

    /** Max buy (and resale plan in Trade mode) for a player this search. */
    planFor(player) {
      const cfg = this.cfg;
      if (cfg.mode !== 'trade') return { maxBuy: effectiveMaxBuy(player, cfg), plan: null };
      // under 3 listed the "market" can be one overpriced card: no trade
      if (player && player.listed > 0 && player.listed < 3) return { maxBuy: 0, plan: null };
      const plan = player && flipPlan(snipeBase(player.kind === 'filter' ? { avg: player.avg } : player, 'trade'), tradeOpts(player.avg, cfg));
      if (!plan) return { maxBuy: 0, plan: null };
      const cap = roundPrice(tradeCap(cfg, fut.coins()), 'down'); // never too many coins on one card
      return { maxBuy: Math.min(plan.maxBuy, player.manualMax || Infinity, cap), plan };
    },

    async loop(runId) {
      const cfg = this.cfg;
      const mine = () => this.running && (runId === undefined || runId === this.runId);
      const startSearches = this.stats.searches;
      const startBuys = this.stats.buys;
      const alerted = new Set();
      const skipped = new Set();
      let errors = 0;
      let i = 0;
      let fullWarned = false;
      const beat = { next: 25, per: new Map(), under: 0 };
      this.listStarted = sniperTargets(cfg).length > 0;
      this.reserveWarned = new Set();
      this.turns = new Map();
      this.dry = new Map();
      this.pstats = new Map();
      this.nearCount = 0;
      this.idleSaid = false;
      this.nextUpkeep = cfg.mode === 'trade' ? Date.now() : Date.now() + cfg.upkeepMinutes * 60e3;
      // Bids restored after a reload: collect them as soon as they have ended.
      for (const b of this.bids.values()) this.nextUpkeep = Math.min(this.nextUpkeep, b.endsAt + 8000);

      while (mine()) {
        let limit = '';
        if (this.stats.searches - startSearches >= cfg.maxSearches) limit = 'session search limit reached';
        else if (this.stats.buys - startBuys >= cfg.maxBuys) limit = 'session buy limit reached';
        else if (Date.now() >= this.session.endsAt) limit = `${cfg.sessionMinutes} min session limit — take a break`;
        if (limit) { await this.finishBids(); return this.stop(limit); }
        const gate = this.gate();
        if (!gate.ok) return this.stop(gate.reason);
        if (cfg.goal && fut.coins() >= cfg.goal.coins) {
          const g = cfg.goal;
          cfg.goal = null;
          if (g.prevMode) cfg.mode = g.prevMode; // back to the mode you had before the goal
          this.save(); ui.syncForm();
          await this.finishBids();
          sounds.buy();
          ui.toast(`🎯 Goal reached: ${fmt(fut.coins())}`, 'ok');
          notify.discord('info', { title: '🎯 Coin goal reached', text: `${fmt(fut.coins())} coins — open the SBC tab and tap Solve for ${g.label}` });
          ui.renderGoal();
          return this.stop(`🎯 goal reached — ${fmt(fut.coins())} coins; open the SBC tab and tap Solve for ${g.label}`);
        }
        const listMode = cfg.mode === 'buy';
        const spendable = listMode ? listSpendable(cfg, fut.coins()) : fut.coins() - cfg.minCoins;
        if (listMode && cfg.spendLimit > 0 && spendable < MIN_PRICE) { await this.finishBids(); return this.stop(`spend limit reached (${fmt(cfg.listSpent)} of ${fmt(cfg.spendLimit)})`); }
        if (cfg.mode !== 'alert' && spendable < MIN_PRICE) return this.stop('not enough coins');
        if (listMode && this.listStarted && !sniperTargets(cfg).length) { await this.finishBids(); return this.stop('priority list complete 🎉'); }

        // Transfer list upkeep (Trade mode, or when bids are waiting to be collected).
        if ((cfg.mode === 'trade' || this.bids.size) && Date.now() >= this.nextUpkeep) {
          await this.upkeep();
          this.nextUpkeep = Date.now() + cfg.upkeepMinutes * 60e3;
          if (!this.running) return;
        }

        // Never fall back to "any card" because every player went out of reach.
        if (sniperTargets(cfg).length && !huntTargets(cfg).length) { await this.finishBids(); return this.stop('every player left is out of reach of your coins'); }
        // Bid wars: when one of our auctions is in its last seconds, check it (instead of a search) and counter-bid.
        if (cfg.bidSnipe && cfg.mode !== 'alert' && this.warDue()) {
          await this.warCheck(startBuys);
          this.stats.searches++;
          this.countUsage('searches');
          ui.renderStats();
          if (!this.running) return;
          await this.wait(jitter(cfg.delayMin, cfg.delayMax), 'waiting', 'Bid war');
          continue;
        }
        // 2.4.9: only search players you can afford right now (coins held in open bids don't count).
        const hunt = huntTargets(cfg);
        const free = cfg.mode === 'alert' ? Infinity : freeCoins(cfg, fut.coins(), [...this.bids.values()]);
        const priceOf = (p) => p.floor || p.lowest || effectiveMaxBuy(p, cfg) || 0;
        const reachable = hunt.filter((p) => (p.kind === 'filter' ? free >= MIN_PRICE : withinReach(free, priceOf(p))));
        const affordable = reachable.filter((p) => !skipped.has(p.id)); // ones with no buy price yet are skipped, not searched
        if (reachable.length && !affordable.length) return this.stop('no player or filter can be bought right now — none listed / no profitable price; check prices or Min profit');
        if (hunt.length && !affordable.length) {
          const cheapest = Math.min(...hunt.map(priceOf).filter((x) => x > 0)) || 0;
          if (this.bids.size) {
            if (!this.idleSaid) {
              this.idleSaid = true;
              ui.log(`💤 Can't afford any target right now (free ${fmt(free)}, cheapest ${fmt(cheapest)}) — no searches until your open bid${this.bids.size === 1 ? '' : 's'} end${this.bids.size === 1 ? 's' : ''}`, 'muted');
            }
            const soon = Math.min(this.nextUpkeep, ...[...this.bids.values()].map((b) => b.endsAt - ((cfg.bidWindow || 45) + 5) * 1000));
            await this.wait(Math.max(1000, Math.min(15000, soon - Date.now())), 'waiting', 'Waiting for your open bids');
            continue;
          }
          await this.finishBids();
          return this.stop(`can't afford any target (free ${fmt(free)}, cheapest ${fmt(cheapest)})`);
        }
        this.idleSaid = false;
        const pick = learn.pick(affordable, cfg, i);
        const player = pick.player;
        // Prices drift — refresh a player's (or filter's) market price during long sessions.
        if (player && cfg.autoPrice && !player.manualMax && Date.now() - (player.checkedAt || 0) > cfg.repriceMinutes * 60e3) {
          const ok = await this.priceCheck([player]);
          this.save(); ui.renderPlayers(); ui.renderTrade();
          if (!this.running) return;
          if (!ok) return this.stop('price check stopped by EA — see log');
          await this.wait(jitter(cfg.delayMin, cfg.delayMax), 'waiting', 'Next search');
          continue;
        }

        const planned = this.planFor(player);
        const plan = planned.plan;
        let maxBuy = planned.maxBuy;
        // Smart sniping: the learned discount, never above your coins / profitable price.
        let smartPct = 0;
        // the search is recorded under this level (for picking targets) even when the learner doesn't set the price
        const armPct = cfg.smartPrice ? 0 : (pick.pct && maxBuy ? pick.pct : 0);
        if (pick.pct && maxBuy && cfg.smartPrice) {
          const cap = cfg.mode === 'trade' ? maxBuy : Math.min(roundPrice(spendable, 'down'), roundPrice(player.avg * (1 - (cfg.discount || 0) / 100), 'down'));
          const learned = roundPrice(player.avg * (1 - pick.pct / 100), 'down');
          if (learned >= MIN_PRICE && learned <= cap) { maxBuy = learned; smartPct = pick.pct; }
          else if (learned > cap && cfg.mode === 'trade') smartPct = 0;
        }
        if (!maxBuy) {
          if (player && !skipped.has(player.id)) {
            skipped.add(player.id);
            ui.log(`${player.name}: no profitable buy price yet (needs a price check, or Min profit is too high) — skipping`, 'warn');
          }
          i++;
          if (huntTargets(cfg).every((p) => skipped.has(p.id))) return this.stop('no player or filter can be traded for profit — check prices / Min profit');
          await this.wait(300, 'waiting', 'Next target'); // never spin without yielding
          continue;
        }
        const tradeFull = cfg.mode === 'trade' && fut.transferSpace() <= 0;
        if (tradeFull && !fullWarned) { fullWarned = true; ui.log('Transfer list full — waiting for sales before buying more', 'warn'); }
        if (!tradeFull) fullWarned = false;

        // Buy Now and auction searches alternate per player (a global flip skipped some players' auctions)
        const turnKey = player ? `${player.kind || 'p'}:${player.id}` : '';
        const turnN = (this.turns.get(turnKey) || 0) + 1;
        this.turns.set(turnKey, turnN);
        // 2.4.9: a long dry spell on Buy Now switches this player to auction-only searches for a while
        const dry = this.dry.get(turnKey) || { n: 0, left: 0, on: false };
        this.dry.set(turnKey, dry);
        const canBid = cfg.bidSnipe && cfg.mode !== 'alert';
        if (dry.on && (!dry.left || !canBid)) { dry.on = false; dry.n = 0; if (player) ui.log(`🔁 ${player.name}: back to Buy Now`, 'muted'); }
        const bidTurn = canBid && (dry.on ? (dry.left--, true) : turnN % 2 === 0);
        // Now and then look a little above the max to spot near misses (never buys above the max).
        const probe = !bidTurn && (smartPct || armPct) && cfg.smartProbeEvery > 0 && Math.random() < 1 / cfg.smartProbeEvery;
        const searchMax = probe ? roundPrice(maxBuy * 1.04, 'up') : maxBuy;
        this.setStatus('searching', `${bidTurn ? 'Auctions' : 'Searching'} ${player ? player.name : ''} ≤ ${fmt(maxBuy)}${smartPct ? ` (${smartPct}% under)` : ''}`.replace('  ', ' '));
        const res = await fut.search(bidTurn ? fut.criteria(cfg, player, 0, i, maxBuy) : fut.criteria(cfg, player, searchMax, i));
        this.searchDoneAt = performance.now();
        i++;
        this.stats.searches++;
        this.countUsage('searches');
        if (player) beat.per.set(player.name, (beat.per.get(player.name) || 0) + 1);
        if (res.ok) beat.under += res.listings.filter((l) => l.buyNowPrice > 0 && l.buyNowPrice <= maxBuy).length;
        if (this.stats.searches - startSearches >= beat.next) {
          beat.next += 25;
          const gaps = huntTargets(cfg).filter((p) => p.lowest && p.kind !== 'filter').map((p) => {
            const mx = effectiveMaxBuy(p, cfg);
            const g = gapStats(((learn.data.targets[learn.key(p)] || {}).gaps));
            const ps = this.pstats.get(`${p.kind || 'p'}:${p.id}`);
            const verdict = ps ? ` · ${p.name}: Buy Now ${ps.hits}/${ps.bin} at ≤ ${fmt(mx)}${ps.ends.length ? ` · auctions near the end ~${Math.round(ps.ends.reduce((a, x) => a + x, 0) / ps.ends.length * 10) / 10}% under the cheapest (${ps.ends.length})` : ''}` : '';
            return `${p.name} ${fmt(mx)} vs cheapest ${fmt(p.lowest)} (${Math.max(0, Math.round((1 - mx / p.lowest) * 100))}% under)${verdict}${g.probes ? ` · near-miss checks ${g.probes}, ${g.near} found${g.near ? ` (avg ${g.avgPct}% under the cheapest)` : ''}` : ''}`;
          });
          if ((this.stats.searches - startSearches) % 100 === 0) this.advice().forEach((l) => ui.log(l, 'muted'));
          if (cfg.goal) ui.log(`🎯 Goal ${fmt(cfg.goal.coins)} · now ${fmt(fut.coins())} (${Math.min(100, Math.round(fut.coins() / cfg.goal.coins * 100))}%) — ${cfg.goal.label}`, 'muted');
          ui.log(`🔎 Still sniping — ${this.stats.searches - startSearches} searches (${[...beat.per].map(([n, c]) => `${n} ${c}`).join(', ')}) · ${beat.under} listing${beat.under === 1 ? '' : 's'} under your max${gaps.length ? ` · ${gaps.join(' · ')}` : ''}`, 'muted');
        }

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
          if (cfg.liveLog) ui.log(auctionReport({ n: this.stats.searches, name: player && player.name, maxBid: maxBuy, windowSec: cfg.bidWindow, listings: player && player.kind !== 'filter' ? res.listings.filter((l) => !l.defId || l.defId === player.id) : res.listings }), 'muted');
          if (!tradeFull) await this.bidOn(res.listings, player, maxBuy, plan, this.stats.buys - startBuys);
        } else {
          if (cfg.liveLog) {
            const own = player && player.kind !== 'filter' ? res.listings.filter((l) => !l.defId || l.defId === player.id) : res.listings;
            ui.log(searchReport({ n: this.stats.searches, name: player && player.name, max: maxBuy, searchMax, probe, listings: own, cheapest: player && (player.floor || player.lowest) }), 'muted');
          }
          errors = 0;
          const range = player && player.kind === 'filter' ? { minRating: player.minRating || 0, maxRating: player.maxRating || 0 } : {};
          // A player hunt matches every version of the card (maskedDefId): only buy the exact card you added.
          const buyable = player && player.kind !== 'filter' ? res.listings.filter((l) => !l.defId || l.defId === player.id) : res.listings;
          const targets = pickTargets(buyable, { ...cfg, ...range, maxBuy }, cfg.mode === 'alert' ? Infinity : Math.min(spendable, freeCoins(cfg, fut.coins(), [...this.bids.values()])));
          const outcome = { hit: 0, miss: 0, near: 0 };
          // Many copies under your max in one search = the market dropped: re-check the price next turn.
          if (player && player.kind !== 'filter' && cfg.autoPrice && !player.manualMax
            && res.listings.filter((l) => l.buyNowPrice > 0 && l.buyNowPrice <= maxBuy && l.defId === player.id).length >= 3) {
            player.checkedAt = 0;
            ui.log(`📉 ${player.name}: several listed under your max — the price is dropping, re-checking it next`, 'muted');
          }
          const mine = res.listings.filter((l) => l.buyNowPrice > 0 && (!player || player.kind === 'filter' || l.defId === player.id));
          if (probe) {
            outcome.probe = true;
            const above = mine.filter((l) => l.buyNowPrice > maxBuy && l.buyNowPrice <= searchMax).map((l) => l.buyNowPrice);
            if (above.length) { outcome.near = 1; outcome.nearPrice = Math.min(...above); this.nearCount = (this.nearCount || 0) + 1; }
          }
          for (const t of targets) {
            if (!this.running) break;
            if (cfg.mode !== 'alert') {
              // Several buys from one search: re-check the limits before each one.
              if (this.stats.buys - startBuys + this.bids.size >= cfg.maxBuys) break; // an open bid may still become a buy
              if (listMode && cfg.buyOnce && player && player.kind !== 'filter' && !cfg.players.some((p) => p.id === player.id)) break;
              const left = freeCoins(cfg, fut.coins(), [...this.bids.values()]); // coins held for open bids are not free
              if (t.buyNowPrice > left) continue;
            }
            if (cfg.mode === 'alert') {
              if (alerted.has(t.tradeId)) continue;
              alerted.add(t.tradeId);
              ui.log(`👀 ${t.name} (${t.rating || '?'}) listed at ${fmt(t.buyNowPrice)}`, 'alert');
              ui.toast(`${t.name} at ${fmt(t.buyNowPrice)}`, 'alert');
              sounds.alert();
              notify.discord('alert', { name: t.name, price: t.buyNowPrice, maxBuy });
            } else if (!tradeFull) {
              const r = await this.attempt(t, player, plan);
              if (r === 'bought') outcome.hit++;
              else if (r === 'missed') outcome.miss++;
            }
          }
          if (player) {
            const ps = this.pstats.get(turnKey) || { bin: 0, hits: 0, ends: [] };
            ps.bin++; if (outcome.hit) ps.hits++;
            this.pstats.set(turnKey, ps);
            if (outcome.hit) dry.n = 0;
            else if (++dry.n >= (cfg.dryTurns || Infinity) && canBid && !dry.on) {
              dry.on = true; dry.left = Math.max(1, cfg.dryAuctionSearches || 60);
              ui.log(`🔁 ${player.name}: ${cfg.dryTurns} Buy Now searches with nothing — the next ${dry.left} searches for ${player.name} are auctions only (late bids)`, 'warn');
            }
          }
          if ((smartPct || armPct) && player) {
            learn.record(player, smartPct || armPct, outcome, cfg);
            const ref = player.floor || player.avg;
            if (outcome.near && !outcome.hit) ui.log(`🎯 Near miss: ${player.name} listed at ${fmt(outcome.nearPrice)}, just above your ${fmt(maxBuy)}${ref ? ` (${Math.round((1 - outcome.nearPrice / ref) * 100)}% under the cheapest)` : ''} — noted`, 'muted');
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

    // tradeId -> { name, amount, endsAt, player, plan, debited } — saved, so won auctions are still collected and counted after a reload
    bids: new Map((() => { const v = store.get(KEYS.bids, []); return Array.isArray(v) ? v.filter((e) => Array.isArray(e) && e[1] && e[1].amount > 0) : []; })()),
    saveBids() {
      store.set(KEYS.bids, [...this.bids].map(([id, b]) => [id, { ...b, player: b.player ? { id: b.player.id, name: b.player.name, kind: b.player.kind, avg: b.player.avg } : null }]));
    },

    /** A won auction: book it; a second copy (Buy Now won the priority) is resold at a profit. */
    async collectWon(it, bid, st) {
      const p = fut.toPlayer(it);
      const price = st.price || (bid && bid.amount) || 0;
      let plan = bid && bid.plan;
      if (bid && bid.resell) {
        const sell = Math.max(breakEvenSell(price, this.cfg.minProfit || 0), bid.avg ? roundPrice(bid.avg * 0.97, 'down') : 0);
        plan = { sell, maxBuy: price, profit: profit(price, sell) };
        ui.log(`Second copy of ${p.name} — listing it for ${fmt(sell)}`, 'muted');
      }
      await this.bought(it, { name: p.name, rating: p.rating, defId: p.id, price }, bid && bid.player, plan, 'bid');
    },

    /** Is one of our auctions in its last seconds (time to check for a counter-bid)? */
    warDue() {
      const soon = Date.now() + ((this.cfg.bidWindow || 30) + 5) * 1000;
      return [...this.bids.values()].some((b) => !b.gaveUp && b.endsAt <= soon && Date.now() - (b.checkedAt || 0) >= 3000 && Date.now() < b.endsAt + 15000);
    },

    /**
     * One watchlist check for every open bid: book wins, clear losses, and
     * counter-bid when outbid — up to the war ceiling, the counter limit, the
     * war coin pool and the shared spend limits.
     */
    async warCheck(startBuys) {
      const cfg = this.cfg;
      this.setStatus('searching', 'Bid war — checking your auctions');
      const watched = await fut.watched();
      if (!watched) return;
      const lost = [];
      const now = Date.now();
      for (const it of watched) {
        const st = fut.auctionState(it);
        const bid = this.bids.get(st.tradeId);
        if (!bid) continue;
        bid.checkedAt = now;
        const l = fut.listing(it);
        if (st.state === 'won') { this.bids.delete(st.tradeId); await this.collectWon(it, bid, st); continue; }
        if (st.state === 'lost' || st.state === 'expired') { lost.push(it); this.bids.delete(st.tradeId); if (bid.counters) ui.log(`🏳️ Lost the bid war on ${bid.name} at ${fmt(l.currentBid || bid.amount)}`, 'muted'); continue; }
        if (l.expires > 0) bid.endsAt = now + l.expires * 1000; // a late bid extends the timer
        if (l.bidState === 'highest' || bid.gaveUp) continue;
        // Outbid: counter only in the last seconds (bidding earlier just invites more bids).
        if (!(l.expires > 0 && l.expires <= (cfg.bidWindow || 30))) continue;
        bid.current = l.currentBid || bid.amount;
        const ceiling = warCeiling(bid, cfg);
        const next = nextPrice(bid.current);
        const wars = [...this.bids.values()].filter((b) => b.counters > 0 && !b.gaveUp && b !== bid).length;
        const others = [...this.bids.entries()].filter(([k]) => k !== st.tradeId).map(([, b]) => b);
        const pool = Math.max(0, fut.coins() - (cfg.minCoins || 0)) * Math.max(5, Math.min(100, cfg.bidWarPoolPct ?? 25)) / 100;
        const inWars = others.filter((b) => b.counters > 0).reduce((a, b) => a + b.amount, 0);
        let why = '';
        if (next > ceiling) why = `next bid ${fmt(next)} is over the war limit ${fmt(ceiling)}`;
        else if (bid.counters >= (cfg.bidWarMaxCounters ?? 5)) why = `${bid.counters} counter-bids without winning`;
        else if (!bid.counters && wars >= Math.max(1, Math.min(3, cfg.bidWars || 1))) why = `already in ${wars} bid war${wars === 1 ? '' : 's'}`;
        else if (!bid.counters && warSteps(bid.current, ceiling) < (cfg.bidWarMinSteps ?? 2)) why = 'too little room under the war limit';
        else if (inWars + next > pool) why = 'the war coin pool is used up';
        else {
          const block = bidBlock(next, bid.player, cfg, fut.coins(), others, this.stats.buys - startBuys);
          // (this bid itself is left out of `others`: a counter-bid replaces it)
          if (block) why = { coins: 'not enough free coins', buys: 'session buy limit', reserve: 'keeping coins for higher players', once: 'already buying this player' }[block] || block;
        }
        if (why) { bid.gaveUp = true; this.nextUpkeep = Math.min(this.nextUpkeep, bid.endsAt + 8000); ui.log(`🏳️ Letting ${bid.name} go at ${fmt(bid.current)} — ${why}`, 'muted'); continue; }
        const before = fut.coins();
        const r = await fut.placeBid(l, next);
        if (!r.ok) {
          const kind = classifyStatus(r.status);
          if (kind === 'captcha' || kind === 'throttled') { this.saveBids(); return this.halt(kind, `blocked while bidding (${r.status})`); }
          ui.log(`Counter-bid on ${bid.name} at ${fmt(next)} failed (${r.status})`, 'muted');
          continue;
        }
        bid.counters++;
        bid.amount = next;
        bid.current = next;
        bid.debited = before - fut.coins() >= next;
        bid.endsAt = Date.now() + Math.max(l.expires || 0, 30) * 1000;
        ui.log(`⚔️ Counter-bid ${fmt(next)} on ${bid.name} (${bid.counters}/${cfg.bidWarMaxCounters ?? 5}, limit ${fmt(ceiling)})`, 'ok');
        await sleep(jitter(700, 1400));
      }
      if (lost.length) await fut.untarget(lost);
      this.saveBids();
      ui.renderStats();
    },

    async bidOn(listings, player, maxBid, plan, sessionBuys) {
      const cfg = this.cfg;
      // A filter's rating range, like pickTargets does for Buy Now.
      const lo = (player && player.kind === 'filter' && player.minRating) || 0;
      const hi = (player && player.kind === 'filter' && player.maxRating) || 0;
      const why = new Map(); // reason -> count, for one live-update line
      const note = (r) => why.set(r, (why.get(r) || 0) + 1);
      const seen = this.seenAuctions || (this.seenAuctions = new Map());
      // a player search matches every version of the card: bid only on the exact card you added (review fix)
      const exact = player && player.kind !== 'filter' ? listings.filter((l) => !l.defId || l.defId === player.id) : listings;
      for (const l of exact.slice().sort((a, b) => (a.expires || 0) - (b.expires || 0))) {
        // remember auctions seen early, to say later what they ended up at (no extra searches)
        const cur = l.currentBid > 0 ? l.currentBid : l.startingBid || 0;
        const was = seen.get(l.tradeId);
        if (!was && l.expires > cfg.bidWindow) {
          seen.set(l.tradeId, { bid: cur, left: l.expires, name: l.name });
          if (seen.size > 20) seen.delete(seen.keys().next().value);
        } else if (was && !was.told && l.expires <= cfg.bidWindow && cfg.liveLog) {
          was.told = true;
          const next = l.currentBid > 0 ? nextPrice(l.currentBid) : cur;
          const key = player ? `${player.kind || 'p'}:${player.id}` : '';
          const ref = player && (player.floor || player.lowest);
          const ps = this.pstats && this.pstats.get(key);
          if (ps && ref) { ps.ends.push(Math.round((1 - cur / ref) * 1000) / 10); if (ps.ends.length > 30) ps.ends.shift(); }
          if (next > maxBid) ui.log(`🔨 ${l.name}: an auction seen at ${fmt(was.bid)} with ${shortTime(was.left)} left is at ${fmt(cur)} with ${shortTime(l.expires)} to go — over your max ${fmt(maxBid)}`, 'muted');
        }
        if (!this.running) break;
        if (this.bids.size >= cfg.maxActiveBids) { note(`already ${cfg.maxActiveBids} open bids`); continue; }
        if (this.bids.has(l.tradeId)) { note('already bid'); continue; }
        if ((lo && (l.rating || 0) < lo) || (hi && (l.rating || 0) > hi)) { note('outside the filter rating'); continue; }
        const amount = bidAmount(l, maxBid, cfg.bidWindow);
        if (!amount) { note(bidSkipReason(l, maxBid, cfg.bidWindow) || 'skipped'); continue; }
        // Same limits as Buy Now, with every open bid counted as coins spent and a buy made.
        const before = fut.coins();
        const block = bidBlock(amount, player, cfg, before, [...this.bids.values()], sessionBuys);
        if (block === 'buys' || block === 'once') { note(block === 'buys' ? 'session buy limit' : 'bought once already'); break; }
        if (block) { note(block === 'coins' ? `not enough free coins (${fmt(freeCoins(cfg, before, [...this.bids.values()]))})` : `limit: ${block}`); continue; }
        const r = await fut.placeBid(l, amount);
        if (!r.ok) {
          const kind = classifyStatus(r.status);
          if (kind === 'captcha' || kind === 'throttled') return this.halt(kind, `blocked while bidding (${r.status})`);
          if (kind === 'coins') return;
          ui.log(`Bid on ${l.name} at ${fmt(amount)} failed (${r.status})`, 'muted');
          continue;
        }
        this.bids.set(l.tradeId, { name: l.name, amount, endsAt: Date.now() + (l.expires || 30) * 1000, player, plan, debited: before - fut.coins() >= amount,
          defId: l.defId, maxBid, avg: (player && player.avg) || (plan && plan.sell) || 0, buyNow: l.buyNowPrice || 0, counters: 0 });
        this.saveBids();
        this.nextUpkeep = Math.min(this.nextUpkeep, Date.now() + ((l.expires || 30) + 8) * 1000);
        ui.log(`🔨 Bid ${fmt(amount)} on ${l.name} (${l.rating || '?'}) — ends in ${Math.round(l.expires)}s`, 'ok');
        await sleep(jitter(700, 1400));
      }
      if (cfg.liveLog && why.size) ui.log(`   not bid: ${[...why].map(([r, n]) => `${n} ${r}`).join(' · ')}`, 'muted');
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
      if (cfg.mode === 'buy' && player) {
        Object.assign(cfg, afterListBuy(cfg, player.id, info.price));
        this.save();
        if (cfg.buyOnce && player.kind !== 'filter') ui.log(`${player.name} ticked off your list${cfg.players.length ? ` — ${cfg.players.length} left` : ''}`, 'ok');
        ui.renderPlayers();
      }
      ui.renderStats(); ui.renderHistory(); ui.renderTrade();
      notify.discord('buy', entry);
    },

    async attempt(t, player, plan) {
      const cfg = this.cfg;
      if (cfg.mode === 'buy' && player) {
        const idx = cfg.players.findIndex((p) => p.id === player.id);
        if (!reserveOk(cfg.players, idx, t.buyNowPrice, listSpendable(cfg, fut.coins()), cfg)) {
          if (!this.reserveWarned.has(player.id)) {
            this.reserveWarned.add(player.id);
            ui.log(`Skipped ${t.name} at ${fmt(t.buyNowPrice)} — keeping coins for players higher on your list`, 'muted');
          }
          return 'skipped';
        }
      }
      // A bid war on the same player: the user's priority rule decides.
      const war = player && [...this.bids.values()].find((b) => !b.gaveUp && b.player && b.player.id === player.id);
      if (war) {
        const next = nextPrice(war.current || war.amount);
        const ceiling = warCeiling(war, cfg);
        const pick = binVsWar(t.buyNowPrice, next <= ceiling ? next : 0, war.avg || player.avg, cfg);
        if (pick === 'war') { ui.log(`⚔️ Kept the bid war on ${war.name} (next bid ${fmt(next)} is still a better deal than Buy Now at ${fmt(t.buyNowPrice)})`, 'muted'); return 'skipped'; }
        war.gaveUp = true;
        war.resell = true; // if we still win it, it's a second copy: resell it
        this.saveBids();
        ui.log(pick === 'ideal'
          ? `💎 ${t.name} at ${fmt(t.buyNowPrice)} is too good to skip — buying it; the bid war's card (if won) will be resold`
          : `🛒 Buy Now beats the bid war on ${war.name} — buying at ${fmt(t.buyNowPrice)}, letting the war go`, 'ok');
      }
      const react = Math.round(performance.now() - (this.searchDoneAt || performance.now()));
      const t0 = performance.now();
      const r = await fut.buy(t);
      const rtt = Math.round(performance.now() - t0);
      if (!r.ok) {
        this.stats.missed++;
        const kind = classifyStatus(r.status);
        if (kind === 'captcha' || kind === 'throttled') { this.halt(kind, `blocked while buying (${r.status})`); return 'blocked'; }
        if (kind === 'coins') { this.stop('not enough coins'); return 'coins'; }
        learn.speed(react + rtt, true);
        ui.log(`Missed ${t.name} at ${fmt(t.buyNowPrice)} (${r.status}) — someone was faster · you: ${react} ms to react + ${rtt} ms to EA`, 'muted');
        return 'missed';
      }
      learn.speed(react + rtt, false);
      await this.bought(t.item, { name: t.name, rating: t.rating, defId: t.defId, price: t.buyNowPrice }, player, plan, 'buy');
      return 'bought';
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
        out.relisted = await this.relistSmart(items);
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
              this.saveBids();
              out.won++;
              await this.collectWon(it, bid, st);
            } else if (st.state === 'lost' || st.state === 'expired') {
              lost.push(it);
              this.bids.delete(st.tradeId);
            }
          }
          if (lost.length) { await fut.untarget(lost); out.lost = lost.length; ui.log(`Outbid on ${lost.length} auction${lost.length === 1 ? '' : 's'} — cleared`, 'muted'); }
        }
        // Forget bids long past their end that never showed up.
        for (const [id, b] of this.bids) if (Date.now() - b.endsAt > 10 * 60e3) this.bids.delete(id);
        this.saveBids();
      }
      this.listedNow = out.active;
      ui.renderTrade(); ui.renderHistory();
      if (this.running) this.setStatus('waiting', 'Next search');
      return out;
    },

    /**
     * Relist expired cards at today's price: one step under the cheapest listing,
     * but never below what you paid + Min profit after tax. After "Cut losses
     * after" failed relists, it may drop to break-even. Cards the bot didn't buy
     * are relisted at their old price.
     */
    async relistSmart(items) {
      const cfg = this.cfg;
      const expired = items.filter((it) => fut.auctionState(it).state === 'expired');
      let repriced = 0;
      for (const it of expired.slice(0, cfg.smartRelist ? 5 : 0)) {
        const entry = this.history.find((e) => e.itemId === it.id && !e.soldFor);
        if (!entry) continue;
        const res = await fut.search(fut.criteria({}, { id: it.definitionId }, 0));
        this.countUsage('searches');
        if (!res.ok) { const k = classifyStatus(res.status); if (k === 'captcha' || k === 'throttled') { this.halt(k, `blocked while repricing (${res.status})`); return repriced; } continue; }
        const lowest = res.listings.filter((l) => l.defId === it.definitionId && l.buyNowPrice).map((l) => l.buyNowPrice).sort((a, b) => a - b)[0];
        const tries = (entry.relists || 0) + 1;
        const cut = cfg.cutLossAfter > 0 && tries > cfg.cutLossAfter;
        const floor = breakEvenSell(entry.price, cut ? 0 : cfg.minProfit || 0);
        const price = Math.max(floor, lowest ? prevPrice(lowest) : (entry.sell || floor));
        const r = await fut.relistItem(it, price, cfg.listDuration);
        if (r.ok) {
          repriced++;
          entry.relists = tries;
          entry.sell = price;
          ui.log(`Relisted ${entry.name} at ${fmt(price)}${lowest ? ` (cheapest ${fmt(lowest)})` : ''}${cut ? ' — break-even' : ''}`, 'muted');
        }
        await sleep(jitter(cfg.delayMin, cfg.delayMax)); // same pacing as searches
      }
      store.set(KEYS.history, this.history);
      // everything else (cards the bot didn't buy): relist at the old price
      const rest = expired.length - repriced;
      if (rest > 0 && await fut.relistExpired()) ui.log(`Relisted ${rest} other expired item${rest === 1 ? '' : 's'} at their old price`, 'muted');
      return expired.length;
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
  const LOG_KEEP = 1500; // log lines kept across reloads (newest win)
  const debugLog = []; // technical details for "Copy log" (kept across reloads too)
  try { debugLog.push(...(JSON.parse(localStorage.getItem('fc-sniper:debug') || '[]') || []).slice(-200)); } catch { /* none */ }


  const jobs = {
    current: null,
    cancelled: false,

    async run(name, fn) {
      if (engine.running || engine.busy || this.current) { ui.log('Busy — wait for the current task to finish', 'warn'); return; }
      if (Date.now() - (this.freedAt || 0) < 35000) { ui.log('A stuck task was just freed — wait a few seconds before starting another', 'warn'); return; }
      if (!fut.ready()) { ui.log('Web App not ready — log in first', 'err'); return; }
      engine.safety = store.get(KEYS.safety, {});
      const gate = engine.gate();
      if (!gate.ok) { ui.log(`Can't start — ${gate.reason}`, 'err'); return; } // daily caps too, not only lockouts
      this.current = name;
      this.cancelled = false;
      this.loggedOut = false;
      ui.setJob(name);
      try {
        await fn();
        return true;
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

    /**
     * Shared gate for every market call a side task makes (search, buy, bid,
     * list): the same ≥3 s pacing clock as the sniper, rests every N calls,
     * and the daily caps / lockouts checked before EACH call. A buy straight
     * after its own search doesn't wait (it still counts toward the caps).
     * Hitting a limit stops the task cleanly; what's already bought stays.
     */
    async gate(kind) {
      if (this.cancelled) throw new Stopped();
      const cfg = engine.cfg;
      engine.safety = store.get(KEYS.safety, {});
      const g = engine.gate();
      if (!g.ok) { ui.log(`${this.current} stopped — ${g.reason}. Anything already bought stays in your club.`, 'warn'); throw new Stopped(); }
      const afterSearch = kind === 'buy' && this.lastKind === 'search';
      const wait = (this.lastMarketAt || 0) + jitter(cfg.delayMin, cfg.delayMax) - Date.now();
      if (!afterSearch && wait > 0) await this.pause(wait, wait);
      this.calls = (this.calls || 0) + 1;
      if (cfg.pauseEvery > 0 && this.calls % cfg.pauseEvery === 0) {
        const ms = jitter(cfg.pauseMin, cfg.pauseMax);
        ui.log(`Safety rest ${Math.round(ms / 1000)}s — ${this.current} continues after (tap ■ to stop it)`, 'muted');
        engine.setStatus('resting', `Safety rest — ${this.current} continues after`, Date.now() + ms);
        await this.pause(ms, ms);
      }
      this.lastKind = kind;
    },

    /** Refuse up front when a task needs more buys than today's cap has left. */
    buysLeft() {
      const u = usageFor(engine.safety.usage, Date.now());
      return Math.max(0, (engine.cfg.buysPerDay || Infinity) - u.buys);
    },

    cancel() {
      if (!this.current) return;
      // Second tap after ~10 s: the task is stuck (e.g. EA never answered) — free the bot.
      if (this.cancelled && Date.now() - (this.cancelAt || 0) > 10000) {
        ui.log(`${this.current} didn't stop on its own — freed the bot. If it keeps happening, use “Reload the Web App” (Log tab).`, 'warn');
        this.current = null; // `cancelled` stays true, so the old task stops at its next step if EA answers late
        this.freedAt = Date.now();
        ui.setJob(null); engine.setStatus('idle', 'Idle');
        return;
      }
      if (!this.cancelled) this.cancelAt = Date.now();
      this.cancelled = true;
      ui.log(`Stopping ${this.current}… (if it doesn't stop, tap Stop again in 10 s)`, 'warn');
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
      if (kind === 'session') { this.loggedOut = true; ui.log(`Logged out (${status}) — log in again`, 'err'); throw new Stopped(); }
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
      await jobs.run('Opening packs', async () => { await this.openList(packList); });
    },

    /** Open packs and sort each one (runs inside an existing task). */
    async openList(packList) {
      {
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
      }
    },

    /** Pack ids you hold → how many of each (to spot new reward packs). */
    async counts() {
      const r = await fut.myPacks();
      const m = new Map();
      if (r.ok) r.packs.forEach((p) => m.set(p.id, (m.get(p.id) || 0) + 1));
      return { ok: r.ok, packs: r.ok ? r.packs : [], m };
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
      return jobs.run('Loading SBCs', async () => {
        engine.setStatus('pricing', 'Loading SBCs…');
        const r = await fut.sbcSets();
        jobs.check(r, 'loading SBCs');
        this.sets = r.sets.filter((s) => !(typeof s.isComplete === 'function' && s.isComplete()));
        ui.renderSbc();
        ui.log(`${this.sets.length} SBCs available`, 'muted');
      });
    },

    async loadChallenges(set) {
      return jobs.run('Loading SBC', async () => {
        engine.setStatus('pricing', `Loading ${set.name}…`);
        const r = await fut.challenges(set);
        jobs.check(r, 'loading challenges');
        const list = r.list.filter((ch) => !(typeof ch.isCompleted === 'function' && ch.isCompleted()) && ch.status !== 'COMPLETED');
        this.open.set(set.id, list.map((challenge) => {
          const reqs = fut.requirements(challenge);
          const parsed = parseRequirements(reqs, fut.requiredPlayers(challenge));
          parsed.points = reqs.some((r) => r.key === 'ACADEMY_PLAYER_SLOTTING');
          if (parsed.unsupported.length) debugLog.push(`manual SBC "${challenge.name}": ${fut.rawRequirements(challenge)}`);
          return { challenge, reqs, parsed };
        }));
        ui.renderSbc();
      });
    },

    /** Rank every SBC by a quick club check (no market searches; one challenge list per SBC, paced). */
    async rank() {
      return jobs.run('Ranking SBCs', async () => {
        if (!this.sets.length) {
          const r = await fut.sbcSets();
          jobs.check(r, 'loading SBCs');
          this.sets = r.sets.filter((x) => !(typeof x.isComplete === 'function' && x.isComplete()));
        }
        const club = await this.pool();
        const counts = { club: 0, buys: 0, points: 0, manual: 0 };
        for (const [i, set] of this.sets.slice(0, 40).entries()) {
          engine.setStatus('pricing', `Checking SBCs… ${i + 1}/${Math.min(40, this.sets.length)}`);
          const r = await fut.challenges(set);
          jobs.check(r, 'loading challenges');
          const list = r.list.filter((ch) => !(typeof ch.isCompleted === 'function' && ch.isCompleted()) && ch.status !== 'COMPLETED');
          const entries = list.map((challenge) => {
            const reqs = fut.requirements(challenge);
            const parsed = parseRequirements(reqs, fut.requiredPlayers(challenge));
            parsed.points = reqs.some((x) => x.key === 'ACADEMY_PLAYER_SLOTTING');
            const k = parsed.constraints;
            const fitting = club.filter((p) => p.rating >= (k.minOvr || 0) && p.rating <= (k.maxOvr || 99) && qualityOf(p.rating) >= (k.minQuality || 0) && qualityOf(p.rating) <= (k.maxQuality || 9)).length;
            return { challenge, reqs, parsed, likely: sbcLikely(parsed, fitting) };
          });
          this.open.set(set.id, entries);
          const best = entries.map((e) => e.likely).sort((a, b) => sbcOrder({ likely: a }, { likely: b }))[0];
          set.likely = best || 'manual';
          counts[set.likely]++;
          await jobs.pause(700, 1400);
        }
        this.sets.sort(sbcOrder);
        ui.renderSbc();
        ui.log(`🧩 SBCs ranked: ${counts.club} likely from your club · ${counts.buys} need buys · ${counts.points} points · ${counts.manual} manual (a quick check — Solve has the final word)`, 'ok');
      });
    },

    raw: null, // club + storage players, read once per session
    guard: null, // { itemIds, defIds } of your whole active squad

    /**
     * Club + storage players the solver may use. Never: anyone in your active
     * squad (starters, subs and reserves), loans, evolution players, players
     * above your max rating, specials (unless allowed) or tradeables (unless allowed).
     */
    /**
     * Put Unassigned players where SBCs can use them: new cards to your club,
     * duplicates to SBC storage. Anything that can't move stays (e.g. a full pile).
     */
    async tidyUnassigned() {
      const items = await fut.unassigned();
      if (!items || !items.length) return 0;
      const players = items.filter((it) => (typeof it.isPlayer === 'function' ? it.isPlayer() : true));
      const fresh = players.filter((it) => !(typeof it.isDuplicate === 'function' && it.isDuplicate()));
      const dups = players.filter((it) => typeof it.isDuplicate === 'function' && it.isDuplicate());
      let moved = 0;
      if (fresh.length && await fut.move(fresh, w.ItemPile.CLUB)) moved += fresh.length;
      if (dups.length && !fut.pileFull(w.ItemPile.STORAGE)) {
        await sleep(jitter(700, 1200));
        if (await fut.move(dups, w.ItemPile.STORAGE)) moved += dups.length;
      }
      if (moved) ui.log(`Unassigned: ${moved} player${moved === 1 ? '' : 's'} moved where SBCs can use them (${fresh.length} to club, ${dups.length} to SBC storage)`, 'muted');
      if (moved < players.length) ui.log(`${players.length - moved} unassigned player${players.length - moved === 1 ? '' : 's'} couldn’t be moved (pile full?)`, 'warn');
      return moved;
    },

    async pool(force) {
      if (!this.raw || force) {
        if (engine.cfg.sbcUseUnassigned) {
          try { if (await this.tidyUnassigned()) await sleep(jitter(800, 1400)); } catch (e) { ui.log(`Couldn’t tidy Unassigned: ${errText(e)}`, 'warn'); }
        }
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
      // Bought fill-ins: the max-rating rule protects your own players, not cards bought for this SBC.
      if (p.market || p.bought) return !(this.guard && this.guard.defIds.has(p.defId));
      if (this.guard && (this.guard.itemIds.has(p.itemId ?? p.id) || this.guard.defIds.has(p.defId ?? p.item?.definitionId))) return false;
      if (p.rating > cfg.sbcMaxRating) return false;
      if (p.special && !cfg.sbcUseSpecials) return false;
      if (!(p.untradeable || p.storage || cfg.sbcUseTradeables)) return false;
      return true;
    },

    /**
     * 💎 points SBC estimate: points still needed, what your spare cards cover
     * (same protections as normal SBCs), and what the rest would cost on the
     * market at the fewest coins per point. Nothing is bought or handed in.
     */
    async estimatePoints(set, entry) {
      await jobs.run('Estimating points SBC', async () => {
        const cfg = engine.cfg;
        const ch = entry.challenge;
        const goal = Number(ch.scoreRequirement ?? set.scoreRequirement) || 0;
        const done = Number(ch.submittedScore ?? set.totalSubmittedScore) || 0;
        const need = Math.max(0, goal - done);
        if (!goal) { ui.log('Couldn’t read this SBC’s points goal', 'warn'); return; }
        const k = entry.parsed.constraints;
        const usable = (await this.pool()).filter((p) => p.rating >= (k.minOvr || 0));
        // points by rating from your own cards (used when a market card doesn't show its value)
        const byRating = new Map();
        (this.raw || []).forEach((p) => { if (p.points) byRating.set(p.rating, Math.max(byRating.get(p.rating) || 0, p.points)); });
        const ptsFor = (p) => p.points || byRating.get(p.rating) || 0;
        const club = usable.map((p) => ({ ...p, points: ptsFor(p), baseId: baseId(p.defId ?? p.id) }));
        let market = [];
        const clubTotal = club.reduce((a, p) => a + p.points, 0);
        if (clubTotal < need) {
          const owned = new Set((this.raw || []).map((p) => baseId(p.defId ?? p.id)));
          const seen = new Set();
          for (const [i, band] of [[0, 1500], [1000, 3000], [2500, 6000], [5000, 15000]].entries()) {
            engine.setStatus('pricing', `Checking market points value… ${i + 1}/4`);
            const c = fut.newCriteria();
            c.level = 'gold';
            if (band[0] >= 200) c.minBuy = band[0];
            c.maxBuy = band[1];
            const r = await fut.search(c);
            engine.countUsage('searches');
            jobs.check(r, 'market search');
            for (const l of r.listings) {
              const p = fut.toPlayer(l.item);
              const b = baseId(p.id);
              if (!p.player || !l.buyNowPrice || owned.has(b) || seen.has(b) || p.rating < (k.minOvr || 0)) continue;
              seen.add(b);
              market.push({ ...p, id: `m${l.tradeId}`, baseId: b, price: l.buyNowPrice, points: ptsFor(p) });
            }
            await jobs.pause(cfg.delayMin, cfg.delayMax);
          }
          market = market.filter((p) => p.points > 0);
        }
        const plan = planPoints(need, club, market);
        // The market sample is small: extrapolate the rest at the best coins-per-point seen.
        const best = market.slice().sort((a, b) => a.price / a.points - b.price / b.points)[0];
        const extra = plan.short && best ? Math.ceil(plan.short / best.points) * best.price : 0;
        this.points = { set, entry, goal, done, need, plan, best, extra, byRating: [...byRating.entries()],
          bestBand: best ? [Math.max(0, roundPrice(best.price * 0.6)), roundPrice(best.price * 1.6, 'up')] : [800, 3000] };
        const perPt = best ? (best.price / best.points).toFixed(1) : null;
        ui.log(`💎 ${ch.name}: ${fmt(done)}/${fmt(goal)} · your spare cards give ${fmt(plan.clubPoints)} (${plan.fromClub.length} cards)`
          + (plan.buys.length || extra ? ` · rest ≈ ${fmt(plan.buyCoins + extra)} coins${perPt ? ` (best: ${best.rating}-rated at ${fmt(best.price)} = ${best.points} 💎, ${perPt}/💎)` : ''}` : ''), 'ok');
        ui.renderSbc();
      });
    },

    /** Hand in the estimated spare cards, 20 at a time, until the points goal is reached. */
    async handInPoints() {
      const pt = this.points;
      if (!pt || (!pt.plan.fromClub.length && !(engine.cfg.pointsBuyLimit > 0))) return;
      await jobs.run('Handing in 💎 points', async () => {
        const { set, entry } = pt;
        const ch = entry.challenge;
        const st = await fut.startPointsChallenge(ch);
        jobs.check(st, 'starting the challenge');
        let score = Number(ch.submittedScore) || pt.done || 0;
        const goal = pt.goal;
        // Biggest point values first so the goal is reached with as few cards as possible.
        const cards = pt.plan.fromClub.slice().sort((a, b) => b.points - a.points);
        let handed = 0;
        for (let i = 0; i < cards.length && score < goal; i += 20) {
          if (jobs.cancelled) break;
          let batch = cards.slice(i, i + 20);
          // only what's still needed in the last batch
          let acc = score;
          batch = batch.filter((p) => { if (acc >= goal) return false; acc += p.points; return true; });
          const bad = batch.filter((p) => !this.allowed(p) || !p.item || !p.item.id);
          if (bad.length) { ui.log(`Safety check stopped the hand-in: ${bad.map((p) => `${p.name} ${p.rating}`).join(', ')}`, 'err'); break; }
          engine.setStatus('pricing', `Handing in ${batch.length} cards… ${fmt(score)} / ${fmt(goal)} 💎`);
          const r = await fut.submitPoints(ch, set, batch.map((p) => p.item.id));
          if (!r.ok && Number(r.status) === 409) { ui.log('EA says some of these cards are in one of your squads — stopped, nothing from this batch was handed in', 'err'); break; }
          jobs.check(r, 'handing in cards');
          handed += batch.length;
          score = Number(r.data.submittedScore ?? (score + batch.reduce((a, p) => a + p.points, 0)));
          const used = new Set(batch.map((p) => p.itemId));
          this.raw = (this.raw || []).filter((p) => !used.has(p.itemId));
          ui.log(`💎 Handed in ${batch.length} cards — ${fmt(score)} / ${fmt(goal)}`, 'ok');
          if (r.data.challengeCompleted || score >= goal) {
            ui.log(`✅ ${ch.name} complete — reward on its way`, 'ok');
            ui.toast(`SBC done: ${ch.name}`, 'ok');
            sounds.buy();
            notify.discord('info', { title: `🧩 SBC done: ${ch.name}`, text: `${handed} cards handed in` });
            break;
          }
          await jobs.pause(engine.cfg.delayMin, engine.cfg.delayMax);
        }
        // Still short: buy the best 💎-per-coin cards and hand them in, up to your coin limit.
        if (score < goal && !jobs.cancelled && engine.cfg.pointsBuyLimit > 0) {
          const r = await this.buyForPoints(pt, ch, set, score, goal);
          score = r.score;
          handed += r.handed;
          if (score >= goal) {
            ui.log(`✅ ${ch.name} complete — reward on its way`, 'ok');
            ui.toast(`SBC done: ${ch.name}`, 'ok');
            sounds.buy();
          }
        }
        if (score < goal) ui.log(`Stopped at ${fmt(score)} / ${fmt(goal)} 💎 (${handed} cards handed in)`, 'warn');
        ch.submittedScore = score;
        this.points = null;
        ui.renderSbc();
      });
    },

    /**
     * Buy cards with the most 💎 per coin (fresh listings, bought straight after
     * the search), move them to your club and hand them in, until the goal or
     * the coin limit. Never buys a card you already own.
     */
    async buyForPoints(pt, ch, set, score, goal) {
      const cfg = engine.cfg;
      if (!jobs.buysLeft()) { ui.log('No buys left today — the rest of the points SBC has to wait', 'warn'); return { score, handed: 0, spent: 0 }; }
      const byRating = new Map(pt.byRating || []);
      const owned = new Set((this.raw || []).map((p) => baseId(p.defId ?? p.id)));
      const minOvr = pt.entry.parsed.constraints.minOvr || 0;
      let spent = 0;
      let handed = 0;
      let [lo, hi] = pt.bestBand || [800, 3000];
      for (let round = 0; round < 40 && score < goal && spent < cfg.pointsBuyLimit && !jobs.cancelled; round++) {
        engine.setStatus('pricing', `Buying for 💎… ${fmt(score)} / ${fmt(goal)} · spent ${fmt(spent)}`);
        const c = fut.newCriteria();
        c.level = 'gold';
        if (lo >= 200) c.minBuy = lo;
        c.maxBuy = Math.min(hi, roundPrice(cfg.pointsBuyLimit - spent));
        const res = await fut.search(c);
        engine.countUsage('searches');
        jobs.check(res, 'market search');
        const seen = new Set();
        const cands = res.listings.map((l) => ({ l, p: fut.toPlayer(l.item) }))
          .filter(({ l, p }) => p.player && l.buyNowPrice && p.rating >= minOvr && !owned.has(baseId(p.id)) && !seen.has(baseId(p.id)) && seen.add(baseId(p.id)))
          .map(({ l, p }) => ({ l, p, pts: p.points || byRating.get(p.rating) || 0 }))
          .filter((x) => x.pts > 0)
          .sort((a, b) => a.l.buyNowPrice / a.pts - b.l.buyNowPrice / b.pts);
        if (!cands.length) { [lo, hi] = [Math.max(0, roundPrice(lo * 0.7)), roundPrice(hi * 1.4, 'up')]; await jobs.pause(cfg.delayMin, cfg.delayMax); continue; }
        const bought = [];
        let acc = score;
        for (const x of cands) {
          if (bought.length >= 20 || acc >= goal || spent + x.l.buyNowPrice > cfg.pointsBuyLimit) break;
          const r = await fut.buy(x.l);
          if (!r.ok) {
            const kind = classifyStatus(r.status);
            if (kind === 'captcha' || kind === 'throttled') jobs.check(r, 'buying for points');
            if (kind === 'coins') break;
            continue;
          }
          engine.countUsage('buys');
          spent += x.l.buyNowPrice;
          acc += x.pts;
          owned.add(baseId(x.p.id));
          bought.push(x);
          engine.history = addHistory(engine.history, { at: Date.now(), id: x.p.id, itemId: x.l.item.id, name: x.p.name, rating: x.p.rating, price: x.l.buyNowPrice, via: 'sbc' });
          await sleep(jitter(700, 1300));
        }
        store.set(KEYS.history, engine.history);
        if (!bought.length) break;
        ui.log(`Bought ${bought.length} card${bought.length === 1 ? '' : 's'} for ${fmt(bought.reduce((a, x) => a + x.l.buyNowPrice, 0))} (${fmt(bought.reduce((a, x) => a + x.pts, 0))} 💎)`, 'ok');
        await fut.move(bought.map((x) => x.l.item), w.ItemPile.CLUB);
        await jobs.pause(1200, 2200);
        const r = await fut.submitPoints(ch, set, bought.map((x) => x.l.item.id));
        if (!r.ok && Number(r.status) === 409) { ui.log('EA reported a squad conflict on bought cards — stopped (they’re in your club)', 'err'); break; }
        jobs.check(r, 'handing in cards');
        handed += bought.length;
        score = Number(r.data.submittedScore ?? acc);
        ui.log(`💎 Handed in ${bought.length} bought cards — ${fmt(score)} / ${fmt(goal)} · spent ${fmt(spent)}`, 'ok');
        if (r.data.challengeCompleted || score >= goal) break;
        await jobs.pause(cfg.delayMin, cfg.delayMax);
      }
      if (spent >= cfg.pointsBuyLimit && score < goal) ui.log(`Reached your coin limit for 💎 SBCs (${fmt(cfg.pointsBuyLimit)})`, 'warn');
      ui.renderHistory();
      return { score, handed, spent };
    },

    /** 💎 points SBC: open it and record where EA keeps the points (nothing is handed in). */
    async probe(set, entry) {
      await jobs.run('Checking points SBC', async () => {
        // Points SBCs may not open with the usual call: try it, then the other loader, and probe anyway.
        const ch = entry.challenge;
        const load = await fut.loadChallenge(ch);
        let alt = null;
        if (!load.ok) {
          const kind = classifyStatus(load.status);
          if (kind === 'captcha' || kind === 'throttled') jobs.check(load, 'loading the challenge');
          try {
            if (w.services.SBC.sbcDAO && typeof w.services.SBC.sbcDAO.loadChallenge === 'function') {
              const inProgress = typeof ch.isInProgress === 'function' ? ch.isInProgress() : false;
              alt = await observe(w.services.SBC.sbcDAO.loadChallenge(ch.id, inProgress));
            }
          } catch (e) { alt = { success: false, status: errText(e) }; }
        }
        debugLog.push(`points SBC load "${ch.name}": loadChallenge ${load.ok ? 'ok' : load.status}${alt ? ` · sbcDAO ${alt.success ? 'ok' : alt.status} keys ${Object.keys(alt.data || {}).join(',')}` : ''}`);
        if (alt && alt.success && alt.data) debugLog.push(`points SBC dao data: ${(() => { try { return JSON.stringify(alt.data, (k, v) => (typeof v === 'object' && v && Object.keys(v).length > 40 ? '[big]' : v)).slice(0, 700); } catch { return 'unserializable'; } })()}`);
        await this.pool();
        const sample = (this.raw || []).find((p) => p.player);
        debugLog.push(`points SBC probe "${entry.challenge.name}": ${fut.pointsProbe(entry.challenge, set, sample && sample.item)}`);
        debugLog.push(`points SBC raw "${entry.challenge.name}": ${fut.rawRequirements(entry.challenge)} · needs ${fut.requiredPlayers(entry.challenge)} · slots ${fut.challengeSlots(entry.challenge).length}`);
        const fnNames = (o) => { const n = new Set(); for (let x = o, d = 0; x && d < 3; x = Object.getPrototypeOf(x), d++) Object.getOwnPropertyNames(x).forEach((k) => { try { if (typeof o[k] === 'function' && k !== 'constructor') n.add(k); } catch { /* skip */ } }); return [...n].join(','); };
        debugLog.push(`SBC service: ${fnNames(w.services.SBC).slice(0, 700)}`);
        if (w.services.SBC.sbcDAO) debugLog.push(`SBC dao: ${fnNames(w.services.SBC.sbcDAO).slice(0, 500)}`);
        debugLog.push(`challenge fns: ${fnNames(entry.challenge).slice(0, 500)}`);
        // How the Web App hands in a points ("one-click") challenge: save the code of those functions.
        const src = (label, fn) => { try { return `${label}: ${String(fn).replace(/\s+/g, ' ').slice(0, 900)}`; } catch { return `${label}: ?`; } };
        const S = w.services.SBC;
        const D = S.sbcDAO || {};
        debugLog.push(`oneClick=${typeof entry.challenge.isOneClickChallenge === 'function' ? entry.challenge.isOneClickChallenge() : '?'}`);
        [['svc.initiateOneClickChallenge', S.initiateOneClickChallenge], ['svc.submitOneClickChallenge', S.submitOneClickChallenge],
          ['svc._applyOneClickSubmission', S._applyOneClickSubmission], ['dao.initiateOneClickChallenge', D.initiateOneClickChallenge],
          ['dao.submitPlayers', D.submitPlayers]].forEach(([l, f]) => { if (f) debugLog.push(src(l, f)); });
        ui.log(`💎 ${entry.challenge.name}: points details saved — Log tab → Copy log and send it`, 'ok');
      });
    },

    /** Cheapest solution from a pool; chemistry/group SBCs use the position-aware search. */
    solveWith(pool, entry, slots) {
      const k = entry.parsed.constraints;
      // A player can only be in a squad once: keep the cheapest copy of each
      // (SBC-storage duplicate, then club, then market).
      const best = new Map();
      for (const p of pool) {
        const key = baseId(p.defId ?? p.id);
        if (!best.has(key) || best.get(key).cost > p.cost) best.set(key, p);
      }
      pool = [...best.values()];
      if (k.needsSearch) return solveSbcSearch(pool, slots, k);
      return solveSbc(pool, k);
    },

    /**
     * Cheap market listings that could fill the SBC: right quality (and rare
     * if needed), a few price levels, plus your club's main leagues for
     * chemistry. Cards you already own are skipped (EA won't take duplicates
     * into your club). Your own fodder always goes first; only gaps are bought.
     */
    async marketPool(k, ownedBase, cap) {
      const cfg = engine.cfg;
      const level = marketLevel(k);
      const cheapLevel = level === 'bronze' || level === 'silver';
      const limit = cap || cfg.sbcBuyLimit || 20000; // `cap`: a price estimate past your SBC buy limit (never used to buy)
      const perPlayer = cheapLevel ? Math.min(limit, 3000)
        : Math.max(1000, Math.min(limit, k.teamRating ? fodderValue(k.teamRating + 3) * 2 : 4000));
      // Several low price levels for bronzes/silvers (they're cheap), wider ones for golds.
      const mins = level === 'bronze' ? [0, 200, 300, 450] : level === 'silver' ? [0, 250, 400, 650] : [0, 0.2, 0.5].map((f) => (f ? roundPrice(perPlayer * f) : 0));
      const searches = mins.map((min) => ({ min }));
      if (k.rareMin) searches.push({ min: 0, rare: true });
      const leagues = topValues((this.club || []), 'leagueId', 2).map((x) => x.value);
      if (k.needsSearch) leagues.forEach((league) => searches.push({ min: 0, league }));
      for (const r of k.idReqs || []) if (r.min && ['league', 'nation', 'club'].includes(r.type)) searches.push({ min: 0, [r.type]: r.ids[0] });
      const out = new Map();
      const perCard = new Map();
      for (const [i, q] of searches.slice(0, 8).entries()) {
        engine.setStatus('pricing', `Checking market prices… ${i + 1}/${Math.min(8, searches.length)}`);
        const c = fut.newCriteria();
        if (level) c.level = level;
        if (q.rare) c.rarities = [1];
        if (q.league) c.league = q.league;
        if (q.nation) c.nation = q.nation;
        if (q.club) c.club = q.club;
        c.maxBuy = roundPrice(perPlayer);
        if (q.min >= 200) c.minBuy = roundPrice(q.min);
        const r = await fut.search(c);
        engine.countUsage('searches');
        jobs.check(r, 'market search');
        for (const l of r.listings) {
          const p = fut.toPlayer(l.item);
          if (p.rating < k.minOvr || p.rating > k.maxOvr) continue;
          if (!p.player || !l.buyNowPrice || out.has(l.tradeId) || ownedBase.has(baseId(p.id))) continue;
          if (p.special && !cfg.sbcUseSpecials) continue;
          if ((perCard.get(p.id) || 0) >= 1) continue; // one copy per player — a squad can't use two
          perCard.set(p.id, (perCard.get(p.id) || 0) + 1);
          // Coins spent weigh far more than giving away your own fodder: the solver spends
          // as few coins as possible and uses your players wherever they fit.
          out.set(l.tradeId, { ...p, id: `m${l.tradeId}`, defId: p.id, market: true, price: l.buyNowPrice, cost: COIN_WEIGHT * l.buyNowPrice + 2000, listing: l });
        }
        await jobs.pause(cfg.delayMin, cfg.delayMax);
      }
      ui.log(`Market: ${out.size} cheap ${level ? `${level} ` : ''}listings to fill gaps`, 'muted');
      return [...out.values()];
    },

    async solve(set, entry) {
      return jobs.run('Solving SBC', async () => {
        const { challenge } = entry;
        let { parsed } = entry;
        if (parsed.unsupported.length) { ui.log(`Can't auto-solve yet: ${parsed.unsupported.join(', ')}`, 'warn'); return; }
        const cfg = engine.cfg;
        this.short = null;
        const load = await fut.loadChallenge(challenge);
        jobs.check(load, 'loading the challenge');
        // The number of players is only known once the challenge is loaded.
        entry.reqs = fut.requirements(challenge);
        entry.parsed = parseRequirements(entry.reqs, fut.requiredPlayers(challenge));
        if (entry.reqs.some((r) => r.key === 'ACADEMY_PLAYER_SLOTTING')) {
          const sample = (this.raw || [])[0];
          debugLog.push(`points SBC probe "${challenge.name}": ${fut.pointsProbe(challenge, set, sample && sample.item)}`);
          ui.log('This looks like a 💎 points SBC — details saved to Copy log', 'muted');
        }
        const parsedNow = entry.parsed;
        const slots = fut.challengeSlots(challenge);
        if (parsedNow.constraints.players !== slots.length) parsedNow.constraints.players = slots.length;
        parsed = parsedNow;
        if (parsed.unsupported.length) { ui.log(`Can't auto-solve yet: ${parsed.unsupported.join(', ')}`, 'warn'); return; }
        if (parsed.constraints.players < 11) ui.log(`This SBC needs ${parsed.constraints.players} player${parsed.constraints.players === 1 ? '' : 's'}`, 'muted');
        if (parsed.constraints.needsSearch && slots.some((x) => x === '?')) ui.log('Couldn’t read this SBC’s positions — chemistry may not work', 'warn');
        const club = await this.pool();
        this.club = club;
        engine.setStatus('pricing', 'Solving…');
        await sleep(30);
        let solution = this.solveWith(club, entry, slots);
        let buys = [];
        if (!solution && cfg.sbcBuyMissing) {
          ui.log('Not possible from your club alone — checking the market for cheap fill-ins…', 'muted');
          const ownedBase = new Set([...(this.raw || []).map((p) => baseId(p.defId ?? p.id)), ...(this.guard ? [...this.guard.defIds].map(baseId) : [])]);
          const market = await this.marketPool(parsed.constraints, ownedBase);
          this.lastMarket = market;
          engine.setStatus('pricing', 'Solving with market fill-ins…');
          await sleep(30);
          solution = this.solveWith([...club, ...market], entry, slots);
          if (solution) {
            buys = solution.players.filter((p) => p.market);
            const total = buys.reduce((a, p) => a + p.price, 0);
            if (total > (cfg.sbcBuyLimit || 0)) {
              ui.log(`Cheapest solution needs ${fmt(total)} of buys — over your limit of ${fmt(cfg.sbcBuyLimit)}`, 'warn');
              this.short = { name: set.name, cost: total, overLimit: true };
              solution = null; buys = [];
            }
          }
          // Nothing within your SBC buy limit: price it once without the limit (an estimate — nothing is bought),
          // so a coin goal can be offered for it.
          if (!solution && !this.short && (cfg.sbcBuyLimit || 0) < 1e6) {
            ui.log('Nothing fits your SBC buy limit — estimating what it would cost (nothing is bought)…', 'muted');
            const wide = await this.marketPool(parsed.constraints, ownedBase, 1e6);
            const est = this.solveWith([...club, ...wide], entry, slots);
            if (est) {
              const total = est.players.filter((p) => p.market).reduce((a, p) => a + p.price, 0);
              this.short = { name: set.name, cost: total, overLimit: true };
              ui.log(`${set.name} would need about ${fmt(total)} of buys — over your SBC buy limit of ${fmt(cfg.sbcBuyLimit)}`, 'warn');
            }
          }
        }
        if (!solution) {
          const k = parsed.constraints;
          const fits = (p) => p.rating >= k.minOvr && p.rating <= k.maxOvr && qualityOf(p.rating) >= (k.minQuality || 0) && qualityOf(p.rating) <= (k.maxQuality || 9);
          const nClub = club.filter(fits).length;
          const nMarket = (this.lastMarket || []).filter(fits).length;
          const range = k.maxOvr < 99 || k.minOvr > 0 ? ` rated ${k.minOvr || 0}–${k.maxOvr}` : '';
          ui.log(`No solution for ${challenge.name || set.name}: ${nClub + nMarket < k.players ? `only ${nClub + nMarket} of ${k.players} needed players${range} (club ${nClub}, market ${nMarket})` : 'the requirements couldn’t all be met together'}${cfg.sbcBuyMissing ? '' : ' — turn on “Buy missing players”'}`, 'warn');
          this.plan = null; ui.renderSbc(); return;
        }
        const buyTotal = buys.reduce((a, p) => a + p.price, 0);
        this.points = null;
        this.plan = { set, entry, solution, slots, buys, buyTotal };
        // more buys than free coins → offer to trade toward it
        this.short = buyTotal > freeCoins(cfg, fut.coins(), []) ? { name: set.name, cost: buyTotal } : null;
        ui.log(`Solution: ${solution.players.length} players · rating ${solution.rating || '—'}${parsed.constraints.needsSearch ? ` · chemistry ${solution.chem ?? '—'}` : ''}${buys.length ? ` · buy ${buys.length} for ${fmt(buyTotal)}` : ''} — review it, then submit`, 'ok');
        ui.renderSbc();
      });
    },

    /**
     * Buy the planned fill-ins. Listings from the price check go stale once the
     * market cache is cleared (EA answers 403), so each card is searched again
     * right before buying. If that card is gone, the cheapest fresh listing that
     * fits the same spot is bought instead. Every buy is recorded in the plan,
     * so a retry only buys what's still missing.
     */
    async buyFillIns(plan) {
      const cfg = engine.cfg;
      const need = plan.buys.filter((p) => !p.bought).length;
      if (need > jobs.buysLeft()) throw new Error(`needs ${need} buy${need === 1 ? '' : 's'}, only ${jobs.buysLeft()} left today`);
      if (fut.coins() - cfg.minCoins < plan.buyTotal) throw new Error(`not enough coins for the fill-ins (${fmt(plan.buyTotal)})`);
      const k = plan.entry.parsed.constraints;
      const cap = Math.round(cfg.sbcBuyLimit || plan.buyTotal); // hard cap: never over your SBC coin limit
      const inSquad = new Set(plan.solution.players.map((x) => baseId(x.defId ?? x.id)));
      const ownedBase = new Set([...(this.raw || []).map((x) => baseId(x.defId ?? x.id)), ...(this.guard ? [...this.guard.defIds].map(baseId) : [])]);
      const boughtNow = [];
      plan.spent = plan.spent || 0;

      const tryBuy = async (options) => {
        for (const l of options.slice(0, 3)) {
          if (plan.spent + l.buyNowPrice > cap) return null;
          if (fut.coins() - (cfg.minCoins || 0) < l.buyNowPrice) throw new Error('buying this fill-in would go under Keep coins');
          const r = await fut.buy(l);
          if (r.ok) return l;
          const kind = classifyStatus(r.status);
          if (kind === 'captcha' || kind === 'throttled') jobs.check(r, 'buying a fill-in');
          if (kind === 'coins') throw new Error('not enough coins for the fill-ins');
          await jobs.pause(900, 1600);
        }
        return null;
      };

      for (const p of plan.buys.slice()) {
        if (p.bought) continue;
        const slotPos = (plan.slots || [])[plan.solution.players.indexOf(p)];
        engine.setStatus('pricing', `Buying ${p.name} (${plan.buys.indexOf(p) + 1}/${plan.buys.length})…`);
        // 1) the same card, fresh
        const maxPrice = roundPrice(Math.max(p.price * 1.15, p.price + 100), 'up');
        const fresh = await fut.search(fut.criteria({}, { id: p.defId }, maxPrice));
        engine.countUsage('searches');
        jobs.check(fresh, 'market search');
        let got = await tryBuy(fresh.listings.filter((l) => l.defId === p.defId && l.buyNowPrice && l.buyNowPrice <= maxPrice).sort((x, y) => x.buyNowPrice - y.buyNowPrice));
        // 2) gone: the cheapest card that fits the same spot
        if (!got) {
          await jobs.pause(cfg.delayMin, cfg.delayMax);
          const c = fut.newCriteria();
          const level = marketLevel(k);
          if (level) c.level = level;
          if (k.needsSearch && slotPos && slotPos !== '?') { c._position = slotPos; c.position = slotPos; c.league = p.leagueId; }
          c.maxBuy = roundPrice(Math.max(maxPrice * 1.5, p.price + 300), 'up');
          const alt = await fut.search(c);
          engine.countUsage('searches');
          jobs.check(alt, 'market search');
          const fits = alt.listings.filter((l) => {
            const q = fut.toPlayer(l.item);
            if (!q.player || !l.buyNowPrice || ownedBase.has(baseId(q.id)) || inSquad.has(baseId(q.id))) return false;
            if (q.rating < Math.max(p.rating, k.minOvr) || q.rating > k.maxOvr) return false;
            if (qualityOf(q.rating) < (k.minQuality || 0) || qualityOf(q.rating) > (k.maxQuality || 9)) return false;
            if (p.rare && !q.rare) return false;
            if (q.special && !cfg.sbcUseSpecials) return false;
            if (k.needsSearch && !(q.positions.includes(slotPos) && q.leagueId === p.leagueId && q.nationId === p.nationId)) return false;
            return true;
          }).sort((x, y) => x.buyNowPrice - y.buyNowPrice);
          got = await tryBuy(fits);
          if (got) {
            const q = fut.toPlayer(got.item);
            ui.log(`${p.name} was gone — bought ${q.name} ${q.rating} instead`, 'muted');
            Object.assign(p, { name: q.name, rating: q.rating, defId: q.id, rare: q.rare, positions: q.positions, leagueId: q.leagueId, nationId: q.nationId, teamId: q.teamId });
            inSquad.add(baseId(q.id));
          }
        }
        if (!got) {
          throw new Error(`couldn't get ${p.name} or a replacement — bought ${plan.buys.filter((x) => x.bought).length} of ${plan.buys.length} (kept in the plan, a retry only buys the rest)`);
        }
        engine.countUsage('buys');
        plan.spent += got.buyNowPrice;
        Object.assign(p, { item: got.item, price: got.buyNowPrice, bought: true, market: false });
        boughtNow.push(got.item);
        plan.buyTotal = plan.buys.filter((x) => !x.bought).reduce((a, x) => a + x.price, 0);
        engine.history = addHistory(engine.history, { at: Date.now(), id: p.defId, itemId: got.item && got.item.id, name: p.name, rating: p.rating, price: got.buyNowPrice, via: 'sbc' });
        store.set(KEYS.history, engine.history);
        ui.log(`Bought ${p.name} ${p.rating} for ${fmt(got.buyNowPrice)} (SBC fill-in)`, 'ok');
        ui.renderSbc();
        // move each one to the club straight away, so nothing is left in unassigned if we stop
        await fut.move([got.item], w.ItemPile.CLUB);
        await jobs.pause(cfg.delayMin, cfg.delayMax);
      }
      plan.buys = plan.buys.filter((x) => !x.bought);
      plan.buyTotal = 0;
      ui.renderHistory();
      // Still meets every requirement after any replacements?
      const chk = sbcCheck(plan.solution.players, plan.slots || [], k);
      if (!chk.ok) throw new Error(`after replacing sold cards the squad misses: ${chk.issues.map(([n]) => n).join(', ')} — tap Solve again`);
    },

    async submit(fillOnly) {
      const plan = this.plan;
      if (!plan) return false;
      return jobs.run(fillOnly ? 'Filling SBC' : 'Submitting SBC', async () => {
        const times = fillOnly ? 1 : Math.max(1, engine.cfg.sbcRepeat || 1);
        let current = plan;
        const before = !fillOnly && engine.cfg.sbcOpenRewards ? await packs.counts() : null;
        let submitted = 0;
        try {
        for (let n = 1; n <= times; n++) {
          const { set, entry, solution } = current;
          engine.setStatus('pricing', `${fillOnly ? 'Filling' : 'Submitting'} ${set.name}${times > 1 ? ` (${n}/${times})` : ''}`);
          const bad = solution.players.filter((p) => !this.allowed(p));
          if (bad.length) {
            ui.log(`Safety check blocked this squad: ${bad.map((p) => `${p.name} ${p.rating}`).join(', ')} — nothing was sent`, 'err');
            return;
          }
          if (current.buys && current.buys.length) await this.buyFillIns(current);
          const load = await fut.loadChallenge(entry.challenge);
          jobs.check(load, 'loading the challenge');
          await jobs.pause(800, 1500);
          const items = solution.players.map((p) => p.item);
          const fill = await fut.fillChallenge(entry.challenge, items);
          jobs.check(fill, 'filling the squad');
          if (fillOnly) { ui.log(`Squad filled and saved — open ${set.name} in the Web App to check and submit`, 'ok'); this.plan = { ...current, buys: [], buyTotal: 0 }; ui.renderSbc(); return; }
          await jobs.pause(1500, 2500);
          const sub = await fut.submitChallenge(entry.challenge, set);
          jobs.check(sub, 'submitting');
          const used = new Set(solution.players.map((p) => p.id));
          this.raw = (this.raw || []).filter((p) => !used.has(p.itemId));
          this.club = (await this.pool()).filter((p) => !used.has(p.id));
          submitted++;
          this.submittedTotal = (this.submittedTotal || 0) + 1;
          ui.log(`✅ Submitted ${set.name}${entry.challenge.name && entry.challenge.name !== set.name ? ` — ${entry.challenge.name}` : ''}`, 'ok');
          ui.toast(`SBC done: ${set.name}`, 'ok');
          sounds.buy();
          notify.discord('info', { title: `🧩 SBC done: ${set.name}`, text: entry.challenge.name || '' });
          this.plan = null;
          if (n === times) break;
          // Repeatable: reload the set and solve the next one from the players left (no buying on repeats).
          await jobs.pause(2500, 4000);
          const again = await fut.challenges(set);
          jobs.check(again, 'reloading the SBC');
          const next = again.list.find((ch) => !(typeof ch.isCompleted === 'function' && ch.isCompleted()));
          if (!next) { ui.log('No more repeats available', 'muted'); break; }
          const reqs = fut.requirements(next);
          const parsed = parseRequirements(reqs, fut.requiredPlayers(next));
          const nextEntry = { challenge: next, reqs, parsed };
          await fut.loadChallenge(next);
          const sol = !parsed.unsupported.length && this.solveWith(this.club, nextEntry, fut.challengeSlots(next));
          if (sol && sol.players.some((p) => !this.allowed(p))) { ui.log('Safety check stopped the repeat', 'err'); break; }
          if (!sol) { ui.log('Out of suitable players for another repeat', 'muted'); break; }
          current = { set, entry: nextEntry, solution: sol, buys: [], buyTotal: 0 };
        }
        } finally {
          if (before && before.ok && submitted) await this.openRewards(before);
        }
        ui.renderSbc();
      });
    },

    /** Open the packs that appeared since `before` (SBC rewards) and sort them. */
    async openRewards(before) {
      try {
        await jobs.pause(2000, 3500);
        const now = await packs.counts();
        if (!now.ok) return;
        const left = new Map(before.m);
        const fresh = now.packs.filter((p) => { const n = left.get(p.id) || 0; if (n > 0) { left.set(p.id, n - 1); return false; } return true; });
        if (!fresh.length) { ui.log('No reward packs to open (the reward may be a player or already opened)', 'muted'); return; }
        ui.log(`Opening ${fresh.length} SBC reward pack${fresh.length === 1 ? '' : 's'}…`, 'ok');
        packs.list = now.packs;
        await packs.openList(fresh);
      } catch (e) {
        if (!(e instanceof Stopped)) ui.log(`Couldn’t open reward packs: ${errText(e)}`, 'warn');
        else throw e;
      }
    },
  };

  // ---- Upgrade advisor -------------------------------------------------------------------

  const upgrades = {
    squad: null, // [{ position, player }]
    summary: null,
    results: [], // [{ slotIndex, position, current, options: [...] }]

    /** Reads the active squad: 11 slots, chemistry, main leagues/nations. */
    async readSquad() {
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
      // Weakest first: lowest meta (or rating) in their slot, then lowest chemistry.
      const by = engine.cfg.lineupBy || 'meta';
      const val = (s) => (s.player ? (by === 'meta' ? metaScore(s.player, s.position) : s.player.rating) : 0);
      const order = slots.map((s, i) => ({ i, v: val(s), c: chem.each[i] })).sort((a, b) => a.v - b.v || a.c - b.c).map((x) => x.i);
      return { slots, order, by };
    },

    /**
     * Every card you own: whole club (+ SBC storage), transfer list and
     * unassigned, plus the squad. Returns { club (usable in squads), ownedBase }.
     */
    async ownedCards(slots = []) {
      const asP = (item) => ({ ...fut.toPlayer(item), source: 'club' });
      const read = await fut.clubPlayers((n) => engine.setStatus('pricing', `Checking your club… ${n}`));
      jobs.check(read, 'reading your club');
      const all = read.items.map(asP).filter((p) => p.player);
      const club = all.filter((p) => !p.loan && !p.storage);
      const storage = all.filter((p) => p.storage);
      const transfer = ((await fut.transferList()) || []).map(asP).filter((p) => p.player);
      const unassigned = ((await fut.unassigned()) || []).map(asP).filter((p) => p.player);
      const squad = slots.map((x) => x.player).filter(Boolean);
      const ownedBase = new Set([...all, ...transfer, ...unassigned, ...squad].map((p) => baseId(p.id)));
      ui.log(`Owned: ${ownedBase.size} players (club ${club.length}, SBC storage ${storage.length}, transfer list ${transfer.length}, unassigned ${unassigned.length})`, 'muted');
      return { club, ownedBase };
    },

    /**
     * 2.5.0: read your active squad only (one request, no market searches) and save it, so the Squad tab and the SBC
     * tools know your team without the slow "find upgrades" pass. Runs by itself when the panel loads.
     */
    async updateTeam(auto) {
      if (engine.running || engine.busy || jobs.current || !fut.ready()) return false;
      this.updating = true;
      try {
        await this.readSquad();
        if (!this.probed) {
          this.probed = true;
          const first = (this.squad || []).find((x) => x.player && x.player.item);
          if (first) debugLog.push(`card fields (${first.player.name}): ${cardFieldsProbe(first.player.item)}`);
          const ps = (this.squad || []).map((x) => x.player && x.player.playStyles && x.player.playStyles.length).filter(Boolean).length;
          debugLog.push(`playstyles read for ${ps}/11 squad players`);
        }
        store.set(KEYS.team, { at: Date.now(), summary: this.summary, squad: (this.squad || []).map((x) => ({ position: x.position, name: x.player && x.player.name, rating: x.player && x.player.rating })) });
        ui.renderUpgrades();
        ui.log(`👥 ${auto ? 'Team read' : 'Team updated'}: rating ${this.summary.rating}, chemistry ${this.summary.chem}/33${this.summary.formation ? ` · ${this.summary.formation}` : ''}`, 'muted');
        return true;
      } catch (e) {
        if (!auto) ui.log(`Couldn't read your squad (${errText(e)}) — open Squads in the Web App once, then tap ↻ Update my team`, 'warn');
        else debugLog.push(`auto team read: ${errText(e)}`); // quiet on launch; the button says why
        return false;
      } finally {
        this.updating = false;
        if (!engine.running && !jobs.current) engine.setStatus('idle', 'Idle');
      }
    },

    /**
     * ⚖️ Auto-compare (2.5.0): every spot in your XI against the best card you own for it (club + SBC storage), by the
     * meta score (stats for the position, meta PlayStyles, pros-run-this). Reads your squad and club — no market searches.
     */
    async compareTeam() {
      return jobs.run('Comparing your team', async () => {
        const { slots } = await this.readSquad();
        const { club } = await this.ownedCards(slots);
        const used = new Set(slots.map((x) => x.player && x.player.id).filter(Boolean));
        this.compare = slots.map((sl, i) => {
          const cur = sl.player;
          const pool = club.filter((c) => !used.has(c.id) && (c.positions || []).includes(sl.position));
          const best = pool.map((c) => ({ c, s: metaScore(c, sl.position) })).sort((x, y) => y.s - x.s)[0];
          const curS = cur ? metaScore(cur, sl.position) : 0;
          const better = best && best.s - curS >= 1;
          return { i, position: sl.position, cur, alt: best ? best.c : null, curScore: curS, altScore: best ? best.s : 0, verdict: !cur ? 'empty spot' : better ? 'swap' : 'keep' };
        });
        ui.renderCompare();
        const swaps = this.compare.filter((x) => x.verdict === 'swap');
        ui.log(swaps.length ? `⚖️ ${swaps.length} spot${swaps.length === 1 ? '' : 's'} where a card you own scores better: ${swaps.map((x) => `${x.position} ${x.alt.name}`).join(' · ')}` : '⚖️ Your XI is already your best by the meta score — use Find upgrades for market options', 'ok');
      });
    },

    /** The team saved by the last update (shown right away after a reload). */
    savedTeam() { return store.get(KEYS.team, null); },

    async analyse() {
      this.evoTeam = null;
      await jobs.run('Finding upgrades', async () => {
        const { slots, order, by } = await this.readSquad();
        this.results = order.slice(0, 3).map((i) => ({ slotIndex: i, position: slots[i].position, current: slots[i].player, options: [] }));
        ui.renderUpgrades();

        // Candidates you already own (and everything you own, so it's never suggested as a buy).
        const { club, ownedBase } = await this.ownedCards(slots);

        const budget = engine.cfg.upgradeBudget || Math.max(0, fut.coins() - engine.cfg.minCoins);
        this.costed = 0;
        const sbcPlayers = engine.cfg.upgradeSbc ? await this.sbcPlayers(ownedBase) : [];
        for (const res of this.results) {
          let candidates = club.slice();
          if (engine.cfg.upgradeMarket && budget >= 1000) {
            candidates = candidates.concat((await this.market(res, budget)).filter((o) => !ownedBase.has(baseId(o.id))));
          }
          // SBC players: cost them only if they'd be an upgrade here (costing loads the SBC).
          const sbcHere = rankUpgrades(slots, res.slotIndex, sbcPlayers.map((o) => ({ ...o, price: 0 })), { budget, by }).slice(0, 1);
          for (const o of sbcHere) if ((this.costed = (this.costed || 0) + 1) <= 3) await this.costSbc(o); // at most 3 SBCs costed per analysis
          candidates = candidates.concat(sbcHere.map((o) => this.sbcCache.list.find((x) => x.id === o.id)).filter((o) => o && o.cost));
          res.options = rankUpgrades(slots, res.slotIndex, candidates.map((o) => (o.source === 'sbc' ? { ...o, price: o.cost.cost } : o)), { budget, by })
            .filter((o) => o.source === 'club' || o.price <= budget).slice(0, 4);
          res.done = true;
          ui.renderUpgrades();
        }
        ui.log(`Team: rating ${this.summary.rating}, chemistry ${this.summary.chem}/33 — suggestions for your ${this.results.length} weakest spots`, 'ok');
        if (engine.cfg.upgradeEvos !== false) await this.teamEvos();
      });
    },

    /**
     * Evolutions your squad's cards can start right now — only ones EA says the card qualifies for (meetsRequirements),
     * starting XI first, then subs/reserves. One preview per pick (what the card becomes). No market searches.
     */
    async teamEvos() {
      engine.setStatus('pricing', 'Checking evolutions for your squad…');
      const r = await fut.evolutions();
      if (!r.ok) { this.evoTeam = { error: String(r.status) }; ui.renderUpgrades(); return; }
      const sq = await fut.activeSquad();
      const all = sq ? (typeof sq.getPlayers === 'function' ? sq.getPlayers() : sq.getFieldPlayers()) : [];
      const xiIds = new Set((this.squad || []).map((x) => x.player && x.player.item && x.player.item.id).filter(Boolean));
      const items = all.map((x) => x && (x.item || x)).filter((it) => it && it.definitionId && !it.academy);
      const matches = [];
      for (const slot of r.slots) {
        for (const it of items) {
          let ok = false;
          try { ok = typeof slot.meetsRequirements === 'function' && slot.meetsRequirements(it); } catch { ok = false; }
          if (ok) matches.push({ evo: { slot, name: fut.evoName(slot), cost: fut.evoCost(slot) }, player: { ...fut.toPlayer(it), item: it }, group: xiIds.has(it.id) ? 'xi' : 'bench' });
        }
      }
      const picks = evoPicks(matches, 6);
      for (const m of picks.slice(0, 4)) {
        try { m.after = await fut.evoPreview(m.evo.slot, m.player.item); } catch { m.after = null; }
        await jobs.pause(800, 1500);
      }
      this.evoTeam = { picks, total: matches.length, evos: r.slots.length };
      if (!r.slots.some((sl) => typeof sl.meetsRequirements === 'function')) debugLog.push(`evo slot keys (no meetsRequirements): ${Object.keys(r.slots[0] || {}).join(',')}`);
      else if (r.slots[0]) debugLog.push(`evo requirement fields: ${Object.keys(r.slots[0]).filter((k) => /req|elig|max|min|pos|rating|rare|league|nation|club/i.test(k)).join(',')}`);
      ui.renderUpgrades();
      ui.log(picks.length ? `🧬 Evolutions your squad can use now: ${picks.map((m) => `${m.player.name} → ${m.evo.name}`).join(' · ')}` : `🧬 None of the ${r.slots.length} evolutions fit your squad's cards right now`, picks.length ? 'ok' : 'muted');
    },

    /** Players you can get from SBCs right now (ones you don't own). Cached for 30 min. */
    async sbcPlayers(ownedBase) {
      if (!this.sbcCache || Date.now() - this.sbcCache.at > 30 * 60e3) {
        engine.setStatus('pricing', 'Checking player SBCs…');
        const r = await fut.sbcSets();
        if (!r.ok) { ui.log(`Couldn’t load SBCs (${r.status}) — skipping SBC players`, 'warn'); return []; }
        const list = [];
        for (const set of r.sets) {
          if (typeof set.isComplete === 'function' && set.isComplete()) continue;
          for (const it of fut.sbcRewardPlayers(set)) list.push({ ...fut.toPlayer(it), source: 'sbc', set, setName: set.name });
        }
        if (!list.length && r.sets[0]) debugLog.push(`no player SBCs found; first set keys: ${Object.keys(r.sets[0]).join(',')}`);
        this.sbcCache = { at: Date.now(), list };
        ui.log(`Player SBCs: ${list.length ? list.map((p) => `${p.name} ${p.rating}`).join(', ') : 'none right now'}`, 'muted');
      }
      return this.sbcCache.list.filter((p) => p.player && !ownedBase.has(baseId(p.id)));
    },

    /** Rough coin cost of an SBC player: each challenge filled with the cheapest cards per rating. */
    async costSbc(o) {
      const p = this.sbcCache.list.find((x) => x.id === o.id);
      if (!p || p.cost) return;
      engine.setStatus('pricing', `Costing ${p.setName}…`);
      const r = await fut.challenges(p.set);
      jobs.check(r, 'loading SBC');
      const ks = r.list.filter((ch) => !(typeof ch.isCompleted === 'function' && ch.isCompleted()))
        .map((ch) => parseRequirements(fut.requirements(ch), fut.requiredPlayers(ch)).constraints);
      const ladder = await this.ladder();
      p.cost = { ...sbcCostEstimate(ks, ladder), challenges: ks.length };
      ui.log(`🧩 ${p.setName}: ${ks.length} challenge${ks.length === 1 ? '' : 's'} · ≈ ${fmt(p.cost.cost)} coins from the market${p.cost.unknown ? ` (${p.cost.unknown} not estimated)` : ''} — less with your own fodder`, 'muted');
      await jobs.pause(engine.cfg.delayMin, engine.cfg.delayMax);
    },

    /** Cheapest market price per rating (gold), for SBC cost estimates. Cached for 30 min. */
    async ladder() {
      if (this.ladderCache && Date.now() - this.ladderCache.at < 30 * 60e3) return this.ladderCache.m;
      const seen = [];
      const bands = [[0, 1000], [900, 2500], [2000, 6000], [5000, 15000], [12000, 45000]];
      for (const [i, [lo, hi]] of bands.entries()) {
        engine.setStatus('pricing', `Checking fodder prices… ${i + 1}/${bands.length}`);
        const c = fut.newCriteria();
        c.level = 'gold';
        if (lo >= 200) c.minBuy = lo;
        c.maxBuy = hi;
        const r = await fut.search(c);
        engine.countUsage('searches');
        jobs.check(r, 'fodder prices');
        for (const l of r.listings) if (l.buyNowPrice) seen.push({ rating: l.rating, price: l.buyNowPrice });
        await jobs.pause(engine.cfg.delayMin, engine.cfg.delayMax);
      }
      this.ladderCache = { at: Date.now(), m: priceLadder(seen) };
      return this.ladderCache.m;
    },

    /**
     * Market listings for a slot within budget: by position alone (best value),
     * then in your squad's main league and nation (keeps chemistry).
     */
    async market(res, budget, opts = {}) {
      const out = [];
      const s = this.summary;
      const lg = s.leagues[0] && s.leagues[0].value;
      const nt = s.nations[0] && s.nations[0].value;
      const searches = [
        { min: Math.round(budget * 0.3) },
        { league: lg, min: Math.round(budget * 0.15) },
        { nation: nt, min: Math.round(budget * 0.15) },
        { min: Math.round(budget * 0.08) },
      ].filter((q) => !('league' in q) || q.league).filter((q) => !('nation' in q) || q.nation).slice(0, opts.searches || 4);
      let matched = 0;
      for (const q of searches) {
        engine.setStatus('pricing', `Searching market for a ${res.position}…`);
        const c = fut.newCriteria();
        if (q.league) c.league = q.league;
        if (q.nation) c.nation = q.nation;
        c._position = res.position;
        c.position = res.position;
        c.level = 'gold';
        c.maxBuy = roundPrice(budget);
        if (q.min >= 200) c.minBuy = roundPrice(q.min);
        const r = await fut.search(c);
        engine.countUsage('searches');
        jobs.check(r, 'market search');
        for (const l of r.listings) {
          const p = fut.toPlayer(l.item);
          if (!p.player || !l.buyNowPrice) continue;
          if (p.positions.includes(res.position)) matched++;
          out.push({ ...p, price: l.buyNowPrice, source: 'market' });
        }
        await jobs.pause(engine.cfg.delayMin, engine.cfg.delayMax);
      }
      debugLog.push(`market for ${res.position}: ${out.length} listings, ${matched} in position`);
      // Cheapest listing per card.
      const best = new Map();
      for (const p of out) if (!best.has(p.id) || best.get(p.id).price > p.price) best.set(p.id, p);
      return [...best.values()];
    },

    /**
     * Auto-fill the priority list from what your team needs: finds affordable
     * upgrades for your weakest spots and adds the best one per spot, with a
     * max buy under its cheapest listing so it's a snipe.
     */
    async autofill() {
      await jobs.run('Filling from team needs', async () => {
        const cfg = engine.cfg;
        const budget = listSpendable(cfg, fut.coins());
        if (budget < 1000) { ui.log('Not enough coins (or spend limit) left to fill the list', 'warn'); return; }
        const { slots, order, by } = await this.readSquad();
        const listed = new Set(cfg.players.map((p) => baseId(p.id)));
        // Everything you own — whole club, SBC storage, transfer list, unassigned
        // (any version of a player counts) — is never bought again.
        const { club, ownedBase } = await this.ownedCards(slots);
        const off = Math.max(0, Math.min(50, cfg.discount || 0)) / 100;
        // Look a bit above budget: a snipe at `discount`% under still fits.
        const searchBudget = roundPrice(budget / (1 - off));
        const added = [];
        for (const idx of order.slice(0, 3)) {
          if (jobs.cancelled) break;
          const res = { slotIndex: idx, position: slots[idx].position };
          const market = (await this.market(res, searchBudget, { searches: 3 })).filter((o) => !ownedBase.has(baseId(o.id)));
          const ranked = rankUpgrades(slots, idx, [...club, ...market], { budget: searchBudget, by });
          if (ranked[0] && ranked[0].source === 'club') {
            ui.log(`🧩 ${res.position}: you already own ${ranked[0].name} ${ranked[0].rating} — put that card in your squad (no need to buy)`, 'ok');
            continue;
          }
          const best = ranked.find((o) => o.source !== 'club' && !listed.has(baseId(o.id)));
          if (!best) { ui.log(`${res.position}: no affordable upgrade found`, 'muted'); continue; }
          const maxBuy = Math.min(roundPrice(best.price * (1 - off), 'down'), roundPrice(budget, 'down'));
          if (maxBuy < MIN_PRICE) continue;
          const entry = { id: best.id, name: best.name, rating: best.rating, manualMax: maxBuy, autofill: `${res.position} upgrade`, lowest: best.price };
          listed.add(baseId(best.id));
          added.push(entry);
          ui.log(`🧩 ${res.position}: ${best.name} ${best.rating} — cheapest ${fmt(best.price)}, sniping ≤ ${fmt(maxBuy)}${best.chemGain > 0 ? ` · +${best.chemGain} chem` : ''}`, 'ok');
        }
        if (!added.length) { ui.log('No upgrades found within your budget right now — try again later or raise the spend limit', 'warn'); return; }
        engine.cfg.players = [...engine.cfg.players.filter((p) => !p.autofill), ...added];
        engine.save();
        ui.renderPlayers();
        ui.log(`Added ${added.length} team upgrade${added.length === 1 ? '' : 's'} to your priority list — tap ▶ to snipe`, 'ok');
      });
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
        const by = engine.cfg.lineupBy || 'meta';
        const cur = lineupScore(curPlayers, curSlots, { by });

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
        const withStats = players.filter((p) => p.stats).length;
        if (by === 'meta') ui.log(withStats ? `Meta: face stats found for ${withStats}/${players.length} players` : 'Meta: this Web App version doesn’t expose face stats — using rating instead', withStats ? 'muted' : 'warn');
        const sampleItem = allSquad.map((x) => x && (x.item || x)).find((it) => it && it.definitionId);
        if (sampleItem) debugLog.push(`item keys: ${Object.keys(sampleItem).slice(0, 60).join(',')}`);
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
        const list = [{ id: curFormation, label: `${curLabel} (yours now)`, rating: cur.rating, chem: cur.chem, meta: cur.meta, score: cur.score, lineup: curPlayers, slots: curSlots, current: true, filled: curPlayers.filter(Boolean).length, ins: [], outs: [] }];
        // Best XI in the formation you already use.
        const same = bestLineup(players, curSlots, { by });
        if (same.filled >= 11) list.push({ id: curFormation, label: `${curLabel} — best XI`, rating: same.rating, chem: same.chem, meta: same.meta, score: same.score, lineup: same.lineup, slots: curSlots, filled: same.filled, ...describe(same.lineup) });
        for (const [id, f] of Object.entries(FORMATIONS)) {
          if (id === curFormation) continue;
          const best = bestLineup(players, f.slots, { by });
          const missing = f.slots.filter((_, i) => !best.lineup[i]);
          list.push({ id, label: f.label, rating: best.rating, chem: best.chem, meta: best.meta, score: best.score, lineup: best.lineup, slots: f.slots, filled: best.filled, missing, ...describe(best.lineup) });
        }
        const metaOf = (f) => (!f.current && META_NOTES.formations[f.id] ? 1 : 0);
        list.sort((x, y) => (y.filled === 11) - (x.filled === 11) || metaOf(y) - metaOf(x) || y.score - x.score);
        // weakest spots in each lineup (where an upgrade helps most)
        for (const f of list) {
          f.weak = f.lineup.map((p, k) => ({ p, pos: f.slots[k], v: p ? (by === 'meta' ? metaScore(p, f.slots[k]) : p.rating) : 0 }))
            .filter((x) => x.p).sort((a, b) => a.v - b.v).slice(0, 2);
        }
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
      const players = engine.cfg.players.filter((p) => baseId(p.id) !== baseId(opt.id));
      players.push({ id: opt.id, name: opt.name, rating: opt.rating, manualMax: opt.price ? roundPrice(opt.price) : 0 });
      engine.cfg.players = players;
      engine.save();
      ui.renderPlayers();
      ui.showTab('snipe');
      ui.log(`Added ${opt.name} to snipe${opt.price ? ` at ≤ ${fmt(roundPrice(opt.price))}` : ''} — tap ▶ to start`, 'ok');
    },
  };

  // ---- Evolutions helper ---------------------------------------------------------------

  const evos = {
    list: [], // [{ slot, name, cost, players: [{ name, rating, item, after }] }]

    async find() {
      await jobs.run('Finding evolutions', async () => {
        engine.setStatus('pricing', 'Loading evolutions…');
        const r = await fut.evolutions();
        jobs.check(r, 'loading evolutions');
        engine.setStatus('pricing', 'Reading your club…');
        const club = await fut.clubPlayers((n) => engine.setStatus('pricing', `Reading your club… ${n}`), { storage: false });
        jobs.check(club, 'reading your club');
        const items = club.items.filter((it) => (typeof it.isPlayer === 'function' ? it.isPlayer() : true));
        this.list = r.slots.map((slot) => {
          const fits = items.filter((it) => { try { return slot.meetsRequirements(it); } catch { return false; } })
            .map((it) => ({ ...fut.toPlayer(it), item: it })).sort((a, b) => b.rating - a.rating);
          return { slot, name: fut.evoName(slot), cost: fut.evoCost(slot), players: fits };
        }).sort((a, b) => b.players.length - a.players.length);
        ui.renderEvos();
        const usable = this.list.filter((e) => e.players.length).length;
        ui.log(`Evolutions: ${this.list.length} available · ${usable} with players from your club`, 'ok');
        if (this.list.length && !r.slots.some((sl) => typeof sl.meetsRequirements === 'function')) debugLog.push(`evo slot keys: ${Object.keys(r.slots[0] || {}).join(',')}`);
      });
    },

    /** What the best few qualifying players become (one request each). */
    async preview(i) {
      const e = this.list[i];
      if (!e) return;
      await jobs.run('Previewing evolution', async () => {
        for (const p of e.players.slice(0, 3)) {
          engine.setStatus('pricing', `Previewing ${p.name}…`);
          try { p.after = await fut.evoPreview(e.slot, p.item); } catch { p.after = null; }
          ui.renderEvos();
          await jobs.pause(1000, 1800);
        }
      });
    },
  };

  // ---- Hot cards (market scanner) ---------------------------------------------------

  const hot = {
    list: [], // [{ id, name, rating, count, bids, score, avg, lowest, plan }]
    scannedAt: 0,

    budget() {
      const cfg = engine.cfg;
      return tradeCap(cfg, fut.coins());
    },

    /**
     * Find cards worth flipping. Sources: cards you've flipped for profit before
     * (your history), then a market sweep in narrow price bands per league (so
     * copies of the same card show up together). The best candidates are
     * price-checked and ranked by profit × liquidity × demand.
     */
    async scan(autoAdd) {
      let added = false;
      await jobs.run('Finding hot cards', async () => {
        const cfg = engine.cfg;
        const budget = this.budget();
        if (budget < 1000) { ui.log('Not enough coins to trade', 'warn'); return; }
        const cands = new Map(); // id -> candidate
        const put = (c, src) => {
          const cur = cands.get(c.id);
          if (cur) { cur.src.add(src); Object.assign(cur, { proven: cur.proven || c.proven }); return; }
          cands.set(c.id, { score: 0, count: 0, bids: 0, ...c, src: new Set([src]) });
        };
        // 1) proven flips
        const proven = provenFlips(engine.history, Date.now()).slice(0, 4);
        proven.forEach((c) => put({ id: c.id, name: c.name, rating: c.rating, proven: c }, 'proven'));
        // 2) market sweep: league × narrow price band, page 1 (+ page 2 when full)
        const leagues = String(cfg.hotLeagues || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean);
        const bands = priceBands(budget, 5);
        const ls = leagues.length ? leagues : [0];
        const maxSearches = Math.max(4, Math.min(30, cfg.hotSearches || 14));
        // every band and every league, each combination once
        const plan = [];
        for (let i = 0; i < Math.min(maxSearches, bands.length * ls.length); i++) {
          plan.push({ band: bands[i % bands.length], league: ls[(i + Math.floor(i / bands.length)) % ls.length] });
        }
        const all = [];
        let searches = 0;
        // If EA returns nothing, relax the filters step by step (rare-only, then league) and say so.
        let relax = cfg.hotRareOnly && !this.rareEmpty ? 0 : 1;
        if (cfg.hotRareOnly && this.rareEmpty) ui.log('Hot scan: “rare only” found nothing earlier this session — scanning all gold cards', 'muted');
        let emptyRun = 0;
        for (const sg of plan) {
          if (jobs.cancelled) break;
          engine.setStatus('pricing', `Scanning the market… ${searches + 1}/${plan.length}`);
          const c = fut.newCriteria();
          if (sg.league && relax < 2) c.league = sg.league;
          c.level = 'gold';
          if (relax < 1) c.rarities = [1];
          c.minBuy = sg.band[0];
          c.maxBuy = sg.band[1];
          const r = await fut.search(c);
          searches++;
          engine.countUsage('searches');
          jobs.check(r, 'market scan');
          if (searches <= 2 || !r.listings.length) debugLog.push(`hot search ${searches}: ${JSON.stringify({ type: c.type, category: c.category, level: c.level, league: c.league, rarities: c.rarities, minBuy: c.minBuy, maxBuy: c.maxBuy })} → ${r.listings.length} listings`);
          emptyRun = r.listings.length ? 0 : emptyRun + 1;
          // only when a whole sweep (every price band) found nothing — high bands are often legitimately empty
          if (emptyRun >= Math.max(2, bands.length) && relax < 2 && !all.length && !r.listings.length) {
            relax++;
            emptyRun = 0;
            if (relax === 1) this.rareEmpty = true;
            ui.log(relax === 1 ? 'Hot scan: no results with “rare only” — trying all gold cards' : 'Hot scan: still nothing — trying without the league filter', 'warn');
          }
          all.push(...r.listings);
          await jobs.pause(cfg.delayMin, cfg.delayMax);
        }
        const agg = aggregateListings(all);
        agg.filter((c) => c.count >= 2).forEach((c) => prices.add(c.id, { name: c.name, rating: c.rating }, c.minBin, c.count));
        const ranked = rankHot(agg, { budget, minListings: 2 });
        ranked.forEach((c) => put(c, 'market'));
        // When nothing repeats, the most-bid-on singles are still worth a look.
        if (!ranked.length) agg.filter((c) => c.bids > 0 && c.minBin <= budget).sort((a, b) => b.bids - a.bids).slice(0, 4).forEach((c) => put({ ...c, score: c.bids }, 'bids'));
        this.snipeList = agg.map((c) => ({ ...c, bins: undefined, ...snipeScore(c, { budget }) })).filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
        ui.log(this.snipeList.length ? `🎯 Snipe-friendly: ${this.snipeList.map((x) => `${x.name} ${x.score} (spread ${Math.round(x.spread * 100)}%, try ${x.suggest}% under)`).join(', ')}` : '🎯 No snipe-friendly cards in this scan (prices were tight)', this.snipeList.length ? 'ok' : 'muted');
        const repeats = agg.filter((c) => c.count >= 2).length;
        ui.log(`Scanned ${all.length} listings in ${searches} searches · ${agg.length} different cards, ${repeats} listed more than once · ${proven.length} proven flip${proven.length === 1 ? '' : 's'} from your history`, 'muted');
        if (!cands.size) {
          ui.log('No candidates — the market looked empty in your price range. Check the leagues to scan or raise the budget.', 'warn');
          return;
        }
        // 3) price-check the best candidates
        const queue = [...cands.values()].sort((a, b) => (!!b.proven - !!a.proven) || b.score - a.score).slice(0, Math.min(6, Math.max(4, (cfg.hotPick || 3) + 2)));
        const out = [];
        const why = [];
        for (const card of queue) {
          if (jobs.cancelled) break;
          engine.setStatus('pricing', `Pricing ${card.name}…`);
          const r = await findMarketPrice(engine.priceSearch(card), { defId: card.id });
          jobs.check(r, 'price check');
          if (!r.count) { why.push(`${card.name}: none listed now`); continue; }
          const p = flipPlan(r.avg, tradeOpts(r.avg, cfg));
          const c = { ...card, src: [...card.src], avg: r.avg, lowest: r.lowest, listed: r.count, plan: p };
          if (r.count < 3) { why.push(`${card.name}: only ${r.count} listed — too thin to flip`); await jobs.pause(cfg.delayMin, cfg.delayMax); continue; }
          else if (!p) why.push(`${card.name}: avg ${fmt(r.avg)} — no profit at your min profit`);
          else if (r.avg > budget) { why.push(`${card.name}: avg ${fmt(r.avg)} over your budget`); c.plan = null; }
          prices.add(card.id, { name: card.name, rating: card.rating }, r.lowest, r.count);
          c.trend = prices.trend(card.id);
          c.value = flipValue(c);
          // Trend as a tie-breaker, only with enough history: rising prices sell; falling ones can leave you holding cards.
          if (c.trend && !c.trend.thin) c.value = Math.round(c.value * (c.trend.pct >= 3 ? 1.15 : c.trend.pct <= -5 ? 0.85 : 1));
          out.push(c);
          await jobs.pause(cfg.delayMin, cfg.delayMax);
        }
        out.sort((a, b) => b.value - a.value);
        this.list = out;
        this.scannedAt = Date.now();
        ui.renderHot();
        const good = out.filter((x) => x.plan);
        if (why.length) ui.log(`Skipped: ${why.join(' · ')}`, 'muted');
        ui.log(good.length ? `🔥 Hot: ${good.slice(0, 3).map((x) => `${x.name} ${x.rating || ''} (+${fmt(x.plan.profit)})`).join(', ')}` : 'No card has a profitable flip right now — try a bigger budget, other leagues or a lower min profit', good.length ? 'ok' : 'warn');
        if (autoAdd && good.length) { this.addTop(); added = true; }
      });
      return added;
    },

    snipeList: [],

    addSnipe(i) {
      const c = this.snipeList[i];
      if (!c || engine.running) return;
      const players = engine.cfg.players.filter((p) => p.id !== c.id);
      players.push({ id: c.id, name: c.name, rating: c.rating }); // priced on start like any new player (never hunted at the default max)
      engine.cfg.players = players;
      engine.save();
      ui.renderPlayers(); ui.renderTrade(); ui.renderHot();
      ui.log(`Added ${c.name} — suggested Snipe % ${c.suggest} (your Snipe % stays as set)`, 'ok');
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

  // ---- Session plan (2.4.7) -----------------------------------------------------------
  // Sniping blocks with real breaks; between blocks, only the SBCs you ticked, cheapest checks first.
  // One coin floor for everything (sniping, trades, SBC buys). Anything EA pushes back with —
  // captcha, market limit, logout, a safety lock — ends the whole plan at once. Never auto-resumes.

  const plan = {
    active: false,
    cancelled: false,
    state: store.get(KEYS.plan, null), // { startedAt, startCoins, floor, budget, block, blocks, sbcDone, ended, saved }

    save() { store.set(KEYS.plan, this.state); ui.renderPlan(); },
    cancel() { if (this.active && !this.cancelled) { this.cancelled = true; ui.log('Stopping the plan…', 'warn'); } },
    locked() { engine.safety = store.get(KEYS.safety, {}); return (engine.safety.lockUntil || 0) > Date.now(); },

    /** After a reload: a plan that was running is never resumed — put your settings back and say where it stopped. */
    recover() {
      const st = this.state;
      if (!st || st.ended) return;
      this.restore();
      st.ended = `interrupted at block ${st.block || 1} of ${st.blocks} (the page reloaded) — start a new plan when you're ready`;
      this.save();
      ui.log(`📋 Plan ${st.ended}`, 'warn');
    },

    /** Put back the settings the plan tightened for its run. */
    restore() {
      const st = this.state;
      if (!st || !st.saved) return;
      Object.assign(engine.cfg, st.saved);
      st.saved = null;
      engine.save(); ui.syncForm();
    },

    end(reason, kind = 'warn') {
      const st = this.state;
      this.active = false; // first, so the button and the panel show "ended" when they re-render below
      this.restore();
      st.ended = reason;
      st.endedAt = Date.now();
      st.endCoins = fut.coins();
      this.save();
      const spent = Math.max(0, st.startCoins - st.endCoins);
      const done = Object.values(st.sbcDone || {}).reduce((a, x) => a + x.n, 0);
      const summary = `📋 Plan ended — ${reason} · coins ${fmt(st.startCoins)} → ${fmt(st.endCoins)}${spent ? ` (−${fmt(spent)}, cards bought are in your club/transfer list)` : ''} · ${done} SBC${done === 1 ? '' : 's'} done`;
      ui.log(summary, kind);
      notify.discord('stop', { reason: summary.replace('📋 ', '') });
      this.active = false;
      ui.setRunning(false);
    },

    /** Light health check before every block: logged in, market answers normally. Can only stop, never restart. */
    async check() {
      if (this.locked()) return `safety lock: ${engine.safety.lockReason || 'EA pushback'}`;
      if (!fut.ready()) return 'Web App not ready (logged out?)';
      const gate = engine.gate();
      if (!gate.ok) return gate.reason;
      const c = fut.newCriteria();
      c.level = 'gold';
      c.maxBuy = 1000;
      const r = await fut.search(c);
      engine.countUsage('searches');
      if (!r.ok) {
        const kind = classifyStatus(r.status);
        if (kind === 'captcha' || kind === 'throttled') engine.lock(kind, `EA pushback during the plan check (${r.status})`);
        return `EA answered ${r.status} to the check (${kind || 'error'})`;
      }
      return '';
    },

    /** A real break: no market calls. Optional keep-alive: one transfer-list read every ~10 min. */
    async rest(min) {
      // tests shorten a "minute" (the mock Web App can't wait 20 real minutes)
      let unit = 60e3;
      try { unit = Number(localStorage.getItem('fc-sniper:test-minute-ms')) || 60e3; } catch { /* default */ }
      const until = Date.now() + min * unit;
      let nextPing = Date.now() + 10 * 60e3;
      engine.setStatus('resting', `Plan break — block ${this.state.block + 1} of ${this.state.blocks} next`, until);
      while (Date.now() < until && !this.cancelled) {
        await sleep(Math.min(1000, until - Date.now()));
        if (engine.cfg.planKeepAlive && Date.now() >= nextPing && Date.now() < until - 60e3) {
          nextPing = Date.now() + 10 * 60e3;
          const items = await fut.transferList();
          ui.log(items ? '🔌 keep-alive' : '🔌 keep-alive got no answer — EA may have logged you out', items ? 'muted' : 'warn');
          if (!items) return 'keep-alive got no answer (logged out?)';
        }
      }
      return '';
    },

    /** The SBCs you ticked, in order: each while it's solvable, under the coin cap and above the floor. */
    async sbcs() {
      const st = this.state;
      const cfg = engine.cfg;
      const list = cfg.planSbcs || [];
      if (!list.length || !(cfg.planSbcMax > 0)) return '';
      let done = 0;
      const bad = new Set(st.sbcFailed || []);
      const stopNow = () => this.cancelled || this.locked() || jobs.loggedOut;
      if (!(await sbc.loadSets()) || stopNow()) return stopNow() ? 'stopped during SBCs' : '';
      for (const want of list) {
        while (done < cfg.planSbcMax && !bad.has(want.id)) {
          if (stopNow()) return 'stopped during SBCs';
          const set = sbc.sets.find((x) => String(x.id) === String(want.id));
          const skip = (why) => { ui.log(`📋 ${want.name}: ${why} — skipped for the rest of the plan`, 'muted'); bad.add(want.id); };
          if (!set) { skip('not available any more (done, expired or not loaded)'); break; }
          const room = fut.coins() - st.floor;
          if (room <= 0) return 'coin floor reached';
          await sbc.loadChallenges(set);
          if (stopNow()) return 'stopped during SBCs';
          const entry = (sbc.open.get(set.id) || []).find((e) => !e.parsed.points && !e.parsed.unsupported.length);
          if (!entry) { skip('no challenge the bot can solve'); break; }
          // the plan's caps only ever tighten your own SBC limit
          const before = { limit: cfg.sbcBuyLimit, repeat: cfg.sbcRepeat };
          cfg.sbcBuyLimit = Math.max(0, Math.min(cfg.sbcBuyLimit || 0, cfg.planSbcCoins || 0, room));
          cfg.sbcRepeat = 1;
          try {
            sbc.plan = null;
            await sbc.solve(set, entry);
            if (stopNow()) return 'stopped during SBCs';
            if (!sbc.plan) { skip('no solution within your caps'); break; }
            if (fut.coins() - sbc.plan.buyTotal < st.floor) { ui.log(`📋 ${want.name}: buying ${fmt(sbc.plan.buyTotal)} would go under the floor`, 'muted'); return 'coin floor reached'; }
            const n0 = sbc.submittedTotal || 0;
            await sbc.submit(false);
            if (stopNow()) return 'stopped during SBCs';
            if ((sbc.submittedTotal || 0) > n0) {
              done++;
              const d = st.sbcDone[want.id] || { name: want.name, n: 0 };
              d.n++; st.sbcDone[want.id] = d;
              this.save();
              ui.log(`📋 ${want.name} done (${d.n} tonight) — checking it again`, 'ok');
            } else { skip('submitting failed'); break; }
          } finally {
            engine.cfg.sbcBuyLimit = before.limit; engine.cfg.sbcRepeat = before.repeat; // engine.cfg may have been replaced meanwhile
          }
        }
      }
      st.sbcFailed = [...bad];
      this.save();
      return '';
    },

    async start() {
      if (this.active || engine.running || engine.busy || jobs.current) return;
      ui.commit();
      if (!fut.ready()) { ui.log('Web App not ready — log in first', 'err'); return; }
      const { cfg } = clampConfig(engine.cfg);
      engine.cfg = cfg; engine.save(); ui.syncForm();
      engine.safety = store.get(KEYS.safety, {});
      const gate = engine.gate();
      if (!gate.ok) { ui.log(`Can't start the plan — ${gate.reason}`, 'err'); return; }
      const coins = fut.coins();
      const sum = planSummary(cfg, coins);
      // the plan's budget can make your players unaffordable — say so before it starts
      const room = coins - sum.floor;
      const tooDear = huntTargets(cfg).filter((p) => p.kind !== 'filter' && effectiveMaxBuy(p, cfg) > room).map((p) => p.name);
      const warn = tooDear.length ? `\n\n⚠️ Over the plan's budget (${fmt(room)}), so skipped: ${tooDear.join(', ')}. Raise "Spend at most %" to snipe them.` : '';
      if (!w.confirm(`Start this plan?\n\n${sum.text}${warn}\n\nAny captcha, market limit or logout ends it at once.`)) return;
      if (tooDear.length) ui.log(`📋 Over the plan's budget of ${fmt(room)}, so skipped while the plan runs: ${tooDear.join(', ')}`, 'warn');
      this.state = { startedAt: Date.now(), startCoins: coins, budget: sum.budget, floor: sum.floor, block: 0, blocks: sum.blocks, sbcDone: {}, sbcFailed: [], ended: '',
        saved: { minCoins: cfg.minCoins, sessionMinutes: cfg.sessionMinutes, sbcBuyLimit: cfg.sbcBuyLimit, sbcRepeat: cfg.sbcRepeat } };
      // the plan's floor and block length only ever tighten your settings; put back at the end
      cfg.minCoins = Math.max(cfg.minCoins || 0, sum.floor);
      cfg.sessionMinutes = Math.min(cfg.planBlockMin, SAFETY.maxSessionMinutes); // one block = one session
      engine.save(); ui.syncForm();
      this.active = true; this.cancelled = false; jobs.loggedOut = false;
      this.save();
      ui.setRunning(true);
      ui.log(`📋 Plan started — ${sum.text}`, 'ok');
      try {
        await this.run();
      } catch (e) {
        if (this.active) this.end(`error: ${errText(e)}`, 'err');
      }
    },

    async run() {
      const st = this.state;
      const cfg = engine.cfg;
      for (let b = 1; b <= st.blocks; b++) {
        st.block = b; this.save();
        if (this.cancelled) return this.end('stopped by you');
        const bad = await this.check();
        if (bad) return this.end(`check before block ${b} failed — ${bad}`, 'err');
        if (fut.coins() <= st.floor) return this.end('coin floor reached');
        ui.log(`📋 Block ${b} of ${st.blocks}: sniping for up to ${cfg.sessionMinutes} min (✅ check passed)`, 'ok');
        engine.lastStop = '';
        await engine.start();
        while (engine.running || engine.busy) await sleep(500);
        if (this.cancelled) return this.end('stopped by you');
        if (planVerdict(engine.lastStop, (store.get(KEYS.safety, {}).lockUntil || 0), Date.now()) === 'end') return this.end(`block ${b} ended: ${engine.lastStop || 'it did not start'}`);
        if (b === st.blocks) break;
        const sb = await this.sbcs();
        if (sb === 'stopped during SBCs') return this.end(this.cancelled ? 'stopped by you' : jobs.loggedOut ? 'logged out during an SBC' : 'EA pushback during an SBC', this.cancelled ? 'warn' : 'err');
        const rest = await this.rest(cfg.planBreakMin);
        if (this.cancelled) return this.end('stopped by you');
        if (rest) return this.end(rest, 'err');
      }
      return this.end(`all ${st.blocks} blocks done`, 'ok');
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
    list: [
      ['spendLimit', 'Spend limit (0 = all but Keep coins)', 'number'],
      ['buyOnce', 'Buy each player once', 'toggle'],
      ['reserveForHigher', 'Keep coins for players higher up', 'toggle'],
    ],
    mode: [
      ['mode', 'Mode', 'seg', OPT([['buy', 'Buy'], ['trade', 'Trade'], ['alert', 'Alert']])],
    ],
    snipe: [
      ['discount', 'Snipe % under avg', 'number'],
      ['minCoins', 'Keep coins', 'number'],
      ['maxBuys', 'Buys per session', 'number'],
      ['bidSnipe', 'Also bid on auctions ending soon', 'toggle'],
    ],
    snipeAdv: [
      ['liveLog', 'Live updates (a log line for every search)', 'toggle'],
    ],
    bids: [
      ['bidWindow', 'Bid in the last (seconds)', 'number'],
      ['maxActiveBids', 'Open bids at once', 'number'],
      ['dryTurns', 'Dry spell: switch to auctions after N Buy Now searches (0 = off)', 'number'],
      ['dryAuctionSearches', '… then auction-only searches for that player', 'number'],
      ['bidWars', 'Bid wars at once (1–3)', 'number'],
      ['bidWarStretchPct', 'War: go up to % over my max', 'number'],
      ['bidWarMaxCounters', 'War: give up after N counter-bids', 'number'],
      ['bidWarPoolPct', 'Wars may hold % of my coins', 'number'],
      ['bidWarMinSteps', 'Start a war only with N+ bid steps of room', 'number'],
      ['binIdealPct', 'Buy Now this % under avg always wins', 'number'],
      ['warKeepPct', 'War this % under avg beats a Buy Now', 'number'],
    ],
    trade: [
      ['undercut', 'List % under market avg', 'number'],
      ['goalBufferPct', 'SBC coin goal: aim this % above the cost', 'number'],
      ['minProfit', 'Min profit per card (after tax)', 'number'],
      ['minProfitPct', 'Min profit % of market avg', 'number'],
      ['listDuration', 'List for', 'select', DURATIONS],
      ['upkeepMinutes', 'Check transfer list every (min)', 'number'],
      ['smartRelist', 'Reprice expired cards to the market', 'toggle'],
      ['cutLossAfter', 'Sell at break-even after N relists (0 = never)', 'number'],
      ['repriceMinutes', 'Refresh prices every (min)', 'number'],
      ['tradeBudget', 'Max coins per card (0 = no fixed cap)', 'number'],
      ['tradeBudgetPct', 'Max % of my coins on one card', 'number'],
    ],
    smart: [
      ['smartSnipe', 'Smart sniping (picks which card to search)', 'toggle'],
    ],
    smartAdv: [
      ['smartPrice', 'Also let it set the discount (experimental)', 'toggle'],
      ['smartMinPct', 'Never closer than % under avg', 'number'],
      ['smartMaxPct', 'Never deeper than % under avg', 'number'],
      ['smartProbeEvery', 'Near-miss check: 1 in N searches (0 = off)', 'number'],
    ],
    plan: [
      ['planBlocks', 'Sniping blocks', 'number'],
      ['planBlockMin', 'Block length (min, ≤ 120)', 'number'],
      ['planBreakMin', 'Break between blocks (min, ≥ 20)', 'number'],
      ['planBudgetPct', 'Spend at most % of my coins', 'number'],
      ['planSbcMax', 'SBCs per break', 'number'],
      ['planSbcCoins', 'Max coins of buys per SBC', 'number'],
      ['planKeepAlive', 'Keep me logged in during breaks', 'toggle'],
    ],
    hot: [
      ['hotAuto', 'Pick hot cards when I start trading', 'toggle'],
      ['hotPick', 'How many hot cards to trade', 'number'],
      ['hotRareOnly', 'Rare golds only', 'toggle'],
      ['hotLeagues', 'Leagues to scan (13 Premier League, 53 LaLiga, 19 Bundesliga, 31 Serie A, 16 Ligue 1)', 'text', '13,53,19,31,16'],
      ['hotSearches', 'Searches per scan', 'number'],
    ],
    squad: [
      ['lineupBy', 'Best XI by', 'seg', OPT([['meta', 'Meta (stats)'], ['rating', 'Rating']])],
      ['upgradeBudget', 'Budget (0 = my coins)', 'number'],
      ['upgradeMarket', 'Also search the market', 'toggle'],
      ['upgradeSbc', 'Include SBC players', 'toggle'],
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
      ['sbcUseUnassigned', 'Use my Unassigned players', 'toggle'],
      ['sbcBuyMissing', 'Buy missing players (cheapest)', 'toggle'],
      ['sbcBuyLimit', 'Max coins to spend per SBC', 'number'],
      ['pointsBuyLimit', 'Max coins to buy for 💎 SBCs (0 = never)', 'number'],
      ['sbcOpenRewards', 'Open reward packs after SBCs', 'toggle'],
    ],
    filters: [
      ['autoPrice', 'Auto max buy from price', 'toggle'],
      ['maxBuy', 'Default max buy', 'number', 'Used when there’s no price'],
      ['minRating', 'Min rating', 'number'],
      ['level', 'Quality', 'select', OPT([['any', 'Any'], ['gold', 'Gold'], ['silver', 'Silver'], ['bronze', 'Bronze']])],
      ['rarity', 'Rarity ID', 'text', 'e.g. 1 = rare'],
      ['position', 'Position', 'select', POSITIONS],
      ['nation', 'Nation ID', 'text', 'e.g. 14 England, 18 France, 21 Germany, 54 Brazil, 52 Argentina'],
      ['league', 'League ID', 'text', '13 Premier League, 53 LaLiga, 19 Bundesliga, 31 Serie A, 16 Ligue 1'],
      ['club', 'Club ID', 'text', 'number from the club’s EA id'],
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
    ],
    notify: [
      ['theme', 'Accent colour', 'select', OPT([['green', 'Green'], ['orange', 'Orange']])],
      ['sound', 'Sound & vibration', 'toggle'],
      ['discordWebhook', 'Discord webhook', 'text', 'https://discord.com/api/webhooks/…'],
    ],
  };

  /** The two stats that matter most for a position, e.g. " · PAC 95 · DRI 90". */
  function keyStats(p, pos) {
    const w = META_WEIGHTS[pos];
    if (!w || !p.stats) return '';
    const names = ['PAC', 'SHO', 'PAS', 'DRI', 'DEF', 'PHY'];
    const vals = [p.stats.pac, p.stats.sho, p.stats.pas, p.stats.dri, p.stats.def, p.stats.phy];
    return w.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).slice(0, 2).map(([, i]) => ` · ${names[i]} ${vals[i]}`).join('');
  }

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
  #fcs{--bg:#0f1823;--card:#16212d;--card2:#1d2a38;--line:#263445;--pos:#3ddc84;--text:#e9eef3;--muted:#8796a5;--dim:#7a8796;
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

  #fcs.orange{--green:#ff7a1a;--green-ink:#1f0b00;--blue:#ffb066}
  #fcs .up,#fcs .hist .g,#fcs .profit .stats b.g,#fcs .profit .hist .g{color:var(--pos)} /* profit is green in every theme */
  #fcs.orange .logo{background:linear-gradient(135deg,#ff8a2a,#c74507);color:#1f0b00}
  #fcs .hd,#fcs .tabs{flex:none}
  #fcs .frow{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)}
  #fcs .frow:last-child{border-bottom:0}
  #fcs .frow .t{flex:1;min-width:0}#fcs .frow .t b{display:block;font-weight:600}#fcs .frow .t small{display:block;color:var(--dim);font-size:11.5px}
  #fcs .frow.off .t{opacity:.5}
  #fcs .sw{width:36px;height:22px;border-radius:999px;background:var(--card2);border:1px solid var(--line);position:relative;flex:none}
  #fcs .sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--muted);transition:.2s}
  #fcs .sw.on{background:var(--green);border-color:var(--green)}#fcs .sw.on::after{left:16px;background:#fff}
  #fcs .fed{background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin:8px 0}
  #fcs .tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:2px 10px 10px;border-bottom:1px solid var(--line)}
  #fcs .tabs button{padding:7px 2px;color:var(--muted);font-weight:600;font-size:12px;border-radius:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #fcs .tabs button.on{color:var(--text);background:var(--card2);box-shadow:inset 0 -2px 0 var(--green)}
  #fcs .body{flex:1;min-height:0}
  #fcs .last{margin:6px 0 0;font-size:12px;color:var(--muted);white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  #fcs .last:empty{display:none}
  #fcs .jobbar{display:flex;align-items:center;gap:8px;justify-content:space-between;margin:6px 0;padding:8px 10px;border-radius:10px;background:rgba(232,163,61,.15);border:1px solid rgba(232,163,61,.5);font-size:13px}
  #fcs .jobbar[hidden]{display:none}
  #fcs .jobbar .mini{min-height:32px;padding:0 14px}
  #fcs .last.ok{color:var(--green)}#fcs .last.warn{color:var(--amber)}#fcs .last.err{color:var(--red)}#fcs .last.alert{color:#ffe08a}
  #fcs .btn.go-btn{background:var(--green);border-color:var(--green);color:var(--green-ink)}
  #fcs .body{overflow-y:auto;overflow-x:hidden;padding:12px 14px 14px;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
  #fcs .log div,#fcs small,#fcs .note{overflow-wrap:anywhere}
  #fcs.min .tabs,#fcs.min .body{display:none}
  #fcs .pane{display:none}#fcs .pane.on{display:block}

  #fcs .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:10px}
  #fcs .card h4.title{text-transform:none;letter-spacing:0}
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
  #fcs .chip{display:flex;flex-direction:column;gap:4px;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:7px 6px 7px 10px}
  #fcs .chip .top,#fcs .chip .bot{display:flex;align-items:center;gap:8px}
  #fcs .chip .bot{justify-content:space-between;padding-left:20px}
  #fcs .chip .num{font-weight:800;color:var(--dim);font-size:11px;min-width:12px}
  #fcs .chip .ord{display:flex;gap:4px}
  #fcs .chip .ord button{width:28px;height:22px;line-height:20px;font-size:12px;color:var(--muted);background:var(--card);border-radius:6px}
  #fcs .chip .ord button:disabled{opacity:.25}
  #fcs .two{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  #fcs .two .btn{margin-top:8px;font-size:12px;padding:9px 4px}
  #fcs .spend{margin:8px 0 2px;color:var(--muted);font-size:12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  #fcs .spend b{color:var(--text)}
  #fcs .chip .ovr{font-weight:800;color:var(--green);font-size:12px;min-width:22px}
  #fcs .chip .nm{flex:1;min-width:0;font-weight:600;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.25}
  #fcs .chip .nm small{display:block;font-weight:400;color:var(--dim);font-size:11px}
  #fcs .chip .mx{font-weight:700;color:var(--amber);font-variant-numeric:tabular-nums;padding:4px 7px;border-radius:7px;background:rgba(255,200,87,.08)}
  #fcs .chip .mx.manual{color:var(--blue);background:rgba(90,169,255,.1)}
  #fcs .chip .rm{width:26px;height:26px;color:var(--dim);font-size:17px;border-radius:7px}
  #fcs .sugg{position:absolute;left:0;right:0;top:100%;z-index:3;margin-top:4px;background:var(--card2);border:1px solid var(--line);border-radius:10px;max-height:260px;overflow:auto;box-shadow:0 12px 30px rgba(0,0,0,.5)}
  #fcs .sugg:empty{display:none}
  #fcs .sugg .face{width:30px;height:30px;border-radius:50%;object-fit:cover;background:var(--card);margin-right:9px;flex:none}
  #fcs .sugg button.who{justify-content:flex-start}#fcs .sugg button.who span{flex:1}
  #fcs .sugg:has(.vcards){max-height:min(440px,60vh)}
  #fcs .vcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:8px;padding:8px}
  #fcs .sugg button.vcard{display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 6px 8px;border:1px solid var(--line);border-radius:12px;text-align:center;
    background:linear-gradient(160deg,#3a3f47,#20252c)}
  #fcs .sugg button.vcard.rare{background:linear-gradient(160deg,#7a6326,#2e2814);border-color:#a8873a}
  #fcs .sugg button.vcard.special{background:linear-gradient(160deg,#5b2a86,#1e1430);border-color:#8e5bd1}
  #fcs .vcard .ovr{font:800 22px/1 -apple-system,system-ui,sans-serif}
  #fcs .vcard img{width:64px;height:64px;object-fit:contain}
  #fcs .vcard .ph{width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;font-weight:700}
  #fcs .vcard .vn{font-size:12px;font-weight:600;line-height:1.2}
  #fcs .vcard .vp{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
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
  #fcs [data-pane=log] .log{max-height:50vh}
  #fcs .copybox{margin-bottom:8px}#fcs .copybox p{margin:0 0 6px}
  #fcs .copybox textarea{width:100%;box-sizing:border-box;font:11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px}
  #fcs .log div{padding:2px 0;color:var(--muted)}#fcs .log time{color:var(--dim);margin-right:6px}
  #fcs .log .ok{color:var(--green)}#fcs .log .warn{color:var(--amber)}#fcs .log .err{color:var(--red)}#fcs .log .alert{color:#ffe08a}#fcs .log .muted{color:var(--dim)}
  #fcs .hist{display:flex;flex-direction:column}
  #fcs .hist div{display:grid;grid-template-columns:1fr auto;gap:2px 8px;padding:7px 0;border-bottom:1px solid var(--line)}
  #fcs .hist div:last-child{border-bottom:0}
  #fcs .hist small{color:var(--dim)}#fcs .hist .p{text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
  #fcs .hist .g{color:var(--green)}
  #fcs .profit .stats b.g,#fcs .profit .hist .g{color:var(--green)}#fcs .profit .stats b.r,#fcs .profit .hist .r{color:var(--red)}
  #fcs .profit .stats small{display:block;font-size:10px;color:var(--dim)}
  #fcs .profit h5{margin:10px 0 2px;font-size:12px;color:var(--muted)}
  #fcs .pbars{display:flex;align-items:flex-end;gap:5px;height:64px;margin:8px 0 4px}
  #fcs .pbars span{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:2px}
  #fcs .pbars i{display:block;width:100%;background:var(--green);border-radius:3px 3px 0 0}
  #fcs .pbars i.neg{background:var(--red)}
  #fcs .pbars em{font-style:normal;font-size:10px;color:var(--dim)}
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
  #fcs details.adv,#fcs details.hint{margin-top:6px}
  #fcs details.adv>summary,#fcs details.hint>summary{cursor:pointer;color:var(--muted);font-weight:600;font-size:12.5px;padding:6px 0;list-style:none}
  #fcs details.adv>summary::-webkit-details-marker,#fcs details.hint>summary::-webkit-details-marker{display:none}
  #fcs details.adv>summary::before,#fcs details.hint>summary::before{content:"▸ "}
  #fcs details[open].adv>summary::before,#fcs details[open].hint>summary::before{content:"▾ "}
  #fcs.mob details.adv>summary,#fcs.mob details.hint>summary{min-height:44px;display:flex;align-items:center}
  #fcs .chip .mx.none{color:var(--dim);background:var(--card);font-weight:600}
  #fcs .chip .ord button.edge{visibility:hidden}
  #fcs.mob .chip .mx{min-height:40px;min-width:64px}
  #fcs.mob .mini{padding:9px 12px;font-size:14px;min-height:40px}#fcs.mob .rm,#fcs.mob .ord button{min-width:44px;min-height:44px}#fcs.mob .li{padding:10px 0}

  #fcs-toast{position:fixed;left:50%;top:calc(env(safe-area-inset-top, 0px) + 12px);transform:translate(-50%,-30px);opacity:0;visibility:hidden;z-index:2147483001;padding:10px 16px;border-radius:12px;
    font:600 14px -apple-system,system-ui,sans-serif;color:#05210f;background:#3ddc84;box-shadow:0 12px 30px rgba(0,0,0,.4);transition:transform .25s,opacity .25s,visibility .25s;pointer-events:none;max-width:90vw}
  #fcs-toast.show{transform:translate(-50%,0);opacity:1;visibility:visible}#fcs-toast.alert{background:#ffc857;color:#2b1d00}

  #fcs.mob{top:auto!important;left:0!important;right:0!important;bottom:0;width:auto;max-height:78vh;max-height:88dvh;border-radius:20px 20px 0 0;border-bottom:0;
    font-size:15px;padding-bottom:env(safe-area-inset-bottom)}
  #fcs.mob .hd{cursor:default;padding:12px 12px 10px 16px}
  #fcs.mob .hd::before{content:"";position:absolute;left:50%;top:5px;width:36px;height:4px;margin-left:-18px;border-radius:9px;background:var(--line)}
  #fcs.mob .go{width:48px;height:40px}#fcs.mob .fold{width:40px;height:40px}
  #fcs.mob:not(.min){height:min(80vh,720px);height:min(88dvh,760px)}
  #fcs.mob .tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}
  #fcs.mob .tabs button{height:39px;padding:0 2px;font-size:13px}
  #fcs.mob .last{font-size:13px}
  #fcs.mob input,#fcs.mob select{font-size:16px;padding:10px}
  #fcs.mob .row{padding:7px 0}#fcs.mob .seg button{padding:8px 4px;font-size:14px}
  #fcs.mob .btn{padding:13px}
  #fcs.mob .chip .ord button{width:36px;height:30px;font-size:15px}
  #fcs.mob .two .btn{font-size:13px;padding:12px 4px}#fcs.mob .chip{padding:9px 6px 9px 12px}#fcs.mob .chip .rm{width:34px;height:34px}
  #fcs.mob .sugg button{padding:13px 12px}#fcs.mob .log{font-size:12px}
  /* collapsed on a phone: a small handle on the right edge, drag it up or down */
  #fcs.mob.min.lft{right:auto!important;left:12px!important}
  #fcs.mob.min{left:auto!important;right:6px!important;top:var(--fcs-top,58%)!important;bottom:auto;width:auto;
    border:1px solid var(--line);border-radius:16px;padding-bottom:0;box-shadow:0 8px 24px rgba(0,0,0,.5)}
  #fcs.mob.min .hd{padding:6px 6px 6px 16px;gap:6px;cursor:grab;position:relative}
  #fcs.mob.min .hd::after{content:"";position:absolute;left:6px;top:50%;width:4px;height:18px;margin-top:-9px;border-radius:2px;
    background:repeating-linear-gradient(to bottom,var(--muted) 0 2px,transparent 2px 5px);opacity:.7} /* grip: drag from anywhere */
  #fcs svg{pointer-events:none}
  #fcs .last{min-height:2.8em}
  #fcs.mob.min .hd::before,#fcs.mob.min .brand b,#fcs.mob.min .coins,#fcs.mob.min .pill{display:none}
  #fcs.mob.min .brand{flex:none}
  @media (max-width:375px){
    #fcs .brand b{display:none}
    #fcs .coins{font-size:12px}
    #fcs .pill{padding:2px 6px}
    #fcs.mob .tabs button{font-size:12.5px}
  }
  #fcs.mob.min .logo{width:32px;height:32px;flex:none}
  #fcs.mob.min .go{width:42px;height:36px}#fcs.mob.min .fold{min-width:44px;width:44px;height:36px}
  #fcs.min .jobbar,#fcs.mob.min .tabs{display:none}
  #fcs.mob.min.running .logo{box-shadow:0 0 0 2px var(--green);animation:fcsPulse 1.6s infinite}
  @keyframes fcsPulse{0%,100%{opacity:1}50%{opacity:.55}}`;

  const ui = {
    root: null,
    tab: (() => { const t = store.get(KEYS.ui, {}).tab || 'snipe'; return OLD_TABS[t] || t; })(),

    q(sel) { return this.root.querySelector(sel); },
    qa(sel) { return [...this.root.querySelectorAll(sel)]; },

    mount() {
      if (document.getElementById('fcs')) return;
      const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
      const toast = document.createElement('div'); toast.id = 'fcs-toast'; toast.setAttribute('role', 'status'); document.body.appendChild(toast);
      const root = document.createElement('div'); root.id = 'fcs';
      root.innerHTML = `
        <div class="hd">
          <div class="brand"><span class="logo">FC</span><b>Sniper</b><span class="pill" data-r="pill">Idle</span></div>
          <span class="coins" data-r="coins"></span>
          <button class="go" data-a="toggle" aria-label="Start">${ICON.play}</button>
          <button class="fold" data-a="fold" aria-label="Collapse">${ICON.chevron}</button>
        </div>
        <div class="jobbar" data-r="jobbar" hidden><span data-r="jobname"></span><button class="mini" data-a="job-stop">Stop</button></div>
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
              <p class="note" data-r="budget"></p>
            </div>
            <div class="card setup" data-r="setup"></div>
            <div class="card"><h4>Mode</h4>${FIELDS.mode.map(fieldHtml).join('')}
              <p class="note"><b>Buy</b> snipes under your max, <b>Trade</b> buys under value and relists, <b>Alert</b> only notifies you.</p></div>
            <div class="card picker">
              <h4>Priority list</h4>
              <div class="chips" data-r="chips"></div>
              <div class="pqw"><input data-r="pq" type="search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Add a player — name or ID">
              <div class="sugg" data-r="sugg"></div></div>
              <div class="two"><button class="btn blue" data-a="price">Check prices</button><button class="btn blue" data-a="autofill">🧩 Fill from team needs</button></div>
              <button class="btn" data-a="refresh-prices">↻ Fresh prices (forget old prices, re-check all)</button>
              <div class="spend" data-r="spend"></div>
              ${FIELDS.list.map(fieldHtml).join('')}
              <p class="note">All players are hunted at once; higher on the list wins ties.</p>
              <details class="hint"><summary>More</summary><p class="note">Tap a price to set your own max buy, ↑↓ to reorder. “Fill from team needs” adds snipes for your squad’s weakest spots.</p></details>
            </div>
            <div class="card"><h4>Search filters</h4>
              <div data-r="filters"></div>
              <div data-r="fedit" hidden></div>
              <button class="btn blue" data-a="filter-new">+ Add a search filter</button>
              <button class="btn" data-a="filter-starters">+ Starter filters (gold rare 84–86, big leagues)</button>
              <p class="note">Every filter that’s switched on is hunted together with your priority list.</p>
              <details class="hint"><summary>More</summary><p class="note">Snipe by quality, rarity, league, nation, club, position and rating range. “Price” finds the going rate for the whole filter and sets the max buy under it.</p></details></div>
            <details class="card" data-r="plan-card"><summary><h4 style="display:inline">📋 Session plan</h4></summary>
              <p class="note" data-r="plan-info"></p>
              ${FIELDS.plan.map(fieldHtml).join('')}
              <div data-r="plan-sbcs"></div>
              <button class="btn blue" data-a="plan-start">Start plan</button>
              <p class="note">Snipes in blocks with breaks, and does only the SBCs you add with ＋ Plan in the breaks.</p>
              <details class="hint"><summary>More</summary><p class="note">Breaks make no market calls; each SBC runs while it's solvable and under your coin cap. Your coins never go below the floor shown above. Any captcha, market limit, logout or safety lock ends the plan at once; after a reload it never resumes by itself.</p></details>
            </details>
            <div class="card"><h4>Snipe settings</h4>${FIELDS.snipe.map(fieldHtml).join('')}
              <details class="adv"><summary>Advanced</summary>${FIELDS.snipeAdv.map(fieldHtml).join('')}
                <p class="note">Bid timing and bid wars are in Settings → Auctions &amp; bid wars.</p></details></div>
            <div class="card"><h4>🧠 Smart sniping</h4>
              <div data-r="learn"></div>
              ${FIELDS.smart.map(fieldHtml).join('')}
              <details class="adv"><summary>Advanced</summary>${FIELDS.smartAdv.map(fieldHtml).join('')}</details>
              <button class="btn red" data-a="learn-reset">Forget what it learned</button>
              <p class="note">The bot tries several discounts on priced players and learns which pay off.</p>
              <details class="hint"><summary>More</summary><p class="note">A buy counts most, a card you lost to a faster buyer next, a listing just above your max a little. Players that hit get more of your searches. It stays inside your coins, Keep coins, spend limit and (in Trade) the profitable price, and never searches more often.</p></details></div>
            <div class="card"><h4>This session</h4>
              <div class="stats">
                <div><b data-s="searches">0</b>Searches</div><div><b data-s="buys">0</b>Bought</div><div><b data-s="missed">0</b>Missed</div>
                <div><b data-s="spent">0</b>Spent</div><div><b data-s="listed">0</b>Listed</div><div><b data-s="profit">0</b>Est. profit</div>
              </div>
            </div>
          </section>
          <section class="pane" data-pane="trade">
            <div class="card"><h4>🔥 Hot right now</h4><div data-r="hot"><p class="empty">Scans the live market for cards people are buying and bidding on, then keeps the ones you can flip for profit.</p></div>
              <div class="two"><button class="btn blue" data-a="hot-scan">Find hot cards</button><button class="btn" data-a="refresh-hot">↻ Clear list</button></div>
              <p class="note">Based on what’s listed and being bid on in EA’s market right now.</p>
              <details class="hint"><summary>More</summary><p class="note">About 10 searches plus a price check per card. Trend sites like Futbin block bots, so this is live market data instead.</p></details></div>
            <div class="card"><h4>Resell bot</h4>
              <div class="kpi" data-r="tkpi"></div>
              <div data-r="tplans"></div>
              <button class="btn go-btn" data-a="trade-start">Start trading</button>
              <button class="btn" data-a="upkeep">Check transfer list now</button>
              <p class="note">Buys only low enough to keep your min profit after EA’s 5% tax, then lists a little under market average.</p>
              <details class="hint"><summary>More</summary><p class="note">Works on each player on the Snipe tab. Every few minutes it records sales, clears sold items, relists expired ones, and pauses buying when your transfer list is full. Same safety limits as sniping.</p></details></div>
            <div class="card"><h4>Trade settings</h4>${FIELDS.trade.map(fieldHtml).join('')}</div>
            <div class="card"><h4>Profit calculator</h4>
              <label class="row"><span>Buy for</span><input type="number" inputmode="numeric" data-r="pc-buy" placeholder="e.g. 45000"></label>
              <label class="row"><span>Sell for</span><input type="number" inputmode="numeric" data-r="pc-sell" placeholder="e.g. 50000"></label>
              <p class="note" data-r="pc-out">EA keeps 5% of every sale.</p></div>
            <div class="card"><h4>Hot card settings</h4>${FIELDS.hot.map(fieldHtml).join('')}
              <p class="note">League IDs: 13 Premier League, 53 LaLiga, 19 Bundesliga, 31 Serie A, 16 Ligue 1.</p></div>
          </section>
          <section class="pane" data-pane="squad">
            <div class="card"><h4>Your team</h4><div data-r="team"><p class="empty">Your squad is read automatically when the panel opens (no market searches).</p></div>
              <div class="two"><button class="btn blue" data-a="team-update">↻ Update my team</button><button class="btn" data-a="analyse">Find upgrades</button></div>
              <button class="btn" data-a="refresh-squad">Clear squad data</button>
              <p class="note">“Update my team” reads your squad in seconds. “Find upgrades” is the slower part: it checks the market and SBCs for your 3 weakest spots.</p></div>
            <div class="card"><h4>⚖️ Compare</h4><div data-r="cmp"><p class="empty">Compares every spot in your XI with the best card you own for it — stats for the position, meta PlayStyles, and whether pros run him. Tap a row to see them side by side.</p></div>
              <button class="btn blue" data-a="compare-team">⚖️ Compare my team</button></div>
            <div data-r="upg"></div>
            <div class="card"><h4>Formation coach</h4><div data-r="forms"><p class="empty">Builds the best XI from your own club for each formation, with what public guides call meta marked 📰.</p></div>
              <button class="btn blue" data-a="forms">Compare formations</button>
              <p class="note">Meta notes come from public FC 27 guides (dated, with sources) and update with the script — not live data. Lineups, ratings and chemistry are from your own club. “Create squad” makes a new squad, so your current one isn’t touched.</p></div>
            <div class="card"><h4>Evolutions</h4><div data-r="evos"><p class="empty">Shows the evolutions you can start and which of your players qualify.</p></div>
              <button class="btn blue" data-a="evo-find">Find evolutions</button></div>
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
            <div class="card" data-r="goal" hidden></div>
            <div class="card plan" data-r="plan" hidden></div>
            <div class="card"><h4>Squad Building Challenges</h4><div data-r="sbc"><p class="empty">Load SBCs to see which ones can be solved from your club.</p></div>
              <div class="two"><button class="btn blue" data-a="sbc-load">Load SBCs</button><button class="btn" data-a="refresh-sbc">↻ Refresh SBCs</button></div>
              <button class="btn blue" data-a="sbc-rank">🧩 Rank SBCs (from your club first)</button></div>
            <div class="card">${FIELDS.sbc.map(fieldHtml).join('')}
              <p class="note">Never uses your active squad, loans, evolutions or (unless allowed) specials and tradeables, and re-checks every player before sending.</p>
              <details class="hint"><summary>More</summary><p class="note">Also never anyone above your max rating. Cheapest fodder first: SBC storage and duplicates, then untradeables. When your club can’t complete one, it adds the cheapest market fill-ins (never cards you own) and shows the cost before buying. Chemistry, league/nation/club and “from league X” requirements are solved with players in the right positions. 💎 points SBCs (a points bar instead of a squad): Estimate shows what your spare cards cover and what the rest would cost, then hands them in 20 at a time.</p></details></div>
          </section>
          <section class="pane" data-pane="history">
            <div class="card profit" data-r="profit"></div>
            <div class="card"><h4>Totals</h4><div class="stats" data-r="totals"></div></div>
            <div class="card"><h4>Recent buys</h4><div class="hist" data-r="hist"></div>
              <button class="btn red" data-a="clear-history">Clear history</button></div>
          </section>
          <section class="pane" data-pane="log">
            <div class="card"><h4>Activity</h4>
              <div class="copybox" data-r="copybox" hidden><p class="note">Select all and copy this text, then paste it in the chat.</p><textarea readonly rows="6" data-r="copytext"></textarea><button class="btn" data-a="copy-close">Close</button></div>
              <div class="two"><button class="btn" data-a="copy-log">Copy log (new since last copy)</button><button class="btn" data-a="copy-log-full">Copy full log</button></div>
              <button class="btn blue" data-a="ask-claude">Ask Claude (copies the log, opens claude.ai)</button>
              <div class="log" data-r="log" style="margin-top:8px"></div></div>
            <details class="card"><summary>Diagnostics</summary>
              <button class="btn" data-a="reload-app">Reload the Web App</button>
              <button class="btn" data-a="gallery-probe">Gallery check (read-only)</button>
              <button class="btn" data-a="record-search">Record my next 3 market searches (read-only)</button>
              <button class="btn red" data-a="clear-log">Clear log</button></details>
          </section>
          <section class="pane" data-pane="settings">
            <div class="card"><h4>Targets & filters</h4>${FIELDS.filters.map(fieldHtml).join('')}
              <p class="note">Players match every version of the card. Use Min rating to target one version.</p></div>
            <div class="card"><h4>After buying</h4>${FIELDS.sell.map(fieldHtml).join('')}
              <p class="note">Min profit and listing time are on the Trade tab. EA keeps 5% of every sale; profit shown is after tax.</p></div>
            <div class="card"><h4>Auctions &amp; bid wars</h4>${FIELDS.bids.map(fieldHtml).join('')}
              <p class="note">Bidding on auctions ending soon is switched on with “Also bid…” on the Snipe tab.</p></div>
            <div class="card"><h4>Safety limits</h4>${FIELDS.safety.map(fieldHtml).join('')}
              <p class="note">Minimums are enforced. A captcha locks the bot for 3 h, a market limit for 24 h.</p>
              <p class="note" data-r="lock"></p></div>
            <div class="card"><h4>Backup</h4>
              <p class="note" style="margin:0 0 6px">Saves your players, filters, history, settings and log as text, to restore here if Safari data is cleared.</p>
              <div class="two"><button class="btn blue" data-a="backup">Backup (copy)</button><button class="btn" data-a="restore">Restore (paste)</button></div>
              <button class="btn red" data-a="reset-defaults">Reset settings to defaults (keeps players, filters, history)</button></div>
            <div class="card"><h4>Look & notifications</h4>${FIELDS.notify.map(fieldHtml).join('')}
              <button class="btn" data-a="discord-test">Send test notification</button></div>
          </section>
        </div>`;
      document.body.appendChild(root);
      this.root = root;

      if (isMobile()) root.classList.add('mob', 'min');
      root.classList.toggle('orange', engine.cfg.theme === 'orange');
      this.bind();
      this.mountPicker();
      this.showTab(this.tab);
      this.renderPlayers(); this.renderStats(); this.renderHistory(); this.renderStatus(); this.renderTrade();
      plan.recover(); this.renderPlan();
      this.renderUpgrades();
      setTimeout(() => { upgrades.updateTeam(true); }, 4000); // 2.5.0: read the squad by itself (one request, no market)
      setInterval(() => this.tick(), 500);

      // previous log, so it survives reloads
      this.saved = store.get(KEYS.log, []);
      this.saved.forEach(([at, cls, msg]) => this.log(msg, cls, at, true));
      w.addEventListener('pagehide', () => { if (this.saved) store.set(KEYS.log, this.saved); store.set(KEYS.debug, debugLog.slice(-200)); });
      this.log(isMobile() ? 'Ready — tap ▶ to start' : 'Ready — Alt+S to start/stop', 'muted');
      const gate = engine.gate();
      if (!gate.ok) this.log(`Locked — ${gate.reason}`, 'err');
    },

    bind() {
      const root = this.root;
      root.addEventListener('click', (e) => {
        if (root.classList.contains('min') && e.target.closest('.logo')) { root.classList.remove('min'); return; }
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
          case 'fold': root.classList.toggle('min'); return this.placeHandle();
          case 'price': return engine.checkPricesNow();
          case 'filter-new': if (!engine.running) this.editFilter(-1); return;
          case 'filter-starters': if (!engine.running) this.addStarterFilters(); return;
          case 'filter-cancel': return this.editFilter(null);
          case 'filter-save': return this.saveFilter();
          case 'filter-del': {
            const i = Number(btn.dataset.i);
            if (engine.running || !w.confirm(`Delete “${engine.cfg.filters[i].name}”?`)) return;
            engine.cfg.filters = engine.cfg.filters.filter((_, k) => k !== i);
            engine.save(); this.editFilter(null); return this.renderFilters();
          }
          case 'filter-price': {
            const f = engine.cfg.filters[Number(btn.dataset.i)];
            this.editFilter(null);
            if (!f || engine.running || engine.busy || jobs.current) return;
            engine.busy = true; this.setBusy(true);
            return engine.priceCheck([f]).catch((e) => this.log(`Price check error: ${errText(e)}`, 'err')).finally(() => {
              engine.save(); engine.busy = false; this.setBusy(false); engine.setStatus('idle', 'Idle'); this.renderFilters();
            });
          }
          case 'evo-find': return evos.find();
          case 'evo-preview': return evos.preview(Number(btn.dataset.i));
          case 'evo-open': this.evoOpen = this.evoOpen === Number(btn.dataset.i) ? -1 : Number(btn.dataset.i); return this.renderEvos();
          case 'analyse': return upgrades.analyse();
          case 'compare-team':
            if (engine.running || jobs.current) { this.log('Stop the running task first (■)', 'warn'); return; }
            return upgrades.compareTeam();
          case 'compare-open': { this.cmpOpen = this.cmpOpen === Number(btn.dataset.i) ? -1 : Number(btn.dataset.i); return this.renderCompare(); }
          case 'team-update':
            if (engine.running || jobs.current) { this.log('Stop the running task first (■)', 'warn'); return; }
            return upgrades.updateTeam(false);
          case 'autofill': this.commit(); return upgrades.autofill();
          case 'spend-reset':
            engine.cfg.listSpent = 0; engine.save(); this.renderPlayers();
            return this.log('Spend counter reset', 'muted');
          case 'hot-scan': return hot.scan(false);
          case 'hot-add': return hot.add(hot.list[Number(btn.dataset.i)]);
          case 'snipe-add': return hot.addSnipe(Number(btn.dataset.i));
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
          case 'copy-log': return this.copyLog(false);
          case 'copy-log-full': return this.copyLog(true);
          case 'copy-close': return this.showCopyBox(null);
          case 'job-stop': return jobs.cancel();
          case 'refresh-sbc': {
            if (jobs.current || engine.running) { this.log('Stop the running task first (Stop in the top bar)', 'warn'); return; }
            Object.assign(sbc, { sets: [], open: new Map(), club: null, raw: null, guard: null, plan: null, points: null });
            this.renderSbc();
            this.log('↻ SBCs refreshed — loading them fresh', 'muted');
            return sbc.loadSets();
          }
          case 'refresh-squad': {
            if (jobs.current || engine.running) { this.log('Stop the running task first (Stop in the top bar)', 'warn'); return; }
            Object.assign(upgrades, { squad: null, summary: null, results: [], formations: [], sbcCache: null, ladderCache: null, costed: 0 });
            evos.list = [];
            this.formOpen = -1;
            this.renderUpgrades(); this.renderFormations(); if (this.renderEvos) this.renderEvos();
            this.q('[data-r=team]').innerHTML = '';
            this.log('↻ Squad tools refreshed — tap Analyse or Compare formations to start clean', 'muted');
            return;
          }
          case 'refresh-prices': {
            if (jobs.current || engine.running) { this.log('Stop the bot first (■)', 'warn'); return; }
            engine.cfg.players.forEach((p) => { delete p.checkedAt; delete p.outOfReach; delete p.avg; delete p.lowest; delete p.maxBuy; });
            (engine.cfg.filters || []).forEach((f) => { delete f.checkedAt; delete f.avg; delete f.maxBuy; });
            engine.save(); this.renderPlayers(); this.renderFilters();
            this.log('↻ Old prices forgotten — checking every player and filter again', 'muted');
            return engine.checkPricesNow();
          }
          case 'refresh-hot': hot.list = []; hot.snipeList = []; hot.scannedAt = 0; { const box = this.q('[data-r=hot]'); if (box) box.innerHTML = ''; } this.log('↻ Hot-card list cleared', 'muted'); return;
          case 'reset-defaults': {
            if (engine.running || jobs.current) { this.log('Stop the bot before resetting settings', 'warn'); return; }
            if (!w.confirm('Reset all settings to defaults? Your players, filters, history and the learning stay.')) return;
            store.set('fc-sniper:config-before-reset', engine.cfg);
            const keep = { players: engine.cfg.players, filters: engine.cfg.filters, listSpent: engine.cfg.listSpent };
            engine.cfg = clampConfig(migrateConfig({ ...DEFAULT_CONFIG, ...keep })).cfg;
            engine.save(); this.syncForm(); this.renderPlayers(); this.renderTrade(); this.renderStatus();
            this.log('Settings reset to defaults (previous settings saved — Restore can bring a backup back)', 'ok');
            return;
          }
          case 'ask-claude': return this.askClaude();
          case 'reload-app':
            if (engine.running || jobs.current) { this.log('Stop the bot or the running task before reloading', 'warn'); return; }
            if (w.confirm('Reload the Web App? Your settings, lists and log are kept.')) { if (this.saved) store.set(KEYS.log, this.saved); w.location.reload(); }
            return;
          case 'gallery-probe': return this.galleryProbe();
          case 'record-search': {
            if (fut.recording) { this.log('Already recording — do your searches in the Web App', 'muted'); return; }
            const ok = fut.recordSearches(3, 180000, (lines) => {
              lines.forEach((l) => debugLog.push(`web app search: ${l}`));
              this.log(lines.length ? `🔍 Recorded ${lines.filter((l) => l.startsWith('page')).length} Web App search(es) — tap Copy log and send it` : '🔍 No Web App search seen in 3 minutes — recording stopped', lines.length ? 'ok' : 'warn');
            });
            this.log(ok ? '🔍 Recording for 3 minutes: search the Transfer Market by hand now (e.g. Quality Gold, Rarity Rare). Nothing is bought or changed.' : 'Web App not ready — log in first', ok ? 'ok' : 'err');
            return;
          }
          case 'learn-reset': if (w.confirm('Forget everything smart sniping learned?')) { learn.reset(); this.renderLearn(); this.log('Smart sniping: memory cleared', 'muted'); } return;
          case 'clear-log':
            if (!w.confirm('Clear the activity log?')) return;
            this.saved = []; store.set(KEYS.log, []); this.q('[data-r=log]').innerHTML = ''; return;
          case 'backup': return this.backup();
          case 'restore': return this.restore();
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
          case 'sbc-rank': return sbc.rank();
          case 'plan-start':
            if (!plan.active) return plan.start();
            plan.cancel();
            if (jobs.current) jobs.cancel(); else if (engine.running) engine.stop('stopped by you');
            return;
          case 'setup-fix': {
            const it = (this.setupItems || [])[Number(btn.dataset.i)];
            if (!it || !it.fix || engine.running || plan.active || jobs.current) { if (it && it.fix) this.log('Stop the bot / plan first, then tap the fix', 'warn'); return; }
            if (it.fix.type === 'update') { w.open('https://raw.githubusercontent.com/znxgio/Darkroom/claude/ea-fc-sniping-bot-jdz6vq/fc-sniper/fc-sniper.user.js', '_blank'); return; }
            if (it.fix.type === 'keep') engine.cfg.minCoins = it.fix.value;
            if (it.fix.type === 'bid') engine.cfg.bidSnipe = true;
            engine.save(); this.syncForm(); this.renderSetup();
            this.log(`✅ ${it.fix.type === 'keep' ? `Keep coins set to ${fmt(it.fix.value)}` : 'Auction bidding turned on'}`, 'ok');
            return;
          }
          case 'advice-fix': {
            const a = (this.adviceItems || [])[Number(btn.dataset.i)];
            if (!a || !a.fix || engine.running || plan.active || jobs.current) { if (a && a.fix) this.log('Stop the bot / plan first, then apply', 'warn'); return; }
            const f = a.fix;
            if (f.type === 'max') { engine.cfg.players = engine.cfg.players.map((p) => (p.id === f.id ? { ...p, manualMax: f.value } : p)); this.log(`✅ ${f.label}: ${fmt(f.value)}`, 'ok'); }
            if (f.type === 'bid') { engine.cfg.bidSnipe = true; this.log('✅ Auction bidding turned on', 'ok'); }
            if (f.type === 'drop') { engine.cfg.players = engine.cfg.players.filter((p) => p.id !== f.id); this.log(`✅ ${f.label}`, 'ok'); }
            engine.lastAdvice = (engine.lastAdvice || []).filter((x) => x !== a);
            engine.save(); this.syncForm(); this.renderPlayers(); this.renderSetup();
            return;
          }
          case 'goal-cancel':
            if (engine.running) { this.log('Stop the bot first (■), then cancel the goal', 'warn'); return; }
            if (engine.cfg.goal && engine.cfg.goal.prevMode) engine.cfg.mode = engine.cfg.goal.prevMode;
            engine.cfg.goal = null; engine.save(); this.syncForm(); this.renderGoal(); this.log('🎯 Coin goal cancelled', 'muted'); return;
          case 'goal-start': {
            if (engine.running || jobs.current || plan.active || !sbc.short || sbc.short.cost <= freeCoins(engine.cfg, fut.coins(), [])) return;
            const goal = coinGoal(sbc.short.cost, engine.cfg.minCoins, engine.cfg.goalBufferPct);
            this.commit();
            engine.cfg = { ...engine.cfg, mode: 'trade', goal: { coins: goal, label: sbc.short.name, prevMode: engine.cfg.mode } };
            engine.save(); this.syncForm(); this.renderGoal();
            this.log(`🎯 Trading toward ${fmt(goal)} for ${sbc.short.name} — it stops by itself when you have it`, 'ok');
            this.showTab('trade');
            return hot.scan(true).then((ok) => {
              if (ok && !jobs.cancelled && engine.cfg.goal) engine.start();
              else if (!jobs.cancelled) this.log('No profitable hot cards found right now — the goal stays; try 🎯 again later', 'warn');
            });
          }
          case 'plan-sbc': {
            const set = sbc.sets[Number(btn.dataset.i)];
            if (!set || plan.active) return;
            const list = engine.cfg.planSbcs || [];
            const has = list.some((x) => String(x.id) === String(set.id));
            engine.cfg.planSbcs = has ? list.filter((x) => String(x.id) !== String(set.id)) : [...list, { id: set.id, name: set.name }];
            engine.save(); this.renderSbc(); this.renderPlan();
            this.log(has ? `📋 ${set.name} taken off the plan` : `📋 ${set.name} added to the plan (only repeatable, cheap SBCs make sense)`, 'muted');
            return;
          }
          case 'plan-sbc-rm': {
            if (plan.active) return;
            engine.cfg.planSbcs = (engine.cfg.planSbcs || []).filter((x) => String(x.id) !== btn.dataset.id);
            engine.save(); this.renderPlan(); if (sbc.sets.length) this.renderSbc();
            return;
          }
          case 'sbc-set': return sbc.loadChallenges(sbc.sets[Number(btn.dataset.i)]);
          case 'sbc-solve': {
            const set = sbc.sets[Number(btn.dataset.i)];
            return set && sbc.solve(set, sbc.open.get(set.id)[Number(btn.dataset.j)]);
          }
          case 'sbc-points': {
            const set = sbc.sets[Number(btn.dataset.i)];
            return set && sbc.estimatePoints(set, sbc.open.get(set.id)[Number(btn.dataset.j)]);
          }
          case 'sbc-probe': {
            const set = sbc.sets[Number(btn.dataset.i)];
            return set && sbc.probe(set, sbc.open.get(set.id)[Number(btn.dataset.j)]);
          }
          case 'sbc-submit': return sbc.submit(false);
          case 'sbc-fill': return sbc.submit(true);
          case 'sbc-discard': sbc.plan = null; return this.renderSbc();
          case 'sbc-points-close': sbc.points = null; return this.renderSbc();
          case 'sbc-points-go': return sbc.handInPoints();
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
      root.addEventListener('input', (e) => {
        if (!e.target.closest('[data-r=pc-buy], [data-r=pc-sell]')) return;
        const b = Number(this.q('[data-r=pc-buy]').value) || 0;
        const sl = Number(this.q('[data-r=pc-sell]').value) || 0;
        const out = this.q('[data-r=pc-out]');
        if (!b && !sl) { out.textContent = 'EA keeps 5% of every sale.'; return; }
        const parts = [];
        if (sl) parts.push(`You get ${fmt(afterTax(sl))} after tax`);
        if (b && sl) { const pr = profit(b, sl); parts.push(`<b class="${pr >= 0 ? 'up' : 'down'}">${pr >= 0 ? '+' : ''}${fmt(pr)} profit</b> (${((pr / b) * 100).toFixed(1)}%)`); }
        if (b) parts.push(`break-even: sell for ${fmt(breakEvenSell(b, 1))}`);
        out.innerHTML = parts.join(' · ');
      });
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

    /**
     * Phone: drag the collapsed handle up/down, and across to snap it to the left or right edge (2.5.0: from anywhere
     * on the handle, buttons included). Under 8 px of movement it's a tap (the button works as usual); a real drag
     * swallows the click that follows, so a wobble on ▶ never starts the bot.
     */
    dragHandle(e, handle) {
      const id = e.pointerId; const root = this.root;
      const startTop = root.getBoundingClientRect().top;
      const sx = e.clientX; const sy = e.clientY;
      const h = root.offsetHeight;
      let top = startTop; let x = sx; let dragging = false;
      const move = (ev) => {
        if (ev.pointerId !== id) return;
        if (!dragging) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return; // still a tap
          dragging = true;
          try { handle.setPointerCapture(id); } catch { /* older Safari */ }
        }
        top = Math.min(this.viewH() - h - 8, Math.max(8, startTop + ev.clientY - sy));
        x = ev.clientX;
        root.style.setProperty('--fcs-top', `${top}px`);
        root.style.transform = `translateX(${Math.round(ev.clientX - sx)}px)`;
      };
      const end = (ev) => {
        if (ev.pointerId !== id) return;
        removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end);
        root.style.transform = '';
        if (!dragging) return;
        this.dragEndAt = Date.now();
        const left = Math.abs(x - sx) > 30 ? x < w.innerWidth / 2 : root.classList.contains('lft');
        root.classList.toggle('lft', left);
        store.set(KEYS.ui, { ...store.get(KEYS.ui, {}), handleTop: Math.round(top), handleLeft: left });
      };
      addEventListener('pointermove', move); addEventListener('pointerup', end); addEventListener('pointercancel', end);
    },

    /** Visible height (Safari's toolbar changes it). */
    viewH() { return (w.visualViewport && w.visualViewport.height) || w.innerHeight; },

    /** Keep the collapsed handle on screen after a reload, a rotation or Safari's toolbar showing. */
    placeHandle() {
      const u = store.get(KEYS.ui, {});
      if (u.handleTop == null || !this.root) return;
      const h = this.root.classList.contains('min') ? this.root.offsetHeight || 50 : 50;
      const top = Math.min(this.viewH() - h - 8, Math.max(8, u.handleTop));
      this.root.style.setProperty('--fcs-top', `${Math.round(top)}px`);
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
      this.root.classList.toggle('orange', cfg.theme === 'orange');
      this.renderStatus();
      this.renderPlan();
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

      // 2.4.10: the name list only has each player's base card — look on the market for the other versions
      // (Future Stars, TOTW…) and let the user pick the exact card. One normal market search, under the usual limits.
      let versions = null;
      // pictures load quietly; a missing one falls back to the base card's picture, then disappears
      const loadPics = () => sugg.querySelectorAll('img[data-src]').forEach((img) => {
        const alt = img.dataset.alt;
        img.addEventListener('error', () => {
          if (alt && img.src !== alt) { img.src = alt; return; }
          if (img.dataset.ini) { const ph = document.createElement('span'); ph.className = 'ph'; ph.textContent = img.dataset.ini; img.replaceWith(ph); } else img.remove();
        });
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
      });
      const chooseVersion = async (p) => {
        if (!fut.ready() || engine.running || engine.busy || jobs.current) return add(p);
        input.value = '';
        sugg.innerHTML = `<div class="msg">Looking for ${esc(p.name)}'s cards on the market…</div>`;
        let found = [];
        await jobs.run('Finding card versions', async () => {
          const c = fut.newCriteria();
          c.maskedDefId = baseId(p.id);
          const r = await fut.search(c);
          engine.countUsage('searches');
          jobs.check(r, 'finding card versions');
          found = cardVersions(r.listings, baseId(p.id));
        });
        if (!found.length) { this.log(`${p.name}: no cards listed right now — added the base card (type a card ID to pick another version)`, 'muted'); return add(p); }
        if (found.length === 1 && found[0].defId === p.id) return add(p);
        const rar = Object.fromEntries(fut.rarityOptions().map((o) => [o.v, o.l]));
        versions = found.map((v) => {
          const label = rar[String(v.rareflag)] || (v.rareflag > 1 ? 'Special' : v.rareflag ? 'Rare' : 'Common');
          return { id: v.defId, label, rareflag: v.rareflag, name: `${p.name}${v.defId === p.id ? '' : ` (${label})`}`, rating: v.rating, cheapest: v.cheapest };
        });
        const initials = esc(p.name.split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase());
        sugg.innerHTML = `<div class="msg">Which ${esc(p.name)} card? Tap one to hunt it.</div><div class="vcards">${versions.map((v, i) => {
          const pic = playerDb.portrait(v.id);
          return `<button class="vcard ${v.rareflag > 1 ? 'special' : v.rareflag ? 'rare' : ''}" data-ver="${i}">
            <span class="ovr">${v.rating || '?'}</span>
            ${pic ? `<img alt="" data-src="${esc(pic)}" data-alt="${esc(playerDb.portrait(baseId(v.id)))}" data-ini="${initials}">` : `<span class="ph">${initials}</span>`}
            <span class="vn">${esc(v.label)}</span>
            <span class="vp">${v.cheapest ? `from ${fmt(v.cheapest)}` : 'listed'}</span></button>`;
        }).join('')}</div>`;
        loadPics();
      };

      const add = (p) => {
        input.value = ''; sugg.innerHTML = ''; versions = null;
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
          ? results.map((p, i) => `<button class="who" data-pick="${i}">${playerDb.portrait(p.id) ? `<img class="face" alt="" data-src="${esc(playerDb.portrait(p.id))}">` : ''}<span>${esc(p.name)}${p.full && p.full !== p.name ? `<br><small>${esc(p.full)}</small>` : ''}</span><b>${p.rating || ''}</b></button>`).join('')
          : '<div class="msg">No players found</div>';
        loadPics();
      };

      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(show, 160); });
      input.addEventListener('focus', () => { playerDb.load().catch(() => {}); });
      input.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape') { sugg.innerHTML = ''; return; }
        if (e.key !== 'Enter' || !input.value.trim()) return;
        e.preventDefault();
        clearTimeout(timer);
        await show(); // Enter may come before the suggestions have loaded
        if (results[0] && sugg.querySelector('[data-pick]')) { if (/^#\d+$/.test(results[0].name)) add(results[0]); else chooseVersion(results[0]); }
      });
      this.root.addEventListener('click', (e) => {
        const pick = e.target.closest('[data-pick]');
        if (pick) { const p = results[Number(pick.dataset.pick)]; return /^#\d+$/.test(p.name) ? add(p) : chooseVersion(p); }
        const ver = e.target.closest('[data-ver]');
        if (ver && versions) return add(versions[Number(ver.dataset.ver)]);
        const rm = e.target.closest('[data-rm]');
        if (rm && !engine.running) {
          engine.cfg.players = engine.cfg.players.filter((p) => p.id !== Number(rm.dataset.rm));
          engine.save(); this.renderPlayers();
          return;
        }
        const fon = e.target.closest('[data-fon]');
        if (fon && !engine.running) {
          const f = engine.cfg.filters[Number(fon.dataset.fon)];
          f.on = !f.on; engine.save(); this.renderFilters(); return;
        }
        const fedit = e.target.closest('[data-fedit]');
        if (fedit && !engine.running) return this.editFilter(Number(fedit.dataset.fedit));
        const fmax = e.target.closest('[data-fmax]');
        if (fmax && !engine.running) {
          const f = engine.cfg.filters[Number(fmax.dataset.fmax)];
          const v = w.prompt(`Max buy for “${f.name}”.${f.avg ? ` Going rate is ${fmt(f.avg)}.` : ''}\nLeave empty to use the price check.`, f.manualMax || '');
          if (v === null) return;
          const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
          f.manualMax = n >= MIN_PRICE ? roundPrice(n) : 0;
          engine.save(); this.renderFilters(); return;
        }
        const up = e.target.closest('[data-up]');
        const down = e.target.closest('[data-down]');
        if ((up || down) && !engine.running) {
          const i = Number((up || down).dataset[up ? 'up' : 'down']);
          const j = up ? i - 1 : i + 1;
          const list = engine.cfg.players.slice();
          if (j < 0 || j >= list.length) return;
          [list[i], list[j]] = [list[j], list[i]];
          engine.cfg.players = list;
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

    renderFilters() {
      const box = this.q('[data-r=filters]');
      if (!box) return;
      const rar = new Map(fut.ready() ? fut.rarityOptions().map((o) => [o.v, o.l]) : []);
      const list = engine.cfg.filters || [];
      box.innerHTML = list.length ? list.map((f, i) => {
        const max = f.manualMax || f.maxBuy || engine.cfg.maxBuy;
        const names = { rarity: rar.get(String(f.rarity)), league: f.league ? fut.leagueName(f.league) : '' };
        return `<div class="frow${f.on ? '' : ' off'}"><button class="sw${f.on ? ' on' : ''}" data-fon="${i}" aria-label="On/off"></button>
          <span class="t"><b>${esc(f.name || 'Filter')}</b>${(() => { const sm = filterSummary(f, names); const sub = [sm !== f.name ? esc(sm) : '', f.avg ? `avg ${fmt(f.avg)}` : ''].filter(Boolean).join(' · '); return sub ? `<small>${sub}</small>` : ''; })()}</span>
          <button class="mx${f.manualMax ? ' manual' : ''}" data-fmax="${i}">≤ ${fmt(max)}</button>
          <button class="mini" data-fedit="${i}">Edit</button></div>`;
      }).join('') : '<p class="empty">No search filters yet</p>';
    },

    /** Inline editor for a search filter (new or existing). */
    editFilter(i) {
      const box = this.q('[data-r=fedit]');
      if (i === null) { box.hidden = true; box.innerHTML = ''; return; }
      const f = i >= 0 ? engine.cfg.filters[i] : { name: '', level: 'gold', rarity: '1', position: '', league: '', nation: '', club: '', minRating: 0, maxRating: 0, manualMax: 0, on: true };
      const rar = fut.ready() ? fut.rarityOptions() : [{ v: '1', l: 'Rare' }, { v: '0', l: 'Common' }];
      const opt = (list, v) => list.map((o) => `<option value="${esc(o.v)}" ${String(v ?? '') === String(o.v) ? 'selected' : ''}>${esc(o.l)}</option>`).join('');
      const leagues = [{ v: '', l: 'Any league' }, ...Object.keys(LEAGUES).map((id) => ({ v: id, l: fut.ready() ? fut.leagueName(id) : LEAGUES[id] }))];
      if (f.league && !LEAGUES[f.league]) leagues.push({ v: String(f.league), l: `League ${f.league}` });
      box.hidden = false;
      box.innerHTML = `<div class="fed" data-fi="${i}">
        <label class="row"><span>Name</span><input data-ff="name" value="${esc(f.name)}" placeholder="e.g. 84–86 PL golds"></label>
        <label class="row"><span>Quality</span><select data-ff="level">${opt(OPT([['any', 'Any'], ['gold', 'Gold'], ['silver', 'Silver'], ['bronze', 'Bronze']]), f.level)}</select></label>
        <label class="row"><span>Rarity</span><select data-ff="rarity">${opt([{ v: '', l: 'Any rarity' }, ...rar], f.rarity)}</select></label>
        <label class="row"><span>League</span><select data-ff="league">${opt(leagues, f.league)}</select></label>
        <label class="row"><span>Position</span><select data-ff="position">${opt(POSITIONS, f.position)}</select></label>
        <label class="row"><span>Rating from</span><input type="number" inputmode="numeric" data-ff="minRating" value="${f.minRating || ''}" placeholder="e.g. 84"></label>
        <label class="row"><span>Rating to</span><input type="number" inputmode="numeric" data-ff="maxRating" value="${f.maxRating || ''}" placeholder="e.g. 86"></label>
        <label class="row"><span>Nation ID</span><input type="number" inputmode="numeric" data-ff="nation" value="${f.nation || ''}"></label>
        <label class="row"><span>Club ID</span><input type="number" inputmode="numeric" data-ff="club" value="${f.club || ''}"></label>
        <label class="row"><span>Max buy (0 = from Price)</span><input type="number" inputmode="numeric" data-ff="manualMax" value="${f.manualMax || ''}"></label>
        <div class="two"><button class="btn go-btn" data-a="filter-save">Save</button><button class="btn" data-a="filter-cancel">Cancel</button></div>
        ${i >= 0 ? `<div class="two"><button class="btn blue" data-a="filter-price" data-i="${i}">Price this filter</button><button class="btn red" data-a="filter-del" data-i="${i}">Delete</button></div>` : ''}
      </div>`;
    },

    /** Ready-made filters that suit a mid-size budget; added switched OFF so nothing changes until you pick one. */
    addStarterFilters() {
      const presets = [
        { name: 'Gold rare 84–86 · Premier League', league: 13 },
        { name: 'Gold rare 84–86 · LALIGA', league: 53 },
        { name: 'Gold rare 84–86 · Bundesliga', league: 19 },
        { name: 'Gold rare 84–86 · Serie A', league: 31 },
      ];
      const have = new Set((engine.cfg.filters || []).map((f) => f.name));
      const add = presets.filter((p) => !have.has(p.name)).map((p, k) => ({
        kind: 'filter', id: `fs${Date.now().toString(36)}${k}`, on: false, level: 'gold', rarity: '1', league: p.league,
        position: '', nation: '', club: '', minRating: 84, maxRating: 86, manualMax: 0, name: p.name, starter: true,
      }));
      if (!add.length) { this.log('Starter filters are already in your list', 'muted'); return; }
      engine.cfg.filters = [...(engine.cfg.filters || []), ...add];
      engine.save();
      this.renderFilters();
      this.log(`Added ${add.length} starter filters (switched off). Turn one or two on — the bot prices each filter and snipes ${engine.cfg.discount}% under it.`, 'ok');
    },

    saveFilter() {
      const box = this.q('[data-r=fedit] .fed');
      if (!box) return;
      const i = Number(box.dataset.fi);
      const val = (k) => box.querySelector(`[data-ff=${k}]`).value.trim();
      const num = (k) => Number(val(k)) || 0;
      const prev = i >= 0 ? engine.cfg.filters[i] : {};
      const f = {
        ...prev, kind: 'filter', id: prev.id || `f${Date.now().toString(36)}`, on: prev.on ?? true,
        level: val('level'), rarity: val('rarity'), league: num('league') || '', position: val('position'),
        nation: num('nation') || '', club: num('club') || '', minRating: num('minRating'), maxRating: num('maxRating'),
        manualMax: num('manualMax') >= MIN_PRICE ? roundPrice(num('manualMax')) : 0,
      };
      // changed filters need a fresh price
      if (['level', 'rarity', 'league', 'position', 'nation', 'club', 'minRating', 'maxRating'].some((k) => String(prev[k] ?? '') !== String(f[k] ?? ''))) { delete f.avg; delete f.maxBuy; delete f.checkedAt; }
      const rar = new Map(fut.ready() ? fut.rarityOptions().map((o) => [o.v, o.l]) : []);
      f.name = val('name') || filterSummary(f, { rarity: rar.get(String(f.rarity)), league: f.league ? fut.leagueName(f.league) : '' });
      const list = (engine.cfg.filters || []).slice();
      if (i >= 0) list[i] = f; else list.push(f);
      engine.cfg.filters = list;
      engine.save();
      this.editFilter(null);
      this.renderFilters();
      this.log(`Search filter saved: ${f.name}`, 'muted');
    },

    renderPlayers() {
      this.renderFilters();
      const cfg = engine.cfg;
      const sp = this.q('[data-r=spend]');
      if (sp) {
        sp.innerHTML = cfg.spendLimit > 0
          ? `Spent <b>${fmt(cfg.listSpent || 0)}</b> of ${fmt(cfg.spendLimit)} · ${fmt(Math.max(0, cfg.spendLimit - (cfg.listSpent || 0)))} left <button class="mini" data-a="spend-reset">Reset</button>`
          : `Spent <b>${fmt(cfg.listSpent || 0)}</b> on the list${cfg.listSpent ? ' <button class="mini" data-a="spend-reset">Reset</button>' : ''}`;
      }
      this.q('[data-r=chips]').innerHTML = cfg.players.map((p, i) => {
        const max = effectiveMaxBuy(p, cfg);
        const unpriced = !p.manualMax && !p.maxBuy && !p.avg && (max === 0 || cfg.autoPrice);
        const tr = prices.trend(p.id);
        const sub = `${tr.n && !tr.thin ? `${esc(trendText(tr).split(' · seen')[0])} · ` : ''}${p.outOfReach && !p.manualMax ? '⏭️ out of reach · ' : ''}${p.hot ? '🔥 ' : ''}${p.autofill ? `🧩 ${esc(p.autofill)} · ` : ''}${p.manualMax ? (p.autofill && p.lowest ? `cheapest ${fmt(p.lowest)}` : 'your max') : p.avg ? `avg ${fmt(p.avg)}` : p.checkedAt ? 'none listed' : 'not priced yet'}`;
        return `<div class="chip">
          <div class="top"><span class="num">${i + 1}</span><span class="ovr">${p.rating || ''}</span>
            <span class="nm">${esc(p.name)}<small>${sub}</small></span>
            <button class="rm" data-rm="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></div>
          <div class="bot"><span class="ord"><button data-up="${i}" aria-label="Move up" ${i === 0 ? 'disabled class="edge"' : ''}>↑</button><button data-down="${i}" aria-label="Move down" ${i === cfg.players.length - 1 ? 'disabled class="edge"' : ''}>↓</button></span>
            <button class="mx${p.manualMax ? ' manual' : ''}${unpriced ? ' none' : ''}" data-max="${p.id}">${unpriced ? '—' : `≤ ${fmt(max)}`}</button></div></div>`;
      }).join('');
    },

    setJob(name) {
      const go = this.q('[data-a=toggle]');
      const on = !!name || engine.running;
      go.classList.toggle('on', on);
      this.root.classList.toggle('running', on);
      go.innerHTML = on ? ICON.stop : ICON.play;
      go.disabled = false;
      this.qa('[data-a=analyse], [data-a=evo-find], [data-a=evo-preview], [data-a=packs-load], [data-a=pack-open], [data-a=pack-open-all], [data-a=sbc-load], [data-a=sbc-set], [data-a=sbc-solve], [data-a=sbc-submit], [data-a=sbc-fill], [data-a=sbc-points], [data-a=sbc-points-go], [data-a=price]')
        .forEach((b) => { b.disabled = !!name; });
      if (name) engine.setStatus('pricing', `${name}…`);
      // a visible "task running — Stop" bar on every tab
      const bar = this.q('[data-r=jobbar]');
      if (bar) { bar.hidden = !name && !engine.running; this.q('[data-r=jobname]').textContent = name ? `⏳ ${name}…` : engine.running ? '▶ Bot running — stop (■) to change settings' : ''; }
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
        case 'ACADEMY_PLAYER_SLOTTING': return `OVR min ${v}`;
        case 'PLAYER_ATTRIBUTE': return '';
        case 'PLAYER_QUALITY': case 'PLAYER_LEVEL': return `${per}Quality ${sym} ${r.values.map((x) => q[x] || x).join('/')}`;
        case 'PLAYER_RARITY_GROUP': return `${per}Rare ${sym} ${r.count > 0 ? '' : 'all'}`.trim();
        case 'PLAYER_MIN_OVR': return `Each player ≥ ${v}`;
        case 'PLAYER_MAX_OVR': return `Each player ≤ ${v}`;
        case 'PLAYER_EXACT_OVR': return `Each player = ${v}`;
        case 'CHEMISTRY_POINTS': return `Chemistry ${sym} ${v}`;
        case 'ALL_PLAYERS_CHEMISTRY_POINTS': return `Each player chem ${sym} ${v}`;
        case 'SAME_LEAGUE_COUNT': return `Same league ${sym} ${v}`;
        case 'SAME_NATION_COUNT': return `Same nation ${sym} ${v}`;
        case 'SAME_CLUB_COUNT': return `Same club ${sym} ${v}`;
        case 'LEAGUE_COUNT': return `Leagues ${sym} ${v}`;
        case 'NATION_COUNT': return `Nations ${sym} ${v}`;
        case 'CLUB_COUNT': return `Clubs ${sym} ${v}`;
        case 'LEAGUE_ID': return `${per}from league ${v}`;
        case 'NATION_ID': return `${per}from nation ${v}`;
        case 'CLUB_ID': return `${per}from club ${v}`;
        default: return `${per}${r.key.toLowerCase().replace(/_/g, ' ')} ${sym} ${v}`;
      }
    },

    renderSbc() {
      const box = this.q('[data-r=sbc]');
      box.innerHTML = sbc.sets.length ? `<div class="list">${sbc.sets.slice(0, 80).map((set, i) => {
        const loaded = sbc.open.get(set.id);
        const rep = (set.repeatable || set.timesCompleted ? `<span class="tag">${set.timesCompleted || 0} done</span>` : '')
          + ({ club: '<span class="tag ok">✅ from your club</span>', buys: '<span class="tag no">needs buys</span>', points: '<span class="tag">💎 points</span>', manual: '<span class="tag">manual</span>' }[set.likely] || '');
        const sub = loaded ? `<div class="sub">${loaded.length ? loaded.map((e, j) => {
          const ok = !e.parsed.unsupported.length && !e.parsed.points;
          const tagHtml = e.parsed.points ? '<span class="tag">💎 points</span>' : ok ? '<span class="tag ok">auto</span>' : '<span class="tag no">manual</span>';
          return `<div class="li"><span class="t"><b>${esc(e.challenge.name || set.name)}${tagHtml}</b>
            <small>${esc(e.reqs.filter((r) => r.key !== 'SCOPE' && r.key !== 'PLAYER_COUNT').map((r) => this.reqText(r)).filter(Boolean).join(' · ') || `${fut.requiredPlayers(e.challenge)} players`)}${e.parsed.unsupported.length ? ` — needs ${esc(e.parsed.unsupported.join(', '))}` : ''}</small></span>
            ${ok ? `<button class="mini go2" data-a="sbc-solve" data-i="${i}" data-j="${j}">Solve</button>` : e.parsed.points ? `<button class="mini go2" data-a="sbc-points" data-i="${i}" data-j="${j}">Estimate</button><button class="mini" data-a="sbc-probe" data-i="${i}" data-j="${j}">Details</button>` : ''}</div>`;
        }).join('') : '<p class="empty">All done</p>'}</div>` : '';
        return `<div class="li"><span class="t"><b>${esc(set.name)}${rep}</b><small>${esc(set.description || '')}</small></span>
          ${loaded ? '' : `<button class="mini" data-a="sbc-set" data-i="${i}">View</button>`}<button class="mini" data-a="plan-sbc" data-i="${i}">${(engine.cfg.planSbcs || []).some((x) => String(x.id) === String(set.id)) ? '✓ Plan' : '＋ Plan'}</button></div>${sub}`;
      }).join('')}</div>` : '<p class="empty">Load SBCs to see which ones can be solved from your club.</p>';

      this.renderGoal();
      const plan = this.q('[data-r=plan]');
      const p = sbc.plan;
      const pt = sbc.points;
      plan.hidden = !p && !pt;
      if (!p && pt) {
        const best = pt.best;
        const coins = pt.plan.buyCoins + pt.extra;
        plan.innerHTML = `<h4>💎 Estimate — ${esc(pt.entry.challenge.name)}</h4>
          <div class="kpi"><div><b>${fmt(pt.need)}</b>💎 needed</div><div><b>${fmt(pt.plan.clubPoints)}</b>From your cards</div><div><b>${coins ? fmt(coins) : '0'}</b>Coins to buy rest</div></div>
          <p class="note" style="margin:0 0 6px">${fmt(pt.done)} of ${fmt(pt.goal)} done. Your spare cards (never your squad, specials, loans, or above ${engine.cfg.sbcMaxRating}): <b>${pt.plan.fromClub.length}</b> cards for ${fmt(pt.plan.clubPoints)} 💎.
          ${coins ? `The rest ≈ <b>${fmt(coins)} coins</b>${best ? ` — best value on the market right now: ${best.rating}-rated at ${fmt(best.price)} for ${fmt(best.points)} 💎 (${(best.price / best.points).toFixed(1)} coins per 💎)` : ''}.` : 'Your spare cards cover it — no coins needed.'}
          About ${Math.max(1, Math.ceil((pt.plan.cards + (pt.extra && best ? Math.ceil(pt.plan.short / best.points) : 0)) / 20))} hand-ins of 20.</p>
          <div class="list">${pt.plan.fromClub.slice().sort((a, b) => b.points - a.points).slice(0, 12).map((x) => `<div class="li"><span class="t"><b>${esc(x.name)} ${x.rating}</b></span><b>${fmt(x.points)} 💎</b></div>`).join('')}</div>
          ${(() => {
            const left = Math.max(0, pt.need - pt.plan.clubPoints);
            const lim = engine.cfg.pointsBuyLimit || 0;
            const label = `Hand in ${pt.plan.fromClub.length} card${pt.plan.fromClub.length === 1 ? '' : 's'}${left && lim ? ` + buy up to ${fmt(lim)} coins` : ''}`;
            return (pt.plan.fromClub.length || (left && lim)) ? `<button class="btn" data-a="sbc-points-go" style="background:var(--green);color:var(--green-ink);border-color:var(--green)">${label}</button>` : '';
          })()}
          ${pt.need > pt.plan.clubPoints ? (engine.cfg.pointsBuyLimit > 0
            ? `<p class="note">${fmt(pt.need - pt.plan.clubPoints)} 💎 left after your spare cards — it buys the best 💎-per-coin cards up to ${fmt(engine.cfg.pointsBuyLimit)} coins (SBC tab setting).</p>`
            : `<p class="warn-box" style="border:1px solid var(--amber,#e8a33d);border-radius:10px;padding:8px 10px;margin:6px 0">⚠️ Your spare cards cover ${fmt(pt.plan.clubPoints)} of ${fmt(pt.need)} 💎. To buy the rest (≈ <b>${fmt(coins)}</b> coins${coins > Math.max(0, fut.coins() - engine.cfg.minCoins) ? ` — <b>more than your ${fmt(Math.max(0, fut.coins() - engine.cfg.minCoins))} spare coins</b>` : ''}), set <b>“Max coins to buy for 💎 SBCs”</b> in the SBC settings below.</p>`) : ''}
          <p class="note">Hands in up to 20 at a time, biggest points first, with your protections re-checked before every batch.</p>
          <button class="btn red" data-a="sbc-points-close">Close</button>`;
        return;
      }
      if (!p) return;
      const tag = (x) => (x.bought ? `<span class="tag ok">bought ${fmt(x.price)}</span>` : x.market ? `<span class="tag no">buy ${fmt(x.price)}</span>` : x.storage ? '<span class="tag">storage</span>' : x.duplicate ? '<span class="tag">duplicate</span>' : x.untradeable ? '<span class="tag">untradeable</span>' : '<span class="tag no">tradeable</span>');
      const slots = p.slots || [];
      const buys = (p.buys || []).filter((x) => !x.bought).length;
      const boughtN = p.solution.players.filter((x) => x.bought).length;
      const chemOn = p.entry.parsed.constraints.needsSearch;
      plan.innerHTML = `<h4>Solution — ${esc(p.set.name)}</h4>
        <p class="note" style="margin:0 0 8px">✓ none from your squad (${sbc.guard ? sbc.guard.itemIds.size : 0} protected) · ✓ all ≤ ${engine.cfg.sbcMaxRating}${engine.cfg.sbcUseSpecials ? '' : ' · ✓ no specials'}${engine.cfg.sbcUseTradeables ? '' : ' · ✓ untradeables only'}</p>
        <div class="kpi"><div><b>${p.solution.rating || '—'}</b>Rating</div><div><b>${chemOn ? `${p.solution.chem ?? '—'}` : p.solution.players.filter((x) => x.rare).length}</b>${chemOn ? 'Chemistry' : 'Rares'}</div><div><b>${buys ? fmt(p.buyTotal) : '0'}</b>${buys ? `To buy (${buys})` : 'Coins'}</div></div>
        <div class="list">${p.solution.players.map((x, i) => ({ x, pos: slots[i] })).sort((a, b) => (chemOn ? 0 : b.x.rating - a.x.rating)).map(({ x, pos }) => `<div class="li"><span class="t"><b>${chemOn && pos ? `${esc(pos)} · ` : ''}${esc(x.name)}${tag(x)}</b></span><b>${x.rating}</b></div>`).join('')}</div>
        ${boughtN ? `<p class="note" style="margin:6px 0 0">${boughtN} already bought for this SBC — ${buys ? `only ${buys} left to buy` : 'nothing left to buy'}.</p>` : ''}
        <button class="btn" data-a="sbc-submit" style="background:var(--green);color:var(--green-ink);border-color:var(--green)">${buys ? `Buy ${buys}${boughtN ? ' more' : ''} for ${fmt(p.buyTotal)} & submit` : 'Submit'}${engine.cfg.sbcRepeat > 1 ? ` (up to ${engine.cfg.sbcRepeat}×)` : ''}</button>
        <button class="btn" data-a="sbc-fill">${buys ? `Buy ${buys} & fill squad only` : 'Fill squad only (check it in the Web App)'}</button>
        <button class="btn red" data-a="sbc-discard">Discard</button>`;
    },

    renderHot() {
      const box = this.q('[data-r=hot]');
      if (!box || !(hot.list.length || hot.snipeList.length)) return;
      const mine = new Set(engine.cfg.players.map((p) => p.id));
      const ago = Math.round((Date.now() - hot.scannedAt) / 60e3);
      const snipeHtml = hot.snipeList.length ? `<h4 style="margin:10px 0 4px">🎯 Snipe-friendly</h4><div class="list">${hot.snipeList.map((c, i) => `<div class="li">
          <span class="t"><b>${esc(c.name)} ${c.rating || ''}</b>
          <small>cheapest ${fmt(c.minBin)} · spread ${Math.round(c.spread * 100)}% · ${esc(c.reason)} · try ${c.suggest}% under</small></span>
          ${mine.has(c.id) ? '<span class="tag ok">added</span>' : `<button class="mini" data-a="snipe-add" data-i="${i}">Snipe it</button>`}</div>`).join('')}</div>` : '';
      box.innerHTML = `<div class="list">${hot.list.map((c, i) => `<div class="li">
          <span class="t"><b>${esc(c.name)} ${c.rating || ''}${c.proven ? ` <span class="tag ok">flipped ${c.proven.wins}×</span>` : ''}${c.bids ? ` <span class="tag ok">${c.bids} bid${c.bids === 1 ? '' : 's'}</span>` : ''}</b>
          <small>${c.trend && c.trend.n ? `${esc(trendText(c.trend))}<br>` : ''}${c.listed} listed · avg ${fmt(c.avg)}${c.plan ? ` · buy ≤ ${fmt(c.plan.maxBuy)} → sell ${fmt(c.plan.sell)} <span class="up">+${fmt(c.plan.profit)}</span>` : ' · <span class="down">no profit at your settings</span>'}</small></span>
          <a class="mini" href="${lookupUrl(c.name)}" target="_blank" rel="noopener" title="Look up on FUT.GG">🔎</a>
          ${c.plan ? (mine.has(c.id) ? '<span class="tag ok">added</span>' : `<button class="mini" data-a="hot-add" data-i="${i}">Add</button>`) : ''}</div>`).join('')}</div>
        ${hot.list.some((c) => c.plan) ? `<button class="btn go-btn" data-a="hot-top">Trade the top ${Math.min(engine.cfg.hotPick || 3, hot.list.filter((c) => c.plan).length)}</button>` : ''}
        <p class="note">Scanned ${ago < 1 ? 'just now' : `${ago} min ago`}.</p>${snipeHtml}`;
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

    renderEvos() {
      const box = this.q('[data-r=evos]');
      if (!box) return;
      box.innerHTML = evos.list.length ? `<div class="list">${evos.list.map((e, i) => `
        <div class="li"><span class="t"><b>${esc(e.name)}</b><small>${e.cost} · ${e.players.length ? `${e.players.length} of your players qualify` : 'none of your players qualify'}</small></span>
          ${e.players.length ? `<button class="mini" data-a="evo-open" data-i="${i}">${this.evoOpen === i ? 'Hide' : 'Players'}</button>` : ''}</div>
        ${this.evoOpen === i ? `<div class="sub">${e.players.slice(0, 8).map((p) => `<div class="li"><span class="t"><b>${esc(p.name)} ${p.rating}${p.after && p.after.rating ? ` → <span class="up">${p.after.rating}</span>` : ''}</b>
            <small>${esc(p.positions.join(', '))}${p.untradeable ? ' · untradeable' : ''}</small></span></div>`).join('')}
          <button class="btn" data-a="evo-preview" data-i="${i}">Preview the top 3 (final ratings)</button></div>` : ''}`).join('')}</div>
        <p class="note">Start an evolution in the Web App (Club → Evolutions). The bot only finds the matches.</p>`
        : '<p class="empty">No evolutions available right now.</p>';
    },

    renderFormations() {
      const list = upgrades.formations;
      const names = (arr) => arr.map((p) => `${esc(p.name)} ${p.rating}`).join(', ');
      this.q('[data-r=forms]').innerHTML = list.length ? `<div class="list">${list.map((f, i) => {
        const full = f.filled === 11;
        const best = full && !f.current && list.findIndex((x) => x.filled === 11) === i;
        let sub;
        const metaTxt = engine.cfg.lineupBy === 'meta' && f.meta ? ` · meta ${f.meta}` : '';
        if (f.current) sub = `rating ${f.rating} · chemistry ${f.chem}/33${metaTxt}`;
        else if (!full) sub = `can’t fill: no ${[...new Set(f.missing)].join(', ')} in your club`;
        else {
          const dR = f.rating - list.find((x) => x.current).rating;
          const dC = f.chem - list.find((x) => x.current).chem;
          sub = `rating ${f.rating} (${dR >= 0 ? '+' : ''}${dR}) · chemistry ${f.chem}/33 (${dC >= 0 ? '+' : ''}${dC})${metaTxt} · ${f.ins.length ? `${f.ins.length} change${f.ins.length === 1 ? '' : 's'}` : 'same players'}`;
        }
        const detail = this.formOpen === i ? `<div class="sub">
          ${!f.current && f.ins.length ? `<p class="note" style="margin:4px 0"><span class="up">In:</span> ${names(f.ins)}<br><span class="down">Out:</span> ${names(f.outs) || '—'}</p>` : ''}
          ${f.lineup.map((p, k) => `<div class="li"><span class="t"><b>${esc(f.slots[k])} · ${p ? esc(p.name) : '—'}</b>
          <small>${p ? `${p.rating}${keyStats(p, f.slots[k])}${!f.current && !(upgrades.currentIds || new Set()).has(p.id) ? ' · <span class="up">new in XI</span>' : ''}` : 'nobody fits'}</small></span></div>`).join('')}</div>` : '';
        const mn = !f.current && META_NOTES.formations[f.id];
        const weak = full && f.weak && f.weak.length ? `<br>Weakest: ${f.weak.map((x) => `${esc(x.pos)} ${esc(x.p.name)} ${x.p.rating}`).join(' · ')} <button class="mini" data-a="analyse">Find upgrades</button>` : '';
        const canCreate = !f.current && full && !(FORMATIONS[f.id] && FORMATIONS[f.id].noCreate);
        return `<div class="li"><span class="t"><b>${best ? '⭐ ' : ''}${mn ? '📰 ' : ''}Best XI from your club · ${esc(f.label)}</b><small>${sub}${mn ? `<br>📰 ${esc(mn.tag)} — ${esc(mn.tactic)} <i>(${esc(mn.source)})</i>` : ''}${weak}</small></span>
          <button class="mini" data-a="form-view" data-i="${i}">${this.formOpen === i ? 'Hide' : 'View'}</button>
          ${canCreate ? `<button class="mini go2" data-a="form-create" data-i="${i}">Create squad</button>` : ''}</div>${detail}`;
      }).join('')}</div>
        <p class="note">📰 = called meta by a public guide (meta notes from ${META_NOTES.asOf}${(Date.now() - Date.parse(META_NOTES.asOf)) / 864e5 > 21 ? ' — <span class="down">over 3 weeks old, update the script for fresher notes</span>' : ''}). ${esc(META_NOTES.note)} Ratings and chemistry come from your own club.</p>`
        : '<p class="empty">Builds the best XI from your own club for each formation, with what public guides call meta marked 📰.</p>';
    },

    async backup() {
      const data = { app: 'fc-sniper', version: VERSION, at: new Date().toISOString(),
        config: engine.cfg, history: engine.history, safety: store.get(KEYS.safety, {}), log: (this.saved || []).slice(-150) };
      const text = JSON.stringify(data);
      try { await navigator.clipboard.writeText(text); this.toast('Backup copied — paste it into Notes', 'ok'); this.log(`Backup copied (${Math.round(text.length / 1024)} KB)`, 'ok'); } catch {
        w.prompt('Copy this backup and keep it somewhere safe:', text);
      }
    },

    restore() {
      if (engine.running || jobs.current) { this.log('Stop the bot before restoring', 'warn'); return; }
      const text = w.prompt('Paste your FC Sniper backup:');
      if (!text) return;
      let data;
      try { data = JSON.parse(text.trim()); } catch { this.log('That isn’t a valid backup', 'err'); return; }
      if (!data || data.app !== 'fc-sniper' || !data.config) { this.log('That isn’t an FC Sniper backup', 'err'); return; }
      store.set('fc-sniper:config-before-restore', engine.cfg); // so a wrong paste can be undone
      engine.cfg = clampConfig(migrateConfig({ ...DEFAULT_CONFIG, ...data.config })).cfg;
      engine.save();
      if (Array.isArray(data.history)) { engine.history = data.history; store.set(KEYS.history, engine.history); }
      if (Array.isArray(data.log)) { this.saved = data.log; store.set(KEYS.log, data.log); }
      this.syncForm(); this.renderPlayers(); this.renderHistory(); this.renderTrade(); this.renderStatus();
      this.root.classList.toggle('orange', engine.cfg.theme === 'orange');
      this.log(`Backup from ${data.at ? new Date(data.at).toLocaleString() : 'unknown date'} restored (${engine.cfg.players.length} players, ${(engine.cfg.filters || []).length} filters, ${engine.history.length} history entries)`, 'ok');
    },

    async galleryProbe() {
      await jobs.run('Checking for the Gallery', async () => {
        if (!fut.ready()) { this.log('Web App not ready — log in first', 'err'); return; }
        engine.setStatus('pricing', 'Looking for the Gallery…');
        const r = await fut.galleryProbe();
        r.lines.forEach((l) => debugLog.push(`gallery probe: ${l}`));
        this.log(r.found ? '🖼️ Found Gallery parts in the Web App — details saved. Tap Copy log and send it' : '🖼️ No Gallery found in the Web App — details saved. Tap Copy log and send it anyway', r.found ? 'ok' : 'warn');
      });
    },

    /**
     * Copy log: everything since the last copy (so nothing is sent twice and nothing is lost),
     * then a "📋 Log copied" marker line is added to the log itself. Full: the whole saved log.
     */
    /**
     * Ask Claude: you type a question, the bot copies it with the new log lines,
     * then opens claude.ai — paste and send. No password or API key is stored in the bot.
     */
    async askClaude() {
      const q = w.prompt('What do you want to ask Claude? (the new log lines are added for context)');
      if (q === null) return;
      await this.copyLog(false, `My question: ${q || '(see the log)'}`);
      w.open('https://claude.ai/new', '_blank', 'noopener');
    },

    async copyLog(full, question) {
      const saved = this.saved || store.get(KEYS.log, []);
      const fmtLine = ([at, , msg]) => `${new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })} ${msg}`;
      let from = 0;
      if (!full) for (let k = saved.length - 1; k >= 0; k--) if (/^📋 Log copied/.test(saved[k][2])) { from = k; break; }
      const part = saved.slice(from);
      const head = `FC Sniper ${VERSION} · ${navigator.userAgent}\n${full ? `Full log (${saved.length} lines)` : from ? `Since the last copy (${part.length} lines; earlier lines are in “Copy full log”)` : `Whole log (${part.length} lines)`}`;
      this.log(`📋 Log copied (${VERSION}) — ${part.length} line${part.length === 1 ? '' : 's'} up to here were sent`, 'muted');
      const text = [...(question ? [question, ''] : []), head, ...part.map(fmtLine), fmtLine([Date.now(), '', `📋 Log copied (${VERSION})`]), '--- details ---', ...debugLog.slice(full ? -200 : -80)].join('\n');
      store.set(KEYS.debug, debugLog.slice(-200));
      try { await navigator.clipboard.writeText(text); this.toast('Log copied — paste it in the chat', 'ok'); } catch {
        this.showCopyBox(text);
      }
    },
    showCopyBox(text) {
      const box = this.q('[data-r=copybox]'), ta = this.q('[data-r=copytext]');
      if (!box || !ta) return;
      if (text == null) { box.hidden = true; ta.value = ''; return; }
      this.showTab('log');
      ta.value = text; box.hidden = false;
      try { box.scrollIntoView({ block: 'nearest' }); ta.focus(); ta.select(); ta.setSelectionRange(0, 1e9); } catch { /* ignore */ }
    },

    /** ⚖️ Compare: one row per spot; tap to open the side-by-side table with the score breakdown. */
    renderCompare() {
      const box = this.q('[data-r=cmp]');
      if (!box || !upgrades.compare) return;
      box.innerHTML = `<div class="list">${upgrades.compare.map((x) => {
        const open = this.cmpOpen === x.i && x.cur && x.alt;
        const head = `<div class="li"><span class="t"><b>${esc(x.position)} · ${x.cur ? esc(x.cur.name) : 'empty'}${x.verdict === 'swap' ? ' <span class="tag no">swap?</span>' : x.verdict === 'keep' ? ' <span class="tag ok">keep</span>' : ''}${x.cur && proPick(x.cur, x.position) ? ' <span class="tag">🏆 pro pick</span>' : ''}</b>
          <small>${x.alt ? `best you own: ${esc(x.alt.name)} ${x.alt.rating} · score ${x.altScore} vs ${x.curScore}` : 'nothing else you own plays here'}</small></span>${x.cur && x.alt ? `<button class="mini" data-a="compare-open" data-i="${x.i}">${open ? 'Close' : 'Compare'}</button>` : ''}</div>`;
        if (!open) return head;
        const c = comparePlayers(x.cur, x.alt, x.position);
        const cell = (v, w) => `<td style="text-align:right${w ? ';color:var(--pos);font-weight:700' : ''}">${esc(String(v))}</td>`;
        return head + `<table class="cmp" style="width:100%;font-size:12px;margin:4px 0 8px"><tr><th></th><th style="text-align:right">${esc(x.cur.name)}</th><th style="text-align:right">${esc(x.alt.name)}</th></tr>
          ${c.rows.map((r) => `<tr><td style="color:var(--muted)">${esc(r.label)}</td>${cell(r.a, r.better === 'a')}${cell(r.b, r.better === 'b')}</tr>`).join('')}</table>
          <p class="note">${c.winner ? `${esc(c.winner === 'a' ? x.cur.name : x.alt.name)} scores higher here` : 'About level here'} — ${esc(x.cur.name)}: ${esc(c.a.parts.map((p) => `${p.label} ${p.value}`).join(' + '))} · ${esc(x.alt.name)}: ${esc(c.b.parts.map((p) => `${p.label} ${p.value}`).join(' + '))}</p>`;
      }).join('')}</div>`;
    },

    /** Evolutions your squad can use now (from Find upgrades). */
    evoTeamHtml() {
      const e = upgrades.evoTeam;
      if (!e) return '';
      if (e.error) return `<div class="card"><h4 class="title">🧬 Evolutions</h4><p class="empty">Couldn't load evolutions (${esc(e.error)})</p></div>`;
      if (!e.picks.length) return `<div class="card"><h4 class="title">🧬 Evolutions</h4><p class="empty">None of the ${e.evos} evolutions fit your squad's cards right now.</p></div>`;
      return `<div class="card"><h4 class="title">🧬 Evolutions your squad can use now</h4><div class="list">${e.picks.map((m) => `<div class="li"><span class="t"><b>${esc(m.player.name)} ${m.player.rating}${m.group === 'xi' ? '' : ' <span class="tag">bench</span>'}</b>
        <small>${esc(m.evo.name)}${m.evo.cost ? ` · ${esc(String(m.evo.cost))}` : ''}${m.after && m.after.rating ? ` · becomes <span class="up">${m.after.rating}</span>` : ''}</small></span></div>`).join('')}</div>
        <p class="note">Only evolutions EA says the card qualifies for. Start them in the Web App (Evolutions).</p></div>`;
    },

    renderUpgrades() {
      const saved = upgrades.savedTeam();
      const s = upgrades.summary || (saved && saved.summary);
      if (s) {
        const age = saved && saved.at ? Math.round((Date.now() - saved.at) / 60e3) : null;
        const when = upgrades.summary && age !== null && age < 2 ? 'just now' : age !== null ? (age < 60 ? `${age} min ago` : age < 1440 ? `${Math.round(age / 60)} h ago` : `${Math.round(age / 1440)} d ago`) : '';
        this.q('[data-r=team]').innerHTML = `<div class="kpi"><div><b>${s.rating}</b>Rating</div><div><b>${s.chem}/33</b>Chemistry</div><div><b>${esc(s.formation || '—')}</b>Formation</div></div>`
          + `${when ? `<p class="note" style="margin:6px 0 0">Read ${when}${upgrades.updating ? ' · updating…' : ''}</p>` : ''}`;
      }
      this.q('[data-r=upg]').innerHTML = upgrades.results.map((r, si) => `
        <div class="card"><h4 class="title">${esc(r.position)} — now ${r.current ? `${esc(r.current.name)} ${r.current.rating}` : 'empty'}</h4>
        ${r.options.length ? `<div class="list">${r.options.map((o, oi) => `<div class="li">
          <span class="t"><b>${esc(o.name)} ${o.rating}</b><small>${o.source === 'club' ? 'You own this card' : o.source === 'sbc' ? `SBC “${esc(o.setName)}” · ≈ ${fmt(o.price)} coins` : `${fmt(o.price)} coins`} ·
            team <span class="${o.ratingGain > 0 ? 'up' : ''}">${o.ratingGain > 0 ? '+' : ''}${o.ratingGain}</span> ·
            chem <span class="${o.chemGain > 0 ? 'up' : o.chemGain < 0 ? 'down' : ''}">${o.chemGain > 0 ? '+' : ''}${o.chemGain}</span>${o.why && o.why.length ? `<br>${esc(o.why.join(' · '))}` : ''}</small></span>
          <a class="mini" href="${lookupUrl(o.name)}" target="_blank" rel="noopener" title="Look up on FUT.GG">🔎</a>
          ${o.source === 'club' ? '<span class="tag ok">owned</span>' : o.source === 'sbc' ? '<span class="tag">SBC</span>' : `<button class="mini go2" data-a="snipe-opt" data-s="${si}" data-o="${oi}">Snipe</button>`}</div>`).join('')}</div>`
          : `<p class="empty">${r.done ? (r.current && metaPlayStyles(r.current, r.position).length ? `Keep ${esc(r.current.name)} — already has ${esc(metaPlayStyles(r.current, r.position).map((x) => x.name + (x.plus ? '+' : '')).join(', '))}; nothing better within budget` : 'No better option found within budget') : 'Looking…'}</p>`}</div>`).join('')
        + this.evoTeamHtml();
    },

    /** Setup check + advice with one-tap fixes (2.5.0). Checks for an update once per load (if the page allows it). */
    renderSetup() {
      const box = this.q && this.root && this.q('[data-r=setup]');
      if (!box) return;
      const cfg = engine.cfg;
      if (this.latest === undefined && !this.latestAsked) {
        this.latestAsked = true;
        fetch(`https://raw.githubusercontent.com/znxgio/Darkroom/claude/ea-fc-sniping-bot-jdz6vq/fc-sniper/fc-sniper.user.js?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit' })
          .then((r) => (r.ok ? r.text() : '')).then((t) => { const m = t.match(/@version\s+([\d.]+)/); this.latest = m ? m[1] : null; this.renderSetup(); })
          .catch(() => { this.latest = null; this.renderSetup(); });
      }
      const coins = fut.ready() ? fut.coins() : 0;
      engine.safety = engine.safety || store.get(KEYS.safety, {});
      const left = Math.max(0, (cfg.searchesPerDay || 0) - usageFor(engine.safety.usage, Date.now()).searches);
      const items = setupIssues(cfg, { coins, version: VERSION, latest: this.latest, targets: sniperTargets(cfg).length, reachable: huntTargets(cfg).length, searchesLeft: left });
      const adv = (engine.lastAdvice || []).filter((a) => a.fix);
      this.setupItems = items; this.adviceItems = adv;
      const icon = { ok: '✅', warn: '⚠️', info: 'ℹ️' };
      const fixLabel = (f) => ({ update: 'Open install link', keep: `Keep ${fmt(f.value)}`, bid: 'Turn on' }[f.type]);
      const warn = items.filter((x) => x.level === 'warn').length;
      box.innerHTML = `<details${warn || adv.length ? ' open' : ''}><summary><h4 style="display:inline">${warn ? `⚠️ Setup check (${warn})` : '✅ Setup check'}</h4></summary>
        ${items.map((x, i) => `<div class="li"><span class="t"><small>${icon[x.level]} ${esc(x.text)}</small></span>${x.fix ? `<button class="mini" data-a="setup-fix" data-i="${i}">${esc(fixLabel(x.fix))}</button>` : ''}</div>`).join('')}
        ${adv.length ? `<p class="note" style="margin:8px 0 4px">💡 Suggestions — tap to apply (nothing changes by itself)</p>${adv.map((a, i) => `<div class="li"><span class="t"><small>${esc(a.text.replace(/^💡 /, ''))}</small></span><button class="mini" data-a="advice-fix" data-i="${i}">${esc(a.fix.label)}</button></div>`).join('')}` : ''}
      </details>`;
    },

    /** SBC coin goal: offer when an SBC needs more coins than you have; progress while trading toward it. */
    renderGoal() {
      const box = this.q('[data-r=goal]');
      if (!box) return;
      const cfg = engine.cfg;
      const coins = fut.ready() ? fut.coins() : 0;
      if (cfg.goal) {
        const pct = Math.min(100, Math.round(coins / cfg.goal.coins * 100));
        box.hidden = false;
        box.innerHTML = `<h4>🎯 Coin goal — ${esc(cfg.goal.label)}</h4><p class="note">Goal ${fmt(cfg.goal.coins)} · now ${fmt(coins)} (${pct}%). Trade mode flips hot cards until you have it, then stops and tells you.</p>
          <div class="bar"><div><i style="width:${pct}%"></i></div></div><button class="btn red" data-a="goal-cancel">Cancel the goal</button>`;
        return;
      }
      const sh = sbc.short;
      if (!sh) { box.hidden = true; box.innerHTML = ''; return; }
      const free = freeCoins(cfg, coins, []);
      box.hidden = false;
      if (sh.cost <= free) {
        // affordable — only your SBC buy limit is in the way
        box.innerHTML = `<h4>SBC buy limit</h4><p class="note">${esc(sh.name)} needs about ${fmt(sh.cost)} of buys — you can afford it, but it's over your SBC buy limit of ${fmt(cfg.sbcBuyLimit)}. Raise “Max coins to spend per SBC” in the SBC settings to solve it.</p>`;
        return;
      }
      const goal = coinGoal(sh.cost, cfg.minCoins, cfg.goalBufferPct);
      box.innerHTML = `<h4>🎯 Not enough coins yet</h4><p class="note">${esc(sh.name)} needs about ${fmt(sh.cost)} of buys${sh.overLimit ? ` (over your SBC buy limit of ${fmt(cfg.sbcBuyLimit)})` : ''}; you have ${fmt(coins)}. Trade toward ${fmt(goal)} (${cfg.goalBufferPct ?? 12}% extra so you can do it again).</p>
        <button class="btn blue" data-a="goal-start">🎯 Trade toward ${fmt(goal)}</button>`;
    },

    renderPlan() {
      const box = this.q && this.root && this.q('[data-r=plan-info]');
      if (!box) return;
      const cfg = engine.cfg;
      const st = plan.state;
      const sum = planSummary(cfg, fut.ready() ? fut.coins() : 0);
      let line = esc(sum.text);
      if (plan.active && st) line = `<b>Running: block ${st.block} of ${st.blocks}</b> · floor ${fmt(st.floor)} · coins now ${fmt(fut.coins())}${Object.keys(st.sbcDone).length ? ` · SBCs: ${Object.values(st.sbcDone).map((x) => `${esc(x.name)} ×${x.n}`).join(', ')}` : ''}`;
      else if (st && st.ended) line = `Last plan (${new Date(st.startedAt).toLocaleString()}): ${esc(st.ended)} · coins ${fmt(st.startCoins)} → ${fmt(st.endCoins || 0)}${Object.keys(st.sbcDone || {}).length ? ` · SBCs: ${Object.values(st.sbcDone).map((x) => `${esc(x.name)} ×${x.n}`).join(', ')}` : ''}<br>Next: ${line}`;
      box.innerHTML = line;
      const list = cfg.planSbcs || [];
      this.q('[data-r=plan-sbcs]').innerHTML = list.length
        ? `<div class="list">${list.map((x, i) => `<div class="li"><span class="t"><b>${i + 1}. ${esc(x.name)}</b></span><button class="mini" data-a="plan-sbc-rm" data-id="${esc(String(x.id))}">×</button></div>`).join('')}</div>`
        : '<p class="empty">No SBCs yet — add cheap repeatable ones with ＋ Plan on the SBC tab.</p>';
      const btn = this.q('[data-a=plan-start]');
      if (btn) btn.textContent = plan.active ? '■ Stop plan' : 'Start plan';
    },

    renderLearn() {
      const box = this.q('[data-r=learn]');
      if (!box) return;
      const cfg = engine.cfg;
      const levels = learn.levels(cfg);
      const rows = huntTargets(cfg).map((p) => {
        if (!learn.usable(p, cfg)) return `<div class="li"><span class="t"><b>${esc(p.name)}</b><small>${p.manualMax ? 'manual max — not learning' : 'needs a price check first'}</small></span></div>`;
        const arms = learn.arms(p);
        const r = (x) => Math.round(x || 0);
        const n = r(Object.values(arms).reduce((a, x) => a + (x.n || 0), 0));
        const tot = (k) => r(Object.values(arms).reduce((a, x) => a + (x[k] || 0), 0));
        const best = cfg.smartPrice ? bestArm(arms, levels, Date.now()) : null;
        const g = gapStats((learn.data.targets[learn.key(p)] || {}).gaps);
        const gapLine = g.probes ? `<br>near-miss checks ${g.probes} · ${g.near} found just above your max${g.near ? ` · avg ${g.avgPct}% under the cheapest` : ''}` : '';
        const tried = levels.filter((d) => arms[d] && (arms[d].n || arms[d].near)).map((d) => `${d}%: ${r(arms[d].n)}${arms[d].hits ? ` ✅${r(arms[d].hits)}` : ''}${arms[d].misses ? ` ⚡${r(arms[d].misses)}` : ''}${arms[d].near >= 0.5 ? ` 🎯${r(arms[d].near)}` : ''}`).join(' · ');
        return `<div class="li"><span class="t"><b>${esc(p.name)}${best && (best.hits || best.misses || best.near) ? ` <span class="tag ok">best ${best.pct}% under</span>` : ''}</b>
          <small>${n ? `${n} searches · ${tot('hits')} bought · ${tot('misses')} lost races` : 'not tried yet'}${cfg.smartPrice && tried ? `<br>${tried}` : ''}${gapLine}</small></span></div>`;
      });
      const sp = learn.data.speed || {};
      const hours = Object.entries(learn.data.hours || {}).filter(([, h]) => h.n >= 10).map(([h, x]) => ({ h: Number(h), r: x.good / x.n })).sort((a, b) => b.r - a.r).slice(0, 3).filter((x) => x.r > 0);
      box.innerHTML = `${rows.length ? `<div class="list">${rows.join('')}</div>` : '<p class="empty">Add players to start learning</p>'}
        <p class="note">✅ bought · ⚡ lost to a faster buyer · 🎯 just above your max${sp.n ? ` · your buy speed ${Math.round(sp.ms / sp.n)} ms avg (${sp.lost} of ${sp.n} lost)` : ''}${hours.length ? ` · best hours: ${hours.map((x) => `${x.h}:00`).join(', ')}` : ''}</p>`;
    },

    renderBudget() {
      const el = this.q('[data-r=budget]');
      if (!el) return;
      const cfg = engine.cfg;
      const used = usageFor(engine.safety.usage, Date.now()).searches;
      const n = huntTargets(cfg).length;
      const b = searchBudget(cfg, used, n);
      el.innerHTML = `${fmt(b.left)} searches left today · about ${fmt(b.perHour)}/hour: ${n ? `${fmt(b.huntPerHour)} hunting${b.pricingPerHour ? `, ${fmt(b.pricingPerHour)} price checks (${n} target${n === 1 ? '' : 's'})` : ''}` : 'add a player or filter'}`
        + (b.pricingShare > 0.3 ? ` · <span class="down">price checks use ${Math.round(b.pricingShare * 100)}% — fewer targets or a longer “Refresh prices every” leaves more for sniping</span>` : '');
    },

    renderStats() {
      this.renderLearn();
      this.renderPlan();
      if (!engine.running) this.renderSetup();
      this.renderBudget();
      Object.entries(engine.stats).forEach(([k, v]) => {
        const el = this.q(`[data-s="${k}"]`);
        if (el) el.textContent = fmt(v);
      });
    },

    renderProfit() {
      const el = this.q('[data-r=profit]');
      if (!el) return;
      const ps = profitSummary(engine.history, Date.now());
      const sg = (n) => `${n > 0 ? '+' : ''}${fmt(n)}`;
      const cls = (n) => (n > 0 ? 'g' : n < 0 ? 'r' : '');
      const cell = (label, p) => `<div><b class="${cls(p.net)}">${sg(p.net)}</b>${label}<small>${fmt(p.sold)} sold / ${fmt(p.bought)} bought</small></div>`;
      const max = Math.max(1, ...ps.days.map((d) => Math.abs(d.net)));
      const bars = ps.days.map((d) => {
        const wd = new Date(`${d.key}T12:00:00`).toLocaleDateString([], { weekday: 'narrow' });
        return `<span title="${esc(d.key)}: ${sg(d.net)}"><i class="${d.net < 0 ? 'neg' : ''}" style="height:${d.net ? Math.max(4, Math.round(Math.abs(d.net) / max * 100)) : 0}%"></i><em>${esc(wd)}</em></span>`;
      }).join('');
      const row = (c) => `<div><span>${esc(c.name)}${c.rating ? ` · ${c.rating}` : ''}</span><span class="p ${cls(c.net)}">${sg(c.net)}</span><small>sold ${c.sold}/${c.bought}${c.avgDays != null ? ` · ${c.avgDays}d avg` : ''}</small></div>`;
      el.innerHTML = `<h4>💰 Profit</h4>
        <div class="stats">${cell('Today', ps.today)}${cell('7 days', ps.week)}${cell('All time', ps.all)}</div>
        <p class="note">Tied up in unsold listings: <b>${fmt(ps.all.tiedUp)}</b>${ps.all.sellThrough != null ? ` · sell-through ${ps.all.sellThrough}%` : ''}${ps.all.avgHours != null ? ` · avg ${ps.all.avgHours}h to sell` : ''} · received ${fmt(ps.all.received)} after tax</p>
        <div class="pbars">${bars}</div>
        ${ps.best.length ? `<h5>Best cards</h5><div class="hist">${ps.best.map(row).join('')}</div>` : '<p class="empty">No sales yet</p>'}
        ${ps.worst.length ? `<h5>Worst cards</h5><div class="hist">${ps.worst.map(row).join('')}</div>` : ''}`;
    },

    renderHistory() {
      this.renderProfit();
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
      on = on || plan.active; // a plan keeps the panel locked through its breaks and SBCs
      const go = this.q('[data-a=toggle]');
      go.classList.toggle('on', on);
      this.root.classList.toggle('running', on || !!jobs.current);
      go.innerHTML = on ? ICON.stop : ICON.play;
      go.setAttribute('aria-label', on ? 'Stop' : 'Start');
      this.tick();
      this.qa('[data-k] , [data-k] button, [data-r=pq], [data-a=price]').forEach((el) => { el.disabled = on; });
      const bar = this.q('[data-r=jobbar]');
      if (bar && !jobs.current) { bar.hidden = !on; this.q('[data-r=jobname]').textContent = on ? '▶ Bot running — stop (■) to change settings' : ''; }
      this.qa('[data-a=trade-start], [data-a=hot-scan], [data-a=hot-top], [data-a=hot-add], [data-a=snipe-add], [data-a=autofill], [data-up], [data-down], [data-fon], [data-fedit], [data-fmax], [data-a=filter-new]').forEach((el) => { el.disabled = on; });
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

    log(msg, cls = '', at = Date.now(), restoring = false) {
      const box = this.root && this.q('[data-r=log]');
      if (!box) return;
      // Problems shouldn't hide in the Log tab: show them on screen too.
      if (!restoring && (cls === 'err' || /^(Can['’]t start|Busy|Locked|Stop the bot)/.test(msg))) { try { this.toast(msg.length > 120 ? `${msg.slice(0, 117)}…` : msg, 'alert'); } catch { /* ignore */ } }
      const line = document.createElement('div');
      line.className = cls;
      const d = new Date(at);
      const today = new Date().toDateString() === d.toDateString();
      line.innerHTML = `<time>${today ? '' : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} `}${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time>`;
      line.append(document.createTextNode(msg));
      box.prepend(line);
      if (!restoring) {
        // keep the log across reloads (last LOG_KEEP lines) — and the technical details with it
        this.saved = (this.saved || store.get(KEYS.log, [])).concat([[at, cls, msg]]).slice(-LOG_KEEP);
        clearTimeout(this.logTimer);
        this.logTimer = setTimeout(() => { store.set(KEYS.log, this.saved); store.set(KEYS.debug, debugLog.slice(-200)); }, 500);
      }
      while (box.childNodes.length > 500) box.lastChild.remove();
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
      this.placeHandle();
      w.addEventListener('resize', () => this.placeHandle());
      if (w.visualViewport) w.visualViewport.addEventListener('resize', () => this.placeHandle());
      if (store.get(KEYS.ui, {}).handleLeft) this.root.classList.add('lft');
      // the click that ends a drag is swallowed (capture phase, before the panel's own click handlers)
      this.root.addEventListener('click', (e) => {
        // only the one click a finished drag produces (it arrives right away), never a later real tap
        if (this.dragEndAt && Date.now() - this.dragEndAt < 200) { this.dragEndAt = 0; e.preventDefault(); e.stopImmediatePropagation(); }
      }, true);
      handle.addEventListener('pointerdown', (e) => {
        const cls = this.root.classList;
        if (cls.contains('mob') && cls.contains('min')) return this.dragHandle(e, handle); // whole handle, buttons included
        if (e.target.closest('button')) return;
        if (cls.contains('mob')) return;
        const r = this.root.getBoundingClientRect();
        const sx = e.clientX; const sy = e.clientY;
        const move = (ev) => {
          this.root.style.left = `${Math.max(0, r.left + ev.clientX - sx)}px`;
          this.root.style.top = `${Math.max(0, r.top + ev.clientY - sy)}px`;
          this.root.style.right = 'auto';
        };
        const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
        addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
      });
    },
  };

  // Wait for the Web App to finish booting, then mount the panel.
  const boot = setInterval(() => {
    if (document.body && fut.ready()) { clearInterval(boot); ui.mount(); }
  }, 1000);
})();
