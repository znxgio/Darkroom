'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../server/futgg-personal-sync');

test('FUT.GG personal snapshot keeps pro and community usage separate and unreported context honest', () => {
  const now = Date.parse('2026-11-27T18:00:00.000Z');
  const overview = { title: 'EA FC 27 Tactics & Formations', url: `${sync.BASE}/tactics/`, formations: [
    { formation: '4-3-1-2', communityShare: 26, proShare: 33, buildUpStyle: 'Balanced', defensiveLineStyle: 'Balanced', url: `${sync.BASE}/tactics/` }
  ] };
  const positionPages = sync.POSITIONS.map(position => ({
    title: `Most Used ${position} players in EA FC 27`, position, url: `${sync.BASE}${sync.PLAYER_PATH}${position.toLowerCase()}/`,
    roleSplitText: 'ROLE & FOCUS SPLIT\nCOMMUNITY\nPROS\nAdvanced Forward · Attack\n63%\n61%\nJUMP TO',
    players: [{ kind: 'pro', playerId: '231747', usageShare: 21 }, { kind: 'community', playerId: '239085', usageShare: 8 }]
  }));
  const snapshot = sync.buildSnapshot({ overview, positionPages, now });
  assert.equal(snapshot.personalUseOnly, true);
  assert.equal(snapshot.redistributionAllowed, false);
  assert.equal(snapshot.patch, 'not-reported-by-source');
  assert.equal(snapshot.platform, 'not-reported-by-source');
  assert.deepEqual(snapshot.tacticsSnapshots[0].tactics[0].sampleSize, null);
  assert.equal(snapshot.tacticsSnapshots[0].tactics[0].sampleSizeKnown, false);
  const proPlayers = snapshot.playerSnapshots.find(row => row.sourceId === 'futgg-pro');
  const communityPlayers = snapshot.playerSnapshots.find(row => row.sourceId === 'futgg-community');
  assert.equal(proPlayers.evidence[0].playerId, '231747');
  assert.equal(proPlayers.evidence[0].metric, 'pro-player-usage');
  assert.equal(communityPlayers.evidence[0].metric, 'community-player-usage');
  const proRoles = snapshot.tacticsSnapshots.filter(row => row.sourceId === 'futgg-pro').flatMap(row => row.tactics);
  assert.ok(proRoles.some(row => row.dimension === 'role' && row.position === 'ST' && row.usageShare === 61));
});

test('FUT.GG player use parsing preserves percentage rows and rejects less-than-one exact guesses', () => {
  assert.equal(sync.numericShare('21.5%'), 21.5);
  assert.equal(sync.numericShare('<1%'), null);
  const rows = sync.parseRoleSplit('ROLE & FOCUS SPLIT\nCOMMUNITY\nPROS\nFullback · Balanced\n47%\n55%\nJUMP TO', 'RB', Date.now());
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.kind === 'pro').usageShare, 55);
  assert.equal(rows.find(row => row.kind === 'community').position, 'RB');
});
