// Photos tab: dated feed (newest first), Compare, Timelapse and Face.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { Backend } from '../../data/backend';
import { prettyDay, type Day } from '../../lib/dates';
import { Segmented, errMsg } from '../../screens/ui';
import { settingsApi } from '../settings/api';
import { photosApi, type PhotoDay, type PhotoKind } from './api';
import CaptureFlow, { CameraIcon } from './CaptureFlow';
import Compare from './Compare';
import Timelapse from './Timelapse';
import { dayNumber, relativeLabel } from './labels';
import Viewer from './Viewer';

const PAGE = 10;
// Face analysis (and its model) only loads when the Face view is opened.
const FaceView = lazy(() => import('../face/FaceView'));

export default function PhotosScreen({ backend, onError }: { backend: Backend; onError: (msg: string) => void }) {
  const [mode, setMode] = useState<'feed' | 'compare' | 'timelapse' | 'face'>('feed');
  const [start, setStart] = useState<Day | null>(null);
  const [today, setToday] = useState<Day | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([
      backend.repo.today(),
      settingsApi(backend).get().then((s) => s.photos_from).catch(() => null),
      photosApi(backend).firstDay().catch(() => null),
    ]).then(([t, from, first]) => {
      if (!alive) return;
      setToday(t);
      // Day 1 = the day photos started counting (or the first photo, if earlier).
      setStart(from && first ? (first < from ? first : from) : from ?? first);
    });
    return () => {
      alive = false;
    };
  }, [backend, version]);

  return (
    <div className="screen photos-screen">
      <header className="header">
        <h1>Photos</h1>
      </header>
      <div className="photos-mode fx-modes">
        <Segmented
          options={[
            { value: 'feed', label: 'Feed', testid: 'photos-feed' },
            { value: 'compare', label: 'Compare', testid: 'photos-compare' },
            { value: 'timelapse', label: 'Timelapse', testid: 'photos-timelapse' },
            { value: 'face', label: 'Face', testid: 'photos-face' },
          ]}
          value={mode}
          onChange={setMode}
        />
      </div>
      {today &&
        (mode === 'feed' ? (
          <Feed
            key={version}
            backend={backend}
            today={today}
            start={start}
            onError={onError}
            onChanged={() => setVersion((v) => v + 1)}
          />
        ) : mode === 'compare' ? (
          <Compare backend={backend} start={start} onError={onError} />
        ) : mode === 'timelapse' ? (
          <Timelapse backend={backend} start={start} onError={onError} />
        ) : (
          <Suspense fallback={<p className="muted center">Loading…</p>}>
            <FaceView backend={backend} start={start} onError={onError} />
          </Suspense>
        ))}
    </div>
  );
}

function Feed({
  backend,
  today,
  start,
  onError,
  onChanged,
}: {
  backend: Backend;
  today: Day;
  start: Day | null;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const api = photosApi(backend);
  const [days, setDays] = useState<PhotoDay[]>([]);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ day: PhotoDay; kind: PhotoKind } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);

  const loadMore = useCallback(async () => {
    if (inFlight.current || !more) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const before = days.length ? days[days.length - 1].day : undefined;
      const page = await api.listDays(before, PAGE);
      setDays((d) => [...d, ...page]);
      setMore(page.length === PAGE);
      setFailed(null);
    } catch (e) {
      setFailed(errMsg(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [api, days, more]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more || failed) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: '800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, more, failed]);

  const todayDone = days[0]?.day === today && days[0].faceUrl && days[0].bodyUrl;
  const loadedOnce = !more || days.length > 0;

  return (
    <>
      {loadedOnce && !todayDone && (
        <button type="button" className="photo-cta" data-testid="photos-take" onClick={() => setCapturing(true)}>
          <span className="photo-cta-icon" aria-hidden="true">
            <CameraIcon />
          </span>
          <span className="item-text">
            <span className="item-name">Take today's photos</span>
            <span className="item-meta">Face + body · {prettyDay(today)}</span>
          </span>
          <span className="photo-cta-go" aria-hidden="true">
            ›
          </span>
        </button>
      )}

      {days.length === 0 && !more && (
        <div className="empty photos-empty">
          <p>No photos yet</p>
          <p className="muted small">Your first day will show up here.</p>
        </div>
      )}

      <ul className="pfeed" data-testid="photo-feed">
        {days.map((d) => (
          <li key={d.day}>
            <DayCard
              d={d}
              label={relativeLabel(d.day, today)}
              num={dayNumber(d.day, start)}
              onOpen={(kind) => setViewing({ day: d, kind })}
            />
          </li>
        ))}
      </ul>

      {failed && (
        <div className="empty">
          <p className="error">Couldn't load photos: {failed}</p>
          <button type="button" className="btn" onClick={loadMore}>
            Try again
          </button>
        </div>
      )}
      {more && !failed && (
        <div ref={sentinel} className="pfeed-more muted">
          {loading ? 'Loading…' : ''}
        </div>
      )}

      {viewing && (
        <Viewer
          d={viewing.day}
          kind={viewing.kind}
          num={dayNumber(viewing.day.day, start)}
          onClose={() => setViewing(null)}
        />
      )}
      {capturing && (
        <CaptureFlow
          backend={backend}
          onClose={(changed) => {
            setCapturing(false);
            if (changed) onChanged();
          }}
        />
      )}
    </>
  );
}

function DayCard({
  d,
  label,
  num,
  onOpen,
}: {
  d: PhotoDay;
  label: string | null;
  num: number | null;
  onOpen: (k: PhotoKind) => void;
}) {
  const main: PhotoKind = d.bodyUrl ? 'body' : 'face';
  const mainUrl = d.bodyUrl ?? d.faceUrl;
  const inset = d.bodyUrl && d.faceUrl ? d.faceUrl : null;
  return (
    <div className="pcard" data-testid={`photo-day-${d.day}`}>
      <button type="button" className="pcard-main" aria-label={`Open ${prettyDay(d.day)}`} onClick={() => onOpen(main)}>
        {mainUrl && <img src={mainUrl} alt={`${main} photo, ${prettyDay(d.day)}`} loading="lazy" decoding="async" />}
      </button>
      {inset && (
        <button
          type="button"
          className="pcard-inset"
          aria-label={`Open face photo, ${prettyDay(d.day)}`}
          data-testid="photo-inset"
          onClick={() => onOpen('face')}
        >
          <img src={inset} alt="" loading="lazy" decoding="async" />
        </button>
      )}
      <div className="pcard-label">
        <span className="pcard-date">
          {label ? <>{label} · </> : null}
          {prettyDay(d.day)}
        </span>
        {num !== null && <span className="pcard-num">Day {num}</span>}
      </div>
      {!(d.faceUrl && d.bodyUrl) && (
        <span className="pcard-partial">{d.faceUrl ? 'Body missing' : 'Face missing'}</span>
      )}
    </div>
  );
}
