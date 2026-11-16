import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { computeMetrics, overlayLines, poseFromMatrix, MIRROR_PAIRS, type Pt } from '../src/features/face/metrics';
import { RANGES, rangeOf } from '../src/features/face/ranges';
import { compactValue, compareFaces, metricScore, scoreFace } from '../src/features/face/score';
import { CACHE_VERSION, MP_VERSION } from '../src/features/face/constants';
import { trackerByKey } from '../src/features/trackers/registry';
// @ts-expect-error plain JS helper shared with the browser check
import { syntheticFace } from './fixtures/faceSynth.mjs';
import canonical from './fixtures/face-canonical.json';

const W = 960;
const H = 1280;
const face = (o: Record<string, unknown> = {}): Pt[] => syntheticFace({ W, H, ...o });
const m = (o: Record<string, unknown> = {}) => computeMetrics(face(o), W, H);

describe('synthetic face', () => {
  it('has 478 landmarks', () => {
    expect(face()).toHaveLength(478);
  });
  it('mirror pairs really are mirror twins in the canonical mesh', () => {
    const v = canonical as number[][];
    for (const [a, b] of MIRROR_PAIRS) {
      expect(Math.abs(v[a][0] + v[b][0])).toBeLessThan(0.01);
      expect(Math.abs(v[a][1] - v[b][1])).toBeLessThan(0.01);
      expect(v[a][0]).toBeLessThan(0); // first of each pair is on the photo-left side
    }
  });
});

describe('computeMetrics', () => {
  it('a perfectly symmetric face scores ~100% symmetry', () => {
    expect(m().symmetry).toBeGreaterThan(99.9);
  });

  it('asymmetry lowers symmetry', () => {
    const s = m({ jitter: 0.4, seed: 7 }).symmetry;
    expect(s).toBeLessThan(97);
    expect(s).toBeGreaterThan(50);
  });

  it('measures a known canthal tilt on both eyes', () => {
    for (const t of [-3, 0, 5.8, 9]) {
      const r = m({ tilt: t });
      expect(r.canthalL).toBeCloseTo(t, 3);
      expect(r.canthalR).toBeCloseTo(t, 3);
      expect(r.canthal).toBeCloseTo(t, 3);
    }
  });

  it('positive tilt means the outer corner is higher in the photo', () => {
    const lm = face({ tilt: 6 });
    expect(lm[33].y).toBeLessThan(lm[133].y); // smaller y = higher
    expect(lm[263].y).toBeLessThan(lm[362].y);
  });

  it('a rolled head gives the same numbers after roll correction', () => {
    const base = m({ tilt: 5 });
    for (const roll of [-20, -8, 12, 25]) {
      const r = m({ tilt: 5, roll });
      expect(r.pose.roll).toBeCloseTo(roll, 4);
      expect(r.canthalL).toBeCloseTo(base.canthalL, 4);
      expect(r.canthalR).toBeCloseTo(base.canthalR, 4);
      for (const def of RANGES) expect(r[def.key]).toBeCloseTo(base[def.key], 4);
    }
  });

  it('is independent of face size and position in the frame', () => {
    const a = m();
    const b = m({ scale: 18, cx: 300, cy: 500 });
    for (const def of RANGES) expect(b[def.key]).toBeCloseTo(a[def.key], 6);
    expect(b.faceSize).toBeLessThan(a.faceSize);
  });

  it('computes the ratios from the expected landmarks (canonical mesh values)', () => {
    const r = m();
    const v = canonical as number[][];
    const cheek = 2 * v[454][0];
    expect(r.fwhr).toBeCloseTo(cheek / (v[9][1] - v[0][1]), 4);
    expect(r.thirds).toBeCloseTo((v[2][1] - v[152][1]) / (v[9][1] - v[2][1]), 4);
    expect(r.lowerSplit).toBeCloseTo((v[14][1] - v[152][1]) / (v[2][1] - v[13][1]), 4);
    const eyeW = Math.hypot(v[263][0] - v[362][0], v[263][1] - v[362][1]);
    expect(r.eyeSpacing).toBeCloseTo((2 * v[362][0]) / eyeW, 4);
    expect(r.nose).toBeCloseTo(v[294][0] / v[362][0], 4);
    expect(r.mouth).toBeCloseTo(v[291][0] / v[294][0], 4);
    expect(r.jaw).toBeCloseTo(v[397][0] / v[454][0], 4);
    expect(r.esr).toBeGreaterThan(0.35);
    expect(r.esr).toBeLessThan(0.5);
    expect(r.midface).toBeGreaterThan(0.85);
    expect(r.midface).toBeLessThan(1.2);
  });

  it('a longer chin raises the lower third and the lip-to-chin split', () => {
    const base = m();
    const r = m({ shift: { 152: [0, -1.5] } });
    expect(r.thirds).toBeGreaterThan(base.thirds);
    expect(r.lowerSplit).toBeGreaterThan(base.lowerSplit);
  });

  it('estimates yaw from the landmarks; frontal ≈ 0', () => {
    expect(Math.abs(m().pose.yaw)).toBeLessThan(0.01);
    expect(Math.abs(m().pose.pitch)).toBeLessThan(0.01);
    expect(m({ yaw: 15 }).pose.yaw).toBeCloseTo(15, 3);
    expect(m({ yaw: -9, roll: 7 }).pose.yaw).toBeCloseTo(-9, 3);
  });

  it('a slightly turned head is turned back before measuring', () => {
    const base = m({ tilt: 5 });
    for (const yaw of [-12, 8]) {
      const r = m({ tilt: 5, yaw, roll: 6 });
      for (const def of RANGES) expect(r[def.key]).toBeCloseTo(base[def.key], 3);
    }
  });

  it('uses the transformation matrix for pose when given', () => {
    const a = (20 * Math.PI) / 180;
    // rotation about y by 20°, column-major 4×4
    const mat = [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, -50, 1];
    const r = computeMetrics(face(), W, H, mat);
    expect(r.pose.source).toBe('matrix');
    expect(Math.abs(r.pose.yaw)).toBeCloseTo(20, 4);
    expect(Math.abs(r.pose.pitch)).toBeLessThan(1e-6);
    expect(poseFromMatrix([1, 2])).toBeNull();
  });

  it('detects closed eyes', () => {
    expect(m().eyesOpen).toBe(true);
    const v = canonical as number[][];
    const closed = m({ shift: { 159: [0, v[145][1] - v[159][1] + 0.05], 386: [0, v[374][1] - v[386][1] + 0.05] } });
    expect(closed.eyesOpen).toBe(false);
  });

  it('rejects incomplete landmark sets', () => {
    expect(() => computeMetrics(face().slice(0, 468), W, H)).toThrow();
  });
});

describe('scoring', () => {
  it('scores 10 at the peak, 9 at range edges, falls to 0 at tol', () => {
    const d = rangeOf('canthal');
    expect(metricScore(d, 6)).toBeCloseTo(10);
    expect(metricScore(d, 4)).toBeCloseTo(9);
    expect(metricScore(d, 8)).toBeCloseTo(9);
    expect(metricScore(d, 0)).toBeCloseTo(4.5);
    expect(metricScore(d, -4)).toBe(0);
    expect(metricScore(d, NaN)).toBe(0);
    expect(metricScore(rangeOf('symmetry'), 100)).toBeCloseTo(10);
  });

  it('harmony is 0–100, with 3 strengths and 3 could-improve items that do not overlap', () => {
    const s = scoreFace(m({ tilt: 5.8 }));
    expect(s.harmony).toBeGreaterThanOrEqual(0);
    expect(s.harmony).toBeLessThanOrEqual(100);
    expect(s.items).toHaveLength(RANGES.length);
    expect(s.strengths).toHaveLength(3);
    expect(s.improve).toHaveLength(3);
    const keys = new Set([...s.strengths, ...s.improve].map((x) => x.key));
    expect(keys.size).toBe(6);
    expect(s.strengths[0].score).toBeGreaterThanOrEqual(s.improve[0].score);
  });

  it('writes plain, neutral explanations', () => {
    const s = scoreFace(m({ tilt: 5.8 }));
    const ct = s.items.find((i) => i.key === 'canthal')!;
    expect(ct.text).toBe('Positive canthal tilt (+5.8°) — in the commonly cited 4–8° range');
    const flat = scoreFace(m({ tilt: 1 })).items.find((i) => i.key === 'canthal')!;
    expect(flat.text).toBe('Flatter canthal tilt (+1.0°) — below the commonly cited 4–8° range');
    const bad = /subhuman|ugly|failo|cope|mogged|incel/i;
    for (const d of RANGES) for (const t of [d.good, d.low, d.high, d.note]) expect(t).not.toMatch(bad);
  });

  it('a better canthal tilt raises the harmony score', () => {
    expect(scoreFace(m({ tilt: 6 })).harmony).toBeGreaterThan(scoreFace(m({ tilt: -2 })).harmony);
  });
});

describe('compare', () => {
  it('the same face (rolled) is "≈ same": nothing beyond noise', () => {
    const c = compareFaces(m({ roll: 10 }), m());
    expect(c.scoreReal).toBe(false);
    expect(c.metrics.every((x) => !x.real)).toBe(true);
    expect(c.poseDiffers).toBe(false);
  });

  it('flags a real canthal change and a pose difference', () => {
    const c = compareFaces(m({ tilt: 7 }), m({ tilt: 2 }));
    const ct = c.metrics.find((x) => x.key === 'canthal')!;
    expect(ct.delta).toBeCloseTo(5, 4);
    expect(ct.real).toBe(true);
    expect(c.scoreDelta).toBeGreaterThan(0);
    expect(compareFaces(m({ yaw: 12 }), m()).poseDiffers).toBe(true);
  });

  it('small changes stay within noise', () => {
    const c = compareFaces(m({ tilt: 5.5 }), m({ tilt: 5 }));
    expect(c.metrics.find((x) => x.key === 'canthal')!.real).toBe(false);
  });
});

describe('storage', () => {
  it('compact value fits the tracker rules (number v, under 4 KB)', () => {
    const val = compactValue(m({ tilt: 5 }), CACHE_VERSION);
    expect(typeof val.v).toBe('number');
    expect(Number.isInteger(val.v)).toBe(true);
    expect(JSON.stringify(val).length).toBeLessThan(1024);
    const def = trackerByKey('face_score')!;
    expect(def.auto).toBe(true);
    expect(def.validate(val)).toBeNull();
    expect(def.format(val)).toBe(String(val.v));
  });

  it('overlay lines are finite and inside a sensible area', () => {
    const { lines, dots } = overlayLines(face({ roll: 8 }), W, H);
    expect(lines.length).toBeGreaterThanOrEqual(10);
    for (const l of lines) for (const n of [l.x1, l.y1, l.x2, l.y2]) expect(Number.isFinite(n)).toBe(true);
    for (const d of dots) {
      expect(d.x).toBeGreaterThan(0);
      expect(d.x).toBeLessThan(W);
    }
  });
});

describe('self-hosted model files', () => {
  it('constants match the installed package and the service worker', () => {
    const pkg = JSON.parse(readFileSync('node_modules/@mediapipe/tasks-vision/package.json', 'utf8'));
    expect(pkg.version).toBe(MP_VERSION);
    expect(readFileSync('public/sw.js', 'utf8')).toContain(`mediapipe-${MP_VERSION}`);
  });
});
