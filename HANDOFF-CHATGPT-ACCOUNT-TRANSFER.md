# Darkroom — Account Transfer / Continuation Handoff

Updated: 2026-11-27  
Repository: https://github.com/znxgio/Darkroom  
Working branch: `meta-engine/foundation`  
Draft PR: https://github.com/znxgio/Darkroom/pull/3  
PR base/original branch: `claude/ea-fc-sniping-bot-jdz6vq`  
Last inspected PR head before this continuation: `111ecb4d266269e61bbd999d0071c05f4b6e103c` (the earlier implementation checkpoint was `33cb74ea58ff06b3bba2e36d94a7d13aff217a14`). See branch history and the latest Actions run for subsequent continuation commits.

## Read this first — instructions for the next ChatGPT session

Continue the existing Darkroom project from the working branch. Do not restart the project or recreate already implemented files. Fetch the latest branch contents before editing because this handoff records a point-in-time snapshot.

**Hard rules**
1. Work only on `meta-engine/foundation`.
2. Never merge PR #3 or change the original branch without the owner's explicit approval.
3. Do not change EA buying, bidding, selling, SBC submission, or account automation while working on the meta feature.
4. The owner reports FUT.GG support chat approved automated access for the owner's personal use. Keep collection local and private; no resale, public reuse, or redistribution. Do not use private endpoints, reuse cookies/tokens, or bypass access restrictions.
5. The collector reads normal rendered public FUT.GG pages only. Do not claim private club synchronization or broader provider authorization.
6. Never claim tests pass unless the latest workflow result confirms it. The last verified CI run below has an E2E failure.
7. Do not ask the owner to repeat decisions already recorded here. Make reasonable implementation decisions and report completed work, limitations, and blockers plainly.
8. Do not request or store account passwords, EA credentials, session cookies, or recovery information.
9. The owner approved committing and pushing implementation updates to `meta-engine/foundation`. Do not merge PR #3 or change the original branch.

## Product goal

Darkroom is an EA SPORTS FC Ultimate Team userscript. The meta feature should provide:

- Meta Finder for current formations, tactics, roles, and player performance.
- Player scores for cards in the user's club and players viewed in the transfer market.
- A comparison/value tracker that finds cheaper players with similar role fit, showing quality/score difference, estimated savings, confidence, and evidence freshness.
- Separate professional-player and community evidence, leaning toward professional evidence while still combining both.
- Patch/game/platform-aware and time-decayed evidence so stale or mismatched data is not treated as current.
- Automatic-first data ingestion with a transparent manual fallback.
- Read-only behavior: no automatic market transactions or squad changes as part of meta analysis.

The owner authorized the assistant to implement the architecture and UI, but not to merge into the original branch. The owner prefers a working implementation over lengthy plans and wants progress explained in clear, nontechnical language.

## Current FUT.GG / Mac plan

Desired user experience:
1. Darkroom tries an authorized automatic data import first.
2. If a valid authorized snapshot is available, import and analyze it.
3. If the bridge/feed is missing, stale, invalid, or unavailable, explain why and fall back to manual input/research.
4. Manual and automatic evidence must pass through the same validation and analysis pipeline.

Important distinction: the owner reports FUT.GG support approved automated access for personal use. This is owner-specific permission for the local workflow only. The Mac collector reads rendered public tactics pages in a fresh unauthenticated browser context; it does not access FUT.GG private account pages or EA club data. No resale, public reuse, or redistribution is allowed.

### Implemented Mac bridge

- `fc-sniper/server/futgg-bridge.js`: local Node service bound to `127.0.0.1`, default port 8765.
- `fc-sniper/scripts/start-futgg-bridge.command`: launcher script. Run it with `bash scripts/start-futgg-bridge.command` from `fc-sniper`; it opens FUT.GG tactics in a browser and starts the local service.
- `fc-sniper/test/futgg-bridge.test.js`: validates snapshot schema and size.
- `fc-sniper/docs/FUTGG-MAC-BRIDGE.md`: setup and authorization notes.
- `fc-sniper/server/futgg-personal-sync.js`: local Playwright collector for the rendered FC 27 tactics overview and twelve position-usage pages. Writes an owner-only snapshot to `~/.darkroom/futgg-meta-snapshot.json`.
- Package script: `npm run start:futgg-bridge`.
- Health endpoint: `http://127.0.0.1:8765/health`.
- Snapshot endpoint: `http://127.0.0.1:8765/api/meta/snapshot`.
- Optional snapshot file: set `DARKROOM_META_SNAPSHOT_FILE` to a local JSON file.
- The bridge's local snapshot advertises the two FUT.GG source IDs collected. No extra provider allowlist is needed for this owner-specific local workflow.

The bridge validates schema version 1, context/timestamp, arrays, collection caps, file size, freshness, and the personal-use policy. It binds to loopback, limits browser origins to EA Web App origins, and reads only its local snapshot file.

### Current implementation and limits

The Mac collector and local automatic feed are implemented. The collector reads normal rendered public pages, not an API or private account data. A real collection against the current FUT.GG pages produced 14 formations, 68 role/focus observations, 144 pro player observations, and 144 community player observations; the snapshot passed Darkroom's live-feed parser with zero rejected rows. Rows under 1% are omitted because the source reports them as ranges. FUT.GG does not publish sample denominators, platform scope, patch number, or source observation timestamps on these pages, so these remain explicitly unknown. Local retrieval time is not treated as source publication time.

This is not private club synchronization, market pricing, or proof that FUT.GG has a public API/feed. Manual snapshot import remains supported through the same validation and engine path.

The manual import UI is implemented in Squad → My player scores. It accepts user-provided schema v1 JSON, requires a permission/license confirmation and HTTPS source URLs, previews context and rejections, and sends accepted rows through the same parser and source registry as the authorized feed. The schema is documented in `fc-sniper/docs/META-MANUAL-IMPORT.md`. Imported evidence stays in page memory only. This does not mean a FUT.GG export was found or that FUT.GG import works.

Keep the collector within the owner-reported personal-use authorization and local-only policy. If any other user or public deployment is considered, obtain separate authorization first. Do not add private endpoints, account data, or redistribution.

## Architecture / key files

### Meta engine
- `fc-sniper/src/meta-engine.js`
- `fc-sniper/test/meta-engine.test.js`
- `fc-sniper/docs/META-ENGINE.md`

Provider-neutral engine: player adaptation, role/position weighting, PlayStyle priors, separate pro/community evidence, evidence recency decay, confidence/freshness, warnings, value comparisons, snapshot helpers, and tactics ranking. Current base weights/priors are configurable starting assumptions, not a verified live FC meta model.

### Providers / live feed
- `fc-sniper/src/meta-providers.js`
- `fc-sniper/src/meta-live-feed.js`
- `fc-sniper/docs/META-PROVIDERS.md`

Provider registry records capabilities and access limitations. FUT.GG ingestion is limited to this owner's personal local bridge; PaceFC remains permission-gated. FUTBIN is market reference only. FUT-DB is player-card data, not competitive meta. The feed consumer validates versioned snapshots and context.

### Market / player enrichment
- `fc-sniper/src/meta-market-provider.js`
- `fc-sniper/src/meta-futdb.js`
- `fc-sniper/server/meta-api.js`

FUT-DB enrichment is a separate card-data feature. It requires the user's own server-side FUT-DB token and a deployed HTTPS Darkroom API. It is not a replacement for FUT.GG professional/community meta and must not be represented as one.

### Userscript UI
- `fc-sniper/fc-sniper.user.js`

Existing legacy score remains a fallback. The new meta engine produces quality/role-fit estimates, not current live competitive-meta scores without external evidence. UI currently includes:
- Score my club (read-only; club, SBC storage, transfer list, unassigned).
- FUT-DB top-15 card enrichment control.
- Open FUT.GG tactics.
- Check Mac auto-import.
- Market overlay quality estimate/confidence and value tracker.

Recent UI integration displays separate pro/community formation and player usage in My Player Scores, and the local bridge status check feeds the same engine path as manual import.

### Tests
- `fc-sniper/test/meta-engine.test.js`
- `fc-sniper/test/meta-providers.test.js`
- `fc-sniper/test/meta-live-feed.test.js`
- `fc-sniper/test/meta-market-provider.test.js`
- `fc-sniper/test/meta-api.test.js`
- `fc-sniper/test/meta-futdb.test.js`
- `fc-sniper/test/futgg-bridge.test.js`
- `fc-sniper/test/futgg-personal-sync.test.js`
- Existing Playwright mocked EA Web App tests under `fc-sniper/test/e2e*.js`.

Run from `fc-sniper`:
```sh
npm install
npm test
npm run e2e
```

## Git / PR status

- Original branch: `claude/ea-fc-sniping-bot-jdz6vq` — leave untouched.
- Working branch: `meta-engine/foundation`.
- Draft PR #3: https://github.com/znxgio/Darkroom/pull/3
- PR is open, draft, and unmerged.
- Last inspected head: `111ecb4d266269e61bbd999d0071c05f4b6e103c`.
- Workflow run `45934553567` failed in the mocked E2E step after unit tests passed. Its failure was `test/e2e-filters.js`: tapping a locked toggle showed no why-toast.
- Workflow run `46023266440` on head `111ecb4d266269e61bbd999d0071c05f4b6e103c` also failed on the same locked-toggle why-toast assertion. Logs were retrieved; unit tests passed, E2E failed.
- A local continuation patch reports the lock explanation on pointer-down as well as click, because some browsers suppress click events from disabled form inputs. The full local browser suite verifies this behavior; CI verification is pending for the pushed commit.
- Local `npm test` passes all 193 tests after adding manual snapshot parser/provenance tests. The Chromium launch issue was resolved by reinstalling Playwright's browser in the configured browser cache. The complete local `npm run e2e` suite passed: `test/e2e.js`, `test/e2e-list.js`, `test/e2e-filters.js`, `test/e2e-tasks.js`, `test/e2e-trade.js`, `test/e2e-war.js`, `test/e2e-plan.js`, and `test/e2e-dry.js`. This includes the formerly failing locked-toggle explanation. After updating `test/e2e.js` to exercise manual import preview, authorization, import, and clear, that updated script passed independently. `node --check` on changed JavaScript files and `git diff --check` pass.
- The bridge was checked on isolated port 18765 because port 8765 was occupied by an unrelated Uvicorn service returning 404. The bridge's EA-origin `OPTIONS` preflight returned 204 with the expected allow-origin, methods, and Private Network Access headers; the same EA origin received `/health` 200, and an unlisted origin was denied with 403. This verifies local CORS/PNA response behavior only; it does not verify an end-to-end browser request from the EA Web App on the user's Mac.
- Check the new workflow run before claiming CI status. If it fails, retrieve logs and continue fixing it.
- Current continuation adds the FUT.GG local collector, unknown-sample handling, tactics panel, fixtures, and documentation. Full `npm test` passes 197 tests. Full `npm run e2e` passes all eight suites: `test/e2e.js`, `test/e2e-list.js`, `test/e2e-filters.js`, `test/e2e-tasks.js`, `test/e2e-trade.js`, `test/e2e-war.js`, `test/e2e-plan.js`, and `test/e2e-dry.js`. A real rendered-page collection passed through the snapshot parser (14 formations, 68 roles, 144 pro and 144 community player observations, zero rejects). Local bridge returned 200 for EA-origin health/snapshot requests and 403 for an unlisted origin. Syntax and `git diff --check` pass. GitHub Actions for this continuation has not run yet.
- The userscript's development @downloadURL/@updateURL may point to the dev branch. Before any release/merge, restore approved release URLs and verify all @require commit pins point to the intended immutable commits.

## Research conclusions already reached

- EA Community API access is restricted to approved partner sites; Darkroom does not have direct partner access.
- FUT.GG's EA partner status does not authorize Darkroom to read FUT.GG private account data.
- The owner reports FUT.GG support chat approved rendered-page automated access for personal use. This does not authorize resale, public reuse, redistribution, private account access, or use by other users.
- A third-party hosted API that republishes FUT.GG data does not by itself grant rights to reuse that data.
- No verified free all-in-one provider has been found for current player attributes, live prices, professional usage, community usage, formations, and tactics.
- The owner prefers free options and does not want invented subscriptions/API keys.
- If a legitimate authorized data source becomes available, feed it through the existing versioned snapshot and validation interfaces, not a one-off bypass.

## Suggested next actions (in order)

1. Push the current manual-import and locked-toggle fix to `meta-engine/foundation`, then inspect that exact GitHub Actions run. Do not merge PR #3.
2. If the CI E2E still fails, retrieve its log, fix the assertion/behavior, rerun unit tests, and push a follow-up to the same branch.
3. Inspect `futgg-bridge.js` and the userscript bridge check together for browser private-network/CORS behavior. Test from the actual EA Web App origin on the user's Mac. Do not report local bridge success merely because the Node process starts.
4. Run full tests and a local bridge/EA-origin check; fix any failures.
5. Commit and push the implementation to `meta-engine/foundation`, then inspect the exact CI run and update the draft PR description.
6. Ask for explicit merge approval only after the owner can review the working branch and CI is green.

## How to continue with the owner

The owner may be using a different ChatGPT account on their Mac. Do not assume that account has access to this chat's memory or GitHub connection. This document is the continuity source. If the Mac account cannot see the repository, ask the owner to grant that account's GitHub integration access or have them open the repository/PR. Do not ask them to share their ChatGPT password or email account credentials.

Keep explanations concise and distinguish clearly between:
- implemented in the repository,
- tested and passing,
- requires setup on the user's Mac,
- blocked by provider authorization or unavailable access.
