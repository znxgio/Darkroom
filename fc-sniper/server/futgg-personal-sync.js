'use strict';

// Personal, local-only collector for the rendered FUT.GG FC 27 tactics pages.
// It uses ordinary browser navigation to the pages FUT.GG exposes to users;
// it does not call site-internal APIs, log in, or read browser profile data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = 'https://www.fut.gg';
const OVERVIEW_PATH = '/tactics/';
const PLAYER_PATH = '/tactics/most-used-players/';
const POSITIONS = Object.freeze(['ST', 'LW', 'RW', 'LM', 'RM', 'CAM', 'CM', 'CDM', 'LB', 'CB', 'RB', 'GK']);
const DEFAULT_SNAPSHOT_FILE = path.join(os.homedir(), '.darkroom', 'futgg-meta-snapshot.json');
const PAGE_DELAY_MS = 900;

function numericShare(text) {
  const value = String(text || '').trim();
  if (/^<\s*1\s*%$/.test(value)) return null;
  const match = value.match(/^(\d{1,3}(?:\.\d+)?)\s*%$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function parseRoleSplit(text, position, observedAt) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const start = lines.findIndex(line => line.toUpperCase() === 'ROLE & FOCUS SPLIT');
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line.toUpperCase() === 'JUMP TO');
  const block = lines.slice(start + 1, end < 0 ? lines.length : end);
  if (block.shift()?.toUpperCase() !== 'COMMUNITY' || block.shift()?.toUpperCase() !== 'PROS') return [];
  const rows = [];
  for (let i = 0; i + 2 < block.length;) {
    const key = block[i++];
    const community = numericShare(block[i++]);
    const pro = numericShare(block[i++]);
    if (community == null && pro == null) break;
    const [role, focus = ''] = key.split(' · ', 2);
    if (!role) continue;
    if (pro != null) rows.push({ kind: 'pro', dimension: 'role', key: `${role}${focus ? ` · ${focus}` : ''}`,
      role, focus: focus || null, position, usageShare: pro, sampleSize: null, sampleSizeKnown: false, observedAt });
    if (community != null) rows.push({ kind: 'community', dimension: 'role', key: `${role}${focus ? ` · ${focus}` : ''}`,
      role, focus: focus || null, position, usageShare: community, sampleSize: null, sampleSizeKnown: false, observedAt });
  }
  return rows;
}

function assertFc27(title, pageUrl) {
  if (!/EA FC 27/i.test(String(title || ''))) throw new Error(`Unexpected FUT.GG game/version at ${pageUrl}`);
}

function normalizeFormationRows(rows, observedAt) {
  const result = { pro: [], community: [] };
  for (const row of rows || []) {
    const { formation, communityShare, proShare, buildUpStyle, defensiveLineStyle, url } = row || {};
    if (!formation) continue;
    for (const [kind, usageShare] of [['pro', proShare], ['community', communityShare]]) {
      if (!Number.isFinite(usageShare)) continue;
      result[kind].push({ dimension: 'formation', key: formation, usageShare,
      sampleSize: null, sampleSizeKnown: false, observedAt, url: url || null,
        buildUpStyle: buildUpStyle || null, defensiveLineStyle: defensiveLineStyle || null });
    }
  }
  return result;
}

function normalizePlayerPage(payload, observedAt) {
  const position = String(payload.position || '').toUpperCase();
  if (!POSITIONS.includes(position)) throw new Error(`Unsupported FUT.GG position page: ${position}`);
  assertFc27(payload.title, payload.url);
  const players = { pro: [], community: [] };
  for (const row of payload.players || []) {
    const kind = row.kind === 'pro' ? 'pro' : row.kind === 'community' ? 'community' : null;
    const playerId = String(row.playerId || '');
    const usageShare = Number(row.usageShare);
    if (!kind || !/^\d{1,12}$/.test(playerId) || !Number.isFinite(usageShare) || usageShare < 0 || usageShare > 100) continue;
    players[kind].push({ playerId, position, kind, metric: `${kind}-player-usage`, value: usageShare,
      sampleSize: null, sampleSizeKnown: false, observedAt, sourceUrl: payload.url });
  }
  const tactics = parseRoleSplit(payload.roleSplitText, position, observedAt);
  return { players, tactics };
}

function buildSnapshot({ overview, positionPages, now = Date.now() }) {
  const generatedAt = new Date(now).toISOString();
  assertFc27(overview.title, overview.url);
  const game = 'FC 27';
  const patch = 'not-reported-by-source';
  const platform = 'not-reported-by-source';
  const tacticsSnapshots = [];
  const playerSnapshots = [];
  const allPlayerTactics = { pro: [], community: [] };
  const formationTactics = normalizeFormationRows(overview.formations, now);
  for (const kind of ['pro', 'community']) {
    tacticsSnapshots.push({ sourceId: `futgg-${kind}`, game, patch, platform, generatedAt,
      sourceUrl: overview.url, tactics: formationTactics[kind] });
  }

  const pages = new Map((positionPages || []).map(payload => [String(payload.position || '').toUpperCase(), payload]));
  for (const position of POSITIONS) {
    const payload = pages.get(position);
    if (!payload) throw new Error(`Missing FUT.GG position page: ${position}`);
    const normalized = normalizePlayerPage(payload, now);
    for (const row of normalized.tactics) allPlayerTactics[row.kind].push({ ...row, url: payload.url });
    for (const kind of ['pro', 'community']) {
      playerSnapshots.push({ sourceId: `futgg-${kind}`, game, patch, platform, generatedAt,
        sourceUrl: payload.url, evidence: normalized.players[kind] });
    }
  }
  for (const kind of ['pro', 'community']) {
    tacticsSnapshots.push({ sourceId: `futgg-${kind}`, game, patch, platform, generatedAt,
      sourceUrl: `${BASE}${PLAYER_PATH}`, tactics: allPlayerTactics[kind] });
  }

  return { schemaVersion: 1, game, patch, platform, generatedAt,
    personalUseOnly: true, redistributionAllowed: false,
    timestampSemantics: 'retrieved-at; FUT.GG pages do not publish a source observation timestamp or sample denominator',
    authorizedSources: ['futgg-pro', 'futgg-community'],
    tacticsSnapshots, playerSnapshots };
}

async function extractVisiblePage(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (!response || !response.ok()) throw new Error(`FUT.GG page returned HTTP ${response ? response.status() : 'no response'}: ${url}`);
  await page.waitForSelector('main h1', { timeout: 20000 });
  return page.evaluate(({ pageUrl, positionPaths }) => {
    const main = document.querySelector('main');
    const title = main?.querySelector('h1')?.innerText?.trim() || '';
    const position = positionPaths.find(code => new URL(pageUrl).pathname.toLowerCase().includes(`/most-used-players/${code.toLowerCase()}/`)) || '';
    if (!position) {
      const heading = [...(main?.querySelectorAll('h2') || [])].find(item => item.innerText.trim() === 'All formations');
      const group = heading?.closest('section') || heading?.parentElement?.parentElement;
      const formations = [...(group?.querySelectorAll('h3') || [])].map(h3 => {
        const card = h3.closest('a') || h3.parentElement?.parentElement;
        const text = card?.innerText || '';
        const communityText = text.match(/(<\s*1\s*%|\d{1,3}(?:\.\d+)?\s*%)\s*of community squads/i)?.[1] || '';
        const proText = text.match(/(<\s*1\s*%|\d{1,3}(?:\.\d+)?\s*%)\s*of pros/i)?.[1] || '';
        const style = text.match(/([A-Za-z -]+)\s+build-up\s*·\s*([A-Za-z -]+)\s+line/i);
        const toNumber = value => /^\s*</.test(value) ? null : Number(String(value).replace('%', '').trim());
        return { formation: h3.innerText.trim(), communityShare: toNumber(communityText), proShare: toNumber(proText),
          buildUpStyle: style?.[1]?.trim() || null, defensiveLineStyle: style?.[2]?.trim() || null,
          url: card?.href || pageUrl };
      });
      return { type: 'overview', title, url: pageUrl, formations };
    }
    const bodyText = document.body.innerText || '';
    const players = [];
    const headings = [...main.querySelectorAll('h2')].filter(h2 => /^what the (pros use|community uses)$/i.test(h2.innerText.trim()));
    for (const h2 of headings) {
      const kind = /pros/i.test(h2.innerText) ? 'pro' : 'community';
      const group = h2.parentElement?.parentElement;
      for (const anchor of [...(group?.querySelectorAll('a[href*="/players/"]') || [])]) {
        const href = anchor.getAttribute('href') || '';
        const id = href.match(/\/27-(\d+)(?:\/|$)/)?.[1];
        const card = anchor.parentElement;
        const share = [...(card?.querySelectorAll('span') || [])].map(span => span.innerText.trim())
          .find(value => /^\d{1,3}(?:\.\d+)?%$/.test(value));
        if (id && share) players.push({ kind, playerId: id, usageShare: Number(share.replace('%', '')) });
      }
    }
    return { type: 'players', title, url: pageUrl, position, roleSplitText: bodyText, players };
  }, { pageUrl: url, positionPaths: POSITIONS });
}

async function collectSnapshot({ chromium, now = Date.now(), pageDelayMs = PAGE_DELAY_MS, onPage = () => {} } = {}) {
  const browserType = chromium || require('playwright').chromium;
  const browser = await browserType.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const overviewUrl = BASE + OVERVIEW_PATH;
    const overview = await extractVisiblePage(page, overviewUrl);
    if (overview.type !== 'overview' || !overview.formations.length) throw new Error('FUT.GG tactics overview did not expose formation rows');
    onPage(overviewUrl, overview.formations.length);
    const positionPages = [];
    for (const position of POSITIONS) {
      if (pageDelayMs > 0) await page.waitForTimeout(pageDelayMs);
      const url = `${BASE}${PLAYER_PATH}${position.toLowerCase()}/`;
      const payload = await extractVisiblePage(page, url);
      if (payload.type !== 'players' || payload.position !== position || !payload.players.length)
        throw new Error(`FUT.GG ${position} page did not expose player usage rows`);
      positionPages.push(payload);
      onPage(url, payload.players.length);
    }
    return buildSnapshot({ overview, positionPages, now });
  } finally {
    await browser.close();
  }
}

function writeSnapshot(filePath, snapshot) {
  const target = path.resolve(filePath || DEFAULT_SNAPSHOT_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

async function syncToFile(options = {}) {
  const snapshot = await collectSnapshot(options);
  const filePath = writeSnapshot(options.filePath || DEFAULT_SNAPSHOT_FILE, snapshot);
  return { filePath, snapshot };
}

module.exports = Object.freeze({ BASE, OVERVIEW_PATH, PLAYER_PATH, POSITIONS, DEFAULT_SNAPSHOT_FILE,
  numericShare, parseRoleSplit, normalizePlayerPage, normalizeFormationRows, buildSnapshot,
  extractVisiblePage, collectSnapshot, writeSnapshot, syncToFile });
