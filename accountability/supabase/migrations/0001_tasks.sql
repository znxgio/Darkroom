-- Stage 1: tasks + daily check-off.
-- Every table is private to its owner via Row Level Security (RLS).

create or replace function public.today_la() returns date
language sql stable set search_path = '' as $$
  select (pg_catalog.now() at time zone 'America/Los_Angeles')::date
$$;

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  kind text not null check (kind in ('recurring', 'one_time')),
  pattern text check (pattern in ('daily', 'weekdays', 'weekly_day', 'weekly_any')),
  weekdays smallint[] not null default '{}',
  one_time_date date,
  goal_time time,
  critical boolean not null default false,
  start_date date not null default public.today_la(),
  archived_on date,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  check (
    (kind = 'one_time' and one_time_date is not null and pattern is null)
    or (kind = 'recurring' and pattern is not null and one_time_date is null)
  ),
  check (pattern is distinct from 'weekdays' or cardinality(weekdays) between 1 and 7),
  check (pattern is distinct from 'weekly_day' or cardinality(weekdays) = 1),
  check (weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[])
);

create table public.task_logs (
  task_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null,
  status text not null check (status in ('done', 'skipped', 'missed')),
  reason text check (reason is null or length(reason) <= 500),
  created_at timestamptz not null default now(),
  primary key (task_id, day),
  -- a log can only point at one of your own tasks; tasks with history can't be hard-deleted
  foreign key (task_id, user_id) references public.tasks (id, user_id) on delete restrict
);

create index task_logs_user_day on public.task_logs (user_id, day);

-- NO BACKFILLING. Enforced here so it holds no matter what the app sends.
--  * today: check off (done), skip (needs a reason), or undo.
--  * past days: locked. The only write allowed is recording a miss, and
--    filling in the reason on a miss that has none yet.
--  * future days: nothing.
create or replace function public.guard_task_log() returns trigger
language plpgsql set search_path = '' as $$
declare
  t date := public.today_la();
  pat text;
begin
  if tg_op = 'DELETE' then
    if old.day <> t or old.status = 'missed' then
      raise exception 'Past days are locked' using errcode = 'P0001';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and (new.task_id <> old.task_id or new.day <> old.day or new.user_id <> old.user_id) then
    raise exception 'An entry can''t be moved to another task or day' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    new.created_at := pg_catalog.now();
  else
    new.created_at := old.created_at;
  end if;

  if tg_op = 'UPDATE' and old.day <> t then
    if old.status = 'missed' and new.status = 'missed' and old.reason is null
       and new.day = old.day and new.task_id = old.task_id
       and coalesce(btrim(new.reason), '') <> '' then
      return new;
    end if;
    raise exception 'Past days are locked' using errcode = 'P0001';
  end if;

  if new.day > t then
    raise exception 'Can''t log a future day' using errcode = 'P0001';
  end if;

  if new.day < t then
    if tg_op = 'INSERT' and new.status = 'missed' then
      return new;
    end if;
    raise exception 'Past days are locked' using errcode = 'P0001';
  end if;

  if new.status = 'missed' then
    raise exception 'Today isn''t over yet' using errcode = 'P0001';
  end if;
  if new.status = 'skipped' and coalesce(btrim(new.reason), '') = '' then
    raise exception 'A skip needs a reason' using errcode = 'P0001';
  end if;
  -- "Once a week, any day" tasks: a skip only makes sense on the last day of the week (Sunday).
  if new.status = 'skipped' then
    select pattern into pat from public.tasks where id = new.task_id;
    if pat = 'weekly_any' and extract(dow from t) <> 0 then
      raise exception 'A once-a-week task can only be skipped on Sunday' using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;

-- TASKS CAN'T REWRITE HISTORY. Past results are computed from tasks + logs,
-- so once a task has started, its schedule is frozen:
--  * name, goal time, critical flag and order can change any time.
--  * a schedule change = archive this task (from tomorrow) + create a new one (from tomorrow).
--  * archiving always takes effect tomorrow, so it can't dodge today's item; it can't be undone.
--  * a one-time task can be moved only while its date is still in the future.
--  * delete only a task added today or later with no entries (a mistake); otherwise archive.
create or replace function public.guard_task() returns trigger
language plpgsql set search_path = '' as $$
declare
  t date := public.today_la();
begin
  if tg_op = 'INSERT' then
    new.created_at := pg_catalog.now();
    if new.start_date < t then
      raise exception 'A new task can''t start in the past' using errcode = 'P0001';
    end if;
    if new.kind = 'one_time' and new.one_time_date < t then
      raise exception 'A one-time task can''t be in the past' using errcode = 'P0001';
    end if;
    if new.archived_on is not null then
      raise exception 'A new task can''t be archived' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- A task added today (or for later) with nothing logged can be deleted: fixes typos/mistakes.
    if old.start_date < t
       or exists (select 1 from public.task_logs l where l.task_id = old.id) then
      raise exception 'This task has history; archive it instead' using errcode = 'P0001';
    end if;
    return old;
  end if;

  -- UPDATE
  new.created_at := old.created_at;
  if new.id <> old.id or new.user_id <> old.user_id then
    raise exception 'Not allowed' using errcode = 'P0001';
  end if;
  if new.start_date is distinct from old.start_date
     or new.kind is distinct from old.kind
     or new.pattern is distinct from old.pattern
     or new.weekdays is distinct from old.weekdays then
    if old.start_date <= t then
      raise exception 'Schedule changes start a new task from tomorrow' using errcode = 'P0001';
    end if;
    if new.start_date < t then
      raise exception 'A task can''t start in the past' using errcode = 'P0001';
    end if;
  end if;
  if new.one_time_date is distinct from old.one_time_date then
    if old.one_time_date <= t or new.one_time_date < t then
      raise exception 'A one-time task can only be moved while it''s still upcoming' using errcode = 'P0001';
    end if;
  end if;
  if new.archived_on is distinct from old.archived_on then
    if old.archived_on is not null or new.archived_on is distinct from t + 1 then
      raise exception 'Archiving takes effect tomorrow and can''t be undone' using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;

create trigger tasks_guard
before insert or update or delete on public.tasks
for each row execute function public.guard_task();

create trigger task_logs_guard
before insert or update or delete on public.task_logs
for each row execute function public.guard_task_log();

alter table public.tasks enable row level security;
alter table public.task_logs enable row level security;

create policy "own tasks" on public.tasks
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own logs" on public.task_logs
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Least privilege. RLS already limits rows to the owner; these limit columns/verbs.
revoke all on public.tasks, public.task_logs from anon;
revoke all on public.tasks, public.task_logs from authenticated;
grant select, insert, delete on public.tasks to authenticated;
grant update (name, goal_time, critical, sort, one_time_date, archived_on, pattern, weekdays, kind, start_date)
  on public.tasks to authenticated;
grant select, insert, delete on public.task_logs to authenticated;
-- task_id/day must be updatable for PostgREST upserts (ON CONFLICT DO UPDATE sets every sent column);
-- the guard trigger still refuses any real change to them.
grant update (task_id, day, status, reason) on public.task_logs to authenticated;

-- The app reads "today" from the server so a wrong phone clock can't matter.
revoke execute on function public.today_la() from public, anon;
grant execute on function public.today_la() to authenticated;
