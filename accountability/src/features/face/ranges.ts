// Reference ranges for every scored face metric, in one table.
// These are popular reference values (aesthetics articles, orthodontic/plastic-surgery rules of
// thumb, looksmaxing forums), NOT validated science. The UI says so.
//
// Scoring (see score.ts): inside [lo, hi] = 9–10 (10 at `peak`, default the middle);
// outside, the score falls from 9 to 0 as the value moves `tol` beyond the range.
// `noise`: the smallest change between two photos we call real. Below it, angle, distance,
// lens and expression easily explain the difference (picked from how much these ratios move
// between back-to-back phone selfies: roughly 2–4% for ratios, ~1.5° for angles).
import type { FaceMetrics } from './metrics';

export type MetricKey =
  | 'canthal'
  | 'symmetry'
  | 'fwhr'
  | 'thirds'
  | 'lowerSplit'
  | 'eyeSpacing'
  | 'esr'
  | 'midface'
  | 'nose'
  | 'mouth'
  | 'jaw';

export interface RangeDef {
  key: MetricKey;
  label: string;
  lo: number;
  hi: number;
  peak?: number;
  tol: number;
  weight: number;
  noise: number;
  /** how values are shown */
  fmt: (v: number) => string;
  /** range as text, e.g. "4–8°" */
  range: string;
  /** one-line note shown under the metric */
  note: string;
  /** plain-English phrases for the strengths / could-improve lists */
  good: string;
  low: string;
  high: string;
}

const ratio = (d = 2) => (v: number) => v.toFixed(d);
const signedDeg = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°`;

export const RANGES: RangeDef[] = [
  {
    key: 'canthal',
    label: 'Canthal tilt',
    lo: 4, hi: 8, tol: 8, weight: 1.5, noise: 1.5,
    fmt: signedDeg, range: '4–8°',
    note: 'Angle from inner to outer eye corner; positive = outer corner higher.',
    good: 'Positive canthal tilt', low: 'Flatter canthal tilt', high: 'Steep canthal tilt',
  },
  {
    key: 'symmetry',
    label: 'Symmetry',
    lo: 92, hi: 100, peak: 100, tol: 20, weight: 1.5, noise: 2,
    fmt: (v) => `${Math.round(v)}%`, range: '92–100%',
    note: 'How well left and right landmarks mirror each other. Head turn lowers it.',
    good: 'Balanced left/right symmetry', low: 'Less left/right symmetry', high: 'Symmetry',
  },
  {
    key: 'fwhr',
    label: 'Width-to-height (FWHR)',
    lo: 1.85, hi: 2.1, tol: 0.4, weight: 1, noise: 0.05,
    fmt: ratio(), range: '1.85–2.10',
    note: 'Cheekbone width ÷ brow-to-upper-lip height. Higher reads as broader.',
    good: 'Broad face width-to-height', low: 'Longer, narrower face ratio', high: 'Very wide face ratio',
  },
  {
    key: 'thirds',
    label: 'Lower ÷ middle third',
    lo: 0.95, hi: 1.1, tol: 0.25, weight: 1, noise: 0.04,
    fmt: ratio(), range: '0.95–1.10',
    note: 'Nose-base-to-chin vs brow-to-nose-base. Equal thirds ≈ 1.0.',
    good: 'Balanced facial thirds', low: 'Shorter lower third', high: 'Longer lower third',
  },
  {
    key: 'lowerSplit',
    label: 'Lip-to-chin split',
    lo: 1.8, hi: 2.2, tol: 0.8, weight: 0.75, noise: 0.15,
    fmt: (v) => `1 : ${v.toFixed(1)}`, range: '1 : 1.8–2.2',
    note: 'Nose-to-mouth vs mouth-to-chin. The classic ideal is 1 : 2.',
    good: 'Classic 1:2 lower-face split', low: 'Short chin vs upper lip', high: 'Long chin vs upper lip',
  },
  {
    key: 'eyeSpacing',
    label: 'Eye spacing',
    // The mesh's eye-corner points sit inside the visible corners: its own average face reads
    // 1.43 here where the population average (rule of fifths) is ~1.05. Range shifted to match.
    lo: 1.25, hi: 1.5, tol: 0.45, weight: 1, noise: 0.05,
    fmt: ratio(), range: '1.25–1.50',
    note: 'Gap between eyes ÷ eye width, on the mesh’s scale (rule of fifths ≈ 1.25–1.50 here).',
    good: 'Eye spacing near the rule of fifths', low: 'Closer-set eyes', high: 'Wider-set eyes',
  },
  {
    key: 'esr',
    label: 'Eye separation (ESR)',
    // Cited ~0.45–0.47 with true cheekbone points; the mesh's face edge (234/454) sits a bit
    // wider (its average face reads 0.41), so the range is shifted by the same amount.
    lo: 0.4, hi: 0.44, tol: 0.08, weight: 1, noise: 0.01,
    fmt: ratio(3), range: '0.40–0.44',
    note: 'Pupil distance ÷ face width at the cheekbones (cited 0.45–0.47 on the skull).',
    good: 'Eye separation ratio', low: 'Pupils close vs face width', high: 'Pupils wide vs face width',
  },
  {
    key: 'midface',
    label: 'Midface ratio',
    lo: 0.95, hi: 1.05, tol: 0.25, weight: 1, noise: 0.04,
    fmt: ratio(), range: '0.95–1.05',
    note: 'Pupil distance ÷ pupils-to-upper-lip height. Compact midface ≈ 1.0.',
    good: 'Compact midface', low: 'Longer midface', high: 'Short, wide midface',
  },
  {
    key: 'nose',
    label: 'Nose width',
    lo: 0.9, hi: 1.1, tol: 0.35, weight: 0.75, noise: 0.05,
    fmt: ratio(), range: '0.90–1.10',
    note: 'Nose-wing width ÷ gap between the eyes. Classic ideal ≈ 1.0.',
    good: 'Nose width in proportion', low: 'Narrow nose vs eye gap', high: 'Wide nose vs eye gap',
  },
  {
    key: 'mouth',
    label: 'Mouth width',
    lo: 1.45, hi: 1.65, tol: 0.4, weight: 0.75, noise: 0.06,
    fmt: ratio(), range: '1.45–1.65',
    note: 'Mouth width ÷ nose width. Often cited ~1.5–1.6. Smiling widens it.',
    good: 'Mouth width in proportion', low: 'Narrow mouth vs nose', high: 'Wide mouth vs nose',
  },
  {
    key: 'jaw',
    label: 'Jaw ÷ cheekbones',
    lo: 0.8, hi: 0.92, tol: 0.2, weight: 1, noise: 0.03,
    fmt: ratio(), range: '0.80–0.92',
    note: 'Jaw width near the angle ÷ cheekbone width. Higher = squarer lower face.',
    good: 'Strong, square jaw width', low: 'Narrower jaw vs cheekbones', high: 'Jaw as wide as cheekbones',
  },
];

/** Harmony score: changes smaller than this (points) are photo noise. */
export const SCORE_NOISE = 3;
/** Pose difference (degrees of yaw or pitch) that makes a comparison less reliable. */
export const POSE_LIMIT = 5;

export function rangeOf(key: MetricKey): RangeDef {
  return RANGES.find((r) => r.key === key)!;
}

export function valueOf(m: FaceMetrics, key: MetricKey): number {
  return m[key];
}
