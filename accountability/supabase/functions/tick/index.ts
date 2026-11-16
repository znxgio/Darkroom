// "tick": runs every minute (called by pg_cron, see supabase/setup/cron.sql).
//  1. Sends due push reminders (claim_reminders).
//  2. Sends Stakes emails when 2 days in a row were missed (claim_stakes).
// Also handles two actions from the signed-in app: a test push, and a Stakes email preview to yourself.
//
// Secrets (set in Supabase → Edge Functions → Secrets; never in git):
//   CRON_SECRET          random string; pg_cron sends it in the x-cron-secret header
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY   web push keys
//   VAPID_SUBJECT        https URL of the app (identifies the sender to Apple/Google)
//   EMAIL_PROVIDER       'brevo' or 'resend' (optional until Stakes is used)
//   EMAIL_API_KEY, EMAIL_FROM
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const env = (k: string) => Deno.env.get(k) ?? '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export interface PushMessage {
  title: string;
  body: string;
  tag?: string;
  badge?: number;
  url?: string;
}

async function pushToUser(sb: SupabaseClient, userId: string, msg: PushMessage) {
  const { data: subs, error } = await sb
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId);
  if (error) throw error;
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(msg),
        { TTL: 60 * 60 * 4, urgency: 'high' },
      );
      sent++;
    } catch (e: any) {
      // 404/410 = the phone unsubscribed or the app was removed: forget that subscription.
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await sb.from('push_subscriptions').delete().eq('id', s.id);
      } else {
        console.error('push failed', e?.statusCode, e?.body ?? String(e));
      }
    }
  }
  return sent;
}

export async function sendEmail(to: { email: string; name?: string | null }, subject: string, text: string) {
  const provider = env('EMAIL_PROVIDER');
  const from = env('EMAIL_FROM');
  const key = env('EMAIL_API_KEY');
  if (!provider || !from || !key) throw new Error('Email is not set up yet');
  let res: Response;
  if (provider === 'brevo') {
    res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: from, name: 'Daily accountability' },
        to: [{ email: to.email, name: to.name ?? undefined }],
        subject,
        textContent: text,
      }),
    });
  } else if (provider === 'resend') {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to.email], subject, text }),
    });
  } else {
    throw new Error(`Unknown EMAIL_PROVIDER ${provider}`);
  }
  if (!res.ok) throw new Error(`email ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

function prettyDay(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric',
  });
}

export function stakesEmail(row: {
  my_name: string | null;
  recipient_name: string | null;
  day1: string;
  day2: string;
  missed: { day: string; name: string }[] | null;
}) {
  const who = row.my_name?.trim() || 'Your friend';
  const hi = row.recipient_name?.trim() ? `Hi ${row.recipient_name.trim()},` : 'Hi,';
  const byDay = new Map<string, string[]>();
  for (const m of row.missed ?? []) byDay.set(m.day, [...(byDay.get(m.day) ?? []), m.name]);
  const lines = [...byDay.entries()].map(([d, names]) => `• ${prettyDay(d)}: ${names.join(', ')}`);
  const subject = `${who} missed 2 days in a row`;
  const text = [
    hi,
    '',
    `${who} asked to be held accountable, and set up their daily checklist app to tell you when they slip.`,
    `They missed things 2 days in a row:`,
    '',
    ...lines,
    '',
    `Maybe send them a nudge. 🙂`,
    '',
    `— sent automatically by their accountability app`,
  ].join('\n');
  return { subject, text };
}

async function runTick(sb: SupabaseClient) {
  const now = new Date().toISOString();
  const out = { reminders: 0, pushes: 0, stakes: 0, errors: [] as string[] };

  const { data: due, error } = await sb.rpc('claim_reminders', { p_now: now });
  if (error) out.errors.push(`claim_reminders: ${error.message}`);
  for (const r of due ?? []) {
    out.reminders++;
    try {
      out.pushes += await pushToUser(sb, r.user_id, {
        title: r.title,
        body: r.body,
        tag: r.item_key,
        badge: r.open_count,
        url: r.item_key === 'photos' ? '/?open=photos' : '/',
      });
    } catch (e) {
      out.errors.push(`push: ${String(e)}`);
    }
  }

  const { data: stakes, error: e2 } = await sb.rpc('claim_stakes', { p_now: now });
  if (e2) out.errors.push(`claim_stakes: ${e2.message}`);
  for (const s of stakes ?? []) {
    const mail = stakesEmail(s);
    try {
      await sendEmail({ email: s.recipient_email, name: s.recipient_name }, mail.subject, mail.text);
      await sb.rpc('finish_stakes', { p_user: s.user_id, p_day: s.day2, p_ok: true, p_detail: 'sent' });
      out.stakes++;
      await pushToUser(sb, s.user_id, {
        title: 'Stakes triggered',
        body: `${s.recipient_name || s.recipient_email} was emailed about 2 missed days.`,
        tag: 'stakes',
      });
    } catch (e) {
      await sb.rpc('finish_stakes', { p_user: s.user_id, p_day: s.day2, p_ok: false, p_detail: String(e) });
      out.errors.push(`stakes: ${String(e)}`);
    }
  }
  return out;
}

if (import.meta.main) Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });
  if (env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY')) {
    webpush.setVapidDetails(env('VAPID_SUBJECT') || 'https://example.invalid', env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
  }

  // 1) Scheduled run
  if (safeEqual(req.headers.get('x-cron-secret') ?? '', env('CRON_SECRET'))) {
    return json(await runTick(sb));
  }

  // 2) Signed-in app actions
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: u } = token ? await sb.auth.getUser(token) : { data: { user: null } };
  if (!u?.user) return json({ error: 'unauthorized' }, 401);
  const body = await req.json().catch(() => ({}));

  if (body.action === 'test-push') {
    const sent = await pushToUser(sb, u.user.id, {
      title: 'Reminders are working ✅',
      body: 'This is what a reminder looks like.',
      tag: 'test',
    });
    return json({ sent });
  }

  if (body.action === 'stakes-preview') {
    const { data: s } = await sb.from('settings').select('my_name, stakes_name').eq('user_id', u.user.id).maybeSingle();
    const mail = stakesEmail({
      my_name: s?.my_name ?? null,
      recipient_name: s?.stakes_name ?? null,
      day1: '2026-01-05',
      day2: '2026-01-06',
      missed: [{ day: '2026-01-05', name: 'Example task' }, { day: '2026-01-06', name: 'Example task' }],
    });
    if (!u.user.email) return json({ error: 'no email on account' }, 400);
    try {
      await sendEmail({ email: u.user.email }, `[Preview] ${mail.subject}`, mail.text);
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  return json({ error: 'unknown action' }, 400);
});
