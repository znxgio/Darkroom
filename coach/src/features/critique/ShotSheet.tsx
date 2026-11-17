// The sheet that opens after you take or pick a photo:
// save it to your camera roll (live shots), add a note, get the AI critique.
import { useEffect, useMemo, useRef, useState } from 'react';
import { WORST_CASE_USD } from '../../../supabase/functions/_shared/critique';
import { CritiqueError, type Critique, type Exif, type Photo, type Repo, type Settings, type Source } from '../../data/types';
import { decodeFile, forAI, shareImage, thumbnail } from '../../lib/image';
import { usd } from '../../lib/progress';
import { CritiqueView } from './CritiqueView';

export interface Shot {
  blob: Blob;
  url: string;
  source: Source;
  width: number;
  height: number;
  liveScore: number | null;
  exif: Exif | null;
  takenAt: string | null;
  /** set when re-critiquing an existing gallery photo */
  photoId?: string;
}

interface Props {
  shot: Shot;
  repo: Repo;
  settings: Settings;
  onClose: () => void;
  onSaved: () => void;
  onOpenSettings: () => void;
}

type Phase = 'review' | 'working' | 'done' | 'error';

export function ShotSheet({ shot, repo, settings, onClose, onSaved, onOpenSettings }: Props) {
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<Phase>('review');
  const [error, setError] = useState<CritiqueError | null>(null);
  const [critique, setCritique] = useState<Critique | null>(null);
  const [spend, setSpend] = useState<{ spent: number; cap: number } | null>(null);
  const [saveMsg, setSaveMsg] = useState('');
  const [showHold, setShowHold] = useState(false);
  const photoRef = useRef<Photo | null>(null);
  const file = useMemo(
    () => new File([shot.blob], `darkroom-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`, { type: 'image/jpeg' }),
    [shot.blob],
  );

  useEffect(() => () => URL.revokeObjectURL(shot.url), [shot.url]);

  // Called straight from the tap so iOS allows the share sheet
  async function save() {
    const r = await shareImage(file);
    if (r === 'shared') setSaveMsg('Saved — check your camera roll.');
    if (r === 'unsupported') setShowHold(true);
  }

  async function ensurePhoto(img: HTMLImageElement | ImageBitmap): Promise<Photo> {
    if (photoRef.current) return photoRef.current;
    if (shot.photoId) {
      photoRef.current = { id: shot.photoId } as Photo;
      return photoRef.current;
    }
    photoRef.current = await repo.addPhoto({
      source: shot.source,
      thumb: thumbnail(img),
      width: shot.width,
      height: shot.height,
      exif: shot.exif,
      taken_at: shot.takenAt,
      live_score: shot.liveScore,
      note: note.trim() || null,
    });
    onSaved();
    return photoRef.current;
  }

  async function keep() {
    try {
      await ensurePhoto(await decodeFile(shot.blob));
      onClose();
    } catch (e) {
      setError(new CritiqueError((e as Error).message, 0));
      setPhase('error');
    }
  }

  async function run() {
    setPhase('working');
    setError(null);
    try {
      const img = await decodeFile(shot.blob);
      const photo = await ensurePhoto(img);
      const res = await repo.critique(photo.id, forAI(img));
      setCritique(res.critique);
      setSpend(res.spend);
      setPhase('done');
      onSaved();
    } catch (e) {
      setError(e instanceof CritiqueError ? e : new CritiqueError((e as Error).message || 'Something went wrong', 0));
      setPhase('error');
    }
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Photo">
      <div className="sheet-bar">
        <button className="link" onClick={onClose}>{phase === 'done' ? 'Done' : 'Close'}</button>
        <span className="sheet-title">{shot.source === 'live' ? 'New shot' : 'From camera roll'}</span>
        {shot.source === 'live' ? (
          <button className="link" onClick={save}>Save</button>
        ) : (
          <span className="link-space" />
        )}
      </div>
      <div className="sheet-body">
        <div className="shot-img">
          <img src={shot.url} alt="Your photo" />
          {shot.liveScore != null && <span className="shot-live">Live {shot.liveScore}/10</span>}
        </div>

        {shot.source === 'live' && (
          <div className="save-row">
            <button className="btn" onClick={save}>Save to Photos</button>
            {saveMsg && <span className="ok">{saveMsg}</span>}
          </div>
        )}
        {showHold && <p className="hint">Press and hold the photo above, then tap <b>Save to Photos</b>.</p>}

        {phase === 'review' && (
          <>
            {settings.ai_critique ? (
              <>
                {!shot.photoId && (
                  <label className="field">
                    <span>What were you going for? (optional)</span>
                    <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. the neon on her face" />
                  </label>
                )}
                <button className="btn btn-primary btn-wide" onClick={run}>
                  Get critique
                </button>
                <p className="fine">
                  {repo.mode === 'demo'
                    ? 'Demo mode: sample critique, no cost.'
                    : `Usually 2–4¢ (never more than ${usd(WORST_CASE_USD)}). Only a smaller copy is sent, and it isn’t stored.`}
                </p>
              </>
            ) : (
              <p className="hint">
                AI critique is off. <button className="link" onClick={onOpenSettings}>Turn it on in Settings</button>
              </p>
            )}
            {!shot.photoId && (
              <button className="btn btn-quiet btn-wide" onClick={keep}>
                Keep in gallery without critique
              </button>
            )}
          </>
        )}

        {phase === 'working' && (
          <div className="working" aria-live="polite">
            <div className="spinner" />
            <span>Looking at your photo…</span>
          </div>
        )}

        {phase === 'error' && error && (
          <div className="error-box" role="alert">
            <p>{error.message}</p>
            <div className="row">
              {error.status === 402 ? (
                <button className="btn" onClick={onOpenSettings}>Open Settings</button>
              ) : (
                <button className="btn" onClick={run}>Try again</button>
              )}
            </div>
          </div>
        )}

        {phase === 'done' && critique && <CritiqueView c={critique} editingTips={settings.editing_tips} spend={spend} />}
      </div>
    </div>
  );
}
