/* Phase 3: manual adjustments, crop, before/after split, undo/redo, drafts, export options */
'use strict';
(function () {
const App = window.App, $ = App.$, U = App.U, R = App.R;
const view = App.view;

/* ---------- Adjust ---------- */
const ADJ = [
  ['exposure', 'Exposure', -100, 100], ['contrast', 'Contrast', -100, 100], ['highlights', 'Highlights', -100, 100],
  ['shadows', 'Shadows', -100, 100], ['whites', 'Whites', -100, 100], ['blacks', 'Blacks', -100, 100],
  ['temp', 'Temperature', -100, 100], ['tint', 'Tint', -100, 100], ['saturation', 'Saturation', -100, 100],
  ['vibrance', 'Vibrance', -100, 100], ['fade', 'Fade', 0, 100], ['clarity', 'Clarity', -100, 100],
  ['sharpen', 'Sharpen', 0, 100], ['vignette', 'Vignette', -100, 100]
];
let adjSel = 'exposure';
const fmt = v => (v > 0 ? '+' : '') + v;
function buildAdj() {
  const list = $('adjList'); list.innerHTML = '';
  for (const [id, name] of ADJ) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.dataset.id = id; b.setAttribute('role', 'tab');
    b.innerHTML = '<span></span><small></small>';
    b.querySelector('span').textContent = name;
    b.addEventListener('click', () => { adjSel = id; syncAdj(); });
    list.appendChild(b);
  }
}
function syncAdj() {
  const a = App.state.adjust;
  for (const b of $('adjList').children) {
    const v = Math.round((a[b.dataset.id] || 0) * 100);
    b.setAttribute('aria-selected', b.dataset.id === adjSel);
    b.querySelector('small').textContent = v ? fmt(v) : '';
  }
  const d = ADJ.find(x => x[0] === adjSel);
  $('adjName').textContent = d[1];
  const s = $('adjAmount'); s.min = d[2]; s.max = d[3];
  const v = Math.round((a[adjSel] || 0) * 100);
  s.value = v; $('adjValue').textContent = fmt(v);
}

/* ---------- Crop ---------- */
function oriented() {
  const [w, h] = App.previewSrc ? [App.previewSrc.w, App.previewSrc.h] : [1, 1];
  return R.orientedSize(w, h, App.state.crop);
}
function buildAspects() {
  const list = $('aspectList'); list.innerHTML = '';
  for (const [id, name] of App.ASPECTS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.dataset.id = id; b.textContent = name;
    b.addEventListener('click', () => { setAspect(id); App.commit(); App.sync(); });
    list.appendChild(b);
  }
}
function setAspect(id) {
  const c = App.state.crop; c.aspect = id;
  const [W, H] = oriented();
  const a = App.aspectValue(id, W, H);
  if (a) c.rect = App.aspectRect(W, H, a);
}
function syncCrop() {
  const c = App.state.crop;
  for (const b of $('aspectList').children) b.setAttribute('aria-pressed', b.dataset.id === c.aspect);
  $('straighten').value = Math.round(c.straighten * 10);
  $('straightenLabel').textContent = c.straighten.toFixed(1) + '°';
}
function stageRect() {
  const vr = view.getBoundingClientRect(), sr = $('stage').getBoundingClientRect();
  return { x: vr.left - sr.left, y: vr.top - sr.top, w: vr.width, h: vr.height };
}
function placeOverlays() {
  const box = $('cropbox');
  if (App.editing && !view.hidden) {
    const v = stageRect(), r = App.state.crop.rect;
    Object.assign(box.style, { left: v.x + r[0] * v.w + 'px', top: v.y + r[1] * v.h + 'px', width: r[2] * v.w + 'px', height: r[3] * v.h + 'px' });
    box.hidden = false;
  } else box.hidden = true;
  const dv = $('divider');
  if (App.split != null && App.lastLayout && !view.hidden) {
    const v = stageRect(), L = App.lastLayout;
    dv.style.left = v.x + ((L.pads.l + App.split * L.w) / L.ow) * v.w + 'px';
    dv.style.top = v.y + 'px'; dv.style.height = v.h + 'px'; dv.style.bottom = 'auto';
    dv.hidden = false;
  } else dv.hidden = true;
}
App.stageRect = stageRect;

function cropDrag(e) {
  const h = e.target.dataset.h || 'move';
  const c = App.state.crop, r0 = [...c.rect];
  const v = stageRect(), [W, H] = oriented();
  const a = App.aspectValue(c.aspect, W, H);
  const x0 = e.clientX, y0 = e.clientY;
  const MIN = 0.06;
  $('cropbox').setPointerCapture(e.pointerId);
  const move = ev => {
    const dx = (ev.clientX - x0) / v.w, dy = (ev.clientY - y0) / v.h;
    let r;
    if (h === 'move') {
      r = [U.clamp(r0[0] + dx, 0, 1 - r0[2]), U.clamp(r0[1] + dy, 0, 1 - r0[3]), r0[2], r0[3]];
    } else {
      const left = h[1] === 'l', top = h[0] === 't';
      const ax = left ? r0[0] + r0[2] : r0[0], ay = top ? r0[1] + r0[3] : r0[1];
      let px = U.clamp((left ? r0[0] : r0[0] + r0[2]) + dx, 0, 1), py = U.clamp((top ? r0[1] : r0[1] + r0[3]) + dy, 0, 1);
      let w = Math.max(MIN, left ? ax - px : px - ax), hh = Math.max(MIN, top ? ay - py : py - ay);
      if (a) {
        let wp = w * W, hp = hh * H;
        if (wp / hp > a) wp = hp * a; else hp = wp / a;
        w = wp / W; hh = hp / H;
        const maxW = left ? ax : 1 - ax, maxH = top ? ay : 1 - ay;
        const k = Math.min(1, maxW / w, maxH / hh);
        w *= k; hh *= k;
      } else {
        w = Math.min(w, left ? ax : 1 - ax); hh = Math.min(hh, top ? ay : 1 - ay);
      }
      r = [left ? ax - w : ax, top ? ay - hh : ay, w, hh];
    }
    c.rect = r;
    placeOverlays();
  };
  const up = () => {
    $('cropbox').removeEventListener('pointermove', move);
    $('cropbox').removeEventListener('pointerup', up);
    $('cropbox').removeEventListener('pointercancel', up);
    App.commit();
  };
  $('cropbox').addEventListener('pointermove', move);
  $('cropbox').addEventListener('pointerup', up);
  $('cropbox').addEventListener('pointercancel', up);
}

/* ---------- Before / after + undo ---------- */
function setCompare(on) {
  App.split = on ? 0.5 : null;
  $('compareBtn').setAttribute('aria-pressed', on);
  $('origTag').hidden = !on; $('editTag').hidden = !on;
  App.renderPreview();
}
function dividerDrag(e) {
  const dv = $('divider');
  dv.setPointerCapture(e.pointerId);
  const move = ev => {
    const v = stageRect(), L = App.lastLayout; if (!L) return;
    const sx = ((ev.clientX - $('stage').getBoundingClientRect().left - v.x) / v.w) * L.ow;
    App.split = U.clamp((sx - L.pads.l) / L.w, 0, 1);
    App.renderPreview();
  };
  const up = () => { dv.removeEventListener('pointermove', move); dv.removeEventListener('pointerup', up); dv.removeEventListener('pointercancel', up); };
  dv.addEventListener('pointermove', move); dv.addEventListener('pointerup', up); dv.addEventListener('pointercancel', up);
}
function restore(i) {
  const h = App.history;
  if (i < 0 || i >= h.stack.length) return;
  h.index = i;
  App.state = App.normalize(JSON.parse(h.stack[i]));
  syncHistory();
  App.sync();
  scheduleDraft();
}
function syncHistory() {
  const h = App.history;
  $('undoBtn').disabled = h.index <= 0;
  $('redoBtn').disabled = h.index >= h.stack.length - 1;
}

/* ---------- Drafts (IndexedDB) ---------- */
let draftTimer = null;
function scheduleDraft() {
  if (!App.photo) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => U.idbSet('draft', { state: App.state, ts: Date.now(), hasPhoto2: !!App.photo2File }), 700);
}
async function saveDraftPhotos() {
  try {
    const thumb = await U.canvasBlob(U.scaledCanvas(App.photo, 200, 0, true), 'image/jpeg', 0.8);
    await U.idbSet('draftPhoto', { blob: new Blob([App.photoFile], { type: App.photoFile.type }), name: App.photoFile.name || '', lastModified: App.photoFile.lastModified || 0, thumb });
    await U.idbDel('draftPhoto2');
  } catch (e) { /* storage full: drafts are best effort */ }
}
async function showResume() {
  const d = await U.idbGet('draft'), ph = await U.idbGet('draftPhoto');
  if (!d || !ph || !ph.blob || App.photo) return;
  $('resumeImg').src = ph.thumb ? URL.createObjectURL(ph.thumb) : '';
  const it = App.itemById(d.state.look || d.state.preset);
  $('resumeInfo').textContent = `${it ? it.name : 'Edit'} · ${new Date(d.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  $('resumeBtn').hidden = false;
  $('resumeBtn').onclick = async () => {
    App.busy(true);
    try {
      const file = new File([ph.blob], ph.name || 'draft.jpg', { type: ph.blob.type, lastModified: ph.lastModified || Date.now() });
      if (d.hasPhoto2) {
        const p2 = await U.idbGet('draftPhoto2');
        if (p2 && p2.blob) await App.setPhoto2(new File([p2.blob], 'second.jpg', { type: p2.blob.type }));
      }
      await App.loadPhoto(file, d.state);
      App.notify('Picked up where you left off', 2000);
    } catch (e) { App.notify('The saved edit couldn’t be reopened: ' + e.message); }
    App.busy(false);
  };
}

/* ---------- Export options ---------- */
function exportSheet() {
  const o = App.exportOpts;
  App.openSheet('Save', body => {
    const dims = () => {
      const [iw, ih] = U.imgSize(App.photo);
      const g = R.geometry(iw, ih, App.state.crop, false);
      const pd = R.framePads(App.state.frame, App.preset(), g.w, g.h);
      let w = g.w + pd.l + pd.r, h = g.h + pd.t + pd.b;
      const want = App.EXPORT_SIZES[o.size];
      let k = o.size === 'ig' ? want / w : want ? want / Math.max(w, h) : 1;
      k = Math.min(k, 2, Math.sqrt(12e6 / (w * h)));
      return `${Math.round(w * k)} × ${Math.round(h * k)} px`;
    };
    body.innerHTML = `
      <div class="field"><label>Size</label><div class="seg" id="exSize"></div><span class="muted" id="exDims"></span></div>
      <div class="field"><label>JPEG quality <output id="exQv"></output></label><input type="range" id="exQ" min="60" max="100" style="margin:0;width:100%"></div>
      <div class="row" style="justify-content:center;padding-top:14px"><button class="btn primary" id="exGo" type="button" style="padding:12px 34px">Save photo</button></div>
      <p style="margin:12px auto 0">Full is capped near 12 MP, the most iPhone Safari can render safely.</p>`;
    const sizes = [['full', 'Full'], ['4k', '4K'], ['2k', '2K'], ['ig', 'Instagram 1080']];
    const seg = body.querySelector('#exSize');
    const sync = () => {
      for (const b of seg.children) b.setAttribute('aria-pressed', b.dataset.id === o.size);
      body.querySelector('#exDims').textContent = dims();
      body.querySelector('#exQ').value = o.quality;
      body.querySelector('#exQv').textContent = o.quality;
    };
    for (const [id, n] of sizes) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.dataset.id = id; b.textContent = n;
      b.addEventListener('click', () => { o.size = id; U.lsSet('darkroom.export', o); sync(); });
      seg.appendChild(b);
    }
    body.querySelector('#exQ').addEventListener('input', e => { o.quality = +e.target.value; U.lsSet('darkroom.export', o); sync(); });
    body.querySelector('#exGo').addEventListener('click', () => { App.closeSheet(); App.save(); });
    sync();
  });
}

App.modules.push({
  init() {
    buildAdj(); buildAspects();
    $('adjAmount').addEventListener('input', e => {
      App.state.adjust[adjSel] = e.target.value / 100;
      $('adjValue').textContent = fmt(+e.target.value);
      App.renderPreview();
    });
    $('adjAmount').addEventListener('change', () => { App.commit(); syncAdj(); });
    let lastTap = 0;
    $('adjAmount').addEventListener('pointerup', () => {
      const now = Date.now();
      if (now - lastTap < 320) { App.state.adjust[adjSel] = 0; App.commit(); App.sync(); }
      lastTap = now;
    });
    $('adjReset').addEventListener('click', () => { App.state.adjust = App.defaultState().adjust; App.commit(); App.sync(); });

    $('rotBtn').addEventListener('click', () => {
      const c = App.state.crop; c.rot = (c.rot + 1) % 4;
      const [W, H] = oriented(); const a = App.aspectValue(c.aspect, W, H);
      c.rect = a ? App.aspectRect(W, H, a) : [0, 0, 1, 1];
      App.commit(); App.sync();
    });
    $('flipBtn').addEventListener('click', () => { const c = App.state.crop; c.flipH = !c.flipH; c.rect = [1 - c.rect[0] - c.rect[2], c.rect[1], c.rect[2], c.rect[3]]; App.commit(); App.sync(); });
    $('cropReset').addEventListener('click', () => { App.state.crop = App.defaultState().crop; App.commit(); App.sync(); });
    $('straighten').addEventListener('input', e => {
      App.state.crop.straighten = e.target.value / 10;
      $('straightenLabel').textContent = App.state.crop.straighten.toFixed(1) + '°';
      App.renderPreview();
    });
    $('straighten').addEventListener('change', App.commit);
    $('cropbox').addEventListener('pointerdown', cropDrag);

    $('compareBtn').addEventListener('click', () => setCompare(App.split == null));
    $('divider').addEventListener('pointerdown', dividerDrag);
    $('undoBtn').addEventListener('click', () => restore(App.history.index - 1));
    $('redoBtn').addEventListener('click', () => restore(App.history.index + 1));
    window.addEventListener('keydown', e => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || /input|textarea/i.test(document.activeElement.tagName)) return;
      e.preventDefault(); restore(App.history.index + (e.shiftKey ? 1 : -1));
    });
    App.onSave = exportSheet;
    for (const t of ['adjust', 'crop']) $('tabbar').querySelector(`[data-tab=${t}]`).hidden = false;
    showResume();
  },
  sync() { syncAdj(); syncCrop(); },
  enter(tab) {
    if (tab === 'crop') { if (App.split != null) setCompare(false); App.editing = true; }
  },
  leave(tab) { if (tab === 'crop') { App.editing = false; App.commit(); } },
  afterRender: placeOverlays,
  overlays(st, L, sprites, opts) { if (opts.preview) App.lastLayout = L; },
  committed() { syncHistory(); scheduleDraft(); },
  async photoLoaded(fromDraft) {
    for (const b of ['undoBtn', 'redoBtn', 'compareBtn']) $(b).hidden = false;
    $('resumeBtn').hidden = true;
    if (App.split != null) setCompare(false);
    if (!fromDraft) {
      R.setPhoto2(null); App.photo2File = null;
      setTimeout(saveDraftPhotos, 2500);
    }
  }
});

/* second photo also goes into the draft */
const origSet = App.setPhoto2;
App.setPhoto2 = async function (file) {
  await origSet(file);
  try { await U.idbSet('draftPhoto2', { blob: new Blob([file], { type: file.type }) }); } catch (e) { /* best effort */ }
};
})();
