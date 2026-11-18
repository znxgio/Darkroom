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
  layer: { preset: null, strength: 0.6 },
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
  out.layer = { ...d.layer, ...(s.layer || {}) };
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
    layerPreset: st.layer && st.layer.preset ? P.get(st.layer.preset) : null,
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
/* filled slider tracks: keep --fill in step with every range input */
App.updateRanges = function () {
  for (const r of document.querySelectorAll('input[type=range]')) {
    const min = +r.min || 0, max = +r.max || 100;
    r.style.setProperty('--fill', ((r.value - min) / (max - min)) * 100 + '%');
  }
};
document.addEventListener('input', e => {
  const r = e.target;
  if (r.type === 'range') { const min = +r.min || 0, max = +r.max || 100; r.style.setProperty('--fill', ((r.value - min) / (max - min)) * 100 + '%'); }
});
App.sync = function () { for (const m of App.modules) if (m.sync) m.sync(); App.renderPreview(); App.updateRanges(); };

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
/* In layer mode a thumbnail previews the current base filter with that preset stacked on top */
App.layerMode = false;
App.presetThumbState = id => App.layerMode
  ? { ...App.defaultState(), preset: App.state.preset, layer: { preset: id, strength: 1 }, frame: 'preset' }
  : { ...App.defaultState(), preset: id, frame: 'preset' };
App.invalidatePresetThumbs = () => { for (const p of P.PRESETS) staleThumbs.add(p.id); };
/* Preset thumbnails are rendered lazily, only for the collection on screen, to keep loading light on iPhone */
const staleThumbs = new Set();
App.renderAllThumbs = function () {
  if (!App.photo) return;
  R.freeSource(thumbSrc);
  thumbSrc = R.makeSource(U.scaledCanvas(App.photo, 160, 0, true));
  for (const p of P.PRESETS) staleThumbs.add(p.id);
  for (const m of App.modules) if (m.thumbs) m.thumbs();
  App.paintStrip();
  App.renderPreview();
};

/* ---------- Collections + strip ---------- */
let collection = U.lsGet('darkroom.collection', 'popular');
App.collections = function () {
  const list = [{ id: 'fav', name: 'Favorites' }, ...P.COLLECTIONS];
  for (const m of App.modules) if (m.collections) list.push(...m.collections());
  return list;
};
App.itemsFor = function (cid) {
  if (cid === 'fav') return App.favs.map(id => App.itemById(id)).filter(Boolean);
  for (const m of App.modules) if (m.items) { const r = m.items(cid); if (r) return r; }
  return P.itemsIn(cid).map(p => ({ id: p.id, name: p.name, kind: 'preset' }));
};
App.itemById = function (id) {
  const p = P.BY_ID[id];
  if (p) return { id: p.id, name: p.name, kind: 'preset' };
  for (const m of App.modules) if (m.itemById) { const r = m.itemById(id); if (r) return r; }
  return null;
};
App.activeId = () => App.layerMode ? App.state.layer.preset : (App.state.look || App.state.preset);

function buildCollections() {
  const bar = $('collections');
  bar.innerHTML = '';
  const cols = App.collections();
  if (!cols.some(c => c.id === collection)) collection = 'popular';
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
    const lab = b.querySelector('b');
    lab.textContent = it.name;
    const col = App.labelColor(it.id);
    if (col) { lab.style.background = col.bg; lab.style.color = col.fg; }
    b.setAttribute('aria-label', it.name);
    if (App.favs.includes(it.id) && collection !== 'fav') { const s = document.createElement('span'); s.className = 'fav'; s.textContent = '★'; b.appendChild(s); }
    b.addEventListener('click', () => {
      if (App.activeId() === it.id && App.itemById(it.id).kind === 'preset') App.openStrength();
      else App.selectItem(it.id);
    });
    strip.appendChild(b);
  }
  App.paintStrip();
  const on = strip.querySelector('.frame[aria-pressed=true]');
  if (on) requestAnimationFrame(() => strip.scrollTo({ left: Math.max(0, on.offsetLeft - strip.clientWidth / 2 + on.offsetWidth / 2), behavior: 'smooth' }));
}
App.buildStrip = buildStrip;
App.paintStrip = function () {
  const active = App.activeId();
  let rendered = false;
  for (const b of $('strip').querySelectorAll('.frame')) {
    b.setAttribute('aria-pressed', b.dataset.id === active);
    const id = b.dataset.id;
    if (staleThumbs.has(id) && thumbSrc) { staleThumbs.delete(id); App.renderThumb(id, App.presetThumbState(id)); rendered = true; }
    const t = App.thumbs[id];
    if (t) b.querySelector('canvas').getContext('2d').drawImage(t, 0, 0);
  }
  if (rendered) App.renderPreview();
};

App.selectItem = function (id) {
  const it = App.itemById(id);
  if (!it) return;
  if (it.kind === 'preset' && App.layerMode) {
    if (id === App.state.preset) { App.notify('That\u2019s already the base filter', 1800); return; }
    App.state.layer.preset = id;
    if (!App.state.layer.strength) App.state.layer.strength = 0.6;
  } else if (it.kind === 'preset') {
    App.state.preset = id; App.state.look = null;
    App.state.strength = P.defaultStrength(id);
    if (App.state.layer.preset === id) App.state.layer.preset = null;
  } else {
    App.setLayerMode(false);
    for (const m of App.modules) if (m.applyItem) m.applyItem(it);
  }
  App.commit();
  App.sync();
};

function syncPresets() {
  const id = App.activeId();
  const it = id && App.itemById(id);
  const L = App.layerMode, lay = App.state.layer;
  $('presetName').textContent = it ? it.name : (L ? 'Pick a layer' : App.preset().name);
  $('favBtn').hidden = !it;
  $('favBtn').setAttribute('aria-pressed', !!id && App.favs.includes(id));
  const v = Math.round((L ? lay.strength : App.state.strength) * 100);
  $('strength').value = v;
  $('strengthValue').textContent = v;
  $('strengthLabel').disabled = L && !lay.preset;
  $('strengthLabel').textContent = `${v}%`;
  $('modeBase').setAttribute('aria-selected', !L);
  $('modeLayer').setAttribute('aria-selected', L);
  $('modeLayer').textContent = lay.preset ? 'Layer' : '+ Layer';
  $('layerOff').hidden = !lay.preset;
  App.paintStrip();
}
/* Tap the selected filter again (or the %) for a strength panel with Cancel / Apply */
let strengthBefore = null;
App.openStrength = function () {
  if (App.layerMode && !App.state.layer.preset) return;
  strengthBefore = App.layerMode ? App.state.layer.strength : App.state.strength;
  $('strengthWhat').textContent = App.layerMode ? 'Layer strength' : 'Filter strength';
  $('browse').hidden = true; $('strengthPanel').hidden = false;
  syncPresets();
};
App.closeStrength = function (apply) {
  if ($('strengthPanel').hidden) return;
  if (!apply && strengthBefore != null) {
    if (App.layerMode) App.state.layer.strength = strengthBefore; else App.state.strength = strengthBefore;
    App.renderPreview();
  }
  strengthBefore = null;
  $('strengthPanel').hidden = true; $('browse').hidden = false;
  if (apply) App.commit();
  syncPresets();
};

/* Each filter gets a fixed colour label, measured from what it does to a neutral test swatch */
const labelCache = {};
App.labelColor = function (id) {
  if (labelCache[id] !== undefined) return labelCache[id];
  const p = P.BY_ID[id];
  if (!p) return (labelCache[id] = null);
  if (p.label) return (labelCache[id] = { bg: p.label, fg: '#1d1c1a' });
  if (!App.swatchSrc) {
    const c = document.createElement('canvas'); c.width = 32; c.height = 8;
    const x = c.getContext('2d');
    ['#3a3a3a', '#6e6e6e', '#a0a0a0', '#d2d2d2', '#c99a7e', '#7f9fc4', '#7f9a6a', '#b8b0a6'].forEach((col, i) => { x.fillStyle = col; x.fillRect(i * 4, 0, 4, 8); });
    App.swatchSrc = R.makeSource(c);
    App.swatchIn = Array.from(x.getImageData(0, 0, 32, 8).data);
    App.swatchCv = document.createElement('canvas'); App.swatchCv.width = 32; App.swatchCv.height = 8;
  }
  const st = { ...App.defaultState(), preset: id, frame: 'none' };
  const saved = { grain: p.grain, chroma: p.chroma, vignette: p.vignette, fisheye: p.fisheye, leakStrength: p.leakStrength };
  Object.assign(p, { grain: 0, chroma: 0, vignette: 0, fisheye: 0, leakStrength: 0 });
  App.renderTo(App.swatchSrc, st, { noOverlays: true });
  Object.assign(p, saved);
  const x = App.swatchCv.getContext('2d');
  x.drawImage(view, 0, 0, 32, 8);
  const d = x.getImageData(0, 0, 32, 8).data, s = App.swatchIn;
  let r = 0, g = 0, b = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { r += d[i] - s[i]; g += d[i + 1] - s[i + 1]; b += d[i + 2] - s[i + 2]; }
  r /= n; g /= n; b /= n;
  const m = (r + g + b) / 3;
  // exaggerate the colour shift into a soft pastel; neutral looks stay grey
  const k = 3.2, base = 196 + m * 0.6;
  const ch = v => Math.round(Math.min(245, Math.max(70, base + (v - m) * k)));
  const R8 = ch(r), G8 = ch(g), B8 = ch(b);
  const lum = (0.2126 * R8 + 0.7152 * G8 + 0.0722 * B8) / 255;
  App.renderPreview();
  return (labelCache[id] = { bg: `rgb(${R8},${G8},${B8})`, fg: lum > 0.55 ? '#1d1c1a' : '#f4efe4' });
};

App.setLayerMode = function (on) {
  if (App.layerMode === on) return;
  App.layerMode = on;
  App.invalidatePresetThumbs();
  syncPresets();
  if (on && !App.state.layer.preset) App.notify('Tap a filter to stack it on top of ' + App.preset().name, 2500);
};
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
  App.closeStrength(true);
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

const stage = (s) => { App.loadStage = s; $('spinnerText').textContent = s + '\u2026'; U.crumb(s, App.loadingInfo); };
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
  stage('Rendering preview');
  App.resetHistory();
  App.sync();
  await U.nextFrame();
  stage('Rendering presets');
  try { App.renderAllThumbs(); } catch (e) { App.notify('Preset thumbnails failed: ' + e.message, 8000); }
  await U.nextFrame();
  U.crumb(null);
};

let loading = false, handled = null;
async function openFile(file) {
  if (!file || loading || file === handled) return;
  handled = file; loading = true;
  App.busy(true, 'Opening\u2026');
  App.loadStage = 'Opening';
  App.loadingInfo = (file.type || 'unknown type') + ', ' + (file.size / 1e6).toFixed(1) + ' MB';
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
  // If the last session died mid-load (iOS reloads a tab that runs out of memory), say where
  const crumb = U.crumb.read();
  if (crumb) {
    U.crumb(null);
    const msg = `Last time Darkroom stopped at \u201c${crumb.s}\u201d${crumb.info ? ' (' + crumb.info + ')' : ''} and the page reloaded. ` +
      (crumb.s === 'Choosing photo' ? 'The viewer reloaded while the photo picker was open. Try opening the file in Safari.' : 'This usually means Safari ran out of memory.');
    const p = document.createElement('p'); p.className = 'error'; p.id = 'crashNote'; p.textContent = msg;
    $('emptyWrap').appendChild(p);
  }
  for (const id of ['openBtn', 'emptyBtn']) $(id).addEventListener('click', () => U.crumb('Choosing photo'));
  // After the picker closes: if no photo arrived, say so (some in-app viewers show the picker but never pass the photo on)
  const pickerClosed = () => {
    const c = U.crumb.read();
    if (!c || c.s !== 'Choosing photo' || loading) return;
    setTimeout(() => {
      if (loading || App.photo && handled) { return; }
      const f = $('file').files && $('file').files[0];
      if (f) return;
      U.crumb(null);
      App.notify('No photo came through. If you did pick one, this viewer can\u2019t pass photos to web pages. Open Darkroom in Safari instead.', 12000);
    }, 1500);
  };
  window.addEventListener('focus', pickerClosed);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pickerClosed(); });
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
  $('modeBase').addEventListener('click', () => App.setLayerMode(false));
  $('modeLayer').addEventListener('click', () => App.setLayerMode(true));
  $('layerOff').addEventListener('click', () => { App.state.layer.preset = null; App.setLayerMode(false); App.commit(); App.sync(); });
  $('strengthLabel').addEventListener('click', App.openStrength);
  $('strengthCancel').addEventListener('click', () => App.closeStrength(false));
  $('strengthApply').addEventListener('click', () => App.closeStrength(true));
  $('strength').addEventListener('input', e => {
    if (App.layerMode) App.state.layer.strength = e.target.value / 100;
    else App.state.strength = e.target.value / 100;
    $('strengthValue').textContent = e.target.value;
    $('strengthLabel').textContent = `${e.target.value}%`;
    App.renderPreview();
  });
  // commit happens on Apply
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
