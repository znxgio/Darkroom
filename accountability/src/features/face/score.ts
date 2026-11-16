// Turn face metrics into 0–10 metric scores, a 0–100 Harmony score, plain-English strengths /
// could-improve lines, and a comparison with an earlier photo. Pure functions.
import type { FaceMetrics } from './metrics';
import { POSE_LIMIT, RANGES, SCORE_NOISE, type MetricKey, type RangeDef } from './ranges';

export interface MetricScore {
  key: MetricKey;
  def: RangeDef;
  value: number;
  /** 0–10 */
  score: number;
  where: 'in' | 'below' | 'above';
  text: string;
}

export interface FaceScore {
  /** 0–100 */
  harmony: number;
  items: MetricScore[];
  strengths: MetricScore[];
  improve: MetricScore[];
}

export function metricScore(def: RangeDef, x: number): number {
  if (!Number.isFinite(x)) return 0;
  const c = def.peak ?? (def.lo + def.hi) / 2;
  if (x >= def.lo && x <= def.hi) {
    const half = x < c ? c - def.lo : def.hi - c;
    return half > 0 ? 10 - Math.abs(x - c) / half : 10;
  }
  const d = x < def.lo ? def.lo - x : x - def.hi;
  return Math.max(0, 9 * (1 - d / def.tol));
}

function explain(def: RangeDef, value: number, where: MetricScore['where']): string {
  const v = def.fmt(value);
  if (where === 'in') return `${def.good} (${v}) — in the commonly cited ${def.range} range`;
  return `${where === 'below' ? def.low : def.high} (${v}) — ${where} the commonly cited ${def.range} range`;
}

export function scoreFace(m: FaceMetrics): FaceScore {
  const items: MetricScore[] = RANGES.map((def) => {
    const value = m[def.key];
    const where: MetricScore['where'] = value < def.lo ? 'below' : value > def.hi ? 'above' : 'in';
    return { key: def.key, def, value, score: metricScore(def, value), where, text: explain(def, value, where) };
  });
  let sw = 0;
  let s = 0;
  for (const it of items) {
    sw += it.def.weight;
    s += it.def.weight * it.score;
  }
  const harmony = Math.round((s / sw) * 10);
  // Ties: heavier-weighted metrics first, so the lists are stable.
  const ranked = [...items].sort((a, b) => b.score - a.score || b.def.weight - a.def.weight);
  const strengths = ranked.slice(0, 3);
  const improve = ranked
    .slice(3)
    .reverse()
    .slice(0, 3);
  return { harmony, items, strengths, improve };
}

export interface MetricChange {
  key: MetricKey;
  delta: number;
  /** bigger than photo noise */
  real: boolean;
}

export interface FaceChange {
  scoreDelta: number;
  scoreReal: boolean;
  metrics: MetricChange[];
  /** yaw or pitch differs by more than POSE_LIMIT degrees */
  poseDiffers: boolean;
}

export function compareFaces(cur: FaceMetrics, prev: FaceMetrics): FaceChange {
  const a = scoreFace(cur).harmony;
  const b = scoreFace(prev).harmony;
  const metrics = RANGES.map((def) => {
    const delta = cur[def.key] - prev[def.key];
    return { key: def.key, delta, real: Math.abs(delta) >= def.noise };
  });
  return {
    scoreDelta: a - b,
    scoreReal: Math.abs(a - b) >= SCORE_NOISE,
    metrics,
    poseDiffers:
      Math.abs(cur.pose.yaw - prev.pose.yaw) > POSE_LIMIT || Math.abs(cur.pose.pitch - prev.pose.pitch) > POSE_LIMIT,
  };
}

/** Short keys used in the stored tracker value (must stay stable). */
const SHORT: Record<MetricKey, string> = {
  canthal: 'ct',
  symmetry: 'sym',
  fwhr: 'fw',
  thirds: 'th',
  lowerSplit: 'ls',
  eyeSpacing: 'es',
  esr: 'esr',
  midface: 'mf',
  nose: 'nw',
  mouth: 'mw',
  jaw: 'jw',
};

/** Tracker value for face_score: { v: score, m: compact metrics }. Well under the 4 KB limit. */
export function compactValue(m: FaceMetrics, ver: number): { v: number; m: Record<string, number> } {
  const out: Record<string, number> = { ver };
  for (const def of RANGES) out[SHORT[def.key]] = Math.round(m[def.key] * 1000) / 1000;
  out.ctl = round1(m.canthalL);
  out.ctr = round1(m.canthalR);
  out.yaw = round1(m.pose.yaw);
  out.pitch = round1(m.pose.pitch);
  return { v: scoreFace(m).harmony, m: out };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
