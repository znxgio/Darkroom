import { describe, expect, it } from 'vitest';
import { analyze, Steady, tiltFromGravity, type FrameInput, type Person } from '../src/lib/coach';
import { isBacklit, measureLight, type LightStats } from '../src/lib/light';
import { personFromLandmarks } from '../src/features/live/detector';

const okLight: LightStats = { mean: 0.45, clipped: 0.01, crushed: 0.02, subject: 0.45, surround: 0.45 };
const base = (over: Partial<FrameInput> = {}): FrameInput => ({
  people: [],
  faces: [],
  things: [],
  rollDeg: 0,
  pitchDeg: 0,
  light: okLight,
  guide: 'thirds',
  detectorReady: true,
  ...over,
});
const ids = (f: FrameInput) => analyze(f).nudges.map((n) => n.id);

describe('live coaching rules', () => {
  it('a level, well-lit person on the left third scores high with no nudges', () => {
    const p: Person = { box: { x: 0.22, y: 0.08, w: 0.22, h: 0.6 }, nose: { x: 0.333, y: 0.15 } };
    const a = analyze(base({ people: [p] }));
    expect(a.nudges).toEqual([]);
    expect(a.wellPlaced).toBe(true);
    expect(a.score).toBeGreaterThanOrEqual(9);
  });

  it('flags a crooked horizon, worse when steeper', () => {
    expect(ids(base({ rollDeg: 1.5 }))).not.toContain('horizon');
    const small = analyze(base({ rollDeg: 3 })).nudges.find((n) => n.id === 'horizon')!;
    const big = analyze(base({ rollDeg: -7 })).nudges.find((n) => n.id === 'horizon')!;
    expect(small.severity).toBe(2);
    expect(big.severity).toBe(3);
    expect(big.text).toContain('7°');
  });

  it('too much headroom on a big subject → tilt down', () => {
    const p: Person = { box: { x: 0.25, y: 0.3, w: 0.2, h: 0.68 }, nose: { x: 0.33, y: 0.36 } };
    expect(ids(base({ people: [p] }))).toContain('headroom');
  });

  it('head cut off at the top edge → tilt up', () => {
    const p: Person = { box: { x: 0.3, y: 0, w: 0.3, h: 0.9 } };
    const face = { x: 0.38, y: 0, w: 0.12, h: 0.1 };
    expect(ids(base({ people: [p], faces: [face] }))).toContain('headcut');
  });

  it('cutting off feet: knees in frame, ankles out', () => {
    const p: Person = {
      box: { x: 0.3, y: 0.1, w: 0.3, h: 0.9 },
      nose: { x: 0.33, y: 0.16 },
      knee: { x: 0.4, y: 0.75, v: 0.9 },
      ankle: { x: 0.4, y: 1.05, v: 0.2 },
    };
    expect(ids(base({ people: [p] }))).toContain('feet');
    const atKnees = { ...p, knee: { x: 0.4, y: 0.9, v: 0.9 } };
    expect(ids(base({ people: [atKnees] }))).toContain('knees');
    const full = { ...p, box: { ...p.box, h: 0.85 }, ankle: { x: 0.4, y: 0.94, v: 0.9 } };
    expect(ids(base({ people: [full] }))).not.toContain('feet');
  });

  it('subject jammed at the far right → pan right', () => {
    const p: Person = { box: { x: 0.82, y: 0.2, w: 0.16, h: 0.5 }, nose: { x: 0.9, y: 0.26 } };
    const a = analyze(base({ people: [p] }));
    expect(a.nudges.find((n) => n.id === 'place')?.text).toMatch(/Pan right/);
  });

  it('symmetry guide on: off-center subject → center it', () => {
    const p: Person = { box: { x: 0.1, y: 0.2, w: 0.2, h: 0.5 }, nose: { x: 0.2, y: 0.26 } };
    expect(analyze(base({ people: [p], guide: 'center' })).nudges.find((n) => n.id === 'center')?.text).toMatch(/Pan left/);
  });

  it('tiny subject → get closer', () => {
    const t = { box: { x: 0.3, y: 0.3, w: 0.05, h: 0.05 }, label: 'dog', score: 0.8 };
    expect(ids(base({ things: [t] }))).toContain('tiny');
  });

  it('no subject once detection is running', () => {
    expect(ids(base())).toContain('nosubject');
    expect(ids(base({ detectorReady: false }))).not.toContain('nosubject');
    expect(analyze(base()).score).toBeLessThanOrEqual(6);
  });

  it('low light triggers the native-camera rule', () => {
    const a = analyze(base({ light: { ...okLight, mean: 0.08 } }));
    expect(a.lowLight).toBe(true);
    expect(a.nudges[0].id).toBe('dark');
  });

  it('blown highlights and backlight', () => {
    expect(ids(base({ light: { ...okLight, clipped: 0.2 } }))).toContain('blown');
    const p: Person = { box: { x: 0.25, y: 0.1, w: 0.2, h: 0.6 }, nose: { x: 0.33, y: 0.16 } };
    expect(ids(base({ people: [p], light: { ...okLight, subject: 0.15, surround: 0.8 } }))).toContain('backlit');
  });

  it('nudges sort biggest problem first and the score stays in 1–10', () => {
    const a = analyze(base({ rollDeg: 9, light: { ...okLight, mean: 0.05, clipped: 0.3 } }));
    expect(a.nudges[0].severity).toBe(3);
    expect(a.score).toBeGreaterThanOrEqual(1);
  });
});

describe('Steady (anti-flicker)', () => {
  it('shows a nudge after 3 frames and hides it after 4 frames gone', () => {
    const s = new Steady();
    const n = [{ id: 'x', text: 'x', severity: 1 as const, kind: 'composition' as const }];
    expect(s.update(n)).toEqual([]);
    expect(s.update(n)).toEqual([]);
    expect(s.update(n)).toHaveLength(1);
    for (let i = 0; i < 3; i++) s.update([]);
    expect(s.update(n)).toHaveLength(1); // came back before it was hidden
    for (let i = 0; i < 4; i++) s.update([]);
    expect(s.update(n)).toEqual([]);
  });
});

describe('tilt', () => {
  it('reads ~0 when upright in portrait on either sign convention, and in landscape', () => {
    expect(Math.abs(tiltFromGravity(0, 9.8, 0).roll)).toBeLessThan(0.01);
    expect(Math.abs(tiltFromGravity(0, -9.8, 0).roll)).toBeLessThan(0.01);
    expect(Math.abs(tiltFromGravity(9.8, 0, 0).roll)).toBeLessThan(0.01);
  });
  it('measures a small rotation', () => {
    const r = (5 * Math.PI) / 180;
    expect(Math.abs(tiltFromGravity(9.8 * Math.sin(r), -9.8 * Math.cos(r), 0).roll)).toBeCloseTo(5, 1);
  });
});

describe('light measurement', () => {
  const img = (w: number, h: number, f: (x: number, y: number) => number) => {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = f(x, y);
        a.set([v, v, v, 255], (y * w + x) * 4);
      }
    return a;
  };
  it('mean, clipped and crushed', () => {
    const s = measureLight(img(10, 10, (x) => (x < 5 ? 0 : 255)), 10, 10);
    expect(s.mean).toBeCloseTo(0.5, 2);
    expect(s.clipped).toBeCloseTo(0.5);
    expect(s.crushed).toBeCloseTo(0.5);
  });
  it('detects a dark subject against a bright background', () => {
    const box = { x: 0.4, y: 0.3, w: 0.2, h: 0.4 };
    const s = measureLight(img(20, 20, (x, y) => (x >= 8 && x < 12 && y >= 6 && y < 14 ? 30 : 230)), 20, 20, box);
    expect(isBacklit(s)).toBe(true);
  });
});

describe('pose → person', () => {
  it('builds a box with head room above the nose and finds the lowest knee/ankle', () => {
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
    lm[0] = { x: 0.5, y: 0.2, visibility: 0.99 };
    lm[11] = { x: 0.45, y: 0.32, visibility: 0.9 };
    lm[12] = { x: 0.55, y: 0.32, visibility: 0.9 };
    lm[25] = { x: 0.47, y: 0.7, visibility: 0.9 };
    lm[26] = { x: 0.53, y: 0.72, visibility: 0.9 };
    lm[27] = { x: 0.47, y: 1.1, visibility: 0.1 };
    lm[28] = { x: 0.53, y: 1.12, visibility: 0.1 };
    const p = personFromLandmarks(lm)!;
    expect(p.box.y).toBeLessThan(0.2);
    expect(p.knee!.y).toBeCloseTo(0.72);
    expect(p.ankle!.v).toBeLessThan(0.5);
  });
});
