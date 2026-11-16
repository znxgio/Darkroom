// Pure rules for "what's due when" and "how did a day go".
// Mirrored in SQL (supabase/migrations) for the nightly day-close job;
// both are checked against tests/fixtures/schedule-cases.json.
import { Day, addDays, daysBetween, prettyDay, weekEnd, weekStart, weekday } from './dates';

export type Pattern = 'daily' | 'weekdays' | 'weekly_day' | 'weekly_any';

export interface Task {
  id: string;
  name: string;
  kind: 'recurring' | 'one_time';
  /** recurring only */
  pattern: Pattern | null;
  /** 0=Sun..6=Sat. 'weekdays': the chosen days. 'weekly_day': exactly one day. */
  weekdays: number[];
  /** one_time only */
  one_time_date: Day | null;
  /** 'HH:MM' local. When the reminder fires; NOT a deadline. */
  goal_time: string | null;
  critical: boolean;
  /** First day the task counts. */
  start_date: Day;
  /** Task stops counting on this day (archived). */
  archived_on: Day | null;
  sort: number;
}

export type LogStatus = 'done' | 'skipped' | 'missed';

export interface TaskLog {
  task_id: string;
  day: Day;
  status: LogStatus;
  reason: string | null;
}

/** open = still doable today; missed = day ended without it. */
export type ItemState = 'done' | 'skipped' | 'missed' | 'open';

export function isActiveOn(t: Task, day: Day): boolean {
  return day >= t.start_date && (t.archived_on === null || day < t.archived_on);
}

/** Should this task appear on the checklist for `day`? */
export function isShownOn(t: Task, day: Day, logs: TaskLog[] = []): boolean {
  if (!isActiveOn(t, day)) return false;
  if (t.kind === 'one_time') return t.one_time_date === day;
  switch (t.pattern) {
    case 'daily':
      return true;
    case 'weekdays':
    case 'weekly_day':
      return t.weekdays.includes(weekday(day));
    case 'weekly_any': {
      // Shown every day of the week until it's resolved; then only on the day it was resolved.
      const r = weeklyAnyResolution(t, day, logs);
      return r === null || r.day >= day;
    }
    default:
      return false;
  }
}

/**
 * How a "once a week, any day" task got resolved this week:
 * the earliest 'done' in the week, else a skip/miss logged on Sunday (skips are only allowed Sunday).
 */
function weeklyAnyResolution(t: Task, day: Day, logs: TaskLog[]): TaskLog | null {
  const ws = weekStart(day);
  const we = weekEnd(day);
  const inWeek = logs.filter((l) => l.task_id === t.id && l.day >= ws && l.day <= we);
  const done = inWeek.filter((l) => l.status === 'done').sort((a, b) => (a.day < b.day ? -1 : 1))[0];
  return done ?? inWeek.find((l) => l.day === we) ?? null;
}

/** Can this task be skipped on `day`? (Once-a-week tasks: only on Sunday.) */
export function canSkip(t: Task, day: Day): boolean {
  return !(t.kind === 'recurring' && t.pattern === 'weekly_any' && day !== weekEnd(day));
}

/** Does this task count toward `day`'s result (calendar, streak, score)? */
export function countsOn(t: Task, day: Day, logs: TaskLog[] = []): boolean {
  if (!isActiveOn(t, day)) return false;
  if (t.kind === 'recurring' && t.pattern === 'weekly_any') {
    const r = weeklyAnyResolution(t, day, logs);
    if (r) return r.day === day;
    return day === weekEnd(day); // unresolved by Sunday → counts (as a miss) on Sunday
  }
  return isShownOn(t, day, logs);
}

export interface DayItem {
  task: Task;
  state: ItemState;
  log: TaskLog | null;
}

/**
 * Items on the checklist for `day`, with their state.
 * `today` decides whether an unchecked item is still open or already missed.
 */
export function itemsFor(day: Day, today: Day, tasks: Task[], logs: TaskLog[]): DayItem[] {
  return tasks
    .filter((t) => isShownOn(t, day, logs))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .map((task) => {
      const log = logs.find((l) => l.task_id === task.id && l.day === day) ?? null;
      let state: ItemState;
      if (log) state = log.status;
      else if (day < today) state = 'missed';
      else state = 'open';
      // weekly_any shown mid-week but unresolved isn't a miss until Sunday ends.
      if (state === 'missed' && !log && !countsOn(task, day, logs)) state = 'open';
      return { task, state, log };
    });
}

export type DayColor = 'green' | 'red' | 'gray' | 'pending';

export interface DayResult {
  day: Day;
  required: number;
  done: number;
  color: DayColor;
}

/** Extra daily requirements outside tasks (e.g. photos). done=true if satisfied that day. */
export interface ExtraRequirement {
  key: string;
  appliesOn: (day: Day) => boolean;
  doneOn: (day: Day) => boolean;
}

export function dayResult(
  day: Day,
  today: Day,
  tasks: Task[],
  logs: TaskLog[],
  extras: ExtraRequirement[] = [],
): DayResult {
  let required = 0;
  let done = 0;
  let open = 0;
  for (const t of tasks) {
    if (!countsOn(t, day, logs)) continue;
    required++;
    const log = logs.find((l) => l.task_id === t.id && l.day === day);
    if (log?.status === 'done') done++;
    else if (!log && day >= today) open++;
  }
  for (const x of extras) {
    if (!x.appliesOn(day)) continue;
    required++;
    if (x.doneOn(day)) done++;
    else if (day >= today) open++;
  }
  let color: DayColor;
  if (required === 0) color = 'gray';
  else if (done === required) color = 'green';
  else if (open > 0) color = 'pending';
  else color = 'red';
  return { day, required, done, color };
}

/**
 * Consecutive green days ending today (if today is already complete) or yesterday.
 * Gray days (nothing scheduled) are passed over without breaking the streak.
 */
export function streak(
  today: Day,
  tasks: Task[],
  logs: TaskLog[],
  extras: ExtraRequirement[] = [],
  earliest?: Day,
): number {
  const floor =
    earliest ?? tasks.reduce<Day>((m, t) => (t.start_date < m ? t.start_date : m), today);
  let n = 0;
  let d = today;
  const t0 = dayResult(today, today, tasks, logs, extras);
  if (t0.color === 'green') n++;
  else if (t0.color === 'red') return 0; // e.g. skipped something today
  d = addDays(today, -1);
  for (; d >= floor; d = addDays(d, -1)) {
    const r = dayResult(d, today, tasks, logs, extras);
    if (r.color === 'green') n++;
    else if (r.color === 'gray') continue;
    else break;
  }
  return n;
}

/** % of counted items done in the Mon–Sun week containing `day`. Open (still doable) items are left out. */
export function weeklyScore(
  day: Day,
  today: Day,
  tasks: Task[],
  logs: TaskLog[],
  extras: ExtraRequirement[] = [],
): { done: number; counted: number; pct: number | null } {
  let done = 0;
  let counted = 0;
  const last = weekEnd(day) < today ? weekEnd(day) : today;
  for (const d of daysBetween(weekStart(day), last)) {
    for (const t of tasks) {
      if (!countsOn(t, d, logs)) continue;
      const log = logs.find((l) => l.task_id === t.id && l.day === d);
      if (log?.status === 'done') {
        done++;
        counted++;
      } else if (log || d < today) counted++;
    }
    for (const x of extras) {
      if (!x.appliesOn(d)) continue;
      if (x.doneOn(d)) {
        done++;
        counted++;
      } else if (d < today) counted++;
    }
  }
  return { done, counted, pct: counted === 0 ? null : Math.round((done / counted) * 100) };
}

export function describeSchedule(t: Task): string {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (t.kind === 'one_time') return `Once · ${t.one_time_date ? prettyDay(t.one_time_date) : ''}`;
  switch (t.pattern) {
    case 'daily':
      return 'Every day';
    case 'weekdays': {
      const s = [...t.weekdays].sort((a, b) => a - b).join(',');
      if (s === '1,2,3,4,5') return 'Mon–Fri';
      if (s === '0,6') return 'Weekends';
      return [1, 2, 3, 4, 5, 6, 0].filter((d) => t.weekdays.includes(d)).map((d) => names[d]).join(' ');
    }
    case 'weekly_day':
      return `Every ${names[t.weekdays[0]]}`;
    case 'weekly_any':
      return 'Once a week (any day)';
    default:
      return '';
  }
}
