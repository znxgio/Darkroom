import type { PhotoWithCritiques } from '../../data/types';
import { progressStats } from '../../lib/progress';
import { formatScore, scoreClass } from '../critique/CritiqueView';

export function ProgressScreen({ photos, onOpen }: { photos: PhotoWithCritiques[]; onOpen: (id: string) => void }) {
  const s = progressStats(photos);
  const focus = s.habits[0];
  return (
    <div className="screen">
      <h1>Progress</h1>
      <div className="stats">
        <Stat label="Avg score" value={s.avg != null ? formatScore(s.avg) : '–'} cls={s.avg != null ? scoreClass(s.avg) : ''} />
        <Stat
          label="Trend"
          value={s.trend == null ? '–' : `${s.trend > 0 ? '▲' : s.trend < 0 ? '▼' : '•'} ${Math.abs(s.trend).toFixed(1)}`}
          cls={s.trend == null ? '' : s.trend > 0 ? 'is-good' : s.trend < 0 ? 'is-low' : ''}
        />
        <Stat label="Critiques" value={String(s.count)} />
        <Stat label="Day streak" value={String(s.streak)} />
      </div>

      {s.series.length >= 2 && <Spark series={s.series} />}

      {focus ? (
        <div className="focus">
          <small>This week’s focus</small>
          <strong>{focus.label}</strong>
          <p>{focus.tip}</p>
        </div>
      ) : (
        <div className="empty">
          <strong>Nothing to track yet</strong>
          <span>Get a few critiques and this page will show your scores over time and the habits to work on.</span>
        </div>
      )}

      {s.sub && (
        <>
          <h2>Skills (last 20)</h2>
          <div className="subs">
            {(['composition', 'light', 'moment', 'technical'] as const).map((k) => (
              <div className="sub" key={k}>
                <span>{k}</span>
                <div className="bar"><i style={{ width: `${s.sub![k] * 10}%` }} /></div>
                <b>{s.sub![k].toFixed(1)}</b>
              </div>
            ))}
          </div>
        </>
      )}

      {s.habits.length > 0 && (
        <>
          <h2>Recurring habits</h2>
          <ul className="habits">
            {s.habits.map((h) => (
              <li key={h.tag}>
                <div>
                  <b>{h.label}</b>
                  <span>{h.tip}</span>
                </div>
                <em>
                  {h.count}×{!h.recent && <small> fading</small>}
                </em>
              </li>
            ))}
          </ul>
        </>
      )}

      {s.improved.length > 0 && (
        <>
          <h2>Fixed lately</h2>
          <p className="improved">{s.improved.map((x) => x.label).join(' · ')}</p>
        </>
      )}

      {s.best && (
        <>
          <h2>Best shot</h2>
          <button className="best" onClick={() => onOpen(s.best!.id)}>
            <img src={s.best.thumb} alt="Your best-scoring photo" />
            <span className={`badge ${scoreClass(s.best.critiques[0].score)}`}>{formatScore(s.best.critiques[0].score)}</span>
          </button>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return (
    <div className="stat">
      <b className={cls}>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function Spark({ series }: { series: { at: string; score: number }[] }) {
  const pts = series.slice(-40);
  const W = 320;
  const H = 90;
  const x = (i: number) => (pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * (W - 12) + 6);
  const y = (s: number) => H - 6 - ((s - 1) / 9) * (H - 12);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
  return (
    <figure className="spark" aria-label={`Score over your last ${pts.length} critiques`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        {[2.5, 5, 7.5].map((g) => (
          <line key={g} x1="0" x2={W} y1={y(g + 1)} y2={y(g + 1)} className="spark-grid" />
        ))}
        <path d={d} className="spark-line" />
        {pts.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.score)} r={i === pts.length - 1 ? 3.5 : 2} className="spark-dot" />
        ))}
      </svg>
      <figcaption>Score per critique, oldest → newest</figcaption>
    </figure>
  );
}
