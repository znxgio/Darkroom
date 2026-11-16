// Synthetic face landmarks for tests and the browser check. No photos, no real person:
// the points come from the generic canonical face mesh published with MediaPipe
// (face-canonical.json, 468 vertices, Apache-2.0), projected into a fake image.
// Iris centers (468, 473) and their ring points are added at the middle of each eye.
import canonical from './face-canonical.json' with { type: 'json' };

const RAD = Math.PI / 180;

/**
 * @param {object} o
 * @param {number} [o.W] image width (px)        @param {number} [o.H] image height (px)
 * @param {number} [o.scale] px per mesh unit   @param {number} [o.cx] @param {number} [o.cy] face center (px)
 * @param {number} [o.roll] head tilt in the image plane (deg)
 * @param {number} [o.yaw] head turn (deg)
 * @param {number|null} [o.tilt] force both canthal tilts to this angle (deg); null = mesh as is
 * @param {number} [o.jitter] random asymmetry (mesh units) applied to photo-right points
 * @param {number} [o.seed]
 * @param {Record<number,[number,number]>} [o.shift] extra (dx, dy) per index in mesh units (y up)
 */
export function syntheticFace(o = {}) {
  const W = o.W ?? 960;
  const H = o.H ?? 1280;
  const scale = o.scale ?? 30;
  const cx = o.cx ?? W / 2;
  const cy = o.cy ?? H * 0.48;
  const roll = (o.roll ?? 0) * RAD;
  const yaw = (o.yaw ?? 0) * RAD;
  let seed = o.seed ?? 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;

  const v = canonical.map(([x, y, z]) => [x, y, z]);
  if (o.tilt != null) {
    const t = Math.tan(o.tilt * RAD);
    // outer corners: 33 (photo-left), 263 (photo-right); inner: 133, 362
    v[33][1] = v[133][1] + t * (v[133][0] - v[33][0]);
    v[263][1] = v[362][1] + t * (v[263][0] - v[362][0]);
  }
  if (o.jitter) for (const p of v) if (p[0] > 0.05) { p[0] += rand() * o.jitter; p[1] += rand() * o.jitter; }
  for (const [i, d] of Object.entries(o.shift ?? {})) {
    v[i][0] += d[0];
    v[i][1] += d[1];
  }
  // Iris: center of each eye from its corners and lids, plus 4 ring points.
  const eyeCenter = (a, b, c, d) => [0, 1, 2].map((k) => (v[a][k] + v[b][k] + v[c][k] + v[d][k]) / 4);
  for (const [base, ids] of [
    [468, [33, 133, 159, 145]],
    [473, [362, 263, 386, 374]],
  ]) {
    const c = eyeCenter(...ids);
    v[base] = c;
    const r = 0.55;
    v[base + 1] = [c[0] + r, c[1], c[2]];
    v[base + 2] = [c[0], c[1] + r, c[2]];
    v[base + 3] = [c[0] - r, c[1], c[2]];
    v[base + 4] = [c[0], c[1] - r, c[2]];
  }
  return v.map(([x, y, z]) => {
    // yaw around the vertical axis, then roll in the image plane
    const xr = x * Math.cos(yaw) + z * Math.sin(yaw);
    const zr = -x * Math.sin(yaw) + z * Math.cos(yaw);
    const px = xr * scale;
    const py = -y * scale; // image y grows downward
    const rx = px * Math.cos(roll) - py * Math.sin(roll);
    const ry = px * Math.sin(roll) + py * Math.cos(roll);
    // MediaPipe z: smaller = closer to the camera, in units of image width
    return { x: (cx + rx) / W, y: (cy + ry) / H, z: (-zr * scale) / W };
  });
}
