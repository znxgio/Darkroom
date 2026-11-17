-- Darkroom coach: photos (tiny thumbnails only), critiques, spending ledger, settings.
-- Full-resolution photos never leave the phone's camera roll.

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  taken_at timestamptz,
  source text not null check (source in ('import', 'live')),
  thumb text not null check (length(thumb) < 120000), -- small JPEG data URL (~15 KB)
  width int,
  height int,
  exif jsonb,
  live_score int check (live_score between 1 and 10),
  note text check (length(note) <= 500)
);
create index if not exists photos_user_created on public.photos (user_id, created_at desc);

create table if not exists public.api_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  photo_id uuid references public.photos(id) on delete set null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(10, 5) not null default 0
);
create index if not exists api_usage_user_created on public.api_usage (user_id, created_at desc);

create table if not exists public.critiques (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  photo_id uuid not null references public.photos(id) on delete cascade,
  created_at timestamptz not null default now(),
  model text not null,
  score numeric(3, 1) not null,
  result jsonb not null,
  tags text[] not null default '{}',
  cost_usd numeric(10, 5) not null default 0,
  usage_id uuid references public.api_usage(id) on delete set null
);
create index if not exists critiques_user_created on public.critiques (user_id, created_at desc);
create index if not exists critiques_photo on public.critiques (photo_id);

create table if not exists public.settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  live_coaching boolean not null default true,
  ai_critique boolean not null default true,
  editing_tips boolean not null default true,
  monthly_cap_usd numeric(8, 2) not null default 5 check (monthly_cap_usd >= 0 and monthly_cap_usd <= 500),
  depth text not null default 'quick' check (depth in ('quick', 'thorough')),
  overlays jsonb not null default '{"grid": true, "level": true, "center": false}',
  updated_at timestamptz not null default now()
);

-- ---- Privacy: every row is visible only to its owner ----
alter table public.photos enable row level security;
alter table public.api_usage enable row level security;
alter table public.critiques enable row level security;
alter table public.settings enable row level security;

drop policy if exists photos_own on public.photos;
create policy photos_own on public.photos for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Critiques and the spending ledger are written only by the server function,
-- so the app can't fake a score or hide spending. The app can read and delete critiques.
drop policy if exists critiques_read on public.critiques;
create policy critiques_read on public.critiques for select to authenticated using (user_id = auth.uid());
drop policy if exists critiques_delete on public.critiques;
create policy critiques_delete on public.critiques for delete to authenticated using (user_id = auth.uid());
drop policy if exists usage_read on public.api_usage;
create policy usage_read on public.api_usage for select to authenticated using (user_id = auth.uid());

drop policy if exists settings_own on public.settings;
create policy settings_own on public.settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.photos, public.api_usage, public.critiques, public.settings from anon;
grant select, insert, update, delete on public.photos to authenticated;
grant select, delete on public.critiques to authenticated;
grant select on public.api_usage to authenticated;
grant select, insert, update on public.settings to authenticated;
grant all on public.photos, public.api_usage, public.critiques, public.settings to service_role;

-- ---- For linking other apps later (e.g. a habit tracker) ----
-- A small summary of practice, readable only by the signed-in owner.
create or replace function public.practice_summary(days int default 7)
returns json
language sql
stable
security invoker
set search_path = public
as $$
  select json_build_object(
    'photos', (select count(*) from photos where user_id = auth.uid() and created_at > now() - make_interval(days => days)),
    'critiques', (select count(*) from critiques where user_id = auth.uid() and created_at > now() - make_interval(days => days)),
    'avg_score', (select round(avg(score), 1) from critiques where user_id = auth.uid() and created_at > now() - make_interval(days => days)),
    'last_photo_at', (select max(created_at) from photos where user_id = auth.uid())
  );
$$;
revoke all on function public.practice_summary(int) from public, anon;
grant execute on function public.practice_summary(int) to authenticated;
