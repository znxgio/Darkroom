// A fake EA FC Web App (club, squad, packs, SBCs, market) for browser tests.
// installMock() runs inside the page.
/** A fake Web App with a club, an active squad, packs and one SBC. Runs in the page. */
function installMock() {
  const obs = (res, ms = 5) => ({ observe(ctx, cb) { setTimeout(() => cb({ unobserve() {} }, res), ms); } });
  const PILE = { CLUB: 1, PURCHASED: 3, TRANSFER: 5, STORAGE: 6 };
  window.ItemPile = PILE;
  window.UTSearchCriteriaDTO = function () { this.offset = 0; this.count = 21; };
  let nextId = 1;
  const owned = new Set(); // definitionIds you own (for duplicates)
  const mk = (defId, rating, o = {}) => {
    const it = {
      id: nextId++, definitionId: defId, rating, rareflag: o.rare ? 1 : (o.special ? 3 : 0), untradeable: o.untradeable !== false,
      pile: o.pile || PILE.CLUB, nationId: o.nation || 18, leagueId: o.league || 13, teamId: o.team || defId,
      preferredPosition: o.pos || 'CM', possiblePositions: o.alt || [], attributes: o.attrs || [rating - 6, rating - 8, rating - 4, rating - 3, rating - 10, rating - 5], skillMoves: o.sm || 3, weakFoot: o.wf || 3, _staticData: { name: o.name || `Player ${defId}` },
      _auction: o.price ? { tradeId: nextId, buyNowPrice: o.price } : undefined,
      isPlayer() { return o.player !== false; }, isLimitedUse() { return false; },
      isDuplicate() { return o.dup !== undefined ? o.dup : owned.has(defId) && this.pile !== PILE.CLUB; },
    };
    return it;
  };
  // --- club: fodder 75..86 untradeable, a few tradeables
  const club = [];
  const add = (r, n, o = {}) => { for (let i = 0; i < n; i++) { const it = mk(5000 + club.length, r, { ...o, name: `Fodder ${r}-${i}` }); club.push(it); owned.add(it.definitionId); } };
  add(86, 1); add(85, 4); add(84, 12); add(83, 8, { rare: true }); add(82, 8); add(81, 5); add(78, 6); add(75, 10);
  add(87, 4, { untradeable: false });
  const storage = [mk(9001, 83, { pile: PILE.STORAGE, name: 'Stored 83 A' }), mk(9002, 83, { pile: PILE.STORAGE, name: 'Stored 83 B' })];
  // --- active squad: 4-3-1-2, ST slot weak (75), all Premier League (13), mixed nations
  const posList = ['GK', 'RB', 'CB', 'CB', 'LB', 'CM', 'CM', 'CM', 'CAM', 'ST', 'ST'];
  const squadItems = posList.map((pos, i) => mk(100 + i, i === 10 ? 75 : 85, { pos, nation: 10 + (i % 4), league: 13, name: i === 10 ? 'Weak Striker' : `Starter ${pos}${i}` }));
  squadItems.forEach((it) => { owned.add(it.definitionId); club.push(it); });
  // subs/reserves that look like perfect fodder (83, untradeable, rare) — must never be used
  const benchItems = [mk(650, 83, { rare: true, name: 'My Sub 83' }), mk(651, 84, { name: 'My Reserve 84' })];
  benchItems.forEach((it) => club.push(it));
  // untradeable specials — must not be used unless allowed
  for (let i = 0; i < 6; i++) club.push(mk(660 + i, 83, { special: true, name: `Special 83 ${i}` }));
  club.push(mk(700, 80, { pos: 25, league: 13, name: 'Bench Striker 80' })); // EA sends position ids
  // a pacey 84 striker: should start over slower, higher-rated strikers when picking by meta
  club.push(mk(710, 84, { pos: 25, league: 13, nation: 10, name: 'Pacey Striker 84', attrs: [97, 86, 75, 91, 35, 78], sm: 5, wf: 4 }));
  // a bench covering every position, so formations can be built (numeric ids like the real app)
  const ids = { GK: 0, RB: 3, CB: 5, LB: 7, RWB: 2, LWB: 8, CDM: 10, CM: 14, CAM: 18, RM: 12, LM: 16, RW: 23, LW: 27, CF: 21, ST: 25 };
  ['GK', 'RB', 'CB', 'CB', 'CB', 'LB', 'RWB', 'LWB', 'CDM', 'CDM', 'CM', 'CAM', 'CAM', 'RM', 'LM', 'RW', 'LW', 'CF', 'CF', 'ST', 'ST']
    .forEach((pos, i) => club.push(mk(600 + i, 83 + (i % 4), { pos: ids[pos], league: 13, nation: 10 + (i % 4), name: `Bench ${pos} ${i}` })));
  window.T = { piles: { club: [], storage: [], transfer: [], discarded: [] }, unassigned: [], submitted: [], searches: [], opened: 0 };
  const squad = {
    getFieldPlayers: () => squadItems.map((item, index) => ({ index, item, position: { typeName: posList[index] } })),
    getPlayers: () => [...squadItems, ...benchItems].map((item, index) => ({ index, item })),
    getFormation: () => ({ name: 'f4312' }), // the real app uses EA formation ids
  };
  // --- packs
  const packContents = [
    () => [mk(9100, 88, { name: 'Walkout Hero', special: true, untradeable: false }), mk(5001, 85, { dup: true, untradeable: true }), mk(9101, 72, { name: 'New Silver' })],
    () => [mk(5002, 84, { dup: true, untradeable: false }), mk(5003, 68, { dup: true, untradeable: true })],
    () => [mk(9102, 79, { name: 'New Gold' })],
  ];
  const pack = (i, name) => ({ id: 30 + (i > 0 ? 1 : 0), packName: name, isMyPack: true, open() { T.opened++; T.unassigned.push(...packContents[i]()); return obs({ success: true }); } });
  const myPacks = [pack(0, 'Gold Pack'), pack(1, 'Gold Pack'), pack(2, 'Rare Players Pack')];
  // --- SBC
  const sbcSquad = {
    players: [],
    getNumOfRequiredPlayers: () => 11,
    getFieldPlayers: () => Array.from({ length: 11 }, (_, index) => ({ index, isBrick: () => false })),
    removeAllItems() { this.players = []; },
    setPlayers(arr) { this.players = arr.filter(Boolean); },
  };
  let done = 0;
  const challenge = () => ({ id: 77, name: '84-rated squad', squad: sbcSquad, isCompleted: () => false,
    eligibilityRequirements: [{ scope: 0, count: -1, kvPairs: { _collection: { 19: [84] } } }, { scope: 0, count: 2, kvPairs: { _collection: { 25: [4] } } }] });
  const chemChallenge = { id: 78, name: 'League & Nation', squad: sbcSquad, isCompleted: () => false,
    eligibilityRequirements: [{ scope: 0, count: 3, kvPairs: { _collection: { 5: [3] } } }, { scope: 0, count: -1, kvPairs: { _collection: { 35: [20] } } }] };
  const sets = [{ id: 1, name: '84+ Upgrade', description: 'Repeatable', isComplete: () => false, repeatable: true, timesCompleted: 0 },
    { id: 2, name: 'Hybrid Leagues', description: 'Chemistry', isComplete: () => false }];

  window.services = {
    User: { getUser: () => ({ coins: { amount: 120000 } }) },
    Localization: { localize: (x) => x },
    Item: {
      clearTransferMarketCache() {},
      searchTransferMarket(c) {
        T.searches.push({ league: c.league, nation: c.nation, pos: c._position, max: c.maxBuy, min: c.minBuy });
        const items = c._position === 'ST' ? [
          mk(800, 86, { pos: 'ST', league: 13, nation: 10, name: 'Same League ST 86', price: 45000 }),
          mk(801, 88, { pos: 'ST', league: 53, nation: 99, name: 'Other League ST 88', price: 60000 }),
          mk(802, 90, { pos: 'ST', league: 13, name: 'Too Pricey ST 90', price: 500000 }),
          mk(619, 86, { pos: 25, league: 13, nation: 13, name: 'Bench ST 19', price: 30000 }), // a card you already own, listed cheap
          mk(720, 85, { pos: 25, league: 13, nation: 10, name: 'Listed Striker 85', price: 20000 }), // on your transfer list
        ].filter((i) => !c.maxBuy || i._auction.buyNowPrice <= c.maxBuy) : [];
        return obs({ success: true, data: { items } });
      },
      searchStorageItems: () => obs({ success: true, data: { items: storage, endOfList: true } }),
      requestUnassignedItems: () => obs({ success: true, data: { items: T.unassigned.slice() } }),
      // a striker you're selling on the transfer list (owned, listed cheap on the market below)
      requestTransferItems: () => obs({ success: true, data: { items: [mk(720, 85, { pos: 25, league: 13, name: 'Listed Striker 85', untradeable: false })] } }),
      move(items, pile) {
        const key = { 1: 'club', 5: 'transfer', 6: 'storage' }[pile];
        items.forEach((it) => { T.unassigned = T.unassigned.filter((u) => u !== it); it.pile = pile; T.piles[key].push(it.rating); });
        return obs({ success: true });
      },
      discard(items) { items.forEach((it) => { T.unassigned = T.unassigned.filter((u) => u !== it); T.piles.discarded.push(it.rating); }); return obs({ success: true }); },
    },
    Club: {
      // the real Web App returns club results in `response`, not `data`
      search(c) { const page = club.slice(c.offset, c.offset + c.count); return obs({ success: true, response: { items: page, retrievedAll: c.offset + c.count >= club.length } }); },
    },
    Store: { getPacks: () => obs({ success: true, response: { packs: myPacks.slice(T.opened) } }) },
    Squad: { getActiveSquadId: () => 1, requestSquadById: () => obs({ success: true, data: { squad } }),
      create(name, formation, items) { T.created = { name, formation, n: items.filter(Boolean).length, ratings: items.map((i) => i && i.rating) }; return obs({ success: true }); } },
    SBC: {
      requestSets: () => obs({ success: true, data: { sets } }),
      requestChallengesForSet: (set) => obs({ success: true, data: { challenges: set.id === 1 ? (done < 2 ? [challenge()] : []) : [chemChallenge] } }),
      loadChallenge: () => obs({ success: true }),
      saveChallenge: () => obs({ success: true }),
      submitChallenge(ch) {
        T.submitted.push(ch.squad.players.map((p) => ({ id: p.id, def: p.definitionId, r: p.rating, rare: p.rareflag, pile: p.pile, untradeable: p.untradeable })));
        done++;
        return obs({ success: true });
      },
    },
    Chemistry: { isFeatureEnabled: () => true },
  };
  window.repositories = { Item: { numItemsInCache: () => T.unassigned.length, isPileFull: () => false, setDirty() {} } };
}

module.exports = { installMock };
