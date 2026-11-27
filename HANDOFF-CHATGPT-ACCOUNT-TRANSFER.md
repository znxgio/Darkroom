# Darkroom — Account Transfer / Continuation Handoff

Updated: 2026-11-27  
Repository: https://github.com/znxgio/Darkroom  
Working branch: `meta-engine/foundation`  
Draft PR: https://github.com/znxgio/Darkroom/pull/3  
PR base/original branch: `claude/ea-fc-sniping-bot-jdz6vq`  
Latest PR head after adding this handoff and README links: `2d8cdb65e4cbe67f4ce820834dac2f9088e04cdd` (the earlier implementation checkpoint was `33cb74ea58ff06b3bba2e36d94a7d13aff217a14`).

## Read this first — instructions for the next ChatGPT session

Continue the existing Darkroom project from the working branch. Do not restart the project or recreate already implemented files. Fetch the latest branch contents before editing because this handoff records a point-in-time snapshot.

**Hard rules**
1. Work only on `meta-engine/foundation`.
2. Never merge PR #3 or change the original branch without the owner's explicit approval.
3. Do not change EA buying, bidding, selling, SBC submission, or account automation while working on the meta feature.
4. Do not scrape FUT.GG, use undocumented/private endpoints, reuse EA/FUT.GG cookies or tokens, or bypass access restrictions.
5. Never claim live FUT.GG import works until an authorized export/API/feed is actually obtained and tested end-to-end.
6. Never claim tests pass unless the latest workflow result confirms it. The last verified CI run below has an E2E failure.
7. Do not ask the owner to repeat decisions already recorded here. Make reasonable implementation decisions and report completed work, limitations, and blockers plainly.
8. Do not request or store account passwords, EA credentials, session cookies, or recovery information.

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

Important distinction: FUT.GG's EA account sync puts the user's club data into FUT.GG. That does **not** automatically give Darkroom permission or a technical route to read that private data. The user has discussed using their always-on Mac as a technical/human bridge. The Mac can run a local service and open FUT.GG for the user, but it must not scrape private pages/endpoints or steal/reuse browser session credentials.

### Implemented Mac bridge

- `fc-sniper/server/futgg-bridge.js`: local Node service bound to `127.0.0.1`, default port 8765.
- `fc-sniper/scripts/start-futgg-bridge.command`: launcher script. Run it with `bash scripts/start-futgg-bridge.command` from `fc-sniper`; it opens FUT.GG tactics in a browser and starts the local service.
- `fc-sniper/test/futgg-bridge.test.js`: validates snapshot schema and size.
- `fc-sniper/docs/FUTGG-MAC-BRIDGE.md`: setup and authorization notes.
- Package script: `npm run start:futgg-bridge`.
- Health endpoint: `http://127.0.0.1:8765/health`.
- Snapshot endpoint: `http://127.0.0.1:8765/api/meta/snapshot`.
- Optional snapshot file: set `DARKROOM_META_SNAPSHOT_FILE` to a local JSON file.
- Optional source allowlist: `DARKROOM_AUTHORIZED_META_SOURCES`. It is empty by default. Only configure FUT.GG source IDs after obtaining the relevant permission/license.

The bridge validates schema version 1, required game/patch/platform/generatedAt context, arrays for tactics/player snapshots, collection caps, file size, and freshness. It only serves a local authorized snapshot; it is not a FUT.GG connector or scraper.

### Current limitation — do not gloss over this

No documented FUT.GG export/feed for Darkroom has been verified. Therefore automatic import from FUT.GG is **not currently operational**. The UI's auto-check currently checks the local Mac bridge and then reports manual fallback if no authorized snapshot/source is configured. Opening FUT.GG is a human research step, not a data transfer.

The next ChatGPT should investigate only official/documented export or partner mechanisms and/or request written permission. If no route exists, finish a practical manual import UI (e.g. paste/upload a user-provided export in a documented Darkroom schema) and preserve the auto-first status check. Do not invent a FUT.GG export format and do not silently parse/scrape the FUT.GG website.

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

Provider registry records capabilities and access limitations. FUT.GG and PaceFC ingestion are permission-gated. FUTBIN is market reference only. FUT-DB is player-card data, not competitive meta. The feed consumer validates authorized versioned snapshots and context.

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

Recent UI integration adds a player-evidence variable to the engine evaluation path and a local bridge status check. Verify the exact current code and runtime behavior before extending it.

### Tests
- `fc-sniper/test/meta-engine.test.js`
- `fc-sniper/test/meta-providers.test.js`
- `fc-sniper/test/meta-live-feed.test.js`
- `fc-sniper/test/meta-market-provider.test.js`
- `fc-sniper/test/meta-api.test.js`
- `fc-sniper/test/meta-futdb.test.js`
- `fc-sniper/test/futgg-bridge.test.js`
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
- Last verified head: `33cb74ea58ff06b3bba2e36d94a7d13aff217a14`.
- Workflow run `45934553567` at the earlier implementation checkpoint completed with **failure**. Unit-test step succeeded; mocked Web App end-to-end step failed. The exact failing assertion/log has not yet been retrieved. A newer workflow run `46023192933` for the current handoff commit `2d8cdb65e4cbe67f4ce820834dac2f9088e04cdd` was **in progress** at the time of this update. Check it before claiming CI status. If it fails, retrieve the job logs and fix the E2E failure before saying CI is green.
- An earlier workflow run also had a mocked E2E failure. Do not assume that prior fix resolved all E2E issues.
- The userscript's development @downloadURL/@updateURL may point to the dev branch. Before any release/merge, restore approved release URLs and verify all @require commit pins point to the intended immutable commits.

## Research conclusions already reached

- EA Community API access is restricted to approved partner sites; Darkroom does not have direct partner access.
- FUT.GG's EA partner status does not authorize Darkroom to read FUT.GG private account data.
- Public pages and a browser-open action do not authorize automated bulk extraction.
- A third-party hosted API that republishes FUT.GG data does not by itself grant rights to reuse that data.
- No verified free all-in-one provider has been found for current player attributes, live prices, professional usage, community usage, formations, and tactics.
- The owner prefers free options and does not want invented subscriptions/API keys.
- If a legitimate authorized data source becomes available, feed it through the existing versioned snapshot and validation interfaces, not a one-off bypass.

## Suggested next actions (in order)

1. Fetch the latest `meta-engine/foundation` branch and inspect the exact state; this document is a handoff snapshot, not a substitute for current code.
2. Retrieve logs for workflow run `45934553567`; identify and fix the mocked E2E failure. Run `npm test` and `npm run e2e` locally if the environment allows.
3. Inspect `futgg-bridge.js` and the userscript bridge check together for browser private-network/CORS behavior. Test from the actual EA Web App origin on the user's Mac. Do not report local bridge success merely because the Node process starts.
4. Add the manual import experience using an explicit, documented Darkroom JSON schema with preview, validation, provenance, timestamp, patch/platform context, and rejection reasons. Keep it user-initiated.
5. Improve auto-check status so it distinguishes: Mac bridge offline; bridge online/no authorized feed; authorized snapshot stale/invalid; valid snapshot imported.
6. Research official FUT.GG export/partner permission routes. If unavailable, keep auto-first with honest manual fallback.
7. Update PR description and this handoff whenever the actual state changes.
8. Ask for explicit merge approval only after the owner can review the working branch and CI is green.

## How to continue with the owner

The owner may be using a different ChatGPT account on their Mac. Do not assume that account has access to this chat's memory or GitHub connection. This document is the continuity source. If the Mac account cannot see the repository, ask the owner to grant that account's GitHub integration access or have them open the repository/PR. Do not ask them to share their ChatGPT password or email account credentials.

Keep explanations concise and distinguish clearly between:
- implemented in the repository,
- tested and passing,
- requires setup on the user's Mac,
- blocked by provider authorization or unavailable access.
