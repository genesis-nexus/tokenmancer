/**
 * TrendChart - Tabbed area chart for the daily trend series.
 *
 * One measure at a time on a single zero-based axis. The dashed companion line is
 * a 7-day moving average of the *same* measure, so it shares the axis by
 * construction — never a second scale.
 */

import type { TrendDataPoint } from '@cte/core';
import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { fmtCr } from '../../format.js';

type MetricKey =
  | 'sessionCount'
  | 'totalAic'
  | 'totalLoops'
  | 'avgContextFillRate'
  | 'modelSwitches'
  | 'highContextCalls';

interface TabDef {
  key: MetricKey;
  label: string;
  title: string;
  subtitle: string;
  unit: string;
  /** Scales the raw value into what the axis shows (e.g. ratio → percent). */
  scale?: (v: number) => number;
  format: (v: number) => string;
}

const TABS: TabDef[] = [
  {
    key: 'sessionCount',
    label: 'Sessions',
    title: 'Sessions started',
    subtitle: 'New chat sessions per day',
    unit: '',
    format: (v) => v.toFixed(v % 1 === 0 ? 0 : 1),
  },
  {
    key: 'totalAic',
    label: 'Cost',
    title: 'Credits spent',
    subtitle: 'AI-Credits burned per day',
    unit: 'cr',
    format: (v) => fmtCr(v),
  },
  {
    key: 'totalLoops',
    label: 'Loops',
    title: 'Prompt loops',
    subtitle: 'Agent loops run per day',
    unit: '',
    format: (v) => v.toFixed(v % 1 === 0 ? 0 : 1),
  },
  {
    key: 'avgContextFillRate',
    label: 'Cache Reuse',
    title: 'Cache reuse rate',
    subtitle: 'Share of input served from cache',
    unit: '%',
    scale: (v) => v * 100,
    format: (v) => v.toFixed(0),
  },
  {
    key: 'modelSwitches',
    label: 'Model Switches',
    title: 'Mid-session model switches',
    subtitle: 'Times the model changed inside a session',
    unit: '',
    format: (v) => v.toFixed(v % 1 === 0 ? 0 : 1),
  },
  {
    key: 'highContextCalls',
    label: 'Context Pressure',
    title: 'Calls over 80% context',
    subtitle: 'Calls that ran near the window limit',
    unit: '',
    format: (v) => v.toFixed(v % 1 === 0 ? 0 : 1),
  },
];

// Plot geometry, in viewBox units. Left margin holds the y-axis ticks.
const VB_W = 760;
const VB_H = 260;
const M = { top: 18, right: 18, bottom: 30, left: 48 };
const PLOT_W = VB_W - M.left - M.right;
const PLOT_H = VB_H - M.top - M.bottom;

const MA_WINDOW = 7;

export interface TrendChartProps {
  data: TrendDataPoint[];
}

export function TrendChart({ data }: TrendChartProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<MetricKey>('sessionCount');
  const [hover, setHover] = useState<number | null>(null);
  const tab = TABS.find((t) => t.key === activeTab) ?? TABS[0]!;

  const tabs = (
    <div class="trend-tabs" role="tablist">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.key === activeTab}
          class={`trend-tab ${t.key === activeTab ? 'active' : ''}`}
          onClick={() => {
            setActiveTab(t.key);
            setHover(null);
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  const model = useMemo(() => buildModel(data, tab), [data, tab]);

  if (!model) {
    return (
      <div class="trend-panel empty">
        {tabs}
        <div class="trend-empty">No data in the selected time window</div>
      </div>
    );
  }

  const { values, avgSeries, points, avgPoints, ticks, yMax, avg, latest } = model;
  const single = points.length === 1;
  const active = hover !== null ? hover : null;

  return (
    <div class="trend-panel">
      {tabs}

      <div class="trend-head">
        <div class="trend-head-text">
          <div class="trend-title">{tab.title}</div>
          <div class="trend-subtitle">{tab.subtitle}</div>
        </div>
        <div class="trend-latest">
          <span class="trend-latest-label">Latest</span>
          <span class="trend-latest-value">
            {tab.format(latest)}
            {tab.unit && <small>{tab.unit}</small>}
          </span>
          <MiniSparkline values={values.slice(-12)} />
        </div>
      </div>

      <div class="trend-plot">
        <svg
          class="trend-svg"
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          role="img"
          aria-label={`${tab.title} over ${data.length} days`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => setHover(nearestIndex(e, points.length))}
        >
          <defs>
            <linearGradient id={`trendFill-${activeTab}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" class="trend-fill-top" />
              <stop offset="100%" class="trend-fill-bottom" />
            </linearGradient>
          </defs>

          {/* Gridlines: solid hairlines, one step off the surface. */}
          {ticks.map((t) => (
            <g key={t.value}>
              <line class="trend-grid" x1={M.left} x2={M.left + PLOT_W} y1={t.y} y2={t.y} />
              <text class="trend-axis-label" x={M.left - 10} y={t.y} dy="0.32em" text-anchor="end">
                {t.label}
              </text>
            </g>
          ))}

          {/* Mean reference line — dotted, because it is a threshold rather than
              a grid. Its value is named in the legend: an inline label here sits
              wherever the data happens to be and collides with the curve. */}
          {avg > 0 && (
            <line
              class="trend-avg-line"
              x1={M.left}
              x2={M.left + PLOT_W}
              y1={yOf(avg, yMax)}
              y2={yOf(avg, yMax)}
            />
          )}

          {!single && (
            <>
              <path d={areaPath(points)} fill={`url(#trendFill-${activeTab})`} />
              <path class="trend-line" d={linePath(points)} />
              {avgPoints.length > 1 && <path class="trend-ma-line" d={linePath(avgPoints)} />}
            </>
          )}

          {/* Endpoint marker always visible; the rest appear on hover. */}
          {points.map((p, i) => (
            <circle
              key={p.x}
              class={`trend-dot ${i === points.length - 1 ? 'is-end' : ''} ${
                i === active ? 'is-active' : ''
              }`}
              cx={p.x}
              cy={p.y}
              r="4.5"
            />
          ))}

          {active !== null && points[active] && (
            <line
              class="trend-crosshair"
              x1={points[active]!.x}
              x2={points[active]!.x}
              y1={M.top}
              y2={M.top + PLOT_H}
            />
          )}

          {/* X-axis: first, middle and last only — dates collide otherwise. */}
          {xLabelIndexes(data.length).map((i) => (
            <text
              key={i}
              class="trend-axis-label"
              x={points[i]?.x ?? M.left}
              y={M.top + PLOT_H + 20}
              text-anchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}
            >
              {shortDate(data[i]?.date)}
            </text>
          ))}
        </svg>

        {active !== null && data[active] && (
          <div
            class="trend-tooltip"
            // The SVG scales to the container width, so viewBox x maps straight
            // onto a percentage of that container.
            style={{ left: `${(points[active]!.x / VB_W) * 100}%` }}
          >
            <div class="tt-date">{longDate(data[active]!.date)}</div>
            <div class="tt-row">
              <span class="tt-key tt-key-primary" />
              <span class="tt-name">{tab.label}</span>
              <span class="tt-val">
                {tab.format(values[active] ?? 0)}
                {tab.unit}
              </span>
            </div>
            {avgSeries[active] !== undefined && (
              <div class="tt-row">
                <span class="tt-key tt-key-ma" />
                <span class="tt-name">{MA_WINDOW}-day avg</span>
                <span class="tt-val">
                  {tab.format(avgSeries[active]!)}
                  {tab.unit}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <div class="trend-legend">
        <span class="legend-item">
          <span class="legend-key legend-key-primary" />
          {tab.label} per day
        </span>
        <span class="legend-item">
          <span class="legend-key legend-key-ma" />
          {MA_WINDOW}-day moving average
        </span>
        {avg > 0 && (
          <span class="legend-item">
            <span class="legend-key legend-key-avg" />
            Period average {tab.format(avg)}
            {tab.unit}
          </span>
        )}
      </div>
    </div>
  );
}

interface Pt {
  x: number;
  y: number;
}

interface ChartModel {
  values: number[];
  avgSeries: number[];
  points: Pt[];
  avgPoints: Pt[];
  ticks: Array<{ value: number; y: number; label: string }>;
  yMax: number;
  avg: number;
  latest: number;
}

function buildModel(data: TrendDataPoint[], tab: TabDef): ChartModel | null {
  if (!data.length) return null;

  const scale = tab.scale ?? ((v: number) => v);
  const values = data.map((d) => scale(d[tab.key]));
  const avgSeries = movingAverage(values, MA_WINDOW);

  const dataMax = Math.max(...values, ...avgSeries);
  const { yMax, ticks } = axisScale(dataMax);
  const step = data.length > 1 ? PLOT_W / (data.length - 1) : 0;
  const toPoint = (v: number, i: number): Pt => ({
    x: data.length > 1 ? M.left + i * step : M.left + PLOT_W / 2,
    y: yOf(v, yMax),
  });

  const sum = values.reduce((a, b) => a + b, 0);

  return {
    values,
    avgSeries,
    points: values.map(toPoint),
    avgPoints: avgSeries.map(toPoint),
    ticks: ticks.map((value) => ({
      value,
      y: yOf(value, yMax),
      label: tickLabel(value),
    })),
    yMax,
    avg: values.length > 0 ? sum / values.length : 0,
    latest: values[values.length - 1] ?? 0,
  };
}

const yOf = (v: number, yMax: number): number =>
  M.top + PLOT_H - (yMax > 0 ? (v / yMax) * PLOT_H : 0);

/** Trailing moving average; the first points average over what exists so far. */
function movingAverage(values: number[], window: number): number[] {
  return values.map((_, i) => {
    const from = Math.max(0, i - window + 1);
    const slice = values.slice(from, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

/**
 * Zero-based axis whose ticks land on 1/2/2.5/5 × 10^n. Rounding the *step*
 * rather than the top is what keeps a max of 5 on 0/2/4/6 instead of the
 * unreadable 0/1.3/2.5/3.8/5 that dividing the top into four gives.
 */
function axisScale(max: number): { yMax: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { yMax: 1, ticks: [0, 1] };

  const step = niceStep(max / 4);
  const count = Math.max(1, Math.ceil(max / step - 1e-9));
  // Multiply rather than accumulate, so the ticks stay exact.
  return {
    yMax: step * count,
    ticks: Array.from({ length: count + 1 }, (_, i) => step * i),
  };
}

function niceStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const n = raw / magnitude;
  const snapped = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return snapped * magnitude;
}

function tickLabel(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  if (v >= 10 || v === 0) return v.toFixed(0);
  return v.toFixed(v % 1 === 0 ? 0 : 1);
}

/**
 * Monotone cubic (Fritsch–Carlson) segments — a smooth line that, unlike a plain
 * cardinal spline, cannot overshoot into negative values between two points.
 */
function linePath(points: Pt[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;

  const n = points.length;
  const dx: number[] = [];
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = points[i + 1]!.x - points[i]!.x;
    dx.push(h);
    slopes.push(h === 0 ? 0 : (points[i + 1]!.y - points[i]!.y) / h);
  }

  const m: number[] = new Array(n).fill(0);
  m[0] = slopes[0] ?? 0;
  m[n - 1] = slopes[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    const s0 = slopes[i - 1]!;
    const s1 = slopes[i]!;
    m[i] = s0 * s1 <= 0 ? 0 : (s0 + s1) / 2;
  }
  // Clamp so each segment stays monotone between its endpoints.
  for (let i = 0; i < n - 1; i++) {
    const s = slopes[i]!;
    if (s === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / s;
    const b = m[i + 1]! / s;
    const t = Math.hypot(a, b);
    if (t > 3) {
      m[i] = (3 / t) * a * s;
      m[i + 1] = (3 / t) * b * s;
    }
  }

  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]!;
    const p0 = points[i]!;
    const p1 = points[i + 1]!;
    d += ` C ${p0.x + h / 3} ${p0.y + (m[i]! * h) / 3}, ${p1.x - h / 3} ${
      p1.y - (m[i + 1]! * h) / 3
    }, ${p1.x} ${p1.y}`;
  }
  return d;
}

function areaPath(points: Pt[]): string {
  if (points.length < 2) return '';
  const base = M.top + PLOT_H;
  return `${linePath(points)} L ${points[points.length - 1]!.x} ${base} L ${points[0]!.x} ${base} Z`;
}

/** Map a pointer position onto the nearest data index. */
function nearestIndex(e: JSX.TargetedMouseEvent<SVGSVGElement>, count: number): number | null {
  if (count === 0) return null;
  const rect = e.currentTarget.getBoundingClientRect();
  if (rect.width === 0) return null;
  // Pointer → viewBox units → plot fraction.
  const vbX = ((e.clientX - rect.left) / rect.width) * VB_W;
  const frac = (vbX - M.left) / PLOT_W;
  if (frac < -0.05 || frac > 1.05) return null;
  const i = Math.round(frac * (count - 1));
  return Math.min(count - 1, Math.max(0, i));
}

function xLabelIndexes(length: number): number[] {
  if (length <= 1) return [0];
  if (length === 2) return [0, 1];
  return [...new Set([0, Math.floor((length - 1) / 2), length - 1])];
}

function shortDate(date: string | undefined): string {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function longDate(date: string): string {
  return new Date(date).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export interface MiniSparklineProps {
  values: number[];
  width?: number;
  height?: number;
}

/** Tiny inline sparkline for the "Latest" callout. */
export function MiniSparkline({
  values,
  width = 68,
  height = 22,
}: MiniSparklineProps): JSX.Element {
  if (values.length < 2) return <span />;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => ({
    x: (i / (values.length - 1)) * (width - 2) + 1,
    y: height - 2 - ((v - min) / range) * (height - 4),
  }));

  return (
    <svg
      class="mini-sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <path class="spark-line" d={linePathRaw(pts)} />
      <circle class="spark-end" cx={pts[pts.length - 1]!.x} cy={pts[pts.length - 1]!.y} r="2.5" />
    </svg>
  );
}

/** Straight polyline — a sparkline is too small for smoothing to read. */
function linePathRaw(points: Pt[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
}
