// Side-by-side: any two photo days (default first vs latest), Body or Face.
import { useEffect, useState } from 'react';
import type { Backend } from '../../data/backend';
import { prettyDay, type Day } from '../../lib/dates';
import { Segmented, errMsg } from '../../screens/ui';
import { photosApi, type PhotoDay, type PhotoKind } from './api';
import { dayNumber, daysApart } from './labels';

export default function Compare({
  backend,
  start,
  onError,
}: {
  backend: Backend;
  start: Day | null;
  onError: (msg: string) => void;
}) {
  const api = photosApi(backend);
  const [all, setAll] = useState<Day[] | null>(null);
  const [a, setA] = useState<Day | null>(null);
  const [b, setB] = useState<Day | null>(null);
  const [kind, setKind] = useState<PhotoKind>('body');
  const [shots, setShots] = useState<PhotoDay[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .allDays()
      .then((days) => {
        if (!alive) return;
        setAll(days);
        if (days.length) {
          setA(days[days.length - 1]);
          setB(days[0]);
        }
      })
      .catch((e) => onError(`Couldn't load photos: ${errMsg(e)}`));
    return () => {
      alive = false;
    };
  }, [api, onError]);

  useEffect(() => {
    if (!a || !b) return;
    let alive = true;
    api
      .getDays([a, b])
      .then((r) => alive && setShots(r))
      .catch((e) => onError(`Couldn't load photos: ${errMsg(e)}`));
    return () => {
      alive = false;
    };
  }, [api, a, b, onError]);

  if (!all) return <p className="muted center">Loading…</p>;
  if (all.length < 2) {
    return (
      <div className="empty photos-empty" data-testid="compare-empty">
        <p>{all.length === 0 ? 'No photos yet' : 'One day so far'}</p>
        <p className="muted small">Compare opens up once you have photos from two different days.</p>
      </div>
    );
  }

  const sides: [Day | null, (d: Day) => void, string][] = [
    [a, setA, 'compare-a'],
    [b, setB, 'compare-b'],
  ];
  const gap = a && b ? daysApart(a, b) : 0;

  return (
    <div className="compare" data-testid="compare">
      <Segmented
        options={[
          { value: 'body', label: 'Body', testid: 'compare-body' },
          { value: 'face', label: 'Face', testid: 'compare-face' },
        ]}
        value={kind}
        onChange={setKind}
      />
      <div className="compare-grid">
        {sides.map(([day, set, tid]) => {
          const shot = shots.find((s) => s.day === day);
          const url = kind === 'face' ? shot?.faceUrl : shot?.bodyUrl;
          const num = day ? dayNumber(day, start) : null;
          return (
            <div className="compare-col" key={tid}>
              <div className="compare-photo">
                {url ? (
                  <img src={url} alt={`${kind} photo, ${day ? prettyDay(day) : ''}`} data-testid={`${tid}-img`} />
                ) : (
                  <span className="muted small">{shot ? `No ${kind} photo` : ''}</span>
                )}
                {num !== null && <span className="compare-num">Day {num}</span>}
              </div>
              <label className="compare-pick">
                <span className="sr-only">{tid === 'compare-a' ? 'Before' : 'After'}</span>
                <select data-testid={tid} value={day ?? ''} onChange={(e) => set(e.target.value)}>
                  {all.map((d) => (
                    <option key={d} value={d}>
                      {prettyDay(d)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          );
        })}
      </div>
      <p className="compare-gap" data-testid="compare-gap">
        {gap === 0 ? 'Same day' : `${gap} day${gap === 1 ? '' : 's'} apart`}
      </p>
    </div>
  );
}
