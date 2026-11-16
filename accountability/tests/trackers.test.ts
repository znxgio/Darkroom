import { describe, expect, it, beforeEach } from 'vitest';
import {
  changeOn,
  changeText,
  dayDiff,
  inRange,
  monotonePath,
  movingAverage,
  niceTicks,
  rangeStart,
  signed,
  sinceLabel,
  summarize,
  toPoints,
  type Point,
} from '../src/features/trackers/stats';
import { TRACKERS, trackerByKey, textTracker } from '../src/features/trackers/registry';
import { trackersApi } from '../src/features/trackers/api';
import { memoryRepo } from '../src/data/memoryRepo';
import type { Backend } from '../src/data/backend';

const pts = (...xs: [string, number][]): Point[] => xs.map(([day, v]) => ({ day, v }));

describe('movingAverage', () => {
  it('averages a trailing 7-calendar-day window', () => {
    const p = pts(
      ['2026-11-01', 7],
      ['2026-11-02', 8],
      ['2026-11-03', 9],
      ['2026-11-07', 10],
      ['2026-11-08', 11], // window 11-02..11-08: 8,9,10,11
      ['2026-11-20', 20], // alone after a gap
    );
    const ma = movingAverage(p);
    expect(ma.map((x) => x.day)).toEqual(p.map((x) => x.day));
    expect(ma[0].v).toBe(7);
    expect(ma[1].v).toBe(7.5);
    expect(ma[2].v).toBe(8);
    expect(ma[3].v).toBe(8.5); // 11-01..11-07
    expect(ma[4].v).toBe(9.5);
    expect(ma[5].v).toBe(20);
  });
  it('handles empty and custom windows', () => {
    expect(movingAverage([])).toEqual([]);
    expect(movingAverage(pts(['2026-11-01', 1], ['2026-11-02', 3]), 1).map((x) => x.v)).toEqual([1, 3]);
  });
});

describe('summarize', () => {
  it('finds min, max, latest, change', () => {
    const s = summarize(pts(['2026-11-01', 180], ['2026-11-02', 178.2], ['2026-11-03', 181], ['2026-11-04', 179.5]))!;
    expect(s.count).toBe(4);
    expect(s.min).toEqual({ day: '2026-11-02', v: 178.2 });
    expect(s.max).toEqual({ day: '2026-11-03', v: 181 });
    expect(s.latest.v).toBe(179.5);
    expect(s.change).toBeCloseTo(-0.5);
    expect(s.avg).toBeCloseTo(179.675);
  });
  it('is null when empty; ties keep the latest day', () => {
    expect(summarize([])).toBeNull();
    const s = summarize(pts(['2026-11-01', 5], ['2026-11-02', 5]))!;
    expect(s.min.day).toBe('2026-11-02');
    expect(s.max.day).toBe('2026-11-02');
  });
});

describe('ranges', () => {
  it('30d includes today and the 29 days before', () => {
    expect(rangeStart('30d', '2026-11-30')).toBe('2026-11-01');
    expect(rangeStart('all', '2026-11-30')).toBeNull();
    const p = pts(['2026-10-31', 1], ['2026-11-01', 2], ['2026-11-30', 3], ['2026-12-01', 4]);
    expect(inRange(p, '30d', '2026-11-30').map((x) => x.v)).toEqual([2, 3]);
    expect(inRange(p, 'all', '2026-11-30').map((x) => x.v)).toEqual([1, 2, 3]);
  });
});

describe('change labels', () => {
  it('compares a day with the entry before it', () => {
    const p = pts(['2026-11-13', 182.4], ['2026-11-16', 182.0]);
    const c = changeOn(p, '2026-11-16')!;
    expect(c.prevDay).toBe('2026-11-13');
    expect(c.delta).toBeCloseTo(-0.4);
    expect(changeOn(p, '2026-11-13')).toBeNull();
    expect(changeOn(p, '2026-11-17')).toBeNull();
  });
  it('words the "since" part', () => {
    expect(sinceLabel('2026-11-15', '2026-11-16')).toBe('yesterday');
    expect(sinceLabel('2026-11-13', '2026-11-16')).toBe('Fri'); // Nov 13 2026 is a Friday
    expect(sinceLabel('2026-11-03', '2026-11-16')).toBe('Nov 3');
    expect(sinceLabel('2025-12-30', '2026-01-10')).toBe('Dec 30, 2025');
  });
  it('formats the change text with a real minus sign', () => {
    expect(changeText(-0.4000001, '2026-11-13', '2026-11-16', 1, 'lb')).toBe('−0.4 lb since Fri');
    expect(changeText(1.25, '2026-11-15', '2026-11-16', 1, 'lb')).toBe('+1.3 lb since yesterday');
    expect(changeText(0.01, '2026-11-15', '2026-11-16', 1, 'lb')).toBe('No change since yesterday');
    expect(signed(-0.04, 1)).toBe('0.0');
    expect(dayDiff('2026-11-01', '2026-11-16')).toBe(15);
  });
});

describe('niceTicks', () => {
  it('produces round steps covering the range', () => {
    expect(niceTicks(178.2, 183.7)).toEqual([178, 180, 182, 184]);
    const t = niceTicks(178.2, 183.7);
    expect(t[0]).toBeLessThanOrEqual(178.2);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(183.7);
    const step = t[1] - t[0];
    expect([1, 2, 2.5, 5]).toContain(step);
    expect(niceTicks(0, 100)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(180, 180).length).toBeGreaterThan(1);
  });
});

describe('monotonePath', () => {
  it('draws a smooth path through every point without overshoot', () => {
    expect(monotonePath([])).toBe('');
    expect(monotonePath([[1, 2]])).toBe('M1,2');
    const d = monotonePath([
      [0, 10],
      [10, 0],
      [20, 0],
      [30, 10],
    ]);
    expect(d.startsWith('M0,10C')).toBe(true);
    expect(d.endsWith('30,10')).toBe(true);
    // control points of the flat middle segment stay flat
    const nums = d.replace(/[MC]/g, ',').split(',').filter(Boolean).map(Number);
    const ys = nums.filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(10);
  });
});

describe('registry', () => {
  const weight = trackerByKey('weight')!;
  it('has weight with valid keys', () => {
    expect(TRACKERS.map((t) => t.key)).toContain('weight');
    for (const t of TRACKERS) expect(t.key).toMatch(/^[a-z][a-z0-9_]{0,30}$/);
    expect(new Set(TRACKERS.map((t) => t.key)).size).toBe(TRACKERS.length);
  });
  it('parses, rounds and validates weight', () => {
    expect(weight.parse('182.44')).toEqual({ v: 182.4 });
    expect(weight.parse(' 182,46 ')).toEqual({ v: 182.5 });
    expect(weight.parse('183')).toEqual({ v: 183 });
    expect(typeof weight.parse('')).toBe('string');
    expect(typeof weight.parse('abc')).toBe('string');
    expect(typeof weight.parse('-5')).toBe('string');
    expect(weight.parse('49.9')).toMatch(/between 50 and 700/);
    expect(weight.parse('701')).toMatch(/between/);
    expect(weight.format({ v: 183 })).toBe('183.0');
    expect(weight.step).toBe(0.1);
    expect(weight.chart).toBe('line');
  });
  it('supports text trackers', () => {
    const notes = textTracker({ key: 'notes', name: 'Notes', maxLength: 5 });
    expect(notes.parse('  hi ')).toEqual({ text: 'hi' });
    expect(typeof notes.parse('   ')).toBe('string');
    expect(typeof notes.parse('too long')).toBe('string');
    expect(notes.chart).toBe('none');
  });
  it('toPoints keeps numbers only, sorted', () => {
    expect(
      toPoints([
        { tracker_key: 'weight', day: '2026-11-02', value: { v: 2 } },
        { tracker_key: 'weight', day: '2026-11-01', value: { v: 1 } },
        { tracker_key: 'weight', day: '2026-11-03', value: { text: 'x' } },
      ]),
    ).toEqual(pts(['2026-11-01', 1], ['2026-11-02', 2]));
  });
});

describe('trackersApi (demo)', () => {
  let now = new Date('2026-11-16T17:00:00Z');
  beforeEach(() => {
    const mem = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    now = new Date('2026-11-16T17:00:00Z');
  });
  const backend = (): Backend => {
    const clock = () => now;
    return { repo: memoryRepo({ clock, storageKey: null }), supabase: null, now: clock, storagePrefix: 't' };
  };

  it('writes only today, edits today, lists and finds the latest', async () => {
    const api = trackersApi(backend());
    now = new Date('2026-11-13T17:00:00Z');
    await api.upsertToday('weight', { v: 182.4 });
    now = new Date('2026-11-16T17:00:00Z');
    await api.upsertToday('weight', { v: 182.2 });
    await api.upsertToday('weight', { v: 182.0 }); // edit, not a second row
    expect(await api.get('weight', '2026-11-16')).toEqual({ tracker_key: 'weight', day: '2026-11-16', value: { v: 182 } });
    expect((await api.list('weight', '2026-11-01', '2026-11-30')).map((e) => e.day)).toEqual(['2026-11-13', '2026-11-16']);
    expect((await api.latest('weight'))?.day).toBe('2026-11-16');
    expect((await api.latest('weight', '2026-11-16'))?.day).toBe('2026-11-13');
    expect(await api.latest('sleep')).toBeNull();
    await api.removeToday('weight');
    expect(await api.get('weight', '2026-11-16')).toBeNull();
    expect(await api.get('weight', '2026-11-13')).not.toBeNull();
    await expect(api.upsertToday('Bad-Key', { v: 1 })).rejects.toThrow();
  });
});
