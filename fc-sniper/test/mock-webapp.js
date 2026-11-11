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
  const allItems = new Map(); // every item ever created, by id (bought cards included)
  const mk = (defId, rating, o = {}) => {
    const it = {
      id: nextId++, definitionId: defId, rating, rareflag: o.rare ? 1 : (o.special ? 3 : 0), untradeable: o.untradeable !== false,
      pile: o.pile || PILE.CLUB, nationId: o.nation || 18, leagueId: o.league || 13, teamId: o.team || defId,
      preferredPosition: o.pos || 'CM', possiblePositions: o.alt || [], sbsScore: rating < 65 ? 20 : rating < 75 ? 35 : rating < 81 ? 120 : ({ 81: 280, 82: 450, 83: 700, 84: 900, 85: 2000, 86: 3500, 87: 5500 })[rating] || 8000, attributes: o.attrs || [rating - 6, rating - 8, rating - 4, rating - 3, rating - 10, rating - 5], skillMoves: o.sm || 3, weakFoot: o.wf || 3, _staticData: { name: o.name || `Player ${defId}` },
      _auction: o.price ? { tradeId: nextId, buyNowPrice: o.price } : undefined,
      isPlayer() { return o.player !== false; }, isLimitedUse() { return false; },
      isDuplicate() { return o.dup !== undefined ? o.dup : owned.has(defId) && this.pile !== PILE.CLUB; },
    };
    allItems.set(it.id, it);
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
  const pack = (i, name, id) => {
    const pk = { id: id || 30 + (i > 0 ? 1 : 0), packName: name, isMyPack: true,
      open() { T.opened++; T.packList = T.packList.filter((x) => x !== pk); T.unassigned.push(...(i === 'reward' ? [mk(9200 + T.opened, 83, { name: 'Reward Player 83' })] : packContents[i]())); return obs({ success: true }); } };
    return pk;
  };
  T.packList = [pack(0, 'Gold Pack'), pack(1, 'Gold Pack'), pack(2, 'Rare Players Pack')];
  T.addRewardPack = () => T.packList.push(pack('reward', 'SBC Reward Pack', 77));
  T.addUnassigned = () => { T.unassigned.push(mk(9300, 82, { name: 'Unassigned New 82' }), mk(5003, 83, { name: 'Unassigned Dup 83', dup: true })); };
  // --- SBC
  const sbcSquad = {
    players: [],
    getNumOfRequiredPlayers: () => 11,
    getFieldPlayers: () => ['GK', 'RB', 'CB', 'CB', 'LB', 'CM', 'CM', 'CM', 'RW', 'ST', 'LW'].map((typeName, index) => ({ index, isBrick: () => false, position: { typeName } })),
    removeAllItems() { this.players = []; },
    setPlayers(arr) { this.players = arr.filter(Boolean); },
  };
  let done = 0;
  const challenge = () => ({ id: 77, name: '84-rated squad', squad: sbcSquad, isCompleted: () => false,
    eligibilityRequirements: [{ scope: 0, count: -1, kvPairs: { _collection: { 19: [84] } } }, { scope: 0, count: 2, kvPairs: { _collection: { 25: [4] } } }] });
  const chemChallenge = { id: 78, name: 'League & Nation', squad: sbcSquad, isCompleted: () => false,
    eligibilityRequirements: [{ scope: 0, count: 3, kvPairs: { _collection: { 5: [3] } } }, { scope: 0, count: -1, kvPairs: { _collection: { 35: [20] } } }] };
  // needs an 87-rated squad: more than the club (max 86 allowed) can do → buys fill-ins
  const eliteChallenge = { id: 79, name: 'Elite 87', squad: sbcSquad, isCompleted: () => false,
    eligibilityRequirements: [{ scope: 0, count: -1, kvPairs: { _collection: { 19: [87] } } }] };
  const sets = [{ id: 1, name: '84+ Upgrade', description: 'Repeatable', isComplete: () => false, repeatable: true, timesCompleted: 0 },
    { id: 2, name: 'Hybrid Leagues', description: 'Chemistry', isComplete: () => false },
    { id: 3, name: 'Elite 87', description: 'Needs buys', isComplete: () => false },
    { id: 4, name: 'Break Away', description: 'Bronze', isComplete: () => false },
    { id: 5, name: 'Hat-trick', description: '3 players', isComplete: () => false },
    { id: 6, name: 'Brian Brobbey', description: 'Points', isComplete: () => false, scoreRequirement: 30000, totalSubmittedScore: 0 }];
  // FC 27 points SBC: "OVR Min 45" (Evolutions-style rule) and a 30,000 💎 goal
  const pointsChallenge = { id: 82, name: 'Brian Brobbey', squad: sbcSquad, isCompleted: () => false, scoreRequirement: 30000, submittedScore: 1200,
    hasNotStarted: () => false, isOneClickChallenge: () => true,
    eligibilityRequirements: [{ scope: 0, count: -1, kvPairs: { _collection: { 40: [45], 41: [1] } } }] };
  // a 3-player SBC: player count only known after loading, unused slots flagged (not a method) as bricks
  const hatSquad = {
    loaded: false, players: [],
    getNumOfRequiredPlayers() { if (!this.loaded) throw new Error('not loaded'); return 3; },
    getFieldPlayers: () => ['GK', 'RB', 'CB', 'CB', 'LB', 'CM', 'CM', 'CM', 'RW', 'ST', 'LW'].map((typeName, index) => ({ index, isBrick: ![5, 6, 7].includes(index), position: { typeName } })),
    removeAllItems() { this.players = []; },
    setPlayers(arr) { this.players = arr.filter(Boolean); T.hatIdx = arr.map((x, i) => (x ? i : -1)).filter((i) => i >= 0); },
  };
  const hatChallenge = { id: 81, name: 'Hat-trick', squad: hatSquad, isCompleted: () => false,
    eligibilityRequirements: [{ scope: 0, count: -1, kvPairs: { _collection: { 26: [75] } } }, { scope: 1, count: -1, kvPairs: { _collection: { 28: [84] } } }] };
  // every player ≤ 64: the club has no bronzes, so all come from the market
  const bronzeChallenge = { id: 80, name: 'Break Away', squad: sbcSquad, isCompleted: () => false,
    eligibilityRequirements: [{ scope: 1, count: -1, kvPairs: { _collection: { 28: [64] } } }] };

  window.services = {
    User: { getUser: () => ({ coins: { amount: 120000 } }) },
    Localization: { localize: (x) => x },
    Item: {
      clearTransferMarketCache() { T.gen = (T.gen || 0) + 1; },
      searchTransferMarket(c) {
        T.searches.push({ league: c.league, nation: c.nation, pos: c._position, max: c.maxBuy, min: c.minBuy });
        // cheap tradeable gold fodder on the market, a few of each rating; listings are
        // tagged with the cache generation — buying one after the cache was cleared fails (403)
        const fodder = () => {
          const fod = [];
          [[84, 900], [85, 1400], [86, 2200], [87, 3200], [88, 5000], [89, 9000]].forEach(([r, price]) => {
            for (let k = 0; k < 3; k++) {
              const it = mk(4000 + r * 10 + k, r, { pos: ['CB', 'CM', 'ST'][k], league: 53 + k, nation: 30 + k, untradeable: false, name: `Market ${r}-${k}`, price: price + k * 100 });
              it.gen = T.gen;
              fod.push(it);
            }
          });
          return fod;
        };
        if (!c._position && c.level === 'bronze') {
          if (T.blockSub) { T.blockSub = false; return obs({ success: true, data: { items: [] } }); } // replacements briefly gone too
          const br = [];
          for (let k = 0; k < 20; k++) {
            const it = mk(4500 + k, 55 + (k % 10), { pos: ['GK', 'CB', 'CM', 'ST', 'RB'][k % 5], league: 60 + k, untradeable: false, name: `Bronze ${k}`, price: 200 + (k % 5) * 50 });
            it.gen = T.gen;
            br.push(it);
          }
          return obs({ success: true, data: { items: br.filter((i) => (!c.maxBuy || i._auction.buyNowPrice <= c.maxBuy) && (!c.minBuy || i._auction.buyNowPrice >= c.minBuy)) } });
        }
        if (c.maskedDefId >= 4500 && c.maskedDefId < 4520) {
          T.fresh = (T.fresh || 0) + 1;
          if (T.fresh === 2) return obs({ success: true, data: { items: [] } }); // this card sold out → replacement
          if (T.fresh === 4) { T.blockSub = true; return obs({ success: true, data: { items: [] } }); } // card + replacements gone → run stops
          const it = mk(c.maskedDefId, 55 + ((c.maskedDefId - 4500) % 10), { untradeable: false, name: `Bronze ${c.maskedDefId - 4500}`, price: 250 });
          it.gen = T.gen;
          return obs({ success: true, data: { items: [it] } });
        }
        if (!c._position && c.level === 'gold') {
          return obs({ success: true, data: { items: fodder().filter((i) => (!c.maxBuy || i._auction.buyNowPrice <= c.maxBuy) && (!c.minBuy || i._auction.buyNowPrice >= c.minBuy)) } });
        }
        if (c.maskedDefId >= 4840 && c.maskedDefId < 4900) {
          return obs({ success: true, data: { items: fodder().filter((i) => i.definitionId === c.maskedDefId && (!c.maxBuy || i._auction.buyNowPrice <= c.maxBuy)) } });
        }
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
      bid(item, price) {
        if (item.gen !== undefined && item.gen !== T.gen) { T.stale = (T.stale || 0) + 1; return obs({ success: false, status: 403 }); }
        T.sbcBought = (T.sbcBought || []).concat([{ r: item.rating, price, d: item.definitionId }]); T.coins -= price; return obs({ success: true });
      },
      discard(items) { items.forEach((it) => { T.unassigned = T.unassigned.filter((u) => u !== it); T.piles.discarded.push(it.rating); }); return obs({ success: true }); },
    },
    Club: {
      // the real Web App returns club results in `response`, not `data`
      search(c) { const page = club.slice(c.offset, c.offset + c.count); return obs({ success: true, response: { items: page, retrievedAll: c.offset + c.count >= club.length } }); },
    },
    Store: { getPacks: () => obs({ success: true, response: { packs: T.packList.slice() } }) },
    Squad: { getActiveSquadId: () => 1, requestSquadById: () => obs({ success: true, data: { squad } }),
      create(name, formation, items) { T.created = { name, formation, n: items.filter(Boolean).length, ratings: items.map((i) => i && i.rating) }; return obs({ success: true }); } },
    SBC: {
      requestSets: () => obs({ success: true, data: { sets } }),
      requestChallengesForSet: (set) => obs({ success: true, data: { challenges: set.id === 1 ? (done < 2 ? [challenge()] : []) : set.id === 3 ? [eliteChallenge] : set.id === 4 ? [bronzeChallenge] : set.id === 5 ? [hatChallenge] : set.id === 6 ? [pointsChallenge] : [chemChallenge] } }),
      loadChallenge: (ch) => { if (ch && ch.squad && 'loaded' in ch.squad) ch.squad.loaded = true; return obs({ success: true }); },
      saveChallenge: () => obs({ success: true }),
      initiateOneClickChallenge: () => obs({ success: true }),
      submitOneClickChallenge(ch, set, ids) {
        const byId = allItems;
        if (ids.some((id) => squadItems.some((s) => s.id === id))) return obs({ success: false, status: 409 });
        const pts = ids.reduce((a, id) => a + ((byId.get(id) || {}).sbsScore || 0), 0);
        T.pointsBatches = (T.pointsBatches || []).concat([ids.length]);
        T.pointsIds = (T.pointsIds || []).concat(ids);
        const submittedScore = ch.submittedScore + pts;
        ch.submittedScore = submittedScore; // the Web App updates the challenge, like _applyOneClickSubmission
        return obs({ success: true, data: { submittedScore, challengeCompleted: submittedScore >= ch.scoreRequirement } });
      },
      submitChallenge(ch) {
        if (T.rewardOnSubmit) { T.rewardOnSubmit = false; T.addRewardPack(); }
        T.submitted.push(ch.squad.players.map((p) => ({ id: p.id, def: p.definitionId, r: p.rating, rare: p.rareflag, pile: p.pile, untradeable: p.untradeable })));
        done++;
        return obs({ success: true });
      },
    },
    Chemistry: { isFeatureEnabled: () => true },
    Academy: {
      requestAcademyHub: () => obs({ success: true, data: { slots: [
        { id: 501, name: 'Pacey Strikers', prices: { _collection: { COINS: { amount: 5000 } } }, meetsRequirements: (it) => it.rating <= 85 && (it.preferredPosition === 25 || it.preferredPosition === 'ST') },
        { id: 502, name: 'Icon Only', prices: { _collection: {} }, meetsRequirements: () => false },
      ] } }),
      getCategories: () => [],
      requestSlotsByCategory: () => obs({ success: true, data: { slots: [] } }),
      getSlotPreview: (slotId, itemId) => obs({ success: true, data: { updatedSlot: { levels: [{ boostedPlayer: { rating: 80 } }, { boostedPlayer: { rating: 87 } }] } } }),
    },
  };
  window.repositories = { Item: { numItemsInCache: () => T.unassigned.length, isPileFull: () => false, setDirty() {} } };
}

module.exports = { installMock };
