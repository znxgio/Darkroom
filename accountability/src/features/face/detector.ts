// On-device face landmarks (478 points incl. iris). Photos never leave the phone for this.
// The library, wasm and model are self-hosted under /mediapipe/ and only loaded the first time
// the Face view (or a fresh face photo) needs them: the library is a dynamic import, so it's
// its own chunk and the main bundle stays small.
import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import { MODEL_URL, WASM_BASE } from './constants';
import type { Pt } from './metrics';

export interface DetectedFace {
  landmarks: Pt[];
  matrix: number[] | null;
}

export type LoadProgress = (loaded: number, total: number) => void;

export class OfflineError extends Error {
  constructor() {
    super('The face model needs an internet connection the first time.');
  }
}

let ready: Promise<FaceLandmarker> | null = null;
const listeners = new Set<LoadProgress>();

/** Download with byte progress (so the UI can show "Loading face model… 40%"). */
async function fetchBytes(url: string, onBytes: (n: number, total: number) => void): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new OfflineError();
  }
  if (!res.ok) throw new Error(`Couldn't load ${url.split('/').pop()} (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onBytes(buf.length, buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    onBytes(n, Math.max(total, n));
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function create(): Promise<FaceLandmarker> {
  const vision = await import('@mediapipe/tasks-vision').catch((e) => {
    throw navigator.onLine === false ? new OfflineError() : e;
  });
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
  // Fetch the wasm binary and the model ourselves to report progress; hand the wasm to the
  // library as a blob: URL so it isn't downloaded twice.
  const got = { wasm: 0, model: 0 };
  const tot = { wasm: 9_600_000, model: 3_760_000 };
  const report = () => {
    const l = got.wasm + got.model;
    const t = Math.max(tot.wasm + tot.model, l);
    for (const fn of listeners) fn(l, t);
  };
  const [wasm, model] = await Promise.all([
    fetchBytes(fileset.wasmBinaryPath, (n, t) => {
      got.wasm = n;
      tot.wasm = t;
      report();
    }),
    fetchBytes(MODEL_URL, (n, t) => {
      got.model = n;
      tot.model = t;
      report();
    }),
  ]);
  const wasmUrl = URL.createObjectURL(new Blob([wasm as BlobPart], { type: 'application/wasm' }));
  try {
    return await vision.FaceLandmarker.createFromOptions(
      { ...fileset, wasmBinaryPath: wasmUrl },
      {
        baseOptions: { modelAssetBuffer: model, delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 3,
        outputFacialTransformationMatrixes: true,
        outputFaceBlendshapes: false,
      },
    );
  } finally {
    URL.revokeObjectURL(wasmUrl);
  }
}

/** Load (once) and return the landmarker. Failed loads can be retried. */
export function loadDetector(onProgress?: LoadProgress): Promise<FaceLandmarker> {
  if (onProgress) listeners.add(onProgress);
  if (!ready) {
    ready = create().catch((e) => {
      ready = null;
      throw e;
    });
  }
  const p = ready;
  p.finally(() => onProgress && listeners.delete(onProgress)).catch(() => {});
  return p;
}

/** All faces in the image, largest first. */
export async function detectFaces(
  img: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  onProgress?: LoadProgress,
): Promise<DetectedFace[]> {
  const lm = await loadDetector(onProgress);
  const r = lm.detect(img);
  const faces = (r.faceLandmarks ?? []).map((pts, i) => ({
    landmarks: pts.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    matrix: r.facialTransformationMatrixes?.[i]?.data ?? null,
  }));
  const width = (f: DetectedFace) => {
    const xs = f.landmarks.map((p) => p.x);
    return Math.max(...xs) - Math.min(...xs);
  };
  return faces.sort((a, b) => width(b) - width(a));
}
