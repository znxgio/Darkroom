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

### On your phone
Phone browsers need a userscript manager too:
- **iPhone / iPad:** Safari with the **Userscripts** app (free, App Store) or **Tampermonkey** for Safari.
  Turn the extension on in Settings → Safari → Extensions, then add the script.
- **Android:** **Firefox** with the **Tampermonkey** or **Violentmonkey** add-on.

On a phone the panel is a bar along the bottom of the screen. Tap **▶ / ■** to start or stop,
and **–** to open the full settings sheet. It keeps the screen awake while running and
vibrates when it buys something (on Android) or gets stopped.

**Keep the Web App open and on screen.** Phones pause web pages when you lock the screen or
switch apps, and the bot pauses with them. It picks up again when you come back.

## Use

1. **Add players:** type a name in the search box (accents optional, so `mbappe` finds
   Mbappé) and tap a result, or press Enter for the top one. You can also type a player ID.
   Add several players and the bot **rotates** between them, one per search. Leave the list
   empty to search by quality, rarity, league, nation or club instead.
   - A name matches **every version** of that player (base, TOTW, specials), just like the
     Web App's own search. Use **Min rating** or **Rarity** to target one card.
   - Names come from EA's own player list, the same file the Web App uses for its search
     box. If it says the list isn't found, open **Transfers → Search** once and try again.
2. **Max buy now:** the most you'll pay. Anything listed at or below this gets bought instantly.
3. *(Optional)* tick **Auto-list** to relist bought items automatically, either at a fixed
   **Sell price** or automatically at break-even after EA's 5% tax plus **Min profit**.
4. Press **Start** (or **Alt+S** on desktop, **▶** on phone).

### How it snipes
- Every search changes the min-bid filter, so EA returns fresh listings instead of cached ones.
- Listings at or below your max buy are sorted cheapest first and bought with Buy Now.
- Delays between searches are random, and it takes a longer rest every N searches.
- It **stops automatically** on a captcha or verification prompt (458/459), on rate limiting
  or a soft ban (429/521/512), on a session expiry, when coins run out, or when it hits your
  search or buy limits. An alarm sounds when that happens.

### Safety limits (built in)
These lower the chance of a ban. They **don't make the bot undetectable**; nothing does,
and EA bans users of every autobuyer, paid ones included.

| Limit | Default | Enforced |
|---|---|---|
| Delay between searches | 4–8 s, random | at least 3 s, with at least 1.5 s of randomness |
| Rest break | 45–120 s every 30 searches | at least 20 s, at least every 60 searches |
| Session length | 40 min | at most 120 min |
| Searches per session / per day | 250 / 600 | at most 1,500 per day |
| Buys per session / per day | 10 / 40 | |

If you type something below a minimum, it's raised back up when you press Start.
Daily counts reset at midnight and survive page reloads.

**Lockouts.** When EA pushes back, the bot stops and **won't start again** for a while,
even after you reload the page:
- captcha or verification prompt: **3 hours**
- transfer market limited or soft-banned: **24 hours**
- 3 errors in a row: **30 minutes**

**Habits that matter most:**
- Don't snipe every day for hours. A few short sessions a week is far safer.
- When a captcha appears, solve it and stop for the day. Repeated captchas come right before bans.
- Don't use this on an account you can't afford to lose.

## Develop

```
npm test
```
The pricing, tax, filtering and error-handling logic is pure and unit-tested in `test/`.
