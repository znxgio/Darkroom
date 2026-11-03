/* Custom presets ("My presets") and batch editing */
'use strict';
(function () {
const App = window.App, $ = App.$, U = App.U, R = App.R;
const I = {
  save: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h0M4 12h0M4 18h0"/>',
  batch: '<rect x="7" y="7" width="13" height="13" rx="1.5"/><path d="M4 16V5a1 1 0 011-1h11"/>',
  up: '<path d="M6 15l6-6 6 6"/>', down: '<path d="M6 9l6 6 6-6"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>'
};
App.ICONS = I;

/* ---------- Custom presets ---------- */
const lookState = l => {
  const st = App.normalize({ ...App.defaultState(), preset: l.preset, strength: l.strength, fx: l.fx, adjust: l.adjust, frame: l.frame, layer: l.layer });
  st.stamp.on = !!(l.stamp && l.stamp.on); st.stamp.color = (l.stamp && l.stamp.color) || 0;
  return st;
};
function snapshotLook(name) {
  const s = JSON.parse(JSON.stringify(App.state));
  return { id: 'look-' + Date.now().toString(36), name, preset: s.preset, strength: s.strength, layer: s.layer, fx: s.fx, adjust: s.adjust,
    frame: s.frame, stamp: { on: s.stamp.on, color: s.stamp.color }, created: Date.now() };
}
function saveLookPrompt() {
  const base = App.preset().name;
  const name = (prompt('Name this look', base + ' custom') || '').trim();
  if (!name) return;
  const l = snapshotLook(name.slice(0, 40));
  App.looks.push(l); App.saveLooks();
  App.state.look = l.id;
  App.renderThumb(l.id, lookState(l));
  App.buildCollections(); App.buildStrip(); App.sync();
  App.notify(`Saved “${l.name}” to My presets`, 2200);
}
App.saveLookPrompt = saveLookPrompt;

function manageLooks() {
  App.openSheet('My presets', body => {
    const draw = () => {
      body.innerHTML = '';
      const row = document.createElement('div'); row.className = 'row wrap';
      row.innerHTML = '<button class="btn primary" type="button" data-a="new">Save current look</button><button class="btn" type="button" data-a="export">Export</button><button class="btn" type="button" data-a="import">Import</button>';
      row.querySelector('[data-a=new]').addEventListener('click', () => { saveLookPrompt(); draw(); });
      row.querySelector('[data-a=export]').addEventListener('click', exportLooks);
      row.querySelector('[data-a=import]').addEventListener('click', () => $('fileJson').click());
      body.appendChild(row);
      const p = document.createElement('p'); p.className = 'muted'; p.style.cssText = 'text-align:left;padding:4px 16px 10px;max-width:none';
      p.textContent = App.looks.length ? 'A look stores the preset, strength, effects, adjustments, frame and stamp setting. Crop and text stay with each photo.'
        : 'No saved looks yet. Edit a photo the way you like, then tap Save current look.';
      body.appendChild(p);
      const list = document.createElement('div'); list.className = 'list';
      App.looks.forEach((l, i) => {
        const it = document.createElement('div'); it.className = 'item';
        const c = document.createElement('canvas'); c.width = c.height = 144;
        if (App.thumbs[l.id]) c.getContext('2d').drawImage(App.thumbs[l.id], 0, 0);
        it.appendChild(c);
        const n = document.createElement('div'); n.className = 'name'; n.textContent = l.name;
        const sm = document.createElement('small'); sm.textContent = 'Based on ' + App.P.get(l.preset).name; n.appendChild(sm);
        it.appendChild(n);
        const btn = (icon, label, fn, dis) => {
          const b = document.createElement('button'); b.type = 'button'; b.innerHTML = App.icon(icon); b.setAttribute('aria-label', label);
          b.disabled = !!dis; b.addEventListener('click', fn); it.appendChild(b);
        };
        btn(I.up, 'Move up', () => { App.looks.splice(i - 1, 0, App.looks.splice(i, 1)[0]); App.saveLooks(); draw(); }, i === 0);
        btn(I.down, 'Move down', () => { App.looks.splice(i + 1, 0, App.looks.splice(i, 1)[0]); App.saveLooks(); draw(); }, i === App.looks.length - 1);
        btn(I.edit, 'Rename', () => { const nn = (prompt('Rename look', l.name) || '').trim(); if (nn) { l.name = nn.slice(0, 40); App.saveLooks(); draw(); } });
        btn(I.refresh, 'Update with current edit', () => {
          if (!confirm(`Replace “${l.name}” with the current edit?`)) return;
          const s = snapshotLook(l.name); Object.assign(l, { ...s, id: l.id, created: l.created }); App.saveLooks();
          App.renderThumb(l.id, lookState(l)); draw();
        }, !App.photo);
        btn(I.trash, 'Delete', () => {
          if (!confirm(`Delete “${l.name}”?`)) return;
          App.looks.splice(i, 1); App.saveLooks();
          const f = App.favs.indexOf(l.id); if (f >= 0) { App.favs.splice(f, 1); App.saveFavs(); }
          if (App.state.look === l.id) App.state.look = null;
          draw();
        });
        list.appendChild(it);
      });
      body.appendChild(list);
    };
    draw();
  }, () => { App.buildCollections(); App.buildStrip(); App.sync(); });
}
function exportLooks() {
  const data = JSON.stringify({ app: 'darkroom', version: 1, looks: App.looks, favorites: App.favs }, null, 2);
  const file = new File([data], `darkroom-presets-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file] }).catch(() => {}); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importLooks(file) {
  try {
    const d = JSON.parse(await file.text());
    const list = Array.isArray(d) ? d : d.looks;
    if (!Array.isArray(list)) throw new Error('no presets in file');
    let added = 0;
    for (const l of list) {
      if (!l || !l.preset || !l.name) continue;
      const ex = App.looks.find(x => x.id === l.id);
      if (ex) Object.assign(ex, l); else { App.looks.push({ ...l, id: l.id || 'look-' + Date.now().toString(36) + added }); }
      added++;
    }
    if (Array.isArray(d.favorites)) for (const f of d.favorites) if (!App.favs.includes(f)) App.favs.push(f);
    App.saveLooks(); App.saveFavs();
    if (App.photo) for (const l of App.looks) App.renderThumb(l.id, lookState(l));
    App.buildCollections(); App.buildStrip(); App.sync();
    if (!$('sheet').hidden) manageLooks();
    App.notify(`Imported ${added} preset${added === 1 ? '' : 's'}`, 2500);
  } catch (e) { App.notify('That file isn’t a Darkroom preset backup (' + e.message + ')'); }
}

/* ---------- Batch ---------- */
let batchFiles = [], batchOut = [];
function batchSheet() {
  App.openSheet('Batch edit', body => {
    const draw = () => {
      body.innerHTML = '';
      const p = document.createElement('p'); p.style.cssText = 'margin:0 auto 12px';
      const look = App.itemById(App.activeId());
      p.textContent = `Applies “${look ? look.name : App.preset().name}” with your effects, adjustments, frame and stamp to every photo.` +
        (App.state.crop.aspect !== 'free' && App.state.crop.aspect !== 'original' ? ` Each one is centre-cropped to ${App.state.crop.aspect}.` : '');
      body.appendChild(p);
      const row = document.createElement('div'); row.className = 'row wrap'; row.style.justifyContent = 'center';
      const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'btn';
      pick.textContent = batchFiles.length ? 'Choose other photos' : 'Choose photos';
      pick.addEventListener('click', () => $('fileMulti').click());
      row.appendChild(pick);
      if (batchFiles.length) {
        const go = document.createElement('button'); go.type = 'button'; go.className = 'btn primary';
        go.textContent = `Develop ${batchFiles.length}`;
        go.addEventListener('click', () => runBatch(draw));
        row.appendChild(go);
      }
      if (batchOut.length) {
        const sv = document.createElement('button'); sv.type = 'button'; sv.className = 'btn primary';
        sv.textContent = `Save all ${batchOut.length}`;
        sv.addEventListener('click', () => App.deliver(batchOut));
        row.appendChild(sv);
      }
      body.appendChild(row);
      const g = document.createElement('div'); g.className = 'thumbs'; g.style.marginTop = '12px';
      const shown = batchOut.length ? batchOut : batchFiles;
      shown.forEach((f, i) => {
        const t = document.createElement('div'); t.className = 't';
        const im = document.createElement('img'); im.alt = ''; im.src = URL.createObjectURL(f);
        im.onload = im.onerror = () => {};
        t.appendChild(im);
        const s = document.createElement('span'); s.textContent = batchOut.length ? 'Done' : `${i + 1}`; t.appendChild(s);
        g.appendChild(t);
      });
      body.appendChild(g);
      if (batchOut.length) {
        const hp = document.createElement('p'); hp.style.cssText = 'margin:12px auto 0';
        hp.textContent = 'If Save all doesn’t offer Save to Photos, press and hold each photo instead.';
        body.appendChild(hp);
      }
    };
    App.batchRedraw = draw;
    draw();
  }, () => { App.batchRedraw = null; for (const u of document.querySelectorAll('.thumbs img')) URL.revokeObjectURL(u.src); });
}
async function runBatch(draw) {
  const out = [];
  const base = JSON.parse(JSON.stringify(App.state));
  for (let i = 0; i < batchFiles.length; i++) {
    App.busy(true, `Developing ${i + 1} of ${batchFiles.length}…`);
    await U.nextFrame();
    let img = null;
    try {
      const f = batchFiles[i];
      img = await U.decodeFile(f);
      const st = App.normalize(JSON.parse(JSON.stringify(base)));
      const [iw, ih] = U.imgSize(img);
      st.crop = { ...App.defaultState().crop, aspect: base.crop.aspect };
      const a = App.aspectValue(base.crop.aspect, iw, ih);
      if (a) st.crop.rect = App.aspectRect(iw, ih, a);
      st.texts = [];
      if (st.stamp.on && st.stamp.auto) {
        const d = (await U.readDate(f)) || (f.lastModified ? new Date(f.lastModified) : new Date());
        st.stamp.text = U.stampText(d);
      }
      const blob = await App.exportBlob(img, st);
      if (blob) {
        out.push(new File([blob], `darkroom-${st.preset}-${Date.now()}-${i + 1}.jpg`, { type: 'image/jpeg' }));
        for (const m of App.modules) if (m.exported) m.exported(blob, App.lastThumb);
      }
    } catch (e) { App.notify(`Photo ${i + 1} couldn’t be developed: ${e.message}`); }
    U.releaseImg(img);
  }
  App.busy(false);
  App.renderPreview();
  batchOut = out;
  if (App.batchRedraw) App.batchRedraw();
  App.notify(`${out.length} of ${batchFiles.length} developed. Tap Save all.`, 4000);
}

/* Aspect helpers shared with crop */
App.ASPECTS = [['free', 'Free'], ['original', 'Original'], ['1:1', '1:1'], ['4:5', '4:5'], ['3:2', '3:2'], ['2:3', '2:3'], ['16:9', '16:9'], ['9:16', '9:16']];
App.aspectValue = function (id, W, H) {
  if (id === 'free' || !id) return null;
  if (id === 'original') return W / H;
  const [a, b] = id.split(':').map(Number);
  return a / b;
};
App.aspectRect = function (W, H, a) {
  let rw = 1, rh = 1;
  if (W / H > a) rw = (a * H) / W; else rh = W / (a * H);
  return [(1 - rw) / 2, (1 - rh) / 2, rw, rh];
};

App.modules.push({
  init() {
    $('fileJson').addEventListener('change', e => { const f = e.target.files[0]; if (f) importLooks(f); e.target.value = ''; });
    $('fileMulti').addEventListener('change', e => {
      batchFiles = [...e.target.files].slice(0, 40); batchOut = [];
      e.target.value = '';
      if (App.batchRedraw) App.batchRedraw();
    });
    App.menuItems.push(
      { section: 'Looks' },
      { icon: I.save, label: 'Save look', sub: 'Keep this preset, effects and adjustments', action: saveLookPrompt, needsPhoto: true },
      { icon: I.list, label: 'My presets', sub: 'Rename, reorder, delete, back up', action: manageLooks },
      { icon: I.batch, label: 'Batch edit', sub: 'Apply this look to many photos', action: () => { batchFiles = []; batchOut = []; batchSheet(); }, needsPhoto: true }
    );
  },
  collections: () => [{ id: 'mine', name: 'My presets' }],
  items(cid) { return cid === 'mine' ? App.looks.map(l => ({ id: l.id, name: l.name, kind: 'look' })) : null; },
  itemById(id) { const l = App.looks.find(x => x.id === id); return l ? { id: l.id, name: l.name, kind: 'look' } : null; },
  applyItem(it) {
    const l = App.looks.find(x => x.id === it.id); if (!l) return;
    const s = App.state, ls = lookState(l);
    s.preset = ls.preset; s.strength = ls.strength; s.fx = ls.fx; s.adjust = ls.adjust; s.frame = ls.frame; s.layer = ls.layer;
    s.stamp.on = ls.stamp.on; s.stamp.color = ls.stamp.color;
    s.look = l.id;
  },
  thumbs() { for (const l of App.looks) App.renderThumb(l.id, lookState(l)); }
});
})();
