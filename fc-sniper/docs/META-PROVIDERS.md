# Darkroom Meta Data Providers

## Decision

**Primary meta candidate: FUT.GG.** Its FC 27 tactics hub publishes distinct pro and community views for formations, roles, build-up, and defensive-line choices. That makes it the best first source to evaluate against Darkroom's existing tactics engine.

**Independent cross-check: PaceFC / FUTFC.** Use only where the source discloses its sample, observation window, patch, and methodology. Keep each snapshot separate until the context matches.

**Market reference: FUTBIN.** Treat prices as market data, not proof of competitive effectiveness. Use it for value comparisons only after a documented/authorized data route is established.

**Club data: EA Community API through an approved partner flow.** EA's published partner list names FUT.GG, FUTBIN, and FUTWIZ. EA describes account-authorized access to selected Ultimate Team data. This is not a general public API key and does not authorize Darkroom to impersonate a partner, reuse a user's browser session, or call undocumented endpoints.

## Access and compliance boundary

- No scraping, private endpoints, hidden API calls, EA session-cookie reuse, or partner credential reuse.
- Publicly viewable pages are research references, not an automatic grant of automated ingestion rights.
- Automated ingestion remains disabled until a documented feed, API agreement, export, or explicit written permission is verified.
- User-authorized EA Community API access must occur through an approved partner's own consent flow; Darkroom must not collect EA passwords or tokens.
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
- FUTBIN market values are deliberately not converted into player-meta evidence.
- The existing player quality/role-fit score remains an estimate until validated competitive evidence is ingested.

## Next integration gate

Before enabling a live adapter, verify the exact documented endpoint/feed, authentication model, permitted use, rate limits, retention rules, attribution requirements, and whether commercial/derivative scoring is allowed. Then add a narrow adapter with fixtures and tests. Start with FUT.GG tactics snapshots; add market pricing only through a permitted route.
