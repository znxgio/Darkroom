# Daily — accountability + checklist app: working notes

Read this first in any new session.

## How the owner likes to work
- Short, casual texts from a phone, sometimes with typos. Read for what they mean; ask one short question only if truly unclear.
- They're not a developer. Explain plainly. Recommend one option instead of listing choices.
- Short replies: what was done, what they need to do, what's next.
- "reply first" / "no action taken" / "let's talk about" → answer only, change nothing. Wait for "go".
- "pause" / "I'm testing" → don't push.
- Ask before anything that costs money. Free tiers OK; warn if something will cost money later.
- One combined push per round of requests. After each push, give exact steps to test on the phone.
- Research answers need sources.
- Repo is PUBLIC: never commit secrets, emails, personal data or photos. No AI model names in commits or code.
- Test before every push: `npm test`, `npm run test:sql`, `npm run build && npm run e2e`.
- Use helpers for bigger work; advisors when a bug survives 2 fixes or for risky or tradeoff decisions.
- **UI matters a lot to them.** Polish the look and feel; don't ship plain or default-looking screens.
- **They love new ideas.** Suggest and add small or big ideas they wouldn't think of, then tell them what was added.
- When they're asleep or away, they've handed full control to me: decide, debate when unsure, keep building. Money and privacy calls still wait for them.

## Stack and why
- **React + TypeScript + Vite**: a static app hosted on **Vercel**, free Hobby plan. App code lives in `accountability/`.
- **Supabase** (free plan) for login, the Postgres database and private photo storage.
- **Reminders use Supabase's built-in scheduler (pg_cron) + an Edge Function, not Vercel cron.** Vercel Hobby cron runs only once a day (https://vercel.com/docs/cron-jobs/usage-and-pricing).
- **Login: email + password, not a magic link.** On iOS a magic link opens in Safari, not the Home Screen app, which keeps separate storage. Turn off sign-ups in Supabase after the owner's account exists.
- **Demo mode**: with no Supabase keys set, the app runs on an in-browser store (`src/data/memoryRepo.ts`). Tests and the browser check use it too.
- The free Supabase plan pauses after about 1 week with no activity (https://supabase.com/docs/guides/platform/free-project-pausing). Daily use avoids that; the reminder cron may also keep it active.

## Decisions (owner said "go with your picks", 2026-11-16)
- **An excused skip still counts as a miss** for the streak, calendar and score. The reason is logged.
- **"Weekly" has two flavors**: `weekly_day` (e.g. every Sunday) and `weekly_any` (once, any day Mon–Sun). A `weekly_any` task that's still open is a miss only on Sunday.
- **Weeks run Mon–Sun.** The Sunday review opens Sunday.
- **Photo reminder** defaults to 8 AM (can be changed). *(stage 2/3)*
- **The day boundary is midnight America/Los_Angeles.** "Today" comes from the server (`today_la()` RPC) so a wrong phone clock doesn't matter.
- **No backfilling is enforced in the database** (trigger `guard_task_log`):
  - today: done, skip (reason required) or undo
  - past days: locked, except recording a miss and filling in its reason once
  - future days: nothing
- **Tasks with history are archived, never deleted.** `archived_on` stops a task counting from that day on.
- **Streak**: consecutive green days. Gray days (nothing scheduled) don't break it. Today counts once it's complete; a skip today sets it to 0.
- **Weekly score**: done ÷ counted. Items still open today are left out.
- **Planned**: a nightly "close the day" job will freeze each day's result into a `day_results` table, so later task edits never rewrite history. Until stage 4, past days are computed from tasks + logs.
- **Stakes email**: free senders like Resend need a verified (paid) domain to email other people. Plan: send through the owner's Gmail with an app password (free). Texting costs money; ask first.

## Data model
- `tasks`, `task_logs` (stage 1). Planned: `photos`, `day_results`, `weekly_reviews`, `tracker_entries` (generic: tracker_key, day, value jsonb), `push_subscriptions`, `reminders_sent`, `settings`.
- The rules are written twice: TypeScript (`src/lib/schedule.ts`) for the UI and SQL for server jobs. Keep them in sync; tests cover both.

## Setup done
- (none yet: the owner still needs to create the Supabase + Vercel accounts; steps are in README.md)

## Stages
1. Tasks + check-off: **built, not deployed**
2. Photos
3. Reminders (push)
4. Streak, calendar, weekly score, excuse log + missed-reason prompt, Sunday review
5. Weight log (as the first modular tracker)
6. Stakes

## Bugs & causes
- `scripts/test-sql.sh`: as root, Postgres must be stopped with `runuser -u postgres`, or the server is left running.

## Open to-dos
- Owner: create Supabase + Vercel accounts and deploy (README.md).
- Stage 4: nightly close-day job (pg_cron) + `day_results`.
