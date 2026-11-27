# FUT.GG + Mac bridge

Darkroom uses an automatic-first import flow, with manual fallback. The Mac bridge
is a small local Node service bound only to `127.0.0.1`. It never reads browser
cookies, EA credentials, or hidden FUT.GG endpoints and does not scrape pages.

## Start on macOS

From the `fc-sniper` directory:

```sh
node server/futgg-bridge.js
```

The health check is `http://127.0.0.1:8765/health`. With no configured snapshot,
it reports `manual-fallback-required`; this is expected until FUT.GG provides an
authorized export/feed that can be saved locally.

## Enable automatic import

Only after obtaining written permission or a licensed FUT.GG export/feed, save its Darkroom schema
v1 JSON to a local file and start the bridge with:

```sh
DARKROOM_META_SNAPSHOT_FILE="$HOME/Darkroom/authorized-meta-snapshot.json" \\
DARKROOM_AUTHORIZED_META_SOURCES="futgg-pro,futgg-community" \\
node server/futgg-bridge.js
```

The source allowlist is intentionally empty by default. Add only the FUT.GG source IDs covered by your permission/license. The file must contain `schemaVersion`, `game`, `patch`, `platform`,
`generatedAt`, `tacticsSnapshots`, and `playerSnapshots`. The bridge serves
it at `/api/meta/snapshot`, rejects files over 1 MB and snapshots older than
72 hours, and allows browser requests only from the EA Web App origins.

## Current FUT.GG limitation

FUT.GG's EA club sync populates the user's FUT.GG account; it does not itself
authorize Darkroom to read that private account data. No documented export/feed
for Darkroom has been verified. Therefore the bridge intentionally reports the
manual fallback state until an authorized transfer mechanism is available.
Opening FUT.GG in a browser is supported as a human research step, not as
permission to automate extraction or copy bulk content.

## Security

- Listens on loopback only; no LAN exposure.
- No login/session/token collection.
- Strict Host and Origin checks; no arbitrary proxying.
- Read-only GET endpoints; no EA account or market actions.
