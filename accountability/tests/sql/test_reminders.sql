\set ON_ERROR_STOP 1
\o /dev/null
-- Server-only functions: setup runs as postgres, claim_* checks also pass as service_role (below).
create or replace function pg_temp.expect(cond boolean, what text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'expectation failed: %', what; end if;
end $$;

-- Seed the uploaded files (photo rows require the file to exist first).
insert into storage.objects (bucket_id, name) values
  ('photos', '44444444-4444-4444-4444-444444444444/2026-11-17/body.jpg'),
  ('photos', '44444444-4444-4444-4444-444444444444/2026-11-17/face.jpg');

-- Fresh user for these tests
insert into auth.users values ('44444444-4444-4444-4444-444444444444');
set test.uid = '44444444-4444-4444-4444-444444444444';

-- Seed on Mon Nov 9 (tasks start then; photos & settings too)
set test.today = '2026-11-09';
insert into public.settings (user_id, photo_reminder_time, nudge_time) values ('44444444-4444-4444-4444-444444444444', '08:00', '21:00');
insert into public.tasks (id, user_id, name, kind, pattern, goal_time, critical) values
  ('bbbbbbbb-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'Gym', 'recurring', 'daily', '07:00', true),
  ('bbbbbbbb-0000-0000-0000-000000000002', '44444444-4444-4444-4444-444444444444', 'Read', 'recurring', 'daily', null, false);

-- Mon Nov 16, 06:59 LA (14:59 UTC): nothing due yet
set test.today = '2026-11-16';
select pg_temp.expect((select count(*) from public.claim_reminders('2026-11-16 14:59:00+00')) = 0, 'nothing before goal time');

-- 07:01 LA: Gym due
select pg_temp.expect((select count(*) from public.claim_reminders('2026-11-16 15:01:00+00') where item_key = 'bbbbbbbb-0000-0000-0000-000000000001') = 1, 'Gym reminder at goal time');
-- not twice
select pg_temp.expect((select count(*) from public.claim_reminders('2026-11-16 15:02:00+00') where item_key = 'bbbbbbbb-0000-0000-0000-000000000001') = 0, 'Gym reminder only once');

-- 08:01: photos due (none taken) — then take photos before... (simulate already done for a different check below)
select pg_temp.expect((select count(*) from public.claim_reminders('2026-11-16 16:01:00+00') where item_key = 'photos') = 1, 'photo reminder');

-- Checked off before its time → no reminder (Tue)
set test.today = '2026-11-17';
insert into public.task_logs (task_id, user_id, day, status) values ('bbbbbbbb-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', '2026-11-17', 'done');
insert into public.photos (user_id, day, kind, path) values
  ('44444444-4444-4444-4444-444444444444', '2026-11-17', 'face', '44444444-4444-4444-4444-444444444444/2026-11-17/face.jpg'),
  ('44444444-4444-4444-4444-444444444444', '2026-11-17', 'body', '44444444-4444-4444-4444-444444444444/2026-11-17/body.jpg');
select pg_temp.expect((select count(*) from public.claim_reminders('2026-11-17 17:00:00+00') where item_key in ('bbbbbbbb-0000-0000-0000-000000000001', 'photos')) = 0, 'no reminder when already done');

-- Evening nudge lists what's open (Read) — 21:05 LA = 05:05 UTC next day
create temp table nudge as select * from public.claim_reminders('2026-11-18 05:05:00+00') where item_key = 'nudge';
select pg_temp.expect((select count(*) from nudge) = 1, 'evening nudge');
select pg_temp.expect((select body from nudge) = 'Read', 'nudge lists open items');
select pg_temp.expect((select title from nudge) = '1 thing left today', 'nudge title');

-- ---------- missed_items ----------
-- Mon 16: Gym not done, Read not done, photos not done
select pg_temp.expect((select count(*) from public.missed_items('44444444-4444-4444-4444-444444444444', '2026-11-16')) = 3, 'three misses on Mon');
-- Tue 17: Gym done, photos done, Read missed
select pg_temp.expect((select string_agg(name, ',') from public.missed_items('44444444-4444-4444-4444-444444444444', '2026-11-17')) = 'Read', 'only Read missed Tue');

-- ---------- stakes ----------
-- Off by default → nothing
select pg_temp.expect((select count(*) from public.claim_stakes('2026-11-18 09:00:00+00')) = 0, 'stakes off by default');

-- Turn on (Tue 17) — stakes_since = Nov 17
set test.today = '2026-11-17';
update public.settings set stakes_enabled = true, stakes_email = 'friend@example.com', stakes_name = 'Sam', stakes_scope = 'critical';
select pg_temp.expect((select stakes_since from public.settings where user_id = '44444444-4444-4444-4444-444444444444') = '2026-11-17', 'stakes_since set');

-- Wed 18 and Thu 19: miss Gym (critical) both days. Check at Fri 20 00:30 LA (08:30 UTC)
-- Critical scope: Tue had only a non-critical miss — but Tue < 2-day window anyway
select pg_temp.expect((select count(*) from public.claim_stakes('2026-11-19 08:30:00+00')) = 0, 'Thu morning: pair Tue/Wed — Tue only non-critical miss');
create temp table st as select * from public.claim_stakes('2026-11-20 08:30:00+00');
select pg_temp.expect((select count(*) from st) = 1, 'stakes fire after 2 critical-miss days');
select pg_temp.expect((select recipient_email from st) = 'friend@example.com', 'recipient');
select pg_temp.expect((select day1 from st) = '2026-11-18' and (select day2 from st) = '2026-11-19', 'days');
-- not again for the same pair, nor for the overlapping next pair
select pg_temp.expect((select count(*) from public.claim_stakes('2026-11-20 09:00:00+00')) = 0, 'claimed once');
select pg_temp.expect((select count(*) from public.claim_stakes('2026-11-21 08:30:00+00')) = 0, 'overlapping pair not re-sent');
-- the next separate pair (Sat/Sun... Thu 19 was in the last pair; Fri20+Sat21 → sent Sun 22)
select pg_temp.expect((select count(*) from public.claim_stakes('2026-11-22 08:30:00+00')) = 1, 'next pair sends again');

-- finish_stakes records outcome
select public.finish_stakes('44444444-4444-4444-4444-444444444444', '2026-11-19', true, 'ok');
select pg_temp.expect((select status from public.stakes_sent where day = '2026-11-19') = 'sent', 'status recorded');

-- Days before stakes were switched on never count
update public.settings set stakes_enabled = false where user_id = '44444444-4444-4444-4444-444444444444';
set test.today = '2026-11-25';
update public.settings set stakes_enabled = true where user_id = '44444444-4444-4444-4444-444444444444';
select pg_temp.expect((select count(*) from public.claim_stakes('2026-11-26 08:30:00+00')) = 0, 'pair before re-enable ignored');

-- The app can't call the server functions
set role authenticated;
do $$ begin
  begin
    perform public.claim_reminders(now());
    raise exception 'authenticated could call claim_reminders';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

\o
\echo 'reminders + stakes SQL tests passed'
\o /dev/null
-- The deployed function calls these as service_role: they must work with only the migration's grants.
set role service_role;
select count(*) from public.claim_reminders('2026-11-30 17:00:00+00');
select count(*) from public.claim_stakes('2026-11-30 17:00:00+00');
select public.finish_stakes('44444444-4444-4444-4444-444444444444', '2026-11-19', true, 'ok');
select count(*) from public.push_subscriptions;
insert into public.photo_access_log (user_id, photo_count) values ('44444444-4444-4444-4444-444444444444', 0);
reset role;
\o
\echo 'service_role can run the server functions'
