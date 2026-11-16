// "Remember me": where the login session is kept.
//  on  (default) → localStorage: stay signed in until you sign out.
//  off           → sessionStorage: signed out when the app is fully closed.
const FLAG = 'daily:remember';
const EMAIL = 'daily:email';

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function getRemember(): boolean {
  return safe(() => localStorage.getItem(FLAG) !== '0', true);
}

export function setRemember(on: boolean, email?: string) {
  safe(() => {
    localStorage.setItem(FLAG, on ? '1' : '0');
    if (on && email) localStorage.setItem(EMAIL, email);
    if (!on) localStorage.removeItem(EMAIL);
  }, undefined);
}

export function rememberedEmail(): string {
  return safe(() => localStorage.getItem(EMAIL) ?? '', '');
}

/** Storage adapter for the Supabase client. */
export const authStorage = {
  getItem(key: string): string | null {
    return safe(() => localStorage.getItem(key) ?? sessionStorage.getItem(key), null);
  },
  setItem(key: string, value: string) {
    safe(() => {
      if (getRemember()) {
        localStorage.setItem(key, value);
        sessionStorage.removeItem(key);
      } else {
        sessionStorage.setItem(key, value);
        localStorage.removeItem(key);
      }
    }, undefined);
  },
  removeItem(key: string) {
    safe(() => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    }, undefined);
  },
};
