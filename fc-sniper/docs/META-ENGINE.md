# Darkroom Meta Engine

## Foundation milestone (0.3.1)

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

### Tactics Meta Finder contract

`normalizeTacticsSnapshot(raw, registry, now, options)` validates formation and role usage distributions. The source registry supplies the pro/community classification and reliability; a payload cannot assign its own reliability. Accepted observations retain game, patch, platform, sample size, timestamp, formation, position, role/focus, tactic code, and line height. `rankTactics(observations, options)` returns separate pro and community usage shares plus a pro-first composite for formations, roles, build-up styles, and defensive-line styles. Conflicting game/patch/platform snapshots require an explicit context selection.

A tactics observation uses `dimension` (`formation`, `role`, `buildUp`, or `defensiveLine`), `key`, `usageShare` (0–100), `sampleSize`, and `observedAt`; role rows also require a supported `position`. Source adapters add the registry-assigned `kind`, `source`, and `sourceReliability`.

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
- It does not yet retrieve live competitive/community evidence, tactics distributions, or prices. The new snapshot validators and ranking functions are data contracts only; no provider is connected.
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
- The market overlay scores distinct players in each hand-viewed search result and displays their position-specific quality estimate and confidence beside the legacy price summary. It also flags cheaper, similar-fit cards within those results; these are provisional quality comparisons, not live-meta recommendations.
- The Squad tab has an explicit, read-only action to score every club card by its best available position. It reads club/storage only and makes no market searches.
- This is intentionally read-only. It does not change searches, purchases, bids, listings, club state, or existing ranking decisions.
- The existing legacy score remains active until the new engine has validated live evidence and passes side-by-side comparison.
- Detailed attributes are extracted only when the EA object exposes explicit attribute names; undocumented numeric array positions are not guessed.
- Imported evidence retains game, patch, platform, metric, player, and position context. Evaluation refuses to combine multiple game/patch/platform/metric contexts unless the caller selects one explicitly.

## Validation

Run:

```sh
node --test test/meta-engine.test.js
```
