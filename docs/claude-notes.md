# Claude notes — running catalog

Public repo: no personal details. Add anything that could help the next session, even if small.
Newest learnings go at the end of each section. Dates are when the note was written.

## 1. How the user works and talks
- Short, casual messages, often typed on a phone while busy (once while driving). Expect typos; read for intent.
- Thinks out loud and expects Claude to fill in the details, pick the best option and say why, not list everything.
- "Reply first", "no action taken", "let's talk about": answer only, change nothing. Then wait for "go" / "yes do it".
- "Pause" / "I'm testing": don't push. They test on the real account and send back the bot's Copy log.
- Likes features "like the premium bots" (e.g. Bakers bot) and a clean, mobile-friendly UI; orange theme was a request.
- Wants the install link re-sent after every push, and only once GitHub serves the new version (raw link caches for minutes).
- Values honesty about limits: say plainly when something can't work (e.g. Gallery not in Web App) and offer what can.
- Asks for "research" when unsure; give sources.
- Enjoys experiments with the model team (Opus/Fable/Sonnet) and wants Claude to observe and write down what it learned.
- Has asked for things Claude declined: "undetectable" modes, overnight running, human-like browsing to avoid flags.
  Explain once, keep safety limits, move on — they accept it.
- Plans to make the repo private later; until then keep notes non-personal.

## 2. Environment and setup
- User runs the bot on an iPhone: Safari + the Userscripts app, inside the EA FC 27 Web App.
- Claude sessions are cloud sessions (claude.ai/code, often from the iOS app). `~/.claude` in a container is wiped per session.
- The Default cloud environment has a setup script (added 2026-11-11) that writes the model-routing team into `~/.claude`:
  `agents/big-brother.md` (Fable), `agents/big-brother-max.md` (Opus, effort max), `agents/intern.md` (Sonnet), `CLAUDE.md`, `settings.json`.
  The switch line `BIG_BROTHER: fable` → `opus-max` when Fable stops being included; change it in the setup script too.
- 2026-11-11 team v2 (user picked 1, 2, 4, 5 of Opus's suggestions): added `agents/runner.md` (Sonnet, Bash, runs given
  test/build commands and returns a <200-word summary, never edits) so long e2e output doesn't fill Opus's context;
  five-part advisor brief (Goal, Tried, Evidence, Files, Question) with ~500-word answers; advisors diagnose, Opus fixes
  (big separate fixes may go to a helper in its own worktree); intern only for 3+ mechanical edits, and it now re-reads
  its lines and lists where changed names are used. Setup script is 97 of the 100 allowed lines — keep edits compact.
- Agent files only load at session start. In the session that creates them, emulate with `Agent` + `model`/`effort` parameters.
- Old iOS app versions couldn't show environment-change approval prompts; updating the app fixed it.
- Playwright + Chromium are preinstalled; `require('playwright')` works.

## 3. fc-sniper: how to build, test, ship
- One file: `fc-sniper/fc-sniper.user.js`. Pure logic is in the top `core` object, exported via `module.exports` for tests.
- Tests: `npm test` (unit, node:test). E2E against mock Web Apps: `node test/e2e.js`, `e2e-list.js`, `e2e-filters.js`,
  `e2e-tasks.js` (longest, ~5–10 min), `e2e-trade.js`. Pass a scratch dir for screenshots. Run e2e suites in parallel.
- Shared mock: `test/mock-webapp.js` (`installMock()`): club, storage, squad, packs, SBC sets 1–7 (incl. points SBC and a player SBC).
- Release: bump `@version` header AND the `VERSION` fallback string AND package.json; update README; run all suites; commit; push
  `git push -u origin claude/ea-fc-sniping-bot-jdz6vq`; poll the raw URL until it serves the new version; send the link.
- Commit messages end with the session attribution lines; no model names.
- Python heredoc patch scripts with `assert s.count(a)==1` worked well for exact edits in the big file.
- Gotcha: a chained shell command (`grep -c … && sed …`) stops if grep finds 0 — the version bump silently didn't run once.

## 4. EA Web App facts (found the hard way)
- `observe()` replies: data is in `response` for some calls (club, packs) and `data` for others (market). Normalize both.
- Position ids → names via a fixed table (`POS_NAMES`); `positionIdToName` was wrong for our use.
- Club search: `UTBucketedItemSearchViewModel().searchCriteria`, count 90, call `resetStatsCache/getStats` first.
- Market listings go stale; buying a stale one returns 403 after the cache is cleared → search again right before buying.
- Market search returns ~20 listings per page, sorted soonest-ending. Wide price bands show 20 different cards once each
  (why the first hot-card scanner always found "none"); use narrow price bands.
- Cache busting: vary `minBid` per search so EA doesn't serve cached results.
- SBC requirement keys from `SBCEligibilityKey` (fallback table). FC 27 "OVR Min" = keys 40 (ACADEMY_PLAYER_SLOTTING) + 41 (attribute 1 = overall).
- Points (💎) SBCs are one-click challenges: `initiateOneClickChallenge`, `submitOneClickChallenge(ch, set, itemIds)`;
  max 20 cards per hand-in; card value is `item.sbsScore`; goal `scoreRequirement` / `submittedScore`; 409 = squad conflict.
  Confirmed on the real account: a 42,000 💎 SBC completed with 108 spare cards in 6 hand-ins.
- Academy (evolutions): `requestAcademyHub`, `getCategories`, `slot.meetsRequirements(item)`, `getSlotPreview(slotId, itemId)`.
- FC 27 Gallery is NOT in the Web App. `services.Showcase` is an account-entitlement check, not the Gallery.
  `services.EventToken` holds token balances; `EVENT_TOKEN_1` = "Gallery Token", `EVENT_TOKEN_2` = "Champions Token".
- The Web App has 38 services (list in the gallery-probe log). Unknown APIs: probe read-only (list methods + short source, call only request/get).
- "Logged out (403)" can appear after heavy activity; logging in again fixes it.
- Bidding: EA takes the coins off your balance as soon as you bid (user confirmed 2026-11-11), and gives them back if you're outbid.
- Auction bidding (`bidSnipe`) is OFF by default; the user had only ever seen Buy Now. Keep it off until the 2.4.0 bid spend guard ships.

## 5. Bugs we hit and why (lessons)
- Club read 0 players: reply was in `response`, not `data`.
- SBC fill-ins re-bought on retry → mark items bought, per-buy move to club. Duplicates in a plan → one copy per base id.
- Bronze/silver SBCs searched golds → derive market level from requirements.
- A 3-player SBC filled 11 → reparse after `loadChallenge`, respect brick slots.
- Hot cards "none found" → see narrow bands above; also log why each candidate was skipped.
- Sniper "never hits": 3 of 4 players were priced 3–12× the user's coins, wasting 75% of searches → skip out-of-reach
  players (max < 60% of cheapest) and log a "still sniping" summary every 25 searches so the user can see it working.
- Multi-buy per search could pass session buy limit / buy-once / Keep coins → re-check limits before each buy.
- Fable review (2026-11-11) found, and Opus verified: bidding ignores most spend limits; smart sniping ignored the user's
  discount; "nothing listed" fell back to the global default max; side jobs (SBC/points/hot/relist) skip daily caps;
  stop→start can run two loops; SBC fill-ins can exceed the limit by 15%; learner reward skew. Status in section 7.
- Lesson: limit checks added one path at a time leave holes. One shared spend guard and one pacing wrapper is the design to aim for.

## 6. Model team observations
- 2026-11-11 Fable review of the whole bot: ~200 s, read-only as told, found real coin-spending holes Opus missed, gave
  file:line, scenarios and a clear top 3. Confidence Medium and honest about what it couldn't verify. Worth it for big reviews.
- 2026-11-11 Sonnet intern, exact two-line edit (smart-sniping floor): ~9 s, did exactly what was asked, no extras.
  Lesson: give it the exact old and new lines; it then needs no judgment. It did not notice the change would break an
  e2e expectation — that is Opus's job when reviewing.

- 2026-11-11 Fable FIX of the bidding spend-limit bug (brief: change only this bug, add tests, don't touch other files):
  138 lines across 3 files; a pure `bidBlock`/`freeCoins` guard shared with Buy Now, a running committed-coins total,
  buy-once/reserve/session-cap checks, filter rating range on bids, open bids saved to localStorage and collected after a
  reload, plus unit tests and 3 e2e checks. All suites passed first try; it stayed in scope. It noticed on its own that it
  didn't know if EA takes coins on bid and detected it from the balance (the user then confirmed EA does).
  But the agent was stopped before it sent its report (an interrupted turn ends background helpers) — Opus had to
  review the diff and run the tests itself. Lessons: big fixes from big-brother are good quality but slow (~15+ min) and
  can be lost to interruptions; prefer "advisor diagnoses, Opus fixes" (team v2 rule), or run big fixes in an isolated
  worktree and check the diff, not only the report.

## 7. Open work and ideas
- Shipped in 2.3.1: bidding spend guard (Fable), smart-sniping floor (intern). Still open from the Fable review:
  "nothing listed" fallback, jobs skipping daily caps, run token for stop/start, SBC fill-in hard cap, learner reward tuning.
- Gallery collector (buy → register → resell near break-even): parked until the user checks that a Web App buy registers in the Gallery.
- User OK'd auction bidding as a sniping method (2026-11-11: "buy now is a harder snipe"). After the 2.4.0 bid spend guard:
  ask whether to switch bidding on for them; idea: let smart sniping learn auctions too (win rate per bid level, outbid rate)
  and split searches between Buy Now and auctions by what lands. Never chase outbids or bid at/above Buy Now.
- Other ideas offered: lock players, exact-card sniping, objectives claim, Discord daily summary, profit chart.
