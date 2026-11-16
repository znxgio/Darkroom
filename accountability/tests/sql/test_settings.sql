\set ON_ERROR_STOP 1
\o /dev/null
create or replace function pg_temp.expect_fail(sql text, msg text) returns void language plpgsql as $$
begin
  begin execute sql;
  exception when others then
    if position(msg in sqlerrm) = 0 then raise exception 'expected "%" got "%"', msg, sqlerrm; end if;
    return;
  end;
  raise exception 'expected failure "%": %', msg, sql;
end $$;
grant execute on function pg_temp.expect_fail(text, text) to authenticated;

set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
set test.today = '2026-11-16';
insert into settings (photos_from) values ('2026-11-01');
do $$ begin
  if (select photos_from from settings) <> '2026-11-16' then raise exception 'photos_from must clamp to today'; end if;
end $$;
select pg_temp.expect_fail($$update settings set photos_from = '2026-11-20'$$, 'permission denied');
update settings set stakes_enabled = true, stakes_email = 'friend@example.com', photo_reminder_time = '09:00';
select pg_temp.expect_fail($$update settings set stakes_email = 'not-an-email'$$, 'check constraint');
set test.uid = '22222222-2222-2222-2222-222222222222';
do $$ begin
  if (select count(*) from settings) <> 0 then raise exception 'RLS leak on settings'; end if;
end $$;
reset role;
\o
\echo 'settings SQL tests passed'
