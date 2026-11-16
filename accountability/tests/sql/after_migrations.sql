-- Test-only: let tests pick "today".
create or replace function public.today_la() returns date language sql stable as $$
  select coalesce(nullif(current_setting('test.today', true), '')::date,
                  (now() at time zone 'America/Los_Angeles')::date)
$$;
-- (grants come from the migrations themselves)
insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
