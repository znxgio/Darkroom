// Phone-width browser check of the main flows, in demo mode with a fake clock.
// Usage: npm run build && npm run e2e   (screenshots go to ./screenshots, git-ignored)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    // --strictPort exits if the port is taken; never test someone else's server.
    if (serverExited) throw new Error(`port ${PORT} is in use; rerun with E2E_PORT=<free port>`);
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
for (const tab of ['tab-today', 'tab-progress', 'tab-tasks']) {
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

check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
await browser.close();
stop();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll browser checks passed');
process.exit(failures ? 1 : 0);
