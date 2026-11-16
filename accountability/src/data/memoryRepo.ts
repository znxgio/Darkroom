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

interface State {
  tasks: Task[];
  logs: TaskLog[];
}

export interface MemoryRepoOptions {
  /** Override "now" (tests / browser check). */
  clock?: () => Date;
  /** localStorage key; null = don't persist. */
  storageKey?: string | null;
  seed?: Partial<State>;
}

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

export function memoryRepo(opts: MemoryRepoOptions = {}): Repo {
  const clock = opts.clock ?? (() => new Date());
  const key = opts.storageKey === undefined ? 'accountability-demo' : opts.storageKey;
  let state: State = { tasks: [], logs: [], ...opts.seed };
  if (key && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(key);
      if (raw) state = JSON.parse(raw);
    } catch {
      /* ignore */
    }
  }
  const save = () => {
    if (key && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(key, JSON.stringify(state));
      } catch {
        /* ignore */
      }
    }
  };
  const today = () => dayOf(clock());
  const findLog = (taskId: string, day: Day) =>
    state.logs.findIndex((l) => l.task_id === taskId && l.day === day);
  const requireToday = (day: Day) => {
    if (day !== today()) throw new LockedError(day < today() ? 'Past days are locked' : "Can't log a future day");
  };
  const upsertToday = (log: TaskLog) => {
    requireToday(log.day);
    const i = findLog(log.task_id, log.day);
    if (i >= 0) state.logs[i] = log;
    else state.logs.push(log);
    save();
  };

  return {
    mode: 'demo',
    async today() {
      return today();
    },
    async listTasks() {
      return state.tasks.map((t) => ({ ...t, weekdays: [...t.weekdays] }));
    },
    async createTask(t: NewTask) {
      const start = t.start_date ?? today();
      if (start < today()) throw new LockedError("A new task can't start in the past");
      if (t.kind === 'one_time' && (t.one_time_date ?? '') < today())
        throw new LockedError("A one-time task can't be in the past");
      const task: Task = {
        ...t,
        id: uid(),
        start_date: start,
        archived_on: null,
        sort: state.tasks.length ? Math.max(...state.tasks.map((x) => x.sort)) + 1 : 0,
      };
      state.tasks.push(task);
      save();
      return { ...task };
    },
    async updateTask(id: string, patch: TaskPatch) {
      const i = state.tasks.findIndex((t) => t.id === id);
      if (i < 0) throw new Error('Task not found');
      const cur = state.tasks[i];
      const { id: _i, archived_on: _a, sort: _s, ...rest } = patch as Task;
      if (changesSchedule(cur, rest) && cur.start_date <= today() && !onlyMovesUpcomingOneTime(cur, rest, today())) {
        // Keep history: old version counts through today, new version from tomorrow.
        const tomorrow = addDays(today(), 1);
        state.tasks[i] = { ...cur, archived_on: tomorrow };
        const next: Task = { ...cur, ...rest, id: uid(), start_date: tomorrow, archived_on: null };
        state.tasks.push(next);
        save();
        return { ...next };
      }
      state.tasks[i] = { ...cur, ...rest, id };
      save();
      return { ...state.tasks[i] };
    },
    async archiveTask(id: string) {
      const i = state.tasks.findIndex((t) => t.id === id);
      if (i < 0) return 'deleted';
      const t = state.tasks[i];
      if (t.start_date >= today() && !state.logs.some((l) => l.task_id === id)) {
        state.tasks.splice(i, 1);
        save();
        return 'deleted';
      }
      if (t.archived_on) return 'archived';
      state.tasks[i] = { ...t, archived_on: addDays(today(), 1) };
      save();
      return 'archived';
    },
    async listLogs(from: Day, to: Day) {
      return state.logs.filter((l) => l.day >= from && l.day <= to).map((l) => ({ ...l }));
    },
    async checkOff(taskId, day) {
      upsertToday({ task_id: taskId, day, status: 'done', reason: null });
    },
    async skip(taskId, day, reason) {
      if (!reason.trim()) throw new Error('A skip needs a reason');
      upsertToday({ task_id: taskId, day, status: 'skipped', reason: reason.trim() });
    },
    async undo(taskId, day) {
      requireToday(day);
      state.logs = state.logs.filter((l) => !(l.task_id === taskId && l.day === day));
      save();
    },
    async explainMiss(taskId, day, reason) {
      if (day >= today()) throw new LockedError("Today isn't over yet");
      if (!reason.trim()) throw new Error('A reason is required');
      const i = findLog(taskId, day);
      if (i >= 0) {
        const l = state.logs[i];
        if (l.status !== 'missed' || l.reason) throw new LockedError('Past days are locked');
        state.logs[i] = { ...l, reason: reason.trim() };
      } else {
        state.logs.push({ task_id: taskId, day, status: 'missed', reason: reason.trim() });
      }
      save();
    },
  };
}
