/* Darkroom Meta Provider Registry — no network or scraping.
 * Provider profiles describe candidate sources and the evidence they can supply.
 * Ingestion stays disabled until a documented feed or explicit permission exists.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DarkroomMetaProviders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROVIDERS = Object.freeze([
    {
      id: 'futdb-card-data',
      name: 'FUT-DB — Ultimate Team Card Database',
      url: 'https://fut-db.com/',
      category: 'player-card-data',
      kind: 'data',
      capabilities: ['player-card-lookup-by-ea-resource-id', 'detailed-attributes', 'playstyles', 'roles', 'player-prices-premium'],
      evidenceMetrics: [],
      access: 'documented-api-key',
      automatedIngestion: true,
      status: 'api-key-required',
      reliability: 0.80,
      notes: 'Documented FC 27 REST API. Free account provides card lookup by EA resource id; full stats, player search and prices require premium. Card attributes are not competitive pro-usage evidence.'
    },
    {
      id: 'futgg-pro',
      name: 'FUT.GG — Pro Tactics',
      url: 'https://www.fut.gg/tactics/',
      category: 'competitive-meta',
      kind: 'pro',
      capabilities: ['formation-usage', 'role-usage', 'build-up-usage', 'defensive-line-usage', 'tactic-codes', 'player-role-fit'],
      evidenceMetrics: ['pro-formation-usage', 'pro-role-usage', 'pro-build-up-usage', 'pro-defensive-line-usage'],
      access: 'public-reference-restricted',
      automatedIngestion: false,
      status: 'permission-required',
      reliability: 0.82,
      notes: 'Public FC 27 tactics pages visibly separate pro and community usage, but published content terms restrict automated access and competing use. Human research reference only until written permission or a suitable license is obtained.'
    },
    {
      id: 'futgg-community',
      name: 'FUT.GG — Community Tactics',
      url: 'https://www.fut.gg/tactics/',
      category: 'competitive-meta',
      kind: 'community',
      capabilities: ['formation-usage', 'role-usage', 'build-up-usage', 'defensive-line-usage', 'player-role-fit'],
      evidenceMetrics: ['community-formation-usage', 'community-role-usage', 'community-build-up-usage', 'community-defensive-line-usage'],
      access: 'public-reference-restricted',
      automatedIngestion: false,
      status: 'permission-required',
      reliability: 0.72,
      notes: 'Keep community squad trends separate from pro tactics observations. Automated ingestion requires written permission or a suitable license.'
    },
    {
      id: 'pacefc-pro',
      name: 'PaceFC — Pro Tactics Research',
      url: 'https://pacefc.gg/meta/cards',
      category: 'competitive-meta',
      kind: 'pro',
      capabilities: ['formation-usage', 'tactic-codes', 'patch-comparison'],
      evidenceMetrics: ['pro-formation-usage'],
      access: 'public-reference-restricted',
      automatedIngestion: false,
      status: 'permission-required',
      reliability: 0.76,
      notes: 'Strong potential pro source: tournament-specific pro squads, player pick rates by position, and formation/role usage. PaceFC terms prohibit scraping or automated bulk copying without written permission and restrict bulk/commercial reuse; request permission before ingestion.'
    },
    {
      id: 'datafluxor-fut-market',
      name: 'DataFluxor FUT Data — Player Cards and Market Prices',
      url: 'https://datafluxor.com/fut-data',
      category: 'market-data',
      kind: 'community',
      capabilities: ['player-card-search', 'card-attributes', 'exact-card-identity', 'console-prices', 'pc-prices', 'price-history'],
      evidenceMetrics: [],
      access: 'documented-api-key',
      automatedIngestion: true,
      status: 'api-available-key-required',
      reliability: 0.78,
      notes: 'Documented REST API for FC 27 Ultimate Team cards and observed prices. Use server-side X-API-Key only. Price and card data are market/player facts, never pro-meta evidence.'
    },
    {
      id: 'futsettings-pro',
      name: 'FUTSettings — Pro Tactics Reference',
      url: 'https://futsettings.com/',
      category: 'competitive-meta',
      kind: 'pro',
      capabilities: ['formation-usage', 'pro-player-reference', 'tactic-settings'],
      evidenceMetrics: [],
      access: 'public-reference',
      automatedIngestion: false,
      status: 'human-research-only',
      reliability: 0.70,
      notes: 'Public pro formation and player reference. Terms grant personal non-commercial viewing only and prohibit copying materials; do not ingest, copy, or redistribute without permission.'
    },
    {
      id: 'futbin-market',
      name: 'FUTBIN — Market Reference',
      url: 'https://www.futbin.com/',
      category: 'market-data',
      kind: 'community',
      capabilities: ['market-price-reference', 'player-database', 'price-history-reference'],
      evidenceMetrics: [],
      access: 'authorized-partner-site',
      automatedIngestion: false,
      status: 'candidate',
      reliability: 0.70,
      notes: 'Potential price cross-check only. Do not treat price popularity or community votes as pro-meta evidence. No private API or scraping assumed.'
    },
    {
      id: 'futwiz-club',
      name: 'FUTWIZ — Club Data Partner',
      url: 'https://www.futwiz.com/',
      category: 'club-data',
      kind: 'community',
      capabilities: ['authorized-club-data-integration'],
      evidenceMetrics: [],
      access: 'authorized-partner-site',
      automatedIngestion: false,
      status: 'candidate',
      reliability: 0.70,
      notes: 'EA lists FUTWIZ among Community API launch partners. This does not grant Darkroom direct API access.'
    },
    {
      id: 'ea-community-api',
      name: 'EA SPORTS FC Community API',
      url: 'https://help.ea.com/en/articles/ea-sports-fc/community-api/',
      category: 'official-account-data',
      kind: 'community',
      capabilities: ['authorized-club-data', 'formations', 'tactics'],
      evidenceMetrics: [],
      access: 'partner-approval-and-user-consent',
      automatedIngestion: false,
      publicApiSpec: false,
      partnerRetentionDays: 28,
      status: 'not-available-to-darkroom',
      reliability: 1,
      notes: 'EA documents approved partner access but does not publish a general client API contract. Only FUT.GG, FUTBIN, and FUTWIZ are approved; account-data access is partner-owned and user-authorized. EA states partner retention is limited to 28 days.'
    }
  ]);

  function listProviders() {
    return PROVIDERS.map(provider => ({ ...provider,
      capabilities: [...provider.capabilities], evidenceMetrics: [...provider.evidenceMetrics] }));
  }

  function getProvider(id) {
    const provider = PROVIDERS.find(item => item.id === String(id));
    return provider ? { ...provider, capabilities: [...provider.capabilities],
      evidenceMetrics: [...provider.evidenceMetrics] } : null;
  }

  // Produces the player-evidence registry only for sources the caller has
  // explicitly marked as authorized. Candidate status alone never enables ingest.
  function buildEvidenceRegistry(authorizedSourceIds = []) {
    const authorized = new Set(authorizedSourceIds.map(String));
    const registry = {};
    for (const provider of PROVIDERS) {
      if (!authorized.has(provider.id) || provider.evidenceMetrics.length === 0) continue;
      for (const metric of provider.evidenceMetrics) {
        registry[provider.id + ':' + metric] = {
          kind: provider.kind,
          reliability: provider.reliability,
          allowedMetrics: [metric],
          maxAgeDays: 45
        };
      }
    }
    return registry;
  }

  // Tactics snapshots use one source ID per provider and a separate dimension allowlist.
  // Only enable these after written permission or a documented licensed feed is recorded.
  function buildTacticsRegistry(authorizedSourceIds = []) {
    const authorized = new Set(authorizedSourceIds.map(String));
    const registry = {};
    const dimensions = {
      'futgg-pro': ['formation', 'role', 'buildUp', 'defensiveLine'],
      'futgg-community': ['formation', 'role', 'buildUp', 'defensiveLine'],
      'pacefc-pro': ['formation'],
      'futsettings-pro': ['formation']
    };
    for (const provider of PROVIDERS) {
      const allowedDimensions = dimensions[provider.id];
      if (!authorized.has(provider.id) || !allowedDimensions) continue;
      registry[provider.id] = {
        kind: provider.kind,
        reliability: provider.reliability,
        allowedDimensions: [...allowedDimensions],
        maxAgeDays: 45
      };
    }
    return registry;
  }

  function buildFeedRegistry(authorizedSourceIds = []) {
    return { ...buildTacticsRegistry(authorizedSourceIds), ...buildEvidenceRegistry(authorizedSourceIds) };
  }

  return Object.freeze({ listProviders, getProvider, buildEvidenceRegistry, buildTacticsRegistry, buildFeedRegistry });
});
