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
      id: 'futgg-pro',
      name: 'FUT.GG — Pro Tactics',
      url: 'https://www.fut.gg/tactics/',
      category: 'competitive-meta',
      kind: 'pro',
      capabilities: ['formation-usage', 'role-usage', 'build-up-usage', 'defensive-line-usage', 'tactic-codes', 'player-role-fit'],
      evidenceMetrics: ['pro-formation-usage', 'pro-role-usage', 'pro-build-up-usage', 'pro-defensive-line-usage'],
      access: 'public-reference',
      automatedIngestion: false,
      status: 'candidate',
      reliability: 0.82,
      notes: 'Public FC 27 tactics pages visibly separate pro and community usage. Public visibility is not permission to scrape or call undocumented endpoints.'
    },
    {
      id: 'futgg-community',
      name: 'FUT.GG — Community Tactics',
      url: 'https://www.fut.gg/tactics/',
      category: 'competitive-meta',
      kind: 'community',
      capabilities: ['formation-usage', 'role-usage', 'build-up-usage', 'defensive-line-usage', 'player-role-fit'],
      evidenceMetrics: ['community-formation-usage', 'community-role-usage', 'community-build-up-usage', 'community-defensive-line-usage'],
      access: 'public-reference',
      automatedIngestion: false,
      status: 'candidate',
      reliability: 0.72,
      notes: 'Keep community squad trends separate from pro tactics observations.'
    },
    {
      id: 'pacefc-pro',
      name: 'PaceFC — Pro Tactics Research',
      url: 'https://futfc.gg/fc-27-tactics/',
      category: 'competitive-meta',
      kind: 'pro',
      capabilities: ['formation-usage', 'tactic-codes', 'patch-comparison'],
      evidenceMetrics: ['pro-formation-usage'],
      access: 'public-reference',
      automatedIngestion: false,
      status: 'secondary-candidate',
      reliability: 0.76,
      notes: 'Useful cross-check when methodology, sample window, and patch labels are disclosed. Do not merge unlike sample windows.'
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
      url: 'https://www.ea.com/games/ea-sports-fc/news/pitch-notes-fc26-community-api-update',
      category: 'official-account-data',
      kind: 'community',
      capabilities: ['authorized-club-data', 'formations', 'tactics'],
      evidenceMetrics: [],
      access: 'partner-approval-and-user-consent',
      automatedIngestion: false,
      status: 'not-available-to-darkroom',
      reliability: 1,
      notes: 'EA says access is limited to approved partner sites and user-authorized requests. Darkroom must not imitate partner authentication or reuse a user session.'
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

  // Produces the engine's source registry only for sources the caller has
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

  return Object.freeze({ listProviders, getProvider, buildEvidenceRegistry });
});
