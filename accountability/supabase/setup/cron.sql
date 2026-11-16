-- Run ONCE in the Supabase SQL editor after deploying the `tick` function.
-- Replace the two placeholders first. Do NOT commit the filled-in version.
--   <PROJECT_URL>   e.g. https://abcdefgh.supabase.co
--   <CRON_SECRET>   the same random string saved as the CRON_SECRET function secret
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<PROJECT_URL>', 'project_url');
select vault.create_secret('<CRON_SECRET>', 'cron_secret');

select cron.schedule(
  'tick-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/tick',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);

-- Housekeeping: keep pg_net's response log and cron history small.
select cron.schedule('tidy-logs', '17 3 * * *', $$
  delete from net._http_response where created < now() - interval '2 days';
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  delete from public.reminders_sent where day < (now() at time zone 'America/Los_Angeles')::date - 60;
$$);
