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

export type EngineSource = {
  provider: 'lemonade' | 'official'
  gfx?: string
  asset?: string
  kind: 'zip' | 'tar.gz'
  label: string
}

export type Resolved = {
  path: string | null
  source: 'env' | 'config' | 'managed' | 'none'
  exists: boolean
}

export type InstallProgress = {
  phase: 'idle' | 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'error'
  got: number
  total: number
  version: string | null
  filename: string | null
  verified: boolean | null
  error: string | null
}

export type EngineStatus = {
  detected: {
    os: string
    arch: string
    gpu: { name: string; vendor: string }
    allGpus: { name: string; vendor: string }[]
  }
  source: EngineSource | null
  engine: Resolved
  models: Resolved
  config: { enginePath: string | null; modelsDir: string | null; ctx: number; ngl: number }
  managed: { dir: string; installed: boolean }
  progress: InstallProgress
  installing: boolean
}

export type Page = {
  url: string
  title: string
  text: string
  contentType: string
  bytes: number
  truncated: boolean
}

export type SearchState = {
  provider: 'off' | 'brave' | 'searxng'
  hasKey: boolean
  searxngUrl: string
}

export type SearchHit = { title: string; url: string; snippet: string }

export type WorkspaceState = {
  enabled: boolean
  path: string
  exists: boolean
  error?: string
}

export type WorkspaceList = { path: string; entries: string[]; truncated: boolean }
export type WorkspaceSearch = {
  query: string
  regex: boolean
  scanned: number
  hits: { file: string; line: number; text: string }[]
  truncated: boolean
}
export type WorkspaceFile = {
  path: string
  start: number
  end: number
  total: number
  text: string
  truncated: boolean
}

export type SearxngStatus = {
  installed: boolean
  running: boolean
  pid: number | null
  startedAt: number | null
  url: string
  port: number
  python: { version: string; path: string; bin: string; args: string[] } | null
  source: { version: string; sha: string; url: string }
  progress: {
    phase: 'idle' | 'resolving' | 'downloading' | 'extracting' | 'venv' | 'deps' | 'configuring' | 'done' | 'error'
    got: number
    total: number
    step: string | null
    error: string | null
  }
  log: string[]
  root: string
}

export const manager = {
  status: () => call<ManagerStatus>('/api/status'),
  /** Egress is the manager's decision; the app only asks. */
  network: () => call<{ enabled: boolean }>('/api/network'),
  setNetwork: (enabled: boolean) =>
    call<{ enabled: boolean }>('/api/network', { method: 'POST', body: JSON.stringify({ enabled }) }),
  readPage: (url: string, maxChars?: number) =>
    call<Page>('/api/fetch', { method: 'POST', body: JSON.stringify({ url, maxChars }) }),
  searchState: () => call<SearchState>('/api/search'),
  saveSearch: (patch: { provider?: string; braveKey?: string; searxngUrl?: string }) =>
    call<SearchState>('/api/search', { method: 'POST', body: JSON.stringify(patch) }),
  workspace: () => call<WorkspaceState>('/api/workspace'),
  setWorkspace: (patch: { path?: string; enabled?: boolean }) =>
    call<WorkspaceState>('/api/workspace', { method: 'POST', body: JSON.stringify(patch) }),
  listFiles: (path?: string, depth?: number) =>
    call<WorkspaceList>('/api/workspace/list', { method: 'POST', body: JSON.stringify({ path, depth }) }),
  searchFiles: (query: string, opts: { path?: string; regex?: boolean; limit?: number } = {}) =>
    call<WorkspaceSearch>('/api/workspace/search', { method: 'POST', body: JSON.stringify({ query, ...opts }) }),
  readFile: (path: string, start?: number, lines?: number) =>
    call<WorkspaceFile>('/api/workspace/read', { method: 'POST', body: JSON.stringify({ path, start, lines }) }),
  searxng: () => call<SearxngStatus>('/api/searxng'),
  installSearxng: () => call<{ started: boolean }>('/api/searxng/install', { method: 'POST' }),
  startSearxng: () => call<SearxngStatus>('/api/searxng/start', { method: 'POST' }),
  stopSearxng: () => call<SearxngStatus & { stopped: boolean }>('/api/searxng/stop', { method: 'POST' }),
  removeSearxng: () => call<SearxngStatus & { removed: boolean }>('/api/searxng/remove', { method: 'POST' }),
  search: (q: string, count?: number) =>
    call<{ query: string; provider: string; results: SearchHit[] }>('/api/search/run', {
      method: 'POST',
      body: JSON.stringify({ q, count }),
    }),
  start: (opts: { ctx: number; modelsDir?: string; ngl?: number }) =>
    call<ManagerStatus>('/api/start', { method: 'POST', body: JSON.stringify(opts) }),
  stop: () => call<ManagerStatus>('/api/stop', { method: 'POST' }),
  engine: () => call<EngineStatus>('/api/engine'),
  downloadEngine: () => call<{ started: boolean; source: EngineSource }>('/api/engine/download', { method: 'POST' }),
  progress: () => call<{ progress: InstallProgress; installing: boolean }>('/api/engine/progress'),
  saveConfig: (patch: Partial<EngineStatus['config']>) =>
    call<EngineStatus['config']>('/api/config', { method: 'POST', body: JSON.stringify(patch) }),
}

/** The context size the running server was launched with, if it is ours. */
export function ctxFromArgs(args: string[] | null): number | undefined {
  if (!args) return undefined
  const i = args.indexOf('-c')
  if (i === -1) return undefined
  const n = Number(args[i + 1])
  return Number.isFinite(n) ? n : undefined
}
