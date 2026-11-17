import { useState } from 'react';
import type { PhotoWithCritiques, Settings } from '../../data/types';
import { CritiqueView, formatScore, scoreClass } from '../critique/CritiqueView';

interface Props {
  photo: PhotoWithCritiques;
  settings: Settings;
  onClose: () => void;
  onDelete: () => void;
  /** re-pick the full photo from the camera roll and critique it again */
  onRecritique: () => void;
}

export function PhotoDetail({ photo, settings, onClose, onDelete, onRecritique }: Props) {
  const [idx, setIdx] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const c = photo.critiques[idx];
  const e = photo.exif;
  const meta = [
    e?.model,
    e?.focalLength35 ? `${e.focalLength35}mm` : null,
    e?.shutter,
    e?.aperture ? `ƒ/${e.aperture}` : null,
    e?.iso ? `ISO ${e.iso}` : null,
  ].filter(Boolean);
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Photo details">
      <div className="sheet-bar">
        <button className="link" onClick={onClose}>Back</button>
        <span className="sheet-title">
          {new Date(photo.taken_at ?? photo.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
        <button className="link danger" onClick={() => setConfirm(true)}>Delete</button>
      </div>
      <div className="sheet-body">
        <div className="shot-img shot-thumb">
          <img src={photo.thumb} alt="Photo preview" />
          {photo.live_score != null && <span className="shot-live">Live {photo.live_score}/10</span>}
        </div>
        {meta.length > 0 && <p className="meta">{meta.join(' · ')}</p>}
        {photo.note && <p className="meta">“{photo.note}”</p>}

        {confirm && (
          <div className="error-box" role="alert">
            <p>Delete this preview and its critiques? (The photo in your camera roll isn’t touched.)</p>
            <div className="row">
              <button className="btn btn-danger" onClick={onDelete}>Delete</button>
              <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          </div>
        )}

        {photo.critiques.length > 1 && (
          <div className="filters" role="tablist" aria-label="Critiques">
            {photo.critiques.map((x, i) => (
              <button key={x.id} role="tab" aria-selected={i === idx} className={`chip${i === idx ? ' is-on' : ''}`} onClick={() => setIdx(i)}>
                <span className={`dot ${scoreClass(x.score)}`} /> {formatScore(x.score)} ·{' '}
                {new Date(x.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </button>
            ))}
          </div>
        )}

        {c ? (
          <CritiqueView c={c} editingTips={settings.editing_tips} />
        ) : (
          <p className="hint">No critique yet.</p>
        )}

        {settings.ai_critique && (
          <>
            <button className="btn btn-wide" onClick={onRecritique}>
              {c ? 'Critique again' : 'Get a critique'}
            </button>
            <p className="fine">Only the small preview is kept, so you’ll pick the full photo from your camera roll again.</p>
          </>
        )}
      </div>
    </div>
  );
}
