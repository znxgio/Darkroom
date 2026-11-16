// Full-screen capture: face first, then body. Each shot gets a preview with Retake / Use photo.
// Live camera only — there is deliberately no way to pick an existing picture.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Backend } from '../../data/backend';
import { errMsg } from '../../screens/ui';
import { KINDS, photosApi, type PhotoKind, type TodayPhotos } from './api';
import { captureFrame } from './image';
import { useCamera, usePageVisible, type CameraState, type Facing } from './useCamera';

interface Props {
  backend: Backend;
  /** changed = at least one photo was saved */
  onClose: (changed: boolean) => void;
}

type Step =
  | { name: 'loading' }
  | { name: 'review' }
  | { name: 'camera'; kind: PhotoKind }
  | { name: 'preview'; kind: PhotoKind; blob: Blob; url: string; saving?: boolean; error?: string }
  | { name: 'done' };

const TITLES: Record<PhotoKind, string> = { face: 'Face', body: 'Body' };
const HINTS: Record<PhotoKind, string> = {
  face: 'Face in the oval, even light, neutral look',
  body: 'Prop the phone up, step back, same pose as always',
};
const TIMERS = [0, 3, 10];

interface CamPrefs {
  facing: Facing;
  timer: number;
  ghost: boolean;
}

function prefsStore(b: Backend) {
  const key = `${b.storagePrefix}:photo-camera`;
  const defaults: Record<PhotoKind, CamPrefs> = {
    face: { facing: 'user', timer: 0, ghost: false },
    body: { facing: 'user', timer: 0, ghost: false },
  };
  return {
    read(): Record<PhotoKind, CamPrefs> {
      try {
        const raw = localStorage.getItem(key);
        return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
      } catch {
        return defaults;
      }
    },
    write(v: Record<PhotoKind, CamPrefs>) {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* per-device convenience only */
      }
    },
  };
}

export default function CaptureFlow({ backend, onClose }: Props) {
  const api = photosApi(backend);
  const prefsKV = useMemo(() => prefsStore(backend), [backend]);
  const [prefs, setPrefs] = useState(() => prefsKV.read());
  const [step, setStep] = useState<Step>({ name: 'loading' });
  const [have, setHave] = useState<TodayPhotos>({});
  const [ghosts, setGhosts] = useState<TodayPhotos>({});
  const [queue, setQueue] = useState<PhotoKind[]>([]);
  const changed = useRef(false);
  const visible = usePageVisible();

  const kind = step.name === 'camera' || step.name === 'preview' ? step.kind : null;
  const pref = kind ? prefs[kind] : null;
  const camOn = (step.name === 'camera' || step.name === 'preview') && visible;
  const cam = useCamera(pref?.facing ?? 'user', camOn);

  function setPref(k: PhotoKind, patch: Partial<CamPrefs>) {
    setPrefs((p) => {
      const next = { ...p, [k]: { ...p[k], ...patch } };
      prefsKV.write(next);
      return next;
    });
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const today = await backend.repo.today();
        const [t, prev] = await Promise.all([api.today(), api.listDays(today, 1).catch(() => [])]);
        if (!alive) return;
        setHave(t);
        if (prev[0]) setGhosts({ face: prev[0].faceUrl, body: prev[0].bodyUrl });
        const missing = KINDS.filter((k) => !t[k]);
        if (missing.length === 0) setStep({ name: 'review' });
        else {
          setQueue(missing.slice(1));
          setStep({ name: 'camera', kind: missing[0] });
        }
      } catch {
        if (!alive) return;
        setQueue(['body']);
        setStep({ name: 'camera', kind: 'face' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, backend]);

  // Free preview blob URLs.
  useEffect(() => {
    if (step.name !== 'preview') return;
    const url = step.url;
    return () => URL.revokeObjectURL(url);
  }, [step.name === 'preview' ? step.url : null]);

  // Escape closes (desktop / keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(changed.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function startKind(k: PhotoKind, rest: PhotoKind[]) {
    setQueue(rest);
    setStep({ name: 'camera', kind: k });
  }

  async function use() {
    if (step.name !== 'preview' || step.saving) return;
    const cur = step;
    setStep({ ...cur, saving: true, error: undefined });
    try {
      await api.save(cur.kind, cur.blob);
      changed.current = true;
      // Score today's face photo in the background (on-device; never blocks the flow).
      if (cur.kind === 'face') import('../face/analyze').then((m) => m.scoreToday(backend)).catch(() => {});
      const fresh = await api.today().catch(() => ({ ...have, [cur.kind]: cur.url }));
      setHave(fresh);
      const [next, ...rest] = queue;
      if (next) startKind(next, rest);
      else setStep({ name: 'done' });
    } catch (e) {
      setStep({ ...cur, saving: false, error: `Couldn't save: ${errMsg(e)}` });
    }
  }

  const stepNo = kind ? KINDS.indexOf(kind) + 1 : 0;

  return (
    <div className="cam" role="dialog" aria-modal="true" aria-label="Daily photos" data-testid="capture">
      <div className="cam-top">
        <button
          type="button"
          className="cam-round"
          aria-label="Close"
          data-testid="capture-close"
          onClick={() => onClose(changed.current)}
        >
          ✕
        </button>
        <div className="cam-title">
          {kind ? (
            <>
              <strong>{TITLES[kind]}</strong>
              <span className="cam-steps" aria-label={`Photo ${stepNo} of 2`}>
                {KINDS.map((k) => (
                  <i key={k} className={k === kind ? 'on' : have[k] ? 'done' : ''} />
                ))}
              </span>
            </>
          ) : (
            <strong>Daily photos</strong>
          )}
        </div>
        {step.name === 'camera' && pref ? (
          <button
            type="button"
            className={`cam-round cam-timer${pref.timer ? ' on' : ''}`}
            aria-label={`Self-timer: ${pref.timer ? `${pref.timer} seconds` : 'off'}`}
            data-testid="cam-timer"
            onClick={() => setPref(step.kind, { timer: TIMERS[(TIMERS.indexOf(pref.timer) + 1) % TIMERS.length] })}
          >
            <TimerIcon />
            {pref.timer ? <span>{pref.timer}s</span> : null}
          </button>
        ) : (
          <span className="cam-round ghost-spacer" aria-hidden="true" />
        )}
      </div>

      {step.name === 'loading' && <div className="cam-stage" />}

      {step.name === 'camera' && pref && (
        <CameraStep
          key={step.kind}
          kind={step.kind}
          cam={cam.state}
          retry={cam.retry}
          mirrored={pref.facing === 'user'}
          timer={pref.timer}
          ghostUrl={pref.ghost ? ghosts[step.kind] : undefined}
          canGhost={!!ghosts[step.kind]}
          onToggleGhost={() => setPref(step.kind, { ghost: !pref.ghost })}
          onFlip={() => setPref(step.kind, { facing: pref.facing === 'user' ? 'environment' : 'user' })}
          onShot={(blob) => setStep({ name: 'preview', kind: step.kind, blob, url: URL.createObjectURL(blob) })}
        />
      )}

      {step.name === 'preview' && (
        <>
          <div className="cam-stage">
            <div className="cam-frame">
              <img src={step.url} alt={`${TITLES[step.kind]} photo preview`} data-testid="capture-preview" />
            </div>
          </div>
          <div className="cam-bottom">
            {step.error && <p className="cam-error" role="alert">{step.error}</p>}
            <div className="cam-choices">
              <button
                type="button"
                className="btn cam-btn"
                data-testid="capture-retake"
                disabled={step.saving}
                onClick={() => setStep({ name: 'camera', kind: step.kind })}
              >
                Retake
              </button>
              <button
                type="button"
                className="btn primary cam-btn"
                data-testid="capture-use"
                disabled={step.saving}
                onClick={use}
              >
                {step.saving ? 'Saving…' : 'Use photo'}
              </button>
            </div>
          </div>
        </>
      )}

      {(step.name === 'review' || step.name === 'done') && (
        <>
          <div className="cam-stage cam-summary">
            <div className="cam-pair">
              {KINDS.map((k) => (
                <figure key={k}>
                  {have[k] ? <img src={have[k]} alt={`Today's ${k} photo`} /> : <div className="ph-missing" />}
                  <figcaption>{TITLES[k]}</figcaption>
                </figure>
              ))}
            </div>
            <p className="cam-summary-text">
              {step.name === 'done' ? (
                <>
                  <span className="cam-check" aria-hidden="true">
                    ✓
                  </span>
                  Saved. Today's photos are done.
                </>
              ) : (
                'Already taken today. You can retake them until midnight.'
              )}
            </p>
          </div>
          <div className="cam-bottom">
            {step.name === 'review' && (
              <div className="cam-choices">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className="btn cam-btn"
                    data-testid={`retake-${k}`}
                    onClick={() => startKind(k, [])}
                  >
                    Retake {TITLES[k].toLowerCase()}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              className="btn primary cam-btn wide"
              data-testid="capture-done"
              onClick={() => onClose(changed.current)}
            >
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CameraStep({
  kind,
  cam,
  retry,
  mirrored,
  timer,
  ghostUrl,
  canGhost,
  onToggleGhost,
  onFlip,
  onShot,
}: {
  kind: PhotoKind;
  cam: CameraState;
  retry: () => void;
  mirrored: boolean;
  timer: number;
  ghostUrl?: string;
  canGhost: boolean;
  onToggleGhost: () => void;
  onFlip: () => void;
  onShot: (b: Blob) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const stream = cam.status === 'live' ? cam.stream : null;

  useEffect(() => {
    const v = videoRef.current;
    setReady(false);
    if (!v || !stream) return;
    v.muted = true;
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.srcObject = stream;
    const onReady = () => {
      if (v.videoWidth > 0) setReady(true);
    };
    v.addEventListener('loadedmetadata', onReady);
    v.addEventListener('playing', onReady);
    v.play().catch(() => {
      /* autoplay is allowed for muted inline video; ignore races */
    });
    return () => {
      v.removeEventListener('loadedmetadata', onReady);
      v.removeEventListener('playing', onReady);
      v.srcObject = null;
    };
  }, [stream]);

  // Self-timer countdown.
  useEffect(() => {
    if (count === null) return;
    if (count === 0) {
      setCount(null);
      shoot();
      return;
    }
    const t = window.setTimeout(() => setCount((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [count]);

  async function shoot() {
    const v = videoRef.current;
    if (!v || busy.current) return;
    busy.current = true;
    setFlash(true);
    window.setTimeout(() => setFlash(false), 180);
    try {
      onShot(await captureFrame(v, mirrored));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      busy.current = false;
    }
  }

  function press() {
    if (!ready) return;
    if (count !== null) return setCount(null); // tap again to cancel the timer
    setErr(null);
    if (timer > 0) setCount(timer);
    else shoot();
  }

  return (
    <>
      <div className="cam-stage">
        <div className="cam-frame">
          {cam.status === 'error' ? (
            <CameraError state={cam} retry={retry} />
          ) : (
            <>
              <video
                ref={videoRef}
                className={mirrored ? 'mirrored' : ''}
                playsInline
                muted
                autoPlay
                data-testid="cam-video"
              />
              {ghostUrl && <img className="cam-ghost" src={ghostUrl} alt="" aria-hidden="true" />}
              <Guide kind={kind} />
              {!ready && <div className="cam-wait">Starting camera…</div>}
              {count !== null && count > 0 && (
                <div className="cam-count" key={count} aria-live="assertive">
                  {count}
                </div>
              )}
              {flash && <div className="cam-flash" />}
            </>
          )}
        </div>
      </div>
      <div className="cam-bottom">
        <p className="cam-hint">{err ? <span className="error">{err}</span> : HINTS[kind]}</p>
        <div className="cam-controls">
          <button
            type="button"
            className={`cam-round cam-side${ghostUrl ? ' on' : ''}`}
            aria-label={ghostUrl ? 'Hide last photo outline' : 'Line up with your last photo'}
            aria-pressed={!!ghostUrl}
            disabled={!canGhost}
            style={canGhost ? undefined : { visibility: 'hidden' }}
            onClick={onToggleGhost}
          >
            <GhostIcon />
            <span>Align</span>
          </button>
          <button
            type="button"
            className={`shutter${count !== null ? ' counting' : ''}`}
            aria-label={count !== null ? 'Cancel timer' : `Take ${kind} photo`}
            data-testid="shutter"
            disabled={!ready}
            onClick={press}
          >
            <span />
          </button>
          <button
            type="button"
            className="cam-round cam-side"
            aria-label="Switch camera"
            data-testid="cam-flip"
            disabled={cam.status === 'starting'}
            onClick={onFlip}
          >
            <FlipIcon />
            <span>Flip</span>
          </button>
        </div>
      </div>
    </>
  );
}

function CameraError({ state, retry }: { state: Extract<CameraState, { status: 'error' }>; retry: () => void }) {
  let title = "Camera didn't start";
  let body: ReactNode = state.detail ?? 'Something went wrong opening the camera.';
  if (state.reason === 'denied') {
    title = 'Camera access is off';
    body = (
      <>
        Photos are taken live in the app, so it needs the camera. On iPhone open{' '}
        <b>Settings → Apps → Safari → Camera</b> and choose <b>Ask</b> or <b>Allow</b>. Then come back
        and tap Try again.
      </>
    );
  } else if (state.reason === 'insecure') {
    title = 'Camera needs a secure link';
    body = 'The camera only works when the app is opened over https. Open it from its normal address.';
  } else if (state.reason === 'missing') {
    title = 'No camera found';
    body = "This device doesn't seem to have a camera that can be used here.";
  } else if (state.reason === 'busy') {
    title = 'Camera is busy';
    body = 'Another app may be using the camera. Close it, then tap Try again.';
  } else if (state.reason === 'stopped') {
    title = 'Camera stopped';
    body = 'The camera was turned off. Tap Try again to turn it back on.';
  }
  return (
    <div className="cam-err" role="alert" data-testid="cam-error">
      <div className="cam-err-icon" aria-hidden="true">
        <CameraIcon />
      </div>
      <h2>{title}</h2>
      <p>{body}</p>
      <button type="button" className="btn primary" data-testid="cam-retry" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

function Guide({ kind }: { kind: PhotoKind }) {
  return (
    <svg className="cam-guide" viewBox="0 0 300 400" preserveAspectRatio="none" aria-hidden="true">
      {kind === 'face' ? (
        <ellipse cx="150" cy="185" rx="92" ry="122" />
      ) : (
        <>
          <circle cx="150" cy="62" r="30" />
          <path d="M98 128 Q150 104 202 128 L214 236 M98 128 L86 236 M114 214 L118 372 M186 214 L182 372 M150 252 L150 372" />
        </>
      )}
    </svg>
  );
}

function TimerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2M9 2h6" />
    </svg>
  );
}

function FlipIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
      <path d="M4 3v5h5" />
      <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
      <path d="M20 21v-5h-5" />
    </svg>
  );
}

function GhostIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <rect x="3" y="5" width="12" height="15" rx="2" />
      <rect x="9" y="3" width="12" height="15" rx="2" strokeDasharray="3 2.5" />
    </svg>
  );
}

export function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M4 8h3l1.6-2.4A1.5 1.5 0 0 1 9.9 5h4.2a1.5 1.5 0 0 1 1.3.6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}
