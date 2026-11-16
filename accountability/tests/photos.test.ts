import { describe, expect, it } from 'vitest';
import type { Backend } from '../src/data/backend';
import { memoryRepo } from '../src/data/memoryRepo';
import { completeSet, groupDays, photoPath, photosApi, photosRequirement } from '../src/features/photos/api';
import { cropRect, encodeUnderTarget, fitWithin } from '../src/features/photos/image';
import { dayNumber, daysApart } from '../src/features/photos/labels';
import { dayResult, streak } from '../src/lib/schedule';

describe('image sizing', () => {
  it('fits the longest side to 1280 and never upscales', () => {
    expect(fitWithin(1920, 2560)).toEqual({ w: 960, h: 1280 });
    expect(fitWithin(3024, 4032)).toEqual({ w: 960, h: 1280 });
    expect(fitWithin(2560, 1920)).toEqual({ w: 1280, h: 960 });
    expect(fitWithin(360, 480)).toEqual({ w: 360, h: 480 });
  });

  it('center-crops to 3:4 portrait', () => {
    expect(cropRect(1920, 1080)).toEqual({ sx: 555, sy: 0, sw: 810, sh: 1080 });
    expect(cropRect(1080, 1920)).toEqual({ sx: 0, sy: 240, sw: 1080, sh: 1440 });
    expect(cropRect(480, 640)).toEqual({ sx: 0, sy: 0, sw: 480, sh: 640 });
  });
});

describe('encodeUnderTarget', () => {
  const fake = (sizes: Record<number, number>) => {
    const tried: number[] = [];
    const encode = async (q: number) => {
      tried.push(q);
      return new Blob([new Uint8Array(sizes[q])], { type: 'image/jpeg' });
    };
    return { tried, encode };
  };

  it('keeps the first quality that fits', async () => {
    const f = fake({ 0.8: 500_000, 0.7: 340_000, 0.6: 200_000, 0.5: 100_000 });
    const r = await encodeUnderTarget(f.encode, 350 * 1024);
    expect(r.quality).toBe(0.7);
    expect(f.tried).toEqual([0.8, 0.7]);
  });

  it('stops at 0.8 when it already fits', async () => {
    const f = fake({ 0.8: 120_000 });
    const r = await encodeUnderTarget(f.encode);
    expect(r.quality).toBe(0.8);
    expect(f.tried).toEqual([0.8]);
  });

  it('falls back to the lowest quality when nothing fits', async () => {
    const f = fake({ 0.8: 900_000, 0.7: 800_000, 0.6: 700_000, 0.5: 600_000 });
    const r = await encodeUnderTarget(f.encode);
    expect(r.quality).toBe(0.5);
    expect(r.blob.size).toBe(600_000);
  });
});

describe('photo rows', () => {
  const rows = [
    { day: '2026-11-16', kind: 'body' as const },
    { day: '2026-11-16', kind: 'face' as const },
    { day: '2026-11-15', kind: 'face' as const },
    { day: '2026-11-14', kind: 'body' as const },
  ];

  it('groups by day and drops a possibly cut-off last day', () => {
    expect(groupDays(rows, 10, false).map((g) => g.day)).toEqual(['2026-11-16', '2026-11-15', '2026-11-14']);
    expect(groupDays(rows, 10, true).map((g) => g.day)).toEqual(['2026-11-16', '2026-11-15']);
    expect(groupDays(rows, 1, false).map((g) => g.day)).toEqual(['2026-11-16']);
  });

  it('complete days need both photos', () => {
    expect([...completeSet(rows)]).toEqual(['2026-11-16']);
  });

  it('builds the storage path', () => {
    expect(photoPath('u1', '2026-11-16', 'face')).toBe('u1/2026-11-16/face.jpg');
  });

  it('labels', () => {
    expect(dayNumber('2026-11-16', '2026-11-05')).toBe(12);
    expect(dayNumber('2026-11-04', '2026-11-05')).toBeNull();
    expect(daysApart('2026-11-16', '2026-11-01')).toBe(15);
  });
});

describe('photosRequirement', () => {
  it('counts from photos_from and is done only with both photos', () => {
    const req = photosRequirement('2026-11-10', new Set(['2026-11-12']));
    expect(req.key).toBe('photos');
    expect(req.appliesOn('2026-11-09')).toBe(false);
    expect(req.appliesOn('2026-11-10')).toBe(true);
    expect(req.doneOn('2026-11-12')).toBe(true);
    expect(req.doneOn('2026-11-11')).toBe(false);
    expect(dayResult('2026-11-11', '2026-11-16', [], [], [req]).color).toBe('red');
    expect(dayResult('2026-11-12', '2026-11-16', [], [], [req]).color).toBe('green');
    expect(dayResult('2026-11-16', '2026-11-16', [], [], [req]).color).toBe('pending');
    expect(dayResult('2026-11-09', '2026-11-16', [], [], [req]).color).toBe('gray');
    expect(streak('2026-11-13', [], [], [req], '2026-11-10')).toBe(1);
  });
});

describe('demo photos api', () => {
  function backend(nowIso: { v: string }): Backend {
    const now = () => new Date(nowIso.v);
    return { repo: memoryRepo({ clock: now, storageKey: null }), supabase: null, now, storagePrefix: `t${Math.random()}` };
  }
  const jpg = (n: number) => new Blob([new Uint8Array(n)], { type: 'image/jpeg' });

  it('saves only to today and lists newest first', async () => {
    const clock = { v: '2026-11-15T17:00:00Z' };
    const b = backend(clock);
    const api = photosApi(b);
    expect(await api.firstDay()).toBeNull();
    await api.save('face', jpg(10));
    await api.save('body', jpg(10));
    clock.v = '2026-11-16T17:00:00Z';
    await api.save('face', jpg(10));
    await api.save('face', jpg(20)); // retake replaces

    const t = await api.today();
    expect(t.face).toMatch(/^blob:/);
    expect(t.body).toBeUndefined();
    expect(await api.firstDay()).toBe('2026-11-15');
    expect(await api.allDays()).toEqual(['2026-11-16', '2026-11-15']);
    expect([...(await api.completeDays('2026-11-01', '2026-11-30'))]).toEqual(['2026-11-15']);

    const page1 = await api.listDays(undefined, 1);
    expect(page1.map((d) => d.day)).toEqual(['2026-11-16']);
    const page2 = await api.listDays(page1[0].day, 1);
    expect(page2[0].day).toBe('2026-11-15');
    expect(page2[0].faceUrl && page2[0].bodyUrl).toBeTruthy();

    const got = await api.getDays(['2026-11-15', '2026-11-01']);
    expect(got[0].bodyUrl).toBeTruthy();
    expect(got[1]).toEqual({ day: '2026-11-01' });
  });
});
