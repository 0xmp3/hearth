// Client for the local backend manager (server/index.mjs). Optional: if it is
// not running, the app still works against whatever server is on the port.

const MANAGER = 'http://127.0.0.1:8090'

export type ManagerStatus = {
  running: boolean
  pid: number | null
  startedAt: number | null
  args: string[] | null
  port: number
  error: string | null
  log: string[]
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(MANAGER + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // Forces a CORS preflight, which the manager only answers for localhost.
      'X-Hearth': '1',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as any).error ?? `manager ${res.status}`)
  return body as T
}

export const manager = {
  status: () => call<ManagerStatus>('/api/status'),
  start: (opts: { ctx: number; modelsDir?: string; ngl?: number }) =>
    call<ManagerStatus>('/api/start', { method: 'POST', body: JSON.stringify(opts) }),
  stop: () => call<ManagerStatus>('/api/stop', { method: 'POST' }),
}

/** The context size the running server was launched with, if it is ours. */
export function ctxFromArgs(args: string[] | null): number | undefined {
  if (!args) return undefined
  const i = args.indexOf('-c')
  if (i === -1) return undefined
  const n = Number(args[i + 1])
  return Number.isFinite(n) ? n : undefined
}
