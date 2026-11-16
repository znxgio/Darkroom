// Phone-width browser check of the main flows, in demo mode with a fake clock.
// Usage: npm run build && npm run e2e   (screenshots go to ./screenshots, git-ignored)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
// Uses the machine's Playwright if installed globally, else a local one.
const { chromium } = createRequire(import.meta.url)('playwright');

const PORT = 4179;
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
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
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

console.log('Layout: no horizontal scroll');
for (const tab of ['tab-today', 'tab-tasks']) {
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
