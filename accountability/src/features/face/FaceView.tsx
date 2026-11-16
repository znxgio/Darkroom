// Photos → Face: on-device face measurements from the daily face photo, a Harmony score,
// strengths / could-improve, every metric vs a popular reference range, and the change vs an
// earlier photo (only called real when it beats photo noise). Loaded lazily with the model.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Backend } from '../../data/backend';
import { prettyDay, type Day } from '../../lib/dates';
import { errMsg } from '../../screens/ui';
import { photosApi, type PhotoDay } from '../photos/api';
import { dayNumber, relativeLabel } from '../photos/labels';
import { trackersApi } from '../trackers/api';
import { trackerByKey } from '../trackers/registry';
import TrackerDetail from '../trackers/TrackerDetail';
import '../trackers/trackers.css';
import { analyzeDay, LOW_LIGHT, saveToday, type FaceResult } from './analyze';
import { FACE_TRACKER } from './constants';
import { OfflineError } from './detector';
import type { Seg } from './metrics';
import { POSE_LIMIT, rangeOf } from './ranges';
import { compareFaces, scoreFace, type FaceChange, type FaceScore, type MetricScore } from './score';
import './face.css';

type Phase =
  | { k: 'loading'; pct: number | null }
  | { k: 'done'; r: FaceResult }
  | { k: 'error'; msg: string; offline: boolean };

interface Shot {
  day: Day;
  url: string;
}

const OVERLAY_KEY = 'fx-overlay';

function readOverlay(): boolean {
  try {
    return localStorage.getItem(OVERLAY_KEY) !== '0';
  } catch {
    return true;
  }
}

function useAnalysis(backend: Backend, shot: Shot | null, today: Day | null) {
  const [phase, setPhase] = useState<Phase | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!shot || !today) {
      setPhase(null);
      return;
    }
    let alive = true;
    setPhase({ k: 'loading', pct: null });
    analyzeDay(backend, shot.day, shot.url, (l, t) => {
      if (alive) setPhase({ k: 'loading', pct: t ? Math.min(99, Math.round((l / t) * 100)) : null });
    })
      .then(async (r) => {
        if (!alive) return;
        setPhase({ k: 'done', r });
        if (shot.day === today) await saveToday(backend, r).catch(() => {});
      })
      .catch((e) => {
        if (!alive) return;
        const offline = e instanceof OfflineError || (typeof navigator !== 'undefined' && navigator.onLine === false);
        setPhase({ k: 'error', msg: offline ? '' : errMsg(e), offline });
      });
    return () => {
      alive = false;
    };
  }, [backend, shot?.day, shot?.url, today, tick]);
  const retry = useCallback(() => setTick((n) => n + 1), []);
  return { phase, retry };
}

export default function FaceView({
  backend,
  start,
  onError,
}: {
  backend: Backend;
  start: Day | null;
  onError: (msg: string) => void;
}) {
  const api = photosApi(backend);
  const [today, setToday] = useState<Day | null>(null);
  const [latest, setLatest] = useState<Shot | null | undefined>(undefined);
  const [days, setDays] = useState<Day[]>([]);
  const [cmpDay, setCmpDay] = useState<Day | null>(null);
  const [cmpShot, setCmpShot] = useState<Shot | null | 'none'>(null);
  const [overlay, setOverlay] = useState(readOverlay);
  const [history, setHistory] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [t, recent, all] = await Promise.all([backend.repo.today(), api.listDays(undefined, 14), api.allDays()]);
        if (!alive) return;
        const faces = recent.filter((d: PhotoDay) => d.faceUrl);
        setToday(t);
        setDays(all);
        if (!faces.length) {
          setLatest(null);
          return;
        }
        setLatest({ day: faces[0].day, url: faces[0].faceUrl! });
        const prev = faces[1]?.day ?? all.find((d) => d < faces[0].day) ?? null;
        setCmpDay(prev);
      } catch (e) {
        if (alive) {
          setLatest(null);
          onError(`Couldn't load photos: ${errMsg(e)}`);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, backend, onError]);

  // The photo to compare with.
  useEffect(() => {
    if (!cmpDay) {
      setCmpShot(null);
      return;
    }
    let alive = true;
    api
      .getDays([cmpDay])
      .then(([d]) => alive && setCmpShot(d?.faceUrl ? { day: cmpDay, url: d.faceUrl } : 'none'))
      .catch(() => alive && setCmpShot('none'));
    return () => {
      alive = false;
    };
  }, [api, cmpDay]);

  const cur = useAnalysis(backend, latest ?? null, today);
  // Compare only once the main photo is done (the model is loaded by then).
  const cmpReady = cur.phase?.k === 'done' && cmpShot && cmpShot !== 'none' ? cmpShot : null;
  const cmp = useAnalysis(backend, cmpReady, today);

  const curR = cur.phase?.k === 'done' ? cur.phase.r : null;
  const cmpR = cmp.phase?.k === 'done' ? cmp.phase.r : null;
  const score = useMemo(() => (curR?.status === 'ok' ? scoreFace(curR.metrics) : null), [curR]);
  const change = useMemo(
    () => (curR?.status === 'ok' && cmpR?.status === 'ok' ? compareFaces(curR.metrics, cmpR.metrics) : null),
    [curR, cmpR],
  );

  function toggleOverlay() {
    setOverlay((v) => {
      try {
        localStorage.setItem(OVERLAY_KEY, v ? '0' : '1');
      } catch {
        /* per-device convenience */
      }
      return !v;
    });
  }

  if (latest === undefined || !today) return <p className="muted center">Loading…</p>;
  if (latest === null) {
    return (
      <div className="empty photos-empty fx-empty" data-testid="face-empty">
        <FaceIcon />
        <p>No face photo yet</p>
        <p className="muted small">Take today's photos and your face score shows up here.</p>
      </div>
    );
  }

  const label = relativeLabel(latest.day, today) ?? prettyDay(latest.day);
  const num = dayNumber(latest.day, start);
  const phase = cur.phase;
  const cmpLabel = cmpDay ? prettyDay(cmpDay).replace(/^\w+, /, '') : null;
  const def = trackerByKey(FACE_TRACKER)!;

  return (
    <div className="fx-view" data-testid="face-view">
      <PhotoPanel
        shot={latest}
        result={curR}
        overlay={overlay}
        loading={phase?.k === 'loading'}
        onToggle={toggleOverlay}
        caption={`${label}${label !== prettyDay(latest.day) ? ` · ${prettyDay(latest.day)}` : ''}${num !== null ? ` · Day ${num}` : ''}`}
      />

      {phase?.k === 'loading' && (
        <div className="fx-card fx-status" data-testid="face-loading" role="status" aria-live="polite">
          <span className="fx-spinner" aria-hidden="true" />
          <div>
            <strong>{phase.pct === null ? 'Analyzing your photo…' : `Loading face model… ${phase.pct}%`}</strong>
            <p className="fx-sub">
              {phase.pct === null
                ? 'Measuring on this phone. The photo never leaves it.'
                : 'One-time download (about 13 MB), then it works offline.'}
            </p>
          </div>
        </div>
      )}

      {phase?.k === 'error' && (
        <div className="fx-card fx-status fx-warn" data-testid="face-error" role="alert">
          <div>
            <strong>{phase.offline ? "You're offline" : "Couldn't analyze the photo"}</strong>
            <p className="fx-sub">
              {phase.offline
                ? 'The face model downloads once (about 13 MB). Connect to the internet and try again.'
                : phase.msg}
            </p>
            <button type="button" className="btn small fx-retry" onClick={cur.retry}>
              Try again
            </button>
          </div>
        </div>
      )}

      {curR?.status === 'noface' && (
        <div className="fx-card fx-status fx-warn" data-testid="face-noface">
          <FaceIcon />
          <div>
            <strong>No face found in this photo</strong>
            <p className="fx-sub">
              {curR.light < LOW_LIGHT ? 'The photo looks dark. ' : ''}Face the camera straight on, with your whole face
              inside the oval and even light. Retake today's face photo to get a score.
            </p>
          </div>
        </div>
      )}

      {curR?.status === 'ok' && score && (
        <>
          <ScoreCard score={score} change={change} cmpLabel={cmpLabel} cmpState={cmpState(cmpShot, cmp.phase)} />
          <p className="fx-honesty" data-testid="face-honesty">
            Measured from a phone photo — angle, distance and expression shift these numbers. Ranges are popular
            reference values, not science.
          </p>
          <Quality r={curR} />
          <ListCard title="Strengths" kind="good" items={score.strengths} testid="face-strengths" />
          <ListCard title="Could improve" kind="improve" items={score.improve} testid="face-improve" />

          <div className="fx-compare">
            <label htmlFor="fx-compare-select">Compare with</label>
            <select
              id="fx-compare-select"
              data-testid="face-compare-select"
              value={cmpDay ?? ''}
              onChange={(e) => setCmpDay(e.target.value || null)}
            >
              <option value="">Nothing</option>
              {days
                .filter((d) => d !== latest.day)
                .map((d) => (
                  <option key={d} value={d}>
                    {shortDay(d, today)}
                  </option>
                ))}
            </select>
          </div>

          <h2 className="section-title">All measurements</h2>
          <ul className="fx-metrics">
            {score.items.map((it) => (
              <MetricRow
                key={it.key}
                it={it}
                change={change?.metrics.find((c) => c.key === it.key) ?? null}
                extra={
                  it.key === 'canthal'
                    ? `Left ${signedDeg(curR.metrics.canthalL)} · Right ${signedDeg(curR.metrics.canthalR)} (as in photo)`
                    : undefined
                }
              />
            ))}
          </ul>

          <h2 className="section-title">Photo angle</h2>
          <div className="fx-tiles">
            <Tile label="Turn" value={`${Math.abs(curR.metrics.pose.yaw).toFixed(0)}°`} warn={Math.abs(curR.metrics.pose.yaw) > 10} />
            <Tile label="Nod" value={`${Math.abs(curR.metrics.pose.pitch).toFixed(0)}°`} warn={Math.abs(curR.metrics.pose.pitch) > 10} />
            <Tile label="Tilt" value={`${Math.abs(curR.metrics.pose.roll).toFixed(0)}°`} />
            <Tile label="Face size" value={`${Math.round(curR.metrics.faceSize * 100)}%`} warn={curR.metrics.faceSize < 0.3} />
          </div>
          <p className="fx-foot">Tilt is corrected for. Small turns and nods are corrected using the face's depth.</p>
        </>
      )}

      <button type="button" className="fx-history" data-testid="face-history" onClick={() => setHistory(true)}>
        <ChartIcon />
        <span>Score history</span>
        <span className="chev" aria-hidden="true">
          ›
        </span>
      </button>

      {history && def && (
        <TrackerDetail
          def={def}
          api={trackersApi(backend)}
          backend={backend}
          backLabel="Face"
          onClose={() => setHistory(false)}
          onChanged={() => {}}
        />
      )}
    </div>
  );
}

type CmpState = 'none' | 'nophoto' | 'loading' | 'noface' | 'error' | 'ok';

function cmpState(shot: Shot | null | 'none', phase: Phase | null): CmpState {
  if (shot === 'none') return 'nophoto';
  if (!shot) return 'none';
  if (!phase || phase.k === 'loading') return 'loading';
  if (phase.k === 'error') return 'error';
  return phase.r.status === 'ok' ? 'ok' : 'noface';
}

function shortDay(d: Day, today: Day): string {
  const rel = relativeLabel(d, today);
  return rel ? `${rel} · ${prettyDay(d)}` : prettyDay(d);
}

const signedDeg = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°`;

// ---------- photo + overlay ----------

function cropBox(r: FaceResult | null, w: number, h: number) {
  // Zoom to the face (4:5 box around the landmarks), or show the whole photo.
  if (!r || r.status !== 'ok' || !r.dots.length) return { x: 0, y: 0, w, h };
  const xs = r.dots.map((d) => d.x);
  const ys = r.dots.map((d) => d.y);
  const fw = Math.max(...xs) - Math.min(...xs);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2 - fw * 0.08;
  let bw = Math.min(w, fw * 1.75);
  let bh = bw * 1.25;
  if (bh > h) {
    bh = h;
    bw = bh / 1.25;
  }
  const x = Math.max(0, Math.min(w - bw, cx - bw / 2));
  const y = Math.max(0, Math.min(h - bh, cy - bh / 2));
  return { x, y, w: bw, h: bh };
}

function PhotoPanel({
  shot,
  result,
  overlay,
  loading,
  onToggle,
  caption,
}: {
  shot: Shot;
  result: FaceResult | null;
  overlay: boolean;
  loading: boolean;
  onToggle: () => void;
  caption: string;
}) {
  const ok = result?.status === 'ok' ? result : null;
  const w = result?.w ?? 960;
  const h = result?.h ?? 1280;
  const box = cropBox(result, w, h);
  return (
    <div className={`fx-photo${loading ? ' fx-scanning' : ''}`} data-testid="face-photo">
      {result ? (
        <svg
          className="fx-svg"
          viewBox={`${r2(box.x)} ${r2(box.y)} ${r2(box.w)} ${r2(box.h)}`}
          preserveAspectRatio="xMidYMid slice"
          role="img"
          aria-label={`Face photo, ${caption}`}
        >
          <image href={shot.url} x={0} y={0} width={w} height={h} />
          {ok && overlay && <Overlay lines={ok.lines} dots={ok.dots} />}
        </svg>
      ) : (
        <img src={shot.url} alt={`Face photo, ${caption}`} />
      )}
      {loading && <div className="fx-scan" aria-hidden="true" />}
      <span className="fx-caption">{caption}</span>
      {ok && (
        <button
          type="button"
          className={`fx-chip${overlay ? ' on' : ''}`}
          aria-pressed={overlay}
          data-testid="face-overlay-toggle"
          onClick={onToggle}
        >
          <LinesIcon />
          Lines
        </button>
      )}
    </div>
  );
}

function Overlay({ lines, dots }: { lines: Seg[]; dots: { x: number; y: number }[] }) {
  return (
    <g className="fx-lines" data-testid="face-overlay">
      {lines.map((l, i) => (
        <line key={i} className={`fx-l-${l.k}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} vectorEffect="non-scaling-stroke" />
      ))}
      {dots.map((d, i) => (
        <circle key={i} className="fx-dot" cx={d.x} cy={d.y} r={3.2} vectorEffect="non-scaling-stroke" />
      ))}
    </g>
  );
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------- score ----------

function ScoreCard({
  score,
  change,
  cmpLabel,
  cmpState,
}: {
  score: FaceScore;
  change: FaceChange | null;
  cmpLabel: string | null;
  cmpState: CmpState;
}) {
  const R = 46;
  const C = 2 * Math.PI * R;
  const frac = Math.max(0, Math.min(1, score.harmony / 100));
  let deltaText: string;
  let deltaCls = '';
  if (change && cmpLabel) {
    if (change.scoreReal) {
      deltaText = `${change.scoreDelta > 0 ? '+' : '−'}${Math.abs(change.scoreDelta)} vs ${cmpLabel}`;
      deltaCls = change.scoreDelta > 0 ? ' up' : ' down';
    } else deltaText = `≈ same as ${cmpLabel} (within photo noise)`;
  } else if (cmpState === 'loading') deltaText = 'Comparing…';
  else if (cmpState === 'nophoto') deltaText = `No face photo on ${cmpLabel}`;
  else if (cmpState === 'noface') deltaText = `No face found in the ${cmpLabel} photo`;
  else if (cmpState === 'error') deltaText = "Couldn't analyze the earlier photo";
  else deltaText = 'First score — the next photo shows the change';
  return (
    <div className="fx-card fx-score" data-testid="face-score">
      <svg className="fx-ring" viewBox="0 0 110 110" aria-hidden="true">
        <circle className="fx-ring-bg" cx="55" cy="55" r={R} />
        <circle
          className="fx-ring-fg"
          cx="55"
          cy="55"
          r={R}
          strokeDasharray={`${C * frac} ${C}`}
          transform="rotate(-90 55 55)"
        />
      </svg>
      <div className="fx-score-num" aria-label={`Harmony score ${score.harmony} out of 100`}>
        <span data-testid="face-score-value">{score.harmony}</span>
        <small>/100</small>
      </div>
      <div className="fx-score-side">
        <span className="fx-score-title">Harmony score</span>
        <span className={`fx-delta${deltaCls}`} data-testid="face-delta">
          {deltaText}
        </span>
        {change?.poseDiffers && (
          <span className="fx-pose-warn" data-testid="face-pose-warn">
            Head angle differs by more than {POSE_LIMIT}° from that photo, so this comparison is less reliable.
          </span>
        )}
      </div>
    </div>
  );
}

function Quality({ r }: { r: Extract<FaceResult, { status: 'ok' }> }) {
  const notes: string[] = [];
  if (r.faces > 1) notes.push(`${r.faces} faces found — measuring the largest one.`);
  if (r.light < LOW_LIGHT) notes.push('The photo looks dark; landmarks may be less accurate.');
  if (!r.metrics.eyesOpen) notes.push('Eyes look closed or squinting, which affects eye measurements.');
  if (r.metrics.faceSize < 0.3) notes.push('Your face is small in the frame; move the phone closer.');
  if (Math.abs(r.metrics.pose.yaw) > 10 || Math.abs(r.metrics.pose.pitch) > 10)
    notes.push('Head is turned noticeably; face the camera straight on for steadier numbers.');
  if (!notes.length) return null;
  return (
    <ul className="fx-quality" data-testid="face-quality">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

function ListCard({
  title,
  kind,
  items,
  testid,
}: {
  title: string;
  kind: 'good' | 'improve';
  items: MetricScore[];
  testid: string;
}) {
  return (
    <section className={`fx-card fx-list fx-${kind}`} data-testid={testid}>
      <h3>{title}</h3>
      <ul>
        {items.map((it) => (
          <li key={it.key}>
            <span className="fx-li-icon" aria-hidden="true">
              {kind === 'good' ? '✓' : '↗'}
            </span>
            <span>{it.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MetricRow({
  it,
  change,
  extra,
}: {
  it: MetricScore;
  change: { delta: number; real: boolean } | null;
  extra?: string;
}) {
  const def = rangeOf(it.key);
  const pct = Math.round(it.score * 10);
  const tone = it.score >= 8.5 ? 'hi' : it.score >= 5 ? 'mid' : 'lo';
  let delta: string | null = null;
  if (change) {
    if (!change.real) delta = '≈ same';
    else {
      const d = Math.abs(change.delta);
      const unit = it.key === 'canthal' ? '°' : it.key === 'symmetry' ? '%' : '';
      const dec = it.key === 'canthal' || it.key === 'lowerSplit' ? 1 : it.key === 'symmetry' ? 0 : it.key === 'esr' ? 3 : 2;
      delta = `${change.delta > 0 ? '+' : '−'}${d.toFixed(dec)}${unit}`;
    }
  }
  return (
    <li className="fx-metric" data-testid={`face-metric-${it.key}`}>
      <div className="fx-m-top">
        <span className="fx-m-name">{def.label}</span>
        <span className="fx-m-val">{def.fmt(it.value)}</span>
      </div>
      <div className="fx-m-bar-row">
        <span className={`fx-m-bar fx-${tone}`} aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </span>
        <span className="fx-m-score">{it.score.toFixed(1)}</span>
      </div>
      <div className="fx-m-meta">
        <span>
          Range {def.range}
          {it.where !== 'in' && <> · {it.where}</>}
        </span>
        {delta && <span className={`fx-m-delta${change?.real ? ' real' : ''}`}>{delta}</span>}
      </div>
      {extra && <p className="fx-m-note">{extra}</p>}
      <p className="fx-m-note">{def.note}</p>
    </li>
  );
}

function Tile({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`fx-tile${warn ? ' warn' : ''}`}>
      <span className="fx-tile-label">{label}</span>
      <span className="fx-tile-value">{value}</span>
    </div>
  );
}

// ---------- icons ----------

function FaceIcon() {
  return (
    <svg className="fx-face-icon" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <circle cx="9" cy="10" r="0.6" fill="currentColor" />
      <circle cx="15" cy="10" r="0.6" fill="currentColor" />
      <path d="M9 15c1.6 1.3 4.4 1.3 6 0" />
    </svg>
  );
}

function LinesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M3 8h18M3 16h18M12 3v18" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19h16M5 15l4-5 4 3 6-7" />
    </svg>
  );
}
