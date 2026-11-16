import { describe, expect, it } from 'vitest';
import fx from './fixtures/schedule-cases.json';
import { countsOn, type Task, type TaskLog } from '../src/lib/schedule';

const tasks: Task[] = fx.tasks.map((t, i) => ({ ...t, goal_time: null, critical: false, sort: i }) as Task);
const byName = Object.fromEntries(tasks.map((t) => [t.name, t]));
const logs: TaskLog[] = fx.logs.map((l) => ({ task_id: byName[l.task].id, day: l.day, status: l.status as TaskLog['status'], reason: null }));

describe('shared schedule cases (same file is run against SQL)', () => {
  for (const [name, day, want] of fx.cases as [string, string, boolean][]) {
    it(`${name} counts on ${day}: ${want}`, () => {
      expect(countsOn(byName[name], day, logs)).toBe(want);
    });
  }
});
