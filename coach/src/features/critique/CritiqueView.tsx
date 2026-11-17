import { TAGS, type Tag } from '../../../supabase/functions/_shared/critique';
import type { Critique } from '../../data/types';
import { usd } from '../../lib/progress';

export function scoreClass(s: number) {
  return s >= 8 ? 'is-good' : s >= 5.5 ? 'is-ok' : 'is-low';
}

export function CritiqueView({ c, editingTips, spend }: { c: Critique; editingTips: boolean; spend?: { spent: number; cap: number } | null }) {
  const r = c.result;
  return (
    <article className="crit">
      <header className="crit-head">
        <div className={`crit-score ${scoreClass(c.score)}`}>
          <b>{formatScore(c.score)}</b>
          <span>/10</span>
        </div>
        <p className="crit-headline">{r.headline}</p>
      </header>

      <div className="subs">
        {(['composition', 'light', 'moment', 'technical'] as const).map((k) => (
          <div className="sub" key={k}>
            <span>{k}</span>
            <div className="bar"><i style={{ width: `${r.subscores[k] * 10}%` }} /></div>
            <b>{r.subscores[k]}</b>
          </div>
        ))}
      </div>

      <Section title="What works" items={r.what_works} kind="good" />
      <Section title="Fix" items={r.fix} kind="fix" />
      <Section title="Angle & composition" items={r.angles} kind="angle" />

      {editingTips && r.editing && (
        <section className="crit-sec">
          <h3>Editing tips</h3>
          <dl className="edit-tips">
            <dt>Crop</dt>
            <dd>{r.editing.crop}</dd>
            <dt>Exposure</dt>
            <dd>{r.editing.exposure}</dd>
            <dt>Color</dt>
            <dd>{r.editing.color}</dd>
          </dl>
        </section>
      )}

      {r.next_shot && (
        <section className="next-shot">
          <h3>Next shot</h3>
          <p>{r.next_shot}</p>
        </section>
      )}

      {r.tags.length > 0 && (
        <section className="crit-sec">
          <h3>Habits to watch</h3>
          <ul className="tag-tips">
            {r.tags.map((t) => (
              <li key={t}>
                <b>{TAGS[t as Tag]?.label ?? t}</b>
                <span>{TAGS[t as Tag]?.tip}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="crit-foot">
        {c.model === 'demo' ? `Demo critique (pretend ${usd(c.cost_usd)})` : c.model === 'claude-app' ? 'Via your Claude app (free)' : `Cost ${usd(c.cost_usd)}`}
        {spend ? ` · ${usd(spend.spent)} of ${usd(spend.cap)} this month` : ''}
        {' · '}
        {new Date(c.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      </footer>
    </article>
  );
}

function Section({ title, items, kind }: { title: string; items: string[]; kind: string }) {
  if (!items.length) return null;
  return (
    <section className={`crit-sec crit-${kind}`}>
      <h3>{title}</h3>
      <ul>
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </section>
  );
}

export const formatScore = (s: number) => (Number.isInteger(s) ? String(s) : s.toFixed(1));
