// Days are plain 'YYYY-MM-DD' strings in America/Los_Angeles.
// A day runs midnight to midnight local time.
export const TZ = 'America/Los_Angeles';

export type Day = string;

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** The LA calendar day for a moment in time. */
export function dayOf(now: Date = new Date()): Day {
  return dayFmt.format(now);
}

/** 'HH:MM' LA wall-clock time for a moment. */
export function timeOf(now: Date = new Date()): string {
  return timeFmt.format(now);
}

function toUTC(day: Day): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUTC(dt: Date): Day {
  return dt.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(day: Day): number {
  return toUTC(day).getUTCDay();
}

export function addDays(day: Day, n: number): Day {
  const dt = toUTC(day);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUTC(dt);
}

/** Weeks run Monday–Sunday. */
export function weekStart(day: Day): Day {
  const wd = weekday(day);
  return addDays(day, wd === 0 ? -6 : 1 - wd);
}

export function weekEnd(day: Day): Day {
  return addDays(weekStart(day), 6);
}

export function daysBetween(from: Day, to: Day): Day[] {
  const out: Day[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function prettyDay(day: Day): string {
  const dt = toUTC(day);
  return dt.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
