import { useState } from 'react'
import { useMetrics } from '../hooks/useMetrics'

// A thin strip, not a dashboard. Three numbers by default and the rest behind a
// click, because the point of this app is that it stays quiet.
//
// VRAM leads because it is the number that changes a decision: whether a bigger
// model or a longer context will fit. GPU utilisation is in the detail view,
// where it belongs — a local model is either busy or idle, and the percentage
// tells you very little.

function gb(n: number | null | undefined) {
  return n == null ? '—' : n.toFixed(1)
}

export default function MetricsStrip({
  model,
  enabled,
  compact = false,
}: {
  model?: string
  enabled: boolean
  /** Collapsed rail: a bare VRAM bar, no text. */
  compact?: boolean
}) {
  const { snapshot, error } = useMetrics(enabled, model)
  const [open, setOpen] = useState(false)

  if (!enabled) return null

  if (error) {
    return (
      <div className="metrics-strip" title={error}>
        <span className="metrics-num dim">metrics unavailable</span>
      </div>
    )
  }

  if (!snapshot) {
    return (
      <div className="metrics-strip">
        <span className="metrics-num dim">…</span>
      </div>
    )
  }

  const { system, server } = snapshot
  const gpu = system.gpu
  const vramPct = gpu && gpu.vramTotalGb ? Math.min(100, (gpu.vramUsedGb / gpu.vramTotalGb) * 100) : 0
  const tps = server?.tokensPerSecond ?? null

  if (compact) {
    const label = gpu
      ? `${gb(gpu.vramUsedGb)}/${gb(gpu.vramTotalGb)} GB · ${tps && tps > 0 ? `${tps.toFixed(0)} t/s` : 'idle'}`
      : 'no gpu'
    return (
      <div className="metrics-rail" title={label}>
        <span className="vram-fill" style={{ width: `${vramPct}%` }} />
      </div>
    )
  }

  const promptTotal = (server?.promptTokens ?? 0) + (server?.promptTokensCached ?? 0)
  const cacheHit = promptTotal > 0 ? Math.round(((server?.promptTokensCached ?? 0) / promptTotal) * 100) : null

  return (
    <div className={`metrics-strip${open ? ' open' : ''}`}>
      <button
        className="metrics-row"
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Hide detail' : 'Show detail'}
      >
        {gpu ? (
          <>
            <span className="vram-bar">
              <span className="vram-fill" style={{ width: `${vramPct}%` }} />
            </span>
            <span className="metrics-num">
              {gb(gpu.vramUsedGb)}/{gb(gpu.vramTotalGb)}
            </span>
          </>
        ) : (
          <span className="metrics-num dim">no gpu</span>
        )}
        <span className="metrics-num">{tps && tps > 0 ? `${tps.toFixed(0)} t/s` : 'idle'}</span>
      </button>

      {open && (
        <dl className="metrics-detail">
          <div>
            <dt>cpu</dt>
            <dd>{system.cpu.percent == null ? '—' : `${system.cpu.percent}%`}</dd>
          </div>
          <div>
            <dt>ram</dt>
            <dd>
              {gb(system.ram.usedGb)}/{gb(system.ram.totalGb)} GB
            </dd>
          </div>
          <div>
            <dt>gpu</dt>
            <dd>{gpu ? `${gpu.util}%` : '—'}</dd>
          </div>
          <div>
            <dt>disk</dt>
            <dd>{system.disk ? `${gb(system.disk.freeGb)} GB free` : '—'}</dd>
          </div>
          {server?.contextTokens != null && server.slots?.nCtx ? (
            <div>
              <dt>ctx</dt>
              <dd>
                {Math.round((server.contextTokens / server.slots.nCtx) * 100)}%
              </dd>
            </div>
          ) : null}
          {server?.slots && (
            <div>
              <dt>slots</dt>
              <dd>
                {server.slots.busy}/{server.slots.total}
              </dd>
            </div>
          )}
          {cacheHit != null && (
            <div>
              <dt>cache</dt>
              <dd>{cacheHit}%</dd>
            </div>
          )}
          {server && !server.metricsEnabled && (
            <div>
              <dt>server</dt>
              <dd className="dim">no metrics</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  )
}
