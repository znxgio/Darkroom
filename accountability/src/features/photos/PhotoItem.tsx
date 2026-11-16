// "Daily photos" row at the top of Today. Looks like a task row; opens the camera.
import { useCallback, useEffect, useState } from 'react';
import type { Backend } from '../../data/backend';
import { settingsApi } from '../settings/api';
import { photosApi, type TodayPhotos } from './api';
import CaptureFlow from './CaptureFlow';

export default function PhotoItem({ backend, onError }: { backend: Backend; onError?: (msg: string) => void }) {
  const [have, setHave] = useState<TodayPhotos | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      // Reading settings also starts the photo streak (photos_from) on first use.
      const [t] = await Promise.all([photosApi(backend).today(), settingsApi(backend).get().catch(() => null)]);
      setHave(t);
    } catch {
      setHave((h) => h ?? {});
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

  const done = !!(have?.face && have?.body);
  const state = done ? 'done' : 'open';
  let meta = 'Face + body · takes a minute';
  if (done) meta = 'Both taken · tap to retake';
  else if (have?.face) meta = 'Face done · body next';
  else if (have?.body) meta = 'Body done · face next';

  return (
    <>
      <ul className="checklist photo-list">
        <li className={`item photo-item ${state}`}>
          <button
            type="button"
            className="item-main"
            data-testid="photo-row"
            data-state={state}
            aria-pressed={done}
            onClick={() => setOpen(true)}
          >
            <span className="check" aria-hidden="true">
              {done ? '✓' : <CamGlyph />}
            </span>
            <span className="item-text">
              <span className="item-name">Daily photos</span>
              <span className="item-meta">{have ? meta : 'Loading…'}</span>
            </span>
            {(have?.face || have?.body) && (
              <span className="photo-thumbs" data-testid="photo-thumbs">
                {(['face', 'body'] as const).map((k) =>
                  have[k] ? (
                    <img key={k} src={have[k]} alt={`Today's ${k} photo`} />
                  ) : (
                    <span key={k} className="photo-thumb-empty" />
                  ),
                )}
              </span>
            )}
          </button>
        </li>
      </ul>
      {open && (
        <CaptureFlow
          backend={backend}
          onClose={(changed) => {
            setOpen(false);
            if (changed) load().catch((e) => onError?.(String(e)));
          }}
        />
      )}
    </>
  );
}

function CamGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M4 8h3l1.6-2.4A1.5 1.5 0 0 1 9.9 5h4.2a1.5 1.5 0 0 1 1.3.6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}
