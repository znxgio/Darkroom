// Small hand-drawn SVG visuals (no chart libraries).

export function Flame({ lit, size = 64 }: { lit: boolean; size?: number }) {
  const id = lit ? 'flame-hot' : 'flame-cold';
  return (
    <svg className={`flame${lit ? ' lit' : ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="1" x2="0" y2="0">
          {lit ? (
            <>
              <stop offset="0" stopColor="#ff4d2e" />
              <stop offset="0.55" stopColor="#ff8a1f" />
              <stop offset="1" stopColor="#ffc93c" />
            </>
          ) : (
            <>
              <stop offset="0" stopColor="#3a3f4b" />
              <stop offset="1" stopColor="#4a5160" />
            </>
          )}
        </linearGradient>
      </defs>
      <path
        fill={`url(#${id})`}
        d="M12.6 1.6c.5 3.3 2.9 5.2 4.5 7.6 1.2 1.8 1.9 3.6 1.9 5.5A7 7 0 0 1 12 21.7a7 7 0 0 1-7-7c0-2.9 1.5-5 3.1-6.6.1 1.7.8 3 2.1 3.8-.5-4 .8-7.3 2.4-10.3z"
      />
      <path
        fill={lit ? '#fff3c4' : '#5a6070'}
        opacity={lit ? 0.92 : 0.6}
        d="M12.3 11.6c.5 1.9 2.8 3.1 2.8 5.4a3.1 3.1 0 0 1-6.2 0c0-1.6 1-2.8 2-3.6.1.8.5 1.3 1 1.6-.2-1.2.2-2.4.4-3.4z"
      />
    </svg>
  );
}

/** Progress ring; pct null = no data. */
export function Ring({ pct, size = 88, stroke = 9, label }: { pct: number | null; size?: number; stroke?: number; label?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = pct ?? 0;
  const tone = pct === null ? 'none' : p >= 80 ? 'good' : p >= 50 ? 'mid' : 'low';
  return (
    <div className={`ring ${tone}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        {p > 0 && (
          <circle
            className="ring-fill"
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${(c * p) / 100} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="ring-label">
        {pct === null ? '—' : `${pct}%`}
        {label && <small>{label}</small>}
      </span>
    </div>
  );
}
