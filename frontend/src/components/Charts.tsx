import type { ReactNode } from "react";
import Empty from "./Empty";
import { fmtNum } from "../lib/format";
import type { Order } from "../types";

export const STATUS_GROUP: { id: string; label: string; tone: string; match: string[] }[] = [
  { id: "open", label: "Открыты", tone: "dust", match: ["open"] },
  { id: "work", label: "В работе", tone: "sea", match: ["taken", "assigned", "arrived", "loading", "pickup"] },
  { id: "transit", label: "В рейсе", tone: "deep", match: ["transit"] },
  { id: "delivered", label: "Доставлены", tone: "muted", match: ["delivered"] },
  { id: "cancelled", label: "Отменены", tone: "coral", match: ["cancelled"] },
];

const TONE_COLOR: Record<string, string> = {
  sea: "var(--sea)",
  deep: "var(--sea-2)",
  dust: "var(--dust)",
  coral: "var(--coral)",
  muted: "var(--muted)",
};

export function statusSlices(orders: Order[]) {
  return STATUS_GROUP.map((g) => ({
    label: g.label,
    tone: g.tone,
    value: orders.filter((o) => g.match.includes(o.status)).length,
  })).filter((s) => s.value > 0);
}

export function ordersByDay(orders: Order[], days = 14) {
  const dated = orders.filter((o) => o.created_at);
  if (dated.length === 0) return [];
  const buckets = new Map<string, { label: string; value: number }>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    buckets.set(key, {
      label: d.toLocaleDateString("ru-KZ", { day: "numeric", month: "short" }),
      value: 0,
    });
  }
  for (const o of dated) {
    const key = (o.created_at as string).slice(0, 10);
    const slot = buckets.get(key);
    if (slot) slot.value += 1;
  }
  return [...buckets.values()];
}

export function MetricCard({
  name,
  value,
  unit,
  delta,
}: {
  name: string;
  value: string;
  unit: string;
  delta?: string | null;
}) {
  return (
    <article className="metric">
      <span className="metric-name">{name}</span>
      <strong className="metric-value">
        {value} <small>{unit}</small>
      </strong>
      {delta ? <span className="metric-delta">{delta}</span> : null}
    </article>
  );
}

export function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="chart-card">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function BarList({
  items,
  unit,
}: {
  items: { label: string; value: number; tone?: string }[];
  unit?: string;
}) {
  if (items.length === 0) return <Empty title="Нет данных для графика" />;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="chart-bars">
      {items.map((i) => (
        <div className="chart-bar-row" key={i.label}>
          <span className="chart-bar-label">{i.label}</span>
          <div className="chart-bar-track">
            <div
              className={`chart-bar-fill ${i.tone ?? "sea"}`}
              style={{ width: `${Math.max((i.value / max) * 100, i.value > 0 ? 4 : 0)}%` }}
            />
          </div>
          <span className="chart-bar-val">
            {fmtNum(i.value)}
            {unit ? ` ${unit}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

export function DonutChart({ slices }: { slices: { label: string; value: number; tone: string }[] }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return <Empty title="Нет заявок для распределения" />;
  const r = 42;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="chart-donut">
      <svg viewBox="0 0 120 120" aria-hidden>
        {slices.map((s) => {
          const len = (s.value / total) * circ;
          const node = (
            <circle
              key={s.label}
              cx="60"
              cy="60"
              r={r}
              fill="none"
              stroke={TONE_COLOR[s.tone] ?? TONE_COLOR.sea}
              strokeWidth="14"
              strokeDasharray={`${len} ${circ - len}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
            />
          );
          offset += len;
          return node;
        })}
      </svg>
      <ul>
        {slices.map((s) => (
          <li key={s.label}>
            <i style={{ background: TONE_COLOR[s.tone] ?? TONE_COLOR.sea }} />
            {s.label}
            <b>{s.value}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SparkBars({ points }: { points: { label: string; value: number }[] }) {
  if (points.length === 0) return <Empty title="Нет дат заявок" />;
  const max = Math.max(...points.map((p) => p.value), 1);
  const hasAny = points.some((p) => p.value > 0);
  if (!hasAny) return <Empty title="За последние дни заявок нет" />;
  return (
    <div className="chart-spark">
      {points.map((p) => (
        <div className="chart-spark-col" key={p.label} title={`${p.label}: ${p.value}`}>
          <div className="chart-spark-track">
            <div className="chart-spark-bar" style={{ height: `${(p.value / max) * 100}%` }} />
          </div>
          <span>{p.label.replace(" ", "\u00a0")}</span>
        </div>
      ))}
    </div>
  );
}
