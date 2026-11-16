import { createClient } from '@supabase/supabase-js';
import type { Backend } from './data/backend';
import { memoryRepo } from './data/memoryRepo';
import { supabaseRepo } from './data/supabaseRepo';
import { authStorage } from './data/authStorage';

declare global {
  interface Window {
    /** Browser checks only: pins "now" (ISO string) and uses a separate demo store. */
    __TEST_NOW__?: string;
  }
}

export function makeBackend(): Backend {
  if (typeof window !== 'undefined' && window.__TEST_NOW__) {
    const pinned = window.__TEST_NOW__;
    const now = () => new Date(pinned);
    return {
      repo: memoryRepo({ clock: now, storageKey: 'accountability-test' }),
      supabase: null,
      now,
      storagePrefix: 'accountability-test',
    };
  }
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  const now = () => new Date();
  if (url && key) {
    const supabase = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, storage: authStorage },
    });
    return { repo: supabaseRepo(supabase), supabase, now, storagePrefix: 'accountability' };
  }
  return { repo: memoryRepo(), supabase: null, now, storagePrefix: 'accountability-demo' };
}
