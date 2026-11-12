# Claude notes — running catalog

Public repo: no personal details. Add anything that could help the next session, even if small.
Newest learnings go at the end of each section. Dates are when the note was written.

## 0. Handover (latest first)
- 2026-11-12, end of the long first session (context got very large → user starts a fresh chat). State: fc-sniper
  2.4.4 (refresh buttons per feature, stuck-task rescue, Ask Claude, log copy markers/1,500 lines, median pricing,
  30-min + early reprice, starter filters, budget line, META_NOTES + "Best XI from your club", price history/trends,
  🔎 look-up links, QoL fixes). User has NOT yet tested 2.4.x on the real account beyond out-of-reach + bidding on.
  Next: wait for the user's test log (they'll paste "Copy log"); then the open QoL items in §5 and the Gallery
  collector (§7) if they confirm a Web App buy registers in the Gallery. Keep usage low: debates only when unsure,
  use the runner for test suites, read only the log lines the user pastes.

- 2026-11-12, session 2: first real-account log of 2.4.4. Hot scan with `rarities:[1]` + level gold + league +
  min/maxBuy returned 0 listings in all 5 bands (PL, LaLiga, Bundesliga, Serie A, Ligue 1, 4.4k–60k); without rarities
  the same sweep found 189 listings → our Rare filter is probably not how EA builds it (also affects filter Rarity and
  SBC rare searches). 2.4.5 adds a read-only "Record my next 3 market searches" (wraps searchTransferMarket, logs only
  the Web App's own calls, restores after 3 or 3 min) and skips rare-only for the rest of the session once it came back
  empty. Next: user records a hand search with Rarity = Rare → copy those exact fields into newCriteria/criteria/sbc.

- 2026-11-12, session 2 (cont.): pricing debate (Sonnet A learner-core / B rule-core / referee; Opus observer) →
  2.4.6 (2.4.5 folded in, never pushed alone). Findings verified in code: with zero hits Thompson score p·d favoured the
  DEEPEST arm (prior b∝d, but ev ∝ d) → dry spells drifted to 14%; probes on the shallowest arm credited nothing;
  learner in trade mode was always deeper than flipPlan's ~8% cap (only lowered buys); bid-turn searches never record.
  Shipped: buy = Snipe % under robust cheapest (robustLow), trade = flipPlan(min(avg, 2nd cheapest) − trend nudge),
  trendNudge (falling only, ≤3 pts, needs 24 h), learner picks targets only unless `smartPrice` (new, off),
  depth credit only with evidence, probe gaps (recordGap/gapStats) on the Learning card + heartbeat.
  User's framing: "multi-source decision" = anchor (live listings) + capped nudges, not an equal vote. Next: turn
  on probe/learner nudges once logs show ≥30 probes per card; still open: count bid-turn searches.
- Slow-turn lesson (user said "taking a super long time"): don't wait for one release's full suite before starting
  the next; fold small releases together and run every suite once. e2e-tasks can time out when a random 80–120 s
  safety rest lands in "Analyse" (200 s wait) — timing, not code.

- 2026-11-12, session 2 (cont.): 2.4.7 = session plan (debate: strict fixed plan beat a "smart scorer" because
  repeats-left/expiry/pack-reward values are NOT readable; observer found lockouts EXPIRE (3 h captcha) so the plan
  needs its own end-on-any-pushback, jobs.run returned nothing (now true on success), spendLimit only covers Buy-list
  mode → plan uses one coin floor via a temporary Keep coins) + little brother's additions (summary line, Discord on
  end) + keep-alive (user argued a "don't log me out" ping isn't disguise — agreed: transfer-list read every ~10 min in
  breaks, never a market search) + health check before each block (can only stop, never restart) + the observer's
  UI fixes (done by a Sonnet helper in a worktree, merged). User wants work delegated to parallel agents
  ("remind the text chains, they ghost"). User felt Claude applied EA's terms harder than EA does: clarified the
  line = no disguise features + keep the safety caps (user-adjustable within them); everything else is their call.
- Test seam: localStorage 'fc-sniper:test-minute-ms' shortens plan break minutes (test/e2e-plan.js).

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
- Auctions: a bid placed with under ~30 s left EXTENDS the timer (to ~30 s or 1 min, user, 2026-11-12) — so bid wars are real
  back-and-forths. Models in a debate wrongly assumed no extension: trust the user's real-app knowledge over model memory.
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

- 2026-11-12 "debate" test: agent teams can't run in this cloud/SDK session (Agent tool has no `name`; teams need an
  interactive terminal). Ran a relayed debate instead: 3 Sonnet subagents (Aggressive / Cautious / Referee), ~10 s each,
  round 2 via SendMessage. Useful: Cautious caught the after-tax ceiling, Aggressive the headroom rule, Referee shared
  request pacing. The Referee's EA fact (no timer extension) was wrong; the user corrected it. Cheap and worth it for design questions.

- 2026-11-12 first debate WITH an observer (learner redesign): Exploit vs Explore (Sonnet), Referee (Sonnet, read the
  code: confirmed all 5 review claims + found good>n and unused stored data), Observer (Opus). The Observer found what all
  three missed: hits/misses counted per listing vs n per search; BOTH sides had the near-miss credit direction wrong;
  Exploit's prior math was off and in round 3 its depth scaling pointed the wrong way; near credit to an unsearched arm
  inflates it. Shipped the Observer's closing design in 2.4.1; all suites passed first try. The observer role is clearly
  worth it — keep it on Opus. Cost: ~8 agent runs, ~10-90 s each.

- 2026-11-12 two debates in parallel (agents loaded at session start this time: runner used for all suites):
  * Jobs vs limits: Strict vs Practical mostly agreed; Referee confirmed jobs could start with daily caps used up and had
    no mid-job checks; Observer added: one shared pacing clock, rests counting job calls, refuse up front when a job needs
    more buys than are left. Shipped as `jobs.gate()` (hooked into fut.search/buy/placeBid/list when a job runs) in 2.4.2.
  * Trade defaults: Volume vs Margin far apart; the Referee's flipPlan math (max buy ~88–89% of avg either way, profit per
    flip 2.3× with Margin) settled most of it; Observer: keep undercut 3, pct 4, 3 h listings (phone users leave between
    sessions), maxBuys 12, add a per-card cap (`tradeBudgetPct` 25) enforced on trade buys. Changed defaults are migrated
    only where the user still had the old default (flag `trade242`). Skipped the rebuttal round when the referee's numbers
    already settled it — saves ~2 agent runs.
- Running all 6 browser suites in parallel PLUS another suite can crash e2e-tasks ("Target page closed" ~9 min in) from load —
  rerun it alone before suspecting the code. e2e-tasks now takes ~10–12 min (3 s job pacing).
- Runner subagent: ~8 min for all 6 suites in parallel, returns 10 lines — big context saving vs reading suite output.

- 2026-11-12 data-source research: FUTBIN and FUTWIZ return 403 to automated requests (bot protection — never try to get
  around it). FUT.GG is reachable but its Terms forbid "any automated means (bots, scrapers, crawlers)" and robots.txt
  disallows /api/*. So the bot never fetches these sites. FUT.GG search URLs (?name=/?search=) didn't return results
  server-side; look-up links use a Google site:fut.gg search instead (user taps it).
- Debates 2026-11-12 (data + sniping, 2 sides + referee + observer each):
  * Data → shipped: META_NOTES (dated, sourced: Liquid FC 21 Oct 2026 = 4-1-2-1-2(2); Dexerto launch = 4-2-1-3, Counter,
    line 55/45; sources disagree, shown as such), coach relabelled "Best XI from your club", weakest spots, 4-2-1-3 added
    with noCreate (EA slot order unconfirmed), local price history (KEYS.prices, ≤400 KB, 7 days, trend only with ≥4
    samples over ≥24 h), 🔎 look-up links. Skipped: paste import, EA service probe (unproven), player lists (stale fast).
    Refresh META_NOTES when the meta changes (search public guides; show date + source; never claim a winner).
  * Sniping → the daily cap binds (defaults ≈390 searches/h, 600/day). Shipped: median-of-5 price (robustPrice), 30-min
    reprice + early reprice when ≥3 copies show under max, starter filters (off), daily budget line. Rejected: "max =
    0.85 × median of own results" (searches only return listings ≤ max → circular), moving bookkeeping after the buy
    (1–5 ms), per-slice scoring (too little data at 600/day).
- User log habits: Copy log now copies only lines since the last copy and adds a "📋 Log copied" marker; "Copy full
  log" for everything; log keeps 1,500 lines; details (debugLog) survive reloads.
- User asked for "login to Claude inside the bot": not possible safely (would need an API key stored in the EA page's
  storage, readable by other scripts). Built "Ask Claude" instead: copies question + new log lines, opens claude.ai.
- QoL review (Sonnet, 12 items) 2026-11-12: fixed stop bar for tasks, running bar, errors as toasts, ID hints, tap
  targets, reset-to-defaults, auto-save before restore. Still open: one-row scrollable tabs (8 tabs take 2 rows),
  "Advanced" section for bid-war/win-rule settings, inline copy box instead of prompt(), toast position on phone,
  clearer auto vs manual max chips, league chips instead of IDs.

- 2026-11-12 two-advisor review of 2.4.6 (user's ask: "big brother + little brother"; user wants the cheapest big
  brother = Opus, and at HIGH effort, not max — "knowledge difference minimal, usage big"; pass effort:'high' and
  ask to change the setup script). Sonnet little brother (14 s): 6 "check this" items from skimming, 1 real (log
  wording). Opus big brother (~8 min, no shell, read the file): real finds — wrong-version buys (maskedDefId hunts,
  pickTargets never checked defId; fixed), floor = a listing about to be sniped (tightened robustLow), trend recorded
  outlier lows (now floor), thin trade markets (<3 listed → no trade), global Rarity may blind every hunt (ask user),
  and the key insight: 10% under is where sub-second flip bots win; snipe inside the tax band (4%) → user said yes.
  One factual slip: claimed 10% under cheapest ≈ 12–15% under the old max (really ~1–3%). Verify advisor numbers.

## 7. Open work and ideas
- Shipped in 2.3.1: bidding spend guard (Fable), smart-sniping floor (intern). 2.4.2 fixed: nothing-listed fallback, stop/start run token, SBC hard cap, jobs vs caps. Still open from the Fable review (as of 2.4.2: only minor items — fixed sellMode has no profit floor; price checks don't count toward session maxSearches; special-version id buys):
  "nothing listed" fallback, jobs skipping daily caps, run token for stop/start, SBC fill-in hard cap, learner reward tuning.
- Gallery collector (buy → register → resell near break-even): parked until the user checks that a Web App buy registers in the Gallery.
- Shipped 2.4.0 (2026-11-12): bid wars per the debate + user's Buy Now rule (pure: warCeiling, warSteps, binVsWar;
  runtime: engine.warDue/warCheck/collectWon; test/e2e-war.js with a rival + timer extension). Bidding switched on once via
  migrateConfig flag `bidOn240`. Note: under 10k bids step by 100, so 5 counter-bids only cover ~500 coins there — if the
  user finds wars on cheap cards end too early, consider a price-room stop instead of a fixed counter count (Aggressive's idea).
- User OK'd auction bidding as a sniping method (2026-11-11: "buy now is a harder snipe"). After the 2.4.0 bid spend guard:
  ask whether to switch bidding on for them; idea: let smart sniping learn auctions too (win rate per bid level, outbid rate)
  and split searches between Buy Now and auctions by what lands. Never chase outbids or bid at/above Buy Now.
- Other ideas offered: lock players, exact-card sniping, objectives claim, Discord daily summary, profit chart.

## 8. Debate protocol (user's design, 2026-11-12)
Use when Opus is unsure about an idea or design. Relay it with background subagents + SendMessage (agent teams don't run here).
- **Side A** and **Side B** (Sonnet, medium effort): argue opposite positions (e.g. aggressive vs cautious). Max ~250 words, top 2 changes.
- **Referee** (Sonnet): checks claims against real-world rules (EA behavior, safety limits, the code) and flags contradictions.
- **Observer** (Opus, default effort): takes no side and adds nothing to the opening round. Reads every round. After each
  round speaks only if the referee missed something or one side is clearly wrong. At the end gives his own unbiased opinion;
  he notes who argued better but doesn't decide by "who won".
- Rounds: 1) openings, 2) rebuttals with the others' points, 3) observer's closing view. Opus decides.
- Then: confident → build and push. Still a judgment call for the user (money risk, account-visible behavior) → ask.
- The user's real-app knowledge beats model memory (e.g. the auction timer extension the referee got wrong).
