import type { Backend } from '../../data/backend';
import { weekStart, type Day } from '../../lib/dates';
import type { ExtraRequirement, Task, TaskLog } from '../../lib/schedule';
import { excusesApi, reviewsApi, type WeeklyReview } from './api';
import { loadExtras } from './extras';
import { earliestStart, type ExtraExcuse } from './logic';

export interface StatsData {
  today: Day;
  /** First day anything counted. */
  first: Day;
  tasks: Task[];
  logs: TaskLog[];
  extras: ExtraRequirement[];
  excuses: ExtraExcuse[];
  reviews: WeeklyReview[];
}

/** Full history (single user, small data): the streak needs every day since the start. */
export async function loadStats(b: Backend): Promise<StatsData> {
  const [today, tasks] = await Promise.all([b.repo.today(), b.repo.listTasks()]);
  const first = earliestStart(tasks, today);
  // From the Monday of the first week so "once a week" tasks see their whole week.
  const from = weekStart(first);
  const [logs, extras, excuses, reviews] = await Promise.all([
    b.repo.listLogs(from, today),
    loadExtras(b, from, today),
    excusesApi(b).list(from, today),
    reviewsApi(b).list(),
  ]);
  return { today, first, tasks, logs, extras, excuses, reviews };
}
