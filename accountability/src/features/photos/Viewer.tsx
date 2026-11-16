// Full-screen photo: tap or swipe to switch face/body.
import { useEffect, useRef, useState } from 'react';
import { prettyDay } from '../../lib/dates';
import type { PhotoDay, PhotoKind } from './api';

export default function Viewer({
  d,
  kind,
  num,
  onClose,
}: {
  d: PhotoDay;
  kind: PhotoKind;
  num: number | null;
  onClose: () => void;
}) {
  const kinds = (['body', 'face'] as const).filter((k) => (k === 'face' ? d.faceUrl : d.bodyUrl));
  const [cur, setCur] = useState<PhotoKind>(kind);
  const start = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);

  const other = () => setCur((c) => kinds.find((k) => k !== c) ?? c);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') other();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const url = cur === 'face' ? d.faceUrl : d.bodyUrl;

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`Photos, ${prettyDay(d.day)}`} data-testid="viewer">
      <div className="viewer-top">
        <div className="viewer-date">
          <strong>{prettyDay(d.day)}</strong>
          {num !== null && <span>Day {num}</span>}
        </div>
        <button type="button" className="cam-round" aria-label="Close" data-testid="viewer-close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div
        className="viewer-stage"
        data-testid="viewer-stage"
        onPointerDown={(e) => {
          start.current = { x: e.clientX, y: e.clientY };
          swiped.current = false;
        }}
        onPointerUp={(e) => {
          const s = start.current;
          start.current = null;
          if (!s) return;
          const dx = e.clientX - s.x;
          const dy = e.clientY - s.y;
          if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) {
            swiped.current = true;
            onClose(); // swipe down to close
          } else if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
            swiped.current = true;
            other();
          }
        }}
        onClick={() => {
          if (!swiped.current) other();
          swiped.current = false;
        }}
      >
        {url && <img key={cur} src={url} alt={`${cur} photo, ${prettyDay(d.day)}`} data-testid="viewer-img" draggable={false} />}
      </div>
      <div className="viewer-bottom">
        <div className="viewer-toggle" role="tablist">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={cur === k}
              className={cur === k ? 'on' : ''}
              data-testid={`viewer-${k}`}
              onClick={() => setCur(k)}
            >
              {k === 'face' ? 'Face' : 'Body'}
            </button>
          ))}
        </div>
        {kinds.length > 1 && <p className="viewer-hint">Tap or swipe to switch</p>}
      </div>
    </div>
  );
}
