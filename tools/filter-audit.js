// Usage: node tools/filter-audit.js out.json test-photo.jpg   (needs Playwright + Chromium)
// Distinctness audit: renders every preset on the test card (grain/texture off via clean render), computes CIELAB ΔE between all pairs.
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 393, height: 852 } });
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('file://' + require('path').resolve(__dirname, '../index.html'));
  await p.setInputFiles('#file', process.argv[3] || 'card.jpg');
  await p.waitForSelector('#view:not([hidden])');
  const data = await p.evaluate(() => {
    const src = App.R.makeSource(App.U.scaledCanvas(App.photo, 360, 0, false));
    const c = document.createElement('canvas'); c.width = 60; c.height = 40; const x = c.getContext('2d');
    const out = {};
    for (const pr of [{ id: '_orig' }, ...App.P.PRESETS]) {
      const st = App.defaultState(); st.preset = pr.id === '_orig' ? 'tvset' : pr.id; st.frame = 'none';
      // compare colour/tone only: switch off texture so grain noise doesn't count as difference
      const P = App.P.BY_ID[st.preset]; const saved = {}; for (const k of ['grain', 'chroma', 'fisheye', 'leakStrength', 'vignette']) { saved[k] = P[k]; P[k] = 0; }
      App.renderTo(src, st, { original: pr.id === '_orig', noOverlays: true });
      Object.assign(P, saved);
      x.drawImage(App.view, 0, 0, 60, 40);
      out[pr.id] = Array.from(x.getImageData(0, 0, 60, 40).data);
    }
    return out;
  });
  fs.writeFileSync(process.argv[2] || 'audit.json', JSON.stringify(data));
  await b.close();
})();
