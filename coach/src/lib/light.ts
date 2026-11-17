// Lighting checks on a small downscaled copy of the camera frame.
// Pure functions so they can be unit-tested without a camera.
import type { Box } from './coach';

export interface LightStats {
  /** average brightness 0..1 */
  mean: number;
  /** share of pixels that are blown out (near white) */
  clipped: number;
  /** share of pixels that are crushed (near black) */
  crushed: number;
  /** brightness inside the main subject (null when no subject) */
  subject: number | null;
  /** brightness around the subject (null when no subject) */
  surround: number | null;
}

const luma = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * rgba: pixel data (4 bytes per pixel) of a w×h image.
 * subject: optional normalized box of the main subject.
 */
export function measureLight(rgba: ArrayLike<number>, w: number, h: number, subject?: Box | null): LightStats {
  let sum = 0;
  let clipped = 0;
  let crushed = 0;
  let sIn = 0;
  let nIn = 0;
  let sOut = 0;
  let nOut = 0;
  const bx0 = subject ? Math.floor(subject.x * w) : -1;
  const bx1 = subject ? Math.ceil((subject.x + subject.w) * w) : -1;
  const by0 = subject ? Math.floor(subject.y * h) : -1;
  const by1 = subject ? Math.ceil((subject.y + subject.h) * h) : -1;
  // "around the subject" = a band one subject-size wide around the box
  const padX = subject ? Math.ceil(subject.w * w * 0.6) : 0;
  const padY = subject ? Math.ceil(subject.h * h * 0.4) : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = luma(rgba[i], rgba[i + 1], rgba[i + 2]);
      sum += l;
      if (l > 0.97) clipped++;
      if (l < 0.03) crushed++;
      if (subject) {
        const inside = x >= bx0 && x < bx1 && y >= by0 && y < by1;
        if (inside) {
          sIn += l;
          nIn++;
        } else if (x >= bx0 - padX && x < bx1 + padX && y >= by0 - padY && y < by1 + padY) {
          sOut += l;
          nOut++;
        }
      }
    }
  }
  const n = w * h || 1;
  return {
    mean: sum / n,
    clipped: clipped / n,
    crushed: crushed / n,
    subject: nIn ? sIn / nIn : null,
    surround: nOut ? sOut / nOut : null,
  };
}

/** Dark enough that the browser camera will look muddy/noisy (venues, raves, night streets). */
export const LOW_LIGHT_MEAN = 0.13;

export function isBacklit(s: LightStats): boolean {
  if (s.subject == null || s.surround == null) {
    // No subject: a bright band behind a dark frame (e.g. window, stage lights) still counts
    return false;
  }
  return s.surround > 0.45 && s.subject < s.surround * 0.5;
}
