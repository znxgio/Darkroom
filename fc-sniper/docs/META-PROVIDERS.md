# Darkroom Meta Data Providers

## Decision

**Primary meta candidate: FUT.GG.** Its FC 27 tactics hub publishes distinct pro and community views for formations, roles, build-up, and defensive-line choices. That makes it the best first source to evaluate against Darkroom's existing tactics engine.

**Independent cross-check: PaceFC / FUTFC.** Use only where the source discloses its sample, observation window, patch, and methodology. Keep each snapshot separate until the context matches.

**Market reference: FUTBIN.** Treat prices as market data, not proof of competitive effectiveness. Use it for value comparisons only after a documented/authorized data route is established.

**Club data: EA Community API through an approved partner flow only.** EA's current Help page names FUT.GG, FUTBIN, and FUTWIZ as the only approved community partners. EA says users authorize specific requests through EA's login flow; partner sites may retain pulled account data for up to 28 days. This is not a general public API for Darkroom. EA has not published a general client API contract or endpoint specification, so there is no supported direct Darkroom integration path to implement today.

## Access and compliance boundary

- FUT.GG support told the owner that automated access is acceptable for personal use. The local collector reads rendered public pages only, without FUT.GG/EA login, cookies, private endpoints, or hidden APIs.
- FUT.GG data stays on the owner's Mac for personal use. It is not published, resold, or redistributed; this account-specific approval does not extend to other users.
- Other providers remain disabled until a documented feed, API agreement, export, or provider-specific permission is verified. FUT.GG is enabled only by the owner's local bridge; the provider registry remains empty by default.
- User-authorized EA Community API access must occur through an approved partner's own consent flow; Darkroom must not collect EA passwords or tokens.
- EA's stated 28-day retention limit applies to data pulled by approved partner sites; Darkroom must not assume it inherits partner access or retention rights.
- Store only the minimum data needed, respect source retention rules, and preserve source attribution.

## Evidence model

Keep these source families separate:

| Source family | Evidence type | Darkroom use |
| --- | --- | --- |
| FUT.GG pro tactics | Pro | Formation, role, build-up, line-height meta |
| FUT.GG community tactics | Community | Broad player-base trends |
| PaceFC/FUTFC research | Pro (when sourced to pro samples) | Independent cross-check, patch trend |
| FUTBIN | Market | Price and price-history reference; not pro evidence |
| FUTWIZ / EA partner flow | User-authorized club data | Player/formation/tactics context, subject to partner access |

Each accepted snapshot must retain game cycle, patch, platform, source, metric definition, sample size, observed time, and source URL. Conflicting patches or platforms must never be silently blended. Pro evidence remains weighted above community evidence, while the UI should show both values and disagreement.

## Current implementation

- `src/meta-providers.js` holds provider profiles and their declared capabilities.
- Provider profiles are candidates, not live connections.
- `buildEvidenceRegistry()` returns an empty registry by default. A source must be explicitly authorized before its metrics can be passed to the existing snapshot validator.
- No network client or page scraper is included.
- EA's Help documentation confirms that the Community API is limited to the three approved partners and documents the 28-day account-data retention window; it does not provide a public endpoint/schema for third-party clients.
- FUTBIN market values are deliberately not converted into player-meta evidence.
- The existing player quality/role-fit score remains an estimate until validated competitive evidence is ingested.

## Next integration gate

Before enabling a live adapter, verify the exact documented endpoint/feed, authentication model, permitted use, rate limits, retention rules, attribution requirements, and whether commercial/derivative scoring is allowed. Then add a narrow adapter with fixtures and tests. Start with FUT.GG tactics snapshots; add market pricing only through a permitted route.


## Live feed integration status (27 November 2026)

Darkroom now has a secure HTTPS snapshot consumer in `src/meta-live-feed.js`. It expects a separately hosted Darkroom feed service; provider credentials must remain server-side. The feed is not pointed at any third-party site.

### Access decision

- The owner reports that FUT.GG support approved automated use for their personal workflow. Darkroom now has a Mac-only collector for rendered FUT.GG FC 27 tactics and position-usage pages. It stores a local snapshot only and must not be used to publish, resell, or redistribute FUT.GG data. This account-specific support authorization does not transfer to other users.
- Crawlora documents a hosted API for FUT.GG-derived data, but its own acceptable-use policy says customers remain responsible for source-site terms and rights. It does not grant a right to reuse FUT.GG content that FUT.GG's terms restrict.
- EA's FC Community API is not a direct Darkroom API. EA lists FUT.GG, FUTBIN, and FUTWIZ as the approved partner sites and says it is not accepting additional applications. User consent through one of those partners does not grant Darkroom a separate right to ingest that partner's data.
- PaceFC (pacefc.gg) is the strongest independent pro-meta candidate found so far: it exposes tournament-specific pro squads, most-used cards by position, and formation/role settings. Its Terms of Use (23 October 2026) prohibit scraping or automated copying of large portions without written permission and prohibit bulk/commercial reuse without asking. Request written permission for an automated personal-research feed before ingesting it. FUTSettings' terms grant personal, non-commercial viewing only and prohibit copying materials; do not ingest its tactics or player information without permission.
- Player databases and price feeds are separate data families. Do not turn card ratings, GG Ratings, price popularity, or market price into pro pick-rate evidence unless the source defines that metric.

### Adapter contracts

- `buildTacticsRegistry(authorizedSourceIds)` creates the trusted tactics-source registry. It is empty unless the local bridge reports the authorized sources.
- `buildEvidenceRegistry(authorizedSourceIds)` creates the trusted player-evidence registry. It is empty unless the local bridge reports the authorized sources.
- `meta-live-feed.js` reads a versioned snapshot from an HTTPS Darkroom feed endpoint, validates timestamps and context, and normalizes snapshots through the engine validators.
- Feed payloads cannot assign their own source reliability. The local registry controls source kind, reliability, allowed dimensions/metrics, and maximum age.
- The userscript must never contain partner API keys. A backend service is required for any credentialed provider integration.

### Current source limits

- The collector uses ordinary browser navigation and reads rendered page content. It does not use undocumented/private APIs, site cookies, account authentication, or EA account data.
- Snapshots are local, private, and time-limited. Do not deploy this bridge as a public service or copy its dataset into shared storage.
- FUT.GG pages do not disclose source sample denominators, platform scope, patch number, or source observation timestamps. Darkroom marks these as unknown and lowers confidence by using an explicit unknown-sample-size path; retrieval time is not represented as a FUT.GG publication time.
- Player usage is a popularity/selection metric, not a direct win-rate or causal performance measure. Pro and community usage remain separate.
- Account-specific authorization is not transferable. Another user must obtain their own authorization before automated use.
- The collector fails closed if the expected FC 27 rendered pages or fields are missing. The local manual snapshot flow remains available.


## Market-data integration: DataFluxor FUT Data (26 November 2026)

A documented alternative is DataFluxor's FUT Data REST API. Its published contract includes exact EA item ID card lookup, card search, console/PC market quotes, observation timestamps, stale flags, and price history. It is a market/card data provider, not a competitive tactics source. The published price is an observation of market data, not a live auction feed.

- Provider page and API contract: https://datafluxor.com/fut-data
- Search: `GET /api/v1/fut/cards/search?q=...`
- Price lookup: `GET /api/v1/fut/prices?ea_ids=...&platform=ps` (up to 500 EA item IDs)
- Authentication: `X-API-Key`, server-side only.
- Published plan: $29/month for 100,000 requests; free sandbox is illustrative only and is not production access.
- The provider documents 429 rate limits and returns observation age; Darkroom rejects stale quotes from the value-comparison index.
- No purchase or subscription is made by this repository change. Production requests require the user's own provider key.

### Implementation

- `server/meta-api.js` is a minimal Node HTTP proxy. It keeps the provider key on the server, restricts requests to search and price routes, validates IDs/platforms, applies a local per-IP rate limit, uses HTTPS, and returns no-store responses.
- `src/meta-market-provider.js` normalizes quotes, preserves exact card identity and source timestamps, and excludes stale/zero prices from value comparisons.
- `test/meta-market-provider.test.js` and `test/meta-api.test.js` cover normalization, stale data, route validation, and key isolation.
- Configure `DATAFLUXOR_API_KEY` on the server and `DARKROOM_ALLOWED_ORIGIN` to the exact Darkroom UI origin before exposing it. Do not place the key in userscript settings, local storage, or browser requests.
- Start with `npm run start:meta-api` from `fc-sniper/`; the service listens on `PORT` (default 8787). Set the environment variables in the hosting platform's secret manager. `.env.example` documents the required names without containing secrets.
- The server exposes `GET /health`, `GET /api/meta/snapshot` (reads a versioned snapshot file supplied by an authorized feed operator), `GET /api/meta/cards/search?q=...`, and `GET /api/meta/prices?ea_ids=...&platform=ps`. It is deliberately read-only.

### Competitive-meta source decision

FUTFC/PaceFC and FUTSettings remain useful public research references, but their automated ingestion rights and documented API contracts have not been verified. Their data is not scraped or silently imported. Use them as human research references until they expressly authorize a feed. FUT.GG automated collection is limited to the owner's reported personal-use permission and local bridge. A public player database or market API cannot substitute for pro pick-rate evidence.

### Remaining integration work

The DataFluxor server proxy and quote normalizer are implemented, but production connectivity requires a provider API key, a deployed Darkroom server, and wiring the returned quotes into the existing value tracker UI. The competitive tactics feed still requires an authorized source feed or licensed data export. The server can serve that snapshot from `DARKROOM_META_SNAPSHOT_FILE`; it does not collect or fabricate the underlying tactics evidence. No credentials, external subscriptions, or hosting services are provisioned by this code.


## FUT-DB Ultimate Team card data integration

FUT-DB is now implemented as Darkroom's first documented FC Ultimate Team card-data API connector.

- API documentation: https://api.futdatabase.com/api/doc/index.html
- Terms: https://fut-db.com/terms
- Account/API portal: https://app.futdatabase.com/
- Authentication: `X-AUTH-TOKEN` header, stored only on the Darkroom server.
- Implemented lookup: `GET /api/players/res/{EA resource id}` through Darkroom's `GET /api/meta/futdb/players/resource/{resourceId}` route.
- Free account supports player card lookup; full detailed stats, premium search, and player prices require premium. We only implement the documented card-by-resource-ID route so far.
- The adapter normalizes card identity, six face stats, detailed attribute groups, PlayStyles, PlayStyle+, roles, positions, skill moves, and weak foot.
- These are player-card facts. They do not count as pro-meta usage evidence or formation popularity.
- The FUT-DB terms restrict reproduction/distribution/modification of its content without permission; Darkroom uses the documented API for individual lookups and does not bulk mirror or redistribute its database. Review provider terms before public/commercial deployment.

Configure `FUTDB_API_KEY` in the server's secret manager. No API key is included in this repository. The provider API route returns 503 until a key is configured.
