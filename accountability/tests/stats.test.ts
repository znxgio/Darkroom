import { describe, expect, it } from 'vitest';
import { streak, type ExtraRequirement, type Task, type TaskLog } from '../src/lib/schedule';
import {
  bestStreak,
  dayDetail,
  dayResults,
  defaultReviewWeek,
  excuseHistory,
  excusePatterns,
  missesNeedingReasons,
  monthGrid,
  reasonWords,
  reviewWindow,
  weekExcuses,
} from '../src/features/stats/logic';
import { excusesApi, reviewsApi } from '../src/features/stats/api';
import { memoryRepo } from '../src/data/memoryRepo';
import type { Backend } from '../src/data/backend';

function task(p: Partial<Task> & { id: string }): Task {
  return {
    name: p.id,
    kind: 'recurring',
    pattern: 'daily',
    weekdays: [],
    one_time_date: null,
    goal_time: null,
    critical: false,
    start_date: '2026-11-01',
    archived_on: null,
    sort: 0,
    ...p,
  };
}
const log = (task_id: string, day: string, status: TaskLog['status'] = 'done', reason: string | null = null): TaskLog => ({
  task_id,
  day,
  status,
  reason,
});
const MON = '2026-11-16';

describe('best streak', () => {
  const a = task({ id: 'a', start_date: '2026-11-01' });
  it('finds the longest green run; gray days pass, red resets', () => {
    const gym = task({ id: 'gym', pattern: 'weekdays', weekdays: [1, 2, 3, 4, 5], start_date: '2026-11-02' });
    // Nov 2–6 done (5), Nov 9 missed, Nov 10–13 done (4); weekends gray
    const days = ['02', '03', '04', '05', '06', '10', '11', '12', '13'].map((d) => log('gym', `2026-11-${d}`));
    const res = dayResults('2026-11-02', '2026-11-14', '2026-11-14', [gym], days);
    expect(bestStreak(res)).toBe(5);
    expect(streak('2026-11-14', [gym], days)).toBe(4);
  });
  it('agrees with the current streak when the current run is the best', () => {
    const logs = ['2026-11-13', '2026-11-14', '2026-11-15'].map((d) => log('a', d));
    const res = dayResults('2026-11-13', MON, MON, [a], logs);
    expect(bestStreak(res)).toBe(streak(MON, [a], logs, [], '2026-11-13'));
  });
  it("today's pending doesn't break it; a skip today does", () => {
    const logs = [log('a', '2026-11-15')];
    expect(bestStreak(dayResults('2026-11-15', MON, MON, [a], logs))).toBe(1);
    const skipped = [...logs, log('a', MON, 'skipped', 'x'), log('a', '2026-11-14')];
    expect(bestStreak(dayResults('2026-11-14', MON, MON, [a], skipped))).toBe(2);
  });
  it('counts extras like tasks', () => {
    const photos: ExtraRequirement = { key: 'photos', appliesOn: () => true, doneOn: (d) => d !== '2026-11-14' };
    const logs = ['2026-11-13', '2026-11-14', '2026-11-15'].map((d) => log('a', d));
    expect(bestStreak(dayResults('2026-11-13', '2026-11-15', MON, [a], logs, [photos]))).toBe(1);
  });
});

describe('missed-reason gate', () => {
  const a = task({ id: 'a', name: 'Gym', start_date: '2026-11-14' });
  it('lists unexplained past misses oldest first; skips and explained misses are fine', () => {
    const logs = [
      log('a', '2026-11-14', 'skipped', 'sick'),
      log('a', '2026-11-15', 'missed', null), // recorded, reason missing
    ];
    const got = missesNeedingReasons('2026-11-17', [a], logs, [], []);
    expect(got.map((m) => m.day)).toEqual(['2026-11-15', MON]);
    expect(got[0]).toMatchObject({ kind: 'task', taskId: 'a', name: 'Gym' });
    const explained = [...logs.slice(0, 1), log('a', '2026-11-15', 'missed', 'overslept'), log('a', MON, 'done')];
    expect(missesNeedingReasons('2026-11-17', [a], explained, [], [])).toEqual([]);
  });
  it("never asks about today, or before the first task, or more than 30 days back", () => {
    expect(missesNeedingReasons('2026-11-14', [a], [], [], [])).toEqual([]);
    const old = task({ id: 'o', start_date: '2026-09-01' });
    const got = missesNeedingReasons(MON, [old], [], [], []);
    expect(got.length).toBe(30);
    expect(got[0].day).toBe('2026-10-17');
  });
  it('mid-week "once a week" items are not misses until Sunday', () => {
    const w = task({ id: 'w', pattern: 'weekly_any', start_date: MON });
    expect(missesNeedingReasons('2026-11-20', [w], [], [], [])).toEqual([]);
    expect(missesNeedingReasons('2026-11-23', [w], [], [], []).map((m) => m.day)).toEqual(['2026-11-22']);
  });
  it('asks about missed extras until an excuse exists', () => {
    const photos: ExtraRequirement = { key: 'photos', appliesOn: (d) => d >= '2026-11-15', doneOn: (d) => d === MON };
    const got = missesNeedingReasons('2026-11-17', [], [], [photos], []);
    expect(got).toEqual([{ kind: 'extra', day: '2026-11-15', key: 'photos', name: 'Daily photo', critical: false }]);
    expect(missesNeedingReasons('2026-11-17', [], [], [photos], [{ day: '2026-11-15', item_key: 'photos', reason: 'x' }])).toEqual([]);
  });
});

describe('excuse history + patterns', () => {
  const gym = task({ id: 'gym', name: 'Gym' });
  const gym2 = task({ id: 'gym2', name: 'Gym', start_date: '2026-11-10' }); // a later version
  const read = task({ id: 'read', name: 'Read' });
  const logs = [
    log('gym', '2026-11-02', 'missed', 'Too tired after work'), // Mon
    log('gym2', '2026-11-16', 'skipped', 'Work ran late, tired'), // Mon
    log('read', '2026-11-09', 'missed', 'Forgot'), // Mon
    log('read', '2026-11-11', 'done'),
    log('read', '2026-11-12', 'missed', null), // no reason yet: not listed
    log('gym', '2026-11-05', 'skipped', 'Sick'), // Thu
  ];
  const ex = excuseHistory([gym, gym2, read], logs, [{ day: '2026-11-07', item_key: 'photos', reason: 'Phone died' }]);
  it('lists skips and explained misses newest first, with extras', () => {
    expect(ex.map((e) => `${e.day} ${e.name} ${e.kind}`)).toEqual([
      '2026-11-16 Gym skipped',
      '2026-11-09 Read missed',
      '2026-11-07 Daily photo missed',
      '2026-11-05 Gym skipped',
      '2026-11-02 Gym missed',
    ]);
  });
  it('summarises patterns', () => {
    const p = excusePatterns(ex);
    expect(p.topItems[0]).toEqual({ name: 'Gym', count: 3 });
    expect(p.topWords).toEqual([
      { word: 'tired', count: 2 },
      { word: 'work', count: 2 },
    ]);
    expect(p.worstWeekday).toEqual({ weekday: 1, count: 3 });
  });
  it('a tie is not a pattern', () => {
    expect(excusePatterns(ex.slice(1, 3)).worstWeekday).toBeNull();
    expect(excusePatterns([]).topItems).toEqual([]);
  });
  it('drops filler words', () => {
    expect(reasonWords("I was too tired and didn't go to the gym")).toEqual(['tired', 'gym']);
  });
});

describe('calendar + day detail', () => {
  it('builds a Mon-first month grid', () => {
    const g = monthGrid(2026, 11); // Nov 1 2026 is a Sunday
    expect(g.slice(0, 7)).toEqual([null, null, null, null, null, null, '2026-11-01']);
    expect(g.length % 7).toBe(0);
    expect(g.filter(Boolean).length).toBe(30);
    expect(monthGrid(2027, 2).filter(Boolean).length).toBe(28);
  });
  it('shows a past day read-only, hiding "once a week" items done later', () => {
    const a = task({ id: 'a', name: 'Gym' });
    const w = task({ id: 'w', name: 'Call mom', pattern: 'weekly_any' });
    const rows = dayDetail(MON, '2026-11-20', [a, w], [log('a', MON, 'skipped', 'sick'), log('w', '2026-11-18')], [], []);
    expect(rows).toEqual([{ name: 'Gym', state: 'skipped', reason: 'sick', critical: false }]);
  });
});

describe('weekly review', () => {
  it('note window: from Sunday through the following week', () => {
    expect(reviewWindow(MON, '2026-11-21')).toBe('upcoming');
    expect(reviewWindow(MON, '2026-11-22')).toBe('open');
    expect(reviewWindow(MON, '2026-11-29')).toBe('open');
    expect(reviewWindow(MON, '2026-11-30')).toBe('locked');
  });
  it('defaults to this week on Sunday, last week otherwise', () => {
    expect(defaultReviewWeek('2026-11-22')).toBe(MON);
    expect(defaultReviewWeek('2026-11-24', '2026-11-01')).toBe(MON);
    expect(defaultReviewWeek(MON, '2026-11-01')).toBe('2026-11-09');
    // nothing happened last week yet: this week
    expect(defaultReviewWeek('2026-11-19', MON)).toBe(MON);
  });
  it("collects the week's misses and skips", () => {
    const a = task({ id: 'a', name: 'Gym' });
    const logs = [log('a', MON, 'skipped', 'sick'), log('a', '2026-11-17', 'missed', 'late')];
    const { misses, skips } = weekExcuses(MON, '2026-11-19', [a], logs, [], []);
    expect(skips.map((s) => s.reason)).toEqual(['sick']);
    expect(misses.map((m) => `${m.day}:${m.reason}`)).toEqual(['2026-11-17:late', '2026-11-18:']);
  });
});

describe('demo storage enforces the same rules as the database', () => {
  let now = '2026-11-22T20:00:00Z';
  const backend = (): Backend => {
    const clock = () => new Date(now);
    return { repo: memoryRepo({ clock, storageKey: null }), supabase: null, now: clock, storagePrefix: 't' };
  };
  // demoStore uses localStorage; give the node test env a tiny one
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  it('weekly review notes', async () => {
    const api = reviewsApi(backend());
    await expect(api.save('2026-11-23', 'x')).rejects.toThrow(/opens on Sunday/);
    await expect(api.save('2026-11-17', 'x')).rejects.toThrow(/Monday/);
    await api.save(MON, 'Gym before work');
    now = '2026-11-30T20:00:00Z';
    await expect(api.save(MON, 'rewrite')).rejects.toThrow(/locked/);
    expect((await api.list()).map((r) => r.note)).toEqual(['Gym before work']);
  });
  it('extra excuses: past only, once', async () => {
    now = '2026-11-18T20:00:00Z';
    const api = excusesApi(backend());
    await expect(api.add('2026-11-18', 'photos', 'x')).rejects.toThrow(/past day/);
    await api.add('2026-11-17', 'photos', 'Phone died');
    await expect(api.add('2026-11-17', 'photos', 'again')).rejects.toThrow(/changed/);
    expect(await api.list('2026-11-01', '2026-11-30')).toEqual([{ day: '2026-11-17', item_key: 'photos', reason: 'Phone died' }]);
  });
});
