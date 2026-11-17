import { describe, expect, it } from 'vitest';
import {
  cleanResult,
  costUsd,
  critiqueSchema,
  monthStartLA,
  TAG_KEYS,
  userPrompt,
  WORST_CASE_USD,
} from '../supabase/functions/_shared/critique';
import { memoryRepo, DEMO_COST } from '../src/data/memoryRepo';
import { progressStats } from '../src/lib/progress';
import type { PhotoWithCritiques } from '../src/data/types';

describe('critique format', () => {
  it('schema includes editing tips only when asked', () => {
    const on = critiqueSchema(true) as { required: string[]; properties: Record<string, unknown> };
    const off = critiqueSchema(false) as { required: string[]; properties: Record<string, unknown> };
    expect(on.required).toContain('editing');
    expect(off.required).not.toContain('editing');
    expect(off.properties.editing).toBeUndefined();
  });

  it('cleanResult clamps scores, drops unknown tags and hides editing when off', () => {
    const r = cleanResult(
      {
        score: 14,
        headline: 'Nice',
        scene: 'mars',
        subscores: { composition: 0, light: 7.6, moment: 'x', technical: 11 },
        what_works: ['a', '', 3],
        fix: ['b'],
        angles: [],
        tags: ['headroom', 'made-up', 'backlight', 'noise', 'clutter'],
        editing: { crop: 'c', exposure: 'e', color: 'k' },
        next_shot: 'n',
      },
      false,
    );
    expect(r.score).toBe(10);
    expect(r.scene).toBe('other');
    expect(r.subscores).toEqual({ composition: 1, light: 8, moment: 5, technical: 10 });
    expect(r.what_works).toEqual(['a']);
    expect(r.tags).toEqual(['headroom', 'backlight']);
    expect(r.editing).toBeUndefined();
    expect(cleanResult({ editing: { crop: 'c' } }, true).editing).toEqual({ crop: 'c', exposure: '', color: '' });
  });

  it('cost math and the worst case', () => {
    expect(costUsd(['claude-opus-5-5'], 2500, 1500)).toBeCloseTo(0.01 + 0.03, 6);
    // a fallback model that costs more is charged at its price
    expect(costUsd(['claude-opus-5-5', 'claude-opus-4-8'], 1_000_000, 0)).toBe(5);
    // unknown models are priced high on purpose
    expect(costUsd(['mystery-model'], 1_000_000, 0)).toBe(10);
    expect(WORST_CASE_USD).toBeGreaterThan(0.1);
    expect(WORST_CASE_USD).toBeLessThan(0.2);
  });

  it('the month resets at midnight LA on the 1st (both PST and PDT)', () => {
    expect(monthStartLA(new Date('2026-11-17T12:00:00Z'))).toBe('2026-11-01T07:00:00.000Z'); // Nov 1 is still PDT
    expect(monthStartLA(new Date('2026-12-05T12:00:00Z'))).toBe('2026-12-01T08:00:00.000Z'); // PST
    // 11pm Nov 30 in LA is still November
    expect(monthStartLA(new Date('2026-12-01T07:30:00Z'))).toBe('2026-11-01T07:00:00.000Z');
  });

  it('prompt mentions habits and skips editing when off', () => {
    const p = userPrompt({ editingTips: false, source: 'live', liveScore: 6, recurring: ['Headroom'], note: 'neon' });
    expect(p).toContain('Headroom');
    expect(p).toContain('6/10');
    expect(p).toContain('Skip editing tips');
  });
});

describe('demo store spending cap', () => {
  it('refuses a critique when the next one could pass the cap', async () => {
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    const repo = memoryRepo({ storageKey: 't' });
    const s = await repo.getSettings();
    await repo.saveSettings({ ...s, monthly_cap_usd: WORST_CASE_USD + DEMO_COST * 0.5 });
    const p = await repo.addPhoto({ source: 'import', thumb: 'x', width: 1, height: 1, exif: null, taken_at: null, live_score: null, note: null });
    const first = await repo.critique(p.id, 'AAAA');
    expect(first.spend.spent).toBeCloseTo(DEMO_COST);
    await expect(repo.critique(p.id, 'AAAA')).rejects.toMatchObject({ status: 402 });
    expect((await repo.spend()).count_month).toBe(1);
  });
});

describe('progress', () => {
  const mk = (i: number, score: number, tags: string[]): PhotoWithCritiques => {
    const at = new Date(Date.UTC(2026, 10, 1 + i, 20)).toISOString();
    return {
      id: `p${i}`,
      created_at: at,
      taken_at: null,
      source: 'import',
      thumb: '',
      width: null,
      height: null,
      exif: null,
      live_score: null,
      note: null,
      critiques: [
        {
          id: `c${i}`,
          photo_id: `p${i}`,
          created_at: at,
          model: 'demo',
          score,
          tags,
          cost_usd: 0,
          result: {
            score,
            headline: '',
            scene: 'other',
            subscores: { composition: score, light: score, moment: score, technical: score },
            what_works: [],
            fix: [],
            angles: [],
            tags: tags as never,
            next_shot: '',
          },
        },
      ],
    };
  };
  it('average, trend, habits, improvements and streak', () => {
    const photos = Array.from({ length: 20 }, (_, i) => mk(i, i < 10 ? 5 : 7, i < 10 ? ['horizon-tilt', 'headroom'] : ['headroom']));
    const s = progressStats(photos, new Date('2026-11-20T22:00:00Z'));
    expect(s.avg).toBe(6);
    expect(s.trend).toBe(2);
    expect(s.habits[0].tag).toBe('headroom');
    expect(s.improved.map((x) => x.tag)).toEqual(['horizon-tilt']);
    expect(s.best?.critiques[0].score).toBe(7);
    expect(s.streak).toBe(20);
    expect(TAG_KEYS.length).toBeGreaterThan(10);
  });
});
