# Handover — start here (new session)

You are picking up a long-running project. The previous session ran out of room; everything you need is in this repo.
This repo is **public**: never write personal details (names, emails, account data, coin balances) anywhere in it.

## 1. First 5 minutes (do these in order, quietly)
1. Read `CLAUDE.md` (quick rules) and `docs/claude-notes.md` (the full catalog — §0 handover, §1 how the user works,
   §4 EA Web App facts, §5 bugs and lessons, §6 model-team observations, §7 open work, §8 debate protocol).
2. Check the branch: `git checkout claude/ea-fc-sniping-bot-jdz6vq && git pull`. Work and push only there. No PRs unless asked.
3. Check the version: `grep -m1 "@version" fc-sniper/fc-sniper.user.js` and compare with the raw install link
   (https://raw.githubusercontent.com/znxgio/Darkroom/claude/ea-fc-sniping-bot-jdz6vq/fc-sniper/fc-sniper.user.js).
4. Check the model team loaded: you should have agent types `big-brother` (Fable), `big-brother-max` (Opus, max),
   `intern` (Sonnet) and `runner` (Sonnet), and `~/.claude/CLAUDE.md` with the routing rules. They come from the
   Default cloud environment's setup script — nothing to set up. If they're missing, tell the user in one line;
   don't rebuild them unless asked (the script content is in claude-notes §2).
5. Run `cd fc-sniper && npm test` (unit tests, ~2 s). Leave the browser suites to the runner when you change code.

Then answer the user. Don't recap all of this to them — one or two lines is enough ("caught up, on 2.4.x, ready").

## 2. Who you're working with (short version — details in claude-notes §1)
- Casual, short messages from a phone, often while busy; typos — read for intent. Pick the best option and say why.
- "Reply first" / "no action taken" / "let's talk about" = discuss only, change nothing.
- "Pause" / "I'm testing" = don't push.
- They test on their real account and paste the bot's log ("Copy log" now sends only new lines since the last copy).
- They like debates for unsure decisions (protocol in claude-notes §8: two sides + referee on Sonnet, observer on Opus).
- They care about usage: keep turns lean, debates only when genuinely unsure, runner for test suites.

## 3. The project
- `fc-sniper/fc-sniper.user.js` — one big userscript for the EA FC 27 Web App, run on iPhone Safari via the
  Userscripts app. Pure logic lives in the `core` object (exported for tests); runtime objects: `fut` (Web App
  adapter), `engine` (sniper loop, bidding, wars, upkeep), `jobs` (side tasks + shared gate), `sbc`, `upgrades`,
  `packs`, `evos`, `hot`, `learn` (smart sniping), `prices` (price history), `ui`.
- Tests: `npm test` (unit), and browser suites `test/e2e.js`, `e2e-list.js`, `e2e-filters.js`, `e2e-tasks.js`
  (slowest, ~10–15 min), `e2e-trade.js`, `e2e-war.js` against mock Web Apps (`test/mock-webapp.js` and inline mocks).
- `fc-sniper/README.md` lists every feature — keep it in sync.

## 4. How to ship a change (every time)
1. Make the change. Add/adjust unit tests for pure logic; extend an e2e suite for behavior.
2. Bump the version in three places: `// @version` header, the `VERSION` fallback string (`|| 'x.y.z'`), `package.json`.
3. Update README and `docs/claude-notes.md` (add what you learned — even small things).
4. Hand the runner all suites; fix failures (often the test's expectations — EA prices round to steps: 100 under 10k,
   250 under 50k).
5. Commit (message ends with the session attribution lines from the system prompt; never put model names in commits
   or code), `git push -u origin claude/ea-fc-sniping-bot-jdz6vq`.
6. Poll the raw link until it serves the new `@version`, then send the user the link + what to test.
Never push untested code: the install link updates the user's phone directly.

## 5. Hard rules
- Safety limits stay (≥3 s jittered delays, rests, session/daily caps, lockouts). Never build detection evasion.
- Anything that spends coins goes through the shared limits (Keep coins, spend limit, buy-once, caps, per-card cap).
- Never automate FUTBIN/FUTWIZ (they block bots) or FUT.GG (Terms forbid automated access). User-tapped links are fine.
- Trust the user's real-app knowledge over model memory (e.g. late auction bids extend the timer).

## 6. Where things stand
See claude-notes §0 (latest state + next steps) and §7 (open work). In short: waiting for the user's real-account
test of 2.4.x (bid wars, smart sniping, hot cards with the new fallback, SBC buys, Analyse with SBC players,
refresh buttons). Fix what their log shows first.
