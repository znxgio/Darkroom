/* Phase 4: feed preview, text layers, collage maker, panoramic carousel */
'use strict';
(function () {
const App = window.App, $ = App.$, U = App.U, R = App.R;
const view = App.view;
const I = {
  feed: '<rect x="3" y="3" width="5" height="5"/><rect x="10" y="3" width="5" height="5"/><rect x="17" y="3" width="4" height="5"/><rect x="3" y="10" width="5" height="5"/><rect x="10" y="10" width="5" height="5"/><rect x="17" y="10" width="4" height="5"/><rect x="3" y="17" width="5" height="4"/><rect x="10" y="17" width="5" height="4"/>',
  collage: '<rect x="3" y="3" width="8" height="18"/><rect x="13" y="3" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/>',
  carousel: '<rect x="2" y="5" width="20" height="14"/><path d="M8.7 5v14M15.3 5v14"/>'
};
const pickFiles = (multiple) => new Promise(resolve => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = !!multiple;
  inp.addEventListener('change', () => resolve([...inp.files]));
  inp.click();
});

/* ---------- Feed preview ---------- */
async function addToFeed(blob, kind = 'export') {
  try {
    const img = await U.decodeFile(blob);
    const c = U.scaledCanvas(img, 600, 0, false);
    U.releaseImg(img);
    const t = await U.canvasBlob(c, 'image/jpeg', 0.82);
    await U.feedAdd({ id: Date.now() + Math.random(), blob: t, kind });
    const all = await U.feedAll();
    for (const old of all.slice(60)) await U.feedDel(old.id);
  } catch (e) { /* best effort */ }
}
let feedShape = U.lsGet('darkroom.feedShape', 'tall');
function feedSheet() {
  let sel = null;
  const urls = [];
  App.openSheet('Feed preview', async body => {
    const draw = async () => {
      for (const u of urls.splice(0)) URL.revokeObjectURL(u);
      body.innerHTML = '';
      const row = document.createElement('div'); row.className = 'row wrap';
      row.innerHTML = '<div class="seg"><button class="chip" type="button" data-s="tall">3:4 grid</button><button class="chip" type="button" data-s="square">Square grid</button></div><span class="grow"></span><button class="btn small" type="button" data-a="add">Add posts</button>';
      for (const b of row.querySelectorAll('[data-s]')) {
        b.setAttribute('aria-pressed', b.dataset.s === feedShape);
        b.addEventListener('click', () => { feedShape = b.dataset.s; U.lsSet('darkroom.feedShape', feedShape); draw(); });
      }
      row.querySelector('[data-a=add]').addEventListener('click', async () => {
        const fs = await pickFiles(true);
        for (const f of fs.slice(0, 30).reverse()) await addToFeed(f, 'post');
        draw();
      });
      body.appendChild(row);
      const p = document.createElement('p'); p.style.cssText = 'margin:2px auto 10px';
      p.textContent = 'Your saved photos, newest first. The dashed tile is the photo you’re editing now. Tap a tile twice to remove it.';
      body.appendChild(p);
      const g = document.createElement('div'); g.className = 'grid3' + (feedShape === 'square' ? ' square' : '');
      if (App.photo) {
        const cell = document.createElement('div'); cell.className = 'cell next';
        const c = document.createElement('canvas');
        c.width = Math.min(600, view.width); c.height = Math.round(c.width * view.height / view.width);
        c.getContext('2d').drawImage(view, 0, 0, c.width, c.height);
        cell.appendChild(c);
        const tag = document.createElement('b'); tag.textContent = 'Next'; cell.appendChild(tag);
        g.appendChild(cell);
      }
      const items = await U.feedAll();
      for (const it of items) {
        const cell = document.createElement('div'); cell.className = 'cell';
        const im = document.createElement('img'); const u = URL.createObjectURL(it.blob); urls.push(u); im.src = u; im.alt = '';
        cell.appendChild(im);
        if (sel === it.id) cell.classList.add('sel');
        cell.addEventListener('click', async () => {
          if (sel === it.id) { await U.feedDel(it.id); sel = null; } else sel = it.id;
          draw();
        });
        g.appendChild(cell);
      }
      body.appendChild(g);
      if (!items.length && !App.photo) {
        const e = document.createElement('p'); e.style.cssText = 'margin:20px auto'; e.textContent = 'Nothing here yet. Photos you save appear here.';
        body.appendChild(e);
      }
    };
    draw();
  }, () => { for (const u of urls) URL.revokeObjectURL(u); });
}

/* ---------- Text layers ---------- */
let textSel = -1;
const textCache = new Map();
const COLORS = ['#ffffff', '#1d1c1a', '#ebe4d2', '#e8a33d', '#ff6a3d', '#c23b22', '#7fa7c9', '#9bb27a'];
function textCanvas(layer, px) {
  const key = [layer.text, layer.font, layer.color, layer.shadow, Math.round(px)].join('|');
  let c = textCache.get(key);
  if (!c) {
    c = U.drawText(layer, px);
    textCache.set(key, c);
    if (textCache.size > 40) textCache.delete(textCache.keys().next().value);
  }
  return c;
}
function textOverlays(st, L, sprites, opts) {
  if (opts.editing || !st.texts.length) return;
  const S = Math.min(L.w, L.h);
  for (const t of st.texts) {
    if (!t.text) continue;
    const c = textCanvas(t, t.size * S);
    sprites.push({ canvas: c, cx: L.pads.l + t.x * L.w, cy: L.pads.t + t.y * L.h, w: c.width, h: c.height, rot: (t.rot || 0) * Math.PI / 180 });
  }
}
function buildTextUI() {
  const fl = $('fontList'); fl.innerHTML = '';
  for (const f of U.FONTS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.dataset.id = f.id;
    b.textContent = f.name; b.style.fontFamily = f.css;
    b.addEventListener('click', () => { const t = cur(); if (t) { t.font = f.id; App.commit(); App.sync(); } });
    fl.appendChild(b);
  }
  const tc = $('textColors'); tc.innerHTML = '';
  for (const col of COLORS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'swatch'; b.style.background = col; b.dataset.c = col;
    b.setAttribute('aria-label', 'Colour ' + col);
    b.addEventListener('click', () => { const t = cur(); if (t) { t.color = col; App.commit(); App.sync(); } });
    tc.appendChild(b);
  }
}
const cur = () => App.state.texts[textSel];
function syncText() {
  const ts = App.state.texts;
  if (textSel >= ts.length) textSel = ts.length - 1;
  const ll = $('textLayers'); ll.innerHTML = '';
  ts.forEach((t, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
    b.textContent = (t.text || 'Text').slice(0, 14);
    b.setAttribute('aria-pressed', i === textSel);
    b.addEventListener('click', () => { textSel = i; syncText(); placeTextSel(); });
    ll.appendChild(b);
  });
  const t = cur();
  $('textEditor').hidden = !t; $('textHint').hidden = !!t;
  if (!t) return;
  if (document.activeElement !== $('textInput')) $('textInput').value = t.text;
  for (const b of $('fontList').children) b.setAttribute('aria-pressed', b.dataset.id === t.font);
  for (const b of $('textColors').children) b.setAttribute('aria-pressed', b.dataset.c === t.color);
  $('textShadow').checked = !!t.shadow;
  $('textSize').value = Math.round(t.size * 100);
  $('textRot').value = Math.round(t.rot || 0);
}
function placeTextSel() {
  const box = $('textsel');
  const t = cur(), L = App.lastLayout;
  if (App.tab !== 'text' || !t || !L || view.hidden) { box.hidden = true; return; }
  const v = App.stageRect(), k = v.w / L.ow;
  const c = textCanvas(t, t.size * Math.min(L.w, L.h));
  const cx = v.x + (L.pads.l + t.x * L.w) * k, cy = v.y + (L.pads.t + t.y * L.h) * k;
  Object.assign(box.style, { left: cx - c.width * k / 2 + 'px', top: cy - c.height * k / 2 + 'px', width: c.width * k + 'px', height: c.height * k + 'px', transform: `rotate(${t.rot || 0}deg)` });
  box.hidden = false;
}
function textGestures() {
  const pts = new Map();
  let start = null;
  const toImg = (e) => {
    const L = App.lastLayout, v = App.stageRect(), sr = $('stage').getBoundingClientRect();
    const ox = (e.clientX - sr.left - v.x) / v.w * L.ow, oy = (e.clientY - sr.top - v.y) / v.h * L.oh;
    return [(ox - L.pads.l) / L.w, (oy - L.pads.t) / L.h];
  };
  const snapshot = () => {
    const t = cur(); if (!t) return null;
    const p = [...pts.values()];
    const s = { t: { ...t }, p0: p.map(q => [...q]) };
    if (p.length >= 2) { s.d = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]); s.a = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]); }
    return s;
  };
  view.addEventListener('pointerdown', e => {
    if (App.tab !== 'text' || !App.lastLayout) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    view.setPointerCapture(e.pointerId);
    if (pts.size === 1) {
      // pick the layer under the finger (nearest centre within its box)
      const [ix, iy] = toImg(e), L = App.lastLayout, S = Math.min(L.w, L.h);
      let best = -1, bd = Infinity;
      App.state.texts.forEach((t, i) => {
        const c = textCanvas(t, t.size * S);
        const dx = Math.abs(ix - t.x) * L.w, dy = Math.abs(iy - t.y) * L.h;
        const r = Math.max(c.width, c.height) / 2;
        if (dx < r && dy < r && dx + dy < bd) { bd = dx + dy; best = i; }
      });
      if (best >= 0 && best !== textSel) { textSel = best; syncText(); }
    }
    start = snapshot();
  });
  view.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    const t = cur(); if (!t) return;
    const L = App.lastLayout, v = App.stageRect(), k = L.ow / v.w;
    const p = [...pts.values()];
    if (p.length === 1 && start.p0.length === 1) {
      t.x = U.clamp(start.t.x + (p[0][0] - start.p0[0][0]) * k / L.w, -0.2, 1.2);
      t.y = U.clamp(start.t.y + (p[0][1] - start.p0[0][1]) * k / L.h, -0.2, 1.2);
    } else if (p.length >= 2 && start.d) {
      const d = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
      const a = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]);
      t.size = U.clamp(start.t.size * d / start.d, 0.02, 0.6);
      let r = start.t.rot + (a - start.a) * 180 / Math.PI;
      r = ((r + 540) % 360) - 180;
      t.rot = Math.abs(r) < 3 ? 0 : r;
    }
    App.renderPreview();
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    start = pts.size ? snapshot() : null;
    if (!pts.size) { App.commit(); syncText(); }
  };
  view.addEventListener('pointerup', end);
  view.addEventListener('pointercancel', end);
}

/* ---------- Collage ---------- */
const ROWSPECS = { 2: [[2], [1, 1]], 3: [[3], [1, 2], [2, 1], [1, 1, 1]], 4: [[2, 2], [1, 3], [3, 1], [1, 1, 1, 1]], 5: [[2, 3], [3, 2], [1, 4], [2, 1, 2]],
  6: [[3, 3], [2, 2, 2], [1, 2, 3], [3, 2, 1]], 7: [[3, 4], [2, 3, 2], [4, 3], [1, 3, 3]], 8: [[4, 4], [3, 2, 3], [2, 2, 2, 2], [2, 3, 3]], 9: [[3, 3, 3], [2, 3, 4], [4, 1, 4], [3, 3, 3]] };
function layouts(n) {
  const out = [];
  for (const spec of ROWSPECS[n] || []) {
    for (const transpose of [false, true]) {
      const cells = [];
      spec.forEach((cnt, r) => { for (let i = 0; i < cnt; i++) cells.push([i / cnt, r / spec.length, 1 / cnt, 1 / spec.length]); });
      const c2 = transpose ? cells.map(([x, y, w, h]) => [y, x, h, w]) : cells;
      const key = JSON.stringify(c2.map(c => c.map(v => v.toFixed(3))).sort());
      if (!out.some(o => o.key === key)) out.push({ key, cells: c2 });
    }
  }
  return out;
}
const COL_BG = { white: '#f7f5f0', cream: '#ebe4d2', black: '#111111' };
let collage = null;
function drawCover(ctx, src, x, y, w, h) {
  const sw = src.width, sh = src.height, k = Math.max(w / sw, h / sh);
  const cw = w / k, ch = h / k;
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h);
}
function renderCollage(width) {
  const o = collage;
  const asp = { '1:1': 1, '4:5': 1.25, '9:16': 16 / 9, '3:2': 2 / 3 }[o.aspect];
  const c = document.createElement('canvas');
  c.width = width; c.height = Math.round(width * asp);
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = COL_BG[o.bg]; ctx.fillRect(0, 0, c.width, c.height);
  const lay = layouts(o.imgs.length)[o.layout] || layouts(o.imgs.length)[0];
  const gap = (o.gap / 1000) * width;
  lay.cells.forEach((cell, i) => {
    const im = (o.look ? o.looked : o.imgs)[i];
    if (!im) return;
    const x = cell[0] * (c.width - gap) + gap, y = cell[1] * (c.height - gap) + gap;
    const w = cell[2] * (c.width - gap) - gap, h = cell[3] * (c.height - gap) - gap;
    drawCover(ctx, im, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  });
  return c;
}
function lookCanvas(img) {
  const st = App.normalize(JSON.parse(JSON.stringify(App.state)));
  st.crop = App.defaultState().crop; st.frame = 'none'; st.texts = []; st.stamp.on = false;
  const src = R.makeSource(img);
  App.renderTo(src, st, { noOverlays: true });
  R.freeSource(src);
  const c = document.createElement('canvas'); c.width = view.width; c.height = view.height;
  c.getContext('2d').drawImage(view, 0, 0);
  return c;
}
function collageSheet() {
  collage = { imgs: [], looked: [], layout: 0, aspect: '4:5', gap: 12, bg: 'white', look: !!App.photo };
  App.openSheet('Collage', body => {
    const draw = () => {
      body.innerHTML = '';
      const o = collage;
      const top = document.createElement('div'); top.className = 'row wrap'; top.style.justifyContent = 'center';
      top.innerHTML = `<button class="btn" type="button" data-a="pick">${o.imgs.length ? 'Choose again' : 'Choose 2–9 photos'}</button>` +
        (o.imgs.length > 1 ? '<button class="btn" type="button" data-a="shuffle">Shuffle</button><button class="btn primary" type="button" data-a="save">Save</button>' : '');
      top.querySelector('[data-a=pick]').addEventListener('click', async () => {
        const fs = (await pickFiles(true)).slice(0, 9);
        if (fs.length < 2) { if (fs.length) App.notify('Pick at least 2 photos'); return; }
        App.busy(true, 'Loading photos…');
        o.imgs = []; o.looked = []; o.layout = 0;
        for (const f of fs) {
          try { const im = await U.decodeFile(f); o.imgs.push(U.scaledCanvas(im, 1600, 0, false)); U.releaseImg(im); } catch (e) { /* skip */ }
        }
        if (App.previewSrc) o.looked = o.imgs.map(lookCanvas);
        App.renderPreview();
        App.busy(false);
        draw();
      });
      body.appendChild(top);
      if (o.imgs.length < 2) {
        const p = document.createElement('p'); p.style.cssText = 'margin:20px auto'; p.textContent = 'Pick photos to lay out in a grid. Optionally apply your current look to all of them.';
        body.appendChild(p); return;
      }
      top.querySelector('[data-a=shuffle]').addEventListener('click', () => {
        const idx = o.imgs.map((_, i) => i).sort(() => Math.random() - 0.5);
        o.imgs = idx.map(i => o.imgs[i]); if (o.looked.length) o.looked = idx.map(i => o.looked[i]);
        draw();
      });
      top.querySelector('[data-a=save]').addEventListener('click', async () => {
        App.busy(true, 'Saving…'); await U.nextFrame();
        const c = renderCollage(2160);
        const blob = await U.canvasBlob(c, 'image/jpeg', App.exportOpts.quality / 100);
        c.width = c.height = 0;
        App.busy(false);
        if (!blob) { App.notify('Saving the collage failed.'); return; }
        addToFeed(blob);
        App.deliver([new File([blob], `darkroom-collage-${Date.now()}.jpg`, { type: 'image/jpeg' })]);
      });
      const pv = renderCollage(720); pv.className = 'preview2d'; pv.style.marginTop = '10px';
      body.appendChild(pv);
      const lays = layouts(o.imgs.length);
      const f1 = document.createElement('div'); f1.className = 'field';
      f1.innerHTML = '<label>Layout</label><div class="seg"></div>';
      lays.forEach((l, i) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.setAttribute('aria-pressed', i === o.layout);
        const ic = document.createElement('canvas'); ic.width = 28; ic.height = 34; ic.style.cssText = 'display:block;width:22px;height:27px';
        const x = ic.getContext('2d'); x.fillStyle = getComputedStyle(document.body).color;
        for (const c of l.cells) x.fillRect(c[0] * 28 + 1.5, c[1] * 34 + 1.5, c[2] * 28 - 3, c[3] * 34 - 3);
        b.appendChild(ic); b.style.padding = '6px 10px';
        b.setAttribute('aria-label', 'Layout ' + (i + 1));
        b.addEventListener('click', () => { o.layout = i; draw(); });
        f1.querySelector('.seg').appendChild(b);
      });
      body.appendChild(f1);
      const f2 = document.createElement('div'); f2.className = 'field';
      f2.innerHTML = '<label>Shape</label><div class="seg" data-k="aspect"></div><label>Background</label><div class="seg" data-k="bg"></div><label>Spacing</label><input type="range" min="0" max="40" style="margin:0;width:100%">';
      const segs = { aspect: [['1:1', '1:1'], ['4:5', '4:5'], ['9:16', '9:16'], ['3:2', '3:2']], bg: [['white', 'White'], ['cream', 'Cream'], ['black', 'Black']] };
      for (const k in segs) for (const [v, n] of segs[k]) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = n; b.setAttribute('aria-pressed', o[k] === v);
        b.addEventListener('click', () => { o[k] = v; draw(); });
        f2.querySelector(`[data-k=${k}]`).appendChild(b);
      }
      const rg = f2.querySelector('input'); rg.value = o.gap;
      rg.addEventListener('input', () => { o.gap = +rg.value; const n = renderCollage(720); pv.getContext('2d').drawImage(n, 0, 0); });
      rg.addEventListener('change', draw);
      body.appendChild(f2);
      if (o.looked.length) {
        const r = document.createElement('div'); r.className = 'row';
        r.innerHTML = '<label class="toggle"><input type="checkbox"> Apply current look</label>';
        const cb = r.querySelector('input'); cb.checked = o.look;
        cb.addEventListener('change', () => { o.look = cb.checked; draw(); });
        body.appendChild(r);
      }
    };
    draw();
  }, () => { collage = null; });
}

/* ---------- Panoramic carousel ---------- */
function carouselSheet() {
  const [iw, ih] = U.imgSize(App.photo);
  const g = R.geometry(iw, ih, App.state.crop, false);
  let n = U.clamp(Math.round((g.w / g.h) / 0.8), 2, 10);
  let slides = [];
  const urls = [];
  App.openSheet('Carousel', body => {
    const draw = () => {
      body.innerHTML = '';
      const p = document.createElement('p'); p.style.cssText = 'margin:0 auto 10px';
      p.textContent = 'Splits the current edit into 4:5 slides (1080 × 1350) that line up seamlessly when swiped. Post them in order.';
      body.appendChild(p);
      const f = document.createElement('div'); f.className = 'field';
      f.innerHTML = '<label>Slides</label><div class="seg"></div>';
      for (let i = 2; i <= 10; i++) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = i; b.setAttribute('aria-pressed', i === n);
        b.addEventListener('click', () => { n = i; slides = []; draw(); });
        f.querySelector('.seg').appendChild(b);
      }
      body.appendChild(f);
      // live guide: the edit with slice lines
      const guide = document.createElement('canvas');
      const gw = 720, gh = Math.round(gw * 1350 / (1080 * n));
      guide.width = gw; guide.height = gh; guide.className = 'preview2d';
      const ctx = guide.getContext('2d');
      drawCover(ctx, view, 0, 0, gw, gh);
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
      for (let i = 1; i < n; i++) { ctx.beginPath(); ctx.moveTo(i * gw / n, 0); ctx.lineTo(i * gw / n, gh); ctx.stroke(); }
      body.appendChild(guide);
      const ar = (g.w / g.h), target = n * 0.8;
      const note = document.createElement('p'); note.style.cssText = 'margin:8px auto';
      note.textContent = ar > target * 1.02 ? 'The sides are trimmed to fit. Add a slide to keep more width.' : ar < target * 0.98 ? 'The top and bottom are trimmed to fit. Remove a slide to keep more height.' : 'This photo fits the slides almost exactly.';
      body.appendChild(note);
      const row = document.createElement('div'); row.className = 'row'; row.style.justifyContent = 'center';
      const go = document.createElement('button'); go.type = 'button'; go.className = 'btn primary';
      go.textContent = slides.length ? `Save all ${slides.length}` : `Make ${n} slides`;
      go.addEventListener('click', async () => {
        if (slides.length) { App.deliver(slides); return; }
        App.busy(true, 'Making slides…'); await U.nextFrame();
        try {
          const st = App.normalize(JSON.parse(JSON.stringify(App.state)));
          st.frame = 'none';
          const blob = await App.exportBlob(App.photo, st, { size: 'full', quality: 95 });
          const im = await U.decodeFile(blob);
          const c = document.createElement('canvas'); c.width = 1080; c.height = 1350;
          const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
          const [sw, sh] = U.imgSize(im), k = Math.max((1080 * n) / sw, 1350 / sh);
          const cw = (1080 * n) / k, chh = 1350 / k, ox = (sw - cw) / 2, oy = (sh - chh) / 2;
          for (let i = 0; i < n; i++) {
            x.drawImage(im, ox + i * cw / n, oy, cw / n, chh, 0, 0, 1080, 1350);
            const b = await U.canvasBlob(c, 'image/jpeg', App.exportOpts.quality / 100);
            slides.push(new File([b], `darkroom-slide-${i + 1}-of-${n}.jpg`, { type: 'image/jpeg' }));
          }
          U.releaseImg(im);
        } catch (e) { App.notify('Making slides failed: ' + e.message); slides = []; }
        App.renderPreview();
        App.busy(false);
        draw();
      });
      row.appendChild(go);
      body.appendChild(row);
      if (slides.length) {
        const s = document.createElement('div'); s.className = 'slides';
        for (const f2 of slides) { const im = document.createElement('img'); const u = URL.createObjectURL(f2); urls.push(u); im.src = u; im.alt = f2.name; s.appendChild(im); }
        body.appendChild(s);
      }
    };
    draw();
  }, () => { for (const u of urls) URL.revokeObjectURL(u); });
}

App.modules.push({
  init() {
    buildTextUI();
    textGestures();
    $('tabbar').querySelector('[data-tab=text]').hidden = false;
    $('addText').addEventListener('click', () => {
      const t = prompt('Text', '') ;
      if (t == null || !t.trim()) return;
      App.state.texts.push({ text: t, font: 'sans', color: '#ffffff', size: 0.08, x: 0.5, y: 0.5, rot: 0, shadow: true });
      textSel = App.state.texts.length - 1;
      App.commit(); App.sync();
    });
    $('textInput').addEventListener('input', e => { const t = cur(); if (t) { t.text = e.target.value; App.renderPreview(); } });
    $('textInput').addEventListener('change', () => { App.commit(); syncText(); });
    $('textDel').addEventListener('click', () => { if (cur()) { App.state.texts.splice(textSel, 1); textSel--; App.commit(); App.sync(); } });
    $('textShadow').addEventListener('change', e => { const t = cur(); if (t) { t.shadow = e.target.checked; App.commit(); App.sync(); } });
    $('textSize').addEventListener('input', e => { const t = cur(); if (t) { t.size = e.target.value / 100; App.renderPreview(); } });
    $('textRot').addEventListener('input', e => { const t = cur(); if (t) { t.rot = +e.target.value; App.renderPreview(); } });
    for (const id of ['textSize', 'textRot']) $(id).addEventListener('change', App.commit);
    App.menuItems.push(
      { section: 'Layouts' },
      { icon: I.feed, label: 'Feed preview', sub: 'See your saved photos as a profile grid', action: feedSheet },
      { icon: I.collage, label: 'Collage', sub: '2 to 9 photos in one frame', action: collageSheet },
      { icon: I.carousel, label: 'Panoramic carousel', sub: 'Split this edit into seamless 4:5 slides', action: carouselSheet, needsPhoto: true }
    );
  },
  sync() { syncText(); },
  overlays: textOverlays,
  afterRender: placeTextSel,
  enter(tab) { if (tab === 'text' && textSel < 0 && App.state.texts.length) textSel = 0; syncText(); },
  leave(tab) { if (tab === 'text') $('textsel').hidden = true; },
  exported(blob) { addToFeed(blob); },
  photoLoaded() { textSel = -1; }
});
})();
