// Analyze a day's face photo: landmarks → metrics → (cached) result. Today's score is also saved
// as the `face_score` tracker entry. Past days are computed on the fly and cached on this device
// (keyed by day + a fingerprint of the photo bytes + CACHE_VERSION), never written to the database.
import type { Backend } from '../../data/backend';
import type { Day } from '../../lib/dates';
import { photosApi } from '../photos/api';
import { trackersApi } from '../trackers/api';
import { CACHE_VERSION, FACE_TRACKER } from './constants';
import { detectFaces, OfflineError, type DetectedFace, type LoadProgress } from './detector';
import { computeMetrics, overlayLines, type FaceMetrics, type Pt, type Seg } from './metrics';
import { compactValue } from './score';

interface Base {
  day: Day;
  ver: number;
  /** image size (px) */
  w: number;
  h: number;
  /** average brightness 0..1 */
  light: number;
}

export type FaceResult =
  | (Base & { status: 'ok'; faces: number; metrics: FaceMetrics; lines: Seg[]; dots: Pt[] })
  | (Base & { status: 'noface' });

/** Below this average brightness the photo is likely too dark for good landmarks. */
export const LOW_LIGHT = 0.22;

declare global {
  interface Window {
    /** Browser checks only: fake landmarks per day instead of running the model. */
    __FACE_TEST__?: Record<string, Pt[] | null>;
  }
}

// ---------- cache ----------

interface CacheEntry {
  fp: string;
  r: FaceResult;
}
const MAX_CACHED = 150;

function cacheKey(b: Backend) {
  return `${b.storagePrefix}:face-cache`;
}

function readCache(b: Backend): Record<Day, CacheEntry> {
  try {
    const raw = localStorage.getItem(cacheKey(b));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCache(b: Backend, day: Day, entry: CacheEntry) {
  try {
    const all = readCache(b);
    all[day] = entry;
    const days = Object.keys(all).sort().reverse();
    for (const d of days.slice(MAX_CACHED)) delete all[d];
    localStorage.setItem(cacheKey(b), JSON.stringify(all));
  } catch {
    /* storage full or blocked: just recompute next time */
  }
}

/** Cheap fingerprint of the photo bytes (FNV-1a over every 7th byte + length). */
export function fingerprint(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 7) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${bytes.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

// ---------- image helpers ----------

function decode(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read the photo"));
    };
    img.src = url;
  });
}

function brightness(img: HTMLImageElement): number {
  try {
    const c = document.createElement('canvas');
    c.width = 24;
    c.height = 32;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0.5;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return s / (d.length / 4) / 255;
  } catch {
    return 0.5;
  }
}

// ---------- analysis ----------

const inFlight = new Map<string, Promise<FaceResult>>();

export async function analyzeDay(b: Backend, day: Day, url: string, onProgress?: LoadProgress): Promise<FaceResult> {
  let blob: Blob;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Couldn't load the photo (${res.status})`);
    blob = await res.blob();
  } catch (e) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new OfflineError();
    throw e;
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const fp = fingerprint(bytes);
  const test = typeof window !== 'undefined' ? window.__FACE_TEST__ : undefined;
  if (!test) {
    const hit = readCache(b)[day];
    if (hit && hit.fp === fp && hit.r.ver === CACHE_VERSION) return hit.r;
  }
  const key = `${day}|${fp}`;
  let p = inFlight.get(key);
  if (!p) {
    p = run(b, day, blob, fp, test, onProgress).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

async function run(
  b: Backend,
  day: Day,
  blob: Blob,
  fp: string,
  test: Record<string, Pt[] | null> | undefined,
  onProgress?: LoadProgress,
): Promise<FaceResult> {
  const img = await decode(blob);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const light = Math.round(brightness(img) * 1000) / 1000;
  let faces: DetectedFace[];
  if (test) {
    const lm = test[day];
    faces = lm ? [{ landmarks: lm, matrix: null }] : [];
  } else {
    faces = await detectFaces(img, onProgress);
  }
  const base = { day, ver: CACHE_VERSION, w, h, light };
  let r: FaceResult;
  if (!faces.length) {
    r = { ...base, status: 'noface' };
  } else {
    const f = faces[0];
    const metrics = computeMetrics(f.landmarks, w, h, f.matrix);
    const { lines, dots } = overlayLines(f.landmarks, w, h);
    r = { ...base, status: 'ok', faces: faces.length, metrics, lines, dots };
  }
  if (!test) writeCache(b, day, { fp, r });
  return r;
}

/** Save today's result as the face_score tracker entry (or clear it when no face was found). */
export async function saveToday(b: Backend, r: FaceResult): Promise<boolean> {
  const today = await b.repo.today();
  if (r.day !== today) return false; // past days are locked in the database; never write them
  const api = trackersApi(b);
  const cur = await api.get(FACE_TRACKER, today).catch(() => null);
  if (r.status !== 'ok') {
    if (cur) await api.removeToday(FACE_TRACKER);
    return !!cur;
  }
  const value = compactValue(r.metrics, CACHE_VERSION);
  if (cur && JSON.stringify(cur.value) === JSON.stringify(value)) return false;
  await api.upsertToday(FACE_TRACKER, value);
  return true;
}

/** Analyze today's face photo (if any) and save the score. Used right after capture. */
export async function scoreToday(b: Backend): Promise<FaceResult | null> {
  const [today, photos] = await Promise.all([b.repo.today(), photosApi(b).today()]);
  if (!photos.face) return null;
  const r = await analyzeDay(b, today, photos.face);
  await saveToday(b, r);
  return r;
}
