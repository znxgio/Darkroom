import { useCallback, useEffect, useState } from 'react';
import type { Backend } from '../../data/backend';
import { Segmented, errMsg } from '../../screens/ui';
import {
  disablePush,
  enablePush,
  pushStatus,
  sendStakesPreview,
  sendTestPush,
  type PushStatus,
} from '../reminders/push';
import { photoAccessLog, settingsApi, type PhotoAccess, type Settings, type SettingsPatch } from './api';

interface Props {
  backend: Backend;
  onToast: (msg: string) => void;
  onSignOut?: () => void;
}

const PUSH_TEXT: Record<PushStatus, string> = {
  unsupported: "This browser can't show reminders.",
  'needs-install': 'Add this app to your Home Screen first (Safari → Share → Add to Home Screen), then open it from the icon.',
  'needs-setup': 'Reminders turn on once the cloud setup is finished.',
  denied: 'Notifications are blocked. iPhone Settings → Notifications → Daily → Allow.',
  off: 'Off on this phone.',
  on: 'On. You get a reminder at each goal time if it isn’t done yet.',
};

export default function SettingsScreen({ backend, onToast, onSignOut }: Props) {
  const api = useState(() => settingsApi(backend))[0];
  const [s, setS] = useState<Settings | null>(null);
  const [push, setPush] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [access, setAccess] = useState<PhotoAccess[]>([]);
  // Stakes text fields are saved together (button), not per keystroke.
  const [draft, setDraft] = useState({ my_name: '', stakes_name: '', stakes_email: '' });

  const load = useCallback(async () => {
    try {
      const v = await api.get();
      setS(v);
      setDraft({ my_name: v.my_name ?? '', stakes_name: v.stakes_name ?? '', stakes_email: v.stakes_email ?? '' });
      setPush(await pushStatus(backend).catch(() => 'unsupported' as const));
      setAccess(await photoAccessLog(backend));
    } catch (e) {
      onToast(`Couldn't load settings: ${errMsg(e)}`);
    }
  }, [api, backend, onToast]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(patch: SettingsPatch, okMsg?: string) {
    if (!s) return;
    const before = s;
    setS({ ...s, ...patch });
    try {
      setS(await api.update(patch));
      if (okMsg) onToast(okMsg);
    } catch (e) {
      setS(before);
      onToast(`Couldn't save: ${errMsg(e)}`);
    }
  }

  async function run(fn: () => Promise<unknown>, okMsg: string) {
    setBusy(true);
    try {
      await fn();
      onToast(okMsg);
    } catch (e) {
      onToast(errMsg(e));
    } finally {
      setBusy(false);
      setPush(await pushStatus(backend).catch(() => 'unsupported' as const));
    }
  }

  if (!s) return <div className="screen"><p className="muted center">Loading…</p></div>;

  const emailOk = !draft.stakes_email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.stakes_email);
  const stakesDirty =
    draft.my_name !== (s.my_name ?? '') ||
    draft.stakes_name !== (s.stakes_name ?? '') ||
    draft.stakes_email !== (s.stakes_email ?? '');

  return (
    <div className="screen settings">
      <header className="header">
        <h1>Settings</h1>
      </header>

      <section className="card-section">
        <h2>Reminders</h2>
        <p className="muted small" data-testid="push-status">{push ? PUSH_TEXT[push] : '…'}</p>
        <div className="btn-row">
          {push === 'off' && (
            <button className="btn primary" disabled={busy} onClick={() => run(() => enablePush(backend), 'Reminders are on')}>
              Turn on reminders
            </button>
          )}
          {push === 'on' && (
            <>
              <button className="btn" disabled={busy} onClick={() => run(() => sendTestPush(backend), 'Test sent — it should arrive in a few seconds')}>
                Send a test
              </button>
              <button className="btn" disabled={busy} onClick={() => run(() => disablePush(backend), 'Reminders are off on this phone')}>
                Turn off
              </button>
            </>
          )}
        </div>
        <label className="time-row">
          <span>
            Daily photos reminder
            <small className="hint">If you haven’t taken them yet</small>
          </span>
          <input
            type="time"
            data-testid="photo-time"
            value={s.photo_reminder_time ?? ''}
            onChange={(e) => save({ photo_reminder_time: e.target.value || null })}
          />
        </label>
        <label className="time-row">
          <span>
            Evening check-in
            <small className="hint">Lists anything still open</small>
          </span>
          <input
            type="time"
            data-testid="nudge-time"
            value={s.nudge_time ?? ''}
            onChange={(e) => save({ nudge_time: e.target.value || null })}
          />
        </label>
      </section>

      <section className={`card-section stakes${s.stakes_enabled ? ' armed' : ''}`}>
        <div className="toggle-row">
          <span>
            <h2>Stakes</h2>
            <small className="hint">
              Miss 2 days in a row and someone you choose gets an email.
            </small>
          </span>
          <input
            type="checkbox"
            className="switch"
            data-testid="stakes-toggle"
            checked={s.stakes_enabled}
            disabled={!s.stakes_email && !s.stakes_enabled}
            onChange={(e) => {
              const on = e.target.checked;
              if (on && !window.confirm(`Turn on Stakes? If you miss 2 days in a row, ${s.stakes_name || s.stakes_email} gets an email. Only days from today on count.`)) return;
              save({ stakes_enabled: on }, on ? 'Stakes are on. No pressure. 😅' : 'Stakes are off');
            }}
          />
        </div>
        {!s.stakes_email && <p className="muted small">Add who to tell first, then you can switch it on.</p>}

        <label className="field">
          <span>Your name (used in the email)</span>
          <input value={draft.my_name} maxLength={80} placeholder="e.g. Alex" onChange={(e) => setDraft({ ...draft, my_name: e.target.value })} />
        </label>
        <label className="field">
          <span>Who to tell</span>
          <input value={draft.stakes_name} maxLength={80} placeholder="Their name" onChange={(e) => setDraft({ ...draft, stakes_name: e.target.value })} />
        </label>
        <label className="field">
          <span>Their email</span>
          <input
            type="email"
            inputMode="email"
            autoCapitalize="off"
            data-testid="stakes-email"
            value={draft.stakes_email}
            placeholder="friend@example.com"
            onChange={(e) => setDraft({ ...draft, stakes_email: e.target.value.trim() })}
          />
        </label>
        {!emailOk && <p className="error">That email doesn’t look right.</p>}
        {stakesDirty && (
          <button
            className="btn primary"
            data-testid="stakes-save"
            disabled={!emailOk}
            onClick={() =>
              save(
                {
                  my_name: draft.my_name.trim() || null,
                  stakes_name: draft.stakes_name.trim() || null,
                  stakes_email: draft.stakes_email || null,
                  ...(draft.stakes_email ? {} : { stakes_enabled: false }),
                },
                'Saved',
              )
            }
          >
            Save
          </button>
        )}

        <div className="field">
          <span>What counts as a miss</span>
          <Segmented
            options={[
              { value: 'critical', label: 'Critical only', testid: 'scope-critical' },
              { value: 'any', label: 'Any task', testid: 'scope-any' },
            ]}
            value={s.stakes_scope}
            onChange={(v) => save({ stakes_scope: v })}
          />
          <small className="hint">Daily photos always count. Mark tasks critical in the Tasks tab.</small>
        </div>
        <p className="muted small">Channel: email. (Text messages would cost money; ask first.)</p>
        {backend.supabase && s.stakes_email && (
          <button className="link-btn" disabled={busy} onClick={() => run(() => sendStakesPreview(backend), 'Preview sent to your own email')}>
            Email me a preview of what they’d get
          </button>
        )}
      </section>

      <section className="card-section">
        <div className="toggle-row">
          <span>
            <h2>Let Claude view my photos</h2>
            <small className="hint">
              Instead of sending photos in chat, a Claude session can look at your dated daily photos (read-only, with a
              private key). Off by default; switch off any time.
            </small>
          </span>
          <input
            type="checkbox"
            className="switch"
            data-testid="claude-access"
            checked={s.claude_photo_access}
            onChange={(e) => save({ claude_photo_access: e.target.checked }, e.target.checked ? 'Claude can view your photos' : 'Photo access is off')}
          />
        </div>
        {access.length > 0 ? (
          <ul className="access-log">
            {access.map((a) => (
              <li key={a.at}>
                {new Date(a.at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                {' · '}
                {a.photo_count} photos{a.from_day ? ` (${a.from_day}${a.to_day && a.to_day !== a.from_day ? ` → ${a.to_day}` : ''})` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Claude hasn’t viewed any photos yet.</p>
        )}
      </section>

      <section className="card-section">
        <h2>Account</h2>
        {backend.supabase ? (
          <p className="muted small">Your data is private to your login.</p>
        ) : (
          <p className="muted small">Demo mode: data stays in this browser only.</p>
        )}
        {onSignOut && (
          <button className="btn" onClick={onSignOut}>
            Sign out
          </button>
        )}
      </section>
    </div>
  );
}
