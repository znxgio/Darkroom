// One interface, two backends:
//  - supabaseRepo: the real cloud backend (login, private data)
//  - memoryRepo: demo mode when no Supabase keys are set (data stays in this browser);
//    also used by tests and the browser check. It enforces the same no-backfill rules.
import type { Day } from '../lib/dates';
import type { Task, TaskLog } from '../lib/schedule';

export type NewTask = Omit<Task, 'id' | 'sort' | 'archived_on' | 'start_date'> & {
  start_date?: Day;
};
export type TaskPatch = Partial<Omit<Task, 'id'>>;

export interface Repo {
  readonly mode: 'cloud' | 'demo';
  /** Today in LA, from the server when possible (so a wrong phone clock can't matter). */
  today(): Promise<Day>;

  listTasks(): Promise<Task[]>;
  createTask(t: NewTask): Promise<Task>;
  /**
   * Name / goal time / critical apply right away. A schedule change on a task that has
   * already started keeps today as-is and starts a new version tomorrow (history never changes).
   * Returns the task as it will look going forward.
   */
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  /**
   * A task added today with nothing logged is simply deleted (a mistake).
   * Otherwise it stops counting from tomorrow; history is kept. Can't be undone.
   */
  archiveTask(id: string): Promise<'deleted' | 'archived'>;

  listLogs(from: Day, to: Day): Promise<TaskLog[]>;
  /** Today only. */
  checkOff(taskId: string, day: Day): Promise<void>;
  /** Today only. Reason required. */
  skip(taskId: string, day: Day, reason: string): Promise<void>;
  /** Today only: removes today's done/skip. */
  undo(taskId: string, day: Day): Promise<void>;
  /** Past day only: records a miss with its reason. */
  explainMiss(taskId: string, day: Day, reason: string): Promise<void>;
}

export class LockedError extends Error {}

export const SCHEDULE_FIELDS = ['kind', 'pattern', 'weekdays', 'one_time_date', 'start_date'] as const;

/** Does `patch` change the schedule of `t`? */
export function changesSchedule(t: Task, patch: TaskPatch): boolean {
  return SCHEDULE_FIELDS.some(
    (k) => k in patch && JSON.stringify((patch as any)[k]) !== JSON.stringify((t as any)[k]),
  );
}

/** Only an upcoming one-time task's date changed (allowed in place). */
export function onlyMovesUpcomingOneTime(t: Task, patch: TaskPatch, today: Day): boolean {
  const changed = SCHEDULE_FIELDS.filter(
    (k) => k in patch && JSON.stringify((patch as any)[k]) !== JSON.stringify((t as any)[k]),
  );
  return (
    changed.length === 1 &&
    changed[0] === 'one_time_date' &&
    t.kind === 'one_time' &&
    (t.one_time_date ?? '') > today &&
    (patch.one_time_date ?? '') >= today
  );
}
