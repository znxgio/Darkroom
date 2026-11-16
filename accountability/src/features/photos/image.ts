// Turning a camera frame into a small JPEG. The sizing math is pure (unit-tested);
// the canvas part only runs in the browser.

/** Every photo is a 3:4 portrait, so days line up in the feed and in Compare. */
export const PHOTO_ASPECT = 3 / 4;
export const MAX_SIDE = 1280;
export const TARGET_BYTES = 350 * 1024;
export const QUALITIES = [0.8, 0.7, 0.6, 0.5];

export interface Rect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** The centered crop of a `vw`×`vh` frame with the given width/height ratio (what the preview shows). */
export function cropRect(vw: number, vh: number, aspect = PHOTO_ASPECT): Rect {
  if (vw / vh > aspect) {
    const sw = Math.round(vh * aspect);
    return { sx: Math.round((vw - sw) / 2), sy: 0, sw, sh: vh };
  }
  const sh = Math.round(vw / aspect);
  return { sx: 0, sy: Math.round((vh - sh) / 2), sw: vw, sh };
}

/** Scale `w`×`h` down (never up) so the longest side is at most `max`. */
export function fitWithin(w: number, h: number, max = MAX_SIDE): { w: number; h: number } {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/**
 * Encode at each quality in turn (high → low) and return the first result under `target` bytes.
 * If none fits, returns the smallest-quality one.
 */
export async function encodeUnderTarget(
  encode: (quality: number) => Promise<Blob>,
  target = TARGET_BYTES,
  qualities = QUALITIES,
): Promise<{ blob: Blob; quality: number }> {
  let last: { blob: Blob; quality: number } | null = null;
  for (const q of qualities) {
    const blob = await encode(q);
    last = { blob, quality: q };
    if (blob.size <= target) return last;
  }
  if (!last) throw new Error('No quality levels given');
  return last;
}

/**
 * Grab the current video frame: center-crop to 3:4, mirror it if the preview is mirrored
 * (so the saved photo looks exactly like what you saw), shrink and compress.
 */
export async function captureFrame(video: HTMLVideoElement, mirrored: boolean): Promise<Blob> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) throw new Error('The camera is not ready yet');
  const crop = cropRect(vw, vh);
  const out = fitWithin(crop.sw, crop.sh);
  const canvas = document.createElement('canvas');
  canvas.width = out.w;
  canvas.height = out.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process the photo');
  if (mirrored) {
    ctx.translate(out.w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, out.w, out.h);
  const { blob } = await encodeUnderTarget(
    (q) =>
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not save the photo'))), 'image/jpeg', q),
      ),
  );
  // Free the bitmap memory right away (matters on iPhone).
  canvas.width = canvas.height = 0;
  return blob;
}
