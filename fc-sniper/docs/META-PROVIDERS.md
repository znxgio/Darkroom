# Darkroom Meta Data Providers

## Decision

**Primary meta candidate: FUT.GG.** Its FC 27 tactics hub publishes distinct pro and community views for formations, roles, build-up, and defensive-line choices. That makes it the best first source to evaluate against Darkroom's existing tactics engine.

**Independent cross-check: PaceFC / FUTFC.** Use only where the source discloses its sample, observation window, patch, and methodology. Keep each snapshot separate until the context matches.

**Market reference: FUTBIN.** Treat prices as market data, not proof of competitive effectiveness. Use it for value comparisons only after a documented/authorized data route is established.

**Club data: EA Community API through an approved partner flow only.** EA's current Help page names FUT.GG, FUTBIN, and FUTWIZ as the only approved community partners. EA says users authorize specific requests through EA's login flow; partner sites may retain pulled account data for up to 28 days. This is not a general public API for Darkroom. EA has not published a general client API contract or endpoint specification, so there is no supported direct Darkroom integration path to implement today.

## Access and compliance boundary

- No scraping, private endpoints, hidden API calls, EA session-cookie reuse, or partner credential reuse.
- Publicly viewable pages are research references, not an automatic grant of automated ingestion rights.
- Automated ingestion remains disabled until a documented feed, API agreement, export, or explicit written permission is verified.
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

- FUT.GG remains the strongest candidate for pro/community usage and role/tactics coverage, but its published content terms restrict automated access and use that competes with or substitutes for its service. Treat its tactics page as a human research reference only until Stormstrike grants written permission or a suitable data license.
- Crawlora documents a hosted API for FUT.GG-derived data, but its own acceptable-use policy says customers remain responsible for source-site terms and rights. It does not grant a right to reuse FUT.GG content that FUT.GG's terms restrict.
- EA's FC Community API is not a direct Darkroom API. EA lists FUT.GG, FUTBIN, and FUTWIZ as the approved partner sites and says it is not accepting additional applications. User consent through one of those partners does not grant Darkroom a separate right to ingest that partner's data.
- FUTFC/PaceFC is a useful independent research cross-check where sample windows and patch labels are published, but it is not yet an approved automated source. Confirm its terms and obtain permission before automated ingestion.
- Player databases and price feeds are separate data families. Do not turn card ratings, GG Ratings, price popularity, or market price into pro pick-rate evidence unless the source defines that metric.

### Adapter contracts

- `buildTacticsRegistry(authorizedSourceIds)` creates the trusted tactics-source registry. It is empty by default.
- `buildEvidenceRegistry(authorizedSourceIds)` creates the trusted player-evidence registry. It is empty by default.
- `meta-live-feed.js` reads a versioned snapshot from an HTTPS Darkroom feed endpoint, validates timestamps and context, and normalizes snapshots through the engine validators.
- Feed payloads cannot assign their own source reliability. The local registry controls source kind, reliability, allowed dimensions/metrics, and maximum age.
- The userscript must never contain partner API keys. A backend service is required for any credentialed provider integration.

### Remaining blocker

A live provider is not connected yet. The next step is a written data permission/feed agreement with FUT.GG or another source that can provide dated pro and community observations, plus a hosted feed endpoint. No scrape, undocumented API, third-party proxy, EA login token, or manual hardcoded meta snapshot will be used as a substitute.


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

### Competitive-meta source decision

FUTFC/PaceFC and FUTSettings remain useful public research references, but their automated ingestion rights and documented API contracts have not been verified. Their data is not scraped or silently imported. Use them as human research references until they expressly authorize a feed. FUT.GG remains permission-required. A public player database or market API cannot substitute for pro pick-rate evidence.

### Remaining integration work

The DataFluxor server proxy and quote normalizer are implemented, but production connectivity requires a provider API key, a deployed Darkroom server, and wiring the returned quotes into the existing value tracker UI. The competitive tactics feed still requires an authorized source feed or licensed data export. No credentials, external subscriptions, or hosting services are provisioned by this code.
