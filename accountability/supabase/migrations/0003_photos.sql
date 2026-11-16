-- Stage 2: two private photos a day (face + body).
-- Rows record which photos exist; the JPEGs live in the private storage bucket "photos"
-- at <user_id>/<YYYY-MM-DD>/<face|body>.jpg. Only today's photos can be added, replaced
-- or removed; past days are locked (here and in the storage policies below).

create table public.photos (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null default public.today_la(),
  kind text not null check (kind in ('face', 'body')),
  path text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day, kind)
);

create or replace function public.guard_photo() returns trigger
language plpgsql set search_path = '' as $$
declare
  today date := public.today_la();
begin
  if tg_op = 'DELETE' then
    if old.day <> today then
      raise exception 'Past photos are locked' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.day <> today then
      raise exception 'Past photos are locked' using errcode = 'P0001';
    end if;
    if new.user_id <> old.user_id or new.day <> old.day or new.kind <> old.kind then
      raise exception 'Only the photo itself can be replaced' using errcode = 'P0001';
    end if;
  end if;
  if new.day < today then
    raise exception 'Past photos are locked' using errcode = 'P0001';
  elsif new.day > today then
    raise exception 'Photos can only be taken for today' using errcode = 'P0001';
  end if;
  if new.path is distinct from
     (new.user_id::text || '/' || pg_catalog.to_char(new.day, 'YYYY-MM-DD') || '/' || new.kind || '.jpg') then
    raise exception 'Wrong photo path' using errcode = 'P0001';
  end if;
  -- The file must be uploaded first, so "done" can't be faked with an empty row.
  if not exists (select 1 from storage.objects o where o.bucket_id = 'photos' and o.name = new.path) then
    raise exception 'Upload the photo first' using errcode = 'P0001';
  end if;
  new.created_at := pg_catalog.now();
  return new;
end
$$;

create trigger photos_guard
before insert or update or delete on public.photos
for each row execute function public.guard_photo();

alter table public.photos enable row level security;
create policy "own photos" on public.photos
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.photos from anon, authenticated;
grant select, insert, delete on public.photos to authenticated;
-- Retake today = upsert, which rewrites the key columns with the same values (the guard checks them).
grant update (day, kind, path) on public.photos to authenticated;

-- Storage: private bucket, JPEG only, 1 MB max per file.
insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
on conflict (id) do nothing;
update storage.buckets
   set public = false, file_size_limit = 1048576, allowed_mime_types = '{image/jpeg}'
 where id = 'photos';

-- Read: only your own folder. Never public; the app views photos through short-lived signed URLs.
create policy "photos: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- Write: only your own folder, only today's day folder, only face.jpg / body.jpg.
create policy "photos: add today" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2] = pg_catalog.to_char(public.today_la(), 'YYYY-MM-DD')
    and name ~ '^[^/]+/[0-9]{4}-[0-9]{2}-[0-9]{2}/(face|body)\.jpg$'
  );

create policy "photos: replace today" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2] = pg_catalog.to_char(public.today_la(), 'YYYY-MM-DD')
  )
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2] = pg_catalog.to_char(public.today_la(), 'YYYY-MM-DD')
    and name ~ '^[^/]+/[0-9]{4}-[0-9]{2}-[0-9]{2}/(face|body)\.jpg$'
  );

create policy "photos: remove today" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2] = pg_catalog.to_char(public.today_la(), 'YYYY-MM-DD')
  );
