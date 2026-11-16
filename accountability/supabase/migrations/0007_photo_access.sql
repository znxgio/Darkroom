-- Lets a Claude session view the owner's dated daily photos (read-only), when the owner allows it.
-- Two locks: a secret key (function secret PHOTO_ACCESS_KEY) AND this in-app switch (default OFF).
-- Every access is logged and shown in Settings.
alter table public.settings add column claude_photo_access boolean not null default false;
grant update (claude_photo_access) on public.settings to authenticated;

create table public.photo_access_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now(),
  from_day date,
  to_day date,
  photo_count int not null default 0
);
create index photo_access_log_user_at on public.photo_access_log (user_id, at desc);
alter table public.photo_access_log enable row level security;
create policy "own access log" on public.photo_access_log for select to authenticated using (user_id = auth.uid());
revoke all on public.photo_access_log from anon, authenticated;
grant select on public.photo_access_log to authenticated;
