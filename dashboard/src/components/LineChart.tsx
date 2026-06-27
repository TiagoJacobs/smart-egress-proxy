import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Shared, hand-rolled multi-line SVG renderer used by BOTH the overall history
 * chart and the per-URL chart cards. Keeping the axis/scale/hover math in one
 * place is the whole point: the wrappers only have to shape their data into
 * `LineSeries[]` and pick a color per series (see `colorFor`).
 */

/**
 * Stable 8-hue palette shared by lines, legend and tooltip. Deliberately NOT
 * --ok/--bad so series hue never collides with the health semantics elsewhere.
 */
export const PALETTE = [
  "#60a5fa",
  "#f59e0b",
  "#a78bfa",
  "#34d399",
  "#f472b6",
  "#22d3ee",
  "#fb923c",
  "#c084fc",
] as const;

/** Stable per-series color, indexed by the egress' position in status.egresses. */
export const colorFor = (i: number): string =>
  PALETTE[i % PALETTE.length] as string;

/** One sample of a single series at a single cycle. */
export interface LinePoint {
  /** ISO timestamp for this cycle. */
  t: string;
  /** The plotted value (ms), or null when the series had no sample. */
  value: number | null;
  /** Health flag for this sample (filled vs hollow marker). */
  ok: boolean;
}

/** A single line: one egress' values over the recent cycles. */
export interface LineSeries {
  id: string;
  name: string;
  color: string;
  active: boolean;
  points: LinePoint[];
}

interface LineChartProps {
  series: LineSeries[];
  /** SVG height in px (default 260; pass smaller for compact cards). */
  height?: number;
  /** Tighter margins/labels/legend for the per-URL cards. */
  compact?: boolean;
  /** Unit suffix shown in tooltip/legend/markers (default "ms"). */
  unit?: string;
  ariaLabel?: string;
  /** Overlay shown when there are zero cycles. */
  emptyText?: string;
  /** Overlay shown when there is exactly one cycle (no trend yet). */
  onePointText?: string;
}

/** Round up to a "nice" axis ceiling (1/2/2.5/5/10 × power of ten). */
function niceCeil(v: number): number {
  if (v <= 0) return 100;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * pow;
}

function hhmmss(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

/** The point a series shows at a global column, or null if it has no sample. */
function pointAtCol(series: LineSeries, col: number, N: number): LinePoint | null {
  const offset = N - series.points.length;
  const idx = col - offset;
  return idx >= 0 && idx < series.points.length
    ? (series.points[idx] as LinePoint)
    : null;
}

export function LineChart({
  series,
  height = 260,
  compact = false,
  unit = "ms",
  ariaLabel = "Response time over recent probe cycles",
  emptyText = "Collecting data, run a probe to start charting response times.",
  onePointText = "Collecting data, need at least two cycles to compare trends.",
}: LineChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(720);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const H = height;
  const M = compact
    ? { L: 36, R: 10, T: 8, B: 18 }
    : { L: 48, R: 16, T: 16, B: 28 };
  const fontSize = compact ? 9 : 11;

  // Measure the wrapper so the viewBox width == pixel width (1 unit == 1px),
  // which keeps hover math exact and lines undistorted.
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const update = () => setW(Math.max(320, el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const N = useMemo(
    () => Math.max(0, ...series.map((s) => s.points.length)),
    [series],
  );

  const yMax = useMemo(() => {
    let max = 0;
    for (const s of series) {
      for (const p of s.points) {
        if (p.value !== null && p.value > max) max = p.value;
      }
    }
    return Math.max(100, niceCeil(max * 1.1));
  }, [series]);

  // Representative timestamp per global column (cycles align across egresses).
  const colTime = useMemo(() => {
    const times: (string | undefined)[] = new Array(N).fill(undefined);
    for (const s of series) {
      const offset = N - s.points.length;
      s.points.forEach((p, j) => {
        times[offset + j] = p.t;
      });
    }
    return times;
  }, [series, N]);

  const plotW = w - M.L - M.R;
  const plotH = H - M.T - M.B;
  const x = (col: number): number =>
    N > 1 ? M.L + (col / (N - 1)) * plotW : M.L + plotW;
  const y = (v: number): number => M.T + (1 - v / yMax) * plotH;

  const yFracs = compact ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const yTicks = yFracs.map((f) => Math.round(yMax * f));

  // First/middle/last (or first/last when compact) x-axis time labels.
  const xLabelCols = (
    compact ? [0, N - 1] : [0, Math.floor((N - 1) / 2), N - 1]
  ).filter((c, i, a) => a.indexOf(c) === i);

  function handleMove(e: React.MouseEvent<HTMLDivElement>): void {
    if (N < 1) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const ratio = plotW > 0 ? (px - M.L) / plotW : 0;
    const idx = Math.max(0, Math.min(N - 1, Math.round(ratio * (N - 1))));
    setHoverIdx(idx);
  }

  // Draw active series last so it sits on top.
  const drawOrder = useMemo(
    () => [...series].sort((a, b) => Number(a.active) - Number(b.active)),
    [series],
  );

  const hasData = N >= 1;
  const tooltipLeft =
    hoverIdx !== null ? Math.max(64, Math.min(w - 64, x(hoverIdx))) : 0;

  return (
    <div
      className={`chart ${compact ? "chart--compact" : ""}`}
      ref={wrapRef}
      onMouseMove={handleMove}
      onMouseLeave={() => setHoverIdx(null)}
    >
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${w} ${H}`}
        role="img"
        aria-label={ariaLabel}
      >
        {/* horizontal gridlines + y labels */}
        {yTicks.map((v, i) => (
          <g key={`grid-${i}`}>
            <line
              x1={M.L}
              x2={w - M.R}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--border)"
              strokeWidth={i === 0 ? 1.4 : 1}
            />
            <text
              x={M.L - 8}
              y={y(v) + 3}
              textAnchor="end"
              fill="var(--muted)"
              fontSize={fontSize}
            >
              {v}
            </text>
          </g>
        ))}

        {/* x time labels */}
        {N >= 2
          ? xLabelCols.map((col) => {
              const t = colTime[col];
              if (t === undefined) return null;
              const anchor =
                col === 0 ? "start" : col === N - 1 ? "end" : "middle";
              return (
                <text
                  key={`xl-${col}`}
                  x={x(col)}
                  y={H - (compact ? 5 : 8)}
                  textAnchor={anchor}
                  fill="var(--muted)"
                  fontSize={fontSize}
                >
                  {hhmmss(t)}
                </text>
              );
            })
          : null}

        {/* crosshair */}
        {hoverIdx !== null && N >= 1 ? (
          <line
            x1={x(hoverIdx)}
            x2={x(hoverIdx)}
            y1={M.T}
            y2={H - M.B}
            stroke="var(--muted)"
            strokeDasharray="3 3"
          />
        ) : null}

        {/* lines + circles, active drawn last */}
        {hasData
          ? drawOrder.map((s) => {
              const offset = N - s.points.length;
              // contiguous non-null runs -> one polyline each (true gaps).
              const runs: { col: number; v: number }[][] = [];
              let cur: { col: number; v: number }[] = [];
              s.points.forEach((p, j) => {
                if (p.value !== null) cur.push({ col: offset + j, v: p.value });
                else if (cur.length > 0) {
                  runs.push(cur);
                  cur = [];
                }
              });
              if (cur.length > 0) runs.push(cur);

              return (
                <g key={`series-${s.id}`}>
                  {runs.map((run, ri) =>
                    run.length >= 2 ? (
                      <polyline
                        key={`run-${ri}`}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={s.active ? 2.5 : 1.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={s.active ? 1 : 0.85}
                        points={run
                          .map((pt) => `${x(pt.col)},${y(pt.v)}`)
                          .join(" ")}
                      />
                    ) : null,
                  )}
                  {s.points.map((p, j) => {
                    if (p.value === null) return null;
                    const col = offset + j;
                    const big = hoverIdx === col;
                    return (
                      <circle
                        key={`c-${j}`}
                        cx={x(col)}
                        cy={y(p.value)}
                        r={big ? 4 : compact ? 2 : 2.5}
                        fill={p.ok ? s.color : "var(--bg-elev)"}
                        stroke={p.ok ? "none" : s.color}
                        strokeWidth={p.ok ? 0 : 1.5}
                      >
                        <title>
                          {s.name}, {p.value} {unit} @ {hhmmss(p.t)}
                        </title>
                      </circle>
                    );
                  })}
                </g>
              );
            })
          : null}
      </svg>

      {/* empty / collecting-data overlays */}
      {N === 0 ? <div className="chart__empty">{emptyText}</div> : null}
      {N === 1 ? <div className="chart__empty">{onePointText}</div> : null}

      {/* hover tooltip */}
      {hoverIdx !== null && N >= 1 ? (
        <div className="chart-tooltip" style={{ left: `${tooltipLeft}px` }}>
          <div className="chart-tooltip__time muted">
            {colTime[hoverIdx] !== undefined
              ? hhmmss(colTime[hoverIdx] as string)
              : "-"}
          </div>
          {series.map((s) => {
            const p = pointAtCol(s, hoverIdx, N);
            return (
              <div key={s.id} className="chart-tooltip__row">
                <span
                  className="chart-tooltip__dot"
                  style={{ background: s.color }}
                />
                <span>{s.name}</span>
                <span className="muted">
                  {p?.value ?? "-"} {unit}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* legend */}
      <div className={`chart-legend ${compact ? "chart-legend--compact" : ""}`}>
        {series.map((s) => {
          const latest =
            s.points.length > 0
              ? (s.points[s.points.length - 1] as LinePoint).value
              : null;
          return (
            <span
              key={s.id}
              className={`chart-legend__item ${s.active ? "is-active" : ""}`}
              style={s.points.length === 0 ? { opacity: 0.45 } : undefined}
            >
              <span
                className="chart-legend__swatch"
                style={{ background: s.color }}
              />
              {s.name} · {latest ?? "-"} {unit}
            </span>
          );
        })}
      </div>
    </div>
  );
}
