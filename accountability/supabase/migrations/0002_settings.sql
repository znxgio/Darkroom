-- One settings row per user. Created on first read by the app (upsert).
create table public.settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  -- Daily photos count as a required item from this day on (set when the feature starts).
  photos_from date not null default public.today_la(),
  photo_reminder_time time default '08:00',
  -- Stakes (default OFF)
  stakes_enabled boolean not null default false,
  stakes_scope text not null default 'critical' check (stakes_scope in ('critical', 'any')),
  stakes_name text check (stakes_name is null or length(stakes_name) <= 80),
  stakes_email text check (stakes_email is null or stakes_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  stakes_channel text not null default 'email' check (stakes_channel in ('email')),
  updated_at timestamptz not null default now()
);

-- photos_from is fixed once set, so it can't be moved to erase past misses.
create or replace function public.guard_settings() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.photos_from := public.today_la(); -- never earlier (erasing nothing) or later (skipping days)
  elsif new.photos_from is distinct from old.photos_from then
    raise exception 'The photos start date can''t be changed' using errcode = 'P0001';
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end
$$;

create trigger settings_guard
before insert or update on public.settings
for each row execute function public.guard_settings();

alter table public.settings enable row level security;
create policy "own settings" on public.settings
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.settings from anon, authenticated;
grant select, insert on public.settings to authenticated;
grant update (photo_reminder_time, stakes_enabled, stakes_scope, stakes_name, stakes_email, stakes_channel)
  on public.settings to authenticated;
