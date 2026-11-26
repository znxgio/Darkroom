# Darkroom Meta Engine

## Foundation milestone (0.1.0)

This is a provider-neutral, deterministic scoring core. It intentionally has **no network calls,
credentials, EA Web App calls, browser globals, or automatic transactions**.

### Data flow

1. Provider adapters retrieve data through permitted APIs, feeds, exports, or other authorized means.
2. Adapters normalize player profiles and evidence into the schema below.
3. The engine scores a player for a specific position/role and emits score provenance, confidence,
   freshness, warnings, and a breakdown.
4. A later integration layer exposes versioned snapshots to the userscript and (optionally) a website.

### Evidence contract

Each evidence item has:

- `kind`: `pro` or `community`
- `value`: normalized 0–100 evidence score for a defined metric/context
- `source`: stable source identifier
- `sourceReliability`: 0–1 reliability assigned by a source registry
- `sampleSize`: number of observations represented
- `metric`: what the value measures (e.g. competitive selection, tournament performance, community usage)
- `context`: optional game mode, platform, event, position, formation, or role context
- `observedAt`: ISO timestamp
- `url`: optional provenance URL

**Important:** providers must not mix incompatible metrics. A tournament win rate, player pick rate,
and community poll are not directly interchangeable until an adapter maps them to a documented
common 0–100 scale. Preserve raw observations and metric definitions in the data service; this
engine's normalized evidence is the scoring input, not a replacement for source data.

### Provider snapshot validation

`normalizeProviderSnapshot(raw, registry, now, options)` validates imported snapshots against a local source registry. The registry—not the payload—sets the evidence kind, reliability, allowed metrics, and freshness limit. The validator preserves game, patch, platform, and player/position context; rejects unknown sources, kind mismatches, disallowed metrics, stale/future observations, and duplicate records; and returns explicit rejection reasons. It is a validation boundary, not a live provider or network client.

Each snapshot must include `sourceId`, `game`, `patch`, `platform`, `generatedAt`, and an `evidence` array. Evidence records include `playerId`, `position`, `kind`, `metric`, `value`, `sampleSize`, and `observedAt`. The local registry supplies `kind`, `reliability`, optional `allowedMetrics`, and optional `maxAgeDays`.

### Player contract

- `id`, `name`, `overall`
- `attributes`: normalized attribute names (e.g. pace, shooting, acceleration, finishing,
  interceptions, defensiveAwareness, reflexes)
- `playStyles`: strings or objects with `name` and optional `plus`

### Current scoring policy

- Pro evidence has 70% weight; community evidence 30%.
- Evidence recency decays exponentially, with separate configurable half-lives.
- Position/role attributes and PlayStyles form a quality/fit anchor, not proof of current meta.
- Where live evidence exists, the combined evidence score contributes 75% and the quality anchor 25%.
- Confidence reflects evidence quantity, source breadth, and attribute coverage.
- Missing evidence is explicitly labeled as a player-quality estimate, not a live-meta verdict.
- Scores are per position group. Unsupported positions return no score rather than silently falling back.
- Initial attribute and PlayStyle priors are provisional heuristics, not externally validated ratings.

### What this milestone does not do

- It does not scrape FUTBIN, FUT.GG, or any other site.
- It does not assume third-party sites permit automated access.
- It does not yet retrieve live competitive/community evidence or prices.
- It does not replace the existing userscript's legacy meta scoring yet. The userscript now loads this engine and shows a clearly labeled player-quality estimate in the read-only market overlay; it explicitly warns that live evidence providers are not connected yet.
- It does not make buy, bid, sell, SBC, or squad mutations.

### Next milestones

1. Verify and select authorized sources (including API availability, licensing/terms, freshness, costs, platform coverage).
2. Build provider adapters and a source registry; keep raw evidence and source timestamps.
3. Add contract fixtures from real permitted source responses.
4. Add price adapter and value ranking separately from meta score.
5. Integrate the engine read-only into the userscript, then compare against existing outputs before replacing anything.
6. Build a calibration/evaluation set from dated competitive squads/events and holdout observations.

## Current userscript integration

- The userscript loads the engine through a commit-pinned Tampermonkey `@require` dependency.
- Existing EA player objects are adapted from Darkroom's normalized face stats and PlayStyles.
- The market overlay displays the engine's player-quality estimate and confidence beside the legacy estimate.
- This is intentionally read-only. It does not change searches, purchases, bids, listings, club state, or existing ranking decisions.
- The existing legacy score remains active until the new engine has validated live evidence and passes side-by-side comparison.

## Validation

Run:

```sh
node --test test/meta-engine.test.js
```
