/* Darkroom Meta Engine — provider-neutral scoring core.
 * No network, browser, EA account, or storage dependencies.
 * Input evidence is normalized by adapters before it reaches this module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DarkroomMetaEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '0.3.2';
  const DEFAULTS = Object.freeze({
    proWeight: 0.70,
    communityWeight: 0.30,
    proHalfLifeDays: 45,
    communityHalfLifeDays: 30,
    minConfidenceEvidence: 8,
    maxEvidenceAgeDays: 180,
    maxPlayStyleBonus: 4,
    overallBlend: 0.20,
  });

  // These are transparent initial priors, not claims about a live meta.
  // They are intentionally configurable and should later be calibrated against
  // observed competitive outcomes and user feedback.
  const ROLE_WEIGHTS = Object.freeze({
    ST:  { pace: .18, shooting: .34, passing: .05, dribbling: .18, defending: 0, physical: .10, acceleration: .08, finishing: .07 },
    W:   { pace: .22, shooting: .15, passing: .10, dribbling: .25, defending: 0, physical: .06, acceleration: .12, agility: .10 },
    CAM: { pace: .08, shooting: .13, passing: .23, dribbling: .23, defending: 0, physical: .04, vision: .12, agility: .09, ballControl: .08 },
    CM:  { pace: .06, shooting: .04, passing: .23, dribbling: .14, defending: .10, physical: .08, vision: .10, stamina: .10, interceptions: .08, ballControl: .07 },
    CDM: { pace: .05, shooting: 0, passing: .13, dribbling: .04, defending: .28, physical: .16, interceptions: .12, defensiveAwareness: .10, stamina: .07, strength: .05 },
    FB:  { pace: .18, shooting: 0, passing: .08, dribbling: .06, defending: .23, physical: .10, acceleration: .10, stamina: .10, interceptions: .08, crossing: .07 },
    CB:  { pace: .14, shooting: 0, passing: .03, dribbling: .02, defending: .34, physical: .20, defensiveAwareness: .10, strength: .08, acceleration: .05, jumping: .04 },
    GK:  { diving: .22, handling: .18, kicking: .10, reflexes: .24, speed: .08, positioning: .18 }
  });

  const ROLE_GROUP = Object.freeze({
    ST: 'ST', CF: 'ST', LW: 'W', RW: 'W', LM: 'W', RM: 'W',
    CAM: 'CAM', CM: 'CM', CDM: 'CDM', RB: 'FB', LB: 'FB',
    RWB: 'FB', LWB: 'FB', CB: 'CB', GK: 'GK'
  });

  const PLAYSTYLE_PRIORS = Object.freeze({
    ST: ['finesse shot', 'low driven shot', 'quick step', 'rapid', 'first touch', 'precision header'],
    W: ['rapid', 'quick step', 'technical', 'finesse shot', 'first touch', 'incisive pass', 'whipped pass'],
    CAM: ['technical', 'incisive pass', 'finesse shot', 'first touch', 'tiki taka', 'pinged pass'],
    CM: ['incisive pass', 'pinged pass', 'tiki taka', 'relentless', 'intercept', 'press proven'],
    CDM: ['intercept', 'anticipate', 'bruiser', 'pinged pass', 'press proven', 'relentless'],
    FB: ['quick step', 'intercept', 'jockey', 'relentless', 'whipped pass', 'anticipate'],
    CB: ['anticipate', 'intercept', 'bruiser', 'jockey', 'aerial fortress', 'block'],
    GK: ['far reach', 'footwork', 'deflector', 'rush out', 'cross claimer']
  });

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const round1 = n => Math.round(n * 10) / 10;
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const dayMs = 86400000;

  // Adapter for the normalized player shape already used by Darkroom's userscript.
  // Face stats are useful quality inputs, but are not treated as live-meta evidence.
  function adaptPlayer(player) {
    const p = player || {};
    const stats = p.stats || {};
    const attributes = { ...(p.attributes || p.attrs || {}) };
    const map = { pace: 'pac', shooting: 'sho', passing: 'pas', dribbling: 'dri', defending: 'def', physical: 'phy' };
    for (const [target, source] of Object.entries(map)) {
      if (attributes[target] == null && Number(stats[source]) > 0) attributes[target] = Number(stats[source]);
    }
    return {
      id: p.id ?? p.defId ?? null,
      name: p.name || null,
      overall: Number(p.rating ?? p.overall) || 0,
      attributes,
      playStyles: (p.playStyles || []).map(x => typeof x === 'string' ? x : ({
        name: x && (x.name || x.label || x.id) || '',
        plus: !!(x && (x.plus || x.isPlus))
      }))
    };
  }

  function roleGroup(position) {
    return ROLE_GROUP[String(position || '').toUpperCase()] || null;
  }

  function scoreAttributes(player, position, options = {}) {
    const group = roleGroup(position);
    if (!group) return { score: null, coverage: 0, method: 'unsupported-position', parts: [] };
    const weights = options.roleWeights?.[group] || ROLE_WEIGHTS[group];
    const attrs = player?.attributes || {};
    const keys = Object.keys(weights);
    const present = keys.filter(k => weights[k] > 0 && Number.isFinite(Number(attrs[k])) && attrs[k] > 0);
    if (!present.length) {
      const overall = Number(player?.overall);
      return { score: Number.isFinite(overall) && overall > 0 ? overall : null,
        coverage: overall > 0 ? 0.15 : 0, method: overall > 0 ? 'overall-fallback' : 'no-attributes',
        parts: overall > 0 ? [{ key: 'overall', value: overall, weight: 1 }] : [] };
    }
    const totalWeight = keys.reduce((s, k) => s + weights[k], 0);
    const availableWeight = present.reduce((s, k) => s + weights[k], 0);
    const weighted = present.reduce((s, k) => s + Number(attrs[k]) * weights[k], 0) / availableWeight;
    const coverage = totalWeight ? availableWeight / totalWeight : 0;
    const overall = Number(player?.overall);
    const blend = Number.isFinite(overall) && overall > 0 ? clamp(options.overallBlend ?? DEFAULTS.overallBlend, 0, .5) : 0;
    const raw = weighted * (1 - blend) + (blend ? overall : 0) * blend;
    return { score: round1(raw), coverage: round1(coverage), method: 'position-attributes',
      parts: present.map(k => ({ key: k, value: Number(attrs[k]), weight: round1(weights[k] / availableWeight) })) };
  }

  function playStyleBonus(player, position, cap = DEFAULTS.maxPlayStyleBonus) {
    const group = roleGroup(position);
    const priors = PLAYSTYLE_PRIORS[group] || [];
    const styles = (player?.playStyles || []).map(x => ({
      name: norm(typeof x === 'string' ? x : x.name),
      plus: typeof x === 'object' && !!(x.plus || x.isPlus)
    }));
    let bonus = 0;
    const hits = [];
    priors.forEach((name, i) => {
      const found = styles.find(s => s.name === norm(name));
      if (!found) return;
      const base = Math.max(.25, 1 - i * .11);
      const value = base * (found.plus ? 1.7 : 1);
      bonus += value;
      hits.push({ name, plus: found.plus, value: round1(value) });
    });
    return { bonus: round1(Math.min(cap, bonus)), hits };
  }

  function decayWeight(ageDays, halfLifeDays) {
    if (!Number.isFinite(ageDays) || ageDays < 0) return 0;
    return Math.pow(.5, ageDays / Math.max(1, halfLifeDays));
  }

  function normalizeEvidence(item) {
    if (!item || typeof item !== 'object') return null;
    const kind = item.kind === 'pro' || item.kind === 'community' ? item.kind : null;
    const value = Number(item.value);
    const reliability = Number(item.sourceReliability);
    const observedAt = typeof item.observedAt === 'number' ? item.observedAt : Date.parse(item.observedAt || '');
    if (!kind || !Number.isFinite(value) || value < 0 || value > 100 ||
        !Number.isFinite(observedAt) || !Number.isFinite(reliability)) return null;
    return {
      kind, value, source: String(item.source || 'unknown'),
      sourceReliability: clamp(reliability, 0, 1),
      observedAt, sampleSize: clamp(Number(item.sampleSize) || 1, 1, 1000000),
      metric: String(item.metric || 'rating'), context: String(item.context || ''),
      url: item.url ? String(item.url) : null,
      game: item.game ? String(item.game) : null,
      patch: item.patch ? String(item.patch) : null,
      platform: item.platform ? String(item.platform) : null,
      playerId: item.playerId == null ? null : String(item.playerId),
      position: item.position ? String(item.position).toUpperCase() : null
    };
  }

  function summarizeEvidence(rawEvidence, now, options) {
    const normalized = (rawEvidence || []).map(normalizeEvidence).filter(Boolean);
    const summaries = {};
    for (const kind of ['pro', 'community']) {
      const halfLife = kind === 'pro' ? options.proHalfLifeDays : options.communityHalfLifeDays;
      const entries = normalized.filter(e => e.kind === kind && (now - e.observedAt) / dayMs <= options.maxEvidenceAgeDays);
      let numerator = 0, denominator = 0, rawSamples = 0, newest = 0;
      const sources = new Set();
      for (const e of entries) {
        const age = Math.max(0, (now - e.observedAt) / dayMs);
        const sampleFactor = Math.sqrt(e.sampleSize);
        const weight = decayWeight(age, halfLife) * e.sourceReliability * sampleFactor;
        numerator += e.value * weight;
        denominator += weight;
        rawSamples += e.sampleSize;
        newest = Math.max(newest, e.observedAt);
        sources.add(e.source);
      }
      summaries[kind] = {
        score: denominator ? round1(numerator / denominator) : null,
        evidenceWeight: round1(denominator),
        sampleCount: rawSamples,
        sourceCount: sources.size,
        newestAt: newest ? new Date(newest).toISOString() : null
      };
    }
    return summaries;
  }

  function confidenceOf(summaries, attributeCoverage) {
    const totalWeight = summaries.pro.evidenceWeight + summaries.community.evidenceWeight;
    const evidenceConfidence = 1 - Math.exp(-totalWeight / DEFAULTS.minConfidenceEvidence);
    const independentSourceCount = Math.max(summaries.pro.sourceCount, summaries.community.sourceCount);
    const sourceConfidence = clamp(independentSourceCount / 4, 0, 1);
    const coverage = clamp(attributeCoverage || 0, 0, 1);
    return Math.round(100 * clamp(.55 * evidenceConfidence + .25 * sourceConfidence + .20 * coverage, 0, 1));
  }

  function evaluate(player, position, rawEvidence = [], options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const group = roleGroup(position);
    if (!group) return { playerId: player?.id ?? null, position, status: 'unsupported-position', score: null, confidence: 0 };
    const attr = scoreAttributes(player, position, opts);
    const ps = playStyleBonus(player, position, opts.maxPlayStyleBonus);
    const quality = attr.score === null ? null : round1(clamp(attr.score + ps.bonus, 0, 99.9));
    const normalizedInput = (rawEvidence || []).map(normalizeEvidence).filter(Boolean);
    const evidenceContextWarnings = [];
    const eligibleEvidence = normalizedInput.filter(e => {
      for (const key of ['game', 'patch', 'platform', 'metric']) {
        const requested = options[key];
        if (requested != null && String(e[key] || '') !== String(requested)) return false;
      }
      return true;
    });
    for (const key of ['game', 'patch', 'platform', 'metric']) {
      if (options[key] != null) continue;
      const distinct = new Set(eligibleEvidence.map(e => e[key]).filter(Boolean));
      if (distinct.size > 1) evidenceContextWarnings.push('Mixed ' + key + ' evidence; specify options.' + key + ' before scoring.');
    }
    const evidenceInput = evidenceContextWarnings.length ? [] : eligibleEvidence;
    const evidence = summarizeEvidence(evidenceInput, now, opts);
    const pro = evidence.pro.score;
    const community = evidence.community.score;
    const wPro = clamp(opts.proWeight, 0, 1);
    const wCommunity = clamp(opts.communityWeight, 0, 1);
    const sum = wPro + wCommunity || 1;
    const evidenceScore = pro === null && community === null ? null :
      (pro === null ? community : community === null ? pro : (pro * wPro + community * wCommunity) / sum);
    // Competitive evidence is primary; player attributes remain a useful anchor,
    // but never masquerade as evidence of live competitive usage.
    const score = evidenceScore === null ? quality :
      quality === null ? evidenceScore : round1(clamp(evidenceScore * .75 + quality * .25, 0, 100));
    const confidence = confidenceOf(evidence, attr.coverage);
    const newest = [evidence.pro.newestAt, evidence.community.newestAt].filter(Boolean).sort().pop() || null;
    return {
      engineVersion: VERSION, playerId: player?.id ?? null, playerName: player?.name || null,
      position, roleGroup: group, status: score === null ? 'insufficient-data' : 'scored',
      score: score === null ? null : round1(clamp(score, 0, 100)),
      proMetaScore: pro, communityMetaScore: community,
      playerQualityScore: quality, roleFitScore: attr.score,
      playStyleBonus: ps.bonus, relevantPlayStyles: ps.hits,
      confidence, evidence, evidenceContext: { game: options.game || null, patch: options.patch || null, platform: options.platform || null, metric: options.metric || null }, latestEvidenceAt: newest,
      evidenceFreshness: newest ? round1(Math.max(0, (now - Date.parse(newest)) / dayMs)) : null,
      breakdown: { attributeMethod: attr.method, attributeCoverage: attr.coverage, attributeParts: attr.parts,
        proWeight: opts.proWeight, communityWeight: opts.communityWeight,
        evidenceShare: evidenceScore === null ? 0 : .75, qualityShare: evidenceScore === null ? 1 : .25 },
      warnings: [
        ...(evidenceScore === null ? ['No current pro/community evidence; score is a player-quality estimate, not a live-meta verdict.'] : []),
        ...(attr.coverage < .5 ? ['Limited position-specific attribute coverage.'] : []),
        ...evidenceContextWarnings,
        ...(confidence < 40 ? ['Low confidence: treat this ranking as provisional.'] : [])
      ]
    };
  }

  function compareValue(candidate, target) {
    const a = Number(candidate?.score), b = Number(target?.score);
    const pa = Number(candidate?.price), pb = Number(target?.price);
    if (![a, b, pa, pb].every(Number.isFinite) || pa <= 0 || pb <= 0)
      return { comparable: false, reason: 'Missing score or valid market price.' };
    const scoreGap = round1(a - b);
    return { comparable: true, scoreGap, priceDifference: pb - pa,
      savings: Math.max(0, pb - pa), scorePer100k: round1(a / pa * 100000),
      valuePer100k: round1(b / pb * 100000),
      similarPerformance: Math.abs(scoreGap) <= 3 };
  }

  // Validates an imported provider snapshot against a locally maintained source registry.
  // Provider payloads never get to assign their own reliability score.
  function normalizeProviderSnapshot(raw, sourceRegistry, now = Date.now(), options = {}) {
    const rejected = [];
    const reject = (reason, item = null) => rejected.push({ reason, playerId: item?.playerId ?? null });
    if (!raw || typeof raw !== 'object') return { status: 'rejected', evidence: [], rejected: [{ reason: 'invalid-snapshot', playerId: null }] };
    const sourceId = String(raw.sourceId || '');
    const registry = Array.isArray(sourceRegistry)
      ? sourceRegistry.find(x => x && x.id === sourceId)
      : sourceRegistry?.[sourceId];
    if (!registry || registry.enabled === false) return { status: 'rejected', evidence: [], rejected: [{ reason: 'unregistered-source', playerId: null }] };
    const generatedAt = Date.parse(raw.generatedAt || '');
    if (!raw.game || !raw.patch || !raw.platform || !Number.isFinite(generatedAt)) {
      return { status: 'rejected', evidence: [], rejected: [{ reason: 'missing-snapshot-context', playerId: null }] };
    }
    const maxSnapshotAgeDays = Number(options.maxSnapshotAgeDays ?? registry.maxAgeDays ?? 45);
    const ageDays = (now - generatedAt) / dayMs;
    if (ageDays < -5 / 1440) return { status: 'rejected', evidence: [], rejected: [{ reason: 'future-snapshot', playerId: null }] };
    if (ageDays > maxSnapshotAgeDays) return { status: 'stale', evidence: [], rejected: [{ reason: 'stale-snapshot', playerId: null }] };
    const allowedMetrics = Array.isArray(registry.allowedMetrics) ? registry.allowedMetrics : null;
    const seen = new Set();
    const evidence = [];
    for (const item of Array.isArray(raw.evidence) ? raw.evidence : []) {
      const metric = String(item?.metric || '');
      const observedAt = Date.parse(item?.observedAt || '');
      const key = [item?.playerId, item?.position, metric, item?.context || '', observedAt].join('|');
      if (!item || item.kind !== registry.kind || !['pro', 'community'].includes(item.kind)) { reject('source-kind-mismatch', item); continue; }
      if (!item.playerId || !item.position || !roleGroup(item.position) || !metric || (allowedMetrics && !allowedMetrics.includes(metric))) { reject('invalid-or-disallowed-metric-or-position', item); continue; }
      if (!Number.isFinite(Number(item.sampleSize)) || Number(item.sampleSize) < 1) { reject('invalid-sample-size', item); continue; }
      if (!Number.isFinite(Number(item.value)) || Number(item.value) < 0 || Number(item.value) > 100 ||
          !Number.isFinite(observedAt) || observedAt > now + 5 * 60000) { reject('invalid-value-or-time', item); continue; }
      if ((now - observedAt) / dayMs > Number(registry.maxAgeDays ?? maxSnapshotAgeDays)) { reject('stale-evidence', item); continue; }
      if (seen.has(key)) { reject('duplicate-observation', item); continue; }
      seen.add(key);
      const normalized = normalizeEvidence({
        ...item,
        source: sourceId,
        sourceReliability: Number(registry.reliability),
        sampleSize: item.sampleSize,
        observedAt: new Date(observedAt).toISOString()
      });
      if (!normalized) { reject('normalization-failed', item); continue; }
      evidence.push({ ...normalized, playerId: String(item.playerId), position: String(item.position).toUpperCase(),
        game: String(raw.game), patch: String(raw.patch), platform: String(raw.platform) });
    }
    return { status: evidence.length ? 'ok' : 'empty', sourceId, game: String(raw.game), patch: String(raw.patch),
      platform: String(raw.platform), generatedAt: new Date(generatedAt).toISOString(), evidence, rejected };
  }

  // Validates tactics distributions against the same trusted local source registry.
  function normalizeTacticsSnapshot(raw, sourceRegistry, now = Date.now(), options = {}) {
    const rejected = [];
    const reject = (reason, item = null) => rejected.push({ reason, key: item?.key || item?.formation || null });
    if (!raw || typeof raw !== 'object') return { status: 'rejected', observations: [], rejected: [{ reason: 'invalid-snapshot', key: null }] };
    const sourceId = String(raw.sourceId || '');
    const registry = Array.isArray(sourceRegistry)
      ? sourceRegistry.find(x => x && x.id === sourceId)
      : sourceRegistry?.[sourceId];
    if (!registry || registry.enabled === false) return { status: 'rejected', observations: [], rejected: [{ reason: 'unregistered-source', key: null }] };
    if (!['pro', 'community'].includes(registry.kind) || !Number.isFinite(Number(registry.reliability)) || Number(registry.reliability) < 0 || Number(registry.reliability) > 1) return { status: 'rejected', observations: [], rejected: [{ reason: 'invalid-source-registry', key: null }] };
    const generatedAt = Date.parse(raw.generatedAt || '');
    if (!raw.game || !raw.patch || !raw.platform || !Number.isFinite(generatedAt)) {
      return { status: 'rejected', observations: [], rejected: [{ reason: 'missing-snapshot-context', key: null }] };
    }
    const maxAgeDays = Number(options.maxSnapshotAgeDays ?? registry.maxAgeDays ?? 45);
    const snapshotAge = (now - generatedAt) / dayMs;
    if (snapshotAge < -5 / 1440) return { status: 'rejected', observations: [], rejected: [{ reason: 'future-snapshot', key: null }] };
    if (snapshotAge > maxAgeDays) return { status: 'stale', observations: [], rejected: [{ reason: 'stale-snapshot', key: null }] };
    const allowed = Array.isArray(registry.allowedDimensions) ? registry.allowedDimensions : null;
    const seen = new Set();
    const observations = [];
    for (const item of Array.isArray(raw.tactics) ? raw.tactics : []) {
      const dimension = String(item?.dimension || '');
      const key = String(item?.key || item?.formation || item?.role || '').trim();
      const position = item?.position ? String(item.position).toUpperCase() : null;
      const usageShare = Number(item?.usageShare);
      const sampleSize = Number(item?.sampleSize);
      const observedAt = typeof item?.observedAt === 'number' ? item.observedAt : Date.parse(item?.observedAt || '');
      if (!['formation', 'role', 'buildUp', 'defensiveLine'].includes(dimension) ||
          (allowed && !allowed.includes(dimension)) || !key ||
          (dimension === 'role' && !roleGroup(position))) { reject('invalid-or-disallowed-tactics-dimension', item); continue; }
      if (!Number.isFinite(usageShare) || usageShare < 0 || usageShare > 100 ||
          !Number.isFinite(sampleSize) || sampleSize < 1 || !Number.isFinite(observedAt) ||
          observedAt > now + 5 * 60000) { reject('invalid-tactics-value-or-time', item); continue; }
      if ((now - observedAt) / dayMs > Number(registry.maxAgeDays ?? maxAgeDays)) { reject('stale-tactics-observation', item); continue; }
      const duplicateKey = [dimension, key, position || '', item.focus || '', item.formation || '', observedAt].join('|');
      if (seen.has(duplicateKey)) { reject('duplicate-tactics-observation', item); continue; }
      seen.add(duplicateKey);
      observations.push({ ...item, dimension, key, position, usageShare, sampleSize, observedAt,
        kind: registry.kind, source: sourceId, sourceReliability: Number(registry.reliability),
        game: String(raw.game), patch: String(raw.patch), platform: String(raw.platform) });
    }
    return { status: observations.length ? 'ok' : 'empty', sourceId, game: String(raw.game),
      patch: String(raw.patch), platform: String(raw.platform),
      generatedAt: new Date(generatedAt).toISOString(), observations, rejected };
  }

  // Ranks normalized formation/role/tactic usage observations without mixing
  // pro and community samples or incompatible game/patch/platform contexts.
  function rankTactics(rawObservations, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const opts = { ...DEFAULTS, ...options };
    const rejected = [];
    const accepted = [];
    for (const item of rawObservations || []) {
      const dimension = String(item?.dimension || '');
      const key = String(item?.key || item?.formation || item?.role || '').trim();
      const position = item?.position ? String(item.position).toUpperCase() : null;
      const usageShare = Number(item?.usageShare);
      const sampleSize = Number(item?.sampleSize);
      const observedAt = typeof item?.observedAt === 'number' ? item.observedAt : Date.parse(item?.observedAt || '');
      const reliability = Number(item?.sourceReliability);
      if (!['formation', 'role', 'buildUp', 'defensiveLine'].includes(dimension) ||
          !key || !['pro', 'community'].includes(item?.kind) ||
          (dimension === 'role' && !roleGroup(position)) ||
          !Number.isFinite(usageShare) || usageShare < 0 || usageShare > 100 ||
          !Number.isFinite(sampleSize) || sampleSize < 1 ||
          !Number.isFinite(reliability) || reliability < 0 || reliability > 1 ||
          !Number.isFinite(observedAt)) {
        rejected.push({ reason: 'invalid-tactics-observation', key: key || null }); continue;
      }
      const age = (now - observedAt) / dayMs;
      if (age < -5 / 1440) { rejected.push({ reason: 'future-tactics-observation', key }); continue; }
      if (age > Number(opts.maxEvidenceAgeDays)) { rejected.push({ reason: 'stale-tactics-observation', key }); continue; }
      accepted.push({ ...item, dimension, key, position, usageShare, sampleSize,
        observedAt, source: String(item.source || 'unknown'), sourceReliability: reliability });
    }
    const contextWarnings = [];
    const scoped = accepted.filter(item => {
      for (const key of ['game', 'patch', 'platform']) {
        if (options[key] != null && String(item[key] || '') !== String(options[key])) return false;
      }
      return true;
    });
    for (const key of ['game', 'patch', 'platform']) {
      if (options[key] != null) continue;
      const distinct = new Set(scoped.map(x => x[key]).filter(Boolean));
      if (distinct.size > 1) contextWarnings.push('Mixed ' + key + ' tactics evidence; specify options.' + key + ' before ranking.');
    }
    const groups = new Map();
    if (!contextWarnings.length) for (const item of scoped) {
      const groupKey = [item.dimension, item.key, item.position || '', item.focus || '', item.formation || ''].join('|');
      if (!groups.has(groupKey)) groups.set(groupKey, { dimension: item.dimension, key: item.key,
        position: item.position, focus: item.focus || null, formation: item.formation || null,
        tacticCode: item.tacticCode || null, lineHeight: item.lineHeight ?? null, pro: [], community: [] });
      groups.get(groupKey)[item.kind].push(item);
    }
    const summarize = entries => {
      if (!entries.length) return { usageShare: null, evidenceWeight: 0, sampleCount: 0, sourceCount: 0, newestAt: null };
      let numerator = 0, denominator = 0, sampleCount = 0, newest = 0;
      const sources = new Set();
      for (const e of entries) {
        const age = Math.max(0, (now - e.observedAt) / dayMs);
        const halfLife = e.kind === 'pro' ? opts.proHalfLifeDays : opts.communityHalfLifeDays;
        const weight = decayWeight(age, halfLife) * e.sourceReliability * Math.sqrt(e.sampleSize);
        numerator += e.usageShare * weight;
        denominator += weight;
        sampleCount += e.sampleSize;
        newest = Math.max(newest, e.observedAt);
        sources.add(e.source);
      }
      return { usageShare: denominator ? round1(numerator / denominator) : null,
        evidenceWeight: round1(denominator), sampleCount, sourceCount: sources.size,
        newestAt: newest ? new Date(newest).toISOString() : null };
    };
    const rows = [...groups.values()].map(g => {
      const pro = summarize(g.pro), community = summarize(g.community);
      const wp = clamp(opts.proWeight, 0, 1), wc = clamp(opts.communityWeight, 0, 1), total = wp + wc || 1;
      const score = pro.usageShare === null ? community.usageShare : community.usageShare === null ? pro.usageShare :
        (pro.usageShare * wp + community.usageShare * wc) / total;
      const weight = pro.evidenceWeight + community.evidenceWeight;
      const sourceCount = new Set([...g.pro, ...g.community].map(x => x.source)).size;
      const confidence = Math.round(100 * clamp(.7 * (1 - Math.exp(-weight / DEFAULTS.minConfidenceEvidence)) +
        .3 * clamp(sourceCount / 4, 0, 1), 0, 1));
      const proTacticCode = g.pro.find(x => x.tacticCode)?.tacticCode || null;
      const communityTacticCode = g.community.find(x => x.tacticCode)?.tacticCode || null;
      const proLineHeight = g.pro.find(x => x.lineHeight != null)?.lineHeight ?? null;
      const communityLineHeight = g.community.find(x => x.lineHeight != null)?.lineHeight ?? null;
      return { dimension: g.dimension, key: g.key, position: g.position, focus: g.focus,
        formation: g.formation, tacticCode: proTacticCode || communityTacticCode,
        proTacticCode, communityTacticCode,
        lineHeight: proLineHeight ?? communityLineHeight, proLineHeight, communityLineHeight,
        proUsageShare: pro.usageShare, communityUsageShare: community.usageShare,
        metaUsageShare: score === null ? null : round1(score), confidence,
        pro, community, latestAt: [pro.newestAt, community.newestAt].filter(Boolean).sort().pop() || null };
    }).sort((a, b) => (b.metaUsageShare ?? -1) - (a.metaUsageShare ?? -1));
    const by = dimension => rows.filter(x => x.dimension === dimension);
    return { status: contextWarnings.length ? 'context-required' : rows.length ? 'ok' : 'empty',
      context: { game: options.game || null, patch: options.patch || null, platform: options.platform || null },
      formations: by('formation'), roles: by('role'), buildUpStyles: by('buildUp'),
      defensiveStyles: by('defensiveLine'), rejected, warnings: contextWarnings };
  }

  function snapshotMeta({ game, platform, generatedAt = new Date().toISOString(), sourceStatuses = [], players = [] }) {
    return { schemaVersion: 1, engineVersion: VERSION, game: String(game || ''),
      platform: String(platform || 'all'), generatedAt,
      sourceStatuses: sourceStatuses.map(s => ({ id: String(s.id), status: String(s.status),
        updatedAt: s.updatedAt || null, detail: s.detail || null })),
      players: players.map(p => ({ playerId: p.playerId, position: p.position,
        score: p.score, confidence: p.confidence, proMetaScore: p.proMetaScore,
        communityMetaScore: p.communityMetaScore, latestEvidenceAt: p.latestEvidenceAt,
        warnings: p.warnings || [] })) };
  }

  return Object.freeze({ VERSION, DEFAULTS, ROLE_WEIGHTS, ROLE_GROUP, roleGroup, adaptPlayer,
    scoreAttributes, playStyleBonus, normalizeEvidence, summarizeEvidence,
    evaluate, compareValue, normalizeProviderSnapshot, normalizeTacticsSnapshot, rankTactics, snapshotMeta, decayWeight });
});
