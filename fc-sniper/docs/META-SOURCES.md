# Meta data source strategy

Status: research and integration constraints, reviewed 2026-11-27. The owner reports that FUT.GG support approved automated access for personal use; that permission is limited to the owner's local workflow and does not authorize redistribution.

## Findings

### 1. FUT.GG is the strongest current tactics-data candidate

FUT.GG's FC 27 tactics hub publishes separate community-squad and pro-squad formation usage, preferred build-up styles, defensive lines, role/focus usage, and tactic codes. Individual formation pages also show community/pro splits for roles and focuses. This makes it a much better fit for the formation/role Meta Finder than generic tier-list articles.

Public reference pages:
- https://www.fut.gg/tactics/
- https://www.fut.gg/tactics/codes/
- Example formation detail: https://www.fut.gg/tactics/4-2-1-3/

The site says its tactics are based on real squads it tracks and that the preferred tactic per formation is derived from those squads. Its editorial policy says it uses in-game data it collects directly, official EA announcements, and its own testing. That is useful provenance, but it does not establish a public API or bulk-feed entitlement. FUT.GG support told the owner that personal automated access is acceptable; the implemented local collector relies on that owner-specific authorization.

**Decision:** use only the owner's local collector for personal, non-redistributed use. It reads rendered FC 27 tactics/player-usage pages through ordinary browser navigation, never private endpoints or account credentials. Preserve source URLs and retrieval time. The source pages do not report sample denominator, patch, platform, or source observation time; mark these unknown. Authorization does not transfer to other users.

### 2. EA's FC Community API is not a general developer API

EA's 2026-07-27 announcement identifies FUT.GG, FUTBIN, and FUTWIZ as the only approved community sites at launch. The connection is user-authorized and lets those approved sites retrieve selected Ultimate Team account data (players, formations, tactics, and more); the user does not share their EA password. EA says account data pulled through this program may be retained for up to 28 days and that it was not accepting additional community-site applications at the time of the announcement.

Official references:
- https://www.ea.com/games/ea-sports-fc/news/pitch-notes-fc26-community-api-update
- https://help.ea.com/en/articles/ea-sports-fc/community-api/

**Decision:** Darkroom must not impersonate an approved partner, reverse-engineer partner access, collect EA credentials, or tell users that the Community API is directly available to this userscript. A user may choose to connect their EA account to an approved partner on that partner's own site; that does not grant Darkroom access to the partner's private API or stored data.

### 3. FUTWIZ is a secondary tactics and club-sync candidate

FUTWIZ publishes a custom-tactics database with pro-labelled setups and also offers Squad Sync through EA's official Community API partner program. The squad-sync permission is specific to FUTWIZ's own integration and does not authorize Darkroom to call private FUTWIZ endpoints or reuse account data. The public tactics catalogue is useful for cross-checking named pro tactics, but its displayed records need patch/date validation before they can be treated as current FC 27 evidence.

Public references:
- https://www.futwiz.com/custom-tactics
- https://www.futwiz.com/futwiz-sync

**Decision:** secondary reference and prospective partner/contact only. Do not automate extraction or call undocumented endpoints without written permission or a documented feed.

### 4. PaceFC is a promising pro-scene signal, not a machine feed

PaceFC publishes tournament-focused pro squad and tactics observations, including named player usage and custom tactic codes. Its recent public posts are useful for identifying event-level pro evidence, but a social post or a top-eight sample is not a representative season-wide dataset. No documented API/feed or automated reuse permission was established in this review.

Public reference: https://pacefc.gg/ (and its public social posts)

**Decision:** use only as manually verified, event-scoped evidence until a structured feed and reuse permission are available. Preserve tournament, stage, date, player restrictions, sample size, and the original post/page URL. Never generalize a restricted tournament sample into an overall meta score.

### 5. FUTBIN is not an automated scraping source

FUTBIN's published Terms of Service section 13 prohibits data mining and web scraping without written permission, with a limited pricing-data exception for students and content creators who credit FUTBIN.

Reference: https://www.futbin.com/tos

**Decision:** no FUTBIN scraper, automated page polling, or bulk extraction. Revisit only if written permission or an authorized feed is obtained, and confirm the precise scope of any exception before relying on it.

### 6. FUTWIZ is an EA-approved Community API partner, not automatically a Darkroom provider

EA names FUTWIZ as an approved partner, but that approval is for FUTWIZ's own authorized integration. It is not permission for Darkroom to call FUTWIZ private endpoints or reuse its data. No public, documented Darkroom developer feed was established during this review.

**Decision:** prospective partner/contact only; no undocumented endpoint use.

## Data products must stay separate

Do not collapse every signal into one generic "meta" number.

1. **Tactics meta:** formation, build-up style, defensive approach, line height, position role, and role focus. Track pro and community distributions separately.
2. **Player competitive meta:** selection/usage by named competitive players or tournament squads, split by position/role and patch. A player's popularity is not the same as match performance.
3. **Player community meta:** usage/pick rates or well-defined community samples. Keep poll votes, squad appearances, and player ratings as distinct metrics.
4. **Player quality/role fit:** in-game attributes and PlayStyles mapped to the chosen position and role. This is an estimate, not evidence of competitive selection.
5. **Market value:** platform-specific observed listings/price snapshots. Price is not meta and should not raise the meta score.

A provider adapter may normalize different observations to a common score only when the metric definition and transformation are documented. Never average incompatible metrics (for example, tournament win rate, player pick rate, and a community poll) simply because each can be represented as 0–100.

## Provider registry contract

Every source registration should define:
- stable source ID, publisher, source URL, access method, permission/licence status, and attribution requirements;
- product type (tactics, player-competitive, player-community, player-quality, market-price);
- game cycle, patch, platform, mode, competition, sample window, and update timestamp;
- metric name, metric definition, numerator/denominator where applicable, sample size, and raw value;
- whether the observation is pro or community evidence;
- freshness limit, source reliability rationale, and adapter/schema version.

Each imported snapshot should be immutable and timestamped. Corrections create a new snapshot rather than silently rewriting historical evidence. Reject unknown game versions, stale patches, missing sample sizes where the metric requires them, impossible percentages, and future timestamps. Show the source and freshness in the UI.

## Scoring and user experience decisions

- Keep the current 70/30 pro/community split as a provisional preference, not a scientific truth. Show both component scores and disagreement; do not hide a weak pro sample behind a large community sample.
- Apply source weights only after metric normalization and source-quality review. Cap the influence of any one publisher and deduplicate mirrored reports.
- Tactics rankings should be distribution-based (usage share, sample count, patch age), not hardcoded formation lists.
- Player scores must be position/role-specific. A card can be excellent at ST and mediocre at CAM.
- Market alternatives should compare candidates in the same role and relevant chemistry/PlayStyle context, then show score gap, price difference, and confidence. If there is no valid live evidence, label the result as a quality-fit comparison, not "meta value".
- A low-confidence score must not be used to recommend a purchase automatically.
- Never change the existing sniping/buying logic as part of the meta ingestion work. The first integration remains read-only.

## Integration gates

Do not mark live meta ingestion complete until all are true:
1. Source access is documented and permitted for the exact ingestion method.
2. At least one real, dated provider payload/export is available as a fixture.
3. The adapter preserves provenance, game/patch/platform/mode, metric, sample size, and observation time.
4. Duplicate, stale, future-dated, malformed, and cross-patch data tests pass.
5. Provider outages and stale snapshots are visible in the UI.
6. Scores are calibrated against held-out observations and displayed with confidence.
