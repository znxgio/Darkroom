import { addDays, daysBetween, type Day } from '../../lib/dates';

/** "Day 1" is the day photos started counting. */
export function dayNumber(day: Day, start: Day | null): number | null {
  if (!start || day < start) return null;
  return daysBetween(start, day).length;
}

export function daysApart(a: Day, b: Day): number {
  const [x, y] = a < b ? [a, b] : [b, a];
  return daysBetween(x, y).length - 1;
}

export function relativeLabel(day: Day, today: Day): string | null {
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  return null;
}
