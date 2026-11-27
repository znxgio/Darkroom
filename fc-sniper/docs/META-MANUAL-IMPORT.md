# Manual meta snapshot import

Manual import accepts user-provided data in the same schema v1 envelope used by the authorized feed. It does not fetch, scrape, or export data from a provider. The user must have permission or a license to use every source in the snapshot and confirm that in the UI.

## Envelope fields

- `schemaVersion`: `1`.
- `game`, `patch`, and `platform`: the context for this snapshot.
- `generatedAt`: an ISO timestamp no more than 72 hours old.
- `tacticsSnapshots`: an array of source snapshots with `sourceId`, `game`, `patch`, `platform`, `generatedAt`, `sourceUrl`, and a `tactics` array.
- `playerSnapshots`: an array of source snapshots with `sourceId`, `game`, `patch`, `platform`, `generatedAt`, `sourceUrl`, and an `evidence` array.

Tactics observations use `dimension`, `key`, `usageShare` (0–100), `sampleSize`, and `observedAt`; role observations also use `position`. Player evidence uses `playerId`, `position`, `kind`, `metric`, `value` (0–100), `sampleSize`, and `observedAt`. Player IDs must match the EA definition ID used by Darkroom.

`sourceId` must match a competitive-meta source already in Darkroom's provider registry. Player evidence source IDs include the metric suffix, such as the provider ID plus `:` plus one of that provider's registered metrics. Each `sourceUrl` must be HTTPS. The app assigns evidence kind, reliability, allowed metrics/dimensions, and age limits from its local provider registry; the pasted data cannot assign those values.

The accepted payload shape is:

```json
{
  "schemaVersion": 1,
  "game": "<game cycle>",
  "patch": "<patch identifier>",
  "platform": "<platform>",
  "generatedAt": "<ISO timestamp>",
  "tacticsSnapshots": [
    {
      "sourceId": "<registered tactics provider ID>",
      "game": "<game cycle>",
      "patch": "<patch identifier>",
      "platform": "<platform>",
      "generatedAt": "<ISO timestamp>",
      "sourceUrl": "https://<permitted source page>",
      "tactics": [
        {"dimension": "<formation|role|buildUp|defensiveLine>", "key": "<value>", "position": "<role position when dimension is role>", "usageShare": 0, "sampleSize": 1, "observedAt": "<ISO timestamp>"}
      ]
    }
  ],
  "playerSnapshots": [
    {
      "sourceId": "<registered provider ID:metric>",
      "game": "<game cycle>",
      "patch": "<patch identifier>",
      "platform": "<platform>",
      "generatedAt": "<ISO timestamp>",
      "sourceUrl": "https://<permitted source page>",
      "evidence": [
        {"playerId": "<EA definition ID>", "position": "<position>", "kind": "<registry-assigned pro|community>", "metric": "<registered metric>", "value": 0, "sampleSize": 1, "observedAt": "<ISO timestamp>"}
      ]
    }
  ]
}
```

Replace every placeholder and numeric example with documented source data. The supplied `kind` must match the registry; `sourceReliability` is assigned locally. Neither field can override the app's trust settings.

## Validation and behavior

- The import is limited to 1 MB and 100 source snapshots.
- The UI previews context, generation time, accepted rows, and validation rejection reasons before import.
- Envelope freshness and source snapshot/evidence freshness are checked by the same `meta-live-feed` parser and engine snapshot validators used by the authorized feed.
- Partial imports are allowed only when at least one row passes validation; rejected rows and reasons remain visible in the preview.
- Imported player evidence is matched to the exact player ID and position. It is combined with the player's quality estimate only in the selected game, patch, and platform context.
- Imported evidence remains in memory for the current page session only. It is not uploaded or persisted; clearing it restores quality-only estimates.
- Tactics and player evidence remain separate. Source IDs and source URLs are shown in the validation preview.

Do not copy restricted provider content into this schema without permission. FUT.GG's private account sync does not grant Darkroom access, and manually opening a provider page is not a data export or authorization.
