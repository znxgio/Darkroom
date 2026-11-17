import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { memoryRepo } from './data/memoryRepo';
import { supabaseRepo } from './data/supabaseRepo';
import type { Repo } from './data/types';

declare global {
  interface Window {
    /** Browser checks only: use a separate demo store. */
    __TEST__?: boolean;
  }
}

export interface Backend {
  repo: Repo;
  /** null in demo mode */
  supabase: SupabaseClient | null;
}

export function makeBackend(): Backend {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (typeof window !== 'undefined' && window.__TEST__) {
    return { repo: memoryRepo({ storageKey: 'darkroom-test' }), supabase: null };
  }
  if (url && key) {
    const supabase = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
    return { repo: supabaseRepo(supabase, `${url.replace(/\/$/, '')}/functions/v1`), supabase };
  }
  return { repo: memoryRepo(), supabase: null };
}
