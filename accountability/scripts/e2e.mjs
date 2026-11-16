// Phone-width browser check of the main flows, in demo mode with a fake clock.
// Usage: npm run build && npm run e2e   (screenshots go to ./screenshots, git-ignored)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
// Uses the machine's Playwright if installed globally, else a local one.
const { chromium } = createRequire(import.meta.url)('playwright');

const PORT = Number(process.env.E2E_PORT) || 4179;
const BASE = `http://localhost:${PORT}`;
mkdirSync('screenshots', { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
  env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
});
const stop = () => server.kill();
process.on('exit', stop);

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('preview server did not start');
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else {
    failures++;
    console.log('  FAIL ' + msg);
  }
}

await waitForServer();
// Fake camera: Chromium feeds a test pattern and auto-allows the permission prompt.
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
await ctx.grantPermissions(['camera'], { origin: BASE });
// Remember every camera stream so we can check its tracks get stopped.
await ctx.addInitScript(() => {
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

// Monday Nov 16 2026, 9:00 AM LA
let now = '2026-11-16T17:00:00Z';
await ctx.addInitScript((n) => {
  window.__TEST_NOW__ = localStorage.getItem('__now') || n;
}, now);
const setNow = async (iso) => {
  now = iso;
  await page.evaluate((n) => localStorage.setItem('__now', n), iso);
  await page.reload();
};
const tid = (id) => page.getByTestId(id);

console.log('Flow: create tasks');
await page.goto(BASE);
await tid('tab-tasks').click();

async function addTask(name, setup) {
  await tid('new-task').click();
  await tid('task-name').fill(name);
  await setup();
  await tid('save-task').click();
  await page.getByText(name, { exact: true }).first().waitFor();
}
await addTask('Gym', async () => {
  await tid('type-repeats').click();
  await tid('pattern-weekdays').click();
  for (const d of [1, 2, 3, 4, 5]) await tid(`wd-${d}`).click();
  await tid('goal-time').fill('07:00');
  await tid('critical').click();
});
await addTask('Read 10 pages', async () => {
  await tid('type-repeats').click();
  await tid('pattern-daily').click();
});
await addTask('Clean apartment', async () => {
  await tid('type-repeats').click();
  await tid('pattern-weekly_day').click();
  await tid('wd-0').click();
});
await addTask('Call bank', async () => {
  await tid('type-once').click();
});
await page.screenshot({ path: 'screenshots/tasks.png' });

console.log('Flow: today check-off (Monday)');
await tid('tab-today').click();
check(await tid('task-row-Gym').isVisible(), 'Gym shows on Monday');
check(await tid('task-row-Read 10 pages').isVisible(), 'Daily task shows');
check(await tid('task-row-Call bank').isVisible(), 'One-time task shows on its day');
check((await tid('task-row-Clean apartment').count()) === 0, 'Sunday-only task hidden on Monday');
const t0 = Date.now();
await tid('task-row-Gym').click();
await tid('task-row-Call bank').click();
console.log(`  (two check-offs took ${Date.now() - t0} ms)`);
await tid('skip-Read 10 pages').click();
check(await tid('skip-save').isDisabled(), 'Skip needs a reason (save disabled when empty)');
await tid('skip-reason').fill('Long day at work');
await tid('skip-save').click();
await page.getByText('Long day at work').waitFor();
check((await tid('done-count').textContent())?.includes('2'), 'Done count updates');
await page.screenshot({ path: 'screenshots/today.png' });

console.log('Flow: persists after reload');
await page.reload();
await tid('task-row-Gym').waitFor();
check(await page.getByText('Long day at work').isVisible(), 'Skip reason persisted');

console.log('Flow: next day — yesterday is locked, one-time task gone');
await setNow('2026-11-17T17:00:00Z');
await tid('task-row-Gym').waitFor();
check((await tid('task-row-Call bank').count()) === 0, 'One-time task gone the next day');
check((await tid('done-count').textContent())?.trim().startsWith('0'), 'New day starts fresh (0 done)');

console.log('Flow: Sunday shows weekly task, not Gym');
await setNow('2026-11-22T18:00:00Z');
await tid('task-row-Clean apartment').waitFor();
check((await tid('task-row-Gym').count()) === 0, 'Weekday task hidden on Sunday');

console.log('Flow: edit schedule starts tomorrow; archive keeps today');
page.on('dialog', (d) => d.accept());
await tid('tab-tasks').click();
await tid('task-Read 10 pages').click();
await tid('pattern-weekdays').click();
await tid('wd-1').click();
await tid('save-task').click();
await page.getByText('Starts tomorrow').waitFor();
check(true, 'Schedule edit shows "Starts tomorrow"');
await tid('tab-today').click();
check(await tid('task-row-Read 10 pages').isVisible(), 'Old version still on today (Sunday)');
await tid('tab-tasks').click();
await tid('task-Clean apartment').click();
await tid('archive-task').click();
await tid('new-task').waitFor();
check((await tid('task-Clean apartment').count()) === 0, 'Archived task leaves the list');
await tid('tab-today').click();
check(await tid('task-row-Clean apartment').isVisible(), 'Archived task still counts today');

console.log('Flow: daily photos (live camera)');
async function takePhoto(shot) {
  await tid('cam-video').waitFor();
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="cam-video"]');
    return v && v.videoWidth > 0;
  });
  await tid('shutter').click();
  await tid('capture-preview').waitFor();
  if (shot) await page.screenshot({ path: `screenshots/${shot}.png` });
  await tid('capture-use').click();
}
async function takeBoth(first) {
  await tid('tab-today').click();
  await tid('photo-row').click();
  await tid('capture').waitFor();
  if (first) {
    await tid('cam-video').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="cam-video"]')?.videoWidth > 0);
    await page.screenshot({ path: 'screenshots/photo-camera.png' });
  }
  await takePhoto(first ? 'photo-preview' : null);
  await takePhoto(null);
  await tid('capture-done').waitFor();
  if (first) await page.screenshot({ path: 'screenshots/photo-done.png' });
  await tid('capture-done').click();
  await page.waitForSelector('[data-testid="photo-row"][data-state="done"]');
}
check((await tid('photo-row').getAttribute('data-state')) === 'open', 'Photo item starts open');
check((await page.locator('.checklist').first().getByTestId('photo-row').count()) === 1, 'Photo item is at the top');
await takeBoth(true);
check((await page.locator('[data-testid="photo-thumbs"] img').count()) === 2, 'Photo item done with two thumbnails');
const camInfo = await page.evaluate(() => ({
  opened: window.__streams.length,
  live: window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length,
}));
check(camInfo.opened > 0 && camInfo.live === 0, `Camera tracks stopped after closing (${camInfo.opened} opened, ${camInfo.live} live)`);
await page.screenshot({ path: 'screenshots/today-photos.png' });

console.log('Flow: retake today, then next day');
await tid('photo-row').click();
await tid('retake-face').click();
await takePhoto(null);
await tid('capture-done').click();
await page.waitForSelector('[data-testid="photo-row"][data-state="done"]');
check(true, 'Retake today works');
await setNow('2026-11-23T18:00:00Z');
await tid('photo-row').waitFor();
check((await tid('photo-row').getAttribute('data-state')) === 'open', 'New day: photo item open again');
await takeBoth(false);

console.log('Flow: Photos tab feed, viewer, compare');
await tid('tab-photos').click();
await tid('photo-day-2026-11-23').waitFor();
check(await tid('photo-day-2026-11-22').isVisible(), 'Feed shows both days (newest first)');
const order = await page.$$eval('[data-testid^="photo-day-"]', (els) => els.map((e) => e.dataset.testid));
check(order[0] === 'photo-day-2026-11-23', 'Newest day first');
check((await tid('photo-day-2026-11-23').getByTestId('photo-inset').count()) === 1, 'Day card has face inset');
check((await tid('photo-day-2026-11-23').textContent()).includes('Day 8'), 'Day number shown (Day 8)');
await page.waitForFunction(() => [...document.querySelectorAll('.pcard img')].every((i) => i.complete && i.naturalWidth > 0));
await page.screenshot({ path: 'screenshots/photos-feed.png' });
await tid('photo-day-2026-11-22').locator('.pcard-main').click();
await tid('viewer').waitFor();
check((await tid('viewer-body').getAttribute('aria-selected')) === 'true', 'Viewer opens on body');
await tid('viewer-stage').click();
check((await tid('viewer-face').getAttribute('aria-selected')) === 'true', 'Tap switches to face');
await page.screenshot({ path: 'screenshots/photos-viewer.png' });
await tid('viewer-close').click();
check((await tid('viewer').count()) === 0, 'Viewer closes');
await tid('photos-compare').click();
await tid('compare-a-img').waitFor();
await page.waitForFunction(() =>
  ['compare-a-img', 'compare-b-img'].every((id) => {
    const i = document.querySelector(`[data-testid="${id}"]`);
    return i && i.complete && i.naturalWidth > 0;
  }),
);
check((await tid('compare-a').inputValue()) === '2026-11-22', 'Compare defaults to first day');
check((await tid('compare-b').inputValue()) === '2026-11-23', 'Compare defaults to latest day');
await tid('compare-face').click();
check((await tid('compare-a-img').getAttribute('alt')).startsWith('face'), 'Compare toggles to face');
await page.screenshot({ path: 'screenshots/photos-compare.png' });
const imgSize = await page.evaluate(async () => {
  const src = document.querySelector('[data-testid="compare-a-img"]').src;
  return (await (await fetch(src)).blob()).size;
});
check(imgSize > 0 && imgSize < 350 * 1024, `Saved photo is small (${Math.round(imgSize / 1024)} KB)`);

console.log('Flow: camera permission denied');
{
  const c3 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await c3.addInitScript(() => {
    window.__TEST_NOW__ = '2026-11-16T17:00:00Z';
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });
  const p3 = await c3.newPage();
  await p3.goto(BASE);
  await p3.getByTestId('photo-row').click();
  await p3.getByTestId('cam-error').waitFor();
  check((await p3.getByTestId('cam-error').textContent()).includes('Settings'), 'Denied camera explains the iPhone Settings path');
  check(await p3.getByTestId('cam-retry').isVisible(), 'Denied camera has a Try again button');
  await p3.screenshot({ path: 'screenshots/photo-denied.png' });
  await c3.close();
}

console.log('Layout: no horizontal scroll');
for (const tab of ['tab-today', 'tab-photos', 'tab-tasks']) {
  await tid(tab).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, `${tab}: no horizontal scroll at 390px`);
}
const ctx2 = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
const p2 = await ctx2.newPage();
await p2.goto(BASE);
await p2.getByTestId('tab-today').waitFor();
check(!(await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no horizontal scroll at 320px');

check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
await browser.close();
stop();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll browser checks passed');
process.exit(failures ? 1 : 0);
