// Blocking full-screen prompt: every past miss needs a reason before the app can be used.
// The day stays a miss; the reason goes into the excuse log.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Backend } from '../../data/backend';
import { LockedError } from '../../data/repo';
import { addDays, prettyDay, weekStart } from '../../lib/dates';
import { errMsg } from '../../screens/ui';
import { REASON_MAX, excusesApi } from './api';
import { loadExtras } from './extras';
import { missesNeedingReasons, type PendingMiss } from './logic';

const LOOKBACK = 30;

async function findMisses(b: Backend): Promise<PendingMiss[]> {
  const today = await b.repo.today();
  const from = addDays(today, -LOOKBACK);
  const yesterday = addDays(today, -1);
  const [tasks, logs, extras, excuses] = await Promise.all([
    b.repo.listTasks(),
    b.repo.listLogs(weekStart(from), today),
    loadExtras(b, from, yesterday),
    excusesApi(b).list(from, yesterday),
  ]);
  return missesNeedingReasons(today, tasks, logs, extras, excuses, LOOKBACK);
}

export default function MissGate({ backend, onResolved }: { backend: Backend; onResolved: () => void }) {
  const [queue, setQueue] = useState<PendingMiss[]>([]);
  const [total, setTotal] = useState(0);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const check = useCallback(async () => {
    if (busyRef.current) return;
    try {
      const q = await findMisses(backend);
      setQueue(q);
      setTotal((t) => (q.length === 0 ? 0 : Math.max(t, q.length)));
    } catch {
      /* offline etc.: try again next time the app is opened */
    }
  }, [backend]);

  useEffect(() => {
    check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [check]);

  const open = queue.length > 0;
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;
  const miss = queue[0];
  const step = total - queue.length + 1;

  async function save() {
    const r = reason.trim();
    if (!r || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (miss.kind === 'task') await backend.repo.explainMiss(miss.taskId, miss.day, r);
      else await excusesApi(backend).add(miss.day, miss.key, r);
      advance();
    } catch (e) {
      // Already explained (e.g. on another device): just move on.
      if (e instanceof LockedError) advance();
      else setError(errMsg(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function advance() {
    setReason('');
    const rest = queue.slice(1);
    setQueue(rest);
    if (rest.length === 0) {
      setTotal(0);
      onResolved();
    }
  }

  return (
    <div className="gate" role="dialog" aria-modal="true" aria-labelledby="gate-title" data-testid="miss-gate">
      <div className="gate-inner">
        {total > 1 && (
          <div className="gate-steps" aria-label={`${step} of ${total}`}>
            {Array.from({ length: Math.min(total, 12) }, (_, i) => (
              <span key={i} className={i < Math.min(step, 12) ? 'on' : ''} />
            ))}
            <small>
              {step} of {total}
            </small>
          </div>
        )}
        <div className="gate-icon" aria-hidden="true">
          ✕
        </div>
        <h1 id="gate-title" data-testid="gate-title">
          You missed <span className="gate-task">{miss.name}</span> on {prettyDay(miss.day)}.
        </h1>
        {miss.critical && <span className="badge critical">Critical</span>}
        <p className="gate-q">What happened?</p>
        <textarea
          data-testid="gate-reason"
          rows={4}
          maxLength={REASON_MAX}
          placeholder="Be honest. Future you will read this."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button type="button" className="btn primary big" data-testid="gate-save" disabled={!reason.trim() || busy} onClick={save}>
          {busy ? 'Saving…' : queue.length > 1 ? 'Save & next' : 'Save'}
        </button>
        <p className="gate-foot">It still counts as a miss. The reason goes in your excuse log so you can spot patterns.</p>
      </div>
    </div>
  );
}
