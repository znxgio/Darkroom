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
- **Tasks can't rewrite history** (database trigger `guard_task`, added after an advisor review):
  - once a task has started, its schedule is frozen; editing the schedule archives it and creates a new version from tomorrow
  - name, goal time and critical can change any time
  - archiving takes effect tomorrow (today still counts) and can't be undone
  - only a task added today with nothing logged can be deleted (to fix mistakes)
  - a one-time task can be moved only while its date is still upcoming
- **Once-a-week (any day) tasks**: only a "done" resolves the week; skipping is allowed only on Sunday.
- **Reminders**: each task fires once at its goal time if not done or skipped; photos fire at `photo_reminder_time` (default 8 AM); an evening check-in at `nudge_time` (default 9 PM) lists what's still open. A once-a-week task reminds only on Sunday (last chance).
- **Home Screen badge** shows how many items are still open (Badging API, iOS 16.4+ Home Screen apps).
- **Stakes**:
  - checked every minute by the `tick` function; fires when yesterday AND the day before both had a miss
  - only days after Stakes was switched on count (`stakes_since`)
  - photos count as critical
  - a long slump emails at most once every 2 missed days
  - you get a push when Stakes fires
- **Stakes email provider: not chosen yet.** I couldn't confirm Gmail sending (SMTP) works from Supabase functions, so the code supports Brevo (free, 300/day, sends to anyone from a verified single sender address) or Resend (needs a paid domain to email other people). Recommend Brevo; confirm with the owner before signing up.
- **The rules exist in TypeScript (`schedule.ts`) and SQL (`task_counts_on`).** Both run against `tests/fixtures/schedule-cases.json`; add a case there whenever a rule changes.
- **Streak**: consecutive green days. Gray days (nothing scheduled) don't break it. Today counts once it's complete; a skip today sets it to 0.
- **Weekly score**: done ÷ counted. Items still open today are left out.
- **Planned**: a nightly "close the day" job will freeze each day's result into a `day_results` table, so later task edits never rewrite history. Until stage 4, past days are computed from tasks + logs.
- **Stakes email**: free senders like Resend need a verified (paid) domain to email other people. Plan: send through the owner's Gmail with an app password (free). Texting costs money; ask first.

## Data model
- `tasks`, `task_logs` (stage 1). Planned: `photos`, `day_results`, `weekly_reviews`, `tracker_entries` (generic: tracker_key, day, value jsonb), `push_subscriptions`, `reminders_sent`, `settings`.
- The rules are written twice: TypeScript (`src/lib/schedule.ts`) for the UI and SQL for server jobs. Keep them in sync; tests cover both.

## Server pieces
- Migrations live in `supabase/migrations/` (apply in order).
- The Edge Function is `supabase/functions/tick`, deployed with `verify_jwt = false`; it checks the cron secret or the user's token itself.
- Scheduler: `supabase/setup/cron.sql` (fill in placeholders when running it; never commit the filled-in copy).
- Secrets go in Supabase function secrets: CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, EMAIL_PROVIDER, EMAIL_API_KEY, EMAIL_FROM.
- Vercel env vars: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_VAPID_PUBLIC_KEY.
- Deno for checking the function: `npm i deno` in a scratch folder, then `deno check` from a folder with `{"nodeModulesDir":"auto"}` (the app's package.json confuses it).

## How a Claude session views the owner's photos
The owner asked for this so they don't have to send daily photos in chat.
- Two locks: the function secret `PHOTO_ACCESS_KEY` (32+ random characters) AND Settings → "Let Claude view my photos" (default off). Every access is logged in `photo_access_log` and shown in Settings.
- In a session:
  1. Ask for the key with the `request_credential` tool: host `<project>.supabase.co`, header `x-photo-key`. Never ask for it in chat.
  2. Run `PHOTO_ACCESS_URL=https://<project>.supabase.co/functions/v1/photo-access node scripts/claude-photos.mjs --latest 7 --out <scratchpad>/photos`.
  3. Read the saved `.jpg` files. Never commit them, and never copy them anywhere public.
- The function returns each day as day, day_number, face/body links (15-minute signed URLs) and weight on that day.

## Setup done
- (none yet: the owner still needs to create the Supabase + Vercel accounts; steps are in README.md)

## Stages
All built and tested in demo mode on 2026-11-16 (night). Not deployed: needs the owner's Supabase + Vercel accounts.
1. Tasks + check-off
2. Photos (`src/features/photos`)
3. Reminders (`tick` function + `src/features/reminders`)
4. Streak, calendar, weekly score, excuse log, missed-reason gate, Sunday review (`src/features/stats`)
5. Trackers: Weight log (`src/features/trackers`). Add a tracker = one object in `registry.ts`.
6. Stakes (`tick` function + Settings)

## Photos (stage 2)
- Live camera only (getUserMedia), no file picker. Every photo is a 3:4 portrait, center-cropped, longest side 1280px, JPEG stepped 0.8→0.5 until under ~350 KB.
- Front camera: preview is mirrored and the saved photo is mirrored the same way (what you see is what you get).
- Private bucket `photos`, path `<user_id>/<YYYY-MM-DD>/<face|body>.jpg`; viewed only through 1-hour signed URLs. Today only (DB trigger + storage policies); retake = replace today's.
- Extras: self-timer (3s/10s), "Align" overlay of the last photo, per-kind camera choice remembered on the device.
- `photosRequirement(photosFrom, completeDays)` plugs photos into streak/score as an ExtraRequirement.

## Deploy checklist (from the pre-deploy code review, 2026-11-16)
- Deploy both functions with verify_jwt OFF explicitly (Management API: `verify_jwt: false`; CLI: `--no-verify-jwt`). config.toml only applies to `supabase functions deploy`.
- Functions use SUPABASE_SERVICE_ROLE_KEY, falling back to SUPABASE_SECRET_KEYS (newer projects).
- Migrations grant service_role what the server functions need; the SQL tests run `claim_*` as service_role to prove it.
- Turn off sign-ups right after creating the owner; set PHOTO_OWNER_ID for photo-access.
- Smoke test after deploy:
  - curl tick with x-cron-secret → `{reminders:0,…}` with no errors
  - curl photo-access with the key → 403 while the toggle is off
  - in the app: take/retake photos, check off a task, Settings → Send a test push
- Known and accepted: changing a task's "critical" flag changes how past days count for Stakes. A task created after its goal time sends its reminder right away. A reminder is marked sent before the push goes out, so a failed push isn't retried.

## Gotchas when merging features
- CSS class names are global. Prefix feature classes (e.g. `tk-` for trackers); `.detail` clashed once.
- PostgREST upsert updates every column sent, so column-level UPDATE grants must include the conflict-key columns (`task_logs` got `task_id`, `day`). Triggers block real changes to them.
- `npm run e2e` runs one long story through a pinned clock. Jumping days triggers the missed-reason prompt; answer it with `answerGate()`. Photos count from `photos_from`, which the script seeds as Nov 23.
- Features get the backend from `BackendContext` (`src/data/BackendContext.ts`) or a `backend` prop.

## Bugs & causes
- Day boundary: the container's clock can be on a different LA day than the test clock. Always use `repo.today()`, never `dayOf()`, in UI code.
- Git push is blocked in Auto mode. To push, the owner switches to "Accept edits" and approves; commits work in Auto.
- `npm run e2e` uses port 4179; set `E2E_PORT` when another preview server already holds it (otherwise the check silently tests the other build).
- `scripts/test-sql.sh`: as root, Postgres must be stopped with `runuser -u postgres`, or the server is left running.

## Open to-dos
- **Owner (morning):** approve the push (Accept edits → "push"); create the Supabase + Vercel accounts; give Claude a Supabase access token through the secure form. Then Claude deploys (README "What Claude does").
- **Owner decision:** Stakes email provider (recommended: Brevo, free). Stakes stays off until then.
- After deploy: run the smoke test in the "Deploy checklist" and test on the iPhone (push needs the Home Screen app).
- Small UI leftovers from the click-through: calendar cells are 31–41px (under 44px tap size), a few small buttons are 36px tall, task name field is single-line.
- Ideas not built yet:
  - a weekly summary email to yourself
  - more trackers (sleep, steps, notes): one registry entry each
  - a streak "milestone" badge (7/30/100 days)
  - a Home Screen widget isn't possible for web apps on iOS; the icon badge covers part of it

## Night of 2026-11-16: what happened
- Built all 6 stages with helpers in parallel (photos, stats, weight), plus reminders, Stakes, settings and Claude photo access myself.
- Advisor reviews:
  - stage-1 schema review: closed the history-rewrite holes
  - pre-deploy code review: service_role grants, key fallback, logging photo access before signing, settings race
- A Sonnet click-through found only UI polish items, which were fixed.
- Extras added: day-complete celebration, Home Screen badge, photo timelapse, weight on Compare, evening check-in. The photos helper added a self-timer and an "Align" overlay.
