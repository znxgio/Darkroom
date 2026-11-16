// Loads a tracker's entries and saves today's value (optimistic, rolls back on error).
// Shared by the Today card and the detail view.
import { useCallback, useEffect, useState } from 'react';
import type { Backend } from '../../data/backend';
import type { Day } from '../../lib/dates';
import { errMsg } from '../../screens/ui';
import type { TrackersApi } from './api';
import type { TrackerDef, TrackerEntry, TrackerValue } from './registry';

interface CardData {
  today: Day;
  /** Oldest first: the last 90 days, plus the latest older entry when there's none before today. */
  entries: TrackerEntry[];
}

export function useTodayEntry(api: TrackersApi, backend: Backend, def: TrackerDef, from: (today: Day) => Day) {
  const [data, setData] = useState<CardData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const today = await backend.repo.today();
      let entries = await api.list(def.key, from(today), today);
      if (!entries.some((e) => e.day < today)) {
        const prev = await api.latest(def.key, today);
        if (prev && !entries.some((e) => e.day === prev.day)) entries = [prev, ...entries];
      }
      setData({ today, entries });
      setError(null);
    } catch (e) {
      setError(`Couldn't load: ${errMsg(e)}`);
    }
    // `from` is a module-level function, so it never changes
  }, [api, backend, def.key]);

  useEffect(() => {
    load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  async function save(value: TrackerValue): Promise<boolean> {
    if (!data || saving) return false;
    const before = data;
    const others = data.entries.filter((e) => e.day !== data.today);
    setData({ ...data, entries: [...others, { tracker_key: def.key, day: data.today, value }] });
    setSaving(true);
    setError(null);
    try {
      await api.upsertToday(def.key, value);
      return true;
    } catch (e) {
      setData(before);
      setError(`Couldn't save: ${errMsg(e)}`);
      load(); // the day may have rolled over
      return false;
    } finally {
      setSaving(false);
    }
  }

  return { data, saving, error, load, save };
}

