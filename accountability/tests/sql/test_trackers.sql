\set ON_ERROR_STOP 1
\o /dev/null
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

-- Friday Nov 13: log a weight
set test.today = '2026-11-13';
insert into tracker_entries (tracker_key, day, value) values ('weight', '2026-11-13', '{"v": 182.4}');

-- Monday Nov 16: today is fine, and can be changed or removed
set test.today = '2026-11-16';
insert into tracker_entries (tracker_key, day, value) values ('weight', '2026-11-16', '{"v": 182.2}');
update tracker_entries set value = '{"v": 182.0}' where tracker_key = 'weight' and day = '2026-11-16';
select pg_temp.expect((select value->>'v' from tracker_entries where day = '2026-11-16') = '182.0', 'today''s value updated');
delete from tracker_entries where day = '2026-11-16';
insert into tracker_entries (tracker_key, day, value) values ('weight', '2026-11-16', '{"v": 182.0}');
insert into tracker_entries (tracker_key, day, value) values ('notes', '2026-11-16', '{"text": "slept badly"}');

-- no backfilling, no future
select pg_temp.expect_fail($$insert into tracker_entries (tracker_key, day, value) values ('weight', '2026-11-15', '{"v": 180}')$$, 'Past days are locked');
select pg_temp.expect_fail($$insert into tracker_entries (tracker_key, day, value) values ('weight', '2026-11-17', '{"v": 180}')$$, 'future');
select pg_temp.expect_fail($$update tracker_entries set value = '{"v": 170}' where day = '2026-11-13'$$, 'Past days are locked');
select pg_temp.expect_fail($$delete from tracker_entries where day = '2026-11-13'$$, 'Past days are locked');
-- the upsert path can't overwrite a past day either
select pg_temp.expect_fail($$insert into tracker_entries (tracker_key, day, value) values ('weight', '2026-11-13', '{"v": 170}') on conflict (user_id, tracker_key, day) do update set value = excluded.value$$, 'Past days are locked');
-- yesterday's entry is locked once the day is over
set test.today = '2026-11-17';
select pg_temp.expect_fail($$update tracker_entries set value = '{"v": 1}' where day = '2026-11-16'$$, 'Past days are locked');
select pg_temp.expect_fail($$delete from tracker_entries where day = '2026-11-16'$$, 'Past days are locked');
set test.today = '2026-11-16';

-- entries can't be moved; timestamps and owner are server-set
select pg_temp.expect_fail($$update tracker_entries set day = '2026-11-15' where day = '2026-11-16'$$, 'permission denied');
select pg_temp.expect_fail($$update tracker_entries set tracker_key = 'other' where day = '2026-11-16'$$, 'permission denied');
select pg_temp.expect_fail($$update tracker_entries set created_at = '2020-01-01'$$, 'permission denied');
select pg_temp.expect_fail($$insert into tracker_entries (tracker_key, day, value, created_at) values ('mood', '2026-11-16', '{"v": 1}', '2020-01-01')$$, 'permission denied');
select pg_temp.expect_fail($$insert into tracker_entries (user_id, tracker_key, day, value) values ('22222222-2222-2222-2222-222222222222', 'mood', '2026-11-16', '{"v": 1}')$$, 'permission denied');

-- tracker_key format and value shape
select pg_temp.expect_fail($$insert into tracker_entries (tracker_key, day, value) values ('Weight', '2026-11-16', '{"v": 1}')$$, 'check constraint');
select pg_temp.expect_fail($$insert into tracker_entries (tracker_key, day, value) values ('1abc', '2026-11-16', '{"v": 1}')$$, 'check constraint');
select pg_temp.expect_fail($$insert into tracker_entries (tracker_key, day, value) values ('a-b', '2026-11-16', '{"v": 1}')$$, 'check constraint');
select pg_temp.expect_fail($$insert into tracker_entries (tracker_key, day, value) values ('abcdefghijklmnopqrstuvwxyzabcdef', '2026-11-16', '{"v": 1}')$$, 'check constraint');
insert into tracker_entries (tracker_key, day, value) values ('sleep_hours_2', '2026-11-16', '{"v": 7.5}');
select pg_temp.expect_fail($$insert into tracker_entries (tracker_key, day, value) values ('mood', '2026-11-16', '{"v": "high"}')$$, 'check constraint');
select pg_temp.expect_fail($$insert into tracker_entries (tracker_key, day, value) values ('mood', '2026-11-16', '[1, 2]')$$, 'check constraint');
select pg_temp.expect_fail($$insert into tracker_entries (tracker_key, day, value) values ('mood', '2026-11-16', '{"text": 5}')$$, 'check constraint');
select pg_temp.expect_fail($$insert into tracker_entries (tracker_key, day) values ('mood', '2026-11-16')$$, 'null value');

-- privacy: another user sees nothing and can't touch my entries
set test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect((select count(*) from tracker_entries) = 0, 'RLS: user 2 sees no rows of user 1');
update tracker_entries set value = '{"v": 1}';
delete from tracker_entries;
insert into tracker_entries (tracker_key, day, value) values ('weight', '2026-11-16', '{"v": 150}');
select pg_temp.expect((select count(*) from tracker_entries) = 1, 'user 2 sees only their own row');
set test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.expect((select count(*) from tracker_entries) = 4, 'user 1 rows untouched by user 2');
select pg_temp.expect((select value->>'v' from tracker_entries where tracker_key = 'weight' and day = '2026-11-16') = '182.0', 'user 1 value untouched');

-- anonymous visitors get nothing
reset role;
set role anon;
select pg_temp.expect_fail($$select * from tracker_entries$$, 'permission denied');

reset role;
\o
\echo 'tracker SQL tests passed'
