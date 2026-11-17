import type { SupabaseClient } from '@supabase/supabase-js';
import { monthStartLA } from '../../supabase/functions/_shared/critique';
import {
  CritiqueError,
  DEFAULT_SETTINGS,
  type Critique,
  type Photo,
  type PhotoWithCritiques,
  type Repo,
  type Settings,
} from './types';

export function supabaseRepo(sb: SupabaseClient, functionsUrl: string): Repo {
  const uid = async () => {
    const { data } = await sb.auth.getSession();
    if (!data.session) throw new Error('Signed out');
    return data.session;
  };
  const num = (c: Critique) => ({ ...c, score: Number(c.score), cost_usd: Number(c.cost_usd) });

  return {
    mode: 'cloud',

    async listPhotos() {
      const { data, error } = await sb
        .from('photos')
        .select('*, critiques(*)')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data as PhotoWithCritiques[]).map((p) => ({
        ...p,
        critiques: (p.critiques ?? []).map(num).sort((a, b) => b.created_at.localeCompare(a.created_at)),
      }));
    },

    async addPhoto(p) {
      const { data, error } = await sb.from('photos').insert(p).select('*').single();
      if (error) throw error;
      return data as Photo;
    },

    async deletePhoto(id) {
      const { error } = await sb.from('photos').delete().eq('id', id);
      if (error) throw error;
    },

    async critique(photoId, image) {
      const session = await uid();
      let res: Response;
      try {
        res = await fetch(`${functionsUrl}/critique`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ photo_id: photoId, image, media_type: 'image/jpeg' }),
        });
      } catch {
        throw new CritiqueError('No connection. Try again when you have signal.', 0);
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const spend = typeof body.spent === 'number' ? { spent: body.spent, cap: body.cap } : undefined;
        throw new CritiqueError(body.error ?? `Critique failed (${res.status})`, res.status, spend);
      }
      return { critique: num(body.critique), spend: { spent: body.spent, cap: body.cap } };
    },

    async getSettings() {
      const { data, error } = await sb.from('settings').select('*').maybeSingle();
      if (error) throw error;
      if (!data) return { ...DEFAULT_SETTINGS };
      return {
        live_coaching: data.live_coaching,
        ai_critique: data.ai_critique,
        editing_tips: data.editing_tips,
        monthly_cap_usd: Number(data.monthly_cap_usd),
        depth: data.depth,
        overlays: { ...DEFAULT_SETTINGS.overlays, ...(data.overlays ?? {}) },
      };
    },

    async saveSettings(s: Settings) {
      const session = await uid();
      const { error } = await sb
        .from('settings')
        .upsert({ user_id: session.user.id, ...s, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) throw error;
    },

    async spend() {
      const since = monthStartLA(new Date());
      const [{ data: rows, error }, settings] = await Promise.all([
        sb.from('api_usage').select('cost_usd, created_at').limit(10000),
        this.getSettings(),
      ]);
      if (error) throw error;
      let month = 0;
      let all = 0;
      let count = 0;
      for (const r of rows ?? []) {
        const c = Number(r.cost_usd);
        all += c;
        if (new Date(r.created_at) >= new Date(since)) {
          month += c;
          count++;
        }
      }
      return { month_usd: month, all_usd: all, count_month: count, cap_usd: settings.monthly_cap_usd };
    },
  };
}
