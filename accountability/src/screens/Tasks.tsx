import type { Day } from '../lib/dates';
import { useCallback, useEffect, useState } from 'react';
import type { Repo } from '../data/repo';
import { describeSchedule, type Task } from '../lib/schedule';
import TaskForm from './TaskForm';
import { errMsg, fmtTime } from './ui';

interface Props {
  repo: Repo;
  onError: (msg: string) => void;
  startWithNew: boolean;
  onStartedNew: () => void;
  onSignOut?: () => void;
}

/** null = list; 'new' = create form; Task = edit form */
type View = null | 'new' | Task;

export default function Tasks({ repo, onError, startWithNew, onStartedNew, onSignOut }: Props) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [today, setToday] = useState<Day | null>(null);
  const [view, setView] = useState<View>(startWithNew ? 'new' : null);

  useEffect(() => {
    if (startWithNew) onStartedNew();
  }, [startWithNew, onStartedNew]);

  const load = useCallback(async () => {
    try {
      const [list, d] = await Promise.all([repo.listTasks(), repo.today()]);
      setToday(d);
      setTasks(list);
    } catch (e) {
      onError(`Couldn't load tasks: ${errMsg(e)}`);
    }
  }, [repo, onError]);

  useEffect(() => {
    load();
  }, [load]);

  if (view !== null) {
    return (
      <TaskForm
        repo={repo}
        task={view === 'new' ? null : view}
        onError={onError}
        onDone={() => {
          setView(null);
          load();
        }}
      />
    );
  }

  const active = (tasks ?? []).filter((t) => t.archived_on === null);

  return (
    <div className="screen">
      <header className="header row">
        <h1>Tasks</h1>
        <button
          type="button"
          className="btn primary"
          data-testid="new-task"
          onClick={() => setView('new')}
        >
          + New task
        </button>
      </header>

      {tasks === null ? (
        <p className="muted center">Loading…</p>
      ) : active.length === 0 ? (
        <div className="empty">
          <p>No tasks yet</p>
        </div>
      ) : (
        <ul className="tasklist">
          {active.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className="task-card"
                data-testid={`task-${t.name}`}
                onClick={() => setView(t)}
              >
                <span className="item-name">{t.name}</span>
                <span className="item-meta">
                  <span>{describeSchedule(t)}</span>
                  {t.goal_time && <span>{fmtTime(t.goal_time)}</span>}
                  {t.critical && <span className="badge critical">Critical</span>}
                  {today && t.start_date > today && <span className="badge soon">Starts tomorrow</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {onSignOut && (
        <footer className="footer">
          <button type="button" className="link-btn" onClick={onSignOut}>
            Sign out
          </button>
        </footer>
      )}
    </div>
  );
}
