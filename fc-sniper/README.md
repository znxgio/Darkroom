# FC Sniper

A transfer-market sniper/autobuyer for the **EA SPORTS FC Ultimate Team Web App**, in the
style of tools like Bakers bot. It's a userscript that runs inside the official Web App and
adds a floating control panel.

> ⚠️ Automating the Web App breaks EA's User Agreement. EA detects this and hands out
> transfer-market bans (and sometimes full account bans). Use a throwaway account or accept the risk.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Create a new script and paste in `fc-sniper.user.js`.
3. Open the FC Web App, log in, and the **FC Sniper** panel appears top-right.

## Use

1. **Player ID(s):** the player's definition ID (it's in the futbin/futwiz player URL or page).
   Leave it blank to search by quality, rarity, league, nation or club instead.
2. **Max buy now:** the most you'll pay. Anything listed at or below this gets bought instantly.
3. *(Optional)* tick **Auto-list** to relist bought items automatically, either at a fixed
   **Sell price** or automatically at break-even after EA's 5% tax plus **Min profit**.
4. Press **Start** (or **Alt+S**).

### How it snipes
- Every search changes the min-bid filter, so EA returns fresh listings instead of cached ones.
- Listings at or below your max buy are sorted cheapest first and bought with Buy Now.
- Delays between searches are random, and it takes a longer rest every N searches.
- It **stops automatically** on a captcha or verification prompt (458/459), on rate limiting
  or a soft ban (429/521/512), on a session expiry, when coins run out, or when it hits your
  search or buy limits. An alarm sounds when that happens.

### Safety tips
- Keep delays at 3–6 s or more and sessions short (a few hundred searches), then rest.
- Don't run it around the clock. Long, regular sessions are what get accounts flagged.
- If a captcha appears, solve it yourself and take a break before restarting.

## Develop

```
npm test
```
The pricing, tax, filtering and error-handling logic is pure and unit-tested in `test/`.
