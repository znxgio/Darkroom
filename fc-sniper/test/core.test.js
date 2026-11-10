const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../fc-sniper.user.js');

test('price steps follow EA bands', () => {
  assert.equal(c.priceStep(500), 50);
  assert.equal(c.priceStep(1000), 100);
  assert.equal(c.priceStep(12000), 250);
  assert.equal(c.priceStep(75000), 500);
  assert.equal(c.priceStep(250000), 1000);
});

test('roundPrice snaps to valid prices', () => {
  assert.equal(c.roundPrice(1234), 1200);
  assert.equal(c.roundPrice(1234, 'up'), 1300);
  assert.equal(c.roundPrice(10100), 10000);
  assert.equal(c.roundPrice(10, 'up'), 150);
  assert.equal(c.roundPrice(99999999), c.MAX_PRICE);
});

test('next/prev price cross band boundaries', () => {
  assert.equal(c.nextPrice(950), 1000);
  assert.equal(c.nextPrice(1000), 1100);
  assert.equal(c.prevPrice(1000), 950);
  assert.equal(c.prevPrice(10000), 9900);
  assert.equal(c.prevPrice(150), 150);
});

test('tax and profit', () => {
  assert.equal(c.afterTax(10000), 9500);
  assert.equal(c.profit(9000, 10000), 500);
});

test('breakEvenSell guarantees min profit', () => {
  for (const buy of [200, 950, 4300, 18750, 99000, 420000]) {
    const sell = c.breakEvenSell(buy, 300);
    assert.ok(c.profit(buy, sell) >= 300, `buy ${buy} sell ${sell}`);
    assert.equal(c.roundPrice(sell, 'nearest'), sell);
  }
});

test('cacheBustBid cycles and stays under max buy', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const b = c.cacheBustBid(i, 600);
    assert.ok(b < 600);
    seen.add(b);
  }
  assert.ok(seen.size > 3);
  assert.equal(c.cacheBustBid(0, 150), 0);
});

test('pickTargets filters by price, rating and coins', () => {
  const listings = [
    { tradeId: 1, buyNowPrice: 900, rating: 85 },
    { tradeId: 2, buyNowPrice: 700, rating: 83 },
    { tradeId: 3, buyNowPrice: 1200, rating: 86 },
    { tradeId: 4, buyNowPrice: 800, rating: 86 },
  ];
  const cfg = { maxBuy: 1000, minRating: 84, maxBuysPerSearch: 2 };
  assert.deepEqual(c.pickTargets(listings, cfg, 5000).map((l) => l.tradeId), [4, 1]);
  assert.deepEqual(c.pickTargets(listings, cfg, 850).map((l) => l.tradeId), [4]);
});

test('planSellPrice', () => {
  assert.equal(c.planSellPrice(1000, { autoList: false }), 0);
  assert.equal(c.planSellPrice(1000, { autoList: true, sellPrice: 1520 }), 1500);
  assert.ok(c.profit(1000, c.planSellPrice(1000, { autoList: true, minProfit: 200 })) >= 200);
});

test('classifyStatus', () => {
  assert.equal(c.classifyStatus(458), 'captcha');
  assert.equal(c.classifyStatus('521'), 'throttled');
  assert.equal(c.classifyStatus(470), 'coins');
  assert.equal(c.classifyStatus('470'), 'coins');
  assert.equal(c.classifyStatus(461), 'missed');
  assert.equal(c.classifyStatus(401), 'session');
});

test('jitter stays in range', () => {
  assert.equal(c.jitter(100, 200, () => 0), 100);
  assert.equal(c.jitter(100, 200, () => 1), 200);
  assert.equal(c.jitter(200, 100, () => 0.5), 150);
});
