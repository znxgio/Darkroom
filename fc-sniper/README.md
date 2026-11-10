# FC Sniper

A transfer-market sniper, pack opener, SBC solver and team upgrade advisor for the
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
| **Player search** | Add players by name (accents optional) or ID. Several players are searched in turn. |
| **Price check** | Finds each player's market price from the 5 cheapest Buy Now listings of the base card. |
| **Auto max buy** | Snipes a set % under the average (default 10%), never more than your coins minus *Keep coins*. Tap a price to set your own. |
| **Buy or alert-only** | *Buy* snipes instantly. *Alert only* notifies you and never spends coins. |
| **Auto-selling** | Keep the card, list for a minimum profit, list at the market average, or list at your price. Profit is after EA's 5% tax. |
| **Transfer list tidy** | Optionally relists expired items and clears sold ones when you start. |
| **Filters** | Quality, rarity, position, nation, league, club, min rating. Also works without players. |
| **Notifications** | Sound, vibration (Android), on-screen banner, and Discord webhook messages for buys, alerts and stops. |
| **History** | Every buy with time, price and listed price. Totals for today and all time. |
| **Phone layout** | Bottom sheet with large controls, keeps the screen awake while running. |
| **Upgrade advisor** | Reads your active squad, finds the 3 weakest spots, and suggests upgrades that raise your rating without breaking chemistry. Players you own come first, then market cards in your squad's main league or nation within budget. One tap sends a card to the sniper. |
| **Pack opener** | Lists your unopened packs and opens one, a type, or all. Sorts each pack: new items to your club, untradeable duplicates to SBC storage, tradeable duplicates to the transfer list, and optionally quick-sells duplicates rated below a number you set. Shows your best pulls. |
| **SBC solver** | Loads SBCs, marks which it can solve, and builds the cheapest squad from your club: SBC storage and duplicates first, then untradeables, never your active squad or players rated above your limit. Review, then submit, or just fill the squad and check it in the Web App. Repeats repeatable SBCs. |
| **Safety** | Enforced pacing, session and daily limits, and lockouts after EA warnings (below). Shared by every feature. |

## Using it

1. **Snipe tab:** type a player's name and tap him. His price is checked and his max buy
   shows on his row, e.g. `Mbappé 91 ≤ 46,750 · avg 52,000`.
2. Choose **Buy** or **Alert only**, and set **Buys per session** (1 if you want one card).
3. *(Optional)* **Sell tab:** choose what happens after a buy.
4. Tap **▶**. The status card shows what it's doing, the countdown to the next search,
   time left in the session, and today's usage.

Prices refresh on start if they're older than 15 minutes, or when you tap **Check prices**.
A name matches every version of the card; set **Min rating** (Filters) to aim at one version.

### Upgrades, packs and SBCs
- **Upgrades tab → Analyse my team.** Set a budget (0 = your coins minus Keep coins).
  Turn off *Also search the market* to only use players you own (no searches).
- **Packs tab → Load my packs.** Unassigned must be empty before EA lets you open a pack;
  the bot sorts it first and stops if something can't be moved (for example a full pile).
- **SBC tab → Load SBCs → View → Solve.** Challenges tagged **auto** can be solved:
  team rating, min/max/exact player rating, Bronze/Silver/Gold, and rare count.
  Chemistry and league/nation/club count requirements show as **manual** for now.

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
1. **Chemistry & league/nation/club SBCs** — extend the solver with the chemistry model
   already used by the upgrade advisor, so "Hybrid Leagues"-style SBCs can be solved.
2. **Open SBC reward packs automatically** after submitting, and sort them.
3. **Claim objectives / rewards** in one tap.
4. **Evolutions helper** — list which of your players qualify for active evolutions.
5. **Price data in the upgrade advisor** — show each suggestion's market average.

## Develop

```
npm test        # unit tests for pricing, search, safety, history (no browser)
npm run e2e     # Chromium runs against a mocked Web App: sniper, then packs/SBC/upgrades (~5 min)
```

`fc-sniper.user.js` has pure, unit-tested logic first, then the runtime: Web App adapter,
engine, notifications and UI. The Web App's internal API isn't documented and EA changes it
between editions, so the adapter (`fut`) is the part most likely to need updates.
