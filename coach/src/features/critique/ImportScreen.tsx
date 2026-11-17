import type { PhotoWithCritiques, Settings } from '../../data/types';
import { formatScore, scoreClass } from './CritiqueView';

interface Props {
  settings: Settings;
  recent: PhotoWithCritiques[];
  onPick: () => void;
  onOpen: (id: string) => void;
}

export function ImportScreen({ settings, recent, onPick, onOpen }: Props) {
  const done = recent.filter((p) => p.critiques.length).slice(0, 6);
  return (
    <div className="screen">
      <h1>Critique</h1>
      <button className="pick" onClick={onPick}>
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M3 16l5-5 4 4 3-3 6 6" />
          <circle cx="16" cy="9" r="1.6" />
        </svg>
        <strong>Pick a photo</strong>
        <span>From your camera roll. The full photo stays on your phone.</span>
      </button>
      {!settings.ai_critique && <p className="hint">AI critique is off in Settings. You can still keep photos in your gallery.</p>}

      <div className="tipcard">
        <b>Shooting in the dark?</b>
        <span>Use the iPhone Camera app for venues and raves (Night mode), then pick the photo here.</span>
      </div>

      {done.length > 0 && (
        <>
          <h2>Recent critiques</h2>
          <ul className="recent">
            {done.map((p) => (
              <li key={p.id}>
                <button onClick={() => onOpen(p.id)}>
                  <img src={p.thumb} alt="" />
                  <span className="recent-text">
                    <b>{p.critiques[0].result.headline || 'Critique'}</b>
                    <small>{new Date(p.critiques[0].created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small>
                  </span>
                  <span className={`pill ${scoreClass(p.critiques[0].score)}`}>{formatScore(p.critiques[0].score)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
