// Storage for stage 4: reasons for missed extras, and weekly review notes.
// Cloud = Supabase tables from 0004_accountability.sql; demo = this browser, same rules.
import type { Backend } from '../../data/backend';
import { demoStore } from '../../data/backend';
import { LockedError } from '../../data/repo';
import { weekday, type Day } from '../../lib/dates';
import type { ExtraExcuse } from './logic';
import { reviewWindow } from './logic';

export const REVIEW_MAX = 200;
export const REASON_MAX = 500;

function fail(error: { message?: string } | null): void {
  if (!error) return;
  const msg = error.message ?? String(error);
  if (/locked|past day|opens|Monday|can't be changed/i.test(msg)) throw new LockedError(msg);
  throw new Error(msg);
}

// ---------- Reasons for missed extras (e.g. no photo) ----------

export function excusesApi(b: Backend) {
  if (b.supabase) {
    const sb = b.supabase;
    return {
      async list(from: Day, to: Day): Promise<ExtraExcuse[]> {
        const { data, error } = await sb
          .from('extra_excuses')
          .select('day,item_key,reason')
          .gte('day', from)
          .lte('day', to);
        fail(error);
        return (data ?? []) as ExtraExcuse[];
      },
      /** Past days only; once saved it can't be changed. */
      async add(day: Day, itemKey: string, reason: string): Promise<void> {
        const r = reason.trim();
        if (!r) throw new Error('A reason is required');
        const { error } = await sb.from('extra_excuses').insert({ day, item_key: itemKey, reason: r });
        fail(error);
      },
    };
  }
  const store = demoStore<ExtraExcuse[]>(b, 'extra_excuses', []);
  return {
    async list(from: Day, to: Day): Promise<ExtraExcuse[]> {
      return store.read().filter((e) => e.day >= from && e.day <= to);
    },
    async add(day: Day, itemKey: string, reason: string): Promise<void> {
      const r = reason.trim();
      if (!r) throw new Error('A reason is required');
      if (r.length > REASON_MAX) throw new Error('That reason is too long');
      if (day >= (await b.repo.today())) throw new LockedError('Only a past day can be explained');
      const all = store.read();
      if (all.some((e) => e.day === day && e.item_key === itemKey)) throw new LockedError("Reasons can't be changed");
      store.write([...all, { day, item_key: itemKey, reason: r }]);
    },
  };
}

// ---------- Weekly review notes ----------

export interface WeeklyReview {
  /** Monday of the week */
  week_start: Day;
  note: string;
}

export function reviewsApi(b: Backend) {
  if (b.supabase) {
    const sb = b.supabase;
    const COLS = 'week_start,note';
    return {
      async list(): Promise<WeeklyReview[]> {
        const { data, error } = await sb.from('weekly_reviews').select(COLS);
        fail(error);
        return (data ?? []) as WeeklyReview[];
      },
      /** Allowed from the week's Sunday through the following Sunday (checked by the database). */
      async save(week: Day, note: string): Promise<WeeklyReview> {
        const n = note.trim();
        // No upsert: an upsert would need update rights on the key columns.
        const upd = await sb.from('weekly_reviews').update({ note: n }).eq('week_start', week).select(COLS);
        fail(upd.error);
        if (upd.data && upd.data.length) return upd.data[0] as WeeklyReview;
        const ins = await sb.from('weekly_reviews').insert({ week_start: week, note: n }).select(COLS).single();
        fail(ins.error);
        return ins.data as WeeklyReview;
      },
    };
  }
  const store = demoStore<WeeklyReview[]>(b, 'weekly_reviews', []);
  return {
    async list(): Promise<WeeklyReview[]> {
      return store.read();
    },
    async save(week: Day, note: string): Promise<WeeklyReview> {
      const n = note.trim();
      if (n.length > REVIEW_MAX) throw new Error('Keep it to one line');
      if (weekday(week) !== 1) throw new LockedError('A week starts on Monday');
      const w = reviewWindow(week, await b.repo.today());
      if (w === 'upcoming') throw new LockedError('The weekly review opens on Sunday');
      if (w === 'locked') throw new LockedError("This week's review is locked");
      const rev = { week_start: week, note: n };
      store.write([...store.read().filter((r) => r.week_start !== week), rev]);
      return rev;
    },
  };
}
