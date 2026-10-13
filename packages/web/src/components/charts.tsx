import { useEffect, useRef, useState } from 'react';

/** Width of an element, kept in sync with ResizeObserver, so charts draw at real pixel size (11px labels stay 11px). */
function useWidth<T extends HTMLElement>(fallback: number): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(Math.max(260, Math.round(el.getBoundingClientRect().width)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * Single-series column chart (magnitude by category): one hue, thin columns with 4px rounded tops,
 * hairline gridlines, hover/focus tooltip per column. Values are also listed in the table view.
 */
export function ColumnChart({
  data,
  format,
  ariaLabel,
  height = 220,
}: {
  data: { label: string; value: number; detail?: string }[];
  format: (v: number) => string;
  ariaLabel: string;
  height?: number;
}) {
  const [wrap, width] = useWidth<HTMLDivElement>(560);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const pad = { top: 16, right: 8, bottom: 26, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(0.05, ...data.map((d) => d.value));
  const niceMax = niceCeil(max);
  const ticks = [0, niceMax / 2, niceMax];
  const band = innerW / Math.max(1, data.length);
  const barW = Math.min(24, band * 0.6);
  const y = (v: number) => pad.top + innerH - (v / niceMax) * innerH;
  const peak = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? -1) ? i : best), 0);

  const show = (i: number, target: Element) => {
    const box = wrap.current?.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    if (box) setHover({ i, x: r.left - box.left + r.width / 2, y: r.top - box.top });
  };

  return (
    <div className="chart-wrap" ref={wrap}>
      <svg className="chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
        {ticks.map((tk) => (
          <g key={tk}>
            <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={y(tk)} y2={y(tk)} />
            <text x={pad.left - 6} y={y(tk) + 4} textAnchor="end">
              {format(tk)}
            </text>
          </g>
        ))}
        <line className="axis-line" x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} />
        {data.map((d, i) => {
          const x = pad.left + band * i + (band - barW) / 2;
          const h = Math.max(0, y(0) - y(d.value));
          const r = Math.min(4, h);
          return (
            <g key={d.label}>
              {h > 0 && (
                <path
                  className={`bar ${hover?.i === i ? 'active' : ''}`}
                  d={`M${x},${y(0)} V${y(d.value) + r} Q${x},${y(d.value)} ${x + r},${y(d.value)} H${x + barW - r} Q${x + barW},${y(d.value)} ${x + barW},${y(d.value) + r} V${y(0)} Z`}
                />
              )}
              {/* Hit target larger than the mark. */}
              <rect
                x={pad.left + band * i}
                y={pad.top}
                width={band}
                height={innerH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${d.label}: ${format(d.value)}`}
                onPointerMove={(e) => show(i, e.currentTarget)}
                onPointerLeave={() => setHover(null)}
                onFocus={(e) => show(i, e.currentTarget)}
                onBlur={() => setHover(null)}
              />
              <text x={pad.left + band * i + band / 2} y={height - 8} textAnchor="middle">
                {d.label}
              </text>
              {i === peak && d.value > 0 && (
                <text className="value-label" x={pad.left + band * i + band / 2} y={y(d.value) - 6} textAnchor="middle">
                  {format(d.value)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && data[hover.i] && (
        <div className="chart-tooltip" style={{ left: hover.x, top: hover.y, transform: 'translate(-50%, -110%)' }}>
          <strong>{format(data[hover.i]!.value)}</strong>
          {data[hover.i]!.label}
          {data[hover.i]!.detail ? ` · ${data[hover.i]!.detail}` : ''}
        </div>
      )}
    </div>
  );
}

/** Horizontal bars (magnitude per resource), value at the tip, sorted by the caller. */
export function HBarList({ rows, format, max }: { rows: { label: string; value: number; title?: string }[]; format: (v: number) => string; max?: number }) {
  const top = max ?? Math.max(0.01, ...rows.map((r) => r.value));
  return (
    <div>
      {rows.map((r) => (
        <div key={r.label} className="hbar-row" title={r.title}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
          <div className="hbar-track" aria-hidden="true">
            {r.value > 0 && <div className="hbar-fill" style={{ width: `${(r.value / top) * 100}%` }} />}
          </div>
          <span className="num">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function niceCeil(v: number): number {
  const steps = [0.05, 0.1, 0.2, 0.25, 0.5, 0.75, 1];
  for (const s of steps) if (v <= s) return s;
  const exp = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / exp) * exp;
}
