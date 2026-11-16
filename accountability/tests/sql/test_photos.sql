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
grant execute on function pg_temp.expect_fail(text, text) to authenticated, anon;

do $$ begin
  if (select public or file_size_limit <> 1048576 or allowed_mime_types <> '{image/jpeg}'
      from storage.buckets where id = 'photos') then
    raise exception 'photos bucket must be private, 1 MB, JPEG only';
  end if;
end $$;

-- Seed the uploaded files (photo rows require the file to exist first).
insert into storage.objects (bucket_id, name) values
  ('photos', '11111111-1111-1111-1111-111111111111/2026-11-14/body.jpg'),
  ('photos', '11111111-1111-1111-1111-111111111111/2026-11-15/body.jpg'),
  ('photos', '11111111-1111-1111-1111-111111111111/2026-11-15/face.jpg'),
  ('photos', '11111111-1111-1111-1111-111111111111/2026-11-16/body.jpg'),
  ('photos', '11111111-1111-1111-1111-111111111111/2026-11-16/face.jpg'),
  ('photos', '11111111-1111-1111-1111-111111111111/2026-11-17/body.jpg'),
  ('photos', '11111111-1111-1111-1111-111111111111/2026-11-17/face.jpg'),
  ('photos', '22222222-2222-2222-2222-222222222222/2026-11-16/body.jpg'),
  ('photos', '22222222-2222-2222-2222-222222222222/2026-11-16/face.jpg');
select pg_temp.expect_fail($$insert into photos (day, kind, path) values ('2026-11-16', 'body', '22222222-2222-2222-2222-222222222222/2026-11-16/body.jpg')$$, '');

set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';

-- Yesterday's photo (added while it was "today") becomes locked.
set test.today = '2026-11-15';
insert into photos (day, kind, path)
values ('2026-11-15', 'face', '11111111-1111-1111-1111-111111111111/2026-11-15/face.jpg');

set test.today = '2026-11-16';
-- Today: insert ok, retake (upsert) ok, day defaults to today.
insert into photos (day, kind, path)
values ('2026-11-16', 'face', '11111111-1111-1111-1111-111111111111/2026-11-16/face.jpg');
insert into photos (day, kind, path)
values ('2026-11-16', 'face', '11111111-1111-1111-1111-111111111111/2026-11-16/face.jpg')
on conflict (user_id, day, kind) do update set day = excluded.day, kind = excluded.kind, path = excluded.path;
insert into photos (kind, path) values ('body', '11111111-1111-1111-1111-111111111111/2026-11-16/body.jpg');
do $$ begin
  if (select count(*) from photos where day = '2026-11-16') <> 2 then raise exception 'today photos missing'; end if;
end $$;

-- Past / future blocked.
select pg_temp.expect_fail($$insert into photos (day, kind, path)
  values ('2026-11-14', 'body', '11111111-1111-1111-1111-111111111111/2026-11-14/body.jpg')$$, 'locked');
select pg_temp.expect_fail($$insert into photos (day, kind, path)
  values ('2026-11-17', 'body', '11111111-1111-1111-1111-111111111111/2026-11-17/body.jpg')$$, 'only be taken for today');
select pg_temp.expect_fail($$update photos set path = path where day = '2026-11-15'$$, 'locked');
select pg_temp.expect_fail($$update photos set day = '2026-11-16' where day = '2026-11-15'$$, 'locked');
select pg_temp.expect_fail($$update photos set kind = 'body' where day = '2026-11-16' and kind = 'face'$$, 'Only the photo');
select pg_temp.expect_fail($$update photos set created_at = now() - interval '9 days'$$, 'permission denied');

-- Wrong path / kind blocked.
select pg_temp.expect_fail($$insert into photos (day, kind, path)
  values ('2026-11-16', 'body', '22222222-2222-2222-2222-222222222222/2026-11-16/body.jpg')$$, 'Wrong photo path');
select pg_temp.expect_fail($$update photos set path = 'x.jpg' where day = '2026-11-16' and kind = 'face'$$, 'Wrong photo path');
select pg_temp.expect_fail($$insert into photos (day, kind, path)
  values ('2026-11-16', 'feet', '11111111-1111-1111-1111-111111111111/2026-11-16/feet.jpg')$$, 'Upload the photo first'); -- rejected either way (trigger runs before the kind check)

-- Can't write rows for someone else.
select pg_temp.expect_fail($$insert into photos (user_id, day, kind, path)
  values ('22222222-2222-2222-2222-222222222222', '2026-11-16', 'body',
          '22222222-2222-2222-2222-222222222222/2026-11-16/body.jpg')$$, 'Upload the photo first'); -- that user's file isn't visible to me, so it fails before RLS (also enforced)

-- Delete: past blocked, today ok.
select pg_temp.expect_fail($$delete from photos where day = '2026-11-15'$$, 'locked');
delete from photos where day = '2026-11-16' and kind = 'body';
insert into photos (kind, path) values ('body', '11111111-1111-1111-1111-111111111111/2026-11-16/body.jpg');

-- Storage: own folder, today's day folder, face/body.jpg only.
-- Storage policy checks below start from an empty bucket (the seed was only for the photo rows above).
reset role;
delete from storage.objects;
set role authenticated;
insert into storage.objects (bucket_id, name) values ('photos', '11111111-1111-1111-1111-111111111111/2026-11-16/face.jpg');
update storage.objects set owner = owner where name = '11111111-1111-1111-1111-111111111111/2026-11-16/face.jpg';
select pg_temp.expect_fail($$insert into storage.objects (bucket_id, name)
  values ('photos', '22222222-2222-2222-2222-222222222222/2026-11-16/face.jpg')$$, 'row-level security');
select pg_temp.expect_fail($$insert into storage.objects (bucket_id, name)
  values ('photos', '11111111-1111-1111-1111-111111111111/2026-11-15/face.jpg')$$, 'row-level security');
select pg_temp.expect_fail($$insert into storage.objects (bucket_id, name)
  values ('photos', '11111111-1111-1111-1111-111111111111/2026-11-17/face.jpg')$$, 'row-level security');
select pg_temp.expect_fail($$insert into storage.objects (bucket_id, name)
  values ('photos', '11111111-1111-1111-1111-111111111111/2026-11-16/other.png')$$, 'row-level security');
reset role;
insert into storage.objects (bucket_id, name, owner)
values ('photos', '11111111-1111-1111-1111-111111111111/2026-11-15/face.jpg', '11111111-1111-1111-1111-111111111111'),
       ('photos', '22222222-2222-2222-2222-222222222222/2026-11-16/face.jpg', '22222222-2222-2222-2222-222222222222');
set role authenticated;
do $$ begin
  if (select count(*) from storage.objects where bucket_id = 'photos') <> 2 then
    raise exception 'storage read: should see only own 2 objects';
  end if;
  -- Past objects can't be replaced or removed (RLS filters them out of update/delete).
  update storage.objects set name = name where name like '%/2026-11-15/%';
  if found then raise exception 'past storage object was updated'; end if;
  delete from storage.objects where name like '%/2026-11-15/%';
  if found then raise exception 'past storage object was removed'; end if;
end $$;
select pg_temp.expect_fail($$update storage.objects set name = '11111111-1111-1111-1111-111111111111/2026-11-15/body.jpg'
  where name = '11111111-1111-1111-1111-111111111111/2026-11-16/face.jpg'$$, 'row-level security');

-- The other user sees nothing of user 1.
set test.uid = '22222222-2222-2222-2222-222222222222';
do $$ begin
  if (select count(*) from photos) <> 0 then raise exception 'RLS leak on photos'; end if;
  if (select count(*) from storage.objects where name like '1111%') <> 0 then raise exception 'RLS leak on storage'; end if;
  delete from photos;
  if found then raise exception 'other user deleted photos'; end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from photos) <> 3 then raise exception 'photos changed by other user'; end if;
end $$;

-- anon gets nothing.
set role anon;
select pg_temp.expect_fail($$select * from photos$$, 'permission denied');
reset role;
\o
\echo 'photos SQL tests passed'
