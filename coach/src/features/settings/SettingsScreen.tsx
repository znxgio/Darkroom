import { useEffect, useState } from 'react';
import type { Repo, Settings, Spend } from '../../data/types';
import { usd } from '../../lib/progress';

interface Props {
  repo: Repo;
  settings: Settings;
  onChange: (s: Settings) => void;
  onSignOut: (() => void) | null;
  refreshKey: number;
}

export function SettingsScreen({ repo, settings, onChange, onSignOut, refreshKey }: Props) {
  const [spend, setSpend] = useState<Spend | null>(null);
  const [cap, setCap] = useState(String(settings.monthly_cap_usd));
  useEffect(() => {
    repo.spend().then(setSpend).catch(() => setSpend(null));
  }, [repo, refreshKey, settings.monthly_cap_usd]);
  useEffect(() => setCap(String(settings.monthly_cap_usd)), [settings.monthly_cap_usd]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });
  const commitCap = () => {
    const v = Math.round(Number(cap) * 100) / 100;
    if (Number.isFinite(v) && v >= 0 && v <= 500) set('monthly_cap_usd', v);
    else setCap(String(settings.monthly_cap_usd));
  };
  const pct = spend && spend.cap_usd > 0 ? Math.min(100, (spend.month_usd / spend.cap_usd) * 100) : 0;

  return (
    <div className="screen">
      <h1>Settings</h1>
      {repo.mode === 'demo' && (
        <div className="tipcard">
          <b>Demo mode</b>
          <span>Nothing is connected yet: data stays in this browser and critiques are free samples.</span>
        </div>
      )}

      <section className="group">
        <h2>Modes</h2>
        <Toggle label="Live coaching" sub="Real-time tips and score in the camera" on={settings.live_coaching} onChange={(v) => set('live_coaching', v)} />
        <Toggle label="AI critique" sub="Feedback on photos after you shoot" on={settings.ai_critique} onChange={(v) => set('ai_critique', v)} />
        <Toggle label="Editing tips" sub="Crop, exposure and color suggestions" on={settings.editing_tips} onChange={(v) => set('editing_tips', v)} disabled={!settings.ai_critique} />
        <div className="setting">
          <div>
            <b>Critique depth</b>
            <small>Thorough thinks longer: better detail, about 2× the cost</small>
          </div>
          <div className="seg" role="group" aria-label="Critique depth">
            <button className={settings.depth === 'quick' ? 'is-on' : ''} aria-pressed={settings.depth === 'quick'} onClick={() => set('depth', 'quick')}>Quick</button>
            <button className={settings.depth === 'thorough' ? 'is-on' : ''} aria-pressed={settings.depth === 'thorough'} onClick={() => set('depth', 'thorough')}>Thorough</button>
          </div>
        </div>
      </section>

      <section className="group">
        <h2>Camera guides</h2>
        <Toggle label="Rule-of-thirds grid" on={settings.overlays.grid} onChange={(v) => set('overlays', { ...settings.overlays, grid: v })} />
        <Toggle label="Level line" sub="Uses the tilt sensor" on={settings.overlays.level} onChange={(v) => set('overlays', { ...settings.overlays, level: v })} />
        <Toggle label="Center / symmetry guide" on={settings.overlays.center} onChange={(v) => set('overlays', { ...settings.overlays, center: v })} />
      </section>

      <section className="group">
        <h2>Spending</h2>
        <div className="spend">
          <div className="spend-top">
            <b>{spend ? usd(spend.month_usd) : '…'}</b>
            <span>of {usd(settings.monthly_cap_usd)} this month{spend ? ` · ${spend.count_month} critique${spend.count_month === 1 ? '' : 's'}` : ''}</span>
          </div>
          <div className={`meter${pct >= 90 ? ' is-hot' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Spent this month">
            <i style={{ width: `${pct}%` }} />
          </div>
          {spend && <small>All time {usd(spend.all_usd)} · resets on the 1st (LA time)</small>}
        </div>
        <label className="setting">
          <div>
            <b>Monthly cap</b>
            <small>Critiques stop when the next one could go over</small>
          </div>
          <span className="money">
            $
            <input
              inputMode="decimal"
              value={cap}
              onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ''))}
              onBlur={commitCap}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              aria-label="Monthly cap in dollars"
            />
          </span>
        </label>
      </section>

      <section className="group">
        <h2>Privacy</h2>
        <p className="fine">
          Full photos stay in your camera roll. The app keeps a small preview (about 360px) and the critique text in your private
          database. For a critique, a 1600px copy is sent to the AI service and not stored by this app. Location data is never read.
        </p>
      </section>

      {onSignOut && (
        <button className="btn btn-wide" onClick={onSignOut}>
          Sign out
        </button>
      )}
    </div>
  );
}

function Toggle({ label, sub, on, onChange, disabled }: { label: string; sub?: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`setting${disabled ? ' is-disabled' : ''}`}>
      <div>
        <b>{label}</b>
        {sub && <small>{sub}</small>}
      </div>
      <input type="checkbox" role="switch" className="switch" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
