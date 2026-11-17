// Phone-width browser check of the main flows, in demo mode (no cloud, no cost).
// Usage: npm run build && npm run e2e   (screenshots go to ./screenshots, git-ignored)
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const PORT = Number(process.env.E2E_PORT) || 4189;
const BASE = `http://localhost:${PORT}`;
mkdirSync('screenshots', { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
  detached: true,
  env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
});
let serverExited = false;
server.on('exit', () => (serverExited = true));
const stop = () => {
  try {
    process.kill(-server.pid);
  } catch {}
};
process.on('exit', stop);

const builtIndex = readFileSync('dist/index.html', 'utf8');
for (let i = 0; ; i++) {
  if (serverExited) throw new Error(`port ${PORT} is in use; rerun with E2E_PORT=<free port>`);
  if (i > 60) throw new Error('preview server did not start');
  try {
    const r = await fetch(BASE);
    if (r.ok) {
      if ((await r.text()) !== builtIndex) throw new Error(`port ${PORT} is serving another build`);
      break;
    }
  } catch (e) {
    if (String(e).includes('another build')) throw e;
  }
  await new Promise((r) => setTimeout(r, 250));
}

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
await ctx.grantPermissions(['camera'], { origin: BASE });
await ctx.addInitScript(() => {
  window.__TEST__ = true;
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) return;
  const orig = md.getUserMedia.bind(md);
  window.__streams = [];
  md.getUserMedia = async (c) => {
    const s = await orig(c);
    window.__streams.push(s);
    return s;
  };
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && !/favicon|storage\.googleapis/.test(m.text()) && errors.push('console: ' + m.text()));
const shot = (name) => page.screenshot({ path: `screenshots/${name}.png` });
const tab = (name) => page.locator('nav.tabs button', { hasText: name }).click();

await page.goto(BASE);

console.log('Live coach');
await page.getByRole('button', { name: 'Start camera' }).click();
await page.locator('.live-top').waitFor();
check(await page.locator('.live-overlay').isVisible(), 'camera view with overlay');
// on-device detector loads from the network; give it time, but don't fail the run if it's slow
try {
  await page.waitForFunction(() => /\d/.test(document.querySelector('.live-score')?.textContent ?? ''), null, { timeout: 45000 });
  check(true, 'on-device detector loaded and shows a live score');
} catch {
  const hint = await page.locator('.live-hint').textContent().catch(() => '');
  check(false, `live score did not appear (${hint || 'no hint'})`);
}
await page.waitForTimeout(800);
await shot('1-live');
await page.locator('.chip', { hasText: 'Center' }).click();
check((await page.locator('.chip', { hasText: 'Center' }).getAttribute('aria-pressed')) === 'true', 'center guide toggles on');
await page.getByRole('button', { name: 'Take photo' }).click();
await page.locator('.sheet').waitFor();
check(await page.getByRole('button', { name: 'Save to Photos' }).isVisible(), 'live shot offers Save to Photos');
check(await page.locator('.shot-live').isVisible(), 'live score is attached to the shot');
await page.getByRole('button', { name: 'Get critique' }).click();
await page.locator('.crit').waitFor();
check(await page.locator('.edit-tips').isVisible(), 'critique shows editing tips');
check((await page.locator('.crit-foot').textContent()).includes('Demo'), 'demo critique is labeled free');
await shot('2-critique');
await page.getByRole('button', { name: 'Done' }).click();
const live = await page.evaluate(() => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length);
check(live > 0, 'camera still running on the Shoot tab');

console.log('Import + gallery');
await tab('Critique');
const after = await page.evaluate(() => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length);
check(after === 0, 'camera turns off when leaving the Shoot tab');
await page.locator('[data-testid=file]').setInputFiles('tests/fixture.jpg');
await page.locator('.sheet').waitFor();
check(!(await page.getByRole('button', { name: 'Save to Photos' }).isVisible()), 'imported photo has no Save button (already in camera roll)');
await page.getByRole('button', { name: 'Keep in gallery without critique' }).click();
await tab('Gallery');
check((await page.locator('.grid li').count()) === 2, 'gallery has 2 photos');
check((await page.locator('.grid .badge').count()) === 1, 'one has a score badge');
await shot('3-gallery');
await page.locator('.grid li button').first().click(); // newest = the imported one
await page.locator('.sheet').waitFor();
check((await page.locator('.sheet .hint').textContent()).includes('No critique'), 'uncritiqued photo opens with no critique');
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Get a critique' }).click()]);
await chooser.setFiles('tests/fixture.jpg');
await page.getByRole('button', { name: 'Get critique' }).click();
await page.locator('.crit').waitFor();
await page.getByRole('button', { name: 'Done' }).click();
await page.locator('.sheet .crit').waitFor().catch(() => {});
check((await page.locator('.sheet .crit').count()) === 1, 'returns to the photo page showing the new critique');
await page.getByRole('button', { name: 'Back' }).click();
check((await page.locator('.grid .badge').count()) === 2, 're-critique attaches to the same photo (no duplicate)');
check((await page.locator('.grid li').count()) === 2, 'still 2 photos');

console.log('Progress');
await tab('Progress');
check((await page.locator('.stat b').first().textContent()) !== '–', 'average score shows');
check(await page.locator('.focus').isVisible(), 'focus card shows');
await shot('4-progress');

console.log('Settings + cap');
await tab('Settings');
check((await page.locator('.spend-top b').textContent()).includes('0.07'), 'running cost shows two demo critiques');
await shot('5-settings');
await page.getByLabel('Monthly cap in dollars').fill('0.1');
await page.getByLabel('Monthly cap in dollars').press('Enter');
await page.waitForTimeout(500);
await tab('Critique');
await page.locator('[data-testid=file]').setInputFiles('tests/fixture.jpg');
await page.getByRole('button', { name: 'Get critique' }).click();
await page.locator('.error-box').waitFor();
check((await page.locator('.error-box').textContent()).includes('cap'), 'cap blocks the next critique');
await page.getByRole('button', { name: 'Open Settings' }).click();
check(await page.locator('h1', { hasText: 'Settings' }).isVisible(), 'cap message links to Settings');

await page.getByLabel('Monthly cap in dollars').fill('5');
await page.getByLabel('Monthly cap in dollars').press('Enter');
await page.locator('.setting', { hasText: 'Editing tips' }).locator('input').uncheck();
await tab('Critique');
await page.locator('[data-testid=file]').setInputFiles('tests/fixture.jpg');
await page.getByRole('button', { name: 'Get critique' }).click();
await page.locator('.crit').waitFor();
check(!(await page.locator('.edit-tips').isVisible()), 'editing tips hidden when turned off');
await page.getByRole('button', { name: 'Done' }).click();

await tab('Settings');
await page.locator('.setting', { hasText: 'AI critique' }).locator('input').uncheck();
check((await page.locator('nav.tabs button', { hasText: 'Critique' }).count()) === 0, 'Critique tab hides when AI critique is off');
await page.reload();
check((await page.locator('nav.tabs button', { hasText: 'Critique' }).count()) === 0, 'setting survives a reload');

const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
check(!overflow, 'no sideways scrolling at phone width');
check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);

await browser.close();
stop();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll browser checks passed');
process.exit(failures ? 1 : 0);
