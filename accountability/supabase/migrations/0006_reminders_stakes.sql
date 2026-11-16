-- Stage 3 (reminders) + stage 6 (stakes): server-side rules.
-- A scheduled job (see supabase/setup/cron.sql) calls the `tick` Edge Function every minute;
-- the function asks these SQL functions what to send. All "what's due" rules live here and
-- mirror src/lib/schedule.ts (both are checked against tests/fixtures/schedule-cases.json).

-- ---------- shared rules ----------

-- Monday of the week containing d (weeks run Mon–Sun).
create or replace function public.week_start(d date) returns date
language sql immutable set search_path = '' as $$
  select d - (extract(isodow from d)::int - 1)
$$;

-- Does task t count toward day d's result? (mirror of countsOn in schedule.ts)
create or replace function public.task_counts_on(t public.tasks, d date) returns boolean
language sql stable set search_path = '' as $$
  select d >= t.start_date
     and (t.archived_on is null or d < t.archived_on)
     and case
       when t.kind = 'one_time' then t.one_time_date = d
       when t.pattern = 'daily' then true
       when t.pattern in ('weekdays', 'weekly_day') then extract(dow from d)::smallint = any (t.weekdays)
       when t.pattern = 'weekly_any' then coalesce(
         (select min(l.day) from public.task_logs l
           where l.task_id = t.id and l.status = 'done'
             and l.day between public.week_start(d) and public.week_start(d) + 6) = d,
         d = public.week_start(d) + 6)
       else false
     end
$$;

-- Both daily photos taken on day d?
create or replace function public.photos_done(p_user uuid, d date) returns boolean
language sql stable set search_path = '' as $$
  select count(distinct kind) = 2 from public.photos where user_id = p_user and day = d
$$;

-- Items missed on a (finished) day d. Photos count as critical.
create or replace function public.missed_items(p_user uuid, d date)
returns table (item_key text, name text, critical boolean)
language sql stable set search_path = '' as $$
  select t.id::text, t.name, t.critical
    from public.tasks t
   where t.user_id = p_user
     and public.task_counts_on(t, d)
     and not exists (select 1 from public.task_logs l
                      where l.task_id = t.id and l.day = d and l.status = 'done')
  union all
  select 'photos', 'Daily photos', true
    from public.settings s
   where s.user_id = p_user and d >= s.photos_from and not public.photos_done(p_user, d)
$$;

-- ---------- push subscriptions ----------

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique check (endpoint like 'https://%'),
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
create policy "own subscriptions" on public.push_subscriptions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, delete on public.push_subscriptions to authenticated;

-- ---------- reminder settings ----------

alter table public.settings
  add column nudge_time time default '21:00',
  add column my_name text check (my_name is null or length(my_name) <= 80),
  add column stakes_since date;

-- Stakes only look at days after they were switched on (no surprise email for old misses).
create or replace function public.guard_settings_stakes() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.stakes_enabled and (tg_op = 'INSERT' or not old.stakes_enabled) then
    new.stakes_since := public.today_la();
  elsif tg_op = 'UPDATE' and new.stakes_since is distinct from old.stakes_since then
    new.stakes_since := old.stakes_since;
  end if;
  return new;
end
$$;
create trigger settings_stakes_guard
before insert or update on public.settings
for each row execute function public.guard_settings_stakes();

grant update (nudge_time, my_name) on public.settings to authenticated;

-- ---------- what to send (claimed atomically so overlapping runs never double-send) ----------

create table public.reminders_sent (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  item_key text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, day, item_key)
);
alter table public.reminders_sent enable row level security; -- no policies: server only
revoke all on public.reminders_sent from anon, authenticated;

-- Returns the notifications to send right now and marks them sent.
--  * each task with a goal time, once its time has passed, if not checked off/skipped yet
--  * daily photos at photo_reminder_time if not both taken
--  * evening nudge at nudge_time listing what's still open
create or replace function public.claim_reminders(p_now timestamptz default now())
returns table (user_id uuid, item_key text, title text, body text, open_count int)
language plpgsql volatile set search_path = '' as $$
#variable_conflict use_column
declare
  d date := (p_now at time zone 'America/Los_Angeles')::date;
  tm time := (p_now at time zone 'America/Los_Angeles')::time;
begin
  return query
  with open_tasks as (
    select t.user_id, t.id, t.name, t.goal_time, t.critical
      from public.tasks t
     where public.task_counts_on(t, d)
       and not exists (select 1 from public.task_logs l where l.task_id = t.id and l.day = d)
  ),
  open_photos as (
    select s.user_id, s.photo_reminder_time, s.nudge_time
      from public.settings s
     where d >= s.photos_from and not public.photos_done(s.user_id, d)
  ),
  counts as (
    select u.user_id, count(*)::int as n from (
      select o.user_id from open_tasks o
      union all select p.user_id from open_photos p
    ) u group by u.user_id
  ),
  candidates as (
    select o.user_id, o.id::text as item_key,
           o.name as title,
           case when o.critical then 'Critical — still open today' else 'Still open today' end as body
      from open_tasks o where o.goal_time is not null and o.goal_time <= tm
    union all
    select p.user_id, 'photos', 'Daily photos', 'Face + body — takes 20 seconds'
      from open_photos p where p.photo_reminder_time is not null and p.photo_reminder_time <= tm
    union all
    select s.user_id, 'nudge',
           c.n || case when c.n = 1 then ' thing' else ' things' end || ' left today',
           (select string_agg(x.name, ', ') from (
              select o.name from open_tasks o where o.user_id = s.user_id
              union all select 'Photos' from open_photos p where p.user_id = s.user_id
            ) x)
      from public.settings s join counts c on c.user_id = s.user_id
     where s.nudge_time is not null and s.nudge_time <= tm and c.n > 0
  ),
  claimed as (
    insert into public.reminders_sent as r (user_id, day, item_key)
    select c.user_id, d, c.item_key from candidates c
    on conflict do nothing
    returning r.user_id, r.item_key
  )
  select c.user_id, c.item_key, c.title, c.body, coalesce(n.n, 0)
    from candidates c
    join claimed k on k.user_id = c.user_id and k.item_key = c.item_key
    left join counts n on n.user_id = c.user_id;
end
$$;

-- ---------- stakes ----------

create table public.stakes_sent (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null, -- the second missed day of the pair
  recipient text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  detail text,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.stakes_sent enable row level security;
create policy "own stakes history" on public.stakes_sent for select to authenticated using (user_id = auth.uid());
revoke all on public.stakes_sent from anon, authenticated;
grant select on public.stakes_sent to authenticated;

-- If yesterday AND the day before both had a miss (critical-only or any, per settings),
-- claim one stakes email. A pair already reported isn't reported again
-- (a long slump sends one email every 2 missed days, not every day).
create or replace function public.claim_stakes(p_now timestamptz default now())
returns table (user_id uuid, my_name text, recipient_name text, recipient_email text, day1 date, day2 date, missed jsonb)
language plpgsql volatile set search_path = '' as $$
#variable_conflict use_column
declare
  d1 date := (p_now at time zone 'America/Los_Angeles')::date - 1; -- yesterday
  d2 date := d1 - 1;
begin
  return query
  with eligible as (
    select s.user_id, s.my_name, s.stakes_name, s.stakes_email, s.stakes_scope
      from public.settings s
     where s.stakes_enabled and s.stakes_email is not null
       and s.stakes_since is not null and d2 >= s.stakes_since
  ),
  misses as (
    select e.user_id, dd.d, m.name
      from eligible e
      cross join (values (d1), (d2)) as dd(d)
      cross join lateral public.missed_items(e.user_id, dd.d) m
     where e.stakes_scope = 'any' or m.critical
  ),
  hits as (
    select e.* from eligible e
     where exists (select 1 from misses m where m.user_id = e.user_id and m.d = d1)
       and exists (select 1 from misses m where m.user_id = e.user_id and m.d = d2)
       and not exists (select 1 from public.stakes_sent x where x.user_id = e.user_id and x.day in (d1, d2))
  ),
  claimed as (
    insert into public.stakes_sent as x (user_id, day, recipient)
    select h.user_id, d1, h.stakes_email from hits h
    on conflict do nothing
    returning x.user_id
  )
  select h.user_id, h.my_name, h.stakes_name, h.stakes_email, d2, d1,
         (select jsonb_agg(jsonb_build_object('day', m.d, 'name', m.name) order by m.d, m.name)
            from misses m where m.user_id = h.user_id)
    from hits h join claimed c on c.user_id = h.user_id;
end
$$;

create or replace function public.finish_stakes(p_user uuid, p_day date, p_ok boolean, p_detail text)
returns void language sql volatile set search_path = '' as $$
  update public.stakes_sent set status = case when p_ok then 'sent' else 'failed' end, detail = left(p_detail, 500)
   where user_id = p_user and day = p_day
$$;

-- Server-only functions: never callable from the app.
revoke execute on function public.claim_reminders(timestamptz) from public, anon, authenticated;
revoke execute on function public.claim_stakes(timestamptz) from public, anon, authenticated;
revoke execute on function public.finish_stakes(uuid, date, boolean, text) from public, anon, authenticated;
revoke execute on function public.missed_items(uuid, date) from public, anon, authenticated;
revoke execute on function public.photos_done(uuid, date) from public, anon, authenticated;
do $$ begin
  if exists (select from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_reminders(timestamptz) to service_role;
    grant execute on function public.claim_stakes(timestamptz) to service_role;
    grant execute on function public.finish_stakes(uuid, date, boolean, text) to service_role;
    grant execute on function public.missed_items(uuid, date) to service_role;
    grant execute on function public.photos_done(uuid, date) to service_role;
    grant usage on schema public to service_role;
    grant select, insert, update, delete on all tables in schema public to service_role;
  end if;
end $$;
