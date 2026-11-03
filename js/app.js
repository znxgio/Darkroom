/* Darkroom app core: edit state, preview rendering, presets & collections, favourites, save. */
'use strict';
(function () {
const $ = id => document.getElementById(id);
const P = window.DRPresets, R = window.DRGL, U = window.DRU;
const view = $('view');

const App = window.App = {
  $, P, R, U, view,
  photo: null,          // decoded <img> or ImageBitmap
  photoFile: null,      // original Blob (for drafts)
  photoDate: null,
  previewSrc: null,
  tab: 'presets',
  modules: [],          // panels/tools register { init, sync, enter, leave, overlays }
  editing: false,       // crop editing mode
  split: null,          // before/after divider (0..1) or null
  holding: false,
  thumbs: {},           // id -> canvas (144px)
  exportOpts: U.lsGet('darkroom.export', { size: 'full', quality: 92 })
};

App.defaultState = () => ({
  v: 1,
  preset: 'tvset', strength: 1, look: null,
  fx: {
    seed: 1, grain: { amount: 0, size: 0.4 }, dust: { amount: 0, style: 0 }, leak: { amount: 0, style: 0, pos: 5 },
    burn: { amount: 0, pos: 0 }, halation: { amount: 0 }, bloom: { amount: 0 }, vhs: { amount: 0 },
    rgb: { amount: 0, style: 0 }, blur: { amount: 0, style: 0 }, fisheye: { amount: 0 }, prism: { amount: 0 },
    double: { amount: 0, style: 0 }, texture: { amount: 0, style: 0 }
  },
  adjust: { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temp: 0, tint: 0,
    saturation: 0, vibrance: 0, fade: 0, clarity: 0, sharpen: 0, vignette: 0 },
  crop: { aspect: 'free', rect: [0, 0, 1, 1], rot: 0, flipH: false, flipV: false, straighten: 0 },
  frame: 'preset',
  stamp: { on: false, text: '', auto: true, color: 0 },
  texts: []
});
/* Deep-merge so older saved states pick up new fields */
App.normalize = function (s) {
  const d = App.defaultState();
  if (!s) return d;
  const out = { ...d, ...s };
  out.fx = { ...d.fx };
  for (const k in d.fx) if (k !== 'seed') out.fx[k] = { ...d.fx[k], ...((s.fx || {})[k] || {}) };
  if (s.fx && s.fx.seed) out.fx.seed = s.fx.seed;
  out.adjust = { ...d.adjust, ...(s.adjust || {}) };
  out.crop = { ...d.crop, ...(s.crop || {}) };
  out.stamp = { ...d.stamp, ...(s.stamp || {}) };
  out.texts = Array.isArray(s.texts) ? s.texts : [];
  return out;
};
App.state = App.defaultState();

/* ---------- Custom looks (saved presets) are resolved like presets ---------- */
App.looks = U.lsGet('darkroom.looks', []);
App.saveLooks = () => U.lsSet('darkroom.looks', App.looks);
App.favs = U.lsGet('darkroom.favs', []);
App.saveFavs = () => U.lsSet('darkroom.favs', App.favs);
App.preset = (st = App.state) => P.get(st.preset);

/* ---------- Notices / busy ---------- */
let noticeTimer;
App.notify = function (msg, ms = 5000) {
  const n = $('notice'); n.textContent = msg; n.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { n.hidden = true; }, ms);
};
App.busy = function (on, text) {
  $('spinner').hidden = !on; $('saveBtn').disabled = on;
  $('spinnerText').textContent = text || '';
};

/* ---------- Overlays (date stamp, text layers, film edge text) ---------- */
App.overlays = function (st, layout, opts = {}) {
  const sprites = [];
  for (const m of App.modules) if (m.overlays) m.overlays(st, layout, sprites, opts);
  return sprites;
};

/* Render state st from src to the view canvas */
App.renderTo = function (src, st, o = {}) {
  return R.render(src, st, App.preset(st), {
    editing: o.editing, split: o.split, original: o.original, lean: o.lean,
    overlays: o.noOverlays ? null : (layout => App.overlays(st, layout, o))
  });
};

let pending = false;
App.renderPreview = function () {
  if (!App.previewSrc || pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (!App.previewSrc) return;
    App.renderTo(App.previewSrc, App.state, { editing: App.editing, split: App.split, original: App.holding, preview: true });
    for (const m of App.modules) if (m.afterRender) m.afterRender();
  });
};

/* ---------- Edit history + change notifications ---------- */
App.history = { stack: [], index: -1 };
App.commit = function () {
  const snap = JSON.stringify(App.state);
  const h = App.history;
  if (h.stack[h.index] === snap) return;
  h.stack.splice(h.index + 1);
  h.stack.push(snap);
  if (h.stack.length > 80) h.stack.shift();
  h.index = h.stack.length - 1;
  for (const m of App.modules) if (m.committed) m.committed();
};
App.resetHistory = function () { App.history = { stack: [], index: -1 }; App.commit(); };
App.sync = function () { for (const m of App.modules) if (m.sync) m.sync(); App.renderPreview(); };

/* ---------- Thumbnails ---------- */
let thumbSrc = null;
App.thumbCanvas = function (id) {
  let c = App.thumbs[id];
  if (!c) { c = document.createElement('canvas'); c.width = c.height = 144; App.thumbs[id] = c; }
  return c;
};
App.renderThumb = function (id, st) {
  if (!thumbSrc) return;
  App.renderTo(thumbSrc, st, { noOverlays: true });
  App.thumbCanvas(id).getContext('2d').drawImage(view, 0, 0, 144, 144);
};
App.presetThumbState = id => ({ ...App.defaultState(), preset: id, frame: 'preset' });
App.renderAllThumbs = function () {
  if (!App.photo) return;
  R.freeSource(thumbSrc);
  thumbSrc = R.makeSource(U.scaledCanvas(App.photo, 160, 0, true));
  for (const p of P.PRESETS) App.renderThumb(p.id, App.presetThumbState(p.id));
  for (const m of App.modules) if (m.thumbs) m.thumbs();
  App.renderPreview();
  App.paintStrip();
};

/* ---------- Collections + strip ---------- */
let collection = U.lsGet('darkroom.collection', 'film');
App.collections = function () {
  const list = [{ id: 'fav', name: 'Favorites' }, ...P.COLLECTIONS];
  for (const m of App.modules) if (m.collections) list.push(...m.collections());
  return list;
};
App.itemsFor = function (cid) {
  if (cid === 'fav') return App.favs.map(id => App.itemById(id)).filter(Boolean);
  for (const m of App.modules) if (m.items) { const r = m.items(cid); if (r) return r; }
  return P.PRESETS.filter(p => p.c === cid).map(p => ({ id: p.id, name: p.name, kind: 'preset' }));
};
App.itemById = function (id) {
  const p = P.BY_ID[id];
  if (p) return { id: p.id, name: p.name, kind: 'preset' };
  for (const m of App.modules) if (m.itemById) { const r = m.itemById(id); if (r) return r; }
  return null;
};
App.activeId = () => App.state.look || App.state.preset;

function buildCollections() {
  const bar = $('collections');
  bar.innerHTML = '';
  const cols = App.collections();
  if (!cols.some(c => c.id === collection)) collection = 'film';
  for (const c of cols) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', c.id === collection);
    b.textContent = c.name;
    b.addEventListener('click', () => { collection = c.id; U.lsSet('darkroom.collection', c.id); buildCollections(); buildStrip(); $('strip').scrollLeft = 0; });
    bar.appendChild(b);
  }
}
App.buildCollections = buildCollections;

function buildStrip() {
  const strip = $('strip');
  strip.innerHTML = '';
  const items = App.itemsFor(collection);
  if (!items.length) {
    const h = document.createElement('p'); h.className = 'hint';
    h.textContent = collection === 'fav' ? 'Tap the star next to a preset name to keep it here.'
      : 'Save the current look from the menu (⋯ › Save look) and it shows up here.';
    strip.appendChild(h);
    return;
  }
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'frame'; b.dataset.id = it.id;
    b.innerHTML = '<span class="holes"><i></i><i></i><i></i><i></i></span><canvas width="144" height="144"></canvas><b></b><span class="holes"><i></i><i></i><i></i><i></i></span>';
    b.querySelector('b').textContent = it.name;
    b.setAttribute('aria-label', it.name);
    if (App.favs.includes(it.id) && collection !== 'fav') { const s = document.createElement('span'); s.className = 'fav'; s.textContent = '★'; b.appendChild(s); }
    b.addEventListener('click', () => App.selectItem(it.id));
    strip.appendChild(b);
  }
  App.paintStrip();
}
App.buildStrip = buildStrip;
App.paintStrip = function () {
  const active = App.activeId();
  for (const b of $('strip').querySelectorAll('.frame')) {
    b.setAttribute('aria-pressed', b.dataset.id === active);
    const t = App.thumbs[b.dataset.id];
    if (t) b.querySelector('canvas').getContext('2d').drawImage(t, 0, 0);
  }
};

App.selectItem = function (id) {
  const it = App.itemById(id);
  if (!it) return;
  if (it.kind === 'preset') { App.state.preset = id; App.state.look = null; }
  else for (const m of App.modules) if (m.applyItem) m.applyItem(it);
  App.commit();
  App.sync();
};

function syncPresets() {
  const id = App.activeId();
  const it = App.itemById(id);
  $('presetName').textContent = it ? it.name : App.preset().name;
  $('favBtn').setAttribute('aria-pressed', App.favs.includes(id));
  const v = Math.round(App.state.strength * 100);
  $('strength').value = v;
  $('strengthLabel').textContent = `Strength ${v}%`;
  App.paintStrip();
}
App.toggleFav = function (id = App.activeId()) {
  const i = App.favs.indexOf(id);
  if (i >= 0) App.favs.splice(i, 1); else App.favs.push(id);
  App.saveFavs();
  syncPresets();
  buildStrip();
  App.notify(i >= 0 ? 'Removed from Favorites' : 'Added to Favorites', 1800);
};

/* ---------- Tabs ---------- */
App.setTab = function (name) {
  if (App.tab === name) return;
  const prev = App.tab;
  for (const m of App.modules) if (m.leave) m.leave(prev, name);
  App.tab = name;
  for (const b of $('tabbar').querySelectorAll('button')) b.setAttribute('aria-selected', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.id !== 'pane-' + name;
  for (const m of App.modules) if (m.enter) m.enter(name, prev);
  App.renderPreview();
};

/* ---------- Opening photos ---------- */
App.previewDim = () => Math.min(2400, Math.round(Math.max(innerWidth, innerHeight) * Math.min(window.devicePixelRatio || 1, 2) * 0.9));

const stage = (s) => { App.loadStage = s; $('spinnerText').textContent = s + '\u2026'; };
App.loadPhoto = async function (file, st) {
  stage('Decoding photo');
  const img = await U.decodeFile(file);
  stage('Reading date');
  const date = await U.readDate(file);
  U.releaseImg(App.photo);
  App.photo = img;
  App.photoFile = file;
  App.photoDate = date || (file.lastModified ? new Date(file.lastModified) : new Date());
  stage('Preparing preview');
  await U.nextFrame();
  R.freeSource(App.previewSrc);
  App.previewSrc = R.makeSource(U.scaledCanvas(img, App.previewDim(), 0, false));
  const prevPreset = App.state.preset, prevLook = App.state.look;
  App.state = App.normalize(st || null);
  if (!st) {
    // keep the last used look when opening a new photo, like a camera roll workflow
    App.state.preset = prevPreset; App.state.look = prevLook;
  }
  if (App.state.stamp.auto) App.state.stamp.text = U.stampText(App.photoDate);
  for (const m of App.modules) if (m.photoLoaded) {
    try { await U.timeout(Promise.resolve(m.photoLoaded(!!st)), 4000, 'setup'); } catch (e) { /* non-essential (drafts etc.) */ }
  }
  $('emptyWrap').hidden = true;
  view.hidden = false;
  $('panel').hidden = false; $('tabbar').hidden = false;
  $('saveBtn').hidden = false;
  stage('Rendering presets');
  try { App.renderAllThumbs(); } catch (e) { App.notify('Preset thumbnails failed: ' + e.message, 8000); }
  App.resetHistory();
  App.sync();
};

let loading = false, handled = null;
async function openFile(file) {
  if (!file || loading || file === handled) return;
  handled = file; loading = true;
  App.busy(true, 'Opening\u2026');
  App.loadStage = 'Opening';
  const watchdog = setTimeout(() => App.notify('Still working: ' + App.loadStage + '\u2026 (' + (file.type || 'unknown type') + ', ' + (file.size / 1e6).toFixed(1) + ' MB)', 15000), 12000);
  try {
    await App.loadPhoto(file);
  } catch (e) {
    App.notify('That photo couldn\u2019t be opened at \u201c' + App.loadStage + '\u201d. Details: ' + (e && e.message ? e.message : e) + ' | ' + (file.type || 'unknown type') + ', ' + (file.size / 1e6).toFixed(1) + ' MB', 15000);
  } finally {
    clearTimeout(watchdog);
    loading = false;
    App.busy(false);
    try { $('file').value = ''; } catch (e) { /* ignore */ }
  }
}
App.pickPhoto = () => $('file').click();

/* ---------- Export ---------- */
const EXPORT_SIZES = { full: 0, '4k': 3840, '2k': 2048, ig: 1080 };
App.EXPORT_SIZES = EXPORT_SIZES;

/* Renders img with st at export size into the view canvas. Returns a Blob or null. */
App.exportBlob = async function (img, st, opts = App.exportOpts) {
  const [iw, ih] = U.imgSize(img);
  const maxTex = R.maxSize();
  const p = App.preset(st);
  // dimensions at natural scale, to work out how big the source must be
  const g1 = R.geometry(iw, ih, st.crop, false);
  const pads1 = R.framePads(st.frame, p, g1.w, g1.h);
  const ow1 = g1.w + pads1.l + pads1.r, oh1 = g1.h + pads1.t + pads1.b;
  const cropArea = Math.max(0.02, st.crop.rect[2] * st.crop.rect[3]);
  let k = 1;
  const want = EXPORT_SIZES[opts.size] || 0;
  if (opts.size === 'ig') k = want / ow1;
  else if (want) k = want / Math.max(ow1, oh1);
  k = Math.min(k, 2);
  let area = 12e6; // iPhone Safari's canvas memory ceiling sits around 16 MP
  let blob = null;
  for (let attempt = 0; attempt < 4 && !blob; attempt++, area *= 0.6) {
    // output area cap → source scale
    let kk = Math.min(k, Math.sqrt(area / (ow1 * oh1)));
    const srcArea = Math.min(iw * ih * kk * kk, area / cropArea, area * 1.6);
    kk = Math.min(kk, Math.sqrt(srcArea / (iw * ih)));
    const frameRoom = Math.max(ow1 / g1.w, oh1 / g1.h);
    kk = Math.min(kk, maxTex / Math.max(iw, ih), maxTex / (Math.max(g1.w, g1.h) * frameRoom));
    let cw = Math.max(1, Math.round(iw * kk)), ch = Math.max(1, Math.round(ih * kk));
    if (opts.size === 'ig' && attempt === 0) {
      // nudge the source size so rounding lands on exactly 1080 px wide
      for (let n = 0; n < 6; n++) {
        const g = R.geometry(cw, ch, st.crop, false), pd = R.framePads(st.frame, p, g.w, g.h);
        const ow = g.w + pd.l + pd.r;
        if (ow === want) break;
        const k2 = kk * (1 + (want - ow) / ow) + (want - ow) * 0.25 / iw;
        kk = k2; cw = Math.max(1, Math.round(iw * kk)); ch = Math.max(1, Math.round(ih * kk));
      }
    }
    let src = null;
    try {
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      src = R.makeSource(c, true);
      if (App.renderTo(src, st, { lean: true, export: true })) {
        blob = await new Promise(r => view.toBlob(r, 'image/jpeg', (opts.quality || 92) / 100));
        if (blob) App.lastThumb = U.scaledCanvas(view, 600, 0, false);
      }
    } catch (e) { /* retry smaller */ }
    R.freeSource(src);
  }
  return blob;
};

App.save = async function () {
  if (!App.photo) return;
  App.busy(true, 'Developing…');
  await U.nextFrame();
  let blob = null;
  try { blob = await App.exportBlob(App.photo, App.state); } catch (e) { /* below */ }
  App.renderPreview();
  App.busy(false);
  if (!blob) { App.notify('The full-size render failed. Close other tabs and try again.'); return; }
  for (const m of App.modules) if (m.exported) m.exported(blob, App.lastThumb);
  App.deliver([new File([blob], `darkroom-${App.state.preset}-${Date.now()}.jpg`, { type: 'image/jpeg' })]);
};

/* Share sheet (Save to Photos) with a long-press fallback page */
App.deliver = async function (files, fromGesture = true) {
  if (fromGesture && navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  App.showResults(files);
};
App.showResults = function (files) {
  const body = $('resultBody');
  for (const u of body.querySelectorAll('img')) URL.revokeObjectURL(u.src);
  body.innerHTML = '';
  $('resultTitle').textContent = files.length > 1 ? `${files.length} photos ready` : 'Photo ready';
  const wrap = document.createElement('div'); wrap.className = 'center';
  if (files.length === 1) {
    const url = URL.createObjectURL(files[0]);
    wrap.innerHTML = `<img class="result" alt="Edited photo"><p>Press and hold the photo, then tap Save to Photos.</p>`;
    wrap.querySelector('img').src = url;
    const a = document.createElement('a'); a.href = url; a.download = files[0].name; a.textContent = 'Download';
    wrap.appendChild(a);
  } else {
    wrap.innerHTML = `<p>Press and hold each photo, then tap Save to Photos.</p>`;
    const g = document.createElement('div'); g.className = 'thumbs'; g.style.width = '100%';
    files.forEach((f, i) => {
      const t = document.createElement('div'); t.className = 't';
      const im = document.createElement('img'); im.src = URL.createObjectURL(f); im.alt = `Photo ${i + 1}`;
      t.appendChild(im); g.appendChild(t);
    });
    wrap.appendChild(g);
  }
  if (navigator.canShare && navigator.canShare({ files })) {
    const b = document.createElement('button'); b.className = 'btn primary'; b.type = 'button';
    b.textContent = files.length > 1 ? `Save all ${files.length}` : 'Share';
    b.addEventListener('click', () => navigator.share({ files }).catch(() => {}));
    wrap.appendChild(b);
  }
  body.appendChild(wrap);
  $('resultSheet').hidden = false;
};

/* ---------- Generic sheet ---------- */
App.openSheet = function (title, build, onClose) {
  $('sheetTitle').textContent = title;
  const body = $('sheetBody');
  body.innerHTML = '';
  $('sheetBack').hidden = true;
  App.sheetClose = onClose || null;
  build(body);
  $('sheet').hidden = false;
  body.scrollTop = 0;
};
App.closeSheet = function () {
  $('sheet').hidden = true;
  const f = App.sheetClose; App.sheetClose = null;
  $('sheetBody').innerHTML = '';
  if (f) f();
};
App.menuItems = []; // { icon, label, sub, action, needsPhoto }
const ICON = {
  open: '<path d="M4 7h5l2 2h9v10H4z"/>'
};
App.icon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
function openMenu() {
  App.openSheet('Darkroom', body => {
    const menu = document.createElement('div'); menu.className = 'menu';
    const items = [{ icon: ICON.open, label: 'Open photo', sub: 'Start a new edit', action: () => App.pickPhoto() }, ...App.menuItems];
    for (const it of items) {
      if (it.needsPhoto && !App.photo) continue;
      if (it.section) { const h = document.createElement('h3'); h.textContent = it.section; menu.appendChild(h); continue; }
      const b = document.createElement('button'); b.type = 'button';
      b.innerHTML = App.icon(it.icon || '') + '<span></span>';
      b.querySelector('span').innerHTML = `${it.label}<small></small>`;
      b.querySelector('small').textContent = it.sub || '';
      b.addEventListener('click', () => { App.closeSheet(); it.action(); });
      menu.appendChild(b);
    }
    body.appendChild(menu);
  });
}

/* ---------- Wiring ---------- */
App.start = function () {
  if (!R.init(view)) {
    $('stage').innerHTML = '<p class="error">This browser can’t run Darkroom because WebGL is turned off or unavailable.</p>';
    $('openBtn').hidden = true;
    return;
  }
  for (const m of App.modules) if (m.init) m.init();
  buildCollections();
  buildStrip();
  // Some iOS web views fire only one of these, so listen for both, plus a focus fallback.
  const fromInput = () => { const f = $('file').files && $('file').files[0]; if (f) openFile(f); };
  $('file').addEventListener('change', fromInput);
  $('file').addEventListener('input', fromInput);
  window.addEventListener('focus', () => setTimeout(fromInput, 300));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(fromInput, 300); });
  for (const id of ['openBtn', 'emptyBtn']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); App.pickPhoto(); } });
  $('saveBtn').addEventListener('click', () => (App.onSave ? App.onSave() : App.save()));
  $('moreBtn').addEventListener('click', openMenu);
  $('sheetClose').addEventListener('click', App.closeSheet);
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => {
    const s = b.closest('.sheet'); s.hidden = true;
    for (const u of s.querySelectorAll('img')) if (u.src.startsWith('blob:')) URL.revokeObjectURL(u.src);
  });
  $('favBtn').addEventListener('click', () => App.toggleFav());
  $('strength').addEventListener('input', e => {
    App.state.strength = e.target.value / 100;
    $('strengthLabel').textContent = `Strength ${e.target.value}%`;
    App.renderPreview();
  });
  $('strength').addEventListener('change', App.commit);
  for (const b of $('tabbar').querySelectorAll('button')) b.addEventListener('click', () => App.setTab(b.dataset.tab));

  // Long-press a preset frame to favourite it
  let lp = null, lpFired = false;
  $('strip').addEventListener('pointerdown', e => {
    const f = e.target.closest('.frame'); if (!f) return;
    lpFired = false;
    const x0 = e.clientX;
    lp = setTimeout(() => { lpFired = true; App.toggleFav(f.dataset.id); }, 550);
    const cancel = ev => { if (!ev || Math.abs(ev.clientX - x0) > 8 || ev.type !== 'pointermove') { clearTimeout(lp); off(); } };
    const off = () => { $('strip').removeEventListener('pointermove', cancel); window.removeEventListener('pointerup', cancel); window.removeEventListener('pointercancel', cancel); };
    $('strip').addEventListener('pointermove', cancel); window.addEventListener('pointerup', cancel); window.addEventListener('pointercancel', cancel);
  });
  $('strip').addEventListener('click', e => { if (lpFired) { e.stopPropagation(); e.preventDefault(); lpFired = false; } }, true);
  $('strip').addEventListener('contextmenu', e => e.preventDefault());

  // Press and hold the photo to compare with the original
  view.addEventListener('pointerdown', e => {
    if (!App.previewSrc || App.editing || App.split != null || App.tab === 'text') return;
    App.holding = true; $('origTag').hidden = false; App.renderPreview();
  });
  const release = () => { if (!App.holding) return; App.holding = false; $('origTag').hidden = true; App.renderPreview(); };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  view.addEventListener('contextmenu', e => e.preventDefault());
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { for (const m of App.modules) if (m.afterRender) m.afterRender(); }, 150); });

  App.modules.push({ sync: syncPresets });
  syncPresets();
};
})();
