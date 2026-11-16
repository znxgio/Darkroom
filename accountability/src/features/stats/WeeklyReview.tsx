import { useEffect, useState } from 'react';
import type { Backend } from '../../data/backend';
import { addDays, prettyDay, weekStart, type Day } from '../../lib/dates';
import { weeklyScore } from '../../lib/schedule';
import { errMsg } from '../../screens/ui';
import { REVIEW_MAX, reviewsApi, type WeeklyReview as Review } from './api';
import type { StatsData } from './load';
import { reviewWindow, weekExcuses, type Excuse } from './logic';
import { Ring } from './visuals';

interface Props {
  backend: Backend;
  data: StatsData;
  week: Day;
  onWeek: (week: Day) => void;
  onBack: () => void;
  onSaved: (r: Review) => void;
  onError: (msg: string) => void;
}

function shortDay(d: Day): string {
  return prettyDay(d).replace(/^\w+, /, '');
}

export default function WeeklyReview({ backend, data, week, onWeek, onBack, onSaved, onError }: Props) {
  const { today, tasks, logs, extras, excuses, reviews } = data;
  const saved = reviews.find((r) => r.week_start === week)?.note ?? '';
  const lastNote = reviews.find((r) => r.week_start === addDays(week, -7))?.note;
  const win = reviewWindow(week, today);
  const score = weeklyScore(week, today, tasks, logs, extras);
  const { misses, skips } = weekExcuses(week, today, tasks, logs, extras, excuses);
  const [note, setNote] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    setNote(saved);
    setJustSaved(false);
  }, [week, saved]);

  const canPrev = week > weekStart(data.first);
  const canNext = week < weekStart(today);
  const dirty = note.trim() !== saved && note.trim() !== '';

  async function save() {
    setBusy(true);
    try {
      const r = await reviewsApi(backend).save(week, note);
      onSaved(r);
      setJustSaved(true);
    } catch (e) {
      onError(`Couldn't save: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const clean = misses.length === 0 && skips.length === 0 && score.counted > 0;

  return (
    <div className="screen review" data-testid="review">
      <header className="review-head">
        <button type="button" className="link-btn back" data-testid="review-back" onClick={onBack}>
          ‹ Progress
        </button>
      </header>
      <h1>Weekly review</h1>
      <div className="week-nav">
        <button type="button" className="cal-nav" aria-label="Previous week" data-testid="review-prev" disabled={!canPrev} onClick={() => onWeek(addDays(week, -7))}>
          ‹
        </button>
        <span data-testid="review-week">
          {shortDay(week)} – {shortDay(addDays(week, 6))}
          {week === weekStart(today) && <small> · this week</small>}
        </span>
        <button type="button" className="cal-nav" aria-label="Next week" data-testid="review-next" disabled={!canNext} onClick={() => onWeek(addDays(week, 7))}>
          ›
        </button>
      </div>

      {lastNote && (
        <blockquote className="last-note" data-testid="last-note">
          <span>Last week you said:</span>“{lastNote}”
        </blockquote>
      )}

      <section className="card review-score">
        <Ring pct={score.pct} size={104} stroke={10} />
        <div>
          <p className="big-line">
            {score.counted === 0 ? 'Nothing due' : `${score.done} of ${score.counted} done`}
          </p>
          <p className="muted">
            {misses.length} missed · {skips.length} skipped
            {win === 'upcoming' && ' · so far'}
          </p>
        </div>
      </section>

      {clean && (
        <div className="clean-week">
          <span aria-hidden="true">★</span> Clean week. Nothing missed, nothing skipped.
        </div>
      )}

      {misses.length > 0 && <ExcuseGroup title="Missed" kind="missed" items={misses} />}
      {skips.length > 0 && <ExcuseGroup title="Skipped" kind="skipped" items={skips} />}

      <section className="card note-card">
        <label htmlFor="review-note">
          <h2>What will you fix next week?</h2>
        </label>
        {win === 'open' ? (
          <>
            <input
              id="review-note"
              data-testid="review-note"
              type="text"
              maxLength={REVIEW_MAX}
              placeholder="One thing, one line"
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setJustSaved(false);
              }}
            />
            <div className="note-foot">
              <span className="muted">
                {justSaved ? (
                  <span className="saved" data-testid="review-saved">
                    ✓ Saved
                  </span>
                ) : (
                  `Editable until ${prettyDay(addDays(week, 13))}`
                )}
              </span>
              <button type="button" className="btn primary" data-testid="review-save" disabled={!dirty || busy} onClick={save}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        ) : win === 'upcoming' ? (
          <p className="muted">Opens {prettyDay(addDays(week, 6))}.</p>
        ) : (
          <p className={saved ? 'locked-note' : 'muted'} data-testid="review-locked">
            <span aria-hidden="true">🔒 </span>
            {saved ? `“${saved}”` : 'No note was written this week.'}
          </p>
        )}
      </section>
    </div>
  );
}

function ExcuseGroup({ title, kind, items }: { title: string; kind: 'missed' | 'skipped'; items: Excuse[] }) {
  return (
    <section className={`card group ${kind}`}>
      <div className="section-head">
        <h2>{title}</h2>
        <span className={`tag ${kind}`}>{items.length}</span>
      </div>
      <ul className="excuse-list">
        {items.map((e, i) => (
          <li key={i} className="excuse" data-testid={`review-${kind}`}>
            <div className="excuse-top">
              <span className="excuse-name">{e.name}</span>
              <span className="excuse-day">{prettyDay(e.day)}</span>
            </div>
            <p className={`excuse-reason${e.reason ? '' : ' none'}`}>{e.reason ? `“${e.reason}”` : 'No reason given'}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
