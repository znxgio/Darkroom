// Pure helpers for number trackers: moving average, range stats, change labels,
// axis ticks and the smooth chart line. No React, no storage: unit-tested.
import { addDays, prettyDay, weekday, WEEKDAY_SHORT, type Day } from '../../lib/dates';
import { num, type TrackerEntry } from './registry';

export interface Point {
  day: Day;
  v: number;
}

export type RangeId = '30d' | '90d' | '1y' | 'all';

export const RANGES: { id: RangeId; label: string; days: number | null }[] = [
  { id: '30d', label: '30d', days: 30 },
  { id: '90d', label: '90d', days: 90 },
  { id: '1y', label: '1y', days: 365 },
  { id: 'all', label: 'All', days: null },
];

/** Number entries → points, oldest first (non-numbers dropped). */
export function toPoints(entries: TrackerEntry[]): Point[] {
  const out: Point[] = [];
  for (const e of entries) {
    const v = num(e.value);
    if (v !== null && Number.isFinite(v)) out.push({ day: e.day, v });
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** Whole days from a to b (b later = positive). */
export function dayDiff(a: Day, b: Day): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
}

/**
 * Trailing moving average over a calendar window: the value on day d is the mean
 * of every entry from d-(window-1) through d. Missing days are simply skipped,
 * so gaps don't drag the line to zero. Input must be sorted oldest first.
 */
export function movingAverage(points: Point[], window = 7): Point[] {
  const out: Point[] = [];
  let start = 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    sum += points[i].v;
    const from = addDays(points[i].day, -(window - 1));
    while (points[start].day < from) sum -= points[start++].v;
    out.push({ day: points[i].day, v: sum / (i - start + 1) });
  }
  return out;
}

/** First day shown for a range (null = everything). */
export function rangeStart(range: RangeId, today: Day): Day | null {
  const r = RANGES.find((x) => x.id === range);
  return r?.days ? addDays(today, -(r.days - 1)) : null;
}

export function inRange<T extends { day: Day }>(points: T[], range: RangeId, today: Day): T[] {
  const from = rangeStart(range, today);
  return points.filter((p) => (from === null || p.day >= from) && p.day <= today);
}

export interface Summary {
  count: number;
  first: Point;
  latest: Point;
  min: Point;
  max: Point;
  avg: number;
  /** latest − first */
  change: number;
}

/** Stats for a sorted list of points (null when empty). Ties keep the most recent day. */
export function summarize(points: Point[]): Summary | null {
  if (!points.length) return null;
  let min = points[0];
  let max = points[0];
  let sum = 0;
  for (const p of points) {
    if (p.v <= min.v) min = p;
    if (p.v >= max.v) max = p;
    sum += p.v;
  }
  const first = points[0];
  const latest = points[points.length - 1];
  return { count: points.length, first, latest, min, max, avg: sum / points.length, change: latest.v - first.v };
}

/** Change of `day`'s value versus the entry before it. */
export function changeOn(points: Point[], day: Day): { delta: number; prevDay: Day } | null {
  const i = points.findIndex((p) => p.day === day);
  if (i <= 0) return null;
  return { delta: points[i].v - points[i - 1].v, prevDay: points[i - 1].day };
}

/** "yesterday", "Fri" (within a week), "Nov 3" or "Nov 3, 2025". */
export function sinceLabel(prevDay: Day, today: Day): string {
  const d = dayDiff(prevDay, today);
  if (d === 1) return 'yesterday';
  if (d >= 2 && d <= 6) return WEEKDAY_SHORT[weekday(prevDay)];
  return shortDate(prevDay, prevDay.slice(0, 4) !== today.slice(0, 4));
}

/** "Nov 3" (or "Nov 3, 2025"). */
export function shortDate(day: Day, withYear = false): string {
  const s = prettyDay(day).replace(/^\w+, /, '');
  return withYear ? `${s}, ${day.slice(0, 4)}` : s;
}

/** Signed with a real minus sign: "−0.4", "+1.2", "0.0". */
export function signed(n: number, decimals: number): string {
  const r = Number(n.toFixed(decimals));
  if (r === 0) return (0).toFixed(decimals);
  return (r > 0 ? '+' : '−') + Math.abs(r).toFixed(decimals);
}

/** "−0.4 lb since Fri" / "No change since yesterday". */
export function changeText(delta: number, prevDay: Day, today: Day, decimals: number, unit?: string): string {
  const since = sinceLabel(prevDay, today);
  if (Number(delta.toFixed(decimals)) === 0) return `No change since ${since}`;
  return `${signed(delta, decimals)}${unit ? ' ' + unit : ''} since ${since}`;
}

/** "Nice" round axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const out: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) out.push(Number(t.toFixed(10)));
  return out;
}

/**
 * Smooth SVG path through points (x ascending) using monotone cubic
 * interpolation: no overshoot, so the curve never invents highs or lows.
 */
export function monotonePath(pts: [number, number][]): string {
  const n = pts.length;
  if (!n) return '';
  const f = (v: number) => Number(v.toFixed(2));
  if (n === 1) return `M${f(pts[0][0])},${f(pts[0][1])}`;
  const dx: number[] = [];
  const s: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    s[i] = dx[i] === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  const m: number[] = [s[0]];
  for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (s[i - 1] + s[i]) / 2;
  m[n - 1] = s[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (s[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / s[i];
    const b = m[i + 1] / s[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * s[i];
      m[i + 1] = t * b * s[i];
    }
  }
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const h = dx[i] / 3;
    d += `C${f(x0 + h)},${f(y0 + m[i] * h)},${f(x1 - h)},${f(y1 - m[i + 1] * h)},${f(x1)},${f(y1)}`;
  }
  return d;
}
