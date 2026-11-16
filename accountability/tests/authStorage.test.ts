import { beforeEach, describe, expect, it } from 'vitest';

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    has: (k: string) => m.has(k),
  };
}
const local = fakeStorage();
const session = fakeStorage();
(globalThis as any).localStorage = local;
(globalThis as any).sessionStorage = session;
const { authStorage, setRemember, getRemember, rememberedEmail } = await import('../src/data/authStorage');

describe('remember me', () => {
  beforeEach(() => {
    local.clear();
    session.clear();
  });
  it('defaults to on and keeps the session in localStorage', () => {
    expect(getRemember()).toBe(true);
    authStorage.setItem('sb', 'token');
    expect(local.has('sb')).toBe(true);
    expect(session.has('sb')).toBe(false);
  });
  it('off: session only lives in sessionStorage (gone when the app closes)', () => {
    setRemember(false);
    authStorage.setItem('sb', 'token');
    expect(local.has('sb')).toBe(false);
    expect(authStorage.getItem('sb')).toBe('token');
    expect(rememberedEmail()).toBe('');
  });
  it('remembers the email when on, and sign-out clears both stores', () => {
    setRemember(true, 'me@example.com');
    expect(rememberedEmail()).toBe('me@example.com');
    authStorage.setItem('sb', 'token');
    authStorage.removeItem('sb');
    expect(authStorage.getItem('sb')).toBeNull();
  });
});
