// Draws the guides on top of the camera view.
import type { Analysis, Box } from '../../lib/coach';
import type { Overlays } from '../../data/types';

const GOLD = '#e8a33d';
const LINE = 'rgba(255,255,255,0.42)';

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  o: Overlays & { coach: boolean },
  roll: number | null,
  a: Analysis | null,
  faces: Box[],
) {
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 1;
  ctx.strokeStyle = LINE;

  if (o.grid) {
    ctx.beginPath();
    for (const f of [1 / 3, 2 / 3]) {
      ctx.moveTo(Math.round(w * f) + 0.5, 0);
      ctx.lineTo(Math.round(w * f) + 0.5, h);
      ctx.moveTo(0, Math.round(h * f) + 0.5);
      ctx.lineTo(w, Math.round(h * f) + 0.5);
    }
    ctx.stroke();
    // light up the power point the subject sits on
    if (a?.wellPlaced && a.subject) {
      const s = a.subject;
      const fx = s.x + s.w / 2;
      const fy = s.y + s.h / 3;
      const px = [1 / 3, 2 / 3].reduce((p, c) => (Math.abs(c - fx) < Math.abs(p - fx) ? c : p));
      const py = [1 / 3, 2 / 3].reduce((p, c) => (Math.abs(c - fy) < Math.abs(p - fy) ? c : p));
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(px * w, py * h, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (o.center) {
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.06, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (o.level && roll != null) {
    const level = Math.abs(roll) < 1;
    const len = Math.min(w, h) * 0.32;
    const r = (-roll * Math.PI) / 180;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    // fixed reference ticks
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-len - 18, 0);
    ctx.lineTo(-len - 6, 0);
    ctx.moveTo(len + 6, 0);
    ctx.lineTo(len + 18, 0);
    ctx.stroke();
    // the moving line: it turns gold when level
    ctx.rotate(r);
    ctx.strokeStyle = level ? GOLD : 'rgba(255,255,255,0.9)';
    ctx.lineWidth = level ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.lineTo(len, 0);
    ctx.stroke();
    ctx.restore();
  }

  if (o.coach && a?.subject) {
    // soft corner brackets around the main subject
    const s = a.subject;
    const x = s.x * w;
    const y = s.y * h;
    const bw = s.w * w;
    const bh = s.h * h;
    const k = Math.min(18, bw / 4, bh / 4);
    ctx.strokeStyle = a.wellPlaced ? GOLD : 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [
      [x, y, 1, 1],
      [x + bw, y, -1, 1],
      [x, y + bh, 1, -1],
      [x + bw, y + bh, -1, -1],
    ]) {
      ctx.moveTo(cx + dx * k, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * k);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(232,163,61,0.55)';
    ctx.lineWidth = 1;
    for (const f of faces) ctx.strokeRect(f.x * w, f.y * h, f.w * w, f.h * h);
  }
}
