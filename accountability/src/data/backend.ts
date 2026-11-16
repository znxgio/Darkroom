// Everything a feature module needs to talk to storage.
// Features (photos, stats, trackers, …) each live in src/features/<name>/ and
// implement their own small API with a cloud (Supabase) and a demo (in-browser) version.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Repo } from './repo';

export interface Backend {
  repo: Repo;
  /** null in demo mode */
  supabase: SupabaseClient | null;
  /** "now" (pinned in browser checks) */
  now: () => Date;
  /** Prefix for demo-mode local storage keys */
  storagePrefix: string;
}

/** Tiny JSON helper for demo-mode storage (never used in cloud mode). */
export function demoStore<T>(b: Backend, name: string, initial: T) {
  const key = `${b.storagePrefix}:${name}`;
  return {
    read(): T {
      try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : initial;
      } catch {
        return initial;
      }
    },
    write(v: T) {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage full or blocked: demo only */
      }
    },
  };
}
