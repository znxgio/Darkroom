import { useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getRemember, rememberedEmail, setRemember } from '../data/authStorage';

export default function Login({ supabase }: { supabase: SupabaseClient }) {
  const [email, setEmail] = useState(rememberedEmail);
  const [remember, setRem] = useState(getRemember);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    setRemember(remember, email.trim());
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(error.message);
  }

  return (
    <div className="login">
      <img className="login-logo" src="/icons/icon-192.png" alt="" width="72" height="72" />
      <h1>Daily</h1>
      <p className="muted login-tag">Show up. Every day.</p>
      <form onSubmit={submit} className="form">
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <label className="remember-row">
          <input
            type="checkbox"
            className="switch"
            data-testid="remember-me"
            checked={remember}
            onChange={(e) => setRem(e.target.checked)}
          />
          <span>
            Remember me
            <small className="hint">{remember ? 'Stay signed in on this phone' : 'Sign out when the app is closed'}</small>
          </span>
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn primary big" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
