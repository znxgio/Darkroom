import { describe, expect, it } from 'vitest';
import { addDays, dayOf, weekStart, weekday, weekEnd } from '../src/lib/dates';
import {
  canSkip,
  countsOn,
  dayResult,
  isShownOn,
  itemsFor,
  streak,
  weeklyScore,
  type Task,
  type TaskLog,
} from '../src/lib/schedule';
import { memoryRepo } from '../src/data/memoryRepo';

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
const done = (task_id: string, day: string): TaskLog => ({ task_id, day, status: 'done', reason: null });
const skip = (task_id: string, day: string): TaskLog => ({ task_id, day, status: 'skipped', reason: 'x' });

// 2026-11-16 is a Monday.
const MON = '2026-11-16';
const SUN = '2026-11-22';

describe('dates', () => {
  it('uses LA time for the day boundary', () => {
    // 07:30 UTC on Nov 17 = 11:30 PM Nov 16 in LA (PST, UTC-8)
    expect(dayOf(new Date('2026-11-17T07:30:00Z'))).toBe('2026-11-16');
    expect(dayOf(new Date('2026-11-17T08:00:00Z'))).toBe('2026-11-17');
    // summer (PDT, UTC-7)
    expect(dayOf(new Date('2026-07-01T06:59:00Z'))).toBe('2026-06-30');
    expect(dayOf(new Date('2026-07-01T07:00:00Z'))).toBe('2026-07-01');
  });
  it('weeks run Mon–Sun', () => {
    expect(weekday(MON)).toBe(1);
    expect(weekStart(SUN)).toBe(MON);
    expect(weekStart(MON)).toBe(MON);
    expect(weekEnd(MON)).toBe(SUN);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    // DST change week (Nov 1 2026)
    expect(addDays('2026-10-31', 2)).toBe('2026-11-02');
  });
});

describe('scheduling', () => {
  it('weekday tasks only count on their days', () => {
    const gym = task({ id: 'gym', pattern: 'weekdays', weekdays: [1, 2, 3, 4, 5] });
    expect(isShownOn(gym, MON)).toBe(true);
    expect(isShownOn(gym, SUN)).toBe(false);
    expect(dayResult(SUN, '2026-11-30', [gym], []).color).toBe('gray');
  });
  it('weekly on a day', () => {
    const clean = task({ id: 'clean', pattern: 'weekly_day', weekdays: [0] });
    expect(isShownOn(clean, SUN)).toBe(true);
    expect(isShownOn(clean, MON)).toBe(false);
  });
  it('one-time tasks only on their date', () => {
    const t = task({ id: 'dmv', kind: 'one_time', pattern: null, one_time_date: '2026-11-18' });
    expect(isShownOn(t, '2026-11-18')).toBe(true);
    expect(isShownOn(t, '2026-11-19')).toBe(false);
  });
  it('respects start and archive dates', () => {
    const t = task({ id: 'a', start_date: '2026-11-10', archived_on: '2026-11-15' });
    expect(isShownOn(t, '2026-11-09')).toBe(false);
    expect(isShownOn(t, '2026-11-10')).toBe(true);
    expect(isShownOn(t, '2026-11-14')).toBe(true);
    expect(isShownOn(t, '2026-11-15')).toBe(false);
  });
  it('weekly-any: shown all week, counts on the day done, or as a miss on Sunday', () => {
    const t = task({ id: 'call', pattern: 'weekly_any' });
    expect(isShownOn(t, MON)).toBe(true);
    expect(countsOn(t, MON)).toBe(false);
    expect(countsOn(t, SUN)).toBe(true);
    const logs = [done('call', '2026-11-18')];
    expect(isShownOn(t, '2026-11-19', logs)).toBe(false);
    expect(countsOn(t, '2026-11-18', logs)).toBe(true);
    expect(countsOn(t, SUN, logs)).toBe(false);
    // unresolved mid-week past day isn't a miss
    const items = itemsFor('2026-11-17', '2026-11-19', [t], []);
    expect(items[0].state).toBe('open');
  });
});

describe('day results', () => {
  const a = task({ id: 'a' });
  const b = task({ id: 'b' });
  it('green / red / pending / gray', () => {
    expect(dayResult(MON, '2026-11-17', [a, b], [done('a', MON), done('b', MON)]).color).toBe('green');
    expect(dayResult(MON, '2026-11-17', [a, b], [done('a', MON)]).color).toBe('red');
    expect(dayResult(MON, MON, [a, b], [done('a', MON)]).color).toBe('pending');
    expect(dayResult(MON, MON, [], []).color).toBe('gray');
  });
  it('an excused skip still counts as a miss', () => {
    expect(dayResult(MON, '2026-11-17', [a], [skip('a', MON)]).color).toBe('red');
  });
  it('unchecked past items are missed, today they are open', () => {
    expect(itemsFor(MON, '2026-11-17', [a], [])[0].state).toBe('missed');
    expect(itemsFor(MON, MON, [a], [])[0].state).toBe('open');
  });
  it('extra requirements (photos) count like tasks', () => {
    const photos = { key: 'photos', appliesOn: () => true, doneOn: (d: string) => d === MON };
    expect(dayResult(MON, '2026-11-17', [], [], [photos]).color).toBe('green');
    expect(dayResult('2026-11-15', '2026-11-17', [], [], [photos]).color).toBe('red');
  });
});

describe('streak', () => {
  const a = task({ id: 'a', start_date: '2026-11-10' });
  const gym = task({ id: 'gym', pattern: 'weekdays', weekdays: [1, 2, 3, 4, 5], start_date: '2026-11-10' });
  it('counts back from yesterday when today is in progress', () => {
    const logs = ['2026-11-13', '2026-11-14', '2026-11-15'].map((d) => done('a', d));
    expect(streak(MON, [a], logs)).toBe(3);
  });
  it('includes today once complete', () => {
    const logs = ['2026-11-14', '2026-11-15', MON].map((d) => done('a', d));
    expect(streak(MON, [a], logs)).toBe(3);
  });
  it('a skip today resets it', () => {
    expect(streak(MON, [a], [done('a', '2026-11-15'), skip('a', MON)])).toBe(0);
  });
  it('gray days do not break it', () => {
    // gym only; Fri 13 done, Sat/Sun gray, Mon in progress
    expect(streak(MON, [gym], [done('gym', '2026-11-12'), done('gym', '2026-11-13')])).toBe(2);
  });
});

describe('weekly score', () => {
  it('leaves out still-open items', () => {
    const a = task({ id: 'a' });
    const s = weeklyScore('2026-11-18', '2026-11-18', [a], [done('a', MON)]);
    // Mon done, Tue missed, Wed open → 1/2
    expect(s).toEqual({ done: 1, counted: 2, pct: 50 });
  });
});

describe('demo repo enforces no backfilling', () => {
  it('only today can be checked off', async () => {
    const repo = memoryRepo({ clock: () => new Date('2026-11-16T20:00:00Z'), storageKey: null });
    const t = await repo.createTask({
      name: 'Gym',
      kind: 'recurring',
      pattern: 'daily',
      weekdays: [],
      one_time_date: null,
      goal_time: null,
      critical: false,
    });
    await repo.checkOff(t.id, MON);
    await expect(repo.checkOff(t.id, '2026-11-15')).rejects.toThrow(/locked/);
    await expect(repo.checkOff(t.id, '2026-11-17')).rejects.toThrow(/future/);
    await expect(repo.skip(t.id, MON, '  ')).rejects.toThrow(/reason/);
    await repo.explainMiss(t.id, '2026-11-15', 'overslept');
    await expect(repo.explainMiss(t.id, '2026-11-15', 'again')).rejects.toThrow(/locked/);
    expect((await repo.listLogs('2026-11-01', '2026-11-30')).length).toBe(2);
  });
});

describe('weekly-any rules', () => {
  const t = task({ id: 'call', pattern: 'weekly_any' });
  it('can only be skipped on Sunday', () => {
    expect(canSkip(t, MON)).toBe(false);
    expect(canSkip(t, SUN)).toBe(true);
    expect(canSkip(task({ id: 'd' }), MON)).toBe(true);
  });
  it('earliest done wins, regardless of log order', () => {
    const logs = [done('call', '2026-11-20'), done('call', '2026-11-18')];
    expect(countsOn(t, '2026-11-18', logs)).toBe(true);
    expect(countsOn(t, '2026-11-20', logs)).toBe(false);
  });
  it('a Sunday skip counts as a miss on Sunday', () => {
    expect(dayResult(SUN, '2026-11-23', [t], [skip('call', SUN)]).color).toBe('red');
  });
});

describe('demo repo keeps history safe', () => {
  const base = {
    name: 'Gym', kind: 'recurring' as const, pattern: 'daily' as const, weekdays: [],
    one_time_date: null, goal_time: null, critical: false,
  };
  let now = '2026-11-16T20:00:00Z';
  const mk = () => memoryRepo({ clock: () => new Date(now), storageKey: null });

  it('a schedule change on a started task starts a new version tomorrow', async () => {
    now = '2026-11-10T20:00:00Z';
    const repo = mk();
    const t = await repo.createTask(base);
    now = '2026-11-16T20:00:00Z';
    const next = await repo.updateTask(t.id, { pattern: 'weekdays', weekdays: [1, 2, 3, 4, 5] });
    expect(next.id).not.toBe(t.id);
    expect(next.start_date).toBe('2026-11-17');
    const all = await repo.listTasks();
    expect(all.find((x) => x.id === t.id)?.archived_on).toBe('2026-11-17');
    // still counts today under the old schedule
    expect(isShownOn(all.find((x) => x.id === t.id)!, '2026-11-16')).toBe(true);
  });
  it('renames apply in place', async () => {
    now = '2026-11-10T20:00:00Z';
    const repo = mk();
    const t = await repo.createTask(base);
    now = '2026-11-16T20:00:00Z';
    const same = await repo.updateTask(t.id, { name: 'Gym AM', critical: true });
    expect(same.id).toBe(t.id);
  });
  it('archive takes effect tomorrow; a task added today with no entries is deleted', async () => {
    now = '2026-11-10T20:00:00Z';
    const repo = mk();
    const old = await repo.createTask(base);
    now = '2026-11-16T20:00:00Z';
    const fresh = await repo.createTask({ ...base, name: 'Oops' });
    expect(await repo.archiveTask(old.id)).toBe('archived');
    expect(await repo.archiveTask(fresh.id)).toBe('deleted');
    const all = await repo.listTasks();
    expect(all.map((x) => x.name)).toEqual(['Gym']);
    expect(all[0].archived_on).toBe('2026-11-17');
  });
  it('rejects tasks in the past', async () => {
    const repo = mk();
    await expect(repo.createTask({ ...base, kind: 'one_time', pattern: null, one_time_date: '2026-11-15' })).rejects.toThrow(/past/);
  });
});
