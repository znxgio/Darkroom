// Learning history: trends and recurring habits from past critiques. Pure functions.
import { TAGS, type Subscores, type Tag } from '../../supabase/functions/_shared/critique';
import type { PhotoWithCritiques } from '../data/types';

export interface ProgressStats {
  count: number;
  avg: number | null;
  /** average of the latest 10 vs the 10 before (null until there are enough) */
  trend: number | null;
  sub: Subscores | null;
  /** most common issue tags in the last 30 critiques */
  habits: { tag: Tag; label: string; tip: string; count: number; recent: boolean }[];
  /** issues that showed up early but not in the latest 10 critiques */
  improved: { tag: Tag; label: string }[];
  /** score series oldest→newest for the chart (latest critique per photo) */
  series: { at: string; score: number }[];
  best: PhotoWithCritiques | null;
  /** days in a row (LA time) with at least one photo */
  streak: number;
}

const laDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

export function progressStats(photos: PhotoWithCritiques[], now = new Date()): ProgressStats {
  const latest = photos
    .filter((p) => p.critiques.length)
    .map((p) => ({ photo: p, c: p.critiques[0] }))
    .sort((a, b) => a.c.created_at.localeCompare(b.c.created_at));
  const scores = latest.map((x) => x.c.score);
  const avg = scores.length ? round1(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  let trend: number | null = null;
  if (scores.length >= 6) {
    const half = Math.min(10, Math.floor(scores.length / 2));
    const recent = scores.slice(-half);
    const before = scores.slice(-2 * half, -half);
    trend = round1(mean(recent) - mean(before));
  }
  const last = latest.slice(-20);
  const sub: Subscores | null = last.length
    ? {
        composition: round1(mean(last.map((x) => x.c.result.subscores.composition))),
        light: round1(mean(last.map((x) => x.c.result.subscores.light))),
        moment: round1(mean(last.map((x) => x.c.result.subscores.moment))),
        technical: round1(mean(last.map((x) => x.c.result.subscores.technical))),
      }
    : null;

  const window30 = latest.slice(-30);
  const recent10 = new Set(latest.slice(-10).flatMap((x) => x.c.tags));
  const counts = new Map<Tag, number>();
  for (const x of window30) for (const t of x.c.tags) if (t in TAGS) counts.set(t as Tag, (counts.get(t as Tag) ?? 0) + 1);
  const habits = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag, count]) => ({ tag, label: TAGS[tag].label, tip: TAGS[tag].tip, count, recent: recent10.has(tag) }));
  const improved =
    latest.length >= 15
      ? [...new Set(latest.slice(0, -10).flatMap((x) => x.c.tags))]
          .filter((t) => t in TAGS && !recent10.has(t))
          .slice(0, 4)
          .map((t) => ({ tag: t as Tag, label: TAGS[t as Tag].label }))
      : [];

  const best = latest.length ? latest.reduce((a, b) => (b.c.score > a.c.score ? b : a)).photo : null;

  const days = new Set(photos.map((p) => laDay(p.created_at)));
  let streak = 0;
  const d = new Date(now);
  // today counts if there's a photo; otherwise start from yesterday
  if (!days.has(laDay(d.toISOString()))) d.setUTCDate(d.getUTCDate() - 1);
  while (days.has(laDay(d.toISOString()))) {
    streak++;
    d.setUTCDate(d.getUTCDate() - 1);
  }

  return {
    count: latest.length,
    avg,
    trend,
    sub,
    habits,
    improved,
    series: latest.map((x) => ({ at: x.c.created_at, score: x.c.score })),
    best,
    streak,
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const round1 = (x: number) => Math.round(x * 10) / 10;

export const usd = (x: number) => (x < 1 && x > 0 ? `$${x.toFixed(3).replace(/0$/, '')}` : `$${x.toFixed(2)}`);
