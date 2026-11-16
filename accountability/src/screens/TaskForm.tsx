import { useEffect, useState, type FormEvent } from 'react';
import type { NewTask, Repo } from '../data/repo';
import { WEEKDAY_SHORT, type Day } from '../lib/dates';
import type { Pattern, Task } from '../lib/schedule';
import { Segmented, errMsg } from './ui';

interface Props {
  repo: Repo;
  /** null = create */
  task: Task | null;
  onError: (msg: string) => void;
  onDone: () => void;
}

type Kind = Task['kind'];

// Mon..Sun display order; values are 0=Sun..6=Sat.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const PATTERNS: { value: Pattern; label: string; testid: string }[] = [
  { value: 'daily', label: 'Every day', testid: 'pattern-daily' },
  { value: 'weekdays', label: 'Certain days', testid: 'pattern-weekdays' },
  { value: 'weekly_day', label: 'Weekly on a day', testid: 'pattern-weekly_day' },
  { value: 'weekly_any', label: 'Once a week, any day', testid: 'pattern-weekly_any' },
];

export default function TaskForm({ repo, task, onError, onDone }: Props) {
  const [today, setToday] = useState<Day | null>(null);
  const [name, setName] = useState(task?.name ?? '');
  const [kind, setKind] = useState<Kind | null>(task?.kind ?? null);
  const [pattern, setPattern] = useState<Pattern>(task?.pattern ?? 'daily');
  const [weekdays, setWeekdays] = useState<number[]>(task?.weekdays ?? []);
  const [date, setDate] = useState<Day>(task?.one_time_date ?? '');
  const [goalTime, setGoalTime] = useState(task?.goal_time ?? '');
  const [critical, setCritical] = useState(task?.critical ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    repo
      .today()
      .then((d) => {
        setToday(d);
        setDate((cur) => cur || d);
      })
      .catch((e) => onError(errMsg(e)));
  }, [repo, onError]);

  function choosePattern(p: Pattern) {
    setPattern(p);
    if (p === 'weekly_day' && weekdays.length > 1) setWeekdays([weekdays[0]]);
  }

  function toggleDay(d: number) {
    if (pattern === 'weekly_day') setWeekdays([d]);
    else setWeekdays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));
  }

  function validate(): string | null {
    if (!name.trim()) return 'Give the task a name.';
    if (!kind) return 'Choose "Repeats" or "One time".';
    if (kind === 'recurring') {
      if (pattern === 'weekdays' && weekdays.length === 0) return 'Pick at least one day.';
      if (pattern === 'weekly_day' && weekdays.length !== 1) return 'Pick a day of the week.';
    } else {
      if (!date) return 'Pick a date.';
      const unchanged = task?.kind === 'one_time' && task.one_time_date === date;
      if (today && date < today && !unchanged) return "The date can't be in the past.";
    }
    return null;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = validate();
    setError(problem);
    if (problem || !kind) return;

    const fields: NewTask =
      kind === 'recurring'
        ? {
            name: name.trim(),
            kind,
            pattern,
            weekdays:
              pattern === 'daily' || pattern === 'weekly_any'
                ? []
                : [...weekdays].sort((a, b) => a - b),
            one_time_date: null,
            goal_time: goalTime || null,
            critical,
          }
        : {
            name: name.trim(),
            kind,
            pattern: null,
            weekdays: [],
            one_time_date: date,
            goal_time: goalTime || null,
            critical,
          };

    setSaving(true);
    try {
      if (task) await repo.updateTask(task.id, fields);
      else await repo.createTask(fields);
      onDone();
    } catch (err) {
      setError(`Couldn't save: ${errMsg(err)}`);
      setSaving(false);
    }
  }

  async function archive() {
    if (!task) return;
    const msg =
      today && task.start_date >= today
        ? `Delete "${task.name}"? It was added today, so it's removed completely.`
        : `Archive "${task.name}"? It still counts today and stops from tomorrow. History is kept. This can't be undone.`;
    if (!window.confirm(msg))
      return;
    setSaving(true);
    try {
      await repo.archiveTask(task.id);
      onDone();
    } catch (err) {
      setError(`Couldn't archive: ${errMsg(err)}`);
      setSaving(false);
    }
  }

  const started = !!task && !!today && task.start_date <= today;
  const showChips = kind === 'recurring' && (pattern === 'weekdays' || pattern === 'weekly_day');

  return (
    <div className="screen">
      <header className="header row">
        <button type="button" className="link-btn" onClick={onDone}>
          ‹ Back
        </button>
        <h1>{task ? 'Edit task' : 'New task'}</h1>
        <span className="spacer" />
      </header>

      <form className="form" onSubmit={submit} noValidate>
        <label className="field">
          <span>Name</span>
          <input
            data-testid="task-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            enterKeyHint="done"
          />
        </label>

        <div className="field">
          <span>Type</span>
          <Segmented<Kind>
            value={kind}
            onChange={setKind}
            options={[
              { value: 'recurring', label: 'Repeats', testid: 'type-repeats' },
              { value: 'one_time', label: 'One time', testid: 'type-once' },
            ]}
          />
        </div>

        {kind === 'recurring' && (
          <div className="field">
            <span>How often</span>
            <div className="options" role="radiogroup">
              {PATTERNS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  role="radio"
                  aria-checked={pattern === p.value}
                  data-testid={p.testid}
                  className={`option${pattern === p.value ? ' on' : ''}`}
                  onClick={() => choosePattern(p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {showChips && (
          <div className="field">
            <span>{pattern === 'weekly_day' ? 'Which day' : 'Which days'}</span>
            <div className="chips">
              {WEEK_ORDER.map((d) => (
                <button
                  key={d}
                  type="button"
                  data-testid={`wd-${d}`}
                  aria-pressed={weekdays.includes(d)}
                  className={`chip${weekdays.includes(d) ? ' on' : ''}`}
                  onClick={() => toggleDay(d)}
                >
                  {WEEKDAY_SHORT[d]}
                </button>
              ))}
            </div>
            {pattern === 'weekdays' && (
              <div className="quick">
                <button type="button" className="btn small" onClick={() => setWeekdays([1, 2, 3, 4, 5])}>
                  Mon–Fri
                </button>
              </div>
            )}
          </div>
        )}

        {kind === 'one_time' && (
          <label className="field">
            <span>Date</span>
            <input
              type="date"
              value={date}
              min={today ?? undefined}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        )}

        <label className="field">
          <span>Goal time (optional)</span>
          <div className="time-row">
            <input
              data-testid="goal-time"
              type="time"
              value={goalTime}
              onChange={(e) => setGoalTime(e.target.value)}
            />
            {goalTime && (
              <button type="button" className="link-btn" onClick={() => setGoalTime('')}>
                Clear
              </button>
            )}
          </div>
          <small className="hint">Reminder time — not a deadline</small>
        </label>

        <label className="toggle-row">
          <span>
            Critical
            <small className="hint">Counts for Stakes</small>
          </span>
          <input
            data-testid="critical"
            type="checkbox"
            className="switch"
            checked={critical}
            onChange={(e) => setCritical(e.target.checked)}
          />
        </label>

        {started && (
          <p className="hint">
            Schedule changes start tomorrow, so past days and today stay as they were. Name, time and
            critical change right away.
          </p>
        )}

        {error && <p className="error">{error}</p>}

        <button
          type="submit"
          className="btn primary big"
          data-testid="save-task"
          disabled={saving}
        >
          {task ? 'Save changes' : 'Add task'}
        </button>

        {task && (
          <button
            type="button"
            className="btn danger"
            data-testid="archive-task"
            disabled={saving}
            onClick={archive}
          >
            {today && task.start_date >= today ? 'Delete task' : 'Archive task'}
          </button>
        )}
      </form>
    </div>
  );
}
