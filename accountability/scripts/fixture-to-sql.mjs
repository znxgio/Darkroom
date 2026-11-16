// Turns tests/fixtures/schedule-cases.json into a SQL test for task_counts_on.
import { readFileSync } from 'node:fs';
const fx = JSON.parse(readFileSync(new URL('../tests/fixtures/schedule-cases.json', import.meta.url)));
const q = (v) => (v === null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const U = '33333333-3333-3333-3333-333333333333';
const out = [
  '\\set ON_ERROR_STOP 1', '\\o /dev/null',
  `insert into auth.users values ('${U}') on conflict do nothing;`,
  'alter table public.tasks disable trigger tasks_guard;',
  'alter table public.task_logs disable trigger task_logs_guard;',
];
const ids = {};
for (const t of fx.tasks) {
  ids[t.name] = t.id;
  out.push(`insert into public.tasks (id, user_id, name, kind, pattern, weekdays, one_time_date, start_date, archived_on) values (${q(t.id)}, '${U}', ${q(t.name)}, ${q(t.kind)}, ${q(t.pattern)}, '{${t.weekdays.join(',')}}', ${q(t.one_time_date)}, ${q(t.start_date)}, ${q(t.archived_on)});`);
}
for (const l of fx.logs) {
  out.push(`insert into public.task_logs (task_id, user_id, day, status, reason) values (${q(ids[l.task])}, '${U}', ${q(l.day)}, ${q(l.status)}, ${l.status === 'skipped' ? "'x'" : 'null'});`);
}
for (const [name, day, want] of fx.cases) {
  out.push(`do $$ begin if (select public.task_counts_on(t, ${q(day)}::date) from public.tasks t where t.id = ${q(ids[name])}) is distinct from ${want} then raise exception 'fixture: % on % should be %', ${q(name)}, ${q(day)}, ${want}; end if; end $$;`);
}
out.push('delete from public.task_logs where user_id = ' + q(U) + ';', 'delete from public.tasks where user_id = ' + q(U) + ';');
out.push('alter table public.tasks enable trigger tasks_guard;', 'alter table public.task_logs enable trigger task_logs_guard;');
out.push('\\o', `\\echo 'shared fixture: ${fx.cases.length} cases match in SQL'`);
console.log(out.join('\n'));
