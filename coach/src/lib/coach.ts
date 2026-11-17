// The live-coaching rules: turns what the camera sees into short nudges and a 1–10 score.
// Everything here is plain math on normalized coordinates (0..1, origin top-left),
// so it runs the same in tests and on the phone.
import { isBacklit, LOW_LIGHT_MEAN, type LightStats } from './light';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
  /** 0..1 how sure the model is this point is visible */
  v?: number;
}

export interface Person {
  box: Box;
  /** pose points we care about (missing when not detected) */
  nose?: Point;
  knee?: Point; // lowest knee
  ankle?: Point; // lowest ankle
}

export interface Thing {
  box: Box;
  label: string;
  score: number;
}

export type GuideMode = 'thirds' | 'center';

export interface FrameInput {
  people: Person[];
  faces: Box[];
  things: Thing[];
  /** degrees the phone is rotated away from level (null = no sensor) */
  rollDeg: number | null;
  /** degrees the phone points up (+) or down (−) away from vertical (null = no sensor) */
  pitchDeg: number | null;
  light: LightStats | null;
  /** 'center' when the symmetry guide is on: centered subjects are the goal */
  guide: GuideMode;
  /** false until the detector has produced at least one result */
  detectorReady: boolean;
}

export type NudgeKind = 'level' | 'composition' | 'light';

export interface Nudge {
  id: string;
  text: string;
  /** 3 = big problem, 1 = minor */
  severity: 1 | 2 | 3;
  kind: NudgeKind;
}

export interface Analysis {
  score: number;
  nudges: Nudge[];
  /** too dark for the browser camera: tell the user to use the native Camera app */
  lowLight: boolean;
  /** what we treated as the main subject (for drawing) */
  subject: Box | null;
  /** what the subject is ("person", "face", or an object label) */
  subjectLabel: string | null;
  /** whether the subject sits on a strong point (thirds or center) */
  wellPlaced: boolean;
}

const area = (b: Box) => b.w * b.h;
const cx = (b: Box) => b.x + b.w / 2;
const cy = (b: Box) => b.y + b.h / 2;

/** Objects that make sense as a "main subject" for candid shots. */
const SUBJECT_LABELS = new Set([
  'person', 'dog', 'cat', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'bird', 'skateboard',
  'cup', 'wine glass', 'bottle', 'umbrella', 'chair', 'bench', 'potted plant', 'traffic light',
  'horse', 'cake', 'pizza', 'guitar', 'cell phone', 'handbag', 'backpack', 'clock',
]);

export function pickSubject(input: FrameInput): { box: Box; label: string } | null {
  // People first: candid photos are about people. Largest person wins.
  const people = [...input.people].sort((a, b) => area(b.box) - area(a.box));
  if (people[0] && area(people[0].box) > 0.01) return { box: people[0].box, label: 'person' };
  const faces = [...input.faces].sort((a, b) => area(b) - area(a));
  if (faces[0]) return { box: faces[0], label: 'face' };
  const things = input.things
    .filter((t) => SUBJECT_LABELS.has(t.label) && t.score > 0.35)
    .sort((a, b) => area(b.box) * b.score - area(a.box) * a.score);
  if (things[0]) return { box: things[0].box, label: things[0].label };
  return null;
}

/** Distance from the subject's "focus point" to the nearest strong point for the guide mode. */
function placement(focus: Point, guide: GuideMode): { off: number; dx: number; dy: number } {
  if (guide === 'center') {
    return { off: Math.abs(focus.x - 0.5), dx: 0.5 - focus.x, dy: 0 };
  }
  // Thirds: the closest vertical third line, and the upper third line for eyes/heads.
  const lines = [1 / 3, 2 / 3];
  const nearX = lines.reduce((a, b) => (Math.abs(b - focus.x) < Math.abs(a - focus.x) ? b : a));
  // A subject dead-center horizontally also reads fine for candid shots; treat center as OK too.
  const centerOk = Math.abs(focus.x - 0.5) < 0.05;
  const dx = centerOk ? 0 : nearX - focus.x;
  return { off: Math.abs(dx), dx, dy: 0 };
}

export function analyze(input: FrameInput): Analysis {
  const nudges: Nudge[] = [];
  const add = (id: string, text: string, severity: 1 | 2 | 3, kind: NudgeKind) =>
    nudges.push({ id, text, severity, kind });

  // ---- Level ----
  if (input.rollDeg != null) {
    const r = input.rollDeg;
    if (Math.abs(r) >= 2) {
      // Direction is shown by the level line on screen (sensor sign conventions vary by device)
      add('horizon', `Horizon crooked ${Math.round(Math.abs(r))}° — line up the level`, Math.abs(r) >= 5 ? 3 : 2, 'level');
    }
  }

  // ---- Light ----
  const L = input.light;
  const lowLight = !!L && L.mean < LOW_LIGHT_MEAN;
  if (L) {
    if (lowLight) add('dark', 'Too dark for this camera', 3, 'light');
    else if (L.mean < 0.22) add('dim', 'A bit dark — find more light', 1, 'light');
    if (L.clipped > 0.12) add('blown', 'Highlights blown — reframe off the bright lights', 2, 'light');
  }

  // ---- Composition ----
  const subj = pickSubject(input);
  let wellPlaced = false;
  if (subj && L) {
    // light inside vs around the subject needs the subject box; the caller measured with it
    if (isBacklit(L)) add('backlit', 'Backlit — put the light beside you', 2, 'light');
  }

  if (subj) {
    const b = subj.box;
    const person = subj.label === 'person' ? input.people.find((p) => p.box === b) : undefined;
    const face = subj.label === 'face' ? b : input.faces.find((f) => cx(f) > b.x && cx(f) < b.x + b.w && f.y < b.y + b.h * 0.4);

    // Focus point: eyes/face for people, center for things
    const focus: Point = face
      ? { x: cx(face), y: face.y + face.h * 0.4 }
      : person?.nose
        ? { x: person.nose.x, y: person.nose.y }
        : { x: cx(b), y: cy(b) };

    // Size
    if (area(b) < 0.015) add('tiny', 'Get closer — subject is tiny', 2, 'composition');

    // Head and headroom (people only)
    if (person || face) {
      const top = b.y;
      const big = b.h > 0.35;
      if (top <= 0.005 && face && face.y <= 0.01) add('headcut', 'Head cut off — tilt up', 3, 'composition');
      else if (big && top > 0.22) add('headroom', 'Too much headroom — tilt down', 2, 'composition');
      else if (!big && focus.y > 0.62) add('low', 'Subject sits low — tilt down', 1, 'composition');
    }

    // Feet / joints (needs pose points)
    if (person && b.y + b.h > 0.97) {
      const knee = person.knee;
      const ankle = person.ankle;
      const kneeIn = knee && (knee.v ?? 1) > 0.5 && knee.y < 0.97;
      const ankleOut = !ankle || (ankle.v ?? 1) < 0.5 || ankle.y > 0.97;
      if (kneeIn && ankleOut) {
        if (knee!.y > 0.85) add('knees', 'Cropping at the knees — go wider or crop at the waist', 2, 'composition');
        else add('feet', 'Cutting off feet — step back or crop higher', 2, 'composition');
      }
    }

    // Edges: a subject jammed against the left/right edge
    const touchesSide = b.x < 0.02 || b.x + b.w > 0.98;
    if (touchesSide && b.w < 0.7) add('edge', 'Subject touching the edge — give it room', 1, 'composition');

    // Placement
    const p = placement(focus, input.guide);
    wellPlaced = p.off < 0.07;
    if (!wellPlaced && b.w < 0.75) {
      if (input.guide === 'center') {
        add('center', p.dx > 0 ? 'Pan left to center it ←' : 'Pan right to center it →', 1, 'composition');
      } else if (p.off > 0.12) {
        // dx > 0: subject should move right in frame → aim the camera left
        add('place', p.dx > 0 ? 'Pan left ← to put them on a third' : 'Pan right → to put them on a third', 1, 'composition');
      }
    }
  } else if (input.detectorReady) {
    add('nosubject', 'No clear subject — pick one thing', 1, 'composition');
  }

  // Leaning verticals (buildings, signs) when no people are the point of the shot
  if (input.pitchDeg != null && Math.abs(input.pitchDeg) > 12 && (!subj || subj.label !== 'person')) {
    add('keystone', 'Phone tipped — hold it upright so buildings don’t lean', 1, 'level');
  }

  // ---- Score ----
  let score = 9;
  for (const n of nudges) score -= n.severity === 3 ? 2.5 : n.severity === 2 ? 1.5 : 0.6;
  if (wellPlaced) score += 1;
  if (!subj) score = Math.min(score, 6);
  score = Math.max(1, Math.min(10, Math.round(score)));

  nudges.sort((a, b) => b.severity - a.severity);
  return { score, nudges, lowLight, subject: subj?.box ?? null, subjectLabel: subj?.label ?? null, wellPlaced };
}

/**
 * Keeps nudges from flickering: a nudge shows once it's been seen in most recent frames,
 * and hides once it's been gone for a while.
 */
export class Steady {
  private seen = new Map<string, number>();
  private shown = new Set<string>();
  constructor(
    private readonly onAfter = 3,
    private readonly offAfter = 4,
  ) {}

  update(nudges: Nudge[]): Nudge[] {
    const ids = new Set(nudges.map((n) => n.id));
    for (const id of ids) this.seen.set(id, Math.max(0, this.seen.get(id) ?? 0) + 1);
    for (const [id, c] of this.seen) {
      if (!ids.has(id)) this.seen.set(id, Math.min(0, c) - 1);
    }
    for (const [id, c] of this.seen) {
      if (c >= this.onAfter) this.shown.add(id);
      if (c <= -this.offAfter) {
        this.shown.delete(id);
        this.seen.delete(id);
      }
    }
    // Show current text for nudges still present; drop ones that have gone (but keep hysteresis for re-show)
    return nudges.filter((n) => this.shown.has(n.id));
  }
}

/** Rolling average so the score number doesn't jump every frame. */
export class Smooth {
  private v: number | null = null;
  constructor(private readonly k = 0.25) {}
  push(x: number): number {
    this.v = this.v == null ? x : this.v + (x - this.v) * this.k;
    return Math.round(this.v);
  }
}

/**
 * Phone tilt from the gravity vector (DeviceMotion accelerationIncludingGravity, device axes).
 * roll: rotation in the screen plane away from the nearest upright/landscape position.
 * pitch: how far the camera points up or down from straight ahead (portrait).
 */
export function tiltFromGravity(gx: number, gy: number, gz: number): { roll: number; pitch: number } {
  const deg = (r: number) => (r * 180) / Math.PI;
  let roll = deg(Math.atan2(gx, gy));
  // fold to the nearest 90° so portrait and landscape both read ~0 when level
  roll = ((((roll + 45) % 90) + 90) % 90) - 45;
  const pitch = deg(Math.atan2(gz, Math.hypot(gx, gy)));
  return { roll, pitch };
}
