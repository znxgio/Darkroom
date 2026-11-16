// Full-screen detail for one tracker: trend chart, range toggles, stats and history.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Backend } from '../../data/backend';
import { prettyDay, type Day } from '../../lib/dates';
import { Segmented } from '../../screens/ui';
import type { TrackersApi } from './api';
import { entryFor } from './entry';
import type { TrackerDef, TrackerValue } from './registry';
import {
  inRange,
  movingAverage,
  RANGES,
  rangeStart,
  shortDate,
  signed,
  summarize,
  toPoints,
  type RangeId,
} from './stats';
import TrendChart from './TrendChart';
import { useTodayEntry } from './useTodayEntry';

const FOREVER = () => '1900-01-01';
const PAGE = 60;

export default function TrackerDetail({
  def,
  api,
  backend,
  onClose,
  onChanged,
}: {
  def: TrackerDef;
  api: TrackersApi;
  backend: Backend;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data, saving, error, save } = useTodayEntry(api, backend, def, FOREVER);
  const [range, setRange] = useState<RangeId>('30d');
  const [editing, setEditing] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const ref = useRef<HTMLDivElement>(null);

  // Lock the page behind, close on Escape.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => setShown(PAGE), [range]);

  const today: Day | null = data?.today ?? null;
  const all = useMemo(() => (data ? toPoints(data.entries) : []), [data]);
  const avgAll = useMemo(() => movingAverage(all, 7), [all]);
  const pts = useMemo(() => (today ? inRange(all, range, today) : []), [all, range, today]);
  const avg = useMemo(() => (today ? inRange(avgAll, range, today) : []), [avgAll, range, today]);
  const sum = useMemo(() => summarize(pts), [pts]);

  const isNumber = def.kind === 'number';
  const dec = def.decimals ?? 0;
  const unit = def.unit ? ` ${def.unit}` : '';
  const fmt = (v: number) => v.toFixed(dec);
  const rs = today ? rangeStart(range, today) : null;
  const chartStart = rs && all.length && all[0].day < rs ? rs : null;
  const latest = all.length ? all[all.length - 1] : null;
  const todayEntry = data?.entries.find((e) => e.day === today) ?? null;
  const Entry = entryFor(def);
  const rangeLabel = RANGES.find((r) => r.id === range)!;

  const history = useMemo(() => {
    if (!data || !today) return [];
    const from = rangeStart(range, today);
    const rows = data.entries.filter((e) => !isNumber || from === null || e.day >= from);
    // delta vs the entry before (by day)
    const byDay = data.entries;
    return rows
      .map((e) => {
        const i = byDay.indexOf(e);
        const p = i > 0 ? byDay[i - 1] : null;
        const a = 'v' in e.value ? e.value.v : null;
        const b = p && 'v' in p.value ? p.value.v : null;
        return { e, delta: a !== null && b !== null ? a - b : null };
      })
      .reverse();
  }, [data, today, range, isNumber]);

  async function onSave(v: TrackerValue) {
    if (await save(v)) {
      setEditing(false);
      onChanged();
    }
  }

  return (
    <div className="tk-detail" role="dialog" aria-modal="true" aria-label={def.name} data-testid="tracker-detail" ref={ref} tabIndex={-1}>
      <div className="tk-detail-bar">
        <button type="button" className="back-btn" data-testid="tracker-back" onClick={onClose}>
          <span aria-hidden="true">‹</span> Today
        </button>
        <h1 className="tk-detail-title">{def.name}</h1>
        <span className="back-spacer" />
      </div>

      <div className="tk-detail-body">
        {!data ? (
          <p className={error ? 'error center' : 'muted center'}>{error ?? 'Loading…'}</p>
        ) : (
          <>
            {isNumber && (
              <>
                <section className="hero">
                  <div className="hero-label">{latest && latest.day === today ? 'Today' : latest ? `Latest · ${prettyDay(latest.day)}` : 'No entries yet'}</div>
                  <div className="hero-value" data-testid="stat-latest">
                    {latest ? fmt(latest.v) : '—'}
                    {def.unit && <small>{def.unit}</small>}
                  </div>
                  {sum && sum.count > 1 && (
                    <div className="hero-change" data-testid="range-change">
                      <span className="pill">
                        {signed(sum.change, dec)}
                        {unit}
                      </span>
                      <span className="muted">
                        {!chartStart ? `since ${shortDate(sum.first.day, sum.first.day.slice(0, 4) !== today!.slice(0, 4))}` : `over ${range === '1y' ? '1 year' : rangeLabel.days + ' days'}`}
                      </span>
                    </div>
                  )}
                </section>

                <Segmented
                  options={RANGES.map((r) => ({ value: r.id, label: r.label, testid: `range-${r.id}` }))}
                  value={range}
                  onChange={setRange}
                />

                <div className="chart-card">
                  <TrendChart points={pts} avg={avg} end={today!} start={chartStart} decimals={dec} unit={def.unit} />
                </div>

                <div className="stat-tiles">
                  <Tile label="Low" testid="stat-min" value={sum ? fmt(sum.min.v) : '—'} sub={sum ? shortDate(sum.min.day) : ''} />
                  <Tile label="High" testid="stat-max" value={sum ? fmt(sum.max.v) : '—'} sub={sum ? shortDate(sum.max.day) : ''} />
                  <Tile
                    label="7-day avg"
                    testid="stat-avg"
                    value={avg.length ? fmt(avg[avg.length - 1].v) : '—'}
                    sub={def.unit ?? ''}
                  />
                </div>
              </>
            )}

            <h2 className="section-title">Today</h2>
            <div className="tracker-card">
              {todayEntry && !editing ? (
                <div className="today-row">
                  <span className="today-val">
                    {def.format(todayEntry.value)}
                    {def.unit && <small>{def.unit}</small>}
                  </span>
                  <button type="button" className="btn small" data-testid="detail-edit" onClick={() => setEditing(true)}>
                    Edit
                  </button>
                </div>
              ) : (
                <Entry
                  def={def}
                  initial={todayEntry?.value ?? null}
                  hint={latest ? fmt(latest.v) : undefined}
                  saving={saving}
                  onSave={onSave}
                  onCancel={editing ? () => setEditing(false) : undefined}
                />
              )}
              {error && <p className="tracker-error">{error}</p>}
            </div>

            <h2 className="section-title">
              History
              <span className="count">{history.length}</span>
            </h2>
            {history.length === 0 ? (
              <p className="muted center small-pad">Nothing logged {isNumber && range !== 'all' ? 'in this range' : 'yet'}</p>
            ) : (
              <ul className="history">
                {history.slice(0, shown).map(({ e, delta }) => (
                  <li key={e.day} className="history-row" data-testid="entry-row">
                    <span className="h-day">
                      {e.day === today ? 'Today' : prettyDay(e.day)}
                    </span>
                    {isNumber ? (
                      <>
                        <span className={`h-delta${delta === null ? '' : delta < 0 ? ' down' : delta > 0 ? ' up' : ''}`}>
                          {delta === null ? '' : signed(delta, dec)}
                        </span>
                        <span className="h-val">
                          {def.format(e.value)}
                          {def.unit && <small>{def.unit}</small>}
                        </span>
                      </>
                    ) : (
                      <span className="h-text">{def.format(e.value)}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {history.length > shown && (
              <button type="button" className="btn show-more" onClick={() => setShown((n) => n + PAGE)}>
                Show more
              </button>
            )}
            <p className="locked-note">
              <span aria-hidden="true">🔒</span> Past days are locked. Only today can be changed.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, testid }: { label: string; value: string; sub: string; testid: string }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value" data-testid={testid}>
        {value}
      </span>
      <span className="tile-sub">{sub}</span>
    </div>
  );
}
