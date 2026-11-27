# FUT.GG personal Mac bridge

The owner reports that FUT.GG support approved automated access for personal use. Darkroom keeps the resulting data on the owner's Mac and does not publish, resell, or redistribute it. The collector reads only rendered FUT.GG pages that a user can open normally; it does not call site-internal endpoints, sign in, read browser profiles, or collect EA club data.

## Start

From the `fc-sniper` directory:

```sh
npm install
npx playwright install chromium
bash scripts/start-futgg-bridge.command
```

The launcher opens the FUT.GG tactics page and starts `server/futgg-bridge.js`. The bridge runs an initial local sync and repeats it every six hours. It renders the FC 27 tactics overview and the twelve position-specific Most Used Players pages, then writes a schema v1 snapshot to `~/.darkroom/futgg-meta-snapshot.json` with owner-only file permissions. The browser context is temporary and unauthenticated; the current pages used for competitive meta are public.

The bridge listens only on `127.0.0.1:8765`. The EA Web App reads `http://127.0.0.1:8765/health` and `/api/meta/snapshot`. Only the EA Web App origins are allowed. The snapshot is private to this local workflow.

## Data and limits

- Pro and community evidence stays in separate source registries and score fields.
- FUT.GG publishes player and formation usage percentages but the pages checked do not publish sample denominators, patch numbers, platform scope, or source observation timestamps. Darkroom preserves those as unknown; it does not invent values. The snapshot's `generatedAt` and evidence `observedAt` mean retrieval time.
- The player pages expose exact FC 27 EA resource IDs in their normal player links, so observations can be matched to card IDs and positions.
- The page data is usage/popularity evidence, not a win-rate or causal performance measurement.
- Only the source pages in the collector are visited. The sync is paced and runs every six hours.
- No account credentials, EA session, FUT.GG cookie, private club sync, market data, or player personal information is read.

If FUT.GG changes the rendered page structure or game cycle, the sync fails closed and keeps the previous snapshot. The bridge reports manual fallback when the saved snapshot is missing, invalid, or older than 72 hours.

## Optional controls

Set `DARKROOM_FUTGG_PERSONAL_SYNC=0` to disable automatic collection while keeping the local bridge available. Setting `DARKROOM_META_SNAPSHOT_FILE` points the bridge to a manually supplied authorized snapshot and disables the page collector, so that file is not overwritten. Do not point it at a shared or public location.

## Account sync

FUT.GG's EA account synchronization is not used by this integration. It imports only the competitive meta fields displayed on the public tactics pages. Private club data remains inside FUT.GG and the EA Web App.
