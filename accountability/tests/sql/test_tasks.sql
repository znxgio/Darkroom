\set ON_ERROR_STOP 1
\o /dev/null
-- Helper: expect a statement to fail with a message.
create or replace function pg_temp.expect_fail(sql text, msg text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if position(msg in sqlerrm) = 0 then
      raise exception 'expected error "%" but got "%" for: %', msg, sqlerrm, sql;
    end if;
    return;
  end;
  raise exception 'expected failure "%" but it succeeded: %', msg, sql;
end $$;
grant execute on function pg_temp.expect_fail(text, text) to authenticated;
create or replace function pg_temp.expect(cond boolean, what text) returns void language plpgsql as $$
begin
  if not cond then raise exception 'expectation failed: %', what; end if;
end $$;
grant execute on function pg_temp.expect(boolean, text) to authenticated;

set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';

-- Seed: tasks created on Nov 1.
set test.today = '2026-11-01';
insert into tasks (id, name, kind, pattern) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Gym', 'recurring', 'daily');
insert into tasks (id, name, kind, pattern) values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Call mom', 'recurring', 'weekly_any');
insert into tasks (id, name, kind, one_time_date) values
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Pay rent', 'one_time', '2026-11-10');

-- Monday Nov 16
set test.today = '2026-11-16';

-- today: done, undo, skip w/o reason fails, skip w/ reason ok
insert into task_logs (task_id, day, status) values ('aaaaaaaa-0000-0000-0000-000000000001', '2026-11-16', 'done');
delete from task_logs where day = '2026-11-16';
select pg_temp.expect_fail($$insert into task_logs (task_id, day, status) values ('aaaaaaaa-0000-0000-0000-000000000001', '2026-11-16', 'skipped')$$, 'needs a reason');
insert into task_logs (task_id, day, status, reason) values ('aaaaaaaa-0000-0000-0000-000000000001', '2026-11-16', 'skipped', 'sick');
update task_logs set status = 'done', reason = null where day = '2026-11-16';

-- no backfilling
select pg_temp.expect_fail($$insert into task_logs (task_id, day, status) values ('aaaaaaaa-0000-0000-0000-000000000001', '2026-11-15', 'done')$$, 'Past days are locked');
select pg_temp.expect_fail($$insert into task_logs (task_id, day, status, reason) values ('aaaaaaaa-0000-0000-0000-000000000001', '2026-11-15', 'skipped', 'x')$$, 'Past days are locked');
select pg_temp.expect_fail($$insert into task_logs (task_id, day, status) values ('aaaaaaaa-0000-0000-0000-000000000001', '2026-11-17', 'done')$$, 'future');
select pg_temp.expect_fail($$insert into task_logs (task_id, day, status) values ('aaaaaaaa-0000-0000-0000-000000000001', '2026-11-16', 'missed')$$, 'isn''t over');
-- upsert of a "missed" over a past done must not overwrite it (PostgREST upsert path)
set test.today = '2026-11-17';
select pg_temp.expect_fail($$insert into task_logs (task_id, day, status, reason) values ('aaaaaaaa-0000-0000-0000-000000000001', '2026-11-16', 'missed', 'x') on conflict (task_id, day) do update set status = excluded.status, reason = excluded.reason$$, 'Past days are locked');
set test.today = '2026-11-16';

-- a miss can be recorded for a past day, its reason filled once, then it is frozen
insert into task_logs (task_id, day, status) values ('aaaaaaaa-0000-0000-0000-000000000001', '2026-11-14', 'missed');
update task_logs set reason = 'overslept' where day = '2026-11-14';
select pg_temp.expect_fail($$update task_logs set reason = 'changed' where day = '2026-11-14'$$, 'Past days are locked');
select pg_temp.expect_fail($$update task_logs set status = 'done' where day = '2026-11-14'$$, 'Past days are locked');
select pg_temp.expect_fail($$delete from task_logs where day = '2026-11-14'$$, 'Past days are locked');

-- an entry can't be moved to another day or task
select pg_temp.expect_fail($$update task_logs set day = '2026-11-13' where day = '2026-11-16'$$, 'can''t be moved');
select pg_temp.expect_fail($$update task_logs set task_id = 'aaaaaaaa-0000-0000-0000-000000000002' where day = '2026-11-16'$$, 'can''t be moved');
-- PostgREST-style upserts work for today (insert, then update via conflict)
insert into task_logs (task_id, day, status, reason) values ('aaaaaaaa-0000-0000-0000-000000000003', '2026-11-16', 'done', null)
  on conflict (task_id, day) do update set task_id = excluded.task_id, day = excluded.day, status = excluded.status, reason = excluded.reason;
insert into task_logs (task_id, day, status, reason) values ('aaaaaaaa-0000-0000-0000-000000000003', '2026-11-16', 'skipped', 'busy')
  on conflict (task_id, day) do update set task_id = excluded.task_id, day = excluded.day, status = excluded.status, reason = excluded.reason;
delete from task_logs where task_id = 'aaaaaaaa-0000-0000-0000-000000000003';

-- weekly_any: no skipping before Sunday
select pg_temp.expect_fail($$insert into task_logs (task_id, day, status, reason) values ('aaaaaaaa-0000-0000-0000-000000000002', '2026-11-16', 'skipped', 'busy')$$, 'only be skipped on Sunday');
set test.today = '2026-11-22';
insert into task_logs (task_id, day, status, reason) values ('aaaaaaaa-0000-0000-0000-000000000002', '2026-11-22', 'skipped', 'busy');
set test.today = '2026-11-16';

-- yesterday's done entry can't be undone once the day is over
set test.today = '2026-11-17';
select pg_temp.expect_fail($$delete from task_logs where day = '2026-11-16'$$, 'Past days are locked');
select pg_temp.expect_fail($$update task_logs set status = 'skipped', reason = 'x' where day = '2026-11-16'$$, 'Past days are locked');
set test.today = '2026-11-16';

-- TASKS CAN'T REWRITE HISTORY
-- H1: schedule edits on a started task
select pg_temp.expect_fail($$update tasks set pattern = 'weekdays', weekdays = '{1,2,3,4,5}' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'new task from tomorrow');
select pg_temp.expect_fail($$update tasks set start_date = '2026-11-16' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'new task from tomorrow');
-- H1: move a missed one-time task to today to check it off
select pg_temp.expect_fail($$update tasks set one_time_date = '2026-11-16' where id = 'aaaaaaaa-0000-0000-0000-000000000003'$$, 'still upcoming');
-- H2: archive into the past, archive today, un-archive
select pg_temp.expect_fail($$update tasks set archived_on = '2026-11-10' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'takes effect tomorrow');
select pg_temp.expect_fail($$update tasks set archived_on = '2026-11-16' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'takes effect tomorrow');
update tasks set archived_on = '2026-11-17' where id = 'aaaaaaaa-0000-0000-0000-000000000003';
select pg_temp.expect_fail($$update tasks set archived_on = null where id = 'aaaaaaaa-0000-0000-0000-000000000003'$$, 'can''t be undone');
-- H3: delete a started task, even with no logs
select pg_temp.expect_fail($$delete from tasks where id = 'aaaaaaaa-0000-0000-0000-000000000003'$$, 'archive it instead');
select pg_temp.expect_fail($$delete from tasks where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'archive it instead');
-- new tasks can't start in the past
select pg_temp.expect_fail($$insert into tasks (name, kind, pattern, start_date) values ('x', 'recurring', 'daily', '2026-11-01')$$, 'start in the past');
select pg_temp.expect_fail($$insert into tasks (name, kind, one_time_date) values ('x', 'one_time', '2026-11-15')$$, 'in the past');
-- allowed: rename, goal time, critical; delete a task added today with nothing logged
update tasks set name = 'Gym (AM)', goal_time = '07:00', critical = true where id = 'aaaaaaaa-0000-0000-0000-000000000001';
insert into tasks (id, name, kind, pattern) values ('aaaaaaaa-0000-0000-0000-000000000009', 'Oops', 'recurring', 'daily');
delete from tasks where id = 'aaaaaaaa-0000-0000-0000-000000000009';
-- allowed: move an upcoming one-time task to another upcoming day
insert into tasks (id, name, kind, one_time_date) values ('aaaaaaaa-0000-0000-0000-000000000008', 'Dentist', 'one_time', '2026-11-20');
update tasks set one_time_date = '2026-11-21' where id = 'aaaaaaaa-0000-0000-0000-000000000008';
-- allowed: schedule change on a task that starts tomorrow (the "new task" half of an edit)
insert into tasks (id, name, kind, pattern, start_date) values ('aaaaaaaa-0000-0000-0000-000000000007', 'Gym v2', 'recurring', 'daily', '2026-11-17');
update tasks set pattern = 'weekdays', weekdays = '{1,2,3,4,5}' where id = 'aaaaaaaa-0000-0000-0000-000000000007';
-- created_at is server-controlled
select pg_temp.expect_fail($$update tasks set created_at = '2020-01-01' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'permission denied');

-- privacy: another user sees nothing and can't log against my task
set test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect((select count(*) from tasks) = 0 and (select count(*) from task_logs) = 0, 'RLS: user 2 sees no rows of user 1');
select pg_temp.expect_fail($$insert into task_logs (task_id, day, status) values ('aaaaaaaa-0000-0000-0000-000000000001', '2026-11-16', 'done')$$, 'violates');
select pg_temp.expect_fail($$insert into task_logs (task_id, user_id, day, status) values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '2026-11-16', 'done')$$, 'row-level security');

-- shape checks
set test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.expect_fail($$insert into tasks (name, kind, pattern, weekdays) values ('x', 'recurring', 'weekly_day', '{1,2}')$$, 'check constraint');
select pg_temp.expect_fail($$insert into tasks (name, kind) values ('x', 'one_time')$$, 'check constraint');
select pg_temp.expect_fail($$insert into tasks (name, kind, pattern, weekdays) values ('x', 'recurring', 'weekdays', '{9}')$$, 'check constraint');

-- anonymous visitors get nothing
reset role;
set role anon;
select pg_temp.expect_fail($$select * from tasks$$, 'permission denied');

reset role;
\o
\echo 'SQL tests passed'
