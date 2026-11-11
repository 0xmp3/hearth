import { useEffect, useState } from 'react'
import Dialog from './Dialog'
import { listStatPoints, type StatPoint } from '../lib/db'

type Props = { onClose: () => void }

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="spark-empty">not enough replies yet</div>

  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min || 1
  const w = 100
  const h = 28
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(' ')

  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

export default function StatsDialog({ onClose }: Props) {
  const [points, setPoints] = useState<StatPoint[] | null>(null)

  useEffect(() => {
    void listStatPoints().then(setPoints)
  }, [])

  const byModel = new Map<string, StatPoint[]>()
  for (const p of points ?? []) {
    const list = byModel.get(p.model) ?? []
    list.push(p)
    byModel.set(p.model, list)
  }

  return (
    <Dialog
      title="Stats"
      onClose={onClose}
      wide
      footer={<button onClick={onClose}>Done</button>}
    >
      {points === null ? (
        <p className="hint">Reading…</p>
      ) : points.length === 0 ? (
        <p className="hint">
          No replies recorded yet. Every reply logs its speed, so this fills up as you chat.
        </p>
      ) : (
        <>
          <p className="hint">
            {points.length} repl{points.length === 1 ? 'y' : 'ies'} across{' '}
            {byModel.size} model{byModel.size === 1 ? '' : 's'}. Newest on the right.
          </p>

          {[...byModel.entries()].map(([model, list]) => {
            const speeds = list.map((p) => p.tokPerSec)
            const ttfts = list.map((p) => p.ttftMs).filter((v): v is number => typeof v === 'number')
            const caches = list
              .filter((p) => p.promptTokens && typeof p.cacheN === 'number')
              .map((p) => (p.cacheN! / p.promptTokens!) * 100)

            return (
              <section className="stat-block" key={model}>
                <div className="stat-head">
                  <span className="stat-model">{model}</span>
                  <span className="hint">{list.length} replies</span>
                </div>

                <Spark values={speeds.slice(-40)} />

                <div className="stat-grid">
                  <div>
                    <span className="stat-value">{avg(speeds).toFixed(1)}</span>
                    <span className="stat-label">avg tok/s</span>
                  </div>
                  <div>
                    <span className="stat-value">{Math.max(...speeds).toFixed(1)}</span>
                    <span className="stat-label">best</span>
                  </div>
                  <div>
                    <span className="stat-value">{Math.min(...speeds).toFixed(1)}</span>
                    <span className="stat-label">worst</span>
                  </div>
                  {ttfts.length > 0 && (
                    <div>
                      <span className="stat-value">{(avg(ttfts) / 1000).toFixed(1)}s</span>
                      <span className="stat-label">avg first token</span>
                    </div>
                  )}
                  {caches.length > 0 && (
                    <div>
                      <span className="stat-value">{avg(caches).toFixed(0)}%</span>
                      <span className="stat-label">prompt cached</span>
                    </div>
                  )}
                </div>
              </section>
            )
          })}
        </>
      )}
    </Dialog>
  )
}
