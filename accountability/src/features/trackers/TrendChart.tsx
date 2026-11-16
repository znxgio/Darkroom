// Plain inline-SVG trend chart: daily dots + smooth 7-day average line.
// Drag (or tap) across it to read a day's value.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addDays, prettyDay, type Day } from '../../lib/dates';
import { dayDiff, monotonePath, niceTicks, shortDate, type Point } from './stats';

interface Props {
  points: Point[];
  avg: Point[];
  /** Last day on the x axis (normally today). */
  end: Day;
  /** First day on the x axis (default: first point). */
  start?: Day | null;
  decimals: number;
  unit?: string;
}

const H = 210;
const M = { top: 14, right: 44, bottom: 26, left: 6 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(358);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.max(200, Math.round(el.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export default function TrendChart({ points, avg, end, start, decimals, unit }: Props) {
  const [wrapRef, W] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const gradId = useId().replace(/:/g, '');

  // Clear the readout when the data changes (e.g. another range).
  useEffect(() => setActive(null), [points]);

  const geo = useMemo(() => {
    if (!points.length) return null;
    let x0 = start && start < points[0].day ? start : points[0].day;
    let x1 = end > points[points.length - 1].day ? end : points[points.length - 1].day;
    if (x0 === x1) {
      x0 = addDays(x0, -3);
      x1 = addDays(x1, 3);
    }
    const span = dayDiff(x0, x1);
    const vals = [...points.map((p) => p.v), ...avg.map((p) => p.v)];
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.12, 0.5);
    const yt = niceTicks(lo - pad, hi + pad, 4);
    lo = yt[0];
    hi = yt[yt.length - 1];
    const iw = W - M.left - M.right;
    const ih = H - M.top - M.bottom;
    const x = (d: Day) => M.left + (dayDiff(x0, d) / span) * iw;
    const y = (v: number) => M.top + (1 - (v - lo) / (hi - lo)) * ih;

    // ~4 evenly spaced x labels; month names on long spans.
    const n = W < 340 ? 3 : 4;
    const longSpan = span > 120;
    const multiYear = x0.slice(0, 4) !== x1.slice(0, 4);
    const xt = Array.from({ length: n }, (_, i) => {
      const d = addDays(x0, Math.round((span * i) / (n - 1)));
      const label = longSpan
        ? MONTHS[Number(d.slice(5, 7)) - 1] + (multiYear ? ` ’${d.slice(2, 4)}` : '')
        : shortDate(d);
      return { d, label, x: x(d), anchor: (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') as 'start' | 'end' | 'middle' };
    });

    const avgXY = avg.map((p) => [x(p.day), y(p.v)] as [number, number]);
    const line = monotonePath(avgXY);
    const area = avgXY.length > 1 ? `${line}L${avgXY[avgXY.length - 1][0]},${M.top + ih}L${avgXY[0][0]},${M.top + ih}Z` : '';
    const daily = points.length > 1 ? 'M' + points.map((p) => `${x(p.day).toFixed(1)},${y(p.v).toFixed(1)}`).join('L') : '';
    return { x, y, yt, xt, line, area, daily, ih, iw };
  }, [points, avg, start, end, W]);

  function pick(clientX: number, el: SVGSVGElement) {
    if (!geo) return;
    const r = el.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    let best = 0;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(geo.x(p.day) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setActive(best);
  }

  const fmt = (v: number) => v.toFixed(decimals);
  const sel = active !== null ? points[active] : null;
  const selAvg = sel ? avg.find((a) => a.day === sel.day) : undefined;
  const dotR = points.length > 120 ? 1.6 : points.length > 45 ? 2.2 : 3;

  return (
    <div className="trend">
      <div className="trend-readout" aria-live="polite" data-testid="chart-readout">
        {sel ? (
          <>
            <span className="trend-readout-day">{prettyDay(sel.day)}</span>
            <span className="trend-readout-val">
              {fmt(sel.v)}
              {unit && <small> {unit}</small>}
            </span>
            {selAvg && <span className="trend-readout-avg">avg {fmt(selAvg.v)}</span>}
          </>
        ) : (
          <>
            <span className="legend">
              <i className="legend-dot" /> Daily
            </span>
            <span className="legend">
              <i className="legend-line" /> 7-day average
            </span>
            <span className="legend-hint">Drag to see values</span>
          </>
        )}
      </div>
      <div className="trend-plot" ref={wrapRef}>
      {geo ? (
        <svg
          className="trend-svg"
          data-testid="trend-chart"
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="Trend chart"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            pick(e.clientX, e.currentTarget);
          }}
          onPointerMove={(e) => {
            if (e.buttons || e.pointerType === 'mouse') pick(e.clientX, e.currentTarget);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') setActive(null);
          }}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: 'var(--accent, #f47521)', stopOpacity: 0.26 }} />
              <stop offset="100%" style={{ stopColor: 'var(--accent, #f47521)', stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {geo.yt.map((t) => (
            <g key={t}>
              <line
                className="grid"
                x1={M.left}
                x2={W - M.right + 6}
                y1={geo.y(t)}
                y2={geo.y(t)}
              />
              <text className="axis" x={W - 2} y={geo.y(t) + 4} textAnchor="end">
                {Number.isInteger(t) ? t : t.toFixed(1)}
              </text>
            </g>
          ))}
          {geo.xt.map((t) => (
            <text key={t.d + t.anchor} className="axis" x={t.x} y={H - 6} textAnchor={t.anchor}>
              {t.label}
            </text>
          ))}
          {geo.area && <path d={geo.area} fill={`url(#${gradId})`} />}
          {geo.daily && <path className="daily-line" d={geo.daily} />}
          {points.map((p) => (
            <circle key={p.day} className="pt" cx={geo.x(p.day)} cy={geo.y(p.v)} r={dotR} />
          ))}
          {geo.line && avg.length > 1 && <path className="avg-line" d={geo.line} />}
          {sel && (
            <g>
              <line
                className="guide"
                x1={geo.x(sel.day)}
                x2={geo.x(sel.day)}
                y1={M.top - 6}
                y2={M.top + geo.ih}
              />
              <circle className="pt-active" cx={geo.x(sel.day)} cy={geo.y(sel.v)} r={5.5} />
            </g>
          )}
        </svg>
      ) : (
        <div className="trend-empty" style={{ height: H }}>
          No entries in this range yet
        </div>
      )}
      </div>
    </div>
  );
}
