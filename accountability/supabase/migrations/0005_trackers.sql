-- Stage 5: trackers (weight first). Optional daily logs, one row per tracker per day.
-- They are NOT required items: they never affect streaks or scores.
-- `value` is jsonb so new trackers need no schema change:
--   number trackers store {"v": 182.4}, text trackers store {"text": "..."}.
create table public.tracker_entries (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  tracker_key text not null check (tracker_key ~ '^[a-z][a-z0-9_]{0,30}$'),
  day date not null,
  value jsonb not null check (
    jsonb_typeof(value) = 'object'
    and pg_column_size(value) <= 4096
    and (not value ? 'v' or jsonb_typeof(value -> 'v') = 'number')
    and (not value ? 'text' or jsonb_typeof(value -> 'text') = 'string')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, tracker_key, day)
);

-- NO BACKFILLING (same rule as tasks): only today's entry can be added, changed
-- or removed. Past days are locked; future days can't be logged.
create or replace function public.guard_tracker_entry() returns trigger
language plpgsql set search_path = '' as $$
declare
  t date := public.today_la();
begin
  if tg_op = 'DELETE' then
    if old.day <> t then
      raise exception 'Past days are locked' using errcode = 'P0001';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if new.user_id <> old.user_id or new.tracker_key <> old.tracker_key or new.day <> old.day then
      raise exception 'An entry can''t be moved to another tracker or day' using errcode = 'P0001';
    end if;
    if old.day <> t then
      raise exception 'Past days are locked' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
  else
    if new.day > t then
      raise exception 'Can''t log a future day' using errcode = 'P0001';
    end if;
    if new.day < t then
      raise exception 'Past days are locked' using errcode = 'P0001';
    end if;
    new.created_at := pg_catalog.now();
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end
$$;

create trigger tracker_entries_guard
before insert or update or delete on public.tracker_entries
for each row execute function public.guard_tracker_entry();

alter table public.tracker_entries enable row level security;
create policy "own tracker entries" on public.tracker_entries
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Least privilege: the owner can read, add today's entry, change its value, or remove it.
revoke all on public.tracker_entries from anon, authenticated;
grant select, delete on public.tracker_entries to authenticated;
grant insert (tracker_key, day, value) on public.tracker_entries to authenticated;
grant update (value) on public.tracker_entries to authenticated;
