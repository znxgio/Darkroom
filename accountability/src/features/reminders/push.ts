// Turning reminders on/off on this phone.
// iOS: web push works only in the Home Screen app (Add to Home Screen from Safari), iOS 16.4+,
// and permission must be asked from a tap.
import type { Backend } from '../../data/backend';

export type PushStatus = 'unsupported' | 'needs-install' | 'needs-setup' | 'denied' | 'off' | 'on';

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as any).standalone === true
  );
}

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

function urlB64ToUint8Array(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function pushStatus(b: Backend): Promise<PushStatus> {
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return 'unsupported';
  if (!b.supabase || !VAPID) return 'needs-setup';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

export async function enablePush(b: Backend): Promise<void> {
  if (!b.supabase || !VAPID) throw new Error('Reminders need the cloud setup first.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Turn them on in iPhone Settings → Notifications → Daily.');
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(VAPID) as BufferSource }));
  const j = sub.toJSON();
  await b.supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  const { error } = await b.supabase.from('push_subscriptions').insert({
    endpoint: sub.endpoint,
    p256dh: j.keys?.p256dh,
    auth: j.keys?.auth,
    user_agent: navigator.userAgent.slice(0, 200),
  });
  if (error) throw new Error(error.message);
}

export async function disablePush(b: Backend): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await b.supabase?.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe();
}

export async function sendTestPush(b: Backend): Promise<number> {
  if (!b.supabase) throw new Error('Needs the cloud setup.');
  const { data, error } = await b.supabase.functions.invoke('tick', { body: { action: 'test-push' } });
  if (error) throw new Error(error.message);
  return (data as any)?.sent ?? 0;
}

export async function sendStakesPreview(b: Backend): Promise<void> {
  if (!b.supabase) throw new Error('Needs the cloud setup.');
  const { data, error } = await b.supabase.functions.invoke('tick', { body: { action: 'stakes-preview' } });
  if (error) throw new Error(error.message);
  if ((data as any)?.error) throw new Error((data as any).error);
}

/** Home Screen icon badge = open items today. Silently ignored where unsupported. */
export function setBadge(n: number) {
  const nav = navigator as any;
  try {
    if (n > 0) nav.setAppBadge?.(n)?.catch?.(() => {});
    else nav.clearAppBadge?.()?.catch?.(() => {});
  } catch {
    /* unsupported */
  }
}
