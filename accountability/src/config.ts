import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Repo } from './data/repo';
import { memoryRepo } from './data/memoryRepo';
import { supabaseRepo } from './data/supabaseRepo';

declare global {
  interface Window {
    /** Browser checks only: pins "now" (ISO string) and uses a separate demo store. */
    __TEST_NOW__?: string;
  }
}

export function makeRepo(): { repo: Repo; supabase: SupabaseClient | null } {
  if (typeof window !== 'undefined' && window.__TEST_NOW__) {
    const now = window.__TEST_NOW__;
    return {
      repo: memoryRepo({ clock: () => new Date(now), storageKey: 'accountability-test' }),
      supabase: null,
    };
  }
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (url && key) {
    const supabase = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    return { repo: supabaseRepo(supabase), supabase };
  }
  return { repo: memoryRepo(), supabase: null };
}
