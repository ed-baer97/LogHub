export default function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint && <p>{hint}</p>}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skel-stack">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel" />
      ))}
    </div>
  );
}
