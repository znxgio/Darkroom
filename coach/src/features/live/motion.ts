// Phone tilt for the level line. iPhone asks permission the first time (must come from a tap).
import { tiltFromGravity } from '../../lib/coach';

type PermissionFn = () => Promise<'granted' | 'denied'>;

export function motionNeedsPermission(): boolean {
  const D = (globalThis as { DeviceMotionEvent?: { requestPermission?: PermissionFn } }).DeviceMotionEvent;
  return typeof D?.requestPermission === 'function';
}

export async function requestMotion(): Promise<boolean> {
  const D = (globalThis as { DeviceMotionEvent?: { requestPermission?: PermissionFn } }).DeviceMotionEvent;
  if (!D) return false;
  if (typeof D.requestPermission !== 'function') return true;
  try {
    return (await D.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/** Calls back with smoothed {roll, pitch} in degrees. Returns a stop function. */
export function watchTilt(cb: (t: { roll: number; pitch: number }) => void): () => void {
  let g: [number, number, number] | null = null;
  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const next: [number, number, number] = [a.x, a.y, a.z];
    // low-pass filter so hand shake doesn't make the line jitter
    g = g ? [g[0] * 0.8 + next[0] * 0.2, g[1] * 0.8 + next[1] * 0.2, g[2] * 0.8 + next[2] * 0.2] : next;
    cb(tiltFromGravity(g[0], g[1], g[2]));
  };
  window.addEventListener('devicemotion', onMotion);
  return () => window.removeEventListener('devicemotion', onMotion);
}
