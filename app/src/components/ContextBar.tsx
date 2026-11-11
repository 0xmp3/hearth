type Props = { used: number; total: number }

function short(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

export default function ContextBar({ used, total }: Props) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
  const hot = pct >= 85

  return (
    <div
      className={`ctx${hot ? ' hot' : ''}`}
      title={`${used.toLocaleString()} of ${total.toLocaleString()} tokens in context`}
    >
      <div className="ctx-track">
        <div className="ctx-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="ctx-label">
        {short(used)} / {short(total)}
      </span>
    </div>
  )
}
