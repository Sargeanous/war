// Shared UI primitives for SANDTABLE. Mirrors the DOOH design system.
// Pages must build their layout from these plus the documented CSS classes
// in styles.css (.page-body, .metric-grid, .split-grid, .panel, .table-card,
// .object-list, .form-grid, .status-pill, .tone-*, ...).

import { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { Tone } from "./types";

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="page-body">{children}</div>;
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <section className="metric-grid">{children}</section>;
}

export function Metric({ label, value, helper, tone }: { label: string; value: string; helper: string; tone: Tone }) {
  return (
    <article className={`metric tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{helper}</small>
    </article>
  );
}

export function Panel({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <span className="panel-icon">
            <Icon size={18} />
          </span>
          <h2>{title}</h2>
        </div>
        {action ? <div className="panel-action">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Button({
  children,
  icon: Icon,
  variant = "primary",
  ...props
}: {
  children: ReactNode;
  icon?: LucideIcon;
  variant?: "primary" | "secondary" | "danger";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`button ${variant}`} type={props.type ?? "button"} {...props}>
      {Icon ? <Icon size={16} /> : null}
      {children}
    </button>
  );
}

export function ActionRow({ children }: { children: ReactNode }) {
  return <div className="action-row">{children}</div>;
}

export function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return <span className={`status-pill tone-${tone}`}>{label}</span>;
}

export function Tag({ label, color }: { label: string; color?: string }) {
  // A category reads best as a dot plus plain text. Painting the border AND the
  // label in the hue double-encodes it and turns dense columns into noise.
  return (
    <span className={`tag${color ? " has-dot" : ""}`}>
      {color ? <i className="tag-dot" style={{ background: color }} /> : null}
      {label}
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (value: T) => void;
  items: Array<{ id: T; label: string }>;
}) {
  return (
    <div className="segmented">
      {items.map((item) => (
        <button key={item.id} className={value === item.id ? "active" : ""} type="button" onClick={() => onChange(item.id)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function DetailGrid({ children }: { children: ReactNode }) {
  return <div className="detail-grid">{children}</div>;
}

export function CompactTable({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-card compact-table">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} data-label={columns[index]}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ObjectList({
  rows,
  onSelect,
}: {
  rows: Array<{ id: string; title: string; meta: string; tone: Tone; status: string }>;
  onSelect?: (id: string) => void;
}) {
  return (
    <div className="object-list">
      {rows.map((row) => (
        <article key={row.id} onClick={onSelect ? () => onSelect(row.id) : undefined} style={onSelect ? { cursor: "pointer" } : undefined}>
          <span className={`dot ${row.tone}`} />
          <div>
            <strong>{row.title}</strong>
            <small>{row.meta}</small>
          </div>
          <StatusPill label={row.status} tone={row.tone} />
        </article>
      ))}
    </div>
  );
}

export function Toast({ children }: { children: ReactNode }) {
  return <div className="toast">{children}</div>;
}

export function EmptyState({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint: string }) {
  return (
    <div className="empty-state">
      <Icon size={28} />
      <strong>{title}</strong>
      <small>{hint}</small>
    </div>
  );
}

export function ProgressBar({ value, tone = "info", label }: { value: number; tone?: Tone; label?: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="progress-bar">
      {label ? <span>{label}</span> : null}
      <div className="progress-track">
        <div className={`progress-fill tone-${tone}`} style={{ width: `${clamped}%` }} />
      </div>
      <em>{Math.round(clamped)}%</em>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal-panel${wide ? " wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{title}</h3>
          <button type="button" className="modal-close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// --- Form helpers -----------------------------------------------------------

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function FormGrid({ children, columns = 2 }: { children: ReactNode; columns?: number }) {
  return (
    <div className="form-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {children}
    </div>
  );
}

// --- Tiny charts (pure SVG/CSS, no dependencies) ------------------------------

export function Sparkline({
  values,
  color = "var(--primary)",
  height = 42,
}: {
  values: number[];
  color?: string;
  height?: number;
}) {
  if (!values.length) return <div className="sparkline-empty">no data</div>;
  const w = 220;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * w},${height - ((v - min) / span) * (height - 4) - 2}`);
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height }}>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={2} />
    </svg>
  );
}

export function BarRow({ label, value, max, color, suffix }: { label: string; value: number; max: number; color?: string; suffix?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="bar-row">
      <span>{label}</span>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%`, background: color ?? "var(--primary)" }} />
      </div>
      <em>
        {Math.round(value)}
        {suffix ?? ""}
      </em>
    </div>
  );
}

export function SvgRadar({
  axes,
  series,
  size = 240,
}: {
  axes: string[]; // axis labels, order matters
  series: Array<{ name: string; color: string; values: number[] }>; // values 0..100 matching axes
  size?: number;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 34;
  const angle = (i: number) => (Math.PI * 2 * i) / axes.length - Math.PI / 2;
  const point = (i: number, v: number) => `${cx + Math.cos(angle(i)) * r * (v / 100)},${cy + Math.sin(angle(i)) * r * (v / 100)}`;
  return (
    <svg className="svg-radar" viewBox={`0 0 ${size} ${size}`} style={{ width: "100%", maxWidth: size }}>
      {[25, 50, 75, 100].map((ring) => (
        <polygon
          key={ring}
          points={axes.map((_, i) => point(i, ring)).join(" ")}
          fill="none"
          stroke="var(--line)"
          strokeWidth={1}
        />
      ))}
      {axes.map((label, i) => (
        <g key={label}>
          <line x1={cx} y1={cy} x2={cx + Math.cos(angle(i)) * r} y2={cy + Math.sin(angle(i)) * r} stroke="var(--line)" />
          <text
            x={cx + Math.cos(angle(i)) * (r + 16)}
            y={cy + Math.sin(angle(i)) * (r + 16)}
            textAnchor="middle"
            dominantBaseline="middle"
            className="radar-label"
          >
            {label}
          </text>
        </g>
      ))}
      {series.map((s) => (
        <polygon
          key={s.name}
          points={s.values.map((v, i) => point(i, v)).join(" ")}
          fill={s.color}
          fillOpacity={0.14}
          stroke={s.color}
          strokeWidth={2}
        />
      ))}
    </svg>
  );
}

// Gantt-style horizontal bar for subtasks / COA phases.
export function TimelineBar({
  items,
  totalH,
}: {
  items: Array<{ id: string; label: string; startH: number; endH: number; color?: string; meta?: string }>;
  totalH: number;
}) {
  return (
    <div className="timeline-bars">
      {items.map((item) => {
        const left = Math.max(0, Math.min(100, (item.startH / totalH) * 100));
        const width = Math.max(2, Math.min(100 - left, ((item.endH - item.startH) / totalH) * 100));
        return (
          <div key={item.id} className="timeline-row">
            <span className="timeline-label" title={item.label}>
              {item.label}
            </span>
            <div className="timeline-track">
              <div
                className="timeline-fill"
                style={{ left: `${left}%`, width: `${width}%`, background: item.color ?? "var(--primary)" }}
                title={`${item.label} · H+${item.startH} to H+${item.endH}${item.meta ? ` · ${item.meta}` : ""}`}
              />
            </div>
            <em>
              H+{item.startH}-{item.endH}
            </em>
          </div>
        );
      })}
    </div>
  );
}

// --- Formatting helpers --------------------------------------------------------

export function simClock(simTimeH: number): string {
  const day = Math.floor(simTimeH / 24) + 1;
  const h = Math.floor(simTimeH % 24);
  const m = Math.round((simTimeH % 1) * 60);
  return `D${day} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}Z`;
}

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
