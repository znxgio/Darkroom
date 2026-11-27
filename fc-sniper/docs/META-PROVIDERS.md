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
