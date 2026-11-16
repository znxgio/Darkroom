import { useEffect, useState } from 'react';

export type Facing = 'user' | 'environment';

export type CameraState =
  | { status: 'off' }
  | { status: 'starting' }
  | { status: 'live'; stream: MediaStream }
  | { status: 'error'; reason: 'denied' | 'insecure' | 'missing' | 'busy' | 'stopped' | 'other'; detail?: string };

function stopAll(s: MediaStream) {
  for (const t of s.getTracks()) t.stop();
}

function classify(e: unknown): CameraState {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return { status: 'error', reason: 'denied' };
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError')
    return { status: 'error', reason: 'missing' };
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError')
    return { status: 'error', reason: 'busy' };
  return { status: 'error', reason: 'other', detail: e instanceof Error ? e.message : String(e) };
}

/** True while the page is on screen (the camera is released while the app is in the background). */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/**
 * Live camera stream while `enabled`. Every track is stopped when disabled, when the
 * facing changes, and on unmount — so the camera light never stays on.
 */
export function useCamera(facing: Facing, enabled: boolean) {
  const [state, setState] = useState<CameraState>({ status: 'off' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'off' });
      return;
    }
    if (typeof window !== 'undefined' && (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)) {
      setState({ status: 'error', reason: 'insecure' });
      return;
    }
    let stream: MediaStream | null = null;
    let cancelled = false;
    setState({ status: 'starting' });
    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1920 } },
      })
      .then((s) => {
        if (cancelled) return stopAll(s);
        stream = s;
        for (const t of s.getVideoTracks()) {
          t.addEventListener('ended', () => {
            if (!cancelled) setState({ status: 'error', reason: 'stopped' });
          });
        }
        setState({ status: 'live', stream: s });
      })
      .catch((e) => {
        if (!cancelled) setState(classify(e));
      });
    return () => {
      cancelled = true;
      if (stream) stopAll(stream);
    };
  }, [facing, enabled, attempt]);

  return { state, retry: () => setAttempt((a) => a + 1) };
}
