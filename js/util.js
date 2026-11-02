/* Decoding, EXIF date, IndexedDB, and 2D-canvas drawing for overlays (date stamp, text, film edge text). */
'use strict';
(function () {
const U = window.DRU = {};

/* ---------- Decoding: blob URL → data URL → createImageBitmap ---------- */
function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error('timeout')), 20000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('failed')); };
    img.src = src;
  });
}
const readDataURL = f => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('failed'));
  r.readAsDataURL(f);
});
U.decodeFile = async function (file) {
  const errors = [];
  try { return await loadImg(URL.createObjectURL(file)); } catch (e) { errors.push('blob ' + e.message); }
  try { return await loadImg(await readDataURL(file)); } catch (e) { errors.push('data ' + e.message); }
  try { return await createImageBitmap(file); } catch (e) { errors.push('bitmap ' + (e.message || e.name)); }
  throw new Error(errors.join(', '));
};
U.releaseImg = function (img) {
  if (!img) return;
  if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  if (img.close) img.close();
};
U.imgSize = img => [img.naturalWidth || img.width, img.naturalHeight || img.height];

/* Scale into a new canvas. crop = [x, y, w, h] in source pixels (optional) */
U.scaledCanvas = function (img, maxDim, maxArea, square) {
  let [sw, sh] = U.imgSize(img), sx = 0, sy = 0;
  if (square) { const s = Math.min(sw, sh); sx = (sw - s) / 2; sy = (sh - s) / 2; sw = sh = s; }
  let k = Math.min(1, maxDim / Math.max(sw, sh));
  if (maxArea) k = Math.min(k, Math.sqrt(maxArea / (sw * sh)));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
};
U.canvasBlob = (c, type = 'image/jpeg', q = 0.92) => new Promise(r => c.toBlob(r, type, q));

/* ---------- EXIF DateTimeOriginal (JPEG or HEIC: scans for the TIFF block) ---------- */
U.readDate = async function (file) {
  try {
    const buf = new Uint8Array(await file.slice(0, Math.min(file.size, 512 * 1024)).arrayBuffer());
    for (let i = 0; i < buf.length - 14; i++) {
      if (buf[i] === 0x45 && buf[i + 1] === 0x78 && buf[i + 2] === 0x69 && buf[i + 3] === 0x66 && buf[i + 4] === 0 && buf[i + 5] === 0) {
        const t = i + 6;
        const le = buf[t] === 0x49 && buf[t + 1] === 0x49, be = buf[t] === 0x4d && buf[t + 1] === 0x4d;
        if (!le && !be) continue;
        const dv = new DataView(buf.buffer, t);
        const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
        const str = (o, n) => String.fromCharCode(...buf.subarray(t + o, t + o + n));
        const scan = (ifd, want) => {
          const n = u16(ifd);
          for (let e = 0; e < n; e++) {
            const p = ifd + 2 + e * 12;
            const tag = u16(p);
            if (want.includes(tag)) return { tag, val: u32(p + 8) };
          }
          return null;
        };
        const ifd0 = u32(4);
        let date = null;
        const exif = scan(ifd0, [0x8769]);
        if (exif) { const d = scan(exif.val, [0x9003, 0x9004]); if (d) date = str(d.val, 19); }
        if (!date) { const d = scan(ifd0, [0x0132]); if (d) date = str(d.val, 19); }
        const m = date && date.match(/^(\d{4}):(\d\d):(\d\d)/);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
        return null;
      }
    }
  } catch (e) { /* no date */ }
  return null;
};
U.stampText = function (d) {
  d = d || new Date();
  return `'${String(d.getFullYear()).slice(2)} ${d.getMonth() + 1} ${d.getDate()}`;
};

/* ---------- IndexedDB (tiny key/value wrapper) ---------- */
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('no idb')); return; }
    const r = indexedDB.open('darkroom', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('feed', { keyPath: 'id' }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const req = fn(s);
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
U.idbGet = key => tx('kv', 'readonly', s => s.get(key)).catch(() => null);
U.idbSet = (key, val) => tx('kv', 'readwrite', s => s.put(val, key)).catch(() => null);
U.idbDel = key => tx('kv', 'readwrite', s => s.delete(key)).catch(() => null);
U.feedAll = () => tx('feed', 'readonly', s => s.getAll()).then(a => (a || []).sort((x, y) => y.id - x.id)).catch(() => []);
U.feedAdd = item => tx('feed', 'readwrite', s => s.put(item)).catch(() => null);
U.feedDel = id => tx('feed', 'readwrite', s => s.delete(id)).catch(() => null);

/* ---------- localStorage helpers ---------- */
U.lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
U.lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or blocked */ } };

/* ---------- Date stamp: 7-segment LCD digits with glow ---------- */
const SEG = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc',
  '8': 'abcdefg', '9': 'abcdfg', '-': 'g', 'A': 'abcefg', 'B': 'fgcde', 'C': 'afed', 'D': 'bcdeg', 'E': 'afged', 'F': 'afge',
  'H': 'fbgec', 'L': 'fed', 'P': 'abfge', 'U': 'fbcde', 'O': 'abcdef', 'S': 'afgcd', 'Y': 'fbgcd', 'N': 'ceg', 'R': 'eg', 'T': 'fged' };
const STAMP_COLORS = [
  { core: '#ffc276', glow: 'rgba(255,110,20,0.95)' },
  { core: '#ff7a52', glow: 'rgba(255,40,10,0.95)' },
  { core: '#fff0a0', glow: 'rgba(255,190,40,0.9)' }
];
U.STAMP_COLORS = STAMP_COLORS;
U.drawStamp = function (text, height, colorIdx) {
  const h = Math.max(8, Math.round(height));
  const cw = h * 0.56, gap = h * 0.17, th = Math.max(1.5, h * 0.11), skew = 0.12;
  const chars = [...(text || '').toUpperCase()];
  let width = 0;
  const adv = ch => (ch === ' ' ? cw * 0.55 : (ch === "'" || ch === '.' || ch === ':') ? cw * 0.35 : cw) + gap;
  for (const ch of chars) width += adv(ch);
  const pad = h * 0.5;
  const c = document.createElement('canvas');
  c.width = Math.ceil(width + pad * 2 + h * skew); c.height = Math.ceil(h + pad * 2);
  const ctx = c.getContext('2d');
  const col = STAMP_COLORS[colorIdx || 0] || STAMP_COLORS[0];
  const seg = (x, y, s) => {
    const w = cw, hh = h / 2, t = th, i = t * 0.5;
    const P = {
      a: [[x + i, y], [x + w - i, y], [x + w - t, y + t], [x + t, y + t]],
      d: [[x + t, y + h - t], [x + w - t, y + h - t], [x + w - i, y + h], [x + i, y + h]],
      g: [[x + i, y + hh], [x + t, y + hh - t / 2], [x + w - t, y + hh - t / 2], [x + w - i, y + hh], [x + w - t, y + hh + t / 2], [x + t, y + hh + t / 2]],
      f: [[x, y + i], [x + t, y + t], [x + t, y + hh - t / 2], [x, y + hh - i]],
      e: [[x, y + hh + i], [x + t, y + hh + t / 2], [x + t, y + h - t], [x, y + h - i]],
      b: [[x + w, y + i], [x + w, y + hh - i], [x + w - t, y + hh - t / 2], [x + w - t, y + t]],
      c: [[x + w, y + hh + i], [x + w, y + h - i], [x + w - t, y + h - t], [x + w - t, y + hh + t / 2]]
    };
    for (const k of s) {
      const pts = P[k]; if (!pts) continue;
      ctx.beginPath();
      pts.forEach(([px, py], j) => { const sx = px + (y + h - py) * skew; j ? ctx.lineTo(sx, py) : ctx.moveTo(sx, py); });
      ctx.closePath(); ctx.fill();
    }
  };
  const pass = (blur, color, alpha) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color; ctx.shadowColor = col.glow; ctx.shadowBlur = blur;
    let x = pad;
    const y = pad;
    for (const ch of chars) {
      if (SEG[ch]) seg(x, y, SEG[ch]);
      else if (ch === "'") { ctx.beginPath(); ctx.rect(x + cw * 0.12 + h * skew, y, th, h * 0.28); ctx.fill(); }
      else if (ch === '.') { ctx.beginPath(); ctx.rect(x + cw * 0.05, y + h - th, th, th); ctx.fill(); }
      else if (ch === ':') { ctx.beginPath(); ctx.rect(x + cw * 0.05 + h * skew * 0.7, y + h * 0.25, th, th); ctx.rect(x + cw * 0.05 + h * skew * 0.3, y + h * 0.68, th, th); ctx.fill(); }
      else if (ch !== ' ') { ctx.font = `bold ${h}px ui-monospace, Menlo, Courier, monospace`; ctx.textBaseline = 'top'; ctx.fillText(ch, x, y); }
      x += adv(ch);
    }
    ctx.restore();
  };
  pass(h * 0.45, col.glow, 0.55);
  pass(h * 0.18, col.core, 0.95);
  return c;
};

/* ---------- Text layers ---------- */
U.FONTS = [
  { id: 'sans', name: 'Sans', css: '-apple-system, "Helvetica Neue", Arial, sans-serif', weight: 600 },
  { id: 'serif', name: 'Serif', css: 'ui-serif, "Iowan Old Style", Georgia, serif', weight: 400 },
  { id: 'didot', name: 'Didot', css: 'Didot, "Bodoni 72", "Times New Roman", serif', weight: 400 },
  { id: 'type', name: 'Typewriter', css: '"American Typewriter", "Courier New", Courier, serif', weight: 400 },
  { id: 'mono', name: 'Mono', css: 'ui-monospace, "SF Mono", Menlo, Courier, monospace', weight: 500 },
  { id: 'futura', name: 'Futura', css: 'Futura, "Avenir Next", "Trebuchet MS", sans-serif', weight: 500 },
  { id: 'script', name: 'Script', css: '"Snell Roundhand", "Brush Script MT", "Segoe Script", cursive', weight: 400 },
  { id: 'marker', name: 'Marker', css: '"Marker Felt", "Chalkboard SE", "Comic Sans MS", fantasy', weight: 400 }
];
U.drawText = function (layer, fontPx) {
  const f = U.FONTS.find(x => x.id === layer.font) || U.FONTS[0];
  const px = Math.max(6, Math.round(fontPx));
  const lines = String(layer.text || '').split('\n');
  const c = document.createElement('canvas');
  let ctx = c.getContext('2d');
  const font = `${f.weight} ${px}px ${f.css}`;
  ctx.font = font;
  const lh = px * 1.18;
  const tw = Math.max(1, ...lines.map(l => ctx.measureText(l).width));
  const pad = Math.ceil(px * 0.3);
  c.width = Math.ceil(tw + pad * 2); c.height = Math.ceil(lh * lines.length + pad * 2);
  ctx = c.getContext('2d');
  ctx.font = font; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  if (layer.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = px * 0.15; ctx.shadowOffsetY = px * 0.04; }
  ctx.fillStyle = layer.color || '#ffffff';
  lines.forEach((l, i) => ctx.fillText(l, c.width / 2, pad + lh * (i + 0.5)));
  return c;
};

/* ---------- Film rebate edge text ---------- */
U.drawEdgeText = function (text, height, length) {
  const h = Math.max(6, Math.round(height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(length)); c.height = Math.ceil(h * 1.4);
  const ctx = c.getContext('2d');
  ctx.font = `700 ${h}px ui-monospace, Menlo, Courier, monospace`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8a33d';
  ctx.globalAlpha = 0.92;
  for (const [t, x] of text) ctx.fillText(t, x * c.width, c.height / 2);
  return c;
};

U.nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
U.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
})();
