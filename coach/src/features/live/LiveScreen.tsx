import { useEffect, useRef, useState } from 'react';
import { analyze, Smooth, Steady, type Analysis, type Nudge } from '../../lib/coach';
import { measureLight } from '../../lib/light';
import type { Overlays, Settings } from '../../data/types';
import { createDetector, type Detector } from './detector';
import { drawOverlay } from './overlay';
import { motionNeedsPermission, requestMotion, watchTilt } from './motion';
import { toBlob } from '../../lib/image';

export interface Capture {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  liveScore: number | null;
}

interface Props {
  settings: Settings;
  onSettings: (s: Settings) => void;
  onCapture: (c: Capture) => void;
  onImport: () => void;
}

type CamState = 'idle' | 'starting' | 'on' | 'denied' | 'error';

const LOW_LIGHT_HOLD_MS = 1500;
const TICK_MS = 120;

export function LiveScreen({ settings, onSettings, onCapture, onImport }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cam, setCam] = useState<CamState>('idle');
  const [camError, setCamError] = useState('');
  const [aiState, setAiState] = useState<'off' | 'loading' | 'ready' | 'failed'>('off');
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const [score, setScore] = useState<number | null>(null);
  const [lowLight, setLowLight] = useState(false);
  const [lowLightDismissedAt, setLowLightDismissedAt] = useState(0);
  const [flash, setFlash] = useState(false);
  const [tiltOn, setTiltOn] = useState(!motionNeedsPermission());
  const live = useRef({ roll: null as number | null, pitch: null as number | null, analysis: null as Analysis | null, score: null as number | null });
  const coach = settings.live_coaching;
  const overlays = settings.overlays;
  const optsRef = useRef({ overlays, coach });
  optsRef.current = { overlays, coach };

  // ---- camera ----
  async function start() {
    setCam('starting');
    if (!tiltOn && motionNeedsPermission()) {
      // this must be inside the tap, so ask for the tilt sensor first
      requestMotion().then(setTiltOn);
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      });
      streamRef.current = stream;
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play().catch(() => {});
      setCam('on');
    } catch (e) {
      const name = (e as Error).name;
      if (name === 'NotAllowedError' || name === 'SecurityError') setCam('denied');
      else {
        setCamError((e as Error).message || name);
        setCam('error');
      }
    }
  }

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  // pause the camera when the app goes to the background (saves battery, frees the camera)
  useEffect(() => {
    const onVis = () => {
      if (document.hidden && streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setCam('idle');
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    if (!tiltOn) return;
    return watchTilt(({ roll, pitch }) => {
      live.current.roll = roll;
      live.current.pitch = pitch;
    });
  }, [tiltOn]);

  // ---- detector (loads once coaching is on and the camera is running) ----
  const detectorRef = useRef<Detector | null>(null);
  useEffect(() => {
    if (!coach || cam !== 'on' || detectorRef.current || aiState === 'loading' || aiState === 'failed') return;
    setAiState('loading');
    createDetector()
      .then((d) => {
        detectorRef.current = d;
        setAiState('ready');
      })
      .catch(() => setAiState('failed'));
  }, [coach, cam, aiState]);
  useEffect(() => () => detectorRef.current?.close(), []);

  // ---- the loop: detect → analyze → draw ----
  useEffect(() => {
    if (cam !== 'on') return;
    const v = videoRef.current!;
    const c = canvasRef.current!;
    const ctx = c.getContext('2d')!;
    const probe = document.createElement('canvas');
    probe.width = 48;
    probe.height = 64;
    const pctx = probe.getContext('2d', { willReadFrequently: true })!;
    const steady = new Steady();
    const smooth = new Smooth();
    let darkSince = 0;
    let raf = 0;
    let lastTick = 0;
    let faces: { x: number; y: number; w: number; h: number }[] = [];

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      // match the overlay to the video's on-screen size
      const r = v.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vw = v.videoWidth || 3;
      const vh = v.videoHeight || 4;
      const k = Math.min(r.width / vw, r.height / vh);
      const dw = Math.round(vw * k);
      const dh = Math.round(vh * k);
      if (c.width !== dw * dpr || c.height !== dh * dpr) {
        c.width = dw * dpr;
        c.height = dh * dpr;
        c.style.width = `${dw}px`;
        c.style.height = `${dh}px`;
      }
      const { overlays: o, coach: on } = optsRef.current;

      if (t - lastTick > TICK_MS && v.readyState >= 2) {
        lastTick = t;
        let light = null;
        try {
          probe.width = vw > vh ? 64 : 48;
          probe.height = vw > vh ? 48 : 64;
          pctx.drawImage(v, 0, 0, probe.width, probe.height);
          const img = pctx.getImageData(0, 0, probe.width, probe.height);
          light = measureLight(img.data, probe.width, probe.height, live.current.analysis?.subject);
        } catch {
          /* frame not ready */
        }
        const det = on && detectorRef.current ? detectorRef.current.detect(v, t) : null;
        faces = det?.faces ?? [];
        const a = analyze({
          people: det?.people ?? [],
          faces,
          things: det?.things ?? [],
          rollDeg: o.level ? live.current.roll : null,
          pitchDeg: live.current.pitch,
          light,
          guide: o.center ? 'center' : 'thirds',
          detectorReady: !!det,
        });
        live.current.analysis = a;
        if (on) {
          const shown = steady.update(a.nudges).slice(0, 2);
          setNudges((prev) => (sameNudges(prev, shown) ? prev : shown));
          const sc = smooth.push(a.score);
          live.current.score = det ? sc : null;
          setScore(det ? sc : null);
        } else {
          setNudges((prev) => (prev.length ? [] : prev));
          live.current.score = null;
          setScore(null);
        }
        // Low-light rule applies even with coaching off: the browser camera is poor in the dark
        if (a.lowLight) {
          darkSince ||= t;
          if (t - darkSince > LOW_LIGHT_HOLD_MS) setLowLight(true);
        } else {
          darkSince = 0;
          setLowLight(false);
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawOverlay(ctx, dw, dh, { ...o, coach: on }, o.level ? live.current.roll : null, on ? live.current.analysis : null, faces);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [cam]);

  async function shoot() {
    const v = videoRef.current;
    if (!v || cam !== 'on') return;
    setFlash(true);
    setTimeout(() => setFlash(false), 160);
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    const blob = await toBlob(c, 0.92);
    onCapture({ blob, url: URL.createObjectURL(blob), width: c.width, height: c.height, liveScore: live.current.score });
  }

  const setOverlay = (k: keyof Overlays) => onSettings({ ...settings, overlays: { ...overlays, [k]: !overlays[k] } });
  const showLowLight = lowLight && Date.now() - lowLightDismissedAt > 30_000;

  return (
    <div className="live">
      <div className="live-stage">
        <video ref={videoRef} className="live-video" playsInline muted autoPlay />
        <canvas ref={canvasRef} className="live-overlay" aria-hidden="true" />
        {flash && <div className="live-flash" />}

        {cam !== 'on' && (
          <div className="live-start">
            {cam === 'denied' ? (
              <>
                <strong>Camera is blocked</strong>
                <p>Settings → Apps → Safari → Camera → Allow, then come back. (Home Screen app: remove and re-add it if it still won’t ask.)</p>
                <button className="btn" onClick={start}>Try again</button>
              </>
            ) : cam === 'error' ? (
              <>
                <strong>Camera didn’t start</strong>
                <p>{camError}</p>
                <button className="btn" onClick={start}>Try again</button>
              </>
            ) : (
              <>
                <svg viewBox="0 0 48 48" width="52" height="52" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <circle cx="24" cy="24" r="18" />
                  <circle cx="24" cy="24" r="7" />
                  <path d="M24 6l6 11M42 24H29.5M33 39l-6-11M15 39l6-11M6 24h12.5M15 9l6 11" />
                </svg>
                <strong>Live coach</strong>
                <p>{coach ? 'Grid, level and real-time tips while you frame.' : 'Coaching is off: grid and level only.'}</p>
                <button className="btn btn-primary" onClick={start} disabled={cam === 'starting'}>
                  {cam === 'starting' ? 'Starting…' : 'Start camera'}
                </button>
              </>
            )}
          </div>
        )}

        {cam === 'on' && (
          <>
            <div className="live-top">
              <div className="chips" role="group" aria-label="Guides">
                <Chip on={overlays.grid} onClick={() => setOverlay('grid')}>Grid</Chip>
                <Chip on={overlays.level} onClick={() => (tiltOn ? setOverlay('level') : requestMotion().then(setTiltOn))}>
                  Level{!tiltOn && overlays.level ? ' ⚠︎' : ''}
                </Chip>
                <Chip on={overlays.center} onClick={() => setOverlay('center')}>Center</Chip>
                <Chip on={coach} onClick={() => onSettings({ ...settings, live_coaching: !coach })}>Coach</Chip>
              </div>
              {coach && (
                <div className={`live-score ${score == null ? 'is-wait' : score >= 8 ? 'is-good' : score >= 5 ? 'is-ok' : 'is-low'}`} aria-live="polite">
                  {score == null ? (aiState === 'failed' ? 'off' : '…') : <><b>{score}</b>/10</>}
                </div>
              )}
            </div>

            {coach && aiState === 'loading' && <div className="live-hint">Loading on-device coach…</div>}
            {coach && aiState === 'failed' && <div className="live-hint">Subject detection couldn’t load. Grid, level and light checks still work.</div>}

            <div className="live-nudges" aria-live="polite">
              {nudges.map((n) => (
                <div key={n.id} className={`nudge nudge-${n.kind} sev-${n.severity}`}>{n.text}</div>
              ))}
            </div>

            {showLowLight && (
              <div className="lowlight" role="alertdialog" aria-label="Too dark">
                <strong>Too dark for the in-app camera</strong>
                <p>Browser cameras get muddy in venues and raves. Shoot this one with the iPhone <b>Camera app</b> (Night mode kicks in by itself — hold still), then import it here for a critique.</p>
                <div className="row">
                  <button className="btn btn-primary" onClick={onImport}>Import a photo</button>
                  <button className="btn" onClick={() => setLowLightDismissedAt(Date.now())}>Keep shooting</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="live-bar">
        <button className="live-side" onClick={onImport} aria-label="Import from camera roll">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="M3 16l5-5 4 4 3-3 6 6" />
            <circle cx="16" cy="9" r="1.6" />
          </svg>
        </button>
        <button className="shutter" onClick={shoot} disabled={cam !== 'on'} aria-label="Take photo">
          <span />
        </button>
        <span className="live-side" aria-hidden="true" />
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`chip${on ? ' is-on' : ''}`} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

const sameNudges = (a: Nudge[], b: Nudge[]) => a.length === b.length && a.every((n, i) => n.id === b[i].id && n.text === b[i].text);
