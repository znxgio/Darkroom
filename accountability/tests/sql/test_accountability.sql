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
grant execute on function pg_temp.expect_fail(text, text) to authenticated, anon;
create or replace function pg_temp.expect(cond boolean, what text) returns void language plpgsql as $$
begin
  if not cond then raise exception 'expectation failed: %', what; end if;
end $$;
grant execute on function pg_temp.expect(boolean, text) to authenticated;

set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';

-- WEEKLY REVIEWS (week of Mon Nov 16 2026: opens Sun Nov 22, locks after Sun Nov 29)
set test.today = '2026-11-21';
select pg_temp.expect_fail($$insert into weekly_reviews (week_start, note) values ('2026-11-16', 'early')$$, 'opens on Sunday');
set test.today = '2026-11-22';
select pg_temp.expect_fail($$insert into weekly_reviews (week_start, note) values ('2026-11-17', 'tuesday')$$, 'starts on Monday');
select pg_temp.expect_fail($$insert into weekly_reviews (week_start, note) values ('2026-11-16', repeat('x', 201))$$, 'check constraint');
insert into weekly_reviews (week_start, note) values ('2026-11-16', 'Gym before work');
select pg_temp.expect((select updated_at > '2020-01-01' from weekly_reviews where week_start = '2026-11-16'), 'updated_at is set');
-- editable through the following Sunday
set test.today = '2026-11-29';
update weekly_reviews set note = 'Gym before work, lights out by 11' where week_start = '2026-11-16';
-- then locked
set test.today = '2026-11-30';
select pg_temp.expect_fail($$update weekly_reviews set note = 'rewrite' where week_start = '2026-11-16'$$, 'locked');
select pg_temp.expect_fail($$insert into weekly_reviews (week_start, note) values ('2026-11-09', 'late')$$, 'locked');
select pg_temp.expect((select note from weekly_reviews where week_start = '2026-11-16') = 'Gym before work, lights out by 11', 'note kept');
-- the key and server columns can't be changed; no deletes
select pg_temp.expect_fail($$update weekly_reviews set week_start = '2026-11-23'$$, 'permission denied');
select pg_temp.expect_fail($$update weekly_reviews set updated_at = now()$$, 'permission denied');
select pg_temp.expect_fail($$delete from weekly_reviews$$, 'permission denied');

-- EXTRA EXCUSES (past days only, written once)
set test.today = '2026-11-18';
insert into extra_excuses (day, item_key, reason) values ('2026-11-17', 'photos', 'Phone died');
select pg_temp.expect_fail($$insert into extra_excuses (day, item_key, reason) values ('2026-11-18', 'photos', 'today')$$, 'past day');
select pg_temp.expect_fail($$insert into extra_excuses (day, item_key, reason) values ('2026-11-19', 'photos', 'future')$$, 'past day');
select pg_temp.expect_fail($$insert into extra_excuses (day, item_key, reason) values ('2026-11-16', 'photos', '   ')$$, 'check constraint');
select pg_temp.expect_fail($$insert into extra_excuses (day, item_key, reason) values ('2026-11-17', 'photos', 'again')$$, 'duplicate key');
select pg_temp.expect_fail($$insert into extra_excuses (day, item_key, reason) values ('2026-11-16', 'Bad Key!', 'x')$$, 'check constraint');
select pg_temp.expect_fail($$update extra_excuses set reason = 'changed'$$, 'permission denied');
select pg_temp.expect_fail($$delete from extra_excuses$$, 'permission denied');
select pg_temp.expect_fail($$insert into extra_excuses (day, item_key, reason, created_at) values ('2026-11-15', 'photos', 'x', '2020-01-01')$$, 'permission denied');
-- even with update/delete rights, the trigger keeps them immutable
reset role;
select pg_temp.expect_fail($$update extra_excuses set reason = 'changed'$$, 'can''t be changed');
select pg_temp.expect_fail($$delete from extra_excuses$$, 'can''t be changed');
set role authenticated;

-- PRIVACY: user 2 sees nothing and can't write as user 1
set test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect((select count(*) from weekly_reviews) = 0 and (select count(*) from extra_excuses) = 0, 'RLS: user 2 sees no rows of user 1');
select pg_temp.expect_fail($$insert into extra_excuses (user_id, day, item_key, reason) values ('11111111-1111-1111-1111-111111111111', '2026-11-16', 'photos', 'x')$$, 'permission denied');
set test.today = '2026-11-22';
insert into weekly_reviews (week_start, note) values ('2026-11-16', 'user 2 note');
update weekly_reviews set note = 'hijack' where week_start = '2026-11-16';
set test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.expect((select note from weekly_reviews where week_start = '2026-11-16') = 'Gym before work, lights out by 11', 'RLS: user 2 cannot edit user 1 note');

-- anonymous visitors get nothing
reset role;
set role anon;
select pg_temp.expect_fail($$select * from weekly_reviews$$, 'permission denied');
select pg_temp.expect_fail($$select * from extra_excuses$$, 'permission denied');

reset role;
\o
\echo 'accountability SQL tests passed'
