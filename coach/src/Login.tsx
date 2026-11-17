import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

// Email + password (not a magic link): on iPhone a magic link opens Safari,
// not the Home Screen app, which keeps its own separate login.
export function Login({ supabase }: { supabase: SupabaseClient }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
  }

  return (
    <form className="login" onSubmit={submit}>
      <div className="login-mark" aria-hidden="true">
        <svg viewBox="0 0 48 48" width="56" height="56" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="24" cy="24" r="18" />
          <circle cx="24" cy="24" r="7" />
          <path d="M24 6l6 11M42 24H29.5M33 39l-6-11M15 39l6-11M6 24h12.5M15 9l6 11" />
        </svg>
      </div>
      <h1>Darkroom</h1>
      <p>Your photo coach</p>
      <label className="field">
        <span>Email</span>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="btn btn-primary btn-wide" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
