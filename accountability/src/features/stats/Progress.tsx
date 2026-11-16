import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Backend } from '../../data/backend';
import { WEEKDAY_SHORT, addDays, daysBetween, prettyDay, weekStart, weekday, type Day } from '../../lib/dates';
import { streak, weeklyScore, type DayColor, type DayResult } from '../../lib/schedule';
import { errMsg } from '../../screens/ui';
import { loadStats, type StatsData } from './load';
import {
  bestStreak,
  dayDetail,
  dayResults,
  defaultReviewWeek,
  excuseHistory,
  excusePatterns,
  monthGrid,
  reviewWindow,
  type DayDetailRow,
} from './logic';
import { Flame, Ring } from './visuals';
import WeeklyReview from './WeeklyReview';

interface Props {
  backend: Backend;
  onError: (msg: string) => void;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_PLURAL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

export default function Progress({ backend, onError }: Props) {
  const [data, setData] = useState<StatsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [review, setReview] = useState<Day | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await loadStats(backend));
      setLoadError(null);
    } catch (e) {
      setLoadError(errMsg(e));
    }
  }, [backend]);

  useEffect(() => {
    load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

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

  if (review) {
    return (
      <WeeklyReview
        backend={backend}
        data={data}
        week={review}
        onWeek={setReview}
        onBack={() => setReview(null)}
        onSaved={(r) => setData((d) => (d ? { ...d, reviews: [...d.reviews.filter((x) => x.week_start !== r.week_start), r] } : d))}
        onError={onError}
      />
    );
  }

  return <Overview data={data} onReview={setReview} />;
}

function Overview({ data, onReview }: { data: StatsData; onReview: (week: Day) => void }) {
  const { today, first, tasks, logs, extras } = data;
  const results = useMemo(() => dayResults(first, today, today, tasks, logs, extras), [data]);
  const byDay = useMemo(() => new Map(results.map((r) => [r.day, r])), [results]);
  const current = useMemo(() => streak(today, tasks, logs, extras, first), [data]);
  const best = Math.max(current, bestStreak(results));
  const thisWeek = useMemo(() => weeklyScore(today, today, tasks, logs, extras), [data]);
  const lastWeek = useMemo(() => weeklyScore(addDays(today, -7), today, tasks, logs, extras), [data]);
  const [openDay, setOpenDay] = useState<Day | null>(null);

  if (tasks.length === 0 && extras.length === 0) {
    return (
      <div className="screen">
        <header className="header">
          <h1>Progress</h1>
        </header>
        <div className="empty">
          <Flame lit={false} size={72} />
          <p>Add a task to start your first streak.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="screen stats">
      <header className="header">
        <h1>Progress</h1>
        <p className="sub">Since {prettyDay(first)}</p>
      </header>

      <StreakCard today={today} current={current} best={best} byDay={byDay} todayColor={byDay.get(today)?.color ?? 'gray'} />
      <ScoreCard thisWeek={thisWeek} lastWeek={lastWeek} />
      <ReviewCard data={data} onOpen={onReview} />
      <Calendar data={data} byDay={byDay} onOpen={setOpenDay} />
      <Excuses data={data} />

      {openDay && <DaySheet data={data} day={openDay} result={byDay.get(openDay)} onClose={() => setOpenDay(null)} />}
    </div>
  );
}

// ---------- Streak ----------

function streakMessage(current: number, best: number, color: DayColor): string {
  if (color === 'green') return current > 1 && current >= best ? 'New personal best. Keep it going!' : "Today's done. See you tomorrow.";
  if (color === 'red') return 'Today broke the streak. Tomorrow is a fresh start.';
  if (color === 'pending') return current > 0 ? `Finish today to make it ${current + 1}.` : 'Finish today to start a streak.';
  return current > 0 ? 'Nothing due today. Your streak is safe.' : 'Nothing due today.';
}

function StreakCard({
  today,
  current,
  best,
  byDay,
  todayColor,
}: {
  today: Day;
  current: number;
  best: number;
  byDay: Map<Day, DayResult>;
  todayColor: DayColor;
}) {
  const week = daysBetween(weekStart(today), addDays(weekStart(today), 6));
  return (
    <section className={`card streak-card${current > 0 ? ' hot' : ''}`} aria-label="Streak">
      <div className="streak-top">
        <Flame lit={current > 0} />
        <div className="streak-count">
          <span className="streak-num" data-testid="streak">
            {current}
          </span>
          <span className="streak-label">day streak</span>
        </div>
        <div className="streak-best">
          <span>Best</span>
          <strong data-testid="best-streak">{best}</strong>
        </div>
      </div>
      <p className="streak-msg">{streakMessage(current, best, todayColor)}</p>
      <div className="week-dots" aria-label="This week">
        {week.map((d) => {
          const c = d > today ? 'future' : byDay.get(d)?.color ?? 'none';
          return (
            <span key={d} className={`wd ${c}${d === today ? ' today' : ''}`}>
              <i aria-hidden="true">{c === 'green' ? '✓' : c === 'red' ? '✕' : ''}</i>
              {WEEKDAY_SHORT[weekday(d)].charAt(0)}
            </span>
          );
        })}
      </div>
    </section>
  );
}

// ---------- Weekly score ----------

type Score = ReturnType<typeof weeklyScore>;

function ScoreCard({ thisWeek, lastWeek }: { thisWeek: Score; lastWeek: Score }) {
  let cmp: { text: string; tone: string };
  if (thisWeek.pct === null) cmp = { text: 'Nothing counted yet', tone: 'flat' };
  else if (lastWeek.pct === null) cmp = { text: 'First week of data', tone: 'flat' };
  else {
    const d = thisWeek.pct - lastWeek.pct;
    cmp =
      d > 0
        ? { text: `▲ ${d} pts vs last week`, tone: 'up' }
        : d < 0
          ? { text: `▼ ${-d} pts vs last week`, tone: 'down' }
          : { text: 'Same as last week', tone: 'flat' };
  }
  return (
    <section className="card score-card" aria-label="Weekly score">
      <Ring pct={thisWeek.pct} />
      <div className="score-text">
        <h2>This week</h2>
        <p className="muted" data-testid="week-score">
          {thisWeek.counted === 0 ? 'Nothing due yet' : `${thisWeek.done} of ${thisWeek.counted} done`}
        </p>
        <span className={`delta ${cmp.tone}`}>{cmp.text}</span>
        <p className="score-last" data-testid="last-week-score">
          Last week: {lastWeek.pct === null ? '—' : `${lastWeek.pct}%`}
        </p>
      </div>
    </section>
  );
}

// ---------- Weekly review entry ----------

function ReviewCard({ data, onOpen }: { data: StatsData; onOpen: (week: Day) => void }) {
  const week = defaultReviewWeek(data.today, data.first);
  const isSunday = weekday(data.today) === 0;
  const note = data.reviews.find((r) => r.week_start === week)?.note;
  const open = reviewWindow(week, data.today) === 'open';
  const sub = note
    ? `“${note}”`
    : open
      ? 'What will you fix next week?'
      : `Opens ${prettyDay(addDays(week, 6))}`;
  return (
    <button
      type="button"
      className={`card review-card${isSunday ? ' hl' : ''}`}
      data-testid="open-review"
      onClick={() => onOpen(week)}
    >
      <span className="review-icon" aria-hidden="true">
        ✎
      </span>
      <span className="review-text">
        <span className="review-title">
          Weekly review {isSunday && <span className="badge today">Today</span>}
          {!isSunday && open && !note && <span className="badge due">Due</span>}
        </span>
        <span className="review-sub">{sub}</span>
      </span>
      <span className="chev" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

// ---------- Calendar ----------

function Calendar({ data, byDay, onOpen }: { data: StatsData; byDay: Map<Day, DayResult>; onOpen: (d: Day) => void }) {
  const { today, first } = data;
  const [ym, setYm] = useState<[number, number]>(() => [Number(today.slice(0, 4)), Number(today.slice(5, 7))]);
  const [dir, setDir] = useState<'l' | 'r' | ''>('');
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [y, m] = ym;
  const key = `${y}-${String(m).padStart(2, '0')}`;
  const canPrev = key > first.slice(0, 7);
  const canNext = key < today.slice(0, 7);

  const shift = (n: number) => {
    if ((n < 0 && !canPrev) || (n > 0 && !canNext)) return;
    setDir(n < 0 ? 'r' : 'l');
    setYm(([yy, mm]) => {
      const t = yy * 12 + (mm - 1) + n;
      return [Math.floor(t / 12), (t % 12) + 1];
    });
  };

  const cells = monthGrid(y, m);
  return (
    <section className="card calendar" aria-label="Calendar">
      <div className="cal-head">
        <button type="button" className="cal-nav" aria-label="Previous month" data-testid="cal-prev" disabled={!canPrev} onClick={() => shift(-1)}>
          ‹
        </button>
        <h2 data-testid="cal-month">
          {MONTHS[m - 1]} {y}
        </h2>
        <button type="button" className="cal-nav" aria-label="Next month" data-testid="cal-next" disabled={!canNext} onClick={() => shift(1)}>
          ›
        </button>
      </div>
      <div className="cal-wd" aria-hidden="true">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div
        key={key}
        className={`cal-grid${dir ? ` slide-${dir}` : ''}`}
        onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
        onTouchEnd={(e) => {
          const s = touch.current;
          touch.current = null;
          if (!s) return;
          const dx = e.changedTouches[0].clientX - s.x;
          const dy = e.changedTouches[0].clientY - s.y;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) shift(dx < 0 ? 1 : -1);
        }}
      >
        {cells.map((d, i) => {
          if (!d) return <span key={i} className="cal-cell pad" />;
          const n = Number(d.slice(8));
          if (d > today || d < first)
            return (
              <span key={d} className={`cal-cell ${d > today ? 'future' : 'before'}`}>
                {n}
              </span>
            );
          const color = byDay.get(d)?.color ?? 'gray';
          return (
            <button
              key={d}
              type="button"
              className={`cal-cell ${color}${d === today ? ' today' : ''}`}
              data-testid={`cal-${d}`}
              data-color={color}
              aria-label={`${prettyDay(d)}: ${COLOR_WORDS[color]}`}
              onClick={() => onOpen(d)}
            >
              {n}
            </button>
          );
        })}
      </div>
      <div className="legend" aria-hidden="true">
        <span>
          <i className="green" />
          All done
        </span>
        <span>
          <i className="red" />
          Missed
        </span>
        <span>
          <i className="gray" />
          Nothing due
        </span>
        <span>
          <i className="today" />
          Today
        </span>
      </div>
    </section>
  );
}

const COLOR_WORDS: Record<DayColor, string> = {
  green: 'all done',
  red: 'missed something',
  gray: 'nothing scheduled',
  pending: 'in progress',
};

const STATE_UI: Record<DayDetailRow['state'], { icon: string; label: string }> = {
  done: { icon: '✓', label: 'Done' },
  skipped: { icon: '–', label: 'Skipped' },
  missed: { icon: '✕', label: 'Missed' },
  open: { icon: '', label: 'To do' },
};

function DaySheet({ data, day, result, onClose }: { data: StatsData; day: Day; result?: DayResult; onClose: () => void }) {
  const rows = dayDetail(day, data.today, data.tasks, data.logs, data.extras, data.excuses);
  const summary =
    !result || result.required === 0
      ? 'Nothing was due'
      : result.color === 'green'
        ? 'All done'
        : `${result.done} of ${result.required} done`;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet day-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={prettyDay(day)}
        data-testid="day-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grabber" aria-hidden="true" />
        <div className="day-sheet-head">
          <h2>{prettyDay(day)}</h2>
          <span className={`pill ${result?.color ?? 'gray'}`}>{summary}</span>
        </div>
        {rows.length === 0 ? (
          <p className="muted">Rest day. Nothing was scheduled.</p>
        ) : (
          <ul className="detail-list">
            {rows.map((r, i) => (
              <li key={i} className={`detail ${r.state}`} data-testid={`detail-${r.name}`} data-state={r.state}>
                <span className="detail-icon" aria-hidden="true">
                  {STATE_UI[r.state].icon}
                </span>
                <span className="detail-text">
                  <span className="detail-name">
                    {r.name}
                    {r.critical && <span className="badge critical">Critical</span>}
                  </span>
                  <span className="detail-state">{STATE_UI[r.state].label}</span>
                  {r.reason && <span className="detail-reason">“{r.reason}”</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="btn big" data-testid="day-sheet-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

// ---------- Excuse history ----------

const PAGE = 8;

function Excuses({ data }: { data: StatsData }) {
  const all = useMemo(() => excuseHistory(data.tasks, data.logs, data.excuses), [data]);
  const patterns = useMemo(() => excusePatterns(all), [all]);
  const [filter, setFilter] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const names = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of all) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
  }, [all]);
  const list = filter ? all.filter((e) => e.name === filter) : all;
  const shown = showAll ? list : list.slice(0, PAGE);

  return (
    <section className="card excuses" aria-label="Excuse log">
      <div className="section-head">
        <h2>Excuse log</h2>
        <span className="muted">{all.length}</span>
      </div>
      {all.length === 0 ? (
        <p className="muted">No skips or misses yet. Keep it that way.</p>
      ) : (
        <>
          <div className="patterns" data-testid="patterns">
            {patterns.topItems[0] && (
              <div className="pattern">
                <span className="pattern-k">Most excused</span>
                <span className="pattern-v">
                  {patterns.topItems
                    .slice(0, 2)
                    .map((t) => `${t.name} (${t.count})`)
                    .join(', ')}
                </span>
              </div>
            )}
            {patterns.worstWeekday && (
              <div className="pattern">
                <span className="pattern-k">Toughest day</span>
                <span className="pattern-v">
                  {WEEKDAY_PLURAL[patterns.worstWeekday.weekday]} ({patterns.worstWeekday.count})
                </span>
              </div>
            )}
            {patterns.topWords.length > 0 && (
              <div className="pattern">
                <span className="pattern-k">You often say</span>
                <span className="pattern-v words">
                  {patterns.topWords.map((w) => (
                    <span key={w.word} className="word">
                      {w.word}
                    </span>
                  ))}
                </span>
              </div>
            )}
          </div>
          {names.length > 1 && (
            <div className="filters" role="group" aria-label="Filter by task">
              <button type="button" className={`fchip${filter === null ? ' on' : ''}`} onClick={() => setFilter(null)}>
                All
              </button>
              {names.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`fchip${filter === n ? ' on' : ''}`}
                  data-testid={`filter-${n}`}
                  onClick={() => setFilter(filter === n ? null : n)}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
          <ul className="excuse-list" data-testid="excuse-list">
            {shown.map((e, i) => (
              <li key={`${e.day}-${e.name}-${i}`} className="excuse">
                <div className="excuse-top">
                  <span className="excuse-name">{e.name}</span>
                  <span className={`tag ${e.kind}`}>{e.kind === 'skipped' ? 'Skipped' : 'Missed'}</span>
                  <span className="excuse-day">{prettyDay(e.day)}</span>
                </div>
                <p className="excuse-reason">“{e.reason}”</p>
              </li>
            ))}
          </ul>
          {list.length > PAGE && (
            <button type="button" className="link-btn" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show less' : `Show all ${list.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
