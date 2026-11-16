// Flipbook of every photo day, oldest → newest, with date, day number and weight.
import { useEffect, useRef, useState } from 'react';
import type { Backend } from '../../data/backend';
import { prettyDay, type Day } from '../../lib/dates';
import { Segmented, errMsg } from '../../screens/ui';
import { trackersApi } from '../trackers/api';
import { photosApi, type PhotoDay, type PhotoKind } from './api';
import { dayNumber } from './labels';

const SPEEDS = [2, 4, 8]; // frames per second

export default function Timelapse({
  backend,
  start,
  onError,
}: {
  backend: Backend;
  start: Day | null;
  onError: (msg: string) => void;
}) {
  const [frames, setFrames] = useState<PhotoDay[] | null>(null);
  const [weights, setWeights] = useState<Record<Day, number>>({});
  const [kind, setKind] = useState<PhotoKind>('body');
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    (async () => {
      const api = photosApi(backend);
      const days = (await api.allDays()).slice().reverse(); // oldest first
      const shots: PhotoDay[] = [];
      for (let k = 0; k < days.length; k += 30) shots.push(...(await api.getDays(days.slice(k, k + 30))));
      shots.sort((x, y) => (x.day < y.day ? -1 : 1));
      if (!alive) return;
      setFrames(shots);
      setI(Math.max(0, shots.length - 1));
      if (days.length) {
        const rows = await trackersApi(backend).list('weight', days[0], days[days.length - 1]).catch(() => []);
        const w: Record<Day, number> = {};
        for (const r of rows) {
          const v = (r.value as { v?: number }).v;
          if (typeof v === 'number') w[r.day] = v;
        }
        if (alive) setWeights(w);
      }
    })().catch((e) => onError(`Couldn't load photos: ${errMsg(e)}`));
    return () => {
      alive = false;
    };
  }, [backend, onError]);

  const usable = (frames ?? []).filter((f) => (kind === 'body' ? f.bodyUrl : f.faceUrl));

  // Preload so playback doesn't flicker.
  useEffect(() => {
    for (const f of usable) {
      const u = kind === 'body' ? f.bodyUrl : f.faceUrl;
      if (u) new Image().src = u;
    }
  }, [usable.length, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    window.clearInterval(timer.current);
    if (!playing || usable.length < 2) return;
    timer.current = window.setInterval(() => {
      setI((n) => {
        if (n >= usable.length - 1) {
          setPlaying(false);
          return n;
        }
        return n + 1;
      });
    }, 1000 / SPEEDS[speed]);
    return () => window.clearInterval(timer.current);
  }, [playing, speed, usable.length]);

  if (!frames) return <p className="muted center">Loading…</p>;
  if (usable.length < 2) {
    return (
      <div className="empty photos-empty" data-testid="timelapse-empty">
        <p>Not enough photos yet</p>
        <p className="muted small">The timelapse plays once you have a few days of photos.</p>
      </div>
    );
  }

  const idx = Math.min(i, usable.length - 1);
  const f = usable[idx];
  const url = kind === 'body' ? f.bodyUrl : f.faceUrl;
  const n = dayNumber(f.day, start);

  return (
    <div className="tl" data-testid="timelapse">
      <Segmented
        options={[
          { value: 'body', label: 'Body', testid: 'tl-body' },
          { value: 'face', label: 'Face', testid: 'tl-face' },
        ]}
        value={kind}
        onChange={(k) => {
          setKind(k);
          setI(0);
        }}
      />
      <div className="tl-stage">
        <img src={url} alt={`${kind} photo, ${prettyDay(f.day)}`} data-testid="tl-img" />
        <div className="tl-label">
          <span>
            <span className="tl-day">Day {n}</span>
            <br />
            {prettyDay(f.day)}
          </span>
          {weights[f.day] != null && <span>{weights[f.day]} lb</span>}
        </div>
      </div>
      <div className="tl-controls">
        <button
          type="button"
          className="tl-play"
          data-testid="tl-play"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => {
            if (!playing && idx >= usable.length - 1) setI(0);
            setPlaying(!playing);
          }}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <input
          type="range"
          min={0}
          max={usable.length - 1}
          value={idx}
          aria-label="Scrub through days"
          data-testid="tl-scrub"
          onChange={(e) => {
            setPlaying(false);
            setI(Number(e.target.value));
          }}
        />
        <button type="button" className="btn small tl-speed" data-testid="tl-speed" onClick={() => setSpeed((s) => (s + 1) % SPEEDS.length)}>
          {SPEEDS[speed]}×
        </button>
      </div>
      <p className="muted small center">
        {idx + 1} of {usable.length} days
      </p>
    </div>
  );
}
