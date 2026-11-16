-- Stage 4: weekly review notes + reasons for missed extras (e.g. a day without a photo).
-- Missed TASKS keep their reasons in task_logs (status 'missed'); this covers everything else.

-- WEEKLY REVIEW: one short note per Mon–Sun week, "What will you fix next week?"
-- Writable from that week's Sunday through the end of the following week; locked after.
create table public.weekly_reviews (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  week_start date not null,
  note text not null check (length(note) <= 200),
  updated_at timestamptz not null default now(),
  primary key (user_id, week_start)
);

create or replace function public.guard_weekly_review() returns trigger
language plpgsql set search_path = '' as $$
declare
  t date := public.today_la();
begin
  if tg_op = 'UPDATE' and (new.user_id <> old.user_id or new.week_start <> old.week_start) then
    raise exception 'A review can''t be moved to another week' using errcode = 'P0001';
  end if;
  if extract(isodow from new.week_start) <> 1 then
    raise exception 'A week starts on Monday' using errcode = 'P0001';
  end if;
  if t < new.week_start + 6 then
    raise exception 'The weekly review opens on Sunday' using errcode = 'P0001';
  end if;
  if t > new.week_start + 13 then
    raise exception 'This week''s review is locked' using errcode = 'P0001';
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end
$$;

create trigger weekly_reviews_guard
before insert or update on public.weekly_reviews
for each row execute function public.guard_weekly_review();

-- EXTRA EXCUSES: why an extra daily requirement was missed. Past days only, written once.
create table public.extra_excuses (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null,
  item_key text not null check (item_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  created_at timestamptz not null default now(),
  primary key (user_id, day, item_key)
);

create or replace function public.guard_extra_excuse() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Reasons can''t be changed' using errcode = 'P0001';
  end if;
  if new.day >= public.today_la() then
    raise exception 'Only a past day can be explained' using errcode = 'P0001';
  end if;
  new.created_at := pg_catalog.now();
  return new;
end
$$;

create trigger extra_excuses_guard
before insert or update or delete on public.extra_excuses
for each row execute function public.guard_extra_excuse();

alter table public.weekly_reviews enable row level security;
alter table public.extra_excuses enable row level security;

create policy "own reviews" on public.weekly_reviews
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own excuses: read" on public.extra_excuses
  for select to authenticated using (user_id = auth.uid());
create policy "own excuses: add" on public.extra_excuses
  for insert to authenticated with check (user_id = auth.uid());

-- Least privilege: no deletes; only the note can be edited; excuses are insert-only.
revoke all on public.weekly_reviews, public.extra_excuses from anon, authenticated;
grant select on public.weekly_reviews, public.extra_excuses to authenticated;
grant insert (week_start, note) on public.weekly_reviews to authenticated;
grant update (note) on public.weekly_reviews to authenticated;
grant insert (day, item_key, reason) on public.extra_excuses to authenticated;
