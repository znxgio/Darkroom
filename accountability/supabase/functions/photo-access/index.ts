// photo-access: read-only listing of the owner's dated daily photos, for a Claude session.
// GET /functions/v1/photo-access?from=YYYY-MM-DD&to=YYYY-MM-DD   (max 62 days)
// GET /functions/v1/photo-access?latest=7                        (last N photo days, max 62)
// Header: x-photo-key: <PHOTO_ACCESS_KEY>
// Only works while Settings → "Let Claude view my photos" is ON. Every call is logged.
// Returns short-lived (15 min) signed links; photos are never made public.
import { createClient } from 'npm:@supabase/supabase-js@2';

const env = (k: string) => Deno.env.get(k) ?? '';
// Older projects expose SUPABASE_SERVICE_ROLE_KEY; newer ones only the secret key list.
function serviceKey(): string {
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}');
    return keys.default ?? Object.values(keys)[0] ?? '';
  } catch {
    return '';
  }
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { 'content-type': 'application/json' } });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

if (import.meta.main) Deno.serve(async (req) => {
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);
  const key = env('PHOTO_ACCESS_KEY');
  if (!key || key.length < 32) return json({ error: 'photo access is not set up' }, 404);
  if (!safeEqual(req.headers.get('x-photo-key') ?? '', key)) return json({ error: 'unauthorized' }, 401);

  const sb = createClient(env('SUPABASE_URL'), serviceKey(), { auth: { persistSession: false } });

  // Single-user app: the owner is the one account with settings (or PHOTO_OWNER_ID if set).
  let owner = env('PHOTO_OWNER_ID');
  if (!owner) {
    const { data } = await sb.from('settings').select('user_id').limit(2);
    if (!data || data.length !== 1) return json({ error: 'set PHOTO_OWNER_ID' }, 500);
    owner = data[0].user_id;
  }
  const { data: s } = await sb.from('settings').select('claude_photo_access, photos_from').eq('user_id', owner).single();
  if (!s?.claude_photo_access) return json({ error: 'The owner has photo access switched OFF in Settings.' }, 403);

  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const latest = Number(url.searchParams.get('latest') ?? 0);

  let q = sb.from('photos').select('day, kind, path').eq('user_id', owner);
  if (from || to) {
    if (!from || !to || !DAY.test(from) || !DAY.test(to) || from > to) return json({ error: 'from/to must be YYYY-MM-DD, from <= to' }, 400);
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 62) return json({ error: 'max 62 days per request' }, 400);
    q = q.gte('day', from).lte('day', to);
  } else {
    const n = Math.min(Math.max(latest || 7, 1), 62);
    const { data: days } = await sb.from('photos').select('day').eq('user_id', owner).order('day', { ascending: false }).limit(n * 2);
    const keep = [...new Set((days ?? []).map((d) => d.day))].slice(0, n);
    if (!keep.length) return json({ days: [] });
    q = q.in('day', keep);
  }
  const { data: rows, error } = await q.order('day');
  if (error) return json({ error: error.message }, 500);

  const paths = (rows ?? []).map((r) => r.path);
  const loggedDays = [...new Set((rows ?? []).map((r) => r.day))].sort();
  // Log BEFORE handing out any link; no log, no photos.
  const { error: logErr } = await sb.from('photo_access_log').insert({
    user_id: owner,
    from_day: loggedDays[0] ?? null,
    to_day: loggedDays[loggedDays.length - 1] ?? null,
    photo_count: paths.length,
  });
  if (logErr) return json({ error: 'could not log access; refusing' }, 500);
  const signed = paths.length ? (await sb.storage.from('photos').createSignedUrls(paths, 900)).data ?? [] : [];
  const urlFor = new Map(signed.map((x) => [x.path, x.signedUrl]));

  // Weight on the same day, if logged (helps compare progress).
  const dayList = [...new Set((rows ?? []).map((r) => r.day))];
  const { data: weights } = dayList.length
    ? await sb.from('tracker_entries').select('day, value').eq('user_id', owner).eq('tracker_key', 'weight').in('day', dayList)
    : { data: [] as { day: string; value: any }[] };
  const weightOn = new Map((weights ?? []).map((w) => [w.day, w.value?.v ?? null]));

  const first = s.photos_from as string;
  const out = dayList.map((day) => {
    const face = rows!.find((r) => r.day === day && r.kind === 'face');
    const body = rows!.find((r) => r.day === day && r.kind === 'body');
    return {
      day,
      day_number: Math.round((Date.parse(day) - Date.parse(first)) / 86400000) + 1,
      face: face ? urlFor.get(face.path) ?? null : null,
      body: body ? urlFor.get(body.path) ?? null : null,
      weight_lbs: weightOn.get(day) ?? null,
    };
  });

  return json({ note: 'Links expire in 15 minutes.', days: out });
});
