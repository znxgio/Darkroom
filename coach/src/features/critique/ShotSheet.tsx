// The sheet that opens after you take or pick a photo:
// save it to your camera roll (live shots), choose who critiques it, get the critique.
//  - Free: you ask in your own Claude app (subscription) and paste the reply back.
//  - Cheap / Better / Best: the app asks the AI directly (pay as you go, counts toward the cap).
import { useEffect, useMemo, useRef, useState } from 'react';
import { chatPrompt, isPaidTier, parseChatReply, TIER_KEYS, TIERS, type Tier } from '../../../supabase/functions/_shared/critique';
import { CritiqueError, type Critique, type Exif, type Photo, type Repo, type Settings, type Source } from '../../data/types';
import { decodeFile, forAI, shareImage, thumbnail } from '../../lib/image';
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
  /** note saved with the photo earlier (re-critique) */
  note?: string | null;
}

interface Props {
  shot: Shot;
  repo: Repo;
  settings: Settings;
  /** your recurring habits, so the coach can follow up */
  recurring: string[];
  onClose: () => void;
  onSaved: () => void;
  onOpenSettings: () => void;
}

type Phase = 'review' | 'working' | 'chat' | 'done' | 'error';

export function ShotSheet({ shot, repo, settings, recurring, onClose, onSaved, onOpenSettings }: Props) {
  const [note, setNote] = useState('');
  const [tier, setTier] = useState<Tier>(settings.model_tier);
  const [phase, setPhase] = useState<Phase>('review');
  const [error, setError] = useState<CritiqueError | null>(null);
  const [critique, setCritique] = useState<Critique | null>(null);
  const [spend, setSpend] = useState<{ spent: number; cap: number } | null>(null);
  const [saveMsg, setSaveMsg] = useState('');
  const [showHold, setShowHold] = useState(false);
  // free-mode steps
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const [shared, setShared] = useState<'no' | 'yes' | 'unsupported'>('no');
  const [reply, setReply] = useState('');
  const [replyError, setReplyError] = useState('');
  const photoRef = useRef<Photo | null>(null);
  const file = useMemo(
    () => new File([shot.blob], `darkroom-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`, { type: 'image/jpeg' }),
    [shot.blob],
  );
  const prompt = useMemo(
    () =>
      chatPrompt({
        editingTips: settings.editing_tips,
        exif: shot.exif as Record<string, unknown> | null,
        source: shot.source,
        liveScore: shot.liveScore,
        note: note.trim() || shot.note || null,
        recurring,
      }),
    [settings.editing_tips, shot, note, recurring],
  );

  useEffect(() => () => URL.revokeObjectURL(shot.url), [shot.url]);

  // Called straight from the tap so iOS allows the share sheet
  async function save() {
    const r = await shareImage(file);
    if (r === 'shared') setSaveMsg('Saved — check your camera roll.');
    if (r === 'unsupported') setShowHold(true);
  }

  async function ensurePhoto(): Promise<Photo> {
    if (photoRef.current) return photoRef.current;
    if (shot.photoId) {
      photoRef.current = { id: shot.photoId } as Photo;
      return photoRef.current;
    }
    const img = await decodeFile(shot.blob);
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

  const fail = (e: unknown) => {
    setError(e instanceof CritiqueError ? e : new CritiqueError((e as Error).message || 'Something went wrong', 0));
    setPhase('error');
  };

  async function keep() {
    try {
      await ensurePhoto();
      onClose();
    } catch (e) {
      fail(e);
    }
  }

  async function runPaid() {
    if (!isPaidTier(tier)) return;
    setPhase('working');
    setError(null);
    try {
      const img = await decodeFile(shot.blob);
      const photo = await ensurePhoto();
      const res = await repo.critique(photo.id, forAI(img), tier);
      setCritique(res.critique);
      setSpend(res.spend);
      setPhase('done');
      onSaved();
    } catch (e) {
      fail(e);
    }
  }

  // ---- free mode ----
  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied('yes');
    } catch {
      setCopied('failed'); // show the text so it can be copied by hand
    }
  }
  async function sendPhoto() {
    const r = await shareImage(file);
    setShared(r === 'unsupported' ? 'unsupported' : r === 'shared' ? 'yes' : 'no');
  }
  async function pasteReply() {
    setReplyError('');
    let text = reply;
    if (!text.trim()) {
      try {
        text = await navigator.clipboard.readText();
        setReply(text);
      } catch {
        setReplyError('Couldn’t read the clipboard. Long-press the box below and tap Paste.');
        return;
      }
    }
    const result = parseChatReply(text, settings.editing_tips);
    if (!result) {
      setReplyError(
        'Couldn’t find the scores in that reply. In Claude, copy the whole answer (long-press the reply → Copy) — the part after DARKROOM-DATA is what this app reads.',
      );
      return;
    }
    try {
      const photo = await ensurePhoto();
      const c = await repo.saveChatCritique(photo.id, result);
      setCritique(c);
      setPhase('done');
      onSaved();
    } catch (e) {
      fail(e);
    }
  }

  const t = TIERS[tier];
  const paidHint =
    repo.mode === 'demo'
      ? 'Demo mode: sample critique, pretend cost.'
      : 'Counts toward your monthly cap. Only a smaller copy is sent, and it isn’t stored.';

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Photo">
      <div className="sheet-bar">
        <button className="link" onClick={onClose}>{phase === 'done' ? 'Done' : 'Close'}</button>
        <span className="sheet-title">{shot.photoId ? 'Critique again' : shot.source === 'live' ? 'New shot' : 'From camera roll'}</span>
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

        {shot.source === 'live' && phase !== 'chat' && (
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
                <div className="tiers" role="radiogroup" aria-label="Who critiques it">
                  {TIER_KEYS.map((k) => (
                    <button key={k} role="radio" aria-checked={tier === k} className={tier === k ? 'is-on' : ''} onClick={() => setTier(k)}>
                      <b>{TIERS[k].label}</b>
                      <small>{TIERS[k].estimate}</small>
                    </button>
                  ))}
                </div>
                {tier === 'free' ? (
                  <>
                    <button className="btn btn-primary btn-wide" onClick={() => setPhase('chat')}>
                      Ask in my Claude app
                    </button>
                    <p className="fine">Uses your Claude subscription: $0. A few extra taps.</p>
                  </>
                ) : (
                  <>
                    <button className="btn btn-primary btn-wide" onClick={runPaid}>
                      Get critique · {t.estimate}
                    </button>
                    <p className="fine">{t.sub}. {paidHint}</p>
                  </>
                )}
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

        {phase === 'chat' && (
          <ol className="steps">
            <li className={copied === 'yes' ? 'is-done' : ''}>
              <b>Copy the coaching prompt</b>
              <button className="btn" onClick={copyPrompt}>{copied === 'yes' ? 'Copied ✓' : 'Copy prompt'}</button>
              {copied === 'failed' && (
                <textarea className="prompt-box" readOnly value={prompt} aria-label="Prompt to copy" onFocus={(e) => e.target.select()} />
              )}
            </li>
            <li className={shared === 'yes' ? 'is-done' : ''}>
              <b>Send the photo to Claude</b>
              <span>
                Pick <b>Claude</b> in the share sheet, paste the prompt and send. Not in the list? Open the Claude app, attach the
                photo{shot.source === 'live' ? ' (tap Save first so it’s in your camera roll)' : ' from your camera roll'}, then paste.
              </span>
              <button className="btn" onClick={sendPhoto}>{shared === 'yes' ? 'Sent ✓' : 'Share photo'}</button>
              {shared === 'unsupported' && <span className="hint">Sharing isn’t available here — use the Claude app directly.</span>}
            </li>
            <li>
              <b>Bring the answer back</b>
              <span>In Claude, long-press the reply → <b>Copy</b>. Then come back here.</span>
              <button className="btn btn-primary" onClick={pasteReply}>
                {reply.trim() ? 'Save critique' : 'Paste Claude’s reply'}
              </button>
              <textarea
                className="prompt-box"
                value={reply}
                onChange={(e) => {
                  setReply(e.target.value);
                  setReplyError('');
                }}
                placeholder="…or paste the reply here"
                aria-label="Claude's reply"
              />
              {replyError && <p className="error-text" role="alert">{replyError}</p>}
            </li>
            <li className="steps-back">
              <button className="link" onClick={() => setPhase('review')}>← Choose a different option</button>
            </li>
          </ol>
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
                <>
                  <button className="btn" onClick={onOpenSettings}>Open Settings</button>
                  <button
                    className="btn"
                    onClick={() => {
                      setTier('free');
                      setPhase('chat');
                    }}
                  >
                    Ask in Claude app (free)
                  </button>
                </>
              ) : (
                <>
                  <button className="btn" onClick={() => setPhase('review')}>Back</button>
                  <button className="btn" onClick={runPaid}>Try again</button>
                </>
              )}
            </div>
          </div>
        )}

        {phase === 'done' && critique && <CritiqueView c={critique} editingTips={settings.editing_tips} spend={spend} />}
      </div>
    </div>
  );
}
