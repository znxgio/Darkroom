// Tracker entries: one row per (tracker, day). Cloud = Supabase table `tracker_entries`
// (rules enforced by the database), demo = this browser's storage (same rules here).
import type { Backend } from '../../data/backend';
import { demoStore } from '../../data/backend';
import type { Day } from '../../lib/dates';
import type { TrackerEntry, TrackerValue } from './registry';

const COLS = 'tracker_key,day,value';
const PAGE = 1000;

export interface TrackersApi {
  /** One day's entry, or null. */
  get(key: string, day: Day): Promise<TrackerEntry | null>;
  /** Log or change today's value. Past days are locked. */
  upsertToday(key: string, value: TrackerValue): Promise<TrackerEntry>;
  /** Remove today's value (past days are locked). */
  removeToday(key: string): Promise<void>;
  /** Entries between two days (inclusive), oldest first. */
  list(key: string, from: Day, to: Day): Promise<TrackerEntry[]>;
  /** Most recent entry; with `before`, the most recent one strictly before that day. */
  latest(key: string, before?: Day): Promise<TrackerEntry | null>;
}

function norm(r: any): TrackerEntry {
  return { tracker_key: r.tracker_key, day: String(r.day).slice(0, 10), value: r.value };
}

export function trackersApi(b: Backend): TrackersApi {
  if (b.supabase) {
    const sb = b.supabase;
    const table = () => sb.from('tracker_entries');
    return {
      async get(key, day) {
        const { data, error } = await table().select(COLS).eq('tracker_key', key).eq('day', day).maybeSingle();
        if (error) throw new Error(error.message);
        return data ? norm(data) : null;
      },
      async upsertToday(key, value) {
        const day = await b.repo.today();
        // Update first (only `value` is updatable), insert if there was nothing yet.
        const up = await table().update({ value }).eq('tracker_key', key).eq('day', day).select(COLS);
        if (up.error) throw new Error(up.error.message);
        if (up.data && up.data.length) return norm(up.data[0]);
        const ins = await table().insert({ tracker_key: key, day, value }).select(COLS).single();
        if (ins.error) throw new Error(ins.error.message);
        return norm(ins.data);
      },
      async removeToday(key) {
        const day = await b.repo.today();
        const { error } = await table().delete().eq('tracker_key', key).eq('day', day);
        if (error) throw new Error(error.message);
      },
      async list(key, from, to) {
        const out: TrackerEntry[] = [];
        for (let page = 0; ; page++) {
          const { data, error } = await table()
            .select(COLS)
            .eq('tracker_key', key)
            .gte('day', from)
            .lte('day', to)
            .order('day', { ascending: true })
            .range(page * PAGE, page * PAGE + PAGE - 1);
          if (error) throw new Error(error.message);
          out.push(...(data ?? []).map(norm));
          if (!data || data.length < PAGE) return out;
        }
      },
      async latest(key, before) {
        let q = table().select(COLS).eq('tracker_key', key);
        if (before) q = q.lt('day', before);
        const { data, error } = await q.order('day', { ascending: false }).limit(1).maybeSingle();
        if (error) throw new Error(error.message);
        return data ? norm(data) : null;
      },
    };
  }

  const store = demoStore<TrackerEntry[]>(b, 'trackers', []);
  const sorted = () => [...store.read()].sort((a, c) => (a.day < c.day ? -1 : a.day > c.day ? 1 : 0));
  return {
    async get(key, day) {
      return store.read().find((e) => e.tracker_key === key && e.day === day) ?? null;
    },
    async upsertToday(key, value) {
      if (!/^[a-z][a-z0-9_]{0,30}$/.test(key)) throw new Error('Bad tracker key');
      const day = await b.repo.today();
      const entry: TrackerEntry = { tracker_key: key, day, value };
      store.write([...store.read().filter((e) => !(e.tracker_key === key && e.day === day)), entry]);
      return entry;
    },
    async removeToday(key) {
      const day = await b.repo.today();
      store.write(store.read().filter((e) => !(e.tracker_key === key && e.day === day)));
    },
    async list(key, from, to) {
      return sorted().filter((e) => e.tracker_key === key && e.day >= from && e.day <= to);
    },
    async latest(key, before) {
      const all = sorted().filter((e) => e.tracker_key === key && (!before || e.day < before));
      return all.length ? all[all.length - 1] : null;
    },
  };
}
