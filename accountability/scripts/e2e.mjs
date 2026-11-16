// Phone-width browser check of the main flows, in demo mode with a fake clock.
// Usage: npm run build && npm run e2e   (screenshots go to ./screenshots, git-ignored)
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// Uses the machine's Playwright if installed globally, else a local one.
const { chromium } = createRequire(import.meta.url)('playwright');

// Another checkout may already be serving 4179: pick a free one with E2E_PORT=4501 npm run e2e.
const PORT = Number(process.env.E2E_PORT) || 4179;
const BASE = `http://localhost:${PORT}`;
mkdirSync('screenshots', { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
  detached: true, // own process group, so stop() also ends vite (not just npx)
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

// Another checkout's preview server may already hold the port: make sure it's serving OUR build.
const builtIndex = readFileSync('dist/index.html', 'utf8');
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    // --strictPort exits if the port is taken; never test someone else's server.
    if (serverExited) throw new Error(`port ${PORT} is in use; rerun with E2E_PORT=<free port>`);
    try {
      const r = await fetch(BASE);
      if (r.ok && (await r.text()) === builtIndex) return;
      if (r.ok && server.exitCode !== null)
        throw new Error(`port ${PORT} is serving another build; rerun with E2E_PORT=<free port>`);
    } catch (e) {
      if (String(e).includes('another build')) throw e;
    }
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
// Daily photos start counting on Mon Nov 23 in this script (the photo flows begin then);
// the earlier days test tasks alone.
await page.evaluate(() =>
  localStorage.setItem(
    'accountability-test:settings',
    JSON.stringify({
      photos_from: '2026-11-23', photo_reminder_time: '08:00', stakes_enabled: false, stakes_scope: 'critical',
      stakes_name: null, stakes_email: null, stakes_channel: 'email', nudge_time: '21:00', my_name: null,
      stakes_since: null, claude_photo_access: false,
    }),
  ),
);
await page.reload();
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
check((await tid('miss-gate').count()) === 0, 'No missed-reason prompt when nothing was missed');

/** Answers every missed-reason prompt; returns the titles it answered. */
async function answerGate(reasonFor) {
  const titles = [];
  while ((await tid('miss-gate').count()) > 0) {
    const title = (await tid('gate-title').textContent()) ?? '';
    await tid('gate-reason').fill(reasonFor(title, titles.length));
    await tid('gate-save').click();
    await page.waitForFunction(
      (prev) => document.querySelector('[data-testid=gate-title]')?.textContent !== prev,
      title,
    );
    titles.push(title);
  }
  return titles;
}

console.log('Flow: two days later — the missed-reason prompt blocks the app');
await setNow('2026-11-19T17:00:00Z'); // Wednesday; Tue + Wed went unchecked
await tid('miss-gate').waitFor();
check((await tid('gate-title').textContent())?.includes('Gym') && (await tid('gate-title').textContent())?.includes('Tue, Nov 17'), 'Prompt names the task and day');
const covered = await page.evaluate(() => {
  const el = document.querySelector('[data-testid=tab-progress]');
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return !el.contains(top) && !!top?.closest('[data-testid=miss-gate]');
});
check(covered, 'Prompt covers the whole app (tab bar unreachable)');
check(await tid('gate-save').isDisabled(), 'Prompt needs a reason (save disabled when empty)');
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/gate.png' });
await page.reload();
await tid('miss-gate').waitFor();
check(true, 'Prompt comes back after reload until answered');
const gateReasons = ['Overslept, too tired', 'Too tired after work', 'Work ran late', 'Fell asleep early, tired'];
const answered = await answerGate((_t, i) => gateReasons[i] ?? 'Busy');
check(answered.length === 4, `Asked about each of the 4 misses (${answered.length})`);
await page.reload();
await tid('task-row-Gym').waitFor();
check((await tid('miss-gate').count()) === 0, 'Prompt gone once every miss has a reason');
await tid('task-row-Gym').click();
await tid('task-row-Read 10 pages').click();

console.log('Flow: Progress tab');
await tid('tab-progress').click();
await tid('streak').waitFor();
check((await tid('streak').textContent()) === '1', 'Streak is 1 (today complete after misses)');
check((await tid('best-streak').textContent()) === '1', 'Best streak is 1');
check((await tid('cal-2026-11-17').getAttribute('data-color')) === 'red', 'Calendar: missed day is red');
check((await tid('cal-2026-11-19').getAttribute('data-color')) === 'green', 'Calendar: complete day is green');
check((await tid('cal-2026-11-20').count()) === 0, 'Calendar: future days are blank');
check((await tid('week-score').textContent())?.includes('4 of 9'), `Weekly score counts done/counted (${await tid('week-score').textContent()})`);
check((await tid('last-week-score').textContent())?.includes('—'), 'No data last week');
check((await tid('patterns').textContent())?.includes('tired'), 'Patterns pick up a common word');
await page.screenshot({ path: 'screenshots/progress.png', fullPage: true });
await tid('filter-Gym').click();
const excuseTexts = await tid('excuse-list').locator('li').allTextContents();
check(excuseTexts.length === 2 && excuseTexts.every((t) => t.includes('Gym')), 'Excuse log filters by task');
await tid('cal-2026-11-17').click();
await tid('day-sheet').waitFor();
await page.waitForTimeout(300); // let the sheet finish sliding in
check((await tid('detail-Gym').getAttribute('data-state')) === 'missed', 'Day sheet: Gym missed');
check((await tid('detail-Gym').textContent())?.includes('Overslept'), 'Day sheet shows the reason');
await page.screenshot({ path: 'screenshots/day-sheet.png' });
await tid('day-sheet-close').click();

console.log('Flow: Thu + Sat done, nothing to explain');
await setNow('2026-11-20T17:00:00Z');
await tid('task-row-Gym').waitFor();
check((await tid('miss-gate').count()) === 0, 'No prompt after a complete day');
await tid('task-row-Gym').click();
await tid('task-row-Read 10 pages').click();
await setNow('2026-11-21T17:00:00Z');
await tid('task-row-Read 10 pages').click();

console.log('Flow: Sunday shows weekly task, not Gym');
await setNow('2026-11-22T18:00:00Z');
await tid('task-row-Clean apartment').waitFor();
check((await tid('task-row-Gym').count()) === 0, 'Weekday task hidden on Sunday');

console.log('Flow: Sunday review');
await tid('tab-progress').click();
await tid('streak').waitFor();
check((await tid('streak').textContent()) === '3', 'Streak is 3 (Wed–Sat, today in progress)');
check((await tid('open-review').getAttribute('class'))?.includes('hl'), 'Review card highlighted on Sunday');
await tid('open-review').click();
await tid('review').waitFor();
check((await tid('review-week').textContent())?.includes('Nov 16'), 'Review opens on this week');
check((await tid('review-missed').count()) === 4, 'Review lists the 4 misses');
check((await tid('review-skipped').count()) === 1, 'Review lists the skip');
await tid('review-note').fill('Gym before work, phone away by 10');
await tid('review-save').click();
await tid('review-saved').waitFor();
await page.screenshot({ path: 'screenshots/review.png', fullPage: true });
await page.reload();
await tid('tab-progress').click();
await tid('open-review').click();
check((await tid('review-note').inputValue()) === 'Gym before work, phone away by 10', 'Review note persisted');
await tid('review-back').click();
await tid('tab-today').click();

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
await page.waitForTimeout(800); // the missed-reason prompt loads just after the page
await answerGate(() => 'Long weekend');
check((await tid('photo-row').getAttribute('data-state')) === 'open', 'New day: photo item open again');
await takeBoth(false);

console.log('Flow: Photos tab feed, viewer, compare');
await tid('tab-photos').click();
await tid('photo-day-2026-11-23').waitFor();
check(await tid('photo-day-2026-11-22').isVisible(), 'Feed shows both days (newest first)');
const order = await page.$$eval('[data-testid^="photo-day-"]', (els) => els.map((e) => e.dataset.testid));
check(order[0] === 'photo-day-2026-11-23', 'Newest day first');
check((await tid('photo-day-2026-11-23').getByTestId('photo-inset').count()) === 1, 'Day card has face inset');
check((await tid('photo-day-2026-11-23').textContent()).includes('Day 2'), 'Day number shown (Day 2)');
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

console.log('Flow: next Sunday — answer the week, see last week\'s note');
await setNow('2026-11-29T18:00:00Z');
await tid('miss-gate').waitFor();
const later = await answerGate(() => 'Travelling');
check(later.length >= 2, `Prompt covers a whole week of misses (${later.length})`);
await tid('tab-progress').click();
await tid('open-review').click();
await tid('last-note').waitFor();
check((await tid('last-note').textContent())?.includes('Gym before work'), 'Review shows "Last week you said"');
await page.screenshot({ path: 'screenshots/review-next.png', fullPage: true });
await tid('review-back').click();

console.log('Layout: no horizontal scroll');
for (const tab of ['tab-today', 'tab-photos', 'tab-progress', 'tab-tasks', 'tab-settings']) {
  await tid(tab).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, `${tab}: no horizontal scroll at 390px`);
}
const ctx2 = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
const p2 = await ctx2.newPage();
await p2.goto(BASE);
await p2.getByTestId('tab-today').waitFor();
await p2.getByTestId('tab-progress').click();
await p2.getByText('Progress', { exact: true }).first().waitFor();
check(!(await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no horizontal scroll at 320px');
await ctx2.close();

console.log('Flow: weight log on three days');
// Horizontal overflow of the page or of the full-screen detail view.
const overflowsX = (p) =>
  p.evaluate(() => {
    const d = document.querySelector('.detail');
    return document.documentElement.scrollWidth > window.innerWidth || (d ? d.scrollWidth > d.clientWidth : false);
  });
const logWeight = async (value) => {
  const t = Date.now();
  await tid('tracker-input-weight').fill(value);
  await tid('tracker-save-weight').click();
  await tid('tracker-value-weight').waitFor();
  return Date.now() - t;
};
await setNow('2026-11-23T16:00:00Z'); // Mon 8 AM
await tid('tracker-input-weight').waitFor();
check((await tid('tracker-last-weight').textContent())?.includes('First entry'), 'Weight card: first entry prompt');
await page.screenshot({ path: 'screenshots/weight-empty.png', fullPage: true });
const ms = await logWeight('182.4');
console.log(`  (logging a weight took ${ms} ms)`);
check((await tid('tracker-value-weight').textContent())?.includes('182.4'), 'Mon: 182.4 saved');
check((await tid('tracker-change-weight').textContent())?.includes('First entry'), 'Mon: first entry, no change yet');
check((await tid('done-count').count()) === 1, 'Tasks list still there with trackers');

await setNow('2026-11-25T16:00:00Z'); // Wed
await tid('tracker-input-weight').waitFor();
check((await tid('tracker-last-weight').textContent())?.includes('Last 182.4 lb · Mon'), 'Wed: shows last entry (Mon)');
await tid('tracker-save-weight').waitFor();
check(await tid('tracker-save-weight').isDisabled(), 'Save disabled while empty');
await tid('tracker-input-weight').fill('9999');
await tid('tracker-save-weight').click();
await page.getByText('between 50 and 700').waitFor();
check(true, 'Out-of-range weight is rejected');
await logWeight('182,8'); // comma decimal from some keyboards
check((await tid('tracker-change-weight').textContent())?.trim() === '+0.4 lb since Mon', 'Wed: "+0.4 lb since Mon"');

await setNow('2026-11-27T16:00:00Z'); // Fri
await tid('tracker-input-weight').waitFor();
await logWeight('182.0');
check((await tid('tracker-change-weight').textContent())?.trim() === '−0.8 lb since Wed', 'Fri: "−0.8 lb since Wed"');
await tid('tracker-edit-weight').click();
check((await tid('tracker-input-weight').inputValue()) === '182.0', "Edit is prefilled with today's value");
await tid('tracker-input-weight').fill('181.9');
await tid('tracker-input-weight').press('Enter');
await tid('tracker-value-weight').waitFor();
check((await tid('tracker-change-weight').textContent())?.trim() === '−0.9 lb since Wed', "Today's value can be edited");
await page.reload();
await tid('tracker-value-weight').waitFor();
check((await tid('tracker-value-weight').textContent())?.includes('181.9'), 'Weight persisted after reload');
await page.screenshot({ path: 'screenshots/weight-card.png', fullPage: true });

console.log('Flow: weight detail');
await tid('tracker-open-weight').click();
await tid('tracker-detail').waitFor();
await page.waitForTimeout(300); // slide-in animation
await tid('trend-chart').waitFor();
check((await page.locator('[data-testid=trend-chart] path.avg-line').count()) === 1, 'Chart draws the 7-day average line');
check((await page.locator('[data-testid=trend-chart] circle.pt').count()) === 3, 'Chart shows 3 daily points');
check((await tid('entry-row').count()) === 3, 'History lists 3 entries');
check((await tid('stat-min').textContent()) === '181.9', 'Low = 181.9');
check((await tid('stat-max').textContent()) === '182.8', 'High = 182.8');
check((await tid('stat-latest').textContent())?.includes('181.9'), 'Latest = 181.9');
const box = await tid('trend-chart').boundingBox();
await page.mouse.click(box.x + 8, box.y + box.height / 2);
check((await tid('chart-readout').textContent())?.includes('182.4'), 'Tapping the chart shows that day (Mon 182.4)');
check(!(await overflowsX(page)), 'Detail: no horizontal scroll at 390px');
await page.screenshot({ path: 'screenshots/weight-detail-3.png' });
await tid('tracker-back').click();
check((await tid('tracker-detail').count()) === 0, 'Back closes the detail view');

console.log('Flow: weight detail with a long history');
// Synthetic demo history (not real data): ~14 months, a few skipped days.
await page.evaluate(() => {
  const out = [];
  const start = Date.UTC(2025, 8, 20);
  for (let i = 0; i < 431; i++) {
    if (i % 9 === 4 || i % 13 === 7) continue;
    const day = new Date(start + i * 86400000).toISOString().slice(0, 10);
    const v = 196 - i * 0.032 + Math.sin(i / 11) * 1.4 + Math.sin(i * 1.7) * 0.6;
    out.push({ tracker_key: 'weight', day, value: { v: Math.round(v * 10) / 10 } });
  }
  out.push({ tracker_key: 'weight', day: '2026-11-27', value: { v: 182.2 } });
  localStorage.setItem('accountability-test:trackers', JSON.stringify(out.filter((e, i, a) => a.findIndex((x) => x.day === e.day) === i)));
});
await page.reload();
await tid('tracker-value-weight').waitFor();
await page.screenshot({ path: 'screenshots/weight-card-history.png', fullPage: true });
await tid('tracker-open-weight').click();
await tid('trend-chart').waitFor();
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/weight-detail-30d.png' });
const box2 = await tid('trend-chart').boundingBox();
await page.mouse.click(box2.x + box2.width * 0.55, box2.y + box2.height / 2);
await page.screenshot({ path: 'screenshots/weight-detail-scrub.png' });
for (const r of ['90d', '1y', 'all']) {
  await tid(`range-${r}`).click();
  check((await page.locator('[data-testid=trend-chart] path.avg-line').count()) === 1, `Range ${r}: chart renders`);
  await page.screenshot({ path: `screenshots/weight-detail-${r}.png` });
}
await page.screenshot({ path: 'screenshots/weight-detail-full.png', fullPage: true });
check(!(await overflowsX(page)), 'Detail (long history): no horizontal scroll at 390px');

console.log('Layout: trackers at 320px');
await page.setViewportSize({ width: 320, height: 640 });
await page.waitForTimeout(100);
check(!(await overflowsX(page)), 'Detail: no horizontal scroll at 320px');
await page.screenshot({ path: 'screenshots/weight-detail-320.png' });
await tid('tracker-back').click();
check(!(await overflowsX(page)), 'Today with trackers: no horizontal scroll at 320px');
await tid('tracker-edit-weight').click();
check(!(await overflowsX(page)), 'Weight edit form: no horizontal scroll at 320px');
await page.screenshot({ path: 'screenshots/weight-card-320.png', fullPage: true });

check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
await browser.close();
stop();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll browser checks passed');
process.exit(failures ? 1 : 0);
