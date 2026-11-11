// Client for the manager's metrics endpoint.
//
// Two families, deliberately kept separate: `system` is the machine, `server`
// is the model. They answer different questions and are not merged.

const MANAGER = 'http://127.0.0.1:8090'

export type SystemMetrics = {
  at: number
  cpu: { percent: number | null; cores: number }
  ram: { usedGb: number; totalGb: number }
  gpu: { util: number; vramUsedGb: number; vramTotalGb: number } | null
  gpuError: string | null
  disk: { freeGb: number; totalGb: number } | null
}

export type ServerMetrics = {
  tokensPerSecond: number | null
  /** Tokens in the active slot's context, or null when nothing is running. */
  contextTokens: number | null
  tokensPredicted: number | null
  promptTokens: number | null
  promptTokensCached: number | null
  requestsProcessing: number | null
  requestsDeferred: number | null
  slots: { total: number; busy: number; nCtx: number | null } | null
  metricsEnabled: boolean
}

export type MetricsSnapshot = {
  system: SystemMetrics
  server: ServerMetrics | null
  sampling: boolean
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(MANAGER + path, {
    ...init,
    headers: { 'X-Hearth': '1', ...(init?.headers ?? {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as any).error ?? `manager ${res.status}`)
  return body as T
}

export const metrics = {
  get: (model?: string) =>
    call<MetricsSnapshot>(`/api/metrics${model ? `?model=${encodeURIComponent(model)}` : ''}`),
  start: () => call<{ sampling: boolean }>('/api/metrics/start', { method: 'POST' }),
  stop: () => call<{ sampling: boolean }>('/api/metrics/stop', { method: 'POST' }),
}
