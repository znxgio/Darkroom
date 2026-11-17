// Renders the app icon (aperture mark on a dark tile) to PNGs. Run once: node scripts/make-icons.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#121211"/>
<g transform="translate(${pad} ${pad}) scale(${(512 - 2 * pad) / 48})" fill="none" stroke="#e8a33d" stroke-width="2" stroke-linecap="round">
<circle cx="24" cy="24" r="18"/><circle cx="24" cy="24" r="7"/>
<path d="M24 6l6 11M42 24H29.5M33 39l-6-11M15 39l6-11M6 24h12.5M15 9l6 11"/></g></svg>`;
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of [['icon-192', 192, 70], ['icon-512', 512, 70], ['apple-touch-icon', 180, 70], ['maskable-512', 512, 120]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0">${svg(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await page.screenshot({ path: `public/icons/${name}.png`, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
