// Daily photos (face + body). Cloud: private Supabase bucket + `photos` table, viewed only
// through short-lived signed URLs. Demo: blobs in IndexedDB on this device.
// Both only ever write today's photos; in the cloud the database enforces it too.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Backend } from '../../data/backend';
import type { Day } from '../../lib/dates';
import type { ExtraRequirement } from '../../lib/schedule';
import { blobStore, type BlobRecord } from './blobStore';

export type PhotoKind = 'face' | 'body';
export const KINDS: PhotoKind[] = ['face', 'body'];

export interface TodayPhotos {
  face?: string;
  body?: string;
}

export interface PhotoDay {
  day: Day;
  faceUrl?: string;
  bodyUrl?: string;
}

export interface PhotosApi {
  /** Today's photo URLs (signed in the cloud, blob: in demo). */
  today(): Promise<TodayPhotos>;
  /** Save (or retake) today's photo of this kind. */
  save(kind: PhotoKind, blob: Blob): Promise<void>;
  /** Days with photos, newest first, strictly before `beforeDay` (all days if omitted). */
  listDays(beforeDay?: Day, limit?: number): Promise<PhotoDay[]>;
  /** Days in [from, to] with BOTH photos. */
  completeDays(from: Day, to: Day): Promise<Set<Day>>;
  /** First day with any photo, or null. */
  firstDay(): Promise<Day | null>;
  /** Every day with any photo, newest first (for date pickers). */
  allDays(): Promise<Day[]>;
  /** Photos for specific days (Compare). */
  getDays(days: Day[]): Promise<PhotoDay[]>;
}

/** Daily photos as a required item for streaks/scores, from `photosFrom` on. */
export function photosRequirement(photosFrom: Day, complete: Set<Day>): ExtraRequirement {
  return {
    key: 'photos',
    appliesOn: (day) => day >= photosFrom,
    doneOn: (day) => complete.has(day),
  };
}

export function photoPath(userId: string, day: Day, kind: PhotoKind): string {
  return `${userId}/${day}/${kind}.jpg`;
}

interface Row {
  day: Day;
  kind: PhotoKind;
}

/**
 * Group rows (newest day first, at most one per day+kind) into days.
 * `fetched`/`requested`: when the query hit its row limit, the oldest day may be cut off,
 * so only days that are surely complete are kept, up to `limit`.
 */
export function groupDays<R extends Row>(
  rows: R[],
  limit: number,
  hitRowLimit: boolean,
): { day: Day; rows: R[] }[] {
  const out: { day: Day; rows: R[] }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.day === r.day) last.rows.push(r);
    else out.push({ day: r.day, rows: [r] });
  }
  if (hitRowLimit && out.length > 0 && out[out.length - 1].rows.length < KINDS.length) out.pop();
  return out.slice(0, limit);
}

/** Days that have every kind of photo. */
export function completeSet(rows: Row[]): Set<Day> {
  const byDay = new Map<Day, Set<PhotoKind>>();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, new Set());
    byDay.get(r.day)!.add(r.kind);
  }
  return new Set([...byDay].filter(([, k]) => k.size === KINDS.length).map(([d]) => d));
}

function sortRows<R extends Row>(rows: R[]): R[] {
  return [...rows].sort((a, b) => (a.day === b.day ? (a.kind < b.kind ? -1 : 1) : a.day < b.day ? 1 : -1));
}

const apis = new WeakMap<Backend, PhotosApi>();

export function photosApi(b: Backend): PhotosApi {
  let api = apis.get(b);
  if (!api) {
    api = b.supabase ? cloudApi(b, b.supabase) : demoApi(b);
    apis.set(b, api);
  }
  return api;
}

// ---------- cloud ----------

const BUCKET = 'photos';
const SIGN_SECONDS = 3600;
const SIGN_BATCH = 50;

function cloudApi(b: Backend, sb: SupabaseClient): PhotosApi {
  const signed = new Map<string, { url: string; exp: number }>();

  async function userId(): Promise<string> {
    const { data } = await sb.auth.getSession();
    const id = data.session?.user.id;
    if (!id) throw new Error('Please sign in again');
    return id;
  }

  /** Signed URLs for paths, reusing ones with >10 min left. Batched. */
  async function sign(paths: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const need: string[] = [];
    const now = Date.now();
    for (const p of paths) {
      const hit = signed.get(p);
      if (hit && hit.exp - now > 10 * 60_000) out.set(p, hit.url);
      else need.push(p);
    }
    for (let i = 0; i < need.length; i += SIGN_BATCH) {
      const chunk = need.slice(i, i + SIGN_BATCH);
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(chunk, SIGN_SECONDS);
      if (error) throw new Error(error.message);
      for (const s of data ?? []) {
        if (!s.signedUrl || !s.path) continue;
        out.set(s.path, s.signedUrl);
        signed.set(s.path, { url: s.signedUrl, exp: now + SIGN_SECONDS * 1000 });
      }
    }
    return out;
  }

  type PRow = Row & { path: string };

  async function toDays(groups: { day: Day; rows: PRow[] }[]): Promise<PhotoDay[]> {
    const urls = await sign(groups.flatMap((g) => g.rows.map((r) => r.path)));
    return groups.map((g) => {
      const d: PhotoDay = { day: g.day };
      for (const r of g.rows) {
        const u = urls.get(r.path);
        if (u) d[r.kind === 'face' ? 'faceUrl' : 'bodyUrl'] = u;
      }
      return d;
    });
  }

  return {
    async today() {
      const day = await b.repo.today();
      const { data, error } = await sb.from('photos').select('day,kind,path').eq('day', day);
      if (error) throw new Error(error.message);
      const [d] = await toDays(groupDays(sortRows((data ?? []) as PRow[]), 1, false));
      return { face: d?.faceUrl, body: d?.bodyUrl };
    },

    async save(kind, blob) {
      const [day, uid] = await Promise.all([b.repo.today(), userId()]);
      const path = photoPath(uid, day, kind);
      const up = await sb.storage
        .from(BUCKET)
        .upload(path, blob, { contentType: 'image/jpeg', upsert: true, cacheControl: '3600' });
      if (up.error) throw new Error(up.error.message);
      const { error } = await sb.from('photos').upsert({ day, kind, path }, { onConflict: 'user_id,day,kind' });
      if (error) throw new Error(error.message);
      signed.delete(path); // a fresh token = a fresh URL, so the old image isn't shown from cache
    },

    async listDays(beforeDay, limit = 10) {
      const max = limit * KINDS.length + KINDS.length;
      let q = sb.from('photos').select('day,kind,path').order('day', { ascending: false }).order('kind');
      if (beforeDay) q = q.lt('day', beforeDay);
      const { data, error } = await q.limit(max);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as PRow[];
      return toDays(groupDays(rows, limit, rows.length >= max));
    },

    async completeDays(from, to) {
      const rows: Row[] = [];
      for (let off = 0; ; off += 1000) {
        const { data, error } = await sb
          .from('photos')
          .select('day,kind')
          .gte('day', from)
          .lte('day', to)
          .order('day')
          .order('kind')
          .range(off, off + 999);
        if (error) throw new Error(error.message);
        rows.push(...((data ?? []) as Row[]));
        if (!data || data.length < 1000) break;
      }
      return completeSet(rows);
    },

    async firstDay() {
      const { data, error } = await sb.from('photos').select('day').order('day').limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? String(data.day) : null;
    },

    async allDays() {
      const days: Day[] = [];
      for (let off = 0; ; off += 1000) {
        const { data, error } = await sb
          .from('photos')
          .select('day')
          .order('day', { ascending: false })
          .order('kind')
          .range(off, off + 999);
        if (error) throw new Error(error.message);
        for (const r of data ?? []) if (days[days.length - 1] !== r.day) days.push(String(r.day));
        if (!data || data.length < 1000) break;
      }
      return days;
    },

    async getDays(days) {
      if (days.length === 0) return [];
      const { data, error } = await sb.from('photos').select('day,kind,path').in('day', days);
      if (error) throw new Error(error.message);
      const got = await toDays(groupDays(sortRows((data ?? []) as PRow[]), days.length, false));
      return days.map((d) => got.find((g) => g.day === d) ?? { day: d });
    },
  };
}

// ---------- demo ----------

function demoApi(b: Backend): PhotosApi {
  const store = blobStore(`${b.storagePrefix}-photos`);
  const urls = new Map<string, { at: number; url: string }>();
  let lastAt = 0;

  function urlFor(r: BlobRecord): string {
    const hit = urls.get(r.key);
    if (hit && hit.at === r.created_at) return hit.url;
    if (hit) URL.revokeObjectURL(hit.url);
    const url = URL.createObjectURL(r.blob);
    urls.set(r.key, { at: r.created_at, url });
    return url;
  }

  async function sorted(): Promise<BlobRecord[]> {
    return sortRows(await store.all());
  }

  function toDays(groups: { day: Day; rows: BlobRecord[] }[]): PhotoDay[] {
    return groups.map((g) => {
      const d: PhotoDay = { day: g.day };
      for (const r of g.rows) d[r.kind === 'face' ? 'faceUrl' : 'bodyUrl'] = urlFor(r);
      return d;
    });
  }

  return {
    async today() {
      const day = await b.repo.today();
      const [d] = toDays(groupDays((await sorted()).filter((r) => r.day === day), 1, false));
      return { face: d?.faceUrl, body: d?.bodyUrl };
    },

    async save(kind, blob) {
      if (!KINDS.includes(kind)) throw new Error('Unknown photo kind');
      // Always today: there is no way to add or replace another day's photo.
      const day = await b.repo.today();
      lastAt = Math.max(Date.now(), lastAt + 1); // unique even for two saves in the same ms
      await store.put({ key: `${day}/${kind}`, day, kind, blob, created_at: lastAt });
    },

    async listDays(beforeDay, limit = 10) {
      const rows = (await sorted()).filter((r) => !beforeDay || r.day < beforeDay);
      return toDays(groupDays(rows, limit, false));
    },

    async completeDays(from, to) {
      return completeSet((await store.all()).filter((r) => r.day >= from && r.day <= to));
    },

    async firstDay() {
      const rows = await sorted();
      return rows.length ? rows[rows.length - 1].day : null;
    },

    async allDays() {
      return [...new Set((await sorted()).map((r) => r.day))];
    },

    async getDays(days) {
      const rows = (await sorted()).filter((r) => days.includes(r.day));
      const got = toDays(groupDays(rows, days.length, false));
      return days.map((d) => got.find((g) => g.day === d) ?? { day: d });
    },
  };
}
