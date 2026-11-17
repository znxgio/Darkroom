// On-device detection with Google's MediaPipe (runs in the browser; nothing is uploaded).
// Three small models, run in turns so the phone stays cool:
//  - pose: people, with head/knee/ankle points (headroom, cut-off feet)
//  - face: faces, even small ones in a crowd
//  - objects: everything else (dogs, cars, drinks, signs…)
import type { Box, Person, Point, Thing } from '../../lib/coach';

type Vision = typeof import('@mediapipe/tasks-vision');

/** Served from our own site (copied from the npm package at build time). */
const WASM_PATH = '/mediapipe';
const MODELS = {
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  face: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
  objects: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite',
};

export interface Detections {
  people: Person[];
  faces: Box[];
  things: Thing[];
}

export interface Detector {
  detect(video: HTMLVideoElement, t: number): Detections;
  close(): void;
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

export function personFromLandmarks(lm: { x: number; y: number; visibility?: number }[]): Person | null {
  if (!lm || lm.length < 29) return null;
  const vis = (i: number) => lm[i]?.visibility ?? 1;
  const pts = lm.filter((p) => (p.visibility ?? 1) > 0.5 && p.x > -0.1 && p.x < 1.1 && p.y > -0.2 && p.y < 1.2);
  if (pts.length < 5) return null;
  const nose = lm[0];
  const shoulderY = (lm[11].y + lm[12].y) / 2;
  // top of head ≈ above the nose by about half the nose-to-shoulder distance
  const headTop = nose.y - Math.max(0.02, (shoulderY - nose.y) * 0.75);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = clamp(Math.min(...xs) - 0.02);
  const x1 = clamp(Math.max(...xs) + 0.02);
  const y0 = clamp(Math.min(headTop, ...ys));
  const y1 = clamp(Math.max(...ys) + 0.01);
  const lowest = (a: number, b: number): Point => {
    const p = lm[a].y > lm[b].y ? a : b;
    return { x: lm[p].x, y: lm[p].y, v: vis(p) };
  };
  return {
    box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    nose: { x: nose.x, y: nose.y, v: vis(0) },
    knee: lowest(25, 26),
    ankle: lowest(27, 28),
  };
}

export async function createDetector(): Promise<Detector> {
  const vision: Vision = await import('@mediapipe/tasks-vision');
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);

  async function make<T>(fn: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T> {
    try {
      return await fn('GPU');
    } catch {
      return await fn('CPU'); // some iPhones/browsers refuse WebGL in this mode
    }
  }
  const [pose, face, objects] = await Promise.all([
    make((delegate) =>
      vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODELS.pose, delegate },
        runningMode: 'VIDEO',
        numPoses: 3,
      }),
    ),
    make((delegate) =>
      vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODELS.face, delegate },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5,
      }),
    ),
    make((delegate) =>
      vision.ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODELS.objects, delegate },
        runningMode: 'VIDEO',
        scoreThreshold: 0.35,
        maxResults: 6,
      }),
    ),
  ]);

  let turn = 0;
  const last: Detections = { people: [], faces: [], things: [] };
  let lastT = 0;

  return {
    detect(video, t) {
      // timestamps must strictly increase for each model
      const ts = Math.max(t, lastT + 1);
      lastT = ts;
      const w = video.videoWidth || 1;
      const h = video.videoHeight || 1;
      const norm = (b?: { originX: number; originY: number; width: number; height: number }): Box | null =>
        b ? { x: clamp(b.originX / w), y: clamp(b.originY / h), w: clamp(b.width / w), h: clamp(b.height / h) } : null;
      const which = turn++ % 3;
      try {
        if (which === 0) {
          const r = pose.detectForVideo(video, ts);
          last.people = (r.landmarks ?? []).map(personFromLandmarks).filter((p): p is Person => !!p);
        } else if (which === 1) {
          const r = face.detectForVideo(video, ts);
          last.faces = r.detections.map((d) => norm(d.boundingBox)).filter((b): b is Box => !!b);
        } else {
          const r = objects.detectForVideo(video, ts);
          last.things = r.detections
            .map((d) => {
              const box = norm(d.boundingBox);
              const c = d.categories[0];
              return box && c ? { box, label: c.categoryName, score: c.score } : null;
            })
            .filter((x): x is Thing => !!x);
          // People the pose model missed (far away, partly hidden) still count as people
          if (!last.people.length) {
            last.people = last.things.filter((x) => x.label === 'person' && x.score > 0.5).map((x) => ({ box: x.box }));
          }
        }
      } catch {
        /* a dropped frame is fine */
      }
      return { people: last.people, faces: last.faces, things: last.things };
    },
    close() {
      pose.close();
      face.close();
      objects.close();
    },
  };
}
