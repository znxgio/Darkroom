-- Choose which AI does critiques, and allow free critiques done in the Claude app.

alter table public.settings
  add column if not exists model_tier text not null default 'cheap'
  check (model_tier in ('free', 'cheap', 'better', 'best'));

-- Free mode: the app saves a critique you got in your own Claude app and pasted back.
-- Only that kind, always $0, never linked to the spending ledger. Paid critiques stay server-only.
drop policy if exists critiques_insert_free on public.critiques;
create policy critiques_insert_free on public.critiques for insert to authenticated
  with check (
    user_id = auth.uid()
    and model = 'claude-app'
    and cost_usd = 0
    and usage_id is null
    and exists (select 1 from public.photos p where p.id = photo_id and p.user_id = auth.uid())
  );
grant insert (user_id, photo_id, model, score, result, tags, cost_usd) on public.critiques to authenticated;
