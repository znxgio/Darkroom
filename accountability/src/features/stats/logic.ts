// Pure helpers for the Progress tab, the missed-reason gate and the weekly review.
// All "how did a day go" rules come from src/lib/schedule.ts; this file only aggregates.
import { addDays, daysBetween, weekEnd, weekStart, weekday, type Day } from '../../lib/dates';
import {
  dayResult,
  itemsFor,
  type DayResult,
  type ExtraRequirement,
  type ItemState,
  type Task,
  type TaskLog,
} from '../../lib/schedule';
import { extraLabel } from './extras';

/** A reason given for a missed extra requirement (e.g. no photo that day). */
export interface ExtraExcuse {
  day: Day;
  item_key: string;
  reason: string;
}

/** First day anything counted (earliest task start), or today when there are no tasks. */
export function earliestStart(tasks: Task[], today: Day): Day {
  return tasks.reduce<Day>((m, t) => (t.start_date < m ? t.start_date : m), today);
}

/** Group logs by their Mon–Sun week, so per-day rules only scan that week's logs. */
function logsByWeek(logs: TaskLog[]): Map<Day, TaskLog[]> {
  const m = new Map<Day, TaskLog[]>();
  for (const l of logs) {
    const k = weekStart(l.day);
    const arr = m.get(k);
    if (arr) arr.push(l);
    else m.set(k, [l]);
  }
  return m;
}

/** Day results for every day from `from` to `to` (inclusive), oldest first. */
export function dayResults(
  from: Day,
  to: Day,
  today: Day,
  tasks: Task[],
  logs: TaskLog[],
  extras: ExtraRequirement[] = [],
): DayResult[] {
  if (from > to) return [];
  const byWeek = logsByWeek(logs);
  return daysBetween(from, to).map((d) =>
    dayResult(d, today, tasks, byWeek.get(weekStart(d)) ?? [], extras),
  );
}

/**
 * Longest run of green days in the history (oldest first). Same rules as `streak`:
 * gray days are passed over, a red day ends a run, today's "pending" neither adds nor breaks.
 */
export function bestStreak(results: DayResult[]): number {
  let run = 0;
  let best = 0;
  for (const r of results) {
    if (r.color === 'green') best = Math.max(best, ++run);
    else if (r.color === 'red') run = 0;
  }
  return best;
}

// ---------- Missed-reason gate ----------

export type PendingMiss =
  | { kind: 'task'; day: Day; taskId: string; name: string; critical: boolean }
  | { kind: 'extra'; day: Day; key: string; name: string; critical: false };

/**
 * Past misses that still need a reason, oldest first: tasks in state 'missed' with no log
 * or a 'missed' log without a reason, and extra requirements not met with no excuse yet.
 * Looks back at most `maxDays` days.
 */
export function missesNeedingReasons(
  today: Day,
  tasks: Task[],
  logs: TaskLog[],
  extras: ExtraRequirement[],
  excuses: ExtraExcuse[],
  maxDays = 30,
): PendingMiss[] {
  // Tasks never count before their start date, and extras say when they apply,
  // so the 30-day window is the only floor needed.
  const from = addDays(today, -maxDays);
  const to = addDays(today, -1);
  if (from > to) return [];
  const byWeek = logsByWeek(logs);
  const out: PendingMiss[] = [];
  for (const d of daysBetween(from, to)) {
    const wk = byWeek.get(weekStart(d)) ?? [];
    for (const it of itemsFor(d, today, tasks, wk)) {
      if (it.state === 'missed' && !it.log?.reason?.trim())
        out.push({ kind: 'task', day: d, taskId: it.task.id, name: it.task.name, critical: it.task.critical });
    }
    for (const x of extras) {
      if (!x.appliesOn(d) || x.doneOn(d)) continue;
      if (excuses.some((e) => e.day === d && e.item_key === x.key)) continue;
      out.push({ kind: 'extra', day: d, key: x.key, name: extraLabel(x.key), critical: false });
    }
  }
  return out;
}

// ---------- Excuse history ----------

export interface Excuse {
  day: Day;
  /** Display name; task versions (schedule edits) share a name, so history groups by it. */
  name: string;
  kind: 'skipped' | 'missed';
  reason: string;
}

/** Every skip and explained miss (tasks + extras), newest first. */
export function excuseHistory(tasks: Task[], logs: TaskLog[], excuses: ExtraExcuse[]): Excuse[] {
  const names = new Map(tasks.map((t) => [t.id, t.name]));
  const out: Excuse[] = [];
  for (const l of logs) {
    if (l.status === 'done' || !l.reason?.trim()) continue;
    out.push({ day: l.day, name: names.get(l.task_id) ?? 'Deleted task', kind: l.status, reason: l.reason.trim() });
  }
  for (const e of excuses) out.push({ day: e.day, name: extraLabel(e.item_key), kind: 'missed', reason: e.reason });
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.name.localeCompare(b.name)));
}

const STOP = new Set(
  (
    'a an the and or but so to of in on at for with from by up out off over into about as is are was were be been ' +
    'am i im i\'m me my mine we our you your it its it\'s this that these those there here then than too very just ' +
    'really got get getting had have has did do does didnt didn\'t dont don\'t not no yes all any some more most ' +
    'much many again also still because cause after before when while what which who how why where today day ' +
    'yesterday morning night time went go going felt feel was\'nt wasnt couldnt couldn\'t could would should can ' +
    'cant can\'t will wont won\'t one two lot bit kind like'
  ).split(' '),
);

/** Lowercase words of 3+ letters, minus filler words. */
export function reasonWords(reason: string): string[] {
  return (reason.toLowerCase().match(/[a-z][a-z']+/g) ?? [])
    .map((w) => w.replace(/'s$/, ''))
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

export interface Patterns {
  /** Most-excused items, most first (max 3). */
  topItems: { name: string; count: number }[];
  /** Words used in 2+ excuses, most first (max 5). */
  topWords: { word: string; count: number }[];
  /** Weekday (0=Sun) with the most skips + misses, if it stands out (2+). */
  worstWeekday: { weekday: number; count: number } | null;
}

function top<K>(counts: Map<K, number>, n: number, min = 1): { key: K; count: number }[] {
  return [...counts]
    .filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

export function excusePatterns(excuses: Excuse[]): Patterns {
  const byItem = new Map<string, number>();
  const byWord = new Map<string, number>();
  const byWd = new Map<number, number>();
  for (const e of excuses) {
    byItem.set(e.name, (byItem.get(e.name) ?? 0) + 1);
    byWd.set(weekday(e.day), (byWd.get(weekday(e.day)) ?? 0) + 1);
    for (const w of new Set(reasonWords(e.reason))) byWord.set(w, (byWord.get(w) ?? 0) + 1);
  }
  const wd = top(byWd, 2, 2);
  return {
    topItems: top(byItem, 3).map(({ key, count }) => ({ name: key, count })),
    topWords: top(byWord, 5, 2).map(({ key, count }) => ({ word: key, count })),
    // a tie for first isn't a pattern
    worstWeekday: wd.length && !(wd[1] && wd[1].count === wd[0].count) ? { weekday: wd[0].key, count: wd[0].count } : null,
  };
}

// ---------- Calendar ----------

/** Cells for a month grid, weeks Mon–Sun; null = padding outside the month. */
export function monthGrid(year: number, month: number): (Day | null)[] {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const pad = (weekday(first) + 6) % 7;
  const cells: (Day | null)[] = Array(pad).fill(null);
  for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** What a day looked like, for the read-only day sheet. */
export interface DayDetailRow {
  name: string;
  state: ItemState;
  reason: string | null;
  critical: boolean;
}

export function dayDetail(
  day: Day,
  today: Day,
  tasks: Task[],
  logs: TaskLog[],
  extras: ExtraRequirement[],
  excuses: ExtraExcuse[],
): DayDetailRow[] {
  const wk = logs.filter((l) => l.day >= weekStart(day) && l.day <= weekEnd(day));
  const rows: DayDetailRow[] = itemsFor(day, today, tasks, wk)
    // a past mid-week "once a week" item that was done later isn't due that day
    .filter((it) => !(it.state === 'open' && day < today))
    .map((it) => ({ name: it.task.name, state: it.state, reason: it.log?.reason ?? null, critical: it.task.critical }));
  for (const x of extras) {
    if (!x.appliesOn(day)) continue;
    const state: ItemState = x.doneOn(day) ? 'done' : day < today ? 'missed' : 'open';
    const ex = excuses.find((e) => e.day === day && e.item_key === x.key);
    rows.push({ name: extraLabel(x.key), state, reason: ex?.reason ?? null, critical: false });
  }
  return rows;
}

// ---------- Weekly review ----------

export type ReviewWindow = 'upcoming' | 'open' | 'locked';

/** A week's note can be written from its Sunday through the end of the following week. */
export function reviewWindow(week: Day, today: Day): ReviewWindow {
  if (today < addDays(week, 6)) return 'upcoming';
  if (today > addDays(week, 13)) return 'locked';
  return 'open';
}

/**
 * On Sunday, this week; any other day, last week (still open for a note),
 * unless last week was before anything started (`first`): then this week.
 */
export function defaultReviewWeek(today: Day, first: Day = today): Day {
  const last = addDays(weekStart(today), -7);
  return weekday(today) === 0 || last < weekStart(first) ? weekStart(today) : last;
}

/** Skips and misses (with reasons) in the Mon–Sun week starting `week`, oldest first. */
export function weekExcuses(
  week: Day,
  today: Day,
  tasks: Task[],
  logs: TaskLog[],
  extras: ExtraRequirement[],
  excuses: ExtraExcuse[],
): { misses: Excuse[]; skips: Excuse[] } {
  const misses: Excuse[] = [];
  const skips: Excuse[] = [];
  const last = weekEnd(week) < today ? weekEnd(week) : today;
  if (week > last) return { misses, skips };
  for (const d of daysBetween(week, last)) {
    for (const r of dayDetail(d, today, tasks, logs, extras, excuses)) {
      if (r.state === 'missed') misses.push({ day: d, name: r.name, kind: 'missed', reason: r.reason ?? '' });
      if (r.state === 'skipped') skips.push({ day: d, name: r.name, kind: 'skipped', reason: r.reason ?? '' });
    }
  }
  return { misses, skips };
}
