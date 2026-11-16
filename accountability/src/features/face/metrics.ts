// Face geometry from the 478 face-mesh landmarks (468 mesh points + 10 iris points).
// Pure math: no DOM, no model. Input landmarks are normalized ({x,y} in 0..1 of the image,
// z roughly in units of image width), so everything is first turned into pixels.
//
// Every measurement is roll-corrected: the image is rotated (in math only) so the line through
// the two iris centers is horizontal. A tilted head therefore doesn't change the numbers.
// Small head turns (yaw) and nods (pitch) are also undone with the mesh's depth (see frontalize).
//
// "Left" / "right" below mean the side of the PHOTO (as you see it), not anatomical sides.
//
// Landmark indices used (MediaPipe face mesh topology):
//   468 / 473   iris centers (photo-left / photo-right eye)
//   33 / 133    photo-left eye: outer / inner corner (canthus)
//   362 / 263   photo-right eye: inner / outer corner
//   159 / 145   photo-left eye: upper / lower lid (eye openness)
//   386 / 374   photo-right eye: upper / lower lid
//   234 / 454   face edge at the cheekbones (bizygomatic width)
//   172 / 397   jaw edge near the jaw angle (approx. gonion)
//   64 / 294    nose wings (alar width)
//   61 / 291    mouth corners
//   9           between the brows (glabella / mid-brow)
//   2           base of the nose (subnasale)
//   0           top of the upper lip (center)
//   13 / 14     inner edge of upper / lower lip (stomion sits between)
//   152         bottom of the chin (menton)
//   10          top of the face mesh (forehead; not the hairline)
//   MIRROR_PAIRS left/right twins used for symmetry (checked against the canonical mesh)

export interface Pt {
  x: number;
  y: number;
  z?: number;
}

export interface Pose {
  /** degrees; sign is not meaningful for display, only size and change */
  yaw: number;
  pitch: number;
  /** head tilt in the image plane (degrees) */
  roll: number;
  source: 'matrix' | 'landmarks';
}

export interface FaceMetrics {
  /** Canthal tilt, degrees, positive = outer corner higher. */
  canthalL: number;
  canthalR: number;
  canthal: number;
  /** Bizygomatic width / upper face height (mid-brow → upper lip). */
  fwhr: number;
  /** Lower third / middle third. */
  thirds: number;
  /** (stomion → chin) / (subnasale → stomion); ideal ~2 (1:2). */
  lowerSplit: number;
  /** Intercanthal width / average eye width (rule of fifths ~1). */
  eyeSpacing: number;
  /** Interpupillary distance / bizygomatic width. */
  esr: number;
  /** IPD / (pupil line → upper lip). */
  midface: number;
  /** Alar width / intercanthal width. */
  nose: number;
  /** Mouth width / alar width. */
  mouth: number;
  /** Jaw width / cheekbone width. */
  jaw: number;
  /** 0–100, mirror match of paired landmarks across the facial midline. */
  symmetry: number;
  pose: Pose;
  /** Face width / image width (0..1). */
  faceSize: number;
  /** Average eye aspect ratio (lid gap / eye width); ~0.25 open, <0.15 nearly closed. */
  eyeOpen: number;
  eyesOpen: boolean;
}

export const MIRROR_PAIRS: [number, number][] = [
  // eyes
  [33, 263], [133, 362], [159, 386], [145, 374], [160, 387], [144, 373], [158, 385], [153, 380],
  [246, 466], [7, 249], [163, 390], [161, 388], [157, 384], [154, 381], [155, 382], [173, 398],
  // brows
  [70, 300], [63, 293], [105, 334], [66, 296], [107, 336],
  // face outline
  [234, 454], [93, 323], [132, 361], [58, 288], [172, 397], [136, 365], [150, 379], [149, 378],
  [176, 400], [148, 377], [127, 356], [162, 389], [21, 251], [54, 284], [103, 332], [67, 297], [109, 338],
  // lips
  [61, 291], [40, 270], [37, 267], [39, 269], [185, 409], [146, 375], [91, 321], [181, 405], [84, 314],
  [78, 308], [95, 324], [88, 318], [178, 402], [87, 317], [82, 312], [81, 311], [80, 310], [191, 415],
  // nose
  [64, 294], [48, 278], [98, 327], [129, 358],
  // cheeks
  [50, 280], [205, 425], [187, 411], [123, 352], [116, 345], [117, 346], [118, 347],
];

/** Landmark count the model returns with iris refinement. */
export const LANDMARK_COUNT = 478;

const DEG = 180 / Math.PI;

/** Rotate points so the iris line is horizontal; returns pixel coords in that frame. */
function frame(lm: Pt[], w: number, h: number) {
  const px = lm.map((p) => ({ x: p.x * w, y: p.y * h, z: (p.z ?? 0) * w }));
  const a = px[468];
  const b = px[473];
  const roll = Math.atan2(b.y - a.y, b.x - a.x);
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const c = Math.cos(-roll);
  const s = Math.sin(-roll);
  const pts = px.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c, z: p.z };
  });
  return { px, pts, roll: roll * DEG, center: { x: cx, y: cy }, angle: roll };
}

/** The mesh's own forehead(10)→chin(152) depth slope on a straight-on face (canonical mesh). */
const PITCH_BASE = 0.707;

/**
 * Turn the (roll-corrected) mesh to face the camera, using its own depth (z): undo yaw (cheek
 * edges 234/454 at equal depth) and pitch (forehead 10 vs chin 152). Widths and heights from a
 * slightly turned head then match a straight-on photo much better. Returns the angles undone.
 */
function frontalize(pts: { x: number; y: number; z: number }[], cx: number, cy: number) {
  const yaw = Math.atan2(pts[454].z - pts[234].z, pts[454].x - pts[234].x);
  const cz = (pts[468].z + pts[473].z) / 2;
  const cy0 = Math.cos(yaw);
  const sy0 = Math.sin(yaw);
  const a = pts.map((p) => {
    const dx = p.x - cx;
    const dz = p.z - cz;
    return { x: cx + dx * cy0 + dz * sy0, y: p.y, z: cz - dx * sy0 + dz * cy0 };
  });
  const pitch = Math.atan2(a[152].z - a[10].z, a[152].y - a[10].y) - PITCH_BASE / DEG;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const out = a.map((p) => {
    const dy = p.y - cy;
    const dz = p.z - cz;
    return { x: p.x, y: cy + dy * cp + dz * sp, z: cz - dy * sp + dz * cp };
  });
  return { pts: out, yaw: yaw * DEG, pitch: pitch * DEG };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Yaw/pitch from a 4×4 facial transformation matrix (uses the face's forward axis). */
export function poseFromMatrix(data: number[]): { yaw: number; pitch: number } | null {
  if (!data || data.length < 16 || data.some((n) => !Number.isFinite(n))) return null;
  // Forward axis = third column (column-major). If the layout were row-major this would be the
  // third row, which only flips signs; sizes (what we show and compare) stay the same.
  const fx = data[8];
  const fy = data[9];
  const fz = data[10];
  const n = Math.hypot(fx, fy, fz) || 1;
  return {
    yaw: Math.atan2(fx / n, fz / n) * DEG,
    pitch: Math.asin(Math.max(-1, Math.min(1, -fy / n))) * DEG,
  };
}

export function computeMetrics(
  lm: Pt[],
  width: number,
  height: number,
  matrix?: number[] | null,
): FaceMetrics {
  if (!lm || lm.length < LANDMARK_COUNT) throw new Error(`Need ${LANDMARK_COUNT} landmarks`);
  const f = frame(lm, width, height);
  const roll = f.roll;
  const front = frontalize(f.pts, f.center.x, f.center.y);
  const p = front.pts;

  // 1. Canthal tilt: inner → outer corner vs the (horizontal) eye axis. y grows downward.
  const canthalL = Math.atan2(p[133].y - p[33].y, p[133].x - p[33].x) * DEG;
  const canthalR = Math.atan2(p[362].y - p[263].y, p[263].x - p[362].x) * DEG;

  const cheek = dist(p[234], p[454]);
  const jawW = dist(p[172], p[397]);
  const ipd = dist(p[468], p[473]);
  const intercanthal = dist(p[133], p[362]);
  const eyeW = (dist(p[33], p[133]) + dist(p[362], p[263])) / 2;
  const noseW = dist(p[64], p[294]);
  const mouthW = dist(p[61], p[291]);

  // Heights: vertical distances in the roll-corrected frame.
  const upperFace = p[0].y - p[9].y;
  const middle = p[2].y - p[9].y;
  const lower = p[152].y - p[2].y;
  const lipUpper = p[13].y - p[2].y;
  const chinPart = p[152].y - p[14].y;
  const pupilY = (p[468].y + p[473].y) / 2;
  const pupilToLip = p[0].y - pupilY;

  // 11. Symmetry: best-fit vertical midline (mean of pair midpoints), mirror the left point of
  // each pair across it and measure how far it lands from its twin, relative to face width.
  let mid = 0;
  for (const [a, b] of MIRROR_PAIRS) mid += (p[a].x + p[b].x) / 2;
  mid /= MIRROR_PAIRS.length;
  let dev = 0;
  for (const [a, b] of MIRROR_PAIRS) {
    const mx = 2 * mid - p[a].x;
    dev += Math.hypot(mx - p[b].x, p[a].y - p[b].y);
  }
  dev /= MIRROR_PAIRS.length;
  // 1% of face width average mismatch costs 5 points.
  const symmetry = clamp(100 - (dev / (cheek || 1)) * 500, 0, 100);

  // 12. Pose. Yaw from the depth difference of the two cheek edges, pitch from forehead vs chin
  // depth (the mesh's own z, see frontalize); the model's transformation matrix wins when given.
  let yaw = front.yaw;
  let pitch = front.pitch;
  let source: Pose['source'] = 'landmarks';
  const fromM = matrix ? poseFromMatrix(matrix) : null;
  if (fromM) {
    yaw = fromM.yaw;
    pitch = fromM.pitch;
    source = 'matrix';
  }

  const earL = dist(p[159], p[145]) / (dist(p[33], p[133]) || 1);
  const earR = dist(p[386], p[374]) / (dist(p[362], p[263]) || 1);
  const eyeOpen = (earL + earR) / 2;

  const safe = (n: number, d: number) => (d > 0 ? n / d : 0);
  return {
    canthalL,
    canthalR,
    canthal: (canthalL + canthalR) / 2,
    fwhr: safe(cheek, upperFace),
    thirds: safe(lower, middle),
    lowerSplit: safe(chinPart, lipUpper),
    eyeSpacing: safe(intercanthal, eyeW),
    esr: safe(ipd, cheek),
    midface: safe(ipd, pupilToLip),
    nose: safe(noseW, intercanthal),
    mouth: safe(mouthW, noseW),
    jaw: safe(jawW, cheek),
    symmetry,
    pose: { yaw, pitch, roll, source },
    faceSize: safe(dist(f.px[234], f.px[454]), width),
    eyeOpen,
    eyesOpen: eyeOpen >= 0.15,
  };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

// ---------- overlay ----------

export type LineKind = 'axis' | 'canthal' | 'third' | 'width' | 'mid';

export interface Seg {
  k: LineKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Guide lines in IMAGE pixel coords (for drawing over the photo): eye axis, canthal lines,
 * thirds lines, width lines and the midline. Built in the roll-corrected frame, rotated back.
 */
export function overlayLines(lm: Pt[], width: number, height: number): { lines: Seg[]; dots: Pt[] } {
  const { pts: p, center, angle } = frame(lm, width, height);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const back = (q: Pt) => {
    const dx = q.x - center.x;
    const dy = q.y - center.y;
    return { x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c };
  };
  const seg = (k: LineKind, a: Pt, b: Pt): Seg => {
    const A = back(a);
    const B = back(b);
    return { k, x1: r1(A.x), y1: r1(A.y), x2: r1(B.x), y2: r1(B.y) };
  };
  const ext = (a: Pt, b: Pt, f: number) => {
    // extend segment a→b by factor f beyond b
    return { x: b.x + (b.x - a.x) * f, y: b.y + (b.y - a.y) * f };
  };
  const left = p[234].x;
  const right = p[454].x;
  const pad = (right - left) * 0.06;
  const hline = (k: LineKind, y: number) => seg(k, { x: left - pad, y }, { x: right + pad, y });
  const lines: Seg[] = [
    hline('axis', (p[468].y + p[473].y) / 2),
    seg('canthal', ext(p[263], p[133], 0.15), ext(p[133], p[33], 0.6)),
    seg('canthal', ext(p[33], p[362], 0.15), ext(p[362], p[263], 0.6)),
    hline('third', p[9].y),
    hline('third', p[2].y),
    hline('third', p[152].y),
    seg('width', p[234], p[454]),
    seg('width', p[172], p[397]),
    seg('width', p[64], p[294]),
    seg('width', p[61], p[291]),
  ];
  let mid = 0;
  for (const [a, b] of MIRROR_PAIRS) mid += (p[a].x + p[b].x) / 2;
  mid /= MIRROR_PAIRS.length;
  lines.push(seg('mid', { x: mid, y: p[10].y }, { x: mid, y: p[152].y }));
  const dots = [468, 473, 33, 133, 362, 263, 9, 2, 0, 13, 14, 152, 234, 454, 172, 397, 64, 294, 61, 291].map((i) => {
    const q = back(p[i]);
    return { x: r1(q.x), y: r1(q.y) };
  });
  return { lines, dots };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
