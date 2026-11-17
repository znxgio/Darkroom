-- Each check raises an exception on failure (ON_ERROR_STOP makes the script fail).
\set A '11111111-1111-1111-1111-111111111111'
\set B '22222222-2222-2222-2222-222222222222'

-- user A adds a photo and settings
set role authenticated;
select set_config('test.uid', :'A', false);
insert into photos (source, thumb) values ('import', 'data:image/jpeg;base64,AAAA');
insert into settings (monthly_cap_usd) values (3);

-- A cannot write critiques or the spending ledger (only the server function can)
do $$ begin
  begin
    insert into critiques (user_id, photo_id, model, score, result) select auth.uid(), id, 'x', 9, '{}' from photos limit 1;
    raise exception 'FAIL: app could insert a critique';
  exception when insufficient_privilege then null; end;
  begin
    insert into api_usage (user_id, model, cost_usd) values (auth.uid(), 'x', -5);
    raise exception 'FAIL: app could write to the spending ledger';
  exception when insufficient_privilege then null; end;
  begin
    update settings set monthly_cap_usd = 10000;
    raise exception 'FAIL: cap above 500 accepted';
  exception when check_violation then null; end;
end $$;

-- B sees nothing of A's
select set_config('test.uid', :'B', false);
do $$ begin
  if (select count(*) from photos) <> 0 then raise exception 'FAIL: B can see A''s photos'; end if;
  if (select count(*) from settings) <> 0 then raise exception 'FAIL: B can see A''s settings'; end if;
  begin
    insert into photos (user_id, source, thumb) values ('11111111-1111-1111-1111-111111111111', 'import', 'x');
    raise exception 'FAIL: B could add a photo for A';
  exception when insufficient_privilege then null; end;
end $$;

-- server writes a critique + usage for A; A can read them, B can't
reset role;
insert into api_usage (user_id, model, cost_usd) values (:'A', 'claude-opus-5-5', 0.031);
insert into critiques (user_id, photo_id, model, score, result, tags, cost_usd)
  select :'A', id, 'claude-opus-5-5', 6.5, '{}', '{headroom}', 0.031 from photos;
set role authenticated;
select set_config('test.uid', :'B', false);
do $$ begin
  if (select count(*) from critiques) + (select count(*) from api_usage) <> 0 then raise exception 'FAIL: B sees A''s critiques'; end if;
end $$;
select set_config('test.uid', :'A', false);
do $$ declare s json; begin
  if (select count(*) from critiques) <> 1 then raise exception 'FAIL: A can''t read own critique'; end if;
  s := practice_summary(7);
  if (s->>'photos')::int <> 1 or (s->>'avg_score')::numeric <> 6.5 then raise exception 'FAIL: practice_summary %', s; end if;
end $$;
-- deleting a photo removes its critiques
delete from photos;
do $$ begin
  if (select count(*) from critiques) <> 0 then raise exception 'FAIL: critique outlived its photo'; end if;
end $$;
-- anon gets nothing
reset role;
set role anon;
do $$ begin
  begin
    perform count(*) from photos;
    raise exception 'FAIL: anon can read photos';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---- free mode (0002) ----
set role authenticated;
select set_config('test.uid', :'A', false);
insert into photos (source, thumb) values ('import', 'data:x');
-- a pasted Claude-app critique, $0: allowed
insert into critiques (user_id, photo_id, model, score, result, tags, cost_usd)
  select auth.uid(), id, 'claude-app', 7, '{}', '{}', 0 from photos limit 1;
do $$ begin
  begin
    insert into critiques (user_id, photo_id, model, score, result, cost_usd)
      select auth.uid(), id, 'claude-app', 7, '{}', 0.5 from photos limit 1;
    raise exception 'FAIL: app saved a free critique with a cost';
  exception when insufficient_privilege then null; end;
  begin
    insert into critiques (user_id, photo_id, model, score, result, cost_usd)
      select auth.uid(), id, 'claude-opus-5-5', 9, '{}', 0 from photos limit 1;
    raise exception 'FAIL: app saved a paid-model critique';
  exception when insufficient_privilege then null; end;
  begin
    update settings set model_tier = 'gold';
    raise exception 'FAIL: unknown tier accepted';
  exception when check_violation then null; end;
end $$;
update settings set model_tier = 'free';
-- B can't attach a free critique to A's photo, even knowing its id
reset role;
select set_config('test.photo', (select id::text from photos limit 1), false);
set role authenticated;
select set_config('test.uid', :'B', false);
do $$ begin
  begin
    insert into critiques (user_id, photo_id, model, score, result, cost_usd)
      values (auth.uid(), current_setting('test.photo')::uuid, 'claude-app', 7, '{}', 0);
    raise exception 'FAIL: B attached a critique to A''s photo';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  if (select count(*) from critiques where photo_id in (select id from photos)) <> 1 then raise exception 'FAIL: expected exactly 1 free critique'; end if;
end $$;
