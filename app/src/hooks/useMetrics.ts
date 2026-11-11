import { useEffect, useRef, useState } from 'react'
import { metrics, type MetricsSnapshot } from '../lib/metrics'

// Polls the manager while `enabled`. Turning it off stops the sampler on the
// manager side too, so a hidden strip costs nothing — no PowerShell process,
// no counters, no polling.

const POLL_MS = 2000

export function useMetrics(enabled: boolean, model?: string) {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const modelRef = useRef(model)
  modelRef.current = model
  const getModel = () => modelRef.current

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null)
      void metrics.stop().catch(() => {})
      return
    }

    let cancelled = false
    void metrics.start().catch(() => {})

    async function tick() {
      try {
        const next = await metrics.get(getModel())
        if (!cancelled) {
          setSnapshot(next)
          setError(null)
          // If the sampler died or was stopped elsewhere, bring it back. The
          // strip being visible is the only thing that should decide this.
          if (!next.sampling) void metrics.start().catch(() => {})
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }
    }

    void tick()
    const timer = window.setInterval(() => void tick(), POLL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
      void metrics.stop().catch(() => {})
    }
  }, [enabled])

  return { snapshot, error }
}
