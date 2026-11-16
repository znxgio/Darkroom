import type { SupabaseClient } from '@supabase/supabase-js';
import { addDays, dayOf, type Day } from '../lib/dates';
import type { Task, TaskLog } from '../lib/schedule';
import {
  LockedError,
  changesSchedule,
  onlyMovesUpcomingOneTime,
  type NewTask,
  type Repo,
  type TaskPatch,
} from './repo';

const TASK_COLS =
  'id,name,kind,pattern,weekdays,one_time_date,goal_time,critical,start_date,archived_on,sort';

function fromRow(r: any): Task {
  return {
    ...r,
    weekdays: r.weekdays ?? [],
    goal_time: r.goal_time ? String(r.goal_time).slice(0, 5) : null,
  };
}

function check<T>(res: { data: T; error: any }): T {
  if (res.error) {
    const msg = res.error.message ?? String(res.error);
    if (/locked|future|isn't over|in the past|tomorrow|archive|upcoming|Sunday/i.test(msg)) throw new LockedError(msg);
    throw new Error(msg);
  }
  return res.data;
}

export function supabaseRepo(sb: SupabaseClient): Repo {
  let todayCache: { day: Day; at: number; local: Day } | null = null;

  async function today(): Promise<Day> {
    // Cache for a minute, but never across LA midnight.
    if (todayCache && Date.now() - todayCache.at < 60_000 && dayOf() === todayCache.local) return todayCache.day;
    const { data, error } = await sb.rpc('today_la');
    const day = error || !data ? dayOf() : String(data);
    todayCache = { day, at: Date.now(), local: dayOf() };
    return day;
  }

  return {
    mode: 'cloud',
    today,
    async listTasks() {
      const rows = check(await sb.from('tasks').select(TASK_COLS).order('sort'));
      return (rows as any[]).map(fromRow);
    },
    async createTask(t: NewTask) {
      const { data: maxRow } = await sb
        .from('tasks')
        .select('sort')
        .order('sort', { ascending: false })
        .limit(1)
        .maybeSingle();
      const row = check(
        await sb
          .from('tasks')
          .insert({ ...t, sort: ((maxRow as any)?.sort ?? -1) + 1 })
          .select(TASK_COLS)
          .single(),
      );
      return fromRow(row);
    },
    async updateTask(id: string, patch: TaskPatch) {
      const cur = fromRow(check(await sb.from('tasks').select(TASK_COLS).eq('id', id).single()));
      const { id: _i, archived_on: _a, sort: _s, ...rest } = patch as Task;
      const d = await today();
      if (changesSchedule(cur, rest) && cur.start_date <= d && !onlyMovesUpcomingOneTime(cur, rest, d)) {
        // Keep history: old version counts through today, new version from tomorrow.
        const tomorrow = addDays(d, 1);
        const { id: _x, archived_on: _y, start_date: _z, ...base } = { ...cur, ...rest };
        const row = check(
          await sb.from('tasks').insert({ ...base, start_date: tomorrow }).select(TASK_COLS).single(),
        );
        check(await sb.from('tasks').update({ archived_on: tomorrow }).eq('id', id));
        return fromRow(row);
      }
      const row = check(await sb.from('tasks').update(rest).eq('id', id).select(TASK_COLS).single());
      return fromRow(row);
    },
    async archiveTask(id: string) {
      const d = await today();
      const cur = fromRow(check(await sb.from('tasks').select(TASK_COLS).eq('id', id).single()));
      if (cur.start_date >= d) {
        const { error } = await sb.from('tasks').delete().eq('id', id);
        if (!error) return 'deleted';
      }
      if (!cur.archived_on) check(await sb.from('tasks').update({ archived_on: addDays(d, 1) }).eq('id', id));
      return 'archived';
    },
    async listLogs(from: Day, to: Day) {
      const rows = check(
        await sb.from('task_logs').select('task_id,day,status,reason').gte('day', from).lte('day', to),
      );
      return rows as TaskLog[];
    },
    async checkOff(taskId, day) {
      check(
        await sb
          .from('task_logs')
          .upsert({ task_id: taskId, day, status: 'done', reason: null }, { onConflict: 'task_id,day' }),
      );
    },
    async skip(taskId, day, reason) {
      if (!reason.trim()) throw new Error('A skip needs a reason');
      check(
        await sb
          .from('task_logs')
          .upsert({ task_id: taskId, day, status: 'skipped', reason: reason.trim() }, { onConflict: 'task_id,day' }),
      );
    },
    async undo(taskId, day) {
      check(await sb.from('task_logs').delete().eq('task_id', taskId).eq('day', day));
    },
    async explainMiss(taskId, day, reason) {
      if (!reason.trim()) throw new Error('A reason is required');
      check(
        await sb
          .from('task_logs')
          .upsert({ task_id: taskId, day, status: 'missed', reason: reason.trim() }, { onConflict: 'task_id,day' }),
      );
    },
  };
}
