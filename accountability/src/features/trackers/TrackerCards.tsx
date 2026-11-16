// The "Trackers" section on the Today screen: one compact card per tracker in the
// registry. Tap a card to open its detail view (chart + history).
import { useContext, useEffect, useMemo, useState } from 'react';
import type { Backend } from '../../data/backend';
import { BackendContext } from '../../data/BackendContext';
import { addDays, type Day } from '../../lib/dates';
import { trackersApi, type TrackersApi } from './api';
import { useTodayEntry } from './useTodayEntry';
import { entryFor } from './entry';
import { TRACKERS, type TrackerDef, type TrackerValue } from './registry';
import { changeOn, changeText, monotonePath, sinceLabel, toPoints, type Point } from './stats';
import TrackerDetail from './TrackerDetail';
import './trackers.css';

export default function TrackerCards({ backend }: { backend?: Backend }) {
  const ctx = useContext(BackendContext);
  const b = backend ?? ctx;
  if (!b) throw new Error('TrackerCards needs a backend');
  const api = useMemo(() => trackersApi(b), [b]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const openDef = TRACKERS.find((t) => t.key === openKey);

  if (!TRACKERS.length) return null;
  return (
    <section className="trackers" aria-labelledby="trackers-title">
      <h2 className="section-title" id="trackers-title">
        Trackers
      </h2>
      <div className="tracker-list">
        {TRACKERS.map((def) => (
          <TrackerCard
            key={def.key}
            def={def}
            api={api}
            backend={b}
            version={version}
            onOpen={() => setOpenKey(def.key)}
          />
        ))}
      </div>
      {openDef && (
        <TrackerDetail
          def={openDef}
          api={api}
          backend={b}
          onClose={() => setOpenKey(null)}
          onChanged={() => setVersion((v) => v + 1)}
        />
      )}
    </section>
  );
}

const last90 = (today: Day) => addDays(today, -89);

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function TrackerCard({
  def,
  api,
  backend,
  version,
  onOpen,
}: {
  def: TrackerDef;
  api: TrackersApi;
  backend: Backend;
  version: number;
  onOpen: () => void;
}) {
  const { data, saving, error, load, save } = useTodayEntry(api, backend, def, last90);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (version) load();
  }, [version, load]);

  const points = useMemo(() => (data ? toPoints(data.entries) : []), [data]);

  if (!data) {
    return (
      <div className="tracker-card loading" data-testid={`tracker-card-${def.key}`}>
        {error ? (
          <p className="tracker-error">
            {error}{' '}
            <button type="button" className="link-btn" onClick={load}>
              Retry
            </button>
          </p>
        ) : (
          <span className="muted">Loading…</span>
        )}
      </div>
    );
  }

  const today = data.today;
  const todayEntry = data.entries.find((e) => e.day === today) ?? null;
  const prev = [...data.entries].reverse().find((e) => e.day < today) ?? null;
  const Entry = entryFor(def);
  const unit = def.unit ? ` ${def.unit}` : '';

  const onSave = async (v: TrackerValue) => {
    if (await save(v)) setEditing(false);
  };

  // Auto trackers (e.g. Face score) are never typed in: show the latest value or a hint.
  if (def.auto && !todayEntry) {
    return (
      <div className="tracker-card tk-auto-empty" data-testid={`tracker-card-${def.key}`}>
        <button type="button" className="tc-open" data-testid={`tracker-open-${def.key}`} onClick={onOpen}>
          <span className="tc-name">{def.name}</span>
          <span className="tc-body">
            <span className="tc-main">
              <span className="tc-change" data-testid={`tracker-last-${def.key}`}>
                {prev
                  ? `Last ${def.format(prev.value)}${unit} · ${cap(sinceLabel(prev.day, today))}`
                  : 'No score yet'}
              </span>
              <span className="tk-auto-note">Updates when you take today's face photo</span>
            </span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </span>
        </button>
      </div>
    );
  }

  if (!todayEntry || editing) {
    return (
      <div className="tracker-card" data-testid={`tracker-card-${def.key}`}>
        <div className="tc-top">
          <button type="button" className="tc-title" data-testid={`tracker-open-${def.key}`} onClick={onOpen}>
            {def.name}
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </button>
          <span className="tc-last" data-testid={`tracker-last-${def.key}`}>
            {editing
              ? 'Editing today'
              : prev
                ? `Last ${def.format(prev.value)}${unit} · ${cap(sinceLabel(prev.day, today))}`
                : 'First entry'}
          </span>
        </div>
        <Entry
          def={def}
          initial={todayEntry?.value ?? null}
          hint={prev && def.kind === 'number' ? def.format(prev.value) : undefined}
          saving={saving}
          onSave={onSave}
          onCancel={editing ? () => setEditing(false) : undefined}
        />
        {error && <p className="tracker-error">{error}</p>}
      </div>
    );
  }

  const Summary = def.summaryComponent;
  const change = def.kind === 'number' ? changeOn(points, today) : null;
  return (
    <div className="tracker-card logged" data-testid={`tracker-card-${def.key}`}>
      <button type="button" className="tc-open" data-testid={`tracker-open-${def.key}`} onClick={onOpen}>
        <span className="tc-name">
          {def.name}
          <span className="tc-check" aria-hidden="true">
            ✓
          </span>
        </span>
        {Summary ? (
          <Summary def={def} today={today} entries={data.entries} />
        ) : def.kind === 'number' ? (
          <span className="tc-body">
            <span className="tc-main">
              <span className="tc-value" data-testid={`tracker-value-${def.key}`}>
                {def.format(todayEntry.value)}
                {def.unit && <small>{def.unit}</small>}
              </span>
              <span className="tc-change" data-testid={`tracker-change-${def.key}`}>
                {change
                  ? changeText(change.delta, change.prevDay, today, def.decimals ?? 0, def.unit)
                  : 'First entry'}
              </span>
              {def.auto && def.autoSource && <span className="tk-auto-note">{def.autoSource}</span>}
            </span>
            <Sparkline points={points.filter((p) => p.day >= addDays(today, -29))} />
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </span>
        ) : (
          <span className="tc-text">{def.format(todayEntry.value)}</span>
        )}
      </button>
      {!def.auto && (
      <button
        type="button"
        className="tc-edit"
        data-testid={`tracker-edit-${def.key}`}
        onClick={() => setEditing(true)}
      >
        Edit
      </button>
      )}
      {error && <p className="tracker-error">{error}</p>}
    </div>
  );
}

function Sparkline({ points }: { points: Point[] }) {
  if (points.length < 2) return <span className="spark" />;
  const W = 84;
  const H = 34;
  const vs = points.map((p) => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const t0 = Date.parse(points[0].day);
  const t1 = Date.parse(points[points.length - 1].day);
  const xy = points.map(
    (p) =>
      [
        2 + ((Date.parse(p.day) - t0) / (t1 - t0 || 1)) * (W - 6),
        3 + (hi === lo ? 0.5 : 1 - (p.v - lo) / (hi - lo)) * (H - 6),
      ] as [number, number],
  );
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <path d={monotonePath(xy)} />
      <circle cx={lx} cy={ly} r={3} />
    </svg>
  );
}
