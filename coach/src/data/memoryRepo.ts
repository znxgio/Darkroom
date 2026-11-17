// Demo mode: everything stays in this browser, and critiques are canned examples (free).
// Used when no Supabase keys are set, and by the automated browser check.
import { monthStartLA, TAG_KEYS, worstCaseUsd, type CritiqueResult, type PaidTier } from '../../supabase/functions/_shared/critique';
import {
  CritiqueError,
  DEFAULT_SETTINGS,
  type Critique,
  type Photo,
  type PhotoWithCritiques,
  type Repo,
  type Settings,
} from './types';

interface Store {
  photos: Photo[];
  critiques: Critique[];
  usage: { created_at: string; cost_usd: number }[];
  settings: Settings;
}

/** Pretend cost per demo critique (roughly the real per-tier cost), so the cap can be tried out. */
export const DEMO_COSTS: Record<PaidTier, number> = { cheap: 0.001, better: 0.02, best: 0.035 };
export const DEMO_COST = DEMO_COSTS.best;

const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function demoCritique(seed: string, editingTips: boolean): CritiqueResult {
  const h = hash(seed);
  const pick = <T,>(xs: readonly T[], k: number) => xs[(h >>> k) % xs.length];
  const score = 4 + (h % 50) / 10; // 4.0–8.9
  const s = (k: number) => Math.max(1, Math.min(10, Math.round(score + (((h >>> k) % 5) - 2))));
  const t1 = pick(TAG_KEYS, 3);
  const t2 = pick(TAG_KEYS, 11);
  return {
    score: Math.round(score * 10) / 10,
    headline: 'Demo critique — connect the AI to get a real one.',
    scene: pick(['friends', 'street', 'lights', 'venue', 'concert', 'other'] as const, 5),
    subscores: { composition: s(1), light: s(7), moment: s(13), technical: s(17) },
    what_works: ['The light on the left side gives the scene some shape.', 'Good energy — it feels candid, not posed.'],
    fix: ['The main subject is a little small; get two steps closer.', 'The bright spot in the top corner pulls the eye away.'],
    angles: ['Crouch a bit so the subject stands out against the darker background.'],
    ...(editingTips
      ? { editing: { crop: 'Crop to 4:5 and trim the empty floor.', exposure: 'Exposure −0.2, Highlights −30, Shadows +20.', color: 'Warmth −10 to calm the orange lights.' } }
      : {}),
    tags: t1 === t2 ? [t1] : [t1, t2],
    next_shot: 'Before you press the shutter, check the four edges for half-objects.',
  };
}

export function memoryRepo(opts: { storageKey?: string; now?: () => Date } = {}): Repo {
  const key = opts.storageKey ?? 'darkroom-demo';
  const now = opts.now ?? (() => new Date());
  const empty = (): Store => ({ photos: [], critiques: [], usage: [], settings: { ...DEFAULT_SETTINGS } });
  let mem: Store | null = null;
  const read = (): Store => {
    if (mem) return mem;
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      mem = parsed ? { ...empty(), ...parsed, settings: { ...DEFAULT_SETTINGS, ...parsed.settings } } : empty();
    } catch {
      mem = empty();
    }
    return mem!;
  };
  const write = () => {
    try {
      localStorage.setItem(key, JSON.stringify(mem));
    } catch {
      /* storage full or blocked: keep in memory */
    }
  };
  const monthSpent = (st: Store) => {
    const since = new Date(monthStartLA(now()));
    return st.usage.filter((u) => new Date(u.created_at) >= since).reduce((a, u) => a + u.cost_usd, 0);
  };

  return {
    mode: 'demo',
    async listPhotos() {
      const st = read();
      return st.photos
        .map<PhotoWithCritiques>((p) => ({
          ...p,
          critiques: st.critiques.filter((c) => c.photo_id === p.id).sort((a, b) => b.created_at.localeCompare(a.created_at)),
        }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async addPhoto(p) {
      const st = read();
      const photo: Photo = { id: uuid(), created_at: now().toISOString(), ...p };
      st.photos.push(photo);
      write();
      return photo;
    },
    async deletePhoto(id) {
      const st = read();
      st.photos = st.photos.filter((p) => p.id !== id);
      st.critiques = st.critiques.filter((c) => c.photo_id !== id);
      write();
    },
    async critique(photoId, _image, tier) {
      const st = read();
      if (!st.settings.ai_critique) throw new CritiqueError('AI critique is turned off in Settings.', 403);
      const spent = monthSpent(st);
      const cap = st.settings.monthly_cap_usd;
      if (spent + worstCaseUsd(tier) > cap) {
        throw new CritiqueError(
          `Monthly cap reached ($${spent.toFixed(2)} of $${cap.toFixed(2)}). Raise it in Settings or wait until the 1st.`,
          402,
          { spent, cap },
        );
      }
      await new Promise((r) => setTimeout(r, 700)); // feel like a network call
      const result = demoCritique(photoId + st.critiques.length, st.settings.editing_tips);
      const created_at = now().toISOString();
      const c: Critique = {
        id: uuid(),
        photo_id: photoId,
        created_at,
        model: 'demo',
        score: result.score,
        result,
        tags: result.tags,
        cost_usd: DEMO_COSTS[tier],
      };
      st.critiques.push(c);
      st.usage.push({ created_at, cost_usd: DEMO_COSTS[tier] });
      write();
      return { critique: c, spend: { spent: spent + DEMO_COSTS[tier], cap } };
    },
    async saveChatCritique(photoId, result) {
      const st = read();
      const c: Critique = {
        id: uuid(),
        photo_id: photoId,
        created_at: now().toISOString(),
        model: 'claude-app',
        score: result.score,
        result,
        tags: result.tags,
        cost_usd: 0,
      };
      st.critiques.push(c);
      write();
      return c;
    },
    async getSettings() {
      return { ...read().settings };
    },
    async saveSettings(s) {
      read().settings = { ...s };
      write();
    },
    async spend() {
      const st = read();
      const since = new Date(monthStartLA(now()));
      const month = st.usage.filter((u) => new Date(u.created_at) >= since);
      return {
        month_usd: monthSpent(st),
        all_usd: st.usage.reduce((a, u) => a + u.cost_usd, 0),
        count_month: month.length,
        cap_usd: st.settings.monthly_cap_usd,
      };
    },
  };
}
