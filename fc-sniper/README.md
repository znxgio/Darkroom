# FC Sniper

A transfer-market sniper, resell bot, pack opener, SBC solver and squad advisor for the
**EA SPORTS FC Ultimate Team Web App**. It's a userscript that runs inside the official
Web App on your phone or computer and adds a control panel.

> ⚠️ Automating the Web App breaks EA's User Agreement. EA bans accounts for it, including
> users of paid bots. The safety limits below lower the risk; nothing removes it.

## Install

**Install link:**
https://raw.githubusercontent.com/znxgio/Darkroom/claude/ea-fc-sniping-bot-jdz6vq/fc-sniper/fc-sniper.user.js

- **iPhone:** install **Tampermonkey** (or **Userscripts**) from the App Store and turn it on
  in Settings → Safari → Extensions. Open the link in Safari, tap the 🧩 icon → Install.
- **Android:** use **Firefox** with the **Tampermonkey** add-on, then open the link.
- **Computer:** Tampermonkey in Chrome, Edge, Firefox or Safari, then open the link.

Then open https://www.ea.com/ea-sports-fc/ultimate-team/web-app/ and log in. The panel
appears by itself. On a phone, use Safari's **Request Desktop Website** if EA sends you to
the Companion app. Updates install automatically.

## Features

| | |
|---|---|
| **Priority list** | Add players by name or ID, in order. All are hunted at once (higher on the list wins ties), each is bought once and ticked off, and the bot stops when the list is done or your **spend limit** is reached. Optional: keep coins for players higher on the list. |
| **Search filters** | Multi-filter search: save filters by quality, rarity (names read from the Web App), league, nation, club, position and **rating range** ("snipe by rating"), switch them on and off, and they're hunted together with your priority list. **Price** finds the going rate for a whole filter and sets the max buy under it. |
| **Profit calculator** | Trade tab: buy and sell price → what you get after EA's 5% tax, profit and break-even. |
| **Accent colour** | Green or orange (Settings → Look & notifications). |
| **Fill from team needs** | Reads your squad, finds affordable upgrades (by meta stats and chemistry) for your weakest spots, and adds the best one per spot to the list with a max buy under its cheapest listing. |
| **Your team (2.5.0)** | Your squad is read by itself a few seconds after the panel opens (one request, no market searches) and saved — the Squad tab shows it right away ("Read 2 h ago"). **↻ Update my team** re-reads it after you change your squad. |
| **Find upgrades (2.5.0)** | The slow part, now its own button: for your 3 weakest spots it checks your club, the market (within budget) and SBC rewards, scored by FC 27 meta — position-weighted face stats plus meta **PlayStyles / PlayStyles+** (researched from dated public guides; FC 27 favours raw stats, so PlayStyle bonuses are modest). Each suggestion says why ("meta PlayStyles: Low Driven Shot+ · +7 pace · chem +1"), and a spot gets "Keep …" when your player already has the meta PlayStyles. Also lists **evolutions your squad's cards can start now** — only ones EA says the card qualifies for, starting XI first, then subs/reserves — with what the card becomes. |
| **SBC ranker & coin goal (2.5.0)** | *Rank SBCs* sorts them by a quick club check (likely from your club first, repeatables first; no market searches). When an SBC needs more coins than you have, **🎯 Trade toward it** flips hot cards (only hot cards — never your own list) until you have the cost + a buffer (default 12%, e.g. needs 120k → aims for ~135k), then stops, tells you, and puts your mode back. If it's affordable but over your SBC buy limit, it says to raise the limit instead. |
| **Setup check (2.5.0)** | A card at the top of Snipe: version vs latest, Keep coins, out-of-reach players, bidding, searches left — with one-tap fixes; plus the smart advice with **Apply** buttons. Nothing changes unless you tap. |
| **🧠 Analyst (2.5.0)** | Squad tab: type a question — “what should replace Mainoo?”, “Rice vs Bellingham”, “best CB I own”, “how’s my team?”, “price of Saka”. Answers come only from your squad, club and the bot’s own price checks (reads your club once, no market searches); if it doesn’t know, it says so. **📋 Copy for Claude** copies your team + question for anything else. |
| **Card stats read automatically (2.5.0)** | A player added without a rating or stats gets them from the first listing the price check sees — no extra searches, nothing to look up by hand. |
| **Market overlay (2.5.0)** | When *you* search the market in the Web App, a small card shows the cheapest Buy Now vs the usual price and the card’s meta score. It only reads what your search already returned; never on the bot’s own searches. Settings → “Market overlay on my own searches”. |
| **Status strip & locked controls (2.5.0)** | A thin strip under the tabs shows what the bot is doing, the countdown and today’s searches on every tab. While it runs, settings are dimmed and tapping one says why. |
| **Profit (2.5.0)** | History tab: today / 7 days / all time after tax, coins tied up in unsold cards, sell-through, a 7-day chart, best and worst cards. |
| **Session report** | (2.5.0) When a session ends: one line with searches, buys, races lost, near misses, coins spent, listed, est. profit and your best hour so far — also to Discord if set. |
| **Smart advice** | (2.5.0) From ~60 Buy Now searches on a card, the bot turns what it saw into one plain suggestion (in the session report and every 100 searches): e.g. "listings come in around 1.2% under the cheapest — a Snipe % near 1 would catch some", "nothing came within 4% above your max — a cheaper or less popular card snipes better", or "auctions end ~5% under the cheapest — turning on auction bidding may land one". **Suggestions only** — your settings never change by themselves. |
| **Snipe-friendly cards** | (2.5.0) The hot-card scan also ranks cards whose cheap listings vary a lot (more mispriced listings = better odds for a bot that searches every few seconds), with a suggested Snipe % and a **Snipe it** button that adds the card to your priority list. Tight markets (< 2% spread) are left out. No extra searches. |
| **Card versions** | (2.4.10) EA's player list only has each player's base card. After you pick a name, the bot does one normal market search and shows the different cards it finds (e.g. *Thompson (Future Stars)* 84 · cheapest 48,750, or the base card) — pick the exact one to hunt; it then only buys that card. Name search shows up to 12 matches and ranks a whole surname ("thompson") above partial matches. |
| **Can't afford → don't search** | (2.4.9) Before each search the bot skips players you can't afford right now (free coins = coins − Keep coins − coins held in open bids; a player counts if free coins are at least 60% of its cheapest listing). If nobody is affordable: with open bids it waits with **no searches** until a bid is about to end; with none it stops and says why. |
| **Dry spell → auctions** | (2.4.9, needs bidding on) After *N* Buy Now searches with nothing on a player (default 40), that player's next searches (default 60) are auctions only, using the normal last-seconds bid with all the usual limits; then back to Buy Now. A buy resets the count; 0 turns it off. No early bids and no constant checking — each check of a bid counts as a search. The "Still sniping" line now ends with a verdict per player: `Salma: Buy Now 0/120 at ≤ 186,000 · auctions near the end ~3.1% under the cheapest (8)` — evidence for choosing a different card or depth. |
| **Live updates** | (2.4.8, on by default; Settings → *Live updates*) A log line for every search: `🔍 12. Salma ≤ 186,000: 1 listed · cheapest 193,000 (0.5% under the usual cheapest)`, and for every auction search: how many auctions, which end within your bid window, and — for those it doesn't bid on — why (not ending yet · next bid over your max · Buy Now is cheaper · already highest · not enough free coins · limits). Auctions seen early are remembered, so it can tell you what they climbed to: "seen at 160,000 with 4 min left is at 191,000 with 20 s to go — over your max". |
| **Auction bidding (2.4.8)** | Buy Now and auction searches now alternate per player (before, with an even number of players some never got an auction search). Bid window default 45 s (was 30; 15–90). Still bids only near the end — early bids lock your coins (EA takes them when you bid) and just set the starting price for everyone else. |
| **Session plan** | (2.4.7) Snipe tab → 📋 Session plan. Set blocks, block length (≤ 120 min), break length (≥ 20 min, no market calls), a coin budget (% of your coins at the start), SBCs per break and max coins per SBC; add cheap repeatable SBCs with **＋ Plan** on the SBC tab. Before starting it shows one line: how long, how much it can spend, the coin floor it never goes below, and today's searches. Before every block it runs a check (logged in, market answers normally). In the breaks it does only your ticked SBCs, in order, each again while it's solvable and under your caps; an SBC that fails is skipped for the rest of the plan. Optional keep-alive (one transfer-list read every ~10 min in breaks, never a market search). **Any captcha, market limit, logout or safety lock ends the plan at once**, and after a reload it never resumes by itself — your Keep coins and session length are put back. Discord message when it ends. |
| **Snipe pricing** | (2.4.6) **Buy mode:** your Snipe % (default 4%, inside the 5% tax band where fast flip bots can't profit — more buys, smaller saving each) under the *cheapest real listing* (a lone listing over 30% under the next, or 8%+ under a tight group, is ignored — it's about to be sniped). Player hunts only buy the exact card you added, never another version of it. **Trade mode:** max = what it resells for after EA's 5% tax minus your min profit, where resale is the lower of the market price (median of the 5 cheapest) and the 2nd-cheapest listing. **Trend:** with 24 h+ of price history, a falling price snipes up to 3 points deeper (half the drop); a rising one changes nothing. Filters keep the market price (they cover many cards). The price-check log line shows each part: cheapest, market, trend, max. |
| **Smart sniping** | Picks which card gets the next search by what lands (buys, lost races), 1 search in 10 rotates. Near-miss checks (1 in N searches look 4% above your max, never buy above it) record how far under the cheapest the next listing was — shown on the Learning card and in the "still sniping" line. *Also let it set the discount (experimental, off)*: Thompson sampling over your Snipe % up to 14%; a level with no buys, races or near misses is never favoured for being deeper. Old evidence halves every 7 days and again if the price moves over 15%. Never above your coins / spend limit / profitable price. |
| **Price check** | Finds each player's market price from the 5 cheapest Buy Now listings of the base card. |
| **Auto max buy** | Snipes a set % under the average (default 10%), never more than your coins minus *Keep coins*. Tap a price to set your own. Players your coins can't get near (max under 60% of the cheapest listing) are marked ⏭️ out of reach and skipped while sniping, so searches go to players you can buy — set a manual max to hunt one anyway. Every 25 searches the log shows a *Still sniping* summary: searches per player, listings under your max, and how far your max is under the cheapest listing. |
| **Buy, Trade or Alert** | *Buy* snipes instantly. *Trade* runs the resell bot (below). *Alert* notifies you and never spends coins. |
| **Resell bot (Trade)** | For each player: lists a set % under the market average so cards sell, and only buys low enough to keep your minimum profit after EA's 5% tax (the larger of a coin amount and a % of the price). Every few minutes it records sales and real profit, clears sold items, relists expired ones, and pauses buying when your transfer list is full. Never puts more than 25% of your coins (above Keep coins) into one card (*Max % of my coins on one card*); lists for 3 h by default so cards stay up between sessions. |
| **Hot cards** | Finds cards to flip from two sources: cards you've already flipped for a profit (your history), and a sweep of EA's live market in narrow price bands per league (so copies of the same card show up together). Ranks by demand (live bids), supply and price gap, price-checks the best, drops thin ones (under 3 listed) and ranks the rest by profit × liquidity. The log says why each card was skipped. If *Rare golds only* finds nothing, it scans all gold cards and remembers that for the rest of the session. Add them one by one, trade the top N, or let it pick hot cards every time you start trading. |
| **Search recorder** | Log tab → *Record my next 3 market searches* (read-only): notes how the Web App builds the searches you make by hand, so filters like Rare can be copied exactly. Nothing is bought or changed; stops after 3 searches or 3 minutes. |
| **Auction bidding & bid wars** | On by default (since 2.4.0). Bids in an auction's last seconds when the next bid is under your max and under Buy Now; every bid counts against Keep coins, spend limit, buy-once and the session buy cap, and open bids survive a reload. **Bid wars:** when outbid in the last seconds it counter-bids, up to 8% over your max but never over the market average − 3% (Trade: the price that still leaves your min profit after tax) or Buy Now; it gives up after 5 counter-bids or when out of room, holds at most 25% of your coins in wars, and fights 1 war at a time (up to 3 in Settings). **Buy Now vs a war:** a Buy Now ≥ 20% under average always wins; otherwise the war wins while its next bid is ≥ 10% under average; otherwise Buy Now wins and the war is dropped. A second copy won that way is resold at a profit. |
| **Fresh prices** | Re-checks each player's market price during long sessions (every 15 min by default). |
| **Auto-selling** | Keep the card, list for a minimum profit, list at the market average, or list at your price. Profit is after EA's 5% tax. |
| **Transfer list tidy** | Optionally relists expired items and clears sold ones when you start. |
| **Filters** | Quality, rarity, position, nation, league, club, min rating. Also works without players. |
| **Notifications** | Sound, vibration (Android), on-screen banner, and Discord webhook messages for buys, alerts and stops. |
| **History** | Every buy with time, price, listed price and what it actually sold for. Totals for today and all time, including real profit from sales. |
| **Phone layout** | Bottom sheet with large controls, keeps the screen awake while running. |
| **Upgrade advisor** | Reads your active squad, finds the 3 weakest spots, and suggests upgrades that raise your rating without breaking chemistry. Players you own come first, then market cards in your squad's main league or nation within budget. One tap sends a card to the sniper. **SBC players:** players you can get from SBCs right now are suggested too, with a rough coin cost (each challenge filled with the cheapest market cards per rating — less if you use your own fodder). |
| **Formation coach** | Builds the best XI **from your own club** for each formation (by meta stats or rating) and compares rating and chemistry with your current lineup. Formations that public FC 27 guides call meta are marked 📰 with the guide, date and suggested tactics (sources disagree — both are shown; the notes update with the script, they aren't live). Shows each lineup's weakest spots with a "Find upgrades" button. Can create the lineup as a new squad (not for 4-2-1-3 yet). |
| **Price history & trends** | Every price check and hot scan is remembered on your phone (7 days, small). Once a card has 4+ samples over a day, it shows a trend (↑/↓ %, sparkline); the hot-card list uses it as a tie-breaker. 🔎 opens a FUT.GG search for the card in Safari — the bot itself never reads FUT.GG/FUTBIN. |
| **Helpers** | A bar on every tab shows a running task with a Stop button. Ask Claude copies your question plus the new log lines and opens claude.ai. Reload the Web App, reset settings to defaults, Copy log (new lines since the last copy, marked in the log) and Copy full log. |
| **Pack opener** | Lists your unopened packs and opens one, a type, or all. Sorts each pack: new items to your club, untradeable duplicates to SBC storage, tradeable duplicates to the transfer list, and optionally quick-sells duplicates rated below a number you set. Shows your best pulls. |
| **SBC solver** | Loads SBCs, marks which it can solve, and builds the cheapest squad from your club: SBC storage and duplicates first, then untradeables. Never uses your active squad (starters, subs and reserves), loans, evolutions, special cards or tradeables (unless you allow them), or players rated above your limit — and re-checks every player right before sending. Review, then submit, or just fill the squad and check it in the Web App. Repeats repeatable SBCs. **Buys missing players:** when your club can't complete an SBC, it adds the cheapest market fill-ins (fewest coins, your own players first, never cards you own), shows the total and asks before buying — capped by *Max coins to spend per SBC*. **Chemistry SBCs:** total and per-player chemistry, same/min/max league-nation-club counts and "from league X" requirements, with players placed in the SBC's positions. |
| **Points (💎) SBCs** | Estimates the points you need, how many your spare cards cover and what the rest costs. Hands in spare cards in batches of 20, and — if you set *Max coins for points SBCs* above 0 — buys the cheapest cards per point to finish it. Never uses squad, special or loan cards. |
| **Unassigned in SBCs** | Before an SBC, new items in Unassigned go to your club and duplicates to SBC storage, so the solver can use them. |
| **SBC reward packs** | After an SBC is submitted, any new reward packs are opened and sorted automatically (can be switched off). |
| **Smart relisting** | Expired cards the bot bought are relisted one step under today's cheapest listing, never below what you paid + min profit. After *Cut losses after* failed relists it may drop to break-even. |
| **Evolutions helper** | Squad tab: lists the evolutions on offer, their cost, which of your players qualify, and previews the final rating. Starting an evolution is still done in the Web App. |
| **Backup & saved log** | The log survives reloads (last 300 lines). Settings → Backup copies your settings, lists, filters and history; Restore pastes it back. |
| **Side tasks follow the limits** | SBC fill-ins, points buying, the hot scan and relisting share the sniper's ≥3 s pacing clock, rests, daily caps and lockouts — checked before every market call. A task that needs more buys than you have left today is refused up front; one that hits a limit stops cleanly and keeps what it bought. |
| **Safety** | Enforced pacing, session and daily limits, and lockouts after EA warnings (below). Shared by every feature. |

## Using it

The panel has 8 tabs: **Snipe · Trade · Squad · Packs / SBC · History · Log · Settings**.

1. **Snipe tab → Priority list:** type a player's name and tap him (↑↓ to reorder), or tap
   **🧩 Fill from team needs**. Set a **Spend limit** if you want a total cap.
   Each added player gets a price check, and his max buy
   shows on his row, e.g. `Mbappé 91 ≤ 46,750 · avg 52,000`.
2. Choose **Buy** or **Alert only**, and set **Buys per session** (1 if you want one card).
3. *(Optional)* **Sell tab:** choose what happens after a buy.
4. Tap **▶**. The status card shows what it's doing, the countdown to the next search,
   time left in the session, and today's usage.

Prices refresh on start if they're older than 15 minutes, or when you tap **Check prices**.
A name matches every version of the card; set **Min rating** (Filters) to aim at one version.

### Trading (resell bot)
**Easiest:** Trade tab → **Find hot cards** → **Trade the top 3**, or turn on *Pick hot cards
when I start trading* and just tap **Start trading**. "Hot" is measured from EA's live market
(what's listed and being bid on right now); trend sites like Futbin block bots.

**Your own picks:**
1. Add the players you want to flip on the **Snipe** tab and tap **Check prices**.
2. **Trade** tab: each player shows its plan, e.g. `avg 52,000 · buy ≤ 45,750 · sell 50,000 · +1,560`.
   Adjust *List % under market avg*, *Min profit* and *Min profit %*.
3. Tap **Start trading**. *Check transfer list now* records sales any time.
Cheaper, high-volume cards flip more often; expensive cards need a bigger margin to be worth the risk.

### Squad, packs and SBCs
- **Squad tab → Analyse my team.** Set a budget (0 = your coins minus Keep coins).
  Turn off *Also search the market* to only use players you own (no searches).
- **Packs tab → Load my packs.** Unassigned must be empty before EA lets you open a pack;
  the bot sorts it first and stops if something can't be moved (for example a full pile).
- **SBC tab → Load SBCs → View → Solve.** Challenges tagged **auto** can be solved:
  team rating, min/max/exact player rating, Bronze/Silver/Gold, and rare count.
  Chemistry, league/nation/club counts and "from league X" are solved too; very strict
  combinations can still fail. If your club can't do it, it offers cheap fill-ins to buy.

### Something not working?
Tap **Copy log** (Snipe tab, under Activity) and paste it in the chat. It includes
the exact EA response for whatever failed.

### Discord alerts
In Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy URL. Paste it
in **Safety → Discord webhook** and tap **Send test notification**. If EA's page blocks the
request, the log says so.

## Safety limits

| Limit | Default | Enforced |
|---|---|---|
| Delay between searches | 4–8 s, random | at least 3 s, with at least 1.5 s of randomness |
| Rest break | 45–120 s every 30 searches | at least 20 s, at least every 60 searches |
| Session length | 40 min | at most 120 min |
| Searches per session / per day | 250 / 600 | at most 1,500 per day |
| Buys per session / per day | 10 / 40 | |

Values below a minimum are raised when you press Start. Daily counts reset at midnight and
survive reloads. Price-check searches count too.

**Lockouts.** When EA pushes back, the bot stops and won't start again for a while:
captcha **3 h**, transfer market limited **24 h**, 3 errors in a row **30 min**.

**What matters most:** short sessions a few times a week. When you get a captcha, solve it
and stop for the day. Don't use an account you can't afford to lose.

**Deliberately not included:** running 24/7 or auto-restarting after limits, solving or
skipping captchas, and hiding the script from EA.

## Roadmap

Researched and possible next, roughly in order of value:
1. **Live lineup data** — pro/meta lineups if a source without bot protection is found.
2. **Chemistry & league/nation/club SBCs** — extend the solver with the chemistry model
   already used by the upgrade advisor, so "Hybrid Leagues"-style SBCs can be solved.
3. **Open SBC reward packs automatically** after submitting, and sort them.
4. **Claim objectives / rewards** in one tap.
5. **Evolutions helper** — list which of your players qualify for active evolutions.
6. **Price data in the upgrade advisor** — show each suggestion's market average.

## Develop

```
npm test        # unit tests for pricing, search, safety, history (no browser)
npm run e2e     # Chromium runs against a mocked Web App: sniper, then packs/SBC/upgrades (~5 min)
```

`fc-sniper.user.js` has pure, unit-tested logic first, then the runtime: Web App adapter,
engine, notifications and UI. The Web App's internal API isn't documented and EA changes it
between editions, so the adapter (`fut`) is the part most likely to need updates.
