/* Effects, frames + date stamp panels */
'use strict';
(function () {
const App = window.App, $ = App.$, U = App.U, R = App.R;

/* ---------- Effects ---------- */
const FX = [
  { id: 'grain', name: 'Grain', opts: [{ key: 'size', choices: [['Fine', 0.1], ['Medium', 0.45], ['Coarse', 0.85]] }] },
  { id: 'dust', name: 'Dust', opts: [{ key: 'style', choices: [['Dust', 0], ['Dust + scratches', 1], ['Scratches', 2]] }], shuffle: true },
  { id: 'leak', name: 'Light leak', opts: [
    { key: 'style', choices: [['Warm', 0], ['Rose', 1], ['Gold', 2], ['Cool', 3], ['Rainbow', 4]] },
    { key: 'pos', choices: [['Left', 0], ['Right', 1], ['Top', 2], ['Bottom', 3], ['Top left', 4], ['Top right', 5], ['Bottom left', 6], ['Bottom right', 7]] }], shuffle: true },
  { id: 'burn', name: 'Film burn', opts: [{ key: 'pos', choices: [['Left', 0], ['Right', 1], ['Top', 2], ['Bottom', 3]] }], shuffle: true },
  { id: 'halation', name: 'Halation' },
  { id: 'bloom', name: 'Bloom' },
  { id: 'vhs', name: 'VHS', shuffle: true },
  { id: 'rgb', name: 'RGB split', opts: [{ key: 'style', choices: [['Lens', 0], ['Shift', 1]] }] },
  { id: 'blur', name: 'Blur', opts: [{ key: 'style', choices: [['Soft focus', 0], ['Lens', 1], ['Full', 2]] }] },
  { id: 'fisheye', name: 'Fisheye' },
  { id: 'prism', name: 'Prism' },
  { id: 'double', name: 'Double exposure', opts: [{ key: 'style', choices: [['Screen', 0], ['Lighten', 1], ['Multiply', 2]] }], photo: true },
  { id: 'texture', name: 'Texture', opts: [{ key: 'style', choices: [['Paper', 0], ['Plastic', 1]] }] }
];
App.FX = FX;
let fxSel = 'grain';

function buildFxList() {
  const list = $('fxList'); list.innerHTML = '';
  for (const f of FX) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.dataset.id = f.id; b.setAttribute('role', 'tab');
    b.textContent = f.name;
    b.addEventListener('click', () => { fxSel = f.id; syncFx(); });
    list.appendChild(b);
  }
}
function syncFx() {
  const st = App.state.fx;
  for (const b of $('fxList').children) {
    b.setAttribute('aria-selected', b.dataset.id === fxSel);
    b.classList.toggle('dot', (st[b.dataset.id] || {}).amount > 0);
  }
  const def = FX.find(f => f.id === fxSel), v = st[fxSel];
  $('fxName').textContent = def.name;
  const pct = Math.round(v.amount * 100);
  $('fxAmount').value = pct;
  $('fxValue').textContent = pct + '%';
  const opts = $('fxOptions'); opts.innerHTML = '';
  if (def.photo) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
    b.textContent = R.photo2 ? 'Change photo' : 'Choose photo';
    b.addEventListener('click', pickPhoto2);
    opts.appendChild(b);
  }
  for (const o of def.opts || []) {
    for (const [label, val] of o.choices) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
      b.textContent = label;
      b.setAttribute('aria-pressed', v[o.key] === val);
      b.addEventListener('click', () => {
        v[o.key] = val;
        if (!v.amount) v.amount = 0.5;
        App.commit(); App.sync();
      });
      opts.appendChild(b);
    }
  }
  if (def.shuffle) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
    b.textContent = 'Shuffle';
    b.addEventListener('click', () => { st.seed = 1 + Math.floor(Math.random() * 96); App.commit(); App.renderPreview(); });
    opts.appendChild(b);
  }
  if (v.amount > 0) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
    b.textContent = 'Off';
    b.addEventListener('click', () => { v.amount = 0; App.commit(); App.sync(); });
    opts.appendChild(b);
  }
}

/* Second photo for double exposure */
App.photo2File = null;
async function setPhoto2(file) {
  const img = await U.decodeFile(file);
  R.setPhoto2(U.scaledCanvas(img, 2048, 0, false));
  U.releaseImg(img);
  App.photo2File = file;
}
App.setPhoto2 = setPhoto2;
function pickPhoto2() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.addEventListener('change', async () => {
    const f = inp.files[0]; if (!f) return;
    App.busy(true);
    try {
      await App.setPhoto2(f);
      if (!App.state.fx.double.amount) App.state.fx.double.amount = 0.6;
      App.commit(); App.sync();
      for (const m of App.modules) if (m.committed) m.committed();
    } catch (e) { App.notify('That photo couldn’t be opened: ' + e.message); }
    App.busy(false);
  });
  inp.click();
}

/* ---------- Frames + date stamp ---------- */
const FRAMES = [['preset', 'Preset'], ['none', 'None'], ['thin', 'Thin white'], ['thick', 'Thick white'], ['black', 'Black'], ['polaroid', 'Polaroid'], ['rebate', 'Film']];
App.FRAMES = FRAMES;
function buildFrames() {
  const list = $('frameList'); list.innerHTML = '';
  for (const [id, name] of FRAMES) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ftile'; b.dataset.f = id;
    b.innerHTML = '<i></i><span></span>';
    b.querySelector('span').textContent = name;
    b.addEventListener('click', () => { App.state.frame = id; App.commit(); App.sync(); });
    list.appendChild(b);
  }
  const sw = $('stampColors'); sw.innerHTML = '';
  U.STAMP_COLORS.forEach((c, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'swatch';
    b.style.background = c.core; b.style.boxShadow = `0 0 8px ${c.glow}`;
    b.setAttribute('aria-label', ['Orange', 'Red', 'Yellow'][i] + ' stamp');
    b.addEventListener('click', () => { App.state.stamp.color = i; App.state.stamp.on = true; App.commit(); App.sync(); });
    sw.appendChild(b);
  });
}
function syncFrames() {
  for (const b of $('frameList').children) b.setAttribute('aria-pressed', b.dataset.f === App.state.frame);
  const s = App.state.stamp;
  $('stampOn').checked = s.on;
  if (document.activeElement !== $('stampText')) $('stampText').value = s.text;
  [...$('stampColors').children].forEach((b, i) => b.setAttribute('aria-pressed', s.color === i));
}

const stampCache = { key: '', canvas: null };
const edgeCache = {};
function overlays(st, L, sprites, opts) {
  if (opts.editing) return;
  const S = Math.min(L.w, L.h);
  if (st.frame === 'rebate' && L.pads.rebate) {
    const th = S * 0.05, off = S * 0.058;
    const land = L.w >= L.h, len = land ? L.w : L.h;
    const n = Math.round(len / (0.198 * S * 4));
    const a = [], b = [];
    for (let i = 0; i < Math.max(1, n); i++) {
      a.push(['DARKROOM 400', (i + 0.08) / Math.max(1, n)]);
      b.push([`${14 + i}`, (i + 0.15) / Math.max(1, n)], [`▸ ${14 + i}A`, (i + 0.6) / Math.max(1, n)]);
    }
    const key = (t) => t.map(x => x.join()).join('|') + th + len;
    const mk = t => edgeCache[key(t)] || (edgeCache[key(t)] = U.drawEdgeText(t, th, len));
    const ca = mk(a), cb = mk(b);
    if (land) {
      sprites.push({ canvas: ca, cx: L.pads.l + L.w / 2, cy: L.pads.t - off, w: ca.width, h: ca.height });
      sprites.push({ canvas: cb, cx: L.pads.l + L.w / 2, cy: L.pads.t + L.h + off, w: cb.width, h: cb.height });
    } else {
      sprites.push({ canvas: ca, cx: L.pads.l - off, cy: L.pads.t + L.h / 2, w: ca.width, h: ca.height, rot: -Math.PI / 2 });
      sprites.push({ canvas: cb, cx: L.pads.l + L.w + off, cy: L.pads.t + L.h / 2, w: cb.width, h: cb.height, rot: Math.PI / 2 });
    }
  }
  if (st.stamp.on && st.stamp.text) {
    const h = S * 0.042;
    const key = st.stamp.text + '|' + Math.round(h) + '|' + st.stamp.color;
    if (stampCache.key !== key) { stampCache.key = key; stampCache.canvas = U.drawStamp(st.stamp.text, h, st.stamp.color); }
    const c = stampCache.canvas, pad = Math.max(8, Math.round(h)) * 0.5, m = S * 0.055;
    sprites.push({ canvas: c, cx: L.pads.l + L.w - m - c.width / 2 + pad, cy: L.pads.t + L.h - m - c.height / 2 + pad, w: c.width, h: c.height });
  }
}

App.modules.push({
  init() {
    buildFxList();
    buildFrames();
    $('fxAmount').addEventListener('input', e => {
      App.state.fx[fxSel].amount = e.target.value / 100;
      $('fxValue').textContent = e.target.value + '%';
      App.renderPreview();
    });
    $('fxAmount').addEventListener('change', e => {
      App.commit(); syncFx();
      if (fxSel === 'double' && !R.photo2 && e.target.value > 0) pickPhoto2();
    });
    $('stampOn').addEventListener('change', e => { App.state.stamp.on = e.target.checked; App.commit(); App.sync(); });
    $('stampText').addEventListener('input', e => {
      App.state.stamp.text = e.target.value; App.state.stamp.auto = false;
      if (e.target.value) App.state.stamp.on = true;
      $('stampOn').checked = App.state.stamp.on;
      App.renderPreview();
    });
    $('stampText').addEventListener('change', App.commit);
    $('stampDate').addEventListener('click', () => {
      Object.assign(App.state.stamp, { text: U.stampText(App.photoDate), auto: true, on: true });
      App.commit(); App.sync();
    });
    for (const t of ['effects', 'frames']) $('tabbar').querySelector(`[data-tab=${t}]`).hidden = false;
  },
  sync() { syncFx(); syncFrames(); },
  overlays
});
})();
