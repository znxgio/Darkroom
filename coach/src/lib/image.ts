// Photo helpers: decode a picked file, make the small copies we need, read camera info.
// Full-size photos are never uploaded: only a ~1600px copy goes to the AI (not stored),
// and a ~360px thumbnail is saved for the gallery.
import type { Exif } from '../data/types';

/** Long edge sent to the AI. ~2,500 image tokens ≈ $0.01 of input per critique. */
export const AI_LONG_EDGE = 1600;
export const THUMB_LONG_EDGE = 360;

export type Drawable = HTMLImageElement | ImageBitmap | HTMLCanvasElement | HTMLVideoElement;

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode'));
    img.src = src;
  });
}

/** iPhone photos can be HEIC; Safari decodes those natively, other browsers may not. */
export async function decodeFile(file: Blob): Promise<HTMLImageElement | ImageBitmap> {
  try {
    return await loadImg(URL.createObjectURL(file));
  } catch {
    /* try the next way */
  }
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This photo format can’t be opened here. Try a JPEG or a screenshot.');
  }
}

export function sizeOf(img: Drawable): { w: number; h: number } {
  if (img instanceof HTMLVideoElement) return { w: img.videoWidth, h: img.videoHeight };
  if (img instanceof HTMLImageElement) return { w: img.naturalWidth, h: img.naturalHeight };
  return { w: img.width, h: img.height };
}

export function scaled(img: Drawable, longEdge: number): HTMLCanvasElement {
  const { w, h } = sizeOf(img);
  const k = Math.min(1, longEdge / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export const toBlob = (c: HTMLCanvasElement, q = 0.9) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', q));

/** base64 JPEG (no "data:" prefix) for the AI. */
export function forAI(img: Drawable): string {
  return scaled(img, AI_LONG_EDGE).toDataURL('image/jpeg', 0.85).split(',')[1];
}

/** Small JPEG data URL for the gallery (~10–20 KB). */
export function thumbnail(img: Drawable): string {
  return scaled(img, THUMB_LONG_EDGE).toDataURL('image/jpeg', 0.72);
}

/** Camera info only. GPS/location and anything personal is never read. */
export async function readExif(file: Blob): Promise<{ exif: Exif | null; takenAt: string | null }> {
  try {
    const { default: exifr } = await import('exifr');
    const t = await exifr.parse(file, {
      pick: ['Make', 'Model', 'LensModel', 'FocalLengthIn35mmFormat', 'ISO', 'ExposureTime', 'FNumber', 'Flash', 'DateTimeOriginal'],
      gps: false,
    });
    if (!t) return { exif: null, takenAt: null };
    const e: Exif = {};
    if (t.Make) e.make = String(t.Make);
    if (t.Model) e.model = String(t.Model);
    if (t.LensModel) e.lens = String(t.LensModel);
    if (t.FocalLengthIn35mmFormat) e.focalLength35 = Number(t.FocalLengthIn35mmFormat);
    if (t.ISO) e.iso = Number(t.ISO);
    if (t.ExposureTime) e.shutter = t.ExposureTime >= 1 ? `${t.ExposureTime}s` : `1/${Math.round(1 / t.ExposureTime)}`;
    if (t.FNumber) e.aperture = Number(t.FNumber);
    if (t.Flash != null) e.flash = typeof t.Flash === 'string' ? /fired/i.test(t.Flash) && !/did not/i.test(t.Flash) : !!(Number(t.Flash) & 1);
    const taken = t.DateTimeOriginal instanceof Date ? t.DateTimeOriginal.toISOString() : null;
    return { exif: Object.keys(e).length ? e : null, takenAt: taken };
  } catch {
    return { exif: null, takenAt: null };
  }
}

/**
 * Save to the camera roll. Web apps can't write to Photos directly; on iPhone the share sheet
 * has "Save Image". Must run straight from a tap (no awaiting before it).
 * Returns false when sharing isn't available so the caller can show the long-press fallback.
 */
export async function shareImage(file: File): Promise<'shared' | 'cancelled' | 'unsupported'> {
  if (!navigator.canShare || !navigator.canShare({ files: [file] })) return 'unsupported';
  try {
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'cancelled';
    return 'unsupported';
  }
}
