import { useCallback, useEffect, useRef, useState } from 'react';
import type { Backend } from '../data/backend';
import type { Repo } from '../data/repo';
import PhotoItem from '../features/photos/PhotoItem';
import { prettyDay, weekStart, type Day } from '../lib/dates';
import { canSkip, itemsFor, type DayItem, type Task, type TaskLog } from '../lib/schedule';
import { errMsg, fmtTime } from './ui';
import TrackerCards from '../features/trackers/TrackerCards';
import { setBadge } from '../features/reminders/push';

interface Props {
  repo: Repo;
  backend: Backend;
  onError: (msg: string) => void;
  onAddTask: () => void;
}

interface Data {
  today: Day;
  tasks: Task[];
  logs: TaskLog[];
}

export default function Today({ repo, backend, onError, onAddTask }: Props) {
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [skipping, setSkipping] = useState<Task | null>(null);
  const [photosDone, setPhotosDone] = useState<boolean | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  const wasComplete = useRef<boolean | null>(null);

  // Home Screen badge = what's still open today; celebrate the moment the day becomes complete.
  useEffect(() => {
    if (!data || photosDone === null) return;
    const its = itemsFor(data.today, data.today, data.tasks, data.logs);
    const open = its.filter((i) => i.state === 'open').length + (photosDone ? 0 : 1);
    const complete = its.every((i) => i.state === 'done') && photosDone;
    setBadge(open);
    if (wasComplete.current === false && complete) {
      setCelebrate(true);
      const t = window.setTimeout(() => setCelebrate(false), 2600);
      wasComplete.current = complete;
      return () => window.clearTimeout(t);
    }
    wasComplete.current = complete;
  }, [data, photosDone]);
  const busy = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const today = await repo.today();
      // Whole week so "once a week, any day" tasks know whether they're already resolved.
      const [tasks, logs] = await Promise.all([
        repo.listTasks(),
        repo.listLogs(weekStart(today), today),
      ]);
      setData({ today, tasks, logs });
      setLoadError(null);
    } catch (e) {
      setLoadError(errMsg(e));
    }
  }, [repo]);

  useEffect(() => {
    load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  /** Optimistically replace today's log for a task (null = remove), then persist. */
  async function change(task: Task, next: TaskLog | null, persist: () => Promise<void>) {
    if (!data || busy.current.has(task.id)) return;
    busy.current.add(task.id);
    const before = data.logs;
    const others = before.filter((l) => !(l.task_id === task.id && l.day === data.today));
    setData({ ...data, logs: next ? [...others, next] : others });
    try {
      await persist();
    } catch (e) {
      setData((d) => (d ? { ...d, logs: before } : d));
      onError(`Couldn't save: ${errMsg(e)}`);
      load(); // the day may have rolled over
    } finally {
      busy.current.delete(task.id);
    }
  }

  function tap(item: DayItem) {
    if (!data) return;
    const { task, state } = item;
    const day = data.today;
    if (state === 'open') {
      change(task, { task_id: task.id, day, status: 'done', reason: null }, () =>
        repo.checkOff(task.id, day),
      );
    } else if (state === 'done' || state === 'skipped') {
      change(task, null, () => repo.undo(task.id, day));
    }
  }

  function saveSkip(task: Task, reason: string) {
    if (!data) return;
    const day = data.today;
    setSkipping(null);
    change(task, { task_id: task.id, day, status: 'skipped', reason: reason.trim() }, () =>
      repo.skip(task.id, day, reason),
    );
  }

  if (!data) {
    return (
      <div className="screen">
        {loadError ? (
          <div className="empty">
            <p className="error">Couldn't load: {loadError}</p>
            <button type="button" className="btn" onClick={load}>
              Try again
            </button>
          </div>
        ) : (
          <p className="muted center">Loading…</p>
        )}
      </div>
    );
  }

  const items = itemsFor(data.today, data.today, data.tasks, data.logs);
  const photoCount = photosDone === null ? 0 : 1;
  const doneCount = items.filter((i) => i.state === 'done').length + (photosDone ? 1 : 0);
  const total = items.length + photoCount;

  return (
    <div className="screen">
      <header className="header">
        <h1>{prettyDay(data.today)}</h1>
        <p className="sub" data-testid="done-count">
          {doneCount} of {total} done
        </p>
      </header>

      <PhotoItem backend={backend} onError={onError} onStatus={setPhotosDone} />
      {celebrate && (
        <div className="celebrate" role="status" data-testid="celebrate" onClick={() => setCelebrate(false)}>
          <div className="celebrate-card">
            <div className="celebrate-flame" aria-hidden="true">🔥</div>
            <strong>Day complete</strong>
            <span>Everything’s done. Streak safe.</span>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className="empty">
          <p>No tasks today</p>
          <button type="button" className="btn primary" onClick={onAddTask}>
            + Add a task
          </button>
        </div>
      ) : (
        <ul className="checklist">
          {items.map((item) => (
            <li key={item.task.id} className={`item ${item.state}`}>
              <button
                type="button"
                className="item-main"
                data-testid={`task-row-${item.task.name}`}
                data-state={item.state}
                aria-pressed={item.state === 'done'}
                onClick={() => tap(item)}
              >
                <span className="check" aria-hidden="true">
                  {item.state === 'done' ? '✓' : item.state === 'skipped' ? '–' : ''}
                </span>
                <span className="item-text">
                  <span className="item-name">{item.task.name}</span>
                  <span className="item-meta">
                    {item.task.critical && <span className="badge critical">Critical</span>}
                    {item.task.goal_time && <span>{fmtTime(item.task.goal_time)}</span>}
                    {item.task.pattern === 'weekly_any' && item.state === 'open' && (
                      <span>Any day this week</span>
                    )}
                    {item.state === 'skipped' && (
                      <span className="reason">Skipped: {item.log?.reason}</span>
                    )}
                  </span>
                </span>
              </button>
              {item.state === 'open' && canSkip(item.task, data.today) && (
                <button
                  type="button"
                  className="skip-btn"
                  data-testid={`skip-${item.task.name}`}
                  onClick={() => setSkipping(item.task)}
                >
                  Skip
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <TrackerCards />

      {skipping && (
        <SkipSheet
          task={skipping}
          onCancel={() => setSkipping(null)}
          onSave={(reason) => saveSkip(skipping, reason)}
        />
      )}
    </div>
  );
}

function SkipSheet({
  task,
  onCancel,
  onSave,
}: {
  task: Task;
  onCancel: () => void;
  onSave: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Skip ${task.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Why are you skipping?</h2>
        <p className="muted">{task.name}</p>
        <textarea
          data-testid="skip-reason"
          rows={3}
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            data-testid="skip-save"
            disabled={!reason.trim()}
            onClick={() => onSave(reason)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
